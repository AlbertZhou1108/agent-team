#!/usr/bin/env node
/**
 * 浏览器端性能实测:通过 Chrome DevTools Protocol 统计页面请求速率与渲染规模。
 *
 * 使用前提:一个支持 CDP 的浏览器已带远程调试端口运行(Chrome/Edge/Chromium):
 *   macOS:   "/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge" \
 *              --headless=new --disable-gpu --remote-debugging-port=9222 \
 *              --user-data-dir=/tmp/perf-browser-profile about:blank
 *   Linux:   google-chrome --headless=new --remote-debugging-port=9222 --user-data-dir=/tmp/perf-browser-profile
 *
 * 用法:
 *   node scripts/perf-browser.mjs --app http://127.0.0.1:62048 --target /groups/<id> --window 20000
 *   node scripts/perf-browser.mjs --debug http://127.0.0.1:9222 ...
 *
 * 说明:服务端只对 `/` 提供 index.html(无 SPA 深链回退),所以脚本先加载首页,
 * 再用 history.pushState + popstate 做客户端路由跳转;统计窗口内的 `/api/*` 请求。
 */
import { setTimeout as sleep } from 'node:timers/promises';

function arg(name, fallback) {
  const index = process.argv.indexOf(`--${name}`);
  return index < 0 ? fallback : process.argv[index + 1];
}

const APP = arg('app', 'http://127.0.0.1:62048');
const DEBUG = arg('debug', 'http://127.0.0.1:9222');
const TARGET = arg('target', '/');
const WINDOW_MS = Number(arg('window', 20000));

async function main() {
  let created;
  try {
    created = await fetch(`${DEBUG}/json/new?about:blank`, { method: 'PUT' }).then(response => response.json());
  } catch {
    console.error(`[perf-browser] 无法连接 ${DEBUG};请先按文件头说明启动带 --remote-debugging-port 的浏览器`);
    process.exit(1);
  }

  const socket = new WebSocket(created.webSocketDebuggerUrl);
  await new Promise((resolve, reject) => {
    socket.onopen = resolve;
    socket.onerror = reject;
  });
  let id = 0;
  const pending = new Map();
  const events = [];
  socket.onmessage = event => {
    const message = JSON.parse(event.data);
    if (message.id && pending.has(message.id)) { pending.get(message.id)(message); pending.delete(message.id); }
    else if (message.method) events.push(message);
  };
  const send = (method, params = {}) => {
    const messageId = ++id;
    socket.send(JSON.stringify({ id: messageId, method, params }));
    return new Promise(resolve => pending.set(messageId, resolve));
  };

  await send('Page.enable');
  await send('Network.enable');
  await send('Runtime.enable');
  await send('Page.navigate', { url: `${APP}/` });
  await sleep(4000);
  if (TARGET !== '/') {
    await send('Runtime.evaluate', {
      expression: `history.pushState({}, '', ${JSON.stringify(TARGET)}); window.dispatchEvent(new PopStateEvent('popstate'));`,
      awaitPromise: true,
    });
    await sleep(1500);
  }

  const start = Date.now();
  await sleep(WINDOW_MS);
  const measured = Date.now() - start;
  const requests = events.filter(event => event.method === 'Network.requestWillBeSent' && /\/api\//.test(event.params?.request?.url ?? ''));
  const byPath = {};
  for (const event of requests) {
    const path = new URL(event.params.request.url).pathname;
    byPath[path] = (byPath[path] ?? 0) + 1;
  }
  const heap = await send('Runtime.getHeapUsage').catch(() => null);
  const render = await send('Runtime.evaluate', {
    expression: `JSON.stringify({
      domNodes: document.querySelectorAll('*').length,
      chatGroups: document.querySelectorAll('.chat-message').length,
      domContentLoadedMs: performance.getEntriesByType('navigation')[0]?.domContentLoadedEventEnd ?? null,
      firstContentfulPaintMs: performance.getEntriesByName('first-contentful-paint')[0]?.startTime ?? null,
    })`,
    returnByValue: true,
  }).catch(() => null);
  const consoleErrors = events.filter(event => event.method === 'Runtime.consoleAPICalled' && event.params.type === 'error').length;

  console.log(JSON.stringify({
    app: APP,
    target: TARGET,
    windowMs: measured,
    apiRequests: requests.length,
    requestsPerSecond: Number((requests.length / (measured / 1000)).toFixed(2)),
    byPath,
    consoleErrors,
    heapUsedMB: heap?.result ? Number((heap.result.usedSize / 1024 / 1024).toFixed(1)) : null,
    render: render?.result?.result?.value ? JSON.parse(render.result.result.value) : null,
  }, null, 2));

  socket.close();
  await fetch(`${DEBUG}/json/close/${created.id}`).catch(() => {});
}

main().catch(error => {
  console.error(`[perf-browser] ${error.stack ?? error.message}`);
  process.exit(1);
});
