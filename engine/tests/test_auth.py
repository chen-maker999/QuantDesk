import os
import tempfile
import unittest

os.environ["QUANTDESK_DATA_DIR"] = tempfile.mkdtemp(prefix="quantdesk-auth-test-")

from fastapi.testclient import TestClient  # noqa: E402

from engine import main  # noqa: E402

# TestClient 不会触发 lifespan，这里手动建表
main.initialize()

client = TestClient(main.app)


class AuthFlowTest(unittest.TestCase):
    def test_01_status_uninitialized_and_protected_endpoints_rejected(self):
        status = client.get("/auth/status").json()
        self.assertFalse(status["initialized"])
        self.assertFalse(status["authenticated"])
        # 无凭证访问受保护接口 → 401
        self.assertEqual(client.get("/workspace/status").status_code, 401)

    def test_02_first_register_open_then_locked(self):
        ok = client.post("/auth/register", json={"username": "owner", "password": "password123"})
        self.assertEqual(ok.status_code, 200)
        body = ok.json()
        self.assertTrue(body["token"])
        self.assertEqual(body["user"]["username"], "owner")
        # 校验规则：弱密码/非法用户名
        self.assertEqual(client.post("/auth/register", json={"username": "x", "password": "password123"}).status_code, 422)
        self.assertEqual(client.post("/auth/register", json={"username": "abc", "password": "short"}).status_code, 422)
        # 已初始化后，匿名注册被拒绝
        denied = client.post("/auth/register", json={"username": "intruder", "password": "password123"})
        self.assertEqual(denied.status_code, 403)

    def test_03_login_and_session_access(self):
        bad = client.post("/auth/login", json={"username": "owner", "password": "wrong-pass"})
        self.assertEqual(bad.status_code, 401)
        good = client.post("/auth/login", json={"username": "owner", "password": "password123"})
        self.assertEqual(good.status_code, 200)
        token = good.json()["token"]
        # 会话令牌可访问受保护接口
        headers = {"X-QuantDesk-Session": token}
        self.assertEqual(client.get("/workspace/status", headers=headers).status_code, 200)
        # /auth/status 报告已认证
        me = client.get("/auth/status", headers=headers).json()
        self.assertTrue(me["authenticated"])
        self.assertEqual(me["user"]["username"], "owner")
        # 登出后会话失效
        self.assertEqual(client.post("/auth/logout", headers=headers).status_code, 200)
        self.assertEqual(client.get("/workspace/status", headers=headers).status_code, 401)

    def test_04_login_rate_limited(self):
        for _ in range(8):
            client.post("/auth/login", json={"username": "owner", "password": "wrong-pass"})
        limited = client.post("/auth/login", json={"username": "owner", "password": "password123"})
        self.assertEqual(limited.status_code, 429)

    def test_05_engine_token_still_trusted(self):
        headers = {"X-QuantDesk-Token": main.ENGINE_TOKEN}
        self.assertEqual(client.get("/workspace/status", headers=headers).status_code, 200)
        # 持进程令牌可再注册新账户（授权内建号）
        second = client.post("/auth/register", headers=headers, json={"username": "second", "password": "password123"})
        self.assertEqual(second.status_code, 200)


if __name__ == "__main__":
    unittest.main()
