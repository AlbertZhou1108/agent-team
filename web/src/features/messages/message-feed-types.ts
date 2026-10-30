import type { MessageView } from '@/shared/models/view-types';
import type { Interaction, TeamDirectiveReceipt } from '@/shared/api/raw-types';
import type { StreamView } from './adapters';

export interface MessageFeedProps {
  messages: MessageView[];
  /**
   * 流视图的取值函数,是流数据的唯一入口。高频更新必须走取值函数而不是数组
   * props:函数只在 StreamingMessages 内部被调用,响应式依赖登记在流式子组件上,
   * 本组件不会随每个增量重渲染。
   */
  streamSource?: () => StreamView[];
  directives?: TeamDirectiveReceipt[];
  interactions?: Interaction[];
  title?: string;
  selectedPair: string;
  hosts?: Record<string, string>;
  /** 团队 id → 名称,仅用于运行卡里的工具动作说明。 */
  groupNames?: Record<string, string>;
  loading?: boolean;
  hasNextPage?: boolean;
  fetchingNextPage?: boolean;
  /** 连续 system 消息是否折叠为通知堆栈;Panel 的自动进度消息不折叠。 */
  groupSystemMessages?: boolean;
  /** 助手/系统正文按 Markdown 渲染。 */
  markdown?: boolean;
  ariaLabel?: string;
  resetKey?: string | number;
  viewportClass?: string;
  streamClass?: string;
  contentClass?: string;

}
