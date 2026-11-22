"""HTTP のサーバー（標準ライブラリの ThreadingHTTPServer）。

守り：
- 既定で 127.0.0.1 だけで待ち受ける（家族の端末から使うときは README の「LAN で使う」）。
- Host のヘッダーを確かめる（DNS rebinding を止める）。状態を変えるリクエストは Origin も確かめる。
- 画面のセッションでは、状態を変えるリクエストに CSRF のトークン（X-CSRF-Token）を求める。
- 応答に CSP など。画面は外部のスクリプト・フォント・画像を読まない（家族のデータを外へ出さない）。
- アクセスのログには方法とパスだけを書く（クエリ・本体・家族のデータは書かない）。
"""

from __future__ import annotations

import json
import mimetypes
import re
import sys
from dataclasses import dataclass, field
from http.cookies import SimpleCookie
from pathlib import Path
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from typing import Any, Callable
from urllib.parse import parse_qs, unquote, urlsplit

from .app import App
from .auth import Principal

SESSION_COOKIE = "okura_session"
GUEST_COOKIE = "okura_guest"  # 招待リンクで登録した端末

CSP = (
    "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' blob: data:; "
    "connect-src 'self'; font-src 'self'; object-src 'none'; frame-src 'self'; frame-ancestors 'self'; base-uri 'none'; form-action 'self'"
)


class HttpError(Exception):
    def __init__(self, status: int, message: str, *, code: str = "error", detail: Any = None):
        super().__init__(message)
        self.status = status
        self.code = code
        self.detail = detail


@dataclass
class Response:
    status: int = 200
    body: bytes = b""
    content_type: str = "application/json; charset=utf-8"
    headers: dict[str, str] = field(default_factory=dict)

    @classmethod
    def json(cls, obj: Any, status: int = 200) -> "Response":
        return cls(status, json.dumps(obj, ensure_ascii=False).encode("utf-8"))


@dataclass
class Request:
    handler: "Handler"
    method: str
    path: str
    query: dict[str, list[str]]
    params: dict[str, str]
    principal: Principal | None
    session_token: str | None
    _body: bytes | None = None

    def header(self, name: str) -> str | None:
        return self.handler.headers.get(name)

    def arg(self, name: str, default: str | None = None) -> str | None:
        v = self.query.get(name)
        return v[0] if v else default

    def body(self, limit: int) -> bytes:
        if self._body is None:
            n = int(self.header("Content-Length") or "0")
            if n > limit:
                raise HttpError(413, f"本体が大きすぎる（上限 {limit // 2**20} MiB）", code="too_large")
            self._body = self.handler.rfile.read(n) if n > 0 else b""
            self.handler.body_read = True
        return self._body

    def json(self) -> Any:
        app: App = self.handler.server.app  # type: ignore[attr-defined]
        raw = self.body(app.cfg.max_json_bytes)
        if not raw:
            return {}
        try:
            return json.loads(raw.decode("utf-8"))
        except (ValueError, UnicodeDecodeError) as e:
            raise HttpError(400, "JSON を読めない", code="bad_json") from e


Handler_t = Callable[[Request], Any]


class Router:
    def __init__(self) -> None:
        self.routes: list[tuple[str, re.Pattern[str], Handler_t, dict[str, Any]]] = []

    def add(self, method: str, pattern: str, fn: Handler_t, **opts: Any) -> None:
        rx = re.compile("^" + re.sub(r"\{(\w+)\}", r"(?P<\1>[^/]+)", pattern) + "$")
        self.routes.append((method, rx, fn, opts))

    def route(self, method: str, pattern: str, **opts: Any) -> Callable[[Handler_t], Handler_t]:
        def deco(fn: Handler_t) -> Handler_t:
            self.add(method, pattern, fn, **opts)
            return fn

        return deco

    def match(self, method: str, path: str) -> tuple[Handler_t, dict[str, str], dict[str, Any]] | None:
        allowed = False
        for m, rx, fn, opts in self.routes:
            mm = rx.match(path)
            if mm:
                if m == method:
                    # 経路の中の値は URL の符号を戻す（家計簿の勘定の名前の「:」など。「/」は経路の区切りなので値に入らない）
                    return fn, {k: unquote(v) for k, v in mm.groupdict().items()}, opts
                allowed = True
        if allowed:
            raise HttpError(405, "この方法は使えない", code="method_not_allowed")
        return None


class Handler(BaseHTTPRequestHandler):
    server_version = "okura-web"
    sys_version = ""
    proxy_email: str | None = None  # 手前の認証で確かめたメール（公開のホスト名のときだけ）
    body_read = True  # このリクエストの本体を読んだか（_dispatch で False にする）
    protocol_version = "HTTP/1.1"

    # ログ：方法とパスだけ（クエリ・本体を書かない）
    def log_message(self, format: str, *args: Any) -> None:  # noqa: A002
        return

    def log_request(self, code: int | str = "-", size: int | str = "-") -> None:
        path = urlsplit(self.path).path
        if path.startswith("/api/"):
            sys.stderr.write(f"{self.command} {path} {code}\n")

    def do_GET(self) -> None:
        self._dispatch("GET")

    def do_POST(self) -> None:
        self._dispatch("POST")

    def do_PUT(self) -> None:
        self._dispatch("PUT")

    def do_DELETE(self) -> None:
        self._dispatch("DELETE")

    # ------------------------------------------------------------------
    def _send(self, resp: Response) -> None:
        self._drain_body()
        body = resp.body
        gz = False
        if (
            len(body) >= 1024
            and "gzip" in (self.headers.get("Accept-Encoding") or "")
            and resp.content_type.split(";")[0] in _COMPRESSIBLE
        ):
            body = _gzip(body, resp.headers.get("X-Static-Key"))
            gz = True
        resp.headers.pop("X-Static-Key", None)
        self.send_response(resp.status)
        self.send_header("Content-Type", resp.content_type)
        self.send_header("Content-Length", str(len(body)))
        if gz:
            self.send_header("Content-Encoding", "gzip")
            self.send_header("Vary", "Accept-Encoding")
        self.send_header("X-Content-Type-Options", "nosniff")
        self.send_header("Referrer-Policy", "no-referrer")
        self.send_header("Cross-Origin-Opener-Policy", "same-origin")
        self.send_header("Cross-Origin-Resource-Policy", "same-origin")
        self.send_header("Permissions-Policy", "geolocation=(), microphone=(), camera=(self)")
        if "Content-Security-Policy" not in resp.headers:
            self.send_header("Content-Security-Policy", CSP)
        if "Cache-Control" not in resp.headers:
            self.send_header("Cache-Control", "no-store")
        for k, v in resp.headers.items():
            self.send_header(k, v)
        self.end_headers()
        if self.command != "HEAD":
            self.wfile.write(body)

    def _host_ok(self) -> bool:
        app: App = self.server.app  # type: ignore[attr-defined]
        host = (self.headers.get("Host") or "").lower()
        allowed = {f"127.0.0.1:{app.cfg.port}", f"localhost:{app.cfg.port}", "127.0.0.1", "localhost"}
        extra = getattr(self.server, "allowed_hosts", set())
        public = getattr(self.server, "public_hosts", set())
        return host in allowed or host in extra or host in public

    def _access_ok(self) -> tuple[bool, str]:
        """公開のホスト名なら、手前の認証（proxyauth：Cloudflare Access など）の JWT を確かめる。確かめたメールを覚える。"""
        self.proxy_email = None
        host = (self.headers.get("Host") or "").lower()
        if host not in getattr(self.server, "public_hosts", set()):
            return True, ""
        verifier = self.server.access  # type: ignore[attr-defined]
        cookie = SimpleCookie(self.headers.get("Cookie") or "")
        token = verifier.token_from(self.headers, {k: m.value for k, m in cookie.items()})
        ok, why, claims = verifier.verify(token)
        if ok:
            self.proxy_email = verifier.email_of(claims)
        return ok, why

    def _origin_ok(self) -> bool:
        origin = self.headers.get("Origin")
        if origin is None:
            return True  # 同一オリジンの fetch・コマンドの呼び出し（Cookie は SameSite=Strict）
        host = self.headers.get("Host") or ""
        return origin in (f"http://{host}", f"https://{host}")

    def _drain_body(self) -> None:
        """読まなかった本体を捨てる（同じ接続の次のリクエストとして読まれないように）。大きければ接続を閉じる。"""
        if self.body_read:
            return
        self.body_read = True
        try:
            n = int(self.headers.get("Content-Length") or "0")
        except ValueError:
            n = -1
        if n == 0:
            return
        if 0 < n <= 1_048_576:
            self.rfile.read(n)
        else:
            self.close_connection = True

    def _dispatch(self, method: str) -> None:
        app: App = self.server.app  # type: ignore[attr-defined]
        router: Router = self.server.router  # type: ignore[attr-defined]
        self.body_read = False
        try:
            if not self._host_ok():
                raise HttpError(421, "このホスト名では受け付けない", code="bad_host")
            parts = urlsplit(self.path)
            path = parts.path
            if path == "/mcp":
                # リモートの MCP はエージェントのトークンで守る（Cloudflare Access の Cookie を持てないクライアントのため）
                resp = self._mcp(app, method, parse_qs(parts.query))
                self._send(resp)
                return
            if path == "/mcp/documents":
                # エージェントが書類（写真・PDF）をそのまま送る入口。守りは /mcp と同じ（エージェントのトークン）
                resp = self._mcp_document(app, method, parse_qs(parts.query))
                self._send(resp)
                return
            ok, why = self._access_ok()
            if not ok:
                raise HttpError(403, f"Cloudflare Access で確認できませんでした（{why}）", code="access_denied")
            if path.startswith("/api/"):
                resp = self._api(app, router, method, path, parse_qs(parts.query))
            else:
                resp = self._static(app, path)
        except HttpError as e:
            resp = Response.json({"ok": False, "error": {"code": e.code, "message": str(e), "detail": e.detail}}, e.status)
        except Exception as e:  # noqa: BLE001
            sys.stderr.write(f"internal error: {type(e).__name__}\n")  # 値・本体は書かない
            import traceback

            traceback.print_tb(e.__traceback__)
            resp = Response.json({"ok": False, "error": {"code": "internal", "message": "サーバーの内部の誤り"}}, 500)
        try:
            self._send(resp)
        except (BrokenPipeError, ConnectionResetError):
            pass

    def _mcp(self, app: App, method: str, query: dict[str, list[str]]) -> Response:
        from .mcp_http import handle_body

        def rpc_error(status: int, code: int, message: str, headers: dict[str, str] | None = None) -> Response:
            r = Response.json({"jsonrpc": "2.0", "id": None, "error": {"code": code, "message": message}}, status)
            r.headers.update(headers or {})
            return r

        if method != "POST":
            return rpc_error(405, -32000, "POST だけを受け付ける（Streamable HTTP。SSE は使わない）", {"Allow": "POST"})
        authz = self.headers.get("Authorization") or ""
        token = authz[len("Bearer "):].strip() if authz.startswith("Bearer ") else (query.get("token") or [""])[0]
        principal = app.auth.token(token) if token else None
        if principal is None:
            return rpc_error(401, -32001, "アクセストークンが要る（okura-web の 設定 → AI連携 で発行）", {"WWW-Authenticate": 'Bearer realm="okura-web"'})
        n = int(self.headers.get("Content-Length") or "0")
        if n <= 0 or n > app.cfg.max_json_bytes:
            return rpc_error(400, -32700, "本体がない、または大きすぎる")
        try:
            self.body_read = True
            body = json.loads(self.rfile.read(n).decode("utf-8"))
        except (ValueError, UnicodeDecodeError):
            return rpc_error(400, -32700, "JSON を読めない")
        status, out = handle_body(app, principal, body)
        if out is None:
            return Response(status, b"", "text/plain; charset=utf-8")
        return Response.json(out, status)

    def _mcp_document(self, app: App, method: str, query: dict[str, list[str]]) -> Response:
        from .tools import ToolError, add_document_bytes, context_for

        def fail(status: int, code: str, message: str, headers: dict[str, str] | None = None) -> Response:
            r = Response.json({"ok": False, "error": {"code": code, "message": message}}, status)
            r.headers.update(headers or {})
            return r

        if method != "POST":
            return fail(405, "method", "POST だけを受け付ける", {"Allow": "POST"})
        authz = self.headers.get("Authorization") or ""
        token = authz[len("Bearer "):].strip() if authz.startswith("Bearer ") else ""
        principal = app.auth.token(token) if token else None
        if principal is None:
            return fail(401, "unauthorized", "アクセストークンが要る（okura-web の 設定 → AI連携 で発行）", {"WWW-Authenticate": 'Bearer realm="okura-web"'})
        n = int(self.headers.get("Content-Length") or "0")
        if n <= 0 or n > app.cfg.max_upload_bytes:
            return fail(413 if n > 0 else 400, "bad_size", "中身がない、または大きすぎる")
        self.body_read = True
        data = self.rfile.read(n)
        one = lambda k: (query.get(k) or [""])[0]  # noqa: E731
        try:
            ctx = context_for(app, principal, external=principal.external, origin=f"mcp:{principal.token_id}")
            out = add_document_bytes(ctx, data, one("name"), one("owner") or None, one("label") or None)
        except ToolError as e:
            return fail(400, "rejected", str(e))
        return Response.json({"ok": True, "id": out["evidence_id"], "duplicate": out["duplicate"]})

    def _api(self, app: App, router: Router, method: str, path: str, query: dict[str, list[str]]) -> Response:
        found = router.match(method, path)
        if found is None:
            raise HttpError(404, "見つからない", code="not_found")
        fn, params, opts = found
        cookie = SimpleCookie(self.headers.get("Cookie") or "")
        token = cookie[SESSION_COOKIE].value if SESSION_COOKIE in cookie else None
        principal = app.auth.session(token)
        if principal is None and GUEST_COOKIE in cookie:
            # 招待リンクで登録した端末（その人あての質問に答えるだけ）
            guest = app.auth.guest(cookie[GUEST_COOKIE].value)
            if guest is not None:
                if opts.get("guest_ok"):
                    principal = guest
                elif not opts.get("public"):
                    raise HttpError(403, "招待リンクの端末では使えない", code="guest_only")
        authz = self.headers.get("Authorization") or ""
        if principal is None and authz.startswith("Bearer "):
            if not opts.get("token_ok"):
                raise HttpError(403, "エージェントのトークンでは使えない（画面で人が操作する）", code="human_only")
            principal = app.auth.token(authz[len("Bearer ") :].strip())
            if principal is None:
                raise HttpError(401, "トークンが無効", code="bad_token")
        if principal is not None and principal.kind == "guest" and not opts.get("guest_ok"):
            raise HttpError(403, "招待リンクの端末では使えない", code="guest_only")
        if not opts.get("public") and principal is None:
            raise HttpError(401, "ログインが要る", code="login_required")
        if method != "GET":
            if not self._origin_ok():
                raise HttpError(403, "別のオリジンからのリクエストは受け付けない", code="bad_origin")
            if principal is not None and principal.is_human and not opts.get("no_csrf"):
                if self.headers.get("X-CSRF-Token") != principal.csrf:
                    raise HttpError(403, "CSRF のトークンが違う（画面を読み直す）", code="csrf")
        req = Request(self, method, path, query, params, principal, token)
        out = fn(req)
        if isinstance(out, Response):
            return out
        return Response.json(out if out is not None else {"ok": True})

    def _static(self, app: App, path: str) -> Response:
        """画面のファイル（Vite でビルドした frontend/dist）を配る。
        index.html は覚えさせない。/assets/ の下は名前に中身のハッシュが入っているので、端末にずっと覚えさせる。"""
        web = app.cfg.web_dir.resolve()
        index = web / "index.html"
        if not index.is_file():
            raise HttpError(503, "画面がまだビルドされていない（npm ci --ignore-scripts && npm run build）", code="not_built")
        rel = path.lstrip("/") or "index.html"
        target = (web / rel).resolve()
        if web not in target.parents and target != web:
            raise HttpError(404, "見つからない", code="not_found")
        hashed = rel.startswith("assets/")
        if not target.is_file():
            if hashed or "." in rel.rsplit("/", 1)[-1]:
                # ファイルを指しているのに無い（古い版の部品など）。画面の HTML を代わりに返さない
                raise HttpError(404, "見つからない", code="not_found")
            target = index  # 画面の中の経路（/tax/2026 などの直リンク）
        ctype = mimetypes.guess_type(str(target))[0] or "application/octet-stream"
        if ctype.startswith("text/") or ctype in ("application/javascript", "application/json"):
            ctype += "; charset=utf-8"
        body = target.read_bytes()
        headers = {"Cache-Control": "no-store, max-age=0", "CDN-Cache-Control": "no-store"}
        if hashed:
            # 名前に中身のハッシュが入っているので中身は変わらない。端末にだけ覚えさせる（private：途中の CDN には置かない）
            headers = {"Cache-Control": "private, max-age=31536000, immutable", "X-Static-Key": f"{target}:{target.stat().st_mtime_ns}"}
        return Response(200, body, ctype, headers)


_COMPRESSIBLE = {"application/json", "application/javascript", "text/javascript", "text/css", "text/html", "image/svg+xml", "text/plain"}
_GZ_CACHE: dict[str, bytes] = {}


def _gzip(body: bytes, key: str | None) -> bytes:
    import gzip

    if key and key in _GZ_CACHE:
        return _GZ_CACHE[key]
    out = gzip.compress(body, compresslevel=6, mtime=0)
    if key:
        if len(_GZ_CACHE) > 200:
            _GZ_CACHE.clear()
        _GZ_CACHE[key] = out
    return out


def web_build(web_dir: Path) -> str:
    """画面のビルドの版（index.html の中身のハッシュ。読む部品の名前が変われば変わる）。画面は新しい版が出たら再読み込みを促す。"""
    import hashlib

    try:
        return hashlib.sha256((web_dir / "index.html").read_bytes()).hexdigest()[:16]
    except OSError:
        return "0"


class Server(ThreadingHTTPServer):
    daemon_threads = True
    # 同じポートで2つ目のサーバーが動かないようにする（Windows は SO_REUSEADDR だと2つ同時に待ち受けられてしまい、
    # リクエストが2つのプロセスに分かれて、計算や AI の会話の途中の状態を見失う）
    allow_reuse_address = False

    def server_bind(self) -> None:
        import socket

        if hasattr(socket, "SO_EXCLUSIVEADDRUSE"):
            self.socket.setsockopt(socket.SOL_SOCKET, socket.SO_EXCLUSIVEADDRUSE, 1)
        super().server_bind()

    def __init__(self, app: App, router: Router, *, allowed_hosts: set[str] | None = None, public_hosts: set[str] | None = None):
        from .proxyauth import ProxyAuthVerifier

        self.app = app
        self.router = router
        self.allowed_hosts = {h.lower() for h in (allowed_hosts or set())}
        self.public_hosts = {h.lower() for h in (public_hosts or set())}
        self.access = ProxyAuthVerifier(app.cfg.root / ".work")
        super().__init__((app.cfg.host, app.cfg.port), Handler)


mimetypes.add_type("application/javascript", ".js")
mimetypes.add_type("text/css", ".css")
mimetypes.add_type("image/svg+xml", ".svg")
mimetypes.add_type("application/manifest+json", ".webmanifest")


def session_cookie(token: str, max_age: int) -> str:
    return f"{SESSION_COOKIE}={token}; Path=/; HttpOnly; SameSite=Strict; Max-Age={max_age}"


def clear_cookie() -> str:
    return f"{SESSION_COOKIE}=; Path=/; HttpOnly; SameSite=Strict; Max-Age=0"


def guest_cookie(token: str, max_age: int) -> str:
    return f"{GUEST_COOKIE}={token}; Path=/; HttpOnly; SameSite=Strict; Max-Age={max_age}"


def clear_guest_cookie() -> str:
    return f"{GUEST_COOKIE}=; Path=/; HttpOnly; SameSite=Strict; Max-Age=0"
