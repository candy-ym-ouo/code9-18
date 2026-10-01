import {
  buildCompositionAdvice,
  type CompositionAdviceBasis,
  type CompositionAdviceDto,
  type CompositionAdviceKind,
  type CompositionAdviceReason,
  type CompositionAnnotationInput,
} from '@flil/shared';
import { getDb, newId, nowIso, parseJson, toJson, type SqliteDb } from '../db.js';
import { errors } from '../http/errors.js';

export interface CompositionAdviceRow {
  id: string;
  library_id: string;
  inspiration_id: string;
  asset_id: string;
  kind: CompositionAdviceKind;
  summary: string;
  reasons: string;
  basis: string;
  stale: number;
  created_at: string;
  updated_at: string;
}

export function toCompositionAdviceDto(row: CompositionAdviceRow): CompositionAdviceDto {
  return {
    id: row.id,
    assetId: row.asset_id,
    inspirationId: row.inspiration_id,
    kind: row.kind,
    summary: row.summary,
    reasons: parseJson<CompositionAdviceReason[]>(row.reasons, []),
    basis: parseJson<CompositionAdviceBasis>(row.basis, { annotationIds: [], kinds: [], notes: [] }),
    stale: row.stale === 1,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export function listAdviceForAsset(assetId: string): CompositionAdviceDto[] {
  const rows = getDb()
    .prepare('SELECT * FROM composition_advice WHERE asset_id = ? ORDER BY created_at, rowid')
    .all(assetId) as CompositionAdviceRow[];
  return rows.map(toCompositionAdviceDto);
}

export function listAdviceForInspiration(inspirationId: string): CompositionAdviceDto[] {
  const rows = getDb()
    .prepare('SELECT * FROM composition_advice WHERE inspiration_id = ? ORDER BY created_at, rowid')
    .all(inspirationId) as CompositionAdviceRow[];
  return rows.map(toCompositionAdviceDto);
}

/**
 * 素材被重标（标注覆盖式提交）时同步失效关联建议。
 * 必须在调用方的事务里执行，保证"重标"与"失效"同时落库。
 * 素材删除不走这里：asset 行的 ON DELETE CASCADE 会直接删掉关联建议。
 */
export function invalidateAdviceForAsset(assetId: string, db: SqliteDb = getDb()): number {
  const res = db
    .prepare('UPDATE composition_advice SET stale = 1, updated_at = ? WHERE asset_id = ? AND stale = 0')
    .run(nowIso(), assetId);
  return res.changes;
}

interface AssetContextRow {
  id: string;
  library_id: string;
  inspiration_id: string;
  width: number;
  height: number;
  camera_bearing: number | null;
}

function loadAssetContext(assetId: string, libraryId: string): AssetContextRow {
  const row = getDb()
    .prepare(
      `SELECT a.id, a.library_id, a.inspiration_id, a.width, a.height, s.camera_bearing
       FROM asset a
       JOIN inspiration i ON i.id = a.inspiration_id
       LEFT JOIN spot s ON s.id = i.spot_id
       WHERE a.id = ?`,
    )
    .get(assetId) as AssetContextRow | undefined;
  if (!row) throw errors.notFound('图片');
  if (row.library_id !== libraryId) throw errors.scopeDenied();
  return row;
}

/**
 * 按当前标注全量重算某张素材的机位建议（覆盖式，与标注提交同一风格）。
 * 重算会清掉旧建议（含已失效的），保证列表里只有一套基于最新标注的建议。
 */
export function recomputeAdviceForAsset(assetId: string, libraryId: string): CompositionAdviceDto[] {
  const db = getDb();
  const asset = loadAssetContext(assetId, libraryId);
  const annotations = db
    .prepare('SELECT id, kind, geometry, label FROM composition_note WHERE asset_id = ? ORDER BY created_at')
    .all(assetId) as { id: string; kind: string; geometry: string; label: string | null }[];

  const input: CompositionAnnotationInput[] = annotations.map((a) => ({
    id: a.id,
    kind: a.kind as CompositionAnnotationInput['kind'],
    geometry: parseJson<Record<string, unknown>>(a.geometry, {}),
    label: a.label,
  }));
  const drafts = buildCompositionAdvice({
    annotations: input,
    cameraBearingDeg: asset.camera_bearing,
    imageAspect: asset.width > 0 && asset.height > 0 ? asset.width / asset.height : null,
  });

  const ts = nowIso();
  const run = db.transaction(() => {
    db.prepare('DELETE FROM composition_advice WHERE asset_id = ?').run(assetId);
    for (const d of drafts) {
      db.prepare(
        `INSERT INTO composition_advice (id, library_id, inspiration_id, asset_id, kind, summary, reasons, basis, stale, created_at, updated_at)
         VALUES (?,?,?,?,?,?,?,?,0,?,?)`,
      ).run(newId(), libraryId, asset.inspiration_id, assetId, d.kind, d.summary, toJson(d.reasons), toJson(d.basis), ts, ts);
    }
  });
  run();
  return listAdviceForAsset(assetId);
}
