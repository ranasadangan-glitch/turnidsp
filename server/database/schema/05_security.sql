-- ============================================================
-- 05 — Security additions (additive, idempotent)
--   * refresh-token sessions (multi-device control, rotation)
--   * password reset tokens (expiring)
--   * login attempt tracking (lockout / brute-force protection)
--   * expanded roles: admin | osm | hr_manager | team_leader
-- ============================================================

-- Expanded role set. role stays TEXT; we validate in code, but add a CHECK
-- that allows the four roles (drop old check if present).
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.constraint_column_usage
    WHERE table_name='users' AND constraint_name='users_role_chk'
  ) THEN
    ALTER TABLE users ADD CONSTRAINT users_role_chk
      CHECK (role IN ('admin','osm','hr_manager','team_leader'));
  END IF;
EXCEPTION WHEN others THEN
  -- if existing data violates the constraint, skip adding it (don't block deploy)
  RAISE NOTICE 'Skipping users_role_chk: %', SQLERRM;
END $$;

-- Refresh-token sessions. We store only a SHA-256 hash of the refresh token.
CREATE TABLE IF NOT EXISTS sessions (
  id             BIGSERIAL PRIMARY KEY,
  user_id        INT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  token_hash     TEXT NOT NULL UNIQUE,
  user_agent     TEXT,
  ip             TEXT,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  last_used_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  expires_at     TIMESTAMPTZ NOT NULL,
  revoked_at     TIMESTAMPTZ
);
CREATE INDEX IF NOT EXISTS idx_sessions_user ON sessions(user_id);
CREATE INDEX IF NOT EXISTS idx_sessions_hash ON sessions(token_hash);

-- Password reset tokens (store only the hash; single-use; expiring).
CREATE TABLE IF NOT EXISTS password_reset_tokens (
  id          BIGSERIAL PRIMARY KEY,
  user_id     INT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  token_hash  TEXT NOT NULL UNIQUE,
  expires_at  TIMESTAMPTZ NOT NULL,
  used_at     TIMESTAMPTZ,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_prt_user ON password_reset_tokens(user_id);

-- Login attempt log for lockout / brute-force protection.
CREATE TABLE IF NOT EXISTS login_attempts (
  id          BIGSERIAL PRIMARY KEY,
  username    TEXT,
  ip          TEXT,
  success     BOOLEAN NOT NULL,
  at          TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_login_attempts_lookup ON login_attempts(username, ip, at);

-- Optional: users.email for password-reset delivery.
ALTER TABLE users ADD COLUMN IF NOT EXISTS email TEXT;
