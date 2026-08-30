"""Agent 图表渲染 —— matplotlib(Agg) 把净值/柱状/K线渲染为 PNG。

工具 render_chart 由 Agent 调用（数据来自先前工具结果），图片落盘到
DATA_DIR/charts/<uuid>.png。GET /charts/{name} 需要短时 HMAC 签名查询参数
（<img> 无法带头，不能用引擎令牌本身）。
"""
from __future__ import annotations

import hmac
import hashlib
import re
import time
import uuid
from pathlib import Path
from typing import Any

try:
    from .database import DATA_DIR
except ImportError:  # pragma: no cover - script/packaged entry point
    try:
        from engine.database import DATA_DIR
    except ImportError:
        from database import DATA_DIR

CHARTS_DIR = DATA_DIR / "charts"
# 免鉴权下发的文件名只允许 uuid hex + .png
CHART_NAME_RE = re.compile(r"^[0-9a-f]{32}\.png$")
MAX_POINTS = 600
MAX_FILES = 200
_TITLE_MAX = 80


def _load_plt():
    try:
        import matplotlib
        matplotlib.use("Agg")
        import matplotlib.pyplot as plt
        return plt
    except Exception:  # noqa: BLE001 — 未安装 matplotlib 时工具优雅降级
        return None


def _coerce_labels(raw: Any) -> list[str]:
    if not isinstance(raw, list):
        return []
    return [str(item) for item in raw][:MAX_POINTS]


def _coerce_series(raw: Any) -> list[float]:
    if not isinstance(raw, list):
        return []
    out: list[float] = []
    for item in raw[:MAX_POINTS]:
        try:
            value = float(item)
        except (TypeError, ValueError):
            return []
        if value != value or value in (float("inf"), float("-inf")):  # NaN/Inf
            return []
        out.append(value)
    return out


def _setup_style(plt) -> None:
    plt.rcParams["font.sans-serif"] = [
        "Microsoft YaHei", "SimHei", "PingFang SC", "Noto Sans CJK SC", "Arial Unicode MS", "DejaVu Sans",
    ]
    plt.rcParams["axes.unicode_minus"] = False


def _sparse_xticks(ax, labels: list[str], every: int = 10) -> None:
    step = max(1, len(labels) // every)
    picks = list(range(0, len(labels), step))
    if picks[-1] != len(labels) - 1:
        picks.append(len(labels) - 1)
    ax.set_xticks(picks)
    ax.set_xticklabels([labels[i] for i in picks], fontsize=8, rotation=30, ha="right")


def render_chart(arguments: dict[str, Any]) -> dict[str, Any]:
    """执行 render_chart 工具：校验入参 → matplotlib 渲染 → uuid 落盘 → 返回 markdown。"""
    plt = _load_plt()
    if plt is None:
        return {"available": False, "reason": "引擎未安装 matplotlib（requirements 中已声明），无法生成图表"}

    kind = str(arguments.get("kind") or "").strip()
    if kind not in ("line", "bar", "kline"):
        return {"available": False, "reason": f"不支持的图表类型 {kind or '(空)'}，可用 line/bar/kline"}
    title = str(arguments.get("title") or "").strip()[:_TITLE_MAX] or "图表"
    ylabel = str(arguments.get("ylabel") or "").strip()[:30]
    labels = _coerce_labels(arguments.get("labels"))

    if kind == "kline":
        opens = _coerce_series(arguments.get("open"))
        highs = _coerce_series(arguments.get("high"))
        lows = _coerce_series(arguments.get("low"))
        closes = _coerce_series(arguments.get("close"))
        size = len(closes)
        if not size or not (len(opens) == len(highs) == len(lows) == size):
            return {"available": False, "reason": "K线需要等长的 open/high/low/close 数组"}
        if labels and len(labels) != size:
            return {"available": False, "reason": "labels 与 open/high/low/close 长度不一致"}
    else:
        closes = []
        values = _coerce_series(arguments.get("values"))
        if not values:
            return {"available": False, "reason": "values 需要非空的数值数组"}
        if labels and len(labels) != len(values):
            return {"available": False, "reason": "labels 与 values 长度不一致"}
        size = len(values)
        values2 = _coerce_series(arguments.get("values2")) if kind == "line" else []
        if values2 and len(values2) != size:
            return {"available": False, "reason": "values2 与 values 长度不一致"}

    x = list(range(size))
    xlabels = labels if labels else [str(i + 1) for i in x]

    try:
        _setup_style(plt)
        fig, ax = plt.subplots(figsize=(9, 4.2), dpi=110)
        fig.patch.set_facecolor("white")
        ax.set_facecolor("white")
        ax.grid(axis="y", color="#e5e7eb", linewidth=0.7, alpha=0.8)
        ax.set_axisbelow(True)
        for spine in ("top", "right"):
            ax.spines[spine].set_visible(False)

        if kind == "line":
            label2 = str(arguments.get("label2") or "").strip()[:30]
            ax.plot(x, values, color="#2563eb", linewidth=1.8, label=str(arguments.get("label") or title)[:30])
            if values2:
                ax.plot(x, values2, color="#94a3b8", linewidth=1.4, linestyle="--", label=label2 or "对比")
                ax.legend(loc="best", fontsize=8, frameon=False)
            if ylabel:
                ax.set_ylabel(ylabel, fontsize=9)
        elif kind == "bar":
            colors = ["#2563eb" if v >= 0 else "#d64541" for v in values]
            ax.bar(x, values, width=min(0.8, 0.8 * 60 / max(size, 1) + 0.2), color=colors)
            ax.axhline(0, color="#6b7280", linewidth=0.8)
            if ylabel:
                ax.set_ylabel(ylabel, fontsize=9)
        else:  # kline：中国习惯红涨绿跌
            for i in x:
                o, h, lo, c = opens[i], highs[i], lows[i], closes[i]
                color = "#d64541" if c >= o else "#2e9e5b"
                ax.vlines(i, lo, h, color=color, linewidth=1)
                bottom, height = min(o, c), max(abs(c - o), (max(highs) - min(lows)) * 0.004)
                ax.add_patch(plt.Rectangle((i - 0.32, bottom), 0.64, height, facecolor=color, edgecolor=color))
            if ylabel:
                ax.set_ylabel(ylabel, fontsize=9)
        ax.set_title(title, fontsize=12)
        _sparse_xticks(ax, xlabels)

        fig.tight_layout()
        CHARTS_DIR.mkdir(parents=True, exist_ok=True)
        name = f"{uuid.uuid4().hex}.png"
        fig.savefig(CHARTS_DIR / name, format="png")
        plt.close(fig)
    except Exception as exc:  # noqa: BLE001 — 渲染失败不影响对话
        return {"available": False, "reason": f"图表渲染失败：{exc}"}

    _prune_old_charts()
    url = f"/charts/{name}"
    return {"available": True, "title": title, "kind": kind, "points": size, "file": url,
            "markdown": f"![{title}]({url})", "hint": "请把 markdown 字段原样放进回答，用户端会直接显示图片"}


def _prune_old_charts() -> None:
    """最多保留 MAX_FILES 张历史图表，防止数据目录无限增长。"""
    try:
        files = sorted(CHARTS_DIR.glob("*.png"), key=lambda p: p.stat().st_mtime, reverse=True)
        for stale in files[MAX_FILES:]:
            stale.unlink(missing_ok=True)
    except Exception:  # noqa: BLE001 — 清理失败不影响主流程
        pass


def sign_chart_query(name: str, secret: str, ttl_seconds: int = 86400) -> str:
    exp = int(time.time()) + max(60, ttl_seconds)
    payload = f"{name}.{exp}".encode("utf-8")
    sig = hmac.new(secret.encode("utf-8"), payload, hashlib.sha256).hexdigest()[:20]
    return f"exp={exp}&sig={sig}"


def verify_chart_query(name: str, exp: str, sig: str, secret: str) -> bool:
    try:
        expiry = int(exp)
    except (TypeError, ValueError):
        return False
    if expiry < int(time.time()) or not sig:
        return False
    payload = f"{name}.{expiry}".encode("utf-8")
    expect = hmac.new(secret.encode("utf-8"), payload, hashlib.sha256).hexdigest()[:20]
    return hmac.compare_digest(expect, sig)


def chart_path(name: str) -> Path | None:
    """校验文件名并返回已存在的图表路径；非法/不存在返回 None。"""
    if not CHART_NAME_RE.match(name):
        return None
    path = CHARTS_DIR / name
    return path if path.is_file() else None
