export function settingsRoutes(context) {
    const { bus, url, request, fail, readJsonBody, response } = context;
    return [
        { methods: ['GET'], archived: false, matches: url => url.pathname === '/api/service', handle: async () => context.serviceInfo() },
        { methods: ['POST'], archived: false, matches: url => url.pathname === '/api/service/stop', handle: async () => {
            if (!(request.headers['content-type'] ?? '').startsWith('application/json')) return fail(415, '需要 application/json');
            const body = await readJsonBody(request);
            if (!body || typeof body !== 'object' || Array.isArray(body) || Object.keys(body).length) return fail(400, '停止服务不接受参数');
            response.once('finish', () => context.stopService());
            return { stopping: true };
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
        { methods: ["GET"], archived: false, matches: url => (url.pathname === '/api/model-policy/defaults'), handle: async () => { let value; value = bus.queryDefaults(); return value; } },
        { methods: ["GET"], archived: false, matches: url => (url.pathname === '/api/model-policy'), handle: async () => { let value; value = bus.modelPolicy(); return value; } },
        { methods: ["GET"], archived: false, matches: url => (url.pathname === '/api/model-policy/presets'), handle: async () => { let value; value = bus.modelPolicyPresets(); return value; } },
        { methods: ["GET"], archived: false, matches: url => (url.pathname === '/api/theme-packs'), handle: async () => { let value; value = bus.themePacks(); return value; } },
        { methods: ["GET"], archived: false, matches: url => (url.pathname === '/api/model-catalog'), handle: async () => { let value; value = await bus.modelCatalog({ refresh: url.searchParams.get('refresh') === '1', host: url.searchParams.get('host') || undefined }); return value; } },
    ];
}
