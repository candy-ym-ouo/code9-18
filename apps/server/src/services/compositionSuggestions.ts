import {
  annotationsSignature,
  generateCompositionSuggestions,
  type CompositionSuggestion,
  type CompositionSuggestionDto,
  type CompositionInvalidatedReason,
} from '@flil/shared';
import { getDb, newId, nowIso, parseJson, toJson } from '../db.js';
import type { AssetRow } from './assets.js';

interface AnnotationRow {
  id: string;
  asset_id: string;
  kind: string;
  geometry: string;
  label: string | null;
}

/**
 * 构图辅助：由光位箭头 / 取景框 / 主体线生成机位建议并逐条解释依据。
 * 失效契约（同步、同事务）：
 *  - 素材删除：删除 asset 之前先把 active 建议标记为 invalidated / asset_deleted
 *  - 覆盖重标：PUT annotations 覆盖后，把旧 active 建议标记为 invalidated / annotations_replaced，
 *    再按新标注重算
 */

export function loadAnnotationRows(assetId: string): AnnotationRow[] {
  return getDb()
    .prepare('SELECT * FROM composition_note WHERE asset_id = ? ORDER BY created_at')
    .all(assetId) as AnnotationRow[];
}

export function invalidateSuggestionsForAsset(
  db: ReturnType<typeof getDb>,
  assetId: string,
  reason: CompositionInvalidatedReason,
  ts: string,
): number {
  const info = db
    .prepare(
      `UPDATE composition_suggestion
         SET status = 'invalidated', invalidated_reason = ?, invalidated_at = ?
       WHERE asset_id = ? AND status = 'active'`,
    )
    .run(reason, ts, assetId);
  return info.changes;
}

function toDto(row: Record<string, unknown>): CompositionSuggestionDto {
  return {
    id: row.id as string,
    assetId: (row.asset_id as string | null) ?? null,
    inspirationId: (row.inspiration_id as string | null) ?? null,
    status: row.status as CompositionSuggestionDto['status'],
    ruleCode: row.rule_code as string,
    suggestionKey: row.suggestion_key as string,
    title: row.title as string,
    detail: row.detail as string,
    priority: row.priority as CompositionSuggestionDto['priority'],
    basis: parseJson(row.basis, []),
    actions: parseJson(row.actions, []),
    sourceAnnotationIds: parseJson(row.source_annotation_ids, []),
    signature: row.signature as string,
    invalidatedReason: (row.invalidated_reason as CompositionInvalidatedReason | null) ?? null,
    invalidatedAt: (row.invalidated_at as string | null) ?? null,
    createdAt: row.created_at as string,
  };
}

function cameraBearingOf(inspirationId: string): number | null {
  const row = getDb()
    .prepare(
      `SELECT s.camera_bearing AS bearing
         FROM inspiration i JOIN spot s ON s.id = i.spot_id
        WHERE i.id = ?`,
    )
    .get(inspirationId) as { bearing: number } | undefined;
  return row ? row.bearing : null;
}

/** 依据当前标注重算并落库某素材的全部建议；返回新生成的 active 建议 */
export function regenerateSuggestionsForAsset(asset: AssetRow): {
  generated: number;
  items: CompositionSuggestionDto[];
  signature: string;
} {
  const db = getDb();
  const ts = nowIso();
  const noteRows = loadAnnotationRows(asset.id);
  const annotations = noteRows.map((r) => ({
    id: r.id,
    kind: r.kind,
    geometry: parseJson<Record<string, unknown>>(r.geometry, {}),
    label: r.label,
  }));
  const cameraBearing = cameraBearingOf(asset.inspiration_id);
  const signature = annotationsSignature(annotations, cameraBearing);
  const suggestions: CompositionSuggestion[] = generateCompositionSuggestions({ annotations, cameraBearing });

  const persist = db.transaction(() => {
    const findActive = db.prepare(
      `SELECT id FROM composition_suggestion
        WHERE asset_id = ? AND suggestion_key = ? AND status = 'active'`,
    );
    const insertOne = db.prepare(
      `INSERT INTO composition_suggestion
         (id, library_id, asset_id, inspiration_id, status, rule_code, suggestion_key,
          title, detail, priority, basis, actions, source_annotation_ids, signature,
          invalidated_reason, invalidated_at, created_at)
       VALUES (?,?,?,?, 'active', ?,?,?,?,?,?,?,?,?, NULL, NULL, ?)`,
    );
    const updateOne = db.prepare(
      `UPDATE composition_suggestion
         SET title = ?, detail = ?, priority = ?, basis = ?, actions = ?,
             source_annotation_ids = ?, signature = ?
       WHERE id = ?`,
    );
    for (const s of suggestions) {
      const existing = findActive.get(asset.id, s.key) as { id: string } | undefined;
      if (existing) {
        updateOne.run(
          s.title,
          s.detail,
          s.priority,
          toJson(s.basis),
          toJson(s.actions),
          toJson(s.sourceAnnotationIds),
          signature,
          existing.id,
        );
      } else {
        insertOne.run(
          newId(),
          asset.library_id,
          asset.id,
          asset.inspiration_id,
          s.ruleCode,
          s.key,
          s.title,
          s.detail,
          s.priority,
          toJson(s.basis),
          toJson(s.actions),
          toJson(s.sourceAnnotationIds),
          signature,
          ts,
        );
      }
    }
    // 引擎现在不再产出的旧 active 规则（例如删了某条标注）也要失效
    if (suggestions.length) {
      const placeholders = suggestions.map(() => '?').join(',');
      db.prepare(
        `UPDATE composition_suggestion
           SET status = 'invalidated', invalidated_reason = 'annotations_replaced', invalidated_at = ?
         WHERE asset_id = ? AND status = 'active' AND suggestion_key NOT IN (${placeholders})`,
      ).run(ts, asset.id, ...suggestions.map((s) => s.key));
    } else {
      db.prepare(
        `UPDATE composition_suggestion
           SET status = 'invalidated', invalidated_reason = 'annotations_replaced', invalidated_at = ?
         WHERE asset_id = ? AND status = 'active'`,
      ).run(ts, asset.id);
    }
  });
  persist();

  return {
    generated: suggestions.length,
    signature,
    items: listSuggestionsForAsset(asset.id),
  };
}

export function listSuggestionsForAsset(assetId: string, status: 'all' | 'active' = 'all'): CompositionSuggestionDto[] {
  const sql =
    status === 'active'
      ? `SELECT * FROM composition_suggestion WHERE asset_id = ? AND status = 'active' ORDER BY created_at`
      : `SELECT * FROM composition_suggestion
           WHERE asset_id = ?
           ORDER BY CASE status WHEN 'active' THEN 0 ELSE 1 END, created_at DESC`;
  const rows = getDb().prepare(sql).all(assetId) as Record<string, unknown>[];
  return rows.map(toDto);
}

export function listSuggestionsForInspiration(inspirationId: string): CompositionSuggestionDto[] {
  const rows = getDb()
    .prepare(
      `SELECT * FROM composition_suggestion
        WHERE inspiration_id = ?
        ORDER BY CASE status WHEN 'active' THEN 0 ELSE 1 END, created_at DESC
        LIMIT 200`,
    )
    .all(inspirationId) as Record<string, unknown>[];
  return rows.map(toDto);
}
