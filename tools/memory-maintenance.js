'use strict';

/** 旧 bot 的夜间巩固入口：机械合并 + 模型判重 + 遗忘 + 重放。 */

const memories = require('../src/memories');
const memoryConsolidate = require('../src/memoryConsolidate');

function createMaintenanceRuntime({ dataDir, llm, config = {}, logger } = {}) {
  memories.setDataDir(dataDir);
  return {
    llm,
    config: { ...config, paths: { ...(config.paths || {}), dataDir } },
    logger: logger || { info() {}, warn() {}, debug() {} },
  };
}

async function runConsolidation({ dataDir, llm, config, logger } = {}) {
  const runtime = createMaintenanceRuntime({ dataDir, llm, config, logger });
  return memoryConsolidate.runOnce(runtime);
}

module.exports = { createMaintenanceRuntime, runConsolidation };
