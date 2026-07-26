-- Migration: 016_merge_duplicate_direct_chats.sql
-- Merges duplicate direct conversations for each pair of users.
-- For every pair of users, keeps the direct conversation with the most messages
-- (or the oldest id if tied) and moves messages from duplicates into it.

-- Step 1: Build a mapping of each direct conversation to its user pair (sorted text key)
CREATE TEMP TABLE IF NOT EXISTS conv_pairs AS
SELECT c.id AS conversation_id,
  (
    SELECT string_agg(uid::text, ',' ORDER BY uid)
    FROM (
      SELECT user_id AS uid FROM conversation_participants WHERE conversation_id = c.id
      UNION
      SELECT sender_id FROM messages WHERE conversation_id = c.id
    ) sub
  ) AS user_pair
FROM conversations c
WHERE c.type = 'direct';

-- Step 2: Rank conversations within each pair by message count (desc) then id (asc)
CREATE TEMP TABLE IF NOT EXISTS conv_ranked AS
SELECT cp.conversation_id,
       cp.user_pair,
       (SELECT COUNT(*) FROM messages m WHERE m.conversation_id = cp.conversation_id) AS msg_count,
       ROW_NUMBER() OVER (PARTITION BY cp.user_pair ORDER BY (SELECT COUNT(*) FROM messages m WHERE m.conversation_id = cp.conversation_id) DESC, cp.conversation_id ASC) AS rn
FROM conv_pairs cp;

-- Step 3: Build canonical -> duplicate mapping
CREATE TEMP TABLE IF NOT EXISTS dup_convs AS
SELECT r1.conversation_id AS canonical_id, r2.conversation_id AS duplicate_id
FROM conv_ranked r1
JOIN conv_ranked r2 ON r1.user_pair = r2.user_pair AND r1.rn = 1 AND r2.rn > 1
WHERE r1.user_pair IS NOT NULL AND r2.user_pair IS NOT NULL;

-- Step 4: Move messages from duplicates into the canonical conversation
UPDATE messages m
SET conversation_id = d.canonical_id
FROM dup_convs d
WHERE m.conversation_id = d.duplicate_id;

-- Step 5: Merge participants from duplicates into canonical
INSERT INTO conversation_participants (conversation_id, user_id, is_admin, last_read_message_id, is_hidden, joined_at)
SELECT d.canonical_id, cp.user_id, cp.is_admin, cp.last_read_message_id, cp.is_hidden, cp.joined_at
FROM conversation_participants cp
JOIN dup_convs d ON cp.conversation_id = d.duplicate_id
ON CONFLICT (conversation_id, user_id) DO UPDATE SET
  is_hidden = conversation_participants.is_hidden AND EXCLUDED.is_hidden,
  last_read_message_id = GREATEST(COALESCE(conversation_participants.last_read_message_id, 0), COALESCE(EXCLUDED.last_read_message_id, 0));

-- Step 6: Delete duplicate participant rows
DELETE FROM conversation_participants cp
USING dup_convs d
WHERE cp.conversation_id = d.duplicate_id;

-- Step 7: Delete duplicate conversations
DELETE FROM conversations c
USING dup_convs d
WHERE c.id = d.duplicate_id;

-- Step 8: Bump updated_at on canonical conversations
UPDATE conversations c
SET updated_at = NOW()
FROM dup_convs d
WHERE c.id = d.canonical_id;

-- Cleanup
DROP TABLE IF EXISTS dup_convs;
DROP TABLE IF EXISTS conv_ranked;
DROP TABLE IF EXISTS conv_pairs;
