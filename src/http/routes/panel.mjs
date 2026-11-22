import { openResultFile } from '../files.mjs';
import { searchWorkspace, homeWorkbench, dismissWorkbench } from '../../productivity.mjs';
import { advanceReadState } from '../../read-state.mjs';
import { interactionView } from '../../bus.mjs';
import { attachmentError, ATTACHMENT_IMAGE_TYPES } from '../../attachments.mjs';
import { createStreamRoute } from './shared.mjs';

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

export function panelRoutes(context) {
    const { bus, url, request, fail, readJsonBody, cursor, response } = context;
    const streamRoute = (pattern, options) => createStreamRoute(context, pattern, options);
    return [
        { methods: ['GET'], archived: false, matches: url => url.pathname === '/api/files', handle: async () => {
            let file;
            try { file = openResultFile(bus, { group: url.searchParams.get('group'), panel: url.searchParams.get('panel') === '1', path: url.searchParams.get('path') }); }
            catch (error) { return fail(404, error.message); }
            response.writeHead(200, { 'Content-Type': 'application/octet-stream', 'Content-Length': file.size, 'Content-Disposition': `attachment; filename*=UTF-8''${encodeURIComponent(file.name).replace(/'/g, '%27')}` });
            file.stream.on('error', () => response.destroy());
            response.on('close', () => file.stream.destroy());
            file.stream.pipe(response);
        } },
        { methods: ['GET'], archived: false, matches: url => url.pathname === '/api/search', handle: async () => searchWorkspace(bus, url.searchParams) },
        { methods: ['GET'], archived: false, matches: url => url.pathname === '/api/workbench', handle: async () => homeWorkbench(bus) },
        { methods: ['POST'], archived: false, matches: url => url.pathname === '/api/workbench/summary', handle: async () => {
            if (!(request.headers['content-type'] ?? '').toLowerCase().startsWith('application/json')) return fail(415, '需要 application/json');
            await readJsonBody(request);
            return bus.panelHomeSummaryTurn();
        } },
        { methods: ['POST'], archived: false, matches: url => url.pathname === '/api/read', handle: async () => {
            if (!(request.headers['content-type'] ?? '').startsWith('application/json')) return fail(415, '需要 application/json');
            const body = await readJsonBody(request);
            if (!body || typeof body !== 'object' || Array.isArray(body) || Object.keys(body).some(key => !['scope', 'scopeId', 'seq'].includes(key))) return fail(400, '读水位参数无效');
            try { return advanceReadState(bus, body); }
            catch (error) { return fail(400, error.message); }
        } },
        { methods: ['POST'], archived: false, matches: url => url.pathname === '/api/workbench/dismiss', handle: async () => {
            if (!(request.headers['content-type'] ?? '').startsWith('application/json')) return fail(415, '需要 application/json');
            const body = await readJsonBody(request);
            if (!body || typeof body !== 'object' || Array.isArray(body) || Object.keys(body).some(key => key !== 'items')) return fail(400, '清理参数无效');
            try { return dismissWorkbench(bus, body.items); }
            catch (error) { return fail(400, error.message); }
        } },
        streamRoute(/^\/api\/panel-agent\/events$/, {
            eventName: 'panel-stream',
            snapshot: () => bus.panelStreaming(),
            forward: () => true,
        }),
        { methods: ["POST"], archived: false, matches: url => (/^\/api\/panel-agent(?:\/(?:update|messages|stop|resolve-runtime|reset-session))?$/.test(url.pathname) || /^\/api\/interactions\/[^/]+\/answer$/.test(url.pathname) || /^\/api\/teams\/[^/]+\/(?:takeover|handback)$/.test(url.pathname) || /^\/api\/teams\/[^/]+\/members\/[^/]+\/model$/.test(url.pathname)), handle: async () => {
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
                else if (url.pathname === '/api/panel-agent/reset-session')
                    value = bus.resetPanelPrivateSession();
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
                        value = await bus.decideInteraction(decodeURIComponent(interactionMatch[1]), body.answer);
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
        { methods: ["GET"], archived: false, matches: url => (url.pathname === '/api/panel-agent'), handle: async () => { let value; value = bus.panelBrowserState(url.searchParams.get('summary') === '1'); return value; } },
        { methods: ["GET"], archived: false, matches: url => (url.pathname === '/api/panel-agent/records'), handle: async () => { let value; value = bus.panelMessagePage({ history: url.searchParams.get('history') === '1', before: Number(url.searchParams.get('before')) || 0 }); return value; } },
        { methods: ["GET"], archived: false, matches: url => (url.pathname === '/api/panel-agent/conversation'), handle: async () => { let value; value = bus.panelConversation(cursor(url)); return value; } },
        { methods: ["GET"], archived: false, matches: url => (url.pathname === '/api/panel-agent/teams'), handle: async () => { let value; value = bus.panelTeamViews(); return value; } },
        { methods: ["GET"], archived: false, matches: url => (url.pathname === '/api/interactions'), handle: async () => {
                let value;
                value = url.searchParams.get('panel') === '1'
                    ? bus.store.panelInteractions().map(row => interactionView(row))
                    : bus.store.interactions(bus.store.group(url.searchParams.get('group')).id).map(row => interactionView(row));
                return value;
            } },
    ];
}
