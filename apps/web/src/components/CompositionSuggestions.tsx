import { Alert, Button, Card, Empty, Space, Tag, Timeline, Tooltip, Typography, message } from 'antd';
import type { CompositionSuggestionDto } from '@flil/shared';
import { useGenerateCompositionSuggestions } from '../api/hooks.js';

interface Props {
  suggestions: CompositionSuggestionDto[];
  assetTitles: Record<string, string>;
  /** 标注保存后为 true：存在比建议更新的标注，提示重算 */
  stale?: boolean;
}

const PRIORITY_META = {
  warn: { color: 'orange', mark: '⚠', tag: '注意' },
  info: { color: 'blue', mark: '◎', tag: '依据' },
  tip: { color: 'default', mark: '💡', tag: '建议' },
} as const;

/** 构图辅助：展示由光位箭头 / 取景框 / 主体线生成的机位建议，并逐条解释依据 */
export function CompositionSuggestions({ suggestions, assetTitles, stale = false }: Props) {
  const generate = useGenerateCompositionSuggestions();
  const active = suggestions.filter((s) => s.status === 'active');
  const invalidated = suggestions.filter((s) => s.status === 'invalidated');

  const assetIds = [...new Set(active.map((s) => s.assetId).filter((v): v is string => Boolean(v)))];

  async function regenerateAll() {
    try {
      let total = 0;
      for (const assetId of assetIds) {
        const res = await generate.mutateAsync(assetId);
        total += res.generated;
      }
      message.success(total ? `已按最新标注生成 ${total} 条机位建议` : '当前标注没有可生成的机位建议');
    } catch (err) {
      message.error((err as Error).message);
    }
  }

  return (
    <Card
      title="构图辅助 · 机位建议"
      extra={
        assetIds.length ? (
          <Button size="small" loading={generate.isPending} onClick={() => void regenerateAll()}>
            按标注重新生成
          </Button>
        ) : null
      }
    >
      {stale && active.length > 0 ? (
        <Alert
          type="info"
          showIcon
          style={{ marginBottom: 12 }}
          message="标注在上次生成之后被改过"
          description="旧建议已随重标同步失效，点击右上角「按标注重新生成」获取新建议。"
        />
      ) : null}

      {active.length === 0 ? (
        <Empty
          image={Empty.PRESENTED_IMAGE_SIMPLE}
          description={
            invalidated.length
              ? '历史建议已随素材删除 / 重标失效；在图片上画好箭头、取景框或主体线后重新生成。'
              : '先在图片上标注光位箭头、取景框或主体线，再生成机位建议（每条都会给出可复算依据）。'
          }
        />
      ) : (
        <Timeline
          items={active.map((s) => {
            const meta = PRIORITY_META[s.priority];
            return {
              color: s.priority === 'warn' ? 'orange' : s.priority === 'info' ? 'blue' : 'gray',
              children: (
                <div>
                  <Space wrap size={6}>
                    <Typography.Text strong>
                      {meta.mark} {s.title}
                    </Typography.Text>
                    <Tag color={meta.color}>{meta.tag}</Tag>
                    {s.assetId && assetTitles[s.assetId] ? (
                      <Typography.Text type="secondary" style={{ fontSize: 12 }}>
                        来自 {assetTitles[s.assetId]}
                      </Typography.Text>
                    ) : null}
                  </Space>
                  <div>
                    <Typography.Text type="secondary" style={{ fontSize: 13 }}>
                      {s.detail}
                    </Typography.Text>
                  </div>
                  <div style={{ marginTop: 4 }}>
                    {s.basis.map((b) => (
                      <Tooltip key={b.code} title={b.code}>
                        <Tag style={{ marginBottom: 4 }}>{b.text}</Tag>
                      </Tooltip>
                    ))}
                  </div>
                </div>
              ),
            };
          })}
        />
      )}

      {invalidated.length ? (
        <Typography.Text type="secondary" style={{ fontSize: 12 }}>
          {invalidated.length} 条历史建议已失效（
          {invalidated.some((s) => s.invalidatedReason === 'asset_deleted') ? '素材删除' : ''}
          {invalidated.some((s) => s.invalidatedReason === 'asset_deleted') &&
          invalidated.some((s) => s.invalidatedReason === 'annotations_replaced')
            ? ' / '
            : ''}
          {invalidated.some((s) => s.invalidatedReason === 'annotations_replaced') ? '重新标注' : ''}），依据留档可查。
        </Typography.Text>
      ) : null}
    </Card>
  );
}
