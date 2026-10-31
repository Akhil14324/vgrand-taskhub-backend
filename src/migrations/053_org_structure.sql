-- Group -> company -> site. Additive only: new tables and new nullable columns, nothing existing is changed.
--   org_groups      the parent organisation (one row: Vgrand)
--   businesses      gains group_id, sector and logo_url
--   sites           branches, sites and projects inside a business (Ongolu, Kandukuru, Tripura, ...)
--   site_members    people placed at a site; a site member is always also in user_businesses

CREATE TABLE IF NOT EXISTS org_groups (
  id SERIAL PRIMARY KEY,
  name VARCHAR(120) NOT NULL,
  logo_url TEXT,
  timezone VARCHAR(60) NOT NULL DEFAULT 'Asia/Kolkata',
  working_days JSONB NOT NULL DEFAULT '[1,2,3,4,5,6]',
  working_hours JSONB NOT NULL DEFAULT '{"start":"09:30","end":"18:30"}',
  week_start SMALLINT NOT NULL DEFAULT 1,
  date_format VARCHAR(20) NOT NULL DEFAULT 'DD MMM YYYY',
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

INSERT INTO org_groups (name)
SELECT 'Vgrand' WHERE NOT EXISTS (SELECT 1 FROM org_groups);

ALTER TABLE businesses ADD COLUMN IF NOT EXISTS group_id INTEGER REFERENCES org_groups(id);
ALTER TABLE businesses ADD COLUMN IF NOT EXISTS sector VARCHAR(30);
ALTER TABLE businesses ADD COLUMN IF NOT EXISTS logo_url TEXT;

-- Fill only the new columns, only where they are still empty.
UPDATE businesses SET group_id = (SELECT MIN(id) FROM org_groups) WHERE group_id IS NULL;
UPDATE businesses SET sector = CASE
    WHEN name ILIKE '%health%' OR name ILIKE '%hospital%' THEN 'healthcare'
    WHEN name ILIKE '%lounge%' OR name ILIKE '%bar%' THEN 'liquor'
    WHEN type = 'restaurant' THEN 'food'
    WHEN type = 'construction' THEN 'real_estate'
    WHEN type = 'it' THEN 'software'
    WHEN type = 'mines' THEN 'mining'
    ELSE 'other'
  END
WHERE sector IS NULL;

CREATE TABLE IF NOT EXISTS sites (
  id SERIAL PRIMARY KEY,
  business_id INTEGER NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
  name VARCHAR(120) NOT NULL,
  kind VARCHAR(20) NOT NULL DEFAULT 'site' CHECK (kind IN ('branch', 'site', 'project')),
  status VARCHAR(20) NOT NULL DEFAULT 'active'
    CHECK (status IN ('active', 'under_construction', 'upcoming', 'completed')),
  address TEXT,
  sort_order INTEGER NOT NULL DEFAULT 0,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  archived_at TIMESTAMPTZ,
  UNIQUE (business_id, name)
);
CREATE INDEX IF NOT EXISTS idx_sites_business ON sites(business_id);

CREATE TABLE IF NOT EXISTS site_members (
  site_id INTEGER NOT NULL REFERENCES sites(id) ON DELETE CASCADE,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  designation VARCHAR(30) NOT NULL DEFAULT 'member',
  added_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (site_id, user_id)
);
CREATE INDEX IF NOT EXISTS idx_site_members_user ON site_members(user_id);
