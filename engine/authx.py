"""账户认证工具：PBKDF2 口令哈希、输入校验、登录限流。
仅依赖标准库，保证引擎打包（PyInstaller）无额外二进制依赖。"""
from __future__ import annotations

import hashlib
import hmac
import re
import secrets
import time
from collections import defaultdict

PBKDF2_ITERATIONS = 240_000
USERNAME_RE = re.compile(r"^[A-Za-z0-9_\-\u4e00-\u9fff]{2,32}$")


class AuthError(ValueError):
    """携带用户可读信息的认证错误。"""


def validate_credentials(username: str, password: str) -> tuple[str, str]:
    name = username.strip()
    if not USERNAME_RE.match(name):
        raise AuthError("用户名需为 2-32 位字母、数字、下划线、连字符或中文")
    if len(password) < 8 or len(password) > 128:
        raise AuthError("密码长度需在 8-128 位之间")
    if " " in password or "\n" in password or "\t" in password:
        raise AuthError("密码不能包含空白字符")
    return name, password


def hash_password(password: str) -> str:
    salt = secrets.token_bytes(16)
    digest = hashlib.pbkdf2_hmac("sha256", password.encode("utf-8"), salt, PBKDF2_ITERATIONS)
    return f"pbkdf2_sha256${PBKDF2_ITERATIONS}${salt.hex()}${digest.hex()}"


def generate_totp_secret() -> str:
    """返回 otpauth 兼容的 Base32 密钥（无填充）。"""
    import base64
    return base64.b32encode(secrets.token_bytes(20)).decode("ascii").rstrip("=")


def totp_code(secret: str, at: float | None = None, step: int = 30, digits: int = 6) -> str:
    """RFC 6238 TOTP（SHA-1）。secret 为 Base32。"""
    import base64
    import struct

    padded = secret.strip().upper() + ("=" * ((8 - len(secret.strip()) % 8) % 8))
    key = base64.b32decode(padded, casefold=True)
    counter = int((time.time() if at is None else at) // step)
    digest = hmac.new(key, struct.pack(">Q", counter), hashlib.sha1).digest()
    offset = digest[-1] & 0x0F
    number = struct.unpack(">I", digest[offset:offset + 4])[0] & 0x7FFFFFFF
    return f"{number % (10 ** digits):0{digits}d}"


def verify_totp(secret: str, code: str, window: int = 1) -> bool:
    supplied = (code or "").strip()
    if len(supplied) != 6 or not supplied.isdigit():
        return False
    now = time.time()
    for skew in range(-window, window + 1):
        if hmac.compare_digest(totp_code(secret, at=now + skew * 30), supplied):
            return True
    return False


def totp_provisioning_uri(secret: str, username: str, issuer: str = "QuantDesk") -> str:
    from urllib.parse import quote
    return f"otpauth://totp/{quote(issuer)}:{quote(username)}?secret={secret}&issuer={quote(issuer)}&digits=6&period=30"


def verify_password(password: str, stored: str) -> bool:
    try:
        algorithm, iterations, salt_hex, digest_hex = stored.split("$")
        if algorithm != "pbkdf2_sha256":
            return False
        digest = hashlib.pbkdf2_hmac(
            "sha256", password.encode("utf-8"), bytes.fromhex(salt_hex), int(iterations)
        )
        return hmac.compare_digest(digest.hex(), digest_hex)
    except (ValueError, TypeError):
        return False


class LoginRateLimiter:
    """内存级登录失败限流：同一 (用户名, 客户端) 在窗口期内最多 max_failures 次失败。"""

    def __init__(self, max_failures: int = 8, window_seconds: int = 300) -> None:
        self.max_failures = max_failures
        self.window_seconds = window_seconds
        self._failures: dict[str, list[float]] = defaultdict(list)

    def check(self, key: str) -> bool:
        """True = 放行；False = 已超限。"""
        now = time.monotonic()
        recent = [t for t in self._failures.get(key, []) if now - t < self.window_seconds]
        self._failures[key] = recent
        return len(recent) < self.max_failures

    def record_failure(self, key: str) -> None:
        self._failures[key].append(time.monotonic())

    def reset(self, key: str) -> None:
        self._failures.pop(key, None)
