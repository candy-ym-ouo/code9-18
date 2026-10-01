-- 0002 构图辅助：由标注生成的机位建议（素材删除级联失效，重标置 stale）
CREATE TABLE IF NOT EXISTS composition_advice (
  id             TEXT PRIMARY KEY,
  library_id     TEXT NOT NULL REFERENCES library(id) ON DELETE CASCADE,
  inspiration_id TEXT NOT NULL REFERENCES inspiration(id) ON DELETE CASCADE,
  asset_id       TEXT NOT NULL REFERENCES asset(id) ON DELETE CASCADE,
  kind           TEXT NOT NULL CHECK (kind IN ('keep_bearing','shift_camera','adjust_framing','check_conflict')),
  summary        TEXT NOT NULL,
  reasons        TEXT NOT NULL DEFAULT '[]',
  basis          TEXT NOT NULL DEFAULT '{}',
  stale          INTEGER NOT NULL DEFAULT 0,
  created_at     TEXT NOT NULL,
  updated_at     TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_composition_advice_asset ON composition_advice(asset_id);
CREATE INDEX IF NOT EXISTS idx_composition_advice_inspiration ON composition_advice(inspiration_id);
