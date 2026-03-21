/**
 * 本地 SQLite 数据库：按供应商、按模型准确统计 token 使用量。
 * 每次 writer 发生 token 增量时写入一条记录，汇总按 vendor / (vendor, model_id) 查询。
 */

const Database = require('better-sqlite3');
const path = require('path');

const DEFAULT_DB_PATH = path.join(__dirname, 'token-usage.db');
let db = null;

/**
 * 从 model_id 解析供应商（第一段），如 "nvidia/qwen/xxx" -> "nvidia"
 * @param {string} modelId
 * @returns {string}
 */
function extractVendor(modelId) {
  if (!modelId || typeof modelId !== 'string') return 'unknown';
  const seg = modelId.trim().split('/').filter(Boolean)[0];
  return seg || 'unknown';
}

/**
 * 初始化数据库，创建表（若不存在）。仅写入项目目录，不写 ~/.openclaw。
 * @param {string} [dbPath]
 * @returns {import('better-sqlite3').Database}
 */
function init(dbPath) {
  const target = dbPath || DEFAULT_DB_PATH;
  if (db) return db;
  db = new Database(target);
  db.pragma('journal_mode = WAL');
  db.exec(`
    CREATE TABLE IF NOT EXISTS token_usage_log (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      vendor TEXT NOT NULL,
      model_id TEXT NOT NULL,
      tokens INTEGER NOT NULL,
      agent_id TEXT,
      session_id TEXT,
      recorded_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_token_log_vendor ON token_usage_log(vendor);
    CREATE INDEX IF NOT EXISTS idx_token_log_model ON token_usage_log(vendor, model_id);
    CREATE INDEX IF NOT EXISTS idx_token_log_recorded ON token_usage_log(recorded_at);
    CREATE TABLE IF NOT EXISTS token_import_baseline (
      vendor TEXT NOT NULL,
      model_id TEXT NOT NULL,
      tokens INTEGER NOT NULL,
      imported_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_baseline_vendor ON token_import_baseline(vendor);
    CREATE INDEX IF NOT EXISTS idx_baseline_model ON token_import_baseline(vendor, model_id);
  `);
  return db;
}

/**
 * 写入一条 token 使用记录（单次增量）。
 * @param {object} opts
 * @param {string} opts.vendor - 供应商，若未传则从 modelId 解析
 * @param {string} opts.modelId - 模型 ID
 * @param {number} opts.tokens - 本次 token 数（正整数）
 * @param {string} [opts.agentId]
 * @param {string} [opts.sessionId]
 */
function insertUsage(opts) {
  const { modelId, tokens, agentId = null, sessionId = null } = opts;
  const vendor = opts.vendor != null ? String(opts.vendor).trim() : extractVendor(modelId);
  const model = (modelId != null && String(modelId).trim()) ? String(modelId).trim() : 'unknown';
  const n = Math.max(0, Math.floor(Number(tokens)) || 0);
  if (n === 0) return;
  if (!db) init();
  const now = new Date().toISOString();
  const stmt = db.prepare(
    'INSERT INTO token_usage_log (vendor, model_id, tokens, agent_id, session_id, recorded_at) VALUES (?, ?, ?, ?, ?, ?)'
  );
  stmt.run(vendor, model, n, agentId || null, sessionId || null, now);
}

/**
 * 按供应商汇总：{ vendor, total }（含增量日志 + 导入基线）
 */
function getStatsByVendor() {
  if (!db) init();
  const rows = db.prepare(`
    SELECT vendor, SUM(tokens) AS total FROM (
      SELECT vendor, tokens FROM token_usage_log
      UNION ALL
      SELECT vendor, tokens FROM token_import_baseline
    ) GROUP BY vendor ORDER BY total DESC
  `).all();
  return rows.map((r) => ({ vendor: r.vendor, total: r.total || 0 }));
}

/**
 * 按供应商+模型汇总：{ vendor, modelId, total }（含增量日志 + 导入基线）
 */
function getStatsByVendorModel() {
  if (!db) init();
  const rows = db.prepare(`
    SELECT vendor, model_id AS modelId, SUM(tokens) AS total FROM (
      SELECT vendor, model_id, tokens FROM token_usage_log
      UNION ALL
      SELECT vendor, model_id, tokens FROM token_import_baseline
    ) GROUP BY vendor, model_id ORDER BY total DESC
  `).all();
  return rows.map((r) => ({ vendor: r.vendor, modelId: r.modelId, total: r.total || 0 }));
}

/**
 * 从 token-cumulative-state.json 导入已有 byModel 累计到基线表（覆盖原基线，不与增量重复计算）。
 * @param {string} [stateFilePath] - JSON 路径，默认项目目录下 token-cumulative-state.json
 * @returns {{ imported: number, models: number }}
 */
function importFromTokenCumulativeState(stateFilePath) {
  const path = require('path');
  const fs = require('fs');
  const target = stateFilePath || path.join(__dirname, 'token-cumulative-state.json');
  let raw;
  try {
    raw = fs.readFileSync(target, 'utf-8');
  } catch (e) {
    throw new Error('读取失败: ' + (e.message || target));
  }
  let data;
  try {
    data = JSON.parse(raw);
  } catch (e) {
    throw new Error('JSON 解析失败: ' + (e.message || ''));
  }
  const byModel = data && data.byModel && typeof data.byModel === 'object' ? data.byModel : {};
  if (!db) init();
  const now = new Date().toISOString();
  db.exec('DELETE FROM token_import_baseline');
  const insert = db.prepare(
    'INSERT INTO token_import_baseline (vendor, model_id, tokens, imported_at) VALUES (?, ?, ?, ?)'
  );
  let imported = 0;
  let models = 0;
  for (const [modelId, tokens] of Object.entries(byModel)) {
    const n = Math.max(0, Math.floor(Number(tokens)) || 0);
    if (n === 0) continue;
    const vendor = extractVendor(modelId);
    const model = (modelId && String(modelId).trim()) ? String(modelId).trim() : 'unknown';
    insert.run(vendor, model, n, now);
    imported += n;
    models += 1;
  }
  return { imported, models };
}

/**
 * 按 Agent 汇总 Token（来自增量日志 + 基线）
 * @returns {{ agentId: string, total: number }[]}
 */
function getStatsByAgent() {
  if (!db) init();
  const rows = db.prepare(`
    SELECT COALESCE(agent_id, 'unknown') AS agent_id,
           SUM(tokens) AS total
      FROM (
        SELECT vendor, model_id, tokens, agent_id, recorded_at FROM token_usage_log
        UNION ALL
        SELECT vendor, model_id, tokens, NULL AS agent_id, imported_at FROM token_import_baseline
      ) t
  GROUP BY COALESCE(agent_id, 'unknown')
  ORDER BY total DESC
  `).all();
  return rows.map(r => ({ agentId: r.agent_id, total: r.total || 0 }));
}

/**
 * 关闭数据库连接（进程退出时可选调用）
 */
function close() {
  if (db) {
    try { db.close(); } catch (_) {}
    db = null;
  }
}

module.exports = {
  init,
  insertUsage,
  getStatsByVendor,
  getStatsByVendorModel,
  getStatsByAgent,
  importFromTokenCumulativeState,
  extractVendor,
  close,
};
