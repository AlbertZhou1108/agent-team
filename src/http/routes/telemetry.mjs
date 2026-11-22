import { telemetryOverview } from '../../telemetry-overview.mjs';

export function telemetryRoutes(context) {
    const { bus, url, failJson } = context;
    return [
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
    ];
}
