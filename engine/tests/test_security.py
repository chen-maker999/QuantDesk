import os
import tempfile
import unittest
import json
from unittest.mock import patch

import numpy as np
import pandas as pd

os.environ["QUANTDESK_DATA_DIR"] = tempfile.mkdtemp(prefix="quantdesk-security-test-")

from engine import main  # noqa: E402
from engine.main import _tool_result  # noqa: E402
from engine.netsec import UnsafeUrlError, validate_public_https_url  # noqa: E402


class SecurityBoundaryTest(unittest.TestCase):
    def test_read_only_agent_modes_cannot_mutate_local_state(self):
        for mode in ("ask", "approve"):
            _, _, output = _tool_result("place_paper_order", {"symbol": "600519", "side": "buy", "quantity": 100}, mode)
            self.assertIn('"applied": false', output)

    def test_network_exit_rejects_local_and_non_https_urls(self):
        for url in ("http://example.com", "https://127.0.0.1:8765", "https://localhost"):
            with self.assertRaises(UnsafeUrlError):
                validate_public_https_url(url)

    def test_strategy_backtest_honors_requested_calendar_window(self):
        dates = pd.bdate_range("2022-01-03", periods=900).strftime("%Y-%m-%d")
        prices = [(day, float(100 + index)) for index, day in enumerate(dates)]
        with patch.object(main, "_price_series", return_value={"TEST": prices}):
            _, _, output = main._tool_result("run_strategy_backtest", {"years": 1}, "ask")
        result = json.loads(output)
        self.assertTrue(result["available"])
        self.assertEqual(result["requested_years"], 1)
        self.assertLess(result["observations"], 270)

    def test_read_only_factor_research_does_not_save_experiment(self):
        series = {f"S{i}": [(day, float(10 + index + i)) for index, day in enumerate(pd.bdate_range("2024-01-01", periods=100).strftime("%Y-%m-%d"))] for i in range(3)}
        with patch.object(main, "_price_series", return_value=series), patch.object(main, "read_analysis_bars", return_value=[]), patch.object(main, "evaluate_factor", return_value={"available": True, "symbols": ["S0", "S1", "S2"], "ic_mean": .1, "ic_ir": .2}), patch.object(main, "save_experiment") as save:
            _, _, output = main._tool_result("run_factor_research", {"code": "def factor(df): return df['close'].pct_change(5)"}, "ask")
        self.assertIn('"available": true', output)
        save.assert_not_called()


if __name__ == "__main__":
    unittest.main()
