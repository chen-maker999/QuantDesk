import json
import os
import tempfile
import unittest

os.environ["QUANTDESK_DATA_DIR"] = tempfile.mkdtemp(prefix="quantdesk-charts-test-")

from engine import main  # noqa: E402
from engine.charting import CHARTS_DIR, render_chart  # noqa: E402


class RenderChartTest(unittest.TestCase):
    """render_chart 工具：净值/柱状/K线渲染、入参校验、免鉴权图片路由。"""

    def test_line_chart_creates_png_and_markdown(self):
        result = render_chart({
            "kind": "line", "title": "回测净值", "ylabel": "净值",
            "labels": ["2024-01-01", "2024-01-02", "2024-01-03"],
            "values": [1.0, 1.05, 0.98], "values2": [1.0, 1.01, 1.02], "label2": "基准",
        })
        self.assertTrue(result["available"], result)
        self.assertRegex(result["file"], r"^/charts/[0-9a-f]{32}\.png$")
        self.assertIn("![回测净值](/charts/", result["markdown"])
        path = CHARTS_DIR / result["file"].rsplit("/", 1)[1]
        self.assertTrue(path.is_file())
        self.assertEqual(path.read_bytes()[:8], b"\x89PNG\r\n\x1a\n")

    def test_bar_and_kline_render(self):
        bar = render_chart({"kind": "bar", "title": "逐标的归因", "labels": ["600519", "000001"], "values": [0.12, -0.05], "ylabel": "收益"})
        self.assertTrue(bar["available"], bar)
        kline = render_chart({
            "kind": "kline", "title": "K线", "labels": ["d1", "d2", "d3", "d4"],
            "open": [10, 10.5, 11, 10.8], "high": [10.8, 11.2, 11.5, 11.2],
            "low": [9.8, 10.2, 10.6, 10.2], "close": [10.5, 11.0, 10.9, 11.1],
        })
        self.assertTrue(kline["available"], kline)

    def test_invalid_payloads_reported_unavailable(self):
        cases = [
            {"kind": "pie", "title": "x"},                                     # 类型不支持
            {"kind": "line", "title": "x"},                                    # 缺 values
            {"kind": "line", "title": "x", "values": [1, "bad", 3]},           # 非数值
            {"kind": "line", "title": "x", "values": [1, 2], "labels": ["a"]}, # labels 长度不一致
            {"kind": "kline", "title": "x", "open": [1], "high": [1], "low": [1], "close": [1, 2]},  # K线长度不一致
        ]
        for arguments in cases:
            result = render_chart(arguments)
            self.assertFalse(result["available"], arguments)
            self.assertIn("reason", result)

    def test_tool_dispatch_read_only_in_ask_mode(self):
        # render_chart 是只读工具，ask 模式也应直接执行（只写图表缓存文件）
        label, detail, output = main._tool_result("render_chart", {"kind": "bar", "title": "测试", "values": [1, 2, 3]}, "ask")
        self.assertEqual(label, "生成图表")
        data = json.loads(output)
        self.assertTrue(data["available"], output)

    def test_chart_route_requires_hmac_query(self):
        from fastapi.testclient import TestClient
        from engine.charting import sign_chart_query
        result = render_chart({"kind": "line", "title": "路由测试", "values": [1, 2]})
        name = result["file"].rsplit("/", 1)[1].split("?")[0]
        with TestClient(main.app) as client:
            self.assertEqual(client.get(f"/charts/{name}").status_code, 401)
            signed = sign_chart_query(name, main.ENGINE_TOKEN)
            r = client.get(f"/charts/{name}?{signed}")
            self.assertEqual(r.status_code, 200)
            self.assertEqual(r.headers["content-type"], "image/png")
            self.assertEqual(client.get("/charts/evil.png").status_code, 404)
            self.assertEqual(client.get(f"/charts/{'0' * 32}.png").status_code, 404)


if __name__ == "__main__":
    unittest.main()
