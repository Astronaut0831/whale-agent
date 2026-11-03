# 旧 bot 记忆模块移植 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 把旧 bot 的完整记忆管线（digest、provenance、consolidation、reconsolidate、叙事、复习/重放/遗忘）移植为 DSH 侧可用的模块，替换启发式 `/observe` 直写。

**Architecture:** 抽出 `server.js` 里的 `runDigestPass` 为 `src/digestCore.js`，通过 `runtime` 接口读取消息/写 digest；DSH 侧用 `memory-episodes.jsonl` 构造同样的 runtime，由 memory server 定时跑 digest + consolidation；再巩固走 `/correct-auto`。

**Tech Stack:** Node 24 (`node:sqlite` 不需要)，CommonJS，现有 `src/memories.js`、`src/factSplit.js`、`src/quoteSpan.js`、`src/reconsolidate.js`、`src/memoryConsolidate.js`、`src/narrative.js`。

**Spec:** `docs/superpowers/specs/2026-11-02-unified-envelope-memory.md`

## Global Constraints

- 不改变旧 bot 的现有行为；新模块先旁路，验证后再切换。
- 所有新写入必须带 provenance（kind/confidence/from/to/fromTs/toTs/count）。
- 事实必须走 `splitFacts`、源句定位 `bestSpan`、模型仲裁、墓碑过滤。
- 测试必须可离线：LLM 用 fake `complete`，不发真实请求。
- 不在生产路径上跑启发式直写；`/observe` 只写 episodes。

## Review Focus

- 长会话分批：超过 `batchMessages/batchTokens` 时必须分段，不能截断。
- 模型空返回/JSON 解析失败：不能推进 cursor，下轮重试。
- 来源定位：每条事实要能回指到具体消息，不能只给整段 quote。
- 重复事实：consolidation 必须同时覆盖机械合并和模型合并。
- 纠正：主人说“不对/其实是”时必须先改记忆再回话。

---

### Task 1: 抽出 digest 核心

**Files:**
- Create: `src/digestCore.js`
- Test: `tests/digestCore.test.js`

**Interfaces:**
- Consumes: `runtime.llm.complete`, `runtime.store.sessionKeys()/sessions/messages/digestOf/setDigest`, `runtime.config.digest`, `runtime.logger`.
- Produces: `runDigestPass(runtime, { force }) -> [{ key, added, digest }]`.

- [ ] **Step 1: Write failing test** with fake runtime, 12 messages, fake LLM returning JSON facts; assert addMany called and cursor advanced.
- [ ] **Step 2: Run test, fail.**
- [ ] **Step 3: Copy `server.js` 286-660 into `src/digestCore.js`; add requires for `splitFacts`, `bestSpan`; fix `msgs` undefined to `pending`; export.**
- [ ] **Step 4: Run test, pass.**
- [ ] **Step 5: Commit.**

### Task 2: Episode runtime

**Files:**
- Create: `tools/episode-runtime.js`
- Test: `tools/episode-runtime.test.js`

**Interfaces:**
- Produces: `createEpisodeRuntime({ dataDir, llm, config, logger })` with store methods and `readEpisodes()`.

- [ ] **Step 1: Test** two episodes → `sessionKeys()` one, `messages()` four, digest state persists.
- [ ] **Step 2: Run fail.**
- [ ] **Step 3: Implement JSONL read + state file.**
- [ ] **Step 4: Pass.**
- [ ] **Step 5: Commit.**

### Task 3: LLM + memory server worker

**Files:**
- Create: `tools/memory-llm.js`
- Modify: `tools/memory-server.js`
- Test: `tools/memory-llm.test.js`

**Interfaces:**
- `createMemoryLlm(config)` → `{ complete({system,turns,maxTokens}) }` using DeepSeek chat completions.
- `/digest/run`, `/consolidate/run`, `/correct-auto` endpoints (token-protected).

- [ ] **Step 1: Test** fake fetch returns content; assert URL/body.
- [ ] **Step 2: Implement.**
- [ ] **Step 3: Add endpoints using episode runtime; `/observe` stops direct addMany.**
- [ ] **Step 4: Run memory-server tests.**
- [ ] **Step 5: Commit.**

### Task 4: Consolidation / review / replay

**Files:**
- Create: `tools/memory-maintenance.js`
- Test: `tools/memory-maintenance.test.js`

- [ ] **Step 1: Test** `runConsolidation(runtime)` calls `memories.consolidate`, `applyForgetting`, `salientForReplay`, `reinforce`.
- [ ] **Step 2: Implement by wrapping `src/memoryConsolidate.runOnce` with fake LLM runtime.**
- [ ] **Step 3: Add daily/interval scheduler in memory server.**
- [ ] **Step 4: Pass.**
- [ ] **Step 5: Commit.**

### Task 5: Reconsolidation for DSH

**Files:**
- Modify: `plugins/wechat-adapter/index.js`
- Modify: `tools/memory-server.js`
- Test: `tools/reconsolidate-endpoint.test.js`

- [ ] **Step 1: Test** POST `/correct-auto` with “不对，其实是…” calls autoCorrect and returns applied.
- [ ] **Step 2: Implement endpoint with memory llm.**
- [ ] **Step 3: Adapter active/headless before runTurn calls `/correct-auto` only for master private.**
- [ ] **Step 4: Pass.**
- [ ] **Step 5: Commit.**

### Task 6: Wire and verify

- [ ] **Step 1: Restart memory server with digest worker.**
- [ ] **Step 2: Run a headless conversation with a fact; force `/digest/run`; verify digest, narrative, memories provenance.**
- [ ] **Step 3: Run adapter + memory test suites.**
- [ ] **Step 4: Update runbook/spec.**
- [ ] **Step 5: Commit.**
