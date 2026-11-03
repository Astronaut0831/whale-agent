'use strict';

/**
 * 本地句向量客户端（bge-small-zh-v1.5，跑在 examples/embed_server.py）。
 *
 * 设计：
 * - 一次批量请求，单条消息只发一次 HTTP
 * - 失败/超时返回 null，调用方退回字符相似度，绝不影响聊天
 * - 带 LRU 缓存，同样的句子不重复算
 */

const http = require('node:http');

const URL_DEFAULT = 'http://127.0.0.1:8790/embed';
const cache = new Map();
const CACHE_MAX = 800;

function cacheGet(k) {
  return cache.get(k);
}

function cacheSet(k, v) {
  if (cache.size >= CACHE_MAX) {
    const first = cache.keys().next().value;
    if (first !== undefined) cache.delete(first);
  }
  cache.set(k, v);
}

function postJson(url, body, timeoutMs) {
  return new Promise((resolve, reject) => {
    const u = new URL(url);
    const data = Buffer.from(JSON.stringify(body), 'utf8');
    const req = http.request(
      {
        hostname: u.hostname,
        port: u.port || 80,
        path: u.pathname + u.search,
        method: 'POST',
        headers: { 'content-type': 'application/json', 'content-length': data.length },
      },
      (res) => {
        let raw = '';
        res.setEncoding('utf8');
        res.on('data', (c) => { raw += c; });
        res.on('end', () => {
          if (res.statusCode !== 200) return reject(new Error('HTTP ' + res.statusCode));
          try {
            resolve(JSON.parse(raw));
          } catch (e) {
            reject(new Error('bad json'));
          }
        });
      }
    );
    req.setTimeout(timeoutMs, () => req.destroy(new Error('timeout')));
    req.on('error', reject);
    req.write(data);
    req.end();
  });
}

/**
 * 批量取向量。返回与输入等长的数组，取不到的位置是 null。
 */
async function embedTexts(texts, { url = URL_DEFAULT, timeoutMs = 1500 } = {}) {
  const list = (texts || []).map((t) => String(t || '').slice(0, 400));
  const result = new Array(list.length).fill(null);
  const missing = [];
  const missingIdx = [];
  list.forEach((t, i) => {
    if (!t) return;
    const hit = cacheGet(t);
    if (hit) result[i] = hit;
    else {
      missing.push(t);
      missingIdx.push(i);
    }
  });
  if (!missing.length) return result;
  // 同一个 payload 里可能有重复句子，先去重
  const uniq = [...new Set(missing)];
  try {
    const resp = await postJson(url, { texts: uniq }, timeoutMs);
    const vectors = (resp && resp.vectors) || [];
    const byText = new Map();
    uniq.forEach((t, i) => { if (vectors[i]) byText.set(t, vectors[i]); });
    missing.forEach((t, i) => {
      const v = byText.get(t);
      if (v) {
        result[missingIdx[i]] = v;
        cacheSet(t, v);
      }
    });
    return result;
  } catch {
    return result; // 全 null，调用方回退
  }
}

function cosine(a, b) {
  if (!a || !b || a.length !== b.length) return 0;
  let s = 0;
  for (let i = 0; i < a.length; i += 1) s += a[i] * b[i];
  return s;
}

module.exports = { embedTexts, cosine };
