-- Migration: 003_add_super_admin_role.sql
-- Updates the users.role CHECK constraint to allow 'super_admin'

ALTER TABLE users DROP CONSTRAINT IF EXISTS users_role_check;
ALTER TABLE users ADD CONSTRAINT users_role_check
  CHECK (role IN ('super_admin', 'admin', 'user'));
