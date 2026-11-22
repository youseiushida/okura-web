"""okura-web の MCP サーバー（stdio。標準ライブラリだけ）。

外部のエージェント（Claude Desktop・Claude Code・その他の MCP クライアント）から、okura-web の道具を使えるようにする。
中身は okura-web の /api/v1/tools を呼ぶだけ（見える範囲・同意・伏せ字・権限は okura-web 側でかかる）。

- 道具は「読む・計算する・説明する」と「提案する」だけ。確定（台帳への書き込み）の道具はない（⑬）。
  提案は okura-web の画面の「確認待ち」に入り、人が確定を押すまで台帳に書かれない。
- トークンは okura-web の 設定 → エージェント連携 で作る（外部に渡す範囲を確かめて同意したうえで）。

起動（MCP クライアントの設定に書く）：
    command: C:/…/okura-web/.work/venvs/web/Scripts/python.exe
    args:    ["-I", "-X", "utf8", "C:/…/okura-web/mcp_server.py"]
    env:     {"OKURA_WEB_URL": "http://127.0.0.1:8765", "OKURA_WEB_TOKEN": "okt_…"}
"""

from __future__ import annotations

import json
import os
import sys
import urllib.error
import urllib.request
from typing import Any

SERVER_NAME = "okura-web"
SERVER_VERSION = "0.1.0"
PROTOCOL_VERSIONS = ("2025-06-18", "2025-03-26", "2024-11-05")

INSTRUCTIONS = (
    "okura-web は家族の税・社会保険の記録と、okura-gov（法令の関数）の計算結果を扱う。"
    "最初に household_overview を呼ぶ。計算は run_calculation（数十秒）→ calculation_status → calculation_summary。"
    "未確定は list_questions で分かれ目と候補ごとの値を見る。人が決めること（判断・選択）は propose_judgment で提案するだけで、確定は人が画面で行う。"
    "結果を丸めない・推奨しない（税務の助言をしない）。申告書の欄の値は人が作成コーナーに写す（送信・自動入力はしない）。"
)


class Client:
    def __init__(self, base: str, token: str):
        self.base = base.rstrip("/")
        self.token = token

    def _req(self, method: str, path: str, body: Any = None) -> Any:
        data = None if body is None else json.dumps(body, ensure_ascii=False).encode("utf-8")
        req = urllib.request.Request(
            self.base + path,
            data=data,
            method=method,
            headers={
                "Authorization": f"Bearer {self.token}",
                "Content-Type": "application/json",
                "X-Okura-Client": "mcp",
            },
        )
        try:
            with urllib.request.urlopen(req, timeout=120) as r:  # noqa: S310 - 設定した okura-web の URL
                return json.loads(r.read().decode("utf-8"))
        except urllib.error.HTTPError as e:
            try:
                return json.loads(e.read().decode("utf-8"))
            except ValueError:
                return {"ok": False, "error": {"message": f"HTTP {e.code}"}}

    def tools(self) -> list[dict[str, Any]]:
        out = self._req("GET", "/api/v1/tools")
        if not isinstance(out, dict) or "tools" not in out:
            raise RuntimeError((out or {}).get("error", {}).get("message", "okura-web に接続できない"))
        return out["tools"]

    def call(self, name: str, args: dict[str, Any]) -> dict[str, Any]:
        return self._req("POST", f"/api/v1/tools/{name}", args)


def _send(msg: dict[str, Any]) -> None:
    sys.stdout.write(json.dumps(msg, ensure_ascii=False) + "\n")
    sys.stdout.flush()


def _result(mid: Any, result: Any) -> None:
    _send({"jsonrpc": "2.0", "id": mid, "result": result})


def _error(mid: Any, code: int, message: str) -> None:
    _send({"jsonrpc": "2.0", "id": mid, "error": {"code": code, "message": message}})


def handle(client: Client, msg: dict[str, Any]) -> None:
    method = msg.get("method")
    mid = msg.get("id")
    params = msg.get("params") or {}
    if mid is None:  # 通知
        return
    if method == "initialize":
        want = params.get("protocolVersion")
        ver = want if want in PROTOCOL_VERSIONS else PROTOCOL_VERSIONS[0]
        _result(mid, {
            "protocolVersion": ver,
            "capabilities": {"tools": {"listChanged": False}},
            "serverInfo": {"name": SERVER_NAME, "version": SERVER_VERSION},
            "instructions": INSTRUCTIONS,
        })
    elif method == "ping":
        _result(mid, {})
    elif method == "tools/list":
        try:
            tools = client.tools()
        except Exception as e:  # noqa: BLE001
            _error(mid, -32000, str(e))
            return
        _result(mid, {"tools": [
            {
                "name": t["name"],
                "description": f"[{t['category']}] {t['description']}",
                "inputSchema": t["input_schema"],
                "annotations": {"readOnlyHint": t["category"] != "propose", "destructiveHint": False, "openWorldHint": False},
            }
            for t in tools
        ]})
    elif method == "tools/call":
        name = params.get("name", "")
        args = params.get("arguments") or {}
        if name == "add_document" and args.get("path") and not args.get("content_base64"):
            # このパソコンのファイルを読んで送る（stdio の接続だけ。エージェントが base64 を書かなくて済む）
            import base64

            try:
                with open(str(args["path"]), "rb") as f:
                    data = f.read(26 * 2**20)
            except OSError:
                _result(mid, {"content": [{"type": "text", "text": "ファイルを開けない"}], "isError": True})
                return
            args = {**{k: v for k, v in args.items() if k != "path"}, "content_base64": base64.b64encode(data).decode("ascii")}
            args.setdefault("filename", os.path.basename(str(params["arguments"]["path"])))
        out = client.call(name, args)
        if out.get("ok"):
            _result(mid, {"content": [{"type": "text", "text": json.dumps(out.get("result"), ensure_ascii=False)}], "isError": False})
        else:
            err = (out.get("error") or {}).get("message", "失敗")
            _result(mid, {"content": [{"type": "text", "text": err}], "isError": True})
    elif method in ("resources/list", "prompts/list"):
        _result(mid, {"resources": []} if method == "resources/list" else {"prompts": []})
    else:
        _error(mid, -32601, f"知らない method: {method}")


def main() -> int:
    if not sys.flags.isolated:
        sys.stderr.write("python -I で起動する\n")
        return 2
    token = os.environ.get("OKURA_WEB_TOKEN", "")
    if not token.startswith("okt_"):
        sys.stderr.write("OKURA_WEB_TOKEN（okura-web の 設定 → エージェント連携 で作る）が要る\n")
        return 2
    client = Client(os.environ.get("OKURA_WEB_URL", "http://127.0.0.1:8765"), token)
    for line in sys.stdin:
        line = line.strip()
        if not line:
            continue
        try:
            msg = json.loads(line)
        except ValueError:
            _error(None, -32700, "JSON を読めない")
            continue
        if isinstance(msg, list):
            for m in msg:
                if isinstance(m, dict):
                    handle(client, m)
        elif isinstance(msg, dict):
            handle(client, msg)
    return 0


if __name__ == "__main__":
    sys.exit(main())
