-- Migration: 021_backfill_business_groups.sql
-- Creates group conversations for existing businesses that don't have one yet
-- Adds all admins, super_admins, and assigned users as participants

DO $$
DECLARE
  biz RECORD;
  conv_id INTEGER;
  admin_row RECORD;
  assigned_row RECORD;
  is_sa BOOLEAN;
BEGIN
  FOR biz IN SELECT id, name FROM businesses WHERE id NOT IN (
    SELECT business_id FROM conversations WHERE type = 'group' AND business_id IS NOT NULL
  ) LOOP
    INSERT INTO conversations (type, name, business_id, created_by)
    VALUES ('group', biz.name, biz.id, (SELECT id FROM users WHERE role = 'super_admin' LIMIT 1))
    RETURNING id INTO conv_id;

    FOR admin_row IN SELECT id, role FROM users WHERE role IN ('admin', 'super_admin') AND status = 'active' LOOP
      is_sa := admin_row.role = 'super_admin';
      INSERT INTO conversation_participants (conversation_id, user_id, is_admin, is_invisible)
      VALUES (conv_id, admin_row.id, FALSE, is_sa)
      ON CONFLICT DO NOTHING;
    END LOOP;

    FOR assigned_row IN
      SELECT ub.user_id FROM user_businesses ub
      JOIN users u ON u.id = ub.user_id
      WHERE ub.business_id = biz.id AND u.status = 'active'
    LOOP
      INSERT INTO conversation_participants (conversation_id, user_id, is_admin, is_invisible)
      VALUES (conv_id, assigned_row.user_id, FALSE, FALSE)
      ON CONFLICT DO NOTHING;
    END LOOP;
  END LOOP;
END $$;
