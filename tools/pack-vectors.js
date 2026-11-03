// 把 memories.json 里的向量从 JSON 数组压成 base64 Float32
const fs = require('fs');
const FILE = 'D:/dsh-workspace/chat/whale_gril/data/memories.json';
const B64 = 'b64:';

const data = JSON.parse(fs.readFileSync(FILE, 'utf8'));
let packed = 0;
let skipped = 0;

for (const key of Object.keys(data.sessions || {})) {
  const items = (data.sessions[key] || {}).items || [];
  for (const it of items) {
    if (typeof it.text !== 'string') { skipped += 1; continue; }
    if (!it.vector) continue;
    if (typeof it.vector === 'string') continue;
    if (!Array.isArray(it.vector)) continue;
    const arr = Float32Array.from(it.vector);
    it.vector = B64 + Buffer.from(arr.buffer, arr.byteOffset, arr.byteLength).toString('base64');
    packed += 1;
  }
}

fs.writeFileSync(FILE, JSON.stringify(data), 'utf8');
const kb = Math.round(fs.statSync(FILE).size / 1024);
console.log(`压缩向量 ${packed} 条，跳过 ${skipped} 条，文件现在 ${kb} KB`);
