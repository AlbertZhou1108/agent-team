import type { MessageView } from '@/shared/models/view-types';

export type MessageGroup =
  // 连续 system 消息折叠为通知堆栈（沿用 notification-stack UI）。
  | { id: string; kind: 'system'; messages: MessageView[] }
  // 同一发送者连续发往同一接收者的 send 消息合并:头像与身份只在组首显示。
  | { id: string; kind: 'run'; sender: string; messages: MessageView[] }
  // 同一发送者向多位成员群发的相同指令:正文只展示一次,头部列出全部接收者。
  | { id: string; kind: 'fanout'; sender: string; messages: MessageView[] }
  // note、单条 system 与用户可见的其他独立消息。
  | { id: string; kind: 'single'; message: MessageView };

function senderKey(message: MessageView) {
  // 以 发送者→接收者 为合并键:群发给不同成员的指令各自成组,紧凑条不丢失路由。
  return `${message.senderName}→${message.recipientName}`;
}

interface GroupOptions {
  groupSystemMessages?: boolean;
  /** 自成一组、不参与「同发送者连续消息」合并的消息(如卡片锚点)。 */
  isBlocked?: (message: MessageView) => boolean;
}

export function buildMessageGroups(
  messages: MessageView[],
  { groupSystemMessages = true, isBlocked = (_message: MessageView) => false }: GroupOptions = {},
): MessageGroup[] {
  const groups: MessageGroup[] = [];
  const pushRun = (message: MessageView) => {
    const previous = groups.at(-1);
    if (previous?.kind === 'run' && previous.sender === senderKey(message)) {
      previous.messages.push(message);
      return;
    }
    groups.push({ id: message.id, kind: 'run', sender: senderKey(message), messages: [message] });
  };
  const pushSend = (message: MessageView) => {
    const previous = groups.at(-1);
    // 已在 fanout 组中:同发送者同文本继续并入。
    if (
      previous?.kind === 'fanout'
      && previous.messages[0]!.senderName === message.senderName
      && previous.messages[0]!.text === message.text
    ) {
      previous.messages.push(message);
      return;
    }
    // 单条 run 且与新消息同发送者、同文本、不同接收者:升级为 fanout。
    if (
      previous?.kind === 'run'
      && previous.messages.length === 1
      && previous.messages[0]!.senderName === message.senderName
      && previous.messages[0]!.text === message.text
      && previous.messages[0]!.recipientName !== message.recipientName
    ) {
      groups[groups.length - 1] = {
        id: previous.id,
        kind: 'fanout',
        sender: previous.sender,
        messages: [...previous.messages, message],
      };
      return;
    }
    pushRun(message);
  };
  for (const message of messages) {
    // 卡片锚点消息自成一组:正文由卡片承担,不参与「同发送者连续消息」的身份合并,
    // 否则紧随其后的消息会被当作紧凑条而丢掉头像与身份行。
    if (isBlocked(message)) {
      groups.push({ id: message.id, kind: 'single', message });
      continue;
    }
    if (message.kind === 'system') {
      const previous = groups.at(-1);
      if (groupSystemMessages && previous?.kind === 'system') {
        previous.messages.push(message);
        continue;
      }
      // system 打断任何 run;单条 system 保持独立展示,连续第二条起并入堆栈。
      groups.push({ id: message.id, kind: 'system', messages: [message] });
      continue;
    }
    if (message.kind === 'note') {
      groups.push({ id: message.id, kind: 'single', message });
      continue;
    }
    pushSend(message);
  }
  return groups;
}

// system 堆栈沿用「多于一条才折叠」的既有交互;单条按独立消息渲染。
export function isSystemStack(group: MessageGroup): boolean {
  return group.kind === 'system' && group.messages.length > 1;
}
