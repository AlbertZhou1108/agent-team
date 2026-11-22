export function notesRoutes(context) {
    const { bus, url, request, fail, failJson, readJsonBody } = context;
    return [
        { methods: ['GET'], archived: false, matches: url => url.pathname === '/api/notes', handle: async () => {
            try {
                return bus.notes.list({
                    state: url.searchParams.get('state'),
                    q: url.searchParams.get('q') ?? '',
                    cursor: url.searchParams.get('cursor'),
                    limit: url.searchParams.get('limit'),
                    team: url.searchParams.get('team'),
                    tag: url.searchParams.get('tag'),
                });
            } catch (error) { return failJson(error?.status ?? 400, error); }
        } },
        { methods: ['GET'], archived: false, matches: url => url.pathname === '/api/note-tags', handle: async () => {
            try { return bus.notes.listTags(); }
            catch (error) { return failJson(error?.status ?? 400, error); }
        } },
        { methods: ['POST'], archived: false, matches: url => url.pathname === '/api/note-tags', handle: async () => {
            if (!(request.headers['content-type'] ?? '').startsWith('application/json')) return fail(415, '需要 application/json');
            const body = await readJsonBody(request);
            if (!body || typeof body !== 'object' || Array.isArray(body)) return fail(400, '标签参数无效');
            if (Object.keys(body).some(key => !['name', 'color'].includes(key))) return fail(400, '未知标签参数');
            try { return bus.notes.createTag(body); }
            catch (error) { return failJson(error?.status ?? 400, error); }
        } },
        { methods: ['POST'], archived: false, matches: url => url.pathname === '/api/notes', handle: async () => {
            if (!(request.headers['content-type'] ?? '').startsWith('application/json')) return fail(415, '需要 application/json');
            const body = await readJsonBody(request);
            if (!body || typeof body !== 'object' || Array.isArray(body)) return fail(400, '记录参数无效');
            if (Object.keys(body).some(key => !['id', 'body', 'title', 'todos', 'due', 'sourceTeamId', 'tags'].includes(key))) return fail(400, '未知记录参数');
            try { return bus.notes.create(body).note; }
            catch (error) { return failJson(error?.status ?? 400, error); }
        } },
        { methods: ['POST'], archived: false, matches: url => url.pathname === '/api/notes/prompt', handle: async () => {
            if (!(request.headers['content-type'] ?? '').startsWith('application/json')) return fail(415, '需要 application/json');
            const body = await readJsonBody(request);
            if (!body || typeof body !== 'object' || Array.isArray(body)) return fail(400, '提示词参数无效');
            if (Object.keys(body).some(key => !['ids', 'instruction'].includes(key))) return fail(400, '未知提示词参数');
            try { return bus.notes.promptMany(body.ids, { instruction: body.instruction }); }
            catch (error) { return failJson(error?.status ?? 400, error); }
        } },
        { methods: ['GET'], archived: false, matches: url => /^\/api\/notes\/[^/]+\/prompt$/.test(url.pathname), handle: async () => {
            try {
                return bus.notes.prompt(decodeURIComponent(url.pathname.split('/')[3]), {
                    instruction: url.searchParams.get('instruction') ?? '',
                });
            } catch (error) { return failJson(error?.status ?? 400, error); }
        } },
        { methods: ['GET'], archived: false, matches: url => /^\/api\/notes\/[^/]+$/.test(url.pathname), handle: async () => {
            try { return bus.notes.get(decodeURIComponent(url.pathname.split('/')[3])); }
            catch (error) { return failJson(error?.status ?? 400, error); }
        } },
        { methods: ['PATCH'], archived: false, matches: url => /^\/api\/notes\/[^/]+$/.test(url.pathname), handle: async () => {
            if (!(request.headers['content-type'] ?? '').startsWith('application/json')) return fail(415, '需要 application/json');
            const body = await readJsonBody(request);
            if (!body || typeof body !== 'object' || Array.isArray(body)) return fail(400, '记录参数无效');
            if (Object.keys(body).some(key => !['revision', 'body', 'title', 'todos', 'due', 'sourceTeamId', 'tags'].includes(key))) return fail(400, '未知记录参数');
            try { return bus.notes.update(decodeURIComponent(url.pathname.split('/')[3]), body); }
            catch (error) { return failJson(error?.status ?? 400, error); }
        } },
        { methods: ['POST'], archived: false, matches: url => /^\/api\/notes\/[^/]+\/pin$/.test(url.pathname), handle: async () => {
            if (!(request.headers['content-type'] ?? '').startsWith('application/json')) return fail(415, '需要 application/json');
            const body = await readJsonBody(request);
            if (!body || typeof body !== 'object' || Array.isArray(body)) return fail(400, '置顶参数无效');
            if (Object.keys(body).some(key => !['pinned', 'revision'].includes(key))) return fail(400, '置顶参数无效');
            try { return bus.notes.setPin(decodeURIComponent(url.pathname.split('/')[3]), body); }
            catch (error) { return failJson(error?.status ?? 400, error); }
        } },
        { methods: ['POST'], archived: false, matches: url => /^\/api\/notes\/[^/]+\/state$/.test(url.pathname), handle: async () => {
            if (!(request.headers['content-type'] ?? '').startsWith('application/json')) return fail(415, '需要 application/json');
            const body = await readJsonBody(request);
            if (!body || typeof body !== 'object' || Array.isArray(body)) return fail(400, '状态参数无效');
            if (Object.keys(body).some(key => !['state', 'revision'].includes(key))) return fail(400, '状态参数无效');
            try { return bus.notes.setState(decodeURIComponent(url.pathname.split('/')[3]), body); }
            catch (error) { return failJson(error?.status ?? 400, error); }
        } },
        { methods: ['DELETE'], archived: false, matches: url => /^\/api\/notes\/[^/]+$/.test(url.pathname), handle: async () => {
            try { return bus.notes.remove(decodeURIComponent(url.pathname.split('/')[3])); }
            catch (error) { return failJson(error?.status ?? 400, error); }
        } },
    ];
}
