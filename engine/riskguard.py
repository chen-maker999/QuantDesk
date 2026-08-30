# -*- coding: utf-8 -*-
"""账户级风控熔断（risk guard）。

与 papertrade.py 的"单笔预交易限额"互补，本模块负责账户维度的自动熔断:
- 当日亏损熔断: 当日权益较当日基线回撤超过 daily_max_loss_pct → 停止新开仓;
- 连续亏损熔断: 连续 consecutive_loss_limit 笔平仓亏损 → 停止新开仓;
- 熔断只禁止加仓方向的委托，减仓/平仓始终放行(可人工恢复 resume)。

状态与配置沿用 papertrade 的 settings JSON 模式(单账户场景)，避免额外建表迁移。
"""
from __future__ import annotations

import json
import math
from datetime import datetime
from typing import Any

try:  # 兼容 dev 与打包产物
    from .database import add_notification, audit, get_setting, set_setting
except ImportError:
    try:
        from engine.database import add_notification, audit, get_setting, set_setting
    except ImportError:
        from database import add_notification, audit, get_setting, set_setting

STATE_KEY = "paper_risk_state"
DEFAULT_CONFIG = {
    "daily_max_loss_pct": 0.05,      # 当日权益回撤 5% 熔断
    "consecutive_loss_limit": 3,     # 连续 3 笔平仓亏损熔断
}


def _owner_suffix() -> str:
    try:
        from .scope import owner_id
    except ImportError:
        try:
            from engine.scope import owner_id
        except ImportError:
            from scope import owner_id
    return owner_id()


def _state_key() -> str:
    return f"{STATE_KEY}:{_owner_suffix()}"


def _config_key() -> str:
    return f"paper_risk_guard_config:{_owner_suffix()}"


def _today() -> str:
    return datetime.now().strftime("%Y-%m-%d")


def _empty_state() -> dict[str, Any]:
    return {
        "halted": False,
        "halt_reason": "",
        "halted_at": "",
        "consec_losses": 0,
        "day_date": _today(),
        "day_baseline_equity": None,
        "day_notified": False,
    }


def _load_state() -> dict[str, Any]:
    try:
        stored = json.loads(get_setting(_state_key(), "{}"))
    except (TypeError, ValueError, json.JSONDecodeError):
        stored = {}
    if not isinstance(stored, dict):
        stored = {}
    state = _empty_state()
    state.update({k: v for k, v in stored.items() if k in state})
    return state


def _save_state(state: dict[str, Any]) -> None:
    set_setting(_state_key(), json.dumps(state, ensure_ascii=False))


def get_config() -> dict[str, float | int]:
    config = dict(DEFAULT_CONFIG)
    try:
        stored = json.loads(get_setting(_config_key(), "{}"))
    except (TypeError, ValueError, json.JSONDecodeError):
        stored = {}
    if isinstance(stored, dict):
        value = stored.get("daily_max_loss_pct")
        if isinstance(value, (int, float)) and not isinstance(value, bool) and math.isfinite(value) and 0 < float(value) <= 1:
            config["daily_max_loss_pct"] = float(value)
        value = stored.get("consecutive_loss_limit")
        if isinstance(value, int) and not isinstance(value, bool) and 1 <= value <= 20:
            config["consecutive_loss_limit"] = value
    return config


def update_config(updates: dict[str, Any]) -> dict[str, float | int]:
    config = get_config()
    if "daily_max_loss_pct" in updates:
        try:
            value = float(updates["daily_max_loss_pct"])
        except (TypeError, ValueError) as exc:
            raise ValueError("daily_max_loss_pct 必须是数值") from exc
        if not math.isfinite(value) or not 0 < value <= 1:
            raise ValueError("daily_max_loss_pct 必须在 0 与 1 之间")
        config["daily_max_loss_pct"] = value
    if "consecutive_loss_limit" in updates:
        value = updates["consecutive_loss_limit"]
        if not isinstance(value, int) or isinstance(value, bool) or not 1 <= value <= 20:
            raise ValueError("consecutive_loss_limit 必须是 1-20 的整数")
        config["consecutive_loss_limit"] = value
    set_setting(_config_key(), json.dumps(config, ensure_ascii=False))
    audit("paper_risk_guard_config_updated", config)
    return config


def get_status() -> dict[str, Any]:
    """配置 + 当前熔断状态(供前端展示)。"""
    return {"config": get_config(), **_load_state()}


def resume(operator: str = "user") -> dict[str, Any]:
    state = _load_state()
    state["halted"] = False
    state["halt_reason"] = ""
    state["consec_losses"] = 0
    state["day_notified"] = False
    _save_state(state)
    audit("paper_risk_guard_resumed", {"operator": operator})
    return {"ok": True, **state}


def _halt(state: dict[str, Any], reason: str) -> None:
    first = not state["halted"]
    state["halted"] = True
    state["halt_reason"] = reason
    state["halted_at"] = datetime.now().strftime("%Y-%m-%d %H:%M:%S")
    _save_state(state)
    audit("paper_risk_guard_halted", {"reason": reason})
    if first:
        try:
            add_notification("risk_guard", "模拟盘账户风控熔断", reason)
        except Exception:  # noqa: BLE001 — 通知失败不影响风控
            pass


def observe_equity(total_asset: float, day_pnl: float | None = None) -> dict[str, Any]:
    """盯市入口: 刷新当日基线并在亏损超限时自动熔断。由账户快照与调度循环调用。"""
    state = _load_state()
    config = get_config()
    today = _today()
    if state.get("day_date") != today:
        # 新交易日: 重置当日基线与连亏计数(连亏跨日保留更保守，这里选择跨日保留连亏)
        state["day_date"] = today
        state["day_baseline_equity"] = float(total_asset)
        state["day_notified"] = False
        _save_state(state)
        return state
    if state.get("day_baseline_equity") is None:
        state["day_baseline_equity"] = float(total_asset)
        _save_state(state)
        return state
    baseline = float(state["day_baseline_equity"])
    if baseline > 0:
        drawdown = (baseline - float(total_asset)) / baseline
        if drawdown >= float(config["daily_max_loss_pct"]) and not state["halted"]:
            _halt(
                state,
                f"当日权益回撤 {drawdown * 100:.2f}% 达到熔断阈值 "
                f"{float(config['daily_max_loss_pct']) * 100:.2f}%（基线 {baseline:.0f}，当前 {float(total_asset):.0f}）",
            )
    return state


def mark_trade_result(realized_pnl: float) -> dict[str, Any]:
    """每笔平仓成交后调用: 累计连亏并在达到阈值时熔断。"""
    state = _load_state()
    config = get_config()
    if realized_pnl < 0:
        state["consec_losses"] = int(state.get("consec_losses") or 0) + 1
    else:
        state["consec_losses"] = 0
    _save_state(state)
    if int(state["consec_losses"]) >= int(config["consecutive_loss_limit"]) and not state["halted"]:
        _halt(state, f"连续 {state['consec_losses']} 笔平仓亏损，达到连亏熔断阈值 {config['consecutive_loss_limit']}")
    return state


def gate(side: str, increasing_sides: set[str] | None = None) -> dict[str, Any]:
    """预交易闸门: 熔断期间禁止加仓方向委托，减仓/平仓放行。"""
    increasing = increasing_sides or {"buy", "open_long", "open_short"}
    state = _load_state()
    if state["halted"] and side in increasing:
        return {
            "ok": False,
            "error": f"账户已风控熔断，禁止新开仓（{state['halt_reason']}）；可平仓或手动恢复",
            "guard": {k: state[k] for k in ("halted", "halt_reason", "halted_at", "consec_losses")},
        }
    return {"ok": True, "guard": {k: state[k] for k in ("halted", "halt_reason", "consec_losses")}}
