import type { AnnotationKind } from './enums.js';
import { CompositionAdviceKind } from './enums.js';
import { bearingFromArrow, expectedAzimuth, angleDiff, type Point, type Rect } from './geometry.js';

export interface CompositionAnnotationInput {
  id: string;
  kind: AnnotationKind;
  geometry: Record<string, unknown>;
  label?: string | null;
}

export interface CompositionAdviceInput {
  annotations: CompositionAnnotationInput[];
  /** 机位朝向（未绑定机位时为 null，此时光位箭头只能给出相对建议） */
  cameraBearingDeg: number | null;
  /** 素材真实宽高比（宽/高），用于把归一化取景框换算成实际构图比例 */
  imageAspect?: number | null;
  /** 估算用的水平视场角，默认 54°（约 35mm 等效） */
  horizontalFovDeg?: number;
}

export interface CompositionAdviceReason {
  code: string;
  level: 'ok' | 'warn' | 'bad' | 'info';
  text: string;
}

export interface CompositionAdviceBasis {
  annotationIds: string[];
  kinds: AnnotationKind[];
  /** 可复算的实测值，例如 "取景框中心 (0.62, 0.45)，偏离画面中心 12%" */
  notes: string[];
}

export interface DraftCompositionAdvice {
  kind: CompositionAdviceKind;
  summary: string;
  reasons: CompositionAdviceReason[];
  basis: CompositionAdviceBasis;
}

const DEFAULT_H_FOV = 54;
/** 取景框中心偏移超过画面宽/高的 8% 才建议转机位 */
const CENTER_OFFSET_THRESHOLD = 0.08;
/** 取景框占比小于 15% 认为主体太小，大于 80% 认为顶满 */
const FRAME_SMALL_COVERAGE = 0.15;
const FRAME_FULL_COVERAGE = 0.8;
/** 两条光位箭头方向差超过 30° 视为冲突 */
const LIGHT_CONFLICT_DEG = 30;

function fmtPt(p: Point): string {
  return `(${p.x.toFixed(2)}, ${p.y.toFixed(2)})`;
}

function roundDeg(v: number): number {
  return Math.round(((v % 360) + 360) % 360);
}

/** 光位角的口语化描述：0°=顺光，90°=右侧光，180°=逆光，270°=左侧光 */
export function describeLightBearing(bearingDeg: number): string {
  const sectors: [number, string][] = [
    [0, '顺光（正对面光源）'],
    [45, '右前侧光'],
    [90, '右侧光'],
    [135, '右后侧光'],
    [180, '逆光'],
    [225, '左后侧光'],
    [270, '左侧光'],
    [315, '左前侧光'],
  ];
  let best = sectors[0];
  let bestDiff = Infinity;
  for (const s of sectors) {
    const d = angleDiff(bearingDeg, s[0]);
    if (d < bestDiff) {
      bestDiff = d;
      best = s;
    }
  }
  return `${best[1]}（光位角 ${Math.round(bearingDeg)}°）`;
}

function readArrowBearing(a: CompositionAnnotationInput): number | null {
  const g = a.geometry as { from?: Point; to?: Point; bearingDeg?: number };
  if (typeof g.bearingDeg === 'number' && Number.isFinite(g.bearingDeg)) return g.bearingDeg;
  if (g.from && g.to) return bearingFromArrow(g.from, g.to);
  return null;
}

function readRect(a: CompositionAnnotationInput): Rect | null {
  const rect = (a.geometry as { rect?: Rect }).rect;
  if (!rect || !(rect.w > 0) || !(rect.h > 0)) return null;
  return rect;
}

function readPoints(a: CompositionAnnotationInput): Point[] {
  const pts = (a.geometry as { points?: Point[] }).points;
  return Array.isArray(pts) ? pts : [];
}

/** 三分点坐标 */
const THIRDS = [1 / 3, 2 / 3];

function nearestThirdsAnchor(p: Point): Point {
  const pick = (v: number) => (Math.abs(v - THIRDS[0]) <= Math.abs(v - THIRDS[1]) ? THIRDS[0] : THIRDS[1]);
  return { x: pick(p.x), y: pick(p.y) };
}

/**
 * 构图辅助核心：由标注箭头 / 取景框 / 主体线生成机位建议（纯函数，可复算）。
 * 每条建议都带 basis（用了哪些标注、实测值是多少），素材重标后由服务端统一置为失效。
 */
export function buildCompositionAdvice(input: CompositionAdviceInput): DraftCompositionAdvice[] {
  const fov = input.horizontalFovDeg && input.horizontalFovDeg > 0 ? input.horizontalFovDeg : DEFAULT_H_FOV;
  const vfov = input.imageAspect && input.imageAspect > 0 ? fov / input.imageAspect : fov * (2 / 3);
  const out: DraftCompositionAdvice[] = [];

  const arrows = input.annotations.filter((a) => a.kind === 'light_arrow');
  const frames = input.annotations.filter((a) => a.kind === 'frame');
  const lines = input.annotations.filter((a) => a.kind === 'leading_line');

  // ---------- 标注箭头 → 机位朝向 ----------
  const arrowBearings: { id: string; bearing: number }[] = [];
  for (const arrow of arrows) {
    const bearing = readArrowBearing(arrow);
    if (bearing === null) continue;
    arrowBearings.push({ id: arrow.id, bearing });
    const light = describeLightBearing(bearing);
    if (input.cameraBearingDeg === null) {
      out.push({
        kind: CompositionAdviceKind.keepBearing,
        summary: `这条光是${light}；先给卡片绑定机位朝向，才能换算成太阳方位角`,
        reasons: [
          {
            code: 'NO_CAMERA_BEARING',
            level: 'warn',
            text: `光位箭头已读出光位角 ${Math.round(bearing)}°，但灵感卡还没绑定机位，无法推算期望太阳方位角`,
          },
        ],
        basis: {
          annotationIds: [arrow.id],
          kinds: ['light_arrow'],
          notes: [`光位角 ${Math.round(bearing)}°（0°=顺光，90°=右侧光，180°=逆光）`],
        },
      });
    } else {
      const az = expectedAzimuth(input.cameraBearingDeg, bearing);
      out.push({
        kind: CompositionAdviceKind.keepBearing,
        summary: `保持机位朝向 ${roundDeg(input.cameraBearingDeg)}°，等太阳转到方位角 ${roundDeg(az)}°（${light}）`,
        reasons: [
          {
            code: 'EXPECTED_AZIMUTH',
            level: 'ok',
            text: `机位朝向 ${roundDeg(input.cameraBearingDeg)}° + 光位角 ${Math.round(bearing)}° ⇒ 期望太阳方位角 ${roundDeg(az)}°`,
          },
          {
            code: 'KEEP_BEARING',
            level: 'info',
            text: '机位朝向不要变，否则光位关系会跟着变；要改朝向就得重画光位箭头',
          },
        ],
        basis: {
          annotationIds: [arrow.id],
          kinds: ['light_arrow'],
          notes: [
            `光位角 ${Math.round(bearing)}° = ${light}`,
            `期望太阳方位角 ${roundDeg(az)}°（按当前机位朝向 ${roundDeg(input.cameraBearingDeg)}° 推算）`,
          ],
        },
      });
    }
  }
  if (arrowBearings.length >= 2) {
    let maxDiff = 0;
    for (let i = 0; i < arrowBearings.length; i += 1) {
      for (let j = i + 1; j < arrowBearings.length; j += 1) {
        maxDiff = Math.max(maxDiff, angleDiff(arrowBearings[i].bearing, arrowBearings[j].bearing));
      }
    }
    if (maxDiff > LIGHT_CONFLICT_DEG) {
      out.push({
        kind: CompositionAdviceKind.checkConflict,
        summary: `${arrowBearings.length} 条光位箭头方向相差 ${Math.round(maxDiff)}°，先确认哪条是主光`,
        reasons: [
          {
            code: 'LIGHT_CONFLICT',
            level: 'warn',
            text: `主光方向不一致（最大相差 ${Math.round(maxDiff)}°，阈值 ${LIGHT_CONFLICT_DEG}°），按相互矛盾的箭头踩机位会两头落空`,
          },
        ],
        basis: {
          annotationIds: arrowBearings.map((a) => a.id),
          kinds: ['light_arrow'],
          notes: arrowBearings.map((a, i) => `箭头 ${i + 1} 光位角 ${Math.round(a.bearing)}°`),
        },
      });
    }
  }

  // ---------- 取景框 → 机位移动 / 画幅 ----------
  for (const frame of frames) {
    const rect = readRect(frame);
    if (!rect) continue;
    const cx = rect.x + rect.w / 2;
    const cy = rect.y + rect.h / 2;
    const dx = cx - 0.5;
    const dy = cy - 0.5;
    const basisNotes = [
      `取景框中心 ${fmtPt({ x: cx, y: cy })}，画面中心 (0.50, 0.50)`,
      `偏移量 水平 ${(dx * 100).toFixed(0)}%、垂直 ${(dy * 100).toFixed(0)}%（按水平视场 ${fov}° 估算）`,
    ];

    if (Math.abs(dx) > CENTER_OFFSET_THRESHOLD) {
      const yawDeg = Math.abs(dx) * fov;
      const dir = dx > 0 ? '右' : '左';
      const target =
        input.cameraBearingDeg === null
          ? null
          : roundDeg(input.cameraBearingDeg + (dx > 0 ? yawDeg : -yawDeg));
      out.push({
        kind: CompositionAdviceKind.shiftCamera,
        summary: `取景框中心偏${dir} ${(Math.abs(dx) * 100).toFixed(0)}%，机位向${dir}转约 ${yawDeg.toFixed(0)}°${
          target === null ? '' : `（朝向约 ${target}°）`
        }`,
        reasons: [
          {
            code: 'FRAME_OFF_CENTER_X',
            level: 'info',
            text: `取景框中心水平偏移 ${(dx * 100).toFixed(0)}% × 水平视场 ${fov}° ≈ 需转 ${yawDeg.toFixed(0)}°`,
          },
          ...(target === null
            ? [{ code: 'NO_CAMERA_BEARING', level: 'warn' as const, text: '未绑定机位朝向，给不出目标朝向角' }]
            : [
                {
                  code: 'TARGET_BEARING',
                  level: 'ok' as const,
                  text: `当前朝向 ${roundDeg(input.cameraBearingDeg!)}° → 目标朝向约 ${target}°`,
                },
              ]),
        ],
        basis: { annotationIds: [frame.id], kinds: ['frame'], notes: basisNotes },
      });
    }
    if (Math.abs(dy) > CENTER_OFFSET_THRESHOLD) {
      const pitchDeg = Math.abs(dy) * vfov;
      const dir = dy > 0 ? '压低镜头（构图偏下）' : '抬高镜头（构图偏上）';
      out.push({
        kind: CompositionAdviceKind.shiftCamera,
        summary: `取景框中心偏${dy > 0 ? '下' : '上'} ${(Math.abs(dy) * 100).toFixed(0)}%，${dir}约 ${pitchDeg.toFixed(0)}°`,
        reasons: [
          {
            code: 'FRAME_OFF_CENTER_Y',
            level: 'info',
            text: `取景框中心垂直偏移 ${(dy * 100).toFixed(0)}% × 垂直视场约 ${vfov.toFixed(0)}° ≈ 俯仰调整 ${pitchDeg.toFixed(0)}°`,
          },
        ],
        basis: { annotationIds: [frame.id], kinds: ['frame'], notes: basisNotes },
      });
    }

    const coverage = rect.w * rect.h;
    if (coverage < FRAME_SMALL_COVERAGE) {
      out.push({
        kind: CompositionAdviceKind.adjustFraming,
        summary: `取景框只占画面 ${(coverage * 100).toFixed(0)}%，主体太小：机位向主体靠近，或换更长焦段`,
        reasons: [
          {
            code: 'FRAME_TOO_SMALL',
            level: 'info',
            text: `取景框占比 ${(coverage * 100).toFixed(0)}%（低于 ${FRAME_SMALL_COVERAGE * 100}%），原地拍主体会没有存在感`,
          },
        ],
        basis: {
          annotationIds: [frame.id],
          kinds: ['frame'],
          notes: [...basisNotes, `取景框尺寸 ${(rect.w * 100).toFixed(0)}% × ${(rect.h * 100).toFixed(0)}%`],
        },
      });
    } else if (coverage > FRAME_FULL_COVERAGE) {
      out.push({
        kind: CompositionAdviceKind.adjustFraming,
        summary: `取景框占画面 ${(coverage * 100).toFixed(0)}%，几乎顶满：机位后退半步，给主体留呼吸空间`,
        reasons: [
          {
            code: 'FRAME_TOO_FULL',
            level: 'info',
            text: `取景框占比 ${(coverage * 100).toFixed(0)}%（超过 ${FRAME_FULL_COVERAGE * 100}%），边缘没有留白`,
          },
        ],
        basis: {
          annotationIds: [frame.id],
          kinds: ['frame'],
          notes: [...basisNotes, `取景框尺寸 ${(rect.w * 100).toFixed(0)}% × ${(rect.h * 100).toFixed(0)}%`],
        },
      });
    }

    if (input.imageAspect && input.imageAspect > 0) {
      const frameAspect = (rect.w * input.imageAspect) / rect.h;
      if (frameAspect <= 0.8 && input.imageAspect > 1) {
        out.push({
          kind: CompositionAdviceKind.adjustFraming,
          summary: `取景框是竖构图（宽高比约 1:${(1 / frameAspect).toFixed(1)}），素材是横幅：建议竖拍，或按竖幅裁切`,
          reasons: [
            {
              code: 'FRAME_ASPECT_PORTRAIT',
              level: 'info',
              text: `取景框实际宽高比 ${frameAspect.toFixed(2)}（竖幅），素材宽高比 ${input.imageAspect.toFixed(2)}（横幅）`,
            },
          ],
          basis: { annotationIds: [frame.id], kinds: ['frame'], notes: basisNotes },
        });
      } else if (frameAspect >= 1.25 && input.imageAspect < 1) {
        out.push({
          kind: CompositionAdviceKind.adjustFraming,
          summary: `取景框是横构图（宽高比约 ${frameAspect.toFixed(1)}:1），素材是竖幅：建议横拍，或按横幅裁切`,
          reasons: [
            {
              code: 'FRAME_ASPECT_LANDSCAPE',
              level: 'info',
              text: `取景框实际宽高比 ${frameAspect.toFixed(2)}（横幅），素材宽高比 ${input.imageAspect.toFixed(2)}（竖幅）`,
            },
          ],
          basis: { annotationIds: [frame.id], kinds: ['frame'], notes: basisNotes },
        });
      }
    }
  }

  // ---------- 主体线 → 机位微调 ----------
  for (const line of lines) {
    const pts = readPoints(line);
    if (pts.length < 2) continue;
    const start = pts[0];
    const end = pts[pts.length - 1];
    const anchor = nearestThirdsAnchor(end);
    const offX = anchor.x - end.x;
    const offY = anchor.y - end.y;
    const yawDeg = Math.abs(offX) * fov;
    const basisNotes = [
      `主体线 ${fmtPt(start)} → ${fmtPt(end)}（终点通常压着主体）`,
      `最近的三分点 ${fmtPt(anchor)}，汇聚点距它水平 ${(Math.abs(offX) * 100).toFixed(0)}%、垂直 ${(Math.abs(offY) * 100).toFixed(0)}%`,
    ];

    if (yawDeg > 3) {
      const dir = offX > 0 ? '右' : '左';
      const target =
        input.cameraBearingDeg === null
          ? null
          : roundDeg(input.cameraBearingDeg + (offX > 0 ? yawDeg : -yawDeg));
      out.push({
        kind: CompositionAdviceKind.shiftCamera,
        summary: `主体线汇聚于 ${fmtPt(end)}，机位向${dir}微调约 ${yawDeg.toFixed(0)}°${
          target === null ? '' : `（朝向约 ${target}°）`
        }，让汇聚点落上三分点`,
        reasons: [
          {
            code: 'LINE_OFF_THIRDS',
            level: 'info',
            text: `汇聚点偏${dir} ${(Math.abs(offX) * 100).toFixed(0)}% × 水平视场 ${fov}° ≈ 微调 ${yawDeg.toFixed(0)}°`,
          },
          ...(target === null
            ? [{ code: 'NO_CAMERA_BEARING', level: 'warn' as const, text: '未绑定机位朝向，给不出目标朝向角' }]
            : [
                {
                  code: 'TARGET_BEARING',
                  level: 'ok' as const,
                  text: `当前朝向 ${roundDeg(input.cameraBearingDeg!)}° → 目标朝向约 ${target}°`,
                },
              ]),
        ],
        basis: { annotationIds: [line.id], kinds: ['leading_line'], notes: basisNotes },
      });
    }

    const lineDy = Math.abs(end.y - start.y);
    const lineDx = Math.abs(end.x - start.x);
    if (lineDx > 0.2 && lineDy < 0.05) {
      out.push({
        kind: CompositionAdviceKind.keepBearing,
        summary: '主体线近似水平，机位保持水平、别俯仰，否则线条会斜',
        reasons: [
          {
            code: 'LINE_HORIZONTAL',
            level: 'info',
            text: `主体线水平跨度 ${(lineDx * 100).toFixed(0)}%、垂直落差仅 ${(lineDy * 100).toFixed(0)}%`,
          },
        ],
        basis: { annotationIds: [line.id], kinds: ['leading_line'], notes: basisNotes },
      });
    }
  }

  return out;
}
