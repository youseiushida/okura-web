"""総務省の「全国地方公共団体コード」の Excel から、市区町村コードの一覧を作る。

    .work/venvs/web/Scripts/python.exe -I -X utf8 tools/build_municipalities.py <ダウンロードした .xlsx> <更新日 YYYY-MM-DD> [<取得した URL>]

入手元：https://www.soumu.go.jp/denshijiti/code.html（都道府県コード及び市区町村コード）。
更新日は、そのページのリンクの横に書いてある日（例「令和6年1月1日更新」→ 2024-01-01）。

作るもの（同じ中身）：
- frontend/src/lib/municipalities.js … 画面で市区町村を名前で選ぶ
- okura_web/data/municipalities.json … サーバーでコードを確かめる・名前から探す（okura_web/municipal.py）

読むシート：
- 1枚目「現在の団体」：都道府県と市区町村（東京の特別区を含む）。ここのコードだけを記録に使う
- 2枚目「政令指定都市」：政令指定都市とその区。区は「その市のコードを使う」ための別名として持つ
  （住民税を課すのは市。okura-gov は記録のコードそのままで市町村の注入データを引くので、区のコードでは引けない）

標準ライブラリだけで読む（zip と XML）。取り出すのは 6 桁のコード・都道府県名・市区町村名・読みだけで、形を検査してから書く。
どのファイルから作ったか（更新日・ハッシュ・取得日）を一覧に記録する。
"""

import datetime as dt
import hashlib
import json
import re
import sys
import zipfile
import xml.etree.ElementTree as ET
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
M = "http://schemas.openxmlformats.org/spreadsheetml/2006/main"
NS = {"m": M}
CODE_OK = re.compile(r"^\d{6}$")
DATE_OK = re.compile(r"^\d{4}-\d{2}-\d{2}$")
MAX_XML = 50 * 1024 * 1024
PAGE = "https://www.soumu.go.jp/denshijiti/code.html"


def read_xml(z: zipfile.ZipFile, name: str) -> ET.Element:
    info = z.getinfo(name)
    if info.file_size > MAX_XML:
        raise SystemExit(f"{name} が大きすぎる")
    data = z.read(name)
    if b"<!DOCTYPE" in data or b"<!ENTITY" in data:
        raise SystemExit("DTD・実体の定義を含む XML は読まない")
    return ET.fromstring(data)


def col_index(ref: str) -> int:
    m = re.match(r"[A-Z]+", ref)
    letters = m.group(0) if m else "A"
    n = 0
    for ch in letters:
        n = n * 26 + (ord(ch) - 64)
    return n - 1


def plain_text(el: ET.Element) -> str:
    """セルの文字。ふりがな（rPh）は読まない（名前のうしろに読みがくっつくのを防ぐ）。"""
    parts: list[str] = []

    def walk(e: ET.Element) -> None:
        for child in e:
            if child.tag == f"{{{M}}}rPh":
                continue
            if child.tag == f"{{{M}}}t":
                parts.append(child.text or "")
            else:
                walk(child)

    walk(el)
    return "".join(parts)


def rows(path: Path, sheet_no: int = 1):
    with zipfile.ZipFile(path) as z:
        shared = []
        if "xl/sharedStrings.xml" in z.namelist():
            for si in read_xml(z, "xl/sharedStrings.xml").findall("m:si", NS):
                shared.append(plain_text(si))
        name = f"xl/worksheets/sheet{sheet_no}.xml"
        if name not in z.namelist():
            return
        sheet = read_xml(z, name)
        for row in sheet.iter(f"{{{M}}}row"):
            out = {}
            for c in row.findall("m:c", NS):
                v = c.find("m:v", NS)
                if v is None or v.text is None:
                    is_ = c.find("m:is", NS)
                    text = plain_text(is_) if is_ is not None else ""
                elif c.get("t") == "s":
                    text = shared[int(v.text)]
                else:
                    text = v.text
                out[col_index(c.get("r") or "A1")] = text.strip()
            yield [out.get(i, "") for i in range(max(out) + 1)] if out else []


def clean(s: str, n: int) -> str:
    return "".join(ch for ch in s if ord(ch) >= 32)[:n]


def read_rows(src: Path, sheet_no: int, prefectures: list[list[str]] | None = None) -> list[list[str]]:
    items = []
    for r in rows(src, sheet_no):
        if len(r) < 2:
            continue
        code = r[0].split(".")[0]
        if not CODE_OK.match(code):
            continue
        pref, name = clean(r[1], 10), clean(r[2] if len(r) > 2 else "", 20)
        kana = clean(r[4] if len(r) > 4 else "", 40)
        if not name:  # 都道府県の行（市区町村名なし）
            if prefectures is not None and pref:
                prefectures.append([code, pref])
            continue
        items.append([code, pref, name, kana])
    return items


def main(src: str, updated_on: str, url: str = PAGE) -> None:
    if not DATE_OK.match(updated_on):
        raise SystemExit("更新日は YYYY-MM-DD（総務省のページに書いてある更新日）")
    path = Path(src)
    prefectures: list[list[str]] = []
    items = read_rows(path, 1, prefectures)
    if len(prefectures) != 47:
        raise SystemExit(f"都道府県が47でない（{len(prefectures)}）。表の形が変わったかもしれない")
    if len(items) < 1500:
        raise SystemExit(f"市区町村が少なすぎる（{len(items)}）。表の形が変わったかもしれない")
    by_code = {r[0]: r for r in items}
    # 政令指定都市の区 → その市（区の名前が「市の名前＋区の名前」になっている）
    wards = []
    city = None
    for r in read_rows(path, 2):
        if r[0] in by_code:
            city = r
            continue
        if city is None or r[1] != city[1] or not r[2].startswith(city[2]) or r[0] in by_code:
            raise SystemExit(f"政令指定都市のシートの形が違う（{r[0]}）")
        wards.append([r[0], r[1], r[2], city[0]])
    if not 150 <= len(wards) <= 250:
        raise SystemExit(f"政令指定都市の区の数がおかしい（{len(wards)}）。表の形が変わったかもしれない")
    source = {
        "name": "全国地方公共団体コード（都道府県コード及び市区町村コード）",
        "publisher": "総務省",
        "page": PAGE,
        "url": url,
        "updated_on": updated_on,
        "sha256": hashlib.sha256(path.read_bytes()).hexdigest(),
        "fetched_on": dt.date.today().isoformat(),
    }
    dump = lambda x: json.dumps(x, ensure_ascii=False, separators=(",", ":"))  # noqa: E731
    js = (
        "// 市区町村コード（総務省「全国地方公共団体コード」。tools/build_municipalities.py が作る。手で直さない）\n"
        f"// 元のファイル：{source['updated_on']} 更新・取得 {source['fetched_on']}・sha256 {source['sha256']}\n"
        "// [6桁のコード, 都道府県, 市区町村, 読み]\n"
        f"export const MUNICIPALITIES = {dump(items)};\n"
        "// 政令指定都市の区：[区のコード, 都道府県, 市と区の名前, その市のコード]。記録には市のコードを使う\n"
        f"export const WARDS = {dump(wards)};\n"
        "// 都道府県：[6桁のコード, 名前]\n"
        f"export const PREFECTURES = {dump(prefectures)};\n"
    )
    (ROOT / "frontend" / "src" / "lib" / "municipalities.js").write_text(js, encoding="utf-8", newline="\n")
    (ROOT / "okura_web" / "data").mkdir(exist_ok=True)
    (ROOT / "okura_web" / "data" / "municipalities.json").write_text(
        dump({"source": source, "prefectures": prefectures, "municipalities": items, "wards": wards}), encoding="utf-8", newline="\n")
    print(f"{len(prefectures)} prefectures, {len(items)} municipalities, {len(wards)} wards, {source['updated_on']}")


if __name__ == "__main__":
    main(*sys.argv[1:4])
