"""请求级身份：模拟盘分户、RBAC。中间件写入，业务层读取。"""
from __future__ import annotations

import contextvars

current_owner = contextvars.ContextVar("quantdesk_owner", default="local")
current_role = contextvars.ContextVar("quantdesk_role", default="admin")


def owner_id() -> str:
    return (current_owner.get() or "local").strip() or "local"


def role() -> str:
    value = (current_role.get() or "admin").strip().lower()
    return value if value in {"admin", "operator", "viewer"} else "admin"
