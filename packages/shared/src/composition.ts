import { angleDiff, bearingFromArrow, expectedAzimuth } from './geometry.js';
import type { Point, Rect } from './geometry.js';

/**
 * 构图辅助引擎（纯函数，无 IO）：
 * 由三类标注 —— 光位箭头 / 取景框 / 主体线（引导线）—— 生成机位建议，
 * 每条建议都带可复算的依据（实际量得值 + 阈值）。
 * 素材删除或覆盖重标后，服务端按 signature 同步失效旧建议，引擎本身无状态。
 */

export type SuggestionPriority = 'tip' | 'info' | 'warn';

export interface EngineAnnotation {
  id?: string | null;
  kind: string;
  geometry: Record<string, unknown>;
  label?: string | null;
}

export interface SuggestionBasis {
  code: string;
  text: string;
  values?: Record<string, number | string>;
}

export interface SuggestionAction {
  kind: string;
  label: string;
  payload?: Record<string, unknown>;
}

export interface CompositionSuggestion {
  /** 同一条规则在同一标注上的稳定标识，重生成用于去重 */
  key: string;
  ruleCode: string;
  title: string;
  detail: string;
  priority: SuggestionPriority;
  basis: SuggestionBasis[];
  actions: SuggestionAction[];
  sourceAnnotationIds: string[];
}

const r1 = (n: number): number => Math.round(n * 10) / 10;
const r2 = (n: number): number => Math.round(n * 100) / 100;

const THIRDS = [1 / 3, 2 / 3];

function nearestThirdsPoint(p: Point): { x: number; y: number; dist: number } {
  let best = { x: THIRDS[0], y: THIRDS[0], dist: Infinity };
  for (const x of THIRDS) {
    for (const y of THIRDS) {
      const dist = Math.hypot(p.x - x, p.y - y);
      if (dist < best.dist) best = { x, y, dist };
    }
  }
  return best;
}

/** 点到画面最近一条边的归一化距离 */
function edgeDistance(p: Point): number {
  return Math.min(p.x, 1 - p.x, p.y, 1 - p.y);
}

function asPoint(v: unknown): Point | null {
  if (!v || typeof v !== 'object') return null;
  const { x, y } = v as Point;
  if (typeof x !== 'number' || typeof y !== 'number') return null;
  return { x, y };
}

function arrowBearing(geometry: Record<string, unknown>): number | null {
  if (typeof geometry.bearingDeg === 'number' && Number.isFinite(geometry.bearingDeg)) {
    return ((geometry.bearingDeg % 360) + 360) % 360;
  }
  const from = asPoint(geometry.from);
  const to = asPoint(geometry.to);
  if (!from || !to) return null;
  return bearingFromArrow(from, to);
}

// ----------------------------------------------------------- 光位箭头

function suggestionsFromLightArrow(
  ann: EngineAnnotation,
  suffix: string,
  cameraBearing: number | null,
): CompositionSuggestion[] {
  const bearing = arrowBearing(ann.geometry);
  if (bearing === null) return [];
  const out: CompositionSuggestion[] = [];
  const ids = ann.id ? [ann.id] : [];

  if (cameraBearing !== null) {
    const azimuth = expectedAzimuth(cameraBearing, bearing);
    out.push({
      key: `light_direction:${suffix}`,
      ruleCode: 'light_direction',
      title: `光位箭头：对朝 ${r1(cameraBearing)}° 时，等太阳走到方位角约 ${r1(azimuth)}°`,
      detail:
        '箭头量得光源相对机位的光位角（0°=顺光，90°=光从右来，180°=逆光）；' +
        '需复现的太阳方位角 = 机位朝向 + 光位角。可在拍摄条件里以此设置方位角约束。',
      priority: 'info',
      basis: [
        { code: 'light_bearing', text: `光位角 ${r1(bearing)}°（由画面箭头几何量得）`, values: { lightBearing: r1(bearing) } },
        { code: 'camera_bearing', text: `当前机位朝向 ${r1(cameraBearing)}°`, values: { cameraBearing: r1(cameraBearing) } },
        { code: 'expected_azimuth', text: `期望太阳方位角 ${r1(cameraBearing)}° + ${r1(bearing)}° ≈ ${r1(azimuth)}°`, values: { expectedAzimuth: r1(azimuth) } },
      ],
      actions: [{ kind: 'use_expected_azimuth', label: '用作拍摄条件的方位角约束', payload: { expectedAzimuth: r1(azimuth) } }],
      sourceAnnotationIds: ids,
    });
  } else {
    out.push({
      key: `light_direction:${suffix}`,
      ruleCode: 'light_direction',
      title: `光位箭头：光源相对机位约 ${r1(bearing)}°`,
      detail: '该卡尚未绑定机位（无机位朝向），只能得到相对光位角；绑定机位后可换算成可复算的太阳方位角窗口。',
      priority: 'tip',
      basis: [
        { code: 'light_bearing', text: `光位角 ${r1(bearing)}°（由画面箭头几何量得；0°=顺光，180°=逆光）`, values: { lightBearing: r1(bearing) } },
      ],
      actions: [{ kind: 'bind_spot', label: '去绑定机位' }],
      sourceAnnotationIds: ids,
    });
  }

  const backlightDiff = angleDiff(bearing, 180);
  if (backlightDiff <= 20) {
    out.push({
      key: `light_backlight:${suffix}`,
      ruleCode: 'light_backlight',
      title: `逆光机位（光位角 ${r1(bearing)}°）：提防眩光与剪影`,
      detail: '光源几乎正对镜头：主体易压成剪影、镜头易起雾眩光。建议点测光或包围曝光，黄金时刻光比更柔和，并准备遮光罩。',
      priority: 'warn',
      basis: [
        {
          code: 'backlight_diff',
          text: `光位角与 180° 只差 ${r1(backlightDiff)}°（阈值 20°）`,
          values: { lightBearing: r1(bearing), diffTo180: r1(backlightDiff), threshold: 20 },
        },
      ],
      actions: [],
      sourceAnnotationIds: ids,
    });
  }

  const fromRight = bearing >= 60 && bearing <= 120;
  const fromLeft = bearing >= 240 && bearing <= 300;
  if (fromRight || fromLeft) {
    out.push({
      key: `light_side:${suffix}`,
      ruleCode: 'light_side',
      title: `侧光机位（光位角 ${r1(bearing)}°）：适合刻画纹理与立体感`,
      detail: `光从画面${fromRight ? '右' : '左'}侧约 90° 方向来，建筑表面与引导线的明暗层次最强；机位左右平移十几米即可微调光比。`,
      priority: 'tip',
      basis: [
        {
          code: 'side_range',
          text: `光位角 ${r1(bearing)}° 落在侧光区间 60°–120° / 240°–300°`,
          values: { lightBearing: r1(bearing) },
        },
      ],
      actions: [],
      sourceAnnotationIds: ids,
    });
  }

  return out;
}

// ----------------------------------------------------------- 取景框

function suggestionsFromFrame(ann: EngineAnnotation, suffix: string): CompositionSuggestion[] {
  const rect = (ann.geometry.rect ?? null) as Rect | null;
  if (!rect) return [];
  const out: CompositionSuggestion[] = [];
  const ids = ann.id ? [ann.id] : [];

  const center: Point = { x: rect.x + rect.w / 2, y: rect.y + rect.h / 2 };
  const near = nearestThirdsPoint(center);
  if (near.dist > 0.08) {
    const dirH = center.x < near.x - 0.02 ? '右' : center.x > near.x + 0.02 ? '左' : '';
    const dirV = center.y < near.y - 0.02 ? '下' : center.y > near.y + 0.02 ? '上' : '';
    const move = [dirH && `向画面${dirH}`, dirV && `向画面${dirV}`].filter(Boolean).join('、');
    out.push({
      key: `frame_subject_thirds:${suffix}`,
      ruleCode: 'frame_subject_thirds',
      title: `取景框主体偏离三分线交点 ${r2(near.dist)}（归一化距离）`,
      detail:
        `框内主体中心 (${r2(center.x)}, ${r2(center.y)})，最近的三分线交点为 (${r2(near.x)}, ${r2(near.y)})。` +
        (move ? `微调站位或机位朝向，让主体${move}落到该交点附近；` : '微调机位把主体带到该交点；') +
        '若主体本就居中表意，可忽略本条。',
      priority: 'tip',
      basis: [
        {
          code: 'thirds_offset',
          text: `中心到最近三分线交点距离 ${r2(near.dist)}，超过阈值 0.08`,
          values: { centerX: r2(center.x), centerY: r2(center.y), thirdsX: r2(near.x), thirdsY: r2(near.y), offset: r2(near.dist), threshold: 0.08 },
        },
      ],
      actions: [],
      sourceAnnotationIds: ids,
    });
  }

  const area = rect.w * rect.h;
  if (area < 0.12) {
    out.push({
      key: `frame_subject_scale:${suffix}`,
      ruleCode: 'frame_subject_scale',
      title: `框架内主体仅占画面 ${r1(area * 100)}%，结构偏弱`,
      detail: '取景框面积占比过小，"框中框"结构在成片里会读不出来：靠近主体或换更长焦段，让框沿与画面边缘形成明确层次。',
      priority: 'tip',
      basis: [
        { code: 'frame_area', text: `框面积占比 ${r1(area * 100)}%（宽 ${r2(rect.w)} × 高 ${r2(rect.h)}），低于阈值 12%`, values: { areaPct: r1(area * 100), thresholdPct: 12 } },
      ],
      actions: [],
      sourceAnnotationIds: ids,
    });
  } else if (area > 0.72) {
    out.push({
      key: `frame_subject_scale:${suffix}`,
      ruleCode: 'frame_subject_scale',
      title: `框架撑满画面 ${r1(area * 100)}%，缺少呼吸感`,
      detail: '取景框几乎贴满画面，框架的"隔层"效果消失：后退半步或换更广焦段，给框外沿留出环境，观众视线才会被框引导进去。',
      priority: 'tip',
      basis: [
        { code: 'frame_area', text: `框面积占比 ${r1(area * 100)}%（宽 ${r2(rect.w)} × 高 ${r2(rect.h)}），高于阈值 72%`, values: { areaPct: r1(area * 100), thresholdPct: 72 } },
      ],
      actions: [],
      sourceAnnotationIds: ids,
    });
  }

  return out;
}

// ----------------------------------------------------------- 主体线（引导线）

function suggestionsFromLeadingLine(ann: EngineAnnotation, suffix: string): CompositionSuggestion[] {
  const rawPoints = Array.isArray(ann.geometry.points) ? (ann.geometry.points as unknown[]) : [];
  const points = rawPoints.map(asPoint).filter((p): p is Point => p !== null);
  if (points.length < 2) return [];
  const out: CompositionSuggestion[] = [];
  const ids = ann.id ? [ann.id] : [];

  const start = points[0];
  const end = points[points.length - 1];
  const near = nearestThirdsPoint(end);
  if (near.dist > 0.1) {
    out.push({
      key: `line_vanishing_thirds:${suffix}`,
      ruleCode: 'line_vanishing_thirds',
      title: `主体线收束点偏离三分线交点 ${r2(near.dist)}`,
      detail:
        `线条末端 (${r2(end.x)}, ${r2(end.y)}) 应收束到最近交点 (${r2(near.x)}, ${r2(near.y)})：` +
        '平移机位或微调朝向，把消失点压在交点上，视线引导最稳。',
      priority: 'tip',
      basis: [
        {
          code: 'vanishing_offset',
          text: `末端到最近三分线交点距离 ${r2(near.dist)}，超过阈值 0.10`,
          values: { endX: r2(end.x), endY: r2(end.y), thirdsX: r2(near.x), thirdsY: r2(near.y), offset: r2(near.dist), threshold: 0.1 },
        },
      ],
      actions: [],
      sourceAnnotationIds: ids,
    });
  }

  const entry = edgeDistance(start);
  if (entry > 0.08) {
    out.push({
      key: `line_entry:${suffix}`,
      ruleCode: 'line_entry',
      title: '主体线没有从画面边缘切进来',
      detail: '引导线起点悬在画面内部，纵深感被截断：后退或降低机位，让线条从边角/边缘进入，把观众视线从画外带向主体。',
      priority: 'tip',
      basis: [
        {
          code: 'entry_edge_gap',
          text: `起点 (${r2(start.x)}, ${r2(start.y)}) 距最近画面边缘 ${r2(entry)}，大于阈值 0.08`,
          values: { startX: r2(start.x), startY: r2(start.y), edgeGap: r2(entry), threshold: 0.08 },
        },
      ],
      actions: [],
      sourceAnnotationIds: ids,
    });
  }

  const dx = end.x - start.x;
  const dy = end.y - start.y;
  let pose: { title: string; detail: string } | null = null;
  const angleDeg = (Math.atan2(dy, dx) * 180) / Math.PI;
  if (Math.abs(dx) >= 0.22 && Math.abs(dy) >= 0.22) {
    pose = {
      title: '主体线呈对角走向：低角度贴近起点强化纵深',
      detail: '线条在画面两个方向都有足够跨度，机位贴近起点一侧、压低视角可进一步放大对角动势。',
    };
  } else if (Math.abs(dx) < 0.12 && Math.abs(dy) > 0.22) {
    pose = {
      title: '主体线接近竖直：机位正对走向并保持水平',
      detail: '纵向线条对相机倾斜极敏感，机位正对线条走向、保持水平，避免线条在画面里"倒掉"。',
    };
  } else if (Math.abs(dy) < 0.12 && Math.abs(dx) > 0.22) {
    pose = {
      title: '主体线接近横平：机位水平横移取齐，避免仰俯',
      detail: '横向线条要稳：保持机位水平，沿线条方向横向平移选取最整齐的一段入画。',
    };
  }
  if (pose) {
    out.push({
      key: `line_pose:${suffix}`,
      ruleCode: 'line_pose',
      title: pose.title,
      detail: pose.detail,
      priority: 'tip',
      basis: [
        {
          code: 'line_angle',
          text: `起点→末端水平位移 ${r2(dx)}、垂直位移 ${r2(dy)}，画面角约 ${r1(angleDeg)}°`,
          values: { dx: r2(dx), dy: r2(dy), angleDeg: r1(angleDeg) },
        },
      ],
      actions: [],
      sourceAnnotationIds: ids,
    });
  }

  return out;
}

// --------------------------------------------------------------- 入口

/**
 * 由标注集合生成机位建议。
 * @param annotations 该素材的全部标注（需带持久化 id，用于 key 稳定与来源追溯）
 * @param cameraBearing 关联机位朝向（未绑机位时为 null）
 */
export function generateCompositionSuggestions(params: {
  annotations: EngineAnnotation[];
  cameraBearing?: number | null;
}): CompositionSuggestion[] {
  const { annotations, cameraBearing = null } = params;
  const out: CompositionSuggestion[] = [];
  annotations.forEach((ann, i) => {
    const suffix = ann.id ?? `idx${i}`;
    if (ann.kind === 'light_arrow') {
      out.push(...suggestionsFromLightArrow(ann, suffix, cameraBearing));
    } else if (ann.kind === 'frame') {
      out.push(...suggestionsFromFrame(ann, suffix));
    } else if (ann.kind === 'leading_line') {
      out.push(...suggestionsFromLeadingLine(ann, suffix));
    }
  });
  return out;
}

/** 标注集合 + 机位朝向的稳定签名：内容不变则签名不变，重标即可被识别为失效 */
export function annotationsSignature(annotations: EngineAnnotation[], cameraBearing: number | null = null): string {
  const canonical = JSON.stringify({
    v: 1,
    cameraBearing: cameraBearing === null ? null : r1(cameraBearing),
    annotations: annotations
      .map((a) => ({ kind: a.kind, geometry: a.geometry, label: a.label ?? null }))
      .sort((a, b) => (a.kind === b.kind ? JSON.stringify(a.geometry).localeCompare(JSON.stringify(b.geometry)) : a.kind.localeCompare(b.kind))),
  });
  // djb2 → 16 进制
  let hash = 5381;
  for (let i = 0; i < canonical.length; i += 1) {
    hash = ((hash << 5) + hash + canonical.charCodeAt(i)) | 0;
  }
  return (hash >>> 0).toString(16).padStart(8, '0');
}
