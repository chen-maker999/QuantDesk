from __future__ import annotations

import json
import os
import sqlite3
import time
from contextlib import contextmanager
from pathlib import Path
from typing import Any, Iterator


DATA_DIR = Path(os.environ.get("QUANTDESK_DATA_DIR", str(Path.home() / ".quantdesk")))
DB_PATH = DATA_DIR / "quantdesk.db"


def initialize() -> None:
    DATA_DIR.mkdir(parents=True, exist_ok=True)
    with connect() as db:
        db.executescript(
            """
            PRAGMA journal_mode=WAL;
            CREATE TABLE IF NOT EXISTS settings (
                key TEXT PRIMARY KEY,
                value TEXT NOT NULL,
                updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
            );
            CREATE TABLE IF NOT EXISTS experiments (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                kind TEXT NOT NULL,
                name TEXT NOT NULL,
                status TEXT NOT NULL,
                config TEXT NOT NULL,
                result TEXT,
                created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
                updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
            );
            CREATE TABLE IF NOT EXISTS model_registry (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                name TEXT NOT NULL,
                version TEXT NOT NULL,
                task TEXT NOT NULL,
                metrics TEXT NOT NULL,
                stage TEXT NOT NULL DEFAULT 'candidate',
                artifact_path TEXT,
                created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
                UNIQUE(name, version)
            );
            CREATE TABLE IF NOT EXISTS audit_log (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                event TEXT NOT NULL,
                payload TEXT NOT NULL,
                created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
            );
            CREATE TABLE IF NOT EXISTS market_prices (
                symbol TEXT NOT NULL,
                trade_date TEXT NOT NULL,
                close REAL NOT NULL,
                source TEXT NOT NULL DEFAULT 'import',
                created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
                PRIMARY KEY(symbol, trade_date)
            );
            CREATE INDEX IF NOT EXISTS idx_market_prices_date ON market_prices(trade_date);
            CREATE TABLE IF NOT EXISTS holdings (
                symbol TEXT PRIMARY KEY,
                name TEXT,
                quantity REAL NOT NULL,
                avg_cost REAL,
                market_value REAL,
                updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
            );
            CREATE TABLE IF NOT EXISTS market_bars (
                market TEXT NOT NULL DEFAULT 'a',
                symbol TEXT NOT NULL,
                period TEXT NOT NULL,
                ts TEXT NOT NULL,
                open REAL, high REAL, low REAL, close REAL,
                volume REAL, amount REAL,
                change_pct REAL, turnover_rate REAL,
                adjust TEXT NOT NULL DEFAULT 'qfq',
                source TEXT NOT NULL DEFAULT 'akshare',
                updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
                PRIMARY KEY(market, symbol, period, ts, adjust)
            );
            CREATE INDEX IF NOT EXISTS idx_market_bars_lookup ON market_bars(market, symbol, period, ts);
            CREATE TABLE IF NOT EXISTS market_quote_cache (
                market TEXT NOT NULL DEFAULT 'a',
                symbol TEXT NOT NULL,
                name TEXT, price REAL, change_pct REAL, change_amt REAL,
                open REAL, high REAL, low REAL, prev_close REAL,
                volume REAL, amount REAL, turnover_rate REAL, pe REAL, pb REAL,
                source TEXT NOT NULL DEFAULT 'akshare',
                updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
                PRIMARY KEY(market, symbol)
            );
            CREATE TABLE IF NOT EXISTS paper_account (
                id INTEGER PRIMARY KEY CHECK (id = 1),
                initial_cash REAL NOT NULL DEFAULT 1000000,
                cash REAL NOT NULL DEFAULT 1000000,
                realized_pnl REAL NOT NULL DEFAULT 0,
                updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
            );
            CREATE TABLE IF NOT EXISTS paper_positions (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                market TEXT NOT NULL,
                symbol TEXT NOT NULL,
                name TEXT,
                quantity REAL NOT NULL DEFAULT 0,
                avg_cost REAL NOT NULL DEFAULT 0,
                last_price REAL,
                updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
                UNIQUE(market, symbol)
            );
            CREATE TABLE IF NOT EXISTS paper_orders (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                market TEXT NOT NULL,
                symbol TEXT NOT NULL,
                name TEXT,
                side TEXT NOT NULL,
                order_type TEXT NOT NULL DEFAULT 'market',
                price REAL,
                quantity REAL NOT NULL,
                status TEXT NOT NULL DEFAULT 'pending',
                filled_qty REAL NOT NULL DEFAULT 0,
                filled_avg REAL,
                created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
                updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
            );
            CREATE TABLE IF NOT EXISTS paper_trades (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                order_id INTEGER NOT NULL,
                market TEXT NOT NULL,
                symbol TEXT NOT NULL,
                name TEXT,
                side TEXT NOT NULL,
                price REAL NOT NULL,
                quantity REAL NOT NULL,
                fee REAL NOT NULL DEFAULT 0,
                created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
            );
            CREATE TABLE IF NOT EXISTS thread_messages (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                thread_id TEXT NOT NULL,
                role TEXT NOT NULL,
                name TEXT,
                content TEXT NOT NULL,
                created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
            );
            CREATE INDEX IF NOT EXISTS idx_thread_messages ON thread_messages(thread_id, id);
            CREATE TABLE IF NOT EXISTS price_alerts (
                id TEXT PRIMARY KEY,
                symbol TEXT NOT NULL,
                market TEXT NOT NULL DEFAULT 'a',
                kind TEXT NOT NULL,
                threshold REAL NOT NULL,
                note TEXT,
                enabled INTEGER NOT NULL DEFAULT 1,
                created_at INTEGER NOT NULL,
                last_triggered_at INTEGER
            );
            CREATE TABLE IF NOT EXISTS notifications (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                source TEXT NOT NULL,
                title TEXT NOT NULL,
                body TEXT,
                read INTEGER NOT NULL DEFAULT 0,
                created_at INTEGER NOT NULL
            );
            CREATE TABLE IF NOT EXISTS chat_threads (
                thread_id TEXT PRIMARY KEY,
                data TEXT NOT NULL,
                updated_at INTEGER NOT NULL
            );
            CREATE TABLE IF NOT EXISTS scheduled_tasks (
                id TEXT PRIMARY KEY,
                name TEXT NOT NULL,
                prompt TEXT NOT NULL,
                frequency TEXT NOT NULL,
                hour INTEGER,
                minute INTEGER,
                weekdays TEXT NOT NULL DEFAULT '[]',
                interval_minutes INTEGER,
                model TEXT,
                provider TEXT,
                reasoning TEXT,
                enabled INTEGER NOT NULL DEFAULT 1,
                created_at INTEGER NOT NULL,
                last_run_at INTEGER,
                last_status TEXT,
                last_result TEXT,
                history TEXT NOT NULL DEFAULT '[]'
            );
            """
        )


@contextmanager
def connect() -> Iterator[sqlite3.Connection]:
    db = sqlite3.connect(DB_PATH)
    db.row_factory = sqlite3.Row
    try:
        yield db
        db.commit()
    finally:
        db.close()


def set_setting(key: str, value: str) -> None:
    with connect() as db:
        db.execute(
            "INSERT INTO settings(key, value) VALUES(?, ?) ON CONFLICT(key) DO UPDATE SET value=excluded.value, updated_at=CURRENT_TIMESTAMP",
            (key, value),
        )


def get_setting(key: str, default: str = "") -> str:
    with connect() as db:
        row = db.execute("SELECT value FROM settings WHERE key=?", (key,)).fetchone()
    if not row or row["value"] is None:
        return default
    return str(row["value"])


def pop_setting(key: str, default: str = "") -> str:
    """读取一条 setting 并立即删除（用于把历史明文密钥迁出 SQLite）。"""
    value = get_setting(key, default)
    if value != default or _has_setting(key):
        with connect() as db:
            db.execute("DELETE FROM settings WHERE key=?", (key,))
    return value


def _has_setting(key: str) -> bool:
    with connect() as db:
        return db.execute("SELECT 1 FROM settings WHERE key=?", (key,)).fetchone() is not None


def add_thread_message(thread_id: str, role: str, content: str, name: str | None = None) -> None:
    with connect() as db:
        db.execute(
            "INSERT INTO thread_messages(thread_id,role,name,content) VALUES(?,?,?,?)",
            (thread_id, role, name, content),
        )


def list_thread_messages(thread_id: str, limit: int = 40) -> list[dict[str, Any]]:
    """按时间升序返回某线程最近 limit 条消息(user/assistant/tool)。"""
    with connect() as db:
        rows = db.execute(
            "SELECT role,name,content FROM ("
            " SELECT id,role,name,content FROM thread_messages WHERE thread_id=? ORDER BY id DESC LIMIT ?"
            ") ORDER BY id ASC",
            (thread_id, limit),
        ).fetchall()
    return [{"role": r["role"], "name": r["name"], "content": r["content"]} for r in rows]


def clear_thread_messages(thread_id: str) -> None:
    with connect() as db:
        db.execute("DELETE FROM thread_messages WHERE thread_id=?", (thread_id,))


# ---------- 价格/风险预警 (price_alerts) ----------

def list_alerts() -> list[dict[str, Any]]:
    with connect() as db:
        rows = db.execute("SELECT * FROM price_alerts ORDER BY created_at DESC").fetchall()
    return [_alert_from_row(r) for r in rows]


def get_alert(alert_id: str) -> dict[str, Any] | None:
    with connect() as db:
        row = db.execute("SELECT * FROM price_alerts WHERE id=?", (alert_id,)).fetchone()
    return _alert_from_row(row) if row else None


def upsert_alert(alert: dict[str, Any]) -> dict[str, Any]:
    with connect() as db:
        db.execute(
            "INSERT INTO price_alerts(id,symbol,market,kind,threshold,note,enabled,created_at,last_triggered_at) "
            "VALUES(?,?,?,?,?,?,?,?,?) "
            "ON CONFLICT(id) DO UPDATE SET symbol=excluded.symbol,market=excluded.market,kind=excluded.kind,"
            "threshold=excluded.threshold,note=excluded.note,enabled=excluded.enabled",
            (
                str(alert.get("id") or ""), str(alert.get("symbol") or ""), str(alert.get("market") or "a"),
                str(alert.get("kind") or ""), float(alert.get("threshold") or 0), alert.get("note"),
                1 if alert.get("enabled", True) else 0, int(alert.get("createdAt") or 0), alert.get("lastTriggeredAt"),
            ),
        )
    stored = get_alert(str(alert.get("id") or ""))
    return stored if stored is not None else alert


def delete_alert(alert_id: str) -> bool:
    with connect() as db:
        cursor = db.execute("DELETE FROM price_alerts WHERE id=?", (alert_id,))
    return cursor.rowcount > 0


def mark_alert_triggered(alert_id: str, stamp: int) -> None:
    with connect() as db:
        db.execute("UPDATE price_alerts SET last_triggered_at=? WHERE id=?", (stamp, alert_id))


def _alert_from_row(row: sqlite3.Row) -> dict[str, Any]:
    return {
        "id": row["id"], "symbol": row["symbol"], "market": row["market"],
        "kind": row["kind"], "threshold": row["threshold"], "note": row["note"],
        "enabled": bool(row["enabled"]), "createdAt": row["created_at"],
        "lastTriggeredAt": row["last_triggered_at"],
    }


# ---------- 通知中心 (notifications) ----------

def add_notification(source: str, title: str, body: str = "") -> int:
    with connect() as db:
        cursor = db.execute(
            "INSERT INTO notifications(source,title,body,created_at) VALUES(?,?,?,?)",
            (source, title, body, int(time.time() * 1000)),
        )
        return int(cursor.lastrowid)


def list_notifications(limit: int = 30, unread_only: bool = False) -> list[dict[str, Any]]:
    where = "WHERE read=0" if unread_only else ""
    with connect() as db:
        rows = db.execute(f"SELECT * FROM notifications {where} ORDER BY id DESC LIMIT ?", (limit,)).fetchall()
    return [{"id": r["id"], "source": r["source"], "title": r["title"], "body": r["body"], "read": bool(r["read"]), "createdAt": r["created_at"]} for r in rows]


def unread_notification_count() -> int:
    with connect() as db:
        row = db.execute("SELECT COUNT(*) c FROM notifications WHERE read=0").fetchone()
    return int(row["c"])


def mark_notifications_read(ids: list[int] | None = None) -> None:
    with connect() as db:
        if ids:
            db.executemany("UPDATE notifications SET read=1 WHERE id=?", [(i,) for i in ids])
        else:
            db.execute("UPDATE notifications SET read=1 WHERE read=0")


# ---------- 对话线程持久化 (chat_threads, 前端 localStorage 的服务端镜像) ----------

def upsert_chat_thread(thread_id: str, data_json: str, updated_at: int) -> None:
    with connect() as db:
        db.execute(
            "INSERT INTO chat_threads(thread_id,data,updated_at) VALUES(?,?,?) "
            "ON CONFLICT(thread_id) DO UPDATE SET data=excluded.data,updated_at=excluded.updated_at",
            (thread_id, data_json, updated_at),
        )


def list_chat_threads() -> list[dict[str, Any]]:
    """返回 [{threadId,data,updatedAt}], 按 updatedAt 降序。"""
    with connect() as db:
        rows = db.execute("SELECT thread_id,data,updated_at FROM chat_threads ORDER BY updated_at DESC LIMIT 500").fetchall()
    return [{"threadId": r["thread_id"], "data": r["data"], "updatedAt": r["updated_at"]} for r in rows]


def delete_chat_thread(thread_id: str) -> bool:
    with connect() as db:
        cursor = db.execute("DELETE FROM chat_threads WHERE thread_id=?", (thread_id,))
    return cursor.rowcount > 0


def audit(event: str, payload: dict[str, Any]) -> None:
    with connect() as db:
        db.execute("INSERT INTO audit_log(event, payload) VALUES (?, ?)", (event, json.dumps(payload, ensure_ascii=False)))


def save_experiment(kind: str, name: str, config: dict[str, Any], result: dict[str, Any]) -> int:
    with connect() as db:
        cursor = db.execute(
            "INSERT INTO experiments(kind,name,status,config,result) VALUES(?,?,?,?,?)",
            (kind, name, "completed", json.dumps(config), json.dumps(result)),
        )
        return int(cursor.lastrowid)


# ---------- 定时任务 (scheduled_tasks) ----------
# 前端调度器与 Agent 共用同一份持久化。字段名沿用前端 ScheduledTask 类型(camelCase),
# 仅 SQLite 列名为 snake_case,通过 _task_to_row/_task_from_row 互转。


def _task_to_row(task: dict[str, Any]) -> tuple[Any, ...]:
    last_run = task.get("lastRunAt")
    return (
        str(task.get("id") or ""),
        str(task.get("name") or ""),
        str(task.get("prompt") or ""),
        str(task.get("frequency") or "daily"),
        task.get("hour"),
        task.get("minute"),
        json.dumps(task.get("weekdays") or [], ensure_ascii=False),
        task.get("intervalMinutes"),
        task.get("model") or None,
        task.get("provider") or None,
        task.get("reasoning") or None,
        1 if task.get("enabled", True) else 0,
        int(task.get("createdAt") or 0),
        int(last_run) if last_run is not None else None,
        task.get("lastStatus") or None,
        task.get("lastResult") or None,
        json.dumps(task.get("history") or [], ensure_ascii=False),
    )


def _task_from_row(row: sqlite3.Row) -> dict[str, Any]:
    weekdays = json.loads(row["weekdays"] or "[]")
    return {
        "id": row["id"],
        "name": row["name"],
        "prompt": row["prompt"],
        "frequency": row["frequency"],
        "hour": row["hour"],
        "minute": row["minute"],
        "weekdays": weekdays if weekdays else None,
        "intervalMinutes": row["interval_minutes"],
        "model": row["model"] or None,
        "provider": row["provider"] or None,
        "reasoning": row["reasoning"] or None,
        "enabled": bool(row["enabled"]),
        "createdAt": row["created_at"],
        "lastRunAt": row["last_run_at"],
        "lastStatus": row["last_status"] or None,
        "lastResult": row["last_result"] or None,
        "history": json.loads(row["history"] or "[]"),
    }


def list_scheduled_tasks() -> list[dict[str, Any]]:
    with connect() as db:
        rows = db.execute("SELECT * FROM scheduled_tasks ORDER BY created_at").fetchall()
    return [_task_from_row(r) for r in rows]


def get_scheduled_task(task_id: str) -> dict[str, Any] | None:
    with connect() as db:
        row = db.execute("SELECT * FROM scheduled_tasks WHERE id=?", (task_id,)).fetchone()
    return _task_from_row(row) if row else None


def upsert_scheduled_task(task: dict[str, Any]) -> dict[str, Any]:
    row = _task_to_row(task)
    with connect() as db:
        db.execute(
            "INSERT INTO scheduled_tasks(id,name,prompt,frequency,hour,minute,weekdays,interval_minutes,model,provider,reasoning,enabled,created_at,last_run_at,last_status,last_result,history) "
            "VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?) "
            "ON CONFLICT(id) DO UPDATE SET name=excluded.name,prompt=excluded.prompt,frequency=excluded.frequency,"
            "hour=excluded.hour,minute=excluded.minute,weekdays=excluded.weekdays,interval_minutes=excluded.interval_minutes,"
            "model=excluded.model,provider=excluded.provider,reasoning=excluded.reasoning,enabled=excluded.enabled,"
            "created_at=excluded.created_at,last_run_at=excluded.last_run_at,last_status=excluded.last_status,"
            "last_result=excluded.last_result,history=excluded.history",
            row,
        )
    stored = get_scheduled_task(task["id"])
    return stored if stored is not None else {**task, "id": str(task.get("id") or "")}


def delete_scheduled_task(task_id: str) -> bool:
    with connect() as db:
        cursor = db.execute("DELETE FROM scheduled_tasks WHERE id=?", (task_id,))
    return cursor.rowcount > 0


_QUOTE_COLS = ("market", "symbol", "name", "price", "change_pct", "change_amt", "open", "high", "low", "prev_close", "volume", "amount", "turnover_rate", "pe", "pb", "source")


def upsert_quote_cache(rows: list[dict[str, Any]]) -> None:
    """rows: [{market,symbol,name,price,change_pct,change_amt,open,high,low,prev_close,volume,amount,turnover_rate,pe,pb,source}]"""
    if not rows:
        return
    values: list[tuple[Any, ...]] = []
    for r in rows:
        row = {**r, "source": r.get("source") or "eastmoney"}
        values.append(tuple(row.get(c) for c in _QUOTE_COLS))
    with connect() as db:
        db.executemany(
            "INSERT INTO market_quote_cache(market,symbol,name,price,change_pct,change_amt,open,high,low,prev_close,volume,amount,turnover_rate,pe,pb,source) "
            "VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?) "
            "ON CONFLICT(market,symbol) DO UPDATE SET name=excluded.name,price=excluded.price,change_pct=excluded.change_pct,"
            "change_amt=excluded.change_amt,open=excluded.open,high=excluded.high,low=excluded.low,prev_close=excluded.prev_close,"
            "volume=excluded.volume,amount=excluded.amount,turnover_rate=excluded.turnover_rate,pe=excluded.pe,pb=excluded.pb,"
            "source=excluded.source,updated_at=CURRENT_TIMESTAMP",
            values,
        )


def read_quote_cache(markets: list[str] | None = None, symbols: list[str] | None = None, limit: int = 50) -> list[dict[str, Any]]:
    clauses: list[str] = []
    params: list[Any] = []
    if markets:
        clauses.append(f"market IN ({','.join('?' * len(markets))})")
        params.extend(markets)
    if symbols:
        clauses.append(f"symbol IN ({','.join('?' * len(symbols))})")
        params.extend(symbols)
    where = ("WHERE " + " AND ".join(clauses)) if clauses else ""
    params.append(limit)
    with connect() as db:
        rows = db.execute(f"SELECT {','.join(_QUOTE_COLS)} FROM market_quote_cache {where} ORDER BY amount DESC LIMIT ?", params).fetchall()
    return [dict(row) for row in rows]


def upsert_bars(rows: list[dict[str, Any]]) -> None:
    """rows: [{market,symbol,period,ts,open,high,low,close,volume,amount,change_pct,turnover_rate,adjust,source}]"""
    if not rows:
        return
    values: list[tuple[Any, ...]] = []
    for r in rows:
        values.append((r.get("market", "a"), r.get("symbol", ""), r.get("period", ""), r.get("ts", ""),
                       r.get("open"), r.get("high"), r.get("low"), r.get("close"),
                       r.get("volume"), r.get("amount"), r.get("change_pct"), r.get("turnover_rate"),
                       r.get("adjust", "qfq"), r.get("source", "marketdata")))
    with connect() as db:
        db.executemany(
            "INSERT OR REPLACE INTO market_bars(market,symbol,period,ts,open,high,low,close,volume,amount,change_pct,turnover_rate,adjust,source) "
            "VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?)",
            values,
        )


def read_bars(market: str, symbol: str, period: str, adjust: str = "qfq", limit: int = 320) -> list[dict[str, Any]]:
    with connect() as db:
        rows = db.execute(
            "SELECT ts,open,high,low,close,volume,amount,change_pct,turnover_rate FROM market_bars "
            "WHERE market=? AND symbol=? AND period=? AND adjust=? ORDER BY ts DESC LIMIT ?",
            (market, symbol, period, adjust, limit),
        ).fetchall()
    out = [dict(row) for row in rows]
    out.reverse()
    return out
