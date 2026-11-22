/**
 * 随心记域 API 类型:笔记、待办、标签、计数、分页与归档事实快照。
 */

// 随心记：用户的私人想法。服务端只落内容与三态，不记录任何执行状态。
export type NoteState = 'active' | 'done' | 'archived';

export interface NoteTodo {
  text: string;
  done: boolean;
}

/** 全局标签注册表的一行:笔记按 id 引用,颜色用于色点与筛选区分。 */
export interface NoteTag {
  id: string;
  name: string;
  /** 可选颜色(#rrggbb);null 表示中性无色标签。 */
  color: string | null;
  created: string;
}

export interface Note {
  id: string;
  title: string;
  titleManual: boolean;
  body: string;
  todos: NoteTodo[];
  /** 引用的标签 id 列表;标签删除后残留 id 不再出现在注册表,由界面容忍。 */
  tags: string[];
  /** 置顶时间;null 表示未置顶。置顶笔记在列表中单独成板。 */
  pinnedAt: string | null;
  due: string | null;
  state: NoteState;
  /** 来源团队：记下这条笔记时所在的团队；null 表示无来源。不是归属，团队删了笔记还在。 */
  sourceTeamId: string | null;
  /** 团队当前名字；团队已删除时为 null，由界面显示「团队已删除」。 */
  sourceTeamName: string | null;
  revision: number;
  created: string;
  updated: string;
  completed: string | null;
  archived: string | null;
}

export interface NoteCounts {
  active: number;
  done: number;
  archived: number;
}

export interface NotePage {
  notes: Note[];
  /** 置顶笔记:同筛选范围全量返回(不参与游标分页),按置顶时间倒序。 */
  pinned: Note[];
  nextCursor: string | null;
  counts: NoteCounts;
  /**
   * 团队维度候选:当前筛选范围内真有笔记的团队及其条数(teamId=null 表示无来源)。
   * 分面排除团队维度本身,因此在选中某团队后仍能看到其它可选团队。
   */
  teamFacets: Array<{ teamId: string | null; count: number }>;
  /** 标签维度候选:当前范围内真有笔记的标签及条数(分面同样排除标签维度本身)。 */
  tagFacets: Array<{ tagId: string; count: number }>;
}

export interface ArchiveSnapshot {
  id: string;
  group_id: string;
  created: string;
  summary: string | null;
  summary_created: string | null;
  error: string | null;
  generating: boolean;
  facts: {
    group: { name: string; charter: string | null };
    members: { id: string; name: string; host: string; role: string; profile: string | null; removed: string | null }[];
    panelAgent: { id: string; name: string } | null;
    tasks: { owner_id: string; tasks: { text: string; state: 'doing' | 'done' | 'dropped' }[]; updated: string }[];
    messages: { id: string; sender: string; recipient: string; kind: string; text: string; reply_to: string | null; expects_reply: number; created: string }[];
    panelMessages: { id: string; role: string; text: string; created: string }[];
    interactions: { id: string; state: string; payload: { text?: string; options?: string[] }; answer: { value?: string; selected?: string; approved?: boolean } | null; created: string }[];
  };
}
