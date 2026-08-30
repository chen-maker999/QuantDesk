from __future__ import annotations

import json
import hashlib
import math
import os
import sqlite3
import time
from contextlib import contextmanager
from pathlib import Path
from typing import Any, Iterator


DATA_DIR = Path(os.environ.get("QUANTDESK_DATA_DIR", str(Path.home() / ".quantdesk")))
DB_PATH = DATA_DIR / "quantdesk.db"


def _owner() -> str:
    """Return the request owner without creating an import cycle at module load."""
    try:
        from .scope import owner_id
    except ImportError:
        try:
            from engine.scope import owner_id
        except ImportError:
            return "local"
    return owner_id()


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
                owner_id TEXT NOT NULL DEFAULT 'local',
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
            CREATE TABLE IF NOT EXISTS analysis_bars (
                symbol TEXT NOT NULL,
                trade_date TEXT NOT NULL,
                market TEXT NOT NULL DEFAULT 'unknown',
                adjust TEXT NOT NULL DEFAULT '',
                source TEXT NOT NULL,
                open REAL, high REAL, low REAL, close REAL NOT NULL,
                volume REAL, amount REAL,
                ingested_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
                PRIMARY KEY(symbol, trade_date)
            );
            CREATE INDEX IF NOT EXISTS idx_analysis_bars_symbol_date ON analysis_bars(symbol, trade_date);
            CREATE TABLE IF NOT EXISTS holdings (
                owner_id TEXT NOT NULL DEFAULT 'local',
                symbol TEXT NOT NULL,
                name TEXT,
                quantity REAL NOT NULL,
                avg_cost REAL,
                market_value REAL,
                updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
                PRIMARY KEY(owner_id, symbol)
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
            CREATE TABLE IF NOT EXISTS conditional_orders (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                market TEXT NOT NULL,
                symbol TEXT NOT NULL,
                name TEXT,
                kind TEXT NOT NULL,             -- stop_loss | take_profit | trailing_stop
                trigger_price REAL,             -- 固定触发价(止损/止盈)
                trailing_pct REAL,              -- 移动止损回撤百分比(0-1)
                quantity REAL NOT NULL,         -- 平仓数量
                status TEXT NOT NULL DEFAULT 'pending',  -- pending | triggered | cancelled
                peak_price REAL,                -- 移动止损: 持仓期最高价
                triggered_order_id INTEGER,
                created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
                triggered_at TEXT,
                updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
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
                owner_id TEXT NOT NULL DEFAULT 'local',
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
                owner_id TEXT NOT NULL DEFAULT 'local',
                source TEXT NOT NULL,
                title TEXT NOT NULL,
                body TEXT,
                read INTEGER NOT NULL DEFAULT 0,
                created_at INTEGER NOT NULL
            );
            CREATE TABLE IF NOT EXISTS push_subscriptions (
                endpoint TEXT PRIMARY KEY,
                owner_id TEXT NOT NULL DEFAULT 'local',
                p256dh TEXT NOT NULL,
                auth TEXT NOT NULL,
                user_agent TEXT,
                created_at INTEGER NOT NULL
            );
            CREATE TABLE IF NOT EXISTS chat_threads (
                thread_id TEXT PRIMARY KEY,
                owner_id TEXT NOT NULL DEFAULT 'local',
                data TEXT NOT NULL,
                updated_at INTEGER NOT NULL
            );
            CREATE TABLE IF NOT EXISTS agent_approvals (
                id TEXT PRIMARY KEY,
                owner_id TEXT NOT NULL DEFAULT 'local',
                tool TEXT NOT NULL,
                arguments TEXT NOT NULL,
                thread_id TEXT,
                status TEXT NOT NULL DEFAULT 'pending',
                reason TEXT,
                result TEXT,
                created_at INTEGER NOT NULL,
                decided_at INTEGER
            );
            CREATE TABLE IF NOT EXISTS agent_usage (
                day TEXT PRIMARY KEY,
                tool_calls INTEGER NOT NULL DEFAULT 0,
                runs INTEGER NOT NULL DEFAULT 0,
                tokens INTEGER NOT NULL DEFAULT 0
            );
            CREATE TABLE IF NOT EXISTS chat_sessions (
                thread_id TEXT PRIMARY KEY,
                owner_id TEXT NOT NULL DEFAULT 'local',
                first_at INTEGER NOT NULL,
                last_at INTEGER NOT NULL
            );
            CREATE TABLE IF NOT EXISTS scheduled_tasks (
                id TEXT PRIMARY KEY,
                owner_id TEXT NOT NULL DEFAULT 'local',
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
                trading_days_only INTEGER NOT NULL DEFAULT 0,
                created_at INTEGER NOT NULL,
                last_run_at INTEGER,
                last_status TEXT,
                last_result TEXT,
                history TEXT NOT NULL DEFAULT '[]'
            );
            CREATE TABLE IF NOT EXISTS users (
                id TEXT PRIMARY KEY,
                username TEXT NOT NULL UNIQUE,
                password_hash TEXT NOT NULL,
                created_at INTEGER NOT NULL,
                last_login_at INTEGER
            );
            CREATE TABLE IF NOT EXISTS sessions (
                token TEXT PRIMARY KEY,
                user_id TEXT NOT NULL,
                created_at INTEGER NOT NULL,
                expires_at INTEGER NOT NULL,
                user_agent TEXT
            );
            CREATE INDEX IF NOT EXISTS idx_sessions_user ON sessions(user_id);
            CREATE TABLE IF NOT EXISTS holdings_snapshots (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                owner_id TEXT NOT NULL DEFAULT 'local',
                created_at INTEGER NOT NULL,
                reason TEXT NOT NULL,
                payload TEXT NOT NULL
            );
            CREATE TABLE IF NOT EXISTS tool_artifacts (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                owner_id TEXT NOT NULL DEFAULT 'local',
                thread_id TEXT,
                tool TEXT NOT NULL,
                summary TEXT NOT NULL,
                payload TEXT NOT NULL,
                created_at INTEGER NOT NULL
            );
            CREATE INDEX IF NOT EXISTS idx_tool_artifacts_thread ON tool_artifacts(thread_id, id);
            CREATE TABLE IF NOT EXISTS oms_drafts (
                id TEXT PRIMARY KEY,
                owner_id TEXT NOT NULL DEFAULT 'local',
                created_at INTEGER NOT NULL,
                status TEXT NOT NULL DEFAULT 'open',
                payload TEXT NOT NULL
            );
            CREATE TABLE IF NOT EXISTS schema_version (
                version INTEGER PRIMARY KEY,
                applied_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
            );
            """
        )
        _migrate_identity_and_paper(db)
        _run_migrations(db)


# ---------- 版本化迁移 ----------
# 新增表/列一律走编号迁移：旧库按 version 递增补齐，新库直接建好。
# 迁移必须幂等（CREATE TABLE IF NOT EXISTS / ADD COLUMN IF MISSING）。

SCHEMA_VERSION = 3


def _schema_version(db: sqlite3.Connection) -> int:
    row = db.execute("SELECT MAX(version) AS v FROM schema_version").fetchone()
    return int(row["v"] or 0) if row else 0


def _run_migrations(db: sqlite3.Connection) -> None:
    version = _schema_version(db)
    if version < 1:
        # 迁移 1：实盘风控状态持久化（熔断/日锚/频率/解锁）+ 本地订单台账（回报闭环）
        db.executescript(
            """
            CREATE TABLE IF NOT EXISTS broker_risk (
                broker TEXT PRIMARY KEY,
                day TEXT NOT NULL DEFAULT '',
                day_start_equity REAL,
                tripped_reason TEXT,
                live_armed_until INTEGER NOT NULL DEFAULT 0,
                order_times TEXT NOT NULL DEFAULT '[]'
            );
            CREATE TABLE IF NOT EXISTS broker_orders (
                id TEXT PRIMARY KEY,
                broker TEXT NOT NULL,
                remote_id TEXT,
                symbol TEXT NOT NULL,
                side TEXT NOT NULL,
                order_type TEXT NOT NULL DEFAULT 'market',
                quantity REAL NOT NULL,
                limit_price REAL,
                stop_price REAL,
                time_in_force TEXT NOT NULL DEFAULT 'day',
                status TEXT NOT NULL DEFAULT 'submitted',
                filled_qty REAL NOT NULL DEFAULT 0,
                filled_avg_price REAL,
                trading_mode TEXT NOT NULL DEFAULT 'paper',
                submitted_at INTEGER NOT NULL,
                updated_at INTEGER NOT NULL,
                last_error TEXT
            );
            CREATE INDEX IF NOT EXISTS idx_broker_orders_status ON broker_orders(broker, status);
            """
        )
        db.execute("INSERT OR IGNORE INTO schema_version(version) VALUES(1)")
    if version < 2:
        # 迁移 2：定时任务增加 trading_days_only（默认 0=每天运行）。
        # 旧库没有该列时引擎一律按「仅交易日」兜底，导致周末任务从不触发；
        # 显式持久化后由用户在前端勾选控制。
        _add_column_if_missing(db, "scheduled_tasks", "trading_days_only", "trading_days_only INTEGER NOT NULL DEFAULT 0")
        db.execute("INSERT OR IGNORE INTO schema_version(version) VALUES(2)")
    if version < 3:
        # 迁移 3：Agent 用量记录 tokens（Codex 风格看板）+ 会话时长（最长聊天时长）。
        _add_column_if_missing(db, "agent_usage", "tokens", "tokens INTEGER NOT NULL DEFAULT 0")
        db.execute(
            """CREATE TABLE IF NOT EXISTS chat_sessions (
                thread_id TEXT PRIMARY KEY,
                owner_id TEXT NOT NULL DEFAULT 'local',
                first_at INTEGER NOT NULL,
                last_at INTEGER NOT NULL
            )"""
        )
        db.execute("INSERT OR IGNORE INTO schema_version(version) VALUES(3)")


def _table_columns(db: sqlite3.Connection, table: str) -> set[str]:
    return {str(row[1]) for row in db.execute(f"PRAGMA table_info({table})").fetchall()}


def _add_column_if_missing(db: sqlite3.Connection, table: str, column: str, ddl: str) -> None:
    if column not in _table_columns(db, table):
        db.execute(f"ALTER TABLE {table} ADD COLUMN {ddl}")


def _migrate_identity_and_paper(db: sqlite3.Connection) -> None:
    """用户角色/TOTP、模拟盘分户。幂等。"""
    _add_column_if_missing(db, "users", "role", "role TEXT NOT NULL DEFAULT 'admin'")
    _add_column_if_missing(db, "users", "totp_secret", "totp_secret TEXT")
    _add_column_if_missing(db, "users", "totp_enabled", "totp_enabled INTEGER NOT NULL DEFAULT 0")
    for table in ("paper_positions", "paper_orders", "paper_trades", "conditional_orders"):
        if table in {r[0] for r in db.execute("SELECT name FROM sqlite_master WHERE type='table'").fetchall()}:
            _add_column_if_missing(db, table, "owner_id", "owner_id TEXT NOT NULL DEFAULT 'local'")
    for table in ("experiments", "price_alerts", "notifications", "push_subscriptions", "chat_threads", "agent_approvals", "scheduled_tasks", "holdings_snapshots", "tool_artifacts", "oms_drafts"):
        if table in {r[0] for r in db.execute("SELECT name FROM sqlite_master WHERE type='table'").fetchall()}:
            _add_column_if_missing(db, table, "owner_id", "owner_id TEXT NOT NULL DEFAULT 'local'")
    # holdings originally used symbol as the primary key, which made tenant
    # isolation impossible. Rebuild it once with a composite owner key.
    holding_columns = _table_columns(db, "holdings")
    holding_pk = [row[1] for row in db.execute("PRAGMA table_info(holdings)").fetchall() if row[5]]
    if "owner_id" not in holding_columns or holding_pk == ["symbol"]:
        db.execute("ALTER TABLE holdings RENAME TO holdings_legacy")
        db.execute("""CREATE TABLE holdings (
            owner_id TEXT NOT NULL DEFAULT 'local', symbol TEXT NOT NULL, name TEXT,
            quantity REAL NOT NULL, avg_cost REAL, market_value REAL,
            updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
            PRIMARY KEY(owner_id, symbol)
        )""")
        legacy_cols = _table_columns(db, "holdings_legacy")
        owner_expr = "owner_id" if "owner_id" in legacy_cols else "'local'"
        db.execute(f"INSERT OR IGNORE INTO holdings(owner_id,symbol,name,quantity,avg_cost,market_value,updated_at) SELECT {owner_expr},symbol,name,quantity,avg_cost,market_value,updated_at FROM holdings_legacy")
        db.execute("DROP TABLE holdings_legacy")
    cols = _table_columns(db, "paper_account")
    if "owner_id" not in cols and "id" in cols:
        db.execute(
            """
            CREATE TABLE IF NOT EXISTS paper_account_owners (
                owner_id TEXT PRIMARY KEY,
                initial_cash REAL NOT NULL DEFAULT 1000000,
                cash REAL NOT NULL DEFAULT 1000000,
                realized_pnl REAL NOT NULL DEFAULT 0,
                updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
            )
            """
        )
        db.execute(
            "INSERT OR IGNORE INTO paper_account_owners(owner_id, initial_cash, cash, realized_pnl, updated_at) "
            "SELECT 'local', initial_cash, cash, realized_pnl, updated_at FROM paper_account"
        )
        db.execute("DROP TABLE paper_account")
        db.execute("ALTER TABLE paper_account_owners RENAME TO paper_account")
    elif "owner_id" not in _table_columns(db, "paper_account"):
        db.execute(
            """
            CREATE TABLE IF NOT EXISTS paper_account (
                owner_id TEXT PRIMARY KEY,
                initial_cash REAL NOT NULL DEFAULT 1000000,
                cash REAL NOT NULL DEFAULT 1000000,
                realized_pnl REAL NOT NULL DEFAULT 0,
                updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
            )
            """
        )


@contextmanager
def connect() -> Iterator[sqlite3.Connection]:
    # busy_timeout 让并发写竞争时自动重试而非立即抛 "database is locked"；
    # WAL 已在 initialize() 中持久开启，这里只补每连接的等待窗口。
    db = sqlite3.connect(DB_PATH, timeout=10.0)
    db.row_factory = sqlite3.Row
    db.execute("PRAGMA busy_timeout=8000")
    try:
        yield db
        db.commit()
    finally:
        db.close()


# ---------- 数据库自动备份 ----------

BACKUP_DIR = DATA_DIR / "backups"
BACKUP_KEEP = 14
_last_backup_day = ""


def run_backup() -> dict[str, Any]:
    """用 sqlite3 backup API 在线备份主库到 backups/quantdesk-YYYYMMDD.db（WAL 安全），保留最近 14 份。"""
    BACKUP_DIR.mkdir(parents=True, exist_ok=True)
    target = BACKUP_DIR / f"quantdesk-{time.strftime('%Y%m%d')}.db"
    src = sqlite3.connect(DB_PATH)
    try:
        dst = sqlite3.connect(target)
        try:
            src.backup(dst)
            dst.commit()
        finally:
            dst.close()
    finally:
        src.close()
    _prune_backups()
    return {"file": target.name, "path": str(target), "size": target.stat().st_size, "sha256": _sha256(target), "created_at": time.strftime("%Y-%m-%d %H:%M:%S")}


def _sha256(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as stream:
        for chunk in iter(lambda: stream.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def verify_backup(file_name: str) -> dict[str, Any]:
    """Verify a named backup without changing the live database."""
    safe_name = Path(file_name).name
    target = BACKUP_DIR / safe_name
    if safe_name != file_name or not safe_name.startswith("quantdesk-") or target.suffix != ".db" or not target.is_file():
        return {"ok": False, "error": "备份文件名无效或不存在"}
    digest = _sha256(target)
    try:
        db = sqlite3.connect(f"file:{target.as_posix()}?mode=ro", uri=True)
        try:
            result = db.execute("PRAGMA integrity_check").fetchone()
            tables = {row[0] for row in db.execute("SELECT name FROM sqlite_master WHERE type='table'")}
        finally:
            db.close()
    except sqlite3.DatabaseError as exc:
        return {"ok": False, "file": safe_name, "sha256": digest, "error": f"SQLite 校验失败: {type(exc).__name__}"}
    integrity = str(result[0] if result else "")
    required = {"settings", "market_prices", "experiments", "audit_log"}
    missing = sorted(required - tables)
    return {"ok": integrity.lower() == "ok" and not missing, "file": safe_name, "size": target.stat().st_size, "sha256": digest, "integrity": integrity, "missing_tables": missing}


def _prune_backups() -> None:
    files = sorted(BACKUP_DIR.glob("quantdesk-*.db"))
    for stale in files[:-BACKUP_KEEP]:
        stale.unlink(missing_ok=True)


def list_backups() -> list[dict[str, Any]]:
    if not BACKUP_DIR.exists():
        return []
    files = sorted(BACKUP_DIR.glob("quantdesk-*.db"))
    return [
        {"file": p.name, "size": p.stat().st_size, "modified": time.strftime("%Y-%m-%d %H:%M:%S", time.localtime(p.stat().st_mtime))}
        for p in files
    ]


def maybe_daily_backup() -> dict[str, Any] | None:
    """启动时 + 每日一次的自动备份；当天已备份过则跳过。失败由调用方记录日志。"""
    global _last_backup_day
    today = time.strftime("%Y%m%d")
    if today == _last_backup_day or not DB_PATH.exists():
        return None
    result = run_backup()
    _last_backup_day = today
    return result


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
            "INSERT INTO thread_messages(thread_id,role,name,content) SELECT ?,?,?,? WHERE EXISTS (SELECT 1 FROM chat_threads WHERE thread_id=? AND owner_id=?)",
            (thread_id, role, name, content, thread_id, _owner()),
        )


def list_thread_messages(thread_id: str, limit: int = 40) -> list[dict[str, Any]]:
    """按时间升序返回某线程最近 limit 条消息(user/assistant/tool/summary)。"""
    with connect() as db:
        rows = db.execute(
            "SELECT id,role,name,content FROM ("
            " SELECT m.id,m.role,m.name,m.content FROM thread_messages m JOIN chat_threads t ON t.thread_id=m.thread_id AND t.owner_id=? WHERE m.thread_id=? ORDER BY m.id DESC LIMIT ?"
            ") ORDER BY id ASC",
            (_owner(), thread_id, limit),
        ).fetchall()
    return [{"id": r["id"], "role": r["role"], "name": r["name"], "content": r["content"]} for r in rows]


def compact_thread_messages(thread_id: str, cut_id: int, summary: str) -> None:
    """上下文压缩落库：删除 id<=cut_id 的旧消息，插入一条 role='summary' 摘要。
    后续 list_thread_messages 会把摘要当作最早一条上下文返回。"""
    with connect() as db:
        db.execute("DELETE FROM thread_messages WHERE thread_id=? AND id<=? AND EXISTS (SELECT 1 FROM chat_threads WHERE thread_id=? AND owner_id=?)", (thread_id, cut_id, thread_id, _owner()))
        db.execute(
            "INSERT INTO thread_messages(thread_id,role,name,content) SELECT ?,'summary',NULL,? WHERE EXISTS (SELECT 1 FROM chat_threads WHERE thread_id=? AND owner_id=?)",
            (thread_id, summary, thread_id, _owner()),
        )


def clear_thread_messages(thread_id: str) -> None:
    with connect() as db:
        db.execute("DELETE FROM thread_messages WHERE thread_id=? AND EXISTS (SELECT 1 FROM chat_threads WHERE thread_id=? AND owner_id=?)", (thread_id, thread_id, _owner()))


# ---------- 价格/风险预警 (price_alerts) ----------

def list_alerts() -> list[dict[str, Any]]:
    with connect() as db:
        rows = db.execute("SELECT * FROM price_alerts WHERE owner_id=? ORDER BY created_at DESC", (_owner(),)).fetchall()
    return [_alert_from_row(r) for r in rows]


def get_alert(alert_id: str) -> dict[str, Any] | None:
    with connect() as db:
        row = db.execute("SELECT * FROM price_alerts WHERE id=? AND owner_id=?", (alert_id, _owner())).fetchone()
    return _alert_from_row(row) if row else None


def upsert_alert(alert: dict[str, Any]) -> dict[str, Any]:
    with connect() as db:
        db.execute(
            "INSERT INTO price_alerts(id,owner_id,symbol,market,kind,threshold,note,enabled,created_at,last_triggered_at) "
            "VALUES(?,?,?,?,?,?,?,?,?,?) "
            "ON CONFLICT(id) DO UPDATE SET symbol=excluded.symbol,market=excluded.market,kind=excluded.kind,"
            "threshold=excluded.threshold,note=excluded.note,enabled=excluded.enabled "
            "WHERE price_alerts.owner_id=excluded.owner_id",
            (
                str(alert.get("id") or ""), _owner(), str(alert.get("symbol") or ""), str(alert.get("market") or "a"),
                str(alert.get("kind") or ""), float(alert.get("threshold") or 0), alert.get("note"),
                1 if alert.get("enabled", True) else 0, int(alert.get("createdAt") or 0), alert.get("lastTriggeredAt"),
            ),
        )
    stored = get_alert(str(alert.get("id") or ""))
    return stored if stored is not None else alert


def delete_alert(alert_id: str) -> bool:
    with connect() as db:
        cursor = db.execute("DELETE FROM price_alerts WHERE id=? AND owner_id=?", (alert_id, _owner()))
    return cursor.rowcount > 0


def mark_alert_triggered(alert_id: str, stamp: int) -> None:
    with connect() as db:
        db.execute("UPDATE price_alerts SET last_triggered_at=? WHERE id=? AND owner_id=?", (stamp, alert_id, _owner()))


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
            "INSERT INTO notifications(owner_id,source,title,body,created_at) VALUES(?,?,?,?,?)",
            (_owner(), source, title, body, int(time.time() * 1000)),
        )
        return int(cursor.lastrowid)


def list_notifications(limit: int = 30, unread_only: bool = False) -> list[dict[str, Any]]:
    where = "AND read=0" if unread_only else ""
    with connect() as db:
        rows = db.execute(f"SELECT * FROM notifications WHERE owner_id=? {where} ORDER BY id DESC LIMIT ?", (_owner(), limit)).fetchall()
    return [{"id": r["id"], "source": r["source"], "title": r["title"], "body": r["body"], "read": bool(r["read"]), "createdAt": r["created_at"]} for r in rows]


def unread_notification_count() -> int:
    with connect() as db:
        row = db.execute("SELECT COUNT(*) c FROM notifications WHERE owner_id=? AND read=0", (_owner(),)).fetchone()
    return int(row["c"])


def mark_notifications_read(ids: list[int] | None = None) -> None:
    with connect() as db:
        if ids:
            db.executemany("UPDATE notifications SET read=1 WHERE id=? AND owner_id=?", [(i, _owner()) for i in ids])
        else:
            db.execute("UPDATE notifications SET read=1 WHERE owner_id=? AND read=0", (_owner(),))


# ---------- Web Push 订阅 (push_subscriptions) ----------

def upsert_push_subscription(endpoint: str, p256dh: str, auth: str, user_agent: str = "") -> None:
    with connect() as db:
        db.execute(
            "INSERT INTO push_subscriptions(endpoint,owner_id,p256dh,auth,user_agent,created_at) VALUES(?,?,?,?,?,?) "
            "ON CONFLICT(endpoint) DO UPDATE SET p256dh=excluded.p256dh,auth=excluded.auth,user_agent=excluded.user_agent "
            "WHERE push_subscriptions.owner_id=excluded.owner_id",
            (endpoint, _owner(), p256dh, auth, user_agent, int(time.time() * 1000)),
        )


def delete_push_subscription(endpoint: str) -> None:
    with connect() as db:
        db.execute("DELETE FROM push_subscriptions WHERE endpoint=? AND owner_id=?", (endpoint, _owner()))


def list_push_subscriptions() -> list[dict[str, Any]]:
    with connect() as db:
        rows = db.execute("SELECT endpoint,p256dh,auth,user_agent,created_at FROM push_subscriptions WHERE owner_id=?", (_owner(),)).fetchall()
    return [{"endpoint": r["endpoint"], "p256dh": r["p256dh"], "auth": r["auth"], "userAgent": r["user_agent"] or "", "createdAt": r["created_at"]} for r in rows]


# ---------- 对话线程持久化 (chat_threads, 前端 localStorage 的服务端镜像) ----------

def upsert_chat_thread(thread_id: str, data_json: str, updated_at: int) -> None:
    with connect() as db:
        db.execute(
            "INSERT INTO chat_threads(thread_id,owner_id,data,updated_at) VALUES(?,?,?,?) "
            "ON CONFLICT(thread_id) DO UPDATE SET data=excluded.data,updated_at=excluded.updated_at "
            "WHERE chat_threads.owner_id=excluded.owner_id",
            (thread_id, _owner(), data_json, updated_at),
        )


def get_chat_thread(thread_id: str) -> dict[str, Any] | None:
    with connect() as db:
        row = db.execute("SELECT thread_id,data,updated_at FROM chat_threads WHERE thread_id=? AND owner_id=?", (thread_id, _owner())).fetchone()
    return {"threadId": row["thread_id"], "data": row["data"], "updatedAt": row["updated_at"]} if row else None


def list_chat_threads() -> list[dict[str, Any]]:
    """返回 [{threadId,data,updatedAt}], 按 updatedAt 降序。"""
    with connect() as db:
        rows = db.execute("SELECT thread_id,data,updated_at FROM chat_threads WHERE owner_id=? ORDER BY updated_at DESC LIMIT 500", (_owner(),)).fetchall()
    return [{"threadId": r["thread_id"], "data": r["data"], "updatedAt": r["updated_at"]} for r in rows]


def delete_chat_thread(thread_id: str) -> bool:
    with connect() as db:
        cursor = db.execute("DELETE FROM chat_threads WHERE thread_id=? AND owner_id=?", (thread_id, _owner()))
    return cursor.rowcount > 0


def audit(event: str, payload: dict[str, Any]) -> None:
    with connect() as db:
        db.execute("INSERT INTO audit_log(event, payload) VALUES (?, ?)", (event, json.dumps(payload, ensure_ascii=False)))


def save_experiment(kind: str, name: str, config: dict[str, Any], result: dict[str, Any]) -> int:
    with connect() as db:
        cursor = db.execute(
            "INSERT INTO experiments(owner_id,kind,name,status,config,result) VALUES(?,?,?,?,?,?)",
            (_owner(), kind, name, "completed", json.dumps(config), json.dumps(result)),
        )
        return int(cursor.lastrowid)


def get_experiment(experiment_id: int) -> dict[str, Any] | None:
    """读取一条实验工件。config/result 解析为对象；解析失败时保留原字符串。"""
    with connect() as db:
        row = db.execute(
            "SELECT id,kind,name,status,config,result,created_at,updated_at FROM experiments WHERE id=? AND owner_id=?",
            (int(experiment_id), _owner()),
        ).fetchone()
    if row is None:
        return None
    item = dict(row)
    for field in ("config", "result"):
        raw = item.get(field)
        if isinstance(raw, str):
            try:
                item[field] = json.loads(raw)
            except (TypeError, ValueError, json.JSONDecodeError):
                pass
    return item


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
        1 if task.get("tradingDaysOnly", False) else 0,
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
        "tradingDaysOnly": bool(row["trading_days_only"]) if "trading_days_only" in row.keys() else False,
        "createdAt": row["created_at"],
        "lastRunAt": row["last_run_at"],
        "lastStatus": row["last_status"] or None,
        "lastResult": row["last_result"] or None,
        "history": json.loads(row["history"] or "[]"),
    }


def list_scheduled_tasks() -> list[dict[str, Any]]:
    with connect() as db:
        rows = db.execute("SELECT * FROM scheduled_tasks WHERE owner_id=? ORDER BY created_at", (_owner(),)).fetchall()
    return [_task_from_row(r) for r in rows]


def get_scheduled_task(task_id: str) -> dict[str, Any] | None:
    with connect() as db:
        row = db.execute("SELECT * FROM scheduled_tasks WHERE id=? AND owner_id=?", (task_id, _owner())).fetchone()
    return _task_from_row(row) if row else None


def upsert_scheduled_task(task: dict[str, Any]) -> dict[str, Any]:
    row = _task_to_row(task)
    with connect() as db:
        db.execute(
            "INSERT INTO scheduled_tasks(owner_id,id,name,prompt,frequency,hour,minute,weekdays,interval_minutes,model,provider,reasoning,enabled,trading_days_only,created_at,last_run_at,last_status,last_result,history) "
            "VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?) "
            "ON CONFLICT(id) DO UPDATE SET name=excluded.name,prompt=excluded.prompt,frequency=excluded.frequency,"
            "hour=excluded.hour,minute=excluded.minute,weekdays=excluded.weekdays,interval_minutes=excluded.interval_minutes,"
            "model=excluded.model,provider=excluded.provider,reasoning=excluded.reasoning,enabled=excluded.enabled,"
            "trading_days_only=excluded.trading_days_only,"
            "created_at=excluded.created_at,last_run_at=excluded.last_run_at,last_status=excluded.last_status,"
            "last_result=excluded.last_result,history=excluded.history "
            "WHERE scheduled_tasks.owner_id=excluded.owner_id",
            (_owner(), *row),
        )
    stored = get_scheduled_task(task["id"])
    return stored if stored is not None else {**task, "id": str(task.get("id") or "")}


def delete_scheduled_task(task_id: str) -> bool:
    with connect() as db:
        cursor = db.execute("DELETE FROM scheduled_tasks WHERE id=? AND owner_id=?", (task_id, _owner()))
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


def upsert_analysis_bars(rows: list[dict[str, Any]]) -> None:
    """写入研究使用的日线原始字段与数据血缘；绝不从 close 合成 OHLCV。"""
    if not rows:
        return
    values: list[tuple[Any, ...]] = []
    for row in rows:
        symbol = str(row.get("symbol") or "").strip().upper()
        trade_date = str(row.get("trade_date") or "").strip()[:10]
        source = str(row.get("source") or "").strip()
        if not symbol or not trade_date or not source:
            raise ValueError("analysis_bars 必须包含 symbol、trade_date 和 source")

        def number(name: str, *, required: bool = False) -> float | None:
            value = row.get(name)
            if value is None or value == "":
                if required:
                    raise ValueError(f"analysis_bars 缺少 {name}")
                return None
            try:
                result = float(value)
            except (TypeError, ValueError) as exc:
                raise ValueError(f"analysis_bars 的 {name} 不是数值") from exc
            if not math.isfinite(result):
                raise ValueError(f"analysis_bars 的 {name} 必须是有限数值")
            return result

        open_ = number("open")
        high = number("high")
        low = number("low")
        close = number("close", required=True)
        volume = number("volume")
        amount = number("amount")
        if close is None or close <= 0:
            raise ValueError("analysis_bars 的 close 必须大于 0")
        prices = [value for value in (open_, high, low, close) if value is not None]
        if any(value <= 0 for value in prices):
            raise ValueError("analysis_bars 的 OHLC 必须大于 0")
        if high is not None and high < max(value for value in (open_, low, close) if value is not None):
            raise ValueError("analysis_bars 的 high 小于 OHLC")
        if low is not None and low > min(value for value in (open_, high, close) if value is not None):
            raise ValueError("analysis_bars 的 low 大于 OHLC")
        if (volume is not None and volume < 0) or (amount is not None and amount < 0):
            raise ValueError("analysis_bars 的 volume/amount 不能为负")
        values.append((symbol, trade_date, str(row.get("market") or "unknown"), str(row.get("adjust") or ""), source, open_, high, low, close, volume, amount))
    with connect() as db:
        db.executemany(
            "INSERT INTO analysis_bars(symbol,trade_date,market,adjust,source,open,high,low,close,volume,amount) VALUES(?,?,?,?,?,?,?,?,?,?,?) "
            "ON CONFLICT(symbol,trade_date) DO UPDATE SET market=excluded.market,adjust=excluded.adjust,source=excluded.source,open=excluded.open,high=excluded.high,low=excluded.low,close=excluded.close,volume=excluded.volume,amount=excluded.amount,ingested_at=CURRENT_TIMESTAMP",
            values,
        )


def read_analysis_bars() -> list[dict[str, Any]]:
    with connect() as db:
        rows = db.execute(
            "SELECT symbol,trade_date,market,adjust,source,open,high,low,close,volume,amount,ingested_at FROM analysis_bars ORDER BY symbol,trade_date"
        ).fetchall()
    return [dict(row) for row in rows]


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


# ---------- Agent 审批队列 ----------

def create_approval(approval_id: str, tool: str, arguments: str, thread_id: str | None = None) -> dict[str, Any]:
    now = int(time.time() * 1000)
    with connect() as db:
        db.execute(
            "INSERT INTO agent_approvals(id, owner_id, tool, arguments, thread_id, status, created_at) VALUES(?,?,?,?,?, 'pending', ?)",
            (approval_id, _owner(), tool, arguments, thread_id, now),
        )
    return {"id": approval_id, "tool": tool, "arguments": arguments, "thread_id": thread_id, "status": "pending", "created_at": now}


def get_approval(approval_id: str) -> dict[str, Any] | None:
    with connect() as db:
        row = db.execute("SELECT * FROM agent_approvals WHERE id=? AND owner_id=?", (approval_id, _owner())).fetchone()
    return dict(row) if row else None


def list_approvals(status: str | None = None, limit: int = 50) -> list[dict[str, Any]]:
    query = "SELECT * FROM agent_approvals WHERE owner_id=?"
    params: list[Any] = [_owner()]
    if status:
        query += " AND status=?"
        params.append(status)
    query += " ORDER BY created_at DESC LIMIT ?"
    params.append(limit)
    with connect() as db:
        rows = db.execute(query, params).fetchall()
    return [dict(row) for row in rows]


def decide_approval(approval_id: str, status: str, reason: str = "", result: str = "") -> dict[str, Any] | None:
    with connect() as db:
        db.execute(
            "UPDATE agent_approvals SET status=?, reason=?, result=?, decided_at=? WHERE id=? AND owner_id=?",
            (status, reason, result, int(time.time() * 1000), approval_id, _owner()),
        )
    return get_approval(approval_id)


# ---------- Agent 资源用量 ----------

def bump_agent_usage(day: str, tool_calls: int = 0, runs: int = 0, tokens: int = 0) -> dict[str, Any]:
    with connect() as db:
        db.execute(
            "INSERT INTO agent_usage(day, tool_calls, runs, tokens) VALUES(?,?,?,?) "
            "ON CONFLICT(day) DO UPDATE SET tool_calls=tool_calls+excluded.tool_calls, runs=runs+excluded.runs, tokens=tokens+excluded.tokens",
            (day, tool_calls, runs, max(0, int(tokens))),
        )
        row = db.execute("SELECT day, tool_calls, runs, tokens FROM agent_usage WHERE day=?", (day,)).fetchone()
    return dict(row) if row else {"day": day, "tool_calls": 0, "runs": 0, "tokens": 0}


def get_agent_usage(day: str) -> dict[str, Any]:
    with connect() as db:
        row = db.execute("SELECT day, tool_calls, runs, tokens FROM agent_usage WHERE day=?", (day,)).fetchone()
    return dict(row) if row else {"day": day, "tool_calls": 0, "runs": 0, "tokens": 0}


def get_agent_usage_series(days: int = 14) -> dict[str, Any]:
    """最近 N 天（含今天）的 Agent 用量序列与汇总，缺失日期补零。"""
    import datetime as _dt

    today = _dt.date.today()
    start = today - _dt.timedelta(days=max(days, 1) - 1)
    with connect() as db:
        rows = db.execute(
            "SELECT day, tool_calls, runs, tokens FROM agent_usage WHERE day >= ? AND day <= ? ORDER BY day",
            (start.isoformat(), today.isoformat()),
        ).fetchall()
    by_day = {row["day"]: dict(row) for row in rows}
    series: list[dict[str, Any]] = []
    total_calls = total_runs = total_tokens = 0
    for offset in range(max(days, 1) - 1, -1, -1):
        day = (today - _dt.timedelta(days=offset)).isoformat()
        item = by_day.get(day, {"day": day, "tool_calls": 0, "runs": 0, "tokens": 0})
        total_calls += item["tool_calls"]
        total_runs += item["runs"]
        total_tokens += item.get("tokens", 0)
        series.append(item)
    return {"days": days, "series": series, "total": {"tool_calls": total_calls, "runs": total_runs, "tokens": total_tokens}}


def touch_chat_session(thread_id: str, at_ms: int) -> None:
    """记录一次 Agent 运行所在会话的首/末时间，用于「最长聊天时长」统计。"""
    with connect() as db:
        db.execute(
            "INSERT INTO chat_sessions(thread_id, first_at, last_at) VALUES(?,?,?) "
            "ON CONFLICT(thread_id) DO UPDATE SET "
            "first_at=MIN(first_at, excluded.first_at), last_at=MAX(last_at, excluded.last_at) "
            "WHERE chat_sessions.owner_id=excluded.owner_id",
            (thread_id, int(at_ms), int(at_ms)),
        )


def get_usage_stats() -> dict[str, Any]:
    """Codex 风格用量统计：累计/峰值 tokens、最长聊天时长、当前/最长连续活跃天数。
    连续天数按「当日有 Agent 活动(runs>0)」计，从今天（或昨天）往前回溯。"""
    import datetime as _dt

    with connect() as db:
        row = db.execute("SELECT COALESCE(SUM(tokens),0) total_tokens, COALESCE(MAX(tokens),0) peak_tokens FROM agent_usage").fetchone()
        session = db.execute("SELECT MAX(last_at - first_at) span FROM chat_sessions").fetchone()
        active = [r["day"] for r in db.execute("SELECT day FROM agent_usage WHERE runs>0 ORDER BY day")]
    active_set = set(active)
    today = _dt.date.today()

    def _to_date(token: str) -> _dt.date:
        return _dt.date.fromisoformat(token)

    # 当前连续：从今天起往回数；今天还没活动则从昨天起（不因「今天还没开始用」清零）
    current = 0
    cursor = today
    if today.isoformat() not in active_set:
        cursor = today - _dt.timedelta(days=1)
    while cursor.isoformat() in active_set:
        current += 1
        cursor -= _dt.timedelta(days=1)
    # 最长连续：遍历全部活跃日
    longest = best = 0
    prev: _dt.date | None = None
    for token in active:
        day = _to_date(token)
        best = best + 1 if prev is not None and (day - prev).days == 1 else 1
        longest = max(longest, best)
        prev = day
    span_ms = int(session["span"] or 0) if session else 0
    return {
        "totalTokens": int(row["total_tokens"] or 0),
        "peakTokens": int(row["peak_tokens"] or 0),
        "longestChatSeconds": span_ms // 1000,
        "currentStreak": current,
        "longestStreak": longest,
    }


# ---------- 账户与会话（登录/注册） ----------

def count_users() -> int:
    with connect() as db:
        row = db.execute("SELECT COUNT(*) AS n FROM users").fetchone()
    return int(row["n"]) if row else 0


def create_user(user_id: str, username: str, password_hash: str, role: str = "admin") -> dict[str, Any]:
    now = int(time.time() * 1000)
    role = role if role in {"admin", "operator", "viewer"} else "operator"
    with connect() as db:
        db.execute(
            "INSERT INTO users(id, username, password_hash, created_at, role, totp_enabled) VALUES(?,?,?,?,?,0)",
            (user_id, username, password_hash, now, role),
        )
    return {"id": user_id, "username": username, "created_at": now, "last_login_at": None, "role": role}


def get_user_by_username(username: str) -> dict[str, Any] | None:
    with connect() as db:
        row = db.execute("SELECT * FROM users WHERE username=?", (username,)).fetchone()
    return dict(row) if row else None


def touch_user_login(user_id: str) -> None:
    with connect() as db:
        db.execute("UPDATE users SET last_login_at=? WHERE id=?", (int(time.time() * 1000), user_id))


def create_session(token: str, user_id: str, expires_at: int, user_agent: str = "") -> None:
    now = int(time.time() * 1000)
    with connect() as db:
        # 顺手清理过期会话，避免表无限增长
        db.execute("DELETE FROM sessions WHERE expires_at < ?", (now,))
        db.execute(
            "INSERT INTO sessions(token, user_id, created_at, expires_at, user_agent) VALUES(?,?,?,?,?)",
            (token, user_id, now, expires_at, user_agent[:200]),
        )


def get_session(token: str) -> dict[str, Any] | None:
    """返回未过期的会话及其用户信息；过期视为不存在。"""
    now = int(time.time() * 1000)
    with connect() as db:
        row = db.execute(
            "SELECT s.token, s.user_id, s.created_at, s.expires_at, u.username, u.created_at AS user_created_at, "
            "COALESCE(u.role,'admin') AS role, COALESCE(u.totp_enabled,0) AS totp_enabled "
            "FROM sessions s JOIN users u ON u.id = s.user_id WHERE s.token=? AND s.expires_at >= ?",
            (token, now),
        ).fetchone()
    return dict(row) if row else None


def delete_session(token: str) -> bool:
    with connect() as db:
        cursor = db.execute("DELETE FROM sessions WHERE token=?", (token,))
    return cursor.rowcount > 0


def get_user_by_id(user_id: str) -> dict[str, Any] | None:
    with connect() as db:
        row = db.execute("SELECT * FROM users WHERE id=?", (user_id,)).fetchone()
    return dict(row) if row else None


def set_user_totp(user_id: str, secret: str | None, enabled: bool) -> None:
    with connect() as db:
        db.execute(
            "UPDATE users SET totp_secret=?, totp_enabled=? WHERE id=?",
            (secret, 1 if enabled else 0, user_id),
        )


def snapshot_holdings(reason: str) -> int:
    with connect() as db:
        rows = [dict(row) for row in db.execute("SELECT symbol,name,quantity,avg_cost,market_value FROM holdings WHERE owner_id=?", (_owner(),)).fetchall()]
        cursor = db.execute(
            "INSERT INTO holdings_snapshots(owner_id,created_at,reason,payload) VALUES(?,?,?,?)",
            (_owner(), int(time.time() * 1000), reason[:80], json.dumps(rows, ensure_ascii=False)),
        )
        return int(cursor.lastrowid)


def restore_holdings_snapshot(snapshot_id: int) -> dict[str, Any]:
    with connect() as db:
        row = db.execute("SELECT * FROM holdings_snapshots WHERE id=? AND owner_id=?", (int(snapshot_id), _owner())).fetchone()
        if row is None:
            return {"ok": False, "error": "快照不存在"}
        payload = json.loads(row["payload"] or "[]")
        db.execute("DELETE FROM holdings WHERE owner_id=?", (_owner(),))
        db.executemany(
            "INSERT INTO holdings(owner_id,symbol,name,quantity,avg_cost,market_value) VALUES(?,?,?,?,?,?)",
            [(_owner(), item.get("symbol"), item.get("name"), item.get("quantity"), item.get("avg_cost"), item.get("market_value")) for item in payload],
        )
    return {"ok": True, "restored": len(payload), "snapshot_id": int(snapshot_id)}


def save_tool_artifact(tool: str, summary: str, payload: dict[str, Any], thread_id: str | None = None) -> int:
    compact = json.dumps(payload, ensure_ascii=False)
    if len(compact) > 200_000:
        compact = json.dumps({"truncated": True, "summary": summary}, ensure_ascii=False)
    with connect() as db:
        cursor = db.execute(
            "INSERT INTO tool_artifacts(owner_id,thread_id,tool,summary,payload,created_at) VALUES(?,?,?,?,?,?)",
            (_owner(), thread_id, tool, summary[:240], compact, int(time.time() * 1000)),
        )
        aid = int(cursor.lastrowid)
        db.execute("DELETE FROM tool_artifacts WHERE id NOT IN (SELECT id FROM tool_artifacts ORDER BY id DESC LIMIT 400)")
    return aid


def get_tool_artifact(artifact_id: int) -> dict[str, Any] | None:
    with connect() as db:
        row = db.execute("SELECT * FROM tool_artifacts WHERE id=? AND owner_id=?", (int(artifact_id), _owner())).fetchone()
    if row is None:
        return None
    item = dict(row)
    try:
        item["payload"] = json.loads(item.get("payload") or "{}")
    except (TypeError, ValueError, json.JSONDecodeError):
        pass
    return item


def list_tool_artifacts(thread_id: str | None = None, limit: int = 20) -> list[dict[str, Any]]:
    with connect() as db:
        if thread_id:
            rows = db.execute(
                "SELECT id,thread_id,tool,summary,created_at FROM tool_artifacts WHERE owner_id=? AND thread_id=? ORDER BY id DESC LIMIT ?",
                (_owner(), thread_id, limit),
            ).fetchall()
        else:
            rows = db.execute(
                "SELECT id,thread_id,tool,summary,created_at FROM tool_artifacts WHERE owner_id=? ORDER BY id DESC LIMIT ?",
                (_owner(), limit),
            ).fetchall()
    return [dict(row) for row in rows]


def save_oms_draft(draft_id: str, payload: dict[str, Any]) -> dict[str, Any]:
    now = int(time.time() * 1000)
    blob = json.dumps(payload, ensure_ascii=False)
    with connect() as db:
        db.execute(
            "INSERT INTO oms_drafts(id, owner_id, created_at, status, payload) VALUES(?,?,?, 'open', ?) "
            "ON CONFLICT(id) DO UPDATE SET created_at=excluded.created_at,status='open',payload=excluded.payload "
            "WHERE oms_drafts.owner_id=excluded.owner_id",
            (draft_id, _owner(), now, blob),
        )
    return {"id": draft_id, "created_at": now, "status": "open", "payload": payload}


def list_oms_drafts(status: str = "open") -> list[dict[str, Any]]:
    with connect() as db:
        if status == "all":
            rows = db.execute("SELECT * FROM oms_drafts WHERE owner_id=? ORDER BY created_at DESC LIMIT 50", (_owner(),)).fetchall()
        else:
            rows = db.execute("SELECT * FROM oms_drafts WHERE owner_id=? AND status=? ORDER BY created_at DESC LIMIT 50", (_owner(), status)).fetchall()
    items = []
    for row in rows:
        item = dict(row)
        try:
            item["payload"] = json.loads(item.get("payload") or "{}")
        except (TypeError, ValueError, json.JSONDecodeError):
            pass
        items.append(item)
    return items


def close_oms_draft(draft_id: str) -> bool:
    with connect() as db:
        cursor = db.execute("UPDATE oms_drafts SET status='consumed' WHERE id=? AND status='open'", (draft_id,))
    return cursor.rowcount > 0


# ---------- 实盘风控状态持久化 (broker_risk) ----------
# 熔断/日锚/频率/解锁全部落库：引擎重启后风控状态不丢失，无法借重启绕过。


def load_broker_risk(broker: str) -> dict[str, Any] | None:
    with connect() as db:
        row = db.execute("SELECT * FROM broker_risk WHERE broker=?", (broker,)).fetchone()
    if row is None:
        return None
    try:
        order_times = json.loads(row["order_times"] or "[]")
    except (TypeError, ValueError, json.JSONDecodeError):
        order_times = []
    return {
        "broker": row["broker"],
        "day": row["day"] or "",
        "day_start_equity": row["day_start_equity"],
        "tripped_reason": row["tripped_reason"],
        "live_armed_until": int(row["live_armed_until"] or 0),
        "order_times": [float(t) for t in order_times if isinstance(t, (int, float))],
    }


def save_broker_risk(broker: str, *, day: str, day_start_equity: float | None, tripped_reason: str | None, live_armed_until: int, order_times: list[float]) -> None:
    with connect() as db:
        db.execute(
            "INSERT INTO broker_risk(broker, day, day_start_equity, tripped_reason, live_armed_until, order_times) "
            "VALUES(?,?,?,?,?,?) "
            "ON CONFLICT(broker) DO UPDATE SET day=excluded.day, day_start_equity=excluded.day_start_equity, "
            "tripped_reason=excluded.tripped_reason, live_armed_until=excluded.live_armed_until, order_times=excluded.order_times",
            (broker, day, day_start_equity, tripped_reason, int(live_armed_until), json.dumps(order_times)),
        )


# ---------- 本地订单台账 (broker_orders) ----------
# 下单即落库，回报轮询只更新状态；终态订单保留用于对账。

ORDER_TERMINAL = frozenset({"filled", "cancelled", "canceled", "expired", "rejected", "replaced"})
ORDER_TRANSITIONS = {
    "submitted": frozenset({"submitted", "new", "accepted", "pending", "presubmitted", "partially_filled", "filled", "cancelled", "canceled", "expired", "rejected", "replaced", "unknown"}),
    "new": frozenset({"new", "accepted", "pending", "partially_filled", "filled", "cancelled", "canceled", "expired", "rejected", "replaced", "unknown"}),
    "accepted": frozenset({"accepted", "new", "pending", "partially_filled", "filled", "cancelled", "canceled", "expired", "rejected", "replaced", "unknown"}),
    "pending": frozenset({"pending", "accepted", "new", "partially_filled", "filled", "cancelled", "canceled", "expired", "rejected", "unknown"}),
    "presubmitted": frozenset({"presubmitted", "submitted", "accepted", "new", "partially_filled", "filled", "cancelled", "canceled", "rejected", "unknown"}),
    "partially_filled": frozenset({"partially_filled", "filled", "cancelled", "canceled", "expired", "rejected", "unknown"}),
    "unknown": frozenset({"unknown", "submitted", "new", "accepted", "pending", "partially_filled", "filled", "cancelled", "canceled", "expired", "rejected"}),
}


def upsert_broker_order(order: dict[str, Any]) -> None:
    now = int(time.time() * 1000)
    with connect() as db:
        db.execute(
            "INSERT INTO broker_orders(id, broker, remote_id, symbol, side, order_type, quantity, limit_price, stop_price, "
            "time_in_force, status, filled_qty, filled_avg_price, trading_mode, submitted_at, updated_at, last_error) "
            "VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?) "
            "ON CONFLICT(id) DO UPDATE SET remote_id=excluded.remote_id, status=excluded.status, filled_qty=excluded.filled_qty, "
            "filled_avg_price=excluded.filled_avg_price, updated_at=excluded.updated_at, last_error=excluded.last_error",
            (
                str(order.get("id") or ""), str(order.get("broker") or ""), order.get("remote_id"),
                str(order.get("symbol") or ""), str(order.get("side") or ""), str(order.get("order_type") or "market"),
                float(order.get("quantity") or 0), order.get("limit_price"), order.get("stop_price"),
                str(order.get("time_in_force") or "day"), str(order.get("status") or "submitted"),
                float(order.get("filled_qty") or 0), order.get("filled_avg_price"),
                str(order.get("trading_mode") or "paper"), int(order.get("submitted_at") or now), now, order.get("last_error"),
            ),
        )


def list_broker_orders(broker: str | None = None, statuses: list[str] | None = None, limit: int = 200) -> list[dict[str, Any]]:
    clauses: list[str] = []
    params: list[Any] = []
    if broker:
        clauses.append("broker=?")
        params.append(broker)
    if statuses:
        clauses.append(f"status IN ({','.join('?' * len(statuses))})")
        params.extend(statuses)
    where = ("WHERE " + " AND ".join(clauses)) if clauses else ""
    params.append(limit)
    with connect() as db:
        rows = db.execute(f"SELECT * FROM broker_orders {where} ORDER BY submitted_at DESC LIMIT ?", params).fetchall()
    return [dict(row) for row in rows]


def update_broker_order(order_id: str, *, status: str | None = None, remote_id: str | None = None, filled_qty: float | None = None, filled_avg_price: float | None = None, last_error: str | None = None) -> bool:
    """Apply a monotonic, auditable order update; reject impossible broker reports."""
    fields: list[str] = []
    params: list[Any] = []
    if status is not None:
        fields.append("status=?")
        params.append(status)
    if remote_id is not None:
        fields.append("remote_id=?")
        params.append(remote_id)
    if filled_qty is not None:
        fields.append("filled_qty=?")
        params.append(filled_qty)
    if filled_avg_price is not None:
        fields.append("filled_avg_price=?")
        params.append(filled_avg_price)
    if last_error is not None:
        fields.append("last_error=?")
        params.append(last_error)
    with connect() as db:
        current = db.execute("SELECT status,quantity,filled_qty FROM broker_orders WHERE id=?", (order_id,)).fetchone()
        if current is None:
            return False
        old_status = str(current["status"] or "unknown").lower()
        new_status = str(status or old_status).lower()
        if new_status != old_status and new_status not in ORDER_TERMINAL and new_status not in ORDER_TRANSITIONS.get(old_status, frozenset()):
            return False
        if old_status in ORDER_TERMINAL and new_status != old_status:
            return False
        old_filled = float(current["filled_qty"] or 0.0)
        if filled_qty is not None and (not math.isfinite(float(filled_qty)) or float(filled_qty) < old_filled - 1e-9 or float(filled_qty) > float(current["quantity"]) + 1e-9):
            return False
        if not fields:
            return True
        fields.append("updated_at=?")
        params.append(int(time.time() * 1000))
        params.append(order_id)
        cursor = db.execute(f"UPDATE broker_orders SET {', '.join(fields)} WHERE id=?", params)
        return cursor.rowcount == 1
