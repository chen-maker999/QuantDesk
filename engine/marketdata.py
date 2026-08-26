# -*- coding: utf-8 -*-
"""行情中心 provider 适配层 + /market 路由。

Provider 策略(本机实测 2026-08-25, VPN 关闭态):
- 东财 push2(push2.eastmoney.com): 实时行情/排行/搜索/分时 —— 直连 curl_cffi impersonate chrome。
  akshare 同源函数走 requests 被东财 WAF 部分拦截,故不用 akshare 的东财函数。
- 东财 np-listapi: 新闻快讯 —— curl_cffi。
- 腾讯 ifzq(web.ifzq.gtimg.cn): 日/周/月 K 线 —— curl_cffi,快(0.1-0.3s),qfq 原生。
- 腾讯分钟 K: akshare stock_zh_a_minute(其自身走可达主机)。
- 新浪: 指数日 K 回退。
- Tushare: 日 K 回退(token 从 settings 读)。
- push2his.eastmoney.com(东财历史 K 线)本机被拒连,放弃。
- 离线兜底: SQLite market_bars / market_quote_cache。

所有 fetch_* 不抛异常到 FastAPI,失败返回 {"ok":False,"error":...} + 尽量回退 SQLite。
"""
from __future__ import annotations

import json
import os
import threading
import time
from datetime import datetime, timezone
from typing import Any, Callable
from urllib.parse import urljoin

# 金融数据源直连:NO_PROXY 只限定这些域名,不影响 api.openai.com 走代理。
os.environ.setdefault(
    "NO_PROXY",
    "eastmoney.com,sinajs.cn,gtimg.cn,qq.com,ifzq.gtimg.cn,tushare.pro,10jqka.com.cn",
)
os.environ.setdefault("no_proxy", os.environ["NO_PROXY"])

from fastapi import APIRouter  # noqa: E402

try:  # 兼容 dev(.venv python engine/main.py)与打包产物
    from .database import audit, connect, get_setting, read_bars, read_quote_cache, upsert_analysis_bars, upsert_bars, upsert_quote_cache
    from .netsec import UnsafeUrlError, validate_public_https_url
except ImportError:
    try:
        from engine.database import audit, connect, get_setting, read_bars, read_quote_cache, upsert_analysis_bars, upsert_bars, upsert_quote_cache
        from engine.netsec import UnsafeUrlError, validate_public_https_url
    except ImportError:
        from database import audit, connect, get_setting, read_bars, read_quote_cache, upsert_analysis_bars, upsert_bars, upsert_quote_cache
        from netsec import UnsafeUrlError, validate_public_https_url

router = APIRouter(prefix="/market")

# ---------- 常量 ----------
_SPOT_FIELDS = "f2,f3,f4,f5,f6,f7,f8,f9,f10,f12,f13,f14,f15,f16,f17,f18,f20,f21"
# f2价格 f3涨跌幅 f4涨跌额 f5成交量 f6成交额 f7振幅 f8换手率 f9市盈率 f10市净率 f12代码 f13市场 f14名称 f15最高 f16最低 f17今开 f18昨收 f20总市值 f21流通市值
_A_SHARE_FS = "m:0+t:6,m:0+t:80,m:1+t:2,m:1+t:23,m:0+t:81+s:2048"
_RETRIES = 2
_SLEEP = 0.35
_TTL = {
    "quotes": 20,
    "indices": 20,
    "rankings": 20,
    "kline": 60,
    "minute": 60,
    "intraday": 30,
    "news": 240,
    "search": 60,
}
# 指数: (em_secid, 代码, 名称)
INDEX_LIST = [
    ("1.000001", "000001", "上证指数"),
    ("0.399001", "399001", "深证成指"),
    ("0.399006", "399006", "创业板指"),
    ("1.000300", "000300", "沪深300"),
    ("1.000905", "000905", "中证500"),
    ("1.000688", "000688", "科创50"),
    ("1.000016", "000016", "上证50"),
    ("1.000852", "000852", "中证1000"),
    ("0.899050", "899050", "北证50"),
]

_cache: dict[str, tuple[float, Any]] = {}
_cache_lock = threading.Lock()


def _cached(key: str, ttl: float, loader: Callable[[], Any]) -> Any:
    now = time.time()
    with _cache_lock:
        hit = _cache.get(key)
        if hit and now - hit[0] < ttl:
            return hit[1]
    val = loader()
    with _cache_lock:
        _cache[key] = (now, val)
    return val


def _clean(value: Any) -> Any:
    """数值清理: 东财缺值用 '-' 表示; NaN/inf → None; 数字字符串 → float(仅用于数值字段)。"""
    if value is None:
        return None
    if isinstance(value, bool):
        return value
    if isinstance(value, (int, float)):
        f = float(value)
        return f if f == f and f not in (float("inf"), float("-inf")) else None
    if isinstance(value, str):
        s = value.strip()
        if s == "-" or s == "":
            return None
        try:
            f = float(s)
            return f if f == f and f not in (float("inf"), float("-inf")) else None
        except ValueError:
            return s
    return value


def _str(value: Any) -> str:
    """字符串字段专用: 代码/名称绝不做 float 转换。"""
    if value is None:
        return ""
    return str(value).strip()


def _f(item: dict[str, Any], key: str) -> Any:
    return _clean(item.get(key))


def _exchange(code: str) -> str:
    if code.startswith(("6", "9", "5")):
        return "sh"
    if code.startswith(("0", "3", "2")):
        return "sz"
    if code.startswith(("4", "8")):
        return "bj"
    return "sh"


def _tx_symbol(code: str, market: str) -> str:
    if market == "index":
        return ("sh" if not code.startswith("399") else "sz") + code
    return _exchange(code) + code


def _em_secid(code: str, market: str) -> str:
    if market == "index":
        return ("1." if not code.startswith("399") else "0.") + code
    return ("1." if code.startswith(("6", "9", "5")) else "0.") + code


# ---------- 期货实时行情(东财 push2 ulist) ----------
# 实测(2026-08, VPN 关): 113 上期所 / 142 上期能源 / 114 大商所 / 115 郑商所 可用;
# 8 中金所 / 220 广期所 ulist.np 无响应, 该两所合约走降级(无实时价时报错)。
_FUTURES_INE = {"sc", "nr", "lu", "ec", "bc"}
_FUTURES_CZCE = {"wh", "pm", "cf", "sr", "ta", "oi", "ri", "ma", "fg", "rm", "zc", "lr", "jr", "sf", "sm", "cj", "ap", "ur", "sa", "pf", "pk", "cy", "px", "rs"}
_FUTURES_DCE = {"a", "b", "bb", "c", "cs", "fb", "i", "j", "jd", "jm", "jv", "l", "lh", "m", "p", "pg", "pp", "rr", "v", "y", "eg", "eb", "er", "lg"}


def _em_futures_secid(code: str) -> str | None:
    """'AU2610'/'au2610' → '113.au2610'; 郑商所转大写 'ma609'→'115.MA609'。未知合约返回 None。"""
    raw = code.strip()
    letters = "".join(ch for ch in raw if ch.isalpha())
    digits = "".join(ch for ch in raw if ch.isdigit())
    if not letters or not digits:
        return None
    low = letters.lower()
    if low in _FUTURES_INE:
        return f"142.{low}{digits}"
    if low in _FUTURES_CZCE:
        return f"115.{letters.upper()}{digits}"
    if low in _FUTURES_DCE:
        return f"114.{low}{digits}"
    return f"113.{low}{digits}"  # 默认上期所 au/ag/cu/al/rb/hc/ru/fu/ss/nr 等


# ---------- HTTP ----------
def _em_get(url: str, params: dict[str, str], impersonate: str = "chrome") -> dict[str, Any]:
    from curl_cffi import requests as cr

    last: Exception | None = None
    for _ in range(_RETRIES + 1):
        try:
            response = cr.get(url, params=params, impersonate=impersonate, timeout=8)
            response.raise_for_status()
            return response.json()
        except Exception as exc:  # noqa: BLE001
            last = exc
            time.sleep(_SLEEP)
    raise last  # type: ignore[misc]


def _tushare_token() -> str:
    return get_setting("tushare_token", "")


def _tushare_daily(code: str, market: str, limit: int = 320) -> list[dict[str, Any]]:
    import httpx

    token = _tushare_token()
    if not token:
        return []
    ts_code = (f"{code}.SH" if market == "index" or code.startswith("6") else f"{code}.SZ")
    api_name = "index_daily" if market == "index" else "daily"
    body = {
        "api_name": api_name,
        "token": token,
        "params": {"ts_code": ts_code},
        "fields": "trade_date,open,high,low,close,vol,amount",
    }
    response = httpx.post("https://api.tushare.pro", json=body, timeout=15)
    payload = response.json()
    if payload.get("code") != 0:
        return []
    data = payload.get("data") or {}
    fields = data.get("fields") or []
    items = data.get("items") or []
    idx = {name: i for i, name in enumerate(fields)}
    bars: list[dict[str, Any]] = []
    for item in items[-limit:]:
        d = str(item[idx["trade_date"]])
        ts = f"{d[:4]}-{d[4:6]}-{d[6:8]}" if len(d) == 8 else d
        bars.append({
            "ts": ts,
            "open": _clean(item[idx.get("open", -1)]),
            "high": _clean(item[idx.get("high", -1)]),
            "low": _clean(item[idx.get("low", -1)]),
            "close": _clean(item[idx["close"]]),
            "volume": _clean(item[idx.get("vol", -1)]),
            "amount": _clean(item[idx.get("amount", -1)]),
        })
    return bars


# ---------- 行情 ----------
def _parse_spot_row(row: dict[str, Any], market: str) -> dict[str, Any]:
    return {
        "market": market,
        "symbol": _str(row.get("f12")),
        "name": _str(row.get("f14")),
        "price": _f(row, "f2"),
        "change_pct": _f(row, "f3"),
        "change_amt": _f(row, "f4"),
        "open": _f(row, "f17"),
        "high": _f(row, "f15"),
        "low": _f(row, "f16"),
        "prev_close": _f(row, "f18"),
        "volume": _f(row, "f5"),
        "amount": _f(row, "f6"),
        "turnover_rate": _f(row, "f8"),
        "pe": _f(row, "f9"),
        "pb": _f(row, "f10"),
        "source": "eastmoney",
    }


def _fetch_indices() -> dict[str, Any]:
    secids = ",".join(s for s, _, _ in INDEX_LIST)
    payload = _em_get(
        "https://push2.eastmoney.com/api/qt/ulist.np/get",
        {"fltt": "2", "invt": "2", "fields": _SPOT_FIELDS, "secids": secids},
    )
    diff = (payload.get("data") or {}).get("diff") or []
    by_code = {_str(row.get("f12")): row for row in diff}
    indices: list[dict[str, Any]] = []
    for secid, code, name in INDEX_LIST:
        row = by_code.get(code)
        if not row:
            continue
        item = _parse_spot_row(row, "index")
        item["name"] = name
        indices.append(item)
    return {"indices": indices}


def _fetch_quotes(codes: list[str], market: str = "a") -> dict[str, Any]:
    if market == "index":
        secids = ",".join(_em_secid(c, "index") for c in codes)
        payload = _em_get(
            "https://push2.eastmoney.com/api/qt/ulist.np/get",
            {"fltt": "2", "invt": "2", "fields": _SPOT_FIELDS, "secids": secids},
        )
        diff = (payload.get("data") or {}).get("diff") or []
        quotes = [_parse_spot_row(row, "index") for row in diff]
    else:
        secids = ",".join(_em_secid(c, "a") for c in codes)
        payload = _em_get(
            "https://push2.eastmoney.com/api/qt/ulist.np/get",
            {"fltt": "2", "invt": "2", "fields": _SPOT_FIELDS, "secids": secids},
        )
        diff = (payload.get("data") or {}).get("diff") or []
        quotes = [_parse_spot_row(row, "a") for row in diff]
    return {"quotes": quotes}


def _fetch_futures_quotes(codes: list[str]) -> dict[str, Any]:
    secids: list[str] = []
    for c in codes:
        sid = _em_futures_secid(c)
        if sid:
            secids.append(sid)
    if not secids:
        return {"quotes": []}
    payload = _em_get(
        "https://push2.eastmoney.com/api/qt/ulist.np/get",
        {"fltt": "2", "invt": "2", "fields": _SPOT_FIELDS, "secids": ",".join(secids)},
    )
    diff = (payload.get("data") or {}).get("diff") or []
    if isinstance(diff, dict):
        diff = list(diff.values())
    return {"quotes": [_parse_spot_row(row, "futures") for row in diff]}


def _fetch_rankings(sort: str, order: str, limit: int) -> dict[str, Any]:
    """新浪 getHQNodeData 排行(东财 clist 本机被限频/反爬,新浪稳定)。"""
    from curl_cffi import requests as cr

    sort_key = {"change_pct": "changepercent", "amount": "amount", "turnover": "turnoverratio"}.get(sort, "changepercent")
    asc = "1" if order == "asc" else "0"
    url = "https://vip.stock.finance.sina.com.cn/quotes_service/api/json_v2.php/Market_Center.getHQNodeData"
    params = {"page": "1", "num": str(limit), "sort": sort_key, "asc": asc, "node": "hs_a", "symbol": "", "_s_r_a": "init"}
    last: Exception | None = None
    for _ in range(_RETRIES + 1):
        try:
            response = cr.get(url, params=params, impersonate="chrome", timeout=8)
            response.raise_for_status()
            rows = response.json()
            break
        except Exception as exc:  # noqa: BLE001
            last = exc
            rows = []
            time.sleep(_SLEEP)
    else:
        raise last  # type: ignore[misc]

    rankings: list[dict[str, Any]] = []
    for row in rows or []:
        code = str(row.get("code") or "")
        name = str(row.get("name") or "")
        if not code or not name:
            continue
        rankings.append({
            "market": "a",
            "symbol": code,
            "name": name,
            "price": _clean(row.get("trade")),
            "change_pct": _clean(row.get("changepercent")),
            "change_amt": _clean(row.get("pricechange")),
            "open": _clean(row.get("open")),
            "high": _clean(row.get("high")),
            "low": _clean(row.get("low")),
            "prev_close": _clean(row.get("settlement")),
            "volume": _clean(row.get("volume")),
            "amount": _clean(row.get("amount")),
            "turnover_rate": _clean(row.get("turnoverratio")),
            "pe": _clean(row.get("per")),
            "pb": _clean(row.get("pb")),
            "source": "sina",
        })
    return {"rankings": rankings}


# ---------- K 线 ----------
def _tx_kline(code: str, market: str, period: str, adjust: str, limit: int) -> list[dict[str, Any]]:
    """腾讯 ifzq fqkline: day/week/month。period_map → 'day'|'week'|'month'。"""
    sym = _tx_symbol(code, market)
    tx_period = {"daily": "day", "weekly": "week", "monthly": "month"}[period]
    adj = {"qfq": "qfq", "hfq": "hfq"}.get(adjust, "")
    param = f"{sym},{tx_period},,,{limit},{adj}"
    payload = _em_get("https://web.ifzq.gtimg.cn/appstock/app/fqkline/get", {"param": param})
    data = (payload.get("data") or {}).get(sym) or {}
    key = f"{adj}{tx_period}" if adj else tx_period
    rows = data.get(key) or data.get(tx_period) or []
    bars: list[dict[str, Any]] = []
    prev_close: float | None = None
    for row in rows:
        try:
            ts, open_, close_, high_, low_ = str(row[0]), float(row[1]), float(row[2]), float(row[3]), float(row[4])
            vol = _clean(row[5]) if len(row) > 5 else None
        except (IndexError, TypeError, ValueError):
            continue
        change_pct = ((close_ / prev_close) - 1) * 100 if prev_close else None
        prev_close = close_
        bars.append({
            "ts": ts, "open": open_, "high": high_, "low": low_, "close": close_,
            "volume": vol, "amount": None, "change_pct": change_pct, "turnover_rate": None,
        })
    return bars


def _minute_kline(code: str, period: str, limit: int) -> list[dict[str, Any]]:
    import akshare as ak

    sym = _tx_symbol(code, "a")
    df = ak.stock_zh_a_minute(symbol=sym, period=period, adjust="")
    if df is None or len(df) == 0:
        return []
    bars: list[dict[str, Any]] = []
    prev_close: float | None = None
    for _, row in df.tail(limit).iterrows():
        try:
            close_ = float(row["close"])
        except (TypeError, ValueError):
            continue
        change_pct = ((close_ / prev_close) - 1) * 100 if prev_close else None
        prev_close = close_
        bars.append({
            "ts": str(row["day"]),
            "open": _clean(row.get("open")),
            "high": _clean(row.get("high")),
            "low": _clean(row.get("low")),
            "close": close_,
            "volume": _clean(row.get("volume")),
            "amount": _clean(row.get("amount")),
            "change_pct": change_pct,
            "turnover_rate": None,
        })
    return bars


def _intraday(code: str, market: str) -> list[dict[str, Any]]:
    secid = _em_secid(code, market)
    payload = _em_get(
        "https://push2.eastmoney.com/api/qt/stock/trends2/get",
        {
            "secid": secid,
            "fields1": "f1,f2,f3,f4,f5,f6,f7,f8,f9,f10,f11,f12,f13",
            "fields2": "f51,f52,f53,f54,f55,f56,f57,f58",
            "ndays": "1", "iscr": "0",
        },
    )
    trends = (payload.get("data") or {}).get("trends") or []
    points: list[dict[str, Any]] = []
    for line in trends:
        parts = str(line).split(",")
        if len(parts) < 8:
            continue
        points.append({
            "ts": parts[0],
            "price": _clean(parts[2]),
            "avg_price": _clean(parts[7]),
            "volume": _clean(parts[5]),
        })
    return points


# ---------- 个股详情(资金流/市值/量比/市盈) ----------
_DETAIL_FIELDS = (
    "f43,f44,f45,f46,f48,f50,f57,f58,f60,f116,f117,f135,f136,f137,f138,f139,"
    "f140,f141,f142,f143,f144,f145,f146,f162,f167,f178"
)


def _fetch_quote_detail(code: str, market: str) -> dict[str, Any]:
    """单标的 stock/get: 富化行情(总/流通市值、资金流、市盈、量比原始值、5日主力净)。"""
    secid = _em_secid(code, market)
    payload = _em_get(
        "https://push2.eastmoney.com/api/qt/stock/get",
        {"secid": secid, "fltt": "2", "invt": "2", "fields": _DETAIL_FIELDS},
    )
    d = payload.get("data") or {}
    main_net = (_clean(d.get("f137")) or 0) + (_clean(d.get("f140")) or 0)
    flow = {
        "main_net": main_net,                     # 主力净流入 = 超大单 + 大单
        "xl_in": _clean(d.get("f135")), "xl_out": _clean(d.get("f136")), "xl_net": _clean(d.get("f137")),
        "big_in": _clean(d.get("f138")), "big_out": _clean(d.get("f139")), "big_net": _clean(d.get("f140")),
        "mid_in": _clean(d.get("f141")), "mid_out": _clean(d.get("f142")), "mid_net": _clean(d.get("f143")),
        "small_in": _clean(d.get("f144")), "small_out": _clean(d.get("f145")), "small_net": _clean(d.get("f146")),
    }
    main_5d: list[dict[str, Any]] = []
    f178 = d.get("f178") or []
    if isinstance(f178, str):
        try:
            f178 = json.loads(f178)
        except (ValueError, TypeError):
            f178 = []
    for item in f178 if isinstance(f178, list) else []:
        if isinstance(item, dict):
            main_5d.append({"ts": str(item.get("date") or ""), "main_net": _clean(item.get("mainNetAmt"))})
    return {
        "market": market,
        "symbol": _str(d.get("f57")),
        "name": _str(d.get("f58")),
        "price": _clean(d.get("f43")),
        "open": _clean(d.get("f46")),
        "high": _clean(d.get("f44")),
        "low": _clean(d.get("f45")),
        "amount": _clean(d.get("f48")),
        "price_avg": _clean(d.get("f60")),
        "pb": _clean(d.get("f50")),
        "pe": _clean(d.get("f162")),
        "market_cap": _clean(d.get("f116")),      # 元
        "float_cap": _clean(d.get("f117")),       # 元
        "volume_ratio_raw": _clean(d.get("f167")),  # 疑似量比,前端可回退自算
        "money_flow": flow,
        "main_net_5d": main_5d,
    }


# ---------- 资金流 K 线(大单/主力净量序列) ----------
def _fetch_fflow(code: str, market: str, limit: int) -> dict[str, Any]:
    secid = _em_secid(code, market)
    payload = _em_get(
        "https://push2.eastmoney.com/api/qt/stock/fflow/kline/get",
        {"secid": secid, "lmt": str(limit), "klt": "101", "fields1": "f1,f2,f3,f7", "fields2": "f51,f52,f53,f54,f55,f56"},
    )
    klines = (payload.get("data") or {}).get("klines") or []
    # 每行: 日期,主力净,小单净,中单净,大单净,超大单净
    out: list[dict[str, Any]] = []
    for line in klines[-limit:]:
        parts = str(line).split(",")
        if len(parts) < 6:
            continue
        out.append({
            "ts": parts[0],
            "main_net": _clean(parts[1]),
            "small_net": _clean(parts[2]),
            "mid_net": _clean(parts[3]),
            "big_net": _clean(parts[4]),
            "xl_net": _clean(parts[5]),
        })
    return {"symbol": code, "market": market, "items": out}


# ---------- 北向资金(尽力而为: 实时已停披露,取日度汇总) ----------
def _fetch_hsgt() -> dict[str, Any]:
    """沪深股通/港股通日度资金汇总。2024-08 起实时成交/净买不再披露,故仅日度+提示。"""
    try:
        import akshare as ak  # noqa: PLC0415

        df = ak.stock_hsgt_fund_flow_summary_em()
        if df is None or len(df) == 0:
            raise ValueError("empty")
            rows: list[dict[str, Any]] = []
        for _, r in df.iterrows():
            rows.append({
                "name": str(r.get("资金方向") or ""),
                "net_buy": _clean(r.get("当日成交净买额")),
                "turnover": _clean(r.get("当日资金流入")),
                "quota_left": _clean(r.get("当日余额")),
            })
        net_unavailable = all(row["net_buy"] is None for row in rows)
        return {"available": True, "realtime_discontinued": True, "net_unavailable": net_unavailable, "rows": rows}
    except Exception as exc:  # noqa: BLE001
        return {"available": False, "realtime_discontinued": True, "error": f"{type(exc).__name__}: {exc}", "rows": []}


# ---------- 新闻 / 搜索 ----------
def _fetch_news(limit: int) -> dict[str, Any]:
    """东财要闻资讯（带真实封面图 image、文章链接 url、来源 mediaName、较长摘要）。"""
    payload = _em_get(
        "https://np-listapi.eastmoney.com/comm/web/getNewsByColumns",
        {"client": "web", "biz": "web_724", "column": "345", "order": "1", "needInteractData": "0", "page_index": "1", "page_size": str(limit), "req_trace": "1"},
    )
    items = ((payload.get("data") or {}).get("list")) or []
    news: list[dict[str, Any]] = []
    for item in items:
        stock_list = item.get("stockList") or []
        related = [
            {
                "symbol": str(st.get("Code") or st.get("code") or ""),
                "name": str(st.get("Name") or st.get("name") or ""),
            }
            for st in stock_list if isinstance(st, dict)
        ]
        news.append({
            "id": str(item.get("code") or ""),
            "title": str(item.get("title") or "").strip(),
            "content": str(item.get("summary") or "").strip(),
            "source": str(item.get("mediaName") or "东方财富"),
            "time": str(item.get("showTime") or ""),
            "url": str(item.get("url") or "").strip(),
            "image": str(item.get("image") or ""),
            "related": related,
        })
    return {"news": news}


def _fetch_article(url: str) -> dict[str, Any]:
    """抓取东财文章正文（最详细内容）。返回 title/content/image。"""
    from curl_cffi import requests as cr
    import html as htmlmod
    import re as remod

    last: Exception | None = None
    for _ in range(_RETRIES + 1):
        try:
            current_url = validate_public_https_url(url)
            for _redirect in range(4):
                response = cr.get(current_url, impersonate="chrome", timeout=12, allow_redirects=False)
                if response.status_code not in {301, 302, 303, 307, 308}:
                    break
                location = response.headers.get("location")
                if not location:
                    raise ValueError("重定向响应缺少 Location")
                current_url = validate_public_https_url(urljoin(current_url, location))
            else:
                raise ValueError("重定向次数超过限制")
            response.raise_for_status()
            page = response.text
            # 正文容器:东财为 txtinfos,回退 id="ContentBody"
            m = remod.search(r'<div[^>]*class="txtinfos"[^>]*>(.*?)</div>', page, remod.S)
            if not m:
                m = remod.search(r'<div[^>]*id="ContentBody"[^>]*>(.*?)</div>', page, remod.S)
            body = ""
            if m:
                seg = m.group(1)
                seg = remod.sub(r"<(script|style)[^>]*>.*?</\1>", "", seg, flags=remod.S)
                body = htmlmod.unescape(remod.sub(r"<[^>]+>", "", seg)).strip()
                body = remod.sub(r"\n{3,}", "\n\n", body)
            tm = remod.search(r"<h1[^>]*>(.*?)</h1>", page, remod.S)
            title = htmlmod.unescape(remod.sub(r"<[^>]+>", "", tm.group(1))).strip() if tm else ""
            if not title:
                tm2 = remod.search(r"<title>(.*?)</title>", page, remod.S)
                if tm2:
                    t_raw = htmlmod.unescape(remod.sub(r"<[^>]+>", "", tm2.group(1))).strip()
                    title = remod.split(r"_\s*", t_raw)[0].strip()
            im = remod.search(r'<meta[^>]*property="og:image"[^>]*content="([^"]+)"', page)
            image = im.group(1) if im else ""
            if image:
                try:
                    image = validate_public_https_url(urljoin(current_url, image))
                except UnsafeUrlError:
                    image = ""
            if body:
                return {"title": title, "content": body, "image": image}
            return {"error": "正文为空"}
        except Exception as exc:  # noqa: BLE001
            last = exc
            time.sleep(_SLEEP)
    return {"error": f"无法获取正文: {last}" if last else "无法获取正文"}


_INDEX_NAMES = {"上证指数", "深证成指", "创业板指", "沪深300", "中证500", "科创50", "上证50", "中证1000", "北证50"}


def _search(q: str) -> dict[str, Any]:
    payload = _em_get(
        "https://searchapi.eastmoney.com/api/suggest/get",
        {"input": q, "type": "14", "token": "D43BF722C8E33BDC906FB84D85E326E8", "count": "20"},
    )
    qct = payload.get("QuotationCodeTable") or {}
    items = qct.get("Data") if isinstance(qct, dict) else qct
    results: list[dict[str, Any]] = []
    for item in items or []:
        code = str(item.get("Code") or "")
        name = str(item.get("Name") or "")
        if not code or not name:
            continue
        mkt = int(item.get("MktNum") or -1)
        if mkt not in (0, 1):  # Phase 1 只做 A 股(沪/深/北),港/美留 Phase 2
            continue
        if name in _INDEX_NAMES:
            results.append({"market": "index", "symbol": code, "name": name, "type": "index"})
        else:
            results.append({"market": "a", "symbol": code, "name": name, "type": "stock"})
    return {"results": results}


# ---------- 兜底: SQLite ----------
def _from_cache_quotes(codes: list[str], market: str) -> dict[str, Any]:
    rows = read_quote_cache(markets=[market], symbols=codes, limit=max(len(codes), 50))
    if not rows:
        rows = read_quote_cache(symbols=codes, limit=max(len(codes), 50))
    return {"quotes": [dict(r) for r in rows]}


def _from_cache_indices() -> dict[str, Any]:
    codes = [c for _, c, _ in INDEX_LIST]
    rows = read_quote_cache(markets=["index"], symbols=codes, limit=50)
    return {"indices": [dict(r) for r in rows]}


def _from_cache_rankings(limit: int) -> dict[str, Any]:
    rows = read_quote_cache(markets=["a"], limit=limit)
    return {"rankings": [dict(r) for r in rows]}


def _from_cache_kline(market: str, symbol: str, period: str, adjust: str, limit: int) -> list[dict[str, Any]]:
    return read_bars(market, symbol, period, adjust, limit)


# ---------- 组装端点 ----------
def _persist_quotes(quotes: list[dict[str, Any]]) -> None:
    if quotes:
        upsert_quote_cache(quotes)


def _persist_bars(market: str, symbol: str, period: str, adjust: str, bars: list[dict[str, Any]], source: str) -> None:
    if not bars:
        return
    upsert_bars([
        {**b, "market": market, "symbol": symbol, "period": period, "adjust": adjust, "source": source}
        for b in bars
    ])


def _now_iso() -> str:
    return datetime.now(timezone.utc).isoformat(timespec="seconds")


@router.get("/indices")
def market_indices() -> dict[str, Any]:
    def loader() -> dict[str, Any]:
        return _fetch_indices()

    try:
        data = _cached("indices", _TTL["indices"], loader)
        _persist_quotes(data.get("indices", []))
        return {"ok": True, "source": "eastmoney", "updated_at": _now_iso(), "stale": False, "cached_from_db": False, **data}
    except Exception as exc:  # noqa: BLE001
        try:
            fb = _from_cache_indices()
            return {"ok": False, "error": f"{type(exc).__name__}: {exc}", "stale": True, "cached_from_db": True, **fb}
        except Exception:  # noqa: BLE001
            return {"ok": False, "error": f"{type(exc).__name__}: {exc}", "stale": True, "cached_from_db": False, "indices": []}


@router.get("/quotes")
def market_quotes(symbols: str, market: str = "") -> dict[str, Any]:
    codes = [s.strip() for s in symbols.split(",") if s.strip()][:20]
    if not codes:
        return {"ok": False, "error": "symbols 不能为空", "quotes": []}
    if market == "futures":
        try:
            data = _cached(f"quotes:futures:{','.join(codes)}", _TTL["quotes"], lambda: _fetch_futures_quotes(codes))
            _persist_quotes(data.get("quotes", []))
            return {"ok": True, "source": "eastmoney", "updated_at": _now_iso(), "stale": False, "cached_from_db": False, **data}
        except Exception as exc:  # noqa: BLE001
            return {"ok": False, "error": f"{type(exc).__name__}: {exc}", "stale": True, "cached_from_db": False, "quotes": []}
    if market not in ("a", "index"):
        # 自动探测: 全部是指数代码(399/899 开头,或 000001 短列表)才当作指数
        market = "index" if all(c.startswith(("399", "899")) or c == "000001" for c in codes) and len(codes) <= 3 else "a"
    try:
        data = _cached(f"quotes:{market}:{','.join(codes)}", _TTL["quotes"], lambda: _fetch_quotes(codes, market))
        _persist_quotes(data.get("quotes", []))
        return {"ok": True, "source": "eastmoney", "updated_at": _now_iso(), "stale": False, "cached_from_db": False, **data}
    except Exception as exc:  # noqa: BLE001
        try:
            fb = _from_cache_quotes(codes, market)
            return {"ok": False, "error": f"{type(exc).__name__}: {exc}", "stale": True, "cached_from_db": True, **fb}
        except Exception:  # noqa: BLE001
            return {"ok": False, "error": f"{type(exc).__name__}: {exc}", "stale": True, "cached_from_db": False, "quotes": []}


@router.get("/rankings")
def market_rankings(sort: str = "change_pct", order: str = "desc", limit: int = 20) -> dict[str, Any]:
    sort = sort if sort in ("change_pct", "amount", "turnover") else "change_pct"
    order = order if order in ("asc", "desc") else "desc"
    limit = max(1, min(int(limit), 100))
    try:
        data = _cached(f"rankings:{sort}:{order}:{limit}", _TTL["rankings"], lambda: _fetch_rankings(sort, order, limit))
        _persist_quotes(data.get("rankings", []))
        return {"ok": True, "source": "sina", "updated_at": _now_iso(), "stale": False, "cached_from_db": False, **data}
    except Exception as exc:  # noqa: BLE001
        try:
            fb = _from_cache_rankings(limit)
            return {"ok": False, "error": f"{type(exc).__name__}: {exc}", "stale": True, "cached_from_db": True, **fb}
        except Exception:  # noqa: BLE001
            return {"ok": False, "error": f"{type(exc).__name__}: {exc}", "stale": True, "cached_from_db": False, "rankings": []}


@router.get("/kline")
def market_kline(symbol: str, market: str = "a", period: str = "daily", adjust: str = "qfq", limit: int = 320) -> dict[str, Any]:
    symbol = symbol.strip()
    market = market if market in ("a", "index") else "a"
    period = period if period in ("daily", "weekly", "monthly", "1", "5", "15", "30", "60", "intraday") else "daily"
    adjust = adjust if adjust in ("qfq", "hfq", "") else "qfq"
    limit = max(20, min(int(limit), 320))

    if period == "intraday":
        try:
            points = _cached(f"intraday:{market}:{symbol}", _TTL["intraday"], lambda: _intraday(symbol, market))
            return {"ok": True, "source": "eastmoney", "updated_at": _now_iso(), "stale": False, "cached_from_db": False, "market": market, "symbol": symbol, "period": "intraday", "bars": points}
        except Exception as exc:  # noqa: BLE001
            return {"ok": False, "error": f"{type(exc).__name__}: {exc}", "stale": True, "cached_from_db": False, "bars": []}

    if period in ("1", "5", "15", "30", "60"):
        try:
            bars = _cached(f"minute:{market}:{symbol}:{period}:{limit}", _TTL["minute"], lambda: _minute_kline(symbol, period, limit))
            if bars:
                _persist_bars(market, symbol, period, adjust, bars, "tencent")
            return {"ok": True, "source": "tencent", "updated_at": _now_iso(), "stale": False, "cached_from_db": False, "market": market, "symbol": symbol, "period": period, "adjust": adjust, "bars": bars}
        except Exception as exc:  # noqa: BLE001
            try:
                fb = _from_cache_kline(market, symbol, period, adjust, limit)
                return {"ok": False, "error": f"{type(exc).__name__}: {exc}", "stale": True, "cached_from_db": True, "market": market, "symbol": symbol, "period": period, "adjust": adjust, "bars": fb}
            except Exception:  # noqa: BLE001
                return {"ok": False, "error": f"{type(exc).__name__}: {exc}", "stale": True, "cached_from_db": False, "bars": []}

    # 日/周/月 K: 腾讯优先,Tushare 回退
    try:
        bars = _cached(f"kline:{market}:{symbol}:{period}:{adjust}:{limit}", _TTL["kline"], lambda: _tx_kline(symbol, market, period, adjust, limit))
        if not bars and _tushare_token():
            bars = _tushare_daily(symbol, market, limit)
        if bars:
            _persist_bars(market, symbol, period, adjust, bars, "tencent")
        return {"ok": True, "source": "tencent" if bars else "empty", "updated_at": _now_iso(), "stale": False, "cached_from_db": False, "market": market, "symbol": symbol, "period": period, "adjust": adjust, "bars": bars}
    except Exception as exc:  # noqa: BLE001
        try:
            if _tushare_token():
                try:
                    bars = _tushare_daily(symbol, market, limit)
                    if bars:
                        _persist_bars(market, symbol, period, adjust, bars, "tushare")
                        return {"ok": True, "source": "tushare", "updated_at": _now_iso(), "stale": False, "cached_from_db": False, "market": market, "symbol": symbol, "period": period, "adjust": adjust, "bars": bars}
                except Exception:  # noqa: BLE001
                    pass
            fb = _from_cache_kline(market, symbol, period, adjust, limit)
            return {"ok": False, "error": f"{type(exc).__name__}: {exc}", "stale": True, "cached_from_db": True, "market": market, "symbol": symbol, "period": period, "adjust": adjust, "bars": fb}
        except Exception:  # noqa: BLE001
            return {"ok": False, "error": f"{type(exc).__name__}: {exc}", "stale": True, "cached_from_db": False, "bars": []}


@router.post("/import-prices")
def market_import_prices(symbol: str, market: str = "a", adjust: str = "qfq", limit: int = 320) -> dict[str, Any]:
    """把行情中心拉到的某标的日 K 固化进工作区分析库(market_prices)。"""
    return import_daily_prices(symbol, market, adjust, limit)


def import_daily_prices(symbol: str, market: str = "a", adjust: str = "qfq", limit: int = 320) -> dict[str, Any]:
    """行情 → 工作区分析库 的桥：取日 K 收盘写入 market_prices。
    指数以 {symbol}.IDX 后缀存储，避免与同名个股冲突。此后 scan_alpha_signals 等
    基于导入价格的 Agent 工具即可对该标的分析。"""
    symbol = symbol.strip()
    market = market if market in ("a", "index") else "a"
    adjust = adjust if adjust in ("qfq", "hfq", "") else "qfq"
    limit = max(20, min(int(limit or 320), 320))
    result = market_kline(symbol=symbol, market=market, period="daily", adjust=adjust, limit=limit)
    bars = result.get("bars") or []
    stored_symbol = f"{symbol}.IDX" if market == "index" else symbol
    rows = [(stored_symbol, str(b["ts"])[:10], float(b["close"])) for b in bars if b.get("ts") and b.get("close") is not None]
    if not rows:
        return {"ok": False, "error": f"{symbol} 没有可用日 K 数据({result.get('error') or 'empty'})"}
    with connect() as db:
        db.executemany("INSERT OR REPLACE INTO market_prices(symbol,trade_date,close,source) VALUES(?,?,?,?)", [(s, d, c, "market_bars") for s, d, c in rows])
    source = str(result.get("source") or "market_bars")
    analysis_rows = [{"symbol": stored_symbol, "trade_date": str(bar["ts"])[:10], "market": market, "adjust": adjust, "source": source, "open": bar.get("open"), "high": bar.get("high"), "low": bar.get("low"), "close": bar.get("close"), "volume": bar.get("volume"), "amount": bar.get("amount")} for bar in bars if bar.get("ts") and bar.get("close") is not None]
    upsert_analysis_bars(analysis_rows)
    audit("market_prices_imported", {"provider": source, "symbol": stored_symbol, "rows": len(rows), "ohlcv_rows": len(analysis_rows), "adjust": adjust})
    return {"ok": True, "symbol": stored_symbol, "market": market, "adjust": adjust, "rows": len(rows), "ohlcv_rows": len(analysis_rows), "start": rows[0][1], "end": rows[-1][1], "source": source}


@router.get("/news")
def market_news(limit: int = 30) -> dict[str, Any]:
    limit = max(5, min(int(limit), 100))
    try:
        data = _cached(f"news:{limit}", _TTL["news"], lambda: _fetch_news(limit))
        return {"ok": True, "source": "eastmoney", "updated_at": _now_iso(), "stale": False, "cached_from_db": False, **data}
    except Exception as exc:  # noqa: BLE001
        return {"ok": False, "error": f"{type(exc).__name__}: {exc}", "stale": True, "cached_from_db": False, "news": []}


@router.get("/news/detail")
def market_news_detail(url: str) -> dict[str, Any]:
    url = url.strip()
    if not url:
        return {"ok": False, "error": "缺少文章链接 url", "content": ""}
    try:
        safe_url = validate_public_https_url(url)
        data = _cached(f"news-detail:{safe_url}", 600, lambda: _fetch_article(safe_url))
        return {"ok": True, "source": "eastmoney", **data}
    except UnsafeUrlError as exc:
        return {"ok": False, "error": str(exc), "content": ""}
    except Exception as exc:  # noqa: BLE001
        return {"ok": False, "error": f"{type(exc).__name__}: {exc}", "content": ""}


@router.get("/detail")
def market_detail(symbol: str, market: str = "a") -> dict[str, Any]:
    symbol = symbol.strip()
    market = market if market in ("a", "index") else "a"
    try:
        data = _cached(f"detail:{market}:{symbol}", _TTL["quotes"], lambda: _fetch_quote_detail(symbol, market))
        return {"ok": True, "source": "eastmoney", "updated_at": _now_iso(), "stale": False, "cached_from_db": False, **data}
    except Exception as exc:  # noqa: BLE001
        return {"ok": False, "error": f"{type(exc).__name__}: {exc}", "stale": True, "cached_from_db": False, "detail": None}


@router.get("/fflow")
def market_fflow(symbol: str, market: str = "a", limit: int = 20) -> dict[str, Any]:
    symbol = symbol.strip()
    market = market if market in ("a", "index") else "a"
    limit = max(5, min(int(limit), 120))
    try:
        data = _cached(f"fflow:{market}:{symbol}:{limit}", _TTL["quotes"], lambda: _fetch_fflow(symbol, market, limit))
        return {"ok": True, "source": "eastmoney", "updated_at": _now_iso(), "stale": False, "cached_from_db": False, **data}
    except Exception as exc:  # noqa: BLE001
        return {"ok": False, "error": f"{type(exc).__name__}: {exc}", "stale": True, "cached_from_db": False, "items": []}


@router.get("/hsgt")
def market_hsgt() -> dict[str, Any]:
    try:
        data = _cached("hsgt", 300, _fetch_hsgt)
        return {"ok": True, "updated_at": _now_iso(), "stale": False, **data}
    except Exception as exc:  # noqa: BLE001
        return {"ok": False, "error": f"{type(exc).__name__}: {exc}", "stale": True, "available": False, "realtime_discontinued": True, "rows": []}


@router.get("/search")
def market_search(q: str) -> dict[str, Any]:
    q = q.strip()
    if not q:
        return {"ok": False, "error": "q 不能为空", "results": []}
    try:
        data = _cached(f"search:{q}", _TTL["search"], lambda: _search(q))
        return {"ok": True, "source": "eastmoney", "updated_at": _now_iso(), "stale": False, "cached_from_db": False, **data}
    except Exception as exc:  # noqa: BLE001
        # 搜索失败回退: 指数列表 + 缓存快照子串匹配
        try:
            results: list[dict[str, Any]] = []
            for _, code, name in INDEX_LIST:
                if q in name or q in code:
                    results.append({"market": "index", "symbol": code, "name": name, "type": "index"})
            for row in read_quote_cache(limit=300):
                if q in str(row.get("name", "")) or q in str(row.get("symbol", "")):
                    results.append({"market": row["market"], "symbol": row["symbol"], "name": row["name"], "type": "index" if row["market"] == "index" else "stock"})
            seen: set[str] = set()
            dedup: list[dict[str, Any]] = []
            for r in results:
                key = f"{r['market']}:{r['symbol']}"
                if key not in seen:
                    seen.add(key)
                    dedup.append(r)
            return {"ok": True, "source": "cache", "updated_at": _now_iso(), "stale": True, "cached_from_db": True, "results": dedup[:20]}
        except Exception:  # noqa: BLE001
            return {"ok": False, "error": f"{type(exc).__name__}: {exc}", "stale": True, "cached_from_db": False, "results": []}
