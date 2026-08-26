"""本地 OMS 券商适配层。

券商凭据不写入 SQLite；桌面端从 Windows Credential Manager 取出后，经本地
鉴权通道注入本模块的内存。Agent 没有调用本路由的工具定义，真实下单只能由
用户在 OMS 页面发起。Alpaca 支持官方 REST 交易 API；IBKR 使用用户本机已登录
的 Client Portal Gateway，因而不接收也不保存 IBKR 登录密码。
"""
from __future__ import annotations

import math
import time
import uuid
from typing import Any
from urllib.parse import urlparse

import httpx
from fastapi import APIRouter, HTTPException, Query
from pydantic import BaseModel, Field, field_validator, model_validator

try:
    from .database import audit
except ImportError:  # 兼容打包的入口方式
    try:
        from engine.database import audit
    except ImportError:
        from database import audit


router = APIRouter(prefix="/brokers")
SUPPORTED_BROKERS = {"alpaca", "ibkr"}
ALPACA_PAPER_URL = "https://paper-api.alpaca.markets"
ALPACA_LIVE_URL = "https://api.alpaca.markets"
IBKR_DEFAULT_GATEWAY = "https://localhost:5000/v1/api"
LIVE_CONFIRMATION = "ENABLE LIVE TRADING"
LIVE_ARM_SECONDS = 300


class BrokerError(RuntimeError):
    """可安全展示给桌面用户的券商适配错误。"""


def _number(value: Any, default: float = 0.0) -> float:
    try:
        parsed = float(value)
    except (TypeError, ValueError):
        return default
    return parsed if math.isfinite(parsed) else default


def _clean_symbol(value: str) -> str:
    symbol = value.strip().upper()
    if not symbol or len(symbol) > 32 or not all(ch.isalnum() or ch in ".-_/" for ch in symbol):
        raise BrokerError("标的代码无效")
    return symbol


def _gateway_url(value: str) -> str:
    url = (value or IBKR_DEFAULT_GATEWAY).strip().rstrip("/")
    parsed = urlparse(url)
    if parsed.scheme not in {"http", "https"} or parsed.username or parsed.password:
        raise BrokerError("IBKR Gateway 地址必须是本机 http(s) 地址")
    if (parsed.hostname or "").lower() not in {"localhost", "127.0.0.1", "::1"}:
        raise BrokerError("IBKR Gateway 仅允许连接本机回环地址")
    if parsed.path.rstrip("/") != "/v1/api" or parsed.query or parsed.fragment:
        raise BrokerError("IBKR Gateway 地址必须以 /v1/api 结尾")
    return url


class BrokerConfigureRequest(BaseModel):
    broker: str = Field(pattern="^(alpaca|ibkr)$")
    credentials: dict[str, Any] = Field(default_factory=dict)


class BrokerOrderRequest(BaseModel):
    symbol: str = Field(min_length=1, max_length=32)
    side: str = Field(pattern="^(buy|sell)$")
    quantity: float = Field(gt=0, le=10_000_000)
    order_type: str = Field(default="market", pattern="^(market|limit|stop|stop_limit)$")
    limit_price: float | None = Field(default=None, gt=0)
    stop_price: float | None = Field(default=None, gt=0)
    estimated_price: float = Field(gt=0, le=10_000_000)
    contract_id: str | None = Field(default=None, max_length=32)
    time_in_force: str = Field(default="day", pattern="^(day|gtc)$")

    @field_validator("quantity", "estimated_price", "limit_price", "stop_price")
    @classmethod
    def finite_number(cls, value: float | None) -> float | None:
        if value is not None and not math.isfinite(value):
            raise ValueError("价格和数量必须为有限数值")
        return value

    @model_validator(mode="after")
    def order_prices_match_type(self) -> "BrokerOrderRequest":
        if self.order_type in {"limit", "stop_limit"} and self.limit_price is None:
            raise ValueError("限价/止损限价单必须提供 limit_price")
        if self.order_type in {"stop", "stop_limit"} and self.stop_price is None:
            raise ValueError("止损/止损限价单必须提供 stop_price")
        return self


class LiveArmRequest(BaseModel):
    confirmation: str = Field(min_length=1, max_length=80)


class BrokerRegistry:
    """统一的账户、持仓、订单读写入口。所有状态仅在引擎进程内存中。"""

    def __init__(self) -> None:
        self._configs: dict[str, dict[str, Any]] = {}
        self._live_arms: dict[str, float] = {}

    def configure(self, broker: str, credentials: dict[str, Any]) -> dict[str, Any]:
        broker = broker.strip().lower()
        if broker not in SUPPORTED_BROKERS:
            raise BrokerError("不支持的券商")
        if broker == "alpaca":
            api_key = str(credentials.get("api_key") or "").strip()
            api_secret = str(credentials.get("api_secret") or "").strip()
            mode = str(credentials.get("trading_mode") or "paper").strip().lower()
            if len(api_key) < 8 or len(api_secret) < 8:
                raise BrokerError("Alpaca 需要 API Key 与 API Secret")
            if mode not in {"paper", "live"}:
                raise BrokerError("Alpaca 交易模式只能是 paper 或 live")
            max_order_notional = _number(credentials.get("max_order_notional"), 0)
            if not 0 < max_order_notional <= 1_000_000_000:
                raise BrokerError("必须配置 0-10 亿之间的单笔金额上限")
            max_open_orders = int(_number(credentials.get("max_open_orders"), 10))
            if not 1 <= max_open_orders <= 200:
                raise BrokerError("最大挂单数必须在 1-200 之间")
            config = {
                "api_key": api_key,
                "api_secret": api_secret,
                "trading_mode": mode,
                "max_order_notional": max_order_notional,
                "max_open_orders": max_open_orders,
            }
        else:
            mode = str(credentials.get("trading_mode") or "paper").strip().lower()
            if mode not in {"paper", "live"}:
                raise BrokerError("IBKR 交易模式只能是 paper 或 live")
            max_order_notional = _number(credentials.get("max_order_notional"), 0)
            if not 0 < max_order_notional <= 1_000_000_000:
                raise BrokerError("必须配置 0-10 亿之间的单笔金额上限")
            max_open_orders = int(_number(credentials.get("max_open_orders"), 10))
            if not 1 <= max_open_orders <= 200:
                raise BrokerError("最大挂单数必须在 1-200 之间")
            config = {
                "gateway_url": _gateway_url(str(credentials.get("gateway_url") or IBKR_DEFAULT_GATEWAY)),
                "account_id": str(credentials.get("account_id") or "").strip(),
                "trading_mode": mode,
                "max_order_notional": max_order_notional,
                "max_open_orders": max_open_orders,
            }
        self._configs[broker] = config
        self._live_arms.pop(broker, None)
        audit("broker_configured", {"broker": broker, "trading_mode": config["trading_mode"], "max_order_notional": config["max_order_notional"]})
        return self.status(broker)

    def status(self, broker: str) -> dict[str, Any]:
        broker = broker.strip().lower()
        config = self._configs.get(broker)
        if not config:
            return {"broker": broker, "configured": False, "connected": False, "live_armed_until": None}
        armed_until = self._live_arms.get(broker, 0)
        return {
            "broker": broker,
            "configured": True,
            "connected": False,
            "trading_mode": config["trading_mode"],
            "max_order_notional": config["max_order_notional"],
            "max_open_orders": config["max_open_orders"],
            "account_id": config.get("account_id") or None,
            "gateway_url": config.get("gateway_url") or None,
            "live_armed_until": int(armed_until * 1000) if armed_until > time.time() else None,
        }

    def statuses(self) -> list[dict[str, Any]]:
        return [self.status(name) for name in sorted(SUPPORTED_BROKERS)]

    def _config(self, broker: str) -> dict[str, Any]:
        config = self._configs.get(broker)
        if not config:
            raise BrokerError("请先在 OMS 页面配置并连接该券商")
        return config

    def arm_live(self, broker: str, confirmation: str) -> dict[str, Any]:
        config = self._config(broker)
        if config["trading_mode"] != "live":
            raise BrokerError("当前为模拟模式，不需要解锁真实资金")
        if confirmation.strip() != LIVE_CONFIRMATION:
            raise BrokerError(f"请完整输入 {LIVE_CONFIRMATION}")
        expiry = time.time() + LIVE_ARM_SECONDS
        self._live_arms[broker] = expiry
        audit("broker_live_armed", {"broker": broker, "expires_in_seconds": LIVE_ARM_SECONDS})
        return {"broker": broker, "live_armed_until": int(expiry * 1000), "expires_in_seconds": LIVE_ARM_SECONDS}

    def disarm_live(self, broker: str) -> dict[str, Any]:
        self._live_arms.pop(broker, None)
        audit("broker_live_disarmed", {"broker": broker})
        return {"broker": broker, "live_armed_until": None}

    def _assert_order_allowed(self, broker: str, request: BrokerOrderRequest) -> dict[str, Any]:
        config = self._config(broker)
        notional = request.quantity * request.estimated_price
        if not math.isfinite(notional) or notional > float(config["max_order_notional"]):
            raise BrokerError(f"预交易风控拒绝：预估金额 {notional:.2f} 超过单笔上限 {config['max_order_notional']:.2f}")
        if config["trading_mode"] == "live" and self._live_arms.get(broker, 0) <= time.time():
            raise BrokerError("真实资金尚未解锁，需在本次会话输入确认语后才可下单")
        return config

    async def _request(self, method: str, url: str, *, headers: dict[str, str] | None = None, json: Any = None, verify: bool = True) -> Any:
        try:
            async with httpx.AsyncClient(timeout=httpx.Timeout(12.0, connect=4.0), verify=verify, follow_redirects=False) as client:
                response = await client.request(method, url, headers=headers, json=json)
        except httpx.HTTPError as exc:
            raise BrokerError(f"券商连接失败：{type(exc).__name__}") from exc
        try:
            body: Any = response.json()
        except ValueError:
            body = {"message": response.text[:300]}
        if response.is_error:
            detail = body.get("message") if isinstance(body, dict) else None
            raise BrokerError(f"券商返回 {response.status_code}{f'：{detail}' if detail else ''}")
        return body

    def _alpaca(self) -> tuple[dict[str, Any], str, dict[str, str]]:
        config = self._config("alpaca")
        url = ALPACA_PAPER_URL if config["trading_mode"] == "paper" else ALPACA_LIVE_URL
        return config, url, {"APCA-API-KEY-ID": config["api_key"], "APCA-API-SECRET-KEY": config["api_secret"]}

    async def _ibkr_account_id(self) -> tuple[dict[str, Any], str]:
        config = self._config("ibkr")
        if config.get("account_id"):
            return config, str(config["account_id"])
        accounts = await self._request("GET", f"{config['gateway_url']}/portfolio/accounts", verify=False)
        if not isinstance(accounts, list) or len(accounts) != 1:
            raise BrokerError("IBKR Gateway 返回多个账户；请在 OMS 配置中填写目标 account_id")
        account_id = str((accounts[0] or {}).get("accountId") or "")
        if not account_id:
            raise BrokerError("IBKR Gateway 未返回可用账户")
        return config, account_id

    async def connect(self, broker: str) -> dict[str, Any]:
        broker = broker.lower()
        if broker == "alpaca":
            _, url, headers = self._alpaca()
            account = await self._request("GET", f"{url}/v2/account", headers=headers)
            output = self.status(broker)
            output.update({"connected": True, "account": self._alpaca_account(account)})
        elif broker == "ibkr":
            config = self._config("ibkr")
            auth = await self._request("GET", f"{config['gateway_url']}/iserver/auth/status", verify=False)
            if not isinstance(auth, dict) or not auth.get("authenticated"):
                raise BrokerError("IBKR Gateway 未完成登录或二次验证")
            _, account_id = await self._ibkr_account_id()
            output = self.status(broker)
            output.update({"connected": True, "account_id": account_id, "gateway_authenticated": True})
        else:
            raise BrokerError("不支持的券商")
        audit("broker_connected", {"broker": broker})
        return output

    @staticmethod
    def _alpaca_account(data: Any) -> dict[str, Any]:
        source = data if isinstance(data, dict) else {}
        return {"account_id": source.get("account_number"), "status": source.get("status"), "currency": source.get("currency"), "cash": _number(source.get("cash")), "equity": _number(source.get("equity")), "buying_power": _number(source.get("buying_power"))}

    async def account(self, broker: str) -> dict[str, Any]:
        if broker == "alpaca":
            _, url, headers = self._alpaca()
            return {"broker": broker, "account": self._alpaca_account(await self._request("GET", f"{url}/v2/account", headers=headers))}
        config, account_id = await self._ibkr_account_id()
        summary = await self._request("GET", f"{config['gateway_url']}/portfolio/{account_id}/summary", verify=False)
        return {"broker": broker, "account_id": account_id, "summary": summary}

    async def positions(self, broker: str) -> dict[str, Any]:
        if broker == "alpaca":
            _, url, headers = self._alpaca()
            data = await self._request("GET", f"{url}/v2/positions", headers=headers)
            positions = []
            for item in data if isinstance(data, list) else []:
                positions.append({"symbol": item.get("symbol"), "contract_id": item.get("asset_id"), "quantity": _number(item.get("qty")), "average_price": _number(item.get("avg_entry_price")), "market_price": _number(item.get("current_price")), "market_value": _number(item.get("market_value")), "unrealized_pnl": _number(item.get("unrealized_pl")), "side": item.get("side")})
            return {"broker": broker, "positions": positions}
        config, account_id = await self._ibkr_account_id()
        data = await self._request("GET", f"{config['gateway_url']}/portfolio/{account_id}/positions/0", verify=False)
        positions = []
        for item in data if isinstance(data, list) else []:
            positions.append({"symbol": item.get("contractDesc"), "contract_id": str(item.get("conid") or ""), "quantity": _number(item.get("position")), "average_price": _number(item.get("avgPrice")), "market_price": _number(item.get("mktPrice")), "market_value": _number(item.get("mktValue")), "unrealized_pnl": _number(item.get("unrealizedPnl")), "side": "long" if _number(item.get("position")) >= 0 else "short"})
        return {"broker": broker, "account_id": account_id, "positions": positions}

    async def orders(self, broker: str) -> dict[str, Any]:
        if broker == "alpaca":
            _, url, headers = self._alpaca()
            data = await self._request("GET", f"{url}/v2/orders?status=all&limit=100&direction=desc", headers=headers)
            orders = []
            for item in data if isinstance(data, list) else []:
                orders.append({"id": item.get("id"), "client_order_id": item.get("client_order_id"), "symbol": item.get("symbol"), "side": item.get("side"), "order_type": item.get("type"), "quantity": _number(item.get("qty")), "filled_quantity": _number(item.get("filled_qty")), "limit_price": _number(item.get("limit_price")) if item.get("limit_price") is not None else None, "status": item.get("status"), "submitted_at": item.get("submitted_at"), "filled_avg_price": _number(item.get("filled_avg_price")) if item.get("filled_avg_price") is not None else None})
            return {"broker": broker, "orders": orders}
        config = self._config("ibkr")
        data = await self._request("GET", f"{config['gateway_url']}/iserver/account/orders?force=false", verify=False)
        raw_orders = data.get("orders", []) if isinstance(data, dict) else []
        orders = []
        for item in raw_orders if isinstance(raw_orders, list) else []:
            orders.append({"id": str(item.get("orderId") or item.get("order_id") or ""), "client_order_id": item.get("order_ref"), "symbol": item.get("ticker") or item.get("description"), "side": str(item.get("side") or "").lower(), "order_type": item.get("orderType"), "quantity": _number(item.get("totalSize")), "filled_quantity": _number(item.get("filledQuantity")), "limit_price": _number(item.get("price")) if item.get("price") is not None else None, "status": item.get("status"), "submitted_at": item.get("lastExecutionTime"), "filled_avg_price": _number(item.get("avgPrice")) if item.get("avgPrice") is not None else None})
        return {"broker": broker, "orders": orders}

    async def trades(self, broker: str) -> dict[str, Any]:
        if broker == "alpaca":
            _, url, headers = self._alpaca()
            data = await self._request("GET", f"{url}/v2/account/activities/FILL?direction=desc&page_size=100", headers=headers)
            return {"broker": broker, "trades": data if isinstance(data, list) else []}
        config = self._config("ibkr")
        data = await self._request("GET", f"{config['gateway_url']}/iserver/account/trades?days=7", verify=False)
        return {"broker": broker, "trades": data if isinstance(data, list) else []}

    async def ibkr_contracts(self, symbol: str) -> dict[str, Any]:
        config = self._config("ibkr")
        clean = _clean_symbol(symbol)
        data = await self._request("GET", f"{config['gateway_url']}/iserver/secdef/search?symbol={clean}", verify=False)
        contracts = []
        for item in data if isinstance(data, list) else []:
            contracts.append({"contract_id": str(item.get("conid") or ""), "symbol": item.get("symbol"), "description": item.get("description"), "asset_class": item.get("assetClass"), "listing_exchange": item.get("listingExchange")})
        return {"broker": "ibkr", "symbol": clean, "contracts": contracts}

    async def place_order(self, broker: str, request: BrokerOrderRequest) -> dict[str, Any]:
        broker = broker.lower()
        config = self._assert_order_allowed(broker, request)
        symbol = _clean_symbol(request.symbol)
        if broker == "alpaca":
            _, url, headers = self._alpaca()
            active = await self.orders("alpaca")
            open_count = sum(1 for item in active["orders"] if str(item.get("status") or "").lower() in {"new", "accepted", "pending_new", "partially_filled"})
            if open_count >= int(config["max_open_orders"]):
                raise BrokerError("预交易风控拒绝：当前挂单数量达到上限")
            body: dict[str, Any] = {"symbol": symbol, "qty": request.quantity, "side": request.side, "type": request.order_type, "time_in_force": request.time_in_force.upper(), "client_order_id": f"qd-{uuid.uuid4().hex[:20]}"}
            if request.limit_price is not None:
                body["limit_price"] = request.limit_price
            if request.stop_price is not None:
                body["stop_price"] = request.stop_price
            response = await self._request("POST", f"{url}/v2/orders", headers=headers, json=body)
        elif broker == "ibkr":
            if not request.contract_id or not str(request.contract_id).isdigit():
                raise BrokerError("IBKR 下单必须先搜索并选择精确 conid（contract_id）")
            _, account_id = await self._ibkr_account_id()
            active = await self.orders("ibkr")
            open_count = sum(1 for item in active["orders"] if str(item.get("status") or "").lower() in {"pending", "submitted", "presubmitted", "inactive"})
            if open_count >= int(config["max_open_orders"]):
                raise BrokerError("预交易风控拒绝：当前挂单数量达到上限")
            order_type = {"market": "MKT", "limit": "LMT", "stop": "STP", "stop_limit": "STP LMT"}[request.order_type]
            body_order: dict[str, Any] = {"conid": int(request.contract_id), "side": request.side.upper(), "orderType": order_type, "quantity": request.quantity, "tif": request.time_in_force.upper()}
            if request.limit_price is not None:
                body_order["price"] = request.limit_price
            if request.stop_price is not None:
                body_order["auxPrice"] = request.stop_price
            response = await self._request("POST", f"{config['gateway_url']}/iserver/account/{account_id}/orders", json={"orders": [body_order]}, verify=False)
        else:
            raise BrokerError("不支持的券商")
        audit("broker_order_submitted", {"broker": broker, "symbol": symbol, "side": request.side, "order_type": request.order_type, "quantity": request.quantity, "estimated_notional": round(request.quantity * request.estimated_price, 2), "trading_mode": config["trading_mode"]})
        return {"ok": True, "broker": broker, "response": response}

    async def cancel_order(self, broker: str, order_id: str) -> dict[str, Any]:
        if not order_id.strip() or len(order_id) > 120:
            raise BrokerError("订单 ID 无效")
        if broker == "alpaca":
            _, url, headers = self._alpaca()
            await self._request("DELETE", f"{url}/v2/orders/{order_id}", headers=headers)
        elif broker == "ibkr":
            config, account_id = await self._ibkr_account_id()
            await self._request("DELETE", f"{config['gateway_url']}/iserver/account/{account_id}/order/{order_id}", verify=False)
        else:
            raise BrokerError("不支持的券商")
        audit("broker_order_cancelled", {"broker": broker, "order_id": order_id})
        return {"ok": True, "broker": broker, "order_id": order_id}


registry = BrokerRegistry()


def _handle(error: Exception) -> HTTPException:
    return HTTPException(status_code=422 if isinstance(error, BrokerError) else 502, detail=str(error) if isinstance(error, BrokerError) else "券商连接异常")


@router.get("")
def list_brokers() -> dict[str, Any]:
    return {"brokers": registry.statuses(), "live_confirmation": LIVE_CONFIRMATION, "live_arm_seconds": LIVE_ARM_SECONDS}


@router.post("/configure")
def configure_broker(request: BrokerConfigureRequest) -> dict[str, Any]:
    try:
        return registry.configure(request.broker, request.credentials)
    except Exception as exc:  # noqa: BLE001
        raise _handle(exc) from exc


@router.post("/{broker}/connect")
async def connect_broker(broker: str) -> dict[str, Any]:
    try:
        return await registry.connect(broker)
    except Exception as exc:  # noqa: BLE001
        raise _handle(exc) from exc


@router.post("/{broker}/arm-live")
def arm_live(broker: str, request: LiveArmRequest) -> dict[str, Any]:
    try:
        return registry.arm_live(broker, request.confirmation)
    except Exception as exc:  # noqa: BLE001
        raise _handle(exc) from exc


@router.post("/{broker}/disarm-live")
def disarm_live(broker: str) -> dict[str, Any]:
    try:
        return registry.disarm_live(broker)
    except Exception as exc:  # noqa: BLE001
        raise _handle(exc) from exc


@router.get("/{broker}/account")
async def broker_account(broker: str) -> dict[str, Any]:
    try:
        return await registry.account(broker)
    except Exception as exc:  # noqa: BLE001
        raise _handle(exc) from exc


@router.get("/{broker}/positions")
async def broker_positions(broker: str) -> dict[str, Any]:
    try:
        return await registry.positions(broker)
    except Exception as exc:  # noqa: BLE001
        raise _handle(exc) from exc


@router.get("/{broker}/orders")
async def broker_orders(broker: str) -> dict[str, Any]:
    try:
        return await registry.orders(broker)
    except Exception as exc:  # noqa: BLE001
        raise _handle(exc) from exc


@router.get("/{broker}/trades")
async def broker_trades(broker: str) -> dict[str, Any]:
    try:
        return await registry.trades(broker)
    except Exception as exc:  # noqa: BLE001
        raise _handle(exc) from exc


@router.get("/ibkr/contracts")
async def ibkr_contracts(symbol: str = Query(min_length=1, max_length=32)) -> dict[str, Any]:
    try:
        return await registry.ibkr_contracts(symbol)
    except Exception as exc:  # noqa: BLE001
        raise _handle(exc) from exc


@router.post("/{broker}/orders")
async def place_broker_order(broker: str, request: BrokerOrderRequest) -> dict[str, Any]:
    try:
        return await registry.place_order(broker, request)
    except Exception as exc:  # noqa: BLE001
        raise _handle(exc) from exc


@router.delete("/{broker}/orders/{order_id}")
async def cancel_broker_order(broker: str, order_id: str) -> dict[str, Any]:
    try:
        return await registry.cancel_order(broker, order_id)
    except Exception as exc:  # noqa: BLE001
        raise _handle(exc) from exc
