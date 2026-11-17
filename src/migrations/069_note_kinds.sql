-- Notes come in two kinds (additive: three new columns, every existing note stays a text note as it is).
--   text  : formatted writing. `html` holds the safe markup (utils/noteContent.js); `body` keeps its plain words.
--   sheet : a grid for typing and exporting. `content` holds { rows, widths }; `body` keeps its words for search.
ALTER TABLE notes ADD COLUMN IF NOT EXISTS kind VARCHAR(8) NOT NULL DEFAULT 'text';
ALTER TABLE notes ADD COLUMN IF NOT EXISTS html TEXT;
ALTER TABLE notes ADD COLUMN IF NOT EXISTS content JSONB;
ALTER TABLE notes DROP CONSTRAINT IF EXISTS notes_kind_check;
ALTER TABLE notes ADD CONSTRAINT notes_kind_check CHECK (kind IN ('text', 'sheet'));
