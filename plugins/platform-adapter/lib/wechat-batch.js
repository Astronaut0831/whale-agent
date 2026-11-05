/**
 * Coalesce bursts of WeChat private text into one agent turn.
 * The first caller gets a promise that resolves with the merged payload after
 * the quiet window. Later callers join the same batch and return immediately.
 */
export function createChatBatcher({ windowMs = 900, maxItems = 8, maxChars = 8000 } = {}) {
  const entries = new Map();

  function finish(key, entry) {
    if (entries.get(key) !== entry) return;
    entries.delete(key);
    const items = entry.items.slice(-maxItems);
    const first = items[0];
    const last = items[items.length - 1];
    const text = items
      .map((x) => String(x.text || '').trim())
      .filter(Boolean)
      .join('\n')
      .slice(0, maxChars);
    entry.resolve({
      primary: true,
      payload: {
        ...first,
        text,
        msg_id: 'batch:' + first.msg_id + ':' + last.msg_id,
        ts: last.ts || Date.now(),
        at_me: false,
        reply_to_bot: false,
        images: [],
        batched: items.length,
      },
      count: items.length,
    });
  }

  function push(key, payload) {
    const k = String(key || '');
    if (!k) return Promise.resolve({ primary: true, payload, count: 1 });
    const existing = entries.get(k);
    if (existing) {
      existing.items.push(payload);
      if (existing.items.length > maxItems) existing.items.splice(0, existing.items.length - maxItems);
      clearTimeout(existing.timer);
      existing.timer = setTimeout(() => finish(k, existing), windowMs);
      return { primary: false };
    }
    let resolve;
    const promise = new Promise((r) => { resolve = r; });
    const entry = { items: [payload], resolve, timer: null };
    entries.set(k, entry);
    entry.timer = setTimeout(() => finish(k, entry), windowMs);
    return promise;
  }

  return { push, size: () => entries.size };
}
