/**
 * @deprecated Plan B 过渡实现，生产 headless 已不再调用。
 * 终态：规矩/自省走 whale-system-context 的 systemPrompt，记忆走 memory_recall 工具。
 * 保留此文件仅为历史测试，不要重新接回 runTurn。
 */

export async function recallContext({
  memoryUrl,
  token = '',
  scope,
  query,
  isMaster = true,
  timeoutMs = 1500,
  fetchImpl = fetch,
} = {}) {
  const q = String(query || '').trim();
  if (!memoryUrl || !scope || !q) return '';
  try {
    const r = await fetchImpl(String(memoryUrl).replace(/\/+$/, '') + '/recall', {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...(token ? { 'x-bot-token': token } : {}) },
      body: JSON.stringify({ scope, isMaster, query: q.slice(0, 200), limit: 4 }),
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (!r.ok) return '';
    const d = await r.json();
    const items = (d.items || []).filter((x) => x && x.text);
    const parts = [];
    if (d.review && d.review.text) {
      parts.push('\n\n【可以自然想起】（只在相关话题时自然提一句，不要硬扯）\n- ' + d.review.text);
    }
    if (items.length) {
      parts.push('\n\n【你记得的事】（相关优先，可能来自其他会话）\n' + items.map((x) => '- ' + x.text).join('\n'));
    }
    return parts.join('');
  } catch {
    return '';
  }
}
