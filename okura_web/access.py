"""見える範囲と同意（⑭）、外部に渡すときの伏せ字（⑪）。

見える範囲の3つの段（本人の同意で共有する。既定は共有しない）：
  share_numbers    計算に使う数字（結果の値：所得・税額・判定）を世帯の人に見せる
  share_details    明細（記録の中身：給与・医療費などの1件ずつ）を世帯の人に見せる
  share_originals  原本（アップロードした写真・PDF）を世帯の人に見せる
外部の AI：
  external_ai      外部の LLM API・外部のエージェント（MCP）に、この人のデータを伏せ字をしたうえで渡してよい

計算そのもの（扶養の判定など）には世帯全員の記録を使う（扶養の判定には全員の所得が要る）。同意で変わるのは「誰に見えるか」。
同意を決めるのは本人。アカウントのない人（小さい子など）は、管理する人が代わりに決める。だれがいつ決めたかを追記のみで残す。
"""

from __future__ import annotations

import re
from dataclasses import dataclass, field
from typing import Any, Iterable

from . import db as dbm
from .auth import Principal

CONSENT_KINDS = {
    "share_numbers": "計算に使う数字（所得・税額・判定の結果）を世帯の人に見せる",
    "share_details": "明細（給与・医療費などの記録の中身）を世帯の人に見せる",
    "share_originals": "書類（アップロードした写真・PDF）を世帯の人に見せる",
    "external_ai": "外部の AI（外部の LLM API・外部のエージェント）に、伏せ字をしたうえで自分のデータを渡してよい",
}

MASK = "［伏せ字］"
HIDDEN_PERSON = "非公開の人"

# 名前・住所・自由記述になりうる欄（外部に渡すときに伏せる）。ASCII でない文字列も伏せる（下の _mask_value）
_SENSITIVE_KEYS = re.compile(
    r"(name|counterparty|provider|issuer|payer_name|recipient_name|insurer_name|lender|description|note|memo|"
    r"municipality|address|country|agent_name|liquidator|product|security_name|duties|reason|method|label|title|"
    r"assessment_label|course|certificate|lessee)",
    re.I,
)


def current_consents(database: dbm.Database, household_id: str) -> dict[tuple[str, str], dict[str, Any]]:
    rows = database.all(
        "SELECT person_id, kind, value, decided_by, decided_at, note FROM consents WHERE household_id=? ORDER BY seq",
        (household_id,),
    )
    out: dict[tuple[str, str], dict[str, Any]] = {}
    for r in rows:
        out[(r["person_id"], r["kind"])] = dict(r)
    return out


@dataclass
class Access:
    principal: Principal
    consents: dict[tuple[str, str], dict[str, Any]]
    account_persons: set[str]
    managed: set[str]
    all_persons: list[str] = field(default_factory=list)

    @classmethod
    def load(cls, database: dbm.Database, principal: Principal) -> "Access":
        hid = principal.household_id
        assert hid is not None
        accounts = {r["person_id"] for r in database.all("SELECT person_id FROM memberships WHERE household_id=?", (hid,))}
        managed = {
            r["person_id"]
            for r in database.all(
                "SELECT person_id FROM person_managers WHERE household_id=? AND user_id=?", (hid, principal.user_id)
            )
        }
        persons = [r["person_id"] for r in database.all("SELECT person_id FROM persons WHERE household_id=? ORDER BY created_at, person_id", (hid,))]
        return cls(principal, current_consents(database, hid), accounts, managed, persons)

    @property
    def me(self) -> str | None:
        return self.principal.person_id

    def consent(self, pid: str, kind: str) -> bool:
        c = self.consents.get((pid, kind))
        return bool(c and c["value"])

    def is_mine(self, pid: str) -> bool:
        """本人か、アカウントのない人で自分が管理している人。"""
        return pid == self.me or (pid in self.managed and pid not in self.account_persons)

    def can_decide_for(self, pid: str) -> bool:
        return self.is_mine(pid)

    # 見える範囲 ------------------------------------------------------------
    def sees_numbers(self, pid: str) -> bool:
        return self.is_mine(pid) or self.consent(pid, "share_numbers")

    def sees_details_of(self, persons: Iterable[str], recorded_by: str | None = None) -> bool:
        ps = [p for p in persons if p]
        if recorded_by and recorded_by == self.me:
            return True
        if any(self.is_mine(p) for p in ps):
            return True
        return bool(ps) and all(self.consent(p, "share_details") for p in ps)

    def sees_original(self, owner_person: str, uploaded_by_user: str) -> bool:
        if uploaded_by_user == self.principal.user_id or self.is_mine(owner_person):
            return True
        return self.consent(owner_person, "share_originals")

    # 外部 -----------------------------------------------------------------
    def external_ok(self, pid: str) -> bool:
        return self.consent(pid, "external_ai")

    def pseudonyms(self) -> dict[str, str]:
        return {pid: f"人物{i + 1}" for i, pid in enumerate(self.all_persons)}


def persons_in(obj: Any, known: set[str]) -> set[str]:
    """記録・判断・選択の中に出てくる人の ID（roles・subject・判断者など）。"""
    found: set[str] = set()

    def walk(v: Any) -> None:
        if isinstance(v, str):
            if v in known:
                found.add(v)
        elif isinstance(v, dict):
            for x in v.values():
                walk(x)
        elif isinstance(v, list):
            for x in v:
                walk(x)

    if isinstance(obj, dict):
        for key in ("roles", "subject", "judged_by", "chosen_by", "value"):
            if key in obj:
                walk(obj[key])
        if "birth_on" in obj and obj.get("id") in known:
            found.add(obj["id"])
    return found


def _mask_value(key: str, v: Any) -> Any:
    if isinstance(v, str):
        if _SENSITIVE_KEYS.search(key) or any(ord(ch) > 127 for ch in v):
            return MASK
        return v
    if isinstance(v, dict):
        return {k: _mask_value(k, x) for k, x in v.items()}
    if isinstance(v, list):
        return [_mask_value(key, x) for x in v]
    return v


def redact_record(rec: dict[str, Any]) -> dict[str, Any]:
    """外部に渡す記録の伏せ字：名前・住所・自由記述・ASCII でない文字列を伏せ、生年月日は年だけにする。"""
    out: dict[str, Any] = {}
    for k, v in rec.items():
        if k in ("id", "kind", "roles", "when", "amounts", "mark", "subject", "judged_at", "chosen_at", "chosen_by", "replaces", "recorded_at"):
            out[k] = _mask_value(k, v) if k == "subject" else v
        elif k == "birth_on" and isinstance(v, str):
            out[k] = v[:4]
        elif k == "death_on" and isinstance(v, str):
            out[k] = v[:4]
        elif k == "judged_by":
            out[k] = v if isinstance(v, dict) and "person" in v else MASK
        elif k == "source":
            out[k] = {"evidence": "あり"} if v else v
        elif k in ("attributes", "value", "basis"):
            out[k] = _mask_value(k, v)
        elif k == "note":
            out[k] = MASK
        else:
            out[k] = _mask_value(k, v)
    return out


def replace_ids(obj: Any, mapping: dict[str, str]) -> Any:
    """文字列に出てくる人の ID を置き換える（外部に渡すときの仮名、非公開の人）。"""
    if isinstance(obj, str):
        return mapping.get(obj, obj)
    if isinstance(obj, dict):
        return {k: replace_ids(v, mapping) for k, v in obj.items()}
    if isinstance(obj, list):
        return [replace_ids(v, mapping) for v in obj]
    return obj
