import os
import tempfile
import unittest
from pathlib import Path

os.environ["QUANTDESK_DATA_DIR"] = tempfile.mkdtemp(prefix="quantdesk-test-alerts-")

import engine.database as database  # noqa: E402
from engine.main import _alert_triggered, ALERT_KINDS  # noqa: E402


class AlertLogicTest(unittest.TestCase):
    def test_all_kinds_documented(self):
        for kind in ("price_above", "price_below", "pct_change_above", "pct_change_below", "concentration_above", "drawdown_below"):
            self.assertIn(kind, ALERT_KINDS)

    def test_price_thresholds(self):
        self.assertTrue(_alert_triggered("price_above", 10.0, 10.5))
        self.assertFalse(_alert_triggered("price_above", 10.0, 9.9))
        self.assertTrue(_alert_triggered("price_below", 8.0, 7.5))

    def test_pct_change_uses_signed_semantics(self):
        self.assertTrue(_alert_triggered("pct_change_above", 5.0, 6.0))
        self.assertFalse(_alert_triggered("pct_change_above", 5.0, 1.0))
        self.assertTrue(_alert_triggered("pct_change_below", 3.0, -4.0))
        self.assertFalse(_alert_triggered("pct_change_below", 8.0, -4.0))

    def test_concentration_and_drawdown(self):
        self.assertTrue(_alert_triggered("concentration_above", 30.0, 45.0))
        self.assertTrue(_alert_triggered("drawdown_below", 20.0, -25.0))
        self.assertFalse(_alert_triggered("drawdown_below", 30.0, -25.0))


class AlertStoreTest(unittest.TestCase):
    def test_crud_roundtrip(self):
        import time as _time
        database.initialize()
        stored = database.upsert_alert({"id": "t1", "symbol": "600519", "market": "a", "kind": "price_above", "threshold": 1500.0, "note": "n", "enabled": True, "createdAt": int(_time.time() * 1000)})
        self.assertEqual(stored["kind"], "price_above")
        alerts = database.list_alerts()
        self.assertTrue(any(a["id"] == "t1" for a in alerts))
        database.mark_alert_triggered("t1", 123)
        self.assertEqual(database.get_alert("t1")["lastTriggeredAt"], 123)
        self.assertTrue(database.delete_alert("t1"))
        self.assertFalse(database.delete_alert("t1"))

    def test_notifications(self):
        database.initialize()
        nid = database.add_notification("test", "标题", "正文")
        unread = database.list_notifications(unread_only=True)
        self.assertTrue(any(n["id"] == nid for n in unread))
        database.mark_notifications_read([nid])
        self.assertFalse(any(n["id"] == nid for n in database.list_notifications(unread_only=True)))


if __name__ == "__main__":
    unittest.main()
