CREATE TABLE IF NOT EXISTS registrations (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  visitor_hash TEXT NOT NULL UNIQUE,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);

CREATE TABLE IF NOT EXISTS registration_stats (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  total_count INTEGER NOT NULL DEFAULT 0
);

-- Keeps the public total accurate, including when multiple signups arrive at once.
INSERT OR IGNORE INTO registration_stats (id, total_count)
SELECT 1, COUNT(*) FROM registrations;

CREATE TRIGGER IF NOT EXISTS registrations_count_after_insert
AFTER INSERT ON registrations
BEGIN
  UPDATE registration_stats
  SET total_count = total_count + 1
  WHERE id = 1;
END;
