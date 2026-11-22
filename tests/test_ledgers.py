"""世帯の台帳（HouseholdLedger）の読む側と証憑の置き場所。write・get_ir（別のプロセスを起こす）は呼ばない。"""

from __future__ import annotations

import json
import os
import shutil
import stat
import tempfile
import unittest
from pathlib import Path
from typing import Any

from okura_web.ledgers import HouseholdLedger

from ._fixtures import HID


def _rm_readonly(func: Any, path: str, _exc: Any) -> None:
    os.chmod(path, stat.S_IWRITE)
    func(path)


def _entry(eid: str, op: str, *, record: dict[str, Any] | None = None, replaces: str | None = None, section: str = "facts") -> dict[str, Any]:
    e: dict[str, Any] = {"entry_id": eid, "op": op, "section": section, "recorded_at": "2026-01-01T00:00:00+09:00", "recorded_by": {"person": "p-a"}}
    if record is not None:
        e["record"] = record
    if replaces is not None:
        e["replaces"] = replaces
        e["reason"] = "架空の訂正の理由"
    return e


def _salary(rid: str, gross: int) -> dict[str, Any]:
    return {"id": rid, "kind": "salary_payment", "roles": {"recipient": "p-a"}, "when": {"on": "2026-01-25"}, "amounts": {"gross": gross}}


class LedgerTestBase(unittest.TestCase):
    def setUp(self) -> None:
        self.tmp = Path(tempfile.mkdtemp(prefix="okura-web-test-"))
        self.lg = HouseholdLedger(self.tmp, None, HID)  # type: ignore[arg-type]
        self.lg.ensure()

    def tearDown(self) -> None:
        shutil.rmtree(self.tmp, onerror=_rm_readonly)

    def write_lines(self, path: Path, entries: list[dict[str, Any]]) -> None:
        path.write_bytes("".join(json.dumps(e, ensure_ascii=False) + "\n" for e in entries).encode("utf-8"))


class ConstructTest(unittest.TestCase):
    def test_household_id_shape(self) -> None:
        for bad in ("hh-000", "../hh-0000000000000000", "hh-000000000000000G", "hh-0000000000000000/x"):
            with self.subTest(bad=bad):
                with self.assertRaises(ValueError):
                    HouseholdLedger(Path("."), None, bad)  # type: ignore[arg-type]


class HeadsHistoryTest(LedgerTestBase):
    def setUp(self) -> None:
        super().setUp()
        self.write_lines(
            self.lg.facts,
            [
                _entry("fe-00001", "add", record=_salary("f-1", 300_000)),
                _entry("fe-00002", "add", record=_salary("f-2", 100_000)),
                _entry("fe-00003", "correct", record=_salary("f-1", 310_000), replaces="fe-00001"),
                _entry("fe-00004", "delete", replaces="fe-00002"),
                _entry("fe-00005", "correct", record=_salary("f-1", 320_000), replaces="fe-00003"),
                _entry("fe-00006", "correct", record=_salary("f-x", 1), replaces="fe-99999"),  # 宙に浮いた行
                _entry("fe-00007", "add", record={"id": "p-c", "birth_on": "2010-05-05"}, section="persons"),
            ],
        )
        self.write_lines(
            self.lg.judgments,
            [
                _entry("je-00001", "add", record={"id": "j-1", "kind": "判断.生計を一にするか", "value": True}, section="judgments"),
                _entry("je-00002", "delete", replaces="je-00001", section="judgments"),
            ],
        )

    def test_heads_follow_correct_chain(self) -> None:
        heads = self.lg.heads("facts")
        self.assertEqual(set(heads), {"f-1", "f-2", "p-c"})
        self.assertEqual(heads["f-1"]["entry_id"], "fe-00005")
        self.assertEqual(heads["f-1"]["record"]["amounts"], {"gross": 320_000})
        # 宙に浮いた行（置き換え先がない）は先頭にならない
        self.assertNotIn("", heads)
        self.assertNotIn("f-x", heads)

    def test_deleted_record_head_is_delete_row(self) -> None:
        heads = self.lg.heads("facts")
        self.assertEqual(heads["f-2"]["op"], "delete")
        self.assertNotIn("record", heads["f-2"])
        self.assertEqual(self.lg.heads("judgments")["j-1"]["op"], "delete")

    def test_history(self) -> None:
        h = self.lg.history("f-1")
        self.assertEqual([(x["entry_id"], x["op"]) for x in h], [("fe-00001", "add"), ("fe-00003", "correct"), ("fe-00005", "correct")])
        self.assertEqual(h[1]["replaces"], "fe-00001")
        self.assertEqual([x["op"] for x in self.lg.history("j-1")], ["add", "delete"])
        self.assertEqual(self.lg.history("f-none"), [])

    def test_next_entry_ids(self) -> None:
        self.assertEqual(self.lg._next_entry_ids("facts", 2), ["fe-00008", "fe-00009"])
        self.assertEqual(self.lg._next_entry_ids("judgments", 1), ["je-00003"])

    def test_entries_missing_file(self) -> None:
        self.lg.facts.unlink()
        self.assertEqual(self.lg.entries("facts"), [])
        self.assertEqual(self.lg.heads("facts"), {})


class DigestTest(LedgerTestBase):
    def test_digest_tracks_ledgers_but_not_evidence(self) -> None:
        d0 = self.lg.digest()
        self.assertEqual(d0, self.lg.digest())
        (self.lg.evidence_dir / "x.beancount").write_bytes(b"; not part of the ledger\n")
        self.assertEqual(d0, self.lg.digest())
        self.write_lines(self.lg.facts, [_entry("fe-00001", "add", record=_salary("f-1", 1))])
        d1 = self.lg.digest()
        self.assertNotEqual(d0, d1)
        (self.lg.dir / "extra.beancount").write_bytes(b"; 2026\n")
        self.assertNotEqual(d1, self.lg.digest())


class EvidenceTest(LedgerTestBase):
    DATA = b"%PDF-1.7\n% fictitious receipt\n"

    def test_store_is_content_addressed_and_read_only(self) -> None:
        sha, path = self.lg.store_evidence(self.DATA, "pdf")
        self.assertEqual(len(sha), 64)
        self.assertEqual(path, self.lg.evidence_dir / f"{sha}.pdf")
        self.assertEqual(path.read_bytes(), self.DATA)
        self.assertFalse(os.access(path, os.W_OK))
        self.assertTrue(self.lg.verify_evidence(sha, "pdf"))
        sha2, path2 = self.lg.store_evidence(self.DATA, "pdf")  # 同じ中身はそのまま
        self.assertEqual((sha2, path2), (sha, path))
        self.assertEqual(list(self.lg.tmp_dir.iterdir()), [])

    def test_verify_detects_tampering(self) -> None:
        sha, path = self.lg.store_evidence(self.DATA, "pdf")
        os.chmod(path, stat.S_IREAD | stat.S_IWRITE)  # Linux では S_IWRITE だけだと読めなくなる（0200）
        path.write_bytes(b"tampered")
        self.assertFalse(self.lg.verify_evidence(sha, "pdf"))
        self.assertFalse(self.lg.verify_evidence("0" * 64, "pdf"))

    def test_evidence_path_rejects_bad_names(self) -> None:
        good = "a" * 64
        self.assertEqual(self.lg.evidence_path(good, "jpg"), self.lg.evidence_dir / f"{good}.jpg")
        for sha, ext in (("A" * 64, "jpg"), ("a" * 63, "jpg"), ("../" + "a" * 61, "jpg"), (good, "../x"), (good, "JPG"), (good, ""), (good, "abcdefghi")):
            with self.subTest(sha=sha, ext=ext):
                with self.assertRaises(ValueError):
                    self.lg.evidence_path(sha, ext)


if __name__ == "__main__":
    unittest.main()
