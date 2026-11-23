/**
 * 轻量研发工作流模板注册表（专项 3）：
 * - 严格遵守 GLOSSARY 通信优先原则：模板只提供角色预设、charter 文本引导与规则摘要，
 *   绝不锁定流程状态机，也不重引入 Goal/Contract/Work Item 等退役概念。
 */

export const WORKFLOW_TEMPLATES = Object.freeze([
  Object.freeze({
    id: 'standard-dev',
    name: '标准完整档研发（规划 → 实现 → 独立验收）',
    summary: '主 Agent 负责规划与调度，研发在独立 git worktree 并发编码，验收在只读/浏览器下复核；长文档落盘并以路径引用交付。',
    charter: [
      '【研发协作规范 · 标准完整档】',
      '1. 参考节奏：先澄清需求并经 ask 拍板关键取舍 → 用 tasks_set 公布切片 → 研发成员在各自工作区/worktree 编码并本地验证 → 独立验收成员只读复核 → 主 Agent 汇总结果待用户确认提交。',
      '2. 大文档路径交付：禁止在 send/note 正文粘贴长篇方案或整文件源码；Spec、设计评审与验证报告须写入工作区内 .md 文件（如 docs/flows/<topic>/spec.md、verify.md），群消息仅发送「核心结论 + 文件路径 + 关键章节锚点/验收清单」。',
      '3. Worktree 并行约定：使用独立 worktree 的研发成员完成修改并自测后，在分支提交变更并在汇报中注明分支名、修改文件与实测命令结果，避免并行覆盖。',
    ].join('\n'),
    presetMembers: Object.freeze([
      Object.freeze({
        name: '研发',
        roleHint: '编码实现与自测',
        policyCeiling: 'workspace-write',
        allowShell: true,
        allowBrowser: false,
        workspaceMode: 'worktree',
      }),
      Object.freeze({
        name: '只读验收',
        roleHint: '只读与浏览器独立验收',
        preferredHost: 'codex',
        policyCeiling: 'read-only',
        allowShell: true,
        allowBrowser: true,
        workspaceMode: 'inherit',
      }),
    ]),
  }),
  Object.freeze({
    id: 'quick-fix',
    name: '轻量修复直通（定位 → 修复 → 回归）',
    summary: '适合明确缺陷修复或局部重构：主 Agent 直接派发研发定位修改、回归相关测试并回传修改文件路径与验证输出。',
    charter: [
      '【研发协作规范 · 轻量修复】',
      '1. 聚焦最小复现与最小改动范围，不展开冗余设计文档；如中途发现需扩展交互或架构边界，及时上报调整。',
      '2. 完成修改后实跑相关测试/门禁，并在 send 回报中列出改动文件路径、实际执行的验证命令与输出摘要；长报告写文件传路径。',
    ].join('\n'),
    presetMembers: Object.freeze([
      Object.freeze({
        name: '研发',
        roleHint: '定位缺陷、修复与回归验证',
        policyCeiling: 'workspace-write',
        allowShell: true,
        allowBrowser: false,
        workspaceMode: 'inherit',
      }),
    ]),
  }),
]);

const TEMPLATE_MAP = new Map(WORKFLOW_TEMPLATES.map(item => [item.id, item]));

export function normalizeWorkflowTemplateId(value) {
  if (value === undefined || value === null) return null;
  if (typeof value !== 'string') throw new Error('研发工作流模板参数无效');
  const trimmed = value.trim();
  if (!trimmed || trimmed === 'none') return null;
  if (!TEMPLATE_MAP.has(trimmed)) throw new Error(`未知研发工作流模板: ${trimmed}`);
  return trimmed;
}

export function getWorkflowTemplate(value) {
  const id = normalizeWorkflowTemplateId(value);
  return id ? TEMPLATE_MAP.get(id) ?? null : null;
}

export function listWorkflowTemplates() {
  return WORKFLOW_TEMPLATES.map(template => ({
    id: template.id,
    name: template.name,
    summary: template.summary,
    charter: template.charter,
    presetMembers: template.presetMembers.map(member => ({ ...member })),
  }));
}

/** 根据群配置的模板返回紧凑提示片段（进规则固定区，未配模板则返回空串）。 */
export function workflowPromptHint(templateId) {
  const template = getWorkflowTemplate(templateId);
  if (!template) return '';
  return `当前团队启用工作流参考模板「${template.name}」：长篇方案/设计/验收报告请写入工作区文件，群消息（send/note）只传「核心结论 + 文件路径 + 关键锚点」；并行 worktree 成员汇报时须标明分支名与改动文件。模板仅作协作引导，不限制通信顺序。`;
}
