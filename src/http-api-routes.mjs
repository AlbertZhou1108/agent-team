import { searchWorkspace, homeWorkbench } from './productivity.mjs';
import { telemetryOverview } from './telemetry-overview.mjs';
import { chooseDirectory } from './directory-picker.mjs';
import { interactionView } from './bus.mjs';
import { attachmentError, ATTACHMENT_IMAGE_TYPES } from './attachments.mjs';
// Each declaration owns matching, allowed methods, archived access and dispatch.

// 附件路由的状态码映射:错误 JSON 统一为稳定 {code,error},前端只展示 error。
const ATTACHMENT_STATUS = {
    payload_too_large: 413,
    unsupported_media_type: 415,
    invalid_content: 422,
    invalid_request: 400,
    not_found: 404,
    conflict: 409,
    attachment_missing: 422,
    storage_unavailable: 500,
};

function writeAttachmentJson(response, status, payload) {
    if (response.headersSent || response.writableEnded) return;
    response.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' });
    response.end(JSON.stringify(payload));
}

function writeAttachmentError(response, error) {
    const status = ATTACHMENT_STATUS[error?.code] ?? 500;
    writeAttachmentJson(response, status, { code: error?.code ?? 'internal_error', error: error?.message ?? '附件处理失败' });
}

export function apiRoutes(context) {
    const { bus, url, request, fail, failJson, readJsonBody, cursor, response, panelEventStreams } = context;
    const teamEventsMatch = url.pathname.match(/^\/api\/teams\/([^/]+)\/events$/);
    const directiveMatch = url.pathname.match(/^\/api\/teams\/([^/]+)\/directives$/);
    const hostInstallMatch = url.pathname.match(/^\/api\/hosts\/([^/]+)\/install$/);
    const isDirectiveMutation = request.method === 'POST';
    return [
        { methods: ['GET'], archived: false, matches: url => url.pathname === '/api/search', handle: async () => searchWorkspace(bus, url.searchParams) },
        { methods: ['GET'], archived: false, matches: url => url.pathname === '/api/workbench', handle: async () => homeWorkbench(bus) },
        { methods: ['GET'], archived: false, matches: url => url.pathname === '/api/panel-agent/events', handle: async () => {
                panelEventStreams.add(response);
                response.writeHead(200, {
                    'Content-Type': 'text/event-stream; charset=utf-8',
                    Connection: 'keep-alive',
                    'X-Accel-Buffering': 'no',
                });
                response.write(': connected\n\n');
                const send = event => {
                    if (!response.writableEnded) {
                        response.write(`event: panel-stream\ndata: ${JSON.stringify(event)}\n\n`);
                    }
                };
                const active = bus.panelStreaming();
                send({ type: 'snapshot', streams: active });
                bus.on('panel-stream', send);
                const heartbeat = setInterval(() => {
                    if (!response.writableEnded)
                        response.write(': heartbeat\n\n');
                }, 15000);
                heartbeat.unref();
                const cleanup = () => {
                    clearInterval(heartbeat);
                    bus.off('panel-stream', send);
                    panelEventStreams.delete(response);
                };
                request.once('close', cleanup);
                response.once('close', cleanup);
                return;
            } },
        { methods: ['GET'], archived: false, matches: url => /^\/api\/teams\/([^/]+)\/events$/.test(url.pathname), handle: async () => {
                const groupId = decodeURIComponent(teamEventsMatch[1]);
                bus.store.group(groupId);
                panelEventStreams.add(response);
                response.writeHead(200, {
                    'Content-Type': 'text/event-stream; charset=utf-8',
                    Connection: 'keep-alive',
                    'X-Accel-Buffering': 'no',
                });
                response.write(': connected\n\n');
                const send = event => {
                    if (response.writableEnded)
                        return;
                    if (event.type === 'snapshot') {
                        response.write(`event: team-stream\ndata: ${JSON.stringify(event)}\n\n`);
                        return;
                    }
                    if (event.stream?.groupId !== groupId)
                        return;
                    response.write(`event: team-stream\ndata: ${JSON.stringify(event)}\n\n`);
                };
                const active = bus.teamStreaming(groupId);
                if (active.length)
                    send({ type: 'snapshot', streams: active });
                bus.on('team-stream', send);
                const heartbeat = setInterval(() => {
                    if (!response.writableEnded)
                        response.write(': heartbeat\n\n');
                }, 15000);
                heartbeat.unref();
                const cleanup = () => {
                    clearInterval(heartbeat);
                    bus.off('team-stream', send);
                    panelEventStreams.delete(response);
                };
                request.once('close', cleanup);
                response.once('close', cleanup);
                return;
            } },
        { methods: ["POST"], archived: false, matches: url => (/^\/api\/hosts\/([^/]+)\/install$/.test(url.pathname)), handle: async () => {
                let value;
                if (!(request.headers['content-type'] ?? '').toLowerCase().startsWith('application/json'))
                    return fail(415, '需要 application/json');
                const body = await readJsonBody(request);
                if (!body || typeof body !== 'object' || Array.isArray(body) || Object.keys(body).length)
                    return fail(400, '安装不接受命令或脚本参数');
                const name = decodeURIComponent(hostInstallMatch[1]);
                const host = bus.hosts.get(name);
                if (!host)
                    return fail(404, '宿主未配置');
                if (!host.install)
                    return fail(400, '该适配器不支持自动安装');
                value = { name, ...await host.install() };
                return value;
            } },
        { methods: ["GET"], archived: false, matches: url => (url.pathname === '/api/hosts/installations'), handle: async () => {
                let value;
                value = [...bus.hosts].map(([name, host]) => ({ name, ...(host.installationStatus?.() ?? { installing: false }) }));
                return value;
            } },
        { methods: ["GET"], archived: false, matches: url => (url.pathname === '/api/hosts'), handle: async () => {
                let value;
                value = await Promise.all([...bus.hosts].map(async ([name, host]) => {
                    try {
                        return { name, ...await (host.checkStatus?.() ?? { status: 'error', reason: '该适配器未提供状态检查' }) };
                    }
                    catch (error) {
                        return { name, status: 'error', reason: error.message };
                    }
                }));
                return value;
            } },
        { methods: ["POST"], archived: false, matches: url => (url.pathname === '/api/local/directory-picker'), handle: async () => {
                let value;
                if (!(request.headers['content-type'] ?? '').toLowerCase().startsWith('application/json'))
                    return fail(415, '需要 application/json');
                const body = await readJsonBody(request);
                if (!body || typeof body !== 'object' || Array.isArray(body) || Object.keys(body).length)
                    return fail(400, '文件夹选择不接受路径或脚本参数');
                value = await chooseDirectory();
                return value;
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
        { methods: ["POST"], archived: false, matches: url => (url.pathname === '/api/model-policy' || url.pathname === '/api/model-policy/presets' || /^\/api\/model-policy\/presets\/[^/]+\/(?:rename|save|delete)$/.test(url.pathname)), handle: async () => {
                let value;
                if (!(request.headers['content-type'] ?? '').toLowerCase().startsWith('application/json'))
                    return fail(415, '需要 application/json');
                const body = await readJsonBody(request);
                const presetMatch = url.pathname.match(/^\/api\/model-policy\/presets\/([^/]+)\/(rename|save|delete)$/);
                if (url.pathname === '/api/model-policy') {
                    value = bus.updateModelPolicy({ mode: body.mode, rules: body.rules, presetId: body.presetId });
                }
                else if (url.pathname === '/api/model-policy/presets') {
                    value = bus.createModelPolicyPreset(body);
                }
                else if (presetMatch) {
                    const id = decodeURIComponent(presetMatch[1]);
                    value = presetMatch[2] === 'rename'
                        ? bus.renameModelPolicyPreset(id, body.name)
                        : presetMatch[2] === 'save'
                            ? bus.saveModelPolicyPreset(id, body)
                            : bus.deleteModelPolicyPreset(id);
                }
                return value;
            } },
        { methods: ["POST"], archived: false, matches: url => (url.pathname === '/api/theme-packs' || /^\/api\/theme-packs\/[^/]+\/delete$/.test(url.pathname)), handle: async () => {
                let value;
                if (!(request.headers['content-type'] ?? '').toLowerCase().startsWith('application/json'))
                    return fail(415, '需要 application/json');
                const body = await readJsonBody(request);
                const themeDeleteMatch = url.pathname.match(/^\/api\/theme-packs\/([^/]+)\/delete$/);
                if (themeDeleteMatch) {
                    value = bus.deleteThemePack(decodeURIComponent(themeDeleteMatch[1]));
                }
                else {
                    value = bus.createThemePack(body);
                }
                return value;
            } },
        { methods: ["GET", "POST"], archived: false, matches: url => (url.pathname === '/api/settings/attachments'), handle: async () => {
                let value;
                if (request.method === 'POST') {
                    if (!(request.headers['content-type'] ?? '').toLowerCase().startsWith('application/json'))
                        return fail(415, '需要 application/json');
                    value = bus.updateAttachmentSettings(await readJsonBody(request));
                }
                else
                    value = bus.attachmentSettings();
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
        { methods: ["POST"], archived: false, matches: url => (/^\/api\/panel-agent(?:\/(?:update|messages|stop|resolve-runtime))?$/.test(url.pathname) || /^\/api\/interactions\/[^/]+\/answer$/.test(url.pathname) || /^\/api\/teams\/[^/]+\/(?:takeover|handback)$/.test(url.pathname) || /^\/api\/teams\/[^/]+\/members\/[^/]+\/model$/.test(url.pathname)), handle: async () => {
                let value;
                if (!(request.headers['content-type'] ?? '').toLowerCase().startsWith('application/json'))
                    return fail(415, '需要 application/json');
                const body = await readJsonBody(request);
                if (url.pathname === '/api/panel-agent')
                    value = await bus.createPanelAgent(body);
                else if (url.pathname === '/api/panel-agent/update')
                    value = await bus.updatePanelAgent(body);
                else if (url.pathname === '/api/panel-agent/messages') {
                    // clientMessageId 缺省保持旧客户端兼容;带 ID 时按幂等语义回放或 409。
                    try {
                        value = await bus.panelPrivateTurn({
                            text: body.text,
                            activeTeamId: body.activeTeamId ?? null,
                            clientMessageId: body.clientMessageId ?? null,
                            attachmentIds: Array.isArray(body.attachmentIds) ? body.attachmentIds : [],
                        });
                    } catch (error) {
                        if (error?.code) {
                            writeAttachmentError(response, error);
                            return;
                        }
                        throw error;
                    }
                }
                else if (url.pathname === '/api/panel-agent/stop')
                    value = await bus.stopPanel();
                else if (url.pathname === '/api/panel-agent/resolve-runtime')
                    value = bus.resolvePanelRuntime(body.turnId, body.reason);
                else {
                    const teamMatch = url.pathname.match(/^\/api\/teams\/([^/]+)\/(takeover|handback)$/);
                    const interactionMatch = url.pathname.match(/^\/api\/interactions\/([^/]+)\/answer$/);
                    const memberModelMatch = url.pathname.match(/^\/api\/teams\/([^/]+)\/members\/([^/]+)\/model$/);
                    if (teamMatch) {
                        const groupId = decodeURIComponent(teamMatch[1]);
                        value = teamMatch[2] === 'takeover'
                            ? bus.takeoverTeam(groupId, body.revision)
                            : bus.handbackTeam(groupId, body.revision);
                    }
                    else if (interactionMatch) {
                        value = bus.decideInteraction(decodeURIComponent(interactionMatch[1]), body.answer);
                    }
                    else if (memberModelMatch) {
                        value = await bus.setMemberModel(decodeURIComponent(memberModelMatch[1]), decodeURIComponent(memberModelMatch[2]), body);
                    }
                    else
                        return fail(404, 'Not found');
                }
                return value;
            } },
        { methods: ["POST"], archived: false, matches: url => (url.pathname === '/api/panel-agent/attachments'), handle: async () => {
                // 上传:原始字节流直达附件模块,不经 readJsonBody;响应由本路由自行写入。
                const panelAgent = bus.panelAgent();
                if (!panelAgent) {
                    writeAttachmentError(response, attachmentError('not_found', 'Panel Agent 未创建'));
                    return;
                }
                let name;
                try {
                    const header = request.headers['x-agent-team-filename'];
                    if (typeof header !== 'string' || !header) throw attachmentError('invalid_request', '缺少 X-Agent-Team-Filename 头');
                    name = decodeURIComponent(header);
                } catch (error) {
                    writeAttachmentError(response, error?.code ? error : attachmentError('invalid_request', 'X-Agent-Team-Filename 必须是百分号编码的文件名'));
                    return;
                }
                try {
                    // 类型由服务端按文件扩展名判定;Content-Type 头仅作参考,不再参与校验。
                    const uploaded = await bus.attachmentUpload(panelAgent.id, request, { name });
                    if (response.headersSent) return;
                    response.writeHead(201, { 'Content-Type': 'application/json; charset=utf-8' });
                    response.end(JSON.stringify(uploaded));
                } catch (error) {
                    writeAttachmentError(response, error);
                }
                return;
            } },
        { methods: ["GET"], archived: false, matches: url => /^\/api\/panel-agent\/attachments\/[^/]+$/.test(url.pathname), handle: async () => {
                // 下载/预览:图片 inline,文本 attachment;始终 nosniff,不执行上传内容。
                const panelAgent = bus.panelAgent();
                if (!panelAgent) {
                    writeAttachmentError(response, attachmentError('not_found', 'Panel Agent 未创建'));
                    return;
                }
                const id = url.pathname.split('/').pop();
                try {
                    const attachment = bus.attachmentRead(panelAgent.id, id);
                    const isImage = Object.hasOwn(ATTACHMENT_IMAGE_TYPES, attachment.mediaType);
                    const asciiName = attachment.name.replace(/[^\x20-\x7e]/g, '_').replace(/["\\]/g, '_');
                    response.writeHead(200, {
                        'Content-Type': isImage ? attachment.mediaType : 'text/plain; charset=utf-8',
                        'Content-Length': attachment.size,
                        'Content-Disposition': `${isImage ? 'inline' : 'attachment'}; filename="${asciiName}"; filename*=UTF-8''${encodeURIComponent(attachment.name)}`,
                    });
                    attachment.stream.on('error', () => response.destroy());
                    response.on('close', () => attachment.stream.destroy());
                    attachment.stream.pipe(response);
                } catch (error) {
                    writeAttachmentError(response, error);
                }
                return;
            } },
        { methods: ["DELETE"], archived: false, matches: url => /^\/api\/panel-agent\/attachments\/[^/]+$/.test(url.pathname), handle: async () => {
                // 删除:只允许未发送草稿;已绑定或不存在统一 404。
                const panelAgent = bus.panelAgent();
                if (!panelAgent) {
                    writeAttachmentError(response, attachmentError('not_found', 'Panel Agent 未创建'));
                    return;
                }
                const id = url.pathname.split('/').pop();
                try {
                    bus.attachmentDiscard(panelAgent.id, id);
                    response.writeHead(204);
                    response.end();
                } catch (error) {
                    writeAttachmentError(response, error);
                }
                return;
            } },
        { methods: ["GET"], archived: false, matches: url => (url.pathname === '/api/telemetry/overview'), handle: async () => {
                let value;
                value = telemetryOverview(bus, { from: url.searchParams.get('from') || undefined, to: url.searchParams.get('to') || undefined, bucket: url.searchParams.get('bucket') || 'day', host: url.searchParams.get('host') || undefined, model: url.searchParams.get('model') || undefined, team: url.searchParams.get('team') || undefined });
                return value;
            } },
        { methods: ["GET"], archived: false, matches: url => (url.pathname.startsWith('/api/telemetry/')), handle: async () => {
                let value;
                try {
                    const group = url.searchParams.get('group');
                    if (!group || !group.trim())
                        throw Object.assign(new Error('缺少 group 参数'), { status: 400 });
                    const options = {
                        from: url.searchParams.get('from') || null,
                        to: url.searchParams.get('to') || null,
                        cursor: url.searchParams.get('cursor'),
                        limit: url.searchParams.get('limit') ?? 20,
                    };
                    if (url.pathname === '/api/telemetry/conversation') {
                        const member = url.searchParams.get('member');
                        const peer = url.searchParams.get('peer');
                        if (!member || !peer)
                            throw Object.assign(new Error('缺少 member 或 peer 参数'), { status: 400 });
                        value = bus.telemetryConversation(group, member, peer, options);
                    }
                    else if (url.pathname === '/api/telemetry/manager-conversation') {
                        const member = url.searchParams.get('member');
                        if (!member || !member.trim())
                            throw Object.assign(new Error('缺少 member 参数'), { status: 400 });
                        value = bus.telemetryManagerConversation(group, member, options);
                    }
                    else if (url.pathname === '/api/telemetry/coordination') {
                        value = bus.telemetryCoordination(group, options);
                    }
                    else if (url.pathname === '/api/telemetry/members') {
                        value = bus.telemetryMembers(group, options);
                    }
                    else if (url.pathname === '/api/telemetry/capabilities') {
                        value = bus.telemetryCapabilities(group);
                    }
                    else {
                        return failJson(404, new Error('Not found'));
                    }
                }
                catch (error) {
                    return failJson(error.status ?? 500, error);
                }
                return value;
            } },
        { methods: ["GET"], archived: false, matches: url => (url.pathname === '/api/groups'), handle: async () => { let value; value = url.searchParams.get('archived') === '1' ? bus.store.all("SELECT id,name,workspace,state,created,lead FROM groups WHERE state='archived' ORDER BY created") : bus.store.all("SELECT * FROM groups WHERE state IS NULL OR state!='archived' ORDER BY created"); return value; } },
        { methods: ["GET"], archived: false, matches: url => (url.pathname === '/api/directory'), handle: async () => { let value; value = bus.queryDirectory(); return value; } },
        { methods: ["GET"], archived: false, matches: url => (url.pathname === '/api/model-policy/defaults'), handle: async () => { let value; value = bus.queryDefaults(); return value; } },
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
        { methods: ["GET"], archived: false, matches: url => (url.pathname === '/api/agent-tasks'), handle: async () => { let value; const group = bus.store.group(url.searchParams.get('group')); value = bus.agentTasksView(group.id); return value; } },
        { methods: ["GET"], archived: false, matches: url => (url.pathname === '/api/panel-agent/unread'), handle: async () => { let value; value = bus.queryUnread(true); return value; } },
        { methods: ["GET"], archived: false, matches: url => (url.pathname === '/api/overview'), handle: async () => { let value; value = bus.overview(); return value; } },
        { methods: ["GET"], archived: false, matches: url => (url.pathname === '/api/snapshot'), handle: async () => { let value; value = bus.snapshot(url.searchParams.get('scoped') === '1' ? url.searchParams.get('group') || '' : undefined); return value; } },
        { methods: ["GET"], archived: false, matches: url => (url.pathname === '/api/panel-agent'), handle: async () => { let value; value = bus.panelBrowserState(url.searchParams.get('summary') === '1'); return value; } },
        { methods: ["GET"], archived: false, matches: url => (url.pathname === '/api/panel-agent/records'), handle: async () => { let value; value = bus.panelMessagePage({ history: url.searchParams.get('history') === '1', before: Number(url.searchParams.get('before')) || 0 }); return value; } },
        { methods: ["GET"], archived: false, matches: url => (url.pathname === '/api/panel-agent/conversation'), handle: async () => { let value; value = bus.panelConversation(cursor(url)); return value; } },
        { methods: ["GET"], archived: false, matches: url => (url.pathname === '/api/panel-agent/teams'), handle: async () => { let value; value = bus.panelTeamViews(); return value; } },
        { methods: ["GET"], archived: false, matches: url => (url.pathname === '/api/model-policy'), handle: async () => { let value; value = bus.modelPolicy(); return value; } },
        { methods: ["GET"], archived: false, matches: url => (url.pathname === '/api/model-policy/presets'), handle: async () => { let value; value = bus.modelPolicyPresets(); return value; } },
        { methods: ["GET"], archived: false, matches: url => (url.pathname === '/api/theme-packs'), handle: async () => { let value; value = bus.themePacks(); return value; } },
        { methods: ["GET"], archived: false, matches: url => (url.pathname === '/api/model-catalog'), handle: async () => { let value; value = await bus.modelCatalog({ refresh: url.searchParams.get('refresh') === '1' }); return value; } },
        { methods: ["GET"], archived: false, matches: url => (url.pathname === '/api/collaboration'), handle: async () => { let value; value = bus.groupSummary(url.searchParams.get('group')); return value; } },
        { methods: ["GET"], archived: false, matches: url => (url.pathname === '/api/interactions'), handle: async () => {
                let value;
                value = url.searchParams.get('panel') === '1'
                    ? bus.store.panelInteractions().map(row => interactionView(row))
                    : bus.store.interactions(bus.store.group(url.searchParams.get('group')).id).map(row => interactionView(row));
                return value;
            } },
        { methods: ["GET"], archived: false, matches: url => (url.pathname === '/api/charter'), handle: async () => { let value; value = bus.store.group(url.searchParams.get('group')).charter ?? null; return value; } },
        { methods: ["GET"], archived: false, matches: url => (url.pathname === '/api/messages'), handle: async () => {
                let value;
                const group = url.searchParams.get('group');
                bus.store.group(group);
                if (url.searchParams.get('latest') === '1') {
                    const endpointId = url.searchParams.get('endpoint');
                    const endpoint = endpointId ? (bus.store.get('SELECT * FROM endpoints WHERE id=? AND group_id=?', endpointId, group) ?? bus.store.get("SELECT id,panel_agent_id AS member_id,NULL AS peer FROM panel_sessions WHERE id=? AND group_id=? AND context='coordination'", endpointId, group)) : null;
                    const params = [group];
                    let where = 'group_id=?';
                    if (endpointId && !endpoint)
                        return fail(404, '不存在的团队会话');
                    if (endpoint?.peer) {
                        where += ' AND ((sender=? AND recipient=?) OR (sender=? AND recipient=?))';
                        params.push(endpoint.member_id, endpoint.peer, endpoint.peer, endpoint.member_id);
                    }
                    else if (endpoint) {
                        where += ' AND (sender=? OR recipient=?)';
                        params.push(endpoint.member_id, endpoint.member_id);
                    }
                    const before = Number(url.searchParams.get('before'));
                    if (before > 0) {
                        where += ' AND seq<?';
                        params.push(before);
                    }
                    const after = Number(url.searchParams.get('after'));
                    if (after > 0) {
                        where += ' AND seq>?';
                        params.push(after);
                        value = bus.store.all(`SELECT * FROM messages WHERE ${where} ORDER BY seq LIMIT 200`, ...params);
                    }
                    else
                        value = bus.store.all(`SELECT * FROM messages WHERE ${where} ORDER BY seq DESC LIMIT 50`, ...params).reverse();
                }
                else
                    value = bus.store.all('SELECT * FROM messages WHERE group_id=? AND seq>? ORDER BY seq LIMIT 200', group, cursor(url));
                return value;
            } },
        { methods: ["GET"], archived: false, matches: url => (url.pathname === '/api/message-trace'), handle: async () => {
                let value;
                value = bus.store.messageTrace(url.searchParams.get('message'));
                if (!value)
                    return fail(404, 'Not found');
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
                const endpoint = bus.store.get("SELECT id FROM endpoints WHERE id=? AND context!='private'", url.searchParams.get('endpoint'));
                const panelSession = endpoint ? null : bus.store.get("SELECT id FROM panel_sessions WHERE id=? AND context='coordination'", url.searchParams.get('endpoint'));
                if (!endpoint && !panelSession)
                    return fail(404, '不存在可观测的群会话');
                value = endpoint
                    ? bus.store.all('SELECT * FROM history WHERE endpoint_id=? AND seq>? ORDER BY seq LIMIT 200', endpoint.id, cursor(url))
                    : bus.store.all('SELECT * FROM panel_history WHERE session_id=? AND seq>? ORDER BY seq LIMIT 200', panelSession.id, cursor(url));
                return value;
            } }
    ];
}
