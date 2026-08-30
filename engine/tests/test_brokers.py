from __future__ import annotations

import unittest

from engine.brokers import BrokerError, BrokerOrderRequest, BrokerRegistry
from engine.main import AGENT_TOOLS
from engine.database import initialize, update_broker_order, upsert_broker_order


class BrokerRegistrySafetyTests(unittest.TestCase):
    def setUp(self) -> None:
        initialize()

    def test_alpaca_status_redacts_secrets_and_defaults_to_paper(self) -> None:
        registry = BrokerRegistry()
        status = registry.configure("alpaca", {
            "api_key": "PK-EXAMPLE-123456",
            "api_secret": "SECRET-EXAMPLE-123456",
            "max_order_notional": 1000,
        })
        self.assertTrue(status["configured"])
        self.assertEqual(status["trading_mode"], "paper")
        self.assertNotIn("api_key", status)
        self.assertNotIn("api_secret", status)

    def test_live_order_requires_a_short_lived_explicit_arm(self) -> None:
        registry = BrokerRegistry()
        registry.configure("alpaca", {
            "api_key": "PK-EXAMPLE-123456",
            "api_secret": "SECRET-EXAMPLE-123456",
            "trading_mode": "live",
            "max_order_notional": 1000,
        })
        request = BrokerOrderRequest(symbol="AAPL", side="buy", quantity=1, estimated_price=100)
        with self.assertRaisesRegex(BrokerError, "尚未解锁"):
            registry._assert_order_allowed("alpaca", request)
        with self.assertRaisesRegex(BrokerError, "ENABLE LIVE TRADING"):
            registry.arm_live("alpaca", "yes")
        armed = registry.arm_live("alpaca", "ENABLE LIVE TRADING")
        self.assertGreater(armed["live_armed_until"], 0)
        registry._assert_order_allowed("alpaca", request)

    def test_order_cap_and_ibkr_loopback_gateway_are_enforced(self) -> None:
        registry = BrokerRegistry()
        registry.configure("ibkr", {"gateway_url": "https://localhost:5000/v1/api", "max_order_notional": 100})
        request = BrokerOrderRequest(symbol="AAPL", side="buy", quantity=2, estimated_price=60, contract_id="265598")
        with self.assertRaisesRegex(BrokerError, "单笔上限"):
            registry._assert_order_allowed("ibkr", request)
        with self.assertRaisesRegex(BrokerError, "本机回环"):
            registry.configure("ibkr", {"gateway_url": "https://gateway.example.com/v1/api", "max_order_notional": 100})

    def test_stop_limit_needs_both_prices(self) -> None:
        with self.assertRaises(ValueError):
            BrokerOrderRequest(symbol="AAPL", side="buy", quantity=1, estimated_price=100, order_type="stop_limit", limit_price=101)

    def test_agent_has_no_real_broker_tool(self) -> None:
        self.assertFalse(any("broker" in str(tool.get("name", "")).lower() for tool in AGENT_TOOLS))

    def test_order_reports_are_monotonic_and_terminal_orders_cannot_regress(self) -> None:
        order_id = "state-machine-test"
        upsert_broker_order({"id": order_id, "broker": "alpaca", "symbol": "AAPL", "side": "buy", "quantity": 10, "status": "submitted"})
        self.assertTrue(update_broker_order(order_id, status="partially_filled", filled_qty=4))
        self.assertFalse(update_broker_order(order_id, status="partially_filled", filled_qty=3))
        self.assertTrue(update_broker_order(order_id, status="filled", filled_qty=10))
        self.assertFalse(update_broker_order(order_id, status="accepted", filled_qty=10))

    def test_client_order_id_is_validated_for_idempotent_retries(self) -> None:
        request = BrokerOrderRequest(symbol="AAPL", side="buy", quantity=1, estimated_price=100, client_order_id="retry-123456")
        self.assertEqual(request.client_order_id, "retry-123456")
        with self.assertRaises(ValueError):
            BrokerOrderRequest(symbol="AAPL", side="buy", quantity=1, estimated_price=100, client_order_id="bad id")
