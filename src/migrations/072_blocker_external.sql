-- A task can wait on someone who is not on TaskHub (yet): their name is kept as text.
ALTER TABLE todo_blockers ADD COLUMN IF NOT EXISTS blocked_by_name VARCHAR(120);
