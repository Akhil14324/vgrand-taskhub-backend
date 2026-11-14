-- The super admin (the owner's request, 2026-11-14).
-- 1. Akhil's account becomes a super admin without a tier: it sits above everyone, sees everything, and no
--    screen shows a rank for it (a person without a tier is listed by their place in their company only).
--    Only the role and tier of that one account change; nothing else about it does.
UPDATE users SET role = 'super_admin', org_level = NULL
WHERE lower(username) = 'akhil' AND status <> 'inactive' AND (role <> 'super_admin' OR org_level IS NOT NULL);

-- 2. Every time a super admin signs in as someone else, it is written down here (append-only).
CREATE TABLE IF NOT EXISTS admin_logins (
  id SERIAL PRIMARY KEY,
  admin_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_admin_logins_admin ON admin_logins(admin_id, created_at DESC);
