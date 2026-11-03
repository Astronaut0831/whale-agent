'use strict';

/**
 * 向量打包/解包（base64 Float32）
 * 存 JSON 时用字符串，比数字数组省 3~4 倍空间。
 * 格式和 memories.json 里一致：'b64:<base64>'
 */

const B64 = 'b64:';

function packVec(v) {
  if (!v || !v.length) return null;
  try {
    const arr = v instanceof Float32Array ? v : Float32Array.from(v);
    return B64 + Buffer.from(arr.buffer, arr.byteOffset, arr.byteLength).toString('base64');
  } catch {
    return null;
  }
}

function unpackVec(x) {
  if (!x) return null;
  if (x instanceof Float32Array) return x;
  if (Array.isArray(x)) return Float32Array.from(x);
  if (typeof x === 'string' && x.startsWith(B64)) {
    const buf = Buffer.from(x.slice(B64.length), 'base64');
    const copy = buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength);
    return new Float32Array(copy);
  }
  return null;
}

function cosine(a, b) {
  if (!a || !b || a.length !== b.length) return 0;
  let s = 0;
  for (let i = 0; i < a.length; i += 1) s += a[i] * b[i];
  return s;
}

module.exports = { packVec, unpackVec, cosine, B64 };
