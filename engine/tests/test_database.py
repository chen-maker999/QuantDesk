import os
import sqlite3
import tempfile
import time
import unittest
from unittest.mock import patch

os.environ["QUANTDESK_DATA_DIR"] = tempfile.mkdtemp(prefix="quantdesk-db-test-")

from fastapi.testclient import TestClient  # noqa: E402

from engine import database, main  # noqa: E402


class DatabaseBackupTest(unittest.TestCase):
    def setUp(self):
        database.initialize()
        # 清空备份目录，保证用例相互独立
        for stale in database.BACKUP_DIR.glob("quantdesk-*.db"):
            stale.unlink(missing_ok=True)
        database._last_backup_day = ""

    def test_run_backup_creates_readable_copy(self):
        with database.connect() as db:
            db.execute("INSERT INTO settings(key, value) VALUES('probe', 'v1') ON CONFLICT(key) DO UPDATE SET value='v1'")
        result = database.run_backup()
        self.assertEqual(result["file"], f"quantdesk-{time.strftime('%Y%m%d')}.db")
        self.assertGreater(result["size"], 0)
        self.assertTrue(database.BACKUP_DIR.joinpath(result["file"]).exists())
        check = sqlite3.connect(result["path"])
        try:
            row = check.execute("SELECT value FROM settings WHERE key='probe'").fetchone()
            self.assertEqual(row[0], "v1")
        finally:
            check.close()

    def test_backup_integrity_verification_and_restore_drill(self):
        result = database.run_backup()
        verified = database.verify_backup(result["file"])
        self.assertTrue(verified["ok"])
        self.assertEqual(verified["sha256"], result["sha256"])
        self.assertTrue(verified["integrity"].lower() == "ok")
        self.assertFalse(database.verify_backup("..\\quantdesk-secret.db")["ok"])

    def test_prune_keeps_only_recent_backups(self):
        for i in range(16):
            database.BACKUP_DIR.joinpath(f"quantdesk-2026{i:02d}01.db").write_bytes(b"x")
        database._prune_backups()
        remaining = list(database.BACKUP_DIR.glob("quantdesk-*.db"))
        self.assertEqual(len(remaining), database.BACKUP_KEEP)

    def test_list_backups_sorted_with_metadata(self):
        database.BACKUP_DIR.joinpath("quantdesk-20260101.db").write_bytes(b"a")
        database.BACKUP_DIR.joinpath("quantdesk-20260103.db").write_bytes(b"b")
        listing = database.list_backups()
        names = [item["file"] for item in listing]
        self.assertEqual(names, sorted(names))
        self.assertGreaterEqual(len(listing), 2)
        for item in listing:
            self.assertGreater(item["size"], 0)
            self.assertIn("modified", item)

    def test_daily_backup_skips_missing_db_and_same_day(self):
        # DB 不存在 → 不备份
        with patch.object(database, "DB_PATH", database.DATA_DIR / "missing.db"):
            self.assertIsNone(database.maybe_daily_backup())
        # DB 存在 → 当天首次备份成功，重复调用跳过
        first = database.maybe_daily_backup()
        self.assertIsNotNone(first)
        self.assertIsNone(database.maybe_daily_backup())

    def test_backup_endpoints_require_token_and_work(self):
        client = TestClient(main.app)
        # 未带令牌 → 401
        self.assertEqual(client.get("/backups").status_code, 401)
        headers = {"X-QuantDesk-Token": "db-test-token"}
        with patch.object(main, "ENGINE_TOKEN", "db-test-token"):
            listing = client.get("/backups", headers=headers)
            self.assertEqual(listing.status_code, 200)
            self.assertIsInstance(listing.json(), list)
            made = client.post("/backups/now", headers=headers)
            self.assertEqual(made.status_code, 200)
            body = made.json()
            self.assertIn("file", body)
            self.assertGreater(body["size"], 0)
            checked = client.get(f"/backups/verify?file={body['file']}", headers=headers)
            self.assertEqual(checked.status_code, 200)
            self.assertTrue(checked.json()["ok"])
            drill = client.post(f"/backups/restore-drill?file={body['file']}", headers=headers)
            self.assertEqual(drill.status_code, 200)
            self.assertTrue(drill.json()["drill"])


    def test_agent_usage_series_aggregates_and_pads_zero(self):
        import datetime as dt
        database.initialize()
        today = dt.date.today()
        for offset, calls, runs in [(0, 3, 2), (3, 5, 1)]:
            database.bump_agent_usage((today - dt.timedelta(days=offset)).isoformat(), tool_calls=calls, runs=runs)
            database.bump_agent_usage((today - dt.timedelta(days=offset)).isoformat(), tool_calls=calls, runs=0)
        result = database.get_agent_usage_series(14)
        self.assertEqual(result["days"], 14)
        self.assertEqual(len(result["series"]), 14)
        # 序列按日期升序，最后一天是今天
        self.assertEqual(result["series"][-1]["day"], today.isoformat())
        self.assertEqual(result["series"][-1]["tool_calls"], 6)
        self.assertEqual(result["series"][-4]["tool_calls"], 10)
        self.assertEqual(result["series"][-4]["runs"], 1)
        # 中间缺失日补零
        self.assertEqual(result["series"][-2]["tool_calls"], 0)
        self.assertEqual(result["series"][-3]["tool_calls"], 0)
        self.assertEqual(result["total"]["tool_calls"], 16)
        self.assertEqual(result["total"]["runs"], 3)

    def test_agent_usage_endpoint(self):
        client = TestClient(main.app)
        with patch.object(main, "ENGINE_TOKEN", "db-test-token"):
            resp = client.get("/agent/usage?days=7", headers={"X-QuantDesk-Token": "db-test-token"})
            self.assertEqual(resp.status_code, 200)
            body = resp.json()
            self.assertEqual(len(body["series"]), 7)
            self.assertIn("total", body)
            self.assertIn("quota", body)
            # 参数校验
            self.assertEqual(client.get("/agent/usage?days=0", headers={"X-QuantDesk-Token": "db-test-token"}).status_code, 422)


if __name__ == "__main__":
    unittest.main()
