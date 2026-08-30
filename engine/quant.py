from __future__ import annotations

from dataclasses import dataclass
from typing import Any

import numpy as np
import pandas as pd
from scipy.optimize import minimize
from sklearn.covariance import LedoitWolf
from sklearn.ensemble import ExtraTreesRegressor, HistGradientBoostingRegressor
from sklearn.linear_model import Ridge
from sklearn.metrics import mean_squared_error
from sklearn.preprocessing import RobustScaler


TRADING_DAYS = 252


def build_features(prices: pd.DataFrame) -> pd.DataFrame:
    """Build point-in-time price features without backward-looking leakage."""
    close = prices.astype(float).replace(0, np.nan)
    returns = close.pct_change(fill_method=None)
    features: dict[str, pd.DataFrame] = {
        "ret_1": returns,
        "mom_5": close.pct_change(5, fill_method=None),
        "mom_20": close.pct_change(20, fill_method=None),
        "mom_60": close.pct_change(60, fill_method=None),
        "vol_10": returns.rolling(10).std() * np.sqrt(TRADING_DAYS),
        "vol_20": returns.rolling(20).std() * np.sqrt(TRADING_DAYS),
        "downside_20": returns.clip(upper=0).rolling(20).std() * np.sqrt(TRADING_DAYS),
        "ma_gap_10": close / close.rolling(10).mean() - 1,
        "ma_gap_60": close / close.rolling(60).mean() - 1,
    }
    delta = close.diff()
    gain = delta.clip(lower=0).ewm(alpha=1 / 14, adjust=False).mean()
    loss = -delta.clip(upper=0).ewm(alpha=1 / 14, adjust=False).mean()
    features["rsi_14"] = 100 - 100 / (1 + gain / loss.replace(0, np.nan))
    macd = close.ewm(span=12, adjust=False).mean() - close.ewm(span=26, adjust=False).mean()
    features["macd_norm"] = macd / close
    stacked = [frame.stack().rename(name) for name, frame in features.items()]
    return pd.concat(stacked, axis=1).replace([np.inf, -np.inf], np.nan)


@dataclass
class EnsembleResult:
    predictions: np.ndarray
    weights: dict[str, float]
    validation_rmse: dict[str, float]


class AlphaEnsemble:
    """Diverse nonlinear/linear ensemble, weighted by walk-forward validation error."""

    def __init__(self, random_state: int = 42):
        self.scaler = RobustScaler()
        self.models = {
            "hist_gbdt": HistGradientBoostingRegressor(max_iter=160, learning_rate=.045, max_leaf_nodes=20, l2_regularization=1.2, random_state=random_state),
            "extra_trees": ExtraTreesRegressor(n_estimators=220, min_samples_leaf=8, max_features=.8, n_jobs=-1, random_state=random_state),
            "ridge": Ridge(alpha=2.0),
        }
        self.weights: dict[str, float] = {}
        self.validation_rmse: dict[str, float] = {}

    def fit_predict(self, x: np.ndarray, y: np.ndarray, x_next: np.ndarray) -> EnsembleResult:
        split = max(int(len(x) * .78), 30)
        if split >= len(x):
            raise ValueError("At least 40 aligned observations are required")
        # 验证集只能使用训练样本拟合出的变换参数，避免未来分布泄漏到评估结果。
        self.scaler.fit(x[:split])
        x_train_scaled = self.scaler.transform(x[:split])
        x_valid_scaled = self.scaler.transform(x[split:])
        valid_predictions: dict[str, np.ndarray] = {}
        for name, model in self.models.items():
            model.fit(x_train_scaled, y[:split])
            pred = model.predict(x_valid_scaled)
            valid_predictions[name] = pred
            self.validation_rmse[name] = float(np.sqrt(mean_squared_error(y[split:], pred)))
        inverse_error = {k: 1 / max(v, 1e-8) for k, v in self.validation_rmse.items()}
        total = sum(inverse_error.values())
        self.weights = {k: v / total for k, v in inverse_error.items()}
        predictions = np.zeros(len(x_next))
        # 选定模型权重后，才允许以完整历史重拟合供下一期预测使用。
        x_scaled = self.scaler.fit_transform(x)
        x_next_scaled = self.scaler.transform(x_next)
        for name, model in self.models.items():
            model.fit(x_scaled, y)
            predictions += self.weights[name] * model.predict(x_next_scaled)
        return EnsembleResult(predictions, self.weights, self.validation_rmse)


def _safe_cov(returns: np.ndarray) -> np.ndarray:
    if returns.ndim != 2 or returns.shape[0] < 10:
        raise ValueError("Return matrix must contain at least 10 rows")
    if returns.shape[1] < 1 or not np.isfinite(returns).all():
        raise ValueError("Return matrix must contain finite values and at least one asset")
    return LedoitWolf().fit(returns).covariance_ * TRADING_DAYS


def optimize_portfolio(expected_returns: list[float], return_history: list[list[float]], max_weight: float = .12, risk_aversion: float = 5.0) -> dict[str, Any]:
    """Long-only mean-variance allocation with shrinkage covariance and concentration guardrails."""
    mu = np.asarray(expected_returns, dtype=float) * TRADING_DAYS
    matrix = np.asarray(return_history, dtype=float)
    n = len(mu)
    if n < 1 or matrix.ndim != 2 or matrix.shape[1] != n:
        raise ValueError("Expected returns and history columns must align")
    if not np.isfinite(mu).all() or not np.isfinite(max_weight) or not np.isfinite(risk_aversion):
        raise ValueError("Optimization inputs must be finite")
    if max_weight <= 0 or risk_aversion <= 0:
        raise ValueError("max_weight and risk_aversion must be positive")
    if max_weight * n < 1 - 1e-9:
        raise ValueError(f"当前 long-only 且满仓约束不可行：{n} 个资产的 max_weight 至少应为 {1 / n:.6f}")
    cov = _safe_cov(matrix)
    upper = float(max_weight)
    objective = lambda w: float(.5 * risk_aversion * w @ cov @ w - mu @ w)
    result = minimize(objective, np.full(n, 1 / n), method="SLSQP", bounds=[(0, upper)] * n, constraints={"type": "eq", "fun": lambda w: w.sum() - 1}, options={"maxiter": 500, "ftol": 1e-10})
    if not result.success:
        raise ValueError(f"组合优化未收敛：{result.message}")
    weights = np.asarray(result.x, dtype=float)
    if not np.isfinite(weights).all() or abs(float(weights.sum()) - 1) > 1e-6 or float(weights.max()) > upper + 1e-6:
        raise ValueError("组合优化结果不满足权重约束")
    annual_return = float(mu @ weights)
    annual_vol = float(np.sqrt(weights @ cov @ weights))
    contributions = weights * (cov @ weights) / max(weights @ cov @ weights, 1e-12)
    return {
        "weights": weights.round(6).tolist(),
        "annual_return": annual_return,
        "annual_volatility": annual_vol,
        "sharpe": annual_return / max(annual_vol, 1e-12),
        "risk_contributions": contributions.round(6).tolist(),
        "solver": "SLSQP + Ledoit-Wolf shrinkage",
    }


def risk_report(portfolio_returns: list[float], confidence: float = .95) -> dict[str, float]:
    values = np.asarray(portfolio_returns, dtype=float)
    if len(values) < 20:
        raise ValueError("At least 20 returns are required")
    if not np.isfinite(values).all():
        raise ValueError("Returns must be finite")
    cutoff = np.quantile(values, 1 - confidence)
    if np.any(values <= -1):
        raise ValueError("Returns must be greater than -100%")
    # 从初始净值 1.0 开始，首期亏损也必须被计入最大回撤。
    cumulative = np.concatenate(([1.0], np.cumprod(1 + values)))
    peak = np.maximum.accumulate(cumulative)
    drawdown = cumulative / peak - 1
    negative = values[values < 0]
    return {
        "var": float(-cutoff),
        "cvar": float(-values[values <= cutoff].mean()),
        "annual_volatility": float(values.std(ddof=1) * np.sqrt(TRADING_DAYS)),
        "downside_deviation": float(negative.std(ddof=1) * np.sqrt(TRADING_DAYS)) if len(negative) > 1 else 0.0,
        "max_drawdown": float(drawdown.min()),
    }


def backtest_signal(returns: list[float], signals: list[float], cost_bps: float = 12.0) -> dict[str, Any]:
    r = np.asarray(returns, dtype=float)
    s = np.clip(np.asarray(signals, dtype=float), -1, 1)
    if len(r) != len(s) or len(r) < 8:
        raise ValueError("Returns and signals must align and contain at least 8 rows")
    position = np.roll(s, 1)
    position[0] = 0
    turnover = np.abs(np.diff(position, prepend=0))
    strategy = position * r - turnover * cost_bps / 10_000
    wealth = np.cumprod(1 + strategy)
    peak = np.maximum.accumulate(wealth)
    years = len(strategy) / TRADING_DAYS
    annual_return = float(wealth[-1] ** (1 / max(years, 1 / TRADING_DAYS)) - 1)
    annual_vol = float(strategy.std(ddof=1) * np.sqrt(TRADING_DAYS))
    return {
        "annual_return": annual_return,
        "annual_volatility": annual_vol,
        "sharpe": annual_return / max(annual_vol, 1e-12),
        "max_drawdown": float((wealth / peak - 1).min()),
        "win_rate": float((strategy > 0).mean()),
        "turnover": float(turnover.mean() * TRADING_DAYS),
        "equity_curve": wealth.round(6).tolist(),
        "assumptions": {"cost_bps": cost_bps, "signal_lag": 1, "point_in_time": True},
    }


def _momentum_positions(returns: np.ndarray, lookback: int) -> np.ndarray:
    """动量持仓: position_t = sign(截至 t-1 的过去 lookback 日累计收益), 信号滞后一期执行。

    前 lookback 期无完整历史时仓位为 0; 全程只用截止前一日的数据(point-in-time)。"""
    log_w = np.cumsum(np.log1p(returns))
    trailing = log_w - np.concatenate((np.zeros(lookback), log_w[:-lookback]))
    sig = np.where(np.arange(len(returns)) >= lookback - 1, np.sign(np.expm1(trailing)), 0.0)
    return np.concatenate(([0.0], sig[:-1]))


def _sharpe_of(strategy: np.ndarray) -> float:
    return float(strategy.mean() / strategy.std(ddof=1) * np.sqrt(TRADING_DAYS)) if len(strategy) > 2 and strategy.std(ddof=1) > 0 else 0.0


def _annualized_of(strategy: np.ndarray) -> float:
    wealth = float(np.prod(1 + strategy))
    return wealth ** (TRADING_DAYS / max(len(strategy), 1)) - 1


def _max_drawdown_of(strategy: np.ndarray) -> float:
    wealth = np.concatenate(([1.0], np.cumprod(1 + strategy)))
    return float((wealth / np.maximum.accumulate(wealth) - 1).min())


def _wf_range(dates: list[str] | None, start: int, end: int) -> dict[str, str]:
    return {"start": dates[start] if dates else str(start), "end": dates[end - 1] if dates else str(end - 1)}


def walk_forward(
    returns: list[float],
    param_grid: dict[str, list[int]],
    train_days: int = 252,
    test_days: int = 63,
    cost_bps: float = 12.0,
    dates: list[str] | None = None,
) -> dict[str, Any]:
    """滚动 Walk-Forward 检验(防过拟合初步工具)。

    策略族 = 动量持仓(position = sign(过去 lookback 日累计收益), 滞后一期, 计成本)。
    param_grid["lookback"] 给出候选窗口。每个滚动窗:
    - 训练段(train_days)逐参数算样本内夏普并选最优参数;
    - 紧随的测试段(test_days)用该参数做样本外(OOS)评估, 不参与选参。
    输出各窗 OOS 指标、拼接后的合并 OOS 净值与 IS→OOS 衰减; OOS 显著差于 IS 即过拟合信号。
    """
    r = np.asarray(returns, dtype=float)
    n = len(r)
    lookbacks = sorted({int(v) for v in (param_grid or {}).get("lookback", [])})
    if not lookbacks or lookbacks[0] < 1:
        raise ValueError('param_grid 需要正整数 lookback 候选, 如 {"lookback": [5, 10, 20, 60]}')
    if not np.isfinite(r).all() or (r <= -1).any() or n < train_days + test_days:
        raise ValueError(f"收益必须有限且大于 -100%, 且至少需要 train_days+test_days={train_days + test_days} 个观测, 当前 {n} 个")
    if train_days < 60 or test_days < 10:
        raise ValueError("train_days 至少 60, test_days 至少 10")
    if max(lookbacks) > train_days:
        raise ValueError("lookback 候选不能超过 train_days")
    if dates is not None and len(dates) != n:
        dates = None

    # 每个候选参数全局计算策略收益(信号只依赖截止前一日的数据, 按窗切片不产生未来泄漏)。
    strategies: dict[int, np.ndarray] = {}
    for lb in lookbacks:
        positions = _momentum_positions(r, lb)
        turnover = np.abs(np.diff(positions, prepend=0.0))
        strategies[lb] = positions * r - turnover * cost_bps / 10000.0

    windows: list[dict[str, Any]] = []
    oos_parts: list[np.ndarray] = []
    idx = 0
    while idx + train_days + test_days <= n:
        train_slice = slice(idx, idx + train_days)
        test_slice = slice(idx + train_days, min(idx + train_days + test_days, n))
        is_sharpes = {lb: _sharpe_of(strategies[lb][train_slice]) for lb in lookbacks}
        # 并列时取更短 lookback(参数更少者, 抑制过拟合)。
        best = max(lookbacks, key=lambda lb: (is_sharpes[lb], -lb))
        oos = strategies[best][test_slice]
        oos_parts.append(oos)
        windows.append({
            "train": _wf_range(dates, idx, idx + train_days),
            "test": _wf_range(dates, idx + train_days, test_slice.stop),
            "params": {"lookback": best},
            "is_sharpe": round(is_sharpes[best], 3),
            "oos_sharpe": round(_sharpe_of(oos), 3),
            "oos_annual_return": round(_annualized_of(oos), 4),
            "oos_max_drawdown": round(_max_drawdown_of(oos), 4),
        })
        idx += test_days

    combined = np.concatenate(oos_parts)
    wealth = np.cumprod(1 + combined)
    mean_is = float(np.mean([w["is_sharpe"] for w in windows]))
    mean_oos = float(np.mean([w["oos_sharpe"] for w in windows]))
    step = max(len(wealth) // 400, 1)
    return {
        "n_windows": len(windows),
        "oos_days": int(len(combined)),
        "windows": windows,
        "combined": {
            "annual_return": round(_annualized_of(combined), 4),
            "annual_volatility": round(float(combined.std(ddof=1) * np.sqrt(TRADING_DAYS)), 4) if len(combined) > 2 else 0.0,
            "sharpe": round(_sharpe_of(combined), 3),
            "max_drawdown": round(_max_drawdown_of(combined), 4),
            "win_rate": round(float((combined > 0).mean()), 4),
            "equity_curve": [round(float(v), 6) for v in wealth[::step]],
        },
        "overfit_check": {
            "mean_is_sharpe": round(mean_is, 3),
            "mean_oos_sharpe": round(mean_oos, 3),
            "degradation": round(mean_oos / mean_is, 3) if abs(mean_is) > 1e-9 else 0.0,
        },
        "assumptions": {
            "family": "momentum: position = sign(lookback-day cumulative return)",
            "selection": "in-sample sharpe on each train segment",
            "signal_lag": 1,
            "cost_bps": cost_bps,
            "point_in_time": True,
        },
    }


def run_alpha_ensemble(closes: pd.DataFrame, predict_ahead: int = 1, folds: int = 12, min_obs: int = 80) -> dict[str, Any]:
    """在一个标的的收盘序列上训练 AlphaEnsemble,输出验证指标、前滚回测与下一期预测。

    closes: 以日期为索引、含 'close' 单列(升序排列)的 DataFrame。
    特征经 build_features 全部 point-in-time(无未来函数);
    前滚回测每折只用截止日之前的数据训练并预测下一期;
    最终在全部样本上重训得到下一期 ensemble 预测。
    样本不足时抛 ValueError,由调用方转成"数据不足"说明。
    """
    close = closes["close"].astype(float).replace(0, np.nan)
    if len(close) < min_obs:
        raise ValueError(f"仅 {len(close)} 个交易日, 至少需要 {min_obs} 个交易日")
    feat = build_features(close.to_frame("close"))
    feat.index = feat.index.droplevel(-1)  # (date, 'close') -> date
    target = close.pct_change(predict_ahead).shift(-predict_ahead)
    frame = feat.join(target.rename("target")).dropna()
    if len(frame) < min_obs:
        raise ValueError(f"特征对齐后仅 {len(frame)} 个观测, 至少需要 {min_obs} 个")
    x_all = frame.drop(columns="target").to_numpy()
    y_all = frame["target"].to_numpy()
    last_date = frame.index[-1]
    x_next = feat.loc[[last_date]].to_numpy()

    ensemble = AlphaEnsemble()
    result = ensemble.fit_predict(x_all, y_all, x_next)
    forecast = float(result.predictions[0])

    # 前滚回测: 等距切折, 每折只用历史数据训练, 预测下一期, 与真实收益对齐。
    n = len(frame)
    fold = max(10, n // (folds + 1))
    preds: list[float] = []
    actuals: list[float] = []
    for cut in range(n - fold * folds, n - fold, fold):
        if cut < 42:  # AlphaEnsemble 最低需要 ~40 个训练观测
            continue
        x_train = frame.iloc[:cut].drop(columns="target").to_numpy()
        y_train = frame.iloc[:cut]["target"].to_numpy()
        x_test = frame.iloc[[cut]].drop(columns="target").to_numpy()
        try:
            fold_res = AlphaEnsemble(random_state=cut).fit_predict(x_train, y_train, x_test)
        except ValueError:
            continue
        preds.append(float(fold_res.predictions[0]))
        actuals.append(float(frame.iloc[cut]["target"]))

    backtest: dict[str, Any] = {}
    if len(preds) >= 8:
        p = np.asarray(preds)
        std = float(p.std(ddof=1))
        signals = np.clip(p / std, -1, 1) if std > 0 else np.zeros_like(p)
        backtest = backtest_signal(actuals, signals.tolist())
        backtest.pop("equity_curve", None)  # 工具结果精简, 不留整条净值曲线
        backtest["hit_rate"] = float((np.sign(np.asarray(actuals)) * np.sign(p) > 0).mean())

    return {
        "rows": len(frame),
        "window": {"start": str(frame.index[0]), "end": str(last_date)},
        "forecast": {"next_return": round(forecast, 6), "direction": "up" if forecast > 0 else "down", "ahead_days": predict_ahead},
        "ensemble_weights": {k: round(v, 4) for k, v in result.weights.items()},
        "validation_rmse": {k: round(v, 6) for k, v in result.validation_rmse.items()},
        "walk_forward": {"folds": len(preds), "backtest": backtest},
    }
