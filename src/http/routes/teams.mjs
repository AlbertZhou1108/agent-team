import { createStreamRoute } from './shared.mjs';
import { listWorkflowTemplates } from '../../hosts/workflow-templates.mjs';
import { previewGroupTextFile } from '../../hosts/file-preview.mjs';

// 消息列表统一带上产出它的回合:一个回合可以产出多条消息,前端据此让行内
// 执行轨迹只渲染一份。用户/系统消息没有回合,列为 null。
const MESSAGE_WITH_TURN = `SELECT m.*,(SELECT o.turn_id FROM message_origins o WHERE o.message_id=m.id) AS turn_id FROM messages m`;

export function teamsRoutes(context) {
    const { bus, url, request, response, fail, failJson, readJsonBody, cursor } = context;
    const streamRoute = (pattern, options) => createStreamRoute(context, pattern, options);
    const directiveMatch = url.pathname.match(/^\/api\/teams\/([^/]+)\/directives$/);
    const isDirectiveMutation = request.method === 'POST';
    return [
        { methods: ['GET'], archived: true, matches: url => url.pathname === '/api/workflow-templates', handle: async () => listWorkflowTemplates() },
        { methods: ['GET'], archived: true, matches: url => /^\/api\/teams\/[^/]+\/worktrees$/.test(url.pathname), handle: async () => {
            const groupId = decodeURIComponent(url.pathname.split('/')[3]);
            return bus.listWorktrees(groupId);
        } },
        { methods: ['POST'], archived: false, matches: url => /^\/api\/teams\/[^/]+\/members\/[^/]+\/worktree\/merge$/.test(url.pathname), handle: async () => {
            if (!(request.headers['content-type'] ?? '').startsWith('application/json')) return fail(415, '需要 application/json');
            const body = await readJsonBody(request);
            if (!body || typeof body !== 'object' || Array.isArray(body) || Object.keys(body).length) return fail(400, '合入分支不接受额外参数');
            const match = url.pathname.match(/^\/api\/teams\/([^/]+)\/members\/([^/]+)\/worktree\/merge$/);
            try { return bus.mergeMemberWorktree(decodeURIComponent(match[1]), decodeURIComponent(match[2])); }
            catch (error) { return failJson(400, error); }
        } },
        { methods: ['POST'], archived: false, matches: url => /^\/api\/teams\/[^/]+\/members\/[^/]+\/worktree\/remove$/.test(url.pathname), handle: async () => {
            if (!(request.headers['content-type'] ?? '').startsWith('application/json')) return fail(415, '需要 application/json');
            const body = await readJsonBody(request);
            if (!body || typeof body !== 'object' || Array.isArray(body) || Object.keys(body).some(key => key !== 'force')) return fail(400, '清理参数无效');
            const match = url.pathname.match(/^\/api\/teams\/([^/]+)\/members\/([^/]+)\/worktree\/remove$/);
            try {
                const result = bus.removeMemberWorktree(decodeURIComponent(match[1]), decodeURIComponent(match[2]), { force: Boolean(body.force) });
                if (result.retained) {
                    response.writeHead(409, { 'Content-Type': 'application/json' });
                    response.end(JSON.stringify({ error: result.reason, worktree: result }));
                    return;
                }
                return result;
            } catch (error) { return failJson(400, error); }
        } },
        { methods: ['GET'], archived: true, matches: url => /^\/api\/teams\/[^/]+\/file-preview$/.test(url.pathname), handle: async () => {
            const groupId = decodeURIComponent(url.pathname.split('/')[3]);
            try {
                const group = bus.store.group(groupId);
                return previewGroupTextFile({
                    group,
                    members: bus.members(groupId),
                    filePath: url.searchParams.get('path') ?? '',
                    memberId: url.searchParams.get('memberId') || null,
                });
            } catch (error) { return failJson(error?.status ?? 400, error); }
        } },
        { methods: ['POST'], archived: true, matches: url => /^\/api\/teams\/[^/]+\/delete$/.test(url.pathname), handle: async () => {
            if (!(request.headers['content-type'] ?? '').startsWith('application/json')) return fail(415, '需要 application/json');
            const body = await readJsonBody(request);
            if (!body || typeof body !== 'object' || Array.isArray(body) || Object.keys(body).length) return fail(400, '删除团队不接受参数');
            try { return await bus.deleteGroup(decodeURIComponent(url.pathname.split('/')[3]), { archivedOnly: true }); }
            catch (error) { return failJson(400, error); }
        } },
        { methods: ['GET', 'POST'], archived: true, matches: url => /^\/api\/teams\/[^/]+\/archive-snapshot$/.test(url.pathname), handle: async () => {
            const groupId = decodeURIComponent(url.pathname.split('/')[3]);
            return request.method === 'POST' ? bus.summarizeArchive(groupId) : bus.archiveSnapshot(groupId);
        } },
        { methods: ['POST'], archived: false, matches: url => /^\/api\/teams\/[^/]+\/members\/[^/]+\/policy$/.test(url.pathname), handle: async () => {
            if (!(request.headers['content-type'] ?? '').startsWith('application/json')) return fail(415, '需要 application/json');
            const body = await readJsonBody(request);
            if (!body || typeof body !== 'object' || Array.isArray(body) || Object.keys(body).some(key => !['policyCeiling', 'allowShell', 'allowBrowser'].includes(key))) return fail(400, '权限参数无效');
            const match = url.pathname.match(/^\/api\/teams\/([^/]+)\/members\/([^/]+)\/policy$/);
            try {
                const member = await bus.applyMemberPolicy(decodeURIComponent(match[1]), decodeURIComponent(match[2]), body);
                const capabilityCard = await bus.capabilities.memberCard(bus.store.group(member.group_id), member);
                return { member: { ...member, capabilityCard } };
            } catch (error) { return failJson(400, error); }
        } },
        { methods: ['POST'], archived: false, matches: url => url.pathname === '/api/groups', handle: async () => {
            if (!(request.headers['content-type'] ?? '').startsWith('application/json')) return fail(415, '需要 application/json');
            const body = await readJsonBody(request);
            if (!body || typeof body !== 'object' || Array.isArray(body) || !body.operationId) return fail(400, '需要建群请求编号');
            if (Object.keys(body).some(key => !['operationId', 'name', 'workspace', 'lead', 'members', 'charter', 'policy', 'allowShell', 'workflowTemplate'].includes(key))) return fail(400, '未知建群参数');
            try { return bus.createGroup(body); }
            catch (error) { return failJson(400, error); }
        } },
        streamRoute(/^\/api\/teams\/([^/]+)\/events$/, {
            eventName: 'team-stream',
            before: groupId => bus.store.group(groupId),
            snapshot: groupId => bus.teamStreaming(groupId),
            forward: (event, groupId) => event.stream?.groupId === groupId,
        }),
        { methods: ['POST'], archived: false, matches: url => /^\/api\/teams\/[^/]+\/stop$/.test(url.pathname), handle: async () => {
            if (!(request.headers['content-type'] ?? '').toLowerCase().startsWith('application/json')) return fail(415, '需要 application/json');
            const body = await readJsonBody(request);
            if (!body || typeof body !== 'object' || Array.isArray(body) || Object.keys(body).some(key => key !== 'memberId')) return fail(400, '停止运行参数无效');
            const memberId = body.memberId === undefined ? null : typeof body.memberId === 'string' && body.memberId.trim() ? body.memberId.trim() : undefined;
            if (memberId === undefined) return fail(400, 'memberId 必须为非空字符串');
            const groupId = decodeURIComponent(url.pathname.split('/')[3]);
            bus.store.group(groupId);
            if (memberId) {
                const isMember = Boolean(bus.store.get('SELECT id FROM members WHERE id=? AND group_id=?', memberId, groupId));
                const isPanelAgent = bus.panelAgent()?.id === memberId;
                if (!isMember && !isPanelAgent) return fail(404, '成员不存在');
            }
            const stopped = await bus.stopWhere(endpoint => (
                endpoint.group_id === groupId
                && !['private', 'home-summary', 'archive-summary'].includes(endpoint.context)
                && (!memberId || (endpoint.owner_kind === 'panel_agent' ? endpoint.panel_agent_id : endpoint.member_id) === memberId)
            ));
            return { groupId, memberId, stopped };
        } },
        { methods: ["GET", "POST"], archived: false, matches: url => (/^\/api\/teams\/([^/]+)\/directives$/.test(url.pathname)), handle: async () => {
                let value;
                const groupId = decodeURIComponent(directiveMatch[1]);
                if (isDirectiveMutation) {
                    if (!(request.headers['content-type'] ?? '').toLowerCase().startsWith('application/json'))
                        return fail(415, '需要 application/json');
                    value = bus.teamDirectives.submit(groupId, await readJsonBody(request));
                }
                else
                    value = bus.teamDirectives.list(groupId);
                return value;
            } },
        { methods: ["POST"], archived: true, matches: url => (/^\/api\/teams\/[^/]+\/(?:archive|restore)$/.test(url.pathname)), handle: async () => {
                let value;
                if (!(request.headers['content-type'] ?? '').toLowerCase().startsWith('application/json'))
                    return fail(415, '需要 application/json');
                await readJsonBody(request);
                value = url.pathname.endsWith('/archive')
                    ? await bus.archiveGroup(decodeURIComponent(url.pathname.split('/')[3]))
                    : bus.restoreGroup(decodeURIComponent(url.pathname.split('/')[3]));
                return value;
            } },
        { methods: ["GET"], archived: false, matches: url => (url.pathname === '/api/groups'), handle: async () => { let value; value = url.searchParams.get('archived') === '1' ? bus.store.all("SELECT id,name,workspace,state,created,lead FROM groups WHERE state='archived' ORDER BY created") : bus.store.all("SELECT * FROM groups WHERE state IS NULL OR state!='archived' ORDER BY created"); return value; } },
        { methods: ['GET'], archived: false, matches: url => /^\/api\/groups\/[^/]+\/controllers$/.test(url.pathname), handle: async () => {
            const id = decodeURIComponent(url.pathname.match(/^\/api\/groups\/([^/]+)\/controllers$/)[1]);
            bus.store.group(id);
            return bus.store.controllerRelations(id);
        } },
        { methods: ["GET"], archived: false, matches: url => (url.pathname === '/api/directory'), handle: async () => { let value; value = bus.queryDirectory(); return value; } },
        { methods: ["GET"], archived: false, matches: url => (url.pathname === '/api/group'), handle: async () => {
                let value;
                const group = bus.store.group(url.searchParams.get('group'));
                bus.ensurePanelBindings();
                value = { ...group, controller: bus.teamController(group.id) };
                return value;
            } },
        { methods: ["GET"], archived: false, matches: url => (url.pathname === '/api/sessions'), handle: async () => { let value; value = bus.querySessions(url.searchParams.get('group')); return value; } },
        { methods: ["GET"], archived: false, matches: url => (url.pathname === '/api/session'), handle: async () => {
                let value;
                value = bus.querySession(url.searchParams.get('group'), url.searchParams.get('endpoint'));
                if (!value)
                    return fail(404, '不存在的团队会话');
                return value;
            } },
        { methods: ["GET"], archived: false, matches: url => (url.pathname === '/api/session-target'), handle: async () => {
                let value;
                value = bus.querySessions(url.searchParams.get('group')).endpoints.find(row => row.member_id === url.searchParams.get('member') && row.context === url.searchParams.get('context')) ?? null;
                return value;
            } },
        { methods: ["GET"], archived: false, matches: url => (url.pathname === '/api/group-runtime'), handle: async () => { let value; const group = bus.store.group(url.searchParams.get('group')); value = bus.queryRuntime(group.id); return value; } },
        { methods: ["GET"], archived: false, matches: url => (url.pathname === '/api/home-summary'), handle: async () => { let value; value = bus.queryRuntime(); return value; } },
        { methods: ["GET"], archived: false, matches: url => (url.pathname === '/api/agent-tasks'), handle: async () => { let value; const group = bus.store.group(url.searchParams.get('group')); value = bus.agentTasksPlanView(group.id); return value; } },
        { methods: ["GET"], archived: false, matches: url => (url.pathname === '/api/overview'), handle: async () => { let value; value = bus.overview(); return value; } },
        { methods: ["GET"], archived: false, matches: url => (url.pathname === '/api/snapshot'), handle: async () => { let value; value = bus.snapshot(url.searchParams.get('scoped') === '1' ? url.searchParams.get('group') || '' : undefined); return value; } },
        { methods: ["GET"], archived: false, matches: url => (url.pathname === '/api/collaboration'), handle: async () => { let value; value = bus.groupSummary(url.searchParams.get('group')); return value; } },
        { methods: ["GET"], archived: false, matches: url => (url.pathname === '/api/charter'), handle: async () => { let value; value = bus.store.group(url.searchParams.get('group')).charter ?? null; return value; } },
        { methods: ["GET"], archived: false, matches: url => (url.pathname === '/api/messages'), handle: async () => {
                let value;
                const group = url.searchParams.get('group');
                bus.store.group(group);
                if (url.searchParams.get('latest') === '1') {
                    const endpointId = url.searchParams.get('endpoint');
                    const conversation = endpointId ? bus.store.conversationById(endpointId) : null;
                    const endpoint = conversation && conversation.group_id === group
                        ? { ...conversation, member_id: conversation.member_id ?? conversation.panel_agent_id, peer: conversation.peer ?? null }
                        : null;
                    const params = [group];
                    // turn_id 让前端知道消息由哪个回合产出:一个回合可能产出多条
                    // 消息,行内执行轨迹据此只渲染一份,而不是每组各渲染一遍。
                    let where = 'm.group_id=?';
                    if (endpointId && !endpoint)
                        return fail(404, '不存在的团队会话');
                    if (endpoint?.peer) {
                        where += ' AND ((m.sender=? AND m.recipient=?) OR (m.sender=? AND m.recipient=?))';
                        params.push(endpoint.member_id, endpoint.peer, endpoint.peer, endpoint.member_id);
                    }
                    else if (endpoint) {
                        where += ' AND (m.sender=? OR m.recipient=?)';
                        params.push(endpoint.member_id, endpoint.member_id);
                    }
                    const before = Number(url.searchParams.get('before'));
                    if (before > 0) {
                        where += ' AND m.seq<?';
                        params.push(before);
                    }
                    const after = Number(url.searchParams.get('after'));
                    if (after > 0) {
                        where += ' AND m.seq>?';
                        params.push(after);
                        value = bus.store.all(`${MESSAGE_WITH_TURN} WHERE ${where} ORDER BY m.seq LIMIT 200`, ...params);
                    }
                    else
                        value = bus.store.all(`${MESSAGE_WITH_TURN} WHERE ${where} ORDER BY m.seq DESC LIMIT 50`, ...params).reverse();
                }
                else
                    value = bus.store.all(`${MESSAGE_WITH_TURN} WHERE m.group_id=? AND m.seq>? ORDER BY m.seq LIMIT 200`, group, cursor(url));
                return value;
            } },
        { methods: ["GET"], archived: false, matches: url => (url.pathname === '/api/message-trace'), handle: async () => {
                let value;
                value = bus.store.messageTrace(url.searchParams.get('message'), { segment: url.searchParams.get('segment') === '1' });
                if (!value)
                    return fail(404, 'Not found');
                return value;
            } },
        { methods: ["GET"], archived: false, matches: url => (url.pathname === '/api/turns'), handle: async () => {
                let value;
                const limitParam = Number(url.searchParams.get('limit'));
                const limit = Number.isInteger(limitParam) && limitParam >= 1 && limitParam <= 50 ? limitParam : 5;
                value = bus.store.turnSummaries(url.searchParams.get('endpoint'), {
                    after: url.searchParams.get('after') || undefined,
                    limit,
                });
                if (!value)
                    return fail(404, '不存在可观测的群会话');
                return value;
            } },
        { methods: ["GET"], archived: false, matches: url => (url.pathname === '/api/turn'), handle: async () => {
                let value;
                value = bus.store.turnTrace(url.searchParams.get('turn'), cursor(url));
                if (!value)
                    return fail(404, 'Not found');
                return value;
            } },
        { methods: ["GET"], archived: false, matches: url => (url.pathname === '/api/models'), handle: async () => {
                let value;
                value = bus.store.endpointModels(url.searchParams.get('endpoint'), cursor(url));
                if (!value)
                    return fail(404, '不存在可观测的群会话');
                return value;
            } },
        { methods: ["GET"], archived: false, matches: url => (url.pathname === '/api/history'), handle: async () => {
                let value;
                const conversation = bus.store.get("SELECT id FROM conversations WHERE id=? AND context!='private'", url.searchParams.get('endpoint'));
                if (!conversation)
                    return fail(404, '不存在可观测的群会话');
                value = bus.store.all('SELECT * FROM history WHERE conversation_id=? AND seq>? ORDER BY seq LIMIT 200', conversation.id, cursor(url));
                return value;
            } }
    ];
}
