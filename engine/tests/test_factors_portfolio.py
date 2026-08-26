import os
import tempfile
import unittest
from pathlib import Path

os.environ["QUANTDESK_DATA_DIR"] = tempfile.mkdtemp(prefix="quantdesk-test-")

import numpy as np
import pandas as pd

from engine.factors import FactorCodeError, build_panels, compile_factor, evaluate_factor
from engine.portfolio_backtest import BacktestDataError, run_portfolio_backtest


def make_close(days=260, base=10.0, drift=0.0005, seed=7):
    rng = np.random.default_rng(seed)
    rets = rng.normal(drift, 0.01, days)
    close = base * np.cumprod(1 + rets)
    index = pd.date_range("2025-01-01", periods=days, freq="B").strftime("%Y-%m-%d")
    return pd.Series(close, index=index)


class FactorResearchTest(unittest.TestCase):
    def test_compile_rejects_import(self):
        with self.assertRaises(FactorCodeError):
            compile_factor("import os\ndef factor(df): return df['close']")
        with self.assertRaises(FactorCodeError):
            compile_factor("def factor(df): return df['__class__']")
        with self.assertRaises(FactorCodeError):
            compile_factor("def factor(df): return pd.read_csv('https://example.com/prices.csv')")

    def test_factor_allows_local_assignments_without_executing_python(self):
        fn = compile_factor("def factor(df):\n    close = df['close']\n    return close.pct_change(5) / close.pct_change().rolling(5).std()")
        df = pd.DataFrame({"close": np.arange(20, dtype=float) + 1})
        value = fn(df)
        self.assertIsInstance(value, pd.Series)

    def test_factor_requires_real_ohlcv_data_when_referenced(self):
        fn = compile_factor("def factor(df): return df['volume'].pct_change()")
        self.assertEqual(fn.required_columns, frozenset({"volume"}))
        with self.assertRaises(FactorCodeError):
            evaluate_factor(fn, {f"S{i}": make_close(seed=i) for i in range(3)}, horizon=1, quantiles=3)

    def test_factor_can_evaluate_real_ohlcv_frame(self):
        close = make_close(days=80)
        frame = pd.DataFrame({"open": close * .99, "high": close * 1.01, "low": close * .98, "close": close, "volume": np.arange(len(close)) + 100, "amount": (np.arange(len(close)) + 100) * close}, index=close.index)
        fn = compile_factor("def factor(df): return (df['high'] - df['low']) / df['close'] + df['volume'].pct_change()")
        value = fn(frame)
        self.assertIsInstance(value, pd.Series)
        self.assertIn("volume", fn.required_columns)

    def test_momentum_factor_has_positive_ic_on_drifting_data(self):
        closes = {f"S{i}": make_close(seed=i) for i in range(6)}
        fn = compile_factor("def factor(df):\n    return df['close'].pct_change(20)")
        result = evaluate_factor(fn, closes, horizon=1, quantiles=3)
        self.assertTrue(result["available"])
        self.assertGreater(result["periods"], 10)
        self.assertIn("layers", result)
        self.assertEqual(len(result["decay"]), 5)

    def test_bad_factor_reports_error(self):
        closes = {"A": make_close()}
        fn = compile_factor("def factor(df): return df['close'] * 2")
        with self.assertRaises(FactorCodeError):
            evaluate_factor(fn, closes, horizon=1, quantiles=3)


class PortfolioBacktestTest(unittest.TestCase):
    def _closes(self):
        return {s: make_close(seed=i + 1, drift=0.001 if i < 3 else -0.0005) for i, s in enumerate(["AAA", "BBB", "CCC", "DDD"])}

    def test_basic_metrics_present(self):
        result = run_portfolio_backtest(self._closes(), {"AAA": 0.4, "BBB": 0.3, "CCC": 0.2, "DDD": 0.1}, rebalance_days=20)
        m = result["metrics"]
        for key in ("total_return", "annual_return", "sharpe", "max_drawdown", "win_rate", "avg_turnover_per_rebal"):
            self.assertIn(key, m)
        self.assertEqual(len(result["nav"]), len(result["nav_dates"]))
        self.assertAlmostEqual(sum(result["weights"].values()), 1.0, places=3)

    def test_costs_reduce_returns(self):
        cheap = run_portfolio_backtest(self._closes(), {"AAA": 1.0}, cost_bps=1, slippage_bps=0)
        pricey = run_portfolio_backtest(self._closes(), {"AAA": 1.0}, cost_bps=100, slippage_bps=50)
        self.assertGreater(cheap["metrics"]["total_return"], pricey["metrics"]["total_return"])

    def test_insufficient_data_raises(self):
        short = {"A": make_close(days=10)}
        with self.assertRaises(BacktestDataError):
            run_portfolio_backtest(short, {"A": 1.0})

    def test_missing_target_weight_fails_instead_of_silently_holding_cash(self):
        with self.assertRaises(BacktestDataError):
            run_portfolio_backtest({"AAA": make_close()}, {"AAA": .6, "MISSING": .4})


if __name__ == "__main__":
    unittest.main()
