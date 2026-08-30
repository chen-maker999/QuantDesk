"""A 股交易日历（无外部依赖）。

规则：周六周日恒为非交易日（A 股周末调休上班不开市），法定节假日按内置表；
2024-2025 为官方公布的实际休市安排，2026 年起未公布的部分可通过环境变量
QUANTDESK_EXTRA_HOLIDAYS 追加（逗号分隔 YYYY-MM-DD），例如节前发布新安排时。
"""
from __future__ import annotations

import datetime as _dt
import os

# 内置节假日休市表（仅列工作日休市；周末由规则排除，调休上班的周末自然不开市）
HOLIDAYS: frozenset[str] = frozenset({
    # 2024
    "2024-01-01",
    "2024-02-09", "2024-02-12", "2024-02-13", "2024-02-14", "2024-02-15", "2024-02-16",
    "2024-04-04", "2024-04-05",
    "2024-05-01", "2024-05-02", "2024-05-03",
    "2024-06-10",
    "2024-09-16", "2024-09-17",
    "2024-10-01", "2024-10-02", "2024-10-03", "2024-10-04", "2024-10-07",
    # 2025
    "2025-01-01", "2025-01-28", "2025-01-29", "2025-01-30", "2025-01-31",
    "2025-02-03", "2025-02-04",
    "2025-04-04",
    "2025-05-01", "2025-05-02", "2025-05-05",
    "2025-06-02",
    "2025-10-01", "2025-10-02", "2025-10-03", "2025-10-06", "2025-10-07", "2025-10-08",
    # 2026（官方安排公布前先内置元旦；其余可经 QUANTDESK_EXTRA_HOLIDAYS 追加）
    "2026-01-01", "2026-01-02",
})


def _to_date(value: _dt.date | str) -> _dt.date:
    return _dt.date.fromisoformat(value) if isinstance(value, str) else value


def _extra_holidays() -> frozenset[str]:
    raw = os.environ.get("QUANTDESK_EXTRA_HOLIDAYS", "")
    days = set()
    for token in raw.split(","):
        token = token.strip()
        if token:
            days.add(token)  # 非法格式统一吞掉（视为未配置）
    return frozenset(days)


def is_trading_day(value: _dt.date | str) -> bool:
    """是否为 A 股交易日：非周末且不在节假日表（内置 + 环境变量扩展）。"""
    try:
        day = _to_date(value)
        token = day.isoformat()
    except (TypeError, ValueError):
        return False
    if day.weekday() >= 5:
        return False
    return token not in HOLIDAYS and token not in _extra_holidays()


def next_trading_day(value: _dt.date | str, n: int = 1) -> _dt.date:
    """value 之后（不含当天）的第 n 个交易日。"""
    day = _to_date(value)
    for _ in range(max(n, 1)):
        day += _dt.timedelta(days=1)
        while not is_trading_day(day):
            day += _dt.timedelta(days=1)
    return day


def prev_trading_day(value: _dt.date | str) -> _dt.date:
    """value 之前（不含当天）最近的一个交易日。"""
    day = _to_date(value) - _dt.timedelta(days=1)
    while not is_trading_day(day):
        day -= _dt.timedelta(days=1)
    return day


def trading_days_between(start: _dt.date | str, end: _dt.date | str) -> int:
    """[start, end] 区间内的交易日数量（含两端）。"""
    a, b = _to_date(start), _to_date(end)
    if a > b:
        a, b = b, a
    count, day = 0, a
    while day <= b:
        if is_trading_day(day):
            count += 1
        day += _dt.timedelta(days=1)
    return count
