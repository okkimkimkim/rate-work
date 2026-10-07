"""요율표 엑셀 → 모바일 검색용 HTML 변환.

사용법: 이 폴더에 새 요율표 엑셀(.xlsx)을 넣고 `python build.py` 실행.
가장 최근에 수정된 엑셀 파일을 읽어 요율표.html 을 만든다.

D열(생동/생산)은 엑셀 값을 쓰지 않고, H열 보험코드로 Druginform 서버 DB를 읽기 전용으로
조회해 자체생산/위탁생산(위탁업체명) 값으로 바꿔 넣는다. 서버에 접속할 수 없으면 직전에
받아둔 druginform_mfg.json 을 쓴다.
"""
import json
import re
import subprocess
from pathlib import Path

import openpyxl

HERE = Path(__file__).parent
TEMPLATE = HERE / "template.html"
OUT = HERE / "요율표.html"
MFG_CACHE = HERE / "druginform_mfg.json"
SERVER = "root@1.234.80.8"

# 서버에서 실행할 읽기 전용 조회: 보험코드 → 위탁업체명(빈 문자열이면 자체생산).
# 아직 제조형태를 확인하지 못한 품목(mfg_checked_at NULL)은 넣지 않는다.
MFG_QUERY = r"""
import json, sqlite3
c = sqlite3.connect('file:/opt/drugapp/drugs.db?mode=ro', uri=True)
out = {}
for edi, cons, chk in c.execute("SELECT edi_code, consign_entp_name, mfg_checked_at FROM drugs "
                                "WHERE edi_code != '' AND (cancel_date IS NULL OR cancel_date = '')"):
    if not chk:
        continue
    for code in edi.split(','):
        if code.strip():
            out[code.strip()] = cons or ''
print(json.dumps(out, ensure_ascii=False))
"""


def clean(v):
    if v is None:
        return ""
    if isinstance(v, float) and v.is_integer():
        v = int(v)
    if isinstance(v, str):
        return re.sub(r"[ \t]+", " ", v).strip()
    return v


def is_blank(row):
    return all(c in (None, "") for c in row)


def read_main(ws):
    rows, header_found = [], False
    for r in ws.iter_rows(values_only=True):
        if not header_found:
            header_found = r and r[0] == "성분명"
            continue
        if is_blank(r):
            continue
        rows.append([clean(c) for c in r[:8]])  # I열(특이사항)은 제외
    return rows


def read_special(ws):
    """'9월 신제품 및 재출시' / '9월 요율변동' / '9월 약가변동' 같은 구역으로 나눈다."""
    sections, cur = [], None
    for r in ws.iter_rows(values_only=True):
        if is_blank(r):
            continue
        filled = [c for c in r if c not in (None, "")]
        if len(filled) == 1 and isinstance(filled[0], str):
            cur = {"title": clean(filled[0]), "header": None, "rows": []}
            sections.append(cur)
        elif cur is not None and cur["header"] is None:
            cur["header"] = [clean(c) for c in r if c not in (None, "")]
        elif cur is not None:
            cur["rows"].append([clean(c) for c in r[: len(cur["header"])]])
    # 특이사항 열은 웹페이지에 싣지 않는다
    for s in sections:
        if s["header"] and "특이사항" in s["header"]:
            i = s["header"].index("특이사항")
            s["header"].pop(i)
            for row in s["rows"]:
                del row[i:i + 1]
    return sections


def load_mfg():
    try:
        res = subprocess.run(["ssh", SERVER, "python3", "-"], input=MFG_QUERY, capture_output=True,
                             text=True, encoding="utf-8", timeout=120, check=True)
        mfg = json.loads(res.stdout)
        MFG_CACHE.write_text(json.dumps(mfg, ensure_ascii=False), encoding="utf-8")
        return mfg, "서버 DB"
    except (OSError, subprocess.SubprocessError, ValueError) as e:
        if not MFG_CACHE.exists():
            raise SystemExit(f"Druginform 서버 DB 조회 실패, 저장된 사본도 없음: {e}")
        return json.loads(MFG_CACHE.read_text(encoding="utf-8")), "저장된 사본(서버 접속 실패)"


def mfg_label(mfg, edi):
    # 'D628800250'처럼 앞에 D가 붙은 보험코드는 같은 품목의 다른 유통채널 행 - D를 떼고 찾는다
    code = str(edi).strip()
    if code[:1] in ("D", "d") and code[1:].isdigit():
        code = code[1:]
    if code not in mfg:
        return ""
    return f"위탁생산 · {mfg[code]}" if mfg[code] else "자체생산"


def apply_mfg(mfg, data):
    hit = 0
    for r in data["rows"]:
        r[3] = mfg_label(mfg, r[7])
        hit += bool(r[3])
    for s in data["special"]:
        h = s["header"] or []
        if "생동/생산" in h and "보험코드" in h:
            i, j = h.index("생동/생산"), h.index("보험코드")
            for r in s["rows"]:
                r[i] = mfg_label(mfg, r[j])
    return hit


def main():
    files = [p for p in HERE.glob("*.xlsx") if not p.name.startswith("~$")]
    src = max(files, key=lambda p: p.stat().st_mtime)
    wb = openpyxl.load_workbook(src, read_only=True, data_only=True)
    data = {
        "source": src.stem,
        "month": (re.search(r"\d{4}\.\d{2}", src.stem) or [src.stem])[0],
        "rows": read_main(wb.worksheets[0]),
        "special": read_special(wb.worksheets[1]) if len(wb.worksheets) > 1 else [],
    }
    mfg, mfg_src = load_mfg()
    hit = apply_mfg(mfg, data)
    payload = json.dumps(data, ensure_ascii=False, separators=(",", ":")).replace("</", "<\\/")
    html = TEMPLATE.read_text(encoding="utf-8").replace("/*__DATA__*/null", payload)
    OUT.write_text(html, encoding="utf-8")
    print(f"{src.name} → {OUT.name}: {len(data['rows'])}행, 특이사항 {len(data['special'])}구역, "
          f"{OUT.stat().st_size / 1e6:.1f}MB")
    print(f"제조형태({mfg_src}): {hit:,}/{len(data['rows']):,}행 매칭")


if __name__ == "__main__":
    main()
