"""エージェントの道具（MCP・外部 API・アプリ内のエージェントで共通）。

⑬ 人が決めることを AI に決めさせない：
- 道具は「読む」「計算する」「説明する」と「提案する」に分ける。確定（台帳への書き込み）の道具はない。
- 提案は確認待ち（proposals）に入り、画面で人が「確定」を押したときだけ台帳に書く。
- 判断・選択の提案には、候補と候補ごとの結果（最新の計算の未確定の分かれ目から）を付ける。

⑪ 外部に渡すとき（外部のエージェントのトークン、外部の LLM）：
- external_ai の同意のない人の記録・値は渡さない。
- 名前・住所・自由記述・ASCII でない文字列は伏せ字、生年月日は年だけ。原本（写真）は渡さない。
"""

from __future__ import annotations

import datetime as _dt
import json
from dataclasses import dataclass
from typing import Any, Callable

from . import api
from .access import Access, persons_in, redact_record
from .app import App
from .auth import Principal
from .engine import EngineError
from .results import answer_template, format_value, value_detail, forms_detail


class ToolError(Exception):
    pass


@dataclass
class ToolContext:
    app: App
    principal: Principal
    access: Access
    external: bool
    origin: str  # 提案の出どころ（mcp:<token>・api:<token>・inapp-agent）

    @property
    def hid(self) -> str:
        assert self.principal.household_id
        return self.principal.household_id

    def person_ok(self, pid: str | None) -> bool:
        if pid is None:
            return True
        if not self.access.sees_numbers(pid):
            return False
        return (not self.external) or self.access.external_ok(pid)

    def details_ok(self, persons: set[str]) -> bool:
        if not self.access.sees_details_of(persons):
            return False
        return (not self.external) or all(self.access.external_ok(p) for p in persons)

    def name(self, pid: str | None) -> str | None:
        if pid is None:
            return None
        if self.external:
            return self.access.pseudonyms().get(pid, pid)
        row = self.app.db.one("SELECT display_name FROM persons WHERE household_id=? AND person_id=?", (self.hid, pid))
        return row["display_name"] if row else pid


@dataclass
class Tool:
    name: str
    category: str  # read・compute・explain・propose
    description: str
    schema: dict[str, Any]
    fn: Callable[[ToolContext, dict[str, Any]], Any]


TOOLS: dict[str, Tool] = {}


def tool(name: str, category: str, description: str, props: dict[str, Any] | None = None, required: list[str] | None = None):
    def deco(fn):
        TOOLS[name] = Tool(
            name,
            category,
            description,
            {"type": "object", "properties": props or {}, "required": required or [], "additionalProperties": False},
            fn,
        )
        return fn

    return deco


def _latest(ctx: ToolContext):
    lr = ctx.app.latest_result(ctx.hid)
    if not lr:
        raise ToolError("まだ計算していない。run_calculation で計算する")
    return lr


# ---------------------------------------------------------------------------- 読む
@tool("household_overview", "read", "世帯の人（ID と表示名。外部では仮名）、同意の状態、確認待ちの件数、最新の計算の状態、okura-gov のバージョンを返す。最初に呼ぶ。")
def household_overview(ctx: ToolContext, args: dict[str, Any]) -> Any:
    persons = []
    for pid in ctx.access.all_persons:
        ok = ctx.person_ok(pid)
        persons.append({"person_id": pid, "name": ctx.name(pid) if ok else "非公開の人", "visible": ok, "is_me": pid == ctx.access.me})
    pending = ctx.app.db.one("SELECT COUNT(*) AS n FROM proposals WHERE household_id=? AND status='pending'", (ctx.hid,))["n"]
    lr = ctx.app.latest_result(ctx.hid)
    running = ctx.app.db.one("SELECT id, stage FROM jobs WHERE household_id=? AND status IN ('queued','running') LIMIT 1", (ctx.hid,))
    return {
        "persons": persons,
        "pending_proposals": pending,
        "latest_result": {"finished_at": lr["finished_at"], "hash": lr["result_hash"]} if lr else None,
        "running_job": dict(running) if running else None,
        "okura_gov": ctx.app.engine.okura_gov_version(),
        "external": ctx.external,
        "rules": "確定（データベースへの書き込み）はできない。判断・選択は候補と候補ごとの結果を示して提案する。人が画面で確定する。",
    }


@tool(
    "list_records",
    "read",
    "データベースの今の記録（事実・判断・選択）を返す。見える範囲（本人の同意）で絞る。外部では伏せ字。",
    {
        "kind": {"type": "string", "description": "記録の種類（例 salary_payment・medical_payment・判断.生計を一にする）"},
        "person": {"type": "string", "description": "人の ID（p-…）"},
        "section": {"type": "string"},
        "limit": {"type": "integer", "minimum": 1, "maximum": 500},
    },
)
def list_records(ctx: ToolContext, args: dict[str, Any]) -> Any:
    items, hidden = api.visible_records(ctx.hid, ctx.access, section=args.get("section"))
    out = []
    for it in items:
        rec = it["record"]
        if args.get("kind") and rec.get("kind") != args["kind"]:
            continue
        if args.get("person") and args["person"] not in it["persons"]:
            continue
        if not ctx.details_ok(set(it["persons"])):
            hidden += 1
            continue
        r = redact_record(rec) if ctx.external else rec
        out.append({"section": it["section"], "record": r, "has_original": bool(it["evidence"])})
    limit = int(args.get("limit") or 100)
    return {"records": out[:limit], "total": len(out), "hidden_count": hidden}


@tool("get_record", "read", "記録1件と、その訂正・取消しの履歴を返す。", {"record_id": {"type": "string"}}, ["record_id"])
def get_record(ctx: ToolContext, args: dict[str, Any]) -> Any:
    items, _ = api.visible_records(ctx.hid, ctx.access)
    for it in items:
        if it["record"]["id"] == args["record_id"]:
            if not ctx.details_ok(set(it["persons"])):
                break
            hist = ctx.app.ledger(ctx.hid).history(args["record_id"])
            if ctx.external:
                return {"record": redact_record(it["record"]), "history": [{"op": h["op"], "recorded_at": h["recorded_at"], "reason": "［伏せ字］" if h.get("reason") else None} for h in hist]}
            return {"record": it["record"], "history": hist, "evidence_ids": it["evidence"]}
    raise ToolError("その記録は見えないか、ない")


@tool(
    "vocabulary",
    "read",
    "記録・判断・選択の種類の一覧（kind を省略）か、1つの種類の欄のスキーマ（kind を指定）。提案を作るときに使う。",
    {"kind": {"type": "string"}},
)
def vocabulary(ctx: ToolContext, args: dict[str, Any]) -> Any:
    meta = ctx.app.meta()
    k = args.get("kind")
    if not k:
        return {
            "records": [{"kind": r["kind"], "section": r["section"], "title": r["title"], "when": r["when"]} for r in meta["records"]],
            "judgments_and_choices": [{"kind": r["kind"], "section": r["section"], "title": r["title"], "when": r["when"], "mark": r["mark"]} for r in meta["ledger"]],
        }
    for r in meta["records"] + meta["ledger"]:
        if r["kind"] == k:
            return r
    raise ToolError("その種類はない")


@tool("list_proposals", "read", "確認待ちの提案（人の確定を待っているもの）を返す。", {"status": {"type": "string", "enum": ["pending", "accepted", "rejected"]}})
def list_proposals_tool(ctx: ToolContext, args: dict[str, Any]) -> Any:
    rows = ctx.app.db.all(
        "SELECT * FROM proposals WHERE household_id=? AND status=? ORDER BY created_at DESC LIMIT 100", (ctx.hid, args.get("status", "pending"))
    )
    out = []
    for r in rows:
        payload = json.loads(r["payload"])
        rec = payload.get("record") or {}
        ps = persons_in(rec, set(ctx.access.all_persons))
        if r["kind"] == "injection":
            out.append({"id": r["id"], "kind": "injection", "status": r["status"], "origin": r["origin"], "created_at": r["created_at"], "entry": payload.get("entry")})
            continue
        if r["kind"] != "person" and not ctx.details_ok(ps):
            continue
        if r["kind"] == "person":
            # 家族の追加の提案：外部の AI には名前を返さない
            rec = {"birth_on": rec.get("birth_on")} if ctx.external else rec
            out.append({"id": r["id"], "kind": "person", "status": r["status"], "origin": r["origin"], "created_at": r["created_at"], "record": rec})
            continue
        out.append({"id": r["id"], "kind": r["kind"], "status": r["status"], "origin": r["origin"], "created_at": r["created_at"], "record": redact_record(rec) if ctx.external else rec})
    return {"proposals": out}


# ---------------------------------------------------------------------------- 計算する
@tool(
    "run_calculation",
    "compute",
    "家族全体の計算をバックグラウンドで始める（数十秒）。ジョブの ID を返す。年分を省けば既定（所得税 2025・2026 年分、住民税など 2026・2027 年度）。範囲の外の年は『まだ計算できない』と返る。",
    {
        "income_tax_years": {"type": "array", "items": {"type": "integer"}},
        "fiscal_years": {"type": "array", "items": {"type": "integer"}},
        "judgment_dates": {"type": "array", "items": {"type": "string", "format": "date"}},
    },
)
def run_calculation(ctx: ToolContext, args: dict[str, Any]) -> Any:
    q = None
    if args:
        from .app import default_query

        q = default_query()
        if "income_tax_years" in args:
            q["income_tax_years"] = [int(x) for x in args["income_tax_years"]]
        if "fiscal_years" in args:
            fy = [int(x) for x in args["fiscal_years"]]
            q["resident_tax_fiscal_years"] = q["kokuho_fiscal_years"] = q["kokunen_fiscal_years"] = fy
        if "judgment_dates" in args:
            q["dependent_judgment_dates"] = [str(x) for x in args["judgment_dates"]]
    jid = ctx.app.enqueue(ctx.hid, ctx.principal.user_id, q)
    return {"job_id": jid, "note": "calculation_status で進み具合を見る"}


@tool("calculation_status", "compute", "計算のジョブの状態（順番待ち・計算中・完了・失敗）。", {"job_id": {"type": "string"}})
def calculation_status(ctx: ToolContext, args: dict[str, Any]) -> Any:
    if args.get("job_id"):
        row = ctx.app.db.one("SELECT id, status, stage, created_at, finished_at, error FROM jobs WHERE household_id=? AND id=?", (ctx.hid, args["job_id"]))
    else:
        row = ctx.app.db.one("SELECT id, status, stage, created_at, finished_at, error FROM jobs WHERE household_id=? ORDER BY created_at DESC LIMIT 1", (ctx.hid,))
    if row is None:
        raise ToolError("ジョブがない")
    d = dict(row)
    if d.get("error"):
        e = json.loads(d["error"])
        d["error"] = {"message": e.get("message"), "code": e.get("code")}
    return d


# ---------------------------------------------------------------------------- 説明する
def _digest(ctx: ToolContext) -> dict[str, Any]:
    lr = _latest(ctx)
    d = api.filter_digest(ctx.app.load_digest(ctx.hid, lr["result_hash"]), ctx.access)
    if ctx.external:
        vis = {p for p in d["persons"] if ctx.access.external_ok(p)}
        d = api.filter_digest(d, _OnlyPersons(ctx.access, vis))
    return d


class _OnlyPersons:
    """filter_digest に渡す、見える人を絞った窓口。"""

    def __init__(self, acc: Access, persons: set[str]):
        self._acc = acc
        self._persons = persons

    def sees_numbers(self, pid: str) -> bool:
        return pid in self._persons


@tool(
    "calculation_summary",
    "explain",
    "最新の計算の主な値（人 × 時点：所得・控除・税額・扶養・被扶養者の判定）。未確定・対象外はそのまま返す（丸めない）。",
    {"time": {"type": "string", "description": "時点のキー（Y2026・FY2027・D2026-12-31）。省略は全部"}},
)
def calculation_summary(ctx: ToolContext, args: dict[str, Any]) -> Any:
    d = _digest(ctx)
    t = args.get("time")
    rows = []
    from .results import time_key

    for v in d["key_values"]:
        if t and time_key(v["time"]) != t:
            continue
        rows.append(
            {
                "value_id": v["id"],
                "concept": v["concept"],
                "person": v["person"],
                "person_name": ctx.name(v["person"]),
                "time": v["time"],
                "display": v["display"],
                "states": v["states"],
                "undetermined": v.get("undetermined"),
                "out_of_scope": v.get("out_of_scope"),
            }
        )
    return {
        "versions": {"okura_gov": d["versions"].get("okura_gov"), "okura_core": d["versions"].get("okura_core")},
        "times": [{"key": x["key"], "label": x["label"]} for x in d["times"]],
        "values": rows,
        "hidden_persons": len(d.get("hidden_persons", [])),
        "questions": len(d["questions"]),
        "not_yet_computable": d.get("query_out_of_scope", []),
    }


@tool("explain_value", "explain", "値1つの根拠（法令・出典・使った記録の ID）、依存する値、未確定の候補ごとの値、境目を返す。", {"value_id": {"type": "string"}}, ["value_id"])
def explain_value(ctx: ToolContext, args: dict[str, Any]) -> Any:
    lr = _latest(ctx)
    v = value_detail(ctx.app.load_result(ctx.hid, lr["result_hash"]), args["value_id"])
    if v is None:
        raise ToolError("その値はない")
    if not ctx.person_ok(v.get("person")):
        raise ToolError("その人の値は見えない（本人の同意がない）")
    v["depends"] = [x for x in v["depends"] if x.get("person") is None or ctx.person_ok(x["person"])]
    keep = ("id", "concept", "person", "time", "display", "states", "basis_entries", "depends", "facts", "undetermined", "outcomes_display", "out_of_scope", "boundaries", "filing_item")
    return {k: v.get(k) for k in keep}


@tool(
    "list_questions",
    "explain",
    "未確定の分かれ目（何で結論が分かれているか）と候補ごとの値。means=判断 は人が決めること（提案の材料）、注入 は市町村・保険者の値、一次情報・公表待ちは入力では決まらない。",
    {"means": {"type": "string", "enum": ["判断", "事実", "注入", "一次情報", "公表待ち"]}, "limit": {"type": "integer", "minimum": 1, "maximum": 100}},
)
def list_questions(ctx: ToolContext, args: dict[str, Any]) -> Any:
    d = _digest(ctx)
    qs = [q for q in d["questions"] if not args.get("means") or q["means"] == args["means"]]
    limit = int(args.get("limit") or 20)
    out = []
    for q in qs[:limit]:
        out.append({**{k: q[k] for k in ("id", "means", "means_help", "candidates", "kind", "persons", "not_evaluated_reason", "affects_count")}, "target": q["target"], "affects": q["affects"][:10]})
    return {"questions": out, "total": len(qs)}


@tool("list_out_of_scope", "explain", "対象外の値と理由の文（理由ごと）。年分の外は『まだ計算できない』。")
def list_out_of_scope(ctx: ToolContext, args: dict[str, Any]) -> Any:
    d = _digest(ctx)
    return {"by_reason": d["out_of_scope"][:50], "query": d.get("query_out_of_scope", [])}


@tool("list_boundaries", "explain", "境目（あといくらで結論が変わるか）と年齢の境目。", {"person": {"type": "string"}})
def list_boundaries(ctx: ToolContext, args: dict[str, Any]) -> Any:
    d = _digest(ctx)
    bs = [b for b in d["boundaries"] if not args.get("person") or b["person"] == args["person"]]
    out = []
    for b in bs:
        out.append({**b, "explain": f"{b['compared']['concept'] if b.get('compared') else ''} が {b.get('crossing_value')} を{'超える' if b.get('kind') == '上限' else '下回る'}と結論が変わる。今との差 {b.get('difference')}"})
    return {"boundaries": out, "age_boundaries": [b for b in d["age_boundaries"] if not args.get("person") or b["person"] == args["person"]]}


@tool(
    "form_fields",
    "explain",
    "申告書の様式の欄の値（人が確定申告書等作成コーナーに写すためのもの）。e-Tax への送信や作成コーナーへの自動入力はしない。",
    {"person": {"type": "string"}, "tax_year": {"type": "integer"}},
    ["person", "tax_year"],
)
def form_fields(ctx: ToolContext, args: dict[str, Any]) -> Any:
    if not ctx.person_ok(args["person"]):
        raise ToolError("その人の値は見えない")
    lr = _latest(ctx)
    f = forms_detail(ctx.app.load_result(ctx.hid, lr["result_hash"]), args["person"], int(args["tax_year"]))
    if f is None:
        raise ToolError("その人・年分の様式の値がない")
    if not f.get("ok"):
        return {"ok": False, "reason": f.get("reason"), "category": f.get("category")}
    forms = []
    for form in f.get("forms", []):
        fields = [
            {k: x.get(k) for k in ("code", "name", "position", "status", "value", "unit", "reason", "marks")}
            for x in form.get("fields", [])
            if x.get("status") in ("出力", "未確定", "値なし")
        ]
        if ctx.external:
            for x in fields:
                if isinstance(x.get("value"), str) and any(ord(c) > 127 for c in x["value"]):
                    x["value"] = "［伏せ字］"
        forms.append({"form": form.get("form"), "name": form.get("name"), "use": form.get("use"), "fields": fields})
    return {"ok": True, "forms": forms, "note": "人が作成コーナーに写す。送信・自動入力はしない"}


# ---------------------------------------------------------------------------- 提案する（確定は人）
def _require_propose(ctx: ToolContext) -> None:
    if ctx.principal.kind == "token" and "propose" not in ctx.principal.scopes:
        raise ToolError("このトークンには提案（propose）の権限がない")


_WHEN_KEYS = ("on", "from_on", "to_on", "tax_year", "fiscal_year")


def normalize_record(rec: dict[str, Any]) -> dict[str, Any]:
    """AI がよく間違える形を直す：日付を when の外に書いた・id などを書いた。"""
    rec = dict(rec)
    for k in ("id", "recorded_at", "source"):
        rec.pop(k, None)
    moved = {k: rec.pop(k) for k in _WHEN_KEYS if k in rec}
    if moved:
        w = dict(rec.get("when") or {})
        for k, v in moved.items():
            w.setdefault(k, v)
        rec["when"] = w
    return rec


def check_records(ctx: ToolContext, items: list[tuple[str, dict[str, Any]]]) -> list[str]:
    """提案の前に、記録をデータベースの写しに入れて確かめる（本物は変えない）。問題の文の一覧を返す（空なら通った）。"""
    from .engine import EngineError as _EE
    from .server import HttpError as _HE

    guard: list[str] = []
    for _section, rec in items:
        guard += api.guard_record(rec, set(ctx.access.all_persons))  # 世帯主が本人のときの世帯は、ここで決まる
    if guard:
        return sorted(set(guard))
    try:
        drafts = []
        for section, rec in items:
            r = api._prepare_record(ctx.hid, ctx.access, section, json.loads(json.dumps(rec)), [])
            drafts.append({"op": "add", "section": section, "record": r})
        ctx.app.ledger(ctx.hid).write("facts", drafts, recorded_by_person=ctx.principal.person_id or "p-agent", dry_run=True)
    except _HE as e:
        return [str(e)]
    except _EE as e:
        probs = [f"{p.get('where', '')}: {p.get('message', '')}" for p in (e.problems or [])[:10]]
        return probs or [str(e)]
    return []


def card_extras(ctx: ToolContext, rec: dict[str, Any], assumed: Any) -> dict[str, Any]:
    """提案のカードに添えるもの：コード・ID の欄を画面の言葉にしたもの（display）と、AI が自分で補った欄（assumed）。"""
    from . import municipal

    display: dict[str, str] = {}
    attrs = rec.get("attributes") if isinstance(rec.get("attributes"), dict) else {}
    names = {r["person_id"]: r["display_name"] for r in ctx.app.db.all("SELECT person_id, display_name FROM persons WHERE household_id=?", (ctx.hid,))}
    for k, v in attrs.items():
        if k.endswith("municipality_code"):
            name = municipal.name_of(v)
            if name:
                display[f"attributes.{k}"] = name
        if k == "household_id":
            label = api.household_label(v, names)
            if label:
                display[f"attributes.{k}"] = label
    out: dict[str, Any] = {}
    if display:
        out["display"] = display
    paths = sorted({str(p)[:80] for p in assumed if isinstance(p, str)}) if isinstance(assumed, list) else []
    if paths:
        out["assumed"] = paths[:40]
    return out


@tool(
    "find_municipality",
    "read",
    "市区町村コード（総務省の全国地方公共団体コード）を、名前から一覧で探す。コードを記憶で書かない。必ずこれで探した code を使う。"
    "政令指定都市の区（京都市左京区など）は、その市のコードで返る（記録には市のコードを使う。東京の特別区はそのまま）。",
    {"name": {"type": "string", "description": "都道府県・市区町村の名前（例『京都市』『京都府 左京区』）"}},
    ["name"],
)
def find_municipality(ctx: ToolContext, args: dict[str, Any]) -> Any:
    from . import municipal

    hits = municipal.search(str(args.get("name") or ""))
    if not hits:
        return {"matches": [], "note": "一覧にない。名前を短くするか、人に確かめる（推測でコードを書かない）"}
    return {"matches": hits, "list_updated_on": municipal.source().get("updated_on")}


@tool(
    "propose_record",
    "propose",
    "事実の記録（給与・医療費・経費など）を提案する。確認待ちに入り、人が画面で確かめて確定するまでデータベースに書かない。record は vocabulary の欄に従う（id・recorded_at は書かない）。",
    {
        "section": {"type": "string", "enum": list(api.RECORD_SECTIONS)},
        "record": {"type": "object"},
        "rationale": {"type": "string", "description": "なぜこの記録か（読み取った書類・根拠）"},
        "evidence_id": {"type": "string"},
        "assumed": {"type": "array", "items": {"type": "string"}, "description": "資料にも人の言葉にも根拠がなく、自分で補った欄の道（例 attributes.relation_to_householder）。画面で人が1つずつ確かめる。補った欄がなければ空"},
    },
    ["section", "record", "rationale"],
)
def propose_record(ctx: ToolContext, args: dict[str, Any]) -> Any:
    _require_propose(ctx)
    rec = normalize_record(args["record"])
    if not args.get("_checked"):
        probs = check_records(ctx, [(args["section"], rec)])
        if probs:
            raise ToolError("この記録はデータベースの形に合わない。直して提案し直す：" + " / ".join(probs))
    ps = persons_in(rec, set(ctx.access.all_persons))
    if ctx.external and not all(ctx.access.external_ok(p) for p in ps):
        raise ToolError("外部の AI の同意のない人の記録は提案できない")
    if not args.get("_checked") and api.find_duplicate(ctx.hid, args["section"], rec):
        raise ToolError("同じ内容の記録がすでに登録されている。もう1件要るのかを人に確かめる（要らなければ提案しない）")
    payload = {"section": args["section"], "record": rec, **card_extras(ctx, rec, args.get("assumed"))}
    pid = api.create_proposal(ctx.hid, kind="record", payload=payload, rationale=args.get("rationale"), candidates=None, evidence_id=args.get("evidence_id"), origin=ctx.origin, created_by=ctx.origin)
    return {"proposal_id": pid, "status": "pending", "note": "人が画面の『確認待ち』で確定するまでデータベースには書かない"}


def add_document_bytes(ctx: ToolContext, data: bytes, filename: str, owner: Any, label: Any) -> dict[str, Any]:
    """エージェントからの書類の追加（道具と、/mcp/documents の両方が使う）。持ち主は、トークンの人が管理する人（本人を含む）だけ。"""
    _require_propose(ctx)
    from .server import HttpError as _HE

    owner = str(owner or ctx.principal.person_id or "")
    if not ctx.access.is_mine(owner):
        raise ToolError("書類の持ち主にできるのは、あなた本人か、あなたが管理している人だけ")
    if ctx.external and not ctx.access.external_ok(owner):
        raise ToolError("外部の AI の同意のない人の書類は追加できない")
    try:
        out = api.store_document(ctx.hid, ctx.access, ctx.principal.user_id, owner, data, str(filename or ""), label)
    except _HE as e:
        raise ToolError(str(e)) from e
    if not out["duplicate"]:
        ctx.app.db.audit(ctx.hid, ctx.principal.actor, "evidence_uploaded", out["id"])
    return {"evidence_id": out["id"], "duplicate": out["duplicate"],
            "note": "書類を保存した（まだ記録はない）。この evidence_id を propose_record・propose_records に付けると、人が登録したときに記録と書類が結びつく"}


@tool(
    "add_document",
    "propose",
    "書類（給与明細・源泉徴収票・領収書などの写真・PDF・表）を「書類」に保存する。保存するだけで記録は作らない。"
    "返ってきた evidence_id を propose_record・propose_records の evidence_id に付けると、人が確かめて登録したときに記録と書類が結びつく。"
    "中身は content_base64（base64）で渡す。大きいファイルは、道具を通さずに POST <このサーバー>/mcp/documents?owner=<人のID>&name=<ファイル名>&label=<名前> に"
    "同じトークン（Authorization: Bearer）でファイルをそのまま送る（例：curl --data-binary @file）。応答の id が evidence_id。"
    "path は、このパソコンで動く stdio の接続のときだけ使える（MCP のサーバーがファイルを読んで送る）。"
    "label には、何の書類か分かる名前を付ける（例「2026年10月分の給与明細」。ファイル名をそのまま入れない）。",
    {
        "filename": {"type": "string", "description": "ファイル名（種類の見分けに使う。画面には出さない）"},
        "content_base64": {"type": "string", "description": "ファイルの中身（base64）"},
        "path": {"type": "string", "description": "このパソコンのファイルの場所（stdio の接続だけ）"},
        "owner_person": {"type": "string", "description": "だれの書類か（人の ID。省略はトークンの本人）"},
        "label": {"type": "string", "description": "何の書類か分かる名前（100文字まで）"},
    },
    ["filename"],
)
def add_document(ctx: ToolContext, args: dict[str, Any]) -> Any:
    import base64
    import binascii

    if args.get("path") and not args.get("content_base64"):
        raise ToolError("path は stdio の接続のときだけ使える。この接続では content_base64 で渡すか、/mcp/documents にファイルをそのまま送る")
    try:
        data = base64.b64decode(str(args.get("content_base64") or ""), validate=True)
    except (binascii.Error, ValueError) as e:
        raise ToolError("content_base64 を読めない（base64 でない）") from e
    return add_document_bytes(ctx, data, str(args.get("filename") or ""), args.get("owner_person"), args.get("label"))


@tool(
    "attach_document",
    "propose",
    "まだ確認待ちの記録の提案に、書類（add_document などで保存したもの）を結びつける。提案を出したあとで書類を足したときに使う。"
    "人が登録したときに、記録と書類が結びつく。結びつけられるのは、この接続が出した提案だけ。",
    {"proposal_id": {"type": "string"}, "evidence_id": {"type": "string"}},
    ["proposal_id", "evidence_id"],
)
def attach_document(ctx: ToolContext, args: dict[str, Any]) -> Any:
    _require_propose(ctx)
    pr = ctx.app.db.one("SELECT id, kind, status, created_by FROM proposals WHERE household_id=? AND id=?", (ctx.hid, str(args.get("proposal_id") or "")))
    if pr is None or pr["created_by"] != ctx.origin:
        raise ToolError("その提案はないか、この接続が出したものではない")
    if pr["status"] != "pending" or pr["kind"] != "record":
        raise ToolError("書類を結びつけられるのは、まだ確認待ちの記録の提案だけ")
    ev = ctx.app.db.one("SELECT id, owner_person, uploaded_by FROM evidence WHERE household_id=? AND id=?", (ctx.hid, str(args.get("evidence_id") or "")))
    if ev is None or not ctx.access.sees_original(ev["owner_person"], ev["uploaded_by"]):
        raise ToolError("その書類は見えないか、ない")
    with ctx.app.db.tx() as c:
        c.execute("UPDATE proposals SET evidence_id=? WHERE id=?", (ev["id"], pr["id"]))
    return {"ok": True, "proposal_id": pr["id"], "evidence_id": ev["id"], "note": "人が登録したときに、記録と書類が結びつく"}


@tool(
    "setting_points",
    "read",
    "設定（市区町村・保険者ごとに決まる値：住民税の税率・均等割・級地、国保の率など）の項目の一覧（name を省略）か、1つの項目の欄（name を指定）。"
    "list_questions の「注入」の質問に出てくる項目を、propose_setting で提案するときに使う。",
    {"name": {"type": "string"}},
)
def setting_points(ctx: ToolContext, args: dict[str, Any]) -> Any:
    points = ctx.app.meta().get("injection_points") or []
    name = args.get("name")
    if not name:
        return {"points": [{"name": p["name"], "title": p.get("title"), "issuer_kinds": p.get("issuer_kinds")} for p in points]}
    for p in points:
        if p["name"] == name:
            return {k: p.get(k) for k in ("name", "title", "issuer_kinds", "fields", "candidates", "candidates_note", "note")} | {"source_kinds": ctx.app.meta().get("source_kinds")}
    raise ToolError("その項目はない（name を省略して一覧を見る）")


@tool(
    "propose_setting",
    "propose",
    "設定（市区町村・保険者ごとに決まる値）を提案する。確認待ちに入り、管理者が出典と見比べて押すまで計算に入らない。"
    "値は、人が添付した資料か、開いて読んだ公式のページに書いてあるものだけ。記憶や一般的な標準の値で埋めない。資料がなければ提案せず、資料（PDF・画面の写真・URL）を頼む。"
    "issuer.code は、市区町村なら find_municipality の code、都道府県ならその6桁のコード（末尾が 000 で始まる形のもの。分からなければ人に聞く）。"
    "source.url は資料の公式の URL（http・https）。quote は、その値が書いてあった文をそのまま（人が見比べる）。",
    {
        "point": {"type": "string", "description": "項目の名前（setting_points の name）"},
        "issuer": {"type": "object", "properties": {"kind": {"type": "string"}, "code": {"type": "string"}}, "required": ["kind", "code"]},
        "applies": {"type": "object", "properties": {"from_on": {"type": "string"}, "to_on": {"type": "string"}}, "required": ["from_on"]},
        "data": {"type": "object", "description": "項目の欄（setting_points の fields の name）→ 値"},
        "source": {"type": "object", "properties": {
            "url": {"type": "string"}, "title": {"type": "string"}, "source_kind": {"type": "string"}, "retrieved_on": {"type": "string", "description": "資料を見た日 YYYY-MM-DD"},
        }, "required": ["url", "source_kind", "retrieved_on"]},
        "quote": {"type": "string", "description": "値が書いてあった文（資料からそのまま。400文字まで）"},
        "evidence_id": {"type": "string", "description": "添付の資料の ID（あれば）"},
    },
    ["point", "issuer", "applies", "data", "source", "quote"],
)
def propose_setting(ctx: ToolContext, args: dict[str, Any]) -> Any:
    _require_propose(ctx)
    from . import municipal
    from .server import HttpError as _HE

    quote = " ".join(str(args.get("quote") or "").split())[:400]
    if len(quote) < 4:
        raise ToolError("quote（値が書いてあった文）が要る。資料を読んでいないなら提案しない")
    points = {p["name"]: p for p in (ctx.app.meta().get("injection_points") or [])}
    point = points.get(str(args.get("point") or ""))
    if point is None:
        raise ToolError("その項目はない（setting_points で一覧を見る）")
    body = {k: args.get(k) for k in ("point", "issuer", "applies", "data", "source")}
    try:
        entry = api.injection_entry(ctx.hid, body)
    except _HE as e:
        detail = "；".join(f"{p.get('where', '')} {p.get('message', '')}" for p in (getattr(e, "detail", None) or [])[:8]) if isinstance(getattr(e, "detail", None), list) else ""
        raise ToolError(f"この設定は入れられない：{e}{'（' + detail + '）' if detail else ''}") from e
    entry.pop("id", None)
    iss = entry.get("issuer") or {}
    titles = {f["name"]: f.get("title") or f["name"] for f in point.get("fields", [])}
    display = {
        "title": point.get("title") or "設定",
        "issuer": municipal.issuer_label(iss.get("kind"), iss.get("code")),
        "rows": [[titles.get(k, k), v] for k, v in (entry.get("data") or {}).items()],
    }
    payload = {"section": "injections", "entry": entry, "quote": quote, "display": display, "record": {}}
    pid = api.create_proposal(ctx.hid, kind="injection", payload=payload, rationale=None, candidates=None, evidence_id=args.get("evidence_id"), origin=ctx.origin, created_by=ctx.origin)
    return {"proposal_id": pid, "status": "pending", "note": "管理者が画面で出典と見比べて押すまで、計算には入らない"}


@tool(
    "propose_change",
    "propose",
    "すでにある事実の記録の、取消し（delete）か訂正（correct）を提案する。確認待ちに入り、人が画面で確かめて押すまで何も変わらない。"
    "記録は消さず、取消し・訂正と理由を追記する。record_id は list_records・get_record の id。訂正のときは record に直したあとの記録の全体を渡す（kind は変えない）。"
    "判断・選択の見直しは propose_judgment を使う（これは事実の記録だけ）。",
    {
        "record_id": {"type": "string"},
        "action": {"type": "string", "enum": ["delete", "correct"]},
        "record": {"type": "object", "description": "action が correct のとき：直したあとの記録の全体"},
        "reason": {"type": "string", "description": "なぜ取り消す・直すか（画面に出る。人の言葉で、ID や英字の内部名を書かない）"},
    },
    ["record_id", "action", "reason"],
)
def propose_change(ctx: ToolContext, args: dict[str, Any]) -> Any:
    _require_propose(ctx)
    rid, action = str(args.get("record_id") or ""), args.get("action")
    if action not in ("delete", "correct"):
        raise ToolError("action は delete か correct")
    items, _ = api.visible_records(ctx.hid, ctx.access)
    hit = next((it for it in items if it["record"]["id"] == rid), None)
    if hit is None or hit["section"] not in api.RECORD_SECTIONS or not ctx.details_ok(set(hit["persons"])):
        raise ToolError("その記録は見えないか、ないか、事実の記録ではない")
    if ctx.external and not all(ctx.access.external_ok(p) for p in hit["persons"]):
        raise ToolError("外部の AI の同意のない人の記録は提案できない")
    old = hit["record"]
    pending = ctx.app.db.all("SELECT payload FROM proposals WHERE household_id=? AND status='pending' AND kind IN ('delete','correct')", (ctx.hid,))
    if any(json.loads(r["payload"]).get("record_id") == rid for r in pending):
        raise ToolError("この記録には、まだ決まっていない取消し・訂正の提案がある")
    if action == "delete":
        payload = {"section": hit["section"], "record_id": rid, "record": old}
    else:
        if ctx.external:
            raise ToolError("外部の AI では訂正を提案できない（伏せ字の値を書き戻してしまうため）。人が画面で直す")
        rec = normalize_record(args.get("record") or {})
        guard = api.guard_record(rec, set(ctx.access.all_persons))
        if guard:
            raise ToolError("直したあとの記録を直す：" + " / ".join(guard))
        if rec.get("kind") != old.get("kind"):
            raise ToolError("訂正では kind を変えられない（取消しと追加に分ける）")
        from .engine import EngineError as _EE
        from .server import HttpError as _HE

        try:
            draft = api._prepare_record(ctx.hid, ctx.access, hit["section"], {**json.loads(json.dumps(rec)), "id": rid}, [])
            ctx.app.ledger(ctx.hid).write("facts", [{"op": "correct", "section": hit["section"], "record_id": rid, "record": draft, "reason": "確かめ"}],
                                          recorded_by_person=ctx.principal.person_id or "p-agent", dry_run=True)
        except _HE as e:
            raise ToolError("直したあとの記録がデータベースの形に合わない：" + str(e)) from e
        except _EE as e:
            raise ToolError("直したあとの記録がデータベースの形に合わない：" + " / ".join(f"{p.get('where', '')}: {p.get('message', '')}" for p in (e.problems or [])[:10])) from e
        ps = persons_in(rec, set(ctx.access.all_persons))
        if not ctx.details_ok(ps):
            raise ToolError("見えない人の記録には直せない")
        payload = {"section": hit["section"], "record_id": rid, "record": rec, "old": old, **card_extras(ctx, rec, args.get("assumed"))}
    pid = api.create_proposal(ctx.hid, kind=action, payload=payload, rationale=args.get("reason"), candidates=None, evidence_id=None, origin=ctx.origin, created_by=ctx.origin)
    return {"proposal_id": pid, "status": "pending", "note": "人が画面で確かめて押すまで、記録は変わらない"}


# 画面の場所（AI が道順や URL を作らないように、行き先はこの一覧からだけ選ぶ）
SCREENS: dict[str, tuple[str, str]] = {
    "home": ("/", "ホーム"),
    "book": ("/book", "家計簿"),
    "transactions": ("/txns", "入出金"),
    "transactions_pending": ("/txns/pending", "登録待ちの入出金"),
    "accounts": ("/accounts", "口座"),
    "documents": ("/upload", "書類"),
    "inbox": ("/inbox", "確認待ち"),
    "records": ("/records", "記録の一覧"),
    "family": ("/family", "家族"),
    "tax": ("/tax", "確定申告"),
    "questions": ("/questions", "決めること"),
    "settings_sharing": ("/settings/consents", "設定：共有設定"),
    "settings_members": ("/settings/members", "設定：メンバー"),
    "settings_requests": ("/settings/invites", "設定：依頼"),
    "settings_categories": ("/settings/categories", "設定：カテゴリ"),
    "settings_municipality_insurance": ("/settings/injections", "設定：市区町村・保険"),
    "settings_calculation": ("/settings/query", "設定：計算の対象"),
    "settings_ai": ("/settings/ai", "設定：AI"),
    "settings_agents": ("/settings/agents", "設定：AI連携"),
    "settings_login": ("/settings/login", "設定：ログイン"),
}
_TAX_STEPS = {"documents": ("docs", "書類と記録"), "decide": ("decide", "決めること"), "result": ("result", "結果"), "forms": ("forms", "申告書")}


@tool(
    "show_screen",
    "ui",
    "画面への入口（押せるボタン）を会話に出す。「どこから変えるのか」「リンクがほしい」と聞かれたとき、または人が画面でする操作（記録の取消し・訂正、設定の変更など）を案内するときに使う。"
    "行き先は target の一覧からだけ選べる。文章で URL・メニューの道順を作らない。"
    "target=record は record_id の記録の詳細（訂正・取消しのボタンがある）、target=person は person_id の人のページ、"
    "target=document は書類そのもの（アップロードした写真・PDF。写真は会話の中にそのまま表示され、押すと大きく見られる。ダウンロードのボタンも出る）：record_id を渡すとその記録に結びついた書類、evidence_id を渡すとその書類。"
    "「画像を見たい」「書類をダウンロードしたい」と言われたらこれを使う。"
    "target=tax_return は person_id と year の申告（step を付けるとその段）。",
    {
        "target": {"type": "string", "enum": [*SCREENS.keys(), "record", "person", "tax_return", "document"]},
        "record_id": {"type": "string"},
        "evidence_id": {"type": "string"},
        "person_id": {"type": "string"},
        "year": {"type": "integer", "description": "年分（西暦）"},
        "step": {"type": "string", "enum": list(_TAX_STEPS)},
    },
    ["target"],
)
def show_screen(ctx: ToolContext, args: dict[str, Any]) -> Any:
    from urllib.parse import quote

    t = args.get("target")
    if t in SCREENS:
        path, label = SCREENS[t]
    elif t == "record":
        rid = str(args.get("record_id") or "")
        items, _ = api.visible_records(ctx.hid, ctx.access)
        hit = next((it for it in items if it["record"]["id"] == rid), None)
        if hit is None:
            raise ToolError("その記録は見えないか、ない")
        title = next((k["title"] for k in ctx.app.meta()["records"] if k["kind"] == hit["record"].get("kind")), "記録")
        path, label = f"/records/{quote(rid, safe='')}", f"記録を開く：{title}"
    elif t == "document":
        # 書類そのもの：見てよい人にだけ（書類を見せる同意）。道はサーバーが作る
        eids: list[str] = []
        if args.get("evidence_id"):
            eids = [str(args["evidence_id"])]
        elif args.get("record_id"):
            items, _ = api.visible_records(ctx.hid, ctx.access)
            hit = next((it for it in items if it["record"]["id"] == str(args["record_id"])), None)
            if hit is None:
                raise ToolError("その記録は見えないか、ない")
            eids = list(hit["evidence"])
            if not eids:
                raise ToolError("この記録に結びついた書類はない")
        else:
            raise ToolError("record_id か evidence_id が要る")
        links = []
        for eid in eids[:5]:
            row = ctx.app.db.one("SELECT * FROM evidence WHERE household_id=? AND id=?", (ctx.hid, eid))
            if row is None or not ctx.access.sees_original(row["owner_person"], row["uploaded_by"]):
                continue
            q = quote(eid, safe="")
            links.append({"path": f"/evidence/{q}", "label": "書類を開く", "download": f"/api/evidence/{q}/file", "image": str(row["mime"] or "").startswith("image/")})
        if not links:
            raise ToolError("その書類は見えないか、ない（本人の同意がない）")
        return {"shown": True, "links": links, "note": "会話の中に書類が出た（写真はそのまま表示され、押すと大きく見られる。PDF は開くボタン）。ダウンロードのボタンもある。「会話の中には表示できない」と言わない。URL や道順を文章で繰り返さない"}
    elif t in ("person", "tax_return"):
        pid = str(args.get("person_id") or "")
        if pid not in set(ctx.access.all_persons):
            raise ToolError("その人はいない")
        if t == "person":
            path, label = f"/person/{quote(pid, safe='')}", "この人のページ"
        else:
            year = args.get("year")
            if not isinstance(year, int) or not 2000 <= year <= 2100:
                raise ToolError("year（年分・西暦）が要る")
            path, label = f"/tax/{year}/{quote(pid, safe='')}", f"確定申告（{year}年分）"
            if args.get("step") in _TAX_STEPS:
                seg, name = _TAX_STEPS[args["step"]]
                path, label = f"{path}/{seg}", f"{label}：{name}"
    else:
        raise ToolError("target は一覧のどれか")
    return {"shown": True, "path": path, "label": label, "note": "画面にボタンが出た。URL や道順を文章で繰り返さない"}


@tool(
    "propose_person",
    "propose",
    "家族（人）の追加を提案する。確認待ちに入り、人が画面で名前と生年月日を確かめて登録するまで、人は増えない。"
    "続柄・扶養・同居などの関係は、登録されたあとに household_overview でその人を確かめてから propose_record で提案する。",
    {
        "display_name": {"type": "string", "description": "画面に出す名前（人が言った・書類にある呼び名。40文字まで）"},
        "birth_on": {"type": "string", "description": "生年月日 YYYY-MM-DD。分からなければ提案せず、ask_user か文章で聞く（推測しない）"},
        "rationale": {"type": "string", "description": "なぜ足すか（人が頼んだ・どの書類にあったか）"},
    },
    ["display_name", "birth_on", "rationale"],
)
def propose_person(ctx: ToolContext, args: dict[str, Any]) -> Any:
    _require_propose(ctx)
    from .server import HttpError as _HE

    try:
        name = api._check_name(args.get("display_name"), "表示名")
        birth = api._check_date(args.get("birth_on"), "生年月日")
    except _HE as e:
        raise ToolError(str(e)) from e
    if birth > _dt.date.today().isoformat():
        raise ToolError("生年月日が未来の日付")
    same = ctx.app.db.one("SELECT 1 AS x FROM persons WHERE household_id=? AND display_name=?", (ctx.hid, name))
    pid = api.create_proposal(ctx.hid, kind="person", payload={"section": "persons", "record": {"display_name": name, "birth_on": birth}},
                              rationale=args.get("rationale"), candidates=None, evidence_id=None, origin=ctx.origin, created_by=ctx.origin)
    out = {"proposal_id": pid, "status": "pending", "note": "人が画面で確かめて登録するまで、人は増えない。関係（続柄など）の提案は、登録されたあとで"}
    if same:
        out["warning"] = "同じ名前の人がすでにいる。別の人かどうかを人に確かめる"
    return out


@tool(
    "propose_judgment",
    "propose",
    "判断・選択（生計を一にする、どちらの扶養に入れるか、還付申告をするか など）を提案する。question_id（list_questions の id）を渡すと、候補と候補ごとの結果が付く。決めるのは人。",
    {
        "question_id": {"type": "string"},
        "candidate": {"type": "string", "description": "提案する候補（question の candidates のどれか）"},
        "section": {"type": "string", "enum": ["judgments", "choices"]},
        "record": {"type": "object", "description": "question_id がないとき：kind・subject・when・value"},
        "rationale": {"type": "string"},
    },
    ["rationale"],
)
def propose_judgment(ctx: ToolContext, args: dict[str, Any]) -> Any:
    _require_propose(ctx)
    candidates = None
    if args.get("question_id"):
        d = _digest(ctx)
        q = next((x for x in d["questions"] if x["id"] == args["question_id"]), None)
        if q is None:
            raise ToolError("その分かれ目はない（見えないか、もう決まっている）")
        if q["means"] != "判断":
            raise ToolError("この分かれ目は人の判断で決まるものではない（注入・一次情報・公表待ち・事実）")
        meta = ctx.app.meta()
        cand = args.get("candidate")
        tmpl = answer_template(q, meta, cand)
        if tmpl is None:
            raise ToolError("この分かれ目の判断の下書きを作れない。record を渡す")
        section = tmpl["section"]
        rec = tmpl["record"]
        if args.get("record"):
            rec.update({k: v for k, v in args["record"].items() if k in ("subject", "when", "value", "basis")})
        candidates = {"question_id": q["id"], "candidates": q["candidates"], "per_candidate": [{"value_id": a["value_id"], "concept": a["concept"], "person": a["person"], "per_candidate": a["per_candidate"]} for a in q["affects"][:10]]}
    else:
        if not args.get("record") or not args.get("section"):
            raise ToolError("question_id か、section と record を渡す")
        section = args["section"]
        rec = dict(args["record"])
    for k in ("id", "judged_by", "judged_at", "chosen_by", "chosen_at", "recorded_at"):
        rec.pop(k, None)
    kind = "choice" if section == "choices" else "judgment"
    pid = api.create_proposal(ctx.hid, kind=kind, payload={"section": section, "record": rec}, rationale=args.get("rationale"), candidates=candidates, evidence_id=None, origin=ctx.origin, created_by=ctx.origin)
    return {"proposal_id": pid, "status": "pending", "note": "判断・選択は人が画面で決めて確定する。だれがいつ決めたかが記録される"}


@tool(
    "propose_forecast",
    "propose",
    "収入の見込み（見込み.年間収入。印『予測』）を提案する。被扶養者の判定の材料。予測の値からは申告用の値は出ない。",
    {
        "person": {"type": "string"},
        "on": {"type": "string", "format": "date", "description": "見込みを立てる日（判定日）"},
        "amounts": {"type": "array", "items": {"type": "object", "properties": {"income_type": {"type": "string"}, "amount": {"type": "integer"}}, "required": ["income_type", "amount"]}},
        "rationale": {"type": "string"},
    },
    ["person", "on", "amounts", "rationale"],
)
def propose_forecast(ctx: ToolContext, args: dict[str, Any]) -> Any:
    _require_propose(ctx)
    if not ctx.person_ok(args["person"]):
        raise ToolError("その人の値は見えない")
    rec = {
        "kind": "見込み.年間収入",
        "subject": {"person": args["person"]},
        "when": {"on": args["on"]},
        "value": {"amounts": [{"income_type": a["income_type"], "amount": int(a["amount"])} for a in args["amounts"]]},
        "mark": "予測",
    }
    pid = api.create_proposal(ctx.hid, kind="forecast", payload={"section": "judgments", "record": rec}, rationale=args.get("rationale"), candidates=None, evidence_id=None, origin=ctx.origin, created_by=ctx.origin)
    return {"proposal_id": pid, "status": "pending"}


# ---------------------------------------------------------------------------- 会話のカード（アプリ内の AI）
@tool(
    "propose_records",
    "propose",
    "記録をまとめて提案する（添付の表・PDF・写真から読んだ複数の記録）。1件ずつ確認待ちに入り、画面の『この内容で登録します』のカードで人が確かめて登録する。"
    "読めない値は推測で埋めない（欄を空にして rationale に書く）。evidence_id（添付の ID）を付けると書類と結びつく。",
    {
        "items": {"type": "array", "maxItems": 50, "items": {"type": "object", "properties": {
            "section": {"type": "string", "enum": list(api.RECORD_SECTIONS)},
            "record": {"type": "object"},
            "rationale": {"type": "string"},
            "evidence_id": {"type": "string"},
            "assumed": {"type": "array", "items": {"type": "string"}, "description": "資料にも人の言葉にも根拠がなく、自分で補った欄の道（例 attributes.relation_to_householder）。画面で人が1つずつ確かめる。補った欄がなければ空"},
        }, "required": ["section", "record"]}},
    },
    ["items"],
)
def propose_records(ctx: ToolContext, args: dict[str, Any]) -> Any:
    _require_propose(ctx)
    items = args.get("items")
    if not isinstance(items, list) or not 0 < len(items) <= 50:
        raise ToolError("items は 1〜50 件")
    ids, errors = [], []
    good: list[tuple[int, dict[str, Any]]] = []
    for i, it in enumerate(items):
        if not isinstance(it, dict) or it.get("section") not in api.RECORD_SECTIONS or not isinstance(it.get("record"), dict):
            errors.append({"index": i, "error": "section と record が要る"})
            continue
        good.append((i, {**it, "record": normalize_record(it["record"])}))
    # まとめて確かめる。だめなら1件ずつ確かめて、だめな行を AI に返す
    whole_ok = not check_records(ctx, [(it["section"], it["record"]) for _, it in good]) if good else True
    for i, it in good:
        probs = [] if whole_ok else check_records(ctx, [(it["section"], it["record"])])
        if probs:
            errors.append({"index": i, "error": "データベースの形に合わない：" + " / ".join(probs)})
            continue
        try:
            r = propose_record(ctx, {"section": it["section"], "record": it["record"], "rationale": it.get("rationale") or "添付から読んだ",
                                     "evidence_id": it.get("evidence_id"), "assumed": it.get("assumed"), "_checked": True})
            ids.append(r["proposal_id"])
        except ToolError as e:
            errors.append({"index": i, "error": str(e)})
    return {"proposal_ids": ids, "errors": errors, "note": "画面のカードで人が確かめて登録するまでデータベースには書かない"}


@tool(
    "ask_user",
    "ui",
    "人に選択肢で質問する（画面にボタンが出る）。人が決めること（判断・選択）や、読み取りで迷った点を聞くときに使う。"
    "呼んだらそこで返事を止めて、人の答え（次のメッセージ）を待つ。選択肢は短く（2〜6個）。",
    {
        "question": {"type": "string"},
        "options": {"type": "array", "minItems": 2, "maxItems": 6, "items": {"type": "string"}},
    },
    ["question", "options"],
)
def ask_user(ctx: ToolContext, args: dict[str, Any]) -> Any:
    q = str(args.get("question") or "").strip()[:300]
    opts = [str(o).strip()[:60] for o in (args.get("options") or []) if str(o).strip()][:6]
    if not q or len(opts) < 2:
        raise ToolError("question と 2〜6 個の options が要る")
    return {"asked": True, "question": q, "options": opts, "note": "ここで止めて、人の答えを待つ"}


@tool(
    "propose_book_entries",
    "propose",
    "家計簿の入出金（通帳・カードの明細・レシートの表から読んだもの）を、家計簿の『登録待ち』に入れる。人が画面で登録する。"
    "amount は口座から見た向き（入金は正、出金・カードの利用は負）の整数の円。category は家計簿のカテゴリの勘定（例 Expenses:Food:Groceries。分からなければ省く）。"
    "同じ明細を二度入れないよう、id は明細ごとに決まる文字（日付と行の番号など）にする。",
    {
        "account_label": {"type": "string", "description": "口座の名前（例：〇〇銀行・〇〇カード・財布）"},
        "account_kind": {"type": "string", "enum": ["bank", "card", "emoney", "cash", "securities", "other"]},
        "entries": {"type": "array", "maxItems": 500, "items": {"type": "object", "properties": {
            "id": {"type": "string"}, "date": {"type": "string"}, "amount": {"type": "integer"},
            "payee": {"type": "string"}, "memo": {"type": "string"}, "category": {"type": "string"},
        }, "required": ["id", "date", "amount"]}},
    },
    ["account_label", "account_kind", "entries"],
)
def propose_book_entries(ctx: ToolContext, args: dict[str, Any]) -> Any:
    _require_propose(ctx)
    import hashlib

    from . import api_book
    from .server import HttpError

    label = str(args.get("account_label") or "").strip()[:40]
    if not label:
        raise ToolError("account_label が要る")
    key = "chat-" + hashlib.sha256(label.encode("utf-8")).hexdigest()[:10]
    body = {"source": "chat", "account": {"key": key, "kind": args.get("account_kind") or "bank", "label": label}, "transactions": args.get("entries") or []}
    try:
        out = api_book.create_batch(ctx.hid, ctx.origin, ctx.principal.person_id, body)
    except HttpError as e:
        raise ToolError(str(e)) from e
    return {**out, "note": "家計簿の『登録待ち』に入れた。人が画面で登録する"}


# ---------------------------------------------------------------------------- 呼び出し
def specs(categories: tuple[str, ...] | None = None) -> list[dict[str, Any]]:
    return [
        {"name": t.name, "category": t.category, "description": t.description, "input_schema": t.schema}
        for t in TOOLS.values()
        if categories is None or t.category in categories
    ]


def call(ctx: ToolContext, name: str, args: dict[str, Any]) -> Any:
    t = TOOLS.get(name)
    if t is None:
        raise ToolError(f"知らない道具: {name}")
    if ctx.principal.kind == "token" and t.category != "propose" and "read" not in ctx.principal.scopes:
        raise ToolError("このトークンには読む（read）の権限がない")
    if not isinstance(args, dict):
        raise ToolError("引数はオブジェクト")
    try:
        return t.fn(ctx, args)
    except EngineError as e:
        raise ToolError(str(e)) from e
    except KeyError as e:
        raise ToolError(f"引数が足りない: {e}") from e


def context_for(app: App, principal: Principal, *, external: bool, origin: str) -> ToolContext:
    return ToolContext(app, principal, Access.load(app.db, principal), external, origin)


__all__ = ["TOOLS", "ToolContext", "ToolError", "call", "context_for", "specs", "format_value"]
