-- Business tasks that name exactly one other person with @username in their title, but were never handed to
-- them, now go to that person, so they appear in their To-do. Only open, accepted, unassigned top-level tasks
-- are touched, and only when the title names one active member of that business. Re-running changes nothing.
WITH named AS (
  SELECT DISTINCT t.id AS todo_id, u.id AS user_id
  FROM todos t
  CROSS JOIN LATERAL regexp_matches(t.title, '(?:^|[^A-Za-z0-9_.-])@([A-Za-z0-9._-]{2,50})', 'g') AS m(parts)
  JOIN users u ON LOWER(u.username) = LOWER(REGEXP_REPLACE(m.parts[1], '[.-]+$', ''))
  JOIN user_businesses ub ON ub.user_id = u.id AND ub.business_id = t.business_id
  WHERE t.business_id IS NOT NULL
    AND t.parent_id IS NULL
    AND t.review_state = 'accepted'
    AND t.is_done = FALSE
    AND t.assignee_id IS NULL
    AND u.status <> 'inactive'
    AND u.id <> t.created_by
),
solo AS (
  SELECT todo_id, MIN(user_id) AS user_id
  FROM named
  GROUP BY todo_id
  HAVING COUNT(*) = 1
)
UPDATE todos t
SET assignee_id = solo.user_id, assigned_at = NOW()
FROM solo
WHERE t.id = solo.todo_id;
