"""本地 Agent 的受控公网 HTTP 出口。"""
from __future__ import annotations

import ipaddress
import socket
from urllib.parse import urlparse


class UnsafeUrlError(ValueError):
    """URL 不是可安全访问的公网 HTTPS 地址。"""


def validate_public_https_url(url: str) -> str:
    """拒绝私网、环回、链路本地、凭据 URL 和 DNS 解析到非公网的主机。"""
    parsed = urlparse(url.strip())
    if parsed.scheme != "https" or not parsed.hostname or parsed.username or parsed.password:
        raise UnsafeUrlError("只允许不含凭据的公网 HTTPS 地址")
    host = parsed.hostname.rstrip(".").lower()
    if host == "localhost" or host.endswith(".localhost"):
        raise UnsafeUrlError("不允许访问本机地址")
    try:
        records = socket.getaddrinfo(host, parsed.port or 443, type=socket.SOCK_STREAM)
    except socket.gaierror as exc:
        raise UnsafeUrlError("URL 主机无法解析") from exc
    addresses = {record[4][0] for record in records}
    if not addresses:
        raise UnsafeUrlError("URL 主机没有可用地址")
    for address in addresses:
        try:
            if not ipaddress.ip_address(address).is_global:
                raise UnsafeUrlError("不允许访问非公网地址")
        except ValueError as exc:
            raise UnsafeUrlError("URL 主机地址无效") from exc
    return parsed.geturl()
