-- 개인 코드 1개 = 1행. id는 코드 원문의 SHA-256 (코드 원문은 서버에 두지 않음)
CREATE TABLE IF NOT EXISTS codes (
  id            TEXT PRIMARY KEY,
  name          TEXT NOT NULL UNIQUE,
  active        INTEGER NOT NULL DEFAULT 1,
  device        TEXT,                        -- 등록된 기기 ID (NULL = 미등록)
  activated_at  INTEGER NOT NULL DEFAULT 0,  -- 첫 등록 시각(ms)
  rebind_until  INTEGER NOT NULL DEFAULT 0,  -- 이 시각 전까지 기기 1회 이동 허용(ms)
  last_seen     INTEGER NOT NULL DEFAULT 0,
  created_at    INTEGER NOT NULL DEFAULT 0
);
