"""市区町村コード（総務省「全国地方公共団体コード」）の一覧。

AI・エージェントが記憶でコードを入れないように、コードはこの一覧で確かめ、名前から探すのもこの一覧からだけにする。
一覧は tools/build_municipalities.py が okura_web/data/municipalities.json に作る：
  source（どのファイルから作ったか：更新日・ハッシュ・取得日）
  municipalities：[6桁のコード, 都道府県, 市区町村, 読み]（東京の特別区を含む。記録に使うのはここのコードだけ）
  wards：[区のコード, 都道府県, 市と区の名前, その市のコード]（政令指定都市の区。記録にはその市のコードを使う）
"""
from __future__ import annotations

import json
from functools import lru_cache
from pathlib import Path
from typing import Any

_PATH = Path(__file__).resolve().parent / "data" / "municipalities.json"


@lru_cache(maxsize=1)
def _data() -> dict[str, Any]:
    d = json.loads(_PATH.read_text(encoding="utf-8"))
    return {
        "source": d.get("source") or {},
        "by_code": {r[0]: (r[1], r[2]) for r in d["municipalities"]},
        "prefectures": {r[0]: r[1] for r in d.get("prefectures", [])},
        "wards": [tuple(w) for w in d.get("wards", [])],
    }


def source() -> dict[str, Any]:
    """一覧の出どころ（更新日・取得日・元のファイルのハッシュ）。"""
    return dict(_data()["source"])


def name_of(code: Any) -> str | None:
    """コード → 「京都府 京都市」。一覧になければ None（政令指定都市の区のコードも None：市のコードを使う）。"""
    hit = _data()["by_code"].get(code) if isinstance(code, str) else None
    return f"{hit[0]} {hit[1]}" if hit else None


def prefecture_name(code: Any) -> str | None:
    """都道府県の6桁のコード → 名前。一覧になければ None。"""
    return _data()["prefectures"].get(code) if isinstance(code, str) else None


def issuer_label(kind: Any, code: Any) -> str | None:
    """設定（市区町村・保険）の団体を画面の言葉に。一覧で分かるのは市区町村と都道府県だけ。"""
    if kind == "municipality":
        return name_of(code)
    if kind == "prefecture":
        return prefecture_name(code)
    return None


def city_of_ward(code: Any) -> str | None:
    """政令指定都市の区のコード → その市のコード。区でなければ None。"""
    for w in _data()["wards"]:
        if w[0] == code:
            return w[3]
    return None


def search(query: str, limit: int = 10) -> list[dict[str, str]]:
    """名前（都道府県・市区町村の一部）から探す。空白で区切った語をすべて含むもの。
    政令指定都市の区は、その市のコードで返す（ward に区の名前を入れる）。"""
    words = [w for w in str(query or "").replace("　", " ").split() if w]
    if not words:
        return []
    d = _data()
    out: list[dict[str, str]] = []
    for code, (pref, name) in d["by_code"].items():
        if all(w in pref + name for w in words):
            out.append({"code": code, "prefecture": pref, "name": name})
    seen = {r["code"] for r in out}
    for _wcode, pref, wname, city in d["wards"]:
        if all(w in pref + wname for w in words) and city not in seen:
            cpref, cname = d["by_code"][city]
            out.append({"code": city, "prefecture": cpref, "name": cname, "ward": wname, "note": "政令指定都市の区。記録にはこの市のコードを使う"})
    # 短い名前（市そのもの）を先に
    out.sort(key=lambda r: (len(r.get("ward") or r["name"]), r["code"]))
    return out[:limit]
