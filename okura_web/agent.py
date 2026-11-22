"""アプリ内の AI エージェント（OpenAI の Chat Completions 互換の API）と、写真の読み取り。

- 既定は手元で動く OpenAI 互換のモデル（例：Ollama・LM Studio・llama.cpp の http://127.0.0.1:…/v1）。
- 外部の API（api.openai.com など）に送るかは世帯の管理者が決める（設定で confirm_external）。外部のときは：
  会話を始める前に送る範囲を画面に出して同意の印を求め、道具の結果は伏せ字にし、external_ai の同意のない人の記録は送らない。
- エージェントの道具は tools.py（読む・計算する・説明する・提案する）。確定はしない（⑬）。
- 読み取った値は確認待ち（提案）に入り、人が確かめて確定するまで台帳に書かない（⑫）。
"""

from __future__ import annotations

import base64
import json
import re
import urllib.error
import urllib.request
from typing import Any

from . import db as dbm
from .app import App
from .tools import ToolContext, ToolError, call, specs

SYSTEM_PROMPT = """あなたは家族の税・社会保険の記録を手伝うアシスタント（okura-web の中で動く）。
計算は okura-gov の判定コア（法令の関数）が行い、あなたは道具で結果を読んで説明する。

守ること：
1. 人が決めること（生計を一にするか、事業と称するに至る程度か、どちらの扶養に入れるか、還付申告をするか などの判断・選択）を、あなたが決めない。
   list_questions で分かれ目を調べ、候補と候補ごとの結果を示して、propose_judgment で提案するところまで。確定は人が画面で押す。
2. 記録の追加も propose_record・propose_forecast で提案するだけ。データベースに書く道具はない。
3. 結果を黙って丸めない。未確定は「何で分かれているか」と候補ごとの値を、対象外は理由の文を、そのまま伝える。範囲の外の年分は「まだ計算できない」。
4. 根拠（法令・出典・使った記録）と境目（あといくらで結論が変わるか）を explain_value・list_boundaries で示す。
5. 税務の助言（どちらが得かの推奨）はしない。法令が決める結果と、その分かれ目を説明する。最終の確認と申告の責任は本人にある。
6. 申告書の欄の値（form_fields）は、人が確定申告書等作成コーナーに写すためのもの。e-Tax への送信や自動入力はしない。
7. 見えない人の値（本人の同意がない）を推測しない。
8. 添付（写真・PDF・Excel・CSV・貼り付けた表）から記録を作るときは、全部の行・全部の書類を読んで、propose_records でまとめて提案する
   （1件なら propose_record でもよい）。画面に「この内容で登録します」のカードが出て、人が確かめて登録する。読めない値・あいまいな値は推測で埋めない。
   添付の evidence_id を付ける。通帳・カードの明細などの家計簿の入出金は propose_book_entries で家計簿の『登録待ち』に入れる。
9. 人に決めてもらうこと（判断・選択）や、読み取りで迷った点は ask_user で選択肢を出して、そこで返事を止める。答えが来たら propose_judgment などで提案する。
12. 家族（人）を足すときは propose_person（名前と生年月日。分からなければ聞く。推測しない）。人が登録するまでその人はいない。
    続柄・扶養・同居・住所などは、登録されたあとに household_overview で確かめてから propose_record で提案する。
13. すでにある記録の取消し・訂正を頼まれたら propose_change で提案する（「できない」と断らない）。カードが出て、人が押すと取消し・訂正される。
14. 画面の場所・リンクを聞かれたら show_screen でボタンを出す。URL やメニューの道順を文章で作らない。人が画面でする操作を案内するときも、ボタンを添える。
15. 記録に入れてよい値は、資料に書いてあるもの・人が言ったもの・道具が返したものだけ。記憶や推測で、番号・コード・ID・日付・金額を埋めない。
    市区町村コードは find_municipality で探したものだけを使う。分からない欄は空にして、人に聞く。
    どうしても自分で補った欄があるときは、その欄の道を assumed に入れる（画面で人が1つずつ確かめる）。rationale には、資料から読んだ・人から聞いた・自分で補った、を分けて書く。
16. 住民票の記録（resident_record）の世帯（attributes.household_id）：世帯主が本人（householder が true）なら書かない（仕組みが決める）。
    本人でないなら、世帯主が家族の誰かならその人の ID を使って「hh-<世帯主の person_id>」、家族以外なら「hh-other-<本人の person_id>」。世帯主が誰か分からなければ人に聞く。
17. アップロードした写真・PDF は「書類」と呼ぶ（「原本」と言わない）。
18. 市区町村・保険者ごとの値（住民税の税率・均等割・級地、国保の率など。list_questions の「注入」）は propose_setting で提案できる。
    ただし値は、人が添付した資料（しおりの PDF・公式ページの写真）に書いてあるものだけ。記憶や標準の値で埋めない。資料がなければ、どの資料が要るかを伝えて頼む。
    出典の URL が分からなければ人に聞く。値が書いてあった文を quote にそのまま入れる。
10. カードに出る内容を文章で繰り返さない。文章は「何をしたか」と「人が確かめること」を1〜3行で。
11. 文章と rationale に、人の ID（p-…）・記録の ID・英字の内部の名前（medical_treatment など）を書かない。人は表示名、値は日本語で書く。
答えは日本語で、短く。見出し・箇条書き・表は使ってよい（Markdown）。金額は「1,234円」の形。"""


class LLMError(Exception):
    pass


def llm_config(app: App, household_id: str) -> dict[str, Any]:
    cfg = app.db.get_setting(household_id, "llm") or {}
    cfg.setdefault("base_url", "http://127.0.0.1:11434/v1")
    cfg.setdefault("model", "")
    return cfg


def _post(cfg: dict[str, Any], path: str, body: dict[str, Any], timeout: int = 300) -> dict[str, Any]:
    url = cfg["base_url"].rstrip("/") + path
    headers = {"Content-Type": "application/json"}
    if cfg.get("api_key"):
        headers["Authorization"] = f"Bearer {cfg['api_key']}"
    req = urllib.request.Request(url, data=json.dumps(body, ensure_ascii=False).encode("utf-8"), headers=headers, method="POST")
    try:
        with urllib.request.urlopen(req, timeout=timeout) as r:  # noqa: S310 - 管理者が設定した URL
            return json.loads(r.read().decode("utf-8"))
    except urllib.error.HTTPError as e:
        raise LLMError(f"LLM の API がエラーを返した（HTTP {e.code}）") from e
    except (urllib.error.URLError, TimeoutError, OSError) as e:
        raise LLMError("LLM の API に届かない（設定の base_url と、手元のモデルが起動しているかを確かめる）") from e
    except ValueError as e:
        raise LLMError("LLM の API の応答を読めない") from e


def ping(cfg: dict[str, Any]) -> dict[str, Any]:
    url = cfg["base_url"].rstrip("/") + "/models"
    headers = {}
    if cfg.get("api_key"):
        headers["Authorization"] = f"Bearer {cfg['api_key']}"
    try:
        with urllib.request.urlopen(urllib.request.Request(url, headers=headers), timeout=15) as r:  # noqa: S310
            data = json.loads(r.read().decode("utf-8"))
        return {"ok": True, "models": [m.get("id") for m in data.get("data", [])][:50]}
    except Exception as e:  # noqa: BLE001
        return {"ok": False, "message": f"届かない（{type(e).__name__}）"}


def _openai_tools() -> list[dict[str, Any]]:
    return [
        {"type": "function", "function": {"name": s["name"], "description": f"[{s['category']}] {s['description']}", "parameters": s["input_schema"]}}
        for s in specs()
    ]


_MSG_KEYS = ("role", "content", "tool_calls", "tool_call_id")
# 道具の結果から、画面に出すカード（アプリが描く部品。AI は HTML を作らない）
_PROPOSE_ONE = ("propose_record", "propose_judgment", "propose_forecast", "propose_person", "propose_change", "propose_setting")


def _sanitize(m: dict[str, Any]) -> dict[str, Any]:
    """保存した会話を LLM に送る形に戻す（画面のための ui・添付の情報は送らない）。"""
    out = {k: m[k] for k in _MSG_KEYS if k in m}
    if m.get("attachments") and m.get("role") == "user":
        names = "、".join(a.get("name") or "添付" for a in m["attachments"])
        out["content"] = f"{m.get('content') or ''}\n（添付：{names}。前のやり取りで読んだ）".strip()
    return out


def _ui_from(name: str, result: Any) -> dict[str, Any] | None:
    if not isinstance(result, dict) or result.get("error"):
        return None
    if name in _PROPOSE_ONE and result.get("proposal_id"):
        return {"type": "proposals", "ids": [result["proposal_id"]]}
    if name == "propose_records" and result.get("proposal_ids"):
        return {"type": "proposals", "ids": result["proposal_ids"]}
    if name == "show_screen" and result.get("shown"):
        if result.get("links"):
            return {"type": "links", "links": result["links"]}
        return {"type": "link", "path": result["path"], "label": result["label"]}
    if name == "ask_user" and result.get("asked"):
        return {"type": "choices", "question": result["question"], "options": result["options"]}
    if name == "propose_book_entries" and result.get("batch_id"):
        return {"type": "book", "batch": result["batch_id"], "count": result.get("accepted", 0), "duplicates": result.get("duplicates", 0)}
    return None


def run_chat(app: App, ctx: ToolContext, history: list[dict[str, Any]], user_message: str, *, user_parts: list[dict[str, Any]] | None = None,
             attachments: list[dict[str, Any]] | None = None, max_steps: int = 10,
             on_step: Any = None) -> tuple[list[dict[str, Any]], list[dict[str, Any]]]:
    """会話を1回進める。戻り値：(新しく足したメッセージ, 道具の呼び出しの記録)。
    user_parts：今回の添付を含む中身（画像・PDF・表の文字）。保存するのは文字と添付の情報だけ（中身は原本の保管庫にある）。"""
    cfg = llm_config(app, ctx.hid)
    if not cfg.get("model"):
        raise LLMError("AI のモデルが設定されていない（設定 → AI）")
    content: Any = user_parts if user_parts else user_message
    messages = [{"role": "system", "content": SYSTEM_PROMPT}, *[_sanitize(m) for m in history], {"role": "user", "content": content}]
    first: dict[str, Any] = {"role": "user", "content": user_message}
    if attachments:
        first["attachments"] = attachments
    added: list[dict[str, Any]] = [first]
    trace: list[dict[str, Any]] = []
    ui: list[dict[str, Any]] = []
    for _ in range(max_steps):
        resp = _post(cfg, "/chat/completions", {"model": cfg["model"], "messages": messages, "tools": _openai_tools(), "tool_choice": "auto", "temperature": 0.2})
        try:
            msg = resp["choices"][0]["message"]
        except (KeyError, IndexError, TypeError) as e:
            raise LLMError("LLM の応答の形が違う") from e
        text = (msg.get("content") or "").lstrip("\ufffd")  # 中継で壊れた先頭の文字（U+FFFD）を落とす
        assistant: dict[str, Any] = {"role": "assistant", "content": text}
        tcs = msg.get("tool_calls") or []
        if tcs:
            assistant["tool_calls"] = tcs
        messages.append(assistant)
        added.append(assistant)
        if not tcs:
            break
        asked = False
        for tc in tcs:
            fn = (tc.get("function") or {})
            name = fn.get("name", "")
            if on_step:
                on_step(name)
            try:
                args = json.loads(fn.get("arguments") or "{}")
                result = call(ctx, name, args)
                ok = True
            except (ToolError, ValueError, TypeError) as e:
                result = {"error": str(e)}
                ok = False
            block = _ui_from(name, result) if ok else None
            if block:
                ui.append(block)
            asked = asked or (name == "ask_user" and ok)
            out = json.dumps(result, ensure_ascii=False, default=str)
            if len(out) > 24000:
                out = out[:24000] + "…（長いので省いた）"
            tmsg = {"role": "tool", "tool_call_id": tc.get("id", ""), "content": out}
            messages.append(tmsg)
            added.append(tmsg)
            trace.append({"tool": name, "ok": ok, "proposal_id": result.get("proposal_id") if isinstance(result, dict) else None})
        if asked:
            break  # 人の答えを待つ
    if ui:
        last = next(m for m in reversed(added) if m["role"] == "assistant")
        last["ui"] = ui
    return added, trace


# ---------------------------------------------------------------------------- 写真の読み取り
EXTRACT_PROMPT = """この画像は日本の書類（給与明細・源泉徴収票・医療費の領収書・事業の経費の領収書・寄附の受領証明書など）。
読めた値だけを、次の JSON だけで答える（説明の文は書かない。読めない値は null）：
{"doc_type": "salary_payslip" | "withholding_slip" | "medical_receipt" | "expense_receipt" | "donation_receipt" | "other",
 "date": "YYYY-MM-DD（支給日・支払日・受領日）",
 "tax_year": 2026,
 "counterparty": "支払者・病院・店・寄附先の名前",
 "gross": 総支給額の整数, "withholding_tax": 源泉所得税の整数, "social_insurance": 社会保険料の合計の整数,
 "commuting_allowance": 通勤手当の整数, "amount": 支払った金額の整数, "payment_amount": 源泉徴収票の支払金額の整数}"""

_NAME_OK = re.compile(r"^[^\u0000-\u001f\u007f]{1,100}$")


def _int(v: Any) -> int | None:
    if isinstance(v, bool):
        return None
    if isinstance(v, str):
        s = re.sub(r"[,，円¥\s]", "", v)
        if not re.fullmatch(r"[0-9]{1,13}", s, re.ASCII):  # isdigit は「²」「①」も真になるので使わない
            return None
        v = int(s)
    if isinstance(v, int):
        return v if 0 <= v <= 10**12 else None
    return None


def _date(v: Any) -> str | None:
    if isinstance(v, str) and re.fullmatch(r"\d{4}-\d{2}-\d{2}", v, re.ASCII):
        try:
            import datetime as _dt

            _dt.date.fromisoformat(v)
        except ValueError:
            return None
        return v
    return None


def _name(v: Any) -> str | None:
    if isinstance(v, str) and _NAME_OK.match(v.strip()):
        return v.strip()
    return None


def to_record(read: dict[str, Any], owner: str) -> tuple[str, dict[str, Any]] | None:
    """読み取った値を中間表現の記録の下書きにする（人が確かめて直す前提。足りない欄は空のまま）。"""
    t = read.get("doc_type")
    d = _date(read.get("date"))
    cp = _name(read.get("counterparty"))
    if t == "salary_payslip":
        amounts = {k: v for k, v in {"gross": _int(read.get("gross")), "withholding_tax": _int(read.get("withholding_tax")), "social_insurance_withheld": _int(read.get("social_insurance")), "commuting_allowance": _int(read.get("commuting_allowance"))}.items() if v is not None}
        attrs = {k: v for k, v in {"counterparty": cp, "due_on": d}.items() if v}
        return "facts", {"kind": "salary_payment", "roles": {"recipient": owner}, "when": {"on": d} if d else {}, "amounts": amounts, "attributes": attrs}
    if t == "withholding_slip":
        ty = read.get("tax_year")
        y = ty if isinstance(ty, int) and not isinstance(ty, bool) and 2000 <= ty <= 2100 else (int(d[:4]) if d else None)
        amounts = {k: v for k, v in {"payment_amount": _int(read.get("payment_amount") or read.get("gross")), "withholding_tax": _int(read.get("withholding_tax")), "social_insurance": _int(read.get("social_insurance"))}.items() if v is not None}
        attrs = {"slip_type": "salary", **({"counterparty": cp} if cp else {})}
        return "facts", {"kind": "withholding_slip", "roles": {"recipient": owner}, "when": {"tax_year": y} if y else {}, "amounts": amounts, "attributes": attrs}
    if t == "medical_receipt":
        amt = _int(read.get("amount"))
        attrs = {"medical_kinds": ["medical_treatment"], **({"incurred_on": d} if d else {}), **({"provider": cp} if cp else {})}
        return "facts", {"kind": "medical_payment", "roles": {"payer": owner, "patient": owner}, "when": {"on": d} if d else {}, "amounts": {"amount": amt} if amt is not None else {}, "attributes": attrs}
    if t == "expense_receipt":
        amt = _int(read.get("amount"))
        attrs = {"expense_category": "other", **({"counterparty": cp} if cp else {})}
        return "facts", {"kind": "business_expense", "roles": {"payer": owner}, "when": {"on": d} if d else {}, "amounts": {"amount": amt} if amt is not None else {}, "attributes": attrs}
    if t == "donation_receipt":
        amt = _int(read.get("amount"))
        attrs = {"recipient_name": cp} if cp else {}
        return "facts", {"kind": "donation", "roles": {"donor": owner}, "when": {"on": d} if d else {}, "amounts": {"amount": amt} if amt is not None else {}, "attributes": attrs}
    return None


def _first_json(text: str) -> dict[str, Any] | None:
    m = re.search(r"\{.*\}", text, re.S)
    if not m:
        return None
    try:
        v = json.loads(m.group(0))
        return v if isinstance(v, dict) else None
    except ValueError:
        return None


def extract(app: App, household_id: str, image: bytes, mime: str) -> dict[str, Any]:
    cfg = llm_config(app, household_id)
    model = cfg.get("vision_model") or cfg.get("model")
    if not model:
        raise LLMError("AI のモデルが設定されていない（設定 → AI）。読み取りは画像を読めるモデル（vision）が要る")
    if mime not in ("image/jpeg", "image/png", "image/webp", "image/gif"):
        raise LLMError("この形式（PDF・HEIC）は AI で読み取れない。画面で値を入れる")
    url = f"data:{mime};base64," + base64.b64encode(image).decode("ascii")
    resp = _post(cfg, "/chat/completions", {
        "model": model,
        "messages": [{"role": "user", "content": [{"type": "text", "text": EXTRACT_PROMPT}, {"type": "image_url", "image_url": {"url": url}}]}],
        "temperature": 0,
    })
    try:
        text = resp["choices"][0]["message"].get("content") or ""
    except (KeyError, IndexError, TypeError) as e:
        raise LLMError("LLM の応答の形が違う") from e
    if isinstance(text, list):
        text = "".join(x.get("text", "") for x in text if isinstance(x, dict))
    read = _first_json(text)
    if read is None:
        raise LLMError("読み取りの結果を JSON として読めなかった。画面で値を入れる")
    return read


__all__ = ["LLMError", "SYSTEM_PROMPT", "extract", "llm_config", "ping", "run_chat", "to_record", "dbm"]
