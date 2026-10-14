-- Migration: 044_private_direct_chats.sql
-- A direct chat belongs to exactly two people. Some direct chats had a third person in them
-- (so that person could read the conversation and the names in the list were mixed up), and
-- two people could end up with several direct chats. This repairs the data and makes both
-- impossible from now on.

-- 1. Repair direct chats that have more than two participants.
--    Keep the creator and the people who actually wrote in it. If that does not leave exactly two,
--    keep the creator plus the one other person the creator has no direct chat with yet.
DO $$
DECLARE
  r RECORD;
  keep INT[];
  extra INT;
BEGIN
  FOR r IN
    SELECT c.id, c.created_by
    FROM conversations c
    WHERE c.type = 'direct'
      AND (SELECT COUNT(*) FROM conversation_participants cp WHERE cp.conversation_id = c.id) > 2
    ORDER BY c.id
  LOOP
    SELECT COALESCE(array_agg(DISTINCT uid), '{}') INTO keep FROM (
      SELECT r.created_by AS uid
      UNION
      SELECT m.sender_id FROM messages m WHERE m.conversation_id = r.id
    ) s
    WHERE uid IN (SELECT user_id FROM conversation_participants WHERE conversation_id = r.id);

    IF COALESCE(array_length(keep, 1), 0) <> 2 THEN
      keep := ARRAY[r.created_by];
      extra := NULL;
      SELECT cp.user_id INTO extra
      FROM conversation_participants cp
      WHERE cp.conversation_id = r.id AND cp.user_id <> r.created_by
        AND NOT EXISTS (
          SELECT 1
          FROM conversation_participants a
          JOIN conversation_participants b ON b.conversation_id = a.conversation_id
          JOIN conversations c2 ON c2.id = a.conversation_id AND c2.type = 'direct'
          WHERE a.user_id = r.created_by AND b.user_id = cp.user_id AND a.conversation_id <> r.id
            AND (SELECT COUNT(*) FROM conversation_participants x WHERE x.conversation_id = c2.id) = 2
        )
      ORDER BY cp.joined_at, cp.user_id
      LIMIT 1;
      IF extra IS NULL THEN
        SELECT cp.user_id INTO extra FROM conversation_participants cp
        WHERE cp.conversation_id = r.id AND cp.user_id <> r.created_by ORDER BY cp.joined_at, cp.user_id LIMIT 1;
      END IF;
      keep := keep || extra;
    END IF;

    DELETE FROM conversation_participants WHERE conversation_id = r.id AND NOT (user_id = ANY(keep));
  END LOOP;
END $$;

-- 2. One direct chat per pair: a key such as '2:4' (smaller id first).
ALTER TABLE conversations ADD COLUMN IF NOT EXISTS direct_key TEXT;

UPDATE conversations c
SET direct_key = k.pair
FROM (
  SELECT cp.conversation_id,
         MIN(cp.user_id)::text || ':' || MAX(cp.user_id)::text AS pair
  FROM conversation_participants cp
  GROUP BY cp.conversation_id
  HAVING COUNT(*) = 2
) k
WHERE c.id = k.conversation_id AND c.type = 'direct';

-- 3. Merge duplicate direct chats of the same pair into the one with the most messages.
CREATE TEMP TABLE dup_direct AS
SELECT id AS duplicate_id,
       FIRST_VALUE(id) OVER (PARTITION BY direct_key ORDER BY msgs DESC, id) AS canonical_id,
       ROW_NUMBER() OVER (PARTITION BY direct_key ORDER BY msgs DESC, id) AS rn
FROM (
  SELECT c.id, c.direct_key, (SELECT COUNT(*) FROM messages m WHERE m.conversation_id = c.id) AS msgs
  FROM conversations c
  WHERE c.type = 'direct' AND c.direct_key IS NOT NULL
) t;

DELETE FROM dup_direct WHERE rn = 1;

UPDATE messages m SET conversation_id = d.canonical_id FROM dup_direct d WHERE m.conversation_id = d.duplicate_id;

UPDATE conversation_participants cp
SET is_hidden = cp.is_hidden AND dp.is_hidden
FROM dup_direct d
JOIN conversation_participants dp ON dp.conversation_id = d.duplicate_id
WHERE cp.conversation_id = d.canonical_id AND cp.user_id = dp.user_id;

DELETE FROM conversation_participants cp USING dup_direct d WHERE cp.conversation_id = d.duplicate_id;
DELETE FROM conversations c USING dup_direct d WHERE c.id = d.duplicate_id;
DROP TABLE dup_direct;

CREATE UNIQUE INDEX IF NOT EXISTS uq_conversations_direct_key
  ON conversations(direct_key) WHERE direct_key IS NOT NULL;

-- 4. A direct chat can never take a third participant.
CREATE OR REPLACE FUNCTION enforce_direct_two_participants() RETURNS trigger AS $$
BEGIN
  IF (SELECT type FROM conversations WHERE id = NEW.conversation_id) = 'direct'
     AND (SELECT COUNT(*) FROM conversation_participants WHERE conversation_id = NEW.conversation_id) >= 2 THEN
    RAISE EXCEPTION 'A direct chat has exactly two participants';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_direct_two_participants ON conversation_participants;
CREATE TRIGGER trg_direct_two_participants BEFORE INSERT ON conversation_participants
  FOR EACH ROW EXECUTE FUNCTION enforce_direct_two_participants();
