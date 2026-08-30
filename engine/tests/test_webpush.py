import os
import tempfile
import unittest
from pathlib import Path

os.environ["QUANTDESK_DATA_DIR"] = tempfile.mkdtemp(prefix="quantdesk-test-webpush-")

import engine.database as database  # noqa: E402
import engine.webpush as webpush  # noqa: E402


class PushStoreTest(unittest.TestCase):
    def test_subscription_crud_roundtrip(self):
        database.initialize()
        webpush.subscribe("https://push.example.com/sub/1", "p256dh-key", "auth-key", "ua-test")
        webpush.subscribe("https://push.example.com/sub/1", "p256dh-new", "auth-new", "ua-test2")
        subs = database.list_push_subscriptions()
        matched = [s for s in subs if s["endpoint"] == "https://push.example.com/sub/1"]
        self.assertEqual(len(matched), 1)
        self.assertEqual(matched[0]["p256dh"], "p256dh-new")
        self.assertEqual(matched[0]["auth"], "auth-new")
        self.assertEqual(matched[0]["userAgent"], "ua-test2")
        webpush.unsubscribe("https://push.example.com/sub/1")
        self.assertFalse(any(s["endpoint"] == "https://push.example.com/sub/1" for s in database.list_push_subscriptions()))

    def test_status_shape(self):
        database.initialize()
        state = webpush.status()
        self.assertIn("available", state)
        if state["available"]:
            self.assertTrue(state["publicKey"])
            # 公钥是未压缩 P-256 点的 b64url（65 字节 -> 87 字符去填充）
            self.assertEqual(len(state["publicKey"]), 87)
            self.assertEqual(webpush.subscription_count(), 0)
            # dispatch 无订阅时 0 且不抛异常
            self.assertEqual(webpush.dispatch("test", "标题", "正文"), 0)

    def test_vapid_keys_persist(self):
        database.initialize()
        if not webpush.push_available():
            self.skipTest("pywebpush/cryptography 未安装，降级路径已由 status_shape 覆盖")
        pub1 = webpush.vapid_public_key()
        pub2 = webpush.vapid_public_key()
        self.assertEqual(pub1, pub2, "VAPID 公钥必须跨调用稳定（存 settings 表）")
        pem = database.get_setting("push_vapid_private_pem")
        self.assertIn("BEGIN PRIVATE KEY", pem)


if __name__ == "__main__":
    unittest.main()
