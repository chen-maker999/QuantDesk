import os
import tempfile
import unittest

os.environ["QUANTDESK_DATA_DIR"] = tempfile.mkdtemp(prefix="quantdesk-paper-test-")

from engine import database, papertrade  # noqa: E402


class PaperTradeTest(unittest.TestCase):
    def setUp(self):
        database.initialize()
        papertrade.reset_account()
        papertrade.update_risk_limits(dict(papertrade.DEFAULT_RISK_LIMITS))
        self.price = 10.0
        self.original_quotes = papertrade.market_quotes
        papertrade.market_quotes = lambda *_args, **_kwargs: {"quotes": [{"symbol": "600519", "price": self.price, "name": "测试"}]}

    def tearDown(self):
        papertrade.market_quotes = self.original_quotes

    def test_pending_limit_order_fills_after_price_reaches_limit(self):
        pending = papertrade.place_order("a", "600519", "测试", "buy", "limit", 9.0, 100)
        self.assertEqual(pending["status"], "pending")
        self.price = 8.8
        fills = papertrade.process_pending_orders()
        self.assertEqual(len(fills), 1)
        self.assertEqual(papertrade._list_orders(status="filled")[0]["status"], "filled")

    def test_stock_lot_and_side_validation(self):
        self.assertFalse(papertrade.place_order("a", "600519", "测试", "buy", "market", None, 1)["ok"])
        self.assertFalse(papertrade.place_order("a", "600519", "测试", "open_short", "market", None, 100)["ok"])

    def test_stock_realized_pnl_is_not_counted_twice_in_total_asset(self):
        self.assertTrue(papertrade.place_order("a", "600519", "测试", "buy", "market", None, 100)["ok"])
        self.price = 12.0
        result = papertrade.place_order("a", "600519", "测试", "sell", "market", None, 100)
        self.assertTrue(result["ok"])
        snapshot = papertrade._account_snapshot()
        self.assertAlmostEqual(snapshot["total_asset"], snapshot["cash"], places=2)
        self.assertAlmostEqual(snapshot["total_asset"], papertrade.INITIAL_CASH + 197.4, places=2)

    def test_pre_trade_risk_blocks_oversized_order(self):
        self.price = 100.0
        result = papertrade.place_order("a", "600519", "测试", "buy", "market", None, 1600)
        self.assertFalse(result["ok"])
        self.assertIn("单笔委托金额", result["error"])
        self.assertIn("risk", result)

    def test_futures_close_returns_realized_pnl_to_cash(self):
        self.assertTrue(papertrade.place_order("futures", "AU2608", "测试期货", "open_long", "market", None, 1)["ok"])
        self.price = 12.0
        result = papertrade.place_order("futures", "AU2608", "测试期货", "close_long", "market", None, 1)
        self.assertTrue(result["ok"])
        snapshot = papertrade._account_snapshot()
        self.assertAlmostEqual(snapshot["total_asset"], snapshot["cash"], places=2)
        self.assertAlmostEqual(snapshot["total_asset"], papertrade.INITIAL_CASH, places=2)


if __name__ == "__main__":
    unittest.main()
