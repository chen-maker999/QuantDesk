from __future__ import annotations

from typing import Any

from fastapi import APIRouter, HTTPException
from pydantic import BaseModel, Field

try:
    from .database import delete_scheduled_task, get_scheduled_task, list_scheduled_tasks, upsert_scheduled_task
except ImportError:
    try:
        from engine.database import delete_scheduled_task, get_scheduled_task, list_scheduled_tasks, upsert_scheduled_task
    except ImportError:
        from database import delete_scheduled_task, get_scheduled_task, list_scheduled_tasks, upsert_scheduled_task

# 把读写 helper 再导出,供 main.py 的 Agent 工具直接调用,避免二次 import 逻辑。
__all__ = ["router", "delete_scheduled_task", "get_scheduled_task", "list_scheduled_tasks", "upsert_scheduled_task"]


class ScheduledTaskIn(BaseModel):
    """与前端 lib/scheduler.ts 的 ScheduledTask 字段一致(camelCase)。"""

    id: str = Field(min_length=1, max_length=64)
    name: str = Field(min_length=1, max_length=64)
    prompt: str = Field(min_length=1, max_length=4000)
    frequency: str = Field(pattern="^(once|hourly|daily|weekly|interval)$")
    hour: int | None = Field(default=None, ge=0, le=23)
    minute: int | None = Field(default=None, ge=0, le=59)
    weekdays: list[int] | None = None
    intervalMinutes: int | None = Field(default=None, ge=1, le=10080)
    model: str | None = Field(default=None, max_length=64)
    provider: str | None = Field(default=None, max_length=32)
    reasoning: str | None = Field(default=None, max_length=16)
    enabled: bool = True
    tradingDaysOnly: bool = False
    createdAt: int = Field(ge=0)
    lastRunAt: int | None = None
    lastStatus: str | None = Field(default=None, max_length=16)
    lastResult: str | None = Field(default=None, max_length=4000)
    history: list[dict[str, Any]] = Field(default_factory=list)


router = APIRouter(prefix="/scheduler", tags=["scheduler"])


@router.get("/tasks")
def get_tasks() -> dict[str, Any]:
    return {"ok": True, "tasks": list_scheduled_tasks()}


@router.put("/tasks")
def put_task(task: ScheduledTaskIn) -> dict[str, Any]:
    stored = upsert_scheduled_task(task.model_dump())
    return {"ok": True, "task": stored}


@router.delete("/tasks/{task_id}")
def remove_task(task_id: str) -> dict[str, Any]:
    if not delete_scheduled_task(task_id):
        raise HTTPException(404, "定时任务不存在")
    return {"ok": True, "deleted": task_id}
