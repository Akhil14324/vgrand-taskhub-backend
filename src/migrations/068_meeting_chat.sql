-- Meetings: the questions asked about a meeting and the AI's answers are kept with it (additive: one new column).
-- Each entry is { role: 'user' | 'assistant', text, visual?, at }.
ALTER TABLE meeting_notes ADD COLUMN IF NOT EXISTS chat JSONB NOT NULL DEFAULT '[]'::jsonb;
