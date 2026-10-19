"""마인약품 요율표 PWA 관리 도구 (Cloudflare D1·KV를 wrangler로 다룬다).

  python admin.py setup                 처음 한 번: KV 저장소·D1 표 만들기 + 토큰 서명키 등록 (wrangler login 후)
  python admin.py add 대표1 대표2        개인 코드 발급 (무작위, codes.csv에 이름·코드 기록)
  python admin.py add "김은경 대표" --code 123123   코드를 직접 정해서 발급 (영문·숫자 6자 이상)
  python admin.py list                  코드별 상태·기기 등록 여부·마지막 접속
  python admin.py code 대표1             발급했던 코드 다시 보기
  python admin.py reset 대표1            기기 등록 풀기 (폰을 바꿨을 때) → 새 폰에서 같은 코드 입력
  python admin.py stop 대표1 / start 대표1  사용 중지 / 다시 허용
  python admin.py delete 대표1           코드 삭제 (codes.csv에서도 지움)
  python admin.py import                codes.csv의 코드를 서버 표에 다시 넣기 (표를 새로 만들었을 때)
  python admin.py upload-data           build.py가 만든 data.json을 올리기 (2달마다)
  python admin.py deploy                앱 화면·배너·서버 코드 배포
  python admin.py backup-setup          처음 한 번: 백업 비밀번호 정하기 (VS Code 터미널에서 직접 실행)
  python admin.py backup                codes.csv → codes.csv.enc 암호화 백업 (add·delete 때 자동으로도 함)
  python admin.py restore               codes.csv.enc → codes.csv 복원 (백업 비밀번호 필요)

공통 옵션 --local : 실제 Cloudflare 대신 이 PC의 시험용 저장소(wrangler dev)에 적용.
codes.csv 는 코드 원문이 들어 있어 git에 올리지 않는다(서버 D1에는 코드의 해시만 저장됨).
대신 암호화한 codes.csv.enc 를 git에 올려 백업한다. 잠그는 열쇠(backup_public.pem)는 그대로 두고,
여는 열쇠(backup_private.pem.enc)는 백업 비밀번호로 잠가 둔다 → 백업은 비밀번호 없이 자동, 복원만 비밀번호.
코드·기기 기록은 D1(mine-rate-db의 codes 표), 요율 데이터는 KV(RATE_KV의 data)에 있다.
"""
import base64
import csv
import getpass
import hashlib
import json
import re
import secrets
import subprocess
import sys
from datetime import datetime, timedelta, timezone
from pathlib import Path

HERE = Path(__file__).parent
CODES_CSV = HERE / "codes.csv"
DATA_JSON = HERE / "data.json"
BACKUP_ENC = HERE / "codes.csv.enc"
BACKUP_PUB = HERE / "backup_public.pem"
BACKUP_PRIV = HERE / "backup_private.pem.enc"
WRANGLER_TOML = HERE / "wrangler.toml"
BINDING = "RATE_KV"
DB_NAME = "mine-rate-db"
ALPHABET = "23456789ABCDEFGHJKMNPQRSTUVWXYZ"  # 헷갈리는 0/O, 1/I/L 제외
KST = timezone(timedelta(hours=9))

LOCAL = "--local" in sys.argv
ARGS = [a for a in sys.argv[1:] if a != "--local"]
FIXED_CODE = None
if "--code" in ARGS:
    i = ARGS.index("--code")
    FIXED_CODE = ARGS[i + 1] if i + 1 < len(ARGS) else ""
    del ARGS[i:i + 2]


def wrangler(*args, input_text=None, check=True):
    cmd = ["npx", "wrangler", *args]
    for attempt in range(2):
        res = subprocess.run(cmd, cwd=HERE, input=input_text, capture_output=True, text=True,
                             encoding="utf-8", shell=(sys.platform == "win32"))
        # 로그인 토큰이 만료된 직후 첫 요청은 Cloudflare가 7403(권한 없음)으로 거절하고,
        # 그 사이 wrangler가 토큰을 새로 받아 두 번째 요청은 성공한다 → 한 번만 다시 시도
        if res.returncode == 0 or "7403" not in (res.stdout + res.stderr):
            break
    if check and res.returncode != 0:
        raise SystemExit(f"wrangler 실패: {' '.join(args)}\n{res.stderr or res.stdout}")
    return res.stdout


def kv(*args, **kw):
    return wrangler("kv", "key", *args, "--binding", BINDING, "--local" if LOCAL else "--remote", **kw)


def sql_str(v):
    return "NULL" if v is None else "'" + str(v).replace("'", "''") + "'"


def d1(sql):
    """D1에 SQL 한 문장 실행 → 결과 행 목록"""
    out = wrangler("d1", "execute", DB_NAME, "--local" if LOCAL else "--remote", "--json", "--command", sql)
    out = out[out.index("["):]  # 앞에 붙는 안내 문구 제거
    return json.loads(out)[0].get("results", [])


def code_hash(code):
    return hashlib.sha256(re.sub(r"[^A-Z0-9]", "", code.upper()).encode()).hexdigest()


def new_code():
    raw = "".join(secrets.choice(ALPHABET) for _ in range(8))
    return f"{raw[:4]}-{raw[4:]}"


def find(name):
    rows = d1(f"SELECT * FROM codes WHERE name = {sql_str(name)}")
    if not rows:
        raise SystemExit(f"'{name}' 코드를 찾을 수 없습니다. `python admin.py list`로 이름을 확인하세요.")
    return rows[0]


def fmt_time(ms):
    return datetime.fromtimestamp(ms / 1000, KST).strftime("%Y-%m-%d %H:%M") if ms else "-"


def read_codes():
    if not CODES_CSV.exists():
        return []
    with CODES_CSV.open(encoding="utf-8-sig", newline="") as f:
        return list(csv.DictReader(f))


def cmd_setup():
    toml = WRANGLER_TOML.read_text(encoding="utf-8")
    if "__KV_ID__" in toml:
        out = wrangler("kv", "namespace", "create", BINDING)
        m = re.search(r'id\s*=\s*"([0-9a-f]{32})"', out) or re.search(r'"id":\s*"([0-9a-f]{32})"', out)
        if not m:
            raise SystemExit(f"KV 저장소 id를 찾지 못했습니다:\n{out}")
        WRANGLER_TOML.write_text(toml.replace("__KV_ID__", m.group(1)), encoding="utf-8")
        print(f"KV 저장소 생성: {m.group(1)}")
    wrangler("d1", "execute", DB_NAME, "--local" if LOCAL else "--remote", "--file", "schema.sql")
    print("D1 codes 표 준비 완료")
    if not LOCAL:
        wrangler("secret", "put", "TOKEN_SECRET", input_text=secrets.token_urlsafe(48))
        print("토큰 서명키(TOKEN_SECRET) 등록 완료")


def cmd_add(names):
    if FIXED_CODE is not None:
        if len(names) != 1:
            raise SystemExit("--code는 한 사람씩만 쓸 수 있습니다.")
        if len(re.sub(r"[^A-Z0-9]", "", FIXED_CODE.upper())) < 6:
            raise SystemExit("코드는 영문·숫자 6자 이상이어야 합니다.")
        if d1(f"SELECT name FROM codes WHERE id = {sql_str(code_hash(FIXED_CODE))}"):
            raise SystemExit("이미 다른 사람에게 발급된 코드입니다.")
    existing = {r["name"] for r in d1("SELECT name FROM codes")}
    rows = read_codes()
    for name in names:
        if name in existing:
            print(f"{name}: 이미 있는 이름이라 건너뜀")
            continue
        code = FIXED_CODE or new_code()
        now = int(datetime.now().timestamp() * 1000)
        d1(f"INSERT INTO codes (id, name, created_at) VALUES ({sql_str(code_hash(code))}, {sql_str(name)}, {now})")
        rows.append({"name": name, "code": code, "created": datetime.now(KST).strftime("%Y-%m-%d")})
        print(f"{name}: {code}")
    if not LOCAL:
        write_codes(rows)


def write_codes(rows):
    with CODES_CSV.open("w", encoding="utf-8-sig", newline="") as f:
        w = csv.DictWriter(f, fieldnames=["name", "code", "created"])
        w.writeheader()
        w.writerows(rows)
    if BACKUP_PUB.exists():
        cmd_backup(quiet=True)
    else:
        print("※ 백업 비밀번호가 아직 없어 암호화 백업을 건너뜀 (python admin.py backup-setup)")


# ── 암호화 백업 (RSA로 감싼 AES-GCM: 백업은 공개키만으로, 복원은 비밀번호로 연 개인키로) ──────
def cmd_backup_setup():
    from cryptography.hazmat.primitives import serialization
    from cryptography.hazmat.primitives.asymmetric import rsa
    if BACKUP_PRIV.exists():
        raise SystemExit("이미 백업 비밀번호가 있습니다. 바꾸려면 backup_public.pem·backup_private.pem.enc를 지운 뒤 다시 실행하세요.")
    pw = getpass.getpass("백업 비밀번호 (8자 이상, 화면에 안 보임): ")
    if len(pw) < 8:
        raise SystemExit("8자 이상으로 정해 주세요.")
    if getpass.getpass("한 번 더: ") != pw:
        raise SystemExit("두 비밀번호가 다릅니다.")
    key = rsa.generate_private_key(public_exponent=65537, key_size=3072)
    BACKUP_PRIV.write_bytes(key.private_bytes(serialization.Encoding.PEM, serialization.PrivateFormat.PKCS8,
                                              serialization.BestAvailableEncryption(pw.encode())))
    BACKUP_PUB.write_bytes(key.public_key().public_bytes(serialization.Encoding.PEM,
                                                         serialization.PublicFormat.SubjectPublicKeyInfo))
    print("백업 비밀번호 설정 완료. 이 비밀번호는 어디에도 저장되지 않으니 따로 꼭 기록해 두세요.")
    if CODES_CSV.exists():
        cmd_backup()


def cmd_backup(quiet=False):
    from cryptography.hazmat.primitives import hashes, serialization
    from cryptography.hazmat.primitives.asymmetric import padding
    from cryptography.hazmat.primitives.ciphers.aead import AESGCM
    if not BACKUP_PUB.exists():
        raise SystemExit("먼저 python admin.py backup-setup 으로 백업 비밀번호를 정하세요.")
    pub = serialization.load_pem_public_key(BACKUP_PUB.read_bytes())
    data_key, nonce = AESGCM.generate_key(bit_length=256), secrets.token_bytes(12)
    oaep = padding.OAEP(mgf=padding.MGF1(hashes.SHA256()), algorithm=hashes.SHA256(), label=None)
    b64 = lambda b: base64.b64encode(b).decode()
    BACKUP_ENC.write_text(json.dumps({
        "v": 1,
        "key": b64(pub.encrypt(data_key, oaep)),
        "nonce": b64(nonce),
        "data": b64(AESGCM(data_key).encrypt(nonce, CODES_CSV.read_bytes(), None)),
        "at": datetime.now(KST).strftime("%Y-%m-%d %H:%M"),
    }), encoding="utf-8")
    if not quiet:
        print(f"암호화 백업 완료: {BACKUP_ENC.name} (커밋·싱크하면 GitHub에도 백업됨)")


def cmd_restore():
    from cryptography.hazmat.primitives import hashes, serialization
    from cryptography.hazmat.primitives.asymmetric import padding
    from cryptography.hazmat.primitives.ciphers.aead import AESGCM
    if not (BACKUP_ENC.exists() and BACKUP_PRIV.exists()):
        raise SystemExit("codes.csv.enc 또는 backup_private.pem.enc가 없습니다. 저장소를 최신으로 받았는지 확인하세요.")
    pw = getpass.getpass("백업 비밀번호: ")
    try:
        key = serialization.load_pem_private_key(BACKUP_PRIV.read_bytes(), password=pw.encode())
    except (ValueError, TypeError):
        raise SystemExit("비밀번호가 맞지 않습니다.")
    box = json.loads(BACKUP_ENC.read_text(encoding="utf-8"))
    oaep = padding.OAEP(mgf=padding.MGF1(hashes.SHA256()), algorithm=hashes.SHA256(), label=None)
    data_key = key.decrypt(base64.b64decode(box["key"]), oaep)
    plain = AESGCM(data_key).decrypt(base64.b64decode(box["nonce"]), base64.b64decode(box["data"]), None)
    out = CODES_CSV if not CODES_CSV.exists() else HERE / "codes.restored.csv"
    out.write_bytes(plain)
    print(f"복원 완료: {out.name} (백업 시각 {box.get('at', '?')})")


def cmd_import():
    """codes.csv에 있는 코드를 D1에 다시 넣는다 (서버 표를 새로 만들었을 때, 코드는 그대로 유지)"""
    existing = {r["name"] for r in d1("SELECT name FROM codes")}
    now = int(datetime.now().timestamp() * 1000)
    for row in read_codes():
        if row["name"] in existing:
            continue
        d1(f"INSERT INTO codes (id, name, created_at) VALUES ({sql_str(code_hash(row['code']))}, {sql_str(row['name'])}, {now})")
        print(f"{row['name']}: 등록")


def cmd_delete(name):
    find(name)
    d1(f"DELETE FROM codes WHERE name = {sql_str(name)}")
    if not LOCAL:
        write_codes([r for r in read_codes() if r["name"] != name])
    print(f"{name}: 삭제")


def cmd_list():
    recs = d1("SELECT name, active, device, activated_at, last_seen FROM codes ORDER BY name")
    if not recs:
        print("발급된 코드가 없습니다.")
        return
    print(f"{'이름':<8} {'상태':<4} {'기기':<6} {'첫 등록':<16} {'마지막 접속':<16}")
    for r in recs:
        print(f"{r['name']:<8} {'사용' if r['active'] else '중지':<4} {'등록됨' if r['device'] else '미등록':<6} "
              f"{fmt_time(r['activated_at']):<16} {fmt_time(r['last_seen']):<16}")


def cmd_code(name):
    for row in read_codes():
        if row["name"] == name:
            print(f"{name}: {row['code']}")
            return
    print(f"{name}: codes.csv에 없습니다.")


def cmd_update(name, sql_set):
    find(name)
    d1(f"UPDATE codes SET {sql_set} WHERE name = {sql_str(name)}")


def cmd_upload_data():
    if not DATA_JSON.exists():
        raise SystemExit("data.json이 없습니다. 먼저 상위 폴더에서 `python build.py`를 실행하세요.")
    etag = hashlib.sha1(DATA_JSON.read_bytes()).hexdigest()[:16]
    kv("put", "data", "--path", str(DATA_JSON))
    kv("put", "data:etag", etag)
    print(f"데이터 업로드 완료 ({DATA_JSON.stat().st_size / 1e6:.1f}MB, 버전 {etag})")


def main():
    if not ARGS:
        print(__doc__)
        return
    cmd, rest = ARGS[0], ARGS[1:]
    if cmd == "setup":
        cmd_setup()
    elif cmd == "add" and rest:
        cmd_add(rest)
    elif cmd == "list":
        cmd_list()
    elif cmd == "code" and rest:
        cmd_code(rest[0])
    elif cmd == "reset" and rest:
        cmd_update(rest[0], "device = NULL, rebind_until = 0, activated_at = 0")
        print(f"{rest[0]}: 기기 등록을 풀었습니다. 새 폰에서 같은 코드를 입력하면 됩니다.")
    elif cmd == "stop" and rest:
        cmd_update(rest[0], "active = 0")
        print(f"{rest[0]}: 사용 중지 (다음에 앱을 열 때부터 막힘)")
    elif cmd == "start" and rest:
        cmd_update(rest[0], "active = 1")
        print(f"{rest[0]}: 다시 사용 가능")
    elif cmd == "delete" and rest:
        cmd_delete(rest[0])
    elif cmd == "import":
        cmd_import()
    elif cmd == "backup-setup":
        cmd_backup_setup()
    elif cmd == "backup":
        cmd_backup()
    elif cmd == "restore":
        cmd_restore()
    elif cmd == "upload-data":
        cmd_upload_data()
    elif cmd == "deploy":
        print(wrangler("deploy"))
    else:
        print(__doc__)


if __name__ == "__main__":
    main()
