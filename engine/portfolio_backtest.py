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
    if not weights:
        raise BacktestDataError("目标权重不能为空")
    if any(not np.isfinite(float(weight)) or float(weight) <= 0 for weight in weights.values()):
        raise BacktestDataError("当前组合回测仅支持有限的正权重（long-only）")
    if not np.isfinite(cost_bps) or not np.isfinite(slippage_bps) or cost_bps < 0 or slippage_bps < 0:
        raise BacktestDataError("佣金与滑点必须是非负有限数值")
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
    if not np.isfinite(panel.to_numpy(dtype=float)).all() or (panel.to_numpy(dtype=float) <= 0).any():
        raise BacktestDataError("价格必须为大于 0 的有限数值")

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
    # nav 与 rets 同日对齐；以前一交易日前净值 1.0 衔接，首日收益不能丢失。
    port_returns = nav / np.concatenate(([1.0], nav[:-1])) - 1 if len(nav) else np.array([0.0])
    ann_ret = nav[-1] ** (252 / max(len(nav), 1)) - 1
    ann_vol = float(port_returns.std(ddof=1) * np.sqrt(252)) if len(port_returns) > 2 else 0.0
    nav_with_start = np.concatenate(([1.0], nav))
    running_max = np.maximum.accumulate(nav_with_start)
    drawdown = nav_with_start / running_max - 1
    # 策略净值从 panel 的第一个收益日开始，基准也必须从同一日期开始，避免图表和指标错位。
    bench_nav = (panel.iloc[1:] / panel.iloc[0]).mean(axis=1).to_numpy()
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
        "assumptions": {
            "execution": "initial allocation before first close-to-close return; scheduled rebalances after each completed return",
            "cost_model": "initial buy, turnover on rebalances, and terminal liquidation; benchmark is equal-weight buy-and-hold before costs",
            "long_only": True,
            "point_in_time": True,
        },
        "attribution": {s: round(v / max(total_contrib, 1e-9) * (nav[-1] - 1), 4) if total_contrib != 0 else 0.0 for s, v in contributions.items()},
    }
