from __future__ import annotations

import asyncio
import hashlib
import json
import math
import os
import re
import secrets
import time
from contextlib import asynccontextmanager
from datetime import date, datetime, timezone
from html.parser import HTMLParser
from typing import Any
from urllib.parse import urljoin

import numpy as np
import pandas as pd
import httpx
from fastapi import FastAPI, HTTPException, Request
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse, StreamingResponse
from openai import AsyncOpenAI
from pydantic import BaseModel, Field, field_validator, model_validator

try:
    from .database import add_notification, add_thread_message, audit, clear_thread_messages, connect, delete_alert, delete_chat_thread, get_setting, initialize, list_alerts, list_chat_threads, list_notifications, list_thread_messages, mark_alert_triggered, mark_notifications_read, pop_setting, read_analysis_bars, save_experiment, set_setting, unread_notification_count, upsert_alert, upsert_analysis_bars, upsert_chat_thread
    from .quant import backtest_signal, optimize_portfolio, risk_report, run_alpha_ensemble
except ImportError:
    try:
        from engine.database import add_notification, add_thread_message, audit, clear_thread_messages, connect, delete_alert, delete_chat_thread, get_setting, initialize, list_alerts, list_chat_threads, list_notifications, list_thread_messages, mark_alert_triggered, mark_notifications_read, pop_setting, read_analysis_bars, save_experiment, set_setting, unread_notification_count, upsert_alert, upsert_analysis_bars, upsert_chat_thread
        from engine.quant import backtest_signal, optimize_portfolio, risk_report, run_alpha_ensemble
    except ImportError:
        from database import add_notification, add_thread_message, audit, clear_thread_messages, connect, delete_alert, delete_chat_thread, get_setting, initialize, list_alerts, list_chat_threads, list_notifications, list_thread_messages, mark_alert_triggered, mark_notifications_read, pop_setting, read_analysis_bars, save_experiment, set_setting, unread_notification_count, upsert_alert, upsert_analysis_bars, upsert_chat_thread
        from quant import backtest_signal, optimize_portfolio, risk_report, run_alpha_ensemble

try:
    from .portfolio_backtest import BacktestDataError, run_portfolio_backtest
    from .factors import FactorCodeError, build_panels, compile_factor, evaluate_factor
    from .netsec import UnsafeUrlError, validate_public_https_url
except ImportError:
    try:
        from engine.portfolio_backtest import BacktestDataError, run_portfolio_backtest
        from engine.factors import FactorCodeError, build_panels, compile_factor, evaluate_factor
        from engine.netsec import UnsafeUrlError, validate_public_https_url
    except ImportError:
        from portfolio_backtest import BacktestDataError, run_portfolio_backtest
        from factors import FactorCodeError, build_panels, compile_factor, evaluate_factor
        from netsec import UnsafeUrlError, validate_public_https_url


def _restore_provider_keys() -> None:
    """从本地存储恢复提供商密钥。历史上密钥曾明文写入 SQLite settings 表，
    现统一迁出到内存（桌面端由 Tauri 从 Credential Manager 注入环境变量），
    读取即删除，保证密钥不再落盘。"""
    global AGENT_API_KEY, DEEPSEEK_API_KEY, QWEN_API_KEY, MARKET_API_KEY, TUSHARE_TOKEN
    AGENT_API_KEY = AGENT_API_KEY or os.getenv("OPENAI_API_KEY", "") or pop_setting("openai_api_key")
    DEEPSEEK_API_KEY = DEEPSEEK_API_KEY or os.getenv("DEEPSEEK_API_KEY", "") or pop_setting("deepseek_api_key")
    QWEN_API_KEY = QWEN_API_KEY or os.getenv("DASHSCOPE_API_KEY", "") or pop_setting("dashscope_api_key")
    MARKET_API_KEY = MARKET_API_KEY or os.getenv("ALPHAVANTAGE_API_KEY", "") or pop_setting("alphavantage_api_key")
    TUSHARE_TOKEN = TUSHARE_TOKEN or os.getenv("TUSHARE_TOKEN", "") or pop_setting("tushare_token")


# ---------- 本地引擎鉴权 ----------
# 正式桌面端在进程启动时通过环境变量传入随机 token；token 仅存于两个进程内存，
# 不再落到可被同机其它进程读取的文件。手工启动时须显式设置 QUANTDESK_ENGINE_TOKEN。
ENGINE_TOKEN = os.getenv("QUANTDESK_ENGINE_TOKEN", "") or secrets.token_urlsafe(24)


@asynccontextmanager
async def lifespan(_: FastAPI):
    initialize()
    _restore_provider_keys()
    audit("engine_started", {"version": "0.3.5"})
    # 引擎侧定时调度器：桌面端持有引擎进程期间按计划运行；退出桌面端即停止。
    scheduler_task = asyncio.create_task(_scheduler_loop())
    yield
    scheduler_task.cancel()
    try:
        await scheduler_task
    except asyncio.CancelledError:
        pass


app = FastAPI(title="QuantDesk Engine", version="0.3.5", lifespan=lifespan)

try:
    from .marketdata import router as market_router
    from .marketdata import import_daily_prices, market_detail, market_fflow, market_hsgt, market_indices, market_kline, market_news, market_quotes, market_rankings, market_search
except ImportError:
    try:
        from engine.marketdata import router as market_router
        from engine.marketdata import import_daily_prices, market_detail, market_fflow, market_hsgt, market_indices, market_kline, market_news, market_quotes, market_rankings, market_search
    except ImportError:
        from marketdata import router as market_router
        from marketdata import import_daily_prices, market_detail, market_fflow, market_hsgt, market_indices, market_kline, market_news, market_quotes, market_rankings, market_search
app.include_router(market_router)

try:
    from .papertrade import router as papertrade_router
    from .papertrade import _account_snapshot, _list_orders, _list_trades, cancel_order, get_risk_limits as get_paper_risk_limits, place_order as place_paper_order, process_pending_orders, update_risk_limits as update_paper_risk_limits
except ImportError:
    try:
        from engine.papertrade import router as papertrade_router
        from engine.papertrade import _account_snapshot, _list_orders, _list_trades, cancel_order, get_risk_limits as get_paper_risk_limits, place_order as place_paper_order, process_pending_orders, update_risk_limits as update_paper_risk_limits
    except ImportError:
        from papertrade import router as papertrade_router
        from papertrade import _account_snapshot, _list_orders, _list_trades, cancel_order, get_risk_limits as get_paper_risk_limits, place_order as place_paper_order, process_pending_orders, update_risk_limits as update_paper_risk_limits
app.include_router(papertrade_router)

try:
    from .scheduler import router as scheduler_router
    from .scheduler import delete_scheduled_task as db_delete_task, get_scheduled_task as db_get_task, list_scheduled_tasks as db_list_tasks, upsert_scheduled_task as db_upsert_task
except ImportError:
    try:
        from engine.scheduler import router as scheduler_router
        from engine.scheduler import delete_scheduled_task as db_delete_task, get_scheduled_task as db_get_task, list_scheduled_tasks as db_list_tasks, upsert_scheduled_task as db_upsert_task
    except ImportError:
        from scheduler import router as scheduler_router
        from scheduler import delete_scheduled_task as db_delete_task, get_scheduled_task as db_get_task, list_scheduled_tasks as db_list_tasks, upsert_scheduled_task as db_upsert_task
app.include_router(scheduler_router)

app.add_middleware(
    CORSMiddleware,
    allow_origins=[
        "http://localhost:1420",
        "http://127.0.0.1:1420",
        "tauri://localhost",
        "http://tauri.localhost",
        "https://tauri.localhost",
    ],
    allow_methods=["*"],
    allow_headers=["*"],
)


@app.middleware("http")
async def _auth_guard(request: Request, call_next):
    """本地回环鉴权：校验 X-QuantDesk-Token。防止同机其它进程静默调用
    下单/导入/Agent 等接口。OPTIONS 预检放行由 CORS 中处理。"""
    if request.method != "OPTIONS" and request.headers.get("x-quantdesk-token", "") != ENGINE_TOKEN:
        return JSONResponse({"detail": "引擎令牌缺失或不匹配"}, status_code=401)
    return await call_next(request)


class AgentRequest(BaseModel):
    prompt: str = Field(min_length=2, max_length=8000)
    model: str = "gpt-5.4-mini"
    provider: str = "openai"
    reasoning: str = "medium"  # off | low | medium | high
    access_mode: str = Field(default="ask", pattern="^(ask|approve|full)$")
    thread_id: str | None = Field(default=None, max_length=80)


class AgentConfigureRequest(BaseModel):
    api_key: str = Field(min_length=8)


class MarketPriceRow(BaseModel):
    symbol: str = Field(min_length=1, max_length=32)
    date: str = Field(min_length=8, max_length=32)
    close: float = Field(gt=0)
    open: float | None = Field(default=None, gt=0)
    high: float | None = Field(default=None, gt=0)
    low: float | None = Field(default=None, gt=0)
    volume: float | None = Field(default=None, ge=0)
    amount: float | None = Field(default=None, ge=0)

    @field_validator("date")
    @classmethod
    def normalize_trade_date(cls, value: str) -> str:
        try:
            return date.fromisoformat(value[:10]).isoformat()
        except ValueError as exc:
            raise ValueError("date 必须是 YYYY-MM-DD") from exc

    @model_validator(mode="after")
    def validate_ohlc(self) -> "MarketPriceRow":
        prices = [value for value in (self.open, self.high, self.low, self.close) if value is not None]
        if self.high is not None and self.high < max(prices):
            raise ValueError("high 不能小于 open/low/close")
        if self.low is not None and self.low > min(prices):
            raise ValueError("low 不能大于 open/high/close")
        return self


class MarketImportRequest(BaseModel):
    rows: list[MarketPriceRow] = Field(min_length=1, max_length=500_000)
    source: str = Field(default="csv", max_length=40)
    market: str = Field(default="unknown", max_length=16)
    adjust: str = Field(default="", pattern="^(qfq|hfq|)$")


class ProviderConfigureRequest(BaseModel):
    provider: str = Field(min_length=2, max_length=40)
    api_key: str = Field(min_length=8)


class MarketSyncRequest(BaseModel):
    asset_type: str = Field(pattern="^(stock|fx)$")
    symbol: str | None = Field(default=None, max_length=32)
    from_symbol: str | None = Field(default=None, max_length=8)
    to_symbol: str | None = Field(default=None, max_length=8)


class TushareSyncRequest(BaseModel):
    asset_type: str = Field(pattern="^(stock|future)$")
    symbol: str = Field(min_length=3, max_length=32)


class PublicSyncRequest(BaseModel):
    symbols: list[str] = Field(min_length=1, max_length=8)


class HoldingRow(BaseModel):
    symbol: str = Field(min_length=1, max_length=32)
    name: str | None = Field(default=None, max_length=80)
    quantity: float
    avg_cost: float | None = Field(default=None, ge=0)
    market_value: float | None = Field(default=None, ge=0)


class HoldingsImportRequest(BaseModel):
    rows: list[HoldingRow] = Field(min_length=1, max_length=10_000)


class BacktestRequest(BaseModel):
    returns: list[float]
    signals: list[float]
    cost_bps: float = Field(12.0, ge=0, le=100)


class OptimizeRequest(BaseModel):
    expected_returns: list[float]
    return_history: list[list[float]]
    max_weight: float = Field(.12, gt=0, le=1)
    risk_aversion: float = Field(5.0, gt=0, le=50)


class RiskRequest(BaseModel):
    returns: list[float]
    confidence: float = Field(.95, gt=.8, lt=1)


class EnsembleRequest(BaseModel):
    symbol: str | None = None
    predict_ahead: int = Field(default=1, ge=1, le=10)


class FactorEvaluateRequest(BaseModel):
    name: str = Field(default="custom_factor", max_length=60)
    code: str = Field(min_length=10, max_length=8000)
    horizon: int = Field(default=1, ge=1, le=10)
    quantiles: int = Field(default=5, ge=2, le=10)


class PortfolioBacktestRequest(BaseModel):
    weights: dict[str, float] = Field(min_length=1, max_length=100)
    rebalance_days: int = Field(default=20, ge=0, le=250)
    cost_bps: float = Field(default=12.0, ge=0, le=200)
    slippage_bps: float = Field(default=5.0, ge=0, le=200)


class AlertUpsertRequest(BaseModel):
    id: str | None = Field(default=None, max_length=80)
    symbol: str = Field(max_length=32)
    market: str = Field(default="a", pattern="^(a|index|futures)$")
    kind: str
    threshold: float
    note: str | None = Field(default=None, max_length=200)
    enabled: bool = True


ALERT_KINDS = {
    "price_above": "价格高于",
    "price_below": "价格低于",
    "pct_change_above": "涨幅超过(%)",
    "pct_change_below": "跌幅超过(%)",
    "concentration_above": "单票持仓占比超过(%)",
    "drawdown_below": "组合回撤超过(%)",
}


AGENT_API_KEY = os.getenv("OPENAI_API_KEY", "")
DEEPSEEK_API_KEY = os.getenv("DEEPSEEK_API_KEY", "")
QWEN_API_KEY = os.getenv("DASHSCOPE_API_KEY", "")
MARKET_API_KEY = os.getenv("ALPHAVANTAGE_API_KEY", "")
TUSHARE_TOKEN = os.getenv("TUSHARE_TOKEN", "")
AGENT_TOOLS = [
    {"type":"function","name":"get_workspace_overview","description":"Summarize local workspace: imported prices, holdings, experiments, and which quant skills apply.","parameters":{"type":"object","properties":{},"additionalProperties":False}},
    {"type":"function","name":"get_holding_list","description":"List imported holdings with quantity, cost and market value.","parameters":{"type":"object","properties":{},"additionalProperties":False}},
    {"type":"function","name":"get_market_snapshot","description":"Read imported market prices and compute current breadth from real local data.","parameters":{"type":"object","properties":{},"additionalProperties":False}},
    {"type":"function","name":"get_symbol_stats","description":"Return last price, change, high/low and sample length for one imported symbol.","parameters":{"type":"object","properties":{"symbol":{"type":"string"}},"required":["symbol"],"additionalProperties":False}},
    {"type":"function","name":"scan_alpha_signals","description":"Rank imported securities using real 20-day momentum divided by realized volatility.","parameters":{"type":"object","properties":{"top_n":{"type":"integer","minimum":3,"maximum":50}},"required":["top_n"],"additionalProperties":False}},
    {"type":"function","name":"factor_snapshot","description":"Latest momentum, volatility and moving-average gap for imported symbols.","parameters":{"type":"object","properties":{"top_n":{"type":"integer","minimum":3,"maximum":30}},"required":[],"additionalProperties":False}},
    {"type":"function","name":"correlation_matrix","description":"Pairwise return correlation of imported symbols with enough history.","parameters":{"type":"object","properties":{"lookback":{"type":"integer","minimum":20,"maximum":252}},"required":[],"additionalProperties":False}},
    {"type":"function","name":"run_strategy_backtest","description":"Run a point-in-time momentum backtest on imported prices with signal lag and costs.","parameters":{"type":"object","properties":{"years":{"type":"integer","minimum":1,"maximum":10}},"required":["years"],"additionalProperties":False}},
    {"type":"function","name":"optimize_current_portfolio","description":"Optimize imported holdings using available price history. Never places broker orders.","parameters":{"type":"object","properties":{"objective":{"type":"string","enum":["max_sharpe","min_risk","risk_parity"]}},"required":["objective"],"additionalProperties":False}},
    {"type":"function","name":"calculate_risk_report","description":"Calculate VaR, CVaR, volatility and max drawdown from imported holdings and prices.","parameters":{"type":"object","properties":{"confidence":{"type":"number","minimum":0.9,"maximum":0.99}},"required":["confidence"],"additionalProperties":False}},
    {"type":"function","name":"run_alpha_ensemble","description":"训练异构集成预测模型(HistGradientBoosting/ExtraTrees/Ridge 逆误差加权)并输出验证 RMSE、前滚回测(命中率/年化/回撤)与下一期方向+幅度预测。基于已导入的真实价格数据。可指定 symbol 训练单标的, 缺省对历史最长的前几个标的各训一个。","parameters":{"type":"object","properties":{"symbol":{"type":"string"},"predict_ahead":{"type":"integer","minimum":1,"maximum":10}},"required":[],"additionalProperties":False}},
    {"type":"function","name":"list_experiments","description":"List locally saved backtest and optimization experiments.","parameters":{"type":"object","properties":{},"additionalProperties":False}},
    {"type":"function","name":"fetch_public_quotes","description":"Download daily closes from public Yahoo Finance. No market API key required. Use Yahoo symbols such as MSFT, 000001.SZ, 600519.SS.","parameters":{"type":"object","properties":{"symbols":{"type":"array","items":{"type":"string"},"minItems":1,"maxItems":8}},"required":["symbols"],"additionalProperties":False}},
    {"type":"function","name":"import_market_prices","description":"把某只 A 股或指数(行情中心拉到的日 K)固化进工作区分析库:写入本地 market_prices,之后 scan_alpha_signals/factor_snapshot/correlation_matrix/run_strategy_backtest 等基于导入价格的分析工具就能对它分析。market=a 用 6 位代码(如 600519、000001 平安银行);market=index 用指数代码(如 000001 上证指数,会以 .IDX 后缀存入避免与个股冲突)。adjust=qfq(前复权)默认。","parameters":{"type":"object","properties":{"symbol":{"type":"string"},"market":{"type":"string","enum":["a","index"],"default":"a"},"adjust":{"type":"string","enum":["qfq","hfq",""],"default":"qfq"},"limit":{"type":"integer","minimum":20,"maximum":320,"default":320}},"required":["symbol"],"additionalProperties":False}},
    {"type":"function","name":"apply_portfolio_proposal","description":"Write proposed weights into local holdings. Only applied when access_mode is full. Never sends broker orders.","parameters":{"type":"object","properties":{"weights":{"type":"object","additionalProperties":{"type":"number"}}},"required":["weights"],"additionalProperties":False}},
    {"type":"function","name":"get_market_indices","description":"查询 A 股主要指数实时行情(上证指数/深证成指/创业板指/沪深300/中证500/科创50/上证50/中证1000/北证50):现价、涨跌幅、涨跌额、今开/昨收/最高/最低。无需 API Key。","parameters":{"type":"object","properties":{},"additionalProperties":False}},
    {"type":"function","name":"get_market_quote","description":"查询 A 股个股或指数实时行情快照(现价、涨跌幅、涨跌额、今开/昨收/最高/最低、成交量、成交额、换手率、市盈率、市净率)。symbols 传 6 位代码列表,最多 20 个;market=a 时 000001 是平安银行,market=index 时 000001 是上证指数。","parameters":{"type":"object","properties":{"symbols":{"type":"array","items":{"type":"string"},"minItems":1,"maxItems":20},"market":{"type":"string","enum":["a","index"],"default":"a"}},"required":["symbols"],"additionalProperties":False}},
    {"type":"function","name":"get_market_kline","description":"查询 K 线历史:period 支持 daily/weekly/monthly/1/5/15/30/60/intraday(分时);adjust 支持 qfq(前复权)/hfq(后复权)/空(不复权)。返回 OHLCV 序列(ts/open/high/low/close/volume/amount/change_pct)。","parameters":{"type":"object","properties":{"symbol":{"type":"string"},"market":{"type":"string","enum":["a","index"],"default":"a"},"period":{"type":"string","enum":["daily","weekly","monthly","1","5","15","30","60","intraday"],"default":"daily"},"adjust":{"type":"string","enum":["qfq","hfq",""],"default":"qfq"},"limit":{"type":"integer","minimum":20,"maximum":320,"default":120}},"required":["symbol"],"additionalProperties":False}},
    {"type":"function","name":"get_market_rankings","description":"查询 A 股涨跌排行:sort 支持 change_pct(涨跌幅)/amount(成交额)/turnover(换手率),order 支持 desc(涨榜)/asc(跌榜)。返回代码、名称、现价、涨跌幅、涨跌额、成交额、换手率。","parameters":{"type":"object","properties":{"sort":{"type":"string","enum":["change_pct","amount","turnover"],"default":"change_pct"},"order":{"type":"string","enum":["desc","asc"],"default":"desc"},"limit":{"type":"integer","minimum":1,"maximum":100,"default":20}},"required":[],"additionalProperties":False}},
    {"type":"function","name":"get_market_news","description":"查询最新财经快讯(标题、摘要、发布时间、链接)。可用于市场解读与事件驱动分析。","parameters":{"type":"object","properties":{"limit":{"type":"integer","minimum":5,"maximum":100,"default":20}},"required":[],"additionalProperties":False}},
    {"type":"function","name":"search_market","description":"按代码或名称搜索股票/指数,返回代码、名称、市场。例如搜索'平安'匹配 平安银行、中国平安;搜索'600'匹配所有 600 开头代码。","parameters":{"type":"object","properties":{"q":{"type":"string"}},"required":["q"],"additionalProperties":False}},
    {"type":"function","name":"get_market_detail","description":"查询单只 A 股/指数的富化行情:现价、总市值、流通市值、市盈率、市净率、量比(原始值)、均价、以及今日资金流(主力/超大单/大单/中单/小单净流入)与近 5 日主力净流入序列。用于个股深度分析。","parameters":{"type":"object","properties":{"symbol":{"type":"string"},"market":{"type":"string","enum":["a","index"],"default":"a"}},"required":["symbol"],"additionalProperties":False}},
    {"type":"function","name":"get_market_fflow","description":"查询个股近 N 日资金流序列(每日主力/超大单/大单/中单/小单净流入金额)。用于判断主力资金连续净买/净卖。","parameters":{"type":"object","properties":{"symbol":{"type":"string"},"market":{"type":"string","enum":["a","index"],"default":"a"},"limit":{"type":"integer","minimum":5,"maximum":120,"default":20}},"required":["symbol"],"additionalProperties":False}},
    {"type":"function","name":"get_hsgt_flow","description":"查询沪深港通北向/南向资金日度汇总(当日成交净买额、资金流入、额度余额)。注意:2024年8月起交易所停止披露实时北向成交,故仅有日度数据。","parameters":{"type":"object","properties":{},"additionalProperties":False}},
    {"type":"function","name":"get_paper_account","description":"查询模拟交易账户:总资产、可用现金、已实现盈亏、未实现浮动盈亏、总市值、当日参考盈亏。用于模拟盘资产概览。","parameters":{"type":"object","properties":{},"additionalProperties":False}},
    {"type":"function","name":"get_paper_risk_limits","description":"查询模拟盘预交易风控限额：单笔金额、单标的敞口、总敞口、期货保证金占用和挂单数。","parameters":{"type":"object","properties":{},"additionalProperties":False}},
    {"type":"function","name":"update_paper_risk_limits","description":"更新本地模拟盘预交易风控限额。仅 full 模式可执行；百分比字段取 0-1，max_pending_orders 取 1-200。","parameters":{"type":"object","properties":{"max_order_notional_pct":{"type":"number","exclusiveMinimum":0,"maximum":1},"max_single_position_pct":{"type":"number","exclusiveMinimum":0,"maximum":1},"max_gross_exposure_pct":{"type":"number","exclusiveMinimum":0,"maximum":1},"max_futures_margin_pct":{"type":"number","exclusiveMinimum":0,"maximum":1},"max_pending_orders":{"type":"integer","minimum":1,"maximum":200}},"additionalProperties":False}},
    {"type":"function","name":"list_paper_positions","description":"查询模拟交易当前持仓(股票+期货),含数量、成本价、最新价、市值、浮动盈亏、当日盈亏。","parameters":{"type":"object","properties":{},"additionalProperties":False}},
    {"type":"function","name":"place_paper_order","description":"模拟交易下单。market 支持 a(股票)/futures(期货);side:股票 buy/sell,期货 open_long(开多)/open_short(开空)/close_long(平多)/close_short(平空);order_type 支持 market(市价立即成交)/limit(限价,未触发则挂起可撤);股票需 quantity 手数(100整数倍),期货手数整数。限价单未成交会返回 status=pending 与 order_id,可用 cancel_paper_order 撤单。","parameters":{"type":"object","properties":{"market":{"type":"string","enum":["a","futures"],"default":"a"},"symbol":{"type":"string"},"side":{"type":"string","enum":["buy","sell","open_long","open_short","close_long","close_short"]},"order_type":{"type":"string","enum":["market","limit"],"default":"market"},"price":{"type":"number"},"quantity":{"type":"number"}},"required":["symbol","side","quantity"],"additionalProperties":False}},
    {"type":"function","name":"cancel_paper_order","description":"撤消模拟交易中挂起的限价委托。需传入下单返回的 order_id。","parameters":{"type":"object","properties":{"order_id":{"type":"integer"}},"required":["order_id"],"additionalProperties":False}},
    {"type":"function","name":"list_paper_orders","description":"查询模拟交易今日委托/历史委托:含状态(pending/filled/cancelled)、买卖方向、价格、数量、时间。","parameters":{"type":"object","properties":{"status":{"type":"string","enum":["pending","filled","cancelled"],"default":""}},"required":[],"additionalProperties":False}},
    {"type":"function","name":"list_paper_trades","description":"查询模拟交易今日成交明细:每笔成交的价格、数量、手续费、时间。","parameters":{"type":"object","properties":{"limit":{"type":"integer","default":50}},"required":[],"additionalProperties":False}},
    {"type":"function","name":"browse_page","description":"抓取指定网页正文(自动剥离 HTML),用于查公司公告、政策原文、新闻详情、研报摘要等。只支持 http/https 链接,返回前 8000 字符正文。","parameters":{"type":"object","properties":{"url":{"type":"string"}},"required":["url"],"additionalProperties":False}},
    {"type":"function","name":"list_scheduled_tasks","description":"列出全部定时任务(id、名称、频率、是否启用、上次运行状态)。定时任务到点会自动运行 Agent。","parameters":{"type":"object","properties":{},"additionalProperties":False}},
    {"type":"function","name":"create_scheduled_task","description":"创建或更新一个定时任务,到点自动运行 Agent。频率 frequency 支持 once(一次性,需 hour/minute)/hourly(每小时,可指定 minute)/daily(每天,需 hour/minute)/weekly(每周,需 hour/minute/weekdays 0=周日..6=周六)/interval(固定间隔,需 intervalMinutes)。prompt 是到点时自动运行的任务内容。传入已有 task_id 即更新该任务(可改 prompt/频率/启用状态)。","parameters":{"type":"object","properties":{"name":{"type":"string"},"prompt":{"type":"string"},"frequency":{"type":"string","enum":["once","hourly","daily","weekly","interval"]},"hour":{"type":"integer","minimum":0,"maximum":23},"minute":{"type":"integer","minimum":0,"maximum":59},"weekdays":{"type":"array","items":{"type":"integer","minimum":0,"maximum":6}},"intervalMinutes":{"type":"integer","minimum":1,"maximum":10080},"model":{"type":"string"},"provider":{"type":"string","enum":["openai","deepseek","qwen"]},"reasoning":{"type":"string","enum":["off","low","medium","high"]},"task_id":{"type":"string","description":"更新已有任务时传入其 id;创建新任务可省略"}},"required":["name","prompt","frequency"],"additionalProperties":False}},
    {"type":"function","name":"delete_scheduled_task","description":"删除一个定时任务(按 id)。删除后不再自动运行。","parameters":{"type":"object","properties":{"task_id":{"type":"string"}},"required":["task_id"],"additionalProperties":False}},
    {"type":"function","name":"run_factor_research","description":"在已导入的真实日线数据上研究自定义因子:受限 DSL 的 factor(df) 至少可用 close；由行情中心导入的完整日线可用 open/high/low/volume/amount。因子引用的字段必须在每个标的完整存在，系统会排除缺字段标的并报告覆盖范围，绝不合成 OHLCV。输出 RankIC、ICIR、分层回测与 1-5 日衰减。至少需要 3 个标的、每个 60+ 行日线。","parameters":{"type":"object","properties":{"code":{"type":"string","description":"完整因子函数源码,如 def factor(df): return df['close'].pct_change(20)"},"horizon":{"type":"integer","minimum":1,"maximum":10},"quantiles":{"type":"integer","minimum":2,"maximum":10}},"required":["code"],"additionalProperties":False}},
    {"type":"function","name":"run_portfolio_backtest","description":"组合级事件驱动回测:对给定目标权重(weights,自动归一化)按 rebalance_days 周期再平衡,计入佣金与滑点成本,输出净值曲线、年化/夏普/回撤/胜率/换手、相对等权基准的超额及逐标的归因。基于已导入的本地价格。","parameters":{"type":"object","properties":{"weights":{"type":"object","additionalProperties":{"type":"number"},"description":"如 {\"600519\":0.4,\"000001\":0.6}"},"rebalance_days":{"type":"integer","minimum":0,"maximum":250},"cost_bps":{"type":"number","minimum":0,"maximum":200},"slippage_bps":{"type":"number","minimum":0,"maximum":200}},"required":["weights"],"additionalProperties":False}},
    {"type":"function","name":"manage_price_alerts","description":"价格与风险预警管理:list 列出全部预警;create 创建预警(kind 支持 price_above/price_below 价格、pct_change_above/pct_change_below 当日涨跌幅%、concentration_above 单票持仓占比%、drawdown_below 组合回撤%);delete 按 id 删除。预警到点由引擎每 30 秒检查并推送通知。","parameters":{"type":"object","properties":{"action":{"type":"string","enum":["list","create","delete"]},"symbol":{"type":"string"},"market":{"type":"string","enum":["a","index","futures"]},"kind":{"type":"string"},"threshold":{"type":"number"},"note":{"type":"string"},"alert_id":{"type":"string"}},"required":["action"],"additionalProperties":False}},
    {"type":"function","name":"list_recent_notifications","description":"查看最近的系统通知(预警触发、定时任务结果等),可只看未读。","parameters":{"type":"object","properties":{"limit":{"type":"integer","minimum":1,"maximum":50},"unread_only":{"type":"boolean"}},"required":[],"additionalProperties":False}},
]
QUANT_SKILLS = """
Skills (follow the matching playbook, call tools instead of guessing):
- 组合诊断: get_holding_list → get_workspace_overview → calculate_risk_report → correlation_matrix. Explain concentration, drawdown and what data is missing.
- Alpha扫描: get_market_snapshot → scan_alpha_signals → factor_snapshot. Rank only imported symbols; never invent tickers.
- 策略回测: run_strategy_backtest on imported prices. State lag, costs and sample length from the tool.
- 集成预测: run_alpha_ensemble 训练异构集成模型(HistGBDT/ExtraTrees/Ridge 逆误差加权),报告验证 RMSE、前滚回测命中率与下一期方向,并用 import_market_prices 补足数据后重训。
- 风险审查: calculate_risk_report; if unavailable say the exact import requirement.
- 再平衡提案: optimize_current_portfolio. In ask/approve mode, present as a proposal only. In full mode you may call apply_portfolio_proposal to write local holdings.
- 补数据: If prices are missing, call fetch_public_quotes (no market key) or import_market_prices (把行情中心的某只标的日 K 固化进分析库,之后可被 Alpha扫描/回测/风险工具使用) or tell the user to import CSV. Do not claim a vendor key is required for all market access.
- 网页浏览: browse_page 抓取指定 URL 正文。适合查公司公告原文、政策原文、新闻详情、研报摘要等,读取后据此作答。
- 定时任务: list_scheduled_tasks 查看现有定时任务;create_scheduled_task 创建/更新周期任务(到点自动运行 Agent);delete_scheduled_task 删除任务。适合周期性盯盘、每日复盘、定期生成报告等需求。
- 因子研究: run_factor_research 用受限因子函数在真实数据上算 RankIC/ICIR/分层回测/衰减。只有完整导入的日线才有 OHLCV/amount；绝不假设或合成缺失字段，并如实报告覆盖范围。
- 组合回测: run_portfolio_backtest 对目标权重做含成本再平衡回测,报告净值、超额与逐标的归因;权重来自用户或优化工具结果,不得凭空编造标的。
- 预警: manage_price_alerts 创建价格/涨跌幅/集中度/回撤预警(list 查看现有预警避免重复建);list_recent_notifications 查看已触发的通知。
"""
AGENT_INSTRUCTIONS = f"""You are Quant Agent, a local quantitative investment operator. Call tools when needed, then answer in concise Chinese.
{QUANT_SKILLS}
Rules: ask 和 approve 模式均为只读提案模式，不得尝试任何本地写入；只有用户明确选择 full 后，才可调用允许的本地写工具。Do not emit scripted filler. Ground every number in tool output. If a tool says data is unavailable, say exactly what to import. Never invent prices, holdings, or backtest metrics. Never expose chain-of-thought. Never place real broker orders. Respond in concise Chinese."""
CHAT_TOOLS = [{"type": "function", "function": {"name": tool["name"], "description": tool["description"], "parameters": tool["parameters"]}} for tool in AGENT_TOOLS]


def _workspace_status() -> dict[str, Any]:
    _restore_provider_keys()
    with connect() as db:
        market = db.execute("SELECT COUNT(*) rows, COUNT(DISTINCT symbol) symbols, MAX(trade_date) latest FROM market_prices").fetchone()
        holdings = db.execute("SELECT COUNT(*) count, COALESCE(SUM(market_value),0) value FROM holdings").fetchone()
        experiments = db.execute("SELECT COUNT(*) count FROM experiments").fetchone()
        models = db.execute("SELECT COUNT(*) count FROM model_registry").fetchone()
        audits = db.execute("SELECT COUNT(*) count FROM audit_log").fetchone()
    return {"market_rows": market["rows"], "market_symbols": market["symbols"], "market_latest": market["latest"], "holding_count": holdings["count"], "portfolio_value": holdings["value"] or None, "experiment_count": experiments["count"], "model_count": models["count"], "audit_count": audits["count"], "agent_configured": bool(AGENT_API_KEY), "deepseek_configured": bool(DEEPSEEK_API_KEY), "qwen_configured": bool(QWEN_API_KEY), "market_provider_configured": bool(MARKET_API_KEY), "market_provider": "Alpha Vantage" if MARKET_API_KEY else None, "tushare_configured": bool(TUSHARE_TOKEN)}


async def _sync_alpha_vantage(request: MarketSyncRequest) -> dict[str, Any]:
    if not MARKET_API_KEY:
        raise HTTPException(409, "尚未配置 Alpha Vantage API Key")
    if request.asset_type == "stock":
        symbol = (request.symbol or "").strip().upper()
        if not symbol:
            raise HTTPException(422, "股票代码不能为空")
        params = {"function": "TIME_SERIES_DAILY", "symbol": symbol, "outputsize": "compact", "apikey": MARKET_API_KEY}
        series_key = "Time Series (Daily)"
        stored_symbol = symbol
    else:
        from_symbol = (request.from_symbol or "").strip().upper()
        to_symbol = (request.to_symbol or "").strip().upper()
        if len(from_symbol) != 3 or len(to_symbol) != 3:
            raise HTTPException(422, "外汇代码必须是三个字母，例如 EUR/USD")
        params = {"function": "FX_DAILY", "from_symbol": from_symbol, "to_symbol": to_symbol, "outputsize": "compact", "apikey": MARKET_API_KEY}
        series_key = "Time Series FX (Daily)"
        stored_symbol = f"{from_symbol}/{to_symbol}"
    try:
        async with httpx.AsyncClient(timeout=30) as client:
            response = await client.get("https://www.alphavantage.co/query", params=params)
            response.raise_for_status()
            payload = response.json()
    except (httpx.HTTPError, ValueError) as exc:
        raise HTTPException(502, "行情服务连接失败，请检查网络后重试") from exc
    provider_error = payload.get("Error Message") or payload.get("Information") or payload.get("Note")
    if provider_error:
        raise HTTPException(429 if payload.get("Note") or payload.get("Information") else 422, str(provider_error))
    series = payload.get(series_key)
    if not isinstance(series, dict) or not series:
        raise HTTPException(502, "行情服务未返回可识别的日线数据")
    rows = []
    for trade_date, values in series.items():
        try:
            close = float(values["4. close"])
        except (KeyError, TypeError, ValueError):
            continue
        if close > 0:
            rows.append((stored_symbol, trade_date, close, "alpha_vantage"))
    if not rows:
        raise HTTPException(502, "行情响应中没有有效收盘价")
    with connect() as db:
        db.executemany("INSERT OR REPLACE INTO market_prices(symbol,trade_date,close,source) VALUES(?,?,?,?)", rows)
    audit("market_data_synced", {"provider": "alpha_vantage", "asset_type": request.asset_type, "symbol": stored_symbol, "rows": len(rows)})
    return {"status": _workspace_status(), "imported_rows": len(rows), "symbol": stored_symbol, "source": "Alpha Vantage"}


async def _sync_tushare(request: TushareSyncRequest) -> dict[str, Any]:
    if not TUSHARE_TOKEN:
        raise HTTPException(409, "尚未配置 Tushare Pro Token")
    symbol = request.symbol.strip().upper()
    api_name = "daily" if request.asset_type == "stock" else "fut_daily"
    body = {"api_name": api_name, "token": TUSHARE_TOKEN, "params": {"ts_code": symbol}, "fields": "ts_code,trade_date,close"}
    try:
        async with httpx.AsyncClient(timeout=35) as client:
            response = await client.post("https://api.tushare.pro", json=body)
            response.raise_for_status()
            payload = response.json()
    except (httpx.HTTPError, ValueError) as exc:
        raise HTTPException(502, "Tushare 行情服务连接失败，请检查网络后重试") from exc
    if payload.get("code") != 0:
        raise HTTPException(422, payload.get("msg") or "Tushare 返回未知错误")
    data = payload.get("data") or {}
    fields = data.get("fields") or []
    items = data.get("items") or []
    try:
        symbol_index, date_index, close_index = fields.index("ts_code"), fields.index("trade_date"), fields.index("close")
    except ValueError as exc:
        raise HTTPException(502, "Tushare 响应缺少必要行情字段") from exc
    rows = []
    for item in items:
        try:
            close = float(item[close_index])
            trade_date = str(item[date_index])
            normalized_date = f"{trade_date[:4]}-{trade_date[4:6]}-{trade_date[6:8]}" if len(trade_date) == 8 else trade_date
            row_symbol = str(item[symbol_index]).upper()
        except (IndexError, TypeError, ValueError):
            continue
        if row_symbol and close > 0:
            rows.append((row_symbol, normalized_date, close, "tushare"))
    if not rows:
        raise HTTPException(404, "没有查到该代码的行情，请检查 TS 代码和数据权限")
    with connect() as db:
        db.executemany("INSERT OR REPLACE INTO market_prices(symbol,trade_date,close,source) VALUES(?,?,?,?)", rows)
    audit("market_data_synced", {"provider": "tushare", "asset_type": request.asset_type, "symbol": symbol, "rows": len(rows)})
    return {"status": _workspace_status(), "imported_rows": len(rows), "symbol": symbol, "source": "Tushare Pro"}


def _yahoo_symbol(raw: str) -> str:
    symbol = raw.strip().upper().replace(" ", "")
    if not symbol:
        return symbol
    if "." in symbol or "/" in symbol:
        return symbol
    if symbol.isdigit() and len(symbol) == 6:
        return f"{symbol}.SS" if symbol.startswith("6") else f"{symbol}.SZ"
    return symbol


def _fetch_yahoo_rows(symbol: str) -> list[tuple[str, str, float]]:
    yahoo = _yahoo_symbol(symbol)
    with httpx.Client(timeout=25, headers={"User-Agent": "Mozilla/5.0 QuantDesk/0.3"}) as client:
        response = client.get(
            f"https://query1.finance.yahoo.com/v8/finance/chart/{yahoo}",
            params={"interval": "1d", "range": "2y"},
        )
        response.raise_for_status()
        payload = response.json()
    result = ((payload.get("chart") or {}).get("result") or [None])[0]
    if not result:
        error = ((payload.get("chart") or {}).get("error") or {}).get("description") or "公开行情未返回数据"
        raise ValueError(error)
    stamps = result.get("timestamp") or []
    closes = (((result.get("indicators") or {}).get("quote") or [{}])[0].get("close") or [])
    resolved = ((result.get("meta") or {}).get("symbol") or yahoo).upper()
    rows: list[tuple[str, str, float]] = []
    for stamp, close in zip(stamps, closes):
        if close is None:
            continue
        try:
            value = float(close)
        except (TypeError, ValueError):
            continue
        if value <= 0:
            continue
        day = datetime.fromtimestamp(int(stamp), tz=timezone.utc).date().isoformat()
        rows.append((resolved, day, value))
    if not rows:
        raise ValueError(f"{yahoo} 没有有效收盘价")
    return rows


def _sync_public_quotes(symbols: list[str]) -> dict[str, Any]:
    stored: list[tuple[str, str, float, str]] = []
    errors: list[str] = []
    for raw in symbols:
        try:
            for symbol, day, close in _fetch_yahoo_rows(raw):
                stored.append((symbol, day, close, "public"))
        except Exception as exc:
            errors.append(f"{raw}: {exc}")
    if not stored:
        raise HTTPException(404, "；".join(errors) or "公开行情没有返回任何价格")
    with connect() as db:
        db.executemany("INSERT OR REPLACE INTO market_prices(symbol,trade_date,close,source) VALUES(?,?,?,?)", stored)
    unique = sorted({row[0] for row in stored})
    audit("market_data_synced", {"provider": "public", "symbols": unique, "rows": len(stored)})
    return {"status": _workspace_status(), "imported_rows": len(stored), "symbols": unique, "source": "公开行情", "errors": errors}


def _price_series() -> dict[str, list[tuple[str, float]]]:
    with connect() as db:
        rows = db.execute("SELECT symbol, trade_date, close FROM market_prices ORDER BY symbol, trade_date").fetchall()
    series: dict[str, list[tuple[str, float]]] = {}
    for row in rows:
        series.setdefault(row["symbol"], []).append((row["trade_date"], float(row["close"])))
    return series


def _market_data_manifest(symbols: list[str] | None = None) -> dict[str, Any]:
    """为研究实验记录数据集血缘和内容指纹，不把原始行情重复写进实验表。"""
    selected = sorted({str(symbol).strip().upper() for symbol in symbols or [] if str(symbol).strip()})
    clause = ""
    params: list[Any] = []
    if selected:
        clause = f" WHERE symbol IN ({','.join('?' for _ in selected)})"
        params = selected
    with connect() as db:
        prices = [tuple(row) for row in db.execute(f"SELECT symbol,trade_date,close,source FROM market_prices{clause} ORDER BY symbol,trade_date", params).fetchall()]
        bars = [tuple(row) for row in db.execute(f"SELECT symbol,trade_date,market,adjust,source,open,high,low,close,volume,amount FROM analysis_bars{clause} ORDER BY symbol,trade_date", params).fetchall()]

    def digest(rows: list[tuple[Any, ...]]) -> str:
        payload = "\n".join(json.dumps(row, ensure_ascii=False, separators=(",", ":")) for row in rows)
        return hashlib.sha256(payload.encode("utf-8")).hexdigest()

    def summary(rows: list[tuple[Any, ...]], *, is_bar: bool) -> list[dict[str, Any]]:
        grouped: dict[str, dict[str, Any]] = {}
        for row in rows:
            symbol, trade_date = str(row[0]), str(row[1])
            item = grouped.setdefault(symbol, {"symbol": symbol, "rows": 0, "start": trade_date, "end": trade_date, "sources": set(), "adjustments": set()})
            item["rows"] += 1
            item["start"] = min(item["start"], trade_date)
            item["end"] = max(item["end"], trade_date)
            item["sources"].add(str(row[4] if is_bar else row[3]))
            if is_bar:
                item["adjustments"].add(str(row[3]))
        return [{**item, "sources": sorted(item["sources"]), "adjustments": sorted(item["adjustments"])} for _, item in sorted(grouped.items())]

    manifest = {
        "algorithm": "sha256",
        "selected_symbols": selected or None,
        "market_prices": {"rows": len(prices), "digest": digest(prices), "symbols": summary(prices, is_bar=False)},
        "analysis_bars": {"rows": len(bars), "digest": digest(bars), "symbols": summary(bars, is_bar=True)},
    }
    manifest["fingerprint"] = hashlib.sha256(json.dumps(manifest, ensure_ascii=False, sort_keys=True, separators=(",", ":")).encode("utf-8")).hexdigest()
    return manifest


def _save_reproducible_experiment(kind: str, name: str, config: dict[str, Any], result: dict[str, Any], symbols: list[str] | None = None) -> int:
    stored_config = {**config, "data_manifest": _market_data_manifest(symbols)}
    return save_experiment(kind, name, stored_config, result)


def _factor_inputs() -> dict[str, pd.Series | pd.DataFrame]:
    """因子研究优先读取可追溯的真实 OHLCV；其余来源只保留真实 close。"""
    inputs: dict[str, pd.Series | pd.DataFrame] = {
        symbol: pd.Series({trade_date: price for trade_date, price in points}).sort_index()
        for symbol, points in _price_series().items()
    }
    grouped: dict[str, list[dict[str, Any]]] = {}
    for row in read_analysis_bars():
        grouped.setdefault(str(row["symbol"]), []).append(row)
    fields = ["open", "high", "low", "close", "volume", "amount"]
    for symbol, rows in grouped.items():
        frame = pd.DataFrame(rows).set_index("trade_date").sort_index()
        inputs[symbol] = frame[[field for field in fields if field in frame.columns]]
    return inputs


def _portfolio_returns() -> list[float]:
    with connect() as db:
        holdings = db.execute("SELECT symbol, COALESCE(market_value,0) value FROM holdings").fetchall()
    series = _price_series()
    usable = [(row["symbol"], float(row["value"])) for row in holdings if row["symbol"] in series and len(series[row["symbol"]]) >= 20]
    if not usable:
        return []
    min_len = min(len(series[symbol]) for symbol, _ in usable)
    values = np.array([value for _, value in usable], dtype=float)
    weights = values / values.sum() if values.sum() > 0 else np.full(len(usable), 1 / len(usable))
    matrix = np.column_stack([np.diff(np.log([p for _, p in series[symbol][-min_len:]])) for symbol, _ in usable])
    return (matrix @ weights).tolist()


def _ensemble_analysis(symbol: str | None = None, predict_ahead: int = 1, top_n: int = 3) -> dict[str, Any]:
    """在已导入的真实价格数据上训练 AlphaEnsemble,输出验证 RMSE、前滚回测与下一期预测。
    symbol 指定则只训该标的; 缺省对历史最长的前 top_n 个标的各训一个。"""
    series = _price_series()
    if symbol:
        symbol = symbol.strip().upper()
        if symbol not in series:
            return {"available": False, "reason": f"工作区没有 {symbol} 的价格数据，请先导入(行情中心→加入分析库 / CSV / fetch_public_quotes)"}
        candidates = [symbol]
    else:
        candidates = sorted((s for s, p in series.items() if len(p) >= 80), key=lambda s: len(series[s]), reverse=True)[:top_n]
        if not candidates:
            return {"available": False, "reason": "至少需要一个标的的 80 个交易日价格"}
    models: dict[str, Any] = {}
    for sym in candidates:
        prices = series[sym]
        df = pd.DataFrame(prices, columns=["date", "close"]).set_index("date")
        df.index = pd.to_datetime(df.index)
        df = df[~df.index.duplicated(keep="last")].sort_index()
        try:
            models[sym] = run_alpha_ensemble(df, predict_ahead=predict_ahead)
            models[sym]["available"] = True
        except ValueError as exc:
            models[sym] = {"available": False, "reason": str(exc)}
    return {"available": True, "method": "AlphaEnsemble(HistGBDT/ExtraTrees/Ridge 逆误差加权)", "predict_ahead": predict_ahead, "symbols": candidates, "models": models}


# ---------- 网页正文提取 (browse_page) ----------
_SKIP_TAGS = {"script", "style", "noscript", "svg", "template", "iframe", "textarea"}
_BLOCK_TAGS = {"p", "div", "br", "li", "h1", "h2", "h3", "h4", "h5", "h6", "tr", "section", "article", "table", "blockquote", "pre", "ul", "ol", "dl"}


class _TextExtractor(HTMLParser):
    def __init__(self) -> None:
        super().__init__()
        self.parts: list[str] = []
        self._skip = 0

    def handle_starttag(self, tag: str, attrs: list[tuple[str, str | None]]) -> None:
        if tag in _SKIP_TAGS:
            self._skip += 1
        elif tag in _BLOCK_TAGS:
            self.parts.append("\n")

    def handle_endtag(self, tag: str) -> None:
        if tag in _SKIP_TAGS and self._skip > 0:
            self._skip -= 1
        elif tag in _BLOCK_TAGS:
            self.parts.append("\n")

    def handle_data(self, data: str) -> None:
        if self._skip:
            return
        text = data.strip()
        if text:
            self.parts.append(text)


def _html_to_text(html: str, max_chars: int = 8000) -> str:
    parser = _TextExtractor()
    try:
        parser.feed(html or "")
        parser.close()
    except Exception:
        pass
    text = " ".join(parser.parts)
    text = re.sub(r"[ \t]+", " ", text)
    text = re.sub(r"\n[ \t]+", "\n", text)
    text = re.sub(r"\n{3,}", "\n\n", text)
    return text.strip()[:max_chars]


def _html_title(html: str) -> str:
    match = re.search(r"<title[^>]*>(.*?)</title>", html or "", re.IGNORECASE | re.DOTALL)
    if not match:
        return ""
    return re.sub(r"\s+", " ", match.group(1)).strip()[:120]


def _browse_page(url: str) -> dict[str, Any]:
    """抓取经过公网 HTTPS 校验的页面，并逐跳校验重定向目标。"""
    try:
        current = validate_public_https_url(url)
        with httpx.Client(timeout=15, follow_redirects=False, headers={"User-Agent": "Mozilla/5.0 QuantDesk/0.3"}) as client:
            for _ in range(4):
                response = client.get(current)
                if response.is_redirect:
                    location = response.headers.get("location")
                    if not location:
                        return {"ok": False, "url": current, "error": "重定向缺少目标地址"}
                    current = validate_public_https_url(urljoin(current, location))
                    continue
                response.raise_for_status()
                html = response.text
                break
            else:
                return {"ok": False, "url": current, "error": "重定向次数超过限制"}
        text = _html_to_text(html)
        if not text:
            return {"ok": True, "url": current, "title": _html_title(html), "text": "(页面没有可提取的文本内容)"}
        return {"ok": True, "url": current, "title": _html_title(html), "text": text}
    except UnsafeUrlError as exc:
        return {"ok": False, "error": str(exc)}
    except httpx.HTTPError as exc:
        return {"ok": False, "url": url, "error": f"请求失败: {type(exc).__name__}: {exc}"}
    except Exception as exc:  # noqa: BLE001
        return {"ok": False, "url": url, "error": f"{type(exc).__name__}: {exc}"}


# ---------- 预警规则引擎与通知中心 ----------

WEBHOOK_TIMEOUT = 5


def _notify(source: str, title: str, body: str = "") -> None:
    """写本地通知表, 若配置了 webhook_url 则同步转发(尽力而为)。"""
    try:
        add_notification(source, title, body)
    except Exception:  # noqa: BLE001
        return
    webhook = get_setting("webhook_url").strip()
    if webhook:
        try:
            safe_webhook = validate_public_https_url(webhook)
            httpx.post(safe_webhook, json={"source": source, "title": title, "body": body, "at": int(time.time() * 1000)}, timeout=WEBHOOK_TIMEOUT, follow_redirects=False)
        except Exception:  # noqa: BLE001
            pass


def _alert_current_value(alert: dict[str, Any]) -> tuple[bool, float | None]:
    """计算某条预警的当前观测值。返回 (是否可评估, 当前值)。"""
    kind = alert["kind"]
    symbol = str(alert.get("symbol") or "").strip().upper()
    market = alert.get("market") or "a"
    if kind in ("concentration_above",):
        with connect() as db:
            rows = db.execute("SELECT symbol, COALESCE(market_value,0) value FROM holdings WHERE market_value > 0").fetchall()
        total = sum(float(r["value"]) for r in rows)
        if total <= 0 or not symbol:
            return False, None
        share = next((float(r["value"]) / total for r in rows if r["symbol"] == symbol), 0.0)
        return True, share * 100.0
    if kind == "drawdown_below":
        returns = _portfolio_returns()
        if len(returns) < 20:
            return False, None
        nav = np.cumprod(1 + np.array(returns))
        dd = float((nav / np.maximum.accumulate(nav) - 1).min()) * 100.0
        return True, dd
    if not symbol:
        return False, None
    try:
        result = market_quotes(symbol, market=market)
        quotes = result.get("quotes") or []
        if not quotes:
            return False, None
        q = quotes[0]
        price, pct = q.get("price"), q.get("change_pct")
    except Exception:  # noqa: BLE001
        return False, None
    if kind in ("price_above", "price_below"):
        return (price is not None, price)
    if kind in ("pct_change_above", "pct_change_below"):
        return (pct is not None, pct)
    return False, None


def _alert_triggered(kind: str, threshold: float, value: float) -> bool:
    if kind == "price_above":
        return value > threshold
    if kind == "price_below":
        return value < threshold
    if kind == "pct_change_above":
        return value >= threshold
    if kind == "pct_change_below":
        return value <= -abs(threshold)
    if kind == "concentration_above":
        return value > threshold
    if kind == "drawdown_below":
        # 回撤是负值; 用户填正数阈值表示可容忍回撤幅度
        return value <= -abs(threshold)
    return False


def _check_alerts() -> None:
    """调度循环调用: 检查启用的预警, 触发则发通知并记录时间(同一小时最多触发一次)。"""
    hour_ms = 3600_000
    now = int(time.time() * 1000)
    for alert in list_alerts():
        if not alert.get("enabled"):
            continue
        last = alert.get("lastTriggeredAt")
        if last is not None and now - int(last) < hour_ms:
            continue
        try:
            ok, value = _alert_current_value(alert)
            if not ok or value is None:
                continue
            if _alert_triggered(alert["kind"], float(alert["threshold"]), float(value)):
                label = ALERT_KINDS.get(alert["kind"], alert["kind"])
                title = f"预警触发：{alert['symbol']} {label} {alert['threshold']}"
                body = f"当前值 {round(float(value), 3)} · {alert.get('note') or 'QuantDesk 预警'}"
                _notify("alert", title, body)
                mark_alert_triggered(alert["id"], now)
        except Exception:  # noqa: BLE001
            continue


_MUTATING_TOOL_LABELS = {
    "apply_portfolio_proposal": "写入组合提案",
    "place_paper_order": "模拟下单",
    "cancel_paper_order": "撤单",
    "update_paper_risk_limits": "更新模拟盘风控限额",
    "create_scheduled_task": "创建定时任务",
    "delete_scheduled_task": "删除定时任务",
    "manage_price_alerts": "预警管理",
}


def _is_mutating_tool(name: str, arguments: dict[str, Any]) -> bool:
    if name == "manage_price_alerts":
        return str(arguments.get("action") or "list") in {"create", "delete"}
    return name in _MUTATING_TOOL_LABELS


def _tool_result(name: str, arguments: dict[str, Any], access_mode: str = "ask") -> tuple[str, str, str]:
    # ask/approve 都只生成可审阅的提案；当前 UI 尚未实现可验证、可撤销的逐项批准
    # 状态机，因此不能把“模型认为已同意”当成一次写授权。用户须主动切到 full。
    if _is_mutating_tool(name, arguments) and access_mode != "full":
        label = _MUTATING_TOOL_LABELS.get(name, "写操作")
        return label, "已阻止未授权写操作", json.dumps({
            "available": True,
            "applied": False,
            "approval_required": True,
            "reason": "当前模式仅允许研究和提案。请由用户审阅后切换到“完全访问”并重新发起该操作。",
        }, ensure_ascii=False)
    series = _price_series()
    if name == "get_workspace_overview":
        status = _workspace_status()
        result = {**status, "skills": ["组合诊断", "Alpha扫描", "策略回测", "风险审查", "再平衡提案", "补数据"], "market_key_required": False}
        return "读取工作区", f"价格 {status['market_rows']} 行 · 持仓 {status['holding_count']} 个", json.dumps(result, ensure_ascii=False)
    if name == "get_holding_list":
        with connect() as db:
            holdings = [dict(row) for row in db.execute("SELECT symbol,name,quantity,avg_cost,market_value FROM holdings ORDER BY symbol").fetchall()]
        if not holdings:
            return "读取持仓", "尚未导入持仓", json.dumps({"available": False, "reason": "尚未导入持仓 CSV"}, ensure_ascii=False)
        return "读取持仓", f"已读取 {len(holdings)} 个持仓", json.dumps({"available": True, "holdings": holdings}, ensure_ascii=False)
    if name == "get_symbol_stats":
        symbol = str(arguments.get("symbol") or "").strip().upper()
        prices = series.get(symbol) or series.get(_yahoo_symbol(symbol), [])
        if len(prices) < 2:
            return "读取标的", f"{symbol} 缺少本地价格", json.dumps({"available": False, "reason": f"{symbol} 需要至少两个交易日价格，可用 fetch_public_quotes 或导入 CSV"}, ensure_ascii=False)
        close = [p for _, p in prices]
        change = close[-1] / close[-2] - 1
        window = close[-20:] if len(close) >= 20 else close
        result = {"available": True, "symbol": symbol, "last": close[-1], "change": change, "high": max(window), "low": min(window), "days": len(close), "start": prices[0][0], "end": prices[-1][0]}
        return "读取标的", f"{symbol} 最近收盘 {close[-1]:.4f}", json.dumps(result, ensure_ascii=False)
    if name == "factor_snapshot":
        rows = []
        for symbol, prices in series.items():
            if len(prices) < 21:
                continue
            close = np.array([p for _, p in prices], dtype=float)
            ret = np.diff(np.log(close[-21:]))
            rows.append({"symbol": symbol, "mom_20": float(close[-1] / close[-21] - 1), "vol_20": float(ret.std(ddof=1) * np.sqrt(252)), "ma_gap_20": float(close[-1] / close[-20:].mean() - 1)})
        if not rows:
            return "因子快照", "历史不足", json.dumps({"available": False, "reason": "每个标的至少需要 21 个交易日"}, ensure_ascii=False)
        top_n = int(arguments.get("top_n") or 12)
        ranked = sorted(rows, key=lambda item: item["mom_20"], reverse=True)[:top_n]
        return "因子快照", f"已计算 {len(rows)} 个标的", json.dumps({"available": True, "factors": ranked})
    if name == "correlation_matrix":
        lookback = int(arguments.get("lookback") or 60)
        usable = [(symbol, prices) for symbol, prices in series.items() if len(prices) >= lookback]
        if len(usable) < 2:
            return "相关矩阵", "标的不足", json.dumps({"available": False, "reason": "至少两个标的且各有足够历史"}, ensure_ascii=False)
        names = [symbol for symbol, _ in usable]
        matrix = np.column_stack([np.diff(np.log([p for _, p in prices[-lookback:]])) for _, prices in usable])
        corr = np.corrcoef(matrix, rowvar=False)
        pairs = []
        for i in range(len(names)):
            for j in range(i + 1, len(names)):
                pairs.append({"a": names[i], "b": names[j], "corr": float(corr[i, j])})
        pairs.sort(key=lambda item: abs(item["corr"]), reverse=True)
        return "相关矩阵", f"{len(names)} 个标的", json.dumps({"available": True, "symbols": names, "top_pairs": pairs[:12]})
    if name == "list_experiments":
        with connect() as db:
            rows = db.execute("SELECT id,kind,name,status,created_at FROM experiments ORDER BY id DESC LIMIT 20").fetchall()
        items = [dict(row) for row in rows]
        return "读取实验", f"{len(items)} 条本地实验", json.dumps({"available": True, "experiments": items}, ensure_ascii=False)
    if name == "fetch_public_quotes":
        symbols = [str(item).strip() for item in (arguments.get("symbols") or []) if str(item).strip()]
        if not symbols:
            return "同步公开行情", "未提供代码", json.dumps({"available": False, "reason": "symbols 不能为空"}, ensure_ascii=False)
        try:
            result = _sync_public_quotes(symbols[:8])
            result["available"] = True
            return "同步公开行情", f"已写入 {result['imported_rows']} 行，无需行情 API Key", json.dumps(result, ensure_ascii=False)
        except HTTPException as exc:
            return "同步公开行情", "公开行情失败", json.dumps({"available": False, "reason": exc.detail}, ensure_ascii=False)
    if name == "import_market_prices":
        try:
            symbol = str(arguments.get("symbol") or "").strip()
            market = str(arguments.get("market") or "a")
            adjust = str(arguments.get("adjust") or "qfq")
            limit = int(arguments.get("limit") or 320)
            if not symbol:
                return "导入行情", "未提供代码", json.dumps({"ok": False, "error": "symbol 不能为空"}, ensure_ascii=False)
            result = import_daily_prices(symbol=symbol, market=market, adjust=adjust, limit=limit)
            if not result.get("ok"):
                return "导入行情", "未取到日K", json.dumps(result, ensure_ascii=False)
            return "导入行情", f"{result['symbol']} 已入分析库 {result['rows']} 行", json.dumps(result, ensure_ascii=False)
        except Exception as exc:
            return "导入行情", "导入失败", json.dumps({"ok": False, "error": f"{type(exc).__name__}: {exc}"}, ensure_ascii=False)
    if name == "apply_portfolio_proposal":
        weights = arguments.get("weights") or {}
        cleaned = {str(symbol).upper(): float(weight) for symbol, weight in weights.items() if float(weight) > 0}
        total = sum(cleaned.values())
        if total <= 0:
            return "写入组合提案", "权重无效", json.dumps({"available": False, "reason": "权重必须为正"}, ensure_ascii=False)
        normalized = {symbol: weight / total for symbol, weight in cleaned.items()}
        if access_mode != "full":
            return "写入组合提案", "当前权限不会写入持仓", json.dumps({"available": True, "applied": False, "approval_required": True, "weights": normalized, "reason": "只读提案模式不会写入持仓；请由用户审阅后切换完全访问并重新发起操作"}, ensure_ascii=False)
        with connect() as db:
            current = db.execute("SELECT COALESCE(SUM(market_value),0) value FROM holdings").fetchone()
            portfolio_value = float(current["value"] or 0) or 1_000_000
            db.execute("DELETE FROM holdings")
            db.executemany(
                "INSERT INTO holdings(symbol,quantity,market_value) VALUES(?,?,?)",
                [(symbol, weight * portfolio_value, weight * portfolio_value) for symbol, weight in normalized.items()],
            )
        audit("portfolio_proposal_applied", {"symbols": list(normalized), "access_mode": access_mode})
        return "写入组合提案", "已写入本地持仓（未下单）", json.dumps({"available": True, "applied": True, "orders_placed": False, "weights": normalized})
    if name == "get_market_snapshot":
        changes = [prices[-1][1] / prices[-2][1] - 1 for prices in series.values() if len(prices) >= 2]
        if not changes:
            result = {"available": False, "reason": "尚未导入至少两个交易日的市场价格"}
            return "读取市场数据", "没有足够的真实行情数据", json.dumps(result, ensure_ascii=False)
        result = {"available": True, "symbols": len(changes), "advance_ratio": float(np.mean(np.array(changes) > 0)), "mean_return": float(np.mean(changes))}
        return "读取市场数据", f"已读取 {len(changes)} 个标的的最新真实行情", json.dumps(result)
    if name == "scan_alpha_signals":
        ranked = []
        for symbol, prices in series.items():
            if len(prices) < 21:
                continue
            close = np.array([p for _, p in prices], dtype=float)
            returns = np.diff(np.log(close[-21:]))
            score = (close[-1] / close[-21] - 1) / max(returns.std(ddof=1) * np.sqrt(20), 1e-9)
            ranked.append({"symbol": symbol, "score": float(score), "momentum_20d": float(close[-1] / close[-21] - 1)})
        if not ranked:
            result = {"available": False, "reason": "每个标的至少需要 21 个交易日价格"}
            return "扫描 Alpha 信号", "真实行情历史不足，无法计算", json.dumps(result, ensure_ascii=False)
        top = sorted(ranked, key=lambda x: x["score"], reverse=True)[: arguments.get("top_n", 10)]
        return "扫描 Alpha 信号", f"已基于真实数据评估 {len(ranked)} 个标的", json.dumps({"available": True, "method": "20d_momentum_over_volatility", "candidates": top})
    if name == "run_strategy_backtest":
        requested_years = int(arguments.get("years") or 1)
        eligible: list[tuple[str, list[tuple[str, float]]]] = []
        for symbol, prices in series.items():
            if not prices:
                continue
            try:
                end = datetime.fromisoformat(prices[-1][0]).date()
                try:
                    cutoff = end.replace(year=end.year - requested_years)
                except ValueError:  # 2 月 29 日回退到平年 2 月 28 日。
                    cutoff = end.replace(year=end.year - requested_years, day=28)
            except ValueError:
                continue
            window = [(trade_date, price) for trade_date, price in prices if datetime.fromisoformat(trade_date).date() >= cutoff]
            if len(window) >= 80:
                eligible.append((symbol, window))
        if not eligible:
            result = {"available": False, "reason": f"所选 {requested_years} 年窗口内至少需要一个标的的 80 个交易日价格"}
            return "运行策略回测", "真实历史数据不足，未执行回测", json.dumps(result, ensure_ascii=False)
        symbol, prices = max(eligible, key=lambda item: len(item[1]))
        close = np.array([p for _, p in prices], dtype=float)
        returns = np.diff(close) / close[:-1]
        signals = np.zeros(len(returns))
        for i in range(20, len(returns)):
            signals[i] = 1 if close[i] > close[i-20] else -1
        result = backtest_signal(returns.tolist(), signals.tolist())
        result.update({"available": True, "symbol": symbol, "requested_years": requested_years, "observations": len(prices), "start": prices[0][0], "end": prices[-1][0]})
        return "运行策略回测", "已使用所选时间窗口的导入价格完成点时回测", json.dumps(result)
    if name == "calculate_risk_report":
        returns = _portfolio_returns()
        if len(returns) < 20:
            result = {"available": False, "reason": "需要持仓及其至少 21 个交易日价格"}
            return "计算组合风险", "持仓或价格历史不足，未生成风险指标", json.dumps(result, ensure_ascii=False)
        result = risk_report(returns, arguments.get("confidence", .95)); result["available"] = True
        return "计算组合风险", "已根据真实持仓和价格历史计算", json.dumps(result)
    if name == "run_alpha_ensemble":
        symbol = str(arguments.get("symbol") or "").strip().upper() or None
        result = _ensemble_analysis(symbol, int(arguments.get("predict_ahead", 1)))
        if not result.get("available"):
            return "运行集成预测", "真实历史数据不足，未训练模型", json.dumps(result, ensure_ascii=False)
        trained = [s for s, m in result["models"].items() if m.get("available")]
        if not trained:
            return "运行集成预测", "样本不足，未完成训练", json.dumps(result, ensure_ascii=False)
        if access_mode == "full":
            result["experiment_id"] = _save_reproducible_experiment("alpha_ensemble", "AlphaEnsemble 预测", {"predict_ahead": result["predict_ahead"], "model": result["method"]}, result, trained)
        return "运行集成预测", f"已训练 {len(trained)} 个标的的异构集成模型", json.dumps(result, ensure_ascii=False)
    if name == "optimize_current_portfolio":
        with connect() as db:
            holdings = [row["symbol"] for row in db.execute("SELECT symbol FROM holdings").fetchall()]
        usable = [symbol for symbol in holdings if symbol in series and len(series[symbol]) >= 40]
        if len(usable) < 2:
            result = {"available": False, "reason": "至少需要两个持仓及其 40 个交易日价格"}
            return "优化投资组合", "真实持仓或价格历史不足，未执行优化", json.dumps(result, ensure_ascii=False)
        min_len = min(len(series[s]) for s in usable)
        matrix = np.column_stack([np.diff(np.log([p for _, p in series[s][-min_len:]])) for s in usable])
        result = optimize_portfolio(matrix.mean(axis=0).tolist(), matrix.tolist(), max_weight=max(.12, 1 / len(usable)))
        result.update({"available": True, "symbols": usable, "orders_placed": False, "approval_required": True})
        return "优化投资组合", "已基于真实持仓执行受约束优化", json.dumps(result)
    if name == "get_market_indices":
        try:
            result = market_indices()
            n = len(result.get("indices", []))
            return "读取指数", f"已获取 {n} 个指数实时行情", json.dumps(result, ensure_ascii=False)
        except Exception as exc:
            return "读取指数", "实时指数获取失败", json.dumps({"ok": False, "error": f"{type(exc).__name__}: {exc}"}, ensure_ascii=False)
    if name == "get_market_quote":
        try:
            symbols = [str(s).strip() for s in (arguments.get("symbols") or []) if str(s).strip()]
            market = str(arguments.get("market") or "a")
            if not symbols:
                return "读取行情", "未提供代码", json.dumps({"ok": False, "error": "symbols 不能为空"}, ensure_ascii=False)
            result = market_quotes(",".join(symbols[:20]), market=market)
            n = len(result.get("quotes", []))
            return "读取行情", f"已获取 {n} 个标的实时快照", json.dumps(result, ensure_ascii=False)
        except Exception as exc:
            return "读取行情", "实时快照获取失败", json.dumps({"ok": False, "error": f"{type(exc).__name__}: {exc}"}, ensure_ascii=False)
    if name == "get_market_kline":
        try:
            symbol = str(arguments.get("symbol") or "").strip()
            market = str(arguments.get("market") or "a")
            period = str(arguments.get("period") or "daily")
            adjust = str(arguments.get("adjust") or "qfq")
            limit = int(arguments.get("limit") or 120)
            if not symbol:
                return "读取K线", "未提供代码", json.dumps({"ok": False, "error": "symbol 不能为空"}, ensure_ascii=False)
            result = market_kline(symbol=symbol, market=market, period=period, adjust=adjust, limit=limit)
            n = len(result.get("bars", []))
            return "读取K线", f"{symbol} {period}K线 {n} 根", json.dumps(result, ensure_ascii=False)
        except Exception as exc:
            return "读取K线", "K线获取失败", json.dumps({"ok": False, "error": f"{type(exc).__name__}: {exc}"}, ensure_ascii=False)
    if name == "get_market_rankings":
        try:
            sort = str(arguments.get("sort") or "change_pct")
            order = str(arguments.get("order") or "desc")
            limit = int(arguments.get("limit") or 20)
            result = market_rankings(sort=sort, order=order, limit=limit)
            n = len(result.get("rankings", []))
            return "读取排行", f"{sort}/{order} 前 {n} 名", json.dumps(result, ensure_ascii=False)
        except Exception as exc:
            return "读取排行", "排行获取失败", json.dumps({"ok": False, "error": f"{type(exc).__name__}: {exc}"}, ensure_ascii=False)
    if name == "get_market_news":
        try:
            limit = int(arguments.get("limit") or 20)
            result = market_news(limit=limit)
            n = len(result.get("news", []))
            return "读取快讯", f"最新 {n} 条财经快讯", json.dumps(result, ensure_ascii=False)
        except Exception as exc:
            return "读取快讯", "快讯获取失败", json.dumps({"ok": False, "error": f"{type(exc).__name__}: {exc}"}, ensure_ascii=False)
    if name == "search_market":
        try:
            q = str(arguments.get("q") or "").strip()
            if not q:
                return "搜索标的", "未提供关键词", json.dumps({"ok": False, "error": "q 不能为空"}, ensure_ascii=False)
            result = market_search(q=q)
            n = len(result.get("results", []))
            return "搜索标的", f"'{q}' 匹配 {n} 条", json.dumps(result, ensure_ascii=False)
        except Exception as exc:
            return "搜索标的", "搜索失败", json.dumps({"ok": False, "error": f"{type(exc).__name__}: {exc}"}, ensure_ascii=False)
    if name == "get_market_detail":
        try:
            symbol = str(arguments.get("symbol") or "").strip()
            market = str(arguments.get("market") or "a")
            if not symbol:
                return "读取详情", "未提供代码", json.dumps({"ok": False, "error": "symbol 不能为空"}, ensure_ascii=False)
            result = market_detail(symbol=symbol, market=market)
            flow = result.get("money_flow") or {}
            main = flow.get("main_net")
            return "读取详情", f"{symbol} 市值 {result.get('market_cap')} · 主力净 {main}", json.dumps(result, ensure_ascii=False)
        except Exception as exc:
            return "读取详情", "详情获取失败", json.dumps({"ok": False, "error": f"{type(exc).__name__}: {exc}"}, ensure_ascii=False)
    if name == "get_market_fflow":
        try:
            symbol = str(arguments.get("symbol") or "").strip()
            market = str(arguments.get("market") or "a")
            limit = int(arguments.get("limit") or 20)
            if not symbol:
                return "读取资金流", "未提供代码", json.dumps({"ok": False, "error": "symbol 不能为空"}, ensure_ascii=False)
            result = market_fflow(symbol=symbol, market=market, limit=limit)
            n = len(result.get("items", []))
            return "读取资金流", f"{symbol} 近 {n} 日资金流", json.dumps(result, ensure_ascii=False)
        except Exception as exc:
            return "读取资金流", "资金流获取失败", json.dumps({"ok": False, "error": f"{type(exc).__name__}: {exc}"}, ensure_ascii=False)
    if name == "get_hsgt_flow":
        try:
            result = market_hsgt()
            n = len(result.get("rows", []))
            return "读取北向资金", f"沪深港通 {n} 条日度汇总", json.dumps(result, ensure_ascii=False)
        except Exception as exc:
            return "读取北向资金", "北向资金获取失败", json.dumps({"ok": False, "error": f"{type(exc).__name__}: {exc}"}, ensure_ascii=False)
    if name == "get_paper_account":
        try:
            result = _account_snapshot()
            return "读取模拟账户", f"总资产 {result.get('total_asset')} · 浮动 {result.get('unrealized_pnl')} · 当日 {result.get('day_pnl')}", json.dumps(result, ensure_ascii=False)
        except Exception as exc:
            return "读取模拟账户", "账户读取失败", json.dumps({"ok": False, "error": f"{type(exc).__name__}: {exc}"}, ensure_ascii=False)
    if name == "get_paper_risk_limits":
        return "读取模拟盘风控", "已读取预交易风控限额", json.dumps({"ok": True, "limits": get_paper_risk_limits()}, ensure_ascii=False)
    if name == "update_paper_risk_limits":
        try:
            limits = update_paper_risk_limits(arguments)
            return "更新模拟盘风控", "已更新本地预交易风控限额", json.dumps({"ok": True, "limits": limits}, ensure_ascii=False)
        except ValueError as exc:
            return "更新模拟盘风控", "更新失败", json.dumps({"ok": False, "error": str(exc)}, ensure_ascii=False)
    if name == "list_paper_positions":
        try:
            result = _account_snapshot()
            return "读取持仓", f"{len(result.get('positions', []))} 条持仓 · 市值 {result.get('market_value')} · 浮动 {result.get('unrealized_pnl')}", json.dumps(result.get("positions", []), ensure_ascii=False)
        except Exception as exc:
            return "读取持仓", "持仓读取失败", json.dumps({"ok": False, "error": f"{type(exc).__name__}: {exc}"}, ensure_ascii=False)
    if name == "place_paper_order":
        try:
            result = place_paper_order(
                market=str(arguments.get("market") or "a"),
                symbol=str(arguments.get("symbol") or ""),
                name=str(arguments.get("name") or ""),
                side=str(arguments.get("side") or "buy"),
                order_type=str(arguments.get("order_type") or "market"),
                price=arguments.get("price"),
                quantity=float(arguments.get("quantity") or 0),
            )
            if result.get("ok"):
                return "模拟下单", f"{result.get('side')} {result.get('symbol')} → {result.get('status')}", json.dumps(result, ensure_ascii=False)
            return "模拟下单", "下单失败", json.dumps(result, ensure_ascii=False)
        except Exception as exc:
            return "模拟下单", "下单失败", json.dumps({"ok": False, "error": f"{type(exc).__name__}: {exc}"}, ensure_ascii=False)
    if name == "cancel_paper_order":
        try:
            result = cancel_order(int(arguments.get("order_id") or 0))
            return "撤单", f"委托 {result.get('order_id')} → {result.get('status')}", json.dumps(result, ensure_ascii=False)
        except Exception as exc:
            return "撤单", "撤单失败", json.dumps({"ok": False, "error": f"{type(exc).__name__}: {exc}"}, ensure_ascii=False)
    if name == "list_paper_orders":
        try:
            result = _list_orders(str(arguments.get("status") or ""))
            return "今日委托", f"{len(result)} 条委托", json.dumps(result, ensure_ascii=False)
        except Exception as exc:
            return "今日委托", "委托读取失败", json.dumps({"ok": False, "error": f"{type(exc).__name__}: {exc}"}, ensure_ascii=False)
    if name == "list_paper_trades":
        try:
            result = _list_trades(int(arguments.get("limit") or 50))
            return "今日成交", f"{len(result)} 条成交", json.dumps(result, ensure_ascii=False)
        except Exception as exc:
            return "今日成交", "成交读取失败", json.dumps({"ok": False, "error": f"{type(exc).__name__}: {exc}"}, ensure_ascii=False)
    if name == "browse_page":
        url = str(arguments.get("url") or "").strip()
        if not url:
            return "浏览网页", "未提供链接", json.dumps({"ok": False, "error": "url 不能为空"}, ensure_ascii=False)
        result = _browse_page(url)
        if result.get("ok"):
            return "浏览网页", f"{result.get('title') or '网页'} · {len(result.get('text') or '')} 字", json.dumps(result, ensure_ascii=False)
        return "浏览网页", "抓取失败", json.dumps(result, ensure_ascii=False)
    if name == "list_scheduled_tasks":
        try:
            tasks = db_list_tasks()
            return "读取定时任务", f"{len(tasks)} 个定时任务", json.dumps({"ok": True, "tasks": tasks}, ensure_ascii=False)
        except Exception as exc:
            return "读取定时任务", "读取失败", json.dumps({"ok": False, "error": f"{type(exc).__name__}: {exc}"}, ensure_ascii=False)
    if name == "create_scheduled_task":
        try:
            task_id = str(arguments.get("task_id") or "").strip() or f"task_{int(time.time() * 1000)}"
            frequency = str(arguments.get("frequency") or "daily")
            if frequency not in ("once", "hourly", "daily", "weekly", "interval"):
                return "创建定时任务", "频率非法", json.dumps({"ok": False, "error": f"frequency 不支持: {frequency}"}, ensure_ascii=False)
            prompt = str(arguments.get("prompt") or "").strip()
            if not prompt:
                return "创建定时任务", "缺少任务内容", json.dumps({"ok": False, "error": "prompt 不能为空"}, ensure_ascii=False)
            name = str(arguments.get("name") or "").strip() or prompt[:24]
            existing = next((t for t in db_list_tasks() if t["id"] == task_id), None)
            task: dict[str, Any] = {
                "id": task_id,
                "name": name,
                "prompt": prompt,
                "frequency": frequency,
                "hour": arguments.get("hour"),
                "minute": arguments.get("minute"),
                "weekdays": arguments.get("weekdays") or None,
                "intervalMinutes": arguments.get("intervalMinutes"),
                "model": str(arguments.get("model") or "") or None,
                "provider": str(arguments.get("provider") or "") or None,
                "reasoning": str(arguments.get("reasoning") or "") or None,
                "enabled": True,
                "createdAt": int(time.time() * 1000),
                "history": [],
            }
            if existing:
                task["createdAt"] = existing["createdAt"]
                task["enabled"] = existing["enabled"]
                task["lastRunAt"] = existing.get("lastRunAt")
                task["lastStatus"] = existing.get("lastStatus")
                task["lastResult"] = existing.get("lastResult")
                task["history"] = existing.get("history") or []
            stored = db_upsert_task(task)
            return "创建定时任务", f"已{'更新' if existing else '创建'}「{stored['name']}」", json.dumps({"ok": True, "task": stored}, ensure_ascii=False)
        except Exception as exc:
            return "创建定时任务", "创建失败", json.dumps({"ok": False, "error": f"{type(exc).__name__}: {exc}"}, ensure_ascii=False)
    if name == "delete_scheduled_task":
        try:
            task_id = str(arguments.get("task_id") or "").strip()
            if not task_id:
                return "删除定时任务", "未提供 id", json.dumps({"ok": False, "error": "task_id 不能为空"}, ensure_ascii=False)
            deleted = db_delete_task(task_id)
            return "删除定时任务", "已删除" if deleted else "任务不存在", json.dumps({"ok": True, "deleted": task_id, "removed": deleted}, ensure_ascii=False)
        except Exception as exc:
            return "删除定时任务", "删除失败", json.dumps({"ok": False, "error": f"{type(exc).__name__}: {exc}"}, ensure_ascii=False)
    if name == "run_factor_research":
        try:
            code = str(arguments.get("code") or "")
            horizon = int(arguments.get("horizon") or 1)
            quantiles = int(arguments.get("quantiles") or 5)
            factor_fn = compile_factor(code)
            series = _price_series()
            panel, _ = build_panels(series, min_rows=60)
            result = evaluate_factor(factor_fn, _factor_inputs(), horizon=horizon, quantiles=quantiles)
            result["factor_name"] = str(arguments.get("name") or "custom_factor")
            if access_mode == "full":
                experiment_id = _save_reproducible_experiment("factor_research", result["factor_name"], {"code": code[:2000], "horizon": horizon, "quantiles": quantiles}, {k: v for k, v in result.items() if k != "ic_series_tail"}, result.get("symbols"))
                result["experiment_id"] = experiment_id
                audit("factor_evaluated", {"experiment_id": experiment_id, "symbols": len(result.get("symbols", [])), "ic_mean": result.get("ic_mean")})
            return "因子研究", f"IC 均值 {result.get('ic_mean')} · ICIR {result.get('ic_ir')} · {len(result.get('symbols', []))} 标的", json.dumps(result, ensure_ascii=False)
        except FactorCodeError as exc:
            return "因子研究", "因子无效", json.dumps({"available": False, "reason": str(exc)}, ensure_ascii=False)
        except Exception as exc:
            return "因子研究", "评估失败", json.dumps({"available": False, "reason": f"{type(exc).__name__}: {exc}"}, ensure_ascii=False)
    if name == "run_portfolio_backtest":
        try:
            weights = {str(s).strip().upper(): float(w) for s, w in (arguments.get("weights") or {}).items() if float(w) > 0}
            if not weights:
                return "组合回测", "权重无效", json.dumps({"available": False, "reason": "weights 必须包含正权重"}, ensure_ascii=False)
            series = _price_series()
            closes = {}
            for symbol in weights:
                points = series.get(symbol) or series.get(_yahoo_symbol(symbol)) or []
                if len(points) >= 30:
                    closes[symbol] = pd.Series({d: float(p) for d, p in points}).sort_index()
            if not closes:
                return "组合回测", "缺少价格数据", json.dumps({"available": False, "reason": "给定标的均无本地价格，请先导入(fetch_public_quotes/import_market_prices/CSV)"}, ensure_ascii=False)
            result = run_portfolio_backtest(
                closes, weights,
                rebalance_days=int(arguments.get("rebalance_days") or 20),
                cost_bps=float(arguments.get("cost_bps") or 12.0),
                slippage_bps=float(arguments.get("slippage_bps") or 5.0),
            )
            if access_mode == "full":
                experiment_id = _save_reproducible_experiment("portfolio_backtest", "组合再平衡回测", {"weights": weights}, {k: v for k, v in result.items() if k not in ("nav", "benchmark_nav")}, result.get("symbols"))
                result["experiment_id"] = experiment_id
                audit("portfolio_backtest_completed", {"experiment_id": experiment_id, "symbols": len(closes)})
            m = result["metrics"]
            return "组合回测", f"年化 {m['annual_return']} · 夏普 {m['sharpe']} · 回撤 {m['max_drawdown']}", json.dumps(result, ensure_ascii=False)
        except BacktestDataError as exc:
            return "组合回测", "数据不足", json.dumps({"available": False, "reason": str(exc)}, ensure_ascii=False)
        except Exception as exc:
            return "组合回测", "回测失败", json.dumps({"available": False, "reason": f"{type(exc).__name__}: {exc}"}, ensure_ascii=False)
    if name == "manage_price_alerts":
        try:
            action = str(arguments.get("action") or "list")
            if action == "list":
                alerts = list_alerts()
                return "预警列表", f"{len(alerts)} 条预警", json.dumps({"ok": True, "alerts": alerts}, ensure_ascii=False)
            if action == "create":
                kind = str(arguments.get("kind") or "").strip()
                if kind not in ALERT_KINDS:
                    return "创建预警", "类型非法", json.dumps({"ok": False, "error": f"kind 需为 {'/'.join(ALERT_KINDS)}"}, ensure_ascii=False)
                threshold = float(arguments.get("threshold") or 0)
                symbol = str(arguments.get("symbol") or "").strip().upper()
                if kind not in ("drawdown_below",) and not symbol:
                    return "创建预警", "缺少代码", json.dumps({"ok": False, "error": "除组合回撤外都需要 symbol"}, ensure_ascii=False)
                alert_id = f"alert_{int(time.time() * 1000)}"
                stored = upsert_alert({"id": alert_id, "symbol": symbol, "market": str(arguments.get("market") or "a"), "kind": kind, "threshold": threshold, "note": arguments.get("note"), "enabled": True, "createdAt": int(time.time() * 1000)})
                return "创建预警", f"已创建 {symbol} {ALERT_KINDS[kind]} {threshold}", json.dumps({"ok": True, "alert": stored}, ensure_ascii=False)
            if action == "delete":
                removed = delete_alert(str(arguments.get("alert_id") or ""))
                return "删除预警", "已删除" if removed else "不存在", json.dumps({"ok": True, "removed": removed}, ensure_ascii=False)
            return "预警管理", "未知操作", json.dumps({"ok": False, "error": f"action 不支持: {action}"}, ensure_ascii=False)
        except Exception as exc:
            return "预警管理", "操作失败", json.dumps({"ok": False, "error": f"{type(exc).__name__}: {exc}"}, ensure_ascii=False)
    if name == "list_recent_notifications":
        try:
            items = list_notifications(limit=int(arguments.get("limit") or 15), unread_only=bool(arguments.get("unread_only")))
            return "系统通知", f"{len(items)} 条通知", json.dumps({"ok": True, "notifications": items}, ensure_ascii=False)
        except Exception as exc:
            return "系统通知", "读取失败", json.dumps({"ok": False, "error": f"{type(exc).__name__}: {exc}"}, ensure_ascii=False)
    return name, "未知工具", json.dumps({"available": False, "reason": "unknown_tool"})


def _sse(payload: dict[str, Any]) -> str:
    return f"data: {json.dumps(payload, ensure_ascii=False)}\n\n"


class _RunCancelled(Exception):
    """用户主动取消本次运行。"""


# 运行注册表: thread_id -> 取消事件。/agent/cancel 置位后,
# 流式生成器在每轮 LLM 调用前后与每个工具执行间协作退出。
_CANCEL_EVENTS: dict[str, asyncio.Event] = {}


def _register_run(thread_id: str) -> asyncio.Event:
    event = asyncio.Event()
    _CANCEL_EVENTS[thread_id] = event
    return event


def _release_run(thread_id: str) -> None:
    _CANCEL_EVENTS.pop(thread_id, None)


def _cancelled(thread_id: str) -> bool:
    event = _CANCEL_EVENTS.get(thread_id)
    return bool(event and event.is_set())


def _thread_history_block(thread_id: str | None) -> str:
    """服务端会话记忆: 取该线程最近若干条(user/assistant/tool)压成一段上下文。
    工具轨迹以摘要行保留, 让 Agent 在长会话中仍记得自己查过什么。"""
    if not thread_id:
        return ""
    lines: list[str] = []
    for item in list_thread_messages(thread_id, limit=24):
        if item["role"] == "user":
            lines.append(f"用户：{item['content']}")
        elif item["role"] == "assistant":
            lines.append(f"助手：{item['content']}")
        else:
            lines.append(f"[工具 {item['name']}] {item['content']}")
    if not lines:
        return ""
    return "以下是本次会话此前的交互记录（含工具调用摘要）：\n" + "\n".join(lines)


def _compose_prompt(request: AgentRequest) -> str:
    history = _thread_history_block(request.thread_id)
    return f"{history}\n\n用户目标：{request.prompt}" if history else request.prompt


def _persist_turn(request: AgentRequest, answer: str) -> None:
    if not request.thread_id:
        return
    add_thread_message(request.thread_id, "user", request.prompt)
    if answer.strip():
        add_thread_message(request.thread_id, "assistant", answer.strip())


def _provider_failure_message(provider: str, exc: Exception) -> str:
    label = {"openai": "OpenAI", "deepseek": "DeepSeek", "qwen": "Qwen"}.get(provider.lower(), provider)
    error_name = type(exc).__name__
    if error_name == "AuthenticationError":
        return f"{label} 鉴权失败：API Key 无效、已过期，或不属于该提供商。请在设置中重新配置。"
    if error_name in {"PermissionDeniedError", "NotFoundError", "BadRequestError"}:
        return f"{label} 拒绝了当前模型请求：请检查模型权限、账户余额或所选模型是否可用。"
    if error_name == "RateLimitError":
        return f"{label} 当前请求过多或额度不足，请稍后重试并检查账户额度。"
    if error_name in {"APIConnectionError", "APITimeoutError"}:
        return f"无法连接 {label} API，请检查网络、代理或提供商服务状态。"
    return f"{label} 请求失败（{error_name}），请检查提供商状态后重试。"


async def _chunked_text(text: str, event_type: str):
    content = text or ""
    for start in range(0, len(content), 12):
        yield _sse({"type": event_type, "text": content[start:start + 12]})
        await asyncio.sleep(.012)


def _response_text(response: Any) -> str:
    text = getattr(response, "output_text", None)
    if text:
        return str(text).strip()
    parts: list[str] = []
    for item in getattr(response, "output", None) or []:
        if getattr(item, "type", "") != "message":
            continue
        for block in getattr(item, "content", None) or []:
            piece = getattr(block, "text", None)
            if piece:
                parts.append(str(piece))
    return "".join(parts).strip()


async def _openai_agent_stream(request: AgentRequest, thread_id: str):
    """OpenAI Responses API 真流式: 文本 delta 到达即转发 SSE,
    工具调用在流结束后按 call 执行并携带 previous_response_id 续轮。"""
    _restore_provider_keys()
    if not AGENT_API_KEY:
        yield _sse({"type": "error", "text": "尚未配置 OpenAI API Key。请先在设置中完成配置。"})
        return
    answer_parts: list[str] = []
    try:
        client = AsyncOpenAI(api_key=AGENT_API_KEY)
        reasoning_kwargs: dict[str, Any] = {}
        if request.reasoning in ("low", "medium", "high"):
            reasoning_kwargs["reasoning"] = {"effort": request.reasoning}
        inputs: list[dict[str, Any]] = [{"role": "user", "content": _compose_prompt(request)}]
        previous_id: str | None = None
        rounds = 0
        response = None
        while True:
            if _cancelled(thread_id):
                raise _RunCancelled()
            kwargs: dict[str, Any] = dict(model=request.model, instructions=AGENT_INSTRUCTIONS, input=inputs, tools=AGENT_TOOLS, parallel_tool_calls=True, max_tool_calls=8, stream=True)
            if previous_id:
                kwargs["previous_response_id"] = previous_id
            if reasoning_kwargs and rounds == 0:
                kwargs.update(reasoning_kwargs)
            stream = await client.responses.create(**kwargs)
            async for event in stream:
                if _cancelled(thread_id):
                    raise _RunCancelled()
                etype = getattr(event, "type", "")
                if etype == "response.output_text.delta":
                    delta = getattr(event, "delta", "") or ""
                    if delta:
                        answer_parts.append(delta)
                        yield _sse({"type": "message_delta", "text": delta})
                elif etype == "response.completed":
                    response = getattr(event, "response", None)
                elif etype in ("response.failed", "error"):
                    raise RuntimeError(f"模型响应中断：{etype}")
            if response is None or _cancelled(thread_id):
                raise _RunCancelled() if _cancelled(thread_id) else RuntimeError("模型流未返回完成事件")
            previous_id = response.id
            calls = [item for item in response.output if getattr(item, "type", "") == "function_call"]
            if not calls or rounds >= 3:
                break
            outputs = []
            for call in calls:
                if _cancelled(thread_id):
                    raise _RunCancelled()
                args = json.loads(call.arguments or "{}")
                label, detail, output = _tool_result(call.name, args, request.access_mode)
                yield _sse({"type": "tool_start", "name": call.name, "label": label, "status": "running"})
                await asyncio.sleep(.05)
                yield _sse({"type": "tool_result", "name": call.name, "label": label, "detail": detail, "status": "completed"})
                if request.thread_id:
                    add_thread_message(request.thread_id, "tool", f"{label} · {detail}", name=call.name)
                outputs.append({"type": "function_call_output", "call_id": call.call_id, "output": output})
            inputs = outputs
            rounds += 1
        audit("agent_run_completed", {"provider": "openai", "model": request.model, "tool_rounds": rounds, "reasoning": request.reasoning})
        yield _sse({"type": "done", "text": ""})
        _persist_turn(request, "".join(answer_parts))
    except _RunCancelled:
        audit("agent_run_cancelled", {"provider": "openai", "model": request.model})
        yield _sse({"type": "cancelled", "text": "本次运行已取消。"})
        _persist_turn(request, "".join(answer_parts))
    except Exception as exc:
        audit("agent_run_failed", {"provider": "openai", "error": type(exc).__name__})
        yield _sse({"type": "error", "text": _provider_failure_message("openai", exc)})
        _persist_turn(request, "".join(answer_parts))


async def _compatible_agent_stream(request: AgentRequest, api_key: str, base_url: str, thread_id: str):
    """DeepSeek/Qwen 兼容模式真流式: chat.completions stream=True,
    content delta 即时转发; tool_call 增量按 index 累积后执行。"""
    if not api_key:
        yield _sse({"type": "error", "text": f"尚未配置 {request.provider} API Key。请先在设置中完成配置。"})
        return
    client = AsyncOpenAI(api_key=api_key, base_url=base_url)
    messages: list[dict[str, Any]] = [{"role": "system", "content": AGENT_INSTRUCTIONS}, {"role": "user", "content": _compose_prompt(request)}]
    extra_kwargs: dict[str, Any] = {}
    extra_body: dict[str, Any] = {}
    if request.provider.strip().lower() == "deepseek" and request.reasoning in ("low", "medium", "high"):
        extra_kwargs["reasoning_effort"] = request.reasoning
    elif request.provider.strip().lower() == "qwen" and request.reasoning:
        # enable_thinking 不是 OpenAI SDK 的命名参数，直接传 kwargs 会在 SDK 层抛 TypeError；
        # 必须放进 extra_body 由 SDK 作为请求体字段转发给 DashScope compatible-mode。
        extra_body["enable_thinking"] = request.reasoning != "off"
    answer_parts: list[str] = []
    try:
        rounds = 0
        while rounds < 5:
            if _cancelled(thread_id):
                raise _RunCancelled()
            stream = await client.chat.completions.create(model=request.model, messages=messages, tools=CHAT_TOOLS, parallel_tool_calls=True, extra_body=extra_body, stream=True, **extra_kwargs)
            round_text: list[str] = []
            tool_acc: dict[int, dict[str, str]] = {}
            tool_calls_payload: list[dict[str, Any]] = []
            async for chunk in stream:
                if _cancelled(thread_id):
                    raise _RunCancelled()
                if not getattr(chunk, "choices", None):
                    continue
                choice = chunk.choices[0]
                delta = choice.delta
                if delta and delta.content:
                    round_text.append(delta.content)
                    answer_parts.append(delta.content)
                    yield _sse({"type": "message_delta", "text": delta.content})
                for tc in (delta.tool_calls if delta else None) or []:
                    slot = tool_acc.setdefault(tc.index, {"id": "", "name": "", "arguments": ""})
                    if tc.id:
                        slot["id"] = tc.id
                    fn = tc.function
                    if fn is not None:
                        if fn.name:
                            slot["name"] += str(fn.name)
                        if fn.arguments:
                            slot["arguments"] += str(fn.arguments)
            calls = [tool_acc[key] for key in sorted(tool_acc) if tool_acc[key]["name"]]
            text = "".join(round_text).strip()
            if not calls:
                break
            # 工具轮: 把已流出的前导文本与累积的 tool_calls 回填进消息历史
            messages.append({"role": "assistant", "content": text or None, "tool_calls": [{"id": c["id"], "type": "function", "function": {"name": c["name"], "arguments": c["arguments"]}} for c in calls]})
            for c in calls:
                if _cancelled(thread_id):
                    raise _RunCancelled()
                args = json.loads(c["arguments"] or "{}")
                label, detail, output = _tool_result(c["name"], args, request.access_mode)
                yield _sse({"type": "tool_start", "name": c["name"], "label": label, "status": "running"})
                await asyncio.sleep(.05)
                yield _sse({"type": "tool_result", "name": c["name"], "label": label, "detail": detail, "status": "completed"})
                if request.thread_id:
                    add_thread_message(request.thread_id, "tool", f"{label} · {detail}", name=c["name"])
                messages.append({"role": "tool", "tool_call_id": c["id"], "content": output})
            rounds += 1
        final_text = text or ("".join(answer_parts).strip() or "任务已完成，工具记录已保存。")
        audit("agent_run_completed", {"provider": request.provider, "model": request.model, "tool_rounds": rounds, "reasoning": request.reasoning})
        yield _sse({"type": "done", "text": ""})
        _persist_turn(request, final_text)
    except _RunCancelled:
        audit("agent_run_cancelled", {"provider": request.provider, "model": request.model})
        yield _sse({"type": "cancelled", "text": "本次运行已取消。"})
        _persist_turn(request, "".join(answer_parts))
    except Exception as exc:
        audit("agent_run_failed", {"provider": request.provider, "error": type(exc).__name__})
        yield _sse({"type": "error", "text": _provider_failure_message(request.provider, exc)})
        _persist_turn(request, "".join(answer_parts))


def _live_provider_key(provider: str) -> str:
    _restore_provider_keys()
    name = provider.strip().lower()
    if name == "openai":
        return AGENT_API_KEY
    if name == "deepseek":
        return DEEPSEEK_API_KEY
    if name == "qwen":
        return QWEN_API_KEY
    return ""


async def _agent_stream(request: AgentRequest, thread_id: str):
    provider = request.provider.strip().lower()
    if provider == "openai":
        async for event in _openai_agent_stream(request, thread_id):
            yield event
    elif provider == "deepseek":
        async for event in _compatible_agent_stream(request, _live_provider_key("deepseek"), "https://api.deepseek.com", thread_id):
            yield event
    elif provider == "qwen":
        async for event in _compatible_agent_stream(request, _live_provider_key("qwen"), "https://dashscope.aliyuncs.com/compatible-mode/v1", thread_id):
            yield event
    else:
        yield _sse({"type": "error", "text": "不支持的模型提供商。"})
    _release_run(thread_id)


# ---------- 无头 Agent 执行(引擎侧定时调度 / 手动运行用, 不开 SSE) ----------

async def _run_agent_headless(request: AgentRequest) -> dict[str, Any]:
    """无头执行一次 Agent 任务: 复用 _tool_result 走完整工具循环, 不产生 SSE, 直接返回最终文本。
    与 _agent_stream 的行为一致, 只是把事件流换成返回值, 供调度器在后台静默执行。"""
    provider = request.provider.strip().lower()
    if provider == "openai":
        if not AGENT_API_KEY:
            return {"ok": False, "text": "尚未配置 OpenAI API Key。请先在设置中完成配置。"}
        try:
            client = AsyncOpenAI(api_key=AGENT_API_KEY)
            reasoning_kwargs: dict[str, Any] = {}
            if request.reasoning in ("low", "medium", "high"):
                reasoning_kwargs["reasoning"] = {"effort": request.reasoning}
            response = await client.responses.create(model=request.model, instructions=AGENT_INSTRUCTIONS, input=request.prompt, tools=AGENT_TOOLS, parallel_tool_calls=True, max_tool_calls=8, **reasoning_kwargs)
            rounds = 0
            while rounds < 4:
                calls = [item for item in response.output if getattr(item, "type", "") == "function_call"]
                if not calls:
                    break
                outputs = []
                for call in calls:
                    args = json.loads(call.arguments or "{}")
                    _, _, output = _tool_result(call.name, args, request.access_mode)
                    outputs.append({"type": "function_call_output", "call_id": call.call_id, "output": output})
                response = await client.responses.create(model=request.model, instructions=AGENT_INSTRUCTIONS, previous_response_id=response.id, input=outputs, tools=AGENT_TOOLS, parallel_tool_calls=True, max_tool_calls=8)
                rounds += 1
            text = _response_text(response) or "任务已完成，工具记录已保存。"
            audit("agent_run_completed", {"provider": "openai", "model": request.model, "tool_rounds": rounds, "reasoning": request.reasoning, "mode": "headless"})
            return {"ok": True, "text": text}
        except Exception as exc:
            audit("agent_run_failed", {"provider": "openai", "error": type(exc).__name__, "mode": "headless"})
            return {"ok": False, "text": _provider_failure_message("openai", exc)}
    if provider in ("deepseek", "qwen"):
        api_key = _live_provider_key(provider)
        base_url = "https://api.deepseek.com" if provider == "deepseek" else "https://dashscope.aliyuncs.com/compatible-mode/v1"
        if not api_key:
            return {"ok": False, "text": f"尚未配置 {provider} API Key。请先在设置中完成配置。"}
        try:
            client = AsyncOpenAI(api_key=api_key, base_url=base_url)
            messages: list[dict[str, Any]] = [{"role": "system", "content": AGENT_INSTRUCTIONS}, {"role": "user", "content": request.prompt}]
            extra_kwargs: dict[str, Any] = {}
            extra_body: dict[str, Any] = {}
            if provider == "deepseek" and request.reasoning in ("low", "medium", "high"):
                extra_kwargs["reasoning_effort"] = request.reasoning
            elif provider == "qwen" and request.reasoning:
                extra_body["enable_thinking"] = request.reasoning != "off"
            rounds = 0
            final_text = ""
            while rounds < 5:
                completion = await client.chat.completions.create(model=request.model, messages=messages, tools=CHAT_TOOLS, parallel_tool_calls=True, extra_body=extra_body, **extra_kwargs)
                message = completion.choices[0].message
                calls = message.tool_calls or []
                if not calls:
                    final_text = message.content or "任务已完成，工具记录已保存。"
                    break
                messages.append(message.model_dump(exclude_none=True))
                for call in calls:
                    args = json.loads(call.function.arguments or "{}")
                    _, _, output = _tool_result(call.function.name, args, request.access_mode)
                    messages.append({"role": "tool", "tool_call_id": call.id, "content": output})
                rounds += 1
            audit("agent_run_completed", {"provider": provider, "model": request.model, "tool_rounds": rounds, "reasoning": request.reasoning, "mode": "headless"})
            return {"ok": True, "text": final_text or "任务已完成，工具记录已保存。"}
        except Exception as exc:
            audit("agent_run_failed", {"provider": provider, "error": type(exc).__name__, "mode": "headless"})
            return {"ok": False, "text": _provider_failure_message(provider, exc)}
    return {"ok": False, "text": "不支持的模型提供商。"}


def _resolve_task_run(task: dict[str, Any]) -> tuple[str, str, str]:
    """把定时任务的 model/provider/reasoning 解析成可执行参数。
    任务未指定 provider 时按已配置的 Key 回退; 未指定 model 时用该 provider 的默认模型。
    返回 (provider, model, reasoning); provider 为空表示没有任何模型 API Key 已配置。"""
    _restore_provider_keys()
    configured: list[tuple[str, str]] = []
    if AGENT_API_KEY:
        configured.append(("openai", "gpt-5.4-mini"))
    if DEEPSEEK_API_KEY:
        configured.append(("deepseek", "deepseek-v4-flash"))
    if QWEN_API_KEY:
        configured.append(("qwen", "qwen3.7-flash"))
    if not configured:
        return "", "", ""
    defaults = dict(configured)
    provider = (task.get("provider") or "").strip().lower()
    model = (task.get("model") or "").strip()
    if not provider:
        if model:
            if model.startswith(("gpt", "o3", "o4")):
                provider = "openai"
            elif model.startswith("deepseek"):
                provider = "deepseek"
            elif model.startswith("qwen"):
                provider = "qwen"
        if not provider or provider not in defaults:
            provider = configured[0][0]
    if provider not in defaults:
        provider = configured[0][0]
    if not model:
        model = defaults[provider]
    reasoning = (task.get("reasoning") or "medium").strip() or "medium"
    return provider, model, reasoning


def _task_due(task: dict[str, Any], now_ms: int) -> bool:
    """判断任务当前是否到点。语义对齐前端 lib/scheduler.ts 的 nextRun:
    - 只对「已到达/已错过」的时刻返回 True, 用 lastRunAt 防止同一周期重复触发;
    - 创建时间晚于目标时刻的任务(如 10 点创建 9 点的 daily 任务)不补跑;
    - 引擎离线期间错过的周期, 重新上线后补跑一次(这正是引擎侧调度的价值)。
    前端 weekdays 约定 0=周日…6=周六; Python weekday() 周一=0…周日=6。"""
    if not task.get("enabled"):
        return False
    freq = task.get("frequency")
    last = task.get("lastRunAt")
    created = int(task.get("createdAt") or 0)
    now = datetime.now()

    def ts(d: datetime) -> int:
        return int(d.timestamp() * 1000)

    if freq == "once":
        if last is not None:
            return False
        target = now.replace(hour=int(task.get("hour") or 9), minute=int(task.get("minute") or 0), second=0, microsecond=0)
        return created <= ts(target) <= now_ms
    if freq == "interval":
        step = max(1, int(task.get("intervalMinutes") or 60)) * 60 * 1000
        base = last if last is not None else created
        return base > 0 and now_ms >= base + step
    if freq == "hourly":
        target = now.replace(minute=int(task.get("minute") or 0), second=0, microsecond=0)
        t = ts(target)
        return created <= t and (last is None or last < t) and t <= now_ms
    if freq == "daily":
        target = now.replace(hour=int(task.get("hour") or 9), minute=int(task.get("minute") or 0), second=0, microsecond=0)
        t = ts(target)
        return created <= t and (last is None or last < t) and t <= now_ms
    weekdays = task.get("weekdays") or []
    if not weekdays or (now.weekday() + 1) % 7 not in weekdays:
        return False
    target = now.replace(hour=int(task.get("hour") or 9), minute=int(task.get("minute") or 0), second=0, microsecond=0)
    t = ts(target)
    return created <= t and (last is None or last < t) and t <= now_ms


def _mark_task_result(task_id: str, status: str, text: str, stamp: int) -> None:
    """把一次运行的结果写回任务: lastStatus/lastResult + history(前 20 条), 并推送通知。"""
    task = db_get_task(task_id)
    if task is None:
        return
    task["lastStatus"] = status
    task["lastResult"] = text[:4000]
    history = task.get("history") or []
    preview = re.sub(r"\s+", " ", text).strip()[:140]
    task["history"] = ([{"at": stamp, "status": status, "preview": preview}] + history)[:20]
    db_upsert_task(task)
    if status in ("done", "error"):
        _notify("task", f"定时任务「{task.get('name') or task_id}」{'已完成' if status == 'done' else '执行失败'}", preview)


_scheduler_lock = asyncio.Lock()
_scheduler_running: set[str] = set()


async def _run_scheduled_task(task: dict[str, Any]) -> None:
    """执行一个定时任务: 先落 running 状态防双触发, 跑无头 Agent, 再写结果与历史。
    同一任务不会并发执行(手动运行与调度循环共享 _scheduler_running 守卫)。"""
    task_id = str(task["id"])
    async with _scheduler_lock:
        if task_id in _scheduler_running:
            return
        _scheduler_running.add(task_id)
    try:
        provider, model, reasoning = _resolve_task_run(task)
        stamp = int(time.time() * 1000)
        if not provider:
            _mark_task_result(task_id, "error", "未配置任何模型 API Key，本次运行已跳过", stamp)
            return
        task["lastRunAt"] = stamp
        task["lastStatus"] = "running"
        db_upsert_task(task)
        request = AgentRequest(prompt=f"定时任务「{task.get('name') or task_id}」。\n\n任务内容：{task.get('prompt') or ''}", model=model, provider=provider, reasoning=reasoning, access_mode="ask")
        result = await _run_agent_headless(request)
        text = (result.get("text") or "").strip()
        _mark_task_result(task_id, "done" if result.get("ok") else "error", text, stamp)
    except Exception as exc:
        _mark_task_result(task_id, "error", f"调度执行异常：{type(exc).__name__}", int(time.time() * 1000))
    finally:
        async with _scheduler_lock:
            _scheduler_running.discard(task_id)


async def _scheduler_loop() -> None:
    """后台调度循环: 每 30s 扫一遍启用的定时任务, 到点且未在运行中的逐个执行。
    引擎随桌面应用生命周期运行；关闭应用会结束本会话引擎，因此不会留下不可控的后台 Agent。"""
    # 引擎重启时, 上次中断还停在 running 的任务重置为空闲, 避免永远卡住。
    for task in db_list_tasks():
        if task.get("lastStatus") == "running":
            task["lastStatus"] = "idle"
            db_upsert_task(task)
    while True:
        try:
            now_ms = int(time.time() * 1000)
            for task in db_list_tasks():
                if task.get("lastStatus") == "running":
                    continue
                if _task_due(task, now_ms):
                    await _run_scheduled_task(task)
            # 挂单撮合与预警一样由引擎调度；成交函数会重新做资金、持仓和限价校验。
            process_pending_orders()
            _check_alerts()
        except Exception:
            # 单轮扫描失败不终止循环(DB 可能临时被锁)
            pass
        await asyncio.sleep(30)


@app.get("/health")
def health() -> dict[str, Any]:
    return {"status": "ok", "engine": "quantdesk", "version": "0.3.5", "time": datetime.now(timezone.utc).isoformat(), "agent_mode": "openai" if AGENT_API_KEY else "unconfigured", "capabilities": ["investment_agent", "ensemble_prediction", "walk_forward_backtest", "portfolio_optimization", "risk_analysis", "stock_market_data", "futures_market_data"]}


@app.get("/workspace/status")
def workspace_status() -> dict[str, Any]:
    return _workspace_status()


@app.get("/audit/recent")
def recent_audit() -> list[dict[str, Any]]:
    with connect() as db:
        rows = db.execute("SELECT event, payload, created_at FROM audit_log ORDER BY id DESC LIMIT 50").fetchall()
    return [{"event": row["event"], "payload": json.loads(row["payload"]), "created_at": row["created_at"]} for row in rows]


@app.post("/agent/configure")
def configure_agent(request: AgentConfigureRequest) -> dict[str, Any]:
    # 密钥只保存在进程内存（持久层是 Windows Credential Manager，由 Tauri 注入），
    # 不再写入 SQLite。
    global AGENT_API_KEY
    AGENT_API_KEY = request.api_key
    pop_setting("openai_api_key")
    audit("agent_configured", {"provider": "openai"})
    return {"configured": True, "provider": "openai"}


@app.post("/providers/configure")
def configure_provider(request: ProviderConfigureRequest) -> dict[str, Any]:
    global AGENT_API_KEY, DEEPSEEK_API_KEY, QWEN_API_KEY, MARKET_API_KEY, TUSHARE_TOKEN
    provider = request.provider.strip().lower()
    legacy_keys = {"openai": "openai_api_key", "deepseek": "deepseek_api_key", "qwen": "dashscope_api_key", "dashscope": "dashscope_api_key", "alphavantage": "alphavantage_api_key", "alpha_vantage": "alphavantage_api_key", "alpha vantage": "alphavantage_api_key", "tushare": "tushare_token", "tusharepro": "tushare_token", "tushare pro": "tushare_token"}
    if provider == "openai":
        AGENT_API_KEY = request.api_key
    elif provider == "deepseek":
        DEEPSEEK_API_KEY = request.api_key
    elif provider in {"qwen", "dashscope"}:
        QWEN_API_KEY = request.api_key
    elif provider in {"alphavantage", "alpha_vantage", "alpha vantage"}:
        MARKET_API_KEY = request.api_key
    elif provider in {"tushare", "tusharepro", "tushare pro"}:
        TUSHARE_TOKEN = request.api_key
    else:
        raise HTTPException(422, "不支持的数据提供商")
    if provider in legacy_keys:
        pop_setting(legacy_keys[provider])
    audit("provider_configured", {"provider": provider})
    return {"configured": True, "provider": provider}


@app.post("/workspace/market/sync")
async def sync_market(request: MarketSyncRequest) -> dict[str, Any]:
    return await _sync_alpha_vantage(request)


@app.post("/workspace/tushare/sync")
async def sync_tushare(request: TushareSyncRequest) -> dict[str, Any]:
    return await _sync_tushare(request)


@app.post("/workspace/market/public-sync")
def sync_public_market(request: PublicSyncRequest) -> dict[str, Any]:
    return _sync_public_quotes(request.symbols)


@app.post("/agent/run")
def run_agent(request: AgentRequest) -> StreamingResponse:
    thread_id = request.thread_id or f"run_{secrets.token_urlsafe(8)}"
    _register_run(thread_id)
    audit("agent_run_started", {"provider": request.provider, "model": request.model, "prompt_length": len(request.prompt), "reasoning": request.reasoning, "thread": bool(request.thread_id)})
    return StreamingResponse(_agent_stream(request, thread_id), media_type="text/event-stream", headers={"Cache-Control": "no-cache", "X-Accel-Buffering": "no", "X-Thread-Id": thread_id})


@app.post("/agent/cancel/{thread_id}")
def cancel_agent_run(thread_id: str) -> dict[str, Any]:
    """取消一次运行中的 Agent 任务: 置位取消事件,
    流式循环会在下一个安全点(LLM 调用间隙/工具执行间)退出。"""
    event = _CANCEL_EVENTS.get(thread_id)
    if event is None:
        return {"ok": False, "running": False}
    event.set()
    audit("agent_run_cancel_requested", {"thread": thread_id})
    return {"ok": True, "running": True}


@app.post("/scheduler/tasks/{task_id}/run")
async def run_scheduler_task_now(task_id: str) -> dict[str, Any]:
    """立即运行一个定时任务(引擎侧执行, 不开 SSE, 返回最新任务状态)。"""
    task = db_get_task(task_id)
    if task is None:
        raise HTTPException(404, "定时任务不存在")
    await _run_scheduled_task(task)
    return {"ok": True, "task": db_get_task(task_id)}


@app.post("/workspace/market/import")
def import_market(request: MarketImportRequest) -> dict[str, Any]:
    with connect() as db:
        db.executemany("INSERT OR REPLACE INTO market_prices(symbol,trade_date,close,source) VALUES(?,?,?,?)", [(row.symbol.strip().upper(), row.date, row.close, request.source) for row in request.rows])
    analysis_rows = [
        {"symbol": row.symbol, "trade_date": row.date, "market": request.market, "adjust": request.adjust, "source": request.source, "open": row.open, "high": row.high, "low": row.low, "close": row.close, "volume": row.volume, "amount": row.amount}
        for row in request.rows
        if any(value is not None for value in (row.open, row.high, row.low, row.volume, row.amount))
    ]
    if analysis_rows:
        upsert_analysis_bars(analysis_rows)
    audit("market_data_imported", {"rows": len(request.rows), "ohlcv_rows": len(analysis_rows), "source": request.source, "market": request.market, "adjust": request.adjust})
    return _workspace_status()


@app.post("/workspace/holdings/import")
def import_holdings(request: HoldingsImportRequest) -> dict[str, Any]:
    with connect() as db:
        db.execute("DELETE FROM holdings")
        db.executemany("INSERT INTO holdings(symbol,name,quantity,avg_cost,market_value) VALUES(?,?,?,?,?)", [(row.symbol.strip().upper(), row.name, row.quantity, row.avg_cost, row.market_value) for row in request.rows])
    audit("holdings_imported", {"rows": len(request.rows)})
    return _workspace_status()


@app.post("/backtests")
def create_backtest(request: BacktestRequest) -> dict[str, Any]:
    try:
        result = backtest_signal(request.returns, request.signals, request.cost_bps)
        payload = request.model_dump()
        payload["input_fingerprint"] = hashlib.sha256(json.dumps(payload, sort_keys=True, separators=(",", ":")).encode("utf-8")).hexdigest()
        result["experiment_id"] = save_experiment("backtest", "Imported signal backtest", payload, result)
        audit("backtest_completed", {"experiment_id": result["experiment_id"]})
        return result
    except ValueError as exc:
        raise HTTPException(422, str(exc)) from exc


@app.post("/models/ensemble")
def run_ensemble(request: EnsembleRequest) -> dict[str, Any]:
    """在已导入的真实价格数据上训练异构集成预测模型(引擎侧直接调用 / 前端 Models 页)。"""
    result = _ensemble_analysis(request.symbol, request.predict_ahead)
    trained = [symbol for symbol, model in result.get("models", {}).items() if model.get("available")]
    if trained:
        result["experiment_id"] = _save_reproducible_experiment("alpha_ensemble", "AlphaEnsemble 预测", {"predict_ahead": request.predict_ahead, "model": result["method"]}, result, trained)
    audit("ensemble_predicted", {"available": result.get("available", False), "symbols": result.get("symbols", [])})
    return result


@app.post("/portfolios/optimize")
def optimize(request: OptimizeRequest) -> dict[str, Any]:
    try:
        result = optimize_portfolio(request.expected_returns, request.return_history, request.max_weight, request.risk_aversion)
        audit("portfolio_optimized", {"assets": len(request.expected_returns)})
        return result
    except ValueError as exc:
        raise HTTPException(422, str(exc)) from exc


@app.post("/risk/report")
def risk(request: RiskRequest) -> dict[str, float]:
    try:
        return risk_report(request.returns, request.confidence)
    except ValueError as exc:
        raise HTTPException(422, str(exc)) from exc


# ---------- 因子研究 / 组合回测 ----------

@app.post("/factors/evaluate")
def evaluate_custom_factor(request: FactorEvaluateRequest) -> dict[str, Any]:
    try:
        factor_fn = compile_factor(request.code)
        panel, _ = build_panels(_price_series(), min_rows=60)
        result = evaluate_factor(factor_fn, _factor_inputs(), horizon=request.horizon, quantiles=request.quantiles)
        result["factor_name"] = request.name
        experiment_id = _save_reproducible_experiment("factor_research", request.name, {"code": request.code[:2000], "horizon": request.horizon, "quantiles": request.quantiles}, {k: v for k, v in result.items() if k != "ic_series_tail"}, result.get("symbols"))
        audit("factor_evaluated", {"experiment_id": experiment_id, "symbols": len(result.get("symbols", []))})
        return result
    except (FactorCodeError, ValueError) as exc:
        raise HTTPException(422, str(exc)) from exc


@app.post("/backtests/portfolio")
def backtest_portfolio(request: PortfolioBacktestRequest) -> dict[str, Any]:
    try:
        weights = {s.strip().upper(): float(w) for s, w in request.weights.items() if float(w) > 0}
        series = _price_series()
        closes = {}
        for symbol in weights:
            points = series.get(symbol) or series.get(_yahoo_symbol(symbol)) or []
            if len(points) >= 30:
                closes[symbol] = pd.Series({d: float(p) for d, p in points}).sort_index()
        if not closes:
            raise HTTPException(409, "给定标的均无本地价格，请先导入数据")
        result = run_portfolio_backtest(closes, weights, request.rebalance_days, request.cost_bps, request.slippage_bps)
        experiment_id = _save_reproducible_experiment("portfolio_backtest", "组合再平衡回测", {"weights": weights}, {k: v for k, v in result.items() if k not in ("nav", "benchmark_nav")}, result.get("symbols"))
        audit("portfolio_backtest_completed", {"experiment_id": experiment_id, "symbols": len(closes)})
        return result
    except BacktestDataError as exc:
        raise HTTPException(422, str(exc)) from exc


# ---------- 价格/风险预警 ----------

@app.get("/alerts")
def get_alerts() -> list[dict[str, Any]]:
    return list_alerts()


@app.put("/alerts")
def put_alert(request: AlertUpsertRequest) -> dict[str, Any]:
    if request.kind not in ALERT_KINDS:
        raise HTTPException(422, f"kind 需为 {'/'.join(ALERT_KINDS)}")
    if request.kind != "drawdown_below" and not request.symbol.strip():
        raise HTTPException(422, "除组合回撤外都需要 symbol")
    if not math.isfinite(request.threshold):
        raise HTTPException(422, "threshold 必须是有限数值")
    alert_id = (request.id or "").strip() or f"alert_{int(time.time() * 1000)}"
    stored = upsert_alert({"id": alert_id, "symbol": request.symbol.strip().upper(), "market": request.market, "kind": request.kind, "threshold": request.threshold, "note": request.note, "enabled": request.enabled, "createdAt": int(time.time() * 1000)})
    audit("alert_saved", {"id": alert_id, "kind": request.kind})
    return stored


@app.delete("/alerts/{alert_id}")
def remove_alert(alert_id: str) -> dict[str, Any]:
    return {"ok": delete_alert(alert_id)}


# ---------- 通知中心 ----------

@app.get("/notifications/recent")
def recent_notifications(limit: int = 30, unread_only: bool = False) -> dict[str, Any]:
    return {"notifications": list_notifications(limit=limit, unread_only=unread_only), "unread": unread_notification_count()}


@app.post("/notifications/read")
def read_notifications(ids: list[int] | None = None) -> dict[str, Any]:
    mark_notifications_read(ids)
    return {"ok": True}


class WebhookRequest(BaseModel):
    url: str = Field(default="", max_length=500)


@app.get("/settings/webhook")
def get_webhook() -> dict[str, Any]:
    return {"url": get_setting("webhook_url")}


@app.post("/settings/webhook")
def put_webhook(request: WebhookRequest) -> dict[str, Any]:
    url = request.url.strip()
    if url:
        try:
            url = validate_public_https_url(url)
        except UnsafeUrlError as exc:
            raise HTTPException(422, str(exc)) from exc
    set_setting("webhook_url", url)
    audit("webhook_configured", {"configured": bool(url)})
    return {"ok": True, "url": url}


# ---------- 对话线程持久化(前端 localStorage 的服务端镜像) ----------

@app.get("/chats")
def get_chats() -> list[dict[str, Any]]:
    return list_chat_threads()


@app.put("/chats/{thread_id}")
def save_chat(thread_id: str, payload: dict[str, Any]) -> dict[str, Any]:
    data = payload.get("data")
    if not isinstance(data, str) or len(data) > 2_000_000:
        raise HTTPException(422, "data 必须是对话 JSON 文本且不超过 2MB")
    upsert_chat_thread(thread_id, data, int(payload.get("updatedAt") or time.time() * 1000))
    return {"ok": True}


@app.delete("/chats/{thread_id}")
def remove_chat(thread_id: str) -> dict[str, Any]:
    clear_thread_messages(thread_id)
    return {"ok": delete_chat_thread(thread_id)}


if __name__ == "__main__":
    import uvicorn
    uvicorn.run(app, host="127.0.0.1", port=8765, reload=False, log_config=None, access_log=False)
