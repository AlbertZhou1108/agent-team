import type { HistoryRow } from '@/shared/api/raw-types';
import type {
  StepKind,
  StepStatus,
  TraceStep,
  TurnStatus,
  TurnView,
} from '@/shared/models/view-types';

type Payload = Record<string, unknown>;
type Host = 'codex' | 'claude' | 'dsh' | 'unknown';

interface ParsedRow extends HistoryRow {
  payload: Payload | null;
  host: Host;
}

const knownMetaMethods = new Set([
  'warning',
  'mcpServer/startupStatus/updated',
  'thread/status/changed',
  'thread/tokenUsage/updated',
  'turn/started',
  'turn/moderationMetadata',
  'thread/goal/cleared',
  'item/tool/call',
]);

function record(value: unknown): Payload | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value as Payload
    : null;
}

function array(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

function string(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined;
}

function number(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

function nested(value: Payload | null, ...keys: string[]) {
  let current: unknown = value;
  for (const key of keys) {
    current = record(current)?.[key];
  }
  return current;
}

function textOf(value: unknown) {
  if (typeof value === 'string') return value;
  if (value == null) return '';
  try {
    return JSON.stringify(value, null, 2);
  } catch {
    return String(value);
  }
}

function parseRows(rows: HistoryRow[], hosts: Record<string, Host>): ParsedRow[] {
  return rows.map(row => {
    let payload: Payload | null = null;
    try {
      payload = record(JSON.parse(row.event));
    } catch {
      payload = null;
    }
    return { ...row, payload, host: hosts[row.endpoint_id] ?? 'unknown' };
  });
}

function mergeStep(current: TraceStep | undefined, next: TraceStep): TraceStep {
  if (!current) return next;
  const merged = {
    ...current,
    ...next,
    title: next.title || current.title,
    summary: next.summary || current.summary,
    detail: next.detail || current.detail,
    status: next.status === 'unknown' ? current.status : next.status,
    sourceEvents: [...new Set([...current.sourceEvents, ...next.sourceEvents])].sort((a, b) => a - b),
    raw: [...current.raw, ...next.raw],
    sortSeq: Math.min(current.sortSeq, next.sortSeq),
  };
  return merged;
}

function addStep(steps: Map<string, TraceStep>, step: TraceStep) {
  steps.set(step.id, mergeStep(steps.get(step.id), step));
}

function baseStep(row: ParsedRow, fields: {
  id: string;
  kind: StepKind;
  status: StepStatus;
  title: string;
  summary?: string;
  detail?: string;
}): TraceStep {
  return {
    ...fields,
    turnId: row.turn_id,
    sourceEvents: [row.seq],
    raw: [row.payload],
    sortSeq: row.seq,
  };
}

function mapUniversal(row: ParsedRow, p: Payload, steps: Map<string, TraceStep>) {
  const type = string(p.type);
  if (type === 'input') {
    addStep(steps, baseStep(row, {
      id: `input:${row.seq}`,
      kind: 'input',
      status: 'success',
      title: '输入已提交',
      detail: string(p.text),
    }));
    return true;
  }
  if (type === 'framework.input_accepted') {
    addStep(steps, baseStep(row, {
      id: `checkpoint:accepted:${row.seq}`,
      kind: 'checkpoint',
      status: 'success',
      title: '宿主已接受输入',
      summary: '接受不等于回合完成',
    }));
    return true;
  }
  if (type === 'framework.model') {
    const model = string(p.model) ?? array(p.models).join(', ') ?? '';
    addStep(steps, baseStep(row, {
      id: `model:${row.seq}`,
      kind: 'model',
      status: 'success',
      title: '模型观测',
      summary: [model || '模型未知', string(p.reasoningEffort)].filter(Boolean).join(' · '),
      detail: textOf(p),
    }));
    return true;
  }
  if (type === 'framework.tool_call') {
    const callId = string(p.callId);
    if (!callId) return false;
    addStep(steps, baseStep(row, {
      id: `tool:${callId}`,
      kind: 'tool',
      status: 'running',
      title: string(p.name) ?? '工具调用',
      summary: '等待工具返回',
      detail: textOf(p.args),
    }));
    return true;
  }
  if (type === 'framework.tool_result') {
    const callId = string(p.callId);
    if (!callId) return false;
    const error = string(p.error);
    addStep(steps, baseStep(row, {
      id: `tool:${callId}`,
      kind: 'tool',
      status: error ? 'error' : 'success',
      title: steps.get(`tool:${callId}`)?.title ?? '工具结果',
      summary: error ? '工具执行失败' : '工具执行完成',
      detail: textOf(error ?? p.result),
    }));
    return true;
  }
  if (type === 'framework.output') {
    addStep(steps, baseStep(row, {
      id: `output:${row.seq}`,
      kind: 'output',
      status: 'success',
      title: '回合输出',
      detail: string(p.text),
    }));
    return true;
  }
  if (type === 'framework.error') {
    addStep(steps, baseStep(row, {
      id: `error:${row.seq}`,
      kind: 'error',
      status: 'error',
      title: '回合失败',
      detail: string(p.error),
    }));
    return true;
  }
  return false;
}

function mapCodex(row: ParsedRow, p: Payload, steps: Map<string, TraceStep>) {
  const method = string(p.method);
  const item = record(nested(p, 'params', 'item'));
  const itemType = string(item?.type);

  if (method === 'item/reasoning/textDelta') {
    const itemId = string(nested(p, 'params', 'itemId'));
    if (!itemId) return false;
    const id = `reasoning:${itemId}`;
    const current = steps.get(id);
    addStep(steps, baseStep(row, {
      id,
      kind: 'reasoning',
      status: 'running',
      title: '宿主思考',
      summary: `${current?.summary ?? ''}${string(nested(p, 'params', 'delta')) ?? ''}`,
      detail: current?.detail,
    }));
    return true;
  }

  if (method === 'item/completed' && itemType === 'reasoning') {
    const itemId = string(item?.id);
    if (!itemId) return false;
    const content = array(item?.content).map(textOf).filter(Boolean).join('\n');
    addStep(steps, baseStep(row, {
      id: `reasoning:${itemId}`,
      kind: 'reasoning',
      status: 'success',
      title: '宿主思考',
      summary: content || steps.get(`reasoning:${itemId}`)?.summary,
    }));
    return true;
  }

  if (method === 'item/started' && itemType === 'commandExecution') {
    const itemId = string(item?.id);
    if (!itemId) return false;
    addStep(steps, baseStep(row, {
      id: `terminal:${itemId}`,
      kind: 'terminal',
      status: 'running',
      title: string(item?.command) ?? '命令执行',
      summary: '命令正在执行',
    }));
    return true;
  }

  if (method === 'item/completed' && itemType === 'commandExecution') {
    const itemId = string(item?.id);
    if (!itemId) return false;
    const exitCode = number(item?.exitCode);
    addStep(steps, baseStep(row, {
      id: `terminal:${itemId}`,
      kind: 'terminal',
      status: exitCode === 0 ? 'success' : 'error',
      title: string(item?.command) ?? '命令执行',
      summary: exitCode === 0 ? '命令执行完成' : `退出码 ${exitCode ?? '未知'}`,
      detail: string(item?.aggregatedOutput),
    }));
    return true;
  }

  if (method === 'turn/completed') {
    const status = string(nested(p, 'params', 'turn', 'status'));
    addStep(steps, baseStep(row, {
      id: `checkpoint:turn:${row.turn_id}`,
      kind: 'checkpoint',
      status: status === 'completed' ? 'success' : 'error',
      title: '回合结束',
      summary: status ?? '状态未知',
    }));
    return true;
  }

  if (method?.startsWith('item/')) {
    return true;
  }

  return method ? knownMetaMethods.has(method) : false;
}

function mapClaude(row: ParsedRow, p: Payload, steps: Map<string, TraceStep>) {
  const type = string(p.type);
  const message = record(p.message);
  const blocks = array(message?.content);

  if (type === 'assistant') {
    const thinking = blocks
      .map(block => record(block))
      .filter((block): block is Payload => block?.type === 'thinking')
      .map(block => string(block.thinking))
      .filter((value): value is string => Boolean(value))
      .join('\n');
    if (thinking) {
      addStep(steps, baseStep(row, {
        id: `reasoning:claude:${row.seq}`,
        kind: 'reasoning',
        status: 'success',
        title: '宿主思考',
        summary: thinking,
      }));
    }
    return true;
  }

  if (type === 'user') return true;
  if (type === 'system') return true;

  if (type === 'result') {
    addStep(steps, baseStep(row, {
      id: `checkpoint:result:${row.seq}`,
      kind: 'checkpoint',
      status: p.is_error ? 'error' : 'success',
      title: p.is_error ? '回合失败' : '回合结束',
      summary: string(p.subtype) ?? string(p.stop_reason),
      detail: string(p.result),
    }));
    return true;
  }

  return false;
}

function mapDsh(row: ParsedRow, p: Payload, steps: Map<string, TraceStep>) {
  const type = string(p.type);

  if (type === 'thinking') {
    const thinking = string(p.text);
    if (!thinking) return true;
    addStep(steps, baseStep(row, {
      id: `reasoning:dsh:${row.seq}`,
      kind: 'reasoning',
      status: 'success',
      title: '宿主思考',
      summary: thinking,
    }));
    return true;
  }

  if (type === 'status' && string(p.phase) === 'turn_end') {
    const reason = string(nested(p, 'reason', 'kind'));
    addStep(steps, baseStep(row, {
      id: `checkpoint:turn:${row.turn_id}`,
      kind: 'checkpoint',
      status: reason === 'completed' ? 'success' : 'error',
      title: '回合结束',
      summary: reason ?? '状态未知',
    }));
    return true;
  }

  if (type === 'error') {
    addStep(steps, baseStep(row, {
      id: `error:dsh:${row.seq}`,
      kind: 'error',
      status: 'error',
      title: '宿主错误',
      detail: string(p.message) ?? string(p.error),
    }));
    return true;
  }

  if (['session', 'status', 'tool_call', 'tool_result', 'text', 'final'].includes(type ?? '')) {
    return true;
  }

  return false;
}

function turnStatus(turnId: string, steps: TraceStep[], latestRunningTurn: string | null): TurnStatus {
  if (turnId === latestRunningTurn) return 'running';
  if (steps.some(step => step.kind === 'error' || (step.kind === 'checkpoint' && step.status === 'error'))) {
    return 'error';
  }
  if (steps.some(step => step.kind === 'output' && step.status === 'success')) return 'completed';
  if (steps.some(step => step.kind === 'checkpoint' && step.status === 'success' && step.title === '回合结束')) {
    return 'completed';
  }
  return 'unknown';
}

export function buildTurns(
  rows: HistoryRow[],
  options: { hosts?: Record<string, Host>; running?: boolean } = {},
): TurnView[] {
  const parsed = parseRows(rows, options.hosts ?? {});
  const steps = new Map<string, TraceStep>();

  for (const row of parsed) {
    if (!row.payload) {
      addStep(steps, baseStep(row, {
        id: `unknown:${row.seq}`,
        kind: 'unknown',
        status: 'unknown',
        title: '无法解析的事件',
        detail: row.event,
      }));
      continue;
    }

    const handled = mapUniversal(row, row.payload, steps);
    if (handled) continue;

    const hostHandled = row.host === 'codex'
      ? mapCodex(row, row.payload, steps)
      : row.host === 'claude'
        ? mapClaude(row, row.payload, steps)
        : row.host === 'dsh'
          ? mapDsh(row, row.payload, steps)
          : false;

    if (!hostHandled) {
      addStep(steps, baseStep(row, {
        id: `unknown:${row.seq}`,
        kind: 'unknown',
        status: 'unknown',
        title: '未识别事件',
        summary: string(row.payload.type) ?? string(row.payload.method) ?? 'unknown',
        detail: textOf(row.payload),
      }));
    }
  }

  const groups = new Map<string, TraceStep[]>();
  for (const step of steps.values()) {
    const key = step.turnId ?? 'unknown';
    groups.set(key, [...(groups.get(key) ?? []), step]);
  }

  const latestKnownTurn = [...groups.entries()]
    .sort((a, b) => Math.max(...b[1].map(step => step.sortSeq)) - Math.max(...a[1].map(step => step.sortSeq)))[0]?.[0] ?? null;
  const latestRunningTurn = options.running ? latestKnownTurn : null;

  return [...groups.entries()].map(([id, values]) => {
    const ordered = [...values].sort((a, b) => a.sortSeq - b.sortSeq);
    return {
      id,
      status: turnStatus(id, ordered, latestRunningTurn),
      steps: ordered,
      firstSeq: ordered[0]?.sortSeq ?? 0,
      lastSeq: ordered.at(-1)?.sortSeq ?? 0,
    };
  }).sort((a, b) => b.lastSeq - a.lastSeq);
}

export function uniqueHistoryRows(rows: HistoryRow[]) {
  return [...new Map(rows.map(row => [row.seq, row])).values()]
    .sort((a, b) => a.seq - b.seq);
}
