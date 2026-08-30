"""组合级事件驱动回测: 多标的、周期再平衡、双边成本+滑点、净值曲线与逐标的归因。

输入本地已导入的收盘价面板, 按目标权重定期再平衡:
- 组合每日收益 = Σ w_i * r_i (权重随价格漂移, 再平衡日重置为目标权重)
- 换手成本 = |Δw| 之和 × (cost_bps + slippage_bps) / 10000
- 基准 = 已导入基准指数日线(benchmark_closes); 未提供或对不齐时退回等权买入持有
- 涨跌停(price_limit_pct>0): 单日收盘涨跌幅达阈值视为涨停/跌停, 涨停日买入顺延、
  跌停日卖出顺延(反方向可成交); 被挡腿的价值冻结, 其余腿按可用预算缩放,
  待可成交日补足至目标权重, 顺延次数记入 metrics.deferred_trades
- 停牌: 任一标的缺收盘价的交易日整行剔除(全组合顺延, 不用旧价格补数)

基准对比指标: 超额年化、alpha/beta(CAPM, rf=2%)、信息比率、跟踪误差、月度收益表、相对净值。

日历: 输入面板若混入周末/法定节假日行(非交易日), 会在共同对齐后自动剔除,
避免把非交易日当作正常连续交易日参与收益与再平衡计算。
"""
from __future__ import annotations

import datetime as _dt

import numpy as np
import pandas as pd

try:
    from .trading_calendar import is_trading_day
except ImportError:  # pragma: no cover - 脚本方式运行
    from trading_calendar import is_trading_day


class BacktestDataError(ValueError):
    """回测输入数据不满足要求。"""

RF_ANNUAL = 0.02  # 与夏普一致的无风险利率假设


def _resolve_benchmark_nav(panel: pd.DataFrame, benchmark_closes: pd.Series | None) -> tuple[np.ndarray, str]:
    """基准净值与组合收益日对齐（首日=1.0，长度=len(panel)-1）。

    未提供基准、样本过短或无法在全部共同交易日覆盖（缺数据日不做前向填充，
    避免用停更的旧价格失真）时，退回等权买入持有基准。"""
    equal_weight = (panel.iloc[1:] / panel.iloc[0]).mean(axis=1).to_numpy(dtype=float)
    if benchmark_closes is None or len(benchmark_closes.dropna()) < 30:
        return equal_weight, "等权基准"
    bench = benchmark_closes.reindex(panel.index)
    if len(bench) != len(panel) or bench.isna().any():
        return equal_weight, "等权基准"
    values = bench.to_numpy(dtype=float)
    if not np.isfinite(values).all() or (values <= 0).any():
        return equal_weight, "等权基准"
    return values[1:] / values[0], "已导入基准"


def _benchmark_comparison(port_returns: np.ndarray, bench_nav: np.ndarray, ann_ret: float, bench_ann: float) -> dict:
    """CAPM alpha/beta、信息比率、跟踪误差与超额年化。"""
    bench_returns = bench_nav[1:] / bench_nav[:-1] - 1 if len(bench_nav) > 1 else np.array([0.0])
    size = min(len(port_returns), len(bench_returns))
    p, b = port_returns[:size], bench_returns[:size]
    diff = p - b
    if size > 2:
        var_b = float(b.var(ddof=1))
        beta = float(np.cov(p, b, ddof=1)[0, 1] / var_b) if var_b > 0 else 0.0
        diff_std = float(diff.std(ddof=1))
        ir = float(diff.mean() / diff_std * np.sqrt(252)) if diff_std > 0 else 0.0
        tracking_error = float(diff_std * np.sqrt(252))
    else:
        beta = ir = tracking_error = 0.0
    return {
        "excess_annual_return": round(float(ann_ret - bench_ann), 4),
        "alpha_annual": round(float((ann_ret - RF_ANNUAL) - beta * (bench_ann - RF_ANNUAL)), 4),
        "beta": round(beta, 4),
        "information_ratio": round(ir, 3),
        "tracking_error": round(tracking_error, 4),
    }


def _monthly_returns(dates: list[str], nav: np.ndarray, max_months: int = 36) -> list[dict]:
    """月度收益表：按自然月取月末净值，环比上月末（首月以上期初净值 1.0 为基）。"""
    if not dates or len(nav) != len(dates):
        return []
    series = pd.Series(nav, index=pd.to_datetime(dates))
    month_end = series.groupby([series.index.year, series.index.month]).last()
    values = month_end.to_numpy(dtype=float)
    prev = np.concatenate(([1.0], values[:-1]))
    return [
        {"month": f"{year}-{month:02d}", "return": round(float(value / base - 1), 4)}
        for (year, month), value, base in zip(month_end.index, values, prev)
    ][-max_months:]


def run_portfolio_backtest(
    closes: dict[str, pd.Series],
    weights: dict[str, float],
    rebalance_days: int = 20,
    cost_bps: float = 12.0,
    slippage_bps: float = 5.0,
    benchmark_closes: pd.Series | None = None,
    price_limit_pct: float = 0.098,
) -> dict:
    """weights 为目标权重(自动归一化); rebalance_days<=0 表示期初一次性配置不再平衡。

    price_limit_pct>0 启用涨跌停约束(默认 0.098 对应沪深主板 ±10% 留余量,
    20cm 品种可传 0.198; 传 0 关闭): 涨停日不得买入、跌停日不得卖出,
    被挡的腿顺延至下一可成交日补足, 顺延次数计入 metrics.deferred_trades。"""
    if not weights:
        raise BacktestDataError("目标权重不能为空")
    if any(not np.isfinite(float(weight)) or float(weight) <= 0 for weight in weights.values()):
        raise BacktestDataError("当前组合回测仅支持有限的正权重（long-only）")
    if not np.isfinite(cost_bps) or not np.isfinite(slippage_bps) or cost_bps < 0 or slippage_bps < 0:
        raise BacktestDataError("佣金与滑点必须是非负有限数值")
    if not np.isfinite(price_limit_pct) or price_limit_pct < 0 or price_limit_pct >= 1:
        raise BacktestDataError("price_limit_pct 必须在 [0, 1) 内（0 表示关闭涨跌停约束）")
    usable = {s: c.dropna() for s, c in closes.items() if s in weights and len(c.dropna()) >= 30}
    if len(usable) < 1:
        raise BacktestDataError("没有可用标的（每个至少 30 个交易日收盘价）")

    usable_total = sum(float(weights[s]) for s in usable)
    if usable_total <= 0:
        raise BacktestDataError("目标权重之和必须为正")
    dropped = sorted(set(weights) - set(usable))
    if dropped:
        raise BacktestDataError(f"以下目标权重缺少足够价格数据，无法保证满仓回测：{', '.join(dropped)}")
    target = {s: float(weights[s]) / usable_total for s in usable}

    panel = pd.DataFrame(usable).sort_index().dropna(how="any")
    # 交易日历过滤: 剔除混入面板的周末/节假日行(数据源可能带非交易日)
    panel = panel[[is_trading_day(_dt.date.fromisoformat(str(idx)[:10])) for idx in panel.index]]
    if len(panel) < 40:
        raise BacktestDataError(f"共同交易日后样本不足（{len(panel)} 行，至少 40 行）。可减少标的或补齐历史。")
    if not np.isfinite(panel.to_numpy(dtype=float)).all() or (panel.to_numpy(dtype=float) <= 0).any():
        raise BacktestDataError("价格必须为大于 0 的有限数值")

    rets = panel.pct_change().dropna()
    symbols = list(panel.columns)
    m = len(symbols)
    n = len(rets)
    one_side_cost = (float(cost_bps) + float(slippage_bps)) / 10000.0
    limit_enabled = price_limit_pct > 0
    rets_arr = rets.to_numpy(dtype=float)
    limit_up = rets_arr >= price_limit_pct if limit_enabled else np.zeros((n, m), dtype=bool)
    limit_dn = rets_arr <= -price_limit_pct if limit_enabled else np.zeros((n, m), dtype=bool)

    nav_values: list[float] = []
    dates: list[str] = []
    turnover_list: list[float] = []
    contributions = {s: 0.0 for s in symbols}
    costs_total = 0.0

    target_vec = np.array([target[s] for s in symbols])
    w = target_vec.copy()
    cash = 0.0  # 顺延买入滞留的预算(收益按 0 计)
    equity = 1.0
    since_rebal = 0
    pending: set[int] = set()  # 被涨跌停挡住、等待补足的腿
    deferred_trades = 0
    eps = 1e-6
    # 期初建仓成本
    init_cost = one_side_cost * float(np.abs(w).sum())
    costs_total += init_cost
    for i in range(n):
        if i == 0:
            equity *= 1 - init_cost
        r = rets_arr[i]
        gross_growth = float(np.dot(1 + r, w) + cash)
        # 归因: 各标的对当期净值的贡献(按期初权重); 现金部分贡献 0
        for j, s in enumerate(symbols):
            contributions[s] += w[j] * r[j]
        scale = max(gross_growth, 1e-12)
        w = w * (1 + r) / scale
        cash = cash / scale
        since_rebal += 1

        scheduled_due = rebalance_days > 0 and since_rebal >= rebalance_days and i < n - 1
        if (scheduled_due or pending) and i < n - 1:
            # 意向腿: 再平衡日为全部偏离腿; 顺延补足日仅待补腿(其余等下次再平衡)
            intend = {j for j in range(m) if abs(target_vec[j] - w[j]) > eps} if scheduled_due else set(pending)
            frozen: set[int] = set()
            for j in intend:
                gap = target_vec[j] - w[j]
                if (gap > eps and limit_up[i, j]) or (gap < -eps and limit_dn[i, j]):
                    frozen.add(j)
                    if j not in pending:
                        deferred_trades += 1  # 该腿首次被涨跌停挡下, 记一次顺延
            turnover = 0.0
            exec_legs = sorted(intend - frozen)
            if exec_legs:
                # 可动用预算 = 意向腿现值 + 滞留现金; 冻结腿的价值不可动用
                avail = cash + float(sum(w[j] for j in exec_legs))
                want = float(sum(target_vec[j] for j in exec_legs))
                if want <= avail + 1e-9:
                    new_w = {j: target_vec[j] for j in exec_legs}
                    cash = max(avail - want, 0.0)
                else:  # 跌停卖出被挡无法腾出预算时, 其余腿按比例缩放(满仓不变)
                    factor = avail / want
                    new_w = {j: target_vec[j] * factor for j in exec_legs}
                    cash = 0.0
                turnover = float(sum(abs(new_w[j] - w[j]) for j in exec_legs)) / 2.0  # 单边换手率
                for j, value in new_w.items():
                    w[j] = value
            pending = frozen
            if scheduled_due:
                turnover_list.append(turnover)
                since_rebal = 0
            if turnover > eps:
                cost = turnover * one_side_cost * 2.0  # 双边计费
                costs_total += cost
                equity *= 1 - cost

        equity *= gross_growth
        nav_values.append(equity)
        dates.append(str(rets.index[i]))

    # 回测结果按完整往返交易计费，期末按最后持仓清仓。
    final_turnover = float(np.abs(w).sum())
    final_cost = final_turnover * one_side_cost
    costs_total += final_cost
    equity *= 1 - final_cost
    if nav_values:
        nav_values[-1] = equity

    nav = np.array(nav_values)
    # nav 与 rets 同日对齐；以前一交易日前净值 1.0 衔接，首日收益不能丢失。
    port_returns = nav / np.concatenate(([1.0], nav[:-1])) - 1 if len(nav) else np.array([0.0])
    ann_ret = nav[-1] ** (252 / max(len(nav), 1)) - 1
    ann_vol = float(port_returns.std(ddof=1) * np.sqrt(252)) if len(port_returns) > 2 else 0.0
    nav_with_start = np.concatenate(([1.0], nav))
    running_max = np.maximum.accumulate(nav_with_start)
    drawdown = nav_with_start / running_max - 1
    # 基准净值与组合收益日严格对齐（首日=1.0）；真实基准不可用时退回等权买入持有。
    bench_nav, benchmark_name = _resolve_benchmark_nav(panel, benchmark_closes)
    bench_ann = bench_nav[-1] ** (252 / max(len(bench_nav), 1)) - 1
    step = max(len(nav) // 250, 1) if len(nav) else 1
    relative_nav = [round(float(v), 6) for v in (nav / bench_nav)[::step]]

    total_contrib = sum(contributions.values())
    return {
        "available": True,
        "symbols": symbols,
        "weights": {s: round(target[s], 4) for s in symbols},
        "days": len(nav),
        "start": dates[0] if dates else None,
        "end": dates[-1] if dates else None,
        "rebalance_days": rebalance_days,
        "nav": [round(float(v), 6) for v in nav[::step]],
        "nav_dates": dates[:: max(len(dates) // 250, 1)],
        "benchmark_nav": [round(float(v), 6) for v in bench_nav[::step]],
        "relative_nav": relative_nav,
        "metrics": {
            "total_return": round(float(nav[-1] - 1), 4),
            "annual_return": round(float(ann_ret), 4),
            "annual_volatility": round(ann_vol, 4),
            "sharpe": round(float((ann_ret - 0.02) / ann_vol), 3) if ann_vol > 0 else 0.0,
            "max_drawdown": round(float(drawdown.min()), 4),
            "win_rate": round(float((port_returns > 0).mean()), 4),
            "avg_turnover_per_rebal": round(float(np.mean(turnover_list)), 4) if turnover_list else 0.0,
            "rebalances": len(turnover_list),
            "deferred_trades": deferred_trades,
            "total_cost_drag": round(costs_total, 4),
        },
        "benchmark": benchmark_name,
        "benchmark_annual_return": round(float(bench_ann), 4),
        "comparison": _benchmark_comparison(port_returns, bench_nav, float(ann_ret), float(bench_ann)),
        "monthly_returns": _monthly_returns(dates, nav),
        "assumptions": {
            "execution": "initial allocation before first close-to-close return; scheduled rebalances after each completed return",
            "cost_model": "initial buy, turnover on rebalances, and terminal liquidation; benchmark is buy-and-hold before costs",
            "price_limits": (
                f"|daily return| >= {price_limit_pct} 视为一字板: 涨停日买入顺延、跌停日卖出顺延, 被挡腿冻结至下一可成交日"
                if limit_enabled else "price limits disabled"
            ),
            "suspension": "任一标的缺收盘价的交易日整行剔除(全组合顺延), 不做前向填充",
            "trading_calendar": "收益轴按 A 股交易日历剔除周末与法定节假日行(内置 2024-2025 节假日表, 可经 QUANTDESK_EXTRA_HOLIDAYS 扩展)",
            "long_only": True,
            "point_in_time": True,
        },
        "attribution": {s: round(v / max(total_contrib, 1e-9) * (nav[-1] - 1), 4) if total_contrib != 0 else 0.0 for s, v in contributions.items()},
    }


def walk_forward_portfolio(
    closes: dict[str, pd.Series],
    weights: dict[str, float],
    train_days: int = 252,
    test_days: int = 63,
    cost_bps: float = 12.0,
    slippage_bps: float = 5.0,
    price_limit_pct: float = 0.098,
) -> dict:
    """静态目标权重的滚动样本外：训练窗只标定区间，测试窗独立跑含成本再平衡。

    不在训练窗重新优化权重（避免与动量 Walk-Forward 的选参语义混淆）。
    """
    if train_days < 40 or test_days < 20:
        raise BacktestDataError("train_days 至少 40，test_days 至少 20")
    usable = {s: c.dropna() for s, c in closes.items() if s in weights and len(c.dropna()) >= 30}
    if not usable:
        raise BacktestDataError("没有可用标的（每个至少 30 个交易日收盘价）")
    panel = pd.DataFrame(usable).sort_index().dropna(how="any")
    panel = panel[[is_trading_day(_dt.date.fromisoformat(str(idx)[:10])) for idx in panel.index]]
    n = len(panel)
    if n < train_days + test_days:
        raise BacktestDataError(f"共同交易日不足（{n} 行，需要 train+test={train_days + test_days}）")
    dates = [str(idx)[:10] for idx in panel.index]
    windows: list[dict] = []
    oos_sharpes: list[float] = []
    idx = 0
    while idx + train_days + test_days <= n:
        # 测试段向前多取 1 日以便 pct_change；run_portfolio_backtest 要求 >=40 行
        start = idx + train_days
        stop = min(idx + train_days + test_days, n)
        slice_start = max(0, start - 1)
        test_closes = {col: panel[col].iloc[slice_start:stop] for col in panel.columns}
        result = run_portfolio_backtest(
            test_closes, weights,
            rebalance_days=20, cost_bps=cost_bps, slippage_bps=slippage_bps,
            price_limit_pct=price_limit_pct,
        )
        metrics = result.get("metrics") or {}
        oos_sharpes.append(float(metrics.get("sharpe") or 0.0))
        windows.append({
            "train": {"start": dates[idx], "end": dates[start - 1]},
            "test": {"start": dates[start], "end": dates[stop - 1]},
            "oos_annual_return": metrics.get("annual_return"),
            "oos_sharpe": metrics.get("sharpe"),
            "oos_max_drawdown": metrics.get("max_drawdown"),
            "deferred_trades": metrics.get("deferred_trades"),
        })
        idx += test_days
    mean_oos = float(np.mean(oos_sharpes)) if oos_sharpes else 0.0
    return {
        "available": True,
        "n_windows": len(windows),
        "windows": windows,
        "combined": {"mean_oos_sharpe": round(mean_oos, 3)},
        "assumptions": {
            "family": "static target weights on rolling OOS windows",
            "selection": "weights fixed; no in-sample re-optimization",
            "cost_bps": cost_bps,
            "slippage_bps": slippage_bps,
            "point_in_time": True,
        },
    }
