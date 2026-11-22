"""画面のための API（/api/…）。画面のセッション（人）で使う。エージェントの API は api_agent.py（/api/v1/…）。

書き込み（台帳への確定）は、画面で人が押したときだけ（⑬）。エージェントのトークンでは呼べない（server の token_ok がない経路）。
"""

from __future__ import annotations

import sys
import datetime as _dt
import json
import re
from typing import Any
from urllib.parse import urlsplit

from . import db as dbm
from .access import CONSENT_KINDS, Access, current_consents, persons_in
from .app import App, default_query
from .auth import check_password_strength, hash_password
from .engine import EngineError
from .results import answer_template, forms_detail, time_key, value_detail, values_for
from .server import HttpError, Request, Response, Router, clear_cookie, session_cookie, web_build

router = Router()
APP: App  # serve.py が入れる

SECTION_PREFIX = {
    "relations": "r",
    "residences": "res",
    "insurance_memberships": "ins",
    "facts": "f",
    "assets": "a",
    "filed_documents": "fd",
    "judgments": "j",
    "choices": "c",
}
RECORD_SECTIONS = ("relations", "residences", "insurance_memberships", "facts", "assets", "filed_documents")
LEDGER_SECTIONS = ("judgments", "choices")

_DATE = re.compile(r"^\d{4}-\d{2}-\d{2}$")


# ---------------------------------------------------------------------------- 共通
def _hh(req: Request) -> str:
    p = req.principal
    if p is None or p.household_id is None:
        raise HttpError(403, "世帯に属していない", code="no_household")
    return p.household_id


def _human(req: Request) -> None:
    if req.principal is None or not req.principal.is_human:
        raise HttpError(403, "画面で人が操作する必要がある", code="human_only")


def _admin(req: Request) -> None:
    _human(req)
    if req.principal is None or req.principal.role != "admin":
        raise HttpError(403, "世帯の管理者だけができる", code="admin_only")


def _access(req: Request) -> Access:
    _hh(req)
    assert req.principal is not None
    return Access.load(APP.db, req.principal)


def _engine_error(e: EngineError) -> HttpError:
    return HttpError(422, str(e), code=e.code, detail=e.problems)


def _names(hid: str) -> dict[str, str]:
    return {r["person_id"]: r["display_name"] for r in APP.db.all("SELECT person_id, display_name FROM persons WHERE household_id=?", (hid,))}


def _audit(req: Request, action: str, target: str | None = None) -> None:
    p = req.principal
    APP.db.audit(p.household_id if p else None, p.actor if p else "anonymous", action, target)


def _check_date(v: Any, what: str) -> str:
    if not isinstance(v, str) or not _DATE.match(v):
        raise HttpError(400, f"{what} は YYYY-MM-DD", code="bad_date")
    try:
        _dt.date.fromisoformat(v)
    except ValueError as e:
        raise HttpError(400, f"{what} が実在しない日付", code="bad_date") from e
    return v


def _check_name(v: Any, what: str, maxlen: int = 40) -> str:
    if not isinstance(v, str) or not v.strip() or len(v) > maxlen or any(ord(c) < 32 for c in v):
        raise HttpError(400, f"{what} は1〜{maxlen}文字", code="bad_name")
    return v.strip()


def _recalc(hid: str, user_id: str) -> str:
    return APP.enqueue(hid, user_id)


# ---------------------------------------------------------------------------- 初期設定・ログイン


@router.route("GET", "/api/status", public=True)
def status(req: Request) -> Any:
    n = APP.db.one("SELECT COUNT(*) AS n FROM users")["n"]
    return {"initialized": n > 0, "app": "okura-web", "build": web_build(APP.cfg.web_dir), "okura_gov": APP.engine.okura_gov_version()}


@router.route("POST", "/api/setup", public=True, no_csrf=True)
def setup(req: Request) -> Any:
    with APP.db.write_lock:
        if APP.db.one("SELECT COUNT(*) AS n FROM users")["n"] > 0:
            raise HttpError(409, "初期設定は済んでいる", code="already_initialized")
        b = req.json()
        login = _check_name(b.get("login"), "ログイン名", 40)
        if not re.fullmatch(r"[A-Za-z0-9_.\-]{3,40}", login):
            raise HttpError(400, "ログイン名は英数字と _ . - の3〜40文字", code="bad_login")
        pw = b.get("password") or ""
        msg = check_password_strength(pw)
        if msg:
            raise HttpError(400, msg, code="weak_password")
        display = _check_name(b.get("display_name"), "表示名")
        hname = _check_name(b.get("household_name") or "わが家", "世帯の名前")
        birth = _check_date(b.get("birth_on"), "生年月日")
        uid, hid, pid = dbm.new_id("u", 6), "hh-" + dbm.new_id("x", 8)[2:], dbm.new_id("p", 4)
        lg = APP.ledger(hid)
        lg.ensure()
        try:
            lg.write("facts", [{"op": "add", "section": "persons", "record": {"id": pid, "birth_on": birth}}], recorded_by_person=pid)
        except EngineError as e:
            raise _engine_error(e) from e
        now = dbm.now_iso()
        with APP.db.tx() as c:
            c.execute("INSERT INTO users(id, login, display_name, pw_hash, created_at) VALUES (?,?,?,?,?)", (uid, login, display, hash_password(pw), now))
            c.execute("INSERT INTO households(id, name, created_at) VALUES (?,?,?)", (hid, hname, now))
            c.execute("INSERT INTO memberships(user_id, household_id, role, person_id) VALUES (?,?,?,?)", (uid, hid, "admin", pid))
            c.execute("INSERT INTO persons(household_id, person_id, display_name, created_by, created_at) VALUES (?,?,?,?,?)", (hid, pid, display, uid, now))
    APP.db.audit(hid, f"user:{uid}", "setup")
    return _login_response(login, pw)


def _login_response(login: str, pw: str) -> Response:
    got = APP.auth.login(login, pw)
    if got is None:
        raise HttpError(401, "ログイン名かパスワードが違う", code="bad_login")
    token, csrf = got
    resp = Response.json({"ok": True, "csrf": csrf})
    resp.headers["Set-Cookie"] = session_cookie(token, APP.cfg.session_hours * 3600)
    return resp


@router.route("POST", "/api/login", public=True, no_csrf=True)
def login(req: Request) -> Any:
    b = req.json()
    return _login_response(str(b.get("login", "")), str(b.get("password", "")))


@router.route("POST", "/api/logout")
def logout(req: Request) -> Any:
    if req.session_token:
        APP.auth.logout(req.session_token)
    resp = Response.json({"ok": True})
    resp.headers["Set-Cookie"] = clear_cookie()
    return resp


@router.route("GET", "/api/me")
def me(req: Request) -> Any:
    p = req.principal
    assert p is not None
    hh = APP.db.one("SELECT * FROM households WHERE id=?", (p.household_id,)) if p.household_id else None
    acc = Access.load(APP.db, p) if p.household_id else None
    return {
        "user": {"id": p.user_id, "display_name": p.display_name},
        "household": dict(hh) if hh else None,
        "role": p.role,
        "person_id": p.person_id,
        "csrf": p.csrf,
        "managed": sorted(acc.managed - acc.account_persons) if acc else [],
        "consents_missing": sorted(k for k in CONSENT_KINDS if acc and p.person_id and (p.person_id, k) not in acc.consents),
    }


@router.route("POST", "/api/me/password")
def change_password(req: Request) -> Any:
    _human(req)
    b = req.json()
    p = req.principal
    assert p is not None
    row = APP.db.one("SELECT login FROM users WHERE id=?", (p.user_id,))
    if APP.auth.login(row["login"], str(b.get("current", ""))) is None:
        raise HttpError(400, "今のパスワードが違う", code="bad_password")
    msg = check_password_strength(str(b.get("new", "")))
    if msg:
        raise HttpError(400, msg, code="weak_password")
    with APP.db.tx() as c:
        c.execute("UPDATE users SET pw_hash=? WHERE id=?", (hash_password(str(b["new"])), p.user_id))
        c.execute("DELETE FROM sessions WHERE user_id=?", (p.user_id,))
    _audit(req, "password_changed")
    return {"ok": True, "relogin": True}


# ---------------------------------------------------------------------------- 世帯と人
@router.route("GET", "/api/household")
def household(req: Request) -> Any:
    hid = _hh(req)
    acc = _access(req)
    ir_persons: dict[str, dict[str, Any]] = {}
    ir_error = None
    try:
        ir = APP.ledger(hid).get_ir()
        ir_persons = {p["id"]: p for p in ir.get("persons", [])}
    except EngineError as e:
        ir_error = {"message": str(e), "code": e.code, "problems": e.problems[:20]}
    members = {r["person_id"]: dict(r) for r in APP.db.all(
        "SELECT m.person_id, m.role, u.login, u.display_name AS user_name, u.id AS user_id FROM memberships m JOIN users u ON u.id=m.user_id WHERE m.household_id=?",
        (hid,),
    )}
    managers: dict[str, list[str]] = {}
    for r in APP.db.all("SELECT pm.person_id, u.display_name FROM person_managers pm JOIN users u ON u.id=pm.user_id WHERE pm.household_id=?", (hid,)):
        managers.setdefault(r["person_id"], []).append(r["display_name"])
    persons = []
    for r in APP.db.all("SELECT * FROM persons WHERE household_id=? ORDER BY created_at, person_id", (hid,)):
        pid = r["person_id"]
        irp = ir_persons.get(pid, {})
        m = members.get(pid)
        persons.append(
            {
                "person_id": pid,
                "display_name": r["display_name"],
                "birth_on": irp.get("birth_on") if acc.sees_numbers(pid) else None,
                "death_on": irp.get("death_on") if acc.sees_numbers(pid) else None,
                "has_account": m is not None,
                "role": m["role"] if m else None,
                "login": m["login"] if (m and req.principal and req.principal.role == "admin") else None,
                "is_me": pid == acc.me,
                "is_mine": acc.is_mine(pid),
                "can_decide": acc.can_decide_for(pid),
                "managers": managers.get(pid, []),
                "consents": {k: acc.consent(pid, k) for k in CONSENT_KINDS},
                "consents_decided": {k: (pid, k) in acc.consents for k in CONSENT_KINDS},
                "sees_numbers": acc.sees_numbers(pid),
            }
        )
    hh = APP.db.one("SELECT * FROM households WHERE id=?", (hid,))
    return {"household": dict(hh), "persons": persons, "me": acc.me, "ir_error": ir_error}


@router.route("POST", "/api/persons")
def add_person(req: Request) -> Any:
    _human(req)
    b = req.json()
    return create_person(req, b.get("display_name"), b.get("birth_on"))


def create_person(req: Request, display_name: Any, birth_on: Any) -> dict[str, Any]:
    """家族（人）を足す。人のセッションからだけ呼ぶ（画面の「家族を追加」と、AI の提案を人が確かめて登録するとき）。"""
    _human(req)
    hid = _hh(req)
    name = _check_name(display_name, "表示名")
    birth = _check_date(birth_on, "生年月日")
    pid = dbm.new_id("p", 4)
    p = req.principal
    assert p is not None and p.person_id
    try:
        APP.ledger(hid).write("facts", [{"op": "add", "section": "persons", "record": {"id": pid, "birth_on": birth}}], recorded_by_person=p.person_id)
    except EngineError as e:
        raise _engine_error(e) from e
    with APP.db.tx() as c:
        c.execute("INSERT INTO persons(household_id, person_id, display_name, created_by, created_at) VALUES (?,?,?,?,?)", (hid, pid, name, p.user_id, dbm.now_iso()))
        c.execute("INSERT INTO person_managers(household_id, person_id, user_id) VALUES (?,?,?)", (hid, pid, p.user_id))
    _audit(req, "person_added", pid)
    return {"ok": True, "person_id": pid, "job_id": _recalc(hid, p.user_id)}


@router.route("POST", "/api/persons/{pid}/rename")
def rename_person(req: Request) -> Any:
    _human(req)
    hid = _hh(req)
    acc = _access(req)
    pid = req.params["pid"]
    if not (acc.is_mine(pid) or (req.principal and req.principal.role == "admin")):
        raise HttpError(403, "本人・管理する人・世帯の管理者だけが変えられる", code="forbidden")
    name = _check_name(req.json().get("display_name"), "表示名")
    with APP.db.tx() as c:
        c.execute("UPDATE persons SET display_name=? WHERE household_id=? AND person_id=?", (name, hid, pid))
    return {"ok": True}


@router.route("POST", "/api/persons/{pid}/managers")
def add_manager(req: Request) -> Any:
    _admin(req)
    hid = _hh(req)
    uid = str(req.json().get("user_id", ""))
    if APP.db.one("SELECT 1 FROM memberships WHERE household_id=? AND user_id=?", (hid, uid)) is None:
        raise HttpError(400, "世帯のアカウントでない", code="bad_user")
    with APP.db.tx() as c:
        c.execute("INSERT OR IGNORE INTO person_managers(household_id, person_id, user_id) VALUES (?,?,?)", (hid, req.params["pid"], uid))
    _audit(req, "manager_added", req.params["pid"])
    return {"ok": True}


@router.route("POST", "/api/members")
def add_member(req: Request) -> Any:
    """アカウントを作る（世帯の管理者）。既存の人に結びつけるか、新しい人を作る。"""
    _admin(req)
    hid = _hh(req)
    b = req.json()
    login = str(b.get("login", ""))
    if not re.fullmatch(r"[A-Za-z0-9_.\-]{3,40}", login):
        raise HttpError(400, "ログイン名は英数字と _ . - の3〜40文字", code="bad_login")
    if APP.db.one("SELECT 1 FROM users WHERE login=?", (login,)):
        raise HttpError(409, "そのログイン名は使われている", code="login_taken")
    pw = str(b.get("password", ""))
    msg = check_password_strength(pw)
    if msg:
        raise HttpError(400, msg, code="weak_password")
    role = b.get("role", "member")
    if role not in ("admin", "member"):
        raise HttpError(400, "role は admin か member", code="bad_role")
    pid = b.get("person_id")
    p = req.principal
    assert p is not None and p.person_id
    if pid:
        if APP.db.one("SELECT 1 FROM persons WHERE household_id=? AND person_id=?", (hid, pid)) is None:
            raise HttpError(400, "その人がいない", code="bad_person")
        if APP.db.one("SELECT 1 FROM memberships WHERE household_id=? AND person_id=?", (hid, pid)):
            raise HttpError(409, "その人にはもうアカウントがある", code="has_account")
        display = APP.db.one("SELECT display_name FROM persons WHERE household_id=? AND person_id=?", (hid, pid))["display_name"]
    else:
        display = _check_name(b.get("display_name"), "表示名")
        birth = _check_date(b.get("birth_on"), "生年月日")
        pid = dbm.new_id("p", 4)
        try:
            APP.ledger(hid).write("facts", [{"op": "add", "section": "persons", "record": {"id": pid, "birth_on": birth}}], recorded_by_person=p.person_id)
        except EngineError as e:
            raise _engine_error(e) from e
        with APP.db.tx() as c:
            c.execute("INSERT INTO persons(household_id, person_id, display_name, created_by, created_at) VALUES (?,?,?,?,?)", (hid, pid, display, p.user_id, dbm.now_iso()))
    uid = dbm.new_id("u", 6)
    with APP.db.tx() as c:
        c.execute("INSERT INTO users(id, login, display_name, pw_hash, created_at) VALUES (?,?,?,?,?)", (uid, login, display, hash_password(pw), dbm.now_iso()))
        c.execute("INSERT INTO memberships(user_id, household_id, role, person_id) VALUES (?,?,?,?)", (uid, hid, role, pid))
    _audit(req, "member_added", pid)
    return {"ok": True, "user_id": uid, "person_id": pid}


@router.route("GET", "/api/members")
def list_members(req: Request) -> Any:
    hid = _hh(req)
    rows = APP.db.all(
        "SELECT u.id, u.login, u.display_name, m.role, m.person_id FROM memberships m JOIN users u ON u.id=m.user_id WHERE m.household_id=? ORDER BY u.created_at",
        (hid,),
    )
    is_admin = req.principal is not None and req.principal.role == "admin"
    return {"members": [{**dict(r), "login": r["login"] if is_admin else None} for r in rows]}


# ---------------------------------------------------------------------------- 同意
@router.route("GET", "/api/consents")
def consents(req: Request) -> Any:
    hid = _hh(req)
    acc = _access(req)
    names = _names(hid)
    hist = []
    for r in APP.db.all("SELECT c.*, u.display_name AS by_name FROM consents c LEFT JOIN users u ON u.id=c.decided_by WHERE c.household_id=? ORDER BY c.seq DESC LIMIT 200", (hid,)):
        hist.append({"person_id": r["person_id"], "person": names.get(r["person_id"]), "kind": r["kind"], "value": bool(r["value"]), "decided_by": r["by_name"], "decided_at": r["decided_at"], "note": r["note"]})
    return {
        "kinds": CONSENT_KINDS,
        "current": {f"{p}|{k}": {"value": bool(v["value"]), "decided_at": v["decided_at"]} for (p, k), v in acc.consents.items()},
        "can_decide": [p for p in names if acc.can_decide_for(p)],
        "history": hist,
    }


@router.route("POST", "/api/consents")
def set_consent(req: Request) -> Any:
    _human(req)
    hid = _hh(req)
    acc = _access(req)
    b = req.json()
    pid, kind = str(b.get("person_id", "")), str(b.get("kind", ""))
    if kind not in CONSENT_KINDS:
        raise HttpError(400, "同意の種類が違う", code="bad_kind")
    if not acc.can_decide_for(pid):
        raise HttpError(403, "同意を決められるのは本人（アカウントのない人は管理する人）だけ", code="forbidden")
    note = b.get("note")
    if note is not None:
        note = _check_name(note, "メモ", 200)
    assert req.principal is not None
    with APP.db.tx() as c:
        c.execute(
            "INSERT INTO consents(household_id, person_id, kind, value, decided_by, decided_at, note) VALUES (?,?,?,?,?,?,?)",
            (hid, pid, kind, 1 if b.get("value") else 0, req.principal.user_id, dbm.now_iso(), note),
        )
    _audit(req, f"consent:{kind}:{'on' if b.get('value') else 'off'}", pid)
    return {"ok": True}


# ---------------------------------------------------------------------------- 語彙・版
@router.route("GET", "/api/meta")
def meta(req: Request) -> Any:
    try:
        m = APP.meta()
    except EngineError as e:
        raise _engine_error(e) from e
    return {**m, "okura_gov": APP.engine.okura_gov_version(), "consent_kinds": CONSENT_KINDS}


# ---------------------------------------------------------------------------- 証憑（写真・PDF）
_MAGIC = [
    (b"\xff\xd8\xff", "jpg", "image/jpeg"),
    (b"\x89PNG\r\n\x1a\n", "png", "image/png"),
    (b"GIF87a", "gif", "image/gif"),
    (b"GIF89a", "gif", "image/gif"),
    (b"%PDF-", "pdf", "application/pdf"),
]


def sniff(data: bytes) -> tuple[str, str] | None:
    for magic, ext, mime in _MAGIC:
        if data.startswith(magic):
            return ext, mime
    if data[:4] == b"RIFF" and data[8:12] == b"WEBP":
        return "webp", "image/webp"
    if data[4:8] == b"ftyp" and data[8:12] in (b"heic", b"heix", b"mif1", b"msf1", b"heim", b"heis"):
        return "heic", "image/heic"
    return None


TABLE_TYPES = {"xlsx": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet", "csv": "text/csv", "tsv": "text/tab-separated-values", "txt": "text/plain"}


def sniff_table(data: bytes, name: str) -> tuple[str, str] | None:
    """表・文字のファイル（中身の先頭では見分けられないので、名前の拡張子と中身の両方で確かめる）。"""
    ext = name.lower().rsplit(".", 1)[-1] if "." in name else ""
    if ext == "xlsx" and data.startswith(b"PK\x03\x04"):
        return "xlsx", TABLE_TYPES["xlsx"]
    if ext in ("csv", "tsv", "txt") and b"\x00" not in data[:65536]:
        for enc in ("utf-8-sig", "cp932"):
            try:
                data[:65536].decode(enc)
                return ext, TABLE_TYPES[ext]
            except UnicodeDecodeError:
                continue
    return None


def _evidence_row(hid: str, eid: str) -> dict[str, Any]:
    row = APP.db.one("SELECT * FROM evidence WHERE household_id=? AND id=?", (hid, eid))
    if row is None:
        raise HttpError(404, "証憑がない", code="not_found")
    return dict(row)


def _links(hid: str) -> dict[str, list[str]]:
    out: dict[str, list[str]] = {}
    for r in APP.db.all("SELECT evidence_id, record_id FROM evidence_links WHERE household_id=? ORDER BY seq", (hid,)):
        lst = out.setdefault(r["evidence_id"], [])
        if r["record_id"] not in lst:
            lst.append(r["record_id"])
    return out


@router.route("POST", "/api/evidence")
def upload_evidence(req: Request) -> Any:
    _human(req)
    hid = _hh(req)
    acc = _access(req)
    assert req.principal is not None
    out = store_document(hid, acc, req.principal.user_id, req.arg("owner") or acc.me, req.body(APP.cfg.max_upload_bytes), req.arg("name") or "", req.arg("label"))
    if not out["duplicate"]:
        _audit(req, "evidence_uploaded", out["id"])
    return out


def store_document(hid: str, acc: Access, user_id: str, owner: Any, data: bytes, name: str, label: Any) -> dict[str, Any]:
    """書類（写真・PDF・表）を保存する。画面のアップロードと、エージェント（MCP）からの追加の両方が通る。
    保存するだけで、記録は作らない（記録は、人が画面で確かめて登録したときにできる）。同じ中身の書類は二重に置かない。"""
    if owner not in acc.all_persons:
        raise HttpError(400, "持ち主の人がいない", code="bad_person")
    if not data:
        raise HttpError(400, "中身が空", code="empty")
    if len(data) > APP.cfg.max_upload_bytes:
        raise HttpError(413, "書類が大きすぎる", code="too_large")
    kind = sniff(data) or sniff_table(data, name or "")
    if kind is None:
        raise HttpError(415, "画像（JPEG・PNG・WebP・HEIC・GIF）・PDF・Excel（.xlsx）・CSV・テキストだけを受け付ける", code="unsupported_type")
    ext, mime = kind
    lg = APP.ledger(hid)
    sha, _ = lg.store_evidence(data, ext)
    existing = APP.db.one("SELECT id FROM evidence WHERE household_id=? AND sha256=?", (hid, sha))
    if existing:
        return {"ok": True, "id": existing["id"], "sha256": sha, "duplicate": True}
    eid = dbm.new_id("ev", 6)
    if label:
        label = _check_name(label, "ラベル", 100)
    with APP.db.tx() as c:
        c.execute(
            "INSERT INTO evidence(id, household_id, sha256, ext, mime, size, owner_person, uploaded_by, uploaded_at, label) VALUES (?,?,?,?,?,?,?,?,?,?)",
            (eid, hid, sha, ext, mime, len(data), owner, user_id, dbm.now_iso(), label or None),
        )
    return {"ok": True, "id": eid, "sha256": sha, "duplicate": False}


@router.route("GET", "/api/evidence")
def list_evidence(req: Request) -> Any:
    hid = _hh(req)
    acc = _access(req)
    links = _links(hid)
    pending = {r["evidence_id"]: r["n"] for r in APP.db.all("SELECT evidence_id, COUNT(*) AS n FROM proposals WHERE household_id=? AND status='pending' AND evidence_id IS NOT NULL GROUP BY evidence_id", (hid,))}
    out = []
    hidden = 0
    for r in APP.db.all("SELECT * FROM evidence WHERE household_id=? ORDER BY uploaded_at DESC", (hid,)):
        if not acc.sees_original(r["owner_person"], r["uploaded_by"]):
            hidden += 1
            continue
        out.append({**dict(r), "records": links.get(r["id"], []), "pending": pending.get(r["id"], 0)})
    return {"evidence": out, "hidden": hidden}


@router.route("GET", "/api/evidence/{eid}")
def get_evidence(req: Request) -> Any:
    hid = _hh(req)
    acc = _access(req)
    row = _evidence_row(hid, req.params["eid"])
    if not acc.sees_original(row["owner_person"], row["uploaded_by"]):
        raise HttpError(403, "この書類は本人の同意がないので見られない", code="forbidden")
    intact = APP.ledger(hid).verify_evidence(row["sha256"], row["ext"])
    return {**row, "records": _links(hid).get(row["id"], []), "intact": intact}


@router.route("GET", "/api/evidence/{eid}/file")
def evidence_file(req: Request) -> Any:
    hid = _hh(req)
    acc = _access(req)
    row = _evidence_row(hid, req.params["eid"])
    if not acc.sees_original(row["owner_person"], row["uploaded_by"]):
        raise HttpError(403, "この書類は本人の同意がないので見られない", code="forbidden")
    path = APP.ledger(hid).evidence_path(row["sha256"], row["ext"])
    csp = "default-src 'none'; img-src 'self'; style-src 'unsafe-inline'; frame-ancestors 'self'"
    if row["mime"] != "application/pdf":
        csp = "sandbox; " + csp
    disp = "inline" if row["mime"].startswith("image/") or row["mime"] == "application/pdf" else "attachment"
    return Response(200, path.read_bytes(), row["mime"], {
        "Content-Security-Policy": csp,
        "Content-Disposition": f'{disp}; filename="{row["sha256"][:12]}.{row["ext"]}"',
        "Cache-Control": "private, max-age=3600",
    })


@router.route("POST", "/api/evidence/{eid}/meta")
def evidence_meta(req: Request) -> Any:
    """書類の種類（画面の分類）と「対象外」（税・保険に関係ない写真）の印。原本は変えない。"""
    _human(req)
    hid = _hh(req)
    acc = _access(req)
    row = _evidence_row(hid, req.params["eid"])
    if not acc.sees_original(row["owner_person"], row["uploaded_by"]):
        raise HttpError(403, "見えない書類", code="forbidden")
    b = req.json()
    sets, args = [], []
    if "doc_type" in b:
        dt = b["doc_type"]
        if dt is not None and not re.fullmatch(r"[a-z_]{1,32}", str(dt)):
            raise HttpError(400, "doc_type の形が違う", code="bad_doc_type")
        sets.append("doc_type=?")
        args.append(dt)
    if "ignored" in b:
        sets.append("ignored=?")
        args.append(1 if b["ignored"] else 0)
    if "label" in b:
        sets.append("label=?")
        args.append(_check_name(b["label"], "ラベル", 100) if b["label"] else None)
    if sets:
        with APP.db.tx() as c:
            c.execute(f"UPDATE evidence SET {', '.join(sets)} WHERE id=?", (*args, row["id"]))
    return {"ok": True}


@router.route("POST", "/api/evidence/{eid}/owner")
def evidence_owner(req: Request) -> Any:
    _human(req)
    hid = _hh(req)
    acc = _access(req)
    row = _evidence_row(hid, req.params["eid"])
    if not (acc.is_mine(row["owner_person"]) or row["uploaded_by"] == (req.principal.user_id if req.principal else None)):
        raise HttpError(403, "持ち主か、アップロードした人だけが変えられる", code="forbidden")
    owner = str(req.json().get("owner", ""))
    if owner not in acc.all_persons:
        raise HttpError(400, "その人がいない", code="bad_person")
    with APP.db.tx() as c:
        c.execute("UPDATE evidence SET owner_person=? WHERE id=?", (owner, row["id"]))
    _audit(req, "evidence_owner_changed", row["id"])
    return {"ok": True}


# ---------------------------------------------------------------------------- 記録
def _ir(hid: str) -> dict[str, Any]:
    try:
        return APP.ledger(hid).get_ir()
    except EngineError as e:
        raise _engine_error(e) from e


def _recorders(hid: str) -> dict[str, str]:
    out: dict[str, str] = {}
    lg = APP.ledger(hid)
    for which in ("facts", "judgments"):
        for rid, e in lg.heads(which).items():
            rb = e.get("recorded_by") or {}
            out[rid] = rb.get("person", "")
    return out


def visible_records(hid: str, acc: Access, *, section: str | None = None) -> tuple[list[dict[str, Any]], int]:
    """台帳の今の記録のうち、この人に見えるもの（明細の同意）。見えない件数も返す。"""
    ir = _ir(hid)
    known = set(p["id"] for p in ir.get("persons", []))
    recorders = _recorders(hid)
    links: dict[str, list[str]] = {}
    for eid, rids in _links(hid).items():
        for rid in rids:
            links.setdefault(rid, []).append(eid)
    out: list[dict[str, Any]] = []
    hidden = 0
    for sec in (*RECORD_SECTIONS, *LEDGER_SECTIONS):
        if section and sec != section:
            continue
        for rec in ir.get(sec, []):
            ps = persons_in(rec, known)
            if not acc.sees_details_of(ps, recorders.get(rec["id"])):
                hidden += 1
                continue
            out.append({"section": sec, "record": rec, "persons": sorted(ps), "evidence": links.get(rec["id"], []), "recorded_by": recorders.get(rec["id"])})
    return out, hidden


@router.route("GET", "/api/records")
def list_records(req: Request) -> Any:
    hid = _hh(req)
    acc = _access(req)
    items, hidden = visible_records(hid, acc, section=req.arg("section"))
    kind, person, year = req.arg("kind"), req.arg("person"), req.arg("year")
    if kind:
        items = [i for i in items if i["record"].get("kind") == kind]
    if person:
        items = [i for i in items if person in i["persons"]]
    if year:
        items = [i for i in items if _in_year(i["record"], int(year))]
    return {"records": items, "hidden": hidden}


def _in_year(rec: dict[str, Any], year: int) -> bool:
    w = rec.get("when") or {}
    if "tax_year" in w:
        return w["tax_year"] == year
    if "fiscal_year" in w:
        return w["fiscal_year"] in (year, year + 1)
    if "on" in w:
        return str(w["on"]).startswith(str(year))
    if "from_on" in w:
        start = int(str(w["from_on"])[:4])
        end = int(str(w.get("to_on") or "9999")[:4])
        return start <= year <= end
    return True


@router.route("GET", "/api/records/{rid}")
def get_record(req: Request) -> Any:
    hid = _hh(req)
    acc = _access(req)
    rid = req.params["rid"]
    items, _ = visible_records(hid, acc)
    for i in items:
        if i["record"]["id"] == rid:
            hist = APP.ledger(hid).history(rid)
            return {**i, "history": hist}
    # 置き換えられた判断（連鎖の先頭でない）や見えない記録
    ir = _ir(hid)
    for sec in (*RECORD_SECTIONS, *LEDGER_SECTIONS):
        for rec in ir.get(sec, []):
            if rec["id"] == rid:
                raise HttpError(403, "この記録の明細は本人の同意がないので見られない", code="forbidden")
    if any(p["id"] == rid for p in ir.get("persons", [])):
        return {"section": "persons", "record": {"id": rid}, "persons": [rid], "evidence": [], "history": []}
    raise HttpError(404, "記録がない（取り消し済みかもしれない）", code="not_found")


def _prepare_record(hid: str, acc: Access, section: str, rec: dict[str, Any], evidence_ids: list[str]) -> dict[str, Any]:
    if section not in RECORD_SECTIONS:
        raise HttpError(400, f"section は {RECORD_SECTIONS} のどれか", code="bad_section")
    if not isinstance(rec, dict) or not isinstance(rec.get("kind"), str):
        raise HttpError(400, "record に kind が要る", code="bad_record")
    rec = json.loads(json.dumps(rec))
    rec.setdefault("id", dbm.new_id(SECTION_PREFIX[section], 6))
    rec.pop("recorded_at", None)
    probs = guard_record(rec, set(acc.all_persons))
    if probs:
        raise HttpError(400, " / ".join(probs), code="bad_record")
    shas = []
    for eid in evidence_ids:
        row = _evidence_row(hid, eid)
        if not acc.sees_original(row["owner_person"], row["uploaded_by"]):
            raise HttpError(403, "見られない書類は結びつけられない", code="forbidden")
        shas.append(row["sha256"])
    if shas:
        src = dict(rec.get("source") or {})
        src["evidence_sha256"] = sorted(set(src.get("evidence_sha256", []) + shas))
        src.setdefault("source_kind", "document_copy")
        rec["source"] = src
    return rec


def _link_evidence(hid: str, user_id: str, evidence_ids: list[str], record_id: str) -> None:
    with APP.db.tx() as c:
        for eid in evidence_ids:
            c.execute(
                "INSERT INTO evidence_links(household_id, evidence_id, record_id, linked_by, linked_at) VALUES (?,?,?,?,?)",
                (hid, eid, record_id, user_id, dbm.now_iso()),
            )


def household_label(hh: Any, names: dict[str, str]) -> str | None:
    """世帯の ID を画面の言葉に（ID は画面に出さない）。"""
    if not isinstance(hh, str) or not hh.startswith("hh-"):
        return None
    rest = hh[3:]
    if rest.startswith("other-"):
        return "家族以外の人が世帯主の世帯"
    return f"{names[rest]}さんが世帯主の世帯" if rest in names else None


def guard_record(rec: dict[str, Any], persons: set[str]) -> list[str]:
    """記録の中の「作り話になりやすい値」を確かめる（人の入力・AI の提案の両方）。問題の文の一覧（空なら通った）。

    - 市区町村コード：総務省の一覧にあるものだけ（記憶で入れた番号を通さない）
    - 住民票の世帯：世帯主が本人ならその人の世帯。本人でなければ、世帯主（家族の誰か・家族以外）から決まる形だけ。
      世帯主が本人のときは、ここで世帯を決める（渡された値は使わない）
    """
    from . import municipal

    probs: list[str] = []
    attrs = rec.get("attributes")
    if not isinstance(attrs, dict):
        return probs
    for k, v in attrs.items():
        if k.endswith("municipality_code") and v is not None and municipal.name_of(v) is None:
            city = municipal.city_of_ward(v)
            probs.append(f"政令指定都市の区のコードは使わない。その市のコード（{city}・{municipal.name_of(city)}）を使う" if city
                         else "市区町村コードが総務省の一覧にない（名前から探して選ぶ）")
        if k.endswith("municipality_codes") and isinstance(v, list) and any(municipal.name_of(x) is None for x in v):
            probs.append("市区町村コードが総務省の一覧にない（名前から探して選ぶ）")
    if rec.get("kind") == "resident_record" and "householder" in attrs:
        who = (rec.get("roles") or {}).get("person")
        if attrs.get("householder") is True:
            if isinstance(who, str):
                attrs["household_id"] = f"hh-{who}"
        else:
            hh = attrs.get("household_id")
            ok = isinstance(hh, str) and (hh == f"hh-other-{who}" or (hh.startswith("hh-") and hh[3:] in persons and hh[3:] != who))
            if not ok:
                probs.append("世帯主が本人でないときは、世帯主が誰か（家族の誰か、または家族以外）が要る")
    return probs


def _one_line(text: Any, default: str) -> str:
    """理由の文を1行・200文字までにする（提案の理由には改行が入ることがある）。"""
    s = " ".join(str(text or "").split())[:200]
    return s or default


def _same_content(rec: dict[str, Any]) -> str:
    """記録の中身（ID・記録した時刻・出どころを除く）。同じ内容かどうかを比べる。"""
    return json.dumps({k: v for k, v in rec.items() if k not in ("id", "recorded_at", "source")}, ensure_ascii=False, sort_keys=True)


def find_duplicate(hid: str, section: str, rec: dict[str, Any]) -> str | None:
    """同じ内容の（取り消していない）記録があれば、その ID。二度押し・二重の取り込みで同じ記録が2件入るのを止める。"""
    want = _same_content(rec)
    for rid, head in APP.ledger(hid).heads("facts").items():
        if head["op"] != "delete" and head.get("section") == section and _same_content(head.get("record") or {}) == want:
            return rid
    return None


def write_record(req: Request, section: str, rec: dict[str, Any], evidence_ids: list[str], *, allow_duplicate: bool = False) -> dict[str, Any]:
    """人が確定した記録を事実台帳に書く（写しで中間表現の検査まで通してから）。"""
    _human(req)
    hid = _hh(req)
    acc = _access(req)
    rec = _prepare_record(hid, acc, section, rec, evidence_ids)
    if not allow_duplicate and find_duplicate(hid, section, rec):
        raise HttpError(409, "同じ内容の記録がすでにある", code="duplicate_record")
    p = req.principal
    assert p is not None and p.person_id
    try:
        APP.ledger(hid).write("facts", [{"op": "add", "section": section, "record": rec}], recorded_by_person=p.person_id)
    except EngineError as e:
        raise _engine_error(e) from e
    _link_evidence(hid, p.user_id, evidence_ids, rec["id"])
    _audit(req, f"record_added:{section}", rec["id"])
    return {"ok": True, "record_id": rec["id"], "job_id": _recalc(hid, p.user_id)}


@router.route("POST", "/api/records")
def add_record(req: Request) -> Any:
    b = req.json()
    return write_record(req, str(b.get("section", "")), b.get("record") or {}, list(b.get("evidence_ids") or []), allow_duplicate=bool(b.get("allow_duplicate")))


def _record_section(hid: str, rid: str) -> tuple[str, dict[str, Any]]:
    head = APP.ledger(hid).heads("facts").get(rid)
    if head is None or head["op"] == "delete":
        raise HttpError(404, "記録がない（取り消し済みかもしれない）", code="not_found")
    return head["section"], head.get("record") or {}


@router.route("POST", "/api/records/{rid}/correct")
def correct_record(req: Request) -> Any:
    b = req.json()
    return change_record(req, req.params["rid"], b.get("record") or {}, b.get("reason"), list(b.get("evidence_ids") or []))


def change_record(req: Request, rid: str, rec: dict[str, Any], reason_in: Any, evidence_ids: list[str]) -> dict[str, Any]:
    """記録を訂正する（追記）。人のセッションからだけ。"""
    _human(req)
    hid = _hh(req)
    acc = _access(req)
    section, old = _record_section(hid, rid)
    known = set(acc.all_persons)
    if not acc.sees_details_of(persons_in(old, known), _recorders(hid).get(rid)):
        raise HttpError(403, "見えない記録は直せない", code="forbidden")
    reason = _check_name(reason_in, "訂正の理由", 200)
    rec = dict(rec)
    rec["id"] = rid
    rec = _prepare_record(hid, acc, section, rec, evidence_ids)
    if old.get("source") and "source" not in rec:
        rec["source"] = old["source"]
    p = req.principal
    assert p is not None and p.person_id
    try:
        APP.ledger(hid).write("facts", [{"op": "correct", "section": section, "record_id": rid, "record": rec, "reason": reason}], recorded_by_person=p.person_id)
    except EngineError as e:
        raise _engine_error(e) from e
    _link_evidence(hid, p.user_id, evidence_ids, rid)
    _audit(req, "record_corrected", rid)
    return {"ok": True, "record_id": rid, "job_id": _recalc(hid, p.user_id)}


@router.route("POST", "/api/records/{rid}/delete")
def delete_record(req: Request) -> Any:
    return remove_record(req, req.params["rid"], req.json().get("reason"))


def remove_record(req: Request, rid: str, reason_in: Any) -> dict[str, Any]:
    """記録を取り消す（消さずに、取消しと理由を追記する）。人のセッションからだけ。"""
    _human(req)
    hid = _hh(req)
    acc = _access(req)
    section, old = _record_section(hid, rid)
    if section == "persons":
        raise HttpError(400, "人の記録は取り消せない（生年月日の訂正はできる）", code="bad_section")
    if not acc.sees_details_of(persons_in(old, set(acc.all_persons)), _recorders(hid).get(rid)):
        raise HttpError(403, "見えない記録は取り消せない", code="forbidden")
    reason = _check_name(reason_in, "取消しの理由", 200)
    p = req.principal
    assert p is not None and p.person_id
    try:
        APP.ledger(hid).write("facts", [{"op": "delete", "section": section, "record_id": rid, "reason": reason}], recorded_by_person=p.person_id)
    except EngineError as e:
        raise _engine_error(e) from e
    _audit(req, "record_deleted", rid)
    return {"ok": True, "job_id": _recalc(hid, p.user_id)}


@router.route("POST", "/api/persons/{pid}/birth")
def correct_birth(req: Request) -> Any:
    _human(req)
    hid = _hh(req)
    acc = _access(req)
    pid = req.params["pid"]
    if not (acc.is_mine(pid) or (req.principal and req.principal.role == "admin")):
        raise HttpError(403, "本人・管理する人・世帯の管理者だけが直せる", code="forbidden")
    b = req.json()
    birth = _check_date(b.get("birth_on"), "生年月日")
    reason = _check_name(b.get("reason"), "訂正の理由", 200)
    p = req.principal
    assert p is not None and p.person_id
    try:
        APP.ledger(hid).write("facts", [{"op": "correct", "section": "persons", "record_id": pid, "record": {"id": pid, "birth_on": birth}, "reason": reason}], recorded_by_person=p.person_id)
    except EngineError as e:
        raise _engine_error(e) from e
    _audit(req, "birth_corrected", pid)
    return {"ok": True, "job_id": _recalc(hid, p.user_id)}


# ---------------------------------------------------------------------------- 判断・選択（人が決めること）
def write_judgment(req: Request, section: str, rec: dict[str, Any], basis_note: str | None = None) -> dict[str, Any]:
    """判断・選択を判断台帳に追記する。だれが・いつ決めたかを記録に入れる（⑬）。見直しは record.replaces で足す（消さない）。"""
    _human(req)
    hid = _hh(req)
    acc = _access(req)
    if section not in LEDGER_SECTIONS:
        raise HttpError(400, "section は judgments か choices", code="bad_section")
    if not isinstance(rec, dict) or not isinstance(rec.get("kind"), str):
        raise HttpError(400, "record に kind が要る", code="bad_record")
    p = req.principal
    assert p is not None and p.person_id
    known = set(acc.all_persons)
    involved = persons_in({"subject": rec.get("subject")}, known)
    if involved and not any(acc.is_mine(x) for x in involved) and p.role != "admin":
        raise HttpError(403, "この判断を決められるのは、対象の本人・管理する人・世帯の管理者", code="forbidden")
    rec = json.loads(json.dumps(rec))
    rec.setdefault("id", dbm.new_id(SECTION_PREFIX[section], 6))
    for k in ("recorded_at", "judged_by", "judged_at", "chosen_by", "chosen_at"):
        rec.pop(k, None)
    if section == "judgments":
        rec["judged_by"] = {"person": p.person_id}
        rec["judged_at"] = dbm.now_iso()
    else:
        rec["chosen_by"] = p.person_id
        rec["chosen_at"] = dbm.now_iso()
    if basis_note:
        b = dict(rec.get("basis") or {})
        b.setdefault("method", basis_note[:2000])
        rec["basis"] = b
    try:
        APP.ledger(hid).write("judgments", [{"op": "add", "section": section, "record": rec}], recorded_by_person=p.person_id)
    except EngineError as e:
        raise _engine_error(e) from e
    _audit(req, f"{section}_added:{rec['kind']}", rec["id"])
    return {"ok": True, "record_id": rec["id"], "job_id": _recalc(hid, p.user_id)}


@router.route("POST", "/api/judgments")
def add_judgment(req: Request) -> Any:
    b = req.json()
    note = b.get("basis_note")
    return write_judgment(req, str(b.get("section", "judgments")), b.get("record") or {}, str(note) if note else None)


# ---------------------------------------------------------------------------- 確認待ち（提案・読み取り）
def _proposal(hid: str, pid: str) -> dict[str, Any]:
    row = APP.db.one("SELECT * FROM proposals WHERE household_id=? AND id=?", (hid, pid))
    if row is None:
        raise HttpError(404, "提案がない", code="not_found")
    d = dict(row)
    d["payload"] = json.loads(d["payload"])
    d["candidates"] = json.loads(d["candidates"]) if d["candidates"] else None
    return d


def create_proposal(hid: str, *, kind: str, payload: dict[str, Any], rationale: str | None, candidates: Any, evidence_id: str | None, origin: str, created_by: str) -> str:
    pid = dbm.new_id("pr", 6)
    with APP.db.tx() as c:
        c.execute(
            "INSERT INTO proposals(id, household_id, kind, payload, rationale, candidates, evidence_id, origin, created_by, created_at) VALUES (?,?,?,?,?,?,?,?,?,?)",
            (pid, hid, kind, json.dumps(payload, ensure_ascii=False), (rationale or "")[:4000], json.dumps(candidates, ensure_ascii=False) if candidates is not None else None, evidence_id, origin, created_by, dbm.now_iso()),
        )
    return pid


def proposal_visible(acc: Access, pr: dict[str, Any]) -> bool:
    payload = pr["payload"]
    if pr.get("kind") == "injection":
        return True  # 設定（市区町村・保険）の提案。公開の事実だけ（家族のデータは入らない）。入れられるのは管理者だけ
    if pr.get("kind") == "person":
        return True  # 家族の追加の提案（まだいない人の名前と生年月日だけ）。世帯の人は見て、確かめて登録できる
    ps = persons_in(payload.get("record") or {}, set(acc.all_persons))
    if pr.get("created_by") == f"user:{acc.principal.user_id}":
        return True
    return acc.sees_details_of(ps)


@router.route("GET", "/api/proposals")
def list_proposals(req: Request) -> Any:
    hid = _hh(req)
    acc = _access(req)
    st = req.arg("status", "pending")
    rows = APP.db.all("SELECT * FROM proposals WHERE household_id=? AND status=? ORDER BY created_at DESC LIMIT 300", (hid, st))
    out = []
    hidden = 0
    for r in rows:
        d = _proposal(hid, r["id"])
        if proposal_visible(acc, d):
            out.append(d)
        else:
            hidden += 1
    return {"proposals": out, "hidden": hidden}


@router.route("GET", "/api/proposals/{prid}")
def get_proposal(req: Request) -> Any:
    """提案1件（会話のカードが今の状態を出すため）。"""
    hid = _hh(req)
    acc = _access(req)
    pr = _proposal(hid, req.params["prid"])
    if not proposal_visible(acc, pr):
        raise HttpError(404, "提案がない", code="not_found")
    return pr


@router.route("POST", "/api/proposals/{prid}/accept")
def accept_proposal(req: Request) -> Any:
    """人が確かめて確定する。編集した記録（record）を渡せる。"""
    _human(req)
    hid = _hh(req)
    acc = _access(req)
    pr = _proposal(hid, req.params["prid"])
    if pr["status"] != "pending":
        raise HttpError(409, "この提案はもう決まっている", code="decided")
    if not proposal_visible(acc, pr):
        raise HttpError(403, "見えない提案は確定できない", code="forbidden")
    b = req.json()
    payload = pr["payload"]
    rec = b.get("record") or payload.get("record") or {}
    section = payload.get("section")
    if pr["kind"] == "record":
        ev = [pr["evidence_id"]] if pr.get("evidence_id") else []
        res = write_record(req, section, rec, ev, allow_duplicate=bool(b.get("allow_duplicate")))
    elif pr["kind"] == "delete":
        # 取消しの提案：人が確かめて押したときに、取消しと理由を追記する
        res = remove_record(req, payload.get("record_id"), _one_line(b.get("reason") or pr.get("rationale"), "提案を確かめて取り消した"))
    elif pr["kind"] == "correct":
        res = change_record(req, payload.get("record_id"), rec, _one_line(b.get("reason") or pr.get("rationale"), "提案を確かめて訂正した"), [])
    elif pr["kind"] in ("judgment", "choice", "forecast"):
        res = write_judgment(req, section, rec, b.get("basis_note") or pr.get("rationale"))
    elif pr["kind"] == "injection":
        # 設定（市区町村・保険）の提案。管理者が出典と見比べて押したときに入る（保存の前にもう一度確かめる）
        res = create_injection(req, payload.get("entry") or {})
    elif pr["kind"] == "person":
        # 家族の追加の提案。名前と生年月日は、人が確かめた（直した）ものを使う
        res = create_person(req, rec.get("display_name"), rec.get("birth_on"))
    else:
        raise HttpError(400, "知らない提案の種類", code="bad_kind")
    assert req.principal is not None
    with APP.db.tx() as c:
        c.execute(
            "UPDATE proposals SET status='accepted', decided_by=?, decided_at=?, decision_note=?, result_record_id=? WHERE id=?",
            (req.principal.user_id, dbm.now_iso(), b.get("note"), res.get("record_id"), pr["id"]),
        )
    _audit(req, "proposal_accepted", pr["id"])
    return res


@router.route("POST", "/api/proposals/{prid}/reject")
def reject_proposal(req: Request) -> Any:
    _human(req)
    hid = _hh(req)
    pr = _proposal(hid, req.params["prid"])
    if pr["status"] != "pending":
        raise HttpError(409, "この提案はもう決まっている", code="decided")
    assert req.principal is not None
    with APP.db.tx() as c:
        c.execute("UPDATE proposals SET status='rejected', decided_by=?, decided_at=?, decision_note=? WHERE id=?", (req.principal.user_id, dbm.now_iso(), req.json().get("note"), pr["id"]))
    _audit(req, "proposal_rejected", pr["id"])
    return {"ok": True}


@router.route("POST", "/api/proposals")
def save_draft(req: Request) -> Any:
    """人が途中まで書いた下書きを確認待ちに置く（あとで確かめて確定する）。"""
    _human(req)
    hid = _hh(req)
    b = req.json()
    kind = b.get("kind", "record")
    if kind not in ("record", "judgment", "choice", "forecast"):
        raise HttpError(400, "kind が違う", code="bad_kind")
    assert req.principal is not None
    pid = create_proposal(hid, kind=kind, payload={"section": b.get("section"), "record": b.get("record") or {}}, rationale=b.get("rationale"), candidates=None, evidence_id=b.get("evidence_id"), origin="user", created_by=f"user:{req.principal.user_id}")
    return {"ok": True, "id": pid}


# ---------------------------------------------------------------------------- 計算
def _check_query(q: Any) -> dict[str, Any]:
    if not isinstance(q, dict):
        raise HttpError(400, "問いはオブジェクト", code="bad_query")
    base = default_query()
    out = {k: q.get(k, base[k]) for k in base}
    for k in ("income_tax_years", "resident_tax_fiscal_years", "kokuho_fiscal_years", "kokunen_fiscal_years"):
        if not isinstance(out[k], list) or not all(isinstance(y, int) and not isinstance(y, bool) and 2000 <= y <= 2100 for y in out[k]):
            raise HttpError(400, f"{k} は年の整数の配列", code="bad_query")
    if not isinstance(out["dependent_judgment_dates"], list):
        raise HttpError(400, "dependent_judgment_dates は日付の配列", code="bad_query")
    for d in out["dependent_judgment_dates"]:
        _check_date(d, "判定日")
    fd = out.get("filing_date")
    if fd is not None:
        if not isinstance(fd, dict):
            raise HttpError(400, "filing_date は {on, planned}", code="bad_query")
        _check_date(fd.get("on"), "提出日")
        fd["planned"] = bool(fd.get("planned", True))
    out["scenarios"] = []
    forms = out.get("forms")
    if forms is not None:
        persons = forms.get("persons") if isinstance(forms, dict) else "x"
        if persons is not None and not (isinstance(persons, list) and all(isinstance(p, str) for p in persons)):
            raise HttpError(400, "forms は {persons: null か 人の ID の配列}", code="bad_query")
        out["forms"] = {"persons": persons}
    return out


@router.route("POST", "/api/calc")
def calc(req: Request) -> Any:
    hid = _hh(req)
    b = req.json()
    q = _check_query(b["query"]) if b.get("query") else None
    assert req.principal is not None
    return {"ok": True, "job_id": APP.enqueue(hid, req.principal.user_id, q)}


@router.route("GET", "/api/query/default")
def get_default_query(req: Request) -> Any:
    hid = _hh(req)
    return {"query": APP.db.get_setting(hid, "default_query") or default_query(), "builtin": default_query()}


@router.route("POST", "/api/query/default")
def set_default_query(req: Request) -> Any:
    _admin(req)
    hid = _hh(req)
    q = _check_query(req.json().get("query"))
    assert req.principal is not None
    APP.db.set_setting(hid, "default_query", q, req.principal.user_id)
    return {"ok": True, "query": q}


def _job(row: Any) -> dict[str, Any]:
    d = dict(row)
    d["query"] = json.loads(d["query"])
    d["error"] = json.loads(d["error"]) if d.get("error") else None
    return d


@router.route("GET", "/api/jobs")
def jobs(req: Request) -> Any:
    hid = _hh(req)
    rows = APP.db.all("SELECT * FROM jobs WHERE household_id=? ORDER BY created_at DESC LIMIT 20", (hid,))
    return {"jobs": [_job(r) for r in rows]}


@router.route("GET", "/api/jobs/{jid}", token_ok=True)
def job(req: Request) -> Any:
    hid = _hh(req)
    row = APP.db.one("SELECT * FROM jobs WHERE household_id=? AND id=?", (hid, req.params["jid"]))
    if row is None:
        raise HttpError(404, "ジョブがない", code="not_found")
    return _job(row)


# ---------------------------------------------------------------------------- 結果（見える範囲で絞る）
def filter_digest(d: dict[str, Any], acc: Access) -> dict[str, Any]:
    """数字の同意（share_numbers）のない人の値・質問・境目を除く。除いた人は hidden_persons に出す。"""
    vis = {p for p in d.get("persons", []) if acc.sees_numbers(p)}
    hidden = sorted(set(d.get("persons", [])) - vis)
    out = dict(d)
    out["persons"] = sorted(vis)
    out["hidden_persons"] = hidden
    out["key_values"] = [v for v in d.get("key_values", []) if v.get("person") in vis]
    qs = []
    for q in d.get("questions", []):
        if any(p not in vis for p in q.get("persons", [])):
            continue
        q = dict(q)
        q["affects"] = [a for a in q.get("affects", []) if a.get("person") in vis]
        qs.append(q)
    out["questions"] = qs
    oos = []
    for g in d.get("out_of_scope", []):
        g = dict(g)
        g["values"] = [v for v in g.get("values", []) if v.get("person") in vis]
        if g["values"]:
            oos.append(g)
    out["out_of_scope"] = oos
    out["boundaries"] = [b for b in d.get("boundaries", []) if b.get("person") in vis]
    out["age_boundaries"] = [b for b in d.get("age_boundaries", []) if b.get("person") in vis]
    out["forms"] = [f for f in d.get("forms", []) if f.get("person") in vis]
    out["filing"] = {**d.get("filing", {}), "withheld": [w for w in d.get("filing", {}).get("withheld", []) if w.get("person") in vis]}
    if hidden:
        # 件数は見えない人の値を含むので出さない（数字そのものでなくても、同意のない人の状態が分かりうる）
        out["counts"] = None
        out["filing"].pop("entries", None)
    return out


def _result_hash(req: Request, hid: str) -> str:
    h = req.params.get("rhash") or ""
    if h == "latest":
        lr = APP.latest_result(hid)
        if not lr:
            raise HttpError(404, "まだ計算していない", code="no_result")
        h = lr["result_hash"]
    if APP.db.one("SELECT 1 FROM results WHERE household_id=? AND input_hash=?", (hid, h)) is None:
        raise HttpError(404, "結果がない", code="not_found")
    return h


@router.route("GET", "/api/results/latest")
def latest(req: Request) -> Any:
    hid = _hh(req)
    acc = _access(req)
    lr = APP.latest_result(hid)
    running = APP.db.one("SELECT * FROM jobs WHERE household_id=? AND status IN ('queued','running') ORDER BY created_at DESC LIMIT 1", (hid,))
    failed = APP.db.one("SELECT * FROM jobs WHERE household_id=? ORDER BY created_at DESC LIMIT 1", (hid,))
    out: dict[str, Any] = {
        "running": _job(running) if running else None,
        "last_job": _job(failed) if failed else None,
        "result": None,
    }
    if lr:
        stale = APP.is_stale(hid, lr)
        out["result"] = {"hash": lr["result_hash"], "finished_at": lr["finished_at"], "stale": stale}
        have = (req.query.get("have") or [""])[0]
        cv = (req.query.get("cv") or [""])[0]
        if have == lr["result_hash"] and cv == _consent_version(hid, req.principal.user_id if req.principal else ""):
            out["result"]["unchanged"] = True  # 画面が持っているまとめをそのまま使う
        else:
            out["result"]["digest"] = filter_digest(APP.load_digest(hid, lr["result_hash"]), acc)
        out["result"]["cv"] = _consent_version(hid, req.principal.user_id if req.principal else "")
    return out


def _consent_version(hid: str, user_id: str) -> str:
    """見える範囲（同意・管理・アカウント）が変わったら、まとめを送り直す目印。"""
    c = APP.db.one("SELECT MAX(seq) AS s FROM consents WHERE household_id=?", (hid,))
    m = APP.db.one("SELECT COUNT(*) AS n FROM person_managers WHERE household_id=? AND user_id=?", (hid, user_id))
    a = APP.db.one("SELECT COUNT(*) AS n FROM memberships WHERE household_id=?", (hid,))
    return f"{c['s'] or 0}.{m['n']}.{a['n']}"


@router.route("GET", "/api/results/{rhash}/values")
def result_values(req: Request) -> Any:
    hid = _hh(req)
    acc = _access(req)
    h = _result_hash(req, hid)
    person = req.arg("person")
    if person and not acc.sees_numbers(person):
        raise HttpError(403, "この人の数字は本人の同意がないので見られない", code="forbidden")
    lr = APP.load_result(hid, h)
    vals = values_for(lr, person=person, tkey=req.arg("time"), institution=req.arg("institution"))
    return {"values": [v for v in vals if acc.sees_numbers(v.get("person") or "")]}


@router.route("GET", "/api/results/{rhash}/value")
def result_value(req: Request) -> Any:
    hid = _hh(req)
    acc = _access(req)
    h = _result_hash(req, hid)
    vid = req.arg("id") or ""
    lr = APP.load_result(hid, h)
    v = value_detail(lr, vid)
    if v is None:
        raise HttpError(404, "値がない", code="not_found")
    if not acc.sees_numbers(v.get("person") or ""):
        raise HttpError(403, "この人の数字は本人の同意がないので見られない", code="forbidden")
    v["depends"] = [x for x in v["depends"] if acc.sees_numbers(x.get("person") or "") or x.get("person") is None]
    # 使った記録 → 見える記録と原本
    items, _ = visible_records(hid, acc)
    visible_ids = {i["record"]["id"]: i for i in items}
    facts = []
    for fid in v.get("facts", []):
        it = visible_ids.get(fid)
        facts.append({"id": fid, "visible": it is not None, "kind": it["record"].get("kind") if it else None, "section": it["section"] if it else None, "evidence": it["evidence"] if it else []})
    v["facts_detail"] = facts
    return v


@router.route("GET", "/api/results/{rhash}/forms")
def result_forms(req: Request) -> Any:
    hid = _hh(req)
    acc = _access(req)
    h = _result_hash(req, hid)
    person = req.arg("person") or ""
    if not acc.sees_numbers(person):
        raise HttpError(403, "この人の数字は本人の同意がないので見られない", code="forbidden")
    try:
        year = int(req.arg("year") or "0")
    except ValueError as e:
        raise HttpError(400, "year は整数", code="bad_year") from e
    f = forms_detail(APP.load_result(hid, h), person, year)
    if f is None:
        raise HttpError(404, "この人・年分の様式の値がない", code="not_found")
    return f


@router.route("GET", "/api/results/{rhash}/question")
def result_question(req: Request) -> Any:
    """未確定の分かれ目1つと、候補ごとの判断の下書き（人が確かめて確定する）。"""
    hid = _hh(req)
    acc = _access(req)
    h = _result_hash(req, hid)
    qid = req.arg("id") or ""
    d = filter_digest(APP.load_digest(hid, h), acc)
    q = next((x for x in d["questions"] if x["id"] == qid), None)
    if q is None:
        raise HttpError(404, "その分かれ目がない（見えないか、もう決まっている）", code="not_found")
    meta_ = APP.meta()
    templates = {}
    if q["means"] == "判断":
        for cand in q.get("candidates") or [None]:
            t = answer_template(q, meta_, cand)
            if t:
                templates[str(cand)] = t
        if not templates:
            t = answer_template(q, meta_, None)
            if t:
                templates["_"] = t
    return {"question": q, "templates": templates}


# ---------------------------------------------------------------------------- 注入データ（市町村・保険者ごとの値）
_URL = re.compile(r"^https?://[!-~]+$")


@router.route("GET", "/api/injections")
def list_injections(req: Request) -> Any:
    hid = _hh(req)
    rows = APP.db.all("SELECT i.*, u.display_name AS by_name FROM injections i LEFT JOIN users u ON u.id=i.created_by WHERE household_id=? ORDER BY created_at DESC", (hid,))
    from . import municipal

    out = []
    for r in rows:
        entry = json.loads(r["entry"])
        iss = entry.get("issuer") or {}
        # 団体のコードは画面に出さず、名前で出す（一覧で分かるもの）
        out.append({**{k: r[k] for k in ("id", "created_at", "retired_at")}, "by": r["by_name"], "entry": entry, "issuer_label": municipal.issuer_label(iss.get("kind"), iss.get("code"))})
    return {"injections": out}


@router.route("POST", "/api/injections")
def add_injection(req: Request) -> Any:
    return create_injection(req, req.json())


def injection_entry(hid: str, b: dict[str, Any]) -> dict[str, Any]:
    """設定（市区町村・保険）の1件を作って確かめる（まだ保存しない）。出典の URL・団体（一覧にあるか）・判定コアの約束。
    人の入力でも、AI の提案でも、同じ確かめを通す。"""
    src = b.get("source") or {}
    if not isinstance(src.get("url"), str) or not _URL.match(src["url"]):
        raise HttpError(400, "出典の URL（http・https）が要る", code="source_required")
    _check_date(src.get("retrieved_on"), "取得日")
    from . import municipal

    iss = b.get("issuer") if isinstance(b.get("issuer"), dict) else {}
    if iss.get("kind") == "municipality" and municipal.name_of(iss.get("code")) is None:
        city = municipal.city_of_ward(iss.get("code"))
        raise HttpError(400, f"政令指定都市の区ではなく、その市（{municipal.name_of(city)}）で入れる" if city else "市区町村が総務省の一覧にない（候補から選ぶ）", code="bad_issuer")
    if iss.get("kind") == "prefecture" and municipal.prefecture_name(iss.get("code")) is None:
        raise HttpError(400, "都道府県が一覧にない（候補から選ぶ）", code="bad_issuer")
    entry = {
        "id": dbm.new_id("inj", 6),
        "point": b.get("point"),
        "issuer": b.get("issuer"),
        "applies": b.get("applies"),
        "source": {k: src.get(k) for k in ("url", "retrieved_on", "source_kind", "title", "sha256") if src.get(k) is not None},
        "data": b.get("data"),
    }
    current = APP.injected(hid) or []
    try:
        problems = APP.engine.check_injected([*current, entry])
    except EngineError as e:
        raise _engine_error(e) from e
    if problems:
        raise HttpError(422, "注入データの形が判定コアの約束に合わない", code="injection_invalid", detail=problems)
    return entry


def create_injection(req: Request, b: dict[str, Any]) -> dict[str, Any]:
    """設定（市区町村・保険）を足す。管理者のセッションからだけ（画面の入力と、AI の提案を管理者が確かめて押したとき）。"""
    _admin(req)
    hid = _hh(req)
    entry = injection_entry(hid, b)
    assert req.principal is not None
    with APP.db.tx() as c:
        c.execute("INSERT INTO injections(id, household_id, entry, created_by, created_at) VALUES (?,?,?,?,?)", (entry["id"], hid, json.dumps(entry, ensure_ascii=False), req.principal.user_id, dbm.now_iso()))
    _audit(req, "injection_added", entry["id"])
    return {"ok": True, "id": entry["id"], "job_id": _recalc(hid, req.principal.user_id)}


@router.route("POST", "/api/injections/{iid}/retire")
def retire_injection(req: Request) -> Any:
    _admin(req)
    hid = _hh(req)
    assert req.principal is not None
    with APP.db.tx() as c:
        n = c.execute("UPDATE injections SET retired_at=?, retired_by=? WHERE household_id=? AND id=? AND retired_at IS NULL", (dbm.now_iso(), req.principal.user_id, hid, req.params["iid"])).rowcount
    if not n:
        raise HttpError(404, "その注入データがない", code="not_found")
    _audit(req, "injection_retired", req.params["iid"])
    return {"ok": True, "job_id": _recalc(hid, req.principal.user_id)}


# ---------------------------------------------------------------------------- エージェントのトークン
@router.route("GET", "/api/tokens")
def list_tokens(req: Request) -> Any:
    _human(req)
    hid = _hh(req)
    assert req.principal is not None
    rows = APP.db.all("SELECT id, label, scopes, external, created_at, revoked_at, last_used_at FROM api_tokens WHERE household_id=? AND user_id=? ORDER BY created_at DESC", (hid, req.principal.user_id))
    # このパソコンの AI アプリから MCP でつなぐ設定の例に入れる場所（置き場所は人ごとに違うので、画面で差し込む）
    local = {"python": sys.executable.replace("\\", "/"), "script": str(APP.cfg.root / "mcp_server.py").replace("\\", "/")}
    return {"tokens": [dict(r) for r in rows], "local_mcp": local}


@router.route("POST", "/api/tokens")
def create_token(req: Request) -> Any:
    _human(req)
    hid = _hh(req)
    b = req.json()
    label = _check_name(b.get("label"), "名前", 60)
    scopes = list(b.get("scopes") or ["read"])
    external = bool(b.get("external", True))
    if external and not b.get("acknowledge_external"):
        raise HttpError(400, "外部のエージェントに渡す範囲を確かめて、同意の印（acknowledge_external）を付ける", code="ack_required")
    assert req.principal is not None
    try:
        tid, token = APP.auth.create_token(req.principal.user_id, hid, label, scopes, external)
    except ValueError as e:
        raise HttpError(400, str(e), code="bad_scopes") from e
    _audit(req, "token_created", tid)
    return {"ok": True, "id": tid, "token": token, "note": "このトークンは今だけ表示する。MCP の設定に貼る"}


@router.route("POST", "/api/tokens/{tid}/revoke")
def revoke_token(req: Request) -> Any:
    _human(req)
    hid = _hh(req)
    assert req.principal is not None
    with APP.db.tx() as c:
        c.execute("UPDATE api_tokens SET revoked_at=? WHERE id=? AND household_id=? AND user_id=?", (dbm.now_iso(), req.params["tid"], hid, req.principal.user_id))
    _audit(req, "token_revoked", req.params["tid"])
    return {"ok": True}


# ---------------------------------------------------------------------------- AI の設定
def is_local_url(url: str) -> bool:
    host = (urlsplit(url).hostname or "").lower()
    return host in ("127.0.0.1", "localhost", "::1") or host.endswith(".localhost")


@router.route("GET", "/api/settings/llm")
def get_llm(req: Request) -> Any:
    hid = _hh(req)
    cfg = APP.db.get_setting(hid, "llm") or {}
    out = {k: v for k, v in cfg.items() if k != "api_key"}
    out["has_api_key"] = bool(cfg.get("api_key"))
    out.setdefault("base_url", "http://127.0.0.1:11434/v1")
    out.setdefault("model", "")
    # この PC の中の中継（cliproxy など）でも、その先が外部のサービスなら外部として扱う（forwards_external）
    out["external"] = (not is_local_url(out["base_url"])) or bool(cfg.get("forwards_external"))
    out["forwards_external"] = bool(cfg.get("forwards_external"))
    return out


@router.route("POST", "/api/settings/llm")
def set_llm(req: Request) -> Any:
    _admin(req)
    hid = _hh(req)
    b = req.json()
    base_url = str(b.get("base_url", "")).rstrip("/")
    if not _URL.match(base_url):
        raise HttpError(400, "base_url は http(s) の URL", code="bad_url")
    forwards = bool(b.get("forwards_external"))
    external = (not is_local_url(base_url)) or forwards
    if external and not b.get("confirm_external"):
        raise HttpError(400, "外部の LLM API に家族のデータを送る設定になる。送る範囲を確かめて confirm_external を付ける（決めるのはあなた）", code="ack_required")
    cur = APP.db.get_setting(hid, "llm") or {}
    cfg = {
        "base_url": base_url,
        "model": _check_name(b.get("model") or "local-model", "モデル名", 100),
        "vision_model": (str(b.get("vision_model")).strip()[:100] or None) if b.get("vision_model") else None,
        "api_key": b.get("api_key") if b.get("api_key") is not None else cur.get("api_key"),
        "external": external,
        "forwards_external": forwards,
        "external_confirmed_at": dbm.now_iso() if external else None,
    }
    assert req.principal is not None
    APP.db.set_setting(hid, "llm", cfg, req.principal.user_id)
    _audit(req, f"llm_set:{'external' if external else 'local'}")
    return {"ok": True, "external": external}


# ---------------------------------------------------------------------------- 版・操作の記録
@router.route("GET", "/api/version")
def version(req: Request) -> Any:
    return {"okura_gov": APP.engine.okura_gov_version(), "app": "okura-web"}


@router.route("GET", "/api/audit")
def audit(req: Request) -> Any:
    _admin(req)
    hid = _hh(req)
    rows = APP.db.all("SELECT a.*, u.display_name FROM audit a LEFT JOIN users u ON 'user:' || u.id = a.actor WHERE a.household_id=? ORDER BY seq DESC LIMIT 300", (hid,))
    return {"audit": [dict(r) for r in rows]}


__all__ = ["router", "write_record", "write_judgment", "create_proposal", "visible_records", "filter_digest", "time_key"]
