-- Migration: 065_timebox_report.sql
-- The end-of-day report written from a timebox (summary bullets, impact, ratings, time saved, status).
-- One JSON document on the day's row; nothing existing is changed or removed.
ALTER TABLE timeboxes ADD COLUMN IF NOT EXISTS report JSONB;
