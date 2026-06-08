-- כותרות — D1 schema
-- Headlines + subheadings only. No article bodies, ever.

CREATE TABLE IF NOT EXISTS articles (
  id           TEXT PRIMARY KEY,   -- sha256(link)
  source       TEXT,
  lean         TEXT,
  title        TEXT,
  subheading   TEXT,
  url          TEXT,
  published_at INTEGER,            -- unix seconds
  embedding    TEXT,               -- JSON array of normalized floats
  cluster_id   TEXT,
  fetched_at   INTEGER
);

CREATE INDEX IF NOT EXISTS idx_articles_published_at ON articles (published_at);
CREATE INDEX IF NOT EXISTS idx_articles_cluster_id   ON articles (cluster_id);
