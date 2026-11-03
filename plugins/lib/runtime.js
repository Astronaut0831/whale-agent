/** Shared runtime state reader: target session + memory token, outside profile YAML. */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const repoRoot = fileURLToPath(new URL('../..', import.meta.url));

export function runtimeFile(config = {}) {
  if (config.runtimeFile) return path.resolve(String(config.runtimeFile));
  if (process.env.WHALE_RUNTIME_FILE) return path.resolve(process.env.WHALE_RUNTIME_FILE);
  return fileURLToPath(new URL('../../data/runtime.json', import.meta.url));
}

export function readRuntime(config = {}) {
  try {
    const file = runtimeFile(config);
    return JSON.parse(fs.readFileSync(file, 'utf8').replace(/^\uFEFF/, '')) || {};
  } catch {
    return {};
  }
}

export function resolveTarget(config = {}) {
  const direct = String(config.targetSessionId || '');
  if (direct) return direct;
  const rt = readRuntime(config);
  return String(rt.guiSessionId || '');
}

export function resolveMemoryToken(config = {}) {
  const direct = String(config.token || '');
  if (direct) return direct;
  const rt = readRuntime(config);
  return String(rt.memoryToken || '');
}
