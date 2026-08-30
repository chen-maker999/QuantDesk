import os
import tempfile
import unittest
from datetime import datetime, timedelta

os.environ["QUANTDESK_DATA_DIR"] = tempfile.mkdtemp(prefix="quantdesk-paper-test-")

from engine import database, papertrade, riskguard  # noqa: E402


class PaperTradeTest(unittest.TestCase):
    def setUp(self):
        database.initialize()
        papertrade.reset_account()
        papertrade.update_risk_limits(dict(papertrade.DEFAULT_RISK_LIMITS))
        database.set_setting(riskguard._state_key(), "{}")
        database.set_setting(riskguard._config_key(), "{}")
        self.price = 10.0
        self.prev = None  # None → prev_close=price，涨跌停不触发
        self.original_quotes = papertrade.market_quotes
        self._slippage = papertrade.MARKET_SLIPPAGE
        papertrade.MARKET_SLIPPAGE = 0.0
        papertrade.market_quotes = lambda *_args, **_kwargs: {"quotes": [{"symbol": "600519", "price": self.price, "name": "测试", "prev_close": self.prev if self.prev is not None else self.price, "volume": 10000, "open": self.price, "high": self.price, "low": self.price}]}

    def tearDown(self):
        papertrade.market_quotes = self.original_quotes
        papertrade.MARKET_SLIPPAGE = self._slippage
        database.set_setting(riskguard._state_key(), "{}")
        database.set_setting(riskguard._config_key(), "{}")

    def _season_buys(self):
        yesterday = (datetime.now() - timedelta(days=1)).strftime("%Y-%m-%d 10:00:00")
        with database.connect() as db:
            db.execute("UPDATE paper_trades SET created_at=? WHERE side='buy'", (yesterday,))

    def _buy(self, qty=100, *, season=True):
        result = papertrade.place_order("a", "600519", "测试", "buy", "market", None, qty)
        self.assertTrue(result["ok"], result.get("error"))
        if season:
            self._season_buys()

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
        self._buy()
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

    # ---------- 条件单 ----------
    def test_conditional_order_requires_holding(self):
        result = papertrade.create_conditional_order("a", "600519", "stop_loss", 100, trigger_price=9.0)
        self.assertFalse(result["ok"])
        self.assertIn("无持仓", result["error"])

    def test_stop_loss_triggers_protective_close(self):
        self._buy()
        result = papertrade.create_conditional_order("a", "600519", "stop_loss", 100, trigger_price=9.0)
        self.assertTrue(result["ok"], result.get("error"))
        self.price = 8.8
        outcomes = papertrade.process_conditional_orders()
        self.assertEqual(len(outcomes), 1)
        self.assertEqual(outcomes[0]["action"], "triggered")
        rows = papertrade.list_conditional_orders()
        self.assertEqual(rows[0]["status"], "triggered")
        self.assertEqual(papertrade._account_snapshot()["positions"], [])

    def test_stop_loss_not_triggered_when_price_above(self):
        self._buy()
        papertrade.create_conditional_order("a", "600519", "stop_loss", 100, trigger_price=9.0)
        self.price = 9.5
        self.assertEqual(papertrade.process_conditional_orders(), [])
        self.assertEqual(papertrade.list_conditional_orders("pending")[0]["status"], "pending")

    def test_take_profit_triggers_when_price_reaches_target(self):
        self._buy()
        papertrade.create_conditional_order("a", "600519", "take_profit", 100, trigger_price=11.0)
        self.price = 11.2
        outcomes = papertrade.process_conditional_orders()
        self.assertEqual(outcomes[0]["action"], "triggered")

    def test_trailing_stop_tracks_peak_then_triggers_on_pullback(self):
        self._buy()
        papertrade.create_conditional_order("a", "600519", "trailing_stop", 100, trailing_pct=0.05)
        self.price = 12.0
        self.assertEqual(papertrade.process_conditional_orders(), [])  # 新高不触发
        self.price = 11.3  # 自峰值回撤 5.83% > 5%
        outcomes = papertrade.process_conditional_orders()
        self.assertEqual(len(outcomes), 1)
        self.assertEqual(outcomes[0]["action"], "triggered")

    def test_conditional_order_cancelled_when_position_gone(self):
        self._buy()
        papertrade.create_conditional_order("a", "600519", "stop_loss", 100, trigger_price=9.0)
        papertrade.place_order("a", "600519", "测试", "sell", "market", None, 100)
        outcomes = papertrade.process_conditional_orders()
        self.assertEqual(outcomes[0]["action"], "cancelled")
        self.assertEqual(papertrade.list_conditional_orders()[0]["status"], "cancelled")

    def test_cancel_conditional_order(self):
        self._buy()
        oid = papertrade.create_conditional_order("a", "600519", "stop_loss", 100, trigger_price=9.0)["order_id"]
        self.assertEqual(papertrade.cancel_conditional_order(oid)["status"], "cancelled")
        self.assertFalse(papertrade.cancel_conditional_order(oid)["ok"])

    # ---------- 账户级风控熔断 ----------
    def test_daily_loss_halt_blocks_open_but_allows_close(self):
        riskguard.update_config({"daily_max_loss_pct": 0.05})
        riskguard.observe_equity(papertrade.INITIAL_CASH)  # 建立当日基线
        state = riskguard.observe_equity(papertrade.INITIAL_CASH * 0.94)  # 回撤 6%
        self.assertTrue(state["halted"])
        self.assertFalse(riskguard.gate("buy")["ok"])
        self.assertTrue(riskguard.gate("sell")["ok"])
        self.assertFalse(papertrade.place_order("a", "600519", "测试", "buy", "market", None, 100)["ok"])
        riskguard.resume()
        self.assertTrue(riskguard.gate("buy")["ok"])

    def test_halted_name_rejects_order(self):
        original = papertrade.market_quotes
        papertrade.market_quotes = lambda *_a, **_k: {"quotes": [{"symbol": "600519", "price": 10.0, "name": "测试停牌", "prev_close": 10.0, "volume": 0}]}
        try:
            result = papertrade.place_order("a", "600519", "测试停牌", "buy", "market", None, 100)
            self.assertFalse(result["ok"])
            self.assertIn("停牌", result["error"])
        finally:
            papertrade.market_quotes = original

    def test_market_slippage_moves_fill_away_from_last(self):
        papertrade.MARKET_SLIPPAGE = 0.01
        result = papertrade.place_order("a", "600519", "测试", "buy", "market", None, 100)
        self.assertTrue(result["ok"], result.get("error"))
        self.assertGreater(result["price"], 10.0)

    def test_t1_blocks_same_day_stock_sale(self):
        self._buy(season=False)
        blocked = papertrade.place_order("a", "600519", "测试", "sell", "market", None, 100)
        self.assertFalse(blocked["ok"])
        self.assertIn("T+1", blocked["error"])
        self._season_buys()
        sold = papertrade.place_order("a", "600519", "测试", "sell", "market", None, 100)
        self.assertTrue(sold["ok"], sold.get("error"))

    def test_limit_up_blocks_buy_and_limit_down_blocks_sell(self):
        self.prev = 10.0
        self.price = 11.0  # +10%
        blocked_buy = papertrade.place_order("a", "600519", "测试", "buy", "market", None, 100)
        self.assertFalse(blocked_buy["ok"])
        self.assertIn("涨停", blocked_buy["error"])
        self.price = 10.0
        self._buy()
        self.price = 9.0  # -10%
        blocked_sell = papertrade.place_order("a", "600519", "测试", "sell", "market", None, 100)
        self.assertFalse(blocked_sell["ok"])
        self.assertIn("跌停", blocked_sell["error"])

    def test_consecutive_loss_halt(self):
        riskguard.update_config({"consecutive_loss_limit": 3})
        riskguard.mark_trade_result(-10.0)
        riskguard.mark_trade_result(-10.0)
        state = riskguard.mark_trade_result(-10.0)
        self.assertTrue(state["halted"])
        self.assertIn("连亏", state["halt_reason"])

    def test_consecutive_loss_resets_on_win(self):
        riskguard.mark_trade_result(-10.0)
        state = riskguard.mark_trade_result(5.0)
        self.assertEqual(state["consec_losses"], 0)
        self.assertFalse(state["halted"])


if __name__ == "__main__":
    unittest.main()
