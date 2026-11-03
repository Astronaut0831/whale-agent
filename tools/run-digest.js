// 手动触发一次摘要（force），用来验证记忆链路
const fs = require('fs');
const cfg = JSON.parse(fs.readFileSync('D:/dsh-workspace/chat/whale_gril/config.json', 'utf8'));

(async () => {
  const token = cfg.gateway && cfg.gateway.wechat && cfg.gateway.wechat.inboundToken;
  const url = 'http://127.0.0.1:8787/api/digest/run?token=' + encodeURIComponent(token || '');
  const r = await fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ force: true }),
  });
  const d = await r.json();
  console.log('HTTP', r.status);
  console.log(JSON.stringify(d).slice(0, 600));
})();
