// 生成 config.json：从 config.example.json 复制并按需覆盖。
// 用 Node 做，避免 Windows PowerShell 5.1 的编码坑。
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const root = __dirname;
const src = path.join(root, 'config.example.json');
const dst = path.join(root, 'config.json');

const raw = fs.readFileSync(src, 'utf8').replace(/^\uFEFF/, '');
const c = JSON.parse(raw);

c.provider = 'deepseek';

c.deepseek.apiKey = process.env.DEEPSEEK_API_KEY || '';
c.deepseek.baseUrl = 'https://api.deepseek.com';
c.deepseek.model = 'deepseek-chat';   // 非思考模式别名，实测路由到 deepseek-flash
c.deepseek.temperature = 0.95;
c.deepseek.maxTokens = 700;
c.deepseek.timeoutMs = 45000;

// 群聊安全默认：只被 @ / 叫名字才回，每小时最多 20 条，两次回复至少隔 3 秒
c.group.requireAt = true;
c.group.freeChat = false;
c.group.maxRepliesPerHour = 20;
c.group.cooldownSec = 3;

// 先关掉主动行为，避免刚起就去找人说话 / 发视频
c.share.enabled = false;
c.care.enabled = false;

// 桥接 token 随机生成（桥接脚本和本配置必须一致）
c.gateway.wechat.enabled = true;
c.gateway.wechat.inboundToken = crypto.randomBytes(16).toString('hex');

fs.writeFileSync(dst, JSON.stringify(c, null, 2), 'utf8');

// 回读校验，确认中文没被破坏
const back = JSON.parse(fs.readFileSync(dst, 'utf8').replace(/^\uFEFF/, ''));
const checks = {
  provider: back.provider,
  model: back.deepseek.model,
  baseUrl: back.deepseek.baseUrl,
  apiKeyLen: back.deepseek.apiKey.length,
  personaName: back.persona.name,
  aliases: back.persona.aliases.join('/'),
  requireAt: back.group.requireAt,
  maxRepliesPerHour: back.group.maxRepliesPerHour,
  share: back.share.enabled,
  care: back.care.enabled,
  tokenLen: back.gateway.wechat.inboundToken.length,
};
console.log(JSON.stringify(checks, null, 2));
