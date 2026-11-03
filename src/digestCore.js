'use strict';

/** 旧 bot 的记忆摘要核心，从 server.js 原样抽出。 */

const { splitFacts } = require('./factSplit');
const { bestSpan } = require('./quoteSpan');

async function runDigestPass(runtime, { force = false } = {}) {
  // 同一时间只跑一轮摘要：并发调用会让模型偶发空返回
  if (runtime._digestBusy) return [];
  runtime._digestBusy = true;
  try {
  const done = [];
  if (!runtime || !runtime.llm || runtime.llm.isMock) return done;
  for (const key of runtime.store.sessionKeys()) {
    const sess = runtime.store.sessions.get(key);
    if (!sess) continue;
    const allMsgs = runtime.store.messages(key, 6000);
    if (allMsgs.length < 6) continue;

    // 触发参数全部来自 config.digest（不写死，方便按实测调）
    const dg = (runtime.config && runtime.config.digest) || {};
    const idleMinutes = Number(dg.idleMinutes) || 30;
    const minGapMinutes = Number(dg.minGapMinutes) || 10;
    const pendingMin = Number(dg.pendingMin) || 10;
    const pendingTokensCfg = Number(dg.pendingTokens) || 4000;
    const batchMessages = Number(dg.batchMessages) || 60;
    const batchTokens = Number(dg.batchTokens) || 8000;

    // 只处理"上次摘要之后"的新消息（没有游标时先取最近 120 条兜底）
    const cursor = Number(sess.digestUpTo || 0);
    const pending = cursor
      ? allMsgs.filter((m) => Number(m.ts || 0) > cursor)
      : allMsgs.slice(-120);
    if (!pending.length) continue;

    const estTokens = (list) => list.reduce((n, m) => n + Math.min(String(m.text || '').length, 400) / 1.5, 0);
    const pendingTokens = Math.round(estTokens(pending));
    const lastTs = Number((allMsgs[allMsgs.length - 1] || {}).ts) || 0;
    const idleMs = Date.now() - lastTs;

    let trigger = 'force';
    if (!force) {
      if (Date.now() - Number(sess.digestAt || 0) < minGapMinutes * 60000) continue;
      const byTokens = pendingTokens >= pendingTokensCfg;
      const byIdle = idleMs >= idleMinutes * 60000 && pending.length >= pendingMin;
      if (!byTokens && !byIdle) continue;
      trigger = byTokens ? 'token' : 'idle';
    }

    // 分段：超过单批上限就切段，避免截断丢历史
    const chunks = [];
    let cur = [];
    for (const m of pending) {
      if (cur.length && (cur.length >= batchMessages || estTokens([...cur, m]) > batchTokens)) {
        chunks.push(cur);
        cur = [];
      }
      cur.push(m);
    }
    if (cur.length) chunks.push(cur);

    const fmt = (list) => list
      .map((m) => `${m.role === 'assistant' ? '她' : (m.name || '群友')}：${String(m.text || '').slice(0, 400)}`)
      .join('\n');

    const SUMMARY_SYSTEM =
      '把这段聊天压成 4~6 条**长期要点**：每条只讲一件事，不要一条塞多件事，并给每条打重要性（1~10）。'
      + '只写值得以后记住的东西：人物（名字、身份、习惯、脾气）、关系、固定梗和约定、关键事件、群里在忙什么。'
      + '每条标注：about（user=关于对方/主人，her=关于你自己，relation=你与对方的关系，other=其他人）；'
      + 'msg=这条主要来自本段第几条消息（从 1 开始数）。'
      + '重要性：9~10=承诺/禁忌/关系定性；6~8=稳定偏好/人物设定/固定梗；3~5=一般事件；1~2=闲聊。'
      + '输出 JSON 数组，不要解释，形如 [{"fact":"氧化钙芼叔禁提棍木","importance":9,"about":"other","msg":3}]。每条 fact 不超过 40 字，一条只讲一件事。';

    const inferAbout = (fact) => {
      const f = String(fact || '');
      if (/互|关系|爱意|互道|约定|称/.test(f)) return 'relation';
      if (/她|本鲸|鲸|名字|迁移|人设|傲娇/.test(f)) return 'her';
      if (/主人|Astronaut|复旦|省一|竞赛|焦虑|熬夜|期中|绩点/.test(f)) return 'user';
      return 'other';
    };

    const parseFacts = (raw) => {
      const out = [];
      const text = String(raw || '').trim();
      const m = text.match(/\[[\s\S]*\]/);
      if (m) {
        try {
          const arr = JSON.parse(m[0]);
          for (const it of Array.isArray(arr) ? arr : []) {
            const fact = String((it && it.fact) || '').trim();
            if (fact.length < 4) continue;
            const imp = Number(it && it.importance);
            let about = ['user', 'her', 'relation', 'other'].includes(String(it && it.about)) ? String(it.about) : 'other';
            if (about === 'other') about = inferAbout(fact);
            const msg = Number(it && it.msg);
            const importance = Number.isFinite(imp) ? Math.max(0.05, Math.min(1, imp / 10)) : 0.5;
            // 一条只讲一件事：分号拆开，避免复合事实
            const parts = fact.split(/[；;]/).map((s) => s.trim()).filter((s) => s.length >= 4);
            for (const f of (parts.length > 1 ? parts.slice(0, 4) : [fact])) {
              out.push({ fact: f, importance, about: inferAbout(f) === 'other' ? about : (about === 'other' ? inferAbout(f) : about), msg: Number.isInteger(msg) && msg > 0 ? msg : 0 });
            }
          }
        } catch { /* 落到文本解析 */ }
      }
      if (!out.length) {
        for (const line of text.split('\n')) {
          const fact = line.replace(/^[-*·\s\d.、]+/, '').trim();
          if (fact.length >= 4) out.push({ fact, importance: 0.5, about: 'other', msg: 0 });
        }
      }
      return out;
    };

    const collected = [];
    for (let ci = 0; ci < chunks.length; ci += 1) {
      let ok = false;
      for (let attempt = 0; attempt < 2 && !ok; attempt += 1) {
        try {
          const reply = await runtime.llm.complete({
            system: SUMMARY_SYSTEM,
            turns: [{ role: 'user', content: fmt(chunks[ci]) }],
            maxTokens: attempt === 0 ? 4000 : 8000,
            skipGovernor: true,
          });
          const parsed = await splitFacts(runtime.llm, parseFacts(reply), {
            enabled: !(runtime.config.memory && runtime.config.memory.splitWithModel === false),
          });
          if (parsed.length) {
            const ids = chunks[ci].map((m) => String((m && m.msgId) || '')).filter(Boolean);
            const prov = {
              from: ids[0] || '',
              to: ids[ids.length - 1] || '',
              fromTs: Number((chunks[ci][0] || {}).ts) || 0,
              toTs: Number((chunks[ci][chunks[ci].length - 1] || {}).ts) || 0,
              count: chunks[ci].length,
              kind: 'digest',
              confidence: 0.7,
              speaker: '',
            };
            const quote = fmt(chunks[ci]).slice(0, 240);
            collected.push(...parsed.map((x) => ({ ...x, prov, quote, chunkRef: chunks[ci] })));
            ok = true;
          }
        } catch (err) {
          if (attempt === 1) {
            runtime.logger.warn('[记忆摘要] 第 ' + (ci + 1) + ' 段失败：' + (err && err.message) + '（code=' + ((err && err.code) || '-') + '）');
          }
          await new Promise((r) => setTimeout(r, 800));
        }
      }
    }

    if (!collected.length) {
      runtime.logger.warn('[记忆摘要] ' + key + ' 没抽到要点，游标不动，下轮再试');
      continue;
    }

    let lines = collected.map((x) => x.fact);
    let importances = collected.map((x) => x.importance);

    // 多段时再合并一次（map-reduce 的 reduce）
    if (chunks.length > 1) {
      try {
        const listing = collected.map((x, i) => `${i + 1}. ${x.fact}`).join('\n');
        const mergedReply = await runtime.llm.complete({
          system: '把下面多条要点合并成 4~6 条：去重、合并同义、保留最重要的信息，并给每条打重要性（1~10）。输出 JSON 数组 [{"fact":"…","importance":9}]，不要解释。',
          turns: [{ role: 'user', content: listing }],
          maxTokens: 4000,
          skipGovernor: true,
        });
        const mergedParsed = parseFacts(mergedReply);
        if (mergedParsed.length) {
          lines = mergedParsed.map((x) => x.fact);
          importances = mergedParsed.map((x) => x.importance);
        }
      } catch (err) {
        runtime.logger.warn('[记忆摘要] 合并段失败，直接用分段结果：' + (err && err.message));
      }
    }

    // 墓碑过滤：命中“别记”要求的要点直接丢
    try {
      const tb = require('./tombstones');
      const keep = lines.map((t, i) => ({ t, i })).filter((x) => !tb.hit(x.t, key));
      if (keep.length !== lines.length) {
        lines = keep.map((x) => x.t);
        importances = keep.map((x) => importances[x.i]);
      }
    } catch { /* ignore */ }
    lines = lines.slice(0, 6);
    importances = importances.slice(0, 6);
    if (!lines.length) continue;

    // 推进游标，避免重复摘要同一批内容
    sess.digestUpTo = Number((pending[pending.length - 1] || {}).ts) || Date.now();
    try { runtime.store.markDirty && runtime.store.markDirty(); } catch { /* ignore */ }

    runtime.logger.info(
      `[记忆摘要] ${key} 触发=${trigger} 待摘要=${pending.length}条/~${pendingTokens}tok 分${chunks.length}段 → ${lines.length}条`
    );
    // 旧的留 16 条 + 新的 6 条，去重后压到 24：记忆是累积的，不是覆盖的
    const merged = [...new Set([...runtime.store.digestOf(key).slice(-8), ...lines])].slice(-12);
    runtime.store.setDigest(key, merged);
    try {
      const narrative = require('./narrative');
      narrative.setDataDir(runtime.config.paths && runtime.config.paths.dataDir);
      const sessNow = runtime.store.sessions.get(key) || {};
      const firstMsg = pending[0] || {};
      const lastMsg = pending[pending.length - 1] || {};
      narrative.append({
        session: key,
        title: String(sessNow.title || (key.includes(':g:') ? '群聊' : '私聊')),
        chatType: key.includes(':g:') ? 'group' : 'private',
        from: Number(firstMsg.ts) || 0,
        to: Number(lastMsg.ts) || 0,
        count: pending.length,
        lines: merged,
      });
    } catch (e) { runtime.logger.warn && runtime.logger.warn('[叙事] 写入失败：' + (e && e.message)); }
    // 同时写进检索式记忆库：digest 只留最近，长期事实靠这里按需取
    try {
      const embedUrl = String((runtime.config.group && runtime.config.group.embedUrl) || '');
      const memMod = require('./memories');

      // 模型仲裁（同模型 + 事实核查员角色 + 证据 + 置信度门槛）
      try {
        const olds = memMod.listFacts(key).slice(-40);
        const minConf = Number((runtime.config.digest || {}).arbiterMinConfidence);
        const threshold = Number.isFinite(minConf) ? minConf : 0.6;
        if (olds.length >= 5) {
          const allMsgs = runtime.store.messages(key, 6000);
          const evidenceOf = (fact) => {
            const pr = fact.provenance || {};
            const from = Number(pr.fromTs) || 0;
            const to = Number(pr.toTs) || 0;
            if (!from || !to) return '';
            const hits = allMsgs
              .filter((m) => Number(m.ts) >= from && Number(m.ts) <= to && m.text)
              .slice(0, 2)
              .map((m) => String(m.text).slice(0, 60));
            return hits.length ? '（原话：' + hits.join(' / ') + '）' : '';
          };
          const oldList = olds.map((x, i) => (i + 1) + '. ' + String(x.text).slice(0, 60) + evidenceOf(x)).join('\n');
          const newList = lines.map((x) => '- ' + String(x).slice(0, 60)).join('\n');

          const system = [
            '你是事实核查员，不改写内容。任务：判断每条【旧事实】是否被【新事实】明确推翻或已经过时。',
            '要保守：只有新事实与旧事实指向同一对象时，才可能构成推翻；不确定就判 keep。',
            '逐条输出 JSON 数组，形如 [{"id":3,"verdict":"superseded","confidence":0.8,"reason":"不超过20字"}]。',
            '没有可推翻的就输出 []。不要解释，不要输出别的字。',
          ].join('');

          let verdictRaw = '';
          for (let attempt = 0; attempt < 3; attempt += 1) {
            try {
              verdictRaw = await runtime.llm.complete({
                system,
                turns: [{ role: 'user', content: '【旧事实】\n' + oldList + '\n\n【新事实】\n' + newList }],
                maxTokens: 4000,
                skipGovernor: true,
              });
            } catch (e) {
              if (attempt === 2) throw e;
              await new Promise((r) => setTimeout(r, 600 * (attempt + 1)));
              continue;
            }
            if (String(verdictRaw || '').trim()) break;
            await new Promise((r) => setTimeout(r, 600 * (attempt + 1)));
          }

          const m = String(verdictRaw || '').match(/\[[\s\S]*\]/);
          let applied = 0;
          let held = 0;
          let confSum = 0;
          let confN = 0;
          if (m) {
            const arr = JSON.parse(m[0]);
            for (const v of Array.isArray(arr) ? arr : []) {
              const idx = Number(v && v.id) - 1;
              const fact = olds[idx];
              if (!fact) continue;
              const conf = Number(v && v.confidence);
              confSum += Number.isFinite(conf) ? conf : 0;
              confN += 1;
              if ((v && v.verdict) !== 'superseded') continue;
              if (Number.isFinite(conf) && conf < threshold) {
                held += 1;
                runtime.logger.info('[记忆整理] 存疑（置信 ' + conf + ' < ' + threshold + '）：' + String(fact.text).slice(0, 30));
                continue;
              }
              const killed = memMod.markObsolete(key, [fact.text], '');
              applied += killed;
              if (killed) {
                try {
                  const reason = String((v && v.reason) || '').slice(0, 40);
                  require('node:fs').appendFileSync(
                    'data/memory-merge.log',
                    '[' + new Date().toISOString() + '] ' + key + ' 仲裁取代：' + String(fact.text).slice(0, 40) + ' ｜ ' + reason + '\n',
                    'utf8'
                  );
                } catch { /* ignore */ }
              }
            }
          }
          runtime.logger.info(
            '[记忆整理] 仲裁：候选 ' + olds.length + ' / 判过时 ' + applied + ' / 存疑 ' + held +
            ' / 平均置信度 ' + (confN ? (confSum / confN).toFixed(2) : '-') + ' / 门槛 ' + threshold
          );
        }
      } catch (e) {
        runtime.logger.warn && runtime.logger.warn('[记忆整理] 仲裁跳过：' + (e && e.message));
      }

      // 每条事实的来源区间（前面 collected 里带着 chunk 的 msgId/ts）
      const provenances = lines.map((_, i) => (collected[i] && collected[i].prov) || { kind: 'digest', confidence: 0.7 });
      const overlap = (a, b) => {
        const sa = String(a || '');
        const sb = String(b || '');
        let n = 0;
        for (let i = 0; i + 1 < sa.length; i += 1) if (sb.includes(sa.slice(i, i + 2))) n += 1;
        return n;
      };
      const evidences = lines.map((fact) => {
        let best = null;
        let bestScore = -1;
        for (const c of collected) {
          const s = overlap(fact, c.fact);
          if (s > bestScore) { bestScore = s; best = c; }
        }
        if (!best) return null;
        const p = best.prov || {};
        const idx = Number(best.msg) - 1;
        let src = best.chunkRef && idx >= 0 && idx < best.chunkRef.length ? best.chunkRef[idx] : null;
        if (!src && best.chunkRef) {
          let bm = null;
          let bs = -1;
          for (const m of best.chunkRef) {
            const s = overlap(fact, m && m.text);
            if (s > bs) { bs = s; bm = m; }
          }
          if (bm && bs > 0) src = bm;
        }
        const span = src ? bestSpan(fact, src.text) : null;
        return {
          quote: span ? span.text : String(best.quote || '').replace(/\n/g, ' ').slice(0, 240),
          quoteSpan: span ? { start: span.start, end: span.end } : null,
          msgIds: src ? [String(src.msgId || '')].filter(Boolean) : [p.from, p.to].filter(Boolean),
          confidence: Number(p.confidence),
          about: best.about || 'other',
        };
      });
      await memMod.addMany(key, lines, { embedUrl, source: '摘要', importances, provenances, evidences });
      // 记忆卫生：近似去重 + 过时条目限量保留
      const ded = memMod.dedupeSession(key);
      const pruned = memMod.pruneSuperseded(key, 50);
      if (ded.marked || pruned) runtime.logger.info('[记忆整理] 去重 ' + ded.marked + ' 条，清理过时 ' + pruned + ' 条');
    } catch (e) { runtime.logger.warn && runtime.logger.warn('[记忆库] 写入失败：' + (e && e.message)); }
    runtime.logger.info(`[记忆摘要] ${key} 更新 ${lines.length} 条`);
    // L4：让她对自己做一句观察（失败就算了，不重试不刷钱）
    try {
      const selfNote = require('./selfnote');
      const brief = pending.slice(-30).map((m) => (m.role === "assistant" ? "她：" : (m.name || "群友") + "：") + String(m.text || "").slice(0, 80)).join("\n");
      const sno = await runtime.llm.complete({
        system: '你在回看自己刚才的聊天。用一句不超过 30 字的话，写下你对自己表现的一个观察（语气、习惯、和人的关系都行）。只输出这句话，不要解释。没有值得写的就输出「无」。',
        turns: [{ role: "user", content: brief }],
        maxTokens: 1500,
        skipGovernor: true,
      });
      const t = String(sno || "").trim();
      if (t && t !== "无" && t.length >= 4) {
        selfNote.add(t, { source: "摘要" });
        runtime.logger.info("[自我认知] 新增：" + t.slice(0, 40));
      }
    } catch { /* 忽略 */ }
    done.push({ key, added: lines.length, digest: merged });
  }
  return done;
  } finally {
    runtime._digestBusy = false;
  }
}

module.exports = { runDigestPass };
