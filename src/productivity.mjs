// Read-only projections for navigation and the home workbench.
export function searchWorkspace(bus, params) {
  const q = String(params.get('q') ?? '')
    .trim()
    .slice(0, 200);
  if (!q) return [];
  const excerpt = (text) => {
    const index = text.toLocaleLowerCase().indexOf(q.toLocaleLowerCase());
    const start = Math.max(0, index - 60);
    return (start ? '…' : '') + text.slice(start, start + 300);
  };
  const pattern = `%${q.replace(/[\\%_]/g, '\\$&')}%`;
  const group = params.get('group') || null;
  const member = params.get('member') || null;
  const from = params.get('from') || null;
  const to = params.get('to') || null;
  for (const date of [from, to])
    if (date && !Number.isFinite(Date.parse(date)))
      throw new Error('无效的搜索日期');
  const rows = bus.store
    .all(
      `SELECT m.id,m.seq,m.text,m.created,m.group_id,g.name AS groupName,
    COALESCE(s.name,pa.name,m.sender) AS senderName
    FROM messages m JOIN groups g ON g.id=m.group_id LEFT JOIN members s ON s.id=m.sender
    LEFT JOIN panel_agents pa ON pa.id=m.sender
    WHERE (g.state IS NULL OR g.state!='archived') AND m.text LIKE ? ESCAPE '\\'
    AND (? IS NULL OR m.group_id=?) AND (? IS NULL OR m.sender=? OR m.recipient=?)
    AND (? IS NULL OR m.created>=?) AND (? IS NULL OR m.created<?)
    ORDER BY m.seq DESC LIMIT 40`,
      pattern,
      group,
      group,
      member,
      member,
      member,
      from,
      from,
      to,
      to,
    )
    .map((row) => ({
      ...row,
      text: excerpt(row.text),
      path: `/groups/${encodeURIComponent(row.group_id)}?message=${encodeURIComponent(row.id)}`,
    }));
  const panel =
    group || member
      ? []
      : bus.store
          .all(
            `SELECT id,seq,text,created,role AS senderName FROM panel_messages
    WHERE context='private' AND text LIKE ? ESCAPE '\\' AND (? IS NULL OR created>=?) AND (? IS NULL OR created<?)
    ORDER BY seq DESC LIMIT 20`,
            pattern,
            from,
            from,
            to,
            to,
          )
          .map((row) => ({
            ...row,
            text: excerpt(row.text),
            groupName: 'Panel Agent',
            path: `/agent?history=1&message=${encodeURIComponent(row.id)}`,
          }));
  return [...rows, ...panel]
    .sort((a, b) => b.created.localeCompare(a.created))
    .slice(0, 40);
}

export function homeWorkbench(bus, { waitingThresholdMs = 5 * 60 * 1000, now = Date.now() } = {}) {
  const s = bus.store;
  const groups = s.all(
    "SELECT id,name FROM groups WHERE state IS NULL OR state!='archived'",
  );
  const names = new Map(groups.map((g) => [g.id, g.name]));
  const dismissed = new Map([
    ['interaction', new Set()],
    ['waiting:user', new Set()],
    ['waiting:agent', new Set()],
  ]);
  for (const row of s.all('SELECT category,item_id FROM workbench_dismissals')) {
    dismissed.get(row.category)?.add(row.item_id);
  }
  const destination = (group, endpoint, message) =>
    group
      ? `/groups/${encodeURIComponent(group)}?${new URLSearchParams({ ...(endpoint ? { session: endpoint } : {}), ...(message ? { message } : {}) })}`
      : '/agent';
  const pending = s
    .all(`SELECT * FROM interactions WHERE state='pending' ORDER BY created`)
    .filter((i) => (!i.group_id || names.has(i.group_id)) && !dismissed.get('interaction').has(i.id))
    .map((i) => ({
      id: i.id,
      kind: 'interaction',
      title: JSON.parse(i.payload).text,
      groupName: names.get(i.group_id) ?? 'Panel Agent',
      created: i.created,
      path:
        i.group_id && !i.panel_message_id
          ? `/groups/${encodeURIComponent(i.group_id)}?${new URLSearchParams({ interaction: i.id })}`
          : `/agent?${new URLSearchParams({ interaction: i.id })}`,
    }));
  const queued = bus.store.pending();
  const running = [...bus.running.values()]
    .filter((run) => !run.endpoint.group_id || names.has(run.endpoint.group_id))
    .map((run) => ({
      id: run.turnId,
      // Panel sessions have panel_agent_id, not member_id; never bind undefined.
      name:
        s.get('SELECT name FROM members WHERE id=?', run.endpoint.member_id ?? null)
          ?.name ??
        bus.panelAgent()?.name ??
        'Agent',
      groupName: names.get(run.endpoint.group_id) ?? 'Panel Agent',
      created: run.created,
      queued: queued.filter(
        (m) =>
          m.group_id === run.endpoint.group_id &&
          m.recipient === (run.endpoint.member_id ?? run.endpoint.panel_agent_id) &&
          (!String(run.endpoint.context).startsWith('pair:') ||
            run.endpoint.context === `pair:${m.sender}`),
      ).length,
      path: destination(
        run.endpoint.group_id,
        run.endpoint.group_id ? run.endpoint.id : null,
      ),
    }));
  // 未应答:用户已发出、且尚没有任何一条消息通过 reply_to 指回它的指令。
  // 只覆盖可靠信号(用户→主 Agent);Agent 之间的等待需要协议字段,暂不在此推断。
  // 唯一的降噪是阈值:超过阈值仍无回复才列出,不判断 Agent 是否正在思考。
  const waiting = s
    .all(`SELECT m.id,m.group_id,m.text,m.created,m.recipient,
        g.name AS groupName,
        COALESCE(mem.name,pa.name,m.recipient) AS recipientName,
        CASE WHEN mem.id IS NOT NULL THEN 'member' ELSE 'panel_agent' END AS recipientKind
      FROM messages m JOIN groups g ON g.id=m.group_id
      LEFT JOIN members mem ON mem.id=m.recipient
      LEFT JOIN panel_agents pa ON pa.id=m.recipient
      WHERE m.sender='user' AND m.kind='send' AND m.reply_to IS NULL
        AND (g.state IS NULL OR g.state!='archived')
        AND NOT EXISTS(SELECT 1 FROM messages reply WHERE reply.reply_to=m.id)
        AND NOT EXISTS(SELECT 1 FROM workbench_dismissals d WHERE d.category='waiting:user' AND d.item_id=m.id)
      ORDER BY m.created ASC LIMIT 50`)
    .filter((row) => now - Date.parse(row.created) >= waitingThresholdMs)
    .map((row) => ({
      ...row,
      title: row.text.length > 200 ? `${row.text.slice(0, 200)}…` : row.text,
      path: `/groups/${encodeURIComponent(row.group_id)}?message=${encodeURIComponent(row.id)}`,
    }));
  // Agent 间请求:发信人显式声明 expects_reply 且尚无 reply_to 指回。
  const agentWaiting = s
    .all(`SELECT m.id,m.group_id,m.text,m.created,m.sender,m.recipient,
        g.name AS groupName,
        COALESCE(sm.name,sp.name,m.sender) AS senderName,
        COALESCE(rm.name,rp.name,m.recipient) AS recipientName,
        CASE WHEN sm.id IS NOT NULL THEN 'member' ELSE 'panel_agent' END AS senderKind,
        CASE WHEN rm.id IS NOT NULL THEN 'member' ELSE 'panel_agent' END AS recipientKind
      FROM messages m JOIN groups g ON g.id=m.group_id
      LEFT JOIN members sm ON sm.id=m.sender
      LEFT JOIN panel_agents sp ON sp.id=m.sender
      LEFT JOIN members rm ON rm.id=m.recipient
      LEFT JOIN panel_agents rp ON rp.id=m.recipient
      WHERE m.sender!='user' AND m.kind='send' AND m.expects_reply=1
        AND (g.state IS NULL OR g.state!='archived')
        AND NOT EXISTS(SELECT 1 FROM messages reply WHERE reply.reply_to=m.id)
        AND NOT EXISTS(SELECT 1 FROM workbench_dismissals d WHERE d.category='waiting:agent' AND d.item_id=m.id)
      ORDER BY m.created ASC LIMIT 50`)
    .filter((row) => now - Date.parse(row.created) >= waitingThresholdMs)
    .map((row) => ({
      ...row,
      title: row.text.length > 200 ? `${row.text.slice(0, 200)}…` : row.text,
      path: `/groups/${encodeURIComponent(row.group_id)}?message=${encodeURIComponent(row.id)}`,
    }));
  const recent = s
    .all(
      `SELECT t.id,t.state,t.created,t.ended,t.group_id,
        CASE WHEN t.executor_kind='panel_agent' THEN p.name ELSE m.name END AS name,
        t.conversation_id AS endpoint_id
       FROM turns t JOIN conversations c ON c.id=t.conversation_id
       LEFT JOIN members m ON m.id=c.member_id LEFT JOIN panel_agents p ON p.id=c.panel_agent_id
       WHERE t.state!='running' ORDER BY t.created DESC LIMIT 30`,
    )
    .filter((run) => !run.group_id || names.has(run.group_id))
    .slice(0, 10)
    .map((run) => ({
      ...run,
      groupName: names.get(run.group_id) ?? 'Panel Agent',
      path: destination(run.group_id, run.group_id ? run.endpoint_id : null),
    }));
  const agentId = bus.panelAgent()?.id ?? '';
  const summaryRequest = s.get(
    "SELECT id,created FROM panel_messages WHERE panel_agent_id=? AND context='private' AND role='user' AND text LIKE '[主页进展摘要]%' ORDER BY seq DESC LIMIT 1",
    agentId,
  );
  const summaryReply = s.get(
    `SELECT reply.id,reply.text,reply.created FROM panel_messages request
    JOIN panel_messages reply ON reply.panel_agent_id=request.panel_agent_id AND reply.context='private' AND reply.role='assistant' AND reply.seq>request.seq
    WHERE request.panel_agent_id=? AND request.context='private' AND request.role='user' AND request.text LIKE '[主页进展摘要]%'
    AND reply.seq<COALESCE((SELECT MIN(next.seq) FROM panel_messages next WHERE next.panel_agent_id=request.panel_agent_id AND next.context='private' AND next.role='user' AND next.seq>request.seq),9223372036854775807)
    ORDER BY request.seq DESC,reply.seq DESC LIMIT 1`,
    agentId,
  );
  return {
    pending,
    waiting,
    agentWaiting,
    running,
    recent,
    panelReady: Boolean(bus.panelAgent()),
    summary: summaryReply ?? null,
    summaryRequest: summaryRequest
      ? { id: summaryRequest.id, created: summaryRequest.created }
      : null,
  };
}

const DISMISS_CATEGORIES = new Set(['interaction', 'waiting:user', 'waiting:agent']);

/**
 * 只把条目从工作台隐藏:消息、互动卡和 reply_to 关系都不删除。
 * 服务端按当前投影校验 item_id,避免清理过期或不属于该类别的记录。
 */
export function dismissWorkbench(bus, items) {
  if (!Array.isArray(items) || items.length === 0 || items.length > 300) throw new Error('清理项无效');
  const store = bus.store;
  const live = new Map([
    ['interaction', new Set(store.all("SELECT id FROM interactions WHERE state='pending'").map(row => row.id))],
    ['waiting:user', new Set(store.all(`SELECT m.id FROM messages m JOIN groups g ON g.id=m.group_id
      WHERE m.sender='user' AND m.kind='send' AND m.reply_to IS NULL
        AND (g.state IS NULL OR g.state!='archived')
        AND NOT EXISTS(SELECT 1 FROM messages reply WHERE reply.reply_to=m.id)`).map(row => row.id))],
    ['waiting:agent', new Set(store.all(`SELECT m.id FROM messages m JOIN groups g ON g.id=m.group_id
      WHERE m.sender!='user' AND m.kind='send' AND m.expects_reply=1
        AND (g.state IS NULL OR g.state!='archived')
        AND NOT EXISTS(SELECT 1 FROM messages reply WHERE reply.reply_to=m.id)`).map(row => row.id))],
  ]);
  const seen = new Set();
  for (const item of items) {
    if (!item || typeof item !== 'object' || Array.isArray(item) || Object.keys(item).some(key => !['category', 'id'].includes(key))) throw new Error('清理项无效');
    if (!DISMISS_CATEGORIES.has(item.category) || typeof item.id !== 'string' || !item.id) throw new Error('清理项无效');
    const key = `${item.category}:${item.id}`;
    if (seen.has(key)) continue;
    seen.add(key);
    if (!live.get(item.category)?.has(item.id)) throw new Error('清理项已失效，请刷新后重试');
  }
  store.transaction(() => {
    for (const item of items) store.dismissWorkbench(item.category, item.id);
  });
  return { dismissed: seen.size };
}
