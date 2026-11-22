import { chooseDirectory } from '../directory.mjs';
import { desktopApplicationStatus, detectDesktopApplications, verifyDesktopApplication, disableDesktopApplication, enableDesktopApplication, removeDesktopApplication, installDesktopIntegration } from '../../desktop/index.mjs';

export function desktopRoutes(context) {
    const { bus, url, request, response, fail, readJsonBody } = context;
    const hostInstallMatch = url.pathname.match(/^\/api\/hosts\/([^/]+)\/install$/);
    return [
        { methods: ['GET'], archived: false, matches: url => url.pathname === '/api/hosts/connections', handle: async () =>
            [...bus.hosts].map(([name, host]) => ({ name, ...(host.connectionStatus?.() ?? { status: 'unchecked' }) })) },
        { methods: ['POST'], archived: false, matches: url => url.pathname === '/api/hosts/probe', handle: async () => {
            if (!(request.headers['content-type'] ?? '').startsWith('application/json')) return fail(415, '需要 application/json');
            const body = await readJsonBody(request);
            if (!body || typeof body !== 'object' || Array.isArray(body) || Object.keys(body).some(key => key !== 'host')) return fail(400, '检测参数无效');
            if (body.host !== undefined && !bus.hosts.has(body.host)) return fail(400, '宿主未配置');
            return Promise.all([...bus.hosts].filter(([name]) => body.host === undefined || body.host === name).map(async ([name, host]) => {
                try { return { name, ...await (host.probeConnection?.() ?? Promise.resolve({ status: 'error', reason: '该适配器不支持通信检测' })) }; }
                catch (error) { return { name, status: 'error', reason: error.message }; }
            }));
        } },
        // 桌面应用集成(计划 §3):一行一个应用的用户可见结论,诊断按检查项展开。
        { methods: ['GET'], archived: false, matches: url => url.pathname === '/api/desktop/applications', handle: async () =>
            desktopApplicationStatus(bus.store) },
        { methods: ['POST'], archived: false, matches: url => url.pathname === '/api/desktop/detect', handle: async () => {
            await detectDesktopApplications(bus.store);
            return desktopApplicationStatus(bus.store);
        } },
        { methods: ['POST'], archived: false, matches: url => url.pathname === '/api/desktop/verify', handle: async () => {
            if (!(request.headers['content-type'] ?? '').startsWith('application/json')) return fail(415, '需要 application/json');
            const body = await readJsonBody(request);
            if (!body || typeof body.kind !== 'string') return fail(400, '需要应用类型');
            return verifyDesktopApplication(bus.store, body.kind, { confirmed: body.confirmed === true, socketPath: bus.controlSocketPath });
        } },
        { methods: ['POST'], archived: false, matches: url => url.pathname === '/api/desktop/install', handle: async () => {
            if (!(request.headers['content-type'] ?? '').startsWith('application/json')) return fail(415, '需要 application/json');
            const body = await readJsonBody(request);
            if (!body || typeof body.kind !== 'string') return fail(400, '需要应用类型');
            const result = await installDesktopIntegration(bus.store, body.kind, { socketPath: bus.controlSocketPath });
            await bus.syncDesktopHosts?.();
            return result;
        } },
        { methods: ['POST'], archived: false, matches: url => url.pathname === '/api/desktop/disable', handle: async () => {
            if (!(request.headers['content-type'] ?? '').startsWith('application/json')) return fail(415, '需要 application/json');
            const body = await readJsonBody(request);
            if (!body || typeof body.kind !== 'string') return fail(400, '需要应用类型');
            return disableDesktopApplication(bus.store, body.kind, { reason: typeof body.reason === 'string' ? body.reason : null });
        } },
        { methods: ['POST'], archived: false, matches: url => url.pathname === '/api/desktop/enable', handle: async () => {
            if (!(request.headers['content-type'] ?? '').startsWith('application/json')) return fail(415, '需要 application/json');
            const body = await readJsonBody(request);
            if (!body || typeof body.kind !== 'string') return fail(400, '需要应用类型');
            return enableDesktopApplication(bus.store, body.kind);
        } },
        { methods: ['POST'], archived: false, matches: url => url.pathname === '/api/desktop/remove', handle: async () => {
            if (!(request.headers['content-type'] ?? '').startsWith('application/json')) return fail(415, '需要 application/json');
            const body = await readJsonBody(request);
            if (!body || typeof body.kind !== 'string') return fail(400, '需要应用类型');
            const result = removeDesktopApplication(bus.store, body.kind);
            await bus.syncDesktopHosts?.();
            return result;
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
                const controller = new AbortController();
                // request 的 close 在请求体读完时就会触发，无法区分“页面取消”和“请求正常结束”；
                // response 的 close 才代表连接提前断开（正常返回时 finally 已移除监听）。
                const onClose = () => { if (!response.writableEnded) controller.abort(); };
                response.on('close', onClose);
                try {
                    value = await chooseDirectory({ signal: controller.signal });
                    return value;
                } catch (error) {
                    if (error?.name !== 'AbortError') throw error;
                    if (response.writableEnded || response.destroyed) return undefined;
                    return fail(499, '文件夹选择已取消');
                } finally {
                    response.off('close', onClose);
                }
            } },
    ];
}
