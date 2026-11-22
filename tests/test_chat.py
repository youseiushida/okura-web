"""AI の会話の部品：表のファイルの読み取り（sheets）・記録の形の直し・カードの作り方・保存した会話の送り方。架空のデータだけ。"""

from __future__ import annotations

import io
import unittest
import zipfile

from okura_web import agent, sheets
from okura_web.tools import normalize_record

_CT = '<?xml version="1.0"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"/>'
_WB = ('<?xml version="1.0"?><workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" '
       'xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets><sheet name="明細" sheetId="1" r:id="rId1"/></sheets></workbook>')
_RELS = ('<?xml version="1.0"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">'
         '<Relationship Id="rId1" Type="worksheet" Target="worksheets/sheet1.xml"/></Relationships>')
_SST = '<?xml version="1.0"?><sst xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><si><t>日付</t></si><si><t>架空スーパー</t></si></sst>'
_SHEET = ('<?xml version="1.0"?><worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetData>'
          '<row r="1"><c r="A1" t="s"><v>0</v></c><c r="B1" t="inlineStr"><is><t>金額</t></is></c></row>'
          '<row r="2"><c r="A2"><v>46327</v></c><c r="B2"><v>3200</v></c><c r="C2" t="s"><v>1</v></c></row>'
          '</sheetData></worksheet>')


def xlsx(sheet: str = _SHEET) -> bytes:
    buf = io.BytesIO()
    with zipfile.ZipFile(buf, "w") as z:
        z.writestr("[Content_Types].xml", _CT)
        z.writestr("xl/workbook.xml", _WB)
        z.writestr("xl/_rels/workbook.xml.rels", _RELS)
        z.writestr("xl/sharedStrings.xml", _SST)
        z.writestr("xl/worksheets/sheet1.xml", sheet)
    return buf.getvalue()


class SheetsTest(unittest.TestCase):
    def test_xlsx_values_and_sheet_name(self) -> None:
        text = sheets.read_table("架空の明細.xlsx", "xlsx", xlsx())
        self.assertIn("シート：明細", text)
        self.assertIn("日付\t金額", text)
        self.assertIn("46327\t3200\t架空スーパー", text)

    def test_xlsx_rejects_dtd_and_bad_zip(self) -> None:
        bad = _SHEET.replace('<?xml version="1.0"?>', '<?xml version="1.0"?><!DOCTYPE x [<!ENTITY a "aaaa">]>')
        with self.assertRaises(sheets.SheetError):
            sheets.read_table("x.xlsx", "xlsx", xlsx(bad))
        with self.assertRaises(sheets.SheetError):
            sheets.read_table("x.xlsx", "xlsx", b"PK\x03\x04 not really a zip")

    def test_csv_utf8_and_sjis_and_tsv(self) -> None:
        csv_text = "日付,摘要,出金\n2026/11/01,架空スーパー,3200\n"
        self.assertIn("架空スーパー\t3200", sheets.read_table("a.csv", "csv", csv_text.encode("utf-8")))
        self.assertIn("架空スーパー\t3200", sheets.read_table("a.csv", "csv", csv_text.encode("cp932")))
        self.assertIn("架空スーパー\t3200", sheets.read_table("a.tsv", "tsv", csv_text.replace(",", "\t").encode("utf-8")))
        with self.assertRaises(sheets.SheetError):
            sheets.read_table("a.csv", "csv", b"a\x00b")

    def test_rows_are_capped(self) -> None:
        many = "\n".join(f"{i},架空" for i in range(sheets.MAX_ROWS + 50)).encode()
        text = sheets.read_table("a.csv", "csv", many)
        self.assertIn("ここで切った", text)


class AgentPartsTest(unittest.TestCase):
    def test_normalize_moves_dates_into_when(self) -> None:
        rec = normalize_record({"kind": "medical_payment", "on": "2026-11-03", "id": "x", "recorded_at": "y", "when": {"on": "2026-11-04"}})
        self.assertEqual(rec["when"], {"on": "2026-11-04"})  # when にあればそちらを残す
        self.assertNotIn("id", rec)
        self.assertEqual(normalize_record({"kind": "k", "from_on": "2026-01-01", "to_on": "2026-12-31"})["when"], {"from_on": "2026-01-01", "to_on": "2026-12-31"})

    def test_ui_blocks_from_tool_results(self) -> None:
        self.assertEqual(agent._ui_from("propose_record", {"proposal_id": "pr-1"}), {"type": "proposals", "ids": ["pr-1"]})
        self.assertEqual(agent._ui_from("propose_records", {"proposal_ids": ["pr-1", "pr-2"]}), {"type": "proposals", "ids": ["pr-1", "pr-2"]})
        self.assertEqual(agent._ui_from("ask_user", {"asked": True, "question": "架空の質問", "options": ["はい", "いいえ"]})["type"], "choices")
        self.assertEqual(agent._ui_from("propose_book_entries", {"batch_id": "imp-1", "accepted": 3})["count"], 3)
        self.assertIsNone(agent._ui_from("propose_record", {"error": "x"}))
        self.assertIsNone(agent._ui_from("list_records", {"records": []}))

    def test_sanitize_drops_ui_and_mentions_attachments(self) -> None:
        m = agent._sanitize({"role": "assistant", "content": "ok", "ui": [{"type": "proposals"}]})
        self.assertEqual(m, {"role": "assistant", "content": "ok"})
        u = agent._sanitize({"role": "user", "content": "読んで", "attachments": [{"name": "架空.pdf"}]})
        self.assertIn("架空.pdf", u["content"])
        self.assertNotIn("attachments", u)


if __name__ == "__main__":
    unittest.main()


class ProposePersonTest(unittest.TestCase):
    """家族の追加は「提案」だけ（人が確かめて登録する）。"""

    def test_tool_is_a_proposal_and_makes_a_card(self) -> None:
        from okura_web import tools

        t = tools.TOOLS["propose_person"]
        self.assertEqual(t.category, "propose")
        self.assertEqual(agent._ui_from("propose_person", {"proposal_id": "pr-1", "status": "pending"}), {"type": "proposals", "ids": ["pr-1"]})
        self.assertIsNone(agent._ui_from("propose_person", {"error": "生年月日 は YYYY-MM-DD"}))


class ChangeAndScreenTest(unittest.TestCase):
    """取消し・訂正の提案、画面への入口、同じ内容の記録の見分け。"""

    def test_change_is_a_proposal_and_makes_a_card(self) -> None:
        from okura_web import tools

        self.assertEqual(tools.TOOLS["propose_change"].category, "propose")
        self.assertEqual(agent._ui_from("propose_change", {"proposal_id": "pr-2"}), {"type": "proposals", "ids": ["pr-2"]})

    def test_screen_link_comes_from_the_fixed_list(self) -> None:
        from okura_web import tools

        self.assertEqual(tools.TOOLS["show_screen"].category, "ui")
        for path, label in tools.SCREENS.values():
            self.assertTrue(path.startswith("/") and not path.startswith("//"))
            self.assertTrue(label)
        self.assertEqual(agent._ui_from("show_screen", {"shown": True, "path": "/records", "label": "記録の一覧"}), {"type": "link", "path": "/records", "label": "記録の一覧"})

    def test_same_content_ignores_id_time_and_source(self) -> None:
        from okura_web import api

        a = {"id": "f-1", "kind": "enrollment", "when": {"from_on": "2022-04-01"}, "roles": {"student": "p-a"}, "recorded_at": "2026-11-17T13:56:49", "source": {"x": 1}}
        b = {"id": "f-2", "roles": {"student": "p-a"}, "kind": "enrollment", "when": {"from_on": "2022-04-01"}, "recorded_at": "2026-11-17T13:56:52"}
        self.assertEqual(api._same_content(a), api._same_content(b))
        self.assertNotEqual(api._same_content(a), api._same_content({**b, "when": {"from_on": "2023-04-01"}}))

    def test_reason_is_one_line(self) -> None:
        from okura_web import api

        self.assertEqual(api._one_line("同じ内容が\n2件ある\tため", "x"), "同じ内容が 2件ある ため")
        self.assertEqual(api._one_line(None, "提案を確かめて取り消した"), "提案を確かめて取り消した")
        self.assertEqual(len(api._one_line("あ" * 500, "x")), 200)


class GuardRecordTest(unittest.TestCase):
    """作り話になりやすい値（コード・世帯）を、人の入力でも AI の提案でも確かめる。"""

    def test_municipality_code_must_be_in_the_official_list(self) -> None:
        from okura_web import api, municipal

        self.assertEqual(municipal.name_of("261009"), "京都府 京都市")
        self.assertIsNone(municipal.name_of("261033"))  # 政令指定都市の区は一覧にない（市のコードを使う）
        self.assertEqual(municipal.search("京都市")[0]["code"], "261009")
        ok = {"kind": "municipal_tax_domicile", "attributes": {"municipality_code": "261009"}}
        self.assertEqual(api.guard_record(ok, {"p-a"}), [])
        bad = {"kind": "municipal_tax_domicile", "attributes": {"municipality_code": "999999"}}
        self.assertTrue(api.guard_record(bad, {"p-a"}))

    def test_household_is_decided_by_the_householder(self) -> None:
        from okura_web import api

        mine = {"kind": "resident_record", "roles": {"person": "p-a"}, "attributes": {"municipality_code": "261009", "householder": True, "household_id": "hh-yumegaoka"}}
        self.assertEqual(api.guard_record(mine, {"p-a", "p-b"}), [])
        self.assertEqual(mine["attributes"]["household_id"], "hh-p-a")  # AI が作った名前は使わない
        child = {"kind": "resident_record", "roles": {"person": "p-b"}, "attributes": {"municipality_code": "261009", "householder": False, "household_id": "hh-p-a"}}
        self.assertEqual(api.guard_record(child, {"p-a", "p-b"}), [])
        other = {"kind": "resident_record", "roles": {"person": "p-b"}, "attributes": {"municipality_code": "261009", "householder": False, "household_id": "hh-other-p-b"}}
        self.assertEqual(api.guard_record(other, {"p-a", "p-b"}), [])
        for hh in (None, "hh-true", "hh-p-b", "hh-p-zzz", "世帯A"):
            with self.subTest(hh=hh):
                rec = {"kind": "resident_record", "roles": {"person": "p-b"}, "attributes": {"municipality_code": "261009", "householder": False, "household_id": hh}}
                self.assertTrue(api.guard_record(rec, {"p-a", "p-b"}))

    def test_household_label_hides_the_id(self) -> None:
        from okura_web import api

        self.assertEqual(api.household_label("hh-p-a", {"p-a": "架空太郎"}), "架空太郎さんが世帯主の世帯")
        self.assertEqual(api.household_label("hh-other-p-b", {"p-a": "架空太郎"}), "家族以外の人が世帯主の世帯")
        self.assertIsNone(api.household_label("hh-yumenomachi", {"p-a": "架空太郎"}))


class MunicipalListTest(unittest.TestCase):
    """市区町村コードの一覧：出どころの記録と、政令指定都市の区の扱い。"""

    def test_source_is_recorded(self) -> None:
        from okura_web import municipal

        src = municipal.source()
        self.assertEqual(src["publisher"], "総務省")
        self.assertRegex(src["updated_on"], r"^\d{4}-\d{2}-\d{2}$")
        self.assertRegex(src["sha256"], r"^[0-9a-f]{64}$")

    def test_ward_resolves_to_its_city(self) -> None:
        from okura_web import api, municipal

        self.assertEqual(municipal.city_of_ward("261033"), "261009")
        self.assertIsNone(municipal.city_of_ward("131016"))  # 東京の特別区は、そのコードを使う
        self.assertEqual(municipal.name_of("131016"), "東京都 千代田区")
        hit = municipal.search("京都 左京")[0]
        self.assertEqual((hit["code"], hit["ward"]), ("261009", "京都市左京区"))
        probs = api.guard_record({"kind": "municipal_tax_domicile", "attributes": {"municipality_code": "261033"}}, {"p-a"})
        self.assertIn("261009", probs[0])

    def test_names_have_no_reading_attached(self) -> None:
        # 直した不具合：Excel のふりがなが名前にくっついていた（「滝沢市シ」など）
        from okura_web import municipal

        self.assertEqual(municipal.name_of("032166"), "岩手県 滝沢市")
        self.assertEqual(municipal.name_of("402311"), "福岡県 那珂川市")


class IssuerLabelTest(unittest.TestCase):
    def test_prefecture_and_municipality_names(self) -> None:
        from okura_web import municipal

        self.assertEqual(municipal.issuer_label("municipality", "261009"), "京都府 京都市")
        self.assertEqual(municipal.issuer_label("prefecture", "260002"), "京都府")
        self.assertIsNone(municipal.issuer_label("prefecture", "261009"))
        self.assertIsNone(municipal.issuer_label("insurer", "06139999"))


class DocumentLinkTest(unittest.TestCase):
    def test_document_links_make_a_links_card(self) -> None:
        links = [{"path": "/evidence/ev-1", "label": "書類の原本を開く", "download": "/api/evidence/ev-1/file"}]
        self.assertEqual(agent._ui_from("show_screen", {"shown": True, "links": links}), {"type": "links", "links": links})


class ProposeSettingTest(unittest.TestCase):
    """設定（市区町村・保険者ごとの値）は、出典つきの提案だけ（管理者が確かめて押す）。"""

    def test_tools_and_card(self) -> None:
        from okura_web import tools

        self.assertEqual(tools.TOOLS["propose_setting"].category, "propose")
        self.assertEqual(tools.TOOLS["setting_points"].category, "read")
        self.assertEqual(agent._ui_from("propose_setting", {"proposal_id": "pr-9"}), {"type": "proposals", "ids": ["pr-9"]})


class AddDocumentToolTest(unittest.TestCase):
    """書類の追加は「提案」の権限が要る。保存するだけで、記録は作らない。"""

    def test_tool_category_and_bad_input(self) -> None:
        from okura_web import tools

        t = tools.TOOLS["add_document"]
        self.assertEqual(t.category, "propose")
        with self.assertRaises(tools.ToolError):
            t.fn(None, {"filename": "a.pdf", "path": "C:/x/a.pdf"})  # この接続では path は使えない
        with self.assertRaises(tools.ToolError):
            t.fn(None, {"filename": "a.pdf", "content_base64": "これは base64 でない"})
