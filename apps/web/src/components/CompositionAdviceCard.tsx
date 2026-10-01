import { Button, Card, Empty, Space, Tag, Typography, message } from 'antd';
import {
  ANNOTATION_KIND_LABEL,
  COMPOSITION_ADVICE_KIND_LABEL,
  type AssetDto,
  type CompositionAdviceDto,
} from '@flil/shared';
import { useCompositionAdvice, useRecomputeCompositionAdvice } from '../api/hooks.js';

interface Props {
  inspirationId: string;
  assets: AssetDto[];
}

const LEVEL_ICON: Record<string, string> = { ok: '✓', warn: '!', bad: '✗', info: '·' };

function AdviceItem({ advice }: { advice: CompositionAdviceDto }) {
  return (
    <div
      style={{
        border: '1px solid #eee',
        borderLeft: `4px solid ${advice.stale ? '#bfbfbf' : '#69b1ff'}`,
        borderRadius: 8,
        padding: '10px 12px',
        opacity: advice.stale ? 0.6 : 1,
      }}
    >
      <Space wrap size={6}>
        <Tag color={advice.stale ? 'default' : 'geekblue'}>{COMPOSITION_ADVICE_KIND_LABEL[advice.kind]}</Tag>
        {advice.stale ? <Tag color="orange">已失效：素材已重标，需重新生成</Tag> : null}
        <Typography.Text strong={!advice.stale} delete={advice.stale}>
          {advice.summary}
        </Typography.Text>
      </Space>
      <div style={{ marginTop: 6 }}>
        {advice.reasons.map((r) => (
          <div
            key={`${r.code}-${r.text}`}
            style={{ fontSize: 12, color: r.level === 'bad' ? '#a8071a' : r.level === 'warn' ? '#ad6800' : '#555' }}
          >
            {LEVEL_ICON[r.level] ?? '·'} {r.text}
          </div>
        ))}
      </div>
      {advice.basis.notes.length ? (
        <div style={{ marginTop: 6, fontSize: 12 }}>
          <Typography.Text type="secondary">
            依据：
            {advice.basis.kinds.map((k) => ANNOTATION_KIND_LABEL[k] ?? k).join(' + ')}
            {' —— '}
            {advice.basis.notes.join('；')}
          </Typography.Text>
        </div>
      ) : null}
    </div>
  );
}

/**
 * 构图辅助：由标注箭头 / 取景框 / 主体线生成的机位建议。
 * 素材重标后建议同步失效（stale），删除素材后建议级联消失。
 */
export function CompositionAdviceCard({ inspirationId, assets }: Props) {
  const advice = useCompositionAdvice(inspirationId);
  const recompute = useRecomputeCompositionAdvice();
  const items = advice.data?.items ?? [];

  const byAsset = new Map<string, CompositionAdviceDto[]>();
  for (const a of items) {
    const list = byAsset.get(a.assetId) ?? [];
    list.push(a);
    byAsset.set(a.assetId, list);
  }

  async function regenerate(assetId: string) {
    try {
      const res = await recompute.mutateAsync(assetId);
      message.success(
        res.items.length ? `已生成 ${res.items.length} 条机位建议` : '这张素材还没有可生成建议的标注（箭头/取景框/主体线）',
      );
    } catch (err) {
      message.error((err as Error).message);
    }
  }

  return (
    <Card size="small" title="构图辅助 · 机位建议（由标注生成，重标后自动失效）">
      {assets.length === 0 ? (
        <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description="先上传图片并画标注" />
      ) : (
        <Space direction="vertical" size={12} style={{ width: '100%' }}>
          {assets.map((asset) => {
            const list = byAsset.get(asset.id) ?? [];
            return (
              <div key={asset.id}>
                <Space wrap style={{ marginBottom: 6 }}>
                  <Typography.Text type="secondary" style={{ fontSize: 12 }}>
                    素材 {asset.id.slice(-6)}（{asset.width}×{asset.height}）
                  </Typography.Text>
                  <Button size="small" loading={recompute.isPending} onClick={() => void regenerate(asset.id)}>
                    {list.length ? '按最新标注重新生成' : '生成机位建议'}
                  </Button>
                </Space>
                {list.length ? (
                  <Space direction="vertical" size={8} style={{ width: '100%' }}>
                    {list.map((a) => (
                      <AdviceItem key={a.id} advice={a} />
                    ))}
                  </Space>
                ) : (
                  <div>
                    <Typography.Text type="secondary" style={{ fontSize: 12 }}>
                      还没有建议。在「构图 / 光位标注」里画光位箭头、取景框或主体线后点生成。
                    </Typography.Text>
                  </div>
                )}
              </div>
            );
          })}
        </Space>
      )}
    </Card>
  );
}
