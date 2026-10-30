import { appendFile, rename, stat } from 'node:fs/promises';
import { performance } from 'node:perf_hooks';
import { resolve } from 'node:path';

// Bounded metadata only: never log query parameters, bodies, or credentials.
export function observeResponsiveness(directory, { intervalMs = 1000, stallMs = 1000, slowMs = 2000, write } = {}) {
  const file = resolve(directory, 'responsiveness.jsonl');
  let queue = Promise.resolve();
  const record = write ?? (row => {
    const line = JSON.stringify({ at: new Date().toISOString(), ...row }) + '\n';
    queue = queue.then(async () => {
      const size = await stat(file).then(info => info.size, () => 0);
      if (size >= 5 * 1024 * 1024) await rename(file, file + '.previous');
      await appendFile(file, line, { mode: 0o600 });
    }).catch(() => {});
  });
  let expected = performance.now() + intervalMs;
  const timer = setInterval(() => {
    const now = performance.now();
    const lagMs = Math.round(now - expected);
    expected = now + intervalMs;
    if (lagMs >= stallMs) record({ type: 'event-loop-stall', lagMs });
  }, intervalMs);
  timer.unref();
  return {
    request(request, response) {
      const started = performance.now();
      const pathname = request.url?.split('?')[0] ?? '/';
      if (pathname.endsWith('/events')) return;
      let recorded = false;
      const finish = () => {
        if (recorded) return;
        recorded = true;
        const durationMs = Math.round(performance.now() - started);
        if (durationMs >= slowMs) record({ type: 'slow-request', method: request.method, path: pathname, status: response.statusCode, completed: response.writableFinished, durationMs });
      };
      response.once('finish', finish);
      response.once('close', finish);
    },
    close() { clearInterval(timer); },
  };
}
