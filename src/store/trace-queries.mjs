// 消息/回合追溯查询：只读 history 事件重建公开视图，不写库。
// modelSummaryCache 仍挂在 Store 实例上，保持既有缓存语义。

function modelObservations(rows) {
  return rows.flatMap(row => {
    const event = JSON.parse(row.event);
    return event.type === 'framework.model' ? [{ seq: row.seq, created: row.created, turnId: row.turn_id, ...event }] : [];
  });
}

function latestWith(observations, field, phases) {
  for (const phase of phases) {
    const found = [...observations].reverse().find(observation => observation.phase === phase && observation[field] != null);
    if (found) return { [field]: found[field], phase: found.phase, source: found.source, seq: found.seq, ...(found.turnId ? { turnId: found.turnId } : {}) };
  }
  return null;
}

function deriveCurrentModel(observations) {
  const latest = [...observations].reverse().find(observation => observation.phase !== 'usage' && (observation.model != null || observation.reasoningEffort != null));
  const current = latest?.turnId ? observations.filter(observation => observation.turnId === latest.turnId) : observations;
  return {
    currentModel: latestWith(current, 'model', ['assistant', 'verified', 'session', 'requested']),
    currentReasoningEffort: latestWith(current, 'reasoningEffort', ['verified', 'session', 'requested']),
  };
}

export function messageSegment(store, turnId, callId) {
    if (!turnId || !callId) return null;
    const isFinal = callId === 'framework.final_output';
    const end = isFinal
      ? store.get(`SELECT seq FROM history WHERE turn_id=? AND json_extract(event,'$.type')='framework.output' ORDER BY seq DESC LIMIT 1`, turnId)
      : store.get(`SELECT seq FROM history WHERE turn_id=? AND json_extract(event,'$.type')='framework.tool_result'
          AND json_extract(event,'$.callId')=? ORDER BY seq LIMIT 1`, turnId, callId);
    if (!end) return null;
    const previous = store.get(`SELECT seq FROM history WHERE turn_id=? AND seq<?
        AND json_extract(event,'$.type') IN ('framework.tool_result','framework.output')
      ORDER BY seq DESC LIMIT 1`, turnId, end.seq);
    const events = store.all('SELECT * FROM history WHERE turn_id=? AND seq>? AND seq<=? ORDER BY seq',
      turnId, previous?.seq ?? 0, end.seq);
    return { startSeq: events[0]?.seq ?? end.seq, endSeq: end.seq, events };
  }

export function messageTrace(store, id, { segment = false } = {}) {
    const message = store.get('SELECT id,kind FROM messages WHERE id=?', id);
    if (!message) {
      // Panel 私聊消息存于 panel_messages,未记录回合来源(v6 无消息→turn 映射);
      // 按成员私聊同语义返回 private,前端据此显示「没有可用轨迹」而不是把已知消息当 404。
      if (!store.get('SELECT id FROM panel_messages WHERE id=?', id)) return null;
      return { messageId: id, source: { kind: 'private' }, inputAttempts: [] };
    }
    const origin = store.get(`SELECT o.*,c.context,c.id AS conversation_id,c.member_id,c.panel_agent_id,t.executor_kind,t.group_id AS turn_group_id
      FROM message_origins o JOIN turns t ON t.id=o.turn_id JOIN conversations c ON c.id=t.conversation_id WHERE o.message_id=?`, id);
    const source = !origin
      ? { kind: message.kind === 'system' ? 'system' : 'unknown' }
      : origin.executor_kind === 'panel_agent'
        ? {
            kind: origin.context === 'private' ? 'private' : 'panel',
            turnId: origin.turn_id,
            endpointId: null,
            panelAgentId: origin.panel_agent_id,
            groupId: origin.turn_group_id,
            eventSeq: origin.event_seq,
            callId: origin.call_id,
            nativeCallId: origin.native_call_id,
          }
        : origin.context === 'private'
          ? { kind: 'private' }
          : { kind: 'group', turnId: origin.turn_id, endpointId: origin.conversation_id, eventSeq: origin.event_seq, callId: origin.call_id, nativeCallId: origin.native_call_id };
    const inputAttempts = store.all(
      `SELECT t.id,t.conversation_id AS endpoint_id,t.session,t.created FROM turn_inputs i JOIN turns t ON t.id=i.turn_id
       JOIN conversations c ON c.id=t.conversation_id WHERE i.message_id=? AND c.context!='private' ORDER BY t.rowid`,
      id,
    );
    const result = { messageId: id, source, inputAttempts };
    if (!segment) return result;
    // 段与回合状态一并给出:轨迹头部要显示这条消息从开始到发出的耗时,
    // 以及宿主是否报告了失败——这些都不能从段内事件反推。
    const bounds = source.turnId ? messageSegment(store, source.turnId, source.callId) : null;
    const turn = source.turnId
      ? store.get(`SELECT t.state,t.created,t.ended,c.id AS conversation_id,c.group_id,c.member_id,c.panel_agent_id,t.executor_kind,COALESCE(m.host,p.host) AS host
          FROM turns t JOIN conversations c ON c.id=t.conversation_id
          LEFT JOIN members m ON m.id=c.member_id LEFT JOIN panel_agents p ON p.id=c.panel_agent_id
          WHERE t.id=?`, source.turnId)
      : null;
    return {
      ...result,
      segment: bounds,
      turn: turn ? {
        id: source.turnId,
        state: turn.state,
        created: turn.created,
        ended: turn.ended ?? null,
        host: turn.host ?? null,
        group_id: turn.group_id,
        // 事件行按会话归属;用会话自身 id,panel 来源也要能对上宿主映射。
        endpoint_id: turn.conversation_id,
      } : null,
    };
  }

export function endpointModels(store, id, after = 0) {
    const conversation = store.get("SELECT id FROM conversations WHERE id=? AND context!='private'", id);
    if (!conversation) return null;
    const all = modelObservations(store.all('SELECT seq,turn_id,created,event FROM history WHERE conversation_id=? ORDER BY seq', id));
    const observations = all.filter(observation => observation.seq > after).slice(0, 200);
    return { ...deriveCurrentModel(all), observations, nextAfter: observations.at(-1)?.seq ?? after };
  }

export function endpointModelSummary(store, id) {
    const revision = store.get('SELECT MAX(seq) AS seq,COUNT(*) AS count FROM history WHERE conversation_id=?', id);
    store.modelSummaryCache ??= new Map();
    const cached = store.modelSummaryCache.get(id);
    if (cached?.seq === revision.seq && cached?.count === revision.count) return cached.value;
    const value = deriveCurrentModel(modelObservations(store.all(
      'SELECT seq,turn_id,created,event FROM history WHERE conversation_id=? ORDER BY seq', id,
    )));
    store.modelSummaryCache.set(id, { ...revision, value });
    return value;
  }
  /** 从失败回合的历史事件中提取单行错误摘要，便于折叠行直接预览。 */

export function turnErrorSummary(store, turnId) {
    const rows = store.all('SELECT event FROM history WHERE turn_id=? ORDER BY seq DESC LIMIT 30', turnId);
    for (const row of rows) {
      let parsed;
      try { parsed = JSON.parse(row.event); } catch { continue; }
      if (!parsed || typeof parsed !== 'object') continue;
      let raw = null;
      if (parsed.type === 'framework.error' && typeof parsed.error === 'string') raw = parsed.error;
      else if (parsed.type === 'error') raw = typeof parsed.message === 'string' ? parsed.message : (typeof parsed.error === 'string' ? parsed.error : null);
      else if (parsed.type === 'result' && parsed.is_error && typeof parsed.result === 'string') raw = parsed.result;
      else if (parsed.method === 'error') raw = parsed.params?.error?.message ?? parsed.params?.message ?? null;
      if (!raw || typeof raw !== 'string') continue;
      const lines = raw.split(/\r?\n/).map(line => line.trim()).filter(Boolean);
      if (!lines.length) continue;
      const informative = lines.find(line => /(?:Error|ERR_|Exception|Cannot find|failed|ENOENT|EACCES)/i.test(line)) ?? lines[0];
      return informative.length > 160 ? `${informative.slice(0, 159)}…` : informative;
    }
    return undefined;
  }
  /** 回合摘要(最旧在前):轨迹页从第一回合起正向翻页,事件懒加载走 turnTrace。 */

export function turnSummaries(store, id, { after, limit = 5 } = {}) {
    const conversation = store.get("SELECT id FROM conversations WHERE id=? AND context!='private'", id);
    if (!conversation) return null;
    // 多取一条探测后续页,有更多才给游标,前端不出现"点了却没内容"的空翻页。
    // ordinal 是全会话稳定序号(最旧=1);游标用回合 id,同 created 由 rowid 决胜不漏不重。
    const rows = store.all(`SELECT t.id,t.state,t.created,t.ended,
        (SELECT COUNT(*) FROM turns older WHERE older.conversation_id=t.conversation_id
           AND (older.created<t.created OR (older.created=t.created AND older.rowid<=t.rowid))) AS ordinal,
        COUNT(h.seq) AS eventCount,COALESCE(MIN(h.seq),0) AS firstSeq,COALESCE(MAX(h.seq),0) AS lastSeq
      FROM turns t LEFT JOIN history h ON h.turn_id=t.id
      WHERE t.conversation_id=?
        AND (? IS NULL OR t.created>(SELECT created FROM turns WHERE id=?)
             OR (t.created=(SELECT created FROM turns WHERE id=?) AND t.rowid>(SELECT rowid FROM turns WHERE id=?)))
      GROUP BY t.id ORDER BY t.created ASC, t.rowid ASC LIMIT ?`,
      conversation.id, after ?? null, after ?? null, after ?? null, after ?? null, limit + 1);
    // 游离事件:无回合归属的宿主输出(目前只有会话轮换),量小,随摘要一并返回。
    const unaffiliated = store.all('SELECT * FROM history WHERE conversation_id=? AND turn_id IS NULL ORDER BY seq LIMIT 200', conversation.id);
    const hasMore = rows.length > limit;
    const turns = rows.slice(0, limit).map((row) => {
      if (row.state !== 'failed') return row;
      const errorSummary = turnErrorSummary(store, row.id);
      return errorSummary ? { ...row, errorSummary } : row;
    });
    return {
      turns,
      unaffiliated,
      nextAfter: hasMore ? rows[limit - 1].id : null,
    };
  }

export function turnTrace(store, id, after = 0) {
    // host 随回合返回:执行者的宿主决定前端按哪套 schema 解释事件,调用方不该
    // 再从会话列表反推(那张列表按需加载,不加载时轨迹会全部降级成未识别)。
    const turn = store.get(`SELECT t.*,c.group_id,c.member_id,c.panel_agent_id,c.context,c.peer,
        COALESCE(m.host,p.host) AS host
      FROM turns t JOIN conversations c ON c.id=t.conversation_id
      LEFT JOIN members m ON m.id=c.member_id
      LEFT JOIN panel_agents p ON p.id=c.panel_agent_id
      WHERE t.id=? AND c.context!='private'`, id);
    if (!turn) return null;
    const events = store.all('SELECT * FROM history WHERE turn_id=? AND seq>? ORDER BY seq LIMIT 200', id, after);
    const observations = modelObservations(store.all('SELECT seq,turn_id,created,event FROM history WHERE turn_id=? ORDER BY seq', id));
    // 事件接口按页返回,回合本身可能有几万条。状态与结束时间是回合级事实,
    // 不能从"这一页的事件"推导——超长回合的 turn_end 可能永远不在这 200 条里。
    const eventCount = store.get('SELECT COUNT(*) AS count FROM history WHERE turn_id=?', id)?.count ?? 0;
    return {
      turn: {
        id: turn.id,
        endpoint_id: turn.conversation_id,
        session: turn.session,
        created: turn.created,
        ended: turn.ended ?? null,
        state: turn.state,
        group_id: turn.group_id,
        member_id: turn.executor_kind === 'panel_agent' ? turn.panel_agent_id : turn.member_id,
        context: turn.context,
        peer: turn.peer ?? null,
        host: turn.host ?? null,
      },
      /** 该回合的事件总数;events 只含本页,二者不等即表示被截断。 */
      eventCount,
      nativeTurnRefs: store.all('SELECT ref FROM native_turn_refs WHERE turn_id=? ORDER BY rowid', id).map(row => row.ref),
      inputMessages: store.all('SELECT m.id,m.kind,i.ordinal FROM turn_inputs i JOIN messages m ON m.id=i.message_id WHERE i.turn_id=? ORDER BY i.ordinal', id),
      outgoingMessages: store.all('SELECT message_id,event_seq,call_id,native_call_id FROM message_origins WHERE turn_id=? ORDER BY rowid', id),
      ...deriveCurrentModel(observations),
      modelObservations: observations,
      events,
      nextAfter: events.at(-1)?.seq ?? after,
    };
  }
