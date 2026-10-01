import { describe, expect, it } from 'vitest';
import {
  annotationsSignature,
  generateCompositionSuggestions,
  type EngineAnnotation,
} from '@flil/shared';

const lightArrow = (id: string, from = { x: 0.8, y: 0.5 }, to = { x: 0.2, y: 0.5 }): EngineAnnotation => ({
  id,
  kind: 'light_arrow',
  geometry: { from, to, bearingDeg: 270 },
});

describe('构图辅助：光位箭头 → 机位建议', () => {
  it('有相机朝向时给出期望太阳方位角，并逐条列出可复算依据', () => {
    const items = generateCompositionSuggestions({ annotations: [lightArrow('a1')], cameraBearing: 265 });
    const direction = items.find((s) => s.ruleCode === 'light_direction');
    expect(direction).toBeTruthy();
    expect(direction!.basis.map((b) => b.code)).toEqual([
      'light_bearing',
      'camera_bearing',
      'expected_azimuth',
    ]);
    // 265 + 270 = 535 → 175
    expect(direction!.basis.find((b) => b.code === 'expected_azimuth')?.values?.expectedAzimuth).toBe(175);
    expect(direction!.actions.some((a) => a.kind === 'use_expected_azimuth')).toBe(true);
  });

  it('未绑机位时提示绑定，而不是凭空给方位角', () => {
    const items = generateCompositionSuggestions({ annotations: [lightArrow('a1')] });
    const direction = items.find((s) => s.ruleCode === 'light_direction');
    expect(direction?.priority).toBe('tip');
    expect(direction?.actions.some((a) => a.kind === 'bind_spot')).toBe(true);
  });

  it('光位角接近 180° 给逆光告警', () => {
    const items = generateCompositionSuggestions({
      annotations: [{ id: 'a2', kind: 'light_arrow', geometry: { bearingDeg: 185 } }],
    });
    const warn = items.find((s) => s.ruleCode === 'light_backlight');
    expect(warn?.priority).toBe('warn');
    expect(warn?.basis[0].values?.diffTo180).toBe(5);
  });

  it('侧光（约 90°/270°）给站位提示', () => {
    const right = generateCompositionSuggestions({
      annotations: [{ id: 'a3', kind: 'light_arrow', geometry: { bearingDeg: 90 } }],
    });
    expect(right.some((s) => s.ruleCode === 'light_side')).toBe(true);
    const left = generateCompositionSuggestions({
      annotations: [{ id: 'a4', kind: 'light_arrow', geometry: { bearingDeg: 270 } }],
    });
    expect(left.some((s) => s.ruleCode === 'light_side')).toBe(true);
  });
});

describe('构图辅助：取景框 → 机位建议', () => {
  it('主体中心偏离三分线交点时给出移动方向与实测偏移量', () => {
    const items = generateCompositionSuggestions({
      annotations: [{ id: 'f1', kind: 'frame', geometry: { rect: { x: 0.05, y: 0.05, w: 0.1, h: 0.1 } } }],
    });
    // 中心 (0.1,0.1) 距最近交点 (0.333,0.333) 约 0.33 > 0.08
    const thirds = items.find((s) => s.ruleCode === 'frame_subject_thirds');
    expect(thirds).toBeTruthy();
    expect(thirds!.title).toContain('偏离三分线交点');
    // 框面积仅 1% → 另有占比过小建议
    expect(items.some((s) => s.ruleCode === 'frame_subject_scale')).toBe(true);
  });

  it('框居中且面积适中时不产生构图建议', () => {
    const items = generateCompositionSuggestions({
      // 中心在三分线交点 (1/3,1/3)，面积 14% 落在 12%–72% 区间
      annotations: [{ id: 'f2', kind: 'frame', geometry: { rect: { x: 0.133, y: 0.158, w: 0.4, h: 0.35 } } }],
    });
    expect(items).toHaveLength(0);
  });

  it('框撑满画面时提示后退 / 更广焦段', () => {
    const items = generateCompositionSuggestions({
      annotations: [{ id: 'f3', kind: 'frame', geometry: { rect: { x: 0.02, y: 0.02, w: 0.96, h: 0.96 } } }],
    });
    const scale = items.find((s) => s.ruleCode === 'frame_subject_scale');
    expect(scale?.detail).toContain('后退');
  });
});

describe('构图辅助：主体线（引导线）→ 机位建议', () => {
  it('收束点偏离交点、起点未贴边、对角走向三条规则都能识别', () => {
    const items = generateCompositionSuggestions({
      annotations: [
        {
          id: 'l1',
          kind: 'leading_line',
          geometry: { points: [{ x: 0.5, y: 0.5 }, { x: 0.8, y: 0.2 }] },
        },
      ],
    });
    const codes = items.map((s) => s.ruleCode);
    expect(codes).toContain('line_vanishing_thirds');
    expect(codes).toContain('line_entry');
    expect(codes).toContain('line_pose');
  });

  it('从边缘切向三分线交点的斜向线只给姿态建议', () => {
    const items = generateCompositionSuggestions({
      annotations: [
        {
          id: 'l2',
          kind: 'leading_line',
          // 起点贴左下角，末端接近右上三分线交点
          geometry: { points: [{ x: 0.02, y: 0.98 }, { x: 0.68, y: 0.34 }] },
        },
      ],
    });
    const codes = items.map((s) => s.ruleCode);
    expect(codes).not.toContain('line_entry');
    expect(codes).not.toContain('line_vanishing_thirds');
    expect(codes).toContain('line_pose');
  });
});

describe('构图辅助：标注签名（用于重标失效）', () => {
  it('内容相同（顺序不同）签名一致；改动后签名变化', () => {
    const a = lightArrow('a1');
    const frame: EngineAnnotation = { id: 'f1', kind: 'frame', geometry: { rect: { x: 0.1, y: 0.1, w: 0.3, h: 0.3 } } };
    const s1 = annotationsSignature([a, frame]);
    const s2 = annotationsSignature([frame, a]);
    expect(s1).toBe(s2);

    const changed: EngineAnnotation = {
      ...frame,
      geometry: { rect: { x: 0.1, y: 0.1, w: 0.35, h: 0.35 } },
    };
    expect(annotationsSignature([a, changed])).not.toBe(s1);

    // 相机朝向参与签名：换了机位朝向，依据也应重算
    expect(annotationsSignature([a, frame], 90)).not.toBe(annotationsSignature([a, frame], 180));
  });

  it('建议 key 与标注 id 绑定且规则内稳定（重生成可去重）', () => {
    const items = generateCompositionSuggestions({ annotations: [lightArrow('a1')], cameraBearing: 265 });
    expect(items.length).toBeGreaterThan(0);
    expect(items.every((s) => s.sourceAnnotationIds.includes('a1'))).toBe(true);
    const keys = new Set(items.map((s) => s.key));
    expect(keys.size).toBe(items.length);
    expect(items[0].key).toContain('a1');
  });
});
