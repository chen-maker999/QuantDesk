import datetime as dt
import os
import tempfile
import unittest
from unittest.mock import patch

os.environ["QUANTDESK_DATA_DIR"] = tempfile.mkdtemp(prefix="quantdesk-cal-test-")

import numpy as np
import pandas as pd  # noqa: E402

from engine.trading_calendar import is_trading_day, next_trading_day, prev_trading_day, trading_days_between  # noqa: E402
from engine.portfolio_backtest import run_portfolio_backtest  # noqa: E402


def make_series(start: str, days: int, base: float = 10.0) -> pd.Series:
    rng = np.random.default_rng(7)
    index = pd.date_range(start, periods=days, freq="B").strftime("%Y-%m-%d")
    return pd.Series(base * np.cumprod(1 + rng.normal(0.001, 0.01, days)), index=index)


class TradingCalendarTest(unittest.TestCase):
    def test_weekends_and_holidays_not_trading(self):
        # 周末
        self.assertFalse(is_trading_day("2025-01-04"))  # 周六
        self.assertFalse(is_trading_day("2025-01-05"))  # 周日
        # 春节(2025-01-28 周二 ~ 2025-02-04 周二)
        for day in ("2025-01-28", "2025-01-30", "2025-02-03", "2025-02-04"):
            self.assertFalse(is_trading_day(day), day)
        # 国庆(2025-10-01 周三 ~)
        self.assertFalse(is_trading_day("2025-10-01"))
        self.assertFalse(is_trading_day("2024-05-01"))  # 劳动节
        # 正常交易日
        self.assertTrue(is_trading_day("2025-01-27"))   # 春节前最后一个交易日(周一)
        self.assertTrue(is_trading_day("2025-02-05"))   # 春节后首个交易日(周三)
        self.assertTrue(is_trading_day(dt.date(2025, 6, 9)))

    def test_extra_holidays_via_env(self):
        with patch.dict(os.environ, {"QUANTDESK_EXTRA_HOLIDAYS": "2026-02-17, 2026-02-18"}):
            self.assertFalse(is_trading_day("2026-02-17"))
            self.assertFalse(is_trading_day("2026-02-18"))
        self.assertTrue(is_trading_day("2026-03-02"))

    def test_next_prev_trading_day_skip_closures(self):
        # 2025-01-27(周一, 春节前最后交易日) → 下个交易日是 2025-02-05(春节后)
        self.assertEqual(next_trading_day("2025-01-27"), dt.date(2025, 2, 5))
        self.assertEqual(next_trading_day("2025-01-27", n=1), dt.date(2025, 2, 5))
        # 2025-02-05 之前最近交易日是 2025-01-27
        self.assertEqual(prev_trading_day("2025-02-05"), dt.date(2025, 1, 27))
        # 周五 → 下周周一
        self.assertEqual(next_trading_day("2025-06-06"), dt.date(2025, 6, 9))

    def test_trading_days_between(self):
        # 一整周(周一到周五, 无节假日) = 5 个交易日
        self.assertEqual(trading_days_between("2025-06-09", "2025-06-13"), 5)
        # 含端午(2025-06-02 周一休市)的区间
        self.assertEqual(trading_days_between("2025-06-02", "2025-06-06"), 4)
        # 含春节休市区间: 2025-01-20(周一) ~ 2025-02-07(周五)
        # 假期前 6 个(1/20-1/24, 1/27) + 假期后 3 个(2/5-2/7) = 9
        self.assertEqual(trading_days_between("2025-01-20", "2025-02-07"), 9)

    def test_backtest_panel_drops_non_trading_rows(self):
        # 构造含周末行的面板: 直接把周末日期插进索引, 日历过滤应剔除
        closes = make_series("2023-01-02", 120)
        extra = closes.iloc[:4] * 1.0
        extra.index = ["2023-01-07", "2023-01-08", "2023-01-14", "2023-01-15"]
        mixed = pd.concat([closes, extra]).sort_index()
        baseline = run_portfolio_backtest({"AAA": closes}, {"AAA": 1.0}, rebalance_days=20)
        filtered = run_portfolio_backtest({"AAA": mixed}, {"AAA": 1.0}, rebalance_days=20)
        # 混入 4 个周末行后被日历剔除, 结果与纯工作日数据一致
        self.assertEqual(filtered["nav"], baseline["nav"])
        self.assertIn("trading_calendar", filtered["assumptions"])


class SchedulerTradingDayFilterTest(unittest.TestCase):
    """定时任务交易日过滤: 周期任务默认不落在非交易日, tradingDaysOnly=false 豁免, once 不受影响。"""

    def _task(self, freq: str) -> dict:
        # 触发时刻设为 1 分钟前(动态), createdAt 再往前 2 分钟, 保证满足"已到点未运行"
        moment = dt.datetime.now() - dt.timedelta(minutes=1)
        created = int((dt.datetime.now() - dt.timedelta(minutes=3)).timestamp() * 1000)
        return {"id": "t1", "enabled": True, "frequency": freq, "hour": moment.hour, "minute": moment.minute,
                "intervalMinutes": 1, "createdAt": created, "lastRunAt": None}

    def test_daily_skips_non_trading_day(self):
        from engine import main
        now_ms = int(__import__("time").time() * 1000)
        with patch.object(main, "is_trading_day", return_value=False):
            self.assertFalse(main._task_due(self._task("daily"), now_ms))
            self.assertFalse(main._task_due(self._task("hourly"), now_ms))
            self.assertFalse(main._task_due(self._task("interval"), now_ms))
        with patch.object(main, "is_trading_day", return_value=True):
            self.assertTrue(main._task_due(self._task("daily"), now_ms))
            self.assertTrue(main._task_due(self._task("interval"), now_ms))

    def test_trading_days_only_false_exempts(self):
        from engine import main
        task = self._task("daily")
        task["tradingDaysOnly"] = False
        with patch.object(main, "is_trading_day", return_value=False):
            self.assertTrue(main._task_due(task, int(__import__("time").time() * 1000)))

    def test_once_ignores_trading_day_filter(self):
        from engine import main
        with patch.object(main, "is_trading_day", return_value=False):
            self.assertTrue(main._task_due(self._task("once"), int(__import__("time").time() * 1000)))


if __name__ == "__main__":
    unittest.main()
