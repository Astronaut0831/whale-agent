// 给她 read_file / write_file / list_workspace（仅主人，限 workspace）
const fs = require('fs');
const p = 'D:/dsh-workspace/chat/whale_gril/src/bot.js';
let b = fs.readFileSync(p, 'utf8');

// 1) require
if (!b.includes("require('./workspace')")) {
  b = b.replace("const tools = require('./tools');", "const tools = require('./tools');\nconst workspace = require('./workspace');");
  console.log('require: OK');
}

// 2) TOOL_SPECS 追加
const anchor = '\n];\n\n/** 主人专用：可调的白名单字段';
const specs = `
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
];
`;

if (b.includes(anchor) && !b.includes("name: 'read_file'")) {
  b = b.replace(anchor, specs + '\n/** 主人专用：可调的白名单字段');
  console.log('TOOL_SPECS: OK');
} else {
  console.log('TOOL_SPECS: 已有或没匹配');
}

// 3) 执行分支
const handlerAnchor = "      return '没有这个工具';";
const handlers = `      if (name === 'read_file') {
        if (!isMaster) return '没有权限：只有主人能让我读文件。';
        const r = workspace.readFileText(String(args.path || ''));
        tools.audit({ who: 'master', tool: 'read_file', arg: String(args.path || ''), ok: true, out: r.name + ' ' + r.bytes + 'B' });
        return '【' + r.name + '】\\n' + String(r.text).slice(0, 3000);
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
` + handlerAnchor;

if (b.includes(handlerAnchor) && !b.includes("name === 'read_file'")) {
  b = b.replace(handlerAnchor, handlers);
  console.log('handlers: OK');
} else {
  console.log('handlers: 已有或没匹配');
}

fs.writeFileSync(p, b, 'utf8');
console.log('写入完成');
