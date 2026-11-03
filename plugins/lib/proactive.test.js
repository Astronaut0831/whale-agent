import test from 'node:test';
import assert from 'node:assert/strict';
import { setDataDir, listReminders, addReminder, dueReminders, cancelReminder } from './proactive.js';
import fs from 'node:fs'; import os from 'node:os'; import path from 'node:path';
test('proactive reminders work outside legacy src', () => {
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'whale-proactive-'));
  try { setDataDir(dir); const r=addReminder({chatId:'c',ownerId:'o',due:Date.now()+100000,what:'x'}); assert.ok(r.id); assert.ok(listReminders().length>=1); assert.equal(dueReminders().length,0); assert.ok(cancelReminder(r.id)); }
  finally { fs.rmSync(dir,{recursive:true,force:true}); }
});
