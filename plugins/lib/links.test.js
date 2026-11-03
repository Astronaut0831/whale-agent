import test from 'node:test';
import assert from 'node:assert/strict';
import { extractUrls, isPrivateHost, kindOf, formatForPrompt } from './links.js';

test('link helpers work outside legacy src', () => {
  const urls = extractUrls('看这个 https://example.com/a?b=1，还有 http://127.0.0.1:8787/x');
  assert.equal(urls.length, 2);
  assert.equal(urls[0], 'https://example.com/a?b=1');
  assert.equal(isPrivateHost('127.0.0.1'), true);
  assert.equal(isPrivateHost('example.com'), false);
  assert.equal(kindOf('https://www.bilibili.com/video/BV1xx'), 'video');
  assert.match(formatForPrompt({ ok: false, url: 'https://x', error: 'timeout' }), /打不开/);
});
