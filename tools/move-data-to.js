// 把整个数据目录搬到别的盘（比如 E:\whale-data）
// 用法：node tools/move-data-to.js "E:\whale-data"
// 说明：整目录递归复制（store/memories/selfnotes/usage/日志/备份/归档），改 config 后重启生效。
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const CONFIG = path.join(ROOT, 'config.json');
const SRC = path.join(ROOT, 'data');
const target = process.argv[2];

if (!target) {
  console.log('用法：node tools/move-data-to.js "E:\\whale-data"');
  process.exit(1);
}

const dest = path.resolve(String(target));
const drive = dest.slice(0, 2).toUpperCase();
if (!/^[A-Z]:$/.test(drive)) {
  console.log('路径要以盘符开头，比如 E:\\whale-data');
  process.exit(1);
}
if (!fs.existsSync(drive + '\\')) {
  console.log(`盘 ${drive} 不存在（没插？）`);
  process.exit(1);
}

if (!fs.existsSync(SRC)) {
  console.log('没有 data 目录，先跑一次服务生成');
  process.exit(1);
}

fs.mkdirSync(dest, { recursive: true });

// 1) 递归复制整个 data 目录
let files = 0;
let bytes = 0;
function copyDir(from, to) {
  fs.mkdirSync(to, { recursive: true });
  for (const ent of fs.readdirSync(from, { withFileTypes: true })) {
    const s = path.join(from, ent.name);
    const d = path.join(to, ent.name);
    if (ent.isDirectory()) {
      copyDir(s, d);
    } else {
      fs.copyFileSync(s, d);
      const size = fs.statSync(d).size;
      bytes += size;
      files += 1;
      // 校验大小一致
      if (fs.statSync(s).size !== size) console.log(`⚠ 大小不一致：${ent.name}`);
    }
  }
}
copyDir(SRC, dest);

// 2) 改 config.json
const cfg = JSON.parse(fs.readFileSync(CONFIG, 'utf8').replace(/^\uFEFF/, ''));
cfg.paths = cfg.paths || {};
cfg.paths.dataDir = dest;
cfg.memory = cfg.memory || {};
cfg.memory.usb = {
  ...(cfg.memory.usb || {}),
  dir: path.join(dest, 'backup'),
  autoMinutes: Number((cfg.memory.usb || {}).autoMinutes) || 10,
};
fs.writeFileSync(CONFIG, JSON.stringify(cfg, null, 2), 'utf8');

// 3) 关键文件核对
const must = ['store.json', 'memories.json', 'selfnotes.json', 'preferences.json', 'settings.json', 'usage.json'];
const missing = must.filter((f) => !fs.existsSync(path.join(dest, f)));
console.log(`已复制 ${files} 个文件，${Math.round(bytes / 1024)} KB → ${dest}`);
console.log('关键文件：' + (missing.length ? '缺少 ' + missing.join('、') : '齐全'));
console.log('数据目录 →', cfg.paths.dataDir);
console.log('备份目录 →', cfg.memory.usb.dir);
console.log('\n下一步：重启服务（或让我来），之后新消息就写在这个盘了。');
