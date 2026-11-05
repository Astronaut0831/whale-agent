import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { apply } from '../index.js';

function listen(server) {
  return new Promise((resolve) => server.once('listening', () => resolve(server.address().port)));
}

async function setup(extra = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'whale-cmd-'));
  const cfgFile = path.join(dir, 'config.json');
  fs.writeFileSync(cfgFile, JSON.stringify({
    persona: { master: { wxids: ['wxid_master'] } },
    gateway: { wechat: { inboundToken: 't' } },
    wechat: { listen: { enabled: false, groups: [], privates: [] }, groupSettings: {} },
  }));
  const server = apply({ agents: {}, systemPrompt: { section: () => {} }, effect: () => {} }, {
    host: '127.0.0.1', port: 0, token: 't',
    whaleConfigPath: cfgFile,
    modeFile: path.join(dir, 'mode.json'),
    sessionsFile: path.join(dir, 'sessions.json'),
    logFile: path.join(dir, 'adapter.log'),
    personaFile: path.join(dir, 'persona.md'),
    outboxFile: path.join(dir, 'outbox.json'),
    groupHistoryFile: path.join(dir, 'group-history.jsonl'),
    groupStateFile: path.join(dir, 'group-state.json'),
    dataDir: dir,
    memoryUrl: 'http://127.0.0.1:1',
    ...extra,
  });
  const port = await listen(server);
  return { dir, cfgFile, server, base: 'http://127.0.0.1:' + port };
}

async function cmd(base, body) {
  const r = await fetch(base + '/webhook/wechat', {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-bot-token': 't' },
    body: JSON.stringify(body),
  });
  return { status: r.status, data: await r.json() };
}

test('/listen 已迁移到控制台', async () => {
  const { dir, server, base } = await setup();
  try {
    const r = await cmd(base, {
      chat_id: 'wxid_master', chat_type: 'private', msg_id: 'c1',
      sender_id: 'wxid_master', text: '/listen list',
    });
    assert.equal(r.status, 200);
    assert.match(r.data.bubbles[0], /控制台/);
  } finally {
    server.close();
    fs.rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }
});

test('/corpus on 写入 groupSettings', async () => {
  const { dir, cfgFile, server, base } = await setup();
  try {
    const r = await cmd(base, {
      chat_id: 'g1@chatroom', chat_type: 'group', msg_id: 'c2',
      sender_id: 'wxid_master', text: '/corpus on',
    });
    assert.equal(r.status, 200);
    assert.match(r.data.bubbles[0], /开了/);
    const cfg = JSON.parse(fs.readFileSync(cfgFile, 'utf8'));
    assert.equal(cfg.wechat.groupSettings['g1@chatroom'].collect, true);
  } finally {
    server.close();
    fs.rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }
});

test('/proactive on 写入群话题开关', async () => {
  const { dir, cfgFile, server, base } = await setup();
  try {
    const r = await cmd(base, {
      chat_id: 'wxid_master', chat_type: 'private', msg_id: 'c3',
      sender_id: 'wxid_master', text: '/proactive on',
    });
    assert.equal(r.status, 200);
    assert.match(r.data.bubbles[0], /开了/);
    const cfg = JSON.parse(fs.readFileSync(cfgFile, 'utf8'));
    assert.equal(cfg.proactive.group.enabled, true);
  } finally {
    server.close();
    fs.rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }
});

test('/remind 空列表', async () => {
  const { dir, server, base } = await setup();
  try {
    const r = await cmd(base, {
      chat_id: 'wxid_master', chat_type: 'private', msg_id: 'c4',
      sender_id: 'wxid_master', text: '/remind',
    });
    assert.equal(r.status, 200);
    assert.match(r.data.bubbles[0], /没有待提醒/);
  } finally {
    server.close();
    fs.rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }
});

test('/behavior 和 /pref list 可用', async () => {
  const { dir, server, base } = await setup();
  try {
    const b = await cmd(base, {
      chat_id: 'wxid_master', chat_type: 'private', msg_id: 'c6',
      sender_id: 'wxid_master', text: '/behavior',
    });
    assert.match(b.data.bubbles[0], /行为参数/);
    const p = await cmd(base, {
      chat_id: 'wxid_master', chat_type: 'private', msg_id: 'c7',
      sender_id: 'wxid_master', text: '/pref list',
    });
    assert.match(p.data.bubbles[0], /还没有规矩|规矩/);
  } finally {
    server.close();
    fs.rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }
});

test('/set bubbles 写入 config，/digest 可用，/ls 已移除', async () => {
  const { dir, cfgFile, server, base } = await setup();
  try {
    const s = await cmd(base, {
      chat_id: 'wxid_master', chat_type: 'private', msg_id: 'c8',
      sender_id: 'wxid_master', text: '/set bubbles 3',
    });
    assert.match(s.data.bubbles[0], /已设置/);
    const cfg = JSON.parse(fs.readFileSync(cfgFile, 'utf8'));
    assert.equal(cfg.chat.maxBubbles, 3);

    const d = await cmd(base, {
      chat_id: 'wxid_master', chat_type: 'private', msg_id: 'c9',
      sender_id: 'wxid_master', text: '/digest',
    });
    assert.match(d.data.bubbles[0], /摘要/);

    const l = await cmd(base, {
      chat_id: 'wxid_master', chat_type: 'private', msg_id: 'c10',
      sender_id: 'wxid_master', text: '/ls',
    });
    assert.match(l.data.bubbles[0], /已移除/);
  } finally {
    server.close();
    fs.rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }
});

test('/sendfile 与 /run 已移除', async () => {
  const { dir, server, base } = await setup();
  try {
    const f = await cmd(base, {
      chat_id: 'wxid_master', chat_type: 'private', msg_id: 'c11',
      sender_id: 'wxid_master', text: '/sendfile note.txt',
    });
    assert.match(f.data.bubbles[0], /已移除/);

    const run = await cmd(base, {
      chat_id: 'wxid_master', chat_type: 'private', msg_id: 'c12',
      sender_id: 'wxid_master', text: '/run --yes ok.js',
    });
    assert.match(run.data.bubbles[0], /已移除/);
  } finally {
    server.close();
    fs.rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }
});

test('/offline 关闭入站，/online 恢复', async () => {
  const { dir, server, base } = await setup();
  try {
    const off = await cmd(base, {
      chat_id: 'wxid_master', chat_type: 'private', msg_id: 'c14',
      sender_id: 'wxid_master', text: '/offline',
    });
    assert.match(off.data.bubbles[0], /下线/);

    const skipped = await cmd(base, {
      chat_id: 'wxid_master', chat_type: 'private', msg_id: 'c15',
      sender_id: 'wxid_master', text: '普通消息',
    });
    assert.equal(skipped.data.ignored, true);
    assert.equal(skipped.data.reason, 'offline');

    const on = await cmd(base, {
      chat_id: 'wxid_master', chat_type: 'private', msg_id: 'c16',
      sender_id: 'wxid_master', text: '/online',
    });
    assert.match(on.data.bubbles[0], /上线/);
  } finally {
    server.close();
    fs.rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }
});
