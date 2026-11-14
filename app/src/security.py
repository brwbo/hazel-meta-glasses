import json
import socket
from urllib.parse import urlsplit

UNSAFE = {"POST", "PUT", "PATCH", "DELETE"}
NO_STORE = ("/api/people", "/models/")
LOCAL_HOSTS = {"localhost", "127.0.0.1", "::1", "testserver"}


def host_only(value):
    value = (value or "").strip().lower()
    if not value:
        return ""
    if value.startswith("["):
        return value[1:value.find("]")] if "]" in value else value
    return value.rsplit(":", 1)[0] if value.count(":") == 1 else value


def default_hosts(lan_ip=None):
    hosts = set(LOCAL_HOSTS)
    if lan_ip:
        hosts.add(lan_ip)
    try:
        name = socket.gethostname().lower()
        hosts |= {name, name.removesuffix(".local") + ".local"}
    except OSError:
        pass
    return hosts


def origin_allowed(origin, hosts):
    if origin is None:
        return True
    parts = urlsplit(origin)
    if parts.scheme not in ("http", "https", "ws", "wss") or not parts.hostname:
        return False
    return parts.hostname.lower() in hosts


class Guard:
    def __init__(self, app, hosts):
        self.app = app
        self.hosts = hosts

    def _reason(self, scope):
        headers = {k.decode("latin-1").lower(): v.decode("latin-1") for k, v in scope.get("headers", [])}
        if host_only(headers.get("host")) not in self.hosts:
            return "host not allowed"
        unsafe = scope["type"] == "websocket" or scope.get("method", "GET").upper() in UNSAFE
        if unsafe and not origin_allowed(headers.get("origin"), self.hosts):
            return "origin not allowed"
        return None

    async def __call__(self, scope, receive, send):
        if scope["type"] not in ("http", "websocket"):
            return await self.app(scope, receive, send)
        reason = self._reason(scope)
        if reason and scope["type"] == "websocket":
            await send({"type": "websocket.close", "code": 1008, "reason": reason})
            return
        if reason:
            body = json.dumps({"detail": reason}).encode()
            await send({"type": "http.response.start", "status": 403,
                        "headers": [(b"content-type", b"application/json"),
                                    (b"content-length", str(len(body)).encode())]})
            await send({"type": "http.response.body", "body": body})
            return
        if scope["type"] == "http" and scope.get("path", "").startswith(NO_STORE):
            async def no_store(message):
                if message["type"] == "http.response.start":
                    headers = [(k, v) for k, v in message.get("headers", []) if k.lower() != b"cache-control"]
                    message = {**message, "headers": headers + [(b"cache-control", b"no-store")]}
                await send(message)
            return await self.app(scope, receive, no_store)
        return await self.app(scope, receive, send)
