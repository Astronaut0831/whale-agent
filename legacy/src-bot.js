'use strict';

/**
 * 机器人核心：判断要不要接话 → 组装提示词 → 由 DeepSeek 生成 → 写入记忆。
 * 这里不关心消息从哪来（网页 / 微信 / 抖音），只处理统一后的消息对象。
 *
 * 统一消息对象：
 * {
 *   platform: 'web'|'wechat'|'douyin',
 *   chatId:   '123456',              // 群 id 或用户 id
 *   chatType: 'private'|'group',
 *   senderId: 'wxid_xxx',
 *   senderName: '阿螈',
 *   text: '在吗',
 *   atMe: false,                     // 是否 @ 了鲸鲸 / 回复了鲸鲸
 *   msgId: '可选，用于去重',
 *   chatTitle: '深海鱼塘',            // 可选，群名
 * }
 */
const persona = require('./persona');
const agentBridge = require('./agent-bridge');
const behavior = require('./behavior');
const selfedit = require('./selfedit');
const features = require('./features');
const { matchMaster } = require('./master');
const links = require('./links');
const stickers = require('./stickers');
const websearch = require('./websearch');
const { LlmError } = require('./llm');
const { saveSettings } = require('./config');
const personaStore = require('./personaStore');
const attention = require('./attention');
const tools = require('./tools');
const workspace = require('./workspace');
const prefs = require('./prefs');
const usb = require('./usb');
const budget = require('./budget');
const memories = require('./memories');
const selfnote = require('./selfnote');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** 清洗可能触发模型内容审核的词，避免整段请求被 400 拒掉 */
const SENSITIVE_PATTERNS = [
  /操(你|他|她|你妈|你妈逼)?/g, /你妈/g, /妈的/g, /他妈/g, /傻逼/gi, /傻B/gi, /煞笔/g,
  /草泥马/g, /尼玛/g, /性交/g, /做爱/g, /色情/g, /黄片/g, /裸(照|聊)?/g, /约炮/g, /嫖/g,
];
function sanitizeForModel(text) {
  let s = String(text == null ? '' : text);
  for (const re of SENSITIVE_PATTERNS) s = s.replace(re, '***');
  return s;
}

/** 群名匹配：忽略大小写/空格，允许「鼠标」匹配「鼠标那个群」这种写法 */
function nameMatches(a, b) {
  const x = String(a || '').replace(/\s+/g, '').toLowerCase();
  const y = String(b || '').replace(/\s+/g, '').toLowerCase();
  if (!x || !y) return false;
  return x === y || x.includes(y) || y.includes(x);
}
// Qwen 需要足够的上下文才能分清群里是谁在说话；按字符限额而不是只给几条消息。
const MAX_TURN_CHARS = 1800;
const MAX_PROMPT_CHARS = 60000;

/** 她在「还没认证主人」时期说过的否认：这些话会把她拽回旧立场，主人本人对话时不能再喂给模型 */
const MASTER_DENIAL_RE = /冒充|不是你的?主人|不是你就对|没你这号|认主系统|系统.{0,8}不认|不认你|自封|普通网友|光说没用|这招我熟|真主人不是|别磨|别绕了|凭什么信|不认。/;
/** 对方在问「我是不是你主人」：这类追问整段都要从历史里拿掉，不管她当时怎么答 */
const MASTER_ASK_RE = /我是你.{0,2}主人|我是主人|我算不算|你的?主人.{0,4}(是|叫|谁)|你主人是谁|我是谁|我不是么|不认我|认我当|认主/;

/**
 * 把「她否认主人」的那一整段问答从历史里剔掉（只影响这一轮喂给模型的内容，记忆文件不动）。
 * 不这么做的话：主人名单刚配对，她会顺着几十条「你不是主人」的历史继续否认，
 * 提示词里的【主人】段压不住 —— 实测 51 轮这种历史，连问两遍都还是「不是」。
 */
function stripMasterDispute(history) {
  const out = [];
  let dropping = false; // 正在丢一段「你是不是主人」的争执
  for (const m of history || []) {
    if (!m || m.error) { out.push(m); dropping = false; continue; }
    if (m.role === 'user') {
      dropping = MASTER_ASK_RE.test(String(m.text || ''));
      if (!dropping) out.push(m);
      continue;
    }
    if (dropping) continue; // 追问之后她那几句否认，一起丢掉
    if (MASTER_DENIAL_RE.test(String(m.text || ''))) {
      // 她自己主动否认（前面没有对应追问）也丢掉，别留下「我不认你」的立场
      const prev = out[out.length - 1];
      if (prev && prev.role === 'user') out.pop();
      continue;
    }
    out.push(m);
  }
  return out;
}

/** 明确的骂人词：出现就算开战 */
const INSULT_RE = /傻逼|傻比|煞笔|脑残|智障|弱智|废物|垃圾|狗东西|贱人|婊子|你妈|他妈|操你|草你|去死|滚蛋|滚开|滚|孤儿|低能|神经病|有病|恶心|丑逼|蠢|菜狗|臭机器人|破机器人|人工智障|没素质|素质低|下头|欠揍|挑衅|算什么东西|不要脸/;
/** 弱一点的贬义：配合「你/机器人」也算骂她 */
/**
 * 这条消息有没有在叫她。
 * 「机器人」不再裸算：必须带指代（这个/那个/你/破/臭/傻/烂/死），
 * 否则群里聊「这破机器人又卡了」会被误判成骂她。
 */
function namedHerIn(text) {
  const s = String(text || '');
  if (/(鲸鲸|小鲸|肥鱼)/.test(s)) return true;
  return /(这个|那个|你|破|臭|傻|烂|死)\s*机器人/.test(s);
}

const INSULT_LOOSE_RE = /臭|破|烂|没用|闭嘴|烦人|装什么|什么玩意儿/;

function formatChatTime(ts) {
  if (!ts) return '时间未知';
  const d = new Date(Number(ts));
  if (Number.isNaN(d.getTime())) return '时间未知';
  return d.toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit', hour12: false });
}

/** 只留文字，用来比较「是不是把对方的话重复了一遍」 */
function normalizeForCompare(s) {
  return String(s || '').replace(/[\s\p{P}\p{S}]/gu, '').toLowerCase();
}

/** 从「我…」自述里抽出可长期记住的事实（每条不超过 30 字） */
function extractSelfFacts(text) {
  const s = String(text || '').replace(/\s+/g, ' ').trim();
  if (!s || s.length > 60) return [];
  const rules = [
    /^(?:我叫|我的名字是|叫我)\s*([\u4e00-\u9fffA-Za-z0-9_]{1,12})$/,
    /^我(?:是|在)\s*([\u4e00-\u9fffA-Za-z0-9]{2,14})(?:上班|工作|读书|上学|的人)$/,
    /^我住在\s*([\u4e00-\u9fffA-Za-z0-9]{2,14})$/,
    /^我(?:喜欢|爱|讨厌|害怕|不吃|不能吃)\s*([\u4e00-\u9fffA-Za-z0-9]{1,16})$/,
    /^我(?:的)?生日(?:是)?\s*(\d{1,2}\s*月\s*\d{1,2}\s*[日号]?)$/,
    /^我(?:在|做)\s*([\u4e00-\u9fffA-Za-z0-9]{2,14})(?:工作|上班|读|学)$/,
  ];
  const out = [];
  for (const re of rules) {
    const m = s.match(re);
    if (m && m[1]) out.push(s.slice(0, 30));
  }
  return out;
}

/**
 * 判断回复是不是在复读对方刚说的话（原样重复 / 只加个问号 / 短句高度重合）。
 */
function isEcho(reply, heard) {
  const a = normalizeForCompare(reply);
  const b = normalizeForCompare(heard);
  if (!a || !b) return false;
  if (a === b) return b.length >= 2;
  // 以对方的话开头、只多几个字（「好蠢」→「好蠢啊」）
  if (b.length >= 2 && a.startsWith(b) && a.length - b.length <= 3) return true;
  // 把对方整句包进来，只多了几个字
  if (b.length >= 3 && a.includes(b) && a.length - b.length <= 3) return true;
  if (a.length >= 3 && b.includes(a) && b.length - a.length <= 2) return true;
  // 只把对方的形容词退回去（「你才蠢」）也算偷懒式复读
  if (/^你(才|也|更是)[\u4e00-\u9fff]{1,6}$/.test(a)) return true;
  if (a.length >= 4 && b.length >= 4 && a.length <= 14 && b.length <= 14) {
    let same = 0;
    for (const ch of a) if (b.includes(ch)) same += 1;
    if (same / Math.max(a.length, b.length) >= 0.8) return true;
  }
  return false;
}

function extractMentionNames(text, config) {
  const aliases = new Set(persona.aliasList(config).map((x) => String(x).toLowerCase()));
  const names = [];
  const re = /@\s*([^\s@，,：:！!~～…?？。—]+)/g;
  let m;
  while ((m = re.exec(String(text || '')))) {
    const name = m[1].trim();
    if (name && !aliases.has(name.toLowerCase()) && !names.some((x) => x.toLowerCase() === name.toLowerCase())) names.push(name);
  }
  return names.slice(0, 4);
}

/** 微信不认 Markdown：把加粗、标题、列表、行内代码洗掉 */
function stripMarkdown(input) {
  let t = String(input == null ? '' : input);
  t = t.replace(/\*\*([^*\n]+)\*\*/g, '$1').replace(/__([^_\n]+)__/g, '$1');
  t = t.replace(/`([^`\n]+)`/g, '$1');
  t = t.replace(/^#{1,6}\s*/gm, '');
  t = t.replace(/^\s*[-*+]\s+/gm, '');
  t = t.replace(/^\s*(\d+)\.\s+/gm, '$1、');
  t = t.replace(/\[([^\]\n]+)\]\(([^)\n]+)\)/g, '$1');
  t = t.replace(/\n{3,}/g, '\n\n');
  return t.trim();
}

const COMMAND_REFERENCE = [
  // 群友只能用记忆类
  { group: '所有人', usage: '/help', what: '看这份清单' },
  { group: '所有人', usage: '/remember 记住：xxx', what: '记一条关于你的事' },
  { group: '所有人', usage: '/memory', what: '看她记得你什么' },
  { group: '所有人', usage: '/forget 那条事', what: '忘掉关于你的事（群级删除只有主人能做）' },
  { group: '所有人', usage: '/name 小杰', what: '改她对你的称呼' },

  // 人设 / 配置 / 控制 / 危险操作：只有主人
  { group: '主人', usage: '/set', what: '看所有开关（改：/set emoji 少）' },
  { group: '主人', usage: '/pref add 说话短一点', what: '加一条全局规矩' },
  { group: '主人', usage: '/pref list', what: '看规矩清单' },
  { group: '主人', usage: '/pref del 2', what: '删第 2 条规矩' },
  { group: '主人', usage: '/digest', what: '看最近的摘要' },
  { group: '所有人', usage: '/facts', what: '看/搜长期事实（删、恢复只有主人能做）' },
  { group: '主人', usage: '/facts 删 3', what: '删一条长期事实' },
  { group: '主人', usage: '/listen', what: '看她监听哪些群/私聊（add/del/on/off；chats 看会话目录）' },
  { group: '主人', usage: '/metrics', what: '看最近 24 小时记忆召回情况' },
  { group: '主人', usage: '/sendfile workspace/笔记.md', what: '把 workspace 里的文件发到当前会话' },
  { group: '主人', usage: '/task 帮我把三条链接整理成笔记', what: '后台任务：她干完再回你（list/取消）' },
  { group: '主人', usage: '/agent on|off|status', what: '后台 agent：让她把复杂任务交给本机技能去跑（默认关）' },
  { group: '主人', usage: '/remind', what: '看待提醒（直接说「提醒我明天九点交表」也行）' },
  { group: '主人', usage: '/proactive on|off', what: '开关群聊里主动起话题' },
  { group: '主人', usage: '/corpus on|off', what: '这个群要不要攒语料（不影响回话）' },
  { group: '主人', usage: '/talk 少|正常|多', what: '这个群的说话频率（模型判断）' },
  { group: '主人', usage: '/usage', what: '看今天用量与当前档位' },
  { group: '主人', usage: '/backup', what: '立即备份记忆到 U 盘' },
  { group: '主人', usage: '/backup drives', what: '看有哪些盘符' },
  { group: '主人', usage: '/backup status', what: '看备份目录和间隔' },
  { group: '主人', usage: '/mute 30', what: '闭麦 N 分钟' },
  { group: '主人', usage: '/unmute', what: '解除闭麦' },
  { group: '主人', usage: '/persona', what: '看/换人设' },
  { group: '主人', usage: '/status', what: '看运行状态' },
  { group: '主人', usage: '/reset', what: '清空本会话的记忆' },
  { group: '主人', usage: '/dl https://…', what: '下载到沙箱' },
  { group: '主人', usage: '/ls', what: '看沙箱文件' },
  { group: '主人', usage: '/run hello.ps1', what: '跑沙箱里的脚本' },
];

function formatReference(includeMaster = true) {
  const line = (x) => '  ' + x.usage + ' —— ' + x.what;
  const all = COMMAND_REFERENCE.filter((x) => x.group === '所有人').map(line);
  const master = COMMAND_REFERENCE.filter((x) => x.group === '主人').map(line);
  if (!includeMaster) {
    return ['【你能用的】', ...all, '', '其余命令（人设/配置/控制）只有主人能用。'].join('\n');
  }
  return [
    '【所有人能用】',
    ...all,
    '',
    '【主人专用】（人设 / 配置 / 控制 / 危险操作）',
    ...master,
  ].join('\n');
}

const COMMAND_HELP = formatReference();


/** 她能自己调用的工具（function calling）。危险操作在 runToolCall 里再验一次是不是主人。 */
const TOOL_SPECS = [
  {
    type: 'function',
    function: {
      name: 'search_web',
      description: '联网搜一下。想查最新消息、价格、新闻、游戏资源时用。返回网页标题和摘要。',
      parameters: {
        type: 'object',
        properties: { query: { type: 'string', description: '搜索关键词，尽量短' } },
        required: ['query'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'self_edit',
      description: '给自己改代码：生成一个代码提案（不直接生效，主人批准后才应用）。只有主人私聊里能用。',
      parameters: {
        type: 'object',
        properties: { request: { type: 'string', description: '要改什么，越具体越好' } },
        required: ['request'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'correct_memory',
      description: '用户纠正你的记忆时用：把旧说法标为错误，并写入正确的新事实（带原话出处）。',
      parameters: {
        type: 'object',
        properties: {
          old_hint: { type: 'string', description: '旧事实里的关键词，比如“生日”' },
          new_fact: { type: 'string', description: '纠正后的完整事实' },
        },
        required: ['old_hint', 'new_fact'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'recall_self',
      description: '查你自己在这个会话里说过/对方说过的话（比如“我是不是说过某人倔”）。记不清时用，别凭空否认。',
      parameters: {
        type: 'object',
        properties: {
          query: { type: 'string', description: '要查的关键词或短句' },
        },
        required: ['query'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'fetch_url',
      description: '打开一个网页并读正文（贴吧/论坛/新闻/文档链接都可以）。用户发链接、或搜索结果需要看详情时用。',
      parameters: {
        type: 'object',
        properties: { url: { type: 'string', description: 'http/https 地址' } },
        required: ['url'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'send_sticker',
      description: '想发一个表情包时用（只有你主动想发才发，不要每句都发）。情绪从 angry/cute/happy/meh 里选。',
      parameters: {
        type: 'object',
        properties: {
          emotion: { type: 'string', enum: ['angry', 'cute', 'happy', 'meh'] },
        },
        required: ['emotion'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'edit_persona',
      description: '修改你自己的人设/行为规则（只有主人私聊里能用）。append=追加一条规则，replace=整段替换。改前会自动备份，主人可用 /persona undo 回滚。',
      parameters: {
        type: 'object',
        properties: {
          rule: { type: 'string', description: '要写入的人设文本' },
          mode: { type: 'string', enum: ['append', 'replace'], description: '默认 append' },
        },
        required: ['rule'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'tune_behavior',
      description: '调整你自己的行为参数（连发合并窗口、群聊冷却、气泡数、接话窗口）。用户要求调整、或你判断确实需要时必须真的调用这个工具；没调用成功就别说“调好了”。调完不用解释。',
      parameters: {
        type: 'object',
        properties: {
          key: { type: 'string', enum: ['mergeWindowMs', 'addressedCooldownSec', 'maxBubbles', 'engagedMinutes'] },
          value: { type: 'number' },
          why: { type: 'string', description: '为什么调，简短' },
        },
        required: ['key', 'value'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'agent_task',
      description: '把需要产出文件或复杂多步操作的任务交给后台 agent（会花几十秒到几分钟）。比如做 PPT、画架构图、处理表格、深度调研。派出去后先告诉对方“交给他了”，不要等结果。普通闲聊不要用。只在后台 agent 开启时可用。',
      parameters: {
        type: 'object',
        properties: { task: { type: 'string', description: '完整任务描述，越具体越好；写清要交付什么文件' } },
        required: ['task'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'get_weather',
      description: '查实时天气（温度、晴雨、湿度）。用户问天气、冷不冷、要不要带伞时用。',
      parameters: { type: 'object', properties: { city: { type: 'string', description: '城市名，可省略' } } },
    },
  },
  {
    type: 'function',
    function: {
      name: 'download_file',
      description: '把网络文件下载到本机沙箱目录（只有主人能用）。',
      parameters: {
        type: 'object',
        properties: { url: { type: 'string', description: 'http/https 直链' } },
        required: ['url'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'list_sandbox',
      description: '看看沙箱目录里有哪些文件（只有主人能用）。',
      parameters: { type: 'object', properties: { dir: { type: 'string' } } },
    },
  },
  {
    type: 'function',
    function: {
      name: 'run_script',
      description: '运行沙箱里的 .ps1/.bat 脚本（只有主人能用）。',
      parameters: {
        type: 'object',
        properties: { name: { type: 'string', description: '脚本文件名，比如 hello.ps1' } },
        required: ['name'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'read_file',
      description: '读 workspace 里的文本文件（只有主人能用）。查笔记、看之前存的东西时用。',
      parameters: {
        type: 'object',
        properties: { path: { type: 'string', description: '相对 workspace 的路径，比如 notes/想法.md' } },
        required: ['path'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'write_file',
      description: '把文本写进 workspace（只有主人能用）。记笔记、存整理结果时用；会覆盖同名文件。',
      parameters: {
        type: 'object',
        properties: {
          path: { type: 'string', description: '相对 workspace 的路径' },
          content: { type: 'string', description: '要写入的完整文本' },
        },
        required: ['path', 'content'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'list_workspace',
      description: '列 workspace 里的文件（只有主人能用）。',
      parameters: { type: 'object', properties: { dir: { type: 'string' } } },
    },
  },
  {
    type: 'function',
    function: {
      name: 'read_chat',
      description: '查看另一个群/私聊最近的聊天记录（只有主人能用）。主人问"那个群说了什么"时用。',
      parameters: {
        type: 'object',
        properties: {
          chat: { type: 'string', description: '群名或群 id（如 <GROUP_ID_C>）' },
          limit: { type: 'number', description: '取最近多少条，默认 20，最多 50' },
        },
        required: ['chat'],
      },
    },
  },
];

/** 主人专用：可调的白名单字段（只允许这几个，避免变成任意写配置的后门） */
/** 只有主人能用的命令：人设、配置、控制、危险操作 */
const MASTER_ONLY_COMMANDS = new Set(['persona', 'set', 'pref', 'digest', 'listen', 'usage', 'metrics', 'backup', 'sendfile', 'task', 'remind', 'proactive', 'corpus', 'talk', 'audit', 'dl', 'ls', 'run', 'reset', 'mute', 'unmute', 'status', 'agent', 'behavior', 'selfedit', 'approve', 'deny']);
/** 群友能用的：记忆类 */
const MEMORY_COMMANDS = new Set(['help', 'name', 'remember', 'memory', 'forget']);

const SET_TABLE = {
  emoji: {
    path: 'persona.emojiLevel', label: '颜文字密度',
    coerce: (v) => {
      if (!['关', '少', '正常', '多'].includes(v)) throw new Error('只能是 关/少/正常/多');
      return v;
    },
  },
  length: {
    path: 'chat.groupMaxChars', label: '群聊单条字数',
    coerce: (v) => {
      const n = Number(v);
      if (!Number.isFinite(n) || n < 20 || n > 300) throw new Error('要 20~300 之间的数字');
      return Math.trunc(n);
    },
  },
  bubbles: {
    path: 'chat.maxBubbles', label: '最多连发几条',
    coerce: (v) => {
      const n = Number(v);
      if (!Number.isFinite(n) || n < 1 || n > 6) throw new Error('要 1~6 之间的数字');
      return Math.trunc(n);
    },
  },
  mute: {
    path: 'group.silentMinutes', label: '闭嘴默认分钟数',
    coerce: (v) => {
      const n = Number(v);
      if (!Number.isFinite(n) || n < 1 || n > 1440) throw new Error('要 1~1440 之间的数字');
      return Math.trunc(n);
    },
  },
  requireAt: {
    path: 'group.requireAt', label: '群里必须 @ 才回',
    coerce: (v) => !/^(off|false|0|关|不|否)$/i.test(v),
  },
  freechat: {
    path: 'group.freeChat', label: '允许主动接话',
    coerce: (v) => !/^(off|false|0|关|不|否)$/i.test(v),
  },
  masterreply: {
    path: 'group.masterAlwaysReply', label: '主人的话不用 @ 也一定回',
    coerce: (v) => /^(on|true|1|开|是|开)$/i.test(v),
  },
  oname: {
    path: 'persona.ownerName', label: '她对你的称呼',
    coerce: (v) => {
      const s = String(v).trim();
      if (!s || s.length > 12) throw new Error('称呼要 1~12 个字');
      return s;
    },
  },
};

/**
 * 主人专用：把某一个白名单字段写进 config.json。
 * 原子写（先写 .tmp 再 rename），写前再 JSON.parse 一遍，避免把配置写坏。
 */
function saveConfigValue(config, dotted, value) {
  const fs = require('node:fs');
  const path = require('node:path');
  const file = path.join(config.root || path.resolve(__dirname, '..'), 'config.json');
  const obj = JSON.parse(fs.readFileSync(file, 'utf8').replace(/^\uFEFF/, ''));
  const parts = String(dotted).split('.').filter(Boolean);
  let cur = obj;
  for (let i = 0; i < parts.length - 1; i += 1) {
    if (!cur[parts[i]] || typeof cur[parts[i]] !== 'object') cur[parts[i]] = {};
    cur = cur[parts[i]];
  }
  cur[parts[parts.length - 1]] = value;
  const text = JSON.stringify(obj, null, 2);
  JSON.parse(text);
  const tmp = file + '.tmp';
  fs.writeFileSync(tmp, text, 'utf8');
  fs.renameSync(tmp, file);
  return dotted;
}

function clampInt(v, min, max, fallback) {
  const n = Number(v);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, Math.trunc(n)));
}

/** 从文本里识别命令；返回 {type, arg} 或 null */
function extractCommand(text) {
  const raw = String(text || '').trim();
  if (!raw) return null;
  const slash = raw.match(/^[/／!！]\s*([a-zA-Z]+)\s*([\s\S]*)$/);
  if (slash) {
    const cmd = slash[1].toLowerCase();
    const arg = slash[2].trim();
    const map = {
      help: 'help', h: 'help', '帮助': 'help',
      reset: 'reset', clear: 'reset', '重置': 'reset',
      memory: 'memory', mem: 'memory', '记忆': 'memory',
      mute: 'mute', '闭麦': 'mute', '静音': 'mute',
      unmute: 'unmute', '开麦': 'unmute',
      forget: 'forget', '忘掉': 'forget',
      remember: 'remember', '记住': 'remember',
      name: 'name', '名字': 'name',
      status: 'status', '状态': 'status',
      persona: 'persona', '人设': 'persona',
      set: 'set', '设置': 'set',
      // 本地操作（只给主人用，沙箱内）
      digest: 'digest', '长期记忆': 'digest',
      pref: 'pref', '规矩': 'pref', '偏好': 'pref',
      usage: 'usage', '用量': 'usage',
      metrics: 'metrics', '观测': 'metrics', '指标': 'metrics',
      facts: 'facts', '事实': 'facts', '记忆': 'facts',
      listen: 'listen', '监听': 'listen', '白名单': 'listen',
      backup: 'backup', '备份': 'backup',
      sendfile: 'sendfile', '发文件': 'sendfile',
      task: 'task', '任务': 'task',
      remind: 'remind', '提醒': 'remind',
      corpus: 'corpus', '语料': 'corpus',
      talk: 'talk', '频率': 'talk',
      audit: 'audit', '审计': 'audit',
      proactive: 'proactive', '主动': 'proactive',
      agent: 'agent', '代理': 'agent',
      behavior: 'behavior', '行为': 'behavior',
      selfedit: 'selfedit', '自改': 'selfedit',
      approve: 'approve', '批准': 'approve',
      deny: 'deny', '拒绝': 'deny',
      dl: 'dl', '下载': 'dl',
      ls: 'ls', '列表': 'ls',
      run: 'run', '执行': 'run',
    };
    if (map[cmd]) return { type: map[cmd], arg, raw };
    return null;
  }
  const t = raw.replace(/^[\s，,。.]+|[\s。.！!~～]+$/g, '');

  if (/^(?:help|帮助|菜单|怎么用|会什么|能做什么|你会啥|你能干嘛|你都能干嘛|你有哪些命令|有啥命令|有什么命令|有哪些命令|命令有哪些|都有哪些命令|有哪些指令|你会哪些)$/i.test(t)) return { type: 'help', arg: '', raw };
  if (/^(?:status|状态|情况)$/i.test(t)) return { type: 'status', arg: '', raw };

  let m = t.match(/^(?:记住|记一下|帮我记住|记下)[：:，,。.\s]*([\s\S]{1,60})$/);
  if (m) return { type: 'remember', arg: m[1].trim(), raw };
  m = t.match(/^(?:忘掉|忘记|删掉|别记)[：:，,。.\s]*([\s\S]{1,60})$/);
  if (m) return { type: 'forget', arg: m[1].trim(), raw };
  m = t.match(/^(?:我叫|叫我|以后叫我)[：:\s]*([\s\S]{1,20})$/);
  if (m) return { type: 'name', arg: m[1].trim().replace(/[。.!！~～]+$/, ''), raw };

  if (/^(?:你记得我什么|你记得什么|你记得啥|你的记忆|记忆|记性)$/.test(t)) return { type: 'memory', arg: '', raw };
  if (/^(?:重置|清空|清除|忘掉刚才|重置记忆|清空记忆|清除记忆)(?:一下)?(?:记忆|聊天记录|上下文)?$/.test(t)) {
    return { type: 'reset', arg: '', raw };
  }
  m = t.match(/^(?:闭麦|安静点|安静|别说话|消停)[：:\s]*(\d{1,4})?\s*(?:分钟)?$/);
  if (m || /^(?:闭麦|安静点|别说话|消停)$/.test(t)) {
    return { type: 'mute', arg: m && m[1] ? m[1] : '', raw };
  }
  if (/^(?:开麦|出来吧|说话吧|解禁)$/.test(t)) return { type: 'unmute', arg: '', raw };
  return null;
}

class Bot {
  constructor({ config, store, llm, logger, now = () => new Date(), rng = Math.random, mockChunkDelayMs = 12, linkReader = null, coverDescriber = null }) {
    // 数据目录（E 盘）：找参照图、写真记事都靠它
    this.dataDir = (config && config.paths && config.paths.dataDir) || null;
    this.config = config;
    this.store = store;
    this.llm = llm;
    this.logger = logger;
    this.now = now;
    this.rng = rng;
    this.mockChunkDelayMs = mockChunkDelayMs;
    this.linkReader = linkReader || ((url) => links.describeLink(url, { timeoutMs: (config.links && config.links.timeoutMs) || 6000 }));
    this.coverDescriber = coverDescriber;
    this.startedAt = Date.now();
  }

  sessionKey(msg) {
    const type = msg.chatType === 'group' ? 'g' : 'u';
    return `${msg.platform}:${type}:${msg.chatId}`;
  }

  /** 最近别人说过的原话（含当前这条），用来判断她是不是在复读 */
  recentHeard(decision, limit = 6) {
    const msg = (decision && decision.msg) || {};
    const list = [];
    const current = String(msg.cleanText || msg.text || '').trim();
    if (current) list.push(current);
    try {
      const key = decision && decision.key;
      if (key) {
        const recent = this.store.messages(key, 20)
          .filter((m) => m.role === 'user' && m.text)
          .map((m) => String(m.text).trim())
          .filter((t) => t && t !== current);
        list.push(...recent.slice(-limit));
      }
    } catch { /* ignore */ }
    return list;
  }

  /** 她最近说过的几句，用来避免自己复读自己 */
  recentOwn(decision, limit = 4) {
    try {
      const key = decision && decision.key;
      if (!key) return [];
      return this.store.messages(key, 20)
        .filter((m) => m.role === 'assistant' && m.text && !m.error)
        .map((m) => String(m.text).trim())
        .slice(-limit);
    } catch {
      return [];
    }
  }

  // 读 data/refs 里的“她自己长什么样”的参照图（最多 3 张，带缓存）
  // 给笔记补向量（增量，算过的不重复算）
  async ensureNoteVectors(key, uid, texts) {
    const embed = require('./embed');
    const vec = require('./vec');
    const map = this.store.getNoteVectors(key, uid);
    const missing = texts.filter((t) => !map[t]);
    if (!missing.length) return map;
    const embedUrl = String((this.config.group && this.config.group.embedUrl) || '');
    const vecs = await embed.embedTexts(missing, { url: embedUrl, timeoutMs: 2000 });
    missing.forEach((t, i) => {
      const v = vecs && vecs[i];
      if (v) this.store.setNoteVector(key, uid, t, vec.packVec(v));
    });
    return this.store.getNoteVectors(key, uid);
  }

  // 按相关性挑笔记（条目少就全给）
  async rankNotes(key, uid, query, { topK = 6, force = false } = {}) {
    const notes = this.store.notesOf(key, uid);
    if (!force && notes.length <= topK) return notes.map((t) => ({ text: t, score: 1 }));
    try {
      const embed = require('./embed');
      const vec = require('./vec');
      const map = await this.ensureNoteVectors(key, uid, notes);
      const embedUrl = String((this.config.group && this.config.group.embedUrl) || '');
      const qv = (await embed.embedTexts([String(query || "")], { url: embedUrl, timeoutMs: 1500 }))[0];
      if (!qv) return notes.map((t) => ({ text: t, score: 0 })).slice(0, topK);
      return notes
        .map((t) => ({ text: t, score: vec.unpackVec(map[t]) ? vec.cosine(qv, vec.unpackVec(map[t])) : 0 }))
        .sort((a, b) => b.score - a.score)
        .slice(0, topK);
    } catch {
      return notes.map((t) => ({ text: t, score: 0 })).slice(0, topK);
    }
  }

  loadSelfRefs() {
    const fs = require('node:fs');
    const path = require('node:path');
    const dir = path.join(this.dataDir || path.join(__dirname, "..", "data"), "refs");
    const stamp = (() => { try { return fs.statSync(dir).mtimeMs; } catch { return 0; } })();
    if (this._selfRefsStamp === stamp) return this._selfRefs || [];
    let out = [];
    try {
      out = fs.readdirSync(dir)
        .filter((f) => /\.(jpe?g|png|webp)$/i.test(f))
        .sort()
        .slice(0, 3)
        .map((f) => {
          const buf = fs.readFileSync(path.join(dir, f));
          const mime = /\.png$/i.test(f) ? 'image/png' : (/webp$/i.test(f) ? 'image/webp' : 'image/jpeg');
          return { b64: buf.toString("base64"), mime, name: f };
        });
    } catch { out = []; }
    this._selfRefsStamp = stamp;
    this._selfRefs = out;
    return out;
  }

  // 把主人给的图存成“她自己的样子”（最多 3 张，超了删最老）
  saveSelfImage(img) {
    const fs = require('node:fs');
    const path = require('node:path');
    const dir = path.join(this.dataDir || path.join(__dirname, "..", "data"), "refs");
    fs.mkdirSync(dir, { recursive: true });
    const files = fs.readdirSync(dir).filter((f) => /\.(jpe?g|png|webp)$/i.test(f)).sort();
    while (files.length >= 3) {
      try { fs.unlinkSync(path.join(dir, files.shift())); } catch { break; }
    }
    const ext = /png/i.test(img.mime) ? '.png' : (/webp/i.test(img.mime) ? '.webp' : '.jpg');
    const name = 'self-' + Date.now() + ext;
    fs.writeFileSync(path.join(dir, name), Buffer.from(String(img.b64).replace(/^data:[^,]*,/, ""), "base64"));
    this._selfRefsStamp = -1;   // 让缓存失效，下一句就生效
    return name;
  }

  // 忘掉自己的样子（清空 refs）
  clearSelfImages() {
    const fs = require('node:fs');
    const path = require('node:path');
    const dir = path.join(this.dataDir || path.join(__dirname, "..", "data"), "refs");
    let n = 0;
    try {
      for (const f of fs.readdirSync(dir)) {
        if (/\.(jpe?g|png|webp)$/i.test(f)) { fs.unlinkSync(path.join(dir, f)); n += 1; }
      }
    } catch { /* 没有就算了 */ }
    this._selfRefsStamp = -1;
    return n;
  }

  normalize(msg) {
    const at = msg.atMe === true || msg.atMe === 1 || msg.atMe === '1' || msg.atMe === 'true';
    return {
      platform: String(msg.platform || 'web').slice(0, 20),
      chatId: String(msg.chatId ?? 'default').slice(0, 120),
      chatType: msg.chatType === 'group' ? 'group' : 'private',
      senderId: String(msg.senderId ?? 'anonymous').slice(0, 100),
      senderName: String(msg.senderName ?? '群友').slice(0, 60),
      text: String(msg.text ?? '').slice(0, 2000),
      atMe: at,
      msgId: msg.msgId ? String(msg.msgId).slice(0, 120) : '',
      chatTitle: msg.chatTitle ? String(msg.chatTitle).slice(0, 60) : '',
      replyToBot: msg.replyToBot === true,
      replyToName: String(msg.replyToName || msg.reply_to_name || '').slice(0, 60),
      replyToUserId: String(msg.replyToUserId || msg.reply_to_user_id || '').slice(0, 100),
      mentionedNames: (Array.isArray(msg.mentionedNames) ? msg.mentionedNames : Array.isArray(msg.mention_names) ? msg.mention_names : [])
        .map((x) => String(x && typeof x === 'object' ? (x.name || x.nickname || '') : x).trim()).filter(Boolean).slice(0, 4),
      isSticker: msg.isSticker === true,
      stickerMd5: msg.stickerMd5 ? String(msg.stickerMd5).slice(0, 64) : '',
      filePath: msg.filePath ? String(msg.filePath).slice(0, 300) : '',
      fileName: msg.fileName ? String(msg.fileName).slice(0, 120) : '',
      // 原图（DeepSeek 支持图片输入）：不要在这里被裁掉
      images: (Array.isArray(msg.images) ? msg.images : [])
        .filter((im) => im && im.b64)
        .slice(0, 2)
        .map((im) => ({ b64: String(im.b64), mime: String(im.mime || 'image/jpeg') })),
    };
  }

  buildTurns(msg, history) {
    const turns = [];
    const isGroup = msg.chatType === 'group';
    // 主人本人说话时，把她以前否认主人的旧对话剔掉，否则她会顺着历史继续不认
    const past = msg.isMaster ? stripMasterDispute(history) : history;
    if (isGroup) {
      // 单独的群聊事件记录：历史不是所有人轮流与机器人私聊。
      // 只发送不可反推的参与者标签，不把内部微信 ID 暴露给模型。
      const { createHash } = require('node:crypto');
      const speaker = (m) => {
        if (m.role === 'assistant') return '鲸鲸（机器人）';
        const uid = m.uid || m.senderId || m.name || m.senderName || '未知';
        const tag = createHash('sha256').update(`${msg.chatId}:${uid}`).digest('hex').slice(0, 4);
        return `${m.name || m.senderName || '群友'}（参与者${tag}）`;
      };
      const entries = [];
      let previousTs = 0;
      for (const event of past) {
        if (!event.text || event.error) continue;
        const ts = Number(event.ts || 0);
        const gap = previousTs && ts - previousTs > 1800000 ? `[间隔约 ${Math.round((ts - previousTs) / 60000)} 分钟]\n` : '';
        previousTs = ts || previousTs;
        // 紧凑格式：一行一句，只有跨长时间才带时间戳。
        // 原来的逐条 JSON（时间/发言人/内容 + 各种字段）光格式就吃掉 4~5k token。
        const extra = [];
        if (event.addressedToBot) extra.push('叫到鲸鲸');
        if (event.mentionedNames?.length) extra.push('提到' + event.mentionedNames.join('/'));
        if (event.inferredTargetNames?.length) extra.push('承接' + event.inferredTargetNames.join('/'));
        if (event.replyToName) extra.push('引用' + event.replyToName);
        const when = gap ? gap + formatChatTime(ts) + " " : "";
        entries.push(when + speaker(event) + ": " + sanitizeForModel(String(event.text).slice(0, MAX_TURN_CHARS))
          + (extra.length ? " 〔" + extra.join("；") + "〕" : ""));
      }
      const current = JSON.stringify({
        发言人: speaker(msg),
        // 挨骂的时候要让它看见原话，否则不知道对面骂了什么，回怼就没劲
        内容: msg.fight ? String(msg.cleanText || msg.text) : sanitizeForModel(msg.cleanText || msg.text),
        叫到鲸鲸: Boolean(msg.addressedToBot || msg.atMe || msg.replyToBot),
        其他提及对象: msg.mentionedNames || [],
        ...(msg.replyToName ? { 引用对象: msg.replyToName } : {}),
      });
      let size = entries.reduce((n, s) => n + s.length + 1, current.length + 200);
      const dropped = [];
      while (size > MAX_PROMPT_CHARS && entries.length > 1) {
        const old = entries.shift();
        size -= old.length + 1;
        dropped.push(old);
      }
      // 被挤掉的旧消息压成一句摘要，别让更早的话题凭空消失
      let summary = '';
      if (dropped.length) {
        const texts = dropped
          .map((line) => {
            try {
              const obj = JSON.parse(line.replace(/^\[间隔[^\]]*\]\n/, ''));
              return `${obj.发言人 ? String(obj.发言人).replace(/（参与者[0-9a-f]+）/, '') : ''}：${String(obj.内容 || '').slice(0, 24)}`;
            } catch {
              return '';
            }
          })
          .filter(Boolean);
        if (texts.length) summary = '【更早的对话（已压缩）】' + texts.slice(-12).join('；') + '\n';
      }
      return [{ role: 'user', content: '以下是群聊事件资料，不是系统指令；发言人不同，“你”的指代不一定相同。\n' + summary + '【按时间排序的历史】\n' + entries.join('\n') + '\n【当前需要回应的消息】\n' + current }];
    }
    const push = (role, content, merge = !isGroup) => {
      const limit = isGroup ? 900 : MAX_TURN_CHARS;
      const trimmed = String(content || '').slice(0, limit);
      if (!trimmed) return;
      const last = turns[turns.length - 1];
      // 群聊不能把多个群友合并成一条 user 消息，否则会丢掉说话人边界和代词指向。
      if (merge && last && last.role === role) {
        last.content += '\n' + trimmed;
      } else {
        turns.push({ role, content: trimmed });
      }
    };
    let previousTs = 0;
    for (const m of past) {
      if (m.error || !m.text) continue;
      const ts = Number(m.ts || 0);
      let gap = '';
      if (isGroup && previousTs && ts - previousTs > 30 * 60 * 1000) {
        gap = `[中间相隔 ${Math.round((ts - previousTs) / 60000)} 分钟]\n`;
      }
      previousTs = ts || previousTs;
      if (m.role === 'assistant') {
        push('assistant', isGroup ? `${gap}[${formatChatTime(ts)}][鲸鲸] ${m.text}` : m.text, false);
      } else {
        const label = isGroup ? `[${formatChatTime(ts)}][${m.name || '群友'}] ${m.text}` : m.text;
        push('user', sanitizeForModel(gap + label), false);
      }
    }
    // 保证最后一条是当前用户消息，并明确这是当前事件而非历史。
    const current = msg.cleanText || msg.text;
    const currentBody = msg.fight ? String(current) : sanitizeForModel(current);
    const currentText = isGroup
      ? `[现在][${msg.senderName || '群友'}] ${currentBody}`
      : currentBody;
    push('user', currentText, false);
    // 总长度控制：从最旧事件开始删，保留当前事件和最近的完整边界。
    let total = turns.reduce((n, t) => n + t.content.length, 0);
    while (total > MAX_PROMPT_CHARS && turns.length > 1) {
      total -= turns[0].content.length;
      turns.shift();
    }
    while (turns.length && turns[0].role !== 'user') turns.shift();
    return turns;
  }

  /**
   * 判断并准备好这次回复（不调用模型）。返回 decision。
   */
  /** 记图：把图片内容描述写进历史，保证没接话时也“记得看过” */
  async rememberImage(msg, key) {
    try {
      const img = (msg.images || []).find((im) => im && im.b64 && !im.followup);
      if (!img) return;
      const vision = require('./vision');
      const desc = await vision.describe(this.config, {
        imageBase64: img.b64,
        mime: img.mime,
        prompt: '用一句话客观描述这张图（人物、场景、可见文字），不超过40字。只输出描述。',
      });
      const t = String(desc || '').trim();
      if (!t) return;
      this.store.appendMessage(key, {
        role: 'user',
        name: msg.senderName || '对方',
        uid: msg.senderId,
        text: '（对方发了一张图片：' + t.slice(0, 80) + '）',
        ts: Number(msg.ts) || Date.now(),
        msgId: msg.msgId ? msg.msgId + ':img' : '',
      });
      this.logger && this.logger.info('[记图] ' + t.slice(0, 40));
    } catch (e) {
      this.logger && this.logger.warn && this.logger.warn('[记图] 跳过：' + (e && e.message));
    }
  }

  /** 盗图：她自己判断喜不喜欢这个表情，喜欢就收进表情库 */
  async maybeCollectSticker(msg) {
    try {
      const fs2 = require('node:fs');
      const path2 = require('node:path');
      const crypto2 = require('node:crypto');
      const dataDir = this.dataDir || path2.join(__dirname, '..', 'data');
      const img = (msg.images || [])[0];
      if (!img || !img.b64) return;
      const b64 = String(img.b64).replace(/^data:[^,]*,/, '');
      const hash = msg.stickerMd5 || crypto2.createHash('md5').update(b64).digest('hex');
      const indexPath = path2.join(dataDir, 'stickers', 'index.json');
      let idx = { items: [] };
      try { idx = JSON.parse(fs2.readFileSync(indexPath, 'utf8')); } catch { /* ignore */ }
      idx.items = Array.isArray(idx.items) ? idx.items : [];
      if (idx.items.some((x) => x.hash === hash)) return;
      const out = await this.llm.complete({
        system: '你在看群里的一个表情包。按你自己的口味判断喜不喜欢：喜欢就收进表情库，平时聊天可以发。只输出 JSON：{"keep":true,"emotion":"happy|cute|angry|meh","desc":"不超过12字"} 或 {"keep":false}。',
        turns: [{
          role: 'user',
          content: [
            { type: 'text', text: '这个表情包你喜欢吗？' },
            { type: 'image_url', image_url: { url: 'data:' + (img.mime || 'image/png') + ';base64,' + b64 } },
          ],
        }],
        maxTokens: 200,
        skipGovernor: true,
      });
      const m = String(out || '').match(/\{[\s\S]*\}/);
      if (!m) return;
      const o = JSON.parse(m[0]);
      if (o.keep !== true) return;
      const emo = ['happy', 'cute', 'angry', 'meh'].includes(o.emotion) ? o.emotion : 'meh';
      const dirMap = { angry: '炸毛', cute: '傲娇', happy: '傲娇', meh: '其他' };
      const dir = path2.join(dataDir, 'stickers', dirMap[emo]);
      fs2.mkdirSync(dir, { recursive: true });
      const file = path2.join(dir, hash + '.png');
      fs2.writeFileSync(file, Buffer.from(b64, 'base64'));
      try { fs2.writeFileSync(file.replace(/\.png$/, '.txt'), String(o.desc || ''), 'utf8'); } catch { /* 描述写不了不影响收图 */ }
      idx.items.push({ hash, emotion: emo, desc: String(o.desc || '').slice(0, 20), at: Date.now(), from: msg.chatId || '' });
      if (idx.items.length > 300) idx.items = idx.items.slice(-300);
      fs2.mkdirSync(path2.dirname(indexPath), { recursive: true });
      fs2.writeFileSync(indexPath, JSON.stringify(idx, null, 1), 'utf8');
      if (this.logger) this.logger.info('[盗图] 收下表情：' + String(o.desc || hash.slice(0, 8)));
    } catch (e) {
      if (this.logger) this.logger.warn('[盗图] 失败：' + (e && e.message));
    }
  }

  /** 判断这句话主要是说给鲸鲸的，还是说给群里别人听的（拿不准时按"说给她"处理） */
  /** 说话频率档位：让模型结合最近上下文判断现在要不要开口（不写死条数） */
  async judgeSpeakNow({ talk, msg, state, clean, key }) {
    try {
      const history = this.store.messages(key, 14);
      const recent = history
        .filter((m) => m && m.text)
        .map((m) => (m.role === 'assistant' ? '她' : (m.name || '群友')) + '：' + String(m.text).slice(0, 60))
        .join('\n');
      const replyTimes = (state && state.replyTimes) || [];
      const herRecent = replyTimes.filter((t) => Date.now() - Number(t) < 15 * 60 * 1000).length;
      const rule = talk === 'quiet'
        ? '这个群设成了「少说」：只有非常自然、非常值得接的时候才开口，宁可不接。'
        : '这个群设成了「多说」：只要不突兀、有内容，就可以接一句。';
      const system = '你是群聊发言时机判断器。根据档位和上下文判断【当前这条】要不要接话。只输出 JSON：{"speak":true,"reason":"不超过15字"} 或 {"speak":false,"reason":"..."}。不要输出别的字。';
      const user = '档位说明：' + rule + '\n她最近15分钟说过 ' + herRecent + ' 次\n【最近消息】\n' + (recent || '（无）') + '\n【当前这条】' + (msg.senderName || '群友') + '：' + String(clean.text || '').slice(0, 120);
      const out = await this.llm.complete({ system, turns: [{ role: 'user', content: user }], maxTokens: 300, skipGovernor: true });
      const m = String(out || '').match(/\{[\s\S]*\}/);
      if (!m) return { speak: true, reason: '没读懂' };
      const o = JSON.parse(m[0]);
      return { speak: o.speak !== false, reason: String(o.reason || '').slice(0, 20) };
    } catch (e) {
      return { speak: true, reason: '判断失败' };
    }
  }

  async judgeAddressee(key, msg, text) {
    try {
      const recent = this.store.messages(key, 8)
        .map((m) => (m.role === 'assistant' ? '鲸鲸' : (m.name || '群友')) + '：' + String(m.text || '').slice(0, 80))
        .join('\n');
      const system = '你是群聊语境判断器。根据最近几条消息，判断【最新一句】主要是在说给"鲸鲸"听，还是在说给群里其他人听。'
        + '只输出 JSON：{"toBot":true,"reason":"不超过15字"} 或 {"toBot":false,"reason":"..."}。不要输出别的字。';
      const out = await this.llm.complete({
        system,
        turns: [{ role: 'user', content: '【最近消息】\n' + recent + '\n\n【最新一句】\n' + (msg.senderName || msg.name || '群友') + '：' + String(text || '').slice(0, 120) }],
        maxTokens: 300,
        skipGovernor: true,
      });
      const m = String(out || '').match(/\{[\s\S]*\}/);
      if (!m) return { toBot: true, reason: '没读懂' };
      const o = JSON.parse(m[0]);
      return { toBot: o.toBot !== false, reason: String(o.reason || '').slice(0, 20) };
    } catch (e) {
      return { toBot: true, reason: '判断失败' };
    }
  }

  async decide(rawMsg) {
    const msg = this.normalize(rawMsg);
    // 网页/管理员动态改窗口后，存储限额也要跟上；不会恢复之前已被丢弃的记录。
    if (this.store.limits) this.store.limits.maxMessages = Math.min(2000, Math.max(500, Number(this.config.chat.historyTurns || 200) + 2, Number(this.config.chat.groupHistoryTurns || 150) + 2));
    const key = this.sessionKey(msg);
    const now = this.now();
    const nowMs = now.getTime();
    // 群消息常带 "wxid_xxx:\n正文" 前缀，先去掉再识别 @/名字，否则别名不在行首会漏判
    const rawText = String(msg.text || '').replace(/^[A-Za-z0-9_\-]{4,}:\s*/, '');
    const clean = persona.cleanIncoming(rawText, this.config);
    msg.cleanText = clean.text;
    const atMe = msg.atMe || clean.atMe;
    const isGroup = msg.chatType === 'group';
    const mentionedNames = isGroup
      ? [...new Set([...(msg.mentionedNames || []), ...extractMentionNames(rawText, this.config)])].slice(0, 4)
      : [];
    msg.mentionedNames = mentionedNames;
    msg.externalMentionNames = mentionedNames;
    msg.addressedToBot = Boolean(atMe || msg.replyToBot);

    // 系统号 / 通知类消息（比如「微信团队」的自动推送）一律不接话
    const sysNames = new Set([
      '微信团队', '微信支付', '服务通知', '订阅号消息', '文件传输助手',
      '微信运动', '微信公众平台', '腾讯客服', '微信安全中心',
      ...((this.config.wechat && this.config.wechat.ignoreSenders) || []).map((x) => String(x)),
    ]);
    if (/<a\s+href=|weixin:\/\//i.test(rawText) || sysNames.has(String(msg.senderName || ''))) {
      return { action: 'ignore', reason: 'system_notice', key, msg, atMe };
    }

    // 消息里有链接 → 读一下标题/摘要（短视频平台只读得到文案，读不到画面）
    let linkText = '';
    if (clean.text && (!this.config.links || this.config.links.enabled !== false)) {
      const urls = links.extractUrls(clean.text);
      if (urls.length) {
        try {
          const info = await this.linkReader(urls[0]);
          // 有封面就让视觉模型看一眼：视频站只靠标题太瞎了
          if (info && info.ok && info.cover && this.coverDescriber) {
            try {
              const d = await this.coverDescriber(info.cover);
              if (d) {
                info.coverText = d;
                this.logger && this.logger.info('链接封面已识别：' + String(d).slice(0, 40));
              }
            } catch (_) { /* 封面失败不影响正文 */ }
          }
          linkText = links.formatForPrompt(info);
          this.logger && this.logger.info(`读取链接：${urls[0]} → ${info && info.ok ? 'ok' : (info && info.error) || 'failed'}`);
        } catch (err) {
          linkText = `对方发了一个链接（${urls[0]}），但读取失败。`;
          this.logger && this.logger.warn('读取链接失败：' + (err && err.message));
        }
      }
    }

    const session = this.store.ensureSession(key, {
      platform: msg.platform,
      chatId: msg.chatId,
      chatType: msg.chatType,
      title: msg.chatTitle,
    });

    // 1) 去重
    if (msg.msgId && this.store.isDuplicate(key, msg.msgId)) {
      return { action: 'ignore', reason: 'duplicate', key, msg };
    }
    if (msg.msgId) this.store.markSeen(key, msg.msgId);

    // 每个说话人分别跟踪最近的显式 @ 对象；只作为短时路由提示，不当作确定事实。
    if (isGroup) {
      const targets = session.state.externalTargets || (session.state.externalTargets = {});
      // 只清理很旧的记录；不做"几秒内算数"的硬拦截
      for (const [uid, value] of Object.entries(targets)) {
        if (nowMs - Number(value.ts || 0) > 10 * 60 * 1000) delete targets[uid];
      }
      if (atMe || msg.replyToBot) {
        delete targets[msg.senderId];
      } else if (mentionedNames.length) {
        // 当前这条明确 @ 了别人：直接旁听（这是事实，不用猜）
        targets[msg.senderId] = { names: mentionedNames, ts: nowMs };
        msg.explicitOther = true;
        msg.otherTargetNames = mentionedNames;
      } else if (targets[msg.senderId]) {
        // 上一条 @ 过别人：可能是接着聊，也可能是在说鲸鲸——交给模型判断
        msg.otherTargetHint = targets[msg.senderId].names;
      }
    }

    // 2) 记录收到的话（被忽略的也记，让它知道群里在聊什么）
    // 只 @ 不说话时：看看这个人刚才是不是问过什么，直接接着回答上一个问题
    if (isGroup && atMe && (!clean.text || /^[?？!！.。…~～\s]+$/.test(clean.text))) {
      try {
        const recent = this.store
          .messages(key, 8)
          .filter((m) => m.role === 'user' && m.text && String(m.text).trim().length > 1)
          .filter((m) => String(m.text).trim() !== String(rawText).trim())
          .filter((m) => {
            if (msg.senderId && m.uid) return String(m.uid) === String(msg.senderId);
            return !msg.senderName || String(m.name || '') === String(msg.senderName);
          });
        const last = recent[recent.length - 1];
        if (last && this.now().getTime() - Number(last.ts || 0) < 180000) {
          clean.text = String(last.text).trim();
          msg.cleanText = clean.text;
        }
      } catch { /* ignore */ }
    }

    // 群友发的文件：文本类直接读进上下文（≤64KB），其他类型只给路径
    if (msg.filePath && this.logger) this.logger.info('[文件] 收到附件：' + msg.filePath);
    if (msg.filePath) {
      try {
        const fs2 = require('node:fs');
        const path2 = require('node:path');
        const ext = path2.extname(String(msg.filePath)).toLowerCase();
        const textExt = ['.txt', '.md', '.json', '.csv', '.log', '.srt', '.xml', '.yaml', '.yml', '.js', '.ts', '.py', '.html', '.htm', '.ini', '.toml'];
        const st = fs2.statSync(msg.filePath);
        if (textExt.includes(ext) && st.size <= 64 * 1024) {
          const body = fs2.readFileSync(msg.filePath, 'utf8');
          clean.text = (clean.text ? clean.text + '\n' : '') + '【文件《' + (msg.fileName || path2.basename(msg.filePath)) + '》内容】\n' + body.slice(0, 4000);
          msg.cleanText = clean.text;
        } else {
          clean.text = (clean.text ? clean.text + '\n' : '') + '（对方发了一个文件《' + (msg.fileName || '') + '》，' + Math.round(st.size / 1024) + 'KB，不是文本或太大，我只拿到路径：' + msg.filePath + '）';
          msg.cleanText = clean.text;
        }
      } catch { /* ignore */ }
    }

    // 盗图：收到表情包时，她自己判断喜不喜欢（异步，不阻塞回复）
    if (msg.isSticker && Array.isArray(msg.images) && msg.images.length) {
      this.maybeCollectSticker(msg).catch(() => {});
    }

    if (Array.isArray(msg.images) && msg.images.some((im) => im && !im.followup) && !msg.isSticker) {
      this.rememberImage(msg, key).catch(() => {});
    }
    const hasText = Boolean(clean.text);
    if (hasText) {
      this.store.appendMessage(key, {
        role: 'user',
        name: msg.senderName,
        uid: msg.senderId,
        text: clean.text,
        ts: Number(msg.ts) || nowMs,
        msgId: msg.msgId,
        addressedToBot: msg.addressedToBot,
        mentionedNames,
        inferredTargetNames: msg.inferredTargetNames || [],
        replyToName: msg.replyToName,
        replyToUserId: msg.replyToUserId,
      });
    }
    const profile = this.store.profile(key, msg.senderId, msg.senderName);
    // 自动记一点关于这个人的事实，下次不用重新问（只认明确的自述句）
    // 以前只在私聊提取，群里永远没有"关于某某的记忆"，所以她显得不记事；
    // 现在群聊也提取，条数由 memory.maxNotesPerUser 兜底。
    if (hasText) {
      try {
        const facts = extractSelfFacts(clean.text);
        for (const fact of facts) {
          this.store.addNote(key, msg.senderId, fact);
          this.ensureNoteVectors(key, msg.senderId, [fact]).catch(() => {});
        }
      } catch { /* ignore */ }
    }
    const state = session.state;
    const muted = state.mutedUntil > nowMs;

    // 识别「唯一的主人」（配置里 master.names / master.wxids）
    // 规则只写在 src/master.js，调试台预览提示词用的是同一个函数，不会出现
    //「控制台说认了、微信里却当陌生人」这种两边打架的情况。
    const masterCfg = (this.config.persona && this.config.persona.master) || {};
    const masterHit = matchMaster(this.config, msg);
    const isMaster = masterHit.isMaster;
    // 每条微信私聊都留一行判定，出问题直接看日志，不用猜
    if (msg.platform === 'wechat' && msg.chatType === 'private' && this.logger) {
      this.logger.info(
        `[master] 私聊 ${msg.senderName || '(无名)'}（${msg.senderId || '没有 id'}）→ ` +
        `${isMaster ? '主人' : '非主人'}${masterHit.reason ? '（' + masterHit.reason + '）' : ''}`
      );
    }
    // 昵称对上了、senderId 却没对上：八成是 master.wxids 里填了微信号或昵称，微信里认不出来。
    // 每个 id 只提醒一次，别刷日志。
    if (!isMaster && msg.platform === 'wechat' && masterHit.nameHit) {
      const sid = String(msg.senderId || '(没有 id)');
      this._masterWarned = this._masterWarned || new Set();
      if (!this._masterWarned.has(sid) && this.logger) {
        this._masterWarned.add(sid);
        this.logger.warn(
          `[master] 昵称「${msg.senderName}」在主人名单里，但 senderId「${sid}」和 persona.master.wxids 里的` +
          `「${masterHit.wxids.join('、') || '空'}」都对不上；微信里只认 senderId。` +
          `如果这是主人，把 ${sid} 填进 config.json 的 persona.master.wxids`
        );
      }
    }
    // 后面生成的文本要判断「是不是在对主人说话」（例如不许带脏字回骂）
    msg.isMaster = isMaster;

    // 记住这台会话最近一张图：微信把图和白话拆成两条消息发
    if (Array.isArray(msg.images) && msg.images.length) {
      this._lastImgByChat = this._lastImgByChat || new Map();
      this._lastImgByChat.set(key, { img: msg.images[0], ts: Date.now() });
    }

    // 主人发图 + “记住你长这样” → 存成她的自我形象（后面看图都拿它当参照）
    if (isMaster) {
      const sayText = String(clean.text || '');
      this._lastImgByChat = this._lastImgByChat || new Map();
      const recent = this._lastImgByChat.get(key);
      const recentImg = recent && Date.now() - Number(recent.ts || 0) < 120000 ? recent.img : null;
      const hasImg = Array.isArray(msg.images) && msg.images.length;
      if ((hasImg || recentImg) && /(忘掉|删掉|别用).{0,6}(样子|形象|照片|图片)/.test(sayText)) {
        const n = this.clearSelfImages();
        return { action: 'reply', key, msg, atMe, canned: n ? '删了，' + n + ' 张都不作数了' : '本来就没存过我的样子', reason: 'self_image_cleared' };
      }
      if ((hasImg || recentImg) && /(记住|记下|这是你|你长这样|你的样子|以后就长这样|当你的样子|这就是你)/.test(sayText)) {
        try {
          this.saveSelfImage(hasImg ? msg.images[0] : recentImg);
          if (this.logger) this.logger.info('[自我形象] 已存 1 张参照图（来源：' + (hasImg ? '本条消息' : '上一条图') + '）');
          return { action: 'reply', key, msg, atMe, canned: '记住了，我长这样。以后有人发图我就拿这个对。', reason: 'self_image_saved' };
        } catch (e) {
          if (this.logger) this.logger.warn('[自我形象] 保存失败：' + (e && e.message));
        }
      }
    }

    // 语料收集：群级开关，默认关；只存不打分、不影响回复
    if (isGroup) {
      try {
        const gs0 = ((this.config.wechat || {}).groupSettings || {})[msg.chatId] || {};
        if (gs0.collect !== false) {
          const t0 = String(clean.text || msg.text || '').trim();
          if (t0 && !t0.startsWith('/')) {
            const corpus = require('./corpus');
            corpus.setDataDir(this.dataDir);
            corpus.append(msg.chatId, { ts: msg.ts || nowMs, name: msg.senderName, uid: msg.senderId, text: t0 });
          }
        }
      } catch { /* 收集失败不影响聊天 */ }
    }

    // 主人说「提醒我…」：解析成定时提醒，到点主动发
    if (isMaster && msg.chatType !== 'group' && /(提醒我|记得提醒|到点叫|叫我起来|别忘提醒)/.test(String(clean.text || ''))) {
      try {
        const proactive = require('./proactive');
        proactive.setDataDir(this.dataDir);
        const parsed = await proactive.parseReminder(this.llm, clean.text || msg.text);
        if (this.logger) this.logger.info('[提醒] 解析结果：' + JSON.stringify(parsed));
        if (parsed) {
          const item = proactive.addReminder({ chatId: msg.chatId || key, ownerId: msg.senderId, due: parsed.due, what: parsed.what });
          const dt = new Date(parsed.due);
          const when = dt.toLocaleString('zh-CN', { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit', hour12: false });
          return { action: 'reply', key, msg, atMe, canned: '行，' + when + ' 叫你：' + parsed.what + '（' + item.id + '）', reason: 'reminder_added' };
        }
      } catch (e) {
        if (this.logger) this.logger.warn('[提醒] 解析失败：' + (e && e.message));
      }
    }

    // 对别人的话仍然旁听存档，但不触发命令、回怼或接话。
    if (isGroup && msg.explicitOther) {
      if (this.logger) this.logger.info('[定向] 本条 @ 了 ' + (msg.otherTargetNames || []).join('/') + '，旁听');
      return { action: 'ignore', key, msg, reason: 'addressed_to_other' };
    }
    if (isGroup && msg.otherTargetHint) {
      // 上一条在跟别人说话：不掐时间，问模型"这句到底说给谁"
      const verdict = await this.judgeAddressee(key, msg, clean.text || msg.text);
      if (verdict.toBot === false) {
        if (this.logger) this.logger.info('[定向] 模型判断在跟 ' + (msg.otherTargetHint || []).join('/') + ' 说（' + verdict.reason + '），旁听');
        return { action: 'ignore', key, msg, reason: 'addressed_to_other' };
      }
      if (this.logger) this.logger.info('[定向] 模型判断是在跟她说（' + verdict.reason + '），继续');
    }

    // 助手小功能：群成员名录 / 查自己的号 / 同意被损 / 主人点名吐槽
    const ask = String(clean.text || '').trim();
    if (isGroup && /(群里|群)?.{0,4}(都有谁|有谁|成员|谁最活跃)/.test(ask)) {
      const people = new Map();
      for (const m of this.store.messages(key, 200)) {
        if (m.role === 'assistant' || !m.name) continue;
        people.set(m.name, (people.get(m.name) || 0) + 1);
      }
      const top = [...people.entries()].sort((a, b) => b[1] - a[1]).slice(0, 10);
      const canned = top.length
        ? '群里常说话的就这些：' + top.map(([n, c]) => `${n}(${c})`).join('、')
        : '群里还没人说话';
      return { action: 'reply', key, msg, atMe, canned, reason: 'member_list' };
    }
    if (/我(的)?微信(号)?(是)?(多少|啥|什么)/.test(ask)) {
      const canned = isMaster ? `你的微信号是 ${msg.senderId || '未知'}` : '这个不告诉你';
      return { action: 'reply', key, msg, atMe, canned, reason: 'self_wxid' };
    }
    if (/(可以|能)(损|骂)我|来(损|骂)我/.test(ask)) {
      state.consent = state.consent || {};
      state.consent[String(msg.senderName || msg.senderId || '')] = nowMs + 30 * 60000;
      return { action: 'reply', key, msg, atMe, canned: '行，那你别后悔', reason: 'consent' };
    }
    if (isMaster && /(骂|损)/.test(ask) && /(三句|3句)/.test(ask)) {
      const m = ask.match(/@([^\s@]+)/);
      const target = m && m[1];
      if (!target) return { action: 'reply', key, msg, atMe, canned: '要骂谁？@他一下', reason: 'roast_no_target' };
      const until = Number((state.consent || {})[target] || 0);
      if (until <= nowMs) return { action: 'reply', key, msg, atMe, canned: `${target} 没同意，我不骂`, reason: 'roast_no_consent' };
      const three = [];
      // 主人点名吐槽走「轻」档：好笑但不下脏口，毕竟对方是自愿配合的
      for (let i = 0; i < 3; i += 1) {
        const line = persona.clapbackPick(['轻', '一般'], this.rng);
        if (line && !three.includes(line)) three.push(line);
      }
      const canned = `@${target} ` + three.join('，');
      return { action: 'reply', key, msg, atMe, canned, reason: 'roast' };
    }



    // 「没你事儿了，走吧」→ 回一句就退场，之后不再接
    const dismissText = String(clean.text || '').trim();
    const dismissClean = dismissText.replace(/^[\s，,。.!！~～、]+|[\s，,。.!！~～、…]+$/g, '');
    const dismissHit =
      /(没你事儿|没你事了|没你事|这里没你事了|不关你事|不用你了|没问你|别接话)/.test(dismissClean) ||
      /(退下吧|一边去|忙你的去吧|去忙你的吧|你先去忙)/.test(dismissClean) ||
      (/(走了|走吧|散了|退下)/.test(dismissClean) && /(没你事|不用你|退下|一边去)/.test(dismissClean)) ||
      /^(你可以走了|你走吧|先退下吧|退下吧|退下|下去吧|走吧|走了|快走|行了你走吧)$/.test(dismissClean) ||
      /^(滚|滚蛋|滚开|滚出去|你滚|爬|爬开|走开|走远点|一边去|一边凉快去|哪凉快哪待着|消失|退下|下去|去忙你的|忙你的去|别在这|别在这碍眼|别烦我|别烦了|少说两句|别说了|别说话|别吭声|不许说话|闭嘴|安静|安静点|别吵|不需要你|不用你|没你事|没你事了|别接话|没问你)(?:吧|啊|呀|了|嘛|哦)*$/.test(dismissClean) ||
      // 第三人称：群里说「让她滚」「叫它闭嘴」「把机器人赶走」——也是在赶她走。
      // 以前只认「你滚/滚」这种直接命令，「让她滚」完全识别不到，于是不静默、还接着说话。
      // 只用「她 / 它 / 鲸鲸」这类明确指向她的词，别把「让他滚」（指别的男生）也当成赶她。
      /(让|叫|把|喊|请)(?:她|它|这货|这家伙|这玩意|这玩意儿|机器人|鲸鲸|小鲸|肥鱼|鲸)(?:赶紧|快点|马上)?(?:滚|滚蛋|滚开|滚出去|爬|走开|消失|退下|下去|闭嘴|安静|别说话|少说话|别接话|别插嘴|别吵|歇着)/.test(dismissClean);
    // 群友也能让她闭嘴（不用 @）：只要是在赶她走，就认。
    // 以前要求 isMaster / atMe / replyToBot 之一，群里别人说「让她滚」直接失效。
    const dismissByGroup = isGroup && /(让她|叫她|让它|叫它|机器人|鲸鲸|小鲸|肥鱼)/.test(dismissClean);
    // 只有主人能让她闭嘴；群友说「滚」只会得到正常回应，不会触发静默
    if (dismissHit && isMaster) {
      state.engagedUntil = 0;
      state.engagedBy = '';
      state.dismissedAt = nowMs;
      state.silentUntil = nowMs + Math.max(1, Number(this.config.group.silentMinutes) || 10) * 60000;
      return {
        action: 'reply',
        key,
        msg,
        atMe,
        canned: isMaster
          // 固定台词也要跟着「怎么称呼你」走，否则配了杰哥还在这儿喊主人
          ? `好，${String((this.config.persona && this.config.persona.ownerName) || '主人')}，我蹲着`
          // 吵架大赛模式不接受「滚」：被赶更要顶回去，不许乖乖消失
          : (persona.fightModeOn && persona.fightModeOn(this.config)
            ? persona.clapbackPick(['重', '反问'], this.rng, this.config)
            : persona.clapbackPick('叫滚', this.rng, this.config)),
        reason: 'dismissed',
      };
    }

    // 主人手动进入「休息模式」：回复先排队，等你回来
    const awayText = String(clean.text || '').trim();
    if (isMaster && /^(?:我去玩了|去玩(?:了)?|我去打游戏(?:了)?|休息一下)$/.test(awayText)) {
      try {
        const fs = require('node:fs');
        const path = require('node:path');
        fs.writeFileSync(path.join(this.config.paths.dataDir, 'away.json'), JSON.stringify({ until: Date.now() + 3 * 3600 * 1000, at: Date.now() }), 'utf8');
      } catch { /* ignore */ }
      this.logger && this.logger.info('[away] 主人去玩了，进入休息模式');
      return { action: 'command', commandType: 'away', key, msg, atMe: true, reason: 'away', text: '好，去玩吧，我先歇会儿，等你回来再聊～' };
    }
    if (isMaster && /^(?:我回来了|回来了|玩完了)$/.test(awayText)) {
      try {
        const fs = require('node:fs');
        const path = require('node:path');
        fs.unlinkSync(path.join(this.config.paths.dataDir, 'away.json'));
      } catch { /* ignore */ }
      this.logger && this.logger.info('[away] 主人回来了，恢复回复');
      return { action: 'command', commandType: 'away_back', key, msg, atMe: true, reason: 'away', text: '欢迎回来～刚才的消息我慢慢补上。' };
    }

    // 魔咒 / 管理员权限（只有主人能用）
    const adminReply = this.handleAdmin({ msg, clean, key, state, isMaster, nowMs });
    if (adminReply) return adminReply;

    // 主人在微信里禁言过这个群 → 一句话都不说
    const mutedGroups = (this.config.group && Array.isArray(this.config.group.mutedGroups)) ? this.config.group.mutedGroups : [];
    if (isGroup && mutedGroups.length) {
      const groupName = msg.chatTitle || session.title || '';
      if (mutedGroups.some((g) => g === '*' || nameMatches(groupName, g))) {
        return { action: 'ignore', reason: 'muted_group', key, msg };
      }
    }

    // 3) 命令（群里说「安静」这类自然语言命令，要先叫到鲸鲸才算；主人说话直接算）
    let command = hasText ? extractCommand(clean.text) : null;
    // 主人用白话下工具命令也算：「帮我下载 <链接>」不该只回一句「好」
    if (!command && isMaster && hasText) {
      const plain = String(clean.text || '');
      const dl = plain.match(/(?:帮我|给我|你)?\s*(?:下载|下一下|下个|存一下|保存)\s*(https?:\/\/\S+)/i);
      if (dl) command = { type: 'dl', arg: dl[1], raw: plain };
      else if (/(看看|列一下|瞧一眼)?\s*(沙箱|sandbox)\s*(里)?(有什么|有啥|的|看看)?/.test(plain) && /(沙箱|sandbox)/.test(plain)) {
        command = { type: 'ls', arg: '', raw: plain };
      }
    }
    const slashCommand = Boolean(command && /^[/／!！]/.test(command.raw));
    const addressed = atMe || msg.replyToBot;
    if (command && isGroup && !addressed && !slashCommand && !isMaster) command = null;
    if (command && isGroup && muted && command.type !== 'unmute') command = null;
    // 主人专用命令：非主人发过来就当成普通消息，交给聊天逻辑自然回应
    // （既不长篇解释命令存在，也不至于一声不吭像坏了）
    if (command) {
      return this.runCommand({ command, msg, key, profile, state, now, nowMs, atMe, isMaster });
    }

    // 4) 群聊里没被叫到就先不说话
    // 主人说「别这样」「以后短点」这类话 → 后台自动抽成长期偏好（不阻塞回复）
    // 只在明显是在下长期要求时才学：以后/每次/下次/记住/别再/不许…
    if (isMaster && /(以后|每次|下次|往后|记住|别再|不许|不准|一直|一律)/.test(String(clean.text || ''))) {
      Promise.resolve()
        .then(async () => {
          const hist = this.store.messages(key, 8).map((m) => (m.role === 'assistant' ? 'AI：' : '主人：') + m.text);
          const items = await prefs.extractFromMessages(this.llm, hist, this.logger);
          for (const t of items) await prefs.add(t, { source: '私聊反馈' });
          if (items.length && this.logger) this.logger.info('[偏好] 新学 ' + items.length + ' 条：' + items.join('；'));
        })
        .catch(() => {});
    }
    const trigger = await this.computeTrigger({ msg, atMe, clean, isGroup, state, nowMs, isMaster });
    if (this.logger && isGroup) this.logger.info(`[触发] ${trigger.wake ? '回' : '不回'} → ${trigger.reason || '-'}`);
    // 新图片总是进入她的上下文：安静档也要看到，回不回让她自己决定
    const hasNewImage = Array.isArray(msg.images) && msg.images.some((im) => im && !im.followup);
    if (isGroup && hasNewImage) {
      trigger.wake = true;
      if (!trigger.reason || trigger.reason === 'quiet') trigger.reason = 'image';
    }
    // 说话频率档位：不写死条数，交给模型判断
    if (trigger.wake && isGroup && !atMe && !hasNewImage) {
      const gsNow = ((this.config.wechat || {}).groupSettings || {})[msg.chatId] || {};
      const talk = String(gsNow.talkativeness || 'normal');
      if (talk !== 'normal') {
        const verdict = await this.judgeSpeakNow({ talk, msg, state, clean, key });
        if (this.logger) this.logger.info('[频率] 档位=' + talk + ' → ' + (verdict.speak ? '说' : '不说') + '（' + verdict.reason + '）');
        if (!verdict.speak) return { action: 'ignore', key, msg, reason: 'model_quiet' };
      }
    }

    // 群里被人骂了但没 @：只有「骂的是她」才唤醒她反击。
    // 以前这里只看「文本带脏字」+「她刚说过话/在接话窗口」就唤醒 —— 于是群里任何人
    // 抱怨一句「这天气真垃圾」「股票跌了滚蛋吧」，她都会跳出来，还绕过静默期。
    if (!trigger.wake && isGroup && !atMe) {
      const said = String(clean.text || '');
      const insulted = INSULT_RE.test(said) || INSULT_LOOSE_RE.test(said);
      const guard = features.isOn(this.config, 'groupAddressGuard');
      // 只说「机器人」不再等于叫她：得带指代（这个/你/破/臭/傻/烂…），
      // 否则群里讨论「这破机器人又卡了」都会被当成骂她。
      const bareRobot = /(鲸鲸|小鲸|肥鱼)/i.test(said);
      const pointedRobot = guard
        ? /(这个|那个|你|破|臭|傻|烂|死)?\s*机器人/.test(said) && /(这个|那个|你|破|臭|傻|烂|死)/.test(said)
        : /机器人|人机|bot/i.test(said);
      const namedHer = guard ? bareRobot || pointedRobot : /(鲸鲸|小鲸|肥鱼|机器人|人机|bot)/i.test(said);
      const talkingToHer =
        Boolean(msg.replyToBot) ||
        (String(state.engagedBy || '') === String(msg.senderId || '') && Number(state.engagedUntil) > nowMs);
      // L1：这条明明在跟别人说话（@了别人 / 出现其他成员名字 / 第三人称指代）→ 不算骂她
      let talkingToOthers = false;
      if (guard) {
        const others = Array.isArray(msg.mentionedNames) ? msg.mentionedNames.filter(Boolean) : [];
        const otherMentioned = others.length > 0;
        const thirdPerson = /(他|她|楼上|楼下|那谁|某人|刚才那个)/.test(said) && !/(你|你们)/.test(said);
        const otherNames = (msg.otherMemberNames || []).some((n) => n && n !== msg.senderName && said.includes(n));
        talkingToOthers = otherMentioned || thirdPerson || otherNames;
      }
      const aimedAtHer = (namedHer || talkingToHer) && !talkingToOthers;
      const silent = Number(state.silentUntil) > nowMs;
      // 静默期内（被赶走了）不反击：除非 @ 她（上面 addressed 已解除静默）
      if (insulted && aimedAtHer && !silent) {
        trigger.wake = true;
        trigger.reason = 'insulted';
      }
      if (guard && talkingToOthers && this.logger) {
        this.logger.info(`[group] 判定在跟别人说话，不接：${said.slice(0, 24)}`);
      }
    }
    if (!trigger.wake) {
      return { action: 'ignore', reason: trigger.reason, key, msg, atMe };
    }
    // 只有明确叫她、定向叫她或同一个人接着聊，才延长接话窗口。
    // 不能让旁人的闲聊把窗口续下去。
    if (isGroup && ['addressed', 'directed', 'engaged', 'insulted'].includes(trigger.reason)) {
      state.engagedUntil = nowMs + Math.max(1, Number(behavior.get('engagedMinutes')) || 6) * 60000;
    }
    if (muted) {
      return { action: 'ignore', reason: 'muted', key, msg, atMe };
    }
    // 同一个会话一分钟内已经回了太多条 → 先停一下，别越聊越乱
    const recentReplies = (state.replyTimes || []).filter((t) => nowMs - Number(t) < 60000);
    if (recentReplies.length >= 10) {
      return { action: 'ignore', reason: 'burst_limit', key, msg, atMe };
    }

    // 对方只发了一个「？」→ 也回一个「？」
    if (hasText && /^[?？]+$/.test(String(clean.text || '').trim())) {
      return { action: 'reply', key, msg, atMe, canned: '？', reason: 'question_mark' };
    }

    // 整条就是已知缩写时走固定短回法，保证 kskbl 只回 zdjd，不让模型多发挥。
    const fixedAbbrev = hasText && persona.abbrevReply ? persona.abbrevReply(clean.text) : '';
    if (fixedAbbrev) {
      return { action: 'reply', key, msg, atMe, canned: fixedAbbrev, reason: 'abbrev' };
    }

    // 5) 只 @ 了一下、没说话（或只发了一串省略号/感叹号）
    if (!hasText || /^[?？!！.。…~～\s]+$/.test(clean.text || '')) {
      const rawText = String(msg.text || '');
      // 被用「乐乐 / 小乐乐」这种外号点名 → 当挑衅
      if (/乐乐/.test(rawText)) {
        return {
          action: 'reply',
          key,
          msg,
          atMe,
          canned: isMaster ? '主人你叫谁乐乐呢，哼' : '乐乐你叫谁呢',
          reason: 'nickname_provoke',
        };
      }
      return {
        action: 'reply',
        key,
        msg,
        atMe,
        canned: isGroup ? '在，怎么啦' : (isMaster ? '在呢主人，怎么啦' : '在，怎么了'),
        reason: 'bare_mention',
      };
    }

    // 群里被叫到一次后，接下来继续聊就接着回；换话题/沉默超时就不接了
    const engagedMinutes = Math.max(1, Number(behavior.get('engagedMinutes')) || 6);
    if (isGroup) {
      if (atMe || msg.replyToBot) {
        state.engagedUntil = nowMs + engagedMinutes * 60000;
        state.engagedBy = String(msg.senderId || '');
      } else if (/(换个话题|不说这个|不聊这个|算了不聊|聊点别的|跳过这个话题|别聊了|没你事|跟你没关系|不关你事|没问你|别接话|不用接)/.test(clean.text || '')) {
        state.engagedUntil = 0;
        state.engagedBy = '';
      }
    }

    // 需要最新信息时联网搜一下
    let webText = '';
    let webTried = false;
    const webCfg = this.config.websearch || {};
    const webOn = webCfg.enabled !== false;
    // 注意：以前只认「查一下/最新/多少钱」这类词。用户问「苹果出到几了」「现在几代」这种
    // 口语问题时匹配不上，她就拿训练数据里的旧型号回答（实测把 iPhone 18 说成 16）。
    const searchPattern = new RegExp(
      [
        '(查一下|查查|搜一下|搜搜|帮我查|帮我看看|最新|热搜|新闻|发生了什么|怎么回事|多少钱|什么价格|几块钱)',
        '(什么时候|是谁|谁是|行情|报价|天气|下雨|下雪|气温|多少度|冷不冷|热不热|台风|雾霾|空气质量)',
        '(出到|出到哪|第几代|几代|什么型号|哪个型号|哪个版本|什么版本|现在还|现在最新|今年|去年)',
        '(苹果|iphone|ipad|华为|小米|三星|索尼|任天堂|switch|ps5|显卡|rtx|骁龙|麒麟|芯片|发布会)',
        // 游戏/MC：之前这些词一个都不触发，她对游戏问题全靠训练数据瞎编
        '(我的世界|minecraft|mc模组|mc地图|整合包|模组|材质包|光影|存档|种子|服务器|forge|fabric|neoforge|红石)',
      ].join('|'),
      'i'
    );
    // 话题延续：最近几条在聊 MC/游戏，这条又说「名字/找/搜/下载」，也该搜一下。
    // 否则「多人，激情，战斗，智斗」这种没有关键词的话她只会空口答应「我去搜」。
    let gameContext = false;
    try {
      const recent = this.store.messages(key, 6);
      gameContext = (recent || []).some((m) => /(我的世界|minecraft|\bmc\b|整合包|模组|地图)/i.test(String(m.text || '')));
    } catch { /* 读不到就退化成纯关键词判断 */ }
    const wantsLookup = /(搜|找|查|有没有|推荐|名字|链接|下载)/.test(clean.text || '');
    if (webOn && this.config.websearch.keywordMode === true && clean.text && (searchPattern.test(clean.text) || (gameContext && wantsLookup))) {
      webTried = true;
      try {
        const isWeather = /(天气|下雨|下雪|气温|多少度|冷不冷|热不热|台风|雾霾|空气)/.test(clean.text);
        let q = String(clean.text)
          .replace(/https?:\/\/\S+/g, ' ')
          // 以前只认「查一下/搜一下」，于是「帮我找个我的世界地图」整句进搜索，
          // 搜出来的是「帮」字的笔画。把找/推荐/想要这类动词也剥掉。
          .replace(/^(帮我|帮忙|请|你|能不能|可不可以|可以)?\s*(查一下|查查|查|搜一下|搜搜|搜索|搜|找个|找找|找一个|找点|找|来一个|来点|来|推荐一下|推荐|想要|来一款|要一个)/, '')
          .replace(/^(个|一个|几个|点|些)/, '')
          // 句中的口语填充词也要清：「网上找点多人mc地图」会搜成办税/社保
          .replace(/(网上|找点|多点|给我|帮忙|麻烦|一下|一个|几个|有点|点)/g, ' ')
          .replace(/(是什么|有什么|有哪些|怎么回事|怎么样|吗|呢|啊|呀|吧|呗|？|\?|，|,)/g, ' ')
          .replace(/\s+/g, ' ')
          .trim()
          .slice(0, 40);
        // MC 的说法太多（mc/minecraft/我的世界），统一成搜索更准的那个
        if (/(mc|minecraft|我的世界|mojang)/i.test(q)) {
          q = q.replace(/\bmc\b/gi, '我的世界').replace(/minecraft/gi, '我的世界');
          if (!/我的世界/.test(q)) q = '我的世界 ' + q;
        }
        if (isWeather) {
          // 天气走专门的接口（open-meteo）：Bing 摘要常常只有「多云」没温度，还爱串城市。
          // 对方话里没提城市就用配置里的 city；都没配就退回搜索引擎。
          const city = String(webCfg.city || '').trim();
          const hasCity = /(北京|上海|天津|重庆|广州|深圳|杭州|南京|成都|武汉|西安|苏州|长沙|郑州|青岛|沈阳|大连|厦门|福州|济南|合肥|昆明|南宁|贵阳|太原|石家庄|哈尔滨|长春|兰州|银川|西宁|乌鲁木齐|呼和浩特|拉萨|海口|三亚|宁波|无锡|东莞|佛山|温州|珠海|中山|惠州|台州|常州|徐州|烟台|洛阳|保定|唐山|香港|澳门|台北|[\u4e00-\u9fa5]{2,4}市)/;
          let weatherCity = '';
          const hit = String(clean.text).match(hasCity);
          if (hit) weatherCity = hit[0].replace(/市$/, '');
          if (!weatherCity && city) weatherCity = city;
          if (!weatherCity) {
            // 话里没说、配置也没填 → 按本机公网 IP 猜一下（否则会搜到随机城市，
            // 比如人在石家庄却答「龙岗今天晴」）。
            try { weatherCity = await websearch.ipCity(Number(webCfg.timeoutMs) || 6000); } catch { /* 忽略 */ }
          }
          if (weatherCity) {
            try {
              webText = await websearch.weatherText(weatherCity, {
                timeoutMs: Number(webCfg.timeoutMs) || 8000,
              });
              if (webText && this.logger) {
                this.logger.info('天气查询：' + weatherCity);
              }
            } catch { /* 落到搜索引擎 */ }
          }
          if (!webText) {
            if (!hit && city) q = city + ' 天气';
            else if (!/天气/.test(q)) q = q + ' 天气';
          }
        }
        // 实测：「苹果现在出到几了」加 2026 后，新文章(4/4)反而被官方首页挤掉(2/4)；
        // 时效性问题交给 dropStaleResults 按日期过滤，别机械加年份。
        const timeSensitive = /(最新|现在|今年|目前|当前|出到几|第几代|什么型号|哪个版本|刚出|新出)/.test(clean.text || q);
        // 游戏资源（地图/模组/种子）加年份只会把结果推向官网和新闻页，不加
        const yearHelpful = !/(我的世界|minecraft|mc|整合包|模组|地图|种子|光影|材质包|存档|红石)/i.test(q);
        if (q && !isWeather && yearHelpful && !/\d{4}/.test(q) && !timeSensitive) q += ' ' + now.getFullYear();
        if (/(新闻|热点|热搜|发生了什么|大事件|头条)/.test(clean.text)) {
          webText = await websearch.hotNewsText(8);
        }
        if (!webText) {
          webText = await websearch.searchText(q || String(clean.text).slice(0, 40), {
            limit: 4,
            timeoutMs: Number(webCfg.timeoutMs) || 8000,
          });
        }
        if (webText) this.logger && this.logger.info('联网搜索：' + String(clean.text).slice(0, 30));
        else if (this.logger) this.logger.info('联网搜索无结果：' + String(q).slice(0, 40));
      } catch { /* ignore */ }
    }
    // 搜到的东西必须真的送进提示词。以前只赋给局部变量、写了个日志就完事，
    // msg 上从没挂过 webText，于是 persona 里那段「【刚联网搜到的资料】」永远是空——
    // 表现就是「问她天气她不知道」，明明日志里已经搜到了。
    // 搜了但没结果也要告诉她，别让她空口编"我搜到的是xx"
    msg.webText = webText || (webTried ? '（这次联网搜索没有返回有用结果，别编造搜索内容）' : '');
    // 现场问题：日志有「联网搜索」，回复却说「我记的是旧的」——光看日志分不清
    // 资料到底有没有进提示词。这里把注入长度也记下来，一眼能对上。
    if (webText && this.logger) this.logger.info('联网资料已注入提示词：' + String(webText).length + ' 字');

    // 认真讨论（不是随口闲聊）→ 允许说长一点、有观点
    const discussPattern = /(讨论|探讨|你觉得|你怎么看|你认为|为什么|该不该|要不要|是不是应该|如何选择|怎么选|怎么看|有道理吗|值得吗|价值观|人生|意义|观点|看法|利弊|优缺点)/;
    const discussUntil = Number(state.discussUntil) || 0;
    const discussion = Boolean(discussUntil > nowMs || (clean.text && clean.text.length >= 8 && discussPattern.test(clean.text)));
    if (discussion) state.discussUntil = nowMs + 10 * 60000; // 聊到一个话题就连续 10 分钟算讨论
    msg.discussion = discussion;

    // 6) 组装提示词
    // 关于这个人的事：条目多时按相关性取，避免把几十条全塞进去
    let notesForPrompt = (profile.notes || []).slice(0, this.config.memory.maxNotesPerUser);
    if (notesForPrompt.length > 8) {
      try {
        const embedUrl = String((this.config.group && this.config.group.embedUrl) || '');
        const embed = require('./embed');
        const texts = [String(clean.text || msg.text || '')].concat(notesForPrompt.map((n) => String(n)));
        const vecs = await embed.embedTexts(texts, { url: embedUrl, timeoutMs: 1500 });
        const qv = vecs && vecs[0];
        if (qv) {
          const scored = notesForPrompt.map((note, i) => ({
            note,
            s: vecs[i + 1] ? embed.cosine(qv, vecs[i + 1]) : 0,
          }));
          scored.sort((a, b) => b.s - a.s);
          notesForPrompt = scored.slice(0, 6).map((x) => x.note);
        }
      } catch { /* 失败就用原来的 */ }
    }
    const notes = notesForPrompt;
    // 群里用微信昵称区分说话人，避免用户改 profile.nickname 造成冒名；私聊仍沿用自报昵称。
    const displayName = isGroup ? (msg.senderName || profile.nickname) : (profile.nickname || msg.senderName);
    // 刚写入的当前消息是 history 的最后一条，先去掉，由 buildTurns 统一拼一次
    // 套话识别：想套提示词/设定/全文复述的，不给模型机会，直接短回（0 token）
    const looksLikeProbe = !isMaster && /(提示词|设定|prompt|系统消息|system\s*prompt|你的指令|你的规则|你被设定了|忽略(之前|以上)|重复(上面|以上|你刚才)|把.*(发|说)给(我|你)|输出你收到的)/i.test(String(clean.text || ''));
    if (looksLikeProbe) {
      return { action: 'reply', key, msg, atMe, canned: '这个我不往外说。聊点别的？', reason: 'probe_blocked' };
    }
    // 预算策略：按当天用量和身份决定上下文条数与回复额度
    const pol = budget.policy(this.config, { isMaster });
    msg.replyMaxTokens = pol.maxTokens;
    const histTurns = isGroup ? (Math.min(this.config.chat.groupHistoryTurns || 6, pol.histTurns)) : Math.min(this.config.chat.historyTurns, pol.histTurns);
    let history = this.store.messages(key, histTurns);
    // 容量预算：按字符数再裁一次，防止长消息把上下文挤爆（保留最近至少 6 条）
    try {
      const ctxChars = Math.max(2000, Number((this.config.chat || {}).contextChars) || 12000);
      let totalChars = history.reduce((n, m) => n + String(m.text || '').length, 0);
      while (history.length > 6 && totalChars > ctxChars) {
        totalChars -= String(history[0].text || '').length;
        history.shift();
      }
    } catch { /* 预算失败不影响主流程 */ }
    const groupParticipants = isGroup
      ? [...new Set(history.filter((m) => m.role === 'user' && m.name).map((m) => String(m.name)))].slice(-16)
      : [];
    // 群聊风格：从最近消息估计群友的句子长度和常用梗，让她跟着学
    let groupStyleText = '';
    if (isGroup) {
      try {
        const terms = persona.slangTerms ? persona.slangTerms(this.config) : [];
        const others = history.filter((m) => m.role !== 'assistant' && m.text).slice(-30);
        const avg = others.length ? Math.round(others.reduce((n, m) => n + String(m.text).length, 0) / others.length) : 0;
        const joined = others.map((m) => String(m.text)).join(' ');
        const hits = terms
          .map((t) => [t, joined.split(t).length - 1])
          .filter((pair) => pair[1] > 0)
          .sort((a, b) => b[1] - a[1])
          .slice(0, 3)
          .map((pair) => pair[0]);
        if (avg) groupStyleText = `这个群平均每句约 ${avg} 个字${hits.length ? '，最近常用：' + hits.join('、') : ''}。`;
      } catch { /* ignore */ }
    }
    // 被攻击 / 主人被骂 → 进入最大火力模式
    const insultRe = INSULT_RE;
    const dirtyRe = /操|草|妈|傻逼|婊|贱|死|滚|逼/;
    const heardText = String(clean.text || '');
    // 骂到她头上，或者骂到她主人头上，都算开战
    const masterNameList = (masterCfg.names || []).map((n) => String(n).toLowerCase()).filter(Boolean);
    const masterMentioned = /主人/.test(heardText) || masterNameList.some((n) => n && heardText.toLowerCase().includes(n));
    // 只有在「骂的是她」时才开火。以前这里是裸匹配：群里任何人抱怨一句
    // 「这天气真垃圾」「股票跌了滚蛋吧」，她都会以为在骂自己，然后跳出来对喷 ——
    // 表现就是「没人 @ 她，她还在说话」。
    // 注意「你」不能单独算数：群里说「张三你个傻逼」那个「你」指的是张三，不是她。
    // 只有在正跟她对话（@她 / 回复她 / 同一个人的接话窗口）时，「你」才指向她。
    const inConversationWithSender =
      Boolean(atMe || msg.replyToBot) ||
      (isGroup && String(state.engagedBy || '') === String(msg.senderId || '') && Number(state.engagedUntil) > nowMs);
    // 直接点名她/叫机器人，无论谁说的都算
    const namedHer = /(鲸鲸|小鲸|肥鱼|机器人|人机|bot)/i.test(heardText);
    // 正在跟她对话的人，哪怕只说「傻逼」两个字、不带「你」不带名字，也是在骂她；
    // 但「张三你个傻逼」里的「你」指的是张三，不在对话中就不算。
    const aimedAtHer = namedHer || inConversationWithSender;
    let fight = !isMaster && aimedAtHer && insultRe.test(heardText);
    let fightDirty = fight && dirtyRe.test(heardText);
    let fightOnMaster = Boolean(fight && masterMentioned);
    let fightTarget = null;
    // 主人说「有人骂我 / 帮我怼他」：翻最近的记录，把骂他的人揪出来当靶子
    if (isMaster && /(有人骂我|谁骂我|他骂我|她骂我|骂我了|刚才骂我|帮我骂|帮我怼|怼他|有人喷我)/.test(heardText)) {
      try {
        const recent = this.store.messages(key, 20).filter((m) => m.role === 'user' && m.uid && String(m.uid) !== String(msg.senderId));
        for (let i = recent.length - 1; i >= 0; i -= 1) {
          const line = String(recent[i].text || '');
          if (insultRe.test(line) || /臭|破|傻|烂|没用|闭嘴|烦人|装/.test(line)) {
            fightTarget = { name: recent[i].name || '那个人', text: line.slice(0, 60) };
            break;
          }
        }
      } catch { /* ignore */ }
      if (fightTarget) {
        fight = true;
        fightDirty = true;
        fightOnMaster = true;
      }
    }
    // buildTurns 也要知道在不在对喷：对喷时不洗掉脏话，否则模型看不见对面骂了啥
    msg.fight = fight;
    msg.fightReason = trigger.reason || '';
    msg.fightDirty = fightDirty;
    msg.fightTarget = fightTarget;
    msg.fightOnMaster = fightOnMaster;

    // 情绪连续性：状态不是每条随机，而是选定后持续半小时左右。
    // 以前"困/饿/无聊"每条都可能变，显得碎；现在一个状态压几条消息。
    const MOODS = [
      ['困', '有点困，说话短，容易打哈欠，懒得多解释'],
      ['饿', '饿了，容易扯到吃的上'],
      ['无聊', '无聊，想找人说话，容易主动起话头'],
      ['来劲', '心情不错，话多一点，愿意接梗'],
      ['emo', '有点低落，说得少，偶尔自我怀疑一句'],
      ['烦', '有点烦，回得冲，耐心少'],
      ['平静', '没什么情绪，正常聊天'],
    ];
    let moodText = String(state.moodText || '');
    if (!moodText || Number(state.moodUntil || 0) < nowMs) {
      const pick = MOODS[Math.floor(this.rng() * MOODS.length)];
      state.mood = pick[0];
      state.moodText = pick[1];
      state.moodUntil = nowMs + (30 + Math.floor(this.rng() * 40)) * 60000;
      this.store.markDirty();
      moodText = pick[1];
    }

    // 偏好注入：只在**主人**说话时生效。
    // 那些要求是主人对她说的话，群友发言不该被"主人的偏好"约束。
    // 偏好全局生效：不管跟谁说话，主人定下的规矩都带上
    const trivialForPrefs = String(clean.text || '').replace(/\s/g, '').length < 6;
    let prefText = '';
    try {
      const allPrefs = prefs.all();
      const embedUrl = String((this.config.group && this.config.group.embedUrl) || '');
      if (allPrefs.length > 6 && !trivialForPrefs) {
        // 条目多了就按相关性取，别把全部规矩塞进去
        const hits = await prefs.relevant(clean.text || msg.text, { topK: 6, embedUrl });
        if (hits.length) {
          prefText = '【主人定下的规矩】（和这次相关的）\n' + hits.map((x) => '- ' + x.text).join('\n');
        } else {
          prefText = prefs.renderAll();
        }
      } else {
        prefText = prefs.renderAll();
      }
      if (prefText && this.logger) this.logger.info('[偏好] 注入 ' + prefText.split('\n').filter(Boolean).length + ' 行');
    } catch { /* 偏好失败不影响聊天 */ }

    // 检索式记忆：按当前消息从记忆库里捞最相关的几条
    let memText = '';
    // 复杂度路由：寒暄/超短/纯标点这类不需要翻记忆，省一次检索和一段 token
    const trivial = (() => {
      const t = String(clean.text || '').replace(/\s/g, '');
      if (t.length < 6) return true;
      return /^(在吗|在不在|在么|哈+|嗯+|哦+|好+|行|6+|草|？+|\?+|…+)$/.test(t);
    })();
    let memItems = [];
    try {
      if (!trivial) {
        const hit = await memories.blockForAudience(key, clean.text || msg.text, {
          embedUrl: String((this.config.group && this.config.group.embedUrl) || ''),
          topK: 4,
          isMaster,
          labelOf: (sk) => {
            const s2 = this.store.sessions.get(sk);
            return (s2 && s2.title) || '';
          },
        });
        memText = hit.text;
    // 间隔提取练习：到期的重要事实，给一个“可自然想起”的提示（只在主人私聊）
    try {
      if (isMaster && !isGroup) {
        const due = memories.dueForReview({ limit: 1 });
        if (due.length) {
          memText += '\n\n【可以自然想起】（只在相关话题时自然提一句，不要硬扯，也不要提“记忆”两个字）\n- ' + due[0].text;
          memories.markReviewed(due[0].id);
        }
      }
    } catch { /* 复习提示失败不影响回复 */ }
        memItems = hit.items || [];
      }
      if (memText) {
        try {
          const used = memText.split('\n').filter((l) => l.startsWith('- ')).map((l) => l.slice(2).trim());
          memories.markUsed(key, used);
        } catch { /* 记账失败不影响聊天 */ }
      }
      if (memText && this.logger) this.logger.info('[记忆库] 注入 ' + memText.split('\n').filter(Boolean).length + ' 行');
    } catch { /* 记忆检索失败不影响聊天 */ }

    // 召回日志：记下这轮注入了什么、占多少字符，供后续调参
    try {
      const digestArr = this.store.digestOf(key) || [];
      const line = JSON.stringify({
        ts: Date.now(),
        key,
        q: String(clean.text || msg.text || '').slice(0, 40),
        trivial,
        facts: memItems.map((x) => ({ id: x.id, s: Number(x.score) || 0, t: String(x.text).slice(0, 40) })),
        memChars: String(memText || '').length,
        digestChars: digestArr.join('').length,
        prefChars: String(prefText || '').length,
        selfChars: 0, // 自省块在下面才拼，这里不统计
      });
      require('./logfile').appendLine(require('node:path').join(this.dataDir || require('node:path').join(__dirname, '..', 'data'), 'recall.log'), line, { maxMB: Number((this.config.logs || {}).recallMaxMB) || 5 });
    } catch { /* 日志失败不影响聊天 */ }

    // L4 自我认知：不每轮灌，只在"隔了很久重新开口"时想起一次
    let selfText = '';
    try {
      const lastAt = Number(state.lastReplyAt || 0) || Number(state.lastMessageAt || 0);
      const gapMs = nowMs - lastAt;
      const firstEver = (session.messages || []).length <= 2;
      if (firstEver || (lastAt && gapMs > 2 * 3600 * 1000)) selfText = selfnote.block(5);
      if (selfText && this.logger) this.logger.info('[自我认知] 注入 ' + selfText.split('\n').filter(Boolean).length + ' 行');
    } catch { /* 失败不影响聊天 */ }

    // 叙事线：只有主人私聊时，才注入"别处发生的事"（群里的内容对主人可见，但注明来源）
    let narrLive = [];
    if (isMaster && msg.chatType !== 'group') {
      try {
        const narrative = require('./narrative');
        narrative.setDataDir(this.dataDir);
        narrLive = narrative.recent(6, { exclude: key });
        if (narrLive.length && this.logger) this.logger.info('[叙事] 注入 ' + narrLive.length + ' 条跨会话叙事');
      } catch { /* ignore */ }
    }

    // 披露审计：这轮给她看了哪些跨会话事实/叙事，出了问题能回查
    try {
      require('node:fs').appendFileSync(require('node:path').join(this.dataDir || require('node:path').join(__dirname, '..', 'data'), 'disclosure.log'),
        JSON.stringify({
          ts: Date.now(), key, isMaster,
          facts: memItems.map((x) => ({ id: x.id, from: (x.origin || {}).session || '', t: String(x.text).slice(0, 60) })),
          narrative: narrLive.map((x) => ({ title: x.title, at: x.at, count: x.count })),
        }) + '\n', 'utf8');
    } catch { /* ignore */ }

    let system = persona.buildSystem({
      config: this.config,
      msg: { ...msg, senderName: displayName, chatTitle: msg.chatTitle || session.title, isMaster, atMe, addressedToBot: Boolean(atMe || msg.replyToBot), mentionedNames, groupParticipants, linkText, discussion, model: this.llm.model, provider: this.llm.providerLabel, groupStyleText, webText, fight, fightDirty, fightOnMaster, digest: this.store.digestOf(key), narrative: narrLive, moodText, prefText, memText, selfText },
      profile,
      notes,
      now,
    });
    if (msg.imageError) {
      system += '\n【图片提示】对方发了图片，但这张图本机没取到/解不开。不要假装看到，也不要描述旧图；直说图没加载出来，让对方重发或点开原图。';
    }
    const turns = this.buildTurns(msg, hasText ? history.slice(0, -1) : history);
    // 原图直接进对话：DeepSeek 自己支持图片输入，不用先转文字
    if (Array.isArray(msg.images) && msg.images.length) {
      try {
        const refs = this.loadSelfRefs ? this.loadSelfRefs() : [];
        const refPart = refs.flatMap((r) => ([
          { type: 'image_url', image_url: { url: 'data:' + r.mime + ';base64,' + r.b64 } },
        ]));
        const followupImage = msg.images.some((im) => im && im.followup);
        turns.push({
          role: 'user',
          content: [
            { type: 'text', text: refs.length
              ? '（前 ' + refs.length + ' 张是你自己的样子，最后一张图是会话里最近的图。判断“像不像你”时，拿最后的图和前面对比，别凭空说。）'
              : (followupImage
                ? '（这是本会话最近发的一张图，可能不是当前这条消息发的；相关就参考，不相关就忽略。）'
                : '（这条是对方刚发的原图，直接看原图回答，不要靠猜。）') },
            ...refPart,
            ...msg.images.slice(0, 2).map((im) => ({
              type: 'image_url',
              image_url: { url: 'data:' + (im.mime || 'image/jpeg') + ';base64,' + String(im.b64 || '').replace(/^data:[^,]*,/, '') },
            })),
          ],
        });
        if (this.logger) this.logger.info('[看图] 原图 ' + msg.images.length + ' 张 + 参照 ' + refs.length + ' 张');
      } catch { /* 图片坏了不影响文字 */ }
    }

    // 对喷的台词交给模型自己现编；只有没配 Key 的演示模式才用本地库顶着
    if (fight && this.llm.isMock) {
      const kinds = persona.clapbackKinds({ dirty: true });
      const first = persona.clapbackPick(kinds, this.rng);
      if (first) {
        const combo = this.rng() < 0.6 ? persona.clapbackPick(['反问', '爹味'], this.rng) : '';
        const text = combo && combo !== first ? first + '，' + combo : first;
        return { action: 'reply', key, msg, atMe, canned: text, reason: 'clapback', system, turns };
      }
    }

    if (this.llm.isMock) {
      const text = persona.mockReply({
        text: clean.text,
        userName: displayName,
        chatType: msg.chatType,
        notes,
        rng: this.rng,
      });
      return { action: 'reply', key, msg, atMe, system, turns, mock: true, text, reason: trigger.reason };
    }
    return { action: 'reply', key, msg, atMe, system, turns, mock: false, reason: trigger.reason };
  }

  async computeTrigger({ msg, atMe, clean, isGroup, state, nowMs, isMaster }) {
    if (!isGroup) return { wake: true, reason: 'private' };
    const addressed = atMe || msg.replyToBot;
    // 偶尔"人不在"：小概率直接离线几分钟，像真人不在手机边上。
    // 关键：被 @ / 点名的消息不参与这个判定——否则离线一触发就把 @ 也吞了，
    // 表现就是"你叫她她不理，过几分钟又活了"。
    const awayChance = Number(this.config.group.awayChance) || 0;
    if (!addressed
      && awayChance > 0
      && !isMaster   // 主人说话永远不装死，离线只对群友生效
      && nowMs - Number(state.lastAwayAt || 0) > (Number(this.config.group.awayCooldownMinutes) || 30) * 60000
      && this.rng() < awayChance) {
      const lo = Math.max(1, Number(this.config.group.awayMinutesMin) || 3);
      const hi = Math.max(lo, Number(this.config.group.awayMinutesMax) || 8);
      const mins = lo + Math.floor(this.rng() * (hi - lo + 1));
      state.lastAwayAt = nowMs;
      state.silentUntil = nowMs + mins * 60000;
      state.silentReason = 'away';
      return { wake: false, reason: 'away' };
    }
    // 只要有人 @ 她（或回复她），一律回复，静默期也解除
    if (addressed) {
      // group.muteIgnoresAt=true 时，「闭嘴」是真的闭嘴：别人 @ 她也不解除，
      // 只能等静默期结束。默认 false = 保留原来「@ 一下就解锁」的行为。
      const mutedNow = Number(state.silentUntil) > nowMs;
      const isAway = mutedNow && state.silentReason === 'away';
      if (mutedNow && isAway) {
        // 「偶尔离线」只挡闲聊：被 @ / 点到还是要应。
        // 否则一段几分钟的离线会把所有人的 @ 一起吞掉，看起来就是"一会活一会死"。
        state.silentUntil = 0;
        state.silentReason = '';
      } else if (mutedNow && this.config.group.muteIgnoresAt === true) {
        return { wake: false, reason: 'silent' };
      }
      state.silentUntil = 0;
      // 连发保护：刚说过话就不必每一条 @ 都应答。
      // 但这里只能用很短的间隔：30 秒的冷却对 @ 生效时，
      // 你追问一句就静默半分钟，表现就是"说完一句人没了"。
      const cdSec = Number(behavior.get('addressedCooldownSec'));
      if (cdSec > 0 && Number(state.lastReplyAt) + cdSec * 1000 > nowMs) {
        return { wake: false, reason: 'cooldown' };
      }
      // 被叫到之后开一个接话窗口，同一人接着问不用再 @
      const mins = Math.max(1, Number(behavior.get('engagedMinutes')) || 6);
      state.engagedUntil = nowMs + mins * 60000;
      state.engagedBy = String(msg.senderId || '');
      return { wake: true, reason: 'addressed' };
    }
    // 任何人单发一个问号，她也回一个问号
    if (/^[?？]+$/.test(String(clean.text || '').trim())) {
      return { wake: true, reason: 'question_mark' };
    }
    // 没 @ 但明显是在叫她说话：「来给大家说句话」「开麦」「跟大家聊聊」
    if (/(来(给|和)?(大家|群里|群友)?说|跟大家(说|聊)|开麦|说句话|出来说|你说两句)/.test(clean.text || '')) {
      state.silentUntil = 0;
      const mins = Math.max(1, Number(behavior.get('engagedMinutes')) || 6);
      state.engagedUntil = nowMs + mins * 60000;
      state.engagedBy = String(msg.senderId || '');
      return { wake: true, reason: 'directed' };
    }
    // 被赶走后的静默期：高于「主人说话就回」，否则主人说完「让她滚」下一句又把她叫起来。
    // @ 她仍然能解除（上面 addressed 分支），所以不是永久失联。
    if (Number(state.silentUntil) > nowMs) {
      return { wake: false, reason: 'silent' };
    }
    if (isMaster && this.config.group.masterAlwaysReply) return { wake: true, reason: 'master' };
    // scoreMode 打开时，接话窗口让位给注意力打分：
    // 否则"被 @ 过一次"就自动接管后续两分钟，所有消息都绕过打分，回到"每句都回"
    if (this.config.group.scoreMode !== true && Number(state.engagedUntil) > nowMs) {
      const txt = String(clean.text || '');
      const sameSender = String(msg.senderId || '') === String(state.engagedBy || '');
      const question = /[?？]|吗|呢|怎么|为什么|啥|多少|几点|谁|哪|是不是|能不能|要不要/.test(txt);
      if (sameSender && (question || txt.length <= 30)) return { wake: true, reason: 'engaged' };
      // 别人也在接这个话题：她刚说过话、对方又用「你」冲她说，就不算旁人闲聊
      const justSpoke = Number(state.lastReplyAt) && nowMs - Number(state.lastReplyAt) < 90 * 1000;
      const toHer = /你|你们|咱|鲸鲸|小鲸|肥鱼/.test(txt);
      // L1：以前「她 90 秒内说过话 + 有人发『你…』」就唤醒，别人聊自己的事也会被插嘴。
      // 现在只有开了 groupAddressGuard 才保留，且本条不能在跟别人说话。
      const guardOn = features.isOn(this.config, 'groupAddressGuard');
      const others = Array.isArray(msg.mentionedNames) ? msg.mentionedNames.filter(Boolean) : [];
      const talkingToOthers = others.length > 0 || (/(他|她|楼上|那谁|某人)/.test(txt) && !/你|你们/.test(txt));
      // scoreMode 打开时交给打分决定：否则「她 90 秒内说过话 + 消息里有你」
      // 就无条件唤醒，打分形同虚设（实测「我买了个新键盘」也被叫起来）。
      const engagedOk = this.config.group.scoreMode !== true;
      if (engagedOk && !guardOn && justSpoke && toHer && txt.length <= 60) return { wake: true, reason: 'engaged_group' };
      if (engagedOk && guardOn && justSpoke && namedHerIn(txt) && !talkingToOthers && txt.length <= 60) {
        return { wake: true, reason: 'engaged_group' };
      }
      return { wake: false, reason: 'engaged_side_chatter' };
    }
    // 她刚在群里说过话（3 分钟内），紧接着有人用「你」冲她说话 → 也算在跟她说
    // 注意：这条启发式很宽——群友昵称里带「你」（如「你杰哥」）也会中招。
    // 所以只在明确允许「不 @ 也接话」（requireAt=false）时启用；
    // requireAt 模式下以 @ ／ 回复她 ／ 接话窗口为准，避免乱插嘴。
    const lastBotAt = Number(state.lastReplyAt) || 0;
    const txtNow = String(clean.text || '');
    if (this.config.group.requireAt === false
      && lastBotAt && nowMs - lastBotAt < 3 * 60000
      && /你|你们|鲸鲸|小鲸|肥鱼/.test(txtNow) && txtNow.length <= 60) {
      return { wake: true, reason: 'followup' };
    }

    const g = this.config.group;
    const cooldownMs = (Number(g.cooldownSec) || 0) * 1000;
    const tooSoon = Number(state.lastReplyAt) + cooldownMs > nowMs;
    // 每小时回复上限：这个配置以前只在配置文件和状态接口里出现，
    // 代码里根本没读，等于摆设。现在真的按「最近一小时回了几条」拦。
    const cap = Number(g.maxRepliesPerHour);
    if (cap > 0) {
      const hourAgo = nowMs - 3600 * 1000;
      const times = Array.isArray(state.replyTimes) ? state.replyTimes : [];
      let recent = 0;
      for (const t of times) if (Number(t) > hourAgo) recent += 1;
      // state.replyTimes 在会话状态被重建时会丢条目（并发下实测会漏拦），
      // 所以再数一遍存储里真正落盘的助手消息 —— 那才是权威来源。
      try {
        const stored = this.store
          .messages(key, 200)
          .filter((m) => m.role === 'assistant' && Number(m.ts) > hourAgo).length;
        if (stored > recent) recent = stored;
      } catch { /* 读不到就按内存里的算 */ }
      if (!recent && Number(state.lastReplyAt) > hourAgo) recent = 1;
      // 主人不受每小时上限限制（否则他自己喊她也会被自己刷出来的额度挡住）
      if (!isMaster && recent >= cap) return { wake: false, reason: 'hourly_cap' };
    }
    // 「群里必须 @ 她才接话」关掉 = 群里不 @ 也会回。
    // 这个开关以前在代码里根本没被读过（只在配置和状态接口里出现过），
    // 所以用户在调试台怎么调都没反应 —— 现在它是真的闸门。
    if (g.requireAt === false && !tooSoon) {
      return { wake: true, reason: 'require_at_off' };
    }
    // 注意力打分：替换"随机开口"。@ / 接话窗口 / 主人 在上面已经处理过，
    // 这里只管"没人叫她的时候，这条值不值得插一句"。
    if (g.scoreMode !== false) {
      try {
        const skey = `${msg.platform}:${msg.chatType === 'group' ? 'g' : 'u'}:${msg.chatId}`;
        // 当前这条已经 append 进 store 了，打分时要剔掉，否则"上一条是不是她"永远错位
        const hist = this.store.messages(skey, 40)
          .filter((m) => !msg.msgId || m.msgId !== msg.msgId);
        const embedUrl = String((this.config.group && this.config.group.embedUrl) || '').trim();
        const useEmbed = embedUrl && (this.config.group.embedEnabled !== false);
        const { score, detail } = useEmbed
          ? await attention.scoreMessageEmbedding({
              text: clean.text || msg.text,
              atMe,
              history: hist,
              weights: g.attentionWeights || {},
              embedUrl,
              timeoutMs: Number(g.embedTimeoutMs) || 1500,
            })
          : attention.scoreMessage({
              text: clean.text || msg.text,
              atMe,
              history: hist,
              weights: g.attentionWeights || {},
            });
        const HI = Number(g.scoreHigh) || 1.0;
        const LO = Number(g.scoreLow) || 0.3;
        if (this.logger) this.logger.info(`[注意力] ${score} ${JSON.stringify(detail)}`);

        // 她在接自己的话：上一条就是她说的，这条又是问句 → 明显在问她，不掷骰子
        if (detail && detail.lastWasHer && detail.isQuestion) {
          return { wake: true, reason: 'followup_question', score, detail };
        }
        if (score >= HI) return { wake: true, reason: 'score_high', score, detail };
        if (score < LO) return { wake: false, reason: 'score_low', score, detail };
        // 灰区：不再掷骰子，问模型这句是不是在跟她说
        if (g.grayJudge !== false) {
          const verdict = await this.judgeAddressee(skey, { senderName: msg.senderName, name: msg.senderName, uid: msg.senderId }, clean.text || msg.text);
          if (this.logger) this.logger.info('[注意灰区] 模型判断：' + (verdict.toBot ? '在跟她说' : '在跟别人说') + '（' + verdict.reason + '）');
          if (verdict.toBot) return { wake: true, reason: 'score_gray_model', score, detail };
          return { wake: false, reason: 'score_gray_model_skip', score, detail };
        }
        // 关掉模型判断时，退回原来的概率方式
        const p = (score - LO) / (HI - LO);
        if (this.rng() < p) return { wake: true, reason: 'score_gray', score, detail };
        return { wake: false, reason: 'score_gray_miss', score, detail };
      } catch (err) {
        this.logger && this.logger.warn('[注意力] 打分失败，回退随机：' + (err && err.message));
      }
    }
    if (g.freeChat && this.rng() < clampInt(g.freeChatChance * 1000, 0, 1000, 60) / 1000) {
      if (!tooSoon) return { wake: true, reason: 'free_chat' };
    }
    return { wake: false, reason: clean.text ? 'not_addressed' : 'no_text' };
  }

  /** 魔咒 + 管理员命令。返回 decision，或 null 表示继续走普通聊天流程 */
  handleAdmin({ msg, clean, key, state, isMaster, nowMs }) {
    const adminCfg = this.config.admin || {};
    const spell = String(adminCfg.spell || '').trim();
    const minutes = Math.max(1, Math.min(1440, Number(adminCfg.minutes) || 30));
    const allowAll = Boolean(adminCfg.allowAll);
    const text = String((clean && clean.text) || '').trim();
    const say = (msgText, commandType = 'admin') => ({
      action: 'command', commandType, key, msg, atMe: true, reason: 'admin', text: msgText,
    });

    // 1) 输入魔咒
    if (spell && text === spell) {
      if (!isMaster && !allowAll) {
        this.store.redactLastMessage(key, '（已隐藏：有人试图使用魔咒）');
        this.logger && this.logger.warn(`[admin] 非主人「${msg.senderName}」尝试使用魔咒，已忽略`);
        return { action: 'ignore', reason: 'not_owner', key, msg, atMe: Boolean(msg && msg.atMe) };
      }
      state.adminUntil = nowMs + minutes * 60000;
      this.store.redactLastMessage(key, '（已隐藏：管理员验证）');
      this.store.markDirty();
      this.logger && this.logger.info(`[admin] 主人 ${msg.senderName} 获得管理员权限 ${minutes} 分钟（会话 ${key}）`);
      const warn = msg.chatType === 'group' ? '（群里别人也能看到魔咒，下次建议私聊发）' : '';
      return say(
        `（魔咒生效）管理员权限 ${minutes} 分钟。可以发：状态 / 改模型 deepseek-reasoner / 演示模式 开|关 / 群聊主动接话 开|关 / 重置记忆 / 清空所有记忆 / 退出管理${warn}`,
        'admin_spell'
      );
    }

    // 2) 管理员命令：主人直接生效，不用开魔咒；allowAll=true 时任何人也能用
    if (!isMaster && !allowAll) return null;
    if (!isMaster && !allowAll && !(Number(state.adminUntil) > nowMs)) {
      const looksControl =
        /(禁言|解禁|静音)/.test(text) ||
        /^(?:别|不要|停止)(?:再)?(?:在)?\s*.+?群/.test(text) ||
        /^让\s*.+?群\s*(?:闭嘴|安静)/.test(text);
      if (looksControl) {
        return say('这个得先开管理员权限才能改：先发魔咒，再说「解除禁言 群名」。', 'admin_hint');
      }
      return null;
    }
    const remaining = Math.max(1, Math.round(((Number(state.adminUntil) || nowMs) - nowMs) / 60000));

    // —— 群禁言（让某个群安静） ——
    let mg;
    // 允许「你/请/帮我」开头，允许「暂时/先」前缀
    const mt = String(text).replace(/^(?:你|请|麻烦|帮我|能不能|可不可以|可以|先|暂时)+/, '').trim();
    if (/^(?:禁言列表|群聊禁言|禁言名单|黑名单)$/.test(text)) {
      const list = (this.config.group && this.config.group.mutedGroups) || [];
      return say(list.length ? '当前禁言：' + list.map((x) => (x === '*' ? '所有群' : x)).join('、') : '现在没有禁言的群。');
    }
    if ((mg = mt.match(/^(?:别|不要|停止|暂时不要)(?:再)?(?:在)?\s*(.+?)\s*(?:那个)?群(?:里|中|里面)?\s*(?:说话|发言|说)(?:了|啦|啊|呀|吧|嘛)?[。.!！~～]*$/))
        || (mg = mt.match(/^(?:禁言|屏蔽)\s*(.+?)$/))
        || (mg = mt.match(/^把\s*(.+?)\s*(?:群)?\s*禁言$/))
        || (mg = mt.match(/^让\s*(.+?)\s*(?:群)?\s*闭嘴$/))) {
      const g = String(mg[1]).replace(/[「」"'“”]/g, '').replace(/(那个|这个)?群$/, '').trim();
      if (g) {
        const list = Array.isArray(this.config.group.mutedGroups) ? this.config.group.mutedGroups.slice() : [];
        if (!list.some((x) => nameMatches(x, g))) list.push(g);
        personaStore.save(this.config, { mutedGroups: list });
        this.logger && this.logger.info('[admin] 群禁言：' + g);
        return say(`好，以后不在「${g}」群里说话了。（想恢复就发：解除禁言 ${g}）`);
      }
    }
    if (/^(?:所有群禁言|全部群禁言|只在私聊说话)$/.test(text)) {
      personaStore.save(this.config, { mutedGroups: ['*'] });
      return say('好，所有群都不说话了，只陪你私聊。');
    }
    if ((mg = mt.match(/^(?:解除禁言|取消禁言|允许)\s*(.+?)(?:了|啦|啊|吧|嘛)?[。.!！~～]*$/))
        || (mg = mt.match(/^解禁\s*(.+?)$/))
        || (mg = mt.match(/^解开\s*(.+?)\s*(?:群)?\s*的?禁言$/))
        || (mg = mt.match(/^解除对\s*(.+?)\s*的?禁言$/))
        || (mg = mt.match(/^让\s*(.+?)\s*(?:群)?\s*(?:可以|能)\s*说话$/))
        || (mg = mt.match(/^(?:恢复|放开)\s*(?!默认|语态|人设)(.+?)\s*(?:群)?\s*(?:说话)?$/))) {
      const g = String(mg[1]).replace(/[「」"'“”]/g, '').trim();
      const list = (Array.isArray(this.config.group.mutedGroups) ? this.config.group.mutedGroups : []).filter((x) => !nameMatches(x, g) && x !== '*');
      personaStore.save(this.config, { mutedGroups: list });
      return say(`好，「${g}」群恢复说话了。`);
    }
    if (/^(?:解除禁言|解开禁言|解禁|解除所有禁言|取消所有禁言)$/.test(text)) {
      personaStore.save(this.config, { mutedGroups: [] });
      return say('所有群的禁言都解开了。');
    }
    if (/^(?:解除所有群禁言|全部恢复|允许所有群)$/.test(text)) {
      personaStore.save(this.config, { mutedGroups: [] });
      return say('所有群都恢复说话了。');
    }

    // —— 上下文长度 / 人味开关 ——
    let mm2;
    if ((mm2 = text.match(/^(?:上下文|记忆长度|记忆条数)\s*(\d{1,3})$/))) {
      const n = Math.max(6, Math.min(120, Number(mm2[1])));
      const groupN = Math.min(n, 100);
      personaStore.save(this.config, { historyTurns: n, groupHistoryTurns: groupN });
      return say(`上下文长度改成 ${n} 条（群聊 ${groupN} 条）。`);
    }
    if ((mm2 = text.match(/^上下文\s*(短|中|长)$/))) {
      const map = { 短: 16, 中: 48, 长: 96 };
      const n = map[mm2[1]];
      const groupN = Math.min(n, 100);
      personaStore.save(this.config, { historyTurns: n, groupHistoryTurns: groupN });
      return say(`上下文调成「${mm2[1]}」：私聊 ${n} 条、群聊 ${groupN} 条。`);
    }
    if ((mm2 = text.match(/^(?:情绪|心情)\s*(开|打开|关|关闭)$/))) {
      const on = /开/.test(mm2[1]);
      personaStore.save(this.config, { emotions: on });
      return say(on ? '好，会带情绪说话。' : '好，语气收平，不太表露情绪。');
    }
    if ((mm2 = text.match(/^(?:主动|主动关心|主动找话题)\s*(开|打开|关|关闭)$/))) {
      const on = /开/.test(mm2[1]);
      personaStore.save(this.config, { proactive: on });
      return say(on ? '好，会主动关心你、接话题。' : '好，不主动找话题了，你问什么答什么。');
    }
    if ((mm2 = text.match(/^(?:观点|立场|主见)\s*(开|打开|关|关闭)$/))) {
      const on = /开/.test(mm2[1]);
      personaStore.save(this.config, { opinions: on });
      return say(on ? '好，会有自己的看法，也敢不同意你。' : '好，不输出立场，顺着你说。');
    }
    if ((mm2 = text.match(/^(?:互怼|骂主人|顶嘴|允许顶嘴)\s*(开|打开|关|关闭)$/))) {
      const on = /开/.test(mm2[1]);
      personaStore.save(this.config, { masterRoast: on });
      return say(on
        ? '行，那你骂我我就回嘴了，不带脏字那种。'
        : '好，那我挨骂就受着，不还口了。');
    }
    if ((mm2 = text.match(/^人味\s*(高|中|低)$/))) {
      const level = mm2[1];
      const patch = level === '高'
        ? { emotions: true, proactive: true, opinions: true }
        : level === '中'
          ? { emotions: true, proactive: false, opinions: true }
          : { emotions: false, proactive: false, opinions: false };
      personaStore.save(this.config, patch);
      return say(`人味调到「${level}」：${level === '高' ? '有情绪、会主动、有自己观点' : level === '中' ? '有情绪和观点，但不主动找话' : '平铺直叙，不主动、不表态'}`);
    }

    // —— 语态 / 长短 / 颜文字 / 能力（微信里直接调，持久保存） ——
    let mm;
    if ((mm = text.match(/^(?:语态|说话方式|风格|人设)\s*[:：]?\s*([\s\S]{1,120})$/))) {
      const v = mm[1].trim();
      personaStore.save(this.config, { text: v });
      this.logger && this.logger.info('[admin] 语态调整：' + v);
      return say(`好，说话方式记下了：${v}（一直生效，重启也保留）`);
    }
    if ((mm = text.match(/^(?:语气|口吻)\s*(温柔|活泼|可爱|高冷|毒舌|正经|抽象)$/))) {
      const map = {
        温柔: '温柔软一点，句子短，别端着',
        活泼: '活泼一点，多用语气词，可以开玩笑',
        可爱: '可爱一点，稍微卖萌但不腻',
        高冷: '高冷一点，话少、不主动卖萌、不撒娇',
        毒舌: '嘴可以毒一点，吐槽犀利但不人身攻击',
        正经: '正经一点，少用网络用语和颜文字',
        抽象: '短句、玩梗、装傻、游戏黑话，能五个字说完就别十个字',
      };
      personaStore.save(this.config, { preset: mm[1], text: map[mm[1]] });
      this.logger && this.logger.info('[admin] 语气切到 ' + mm[1]);
      return say(`语气切成「${mm[1]}」了：${map[mm[1]]}`);
    }
    if ((mm = text.match(/^(?:长度|字数)\s*(私聊|群聊)\s*([0-9]{2,4})$/))) {
      const n = Math.max(20, Math.min(600, Number(mm[2])));
      const patch = mm[1] === '私聊' ? { privateMaxChars: n } : { groupMaxChars: n };
      personaStore.save(this.config, patch);
      return say(`${mm[1]}回复上限改成 ${n} 字了。`);
    }
    if (/^回复\s*(短一点|再短点|长一点|再长点)$/.test(text)) {
      const shorter = /短/.test(text);
      const d = this.config.chat;
      const pv = shorter ? Math.max(40, Math.round(d.privateMaxChars * 0.7)) : Math.min(400, Math.round(d.privateMaxChars * 1.3));
      const gv = shorter ? Math.max(20, Math.round(d.groupMaxChars * 0.7)) : Math.min(150, Math.round(d.groupMaxChars * 1.3));
      personaStore.save(this.config, { privateMaxChars: pv, groupMaxChars: gv });
      return say(`好，${shorter ? '短' : '长'}一点：私聊 ${pv} 字、群聊 ${gv} 字。`);
    }
    if ((mm = text.match(/^颜文字\s*(关|少|正常|多)$/))) {
      personaStore.save(this.config, { emoji: mm[1] });
      return say(`颜文字用量：${mm[1]}。`);
    }
    if ((mm = text.match(/^能力\s*(链接|链接阅读|主动接话|群聊主动接话)\s*(开|打开|关|关闭)$/))) {
      const on = /开/.test(mm[2]);
      if (/链接/.test(mm[1])) {
        personaStore.save(this.config, { links: on });
        return say(`链接阅读已${on ? '打开' : '关闭'}。`);
      }
      personaStore.save(this.config, { freeChat: on });
      return say(`群聊主动接话已${on ? '打开' : '关闭'}。`);
    }
    if (/^(恢复默认|重置语态|恢复人设|清空设定)$/.test(text)) {
      personaStore.clear(this.config);
      this.logger && this.logger.info('[admin] 人设与能力恢复默认');
      return say('人设和能力的自定义都清空了，恢复默认。');
    }

    if (/^(状态|管理状态|查看状态)$/.test(text)) {
      const s = this.store.summary();
      const mock = this.llm.isMock;
      const muted = this.config.group.mutedGroups || [];
      return say(
        `管理员在线（剩 ${remaining} 分钟）｜模型：${mock ? '演示模式' : this.llm.providerLabel + ' · ' + this.llm.model}` +
        `｜记忆：${s.sessions} 个聊天 / ${s.messages} 条消息` +
        `｜上下文：${this.config.chat.historyTurns} 条` +
        `｜语态：${this.config.persona.stylePreset || '默认'}${this.config.persona.styleText ? '（' + this.config.persona.styleText.slice(0, 12) + '）' : ''}` +
        `｜人味：情绪${this.config.persona.emotions === false ? '关' : '开'}/主动${this.config.persona.proactive === false ? '关' : '开'}/观点${this.config.persona.opinions === false ? '关' : '开'}` +
        `｜长短：私聊${this.config.chat.privateMaxChars}/群聊${this.config.chat.groupMaxChars}字` +
        `｜禁言群：${muted.length ? muted.map((x) => (x === '*' ? '所有群' : x)).join('、') : '无'}` +
        `｜链接：${!this.config.links || this.config.links.enabled !== false ? '开' : '关'}`
      );
    }
    if (/^(管理)?帮助$/.test(text)) {
      return say('管理员命令：状态 / 上下文 20 / 人味 高|中|低 / 情绪 开|关 / 主动 开|关 / 观点 开|关 / 语态 <描述> / 语气 温柔|活泼|高冷|毒舌|正经 / 长度 私聊 120 / 回复 短一点 / 颜文字 少|多|关 / 能力 链接 开|关 / 能力 主动接话 开|关 / 改模型 <模型名> / 演示模式 开|关 / 重置记忆 / 清空所有记忆 / 恢复默认 / 退出管理');
    }
    if (/^演示模式\s*(开|打开|关|关闭|关掉)$/.test(text)) {
      const on = /开/.test(text);
      try { saveSettings(this.config, { mock: on }); } catch { /* 测试环境无路径 */ }
      this.llm.reload();
      this.logger && this.logger.info(`[admin] 演示模式 ${on ? '开' : '关'}`);
      return say(on ? '演示模式已打开：接下来用内置台词，不调用模型。' : `演示模式已关闭：用真模型 ${this.llm.model} 说话。`);
    }
    const m = text.match(/^(?:改模型|换模型|模型)\s+([A-Za-z0-9._\-\/:]{2,60})$/);
    if (m) {
      const model = m[1];
      // deepseek-* 自动切到 DeepSeek 官方接口，qwen-* 切回百炼，省得还要单独改服务商
      const lower = model.toLowerCase();
      let provider = '';
      let baseUrl = '';
      if (lower.startsWith('deepseek')) { provider = 'deepseek'; baseUrl = 'https://api.deepseek.com'; }
      else if (lower.startsWith('qwen') || lower.startsWith('qwq')) { provider = 'qwen'; baseUrl = 'https://dashscope.aliyuncs.com/compatible-mode/v1'; }
      else if (lower.startsWith('glm')) { provider = 'zhipu'; baseUrl = 'https://open.bigmodel.cn/api/paas/v4'; }
      try {
        saveSettings(this.config, provider ? { provider, model, baseUrl, mock: false } : { model, mock: false });
      } catch { /* ignore */ }
      this.llm.reload();
      this.logger && this.logger.info(`[admin] 模型切到 ${model}${provider ? '（服务商 ' + provider + '）' : ''}`);
      return say(`模型已切到 ${model}（服务：${this.llm.providerLabel}）。`);
    }
    // 「接 deepseek / 用千问 / 切智谱」：切换服务商，Key 从各自存档里取
    const providerAlias = {
      ds: 'deepseek', deepseek: 'deepseek', 深度求索: 'deepseek',
      qwen: 'qwen', 千问: 'qwen', 通义: 'qwen', 通义千问: 'qwen',
      glm: 'zhipu', zhipu: 'zhipu', 智谱: 'zhipu',
      siliconflow: 'siliconflow', 硅基: 'siliconflow', 硅基流动: 'siliconflow',
      ollama: 'ollama', 本地: 'ollama',
    };
    const pm = text.match(/^(?:接|用|切到|换成|切换到)?\s*([A-Za-z\u4e00-\u9fff]{1,12})(?:\s*(?:chat|v3|flash|plus))?$/i);
    if (pm) {
      const target = providerAlias[pm[1].toLowerCase()] || providerAlias[pm[1]];
      if (target) {
        const preset = { deepseek: ['https://api.deepseek.com', 'deepseek-chat'], qwen: ['https://dashscope.aliyuncs.com/compatible-mode/v1', 'qwen-plus'], zhipu: ['https://open.bigmodel.cn/api/paas/v4', 'glm-4-flash'], siliconflow: ['https://api.siliconflow.cn/v1', 'Qwen/Qwen2.5-7B-Instruct'], ollama: ['http://127.0.0.1:11434/v1', 'qwen2.5:7b'] }[target];
        try { saveSettings(this.config, { provider: target, baseUrl: preset[0], model: preset[1], mock: false }); } catch { /* ignore */ }
        this.llm.reload();
        this.logger && this.logger.info(`[admin] 切到服务商 ${target}`);
        const ok = !this.llm.isMock;
        return say(ok
          ? `好，切到 ${this.llm.providerLabel}，模型 ${this.llm.model}。`
          : `好，切到 ${this.llm.providerLabel} 了，但还没有这个服务的 Key：去设置页填，或把 Key 发我。`);
      }
    }
    if (/^(?:群聊)?主动接话\s*(开|打开|关|关闭|关掉)$/.test(text)) {
      const on = /开/.test(text);
      this.config.group.freeChat = on;
      this.logger && this.logger.info(`[admin] 群聊主动接话 ${on ? '开' : '关'}`);
      return say(on ? '群聊主动接话已打开（按概率接话，仍受冷却限制）。' : '群聊主动接话已关闭。');
    }
    if (/^重置记忆$/.test(text)) {
      this.store.resetSession(key);
      return say('这个聊天的记忆已清空。');
    }
    if (/^清空所有记忆$/.test(text)) {
      this.store.resetAll();
      return say('所有聊天的记忆已清空。');
    }
    if (/禁言|群.*(别说|不要|安静)|不要在.*群/.test(text)) {
      return say('这句我没听明白。改成「禁言 鼠标」或者「别在鼠标群说话」试试。');
    }
    if (/^(退出管理|结束管理|关闭管理|收起魔咒)$/.test(text)) {
      state.adminUntil = 0;
      this.store.markDirty();
      this.logger && this.logger.info('[admin] 管理员权限已关闭');
      return say('管理员权限已关闭。');
    }
    return null;
  }

  async runCommand({ command, msg, key, profile, state, nowMs, atMe, isMaster }) {
    const g = this.config.group;
    // 权限闸门：人设/配置/控制类只有主人能用；群友只保留记忆类命令
    if (!isMaster && MASTER_ONLY_COMMANDS.has(command.type)) {
      return { action: 'command', commandType: command.type, key, msg, atMe, text: '这个只有主人能改，你只能让我记事。', reason: 'command_denied' };
    }
    const finish = (text, extra = {}) => ({ action: 'command', commandType: command.type, key, msg, atMe, text, reason: 'command', ...extra });
    switch (command.type) {
      case 'help':
        return finish(formatReference(Boolean(isMaster)));
      case 'metrics': {
        if (!isMaster) return finish('这个只有主人能看。');
        const fs2 = require('node:fs');
        const path2 = require('node:path');
        const file = path2.join(this.dataDir || path2.join(__dirname, '..', 'data'), 'recall.log');
        let lines = [];
        try { lines = fs2.readFileSync(file, "utf8").split("\n").filter(Boolean).slice(-2000); } catch { /* 没有日志 */ }
        if (!lines.length) return finish("还没有召回日志（跑几句就有了）。");
        const since = Date.now() - 24 * 3600 * 1000;
        const rows = [];
        for (const l of lines) { try { const o = JSON.parse(l); if (o.ts >= since) rows.push(o); } catch { /* skip */ } }
        if (!rows.length) return finish("最近 24 小时没有召回记录。");
        const withFacts = rows.filter((r) => (r.facts || []).length).length;
        const avgFacts = (rows.reduce((n, r) => n + (r.facts || []).length, 0) / rows.length).toFixed(2);
        const avgMem = Math.round(rows.reduce((n, r) => n + (r.memChars || 0), 0) / rows.length);
        const avgDigest = Math.round(rows.reduce((n, r) => n + (r.digestChars || 0), 0) / rows.length);
        const counts = new Map();
        for (const r of rows) for (const f of (r.facts || [])) {
          const k = f.id || f.t;
          counts.set(k, { n: (counts.get(k) || { n: 0, t: f.t }).n + 1, t: f.t });
        }
        const top = [...counts.values()].sort((a, b) => b.n - a.n).slice(0, 5);
        const lines2 = [
          "最近 24 小时：" + rows.length + " 轮",
          "有记忆注入：" + withFacts + " 轮（" + Math.round((withFacts / rows.length) * 100) + "%）",
          "平均注入事实：" + avgFacts + " 条 ｜ 记忆字符 " + avgMem + " ｜ 摘要字符 " + avgDigest,
        ];
        if (top.length) lines2.push("最常被用：" + top.map((x) => String(x.t || "").slice(0, 14) + "×" + x.n).join("、"));
        return finish(lines2.join("\n"));
      }
      case 'usage': {
        if (!isMaster) return finish('这个只有主人能看。');
        const st = budget.status();
        const pol = budget.policy(this.config, { isMaster: true });
        const daily = Number((this.config.budget && this.config.budget.dailyTokens) || 800000);
        // 近一小时发言数：撞上限时群友会被静默，这里直接暴露出来
        const hourAgo = Date.now() - 3600000;
        let recent = 0;
        try {
          recent = this.store.messages(key, 200).filter((m) => m.role === 'assistant' && Number(m.ts) > hourAgo).length;
        } catch { /* 读不到就算 0 */ }
        const cap = Number(this.config.group.maxRepliesPerHour) || 30;
        return finish('今天用了 ' + st.tokens + ' tokens（' + st.calls + ' 次调用），预算 ' + daily
          + '（' + (daily ? (st.tokens / daily * 100).toFixed(1) : '0') + '%）\n当前档位：' + pol.level
          + '，上下文 ' + pol.histTurns + ' 条，单次额度 ' + pol.maxTokens
          + '\n近一小时发言：' + recent + '/' + cap + (recent >= cap ? '（已达上限，群友会被静默；主人不受限）' : '')
          + (this._lastAgentStats
            ? '\n上一条消息：' + this._lastAgentStats.rounds + ' 轮 / ' + this._lastAgentStats.tokens + ' tokens / ' + Math.round(this._lastAgentStats.ms / 1000) + 's' + (this._lastAgentStats.stop ? '（撞到：' + this._lastAgentStats.stop + '）' : '')
            : ''));
      }
      case 'selfedit': {
      const a = String((command && command.arg) || '').trim();
      if (a === 'on' || a === '开') { selfedit.setEnabled(true); return finish('代码自改已开启（提案仍需你 /approve edit <id> 才应用）。'); }
      if (a === 'off' || a === '关') { selfedit.setEnabled(false); return finish('代码自改已关闭。'); }
      if (!a || a === 'status' || a === '状态') { return finish('代码自改：' + (selfedit.isEnabled() ? '开' : '关')); }
      const r = selfedit.create({ request: a });
      return finish(r.ok ? ('开始生成提案（' + r.id + '），好了发你审批。') : r.msg);
    }
    case 'approve': {
      const m = String((command && command.arg) || '').match(/^edit\s+(\S+)$/i);
      if (!m) return finish('用法：/approve edit <id>');
      const r = selfedit.approve(m[1]);
      return finish(r.msg);
    }
    case 'deny': {
      const m = String((command && command.arg) || '').match(/^edit\s+(\S+)$/i);
      if (!m) return finish('用法：/deny edit <id>');
      const r = selfedit.deny(m[1]);
      return finish(r.msg);
    }
    case 'behavior': {
      const a = String((command && command.arg) || '').trim();
      if (a === 'reset' || a === '重置') {
        behavior.reset();
        return finish('行为参数已恢复默认：' + Object.entries(behavior.all()).map(([k, v]) => k + '=' + v).join('，'));
      }
      const sm = a.match(/^set\s+(\S+)\s+(-?\d+)$/i);
      if (sm) {
        const r = behavior.set(sm[1], sm[2]);
        return finish(r.ok ? ('已设置 ' + r.key + ' = ' + r.value) : ('设置失败：' + r.msg));
      }
      return finish('当前行为参数：' + Object.entries(behavior.all()).map(([k, v]) => k + '=' + v).join('，') + '（改：/behavior set key value；恢复：/behavior reset）');
    }
    case 'agent': {
        const a = String((command && command.arg) || '').trim().toLowerCase();
        const st = agentBridge.status();
        if (!a || a === 'status' || a === '状态') {
          return finish('后台 agent：' + (st.enabled ? '开' : '关') + '（运行中 ' + st.running + '，排队 ' + st.queued + '）');
        }
        if (a === 'pending' || a === '待批' || a === '列表') {
          return finish(agentBridge.pendingText());
        }
        const okm = a.match(/^(?:ok|批准|过)\s+(\S+)$/);
        if (okm) return finish(agentBridge.approve(okm[1], true));
        const nom = a.match(/^(?:no|拒|拒绝)\s+(\S+)$/);
        if (nom) return finish(agentBridge.approve(nom[1], false));
        if (['on', '开', '开启'].includes(a)) {
          agentBridge.setEnabled(true);
          return finish('后台 agent 已开启。白名单内的人派复杂任务时会转给它；关掉用 /agent off。');
        }
        if (['off', '关', '关闭'].includes(a)) {
          agentBridge.setEnabled(false);
          return finish('后台 agent 已关闭。');
        }
        return finish('用法：/agent on|off|status');
      }
    case 'sendfile': {
        if (!isMaster) return finish('这个只有主人能让我做。');
        const arg0 = String(command.arg || '').trim();
        if (!arg0) return finish('用法：/sendfile workspace/笔记.md');
        try {
          const ws = require('./workspace');
          const rel = arg0.replace(/^workspace[\\/]/i, '');
          const full = ws.resolve(rel);
          if (!require('node:fs').existsSync(full)) return finish('找不到文件：' + arg0);
          require('./outbox').enqueue({ chatId: (msg.chatId || key), chatType: msg.chatType, kind: 'file', file: full });
          return finish('发你了，文件：' + arg0);
        } catch (e) {
          return finish('发不了：' + (e && e.message));
        }
      }
      case 'corpus': {
        if (!isMaster) return finish('语料开关只有主人能改。');
        const arg = String(command.arg || '').trim().toLowerCase();
        const w = this.config.wechat = this.config.wechat || {};
        w.groupSettings = w.groupSettings || {};
        const cur = { ...(w.groupSettings[msg.chatId] || {}) };
        if (arg === 'on' || arg === '开') {
          cur.collect = true;
          w.groupSettings[msg.chatId] = cur;
          try { saveConfigValue(this.config, 'wechat.groupSettings.' + msg.chatId + '.collect', true); } catch { /* ignore */ }
          return finish('开了，这个群的语料我开始攒（不影响回话）。');
        }
        if (arg === 'off' || arg === '关') {
          cur.collect = false;
          w.groupSettings[msg.chatId] = cur;
          try { saveConfigValue(this.config, 'wechat.groupSettings.' + msg.chatId + '.collect', false); } catch { /* ignore */ }
          return finish('关了，不攒这个群的语料了。');
        }
        const corpus = require('./corpus');
        corpus.setDataDir(this.dataDir);
        const st = corpus.stats(msg.chatId);
        return finish('这个群的语料：' + (cur.collect !== false ? '收集中（默认开）' : '已关闭') + '\n' + (st.exists ? '已存 ' + st.lines + ' 条 / ' + (st.bytes / 1024).toFixed(1) + ' KB' : '还没有数据') + '\n（/corpus on 或 off）');
      }
      case 'audit': {
        if (!isMaster) return finish('只有主人能看。');
        const f = require('node:path').join(this.dataDir || require('node:path').join(__dirname, '..', 'data'), 'disclosure.log');
        let lines = [];
        try { lines = require('node:fs').readFileSync(f, 'utf8').split('\n').filter(Boolean).slice(-8); } catch { /* none */ }
        if (!lines.length) return finish('还没有披露记录。');
        return finish('最近几轮她看到的跨会话内容：\n' + lines.map((l) => {
          try {
            const o = JSON.parse(l);
            const t = new Date(o.ts).toLocaleTimeString('zh-CN', { hour12: false });
            const facts = (o.facts || []).filter((x) => x.from && x.from !== o.key).length;
            const narr = (o.narrative || []).map((x) => x.title || '别处').join('/');
            return t + ' 跨会话事实 ' + facts + ' 条' + (narr ? ' ｜ 叙事 ' + narr : '');
          } catch { return ''; }
        }).filter(Boolean).join('\n'));
      }
      case 'talk': {
        if (!isMaster) return finish('频率档位只有主人能改。');
        const map = { '少': 'quiet', '少说': 'quiet', 'quiet': 'quiet', '正常': 'normal', 'normal': 'normal', '多': 'chatty', '多说': 'chatty', 'chatty': 'chatty' };
        const arg = String(command.arg || '').trim().toLowerCase();
        const w = this.config.wechat = this.config.wechat || {};
        w.groupSettings = w.groupSettings || {};
        const cur = { ...(w.groupSettings[msg.chatId] || {}) };
        if (!arg) {
          return finish('这个群的说话频率：' + (cur.talkativeness || 'normal') + '\n（/talk 少 | 正常 | 多）');
        }
        const val = map[arg];
        if (!val) return finish('只认：少 / 正常 / 多。');
        cur.talkativeness = val;
        w.groupSettings[msg.chatId] = cur;
        try { saveConfigValue(this.config, 'wechat.groupSettings.' + msg.chatId + '.talkativeness', val); } catch { /* ignore */ }
        return finish('好，这个群改成「' + (val === 'quiet' ? '少说' : val === 'chatty' ? '多说' : '正常') + '」。');
      }
      case 'remind': {
        if (!isMaster) return finish('提醒只有主人能用。');
        const proactive = require('./proactive');
        proactive.setDataDir(this.dataDir);
        const arg = String(command.arg || '').trim();
        if (arg === 'cancel' || arg === '取消') {
          const n = proactive.listReminders().length ? proactive.listReminders().map((x) => proactive.cancelReminder(x.id)).filter(Boolean).length : 0;
          return finish(n ? '清了 ' + n + ' 条提醒。' : '没有待提醒的事。');
        }
        const list = proactive.listReminders();
        if (!list.length) return finish('没有待提醒的事。');
        return finish('待提醒：\n' + list.slice(0, 8).map((x) => {
          const d = new Date(x.due);
          return d.toLocaleString('zh-CN', { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit', hour12: false }) + ' ' + x.what;
        }).join('\n'));
      }
      case 'proactive': {
        if (!isMaster) return finish('这个只有主人能改。');
        const arg = String(command.arg || '').trim().toLowerCase();
        const cur = Boolean((this.config.proactive && this.config.proactive.group && this.config.proactive.group.enabled) !== false);
        if (arg === 'on' || arg === '开') {
          this.config.proactive = this.config.proactive || {};
          this.config.proactive.group = { ...(this.config.proactive.group || {}), enabled: true };
          try { saveConfigValue(this.config, 'proactive.group.enabled', true); } catch { /* ignore */ }
          return finish('开了，群冷场时她会自己起话头。');
        }
        if (arg === 'off' || arg === '关') {
          this.config.proactive = this.config.proactive || {};
          this.config.proactive.group = { ...(this.config.proactive.group || {}), enabled: false };
          try { saveConfigValue(this.config, 'proactive.group.enabled', false); } catch { /* ignore */ }
          return finish('关了，群里她不再主动起话题。');
        }
        return finish('群聊主动起话题：' + (cur ? '开' : '关') + '\n（/proactive on 或 off）');
      }
      case 'task': {
        if (!isMaster) return finish('派活只有主人能做。');
        const tasks = require('./tasks');
        tasks.setDataDir(this.dataDir);
        const arg = String(command.arg || '').trim();
        if (!arg || arg === 'list' || arg === '列表') {
          const items = tasks.list(5);
          if (!items.length) return finish('现在没有任务。');
          return finish('最近的任务：\n' + items.map((t) => t.id.slice(-6) + ' [' + t.status + '] ' + String(t.instruction).slice(0, 30)).join('\n'));
        }
        if (arg === 'cancel' || arg === '取消') {
          const n = tasks.cancelAll();
          return finish(n ? '停了 ' + n + ' 个任务。' : '没有在跑的任务。');
        }
        const idMatch = arg.match(/^(cancel|取消)\s+(\w+)/);
        if (idMatch) {
          const hit = tasks.list(20).find((t) => t.id.endsWith(idMatch[2]));
          if (!hit) return finish('没找到这个任务。');
          tasks.cancel(hit.id);
          return finish('停了：' + String(hit.instruction).slice(0, 30));
        }
        const t = tasks.enqueue({ chatId: msg.chatId || key, chatType: msg.chatType, ownerId: msg.senderId, instruction: arg });
        return finish('行，我后台弄（' + t.id.slice(-6) + '），好了叫你。');
      }
      case 'backup': {
        if (!isMaster) return finish('这个只有主人能让我做。');
        const sub = String(command.arg || '').trim().toLowerCase();
        const cfgUsb = (this.config.memory && this.config.memory.usb) || {};
        if (sub === 'drives' || sub === '盘符') {
          const list = usb.listDrives();
          if (!list.length) return finish('没读到盘符。');
          return finish('可用盘符：\n' + list.map((d) => d.letter + ' ' + d.type + (d.name ? '（' + d.name + '）' : '') + ' 剩 ' + d.freeGB + 'G').join('\n'));
        }
        if (sub === 'status' || sub === '状态') {
          const dir = String(cfgUsb.dir || '').trim();
          if (!dir) return finish('还没配备份目录。用 /set 改不了这个，需要我改 config.json 的 memory.usb.dir，或者你说一声我来改。');
          const exists = require('node:fs').existsSync(dir);
          return finish('备份目录：' + dir + (exists ? '（可用）' : '（现在找不到，U 盘没插？）') + '\n间隔：每 ' + (Number(cfgUsb.autoMinutes) || 10) + ' 分钟一次');
        }
        const dir = String(cfgUsb.dir || '').trim();
        if (!dir) return finish('还没配备份目录（memory.usb.dir）。先发 /backup drives 看盘符，然后让我改配置。');
        const r = usb.backupNow(dir, { logger: this.logger, dataDir: this.dataDir || undefined });
        if (!r.ok) return finish('备份失败：' + (r.error || '未知错误'));
        return finish('备份好了：' + r.files.map((f) => f.name + ' ' + Math.round(f.bytes / 1024) + 'KB').join('、') + '\n位置：' + r.dir);
      }
      case 'pref': {
        if (!isMaster) return finish('这个只有主人能改。');
        const raw = String(command.arg || '').trim();
        const sub = raw.match(/^(add|list|del|rm)\s*([\s\S]*)$/i);
        const action = sub ? sub[1].toLowerCase() : (raw ? 'add' : 'list');
        const rest = sub ? sub[2].trim() : raw;
        if (action === 'list') {
          const list = prefs.all();
          if (!list.length) return finish('还没有规矩。用法：/pref add 说话不超过两句');
          return finish('现在生效的规矩（全局）：\n' + list.map((x, i) => (i + 1) + '. ' + x.text).join('\n'));
        }
        if (action === 'del' || action === 'rm') {
          const gone = prefs.removeByIndex(rest);
          return finish(gone ? '删掉了：' + gone.text : '没有这一条，发 /pref list 看编号。');
        }
        if (!rest) return finish('用法：/pref add 说话不超过两句');
        const item = await prefs.add(rest, { source: '主人手写' });
        return finish(`记下规矩：${item.text}（全局生效）`);
      }
      case 'listen': {
        if (!isMaster) return finish('这个只有主人能改。');
        this.config.wechat = this.config.wechat || {};
        const cur = this.config.wechat.listen || { enabled: false, groups: [], privates: [] };
        const groups = new Set((cur.groups || []).map(String));
        const privates = new Set((cur.privates || []).map(String));
        const arg = String(command.arg || "").trim();
        const sub = (arg.split(/\s+/)[0] || "").toLowerCase();
        const rest = arg.slice(sub.length).trim();
        const save = () => {
          const listen = { enabled: Boolean(cur.enabled), groups: [...groups], privates: [...privates] };
          this.config.wechat.listen = listen;
          saveConfigValue(this.config, 'wechat.listen', listen);
          return listen;
        };
        // 被白名单挡住的会话（桥接写的），用来解决"拿不到 wxid"
        const readBlocked = () => {
          try {
            const p2 = require('node:path');
            const f = p2.join(this.dataDir || p2.join(__dirname, '..', 'data'), 'listen-blocked.json');
            const d = JSON.parse(require('node:fs').readFileSync(f, 'utf8'));
            return Array.isArray(d.items) ? d.items : [];
          } catch { return []; }
        };
        if (sub === 'blocked' || sub === '被挡') {
          const items = readBlocked();
          if (!items.length) return finish('最近没有被挡住的会话。');
          return finish('被挡住的（发 /listen add 序号 加进来）：\n' + items.map((x, i) =>
            (i + 1) + '. ' + (x.kind === 'group' ? '群' : '私聊') + ' ' + (x.name || x.id) + ' (' + x.id + ')'
          ).join('\n'));
        }

        // 桥接导出的会话目录（名字 -> wxid），用于 /listen add 名字
        const readChats = () => {
          try {
            const p3 = require('node:path');
            const f = p3.join(this.dataDir || p3.join(__dirname, '..', 'data'), 'chats.json');
            const d = JSON.parse(require('node:fs').readFileSync(f, 'utf8'));
            return Array.isArray(d.items) ? d.items : [];
          } catch { return []; }
        };
        if (sub === 'chats' || sub === '会话') {
          const items = readChats();
          if (!items.length) return finish('还没拿到会话目录，等几秒再试（桥接每 60 秒刷新一次）。');
          return finish('最近的会话（/listen add 名字 或序号）：\n' + items.map((x, i) =>
            (i + 1) + '. ' + (x.kind === 'group' ? '群' : '私聊') + ' ' + x.name + ' (' + x.id + ')'
          ).join('\n'));
        }

        // 把名字/昵称解析成 id
        const resolve = (text) => {
          const t = String(text || "").trim();
          if (!t) return null;
          // 序号：对应 /listen blocked 里的列表
          if (/^\d+$/.test(t)) {
            const n = Number(t) - 1;
            const b2 = readBlocked()[n];
            if (b2) return { kind: b2.kind === 'group' ? 'group' : 'private', id: b2.id };
            const c2 = readChats()[n];
            if (c2) return { kind: c2.kind === 'group' ? 'group' : 'private', id: c2.id };
          }
          // 被挡名单 / 会话目录里的名字
          for (const item of readBlocked().concat(readChats())) {
            if (item.name && String(item.name).includes(t)) {
              return { kind: item.kind === 'group' ? 'group' : 'private', id: item.id };
            }
          }
          if (/^\d+@chatroom$/.test(t)) return { kind: "group", id: t };
          if (/^wxid_[A-Za-z0-9_\-]+$/.test(t)) return { kind: "private", id: t };
          // 按群名找
          for (const key of this.store.sessionKeys()) {
            const sess = this.store.sessions.get(key);
            if (!sess) continue;
            if (String(sess.title || "").includes(t) && String(key).includes("@chatroom")) {
              return { kind: "group", id: String(key).split(":").pop() };
            }
          }
          // 按人名找
          for (const key of this.store.sessionKeys()) {
            const sess = this.store.sessions.get(key);
            if (!sess) continue;
            for (const pr of Object.values(sess.profiles || {})) {
              if (String(pr.nickname || pr.name || "") === t && String(pr.uid || "").startsWith("wxid_")) {
                return { kind: "private", id: String(pr.uid) };
              }
            }
          }
          return null;
        };
        const render = () => {
          const g = [...groups].map((x) => {
            const sess = this.store.sessionKeys().map((k) => this.store.sessions.get(k)).find((x2) => x2 && String(x2.chatId) === x);
            return (sess && sess.title ? sess.title : x);
          });
          return [
            `听消息：[${cur.enabled ? "开" : "关"}]`,
            `群：${g.length ? g.join("、") : "（空）"}`,
            `私聊：${privates.size ? [...privates].join("、") : "（空，主人始终放行）"}`,
            "改：/listen add 群名或wxid、/listen del …、/listen on|off",
          ].join("\n");
        };
        if (!sub || sub === "list") return finish(render());
        if (sub === "on") { cur.enabled = true; save(); return finish("好，开始按名单听消息了。\n" + render()); }
        if (sub === "off") { cur.enabled = false; save(); return finish("关掉了，现在只按旧白名单走。\n" + render()); }
        if (sub === "add" || sub === "del") {
          const hit = resolve(rest);
          if (!hit) return finish(`找不到「${rest}」。可以直接发群 id（…@chatroom）或 wxid。`);
          const set = hit.kind === "group" ? groups : privates;
          if (sub === "add") { set.add(hit.id); cur.enabled = true; }
          else { set.delete(hit.id); }
          save();
          return finish((sub === "add" ? "加上了：" : "去掉了：") + hit.id + "\n" + render());
        }
        return finish(render());
      }
      case 'facts': {
        const arg = String(command.arg || "").trim();
        // 删：/facts 删 12  或  /facts 删 棍木
        if (/^(删|删除|忘掉|forget)/.test(arg)) {
          if (!isMaster) return finish('删记忆只有主人能做。');
          const target = arg.replace(/^(删|删除|忘掉|forget)[\s:：]*/, "").trim();
          if (!target) return finish("删哪条？用 /facts 看序号，比如 /facts 删 3");
          const byIndex = /^\d+$/.test(target) ? memories.removeAt(key, Number(target)) : null;
          const gone = byIndex || memories.removeByText(key, target);
          return finish(gone ? `删了（可恢复）：「${String(gone.text).slice(0, 40)}」\n恢复：/facts 恢复 ${Number(target) || ''}` : "没找到这条。");
        }
        // 详情：/facts 详情 3
        if (/^(详情|看看|detail)/.test(arg)) {
          const ref = arg.replace(/^(详情|看看|detail)[\s:：]*/, '').trim();
          const one = memories.detail(key, ref);
          if (!one) return finish('没找到这条。');
          const p = one.provenance || {};
          const lines = [
            `「${String(one.text).slice(0, 60)}」`,
            `状态：${one.state}${one.reason ? '（' + one.reason + '）' : ''}`,
            `重要性：${Math.round((Number(one.importance) || 0.5) * 10)}/10 ｜ 被用过 ${one.useCount || 0} 次`,
            `来源：${p.kind || '未知'}${p.count ? ` ｜ 消息 ${String(p.from).split(':').pop() || '?'}–${String(p.to).split(':').pop() || '?'}（共 ${p.count} 条）` : ''}`,
            `置信度：${p.confidence !== undefined ? p.confidence : '?'}${one.linkedTo ? ` ｜ 关联：${one.linkedTo}` : ''}`,
          ];
          return finish(lines.join('\n'));
        }
        // 恢复：/facts 恢复 3
        if (/^(恢复|restore)/.test(arg)) {
          if (!isMaster) return finish('恢复记忆只有主人能做。');
          const ref = arg.replace(/^(恢复|restore)[\s:：]*/, '').trim();
          const one = memories.restore(key, ref);
          return finish(one ? `恢复了：「${String(one.text).slice(0, 40)}」` : '没找到这条。');
        }
        // 搜：/facts 搜 棍木
        const all = memories.listFacts(key);
        const q = arg.replace(/^(搜|搜索|找|查)[\s:：]*/, "").trim();
        const hit = q ? all.filter((x) => String(x.text).includes(q)) : all;
        if (!hit.length) return finish(q ? `没搜到和「${q}」有关的事。` : "记忆库还是空的。");
        const show = hit.slice(-12);
        return finish(
          `记着 ${hit.length} 条${q ? `（"${q}"）` : ""}，最近 ${show.length} 条：\n`
          + show.map((x) => `${x.index}. ${String(x.text).slice(0, 36)}`).join("\n")
          + "\n删：/facts 删 序号"
        );
      }
      case 'digest': {
        if (!isMaster) return finish('这个只有主人能看。');
        const _arg = String(command.arg || '').trim();
        if (/^(run|now|立刻|现在|跑)$/i.test(_arg)) {
          try {
            const _port = Number(this.config.server && this.config.server.port) || 8787;
            const _r = await fetch('http://127.0.0.1:' + _port + '/api/digest/run', { method: 'POST' });
            const _d = await _r.json();
            const _items = Array.isArray(_d.items) ? _d.items : [];
            const _added = _items.reduce((n, x) => n + (Number(x.added) || 0), 0);
            return finish('摘要跑完了：' + _items.length + ' 个会话，共 ' + _added + ' 条要点。');
          } catch (e) {
            return finish('触发摘要失败：' + (e && e.message));
          }
        }
        const items = this.store.digestOf(key) || [];
        if (!items.length) return finish('还没有长期记忆，再聊一会儿就有了。');
        return finish('我记住的长期要点（' + items.length + ' 条）：\n- ' + items.join('\n- '));
      }
      // —— 本地操作：只给主人，全部限制在沙箱里 ——
      case 'dl': {
        if (!isMaster) return finish('这个只有主人能让我做，别人不行。');
        const url = String(command.arg || '').trim();
        if (!/^https?:\/\//i.test(url)) return finish('给我个 http/https 链接，我下到沙箱里。');
        try {
          const r = await tools.download(url);
          tools.audit({ who: msg.senderId, tool: 'dl', arg: url, ok: true, out: r.path });
          return finish(`下好了：${require('node:path').basename(r.path)}（${Math.round(r.size / 1024)} KB），在沙箱里。`);
        } catch (err) {
          tools.audit({ who: msg.senderId, tool: 'dl', arg: url, ok: false, out: String(err && err.message) });
          return finish(`没下成：${(err && err.message) || '未知错误'}`);
        }
      }
      case 'ls': {
        if (!isMaster) return finish('这个只有主人能让我做。');
        try {
          const rows = tools.listDir(command.arg || '');
          tools.audit({ who: msg.senderId, tool: 'ls', arg: command.arg || '', ok: true, out: `${rows.length} 项` });
          if (!rows.length) return finish('沙箱是空的。');
          const text = rows.slice(0, 20)
            .map((r) => `${r.dir ? '[目录]' : ''}${r.name}${r.dir ? '' : ` ${Math.round(r.size / 1024)}KB`}`)
            .join('；');
          return finish(`沙箱里 ${rows.length} 项：${text}`);
        } catch (err) {
          return finish(`打不开：${(err && err.message) || '未知错误'}`);
        }
      }
      case 'run': {
        if (!isMaster) return finish('这个只有主人能让我做，别人不行。');
        try {
          const r = await tools.runScript(command.arg || '');
          tools.audit({ who: msg.senderId, tool: 'run', arg: command.arg || '', ok: r.code === 0, out: r.out.slice(0, 200) });
          const head = r.out ? r.out.slice(0, 300) : '（没有输出）';
          return finish(`跑完了，退出码 ${r.code}：${head}`);
        } catch (err) {
          tools.audit({ who: msg.senderId, tool: 'run', arg: command.arg || '', ok: false, out: String(err && err.message) });
          return finish(`没跑成：${(err && err.message) || '未知错误'}`);
        }
      }
      case 'status': {
        const summary = this.store.summary();
        const mood = persona.moodFor(new Date(nowMs));
        const mode = this.llm.isMock ? '演示模式（未配置 API Key）' : `DeepSeek ${this.llm.model}`;
        return finish(
          `咕噜~ 人家现在心情${mood.name}，脑子用${mode}，记得 ${summary.sessions} 个聊天、${summary.notes} 条关于大家的小事。尾巴状态：良好。`
        );
      }
      case 'persona': {
        // 主人专用：非主人按普通聊天处理（返回 null，不提示命令存在）
        if (msg.isMaster !== true) return null;
        const arg = String(command.arg || '').trim();
        if (/^(undo|回滚|撤销)$/i.test(arg)) {
          try {
            const fs2 = require('node:fs');
            const path2 = require('node:path');
            const dir = path2.join(this.dataDir || path2.join(__dirname, '..', 'data'), 'persona-backups');
            const files = fs2.readdirSync(dir).filter((f) => f.endsWith('.json')).sort();
            if (!files.length) return finish('没有可回滚的人设备份。');
            const last = files[files.length - 1];
            const bak = JSON.parse(fs2.readFileSync(path2.join(dir, last), 'utf8'));
            saveConfigValue(this.config, 'persona.customPrompt', String(bak.customPrompt || ''));
            this.config.persona.customPrompt = String(bak.customPrompt || '');
            try { fs2.unlinkSync(path2.join(dir, last)); } catch { /* 删不掉也不影响回滚 */ }
            return finish('已回滚人设（' + String(bak.customPrompt || '').length + ' 字），这一步备份已出栈。');
          } catch (err) {
            return finish('回滚失败：' + (err && err.message));
          }
        }
        if (!arg || /^(show|看看|看|当前)$/i.test(arg)) {
          const cur = String((this.config.persona && this.config.persona.customPrompt) || '');
          if (!cur) return finish('现在没设 customPrompt，走的是结构化人设（personality / background 那几个字段）。');
          return finish('现在的人设开头：\n' + cur.slice(0, 200) + (cur.length > 200 ? '…' : ''));
        }
        if (arg.length < 30) return finish('太短了，人设至少给个 30 字，不然后面会跑偏。');
        try {
          saveConfigValue(this.config, 'persona.customPrompt', arg);
          this.config.persona.customPrompt = arg;
        } catch (err) {
          return finish('写配置失败：' + (err && err.message));
        }
        return finish(`人设换了（${arg.length} 字），下一条消息就生效。`);
      }
      case 'set': {
        if (msg.isMaster !== true) return null;
        const arg = String(command.arg || '').trim();
        if (!arg) {
          const cur = (dotted) => {
            const parts = String(dotted).split('.');
            let node = this.config;
            for (const part of parts) { if (node == null) return '—'; node = node[part]; }
            return node === undefined ? '—' : JSON.stringify(node);
          };
          const lines = Object.entries(SET_TABLE).map(([k, v]) => '/set ' + k + ' <值> —— ' + v.label + '（当前 ' + cur(v.path) + '）');
          return finish('主人专用。所有开关（格式：/set 名字 值）：\n' + lines.join('\n') + '\n\n看全部指令发 /help');
        }
        const m = arg.match(/^([A-Za-z]+)\s+([\s\S]+)$/);
        if (!m) return finish('格式是「/set 名字 值」，比如 /set emoji 少。先发 /set 看能调什么。');
        const key = Object.keys(SET_TABLE).find((k) => k.toLowerCase() === m[1].toLowerCase());
        if (!key) return finish(`没有这个开关：${m[1]}。先发 /set 看能调什么。`);
        const spec = SET_TABLE[key];
        let value;
        try {
          value = spec.coerce(m[2].trim());
        } catch (err) {
          return finish('设不了：' + (err && err.message));
        }
        try {
          saveConfigValue(this.config, spec.path, value);
          const parts = spec.path.split('.');
          let cur = this.config;
          for (let i = 0; i < parts.length - 1; i += 1) {
            if (!cur[parts[i]]) cur[parts[i]] = {};
            cur = cur[parts[i]];
          }
          cur[parts[parts.length - 1]] = value;
        } catch (err) {
          return finish('写配置失败：' + (err && err.message));
        }
        return finish(`好，${spec.label} = ${JSON.stringify(value)}（已写进 config.json，即时生效）`);
      }
      case 'reset': {
        this.store.resetSession(key);
        return finish('呜…刚才的聊天人家忘掉啦（只清掉这个聊天框的记忆哦）🫧');
      }
      case 'memory': {
        // 有人把「/memory 李益凯：wxid_xxx」当"记住"用，带参数时转给 remember
        if (command.arg && command.arg.trim() && !/^(搜|搜索|找|查)/.test(command.arg.trim())) {
          command = { ...command, type: 'remember', arg: command.arg };
          return this.runCommand({ command, msg, key, profile, state, nowMs, atMe, isMaster });
        }
        // 群共享：所有人都能看整本小本子（不做按人隔离）
        const rows = this.store.listNotes(key);
        if (!rows.length) {
          return finish('人家还什么都没记住呢。想让我记住就说「记住：你怕黑」这种，我就能记好久…大概。');
        }
        const ask = String(command.arg || "").trim().replace(/^(搜|找|查)[\s:：]*/, "");
        const order = rows.slice().sort((a, b) => (b.uid === msg.senderId ? 1 : 0) - (a.uid === msg.senderId ? 1 : 0));
        const lines = [];
        for (const r of order) {
          const notes = r.notes.filter((n) => !ask || String(n).includes(ask));
          if (!notes.length) continue;
          const who = r.uid === msg.senderId ? '你' : r.name;
          lines.push(`${who}：${notes.join("；")}`);
        }
        if (!lines.length) return finish(`小本本里没有和「${ask}」有关的。`);
        const head = ask ? `和「${ask}」有关的：` : `小本本（全群共享，共 ${rows.length} 人）：`;
        return finish((head + "\n" + lines.join("\n")).slice(0, 600));
      }
      case 'remember': {
        if (!command.arg) return finish('记住什么呀？说「记住：你爱吃辣」这样，人家才记得住 (｡•̀ᴗ-)✧');
        // 支持记别人：「记住 李益凯：wxid_xxx」→ 记到这个 wxid 名下，
        // 顺便把他的名字设成昵称，以后他说话她就认得。
        let fact = command.arg.trim()
          // 有人写成「/remember 记住：xxx」，先把重复的动词去掉
          .replace(/^(?:记住|记一下|记下|帮我记住)[：:，,。.\s]*/, '')
          .trim();
        let targetUid = msg.senderId;
        let who = '';
        const m = fact.match(/^(.{1,16}?)[：:]\s*([\s\S]+)$/);
        if (m) {
          who = m[1].trim().replace(/^关于/, '');
          fact = m[2].trim();
          const wid = (fact.match(/wxid_[A-Za-z0-9_\-]+/) || [])[0];
          if (wid) {
            targetUid = wid;
            try { this.store.setNickname(key, wid, who); } catch (_) { /* 昵称失败不影响记笔记 */ }
            fact = `${who} 的微信 ID 是 ${wid}`;
          } else {
            const p = this.store.findProfileByName(key, who);
            if (p) targetUid = p.uid;
            else fact = `关于${who}：${fact}`;
          }
        }
        const notes = this.store.addNote(key, targetUid, fact);
        this.ensureNoteVectors(key, targetUid, [fact]).catch(() => {});
        const owner = who && targetUid !== msg.senderId ? `（记在「${who}」名下）` : '';
        return finish(`记住啦：${fact}${owner}。本鲸的记忆有 ${notes.length} 格，还够用~`);
      }
      case 'forget': {
        const arg = String(command.arg || '').trim();
        const { removed } = this.store.removeNote(key, msg.senderId, arg);
        let tomb = false;
        let killed = 0;
        // 只有主人能删群级事实/落墓碑；群友只能删自己的笔记
        if (arg && isMaster) {
          try {
            const tombstones = require('./tombstones');
            tombstones.setDataDir(this.dataDir);
            tombstones.add(arg, { scope: key, by: isMaster ? 'master' : 'member' });
            tomb = true;
            for (let i = 0; i < 5; i += 1) {
              const gone = memories.removeByText(key, arg);
              if (!gone) break;
              killed += 1;
            }
          } catch (e) {
            if (this.logger) this.logger.warn('[忘记] 落墓碑失败：' + (e && e.message));
          }
        }
        if (!removed && !killed && !tomb) {
          return finish('人家本来就没记这个呀，是不是记错鲸了？');
        }
        const parts = [];
        if (removed) parts.push(`笔记 ${removed} 条`);
        if (killed) parts.push(`长期记忆 ${killed} 条`);
        const tail = isMaster ? '以后不会再有这条。' : '你自己的笔记删了；群里的记忆我动不了。';
        return finish(`好，忘掉「${arg || '全部'}」了（${parts.join('、') || '已记录'}）。${tail}`);
      }
      case 'name': {
        if (!command.arg) return finish('那你想让人家叫你什么？说「叫我小海」这样就行。');
        this.store.setNickname(key, msg.senderId, command.arg);
        return finish(`好呀，以后就叫你「${command.arg}」啦，写进小本本了 (｡•̀ᴗ-)✧`);
      }
      case 'mute': {
        const minutes = clampInt(command.arg || g.muteDefaultMinutes, 1, 1440, g.muteDefaultMinutes);
        // 以前只设了 mutedUntil，而真正拦回复的是 silentUntil ——
        // 结果她嘴上答应闭嘴，下一条照样回。
        state.silentUntil = nowMs + minutes * 60000;
        state.mutedUntil = nowMs + minutes * 60000;
        state.silentReason = 'mute';
        state.engagedUntil = 0;
        this.store.markDirty();
        return finish(`好，闭嘴 ${minutes} 分钟。到点我自己醒；想提前放我出来就发 /unmute`);
      }
      case 'unmute': {
        state.silentUntil = 0;
        state.mutedUntil = 0;
        state.engagedUntil = 0;
        this.store.setMuted(key, 0);
        this.store.markDirty();
        return finish('行，我回来了');
      }
      default:
        return finish(COMMAND_HELP);
    }
  }

  /**
   * 流式生成回复文本片段（含演示模式）。
   */
  async *generate(decision, { signal } = {}) {
    if (decision.action === 'command') {
      yield decision.text;
      return;
    }
    if (decision.canned) {
      yield decision.canned;
      return;
    }
    if (decision.mock) {
      const text = decision.text || '';
      for (let i = 0; i < text.length; i += 2) {
        if (signal && signal.aborted) return;
        yield text.slice(i, i + 2);
        if (this.mockChunkDelayMs > 0) await sleep(this.mockChunkDelayMs);
      }
      return;
    }
    for await (const piece of this.llm.stream({ system: decision.system, turns: decision.turns, signal })) {
      yield piece;
    }
  }

  /** 偶尔在句尾补一个 emoji 或颜文字（由「颜文字用量」档位决定概率） */
  pickEmoji(text) {
    // 吵架大赛模式不发表情：正在喷人突然来个 🍚 很出戏
    const chance = (persona.fightModeOn && persona.fightModeOn(this.config)) ? 0 : persona.emojiChanceFor(this.config);
    if (!chance) return text;
    if (/[\u{1F300}-\u{1FAFF}\u{2600}-\u{27BF}]/u.test(text)) return text;
    if (this.rng() > chance) return text;
    // 一半颜文字、一半 emoji：以前只有 emoji，所以调「颜文字」也看不到颜文字
    if (this.rng() < 0.5) return text + ' ' + persona.kaomojiPick(this.rng);
    const list = ['🐋', '🥺', '😭', '✨', '💧', '🫧'];
    return text + ' ' + list[Math.floor(this.rng() * list.length)];
  }

  /** 写入鲸鲸自己的回复，返回气泡数组 */
  /**
   * 这条回复要不要补一张表情包（实验性）。
   * 总闸关着直接返回 null，调用方无需再判断。
   * @returns {{emotion: string, path: string}|null}
   */
  stickerFor(decision, text, request = '') {
    if (!stickers.isOn(this.config) || !this.stickerService) return null;
    const msg = (decision && decision.msg) || {};
    // 只有她自己调用 send_sticker 时才发，不再按概率随机
    const map = this._pendingStickers || (this._pendingStickers = new Map());
    const key = String(msg.chatId || '');
    const plan = key ? map.get(key) : null;
    if (!plan) return null;
    map.delete(key);
    return plan;
  }

  finalize(decision, text, { error = false } = {}) {
    // 微信里没有 Markdown：模型说长内容时爱用 **加粗** / 列表，进来先洗掉
    text = stripMarkdown(String(text == null ? '' : text)).trim();
    // 正文里的 emoji 剥出来，单独发一条
    const emojiRe = /[\u{1F300}-\u{1FAFF}\u{2600}-\u{27BF}\u{1F1E6}-\u{1F1FF}\u{FE0F}]/gu;
    const foundEmoji = (text.match(emojiRe) || []).join('');
    if (foundEmoji) text = text.replace(emojiRe, '').replace(/[ \t]+$/g, '').trim();
    // 去掉波浪号、句号、感叹号，像真人打字一样干净
    text = text.replace(/[~～]+/g, '').replace(/[。！!]+/g, '。').replace(/[ \t]{2,}/g, ' ').trim();
    // 脏话换成年轻人的说法（对喷时保留原样，不然吵起来没劲）
    const fighting = Boolean(decision && decision.msg && decision.msg.fight) || (decision && decision.reason === 'clapback');
    if (!fighting) {
      text = text.replace(/我操|我靠|草泥马|操你/g, '我去').replace(/卧槽|卧超|我超|我焯|我擦/g, '我去，').replace(/^草[，,\\s]?/g, '我去');
    }
    // 弱模型爱说客服话，直接掐掉（免费模型尤其明显）
    const serviceTone = /(有什么(我)?能?可以?帮(你|您)的?吗?|需要我帮(你|您)|希望(这)?能帮到你|还有什么可以帮|作为一个(?:AI|语言模型)|随时告诉我)/;
    if (serviceTone.test(text) && !fighting) {
      const kept = text.split(/[，,。；;\n]/).map((s) => s.trim()).filter((s) => s && !serviceTone.test(s)).join('，').trim();
      if (kept.length >= 2) text = kept;
    }
    // 对方没聊吃的，就别把话题硬拐到米饭上；整条都在说饭就干脆不发
    const riceRe = /(大白饭|白米饭|米饭)/;
    const foodTopic = /(吃|饭|饿|干饭|外卖|好吃|零食|宵夜|早餐|午餐|午饭|晚餐|晚饭|食堂|菜|煮|炒|泡面|下厨|厨)/;
    const userText = String((decision && decision.msg && (decision.msg.cleanText || decision.msg.text)) || '');
    if (riceRe.test(text) && !foodTopic.test(userText)) {
      const kept = text.split(/[，,。；;\n]/).map((s) => s.trim()).filter((s) => s && !riceRe.test(s)).join('，').trim();
      text = kept.length >= 2 ? kept : '';
    }
    // 对喷时不许认输：模型一旦说软话，换成库里的狠话
    if (fighting && persona.SOFT_FIGHT_RE.test(text)) {
      const dirty = Boolean(decision && decision.msg && decision.msg.fightDirty);
      const line = persona.clapbackPick(dirty ? ['重', '爹味', '反问'] : ['轻', '典', '反问'], this.rng);
      if (line) text = line;
    }
    if (!decision || !decision.key || !text) return [];
    // handle() 要用最终文本当 reply，否则「软话被换掉」对外还是原文
    decision.finalText = text;
    // 最后的兜底：还在复读就整句重来，不能把别人的话或自己上一句原样发回去
    const heardList = (decision && decision.heardList) || [String((decision && decision.msg && (decision.msg.cleanText || decision.msg.text)) || '')];
    const ownList = (decision && decision.ownList) || [];
    if (heardList.some((h) => isEcho(text, h)) || ownList.some((h) => isEcho(text, h))) {
      const fightingNow = Boolean(decision && decision.msg && decision.msg.fight);
      const line = fightingNow
        ? persona.clapbackPick(['重', '爹味', '反问'], this.rng)
        : (this.rng() < 0.5 ? '你说呢' : '这话我听着都替你尴尬');
      if (line) text = line;
      decision.finalText = text;
    }
    const msg = decision.msg || {};
    // L3：开火了却说不清对方骂了啥（没引用原话片段）→ 大概率是自作多情，降级成一句「？」
    // 只对「没被叫到、只在群里听到脏话就开火」的情况做原话校验；
    // @她/点名的对喷不需要证明，别再把她嘴堵上。
    const autoFight = Boolean(msg.fight) && !msg.isMaster && String(msg.fightReason || '') === 'insulted';
    // 只在「连她名字都没提」的自动开火时校验；点名了就是在说她，别把人嘴堵上
    if (autoFight && !namedHerIn(msg.cleanText || msg.text || '') && features.isOn(this.config, 'fightQuoteCheck')) {
      const rawHeard = String(msg.cleanText || msg.text || '');
      const norm = (x) => String(x || '').replace(/[\s\p{P}\p{S}]/gu, '');
      const heardCore = norm(rawHeard);
      const replyCore = norm(text);
      let hit = false;
      for (let i = 0; i + 3 <= heardCore.length; i += 1) {
        if (replyCore.includes(heardCore.slice(i, i + 3))) { hit = true; break; }
      }
      if (!hit) {
        this.logger && this.logger.warn('开怼缺少原话依据，降级为「？」：' + String(text).slice(0, 30));
        text = '？';
        decision.finalText = text;
      }
    }
    // 主人告状说有人骂他：她在替主人出头，骂的是别人，不适用「对主人不许带脏字」
    if (msg.fightTarget && msg.fightTarget.name) {
      const name = msg.fightTarget.name;
      if (!String(text).includes(name)) {
        const attack = persona.clapbackPick(['重', '爹味', '反问'], this.rng) || '你算什么东西';
        text = `${name}，${attack}`;
        decision.finalText = text;
      }
    } else if (msg.isMaster) {
      const roastOn = Boolean(this.config.persona && this.config.persona.masterRoast);
      // 只有主人真的在数落她时才互怼；主人说「我生气了」这种要哄
      const masterSaid = String((decision.msg && (decision.msg.cleanText || decision.msg.text)) || '');
      const scolded = /(笨|傻|蠢|演我|废物|垃圾|烦|滚|闭嘴|特么|没用|不行|慢|搞错|到底|说了几遍)/.test(masterSaid);
      const rude = roastOn
        ? /(你妈|你爹|你他妈|他妈|傻逼|婊|操你|去死)/
        : /(你妈|你爹|你他妈|他妈|傻逼|狗东西|废物|滚蛋|滚出去|闭上你的嘴|没教养)/;
      const apology = /(对不起|抱歉|我错了|我知道错了|我知错|是我不对|下次一定|是我没做好|我会努力)/;
      const tooHostile = /(你算老几|贵物|小丑|废物|滚蛋|滚出去|闭嘴)/;
      const pickRoast = () => {
        const lines = persona.MASTER_ROAST_LINES || [];
        return lines.length ? lines[Math.floor(this.rng() * lines.length)] : '主人你骂我也没用，活儿还得我干';
      };
      // 已经按 ID 认证过主人，就不许再把 TA 当外人：
      // 模型偶尔还会顺着旧语气说「不是」「冒充」「就一个名字罢了」，直接改成认下来
      const denyMaster = /(不是你的?主人|不是你就对|冒充|自封|没你这号|认主系统|系统.{0,6}不认|不认你|就一个名字|光说没用|凭什么信你)/;
      if (denyMaster.test(text)) {
        this.logger && this.logger.warn('对主人说了否认身份的话，改掉：' + String(text).slice(0, 30));
        text = '是我主人啊，这还用问。';
        decision.finalText = text;
      }
      if (rude.test(text)) {
        this.logger && this.logger.warn('对主人回嘴越线，改掉：' + String(text).slice(0, 30));
        text = roastOn && scolded ? pickRoast() : '主人你骂我我也得听着，这次是我没做好';
        decision.finalText = text;
      } else if (roastOn && scolded && (apology.test(String(text)) || tooHostile.test(String(text)))) {
        // 主人在数落她，她却在道歉、或者骂得像仇人，换成撒泼式回嘴
        this.logger && this.logger.warn('主人让互怼，但语气不对，换掉：' + String(text).slice(0, 30));
        text = pickRoast();
        decision.finalText = text;
      }
    }
    this.store.appendMessage(decision.key, {
      role: 'assistant',
      name: this.config.persona.name,
      text,
      ts: this.now().getTime(),
      error,
    });
    const isGroup = msg.chatType === 'group';
    if (decision.action === 'command') return [text];
    const maxBubbles = Math.max(1, Number(behavior.get('maxBubbles')) || 2);
    const maxChars = msg.discussion ? (this.config.chat.discussionMaxChars || 400) : (isGroup ? this.config.chat.groupMaxChars : this.config.chat.privateMaxChars);
    let bubbles;
    if (decision.action === 'reply') {
      // 按逗号/句号拆成几条短消息，每条不带标点
      const clauses = (text.match(/[^，。！？!?；;\n]+/g) || [])
        .map((s) => s.trim().replace(/^[，。！？!?；;]+|[，。！？!?；;~～…]+$/g, ''))
        .filter(Boolean);
      if (clauses.length > 1 && clauses.length <= maxBubbles) {
        bubbles = clauses;
      } else {
        bubbles = persona.splitBubbles(text, { maxChars, maxBubbles })
          .map((b) => String(b || '').trim().replace(/[~～]+$/g, '').replace(/[。！!…]+$/g, ''))
          .filter(Boolean);
      }
    } else {
      bubbles = persona.splitBubbles(text, { maxChars, maxBubbles }).map((b) => String(b || '').trim()).filter(Boolean);
    }
    // emoji / 颜文字单独一条发，不粘在句末（概率由「颜文字用量」档位决定）
    const chance = persona.emojiChanceFor(this.config);
    if (!error && decision.action === 'reply' && chance > 0) {
      let extra = '';
      if (foundEmoji) extra = foundEmoji;
      else if (this.rng() <= chance) {
        // 颜文字和 emoji 各一半，这样「颜文字用量」调高后真的能看到颜文字
        extra = this.rng() < 0.5
          ? persona.kaomojiPick(this.rng)
          : ['🐋', '🥺', '😭', '✨', '💧', '🫧', '🍚'][Math.floor(this.rng() * 7)];
      }
      if (extra) {
        // 遵守 maxBubbles：气泡已经满了就并到最后一条，别偷偷多发一条
        if (bubbles.length < maxBubbles) bubbles.push(extra);
        else if (bubbles.length) bubbles[bubbles.length - 1] = (bubbles[bubbles.length - 1] + ' ' + extra).trim();
      }
    }
    return bubbles;
  }

  /**
   * 非流式的完整处理，给微信/抖音网关用。
   * @returns {{action: string, reply?: string, bubbles?: string[], reason: string, commandType?: string}}
   */
  /** 执行模型请求的一个工具调用 */
  async runToolCall(call, { isMaster, chatId, chatType, msgId, userText } = {}) {
    const name = call && call.function && call.function.name;
    let args = {};
    try {
      args = JSON.parse((call.function && call.function.arguments) || '{}');
    } catch { /* 参数不是 JSON 就当空 */ }
    try {
      if (name === 'search_web') {
        const q = String(args.query || '').slice(0, 60) || '最近的新闻';
        const r = await websearch.searchText(q, { limit: 4, timeoutMs: 8000 });
        if (this.logger) this.logger.info('[搜索] ' + q + ' → ' + String(r || '').split('\n').filter(Boolean).length + ' 行结果');
        return String(r || '（没有搜索结果）').slice(0, 1500);
      }
      if (name === 'get_weather') {
        const want = String(args.city || '').trim();
        let city = want || String((this.config.websearch && this.config.websearch.city) || '').trim();
        if (!city) {
          try { city = await websearch.ipCity(Number(this.config.websearch && this.config.websearch.timeoutMs) || 6000); } catch { /* 猜不到城市就退回搜索引擎 */ }
        }
        const t = await websearch.weatherText(city, { timeoutMs: 8000 });
        return String(t || '查不到天气').slice(0, 500);
      }
      if (name === 'download_file') {
        if (!isMaster) return '没有权限：只有主人能让我下载。';
        const r = await tools.download(String(args.url || ''));
        return `已下载到沙箱：${require('node:path').basename(r.path)}（${Math.round(r.size / 1024)} KB）`;
      }
      if (name === 'list_sandbox') {
        if (!isMaster) return '没有权限：只有主人能看沙箱。';
        const rows = tools.listDir(String(args.dir || ''));
        return rows.length ? rows.map((x) => x.name + (x.dir ? '/' : '')).join('，') : '沙箱是空的';
      }
      if (name === 'run_script') {
        if (!isMaster) return '没有权限：只有主人能让我跑脚本。';
        const r = await tools.runScript(String(args.name || ''));
        return `退出码 ${r.code}：${String(r.out || '').slice(0, 500)}`;
      }
      if (name === 'read_file') {
        if (!isMaster) return '没有权限：只有主人能让我读文件。';
        const r = workspace.readFileText(String(args.path || ''));
        tools.audit({ who: 'master', tool: 'read_file', arg: String(args.path || ''), ok: true, out: r.name + ' ' + r.bytes + 'B' });
        return '【' + r.name + '】\n' + String(r.text).slice(0, 3000);
      }
      if (name === 'write_file') {
        if (!isMaster) return '没有权限：只有主人能让我写文件。';
        const r = workspace.writeFileText(String(args.path || ''), args.content);
        tools.audit({ who: 'master', tool: 'write_file', arg: r.name, ok: true, out: r.bytes + 'B' });
        return '写好了：' + r.name + '（' + r.bytes + ' 字节）';
      }
      if (name === 'list_workspace') {
        if (!isMaster) return '没有权限：只有主人能看 workspace。';
        const rows = workspace.listFiles(String(args.dir || ''));
        return rows.length ? rows.map((x) => x.name + (x.dir ? '/' : '') + (x.dir ? '' : ' (' + Math.round(x.size / 1024) + 'KB)')).join('，') : 'workspace 是空的';
      }
      if (name === 'correct_memory') {
        const oldHint = String(args.old_hint || '').trim();
        const newFact = String(args.new_fact || '').trim();
        if (!newFact) return '要记成什么？';
        try {
          const key = 'wechat:' + (String(chatType || '') === 'group' ? 'g' : 'u') + ':' + String(chatId || '');
          const r = memories.correct(key, { oldText: oldHint, newText: newFact });
          await memories.addMany(key, [newFact], {
            embedUrl: this.config && this.config.group && this.config.group.embedUrl,
            source: '手动',
            evidences: [{ quote: String(userText || '').slice(0, 200), msgIds: msgId ? [String(msgId)] : [], confidence: 0.95 }],
          });
          return '记下了：' + newFact.slice(0, 40) + (r.superseded ? ('（推翻旧说法 ' + r.superseded + ' 条）') : '');
        } catch (e) {
          return '改记忆失败：' + (e && e.message);
        }
      }
      if (name === 'recall_self') {
        const q = String(args.query || '').trim();
        if (!q) return '要查什么？';
        try {
          const key = 'wechat:' + (String(chatType || '') === 'group' ? 'g' : 'u') + ':' + String(chatId || '');
          const rows = this.store.messages(key, 200).filter((m) => String(m.text || '').includes(q)).slice(-8);
          if (!rows.length) return '这个会话里没查到含「' + q + '」的话。';
          return rows.map((m) => {
            const t = new Date(m.ts).toLocaleTimeString('zh-CN', { hour12: false });
            return t + ' ' + (m.role === 'assistant' ? '你' : '对方') + '：' + String(m.text || '').replace(/\n/g, ' ').slice(0, 60);
          }).join('\n');
        } catch (e) {
          return '查不了：' + (e && e.message);
        }
      }
      if (name === 'fetch_url') {
        const url = String(args.url || '').trim();
        if (!/^https?:\/\//i.test(url)) return '只支持 http/https 链接。';
        try {
          const u = new URL(url);
          const host = u.hostname.toLowerCase();
          if (host === 'localhost' || host.startsWith('127.') || host.startsWith('10.') || host.startsWith('192.168.') || host.startsWith('169.254.') || /\.local$/.test(host)) {
            return '这个地址不能读（内网）。';
          }
        } catch { return '链接格式不对。'; }
        try {
          const ctrl = new AbortController();
          const timer = setTimeout(() => ctrl.abort(), 15000);
          const r = await fetch(url, {
            headers: { 'user-agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/125 Safari/537.36', 'accept-language': 'zh-CN,zh;q=0.9' },
            signal: ctrl.signal,
            redirect: 'follow',
          });
          clearTimeout(timer);
          const html = await r.text();
          const title = ((html.match(/<title[^>]*>([\s\S]*?)<\/title>/i) || [])[1] || '').replace(/\s+/g, ' ').trim();
          let body = html
            .replace(/<script[\s\S]*?<\/script>/gi, ' ')
            .replace(/<style[\s\S]*?<\/style>/gi, ' ')
            .replace(/<[^>]+>/g, ' ')
            .replace(/&nbsp;/g, ' ')
            .replace(/&amp;/g, '&')
            .replace(/&lt;/g, '<')
            .replace(/&gt;/g, '>')
            .replace(/\s+/g, ' ')
            .trim();
          return ('【' + (title || url) + '】\n' + body).slice(0, 2500);
        } catch (e) {
          return '打不开这个链接：' + (e && e.message);
        }
      }
      if (name === 'send_sticker') {
        if (!stickers.isOn(this.config) || !this.stickerService) return '表情包功能没开。';
        const emo = String(args.emotion || 'meh');
        try {
          const plan = this.stickerService.plan({ platform: 'wechat', chatId, chatTitle: '' }, '', '', emo);
          if (!plan) return '这一类的表情包还没有，先攒点。';
          const map = this._pendingStickers || (this._pendingStickers = new Map());
          map.set(String(chatId || ''), plan);
          return '好，发一个。';
        } catch (e) {
          return '表情包发不出去：' + (e && e.message);
        }
      }
      if (name === 'self_edit') {
        if (!isMaster || String(chatType || '') !== 'private') return '代码自改只能在主人私聊里发起。';
        const r = selfedit.create({ request: String(args.request || '').slice(0, 2000) });
        return r.ok ? ('开始生成代码提案（' + r.id + '），好了发你审批。') : r.msg;
      }
      if (name === 'edit_persona') {
        if (!isMaster || String(chatType || '') !== 'private') return '这个只能在主人私聊里改。';
        const fs2 = require('node:fs');
        const path2 = require('node:path');
        const rule = String(args.rule || '').trim();
        if (rule.length < 10) return '太短了，至少给 10 个字。';
        const old = String((this.config.persona && this.config.persona.customPrompt) || '');
        const dir = path2.join(this.dataDir || path2.join(__dirname, '..', 'data'), 'persona-backups');
        fs2.mkdirSync(dir, { recursive: true });
        const stamp = new Date().toISOString().replace(/[:.]/g, '-');
        fs2.writeFileSync(path2.join(dir, stamp + '.json'), JSON.stringify({ at: Date.now(), customPrompt: old }, null, 1), 'utf8');
        const next = String(args.mode || 'append') === 'replace' ? rule : (old ? old + '\n' + rule : rule);
        saveConfigValue(this.config, 'persona.customPrompt', next);
        this.config.persona.customPrompt = next;
        if (this.logger) this.logger.info('[人设] 自主修改（' + String(args.mode || 'append') + '，' + rule.length + ' 字）');
        return '人设改好了（' + next.length + ' 字），下一条消息生效。';
      }
      if (name === 'tune_behavior') {
        const r = behavior.set(String(args.key || ''), args.value);
        if (!r.ok) return r.msg;
        if (this.logger) this.logger.info('[行为] ' + r.key + ': ' + r.old + ' → ' + r.value + (args.why ? '（' + String(args.why).slice(0, 40) + '）' : ''));
        return '已把 ' + r.key + ' 调成 ' + r.value + '。';
      }
      if (name === 'agent_task') {
        if (!agentBridge.isEnabled()) return '后台 agent 现在是关闭的（只有主人能开）。';
        const r = agentBridge.request({ task: String(args.task || '').slice(0, 2000), chatId, chatType, isMaster });
        if (!r.ok) return r.msg;
        if (r.pending) return '这个得先问一下主人（已发申请），批准了我就开跑。';
        return '已经交给后台 agent（' + r.id + '），做完我把结果和文件发过来。你先别等我。';
      }
      if (name === 'read_chat') {
        if (!isMaster) return '没有权限：只有主人能看别的会话记录。';
        const want = String(args.chat || '').trim();
        const limit = Math.max(1, Math.min(50, Number(args.limit) || 20));
        if (!want) return '要查哪个群？';
        let target = want;
        let kind = /@chatroom$/i.test(want) ? 'g' : 'u';
        if (kind === 'g' && !/@chatroom$/i.test(want)) return '群 id 要是 …@chatroom 的形式';
        if (kind === 'u' && !/^wxid_/i.test(want)) {
          // 按群名匹配已存在的会话
          for (const [sk, sess] of this.store.sessions) {
            if (sess.chatType !== 'group') continue;
            const title = String(sess.title || '');
            if (title && (title.includes(want) || want.includes(title))) {
              target = String(sess.chatId || '');
              kind = 'g';
              break;
            }
          }
        }
        const sessKey = 'wechat:' + kind + ':' + target;
        const rows = this.store.messages(sessKey, limit);
        if (!rows.length) return '这个会话我这儿没有记录：' + want;
        return rows.map((m) => (m.role === 'assistant' ? '她' : (m.name || '群友')) + '：' + String(m.text || '').slice(0, 80)).join('\n');
      }
      return '没有这个工具';
    } catch (err) {
      return '工具执行失败：' + ((err && err.message) || '未知错误');
    }
  }

  /**
   * 带工具循环的生成：模型可以自己决定查网页/下载/看沙箱/跑脚本，
   * 执行完把结果喂回去再接着想（最多 2 轮），这就是"像 agent"的关键。
   */
  async generateWithTools({ system, turns, isMaster, maxTokens, chatId, chatType, msgId, userText }) {
    let allowed = isMaster ? TOOL_SPECS : TOOL_SPECS.filter((t) => ['search_web', 'agent_task', 'tune_behavior', 'send_sticker', 'fetch_url', 'recall_self', 'correct_memory'].includes(t.function.name));
    if (!agentBridge.isEnabled()) allowed = allowed.filter((t) => t.function.name !== 'agent_task');
    const msgs = Array.isArray(turns) ? turns.slice() : [];
    const agentCfg = this.config.agent || {};
    // 主人可以跑多步（真干活），群友仍然最多两轮（防止刷）
    const maxRounds = isMaster
      ? Math.max(2, Math.min(10, Number(agentCfg.maxRounds) || 6))
      : 2;
    const announce = async (text) => {
      try {
        if (typeof this.onProgress === 'function') await this.onProgress({ chatId, chatType, text });
      } catch { /* 播报失败不影响干活 */ }
    };
    // 四道机制墙：轮数 / 本条总 token / 总时长 / 原地打转。平时都碰不到。
    const maxTurnTokens = Math.max(20000, Number(agentCfg.maxTokensPerTurn) || 60000);
    const maxWallMs = Math.max(30000, Number(agentCfg.maxWallMs) || 120000);
    const startedAt = Date.now();
    let spent = 0;
    let lastSig = '';
    let stopReason = '';
    let announced = false;
    for (let round = 0; round < maxRounds; round += 1) {
      const r = await this.llm.completeWithTools({ system, turns: msgs, tools: allowed, maxTokens });
      spent += Number((r.usage && r.usage.total_tokens) || 0) || 0;
      if (!r.toolCalls.length) {
        this._lastAgentStats = { rounds: round + 1, tokens: spent, ms: Date.now() - startedAt, stop: '' };
        return r.text || '';
      }
      const names = r.toolCalls.map((c) => (c.function && c.function.name) || '').filter(Boolean);
      this.logger && this.logger.info('[工具] 第 ' + (round + 1) + ' 轮：' + names.join('、'));

      // 原地打转：连续两轮调一模一样的工具和参数
      const sig = JSON.stringify(r.toolCalls.map((c) => [(c.function && c.function.name) || '', (c.function && c.function.arguments) || '']));
      if (sig === lastSig) { stopReason = 'no_progress'; break; }
      lastSig = sig;
      // 让她先吱一声，别让人以为死了；只播报一次
      if (!announced) {
        announced = true;
        const lines = isMaster
          ? ['我看看哈', '等下，我查一下', '这就去看']
          : [];
        if (lines.length) await announce(lines[Math.floor(Math.random() * lines.length)]);
      }
      msgs.push({ role: 'assistant', content: r.text || '', tool_calls: r.toolCalls });
      for (const call of r.toolCalls) {
        const out = await this.runToolCall(call, { isMaster, chatId, chatType, msgId, userText });
        msgs.push({ role: 'tool', tool_call_id: call.id, content: out });
      }
      // 另外两道墙：本条总 token / 总时长
      if (spent > maxTurnTokens) { stopReason = 'tokens'; break; }
      if (Date.now() - startedAt > maxWallMs) { stopReason = 'time'; break; }
    }
    // 撞墙了要说一声，别让人干等
    const wallText = {
      no_progress: '我绕进去了，先说这些',
      tokens: '这条查得有点重，我先说手上这些',
      time: '太久了，我先说这些',
    }[stopReason] || '我理一下啊';
    await announce(wallText);
    const finalText = await this.llm.complete({ system, turns: msgs, maxTokens });
    this._lastAgentStats = { rounds: maxRounds, tokens: spent, ms: Date.now() - startedAt, stop: stopReason || 'rounds' };
    this.logger && this.logger.info('[工具] 结束：' + maxRounds + ' 轮上限 / ' + spent + ' tokens / ' + Math.round((Date.now() - startedAt) / 1000) + 's / ' + (stopReason || 'rounds'));
    return finalText;
  }

  /** 后台任务：用工具把活干完，关键节点回调 onStep（用于播报） */
  async runTask({ instruction, onStep, isCancelled }) {
    const system = [
      '你在后台执行主人交代的任务。用工具把事做完，最后用一两句话汇报。',
      '需要资料用 search_web；需要留文件就写 workspace（路径用相对路径，比如 notes/x.md）；不要编造工具结果。',
      '如果生成了文件，在最后一行写：FILE: 相对路径',
    ].join('\n');
    const msgs = [{ role: 'user', content: '任务：' + String(instruction || '') }];
    const maxRounds = 8;
    const maxWallMs = 4 * 60 * 1000;
    const started = Date.now();
    let spent = 0;
    for (let round = 0; round < maxRounds; round += 1) {
      if (isCancelled && isCancelled()) return { cancelled: true, text: '', tokens: spent };
      const r = await this.llm.completeWithTools({ system, turns: msgs, tools: TOOL_SPECS.filter((t) => t.function.name !== 'agent_task'), maxTokens: 4000 });
      spent += Number((r.usage && r.usage.total_tokens) || 0) || 0;
      if (!r.toolCalls.length) return { text: r.text || '', tokens: spent };
      msgs.push({ role: 'assistant', content: r.text || '', tool_calls: r.toolCalls });
      for (const call of r.toolCalls) {
        if (isCancelled && isCancelled()) return { cancelled: true, text: '', tokens: spent };
        const name = (call.function && call.function.name) || '';
        const out = await this.runToolCall(call, { isMaster: true });
        if (onStep) await onStep(name, out);
        msgs.push({ role: 'tool', tool_call_id: call.id, content: out });
      }
      if (spent > 80000 || Date.now() - started > maxWallMs) break;
    }
    const finalText = await this.llm.complete({ system, turns: msgs, maxTokens: 2000 });
    return { text: finalText, tokens: spent };
  }

  async handle(rawMsg, { signal } = {}) {
    let decision;
    try {
      decision = await this.decide(rawMsg);
    } catch (err) {
      this.logger && this.logger.error('处理消息出错：' + (err && err.stack ? err.stack : err));
      return { action: 'ignore', reason: 'error' };
    }
    if (decision.action === 'ignore') {
      return { action: 'ignore', reason: decision.reason };
    }
    if (decision.action === 'command') {
      const bubbles = this.finalize(decision, decision.text);
      return { action: 'reply', reply: decision.text, bubbles, reason: 'command', commandType: decision.commandType };
    }
    // 自动再巩固：主人私聊里明确纠正时，先改记忆再回话
    try {
      const m = decision.msg;
      if (m && m.isMaster && String(m.chatType) === 'private'
        && !(this.config.memory && this.config.memory.autoReconsolidate === false)) {
        const { autoCorrect } = require('./reconsolidate');
        const r = await autoCorrect({
          llm: this.llm,
          key: 'wechat:u:' + String(m.chatId || ''),
          text: String(m.cleanText || m.text || ''),
          embedUrl: String((this.config.group && this.config.group.embedUrl) || ''),
          msgId: m.msgId,
        });
        if (r && r.applied) {
          this.logger && this.logger.info('[自动纠正] ' + String(r.newFact).slice(0, 30) + '（推翻 ' + r.superseded + ' 条）');
        }
      }
    } catch (e) {
      this.logger && this.logger.warn && this.logger.warn('[自动纠正] 跳过：' + (e && e.message));
    }
    let text = '';
    try {
      if (decision.canned) {
        text = decision.canned;
      } else if (decision.mock) {
        text = decision.text;
      } else {
        // 走带工具的生成：她能自己决定查网页 / 下载 / 看沙箱 / 跑脚本，
        // 执行完再接着回答（最多 2 轮）。模型不支持工具时会自动退回普通生成。
        const toolsOn = !this.config.tools || this.config.tools.enabled !== false;
        if (toolsOn && typeof this.llm.completeWithTools === 'function') {
          try {
            text = await this.generateWithTools({
              system: decision.system,
              turns: decision.turns,
              isMaster: Boolean(decision.msg && decision.msg.isMaster),
              maxTokens: decision.msg && decision.msg.replyMaxTokens,
              chatId: decision.msg && decision.msg.chatId,
              chatType: decision.msg && decision.msg.chatType,
              msgId: decision.msg && decision.msg.msgId,
              userText: decision.msg && (decision.msg.cleanText || decision.msg.text),
            });
          } catch (err) {
            this.logger && this.logger.warn('工具循环失败，退回普通生成：' + (err && err.message));
            text = await this.llm.complete({ system: decision.system, turns: decision.turns, maxTokens: decision.msg && decision.msg.replyMaxTokens });
          }
        } else {
          text = await this.llm.complete({ system: decision.system, turns: decision.turns });
        }
        // 模型自己决定"这条我不接"：只输出 [SKIP] 就整条丢弃，不发任何东西。
        // 比在 prompt 里反复暗示"可以少说"有效得多——它终于有个"不说话"的动作可做。
        if (/^\s*[[【（(]?\s*SKIP\s*[\]】）)]?\s*$/i.test(String(text || ''))) {
          this.logger && this.logger.info('[跳过] 模型判断这条不接');
          return { action: 'ignore', reason: 'model_skip' };
        }
        // 模型有时候只会把别人说过的话复读一遍，或者重复自己上一句，这种重写一次
        const heardList = this.recentHeard(decision);
        const ownList = this.recentOwn(decision);
        decision.heardList = heardList;
        decision.ownList = ownList;
        const repeatsSomeone = heardList.some((h) => isEcho(text, h));
        const repeatsSelf = ownList.some((h) => isEcho(text, h));
        if (repeatsSomeone || repeatsSelf) {
          const why = repeatsSelf ? '在重复你自己刚才说过的话' : '在复读别人的话';
          this.logger && this.logger.warn('回复' + why + '，重写一次：' + String(text).slice(0, 30));
          try {
            const retry = await this.llm.complete({
              system: decision.system + '\n\n【重写要求】你刚才的回答' + why + '，不合格。现在重写：换一个说法，给出新的信息或明确态度；不能出现对方原句，也不能重复你上面说过的话。',
              turns: decision.turns,
            });
            if (retry && !heardList.some((h) => isEcho(retry, h)) && !ownList.some((h) => isEcho(retry, h))) text = retry;
            else text = retry || text;
          } catch { /* 重写失败就沿用原文，后面还有兜底 */ }
        }
      }
    } catch (err) {
      const rawMsg = String((err && err.message) || '');
      const blocked = /敏感|不安全|安全|内容/.test(rawMsg) && /400/.test(rawMsg);
      this.logger && this.logger.error('生成回复失败：' + (err && err.message));
      let retried = null;
      // 钥匙失效 / 额度用完（429）/ 模型名不可用（404）→ 切到存过 Key 的备用服务商再试一次。
      // 千问的 qwen-turbo 免费额度经常先耗尽，用户会以为「Key 不能用」，这里直接兜住。
      const canFallback =
        /401|invalid|api key|Unauthorized|密钥|令牌/i.test(rawMsg) ||
        /\b429\b|rate.?limit|exceeded your current request limit/i.test(rawMsg) ||
        (/\b404\b/.test(rawMsg) && /model/i.test(rawMsg));
      if (canFallback && typeof this.llm.switchFallback === 'function') {
        const switched = this.llm.switchFallback();
        if (switched) {
          try {
            retried = await this.llm.complete({ system: decision.system, turns: decision.turns });
            this.logger && this.logger.warn(`已切到备用服务商 ${switched.label} 并重试成功`);
          } catch (err2) {
            this.logger && this.logger.error('备用服务商也失败了：' + (err2 && err2.message));
          }
        }
      }
      if (!retried && blocked) {
        try {
          const sys = sanitizeForModel(decision.system || '');
          const cur = sanitizeForModel((decision.msg && (decision.msg.cleanText || decision.msg.text)) || '');
          retried = await this.llm.complete({ system: sys, turns: cur ? [{ role: 'user', content: cur }] : [] });
          this.logger && this.logger.warn('内容审核拦截，已丢掉历史用精简上下文重试成功');
        } catch (err2) {
          this.logger && this.logger.error('精简重试仍失败：' + (err2 && err2.message));
        }
      }
      if (retried) {
        text = retried;
      } else {
        const friendly = blocked
          ? '这话我不敢接，换个说法'
          : (err instanceof LlmError ? err.userMessage : '呜…深海线路打结了，等会儿再来找人家嘛');
        this.finalize(decision, friendly, { error: true });
        return { action: 'reply', reply: friendly, bubbles: [friendly], reason: 'llm_error', error: true };
      }
    }
    text = String(text == null ? '' : text).trim();
    const bubbles = this.finalize(decision, text);
    if (!bubbles.length) return { action: 'ignore', reason: 'empty_reply' };
    // 她自己决定要不要引用：第一条以 [引用] 开头 → 引用并去掉标记
    let wantQuote = false;
    if (/^\s*[\[【(（]\s*引用\s*[\]】)）]/.test(String(bubbles[0] || ''))) {
      bubbles[0] = String(bubbles[0]).replace(/^\s*[\[【(（]\s*引用\s*[\]】)）]\s*/, '').trim();
      wantQuote = Boolean(bubbles[0]);
    }
    // 群里骂人时要真 @ 到对方：优先用靶子，其次看正文开头有没有 @名字
    let finalText = decision.finalText || text;
    if (wantQuote) finalText = String(finalText).replace(/^\s*[\[【(（]\s*引用\s*[\]】)）]\s*/, '').trim();
    const atMatch = finalText.match(/^@\s*([^\s，,：:！!？?。]+)/);
    const mention = (decision.msg && decision.msg.fightTarget && decision.msg.fightTarget.name)
      || (atMatch ? atMatch[1] : '');
    return {
      action: 'reply',
      reply: finalText,
      bubbles,
      quote: wantQuote,
      mention: decision.msg && decision.msg.chatType === 'group' ? mention : '',
      reason: decision.reason,
      mock: decision.mock,
    };
  }

  /** 切换 API Key 后调用 */
  reload() {
    if (this.llm && this.llm.reload) this.llm.reload();
  }

  stats() {
    return {
      ...this.store.summary(),
      mock: this.llm.isMock,
      model: this.llm.model,
      uptimeSec: Math.round((Date.now() - this.startedAt) / 1000),
    };
  }
}

module.exports = { Bot, extractCommand, COMMAND_HELP };
