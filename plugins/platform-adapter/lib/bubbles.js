/** 把 agent 的最终文本拆成微信气泡。纯函数。 */

/** 按换行、句末标点切分；超长句硬切；最多 maxBubbles 条。 */
export function splitBubbles(text, { maxBubbles = 4, maxChars = 500 } = {}) {
  const raw = String(text || '').trim();
  if (!raw) return [];
  const parts = raw
    .split(/\n+/)
    .flatMap((line) => line.split(/(?<=[。！？!?；;])/))
    .map((s) => s.trim())
    .filter(Boolean);

  const out = [];
  for (const p of parts) {
    if (p.length <= maxChars) out.push(p);
    else for (let i = 0; i < p.length; i += maxChars) out.push(p.slice(i, i + maxChars));
  }

  if (out.length > maxBubbles) {
    const head = out.slice(0, maxBubbles - 1);
    const tail = out.slice(maxBubbles - 1).join('');
    head.push(tail);
    return head.map((s) => s.slice(0, maxChars));
  }
  return out;
}
