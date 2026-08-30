import json
import os
import tempfile
import unittest

os.environ["QUANTDESK_DATA_DIR"] = tempfile.mkdtemp(prefix="quantdesk-remaining-")

from engine import authx, database, main  # noqa: E402
from engine.scope import current_owner  # noqa: E402


class RemainingFixesTest(unittest.TestCase):
    def setUp(self):
        database.initialize()

    def test_totp_roundtrip(self):
        secret = authx.generate_totp_secret()
        code = authx.totp_code(secret)
        self.assertTrue(authx.verify_totp(secret, code))
        self.assertFalse(authx.verify_totp(secret, "000000"))

    def test_holdings_merge_keeps_unlisted_symbols(self):
        with database.connect() as db:
            db.execute("DELETE FROM holdings")
            db.execute("INSERT INTO holdings(symbol,quantity,market_value) VALUES('AAA',100,1000)")
            db.execute("INSERT INTO holdings(symbol,quantity,market_value) VALUES('BBB',100,1000)")
        _, _, output = main._tool_result("apply_portfolio_proposal", {"weights": {"AAA": 1}}, "full")
        payload = json.loads(output)
        self.assertTrue(payload["applied"])
        self.assertNotIn("BBB", payload.get("removed") or [])
        with database.connect() as db:
            symbols = {row["symbol"] for row in db.execute("SELECT symbol FROM holdings")}
        self.assertIn("BBB", symbols)

    def test_replace_all_removes_unlisted_after_snapshot(self):
        with database.connect() as db:
            db.execute("DELETE FROM holdings")
            db.execute("INSERT INTO holdings(symbol,quantity,market_value) VALUES('AAA',100,1000)")
            db.execute("INSERT INTO holdings(symbol,quantity,market_value) VALUES('BBB',100,1000)")
        _, _, output = main._tool_result("apply_portfolio_proposal", {"weights": {"AAA": 1}, "replace_all": True}, "full")
        payload = json.loads(output)
        self.assertIn("BBB", payload.get("removed") or [])
        self.assertTrue(payload.get("snapshot_id"))

    def test_peer_review_is_readonly(self):
        _, _, output = main._tool_result("peer_review", {"claim": "加仓"}, "ask")
        payload = json.loads(output)
        self.assertTrue(payload["available"])
        self.assertIn(payload["verdict"], {"pass", "caution", "block"})

    def test_second_user_is_operator(self):
        from fastapi.testclient import TestClient
        with TestClient(main.app) as client:
            if not database.count_users():
                client.post("/auth/register", json={"username": "adminuser", "password": "password123"})
            r = client.post("/auth/register", headers={"X-QuantDesk-Token": main.ENGINE_TOKEN}, json={"username": "opuser", "password": "password123"})
            self.assertEqual(r.status_code, 200)
            self.assertEqual(r.json()["user"]["role"], "operator")

    def test_owner_context_isolates_paper_cash(self):
        from engine import papertrade
        papertrade.reset_account()
        token = current_owner.set("user_a")
        try:
            papertrade.reset_account()
            papertrade._ensure_account()
            with database.connect() as db:
                row = db.execute("SELECT owner_id FROM paper_account WHERE owner_id='user_a'").fetchone()
            self.assertIsNotNone(row)
        finally:
            current_owner.reset(token)


class QuantNoFfillTest(unittest.TestCase):
    def test_missing_close_is_not_forward_filled(self):
        import numpy as np
        import pandas as pd
        from engine.quant import build_features
        frame = pd.DataFrame({"x": [10.0, np.nan, 12.0]})
        feat = build_features(frame)
        # 中间缺失不得被前值填成“假行情”
        self.assertTrue(feat.isna().any().any())
