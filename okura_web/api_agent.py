"""エージェントの API：外部のエージェント（/api/v1/…、トークン）、アプリ内のエージェント（/api/agent/…）、写真の読み取り。"""

from __future__ import annotations

import json
import sys
import threading
import time
from typing import Any

from . import api
from . import db as dbm
from .access import CONSENT_KINDS, MASK
from .agent import LLMError, extract, llm_config, ping, run_chat, to_record
from .api import HttpError, Request, Response, router
from .tools import ToolError, call, context_for, specs


def _app():
    return api.APP


# ---------------------------------------------------------------------------- 外部のエージェント（MCP のサーバーもここを呼ぶ）
@router.route("GET", "/api/v1/tools", token_ok=True)
def v1_tools(req: Request) -> Any:
    p = req.principal
    assert p is not None
    cats: tuple[str, ...] | None = None
    if p.kind == "token":
        cats = tuple(c for c in ("read", "compute", "explain") if "read" in p.scopes) + (("propose",) if "propose" in p.scopes else ())
    return {
        "tools": specs(cats),
        "external": p.external if p.kind == "token" else False,
        "rules": "確定（データベースへの書き込み）の道具はない。提案は人が画面で確定する。外部のトークンでは伏せ字と同意のない人の除外がかかる。",
    }


@router.route("POST", "/api/v1/tools/{name}", token_ok=True)
def v1_call(req: Request) -> Any:
    p = req.principal
    assert p is not None
    api._hh(req)
    external = p.external if p.kind == "token" else False
    origin = f"{'mcp' if req.header('X-Okura-Client') == 'mcp' else 'api'}:{p.token_id or p.user_id}"
    ctx = context_for(_app(), p, external=external, origin=origin)
    args = req.json()
    try:
        result = call(ctx, req.params["name"], args if isinstance(args, dict) else {})
    except ToolError as e:
        return Response.json({"ok": False, "error": {"code": "tool_error", "message": str(e)}}, 400)
    _app().db.audit(p.household_id, p.actor, f"tool:{req.params['name']}")
    return {"ok": True, "result": result}


@router.route("GET", "/api/v1/openapi.json", public=True)
def openapi(req: Request) -> Any:
    paths: dict[str, Any] = {}
    for s in specs():
        paths[f"/api/v1/tools/{s['name']}"] = {
            "post": {
                "summary": s["description"],
                "tags": [s["category"]],
                "requestBody": {"required": True, "content": {"application/json": {"schema": s["input_schema"]}}},
                "responses": {"200": {"description": "{ok: true, result}"}, "400": {"description": "{ok: false, error}"}},
                "security": [{"bearer": []}],
            }
        }
    return {
        "openapi": "3.1.0",
        "info": {"title": "okura-web agent API", "version": "1", "description": "読む・計算する・説明する・提案する。確定は人が画面で行う。"},
        "components": {"securitySchemes": {"bearer": {"type": "http", "scheme": "bearer"}}},
        "paths": paths,
    }


# ---------------------------------------------------------------------------- アプリ内のエージェント
@router.route("GET", "/api/agent/scope")
def agent_scope(req: Request) -> Any:
    """外部の LLM に送るときの範囲（画面に出す）。"""
    hid = api._hh(req)
    acc = api._access(req)
    cfg = llm_config(_app(), hid)
    names = api._names(hid)
    return {
        "base_url": cfg.get("base_url"),
        "model": cfg.get("model"),
        "external": bool(cfg.get("external")),
        "persons_sent": [{"person_id": p, "name": names.get(p)} for p in acc.all_persons if acc.external_ok(p) and acc.sees_numbers(p)],
        "persons_not_sent": [{"person_id": p, "name": names.get(p), "reason": "外部の AI の同意がない" if not acc.external_ok(p) else "数字の同意がない"} for p in acc.all_persons if not (acc.external_ok(p) and acc.sees_numbers(p))],
        "masked": f"名前・住所・病院や会社の名前・自由記述（{MASK}）、生年月日は年だけ。人は仮名（人物1…）。添付した写真・PDF・表は伏せられないのでそのまま送る（持ち主が同意している場合だけ）",
        "consent_kind": CONSENT_KINDS["external_ai"],
        # 外部の AI に送るときの仮名 → 画面では名前に戻す（この人の画面に見える人だけ）
        "pseudonyms": {ps: names.get(pid) for pid, ps in acc.pseudonyms().items() if acc.sees_numbers(pid) and names.get(pid)},
    }


@router.route("POST", "/api/agent/chat")
def agent_chat(req: Request) -> Any:
    api._human(req)
    hid = api._hh(req)
    p = req.principal
    assert p is not None
    b = req.json()
    msg = str(b.get("message", "")).strip()
    att_ids = b.get("attachments") or []
    if not isinstance(att_ids, list) or len(att_ids) > MAX_ATTACH or not all(isinstance(x, str) for x in att_ids):
        raise HttpError(400, f"添付は {MAX_ATTACH} 個まで", code="bad_attachments")
    if not msg and att_ids:
        msg = "添付を読んで、登録する内容を提案して"
    if not msg or len(msg) > 20000:
        raise HttpError(400, "メッセージは1〜20000文字（長い表は添付で送る）", code="bad_message")
    cfg = llm_config(_app(), hid)
    external = bool(cfg.get("external"))
    parts, att_meta = _attachment_parts(req, hid, att_ids, msg, external)
    chat_id = b.get("chat_id")
    db = _app().db
    if chat_id:
        row = db.one("SELECT * FROM chats WHERE id=? AND household_id=? AND user_id=?", (chat_id, hid, p.user_id))
        if row is None:
            raise HttpError(404, "会話がない", code="not_found")
        if external and not row["external"] and not b.get("acknowledge_external"):
            raise HttpError(400, "設定が外部の LLM に変わった。送る範囲を確かめて同意する", code="ack_required")
    else:
        if external and not b.get("acknowledge_external"):
            raise HttpError(400, "外部の LLM に送る。送る範囲を確かめて同意する", code="ack_required", detail=agent_scope(req))
        chat_id = dbm.new_id("chat", 6)
        with db.tx() as c:
            c.execute("INSERT INTO chats(id, household_id, user_id, created_at, external) VALUES (?,?,?,?,?)", (chat_id, hid, p.user_id, dbm.now_iso(), 1 if external else 0))
    history = [json.loads(r["content"]) for r in db.all("SELECT content FROM chat_messages WHERE chat_id=? ORDER BY seq", (chat_id,))]
    history = history[-60:]
    while history and history[0].get("role") != "user":
        history = history[1:]  # 道具の結果だけが先頭に残らないように（会話の形を壊さない）
    ctx = context_for(_app(), p, external=external, origin="inapp-agent")
    with _RUNS_LOCK:
        if any(r["chat_id"] == chat_id and r["status"] == "running" for r in _RUNS.values()):
            raise HttpError(409, "この会話はまだ返事を作っている", code="busy")
        now = time.monotonic()
        for k in [k for k, r in _RUNS.items() if now - r["t"] > 900]:
            del _RUNS[k]
        rid = dbm.new_id("run", 8)
        _RUNS[rid] = {"status": "running", "chat_id": chat_id, "user_id": p.user_id, "hid": hid, "progress": [], "t": now, "external": external}

    def work() -> None:
        run = _RUNS[rid]
        try:
            added, trace = run_chat(_app(), ctx, history, msg, user_parts=parts, attachments=att_meta, on_step=lambda n: run["progress"].append(n))
            with db.tx() as c:
                for m in added:
                    c.execute("INSERT INTO chat_messages(chat_id, role, content, created_at) VALUES (?,?,?,?)", (chat_id, m["role"], json.dumps(m, ensure_ascii=False), dbm.now_iso()))
            db.audit(hid, p.actor, "agent_chat", chat_id)
            run.update(status="done", messages=added, trace=trace)
        except LLMError as e:
            run.update(status="error", error=str(e))
        except Exception as e:  # noqa: BLE001 - 中身はログに出さない（型だけ）
            sys.stderr.write(f"agent run failed: {type(e).__name__}\n")
            run.update(status="error", error="AI の返事を作れなかった")

    threading.Thread(target=work, daemon=True, name=f"agent-{rid}").start()
    return {"ok": True, "chat_id": chat_id, "run_id": rid, "external": external}


_RUNS: dict[str, dict[str, Any]] = {}
_RUNS_LOCK = threading.Lock()


@router.route("GET", "/api/agent/runs/{rid}")
def agent_run(req: Request) -> Any:
    """裏で進めている返事の状態（途中経過・終わったら新しいメッセージ）。"""
    api._human(req)
    p = req.principal
    assert p is not None
    run = _RUNS.get(req.params["rid"])
    if run is None or run["user_id"] != p.user_id:
        raise HttpError(404, "返事がない（古くなったかもしれない）", code="not_found")
    out: dict[str, Any] = {"status": run["status"], "chat_id": run["chat_id"], "progress": list(run["progress"])}
    if run["status"] == "done":
        out.update(messages=run["messages"], trace=run["trace"], external=run["external"])
    elif run["status"] == "error":
        out["error"] = run["error"]
    return out


MAX_ATTACH = 5
MAX_IMAGE_BYTES = 4_500_000  # 画像・PDF を1つ送る大きさの上限（モデルの上限より小さく）
_IMAGE = {"image/jpeg", "image/png", "image/webp", "image/gif"}


def _attachment_parts(req: Request, hid: str, ids: list[str], msg: str, external: bool) -> tuple[list[dict[str, Any]] | None, list[dict[str, Any]]]:
    """添付（原本の保管庫の ID）を、LLM に送る中身にする。画像は画像、PDF はファイル、表は文字。
    見られない原本は送らない。外部の AI のときは、持ち主が「外部の AI」に同意している原本だけ（写真・表は伏せ字にできない）。"""
    if not ids:
        return None, []
    import base64

    from .sheets import SheetError, read_table

    acc = api._access(req)
    parts: list[dict[str, Any]] = [{"type": "text", "text": msg}]
    meta: list[dict[str, Any]] = []
    for eid in ids:
        row = api._evidence_row(hid, eid)
        if not acc.sees_original(row["owner_person"], row["uploaded_by"]):
            raise HttpError(403, "見られない書類は送れない", code="forbidden")
        if external and not acc.external_ok(row["owner_person"]):
            raise HttpError(403, "この添付の持ち主が「外部の AI」に同意していないので、外部の AI に送れない（設定 → 共有設定）", code="no_external_consent")
        data = _app().ledger(hid).evidence_path(row["sha256"], row["ext"]).read_bytes()
        name = row["label"] or f"{row['id']}.{row['ext']}"
        meta.append({"evidence_id": row["id"], "name": name, "mime": row["mime"]})
        head = f"（添付 evidence_id={row['id']}・{name}）"
        if row["mime"] in _IMAGE:
            if len(data) > MAX_IMAGE_BYTES:
                raise HttpError(413, f"画像が大きすぎる（{name}）", code="too_large")
            parts.append({"type": "text", "text": head})
            parts.append({"type": "image_url", "image_url": {"url": f"data:{row['mime']};base64,{base64.b64encode(data).decode('ascii')}"}})
        elif row["mime"] == "application/pdf":
            if len(data) > MAX_IMAGE_BYTES * 4:
                raise HttpError(413, f"PDF が大きすぎる（{name}）", code="too_large")
            parts.append({"type": "text", "text": head})
            parts.append({"type": "file", "file": {"filename": f"{row['id']}.pdf", "file_data": f"data:application/pdf;base64,{base64.b64encode(data).decode('ascii')}"}})
        elif row["ext"] in ("xlsx", "csv", "tsv", "txt"):
            try:
                parts.append({"type": "text", "text": head + "\n" + read_table(name, row["ext"], data)})
            except SheetError as e:
                raise HttpError(400, f"{name}：{e}", code="bad_table") from e
        else:
            raise HttpError(415, f"この形式はまだ読めない（{name}。HEIC は JPEG にして送る）", code="unsupported_type")
    return parts, meta


@router.route("POST", "/api/agent/chats/{cid}/note")
def agent_chat_note(req: Request) -> Any:
    """画面のカードで人がしたこと（登録した・やめた）を会話に残す（AI は次の返事でそれを知る）。LLM は呼ばない。"""
    api._human(req)
    hid = api._hh(req)
    p = req.principal
    assert p is not None
    row = _app().db.one("SELECT id FROM chats WHERE id=? AND household_id=? AND user_id=?", (req.params["cid"], hid, p.user_id))
    if row is None:
        raise HttpError(404, "会話がない", code="not_found")
    text = str(req.json().get("text") or "").strip()[:500]
    if not text:
        raise HttpError(400, "text が要る", code="bad_text")
    m = {"role": "user", "content": f"（画面で：{text}）", "note": True}
    with _app().db.tx() as c:
        c.execute("INSERT INTO chat_messages(chat_id, role, content, created_at) VALUES (?,?,?,?)", (row["id"], "user", json.dumps(m, ensure_ascii=False), dbm.now_iso()))
    return {"ok": True}


@router.route("GET", "/api/agent/chats")
def agent_chats(req: Request) -> Any:
    hid = api._hh(req)
    p = req.principal
    assert p is not None
    rows = _app().db.all(
        "SELECT c.id, c.created_at, c.external, MAX(m.created_at) AS updated_at, COUNT(m.seq) AS n FROM chats c "
        "LEFT JOIN chat_messages m ON m.chat_id=c.id WHERE c.household_id=? AND c.user_id=? GROUP BY c.id ORDER BY updated_at DESC LIMIT 100",
        (hid, p.user_id),
    )
    out = []
    for r in rows:
        if not r["n"]:
            continue
        title = ""
        for m in _app().db.all("SELECT content FROM chat_messages WHERE chat_id=? AND role='user' ORDER BY seq LIMIT 5", (r["id"],)):
            d = json.loads(m["content"])
            if not d.get("note") and d.get("content"):
                title = str(d["content"]).strip().splitlines()[0][:60]
                if d.get("attachments") and not title:
                    title = "添付：" + "、".join(a.get("name") or "" for a in d["attachments"])
                break
        out.append({"id": r["id"], "title": title or "（会話）", "created_at": r["created_at"], "updated_at": r["updated_at"], "external": bool(r["external"])})
    return {"chats": out}


@router.route("GET", "/api/agent/chats/{cid}")
def agent_chat_get(req: Request) -> Any:
    hid = api._hh(req)
    p = req.principal
    assert p is not None
    row = _app().db.one("SELECT * FROM chats WHERE id=? AND household_id=? AND user_id=?", (req.params["cid"], hid, p.user_id))
    if row is None:
        raise HttpError(404, "会話がない", code="not_found")
    msgs = [json.loads(r["content"]) for r in _app().db.all("SELECT content FROM chat_messages WHERE chat_id=? ORDER BY seq", (row["id"],))]
    return {"chat": dict(row), "messages": msgs}


@router.route("POST", "/api/llm/test")
def llm_test(req: Request) -> Any:
    api._admin(req)
    hid = api._hh(req)
    return ping(llm_config(_app(), hid))


# ---------------------------------------------------------------------------- 写真の読み取り（OCR・AI）
@router.route("POST", "/api/evidence/{eid}/extract")
def evidence_extract(req: Request) -> Any:
    """AI で写真を読み、記録の下書きを確認待ちに入れる。確かめた印（人の確定）が付くまで台帳に書かない。"""
    api._human(req)
    hid = api._hh(req)
    acc = api._access(req)
    row = api._evidence_row(hid, req.params["eid"])
    if not acc.sees_original(row["owner_person"], row["uploaded_by"]):
        raise HttpError(403, "見えない書類は読み取れない", code="forbidden")
    cfg = llm_config(_app(), hid)
    b = req.json()
    if cfg.get("external"):
        if not acc.external_ok(row["owner_person"]):
            raise HttpError(403, "この書類の持ち主が外部の AI に渡す同意をしていない", code="no_external_consent")
        if not b.get("acknowledge_external"):
            raise HttpError(400, "この写真を外部の LLM API に送る。確かめて同意する", code="ack_required")
    data = _app().ledger(hid).evidence_path(row["sha256"], row["ext"]).read_bytes()
    try:
        read = extract(_app(), hid, data, row["mime"])
    except LLMError as e:
        raise HttpError(502, str(e), code="llm_error") from e
    mapped = to_record(read, row["owner_person"])
    p = req.principal
    assert p is not None
    if mapped is None:
        return {"ok": True, "read": read, "proposal_id": None, "note": "書類の種類が分からなかった。画面で種類を選んで入れる"}
    section, rec = mapped
    prid = api.create_proposal(hid, kind="record", payload={"section": section, "record": rec, "read": read}, rationale="AI の読み取り（未確認）", candidates=None, evidence_id=row["id"], origin="ai-ocr", created_by=f"user:{p.user_id}")
    _app().db.audit(hid, p.actor, "evidence_extracted", row["id"])
    return {"ok": True, "read": read, "proposal_id": prid}
