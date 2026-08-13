-- Add deleted_by column to track who deleted a message (sender or admin)
ALTER TABLE messages ADD COLUMN IF NOT EXISTS deleted_by INTEGER REFERENCES users(id) ON DELETE SET NULL;
