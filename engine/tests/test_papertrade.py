import os
import tempfile
import unittest

os.environ["QUANTDESK_DATA_DIR"] = tempfile.mkdtemp(prefix="quantdesk-paper-test-")

from engine import database, papertrade  # noqa: E402


class PaperTradeTest(unittest.TestCase):
    def setUp(self):
        database.initialize()
        papertrade.reset_account()
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


if __name__ == "__main__":
    unittest.main()
