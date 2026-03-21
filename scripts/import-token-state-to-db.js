#!/usr/bin/env node
/**
 * 将 token-cumulative-state.json 中的 byModel 累计导入到本地 token 数据库（基线表）。
 * 可重复执行：每次会覆盖基线表后重新导入，不影响已写入的增量日志。
 * 用法：node scripts/import-token-state-to-db.js [可选: JSON 文件路径]
 */

const path = require('path');
const tokenDb = require('../token-db');

const stateFile = process.argv[2] || path.join(__dirname, '..', 'token-cumulative-state.json');

tokenDb.init();
try {
  const { imported, models } = tokenDb.importFromTokenCumulativeState(stateFile);
  console.log('导入完成:', stateFile);
  console.log('  模型数:', models, '  累计 token:', imported.toLocaleString());
} catch (e) {
  console.error('导入失败:', e.message || e);
  process.exit(1);
} finally {
  tokenDb.close();
}
