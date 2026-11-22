// 流式事件路由工厂:panel 流与团队流共用同一套 SSE 生命周期
// (连接 -> 初始快照 -> 按谓词转发 -> 心跳 -> 清理),差异只在事件名、快照来源与转发谓词。
export function createStreamRoute(context, pattern, { eventName, before = null, snapshot, forward }) {
    const { bus, url, request, response, panelEventStreams } = context;
    return {
        methods: ['GET'],
        archived: false,
        matches: probe => pattern.test(probe.pathname),
        handle: async () => {
            const capture = pattern.exec(url.pathname)?.[1];
            const param = capture ? decodeURIComponent(capture) : null;
            before?.(param);
            panelEventStreams.add(response);
            response.writeHead(200, {
                'Content-Type': 'text/event-stream; charset=utf-8',
                Connection: 'keep-alive',
                'X-Accel-Buffering': 'no',
            });
            response.write(': connected\n\n');
            const send = event => {
                if (response.writableEnded) return;
                if (event.type !== 'snapshot' && !forward(event, param)) return;
                response.write(`event: ${eventName}\ndata: ${JSON.stringify(event)}\n\n`);
            };
            send({ type: 'snapshot', streams: snapshot(param) });
            bus.on(eventName, send);
            const heartbeat = setInterval(() => {
                if (!response.writableEnded)
                    response.write(': heartbeat\n\n');
            }, 15000);
            heartbeat.unref();
            const cleanup = () => {
                clearInterval(heartbeat);
                bus.off(eventName, send);
                panelEventStreams.delete(response);
            };
            request.once('close', cleanup);
            response.once('close', cleanup);
            return;
        },
    };
}
