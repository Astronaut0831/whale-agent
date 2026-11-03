import test from 'node:test';
import assert from 'node:assert/strict';
import { chatIdOfScope, registerStickerTool } from '../index.js';

test('scope → chatId', () => {
  assert.equal(chatIdOfScope('wechat:u:wxid_master'), 'wxid_master');
  assert.equal(chatIdOfScope('wechat:g:g1@chatroom'), 'g1@chatroom');
});

test('send_sticker 调 adapter enqueue', async () => {
  const tools = [];
  const calls = [];
  const ok = registerStickerTool(
    { tools: { register: (t) => tools.push(t) } },
    {
      adapterUrl: 'http://adapter', token: 't', scope: 'wechat:u:wxid_master',
      fetchImpl: async (url, opts) => { calls.push({ url, body: JSON.parse(opts.body) }); return { ok: true, json: async () => ({ ok: true, job: { id: 'j1' } }) }; },
    },
  );
  assert.equal(ok, true);
  assert.equal(tools[0].name, 'send_sticker');
  const out = await tools[0].execute({ emotion: 'cute' });
  assert.equal(out.jobId, 'j1');
  assert.equal(calls[0].url, 'http://adapter/api/stickers/enqueue');
  assert.equal(calls[0].body.chatId, 'wxid_master');
  assert.equal(calls[0].body.emotion, 'cute');
});
