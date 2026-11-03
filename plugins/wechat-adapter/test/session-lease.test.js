import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { withLease } from '../lib/session-lease.js';

test('lease serializes two local holders', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'whale-lease-'));
  const order = [];
  try {
    const first = withLease('k', async () => {
      order.push('first-start');
      await new Promise((r) => setTimeout(r, 80));
      order.push('first-end');
    }, { dir, waitMs: 2000 });
    const second = withLease('k', async () => {
      order.push('second-start');
      order.push('second-end');
    }, { dir, waitMs: 2000 });
    await Promise.all([first, second]);
    assert.deepEqual(order, ['first-start', 'first-end', 'second-start', 'second-end']);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }
});

test('lease takes over a stale lock', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'whale-lease-'));
  try {
    const lock = path.join(dir, 'leases');
    fs.mkdirSync(lock, { recursive: true });
    const files = [];
    // create any stale lock by invoking once then aging it is awkward; write a known file
    // through the public API first, then age all files.
    await withLease('k', async () => {}, { dir });
    // Find file only by listing; hash is private, so use a stale file discovered by listing.
    for (const n of fs.readdirSync(lock)) files.push(path.join(lock, n));
    assert.equal(files.length, 0, 'lease should be released');
    // Direct stale file with a 1ms ttl: create one by holding and letting ttl expire.
    const held = withLease('slow', async () => {
      await new Promise((r) => setTimeout(r, 150));
    }, { dir, ttlMs: 20, waitMs: 2000 });
    await new Promise((r) => setTimeout(r, 30));
    const t0 = Date.now();
    await withLease('slow', async () => {}, { dir, ttlMs: 20, waitMs: 2000 });
    assert.ok(Date.now() - t0 < 1000);
    await held;
  } finally {
    fs.rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }
});
