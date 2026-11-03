// Minimal CLI client: all text goes through the adapter broker input endpoint.
const argv = process.argv.slice(2);
let sessionId = '';
if (argv[0] === '--session') { sessionId = String(argv[1] || ''); argv.splice(0, 2); }
const text = argv.join(' ').trim();
if (!text) {
  console.error('usage: node tools/whale-cli.mjs [--session <id>] <text>');
  process.exit(2);
}
const url = process.env.WHALE_GUI_INPUT_URL || 'http://127.0.0.1:8788/api/gui/input';
try {
  const r = await fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ text, ...(sessionId ? { sessionId } : {}) }),
    signal: AbortSignal.timeout(150000),
  });
  const data = await r.json().catch(() => ({}));
  if (!r.ok || data.ok !== true) {
    console.error('whale-cli failed:', r.status, data.error || data);
    process.exit(1);
  }
  console.log(JSON.stringify({ text: data.text, turn: data.turn, seq: data.seq, traceId: data.traceId }));
} catch (e) {
  console.error('whale-cli error:', String(e && e.message));
  process.exit(1);
}
