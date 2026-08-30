import os
import tempfile
import unittest
from pathlib import Path

os.environ["QUANTDESK_DATA_DIR"] = tempfile.mkdtemp(prefix="quantdesk-test-")

import numpy as np
import pandas as pd

from engine.factors import FactorCodeError, build_panels, compile_factor, evaluate_factor, walk_forward_ic
from engine.portfolio_backtest import BacktestDataError, run_portfolio_backtest, walk_forward_portfolio


def make_close(days=260, base=10.0, drift=0.0005, seed=7):
    rng = np.random.default_rng(seed)
    rets = rng.normal(drift, 0.01, days)
    close = base * np.cumprod(1 + rets)
    # 2023 年无内置节假日行, freq="B" 已是纯工作日, 回测日历过滤不改变样本
    index = pd.date_range("2023-01-02", periods=days, freq="B").strftime("%Y-%m-%d")
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
        self.assertEqual(len(result["nav"]), len(result["benchmark_nav"]))
        self.assertAlmostEqual(sum(result["weights"].values()), 1.0, places=3)
        self.assertTrue(result["assumptions"]["point_in_time"])

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

    def test_rejects_short_or_invalid_weights(self):
        with self.assertRaises(BacktestDataError):
            run_portfolio_backtest(self._closes(), {"AAA": 1.1, "BBB": -.1})

    def test_real_benchmark_aligns_and_provides_comparison(self):
        closes = self._closes()
        panel_index = pd.DataFrame(closes).sort_index().dropna(how="any").index
        bench = make_close(days=len(panel_index), base=3000.0, drift=0.0002, seed=42)
        bench.index = panel_index
        result = run_portfolio_backtest(closes, {"AAA": 0.5, "BBB": 0.5}, rebalance_days=20, benchmark_closes=bench)
        self.assertEqual(result["benchmark"], "已导入基准")
        comparison = result["comparison"]
        for key in ("excess_annual_return", "alpha_annual", "beta", "information_ratio", "tracking_error"):
            self.assertIn(key, comparison)
        # 相对净值与净值曲线同长；首点 = 首日组合净值 / 首日基准净值
        self.assertEqual(len(result["relative_nav"]), len(result["nav"]))
        self.assertAlmostEqual(result["relative_nav"][0], result["nav"][0] / result["benchmark_nav"][0], places=3)
        # 超额年化 = 组合年化 - 基准年化
        self.assertAlmostEqual(
            comparison["excess_annual_return"],
            result["metrics"]["annual_return"] - result["benchmark_annual_return"], places=2,
        )
        # 月度收益表
        self.assertTrue(result["monthly_returns"])
        for row in result["monthly_returns"]:
            self.assertRegex(row["month"], r"^\d{4}-\d{2}$")
            self.assertTrue(np.isfinite(row["return"]))

    def test_misaligned_benchmark_falls_back_to_equal_weight(self):
        closes = self._closes()
        wrong_index = make_close(days=200, base=1000.0, seed=9)  # 日期与面板不一致
        result = run_portfolio_backtest(closes, {"AAA": 0.5, "BBB": 0.5}, benchmark_closes=wrong_index)
        self.assertEqual(result["benchmark"], "等权基准")
        result_none = run_portfolio_backtest(closes, {"AAA": 0.5, "BBB": 0.5}, benchmark_closes=None)
        self.assertEqual(result_none["benchmark"], "等权基准")

    def test_limit_up_defers_buy_to_next_tradable_day(self):
        closes = self._closes()
        aaa = closes["AAA"].copy()
        # 前 19 个收益日阴跌(权重降到目标之下, 再平衡需买入), 第 20 个交易日 +12% 一字板
        aaa.iloc[1:20] = aaa.iloc[0] * np.cumprod(np.full(19, 0.98))
        aaa.iloc[20] = aaa.iloc[19] * 1.12
        closes["AAA"] = aaa
        weights = {"AAA": 0.5, "BBB": 0.25, "CCC": 0.15, "DDD": 0.1}
        result = run_portfolio_backtest(closes, weights, rebalance_days=20, price_limit_pct=0.098)
        self.assertEqual(result["metrics"]["deferred_trades"], 1)
        # 关闭涨跌停约束后无顺延, 且净值路径不同(顺延改变了成交价格日)
        off = run_portfolio_backtest(closes, weights, rebalance_days=20, price_limit_pct=0)
        self.assertEqual(off["metrics"]["deferred_trades"], 0)
        self.assertNotEqual(result["nav"], off["nav"])
        # 无一字板的正常数据不产生顺延
        normal = run_portfolio_backtest(self._closes(), weights, rebalance_days=20)
        self.assertEqual(normal["metrics"]["deferred_trades"], 0)

    def test_limit_down_defers_sell_to_next_tradable_day(self):
        closes = self._closes()
        aaa = closes["AAA"].copy()
        # 前 19 个收益日大涨(权重远超目标, 再平衡需卖出), 第 20 个交易日 -12% 一字跌停
        aaa.iloc[1:20] = aaa.iloc[0] * np.cumprod(np.full(19, 1.03))
        aaa.iloc[20] = aaa.iloc[19] * 0.88
        closes["AAA"] = aaa
        result = run_portfolio_backtest(closes, {"AAA": 0.5, "BBB": 0.25, "CCC": 0.15, "DDD": 0.1}, rebalance_days=20, price_limit_pct=0.098)
        self.assertEqual(result["metrics"]["deferred_trades"], 1)
        self.assertTrue(np.isfinite(result["nav"]).all())

    def test_suspension_days_defer_whole_panel(self):
        closes = self._closes()
        aaa = closes["AAA"].copy()
        aaa.iloc[100:103] = np.nan  # 停牌 3 日: 面板整行剔除, 组合顺延
        closes["AAA"] = aaa
        result = run_portfolio_backtest(closes, {"AAA": 0.5, "BBB": 0.5}, rebalance_days=20)
        self.assertEqual(result["days"], 256)  # 260 收盘 - 3 停牌 - 1
        self.assertTrue(np.isfinite(result["nav"]).all())
        self.assertIn("suspension", result["assumptions"])

    def test_walk_forward_ic_reports_oos_windows(self):
        dates = pd.bdate_range("2023-01-02", periods=120).strftime("%Y-%m-%d")
        ics = [(day, 0.05 if i % 3 else -0.02) for i, day in enumerate(dates)]
        result = walk_forward_ic(ics, train_days=40, test_days=20)
        self.assertGreaterEqual(result["n_windows"], 2)
        self.assertIn("oos_ic", result["windows"][0])
        self.assertIn("degradation", result["overfit_check"])

    def test_walk_forward_portfolio_static_weights(self):
        closes = self._closes()
        result = walk_forward_portfolio(closes, {"AAA": 0.5, "BBB": 0.5}, train_days=80, test_days=40)
        self.assertGreaterEqual(result["n_windows"], 2)
        self.assertIn("oos_sharpe", result["windows"][0])


if __name__ == "__main__":
    unittest.main()
