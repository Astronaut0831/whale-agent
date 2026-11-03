import test from 'node:test';
import assert from 'node:assert/strict';
import { fetchPopular, searchVideos, pickVideo, pickByKeyword, fetchComments } from './bilibili.js';
test('bilibili helpers are exported outside legacy src', () => {
  for (const f of [fetchPopular, searchVideos, pickVideo, pickByKeyword, fetchComments]) assert.equal(typeof f, 'function');
});
