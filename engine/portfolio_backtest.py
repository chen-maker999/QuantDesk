"""组合级事件驱动回测: 多标的、周期再平衡、双边成本+滑点、净值曲线与逐标的归因。

输入本地已导入的收盘价面板, 按目标权重定期再平衡:
- 组合每日收益 = Σ w_i * r_i (权重随价格漂移, 再平衡日重置为目标权重)
- 换手成本 = |Δw| 之和 × (cost_bps + slippage_bps) / 10000
- 基准 = 等权买入持有
"""
from __future__ import annotations

import numpy as np
import pandas as pd


class BacktestDataError(ValueError):
    """回测输入数据不满足要求。"""


def run_portfolio_backtest(
    closes: dict[str, pd.Series],
    weights: dict[str, float],
    rebalance_days: int = 20,
    cost_bps: float = 12.0,
    slippage_bps: float = 5.0,
) -> dict:
    """weights 为目标权重(自动归一化); rebalance_days<=0 表示期初一次性配置不再平衡。"""
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
    if len(panel) < 40:
        raise BacktestDataError(f"共同交易日后样本不足（{len(panel)} 行，至少 40 行）。可减少标的或补齐历史。")

    rets = panel.pct_change().dropna()
    symbols = list(panel.columns)
    n = len(rets)
    one_side_cost = (float(cost_bps) + float(slippage_bps)) / 10000.0

    nav_values: list[float] = []
    dates: list[str] = []
    turnover_list: list[float] = []
    contributions = {s: 0.0 for s in symbols}
    costs_total = 0.0

    w = np.array([target[s] for s in symbols])
    equity = 1.0
    since_rebal = 0
    # 期初建仓成本
    init_cost = one_side_cost * float(np.abs(w).sum()) / max(float(np.abs(w).sum()), 1e-9)
    costs_total += init_cost
    for i in range(n):
        if i == 0:
            equity *= 1 - init_cost
        r = rets.iloc[i].to_numpy(dtype=float)
        gross_growth = float(np.dot(1 + r, w))
        # 归因: 各标的对当期净值的贡献(按期初权重)
        for j, s in enumerate(symbols):
            contributions[s] += w[j] * r[j]
        w = w * (1 + r) / max(gross_growth, 1e-12)
        since_rebal += 1

        if rebalance_days > 0 and since_rebal >= rebalance_days and i < n - 1:
            target_vec = np.array([target[s] for s in symbols])
            turnover = float(np.abs(target_vec - w).sum()) / 2.0  # 单边换手率
            cost = turnover * one_side_cost * 2.0  # 双边计费
            costs_total += cost
            turnover_list.append(turnover)
            w = target_vec
            since_rebal = 0
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
    port_returns = nav[1:] / nav[:-1] - 1 if len(nav) > 1 else np.array([0.0])
    ann_ret = nav[-1] ** (252 / max(len(nav), 1)) - 1
    ann_vol = float(port_returns.std(ddof=1) * np.sqrt(252)) if len(port_returns) > 2 else 0.0
    nav_with_start = np.concatenate(([1.0], nav))
    running_max = np.maximum.accumulate(nav_with_start)
    drawdown = nav_with_start / running_max - 1
    bench_nav = (panel / panel.iloc[0]).mean(axis=1).to_numpy()
    bench_ret_series = bench_nav[1:] / bench_nav[:-1] - 1 if len(bench_nav) > 1 else np.array([0.0])
    bench_ann = bench_nav[-1] ** (252 / max(len(bench_nav), 1)) - 1

    total_contrib = sum(contributions.values())
    return {
        "available": True,
        "symbols": symbols,
        "weights": {s: round(target[s], 4) for s in symbols},
        "days": len(nav),
        "start": dates[0] if dates else None,
        "end": dates[-1] if dates else None,
        "rebalance_days": rebalance_days,
        "nav": [round(float(v), 6) for v in nav[:: max(len(nav) // 250, 1)]],
        "nav_dates": dates[:: max(len(dates) // 250, 1)],
        "benchmark_nav": [round(float(v), 6) for v in bench_nav[:: max(len(bench_nav) // 250, 1)]],
        "metrics": {
            "total_return": round(float(nav[-1] - 1), 4),
            "annual_return": round(float(ann_ret), 4),
            "annual_volatility": round(ann_vol, 4),
            "sharpe": round(float((ann_ret - 0.02) / ann_vol), 3) if ann_vol > 0 else 0.0,
            "max_drawdown": round(float(drawdown.min()), 4),
            "win_rate": round(float((port_returns > 0).mean()), 4),
            "avg_turnover_per_rebal": round(float(np.mean(turnover_list)), 4) if turnover_list else 0.0,
            "rebalances": len(turnover_list),
            "total_cost_drag": round(costs_total, 4),
        },
        "benchmark_annual_return": round(float(bench_ann), 4),
        "attribution": {s: round(v / max(total_contrib, 1e-9) * (nav[-1] - 1), 4) if total_contrib != 0 else 0.0 for s, v in contributions.items()},
    }
