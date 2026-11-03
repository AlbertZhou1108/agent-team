export type SearchEntry = {
  id: string;
  label: string;
  path: string;
  keywords?: string;
};
export const navigationEntries: SearchEntry[] = [
  {
    id: 'home',
    label: '主页',
    path: '/groups',
    keywords: '首页 待处理 运行活动 统计 摘要',
  },
  {
    id: 'agent',
    label: 'Panel Agent',
    path: '/agent',
    keywords: '助手 私人会话',
  },
  ...[
    ['appearance', '设计预设'],
    ['appearance', '显示模式'],
    ['appearance', '动效'],
    ['appearance', '材质'],
    ['appearance', '主题'],
    ['appearance', '密度'],
    ['appearance', '阅读'],
    ['general', '适配器状态'],
    ['general', '思考过程'],
    ['general', '附件上传'],
    ['policy', '模型策略'],
    ['teams', '归档团队'],
  ].map(([tab, label]) => ({
    id: `setting-${label}`,
    label: label!,
    path: `/settings?${new URLSearchParams({ section: tab!, setting: label! })}`,
    keywords:
      '设置 settings 配置 ' +
      ({
        主题: '配色 theme color',
        显示模式: '深色 浅色 dark light',
        适配器状态: '宿主 host 认证',
        阅读: '字体 字号 行距',
        附件上传: '附件设置 上传大小',
      }[label!] ?? ''),
  })),
];
export function matchingEntries(entries: SearchEntry[], query: string) {
  const terms = query.trim().toLocaleLowerCase().split(/\s+/).filter(Boolean);
  return entries.filter((entry) =>
    terms.every((term) =>
      `${entry.label} ${entry.keywords ?? ''}`
        .toLocaleLowerCase()
        .includes(term),
    ),
  );
}
