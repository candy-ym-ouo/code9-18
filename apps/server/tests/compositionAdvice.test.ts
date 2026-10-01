import { describe, expect, it } from 'vitest';
import { buildCompositionAdvice, describeLightBearing } from '@flil/shared';

const arrow = (id: string, bearingDeg: number) => ({
  id,
  kind: 'light_arrow' as const,
  geometry: { from: { x: 0.2, y: 0.2 }, to: { x: 0.8, y: 0.6 }, bearingDeg },
});

const frame = (id: string, rect: { x: number; y: number; w: number; h: number }) => ({
  id,
  kind: 'frame' as const,
  geometry: { rect },
});

const line = (id: string, points: { x: number; y: number }[]) => ({
  id,
  kind: 'leading_line' as const,
  geometry: { points },
});

describe('光位角口语化描述', () => {
  it('0°=顺光，90°=右侧光，180°=逆光，270°=左侧光', () => {
    expect(describeLightBearing(0)).toContain('顺光');
    expect(describeLightBearing(90)).toContain('右侧光');
    expect(describeLightBearing(180)).toContain('逆光');
    expect(describeLightBearing(270)).toContain('左侧光');
  });
});

describe('构图辅助：标注箭头 → 机位朝向建议', () => {
  it('有机位朝向时给出期望太阳方位角，且依据可复算', () => {
    const out = buildCompositionAdvice({ annotations: [arrow('a1', 90)], cameraBearingDeg: 265 });
    expect(out).toHaveLength(1);
    expect(out[0].kind).toBe('keep_bearing');
    expect(out[0].summary).toContain('265°');
    // 265 + 90 = 355
    expect(out[0].reasons.some((r) => r.code === 'EXPECTED_AZIMUTH' && r.text.includes('355°'))).toBe(true);
    expect(out[0].basis.annotationIds).toEqual(['a1']);
    expect(out[0].basis.notes.length).toBeGreaterThan(0);
  });

  it('未绑定机位时给相对建议并提示先绑机位', () => {
    const out = buildCompositionAdvice({ annotations: [arrow('a1', 180)], cameraBearingDeg: null });
    expect(out).toHaveLength(1);
    expect(out[0].reasons[0].code).toBe('NO_CAMERA_BEARING');
    expect(out[0].reasons[0].level).toBe('warn');
  });

  it('两条光位箭头方向差超过 30° 时产生冲突提醒', () => {
    const out = buildCompositionAdvice({
      annotations: [arrow('a1', 45), arrow('a2', 200)],
      cameraBearingDeg: 90,
    });
    const conflict = out.find((a) => a.kind === 'check_conflict');
    expect(conflict).toBeTruthy();
    expect(conflict!.basis.annotationIds).toEqual(['a1', 'a2']);
  });

  it('方向差在 30° 以内不算冲突', () => {
    const out = buildCompositionAdvice({
      annotations: [arrow('a1', 80), arrow('a2', 100)],
      cameraBearingDeg: 90,
    });
    expect(out.some((a) => a.kind === 'check_conflict')).toBe(false);
  });
});

describe('构图辅助：取景框 → 机位移动与画幅建议', () => {
  it('取景框偏右 → 机位向右转，并给出目标朝向', () => {
    // 中心 cx = 0.5+0.24/2... 直接构造偏右 20% 的框：x=0.6, w=0.2 → cx=0.7, dx=+0.2
    const out = buildCompositionAdvice({
      annotations: [frame('f1', { x: 0.6, y: 0.3, w: 0.2, h: 0.4 })],
      cameraBearingDeg: 100,
      imageAspect: 16 / 9,
    });
    const shift = out.find((a) => a.kind === 'shift_camera' && a.reasons.some((r) => r.code === 'FRAME_OFF_CENTER_X'));
    expect(shift).toBeTruthy();
    expect(shift!.summary).toContain('向右转');
    // 0.2 × 54° ≈ 11° → 目标朝向 111°
    expect(shift!.summary).toContain('111°');
    expect(shift!.basis.notes.join('')).toContain('0.70');
  });

  it('取景框占比过小 → 建议靠近或换长焦', () => {
    const out = buildCompositionAdvice({
      annotations: [frame('f1', { x: 0.4, y: 0.4, w: 0.2, h: 0.2 })],
      cameraBearingDeg: 0,
    });
    const small = out.find((a) => a.kind === 'adjust_framing');
    expect(small).toBeTruthy();
    expect(small!.reasons[0].code).toBe('FRAME_TOO_SMALL');
  });

  it('横幅素材里的竖取景框 → 建议竖拍', () => {
    const out = buildCompositionAdvice({
      annotations: [frame('f1', { x: 0.3, y: 0.1, w: 0.3, h: 0.8 })],
      cameraBearingDeg: 0,
      imageAspect: 16 / 9,
    });
    const aspect = out.find((a) => a.reasons.some((r) => r.code === 'FRAME_ASPECT_PORTRAIT'));
    expect(aspect).toBeTruthy();
    expect(aspect!.summary).toContain('竖拍');
  });

  it('取景框居中且占比正常 → 不产生移动/画幅建议', () => {
    const out = buildCompositionAdvice({
      annotations: [frame('f1', { x: 0.25, y: 0.2, w: 0.5, h: 0.6 })],
      cameraBearingDeg: 0,
      imageAspect: 3 / 2,
    });
    expect(out).toHaveLength(0);
  });
});

describe('构图辅助：主体线 → 机位微调建议', () => {
  it('汇聚点偏离三分点 → 建议微调并给出目标朝向', () => {
    // 终点在画面正中心 (0.5, 0.5)，最近三分点 (2/3, 2/3) → offX ≈ +0.167 → 右移 9°
    const out = buildCompositionAdvice({
      annotations: [line('l1', [{ x: 0.1, y: 0.9 }, { x: 0.5, y: 0.5 }])],
      cameraBearingDeg: 200,
      imageAspect: 3 / 2,
    });
    const tweak = out.find((a) => a.kind === 'shift_camera');
    expect(tweak).toBeTruthy();
    expect(tweak!.summary).toContain('向右微调');
    expect(tweak!.basis.kinds).toEqual(['leading_line']);
  });

  it('汇聚点已在三分点附近 → 不给微调建议', () => {
    const out = buildCompositionAdvice({
      annotations: [line('l1', [{ x: 0.1, y: 0.9 }, { x: 0.667, y: 0.667 }])],
      cameraBearingDeg: 200,
    });
    expect(out.some((a) => a.kind === 'shift_camera')).toBe(false);
  });

  it('近似水平的主体线 → 提醒保持机位水平', () => {
    const out = buildCompositionAdvice({
      annotations: [line('l1', [{ x: 0.1, y: 0.5 }, { x: 0.9, y: 0.52 }])],
      cameraBearingDeg: 0,
    });
    expect(out.some((a) => a.reasons.some((r) => r.code === 'LINE_HORIZONTAL'))).toBe(true);
  });
});

describe('构图辅助：边界情况', () => {
  it('没有标注 → 没有建议', () => {
    expect(buildCompositionAdvice({ annotations: [], cameraBearingDeg: 90 })).toHaveLength(0);
  });

  it('只有三分点/留白标注 → 不产生建议（只认箭头/取景框/主体线）', () => {
    const out = buildCompositionAdvice({
      annotations: [
        { id: 'r1', kind: 'rule_of_thirds', geometry: { points: [{ x: 0.33, y: 0.33 }] } },
        { id: 'n1', kind: 'negative_space', geometry: { rect: { x: 0.1, y: 0.1, w: 0.3, h: 0.3 } } },
      ],
      cameraBearingDeg: 90,
    });
    expect(out).toHaveLength(0);
  });

  it('三类标注组合时各自产出建议，依据互不串扰', () => {
    const out = buildCompositionAdvice({
      annotations: [
        arrow('a1', 180),
        frame('f1', { x: 0.6, y: 0.3, w: 0.2, h: 0.4 }),
        line('l1', [{ x: 0.1, y: 0.9 }, { x: 0.5, y: 0.5 }]),
      ],
      cameraBearingDeg: 90,
      imageAspect: 3 / 2,
    });
    const kinds = out.map((a) => a.kind);
    expect(kinds).toContain('keep_bearing');
    expect(kinds).toContain('shift_camera');
    for (const advice of out) {
      expect(advice.basis.annotationIds.length).toBeGreaterThan(0);
      expect(advice.reasons.length).toBeGreaterThan(0);
    }
  });
});
