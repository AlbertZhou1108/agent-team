import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

export const DSH_CREDENTIALS_PATH = join(homedir(), '.dsh', '.credentials.yaml');

/**
 * DSH 的 headless profile 禁用凭据服务，API key 只能从启动环境注入。
 * 这里从本机 ~/.dsh/.credentials.yaml 读 DEEPSEEK_API_KEY。
 * 只读、不打印内容；读取失败或字段缺失时返回 null，交由调用方保持原环境。
 */
export function readDshApiKey(path = DSH_CREDENTIALS_PATH) {
  try {
    const text = readFileSync(path, 'utf8');
    const match = /^\s*DEEPSEEK_API_KEY:\s*"?([^"\s]+)"?/m.exec(text);
    return match?.[1] ?? null;
  } catch {
    return null;
  }
}

/**
 * 返回用于派生 DSH 子进程的环境：已有 DEEPSEEK_API_KEY 时原样保留，
 * 否则从本机凭据文件补齐。不修改传入对象，不打印 key。
 */
export function dshProcessEnv(baseEnv = process.env, credentialsPath = DSH_CREDENTIALS_PATH) {
  if (baseEnv.DEEPSEEK_API_KEY) return baseEnv;
  const key = readDshApiKey(credentialsPath);
  return key ? { ...baseEnv, DEEPSEEK_API_KEY: key } : baseEnv;
}
