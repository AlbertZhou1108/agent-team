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

export function homeWorkbench(bus) {
  const s = bus.store;
  const groups = s.all(
    "SELECT id,name FROM groups WHERE state IS NULL OR state!='archived'",
  );
  const names = new Map(groups.map((g) => [g.id, g.name]));
  const destination = (group, endpoint, message) =>
    group
      ? `/groups/${encodeURIComponent(group)}?${new URLSearchParams({ ...(endpoint ? { session: endpoint } : {}), ...(message ? { message } : {}) })}`
      : '/agent';
  const pending = s
    .all(`SELECT * FROM interactions WHERE state='pending' ORDER BY created`)
    .filter((i) => !i.group_id || names.has(i.group_id))
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
  const recent = s
    .all(
      `SELECT r.turn_id AS id,r.state,r.created,r.ended,r.group_id,m.name,r.endpoint_id FROM runtime_attempts r
    LEFT JOIN endpoints e ON e.id=r.endpoint_id LEFT JOIN members m ON m.id=e.member_id WHERE r.state!='running'
    UNION ALL SELECT t.id,t.state,t.created,t.ended,t.group_id,p.name,t.session_id FROM panel_turns t
    JOIN panel_agents p ON p.id=t.panel_agent_id WHERE t.state!='running' ORDER BY created DESC LIMIT 30`,
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
    running,
    recent,
    panelReady: Boolean(bus.panelAgent()),
    summary: summaryReply ?? null,
    summaryRequest: summaryRequest
      ? { id: summaryRequest.id, created: summaryRequest.created }
      : null,
  };
}
