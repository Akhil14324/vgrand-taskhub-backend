-- Migration: 042_business_sections.sql
-- A business can have sections of its own. They belong to the business (everyone in it sees them; the people
-- who manage it create, rename, reorder and archive them) and a business task sits in one of them.
-- Purely additive.

ALTER TABLE todo_sections ADD COLUMN IF NOT EXISTS business_id INTEGER REFERENCES businesses(id) ON DELETE CASCADE;
CREATE INDEX IF NOT EXISTS idx_todo_sections_business ON todo_sections(business_id, sort_order) WHERE business_id IS NOT NULL;

ALTER TABLE todos ADD COLUMN IF NOT EXISTS business_section_id INTEGER REFERENCES todo_sections(id) ON DELETE SET NULL;
