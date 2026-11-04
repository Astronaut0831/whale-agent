/** Durable GUI-input job store; survives adapter restarts. */
import fs from 'node:fs';
import path from 'node:path';

export function createGuiInputStore(file, { max = 200 } = {}) {
  const jobs = new Map();

  function load() {
    try {
      const raw = JSON.parse(fs.readFileSync(file, 'utf8').replace(/^\uFEFF/, ''));
      const list = Array.isArray(raw) ? raw : Array.isArray(raw && raw.jobs) ? raw.jobs : [];
      for (const item of list) {
        if (!Array.isArray(item) || !item[0]) continue;
        jobs.set(String(item[0]), item[1] && typeof item[1] === 'object' ? item[1] : {});
      }
    } catch { /* first run */ }
    trim();
    return jobs;
  }

  function trim() {
    while (jobs.size > Math.max(1, Number(max) || 200)) {
      const oldest = jobs.keys().next().value;
      if (oldest === undefined) break;
      jobs.delete(oldest);
    }
  }

  function save() {
    try {
      fs.mkdirSync(path.dirname(file), { recursive: true });
      const tmp = file + '.tmp';
      const body = JSON.stringify({ v: 1, jobs: [...jobs.entries()] }, null, 1);
      fs.writeFileSync(tmp, body, 'utf8');
      fs.renameSync(tmp, file);
    } catch { /* status remains usable in memory */ }
  }

  return {
    load,
    save,
    get: (key) => jobs.get(String(key)),
    set: (key, value) => { jobs.set(String(key), value); trim(); save(); return value; },
    delete: (key) => { const ok = jobs.delete(String(key)); if (ok) save(); return ok; },
    keys: () => jobs.keys(),
    entries: () => jobs.entries(),
    get size() { return jobs.size; },
  };
}
