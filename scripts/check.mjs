import { readdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
function check(directory) {
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const path = resolve(directory, entry.name);
    if (entry.isDirectory()) check(path);
    else if (/\.(mjs|js)$/.test(path)) { const result = spawnSync(process.execPath, ['--check', path], { stdio: 'inherit' }); if (result.status) process.exit(result.status); }
  }
}
for (const directory of ['src', 'web', 'test', 'scripts']) check(directory);
console.log('Syntax checks passed');
