-- 构图辅助模块 · 机位建议表（由光位箭头 / 取景框 / 主体线生成）
-- 素材删除或覆盖重标后，关联建议在同一事务里被标记 invalidated，历史保留可追溯。
-- 注意：asset_id 不加 ON DELETE CASCADE —— 失效必须留痕（显式标记原因），
-- 由服务端在删除素材的事务内先失效再删除。
CREATE TABLE IF NOT EXISTS composition_suggestion (
  id                 TEXT PRIMARY KEY,
  library_id         TEXT NOT NULL REFERENCES library(id) ON DELETE CASCADE,
  asset_id           TEXT NOT NULL,
  inspiration_id     TEXT,
  status             TEXT NOT NULL DEFAULT 'active'
                     CHECK (status IN ('active','invalidated')),
  rule_code          TEXT NOT NULL,
  suggestion_key     TEXT NOT NULL,
  title              TEXT NOT NULL,
  detail             TEXT NOT NULL,
  priority           TEXT NOT NULL DEFAULT 'tip'
                     CHECK (priority IN ('tip','info','warn')),
  basis              TEXT NOT NULL DEFAULT '[]',
  actions            TEXT NOT NULL DEFAULT '[]',
  source_annotation_ids TEXT NOT NULL DEFAULT '[]',
  signature          TEXT NOT NULL,
  invalidated_reason TEXT
                     CHECK (invalidated_reason IS NULL OR invalidated_reason IN ('asset_deleted','annotations_replaced')),
  invalidated_at     TEXT,
  created_at         TEXT NOT NULL
);

-- 重生成去重：同一素材、同一规则键只允许一条 active
CREATE UNIQUE INDEX IF NOT EXISTS idx_compsug_active_key
  ON composition_suggestion(asset_id, suggestion_key) WHERE status = 'active';
CREATE INDEX IF NOT EXISTS idx_compsug_insp ON composition_suggestion(inspiration_id, status, created_at);
CREATE INDEX IF NOT EXISTS idx_compsug_asset ON composition_suggestion(asset_id, status);
