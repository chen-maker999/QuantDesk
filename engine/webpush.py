"""Web Push 推送（可选依赖，优雅降级）。

pywebpush 未安装时所有函数返回不可用状态，不影响引擎其它功能；
已安装时自动生成/持久化 VAPID 密钥（settings 表），订阅端点存 SQLite，
notify 时在后台线程逐个推送，410/404 自动清理失效订阅。
"""
from __future__ import annotations

import base64
import json
import threading
from typing import Any

try:
    from .database import delete_push_subscription, get_setting, list_push_subscriptions, set_setting, upsert_push_subscription
except ImportError:
    try:
        from engine.database import delete_push_subscription, get_setting, list_push_subscriptions, set_setting, upsert_push_subscription
    except ImportError:
        from database import delete_push_subscription, get_setting, list_push_subscriptions, set_setting, upsert_push_subscription

try:
    from pywebpush import WebPushException, webpush  # type: ignore
    _PUSH_OK = True
except Exception:  # noqa: BLE001 - 可选依赖缺失时静默降级
    WebPushException = Exception  # type: ignore
    webpush = None  # type: ignore
    _PUSH_OK = False

try:
    from cryptography.hazmat.primitives import serialization
    from cryptography.hazmat.primitives.asymmetric import ec
    _CRYPTO_OK = True
except Exception:  # noqa: BLE001
    _CRYPTO_OK = False

_VAPID_PRIVATE_KEY = "push_vapid_private_pem"
_VAPID_PUBLIC_KEY = "push_vapid_public_b64"
_CLAIMS_SUB = "mailto:quantdesk@local"
_PUSH_TTL = 3600 * 24  # 24h


def push_available() -> bool:
    return _PUSH_OK and _CRYPTO_OK


def _generate_vapid_keys() -> tuple[str, str]:
    """生成 P-256 VAPID 密钥对：返回 (私钥 PEM 文本, 公钥 b64url)。"""
    if not _CRYPTO_OK:
        raise RuntimeError("缺少 cryptography 库")
    key = ec.generate_private_key(ec.SECP256R1())
    pem = key.private_bytes(
        serialization.Encoding.PEM,
        serialization.PrivateFormat.PKCS8,
        serialization.NoEncryption(),
    ).decode("ascii")
    pub = key.public_key().public_bytes(
        serialization.Encoding.X962,
        serialization.PublicFormat.UncompressedPoint,
    )
    pub_b64 = base64.urlsafe_b64encode(pub).rstrip(b"=").decode("ascii")
    return pem, pub_b64


def ensure_vapid_keys() -> tuple[str, str]:
    """从 settings 读取 VAPID 密钥；首次调用时生成并持久化。"""
    pem = get_setting(_VAPID_PRIVATE_KEY)
    pub = get_setting(_VAPID_PUBLIC_KEY)
    if pem and pub:
        return pem, pub
    pem, pub = _generate_vapid_keys()
    set_setting(_VAPID_PRIVATE_KEY, pem)
    set_setting(_VAPID_PUBLIC_KEY, pub)
    return pem, pub


def vapid_public_key() -> str | None:
    """前端 PushManager.subscribe 需要的 applicationServerKey（b64url）。"""
    if not push_available():
        return None
    try:
        _, pub = ensure_vapid_keys()
        return pub
    except Exception:  # noqa: BLE001
        return None


def subscribe(endpoint: str, p256dh: str, auth: str, user_agent: str = "") -> None:
    upsert_push_subscription(endpoint, p256dh, auth, user_agent)


def unsubscribe(endpoint: str) -> None:
    delete_push_subscription(endpoint)


def subscription_count() -> int:
    return len(list_push_subscriptions())


def dispatch(source: str, title: str, body: str = "", url: str = "/") -> int:
    """向全部订阅推送一条通知，返回成功数。失败(含过期端点)不抛异常。"""
    if not push_available():
        return 0
    subs = list_push_subscriptions()
    if not subs:
        return 0
    try:
        private_pem, _ = ensure_vapid_keys()
    except Exception:  # noqa: BLE001
        return 0
    payload = json.dumps({"source": source, "title": title, "body": body, "url": url}, ensure_ascii=False)
    sent = 0
    for sub in subs:
        try:
            webpush(
                subscription_info={"endpoint": sub["endpoint"], "keys": {"p256dh": sub["p256dh"], "auth": sub["auth"]}},
                data=payload,
                vapid_private_key=private_pem.encode("ascii"),
                vapid_claims={"sub": _CLAIMS_SUB},
                ttl=_PUSH_TTL,
            )
            sent += 1
        except WebPushException as exc:
            status = 0
            response = getattr(exc, "response", None)
            if response is not None:
                status = getattr(response, "status_code", 0) or 0
            if status in (404, 410):
                # 端点已过期/取消 —— 移除订阅
                try:
                    unsubscribe(sub["endpoint"])
                except Exception:  # noqa: BLE001
                    pass
        except Exception:  # noqa: BLE001
            continue
    return sent


def dispatch_async(source: str, title: str, body: str = "", url: str = "/") -> None:
    """后台线程推送：通知写入主流程不能被网络慢拖住。"""
    if not push_available():
        return
    threading.Thread(target=dispatch, args=(source, title, body, url), daemon=True).start()


def status() -> dict[str, Any]:
    """给 /push/public-key 端点的状态摘要。"""
    if not push_available():
        return {"available": False, "reason": "引擎未安装 pywebpush（pip install pywebpush 后重启引擎）"}
    pub = vapid_public_key()
    if not pub:
        return {"available": False, "reason": "VAPID 密钥生成失败"}
    return {"available": True, "publicKey": pub, "subscriptions": subscription_count()}
