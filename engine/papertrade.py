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
import math
from typing import Any

from fastapi import APIRouter, Body

try:  # 兼容 dev 与打包产物
    from .database import audit, connect, get_setting
except ImportError:
    try:
        from engine.database import audit, connect, get_setting
    except ImportError:
        from database import audit, connect, get_setting

try:
    from .marketdata import market_quotes
except ImportError:
    try:
        from engine.marketdata import market_quotes
    except ImportError:
        from marketdata import market_quotes

router = APIRouter(prefix="/trade")

INITIAL_CASH = 1_000_000.0
FUTURES_MARGIN = 0.12  # 期货保证金率
SIDES = {"buy", "sell", "open_long", "open_short", "close_long", "close_short"}


def _now() -> str:
    return datetime.now().strftime("%Y-%m-%d %H:%M:%S")


def _ensure_account() -> None:
    with connect() as db:
        db.execute(
            "INSERT OR IGNORE INTO paper_account(id, initial_cash, cash, realized_pnl) VALUES(1, ?, ?, 0)",
            (INITIAL_CASH, INITIAL_CASH),
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
        acc = db.execute("SELECT * FROM paper_account WHERE id=1").fetchone()
        positions = [dict(row) for row in db.execute(
            "SELECT market,symbol,name,quantity,avg_cost,last_price FROM paper_positions ORDER BY market,symbol"
        ).fetchall()]

    live = _live_prices([(p["market"], p["symbol"]) for p in positions if p["market"] != "futures"])
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

    total_asset = float(acc["cash"]) + asset_contrib + float(acc["realized_pnl"] or 0.0)
    return {
        "initial_cash": float(acc["initial_cash"]),
        "cash": float(acc["cash"]),
        "realized_pnl": float(acc["realized_pnl"] or 0.0),
        "unrealized_pnl": round(unrealized, 2),
        "market_value": round(market_value, 2),
        "total_asset": round(total_asset, 2),
        "day_pnl": round(day_pnl, 2),
        "positions": rows,
    }


def _update_position(db, market: str, symbol: str, name: str, quantity: float, price: float) -> None:
    row = db.execute(
        "SELECT quantity,avg_cost FROM paper_positions WHERE market=? AND symbol=?", (market, symbol)
    ).fetchone()
    price = float(price)
    if row is None:
        db.execute(
            "INSERT INTO paper_positions(market,symbol,name,quantity,avg_cost,last_price,updated_at) VALUES(?,?,?,?,?,?,?)",
            (market, symbol, name, quantity, price, price, _now()),
        )
        return
    old_qty = float(row["quantity"] or 0.0)
    old_avg = float(row["avg_cost"] or 0.0)
    new_qty = old_qty + quantity
    if new_qty == 0:
        db.execute("DELETE FROM paper_positions WHERE market=? AND symbol=?", (market, symbol))
        return
    # 加权平均成本: 仅当加仓方向与现仓位一致时并入成本;反手(平后再开)按新价建仓
    if old_qty * quantity > 0:
        new_avg = (old_qty * old_avg + quantity * price) / new_qty
    else:
        new_avg = price
    db.execute(
        "UPDATE paper_positions SET quantity=?, avg_cost=?, last_price=?, updated_at=? WHERE market=? AND symbol=?",
        (new_qty, new_avg, price, _now(), market, symbol),
    )


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
    _ensure_account()

    with connect() as db:
        acc = db.execute("SELECT cash FROM paper_account WHERE id=1").fetchone()
        cash = float(acc["cash"] or 0.0)

        # 取最新价
        last = None
        if market == "futures":
            try:
                qr = market_quotes(symbol, market="futures")
                q0 = (qr.get("quotes") or [{}])[0]
                last = q0.get("price")
                if name == "":
                    name = str(q0.get("name") or "")
            except Exception:  # noqa: BLE001
                last = None
            if last is None and order_type == "limit" and price:
                last = float(price)  # 行情源不可用时,限价单以委托价成交
        else:
            try:
                qr = market_quotes(symbol, market=market)
                q0 = (qr.get("quotes") or [{}])[0]
                last = q0.get("price")
                if name == "":
                    name = str(q0.get("name") or "")
            except Exception:  # noqa: BLE001
                last = None
        if last is None:
            return {"ok": False, "error": "暂无法获取该标的最新价,请稍后再试"}

        # 限价单判定可成交
        fill_price = last
        if order_type == "limit":
            limit = float(price or 0)
            if side in ("buy", "open_long", "close_short"):
                if limit < last:
                    # 未触发: 挂起
                    if existing_order_id is not None:
                        return {"ok": True, "order_id": existing_order_id, "status": "pending", "reason": f"限价 {limit} 未触及现价 {last}"}
                    db.execute(
                        "INSERT INTO paper_orders(market,symbol,name,side,order_type,price,quantity,status,filled_qty,created_at,updated_at) "
                        "VALUES(?,?,?,?,?,?,?,'pending',0,?,?)",
                        (market, symbol, name, side, order_type, limit, quantity, _now(), _now()),
                    )
                    oid = int(db.execute("SELECT last_insert_rowid()").fetchone()[0])
                    return {"ok": True, "order_id": oid, "status": "pending", "reason": f"限价 {limit} 未触及现价 {last},已挂单"}
                fill_price = last
            else:
                if limit > last:
                    if existing_order_id is not None:
                        return {"ok": True, "order_id": existing_order_id, "status": "pending", "reason": f"限价 {limit} 未触及现价 {last}"}
                    db.execute(
                        "INSERT INTO paper_orders(market,symbol,name,side,order_type,price,quantity,status,filled_qty,created_at,updated_at) "
                        "VALUES(?,?,?,?,?,?,?,'pending',0,?,?)",
                        (market, symbol, name, side, order_type, limit, quantity, _now(), _now()),
                    )
                    oid = int(db.execute("SELECT last_insert_rowid()").fetchone()[0])
                    return {"ok": True, "order_id": oid, "status": "pending", "reason": f"限价 {limit} 未触及现价 {last},已挂单"}
                fill_price = last
        fill_price = float(fill_price)

        amount = fill_price * quantity
        fee = _fee(amount, side, market)

        # 校验资金/持仓
        pos = db.execute("SELECT quantity,avg_cost FROM paper_positions WHERE market=? AND symbol=?", (market, symbol)).fetchone()
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
                delta_cash = avg_at_close * quantity * FUTURES_MARGIN - fee
            elif side == "close_short":
                _update_position(db, market, symbol, name, quantity, fill_price)
                realized = (avg_at_close - fill_price) * quantity
                delta_cash = avg_at_close * quantity * FUTURES_MARGIN - fee
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
            "UPDATE paper_account SET cash=?, realized_pnl=realized_pnl+?, updated_at=? WHERE id=1",
            (new_cash, realized, _now()),
        )
        if existing_order_id is None:
            db.execute(
                "INSERT INTO paper_orders(market,symbol,name,side,order_type,price,quantity,status,filled_qty,filled_avg,created_at,updated_at) "
                "VALUES(?,?,?,?,?,?,?,'filled',?,?,?,?)",
                (market, symbol, name, side, order_type, fill_price, quantity, quantity, fill_price, _now(), _now()),
            )
            oid = int(db.execute("SELECT last_insert_rowid()").fetchone()[0])
        else:
            oid = existing_order_id
            db.execute(
                "UPDATE paper_orders SET status='filled', filled_qty=?, filled_avg=?, updated_at=? WHERE id=? AND status='pending'",
                (quantity, fill_price, _now(), oid),
            )
        db.execute(
            "INSERT INTO paper_trades(order_id,market,symbol,name,side,price,quantity,fee,created_at) VALUES(?,?,?,?,?,?,?,?,?)",
            (oid, market, symbol, name, side, fill_price, quantity, fee, _now()),
        )
    audit("paper_trade", {"market": market, "symbol": symbol, "side": side, "price": fill_price, "qty": quantity})
    return {"ok": True, "order_id": oid, "status": "filled", "price": fill_price, "fee": fee, "realized_pnl": round(realized, 2)}


def process_pending_orders(limit: int = 100) -> list[dict[str, Any]]:
    """按最新可得报价检查并成交挂单；仅在满足原限价时执行。"""
    with connect() as db:
        rows = [dict(row) for row in db.execute(
            "SELECT id,market,symbol,name,side,order_type,price,quantity FROM paper_orders "
            "WHERE status='pending' ORDER BY id ASC LIMIT ?", (max(1, min(int(limit), 500)),)
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
        row = db.execute("SELECT id,status FROM paper_orders WHERE id=?", (order_id,)).fetchone()
        if not row:
            return {"ok": False, "error": "委托不存在"}
        if row["status"] != "pending":
            return {"ok": False, "error": f"该委托已{row['status']},无法撤单"}
        db.execute("UPDATE paper_orders SET status='cancelled', updated_at=? WHERE id=?", (_now(), order_id))
    return {"ok": True, "order_id": order_id, "status": "cancelled"}


def _list_orders(status: str | None = None, limit: int = 50) -> list[dict[str, Any]]:
    with connect() as db:
        if status and status in ("pending", "filled", "cancelled", "partial"):
            rows = db.execute(
                "SELECT * FROM paper_orders WHERE status=? ORDER BY id DESC LIMIT ?", (status, limit)
            ).fetchall()
        else:
            rows = db.execute("SELECT * FROM paper_orders ORDER BY id DESC LIMIT ?", (limit,)).fetchall()
    return [dict(r) for r in rows]


def _list_trades(limit: int = 50) -> list[dict[str, Any]]:
    with connect() as db:
        rows = db.execute("SELECT * FROM paper_trades ORDER BY id DESC LIMIT ?", (limit,)).fetchall()
    return [dict(r) for r in rows]


def reset_account() -> dict[str, Any]:
    with connect() as db:
        db.execute("DELETE FROM paper_trades")
        db.execute("DELETE FROM paper_orders")
        db.execute("DELETE FROM paper_positions")
        db.execute(
            "UPDATE paper_account SET cash=initial_cash, realized_pnl=0, updated_at=? WHERE id=1",
            (_now(),),
        )
    return {"ok": True}


# ---------- FastAPI 路由 ----------
@router.get("/account")
def trade_account() -> dict[str, Any]:
    try:
        return {"ok": True, "updated_at": _now(), **{k: v for k, v in _account_snapshot().items() if k != "positions"}, "positions_count": len(_account_snapshot()["positions"])}
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
