import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Express } from 'express';
import request from 'supertest';
import type { CompositionSuggestionDto } from '@flil/shared';

let app: Express;
let token = '';
let tmpDir = '';

function call(method: 'get' | 'post' | 'put' | 'patch' | 'delete', url: string, body?: unknown) {
  let req = request(app)[method](url);
  if (token) req = req.set('authorization', `Bearer ${token}`);
  if (body !== undefined) req = req.send(body as object);
  return req;
}

// 注意：常量名不要含 "1px"/".png" 等资源扩展名词根，Vite 会误判为静态资源导入
const PIXEL_BUFFER = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+M8AAAMBAQDJ/pLvAAAAAElFTkSuQmCC',
  'base64',
);

const lightArrow = {
  kind: 'light_arrow',
  geometry: { from: { x: 0.8, y: 0.5 }, to: { x: 0.2, y: 0.5 }, bearingDeg: 270 },
};
const frame = {
  kind: 'frame',
  geometry: { rect: { x: 0.05, y: 0.05, w: 0.1, h: 0.1 } },
};

async function uploadAsset(inspirationId: string): Promise<string> {
  const res = await request(app)
    .post(`/api/inspirations/${inspirationId}/assets`)
    .set('authorization', `Bearer ${token}`)
    .attach('files', PIXEL_BUFFER, { filename: 'ref.png', contentType: 'image/png' })
    .field('role', 'reference');
  expect(res.status).toBe(201);
  return res.body.items[0].assetId as string;
}

beforeAll(async () => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'flil-composition-'));
  process.env.DATABASE_URL = path.join(tmpDir, 'app.db');
  process.env.UPLOAD_DIR = path.join(tmpDir, 'uploads');
  process.env.THUMB_DIR = path.join(tmpDir, 'thumbs');
  process.env.SHARE_DIR = path.join(tmpDir, 'share');
  process.env.BACKUP_DIR = path.join(tmpDir, 'backups');
  process.env.JWT_SECRET = 'test-secret';
  process.env.WEATHER_PROVIDER = 'fixture';
  process.env.ENABLE_CLIMATE_BASELINE = 'false';

  const { createApp } = await import('../src/app.js');
  const { migrate } = await import('../src/db.js');
  migrate();
  app = createApp();

  const reg = await request(app).post('/api/auth/register').send({
    email: 'composition@test.com',
    password: 'password123',
    displayName: '构图测试',
  });
  token = reg.body.token;
});

afterAll(async () => {
  const { closeDb } = await import('../src/db.js');
  closeDb();
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

describe('构图辅助模块：生成机位建议 + 依据，删除/重标同步失效', () => {
  let cardId = '';
  let assetId = '';

  it('准备：建卡、建机位并绑定（光位建议需要机位朝向）', async () => {
    const card = await call('post', '/api/inspirations', { title: '连廊光位与框架' });
    cardId = card.body.id;
    const place = await call('post', '/api/places', { name: '构图测试地点' });
    const spot = await call('post', '/api/spots', {
      placeId: place.body.id,
      lat: 31.2471,
      lng: 121.4462,
      cameraBearing: 265,
    });
    await call('post', `/api/inspirations/${cardId}/spot`, { spotId: spot.body.id });
    assetId = await uploadAsset(cardId);
    expect(assetId).toBeTruthy();
  });

  it('由箭头 + 取景框生成机位建议，每条都带依据与来源标注', async () => {
    const saved = await call('put', `/api/assets/${assetId}/annotations`, { items: [lightArrow, frame] });
    expect(saved.status).toBe(200);
    const arrowNoteId = saved.body.items.find((i: { kind: string }) => i.kind === 'light_arrow').id as string;

    const gen = await call('post', `/api/assets/${assetId}/composition-suggestions/generate`, {});
    expect(gen.status).toBe(201);
    const items = gen.body.items as CompositionSuggestionDto[];
    expect(items.length).toBeGreaterThanOrEqual(3);
    expect(items.every((i) => i.status === 'active')).toBe(true);
    // 每条建议必须解释依据（可人工复算的实测值）
    for (const s of items) {
      expect(s.basis.length).toBeGreaterThan(0);
      expect(s.basis.every((b) => b.text.length > 0)).toBe(true);
    }
    // 光位方向建议给出期望方位角 = 265 + 270 ≡ 175
    const direction = items.find((i) => i.ruleCode === 'light_direction');
    expect(direction).toBeTruthy();
    expect(direction!.basis.find((b) => b.code === 'expected_azimuth')?.values?.expectedAzimuth).toBe(175);
    // 来源标注可追溯
    expect(direction!.sourceAnnotationIds).toContain(arrowNoteId);

    // 卡片级聚合接口能查到
    const agg = await call('get', `/api/inspirations/${cardId}/composition-suggestions`);
    expect(agg.body.items.length).toBe(items.length);
  });

  it('重复生成不会产生重复建议（同内容是刷新而不是新增）', async () => {
    const first = await call('post', `/api/assets/${assetId}/composition-suggestions/generate`, {});
    const second = await call('post', `/api/assets/${assetId}/composition-suggestions/generate`, {});
    expect(second.body.items).toHaveLength(first.body.items.length);
    const onlyActive = await call('get', `/api/assets/${assetId}/composition-suggestions?status=active`);
    expect(onlyActive.body.items).toHaveLength(first.body.items.length);
  });

  it('覆盖重标后：旧建议同步失效并留痕，新建议按新标注生成', async () => {
    const before = await call('get', `/api/assets/${assetId}/composition-suggestions?status=active`);
    const oldId = before.body.items[0].id as string;
    expect(
      before.body.items.some((i: CompositionSuggestionDto) => i.ruleCode === 'frame_subject_thirds'),
    ).toBe(true);

    // 只保留光位箭头、删掉取景框
    const saved = await call('put', `/api/assets/${assetId}/annotations`, { items: [lightArrow] });
    expect(saved.status).toBe(200);

    const after = await call('get', `/api/assets/${assetId}/composition-suggestions`);
    const oldRow = after.body.items.find((i: CompositionSuggestionDto) => i.id === oldId);
    expect(oldRow.status).toBe('invalidated');
    expect(oldRow.invalidatedReason).toBe('annotations_replaced');
    expect(oldRow.invalidatedAt).toBeTruthy();
    // active 列表里不再有取景框派生建议
    const active: CompositionSuggestionDto[] = after.body.items.filter(
      (i: CompositionSuggestionDto) => i.status === 'active',
    );
    expect(active.some((i) => i.ruleCode.startsWith('frame_'))).toBe(false);
  });

  it('删除素材后：关联建议在同一请求内全部失效（asset_deleted），历史保留', async () => {
    const otherAsset = await uploadAsset(cardId);
    await call('put', `/api/assets/${otherAsset}/annotations`, { items: [lightArrow] });
    await call('post', `/api/assets/${otherAsset}/composition-suggestions/generate`, {});

    const del = await call('delete', `/api/assets/${otherAsset}`);
    expect(del.status).toBe(200);

    // 素材已删，但失效历史仍可经卡片级聚合看到
    const agg = await call('get', `/api/inspirations/${cardId}/composition-suggestions`);
    const dead: CompositionSuggestionDto[] = agg.body.items.filter(
      (i: CompositionSuggestionDto) => i.assetId === otherAsset,
    );
    expect(dead.length).toBeGreaterThan(0);
    expect(dead.every((i) => i.status === 'invalidated')).toBe(true);
    expect(dead.every((i) => i.invalidatedReason === 'asset_deleted')).toBe(true);

    // 素材不存在时，生成接口 404 而不是复活旧建议
    const retry = await call('post', `/api/assets/${otherAsset}/composition-suggestions/generate`, {});
    expect(retry.status).toBe(404);
  });

  it('越界标注被拒，不会污染建议依据', async () => {
    const bad = await call('put', `/api/assets/${assetId}/annotations`, {
      items: [{ kind: 'frame', geometry: { rect: { x: 0.8, y: 0.8, w: 0.5, h: 0.5 } } }],
    });
    expect(bad.status).toBe(400);
    const active = await call('get', `/api/assets/${assetId}/composition-suggestions?status=active`);
    // 仍是上一轮（仅箭头）的建议
    expect(
      active.body.items.every((i: CompositionSuggestionDto) => !i.ruleCode.startsWith('frame_')),
    ).toBe(true);
  });
});
