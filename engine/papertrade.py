# -*- coding: utf-8 -*-
"""模拟交易(纸面交易): 股票 + 期货。本地 SQLite 记账,不接任何券商。

设计要点:
- 账户: 初始资金 100 万,现金 + 已实现盈亏 + 未实现浮动盈亏 + 总市值 + 当日参考盈亏。
- 撮合: 市价单按最新价立即成交;限价单价格可成交时立即成交,否则挂起(pending 可撤单)。
- 费用: 股票买入佣金 0.025%(最低1元),卖出佣金 0.025% + 印花税 0.05%;期货双边 0.01%(最低1元)。
- 期货: 支持开多/开空/平多/平空,保证金率 12%,仓位可用负值表示空头。
- 股票持仓按最新实时价(东财)逐笔盯市;期货按 last_price 盯市(Phase 2 再接期货行情)。
"""
from __future__ import annotations

from datetime import datetime
import json
import math
from typing import Any

from fastapi import APIRouter, Body

try:  # 兼容 dev 与打包产物
    from .database import add_notification, audit, connect, get_setting, set_setting
    from .scope import owner_id as _owner
except ImportError:
    try:
        from engine.database import add_notification, audit, connect, get_setting, set_setting
        from engine.scope import owner_id as _owner
    except ImportError:
        from database import add_notification, audit, connect, get_setting, set_setting
        from scope import owner_id as _owner

try:
    from .marketdata import market_quotes
except ImportError:
    try:
        from engine.marketdata import market_quotes
    except ImportError:
        from marketdata import market_quotes

try:
    from . import riskguard
except ImportError:
    try:
        from engine import riskguard
    except ImportError:
        import riskguard

router = APIRouter(prefix="/trade")

INITIAL_CASH = 1_000_000.0
FUTURES_MARGIN = 0.12  # 期货保证金率
MARKET_SLIPPAGE = 0.0005  # 市价单 5bp 滑点，避免最新价瞬时成交过于乐观
SIDES = {"buy", "sell", "open_long", "open_short", "close_long", "close_short"}
RISK_LIMITS_KEY = "paper_risk_limits"
DEFAULT_RISK_LIMITS = {
    "max_order_notional_pct": 0.15,
    "max_single_position_pct": 0.25,
    "max_gross_exposure_pct": 0.95,
    "max_futures_margin_pct": 0.30,
    "max_pending_orders": 20,
}


def _now() -> str:
    return datetime.now().strftime("%Y-%m-%d %H:%M:%S")


def get_risk_limits() -> dict[str, float | int]:
    """读取纸面交易的预交易风控；异常或旧配置一律回退到安全默认值。"""
    limits = dict(DEFAULT_RISK_LIMITS)
    try:
        stored = json.loads(get_setting(RISK_LIMITS_KEY, "{}"))
    except (TypeError, ValueError, json.JSONDecodeError):
        stored = {}
    if not isinstance(stored, dict):
        return limits
    for key in ("max_order_notional_pct", "max_single_position_pct", "max_gross_exposure_pct", "max_futures_margin_pct"):
        value = stored.get(key)
        if isinstance(value, (int, float)) and math.isfinite(value) and 0 < float(value) <= 1:
            limits[key] = float(value)
    value = stored.get("max_pending_orders")
    if isinstance(value, int) and 1 <= value <= 200:
        limits["max_pending_orders"] = value
    return limits


def update_risk_limits(updates: dict[str, Any]) -> dict[str, float | int]:
    """更新本地纸面账户的风险限额。限制只能收紧到合理的 0-100% 区间。"""
    allowed = set(DEFAULT_RISK_LIMITS)
    unexpected = set(updates) - allowed
    if unexpected:
        raise ValueError(f"不支持的风控字段: {','.join(sorted(unexpected))}")
    limits = get_risk_limits()
    for key in ("max_order_notional_pct", "max_single_position_pct", "max_gross_exposure_pct", "max_futures_margin_pct"):
        if key not in updates:
            continue
        try:
            value = float(updates[key])
        except (TypeError, ValueError) as exc:
            raise ValueError(f"{key} 必须是数值") from exc
        if not math.isfinite(value) or not 0 < value <= 1:
            raise ValueError(f"{key} 必须在 0 与 1 之间")
        limits[key] = value
    if "max_pending_orders" in updates:
        value = updates["max_pending_orders"]
        if not isinstance(value, int) or isinstance(value, bool) or not 1 <= value <= 200:
            raise ValueError("max_pending_orders 必须是 1-200 的整数")
        limits["max_pending_orders"] = value
    set_setting(RISK_LIMITS_KEY, json.dumps(limits, ensure_ascii=False))
    audit("paper_risk_limits_updated", limits)
    return limits


def _pre_trade_risk_check(db, market: str, symbol: str, side: str, price: float, quantity: float) -> dict[str, Any]:
    """以成交后的投影仓位检查预交易风险。减仓/平仓不受敞口限制。"""
    increasing = side in {"buy", "open_long", "open_short"}
    limits = get_risk_limits()
    if not increasing:
        return {"ok": True, "limits": limits, "action": "risk_reducing"}
    account = db.execute("SELECT cash FROM paper_account WHERE owner_id=?", (_owner(),)).fetchone()
    cash = float(account["cash"] or 0.0) if account else 0.0
    positions = [dict(row) for row in db.execute("SELECT market,symbol,quantity,avg_cost,last_price FROM paper_positions WHERE owner_id=?", (_owner(),)).fetchall()]
    equity = cash
    gross_exposure = 0.0
    futures_margin = 0.0
    projected_single = price * quantity
    for position in positions:
        mark = float(position["last_price"] or position["avg_cost"] or 0.0)
        qty = float(position["quantity"] or 0.0)
        if position["market"] in ("a", "index"):
            notional = abs(qty) * mark
            equity += notional
            gross_exposure += notional
        else:
            margin = abs(qty) * mark * FUTURES_MARGIN
            equity += margin
            gross_exposure += margin
            futures_margin += margin
        if position["market"] == market and position["symbol"] == symbol:
            delta = quantity if side in {"buy", "open_long"} else -quantity
            projected_single = abs(qty + delta) * price
            if market in ("a", "index"):
                gross_exposure -= abs(qty) * mark
            else:
                futures_margin -= abs(qty) * mark * FUTURES_MARGIN
                gross_exposure -= abs(qty) * mark * FUTURES_MARGIN
    if market in ("a", "index"):
        gross_exposure += projected_single
    else:
        projected_margin = projected_single * FUTURES_MARGIN
        futures_margin += projected_margin
        gross_exposure += projected_margin
    equity = max(equity, 1.0)
    order_notional = price * quantity
    metrics = {
        "equity": round(equity, 2), "order_notional": round(order_notional, 2),
        "projected_single_notional": round(projected_single, 2), "projected_gross_exposure": round(gross_exposure, 2),
        "projected_futures_margin": round(futures_margin, 2), "limits": limits,
    }
    checks = [
        (order_notional / equity <= float(limits["max_order_notional_pct"]), "单笔委托金额超过风控上限"),
        (projected_single / equity <= float(limits["max_single_position_pct"]), "单标的敞口超过风控上限"),
        (gross_exposure / equity <= float(limits["max_gross_exposure_pct"]), "总敞口超过风控上限"),
    ]
    if market == "futures":
        checks.append((futures_margin / equity <= float(limits["max_futures_margin_pct"]), "期货保证金占用超过风控上限"))
    for passed, message in checks:
        if not passed:
            return {"ok": False, "error": message, **metrics}
    return {"ok": True, **metrics}


def _ensure_account() -> None:
    with connect() as db:
        db.execute(
            "INSERT OR IGNORE INTO paper_account(owner_id, initial_cash, cash, realized_pnl) VALUES(?, ?, ?, 0)",
            (_owner(), INITIAL_CASH, INITIAL_CASH),
        )


def _fee(amount: float, side: str, market: str) -> float:
    amt = abs(amount)
    if market == "futures":
        return max(1.0, amt * 0.0001)
    commission = max(1.0, amt * 0.00025)
    stamp = amt * 0.0005 if side == "sell" else 0.0
    return round(commission + stamp, 2)


def _live_prices(symbols: list[tuple[str, str]]) -> dict[tuple[str, str], float]:
    """symbols: [(market, symbol)] → {(market,symbol): price}。股票走实时行情,失败回退 DB 缓存。"""
    by_market: dict[str, list[str]] = {}
    for market, symbol in symbols:
        by_market.setdefault(market, []).append(symbol)
    prices: dict[tuple[str, str], float] = {}
    for market, codes in by_market.items():
        try:
            result = market_quotes(",".join(codes[:20]), market=market if market in ("index", "futures") else "a")
            for q in result.get("quotes", []):
                if q.get("price") is None:
                    continue
                key = (market, str(q["symbol"]).upper() if market == "futures" else str(q["symbol"]))
                prices[key] = float(q["price"])
        except Exception:  # noqa: BLE001
            pass
    return prices


# ---------- 账户 ----------
def _account_snapshot() -> dict[str, Any]:
    _ensure_account()
    with connect() as db:
        acc = db.execute("SELECT * FROM paper_account WHERE owner_id=?", (_owner(),)).fetchone()
        positions = [dict(row) for row in db.execute(
            "SELECT market,symbol,name,quantity,avg_cost,last_price FROM paper_positions WHERE owner_id=? ORDER BY market,symbol",
            (_owner(),),
        ).fetchall()]

    live = _live_prices([(p["market"], p["symbol"]) for p in positions])
    unrealized = 0.0
    day_pnl = 0.0
    market_value = 0.0
    asset_contrib = 0.0  # 计入总资产的持仓部分: 股票=市值, 期货=保证金+浮动盈亏
    rows: list[dict[str, Any]] = []
    for p in positions:
        mkt, sym = p["market"], p["symbol"]
        lookup_sym = sym.upper() if mkt == "futures" else sym
        last = live.get((mkt, lookup_sym)) or p.get("last_price")
        if last is None:
            last = p.get("avg_cost") or 0.0
        qty = float(p["quantity"])
        avg = float(p["avg_cost"] or 0.0)
        pnl = (last - avg) * qty
        mv = last * abs(qty)
        if mkt == "futures":
            margin_locked = avg * abs(qty) * FUTURES_MARGIN
            asset_contrib += margin_locked + pnl
        else:
            asset_contrib += mv
        # 当日参考盈亏: 股票用昨收,(last-prev_close)*qty; 期货暂无昨收,记 0
        day = 0.0
        if mkt != "futures":
            try:
                qr = market_quotes(sym, market=mkt if mkt == "index" else "a")
                q0 = (qr.get("quotes") or [{}])[0]
                prev = q0.get("prev_close")
                if prev is not None:
                    day = (last - float(prev)) * qty
            except Exception:  # noqa: BLE001
                pass
        unrealized += pnl
        market_value += mv
        day_pnl += day
        rows.append({
            "market": mkt, "symbol": sym, "name": p["name"], "quantity": qty,
            "avg_cost": avg, "last_price": last, "market_value": mv,
            "unrealized_pnl": round(pnl, 2), "day_pnl": round(day, 2),
            "side_label": "空头" if qty < 0 else "多头",
        })

    # 所有成交损益都回写 cash；realized_pnl 只作报表字段，不能再次计入资产。
    total_asset = float(acc["cash"]) + asset_contrib
    try:  # 账户级风控: 刷新当日基线, 亏损超限自动熔断
        guard_state = riskguard.observe_equity(total_asset)
    except Exception:  # noqa: BLE001
        guard_state = None
    return {
        "initial_cash": float(acc["initial_cash"]),
        "cash": float(acc["cash"]),
        "realized_pnl": float(acc["realized_pnl"] or 0.0),
        "unrealized_pnl": round(unrealized, 2),
        "market_value": round(market_value, 2),
        "total_asset": round(total_asset, 2),
        "day_pnl": round(day_pnl, 2),
        "risk_limits": get_risk_limits(),
        "risk_guard": guard_state,
        "positions": rows,
    }


def _bought_today(db, market: str, symbol: str) -> float:
    """当日已成交买入数量，用于 A 股 T+1（可卖 = 持仓 − 今日买入）。"""
    today = datetime.now().strftime("%Y-%m-%d")
    row = db.execute(
        "SELECT COALESCE(SUM(quantity),0) AS qty FROM paper_trades "
        "WHERE owner_id=? AND market=? AND symbol=? AND side='buy' AND created_at LIKE ?",
        (_owner(), market, symbol, f"{today}%"),
    ).fetchone()
    return float(row["qty"] if row is not None else 0.0)


def _price_limit_pct(symbol: str, market: str) -> float:
    """主板 10%、创业板/科创板 20%、北交所 30%（按代码前缀启发式，无板块字段时的保守默认）。"""
    digits = "".join(ch for ch in (symbol or "") if ch.isdigit())[:6]
    if market == "index":
        return 0.098
    if len(digits) == 6 and digits.startswith(("300", "301", "688", "689")):
        return 0.198
    if len(digits) == 6 and digits[:1] in {"4", "8"}:
        return 0.298
    return 0.098


def _update_position(db, market: str, symbol: str, name: str, quantity: float, price: float) -> None:
    oid = _owner()
    row = db.execute(
        "SELECT quantity,avg_cost FROM paper_positions WHERE owner_id=? AND market=? AND symbol=?",
        (oid, market, symbol),
    ).fetchone()
    price = float(price)
    if row is None:
        db.execute(
            "INSERT INTO paper_positions(owner_id,market,symbol,name,quantity,avg_cost,last_price,updated_at) VALUES(?,?,?,?,?,?,?,?)",
            (oid, market, symbol, name, quantity, price, price, _now()),
        )
        return
    old_qty = float(row["quantity"] or 0.0)
    old_avg = float(row["avg_cost"] or 0.0)
    new_qty = old_qty + quantity
    if new_qty == 0:
        db.execute("DELETE FROM paper_positions WHERE owner_id=? AND market=? AND symbol=?", (oid, market, symbol))
        return
    # 加权平均成本: 仅当加仓方向与现仓位一致时并入成本;反手(平后再开)按新价建仓
    if old_qty * quantity > 0:
        new_avg = (old_qty * old_avg + quantity * price) / new_qty
    else:
        new_avg = price
    db.execute(
        "UPDATE paper_positions SET quantity=?, avg_cost=?, last_price=?, updated_at=? WHERE owner_id=? AND market=? AND symbol=?",
        (new_qty, new_avg, price, _now(), oid, market, symbol),
    )


def _halted_reason(quote: dict[str, Any]) -> str | None:
    name = str(quote.get("name") or "")
    if any(token in name for token in ("停牌", "暂停", "停牌一天")):
        return "标的停牌，拒绝委托"
    try:
        price = float(quote.get("price") or 0)
    except (TypeError, ValueError):
        price = 0.0
    if price <= 0:
        return "无有效成交价（可能停牌），拒绝委托"
    volume = quote.get("volume")
    open_px, high, low, close = quote.get("open"), quote.get("high"), quote.get("low"), quote.get("price")
    try:
        if volume is not None and float(volume) <= 0 and open_px and high and low and float(high) == float(low) == float(open_px):
            return "无成交且价格冻结，视为停牌"
    except (TypeError, ValueError):
        pass
    return None


def place_order(
    market: str,
    symbol: str,
    name: str,
    side: str,
    order_type: str,
    price: float | None,
    quantity: float,
    existing_order_id: int | None = None,
) -> dict[str, Any]:
    market = market if market in ("a", "index", "futures") else "a"
    symbol = (symbol or "").strip()
    side = side if side in SIDES else "buy"
    order_type = order_type if order_type in ("market", "limit") else "market"
    quantity = float(quantity or 0)
    if not symbol or not math.isfinite(quantity) or quantity <= 0:
        return {"ok": False, "error": "代码与数量必须有效"}
    if price is not None and (not math.isfinite(float(price)) or float(price) <= 0):
        return {"ok": False, "error": "委托价格必须是大于 0 的有限数值"}
    if market in ("a", "index"):
        if side not in ("buy", "sell"):
            return {"ok": False, "error": "股票只支持 buy 或 sell"}
        if not quantity.is_integer() or int(quantity) % 100 != 0:
            return {"ok": False, "error": "股票委托数量必须为 100 股的整数倍"}
    elif side not in ("open_long", "open_short", "close_long", "close_short"):
        return {"ok": False, "error": "期货只支持开多、开空、平多或平空"}
    elif not quantity.is_integer():
        return {"ok": False, "error": "期货委托数量必须为整数手"}
    guard = riskguard.gate(side)  # 账户级熔断: 禁止新开仓, 平仓放行
    if not guard.get("ok"):
        return {"ok": False, "error": str(guard["error"]), "risk_guard": guard.get("guard")}
    _ensure_account()

    with connect() as db:
        acc = db.execute("SELECT cash FROM paper_account WHERE owner_id=?", (_owner(),)).fetchone()
        cash = float(acc["cash"] or 0.0)

        # 取最新价
        last = None
        q0: dict[str, Any] = {}
        try:
            qr = market_quotes(symbol, market="futures" if market == "futures" else market)
            q0 = (qr.get("quotes") or [{}])[0] or {}
            last = q0.get("price")
            if name == "":
                name = str(q0.get("name") or "")
        except Exception:  # noqa: BLE001
            last = None
        if last is None and market == "futures" and order_type == "limit" and price:
            last = float(price)  # 行情源不可用时,限价单以委托价成交
        if last is None:
            return {"ok": False, "error": "暂无法获取该标的最新价,请稍后再试"}
        halted = _halted_reason(q0)
        if halted:
            return {"ok": False, "error": halted}
        if order_type == "market":
            bump = 1.0 + MARKET_SLIPPAGE if side in ("buy", "open_long", "close_short") else 1.0 - MARKET_SLIPPAGE
            last = float(last) * bump
        prev_close = q0.get("prev_close")
        price_limit_unknown = False
        if market in ("a", "index") and side in ("buy", "sell"):
            try:
                prev = float(prev_close) if prev_close is not None else 0.0
            except (TypeError, ValueError):
                prev = 0.0
            if prev > 0:
                change = float(last) / prev - 1.0
                lim = _price_limit_pct(symbol, market)
                if side == "buy" and change >= lim - 1e-6:
                    return {"ok": False, "error": f"疑似涨停（{change * 100:.2f}% ≥ {lim * 100:.1f}%），拒绝买入"}
                if side == "sell" and change <= -(lim - 1e-6):
                    return {"ok": False, "error": f"疑似跌停（{change * 100:.2f}% ≤ -{lim * 100:.1f}%），拒绝卖出"}
            else:
                price_limit_unknown = True

        risk_price = float(price) if order_type == "limit" and price is not None else float(last)
        risk = _pre_trade_risk_check(db, market, symbol, side, risk_price, quantity)
        if not risk.get("ok"):
            db.execute("INSERT INTO audit_log(event,payload) VALUES(?,?)", ("paper_trade_blocked", json.dumps({"market": market, "symbol": symbol, "side": side, **risk}, ensure_ascii=False)))
            return {"ok": False, "error": str(risk["error"]), "risk": risk}

        # 限价单判定可成交
        fill_price = last
        if order_type == "limit":
            limit = float(price or 0)
            if side in ("buy", "open_long", "close_short"):
                if limit < last:
                    # 未触发: 挂起
                    if existing_order_id is not None:
                        return {"ok": True, "order_id": existing_order_id, "status": "pending", "reason": f"限价 {limit} 未触及现价 {last}"}
                    pending = int(db.execute("SELECT COUNT(*) FROM paper_orders WHERE owner_id=? AND status='pending'", (_owner(),)).fetchone()[0])
                    if pending >= int(get_risk_limits()["max_pending_orders"]):
                        return {"ok": False, "error": "挂单数量达到风控上限", "risk": risk}
                    db.execute(
                        "INSERT INTO paper_orders(owner_id,market,symbol,name,side,order_type,price,quantity,status,filled_qty,created_at,updated_at) "
                        "VALUES(?,?,?,?,?,?,?,?,'pending',0,?,?)",
                        (_owner(), market, symbol, name, side, order_type, limit, quantity, _now(), _now()),
                    )
                    oid = int(db.execute("SELECT last_insert_rowid()").fetchone()[0])
                    return {"ok": True, "order_id": oid, "status": "pending", "reason": f"限价 {limit} 未触及现价 {last},已挂单"}
                fill_price = last
            else:
                if limit > last:
                    if existing_order_id is not None:
                        return {"ok": True, "order_id": existing_order_id, "status": "pending", "reason": f"限价 {limit} 未触及现价 {last}"}
                    pending = int(db.execute("SELECT COUNT(*) FROM paper_orders WHERE owner_id=? AND status='pending'", (_owner(),)).fetchone()[0])
                    if pending >= int(get_risk_limits()["max_pending_orders"]):
                        return {"ok": False, "error": "挂单数量达到风控上限", "risk": risk}
                    db.execute(
                        "INSERT INTO paper_orders(owner_id,market,symbol,name,side,order_type,price,quantity,status,filled_qty,created_at,updated_at) "
                        "VALUES(?,?,?,?,?,?,?,?,'pending',0,?,?)",
                        (_owner(), market, symbol, name, side, order_type, limit, quantity, _now(), _now()),
                    )
                    oid = int(db.execute("SELECT last_insert_rowid()").fetchone()[0])
                    return {"ok": True, "order_id": oid, "status": "pending", "reason": f"限价 {limit} 未触及现价 {last},已挂单"}
                fill_price = last
        fill_price = float(fill_price)

        amount = fill_price * quantity
        fee = _fee(amount, side, market)

        # 校验资金/持仓
        pos = db.execute("SELECT quantity,avg_cost FROM paper_positions WHERE owner_id=? AND market=? AND symbol=?", (_owner(), market, symbol)).fetchone()
        pos_qty = float(pos["quantity"] or 0.0) if pos else 0.0
        if market == "futures":
            margin = amount * FUTURES_MARGIN + fee
            if side in ("open_long", "open_short"):
                if margin > cash:
                    return {"ok": False, "error": f"可用资金不足: 需保证金约 {margin:.0f},可用 {cash:.0f}"}
            elif side == "close_long":
                if pos_qty < quantity:
                    return {"ok": False, "error": f"多头持仓不足: 现有 {pos_qty:.0f}"}
            elif side == "close_short":
                if -pos_qty < quantity:
                    return {"ok": False, "error": f"空头持仓不足: 现有 {-pos_qty:.0f}"}
        else:
            if side == "buy":
                cost = amount + fee
                if cost > cash:
                    return {"ok": False, "error": f"可用资金不足: 需 {cost:.0f},可用 {cash:.0f}"}
            elif side == "sell":
                if pos_qty < quantity:
                    return {"ok": False, "error": f"持仓不足: 现有 {pos_qty:.0f}"}
                bought_today = _bought_today(db, market, symbol)
                sellable = pos_qty - bought_today
                if quantity > sellable + 1e-9:
                    return {"ok": False, "error": f"T+1 限制：可卖 {max(sellable, 0):.0f}（持仓 {pos_qty:.0f}，今日买入 {bought_today:.0f}）"}

        # 成交: 更新仓位与现金。已实现盈亏只记入 realized_pnl 列(由 total_asset 汇总),
        # 不再混进 delta_cash,避免重复计算。
        realized = 0.0
        delta_cash = 0.0
        if market == "futures":
            margin = amount * FUTURES_MARGIN
            avg_at_close = float(pos["avg_cost"]) if pos else fill_price
            if side == "open_long":
                _update_position(db, market, symbol, name, quantity, fill_price)
                delta_cash = -(margin + fee)
            elif side == "open_short":
                _update_position(db, market, symbol, name, -quantity, fill_price)
                delta_cash = -(margin + fee)
            elif side == "close_long":
                _update_position(db, market, symbol, name, -quantity, fill_price)
                realized = (fill_price - avg_at_close) * quantity
                delta_cash = avg_at_close * quantity * FUTURES_MARGIN + realized - fee
            elif side == "close_short":
                _update_position(db, market, symbol, name, quantity, fill_price)
                realized = (avg_at_close - fill_price) * quantity
                delta_cash = avg_at_close * quantity * FUTURES_MARGIN + realized - fee
        else:
            if side == "buy":
                _update_position(db, market, symbol, name, quantity, fill_price)
                delta_cash = -(amount + fee)
            else:  # sell
                _update_position(db, market, symbol, name, -quantity, fill_price)
                if pos:
                    realized = (fill_price - float(pos["avg_cost"])) * quantity
                delta_cash = amount - fee

        new_cash = cash + delta_cash
        db.execute(
            "UPDATE paper_account SET cash=?, realized_pnl=realized_pnl+?, updated_at=? WHERE owner_id=?",
            (new_cash, realized, _now(), _owner()),
        )
        if existing_order_id is None:
            db.execute(
                "INSERT INTO paper_orders(owner_id,market,symbol,name,side,order_type,price,quantity,status,filled_qty,filled_avg,created_at,updated_at) "
                "VALUES(?,?,?,?,?,?,?,?,'filled',?,?,?,?)",
                (_owner(), market, symbol, name, side, order_type, fill_price, quantity, quantity, fill_price, _now(), _now()),
            )
            oid = int(db.execute("SELECT last_insert_rowid()").fetchone()[0])
        else:
            oid = existing_order_id
            db.execute(
                "UPDATE paper_orders SET status='filled', filled_qty=?, filled_avg=?, updated_at=? WHERE id=? AND status='pending'",
                (quantity, fill_price, _now(), oid),
            )
        db.execute(
            "INSERT INTO paper_trades(owner_id,order_id,market,symbol,name,side,price,quantity,fee,created_at) VALUES(?,?,?,?,?,?,?,?,?,?)",
            (_owner(), oid, market, symbol, name, side, fill_price, quantity, fee, _now()),
        )
    audit("paper_trade", {"market": market, "symbol": symbol, "side": side, "price": fill_price, "qty": quantity})
    if side in ("sell", "close_long", "close_short"):
        try:  # 平仓后累计连亏, 达到阈值自动熔断
            riskguard.mark_trade_result(float(realized or 0.0))
        except Exception:  # noqa: BLE001
            pass
    filled = {"ok": True, "order_id": oid, "status": "filled", "price": fill_price, "fee": fee, "realized_pnl": round(realized, 2), "risk": risk}
    if price_limit_unknown:
        filled["price_limit_unknown"] = True
    return filled


def process_pending_orders(limit: int = 100) -> list[dict[str, Any]]:
    """按最新可得报价检查并成交挂单；仅在满足原限价时执行。"""
    with connect() as db:
        rows = [dict(row) for row in db.execute(
            "SELECT id,market,symbol,name,side,order_type,price,quantity FROM paper_orders "
            "WHERE owner_id=? AND status='pending' ORDER BY id ASC LIMIT ?", (_owner(), max(1, min(int(limit), 500)))
        ).fetchall()]
    outcomes: list[dict[str, Any]] = []
    for row in rows:
        result = place_order(
            market=str(row["market"]), symbol=str(row["symbol"]), name=str(row["name"] or ""),
            side=str(row["side"]), order_type=str(row["order_type"]), price=row["price"],
            quantity=float(row["quantity"]), existing_order_id=int(row["id"]),
        )
        if result.get("status") == "filled":
            outcomes.append(result)
    return outcomes


def cancel_order(order_id: int) -> dict[str, Any]:
    with connect() as db:
        row = db.execute("SELECT id,status FROM paper_orders WHERE id=? AND owner_id=?", (order_id, _owner())).fetchone()
        if not row:
            return {"ok": False, "error": "委托不存在"}
        if row["status"] != "pending":
            return {"ok": False, "error": f"该委托已{row['status']},无法撤单"}
        db.execute("UPDATE paper_orders SET status='cancelled', updated_at=? WHERE id=? AND owner_id=?", (_now(), order_id, _owner()))
    return {"ok": True, "order_id": order_id, "status": "cancelled"}


def _list_orders(status: str | None = None, limit: int = 50) -> list[dict[str, Any]]:
    with connect() as db:
        if status and status in ("pending", "filled", "cancelled", "partial"):
            rows = db.execute(
                "SELECT * FROM paper_orders WHERE owner_id=? AND status=? ORDER BY id DESC LIMIT ?", (_owner(), status, limit)
            ).fetchall()
        else:
            rows = db.execute("SELECT * FROM paper_orders WHERE owner_id=? ORDER BY id DESC LIMIT ?", (_owner(), limit)).fetchall()
    return [dict(r) for r in rows]


def _list_trades(limit: int = 50) -> list[dict[str, Any]]:
    with connect() as db:
        rows = db.execute("SELECT * FROM paper_trades WHERE owner_id=? ORDER BY id DESC LIMIT ?", (_owner(), limit)).fetchall()
    return [dict(r) for r in rows]


def reset_account() -> dict[str, Any]:
    with connect() as db:
        db.execute("DELETE FROM paper_trades WHERE owner_id=?", (_owner(),))
        db.execute("DELETE FROM paper_orders WHERE owner_id=?", (_owner(),))
        db.execute("DELETE FROM paper_positions WHERE owner_id=?", (_owner(),))
        db.execute("DELETE FROM conditional_orders WHERE owner_id=?", (_owner(),))
        db.execute(
            "UPDATE paper_account SET cash=initial_cash, realized_pnl=0, updated_at=? WHERE owner_id=?",
            (_now(), _owner()),
        )
    return {"ok": True}


# ---------- 条件单(止损/止盈/移动止损) ----------
CONDITIONAL_KINDS = {"stop_loss", "take_profit", "trailing_stop"}


def _position_for(db, market: str, symbol: str) -> dict[str, Any] | None:
    row = db.execute(
        "SELECT market,symbol,name,quantity,avg_cost,last_price FROM paper_positions WHERE owner_id=? AND market=? AND symbol=?",
        (_owner(), market, symbol),
    ).fetchone()
    return dict(row) if row else None


def create_conditional_order(
    market: str, symbol: str, kind: str, quantity: float,
    trigger_price: float | None = None, trailing_pct: float | None = None,
) -> dict[str, Any]:
    """创建平仓型条件单。必须有对应持仓(条件单即保护性平仓单)。"""
    market = market if market in ("a", "index", "futures") else "a"
    symbol = (symbol or "").strip()
    kind = kind if kind in CONDITIONAL_KINDS else ""
    quantity = float(quantity or 0)
    if not symbol or not math.isfinite(quantity) or quantity <= 0:
        return {"ok": False, "error": "代码与数量必须有效"}
    if not kind:
        return {"ok": False, "error": "kind 必须是 stop_loss / take_profit / trailing_stop"}
    if kind in ("stop_loss", "take_profit"):
        try:
            trigger_price = float(trigger_price)  # type: ignore[arg-type]
        except (TypeError, ValueError) as exc:
            return {"ok": False, "error": "trigger_price 必须是大于 0 的数值"}
        if not math.isfinite(trigger_price) or trigger_price <= 0:
            return {"ok": False, "error": "trigger_price 必须是大于 0 的数值"}
    else:
        try:
            trailing_pct = float(trailing_pct)  # type: ignore[arg-type]
        except (TypeError, ValueError) as exc:
            return {"ok": False, "error": "trailing_pct 必须在 0 与 1 之间"}
        if not math.isfinite(trailing_pct) or not 0 < trailing_pct < 1:
            return {"ok": False, "error": "trailing_pct 必须在 0 与 1 之间(如 0.03 表示 3%)"}
    if market in ("a", "index") and (not quantity.is_integer() or int(quantity) % 100 != 0):
        return {"ok": False, "error": "股票条件单数量必须为 100 股的整数倍"}
    with connect() as db:
        position = _position_for(db, market, symbol)
        if not position or abs(float(position["quantity"] or 0.0)) <= 0:
            return {"ok": False, "error": "该标的当前无持仓，条件单仅支持保护性平仓"}
        holding = abs(float(position["quantity"]))
        if quantity > holding:
            return {"ok": False, "error": f"平仓数量超过持仓: 持有 {holding:.0f}"}
        db.execute(
            "INSERT INTO conditional_orders(owner_id,market,symbol,name,kind,trigger_price,trailing_pct,quantity,status,peak_price) "
            "VALUES(?,?,?,?,?,?,?,?,'pending',?)",
            (_owner(), market, symbol, str(position["name"] or ""), kind,
             trigger_price if kind in ("stop_loss", "take_profit") else None,
             trailing_pct if kind == "trailing_stop" else None,
             quantity, float(position["last_price"] or position["avg_cost"] or 0.0)),
        )
        oid = int(db.execute("SELECT last_insert_rowid()").fetchone()[0])
    audit("conditional_order_created", {"market": market, "symbol": symbol, "kind": kind, "qty": quantity,
                                        "trigger": trigger_price, "trailing": trailing_pct})
    return {"ok": True, "order_id": oid}


def list_conditional_orders(status: str | None = None, limit: int = 100) -> list[dict[str, Any]]:
    with connect() as db:
        if status and status in ("pending", "triggered", "cancelled"):
            rows = db.execute(
                "SELECT * FROM conditional_orders WHERE owner_id=? AND status=? ORDER BY id DESC LIMIT ?",
                (_owner(), status, limit),
            ).fetchall()
        else:
            rows = db.execute(
                "SELECT * FROM conditional_orders WHERE owner_id=? ORDER BY id DESC LIMIT ?",
                (_owner(), limit),
            ).fetchall()
    return [dict(r) for r in rows]


def cancel_conditional_order(order_id: int) -> dict[str, Any]:
    with connect() as db:
        row = db.execute("SELECT id,status FROM conditional_orders WHERE id=? AND owner_id=?", (order_id, _owner())).fetchone()
        if not row:
            return {"ok": False, "error": "条件单不存在"}
        if row["status"] != "pending":
            return {"ok": False, "error": f"该条件单已{row['status']}"}
        db.execute("UPDATE conditional_orders SET status='cancelled', updated_at=? WHERE id=? AND owner_id=?", (_now(), order_id, _owner()))
    return {"ok": True, "order_id": order_id, "status": "cancelled"}


def _close_side_for(market: str, quantity_held: float) -> str | None:
    if market == "futures":
        return "close_long" if quantity_held > 0 else "close_short"
    return "sell"


def process_conditional_orders(limit: int = 100) -> list[dict[str, Any]]:
    """按最新报价检查 pending 条件单; 触发即下保护性市价平仓单(不受熔断限制)。"""
    rows = list_conditional_orders("pending", min(int(limit), 200))
    if not rows:
        return []
    with connect() as db:
        positions = {f"{r['market']}|{r['symbol']}": dict(r) for r in db.execute(
            "SELECT market,symbol,quantity FROM paper_positions WHERE owner_id=?", (_owner(),)).fetchall()}
    prices = _live_prices([(r["market"], r["symbol"]) for r in rows])
    outcomes: list[dict[str, Any]] = []
    for row in rows:
        key = f"{row['market']}|{row['symbol']}"
        position = positions.get(key)
        if not position or abs(float(position["quantity"] or 0.0)) <= 0:
            # 持仓已不存在(可能被手动平仓) → 条件单作废
            with connect() as db:
                db.execute("UPDATE conditional_orders SET status='cancelled', updated_at=? WHERE id=? AND status='pending'", (_now(), row["id"]))
            outcomes.append({"order_id": row["id"], "action": "cancelled", "reason": "持仓已不存在"})
            continue
        price = prices.get((row["market"], row["symbol"].upper() if row["market"] == "futures" else row["symbol"]))
        if price is None:
            continue  # 无报价时跳过本轮
        quantity_held = float(position["quantity"])
        is_long = quantity_held > 0
        kind = row["kind"]
        hit = False
        updates: dict[str, Any] = {"updated_at": _now()}
        if kind == "stop_loss":
            hit = is_long and price <= float(row["trigger_price"])
        elif kind == "take_profit":
            hit = is_long and price >= float(row["trigger_price"])
        elif kind == "trailing_stop":
            pct = float(row["trailing_pct"])
            if is_long:
                peak = max(float(row["peak_price"] or price), price)
                updates["peak_price"] = peak
                hit = price <= peak * (1 - pct)
            else:
                trough = min(float(row["peak_price"] or price), price) if row["peak_price"] else price
                updates["peak_price"] = trough
                hit = price >= trough * (1 + pct)
        if not hit:
            with connect() as db:
                sets = ",".join(f"{k}=?" for k in updates)
                db.execute(f"UPDATE conditional_orders SET {sets} WHERE id=? AND status='pending'", (*updates.values(), row["id"]))
            continue
        # 触发 → 保护性市价平仓(数量不超过当前持仓)
        close_side = _close_side_for(str(row["market"]), quantity_held)
        if close_side is None:
            continue
        qty = min(float(row["quantity"]), abs(quantity_held))
        result = place_order(
            market=str(row["market"]), symbol=str(row["symbol"]), name=str(row["name"] or ""),
            side=close_side, order_type="market", price=None, quantity=qty,
        )
        if result.get("status") == "filled":
            with connect() as db:
                db.execute(
                    "UPDATE conditional_orders SET status='triggered', triggered_order_id=?, triggered_at=?, updated_at=? WHERE id=?",
                    (result.get("order_id"), _now(), _now(), row["id"]),
                )
            outcomes.append({"order_id": row["id"], "action": "triggered", "fill": result})
            try:
                add_notification("conditional_order",
                                 f"条件单触发: {row['symbol']}",
                                 f"{row['kind']} 触发, 已按市价平仓 {qty} (成交价 {result.get('price')})")
            except Exception:  # noqa: BLE001
                pass
    return outcomes


# ---------- FastAPI 路由 ----------
@router.get("/account")
def trade_account() -> dict[str, Any]:
    try:
        return {"ok": True, "updated_at": _now(), **{k: v for k, v in _account_snapshot().items() if k != "positions"}, "positions_count": len(_account_snapshot()["positions"])}
    except Exception as exc:  # noqa: BLE001
        return {"ok": False, "error": f"{type(exc).__name__}: {exc}"}


def promote_from_holdings(holdings: list[dict[str, Any]]) -> dict[str, Any]:
    """把研究持仓同步到当前用户模拟盘：按目标数量市价补仓/减仓（受 T+1 与风控约束）。"""
    _ensure_account()
    snapshot = _account_snapshot()
    current = {(p["market"], p["symbol"]): float(p["quantity"]) for p in snapshot.get("positions") or [] if p.get("market") in ("a", "index")}
    results: list[dict[str, Any]] = []
    for row in holdings:
        symbol = str(row.get("symbol") or "").strip().upper()
        try:
            target = float(row.get("quantity") or 0)
        except (TypeError, ValueError):
            continue
        if not symbol or target <= 0:
            continue
        target = math.floor(target / 100) * 100
        if target <= 0:
            continue
        have = current.get(("a", symbol), 0.0)
        delta = target - have
        if abs(delta) < 100:
            results.append({"symbol": symbol, "action": "skip", "reason": "已接近目标数量"})
            continue
        side = "buy" if delta > 0 else "sell"
        qty = abs(delta)
        placed = place_order("a", symbol, str(row.get("name") or ""), side, "market", None, qty)
        results.append({"symbol": symbol, "side": side, "quantity": qty, **placed})
    ok = sum(1 for item in results if item.get("ok"))
    return {"ok": True, "promoted": ok, "results": results}


@router.post("/promote")
def trade_promote(payload: dict[str, Any] = Body(default=None)) -> dict[str, Any]:
    rows = (payload or {}).get("holdings") if isinstance(payload, dict) else None
    if not rows:
        with connect() as db:
            rows = [dict(r) for r in db.execute("SELECT symbol,name,quantity FROM holdings WHERE owner_id=?", (_owner(),)).fetchall()]
    return promote_from_holdings(rows or [])


@router.get("/risk-limits")
def trade_risk_limits() -> dict[str, Any]:
    return {"ok": True, "limits": get_risk_limits()}


@router.put("/risk-limits")
def trade_update_risk_limits(payload: dict[str, Any] = Body(...)) -> dict[str, Any]:
    try:
        return {"ok": True, "limits": update_risk_limits(payload)}
    except ValueError as exc:
        return {"ok": False, "error": str(exc)}


@router.get("/risk-guard")
def trade_risk_guard() -> dict[str, Any]:
    try:
        return {"ok": True, **riskguard.get_status()}
    except Exception as exc:  # noqa: BLE001
        return {"ok": False, "error": f"{type(exc).__name__}: {exc}"}


@router.put("/risk-guard")
def trade_update_risk_guard(payload: dict[str, Any] = Body(...)) -> dict[str, Any]:
    try:
        riskguard.update_config(payload)
        return {"ok": True, **riskguard.get_status()}
    except ValueError as exc:
        return {"ok": False, "error": str(exc)}


@router.post("/risk-guard/resume")
def trade_resume_risk_guard() -> dict[str, Any]:
    try:
        return {"ok": True, **riskguard.resume()}
    except Exception as exc:  # noqa: BLE001
        return {"ok": False, "error": f"{type(exc).__name__}: {exc}"}


@router.post("/order")
def trade_order(payload: dict[str, Any] = Body(...)) -> dict[str, Any]:
    try:
        return place_order(
            market=str(payload.get("market") or "a"),
            symbol=str(payload.get("symbol") or ""),
            name=str(payload.get("name") or ""),
            side=str(payload.get("side") or "buy"),
            order_type=str(payload.get("order_type") or "market"),
            price=payload.get("price"),
            quantity=float(payload.get("quantity") or 0),
        )
    except Exception as exc:  # noqa: BLE001
        return {"ok": False, "error": f"{type(exc).__name__}: {exc}"}


@router.post("/cancel")
def trade_cancel(payload: dict[str, Any] = Body(...)) -> dict[str, Any]:
    try:
        return cancel_order(int(payload.get("order_id") or 0))
    except Exception as exc:  # noqa: BLE001
        return {"ok": False, "error": f"{type(exc).__name__}: {exc}"}


@router.post("/conditional")
def trade_conditional_create(payload: dict[str, Any] = Body(...)) -> dict[str, Any]:
    try:
        return create_conditional_order(
            market=str(payload.get("market") or "a"),
            symbol=str(payload.get("symbol") or ""),
            kind=str(payload.get("kind") or ""),
            quantity=float(payload.get("quantity") or 0),
            trigger_price=payload.get("trigger_price"),
            trailing_pct=payload.get("trailing_pct"),
        )
    except Exception as exc:  # noqa: BLE001
        return {"ok": False, "error": f"{type(exc).__name__}: {exc}"}


@router.get("/conditional-orders")
def trade_conditional_list(status: str = "", limit: int = 100) -> dict[str, Any]:
    try:
        return {"ok": True, "orders": list_conditional_orders(status or None, limit)}
    except Exception as exc:  # noqa: BLE001
        return {"ok": False, "error": f"{type(exc).__name__}: {exc}", "orders": []}


@router.post("/conditional/cancel")
def trade_conditional_cancel(payload: dict[str, Any] = Body(...)) -> dict[str, Any]:
    try:
        return cancel_conditional_order(int(payload.get("order_id") or 0))
    except Exception as exc:  # noqa: BLE001
        return {"ok": False, "error": f"{type(exc).__name__}: {exc}"}


@router.get("/positions")
def trade_positions() -> dict[str, Any]:
    try:
        snap = _account_snapshot()
        return {"ok": True, "positions": snap["positions"], "market_value": snap["market_value"], "unrealized_pnl": snap["unrealized_pnl"]}
    except Exception as exc:  # noqa: BLE001
        return {"ok": False, "error": f"{type(exc).__name__}: {exc}", "positions": []}


@router.get("/orders")
def trade_orders(status: str = "", limit: int = 50) -> dict[str, Any]:
    try:
        return {"ok": True, "orders": _list_orders(status or None, limit)}
    except Exception as exc:  # noqa: BLE001
        return {"ok": False, "error": f"{type(exc).__name__}: {exc}", "orders": []}


@router.get("/trades")
def trade_trades(limit: int = 50) -> dict[str, Any]:
    try:
        return {"ok": True, "trades": _list_trades(limit)}
    except Exception as exc:  # noqa: BLE001
        return {"ok": False, "error": f"{type(exc).__name__}: {exc}", "trades": []}


@router.post("/reset")
def trade_reset() -> dict[str, Any]:
    try:
        return reset_account()
    except Exception as exc:  # noqa: BLE001
        return {"ok": False, "error": f"{type(exc).__name__}: {exc}"}
