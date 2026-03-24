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
      calls INTEGER DEFAULT 1,
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
      calls INTEGER DEFAULT 0,
      imported_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_baseline_vendor ON token_import_baseline(vendor);
    CREATE INDEX IF NOT EXISTS idx_baseline_model ON token_import_baseline(vendor, model_id);
  `);
  // 迁移：为已存在的表添加 calls 列（如果不存在）
  try {
    db.exec("ALTER TABLE token_usage_log ADD COLUMN calls INTEGER DEFAULT 1");
  } catch (_) {}
  try {
    db.exec("ALTER TABLE token_import_baseline ADD COLUMN calls INTEGER DEFAULT 0");
  } catch (_) {}
  return db;
}

/**
 * 写入一条 token 使用记录（单次增量）。
 * @param {object} opts
 * @param {string} opts.vendor - 供应商，若未传则从 modelId 解析
 * @param {string} opts.modelId - 模型 ID
 * @param {number} opts.tokens - 本次 token 数（正整数）
 * @param {number} [opts.calls] - 本次 API 调用次数（默认1）
 * @param {string} [opts.agentId]
 * @param {string} [opts.sessionId]
 */
function insertUsage(opts) {
  const { modelId, tokens, calls = 1, agentId = null, sessionId = null } = opts;
  const vendor = opts.vendor != null ? String(opts.vendor).trim() : extractVendor(modelId);
  const model = (modelId != null && String(modelId).trim()) ? String(modelId).trim() : 'unknown';
  const n = Math.max(0, Math.floor(Number(tokens)) || 0);
  const c = Math.max(0, Math.floor(Number(calls)) || 1);
  if (n === 0 && c === 0) return;
  if (!db) init();
  const now = new Date().toISOString();
  const stmt = db.prepare(
    'INSERT INTO token_usage_log (vendor, model_id, tokens, calls, agent_id, session_id, recorded_at) VALUES (?, ?, ?, ?, ?, ?, ?)'
  );
  try {
    stmt.run(vendor, model, n, c, agentId || null, sessionId || null, now);
  } catch (e) {
    console.warn('[writer] insertUsage 失败:', e.message || e);
  }
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
 * 按天聚合 Token 消耗和调用次数（仅来自增量日志，不含基线一次性导入）。
 * 返回结构：{ date, totalTokens, totalCalls, totalCost, byModel: [{ modelId, vendor, tokens, calls, cost }] }
 * @param {number} limitDays - 最近多少天
 */
function getStatsByDay(limitDays) {
  if (!db) init();
  const since = new Date();
  since.setDate(since.getDate() - limitDays);
  const sinceStr = since.toISOString().slice(0, 10); // 'YYYY-MM-DD'

  // 读取费用配置（通过父模块读取；这里直接读 JSON 文件）
  let costConfig = {};
  try {
    const fs = require('fs');
    const cfgPath = require('path').join(__dirname, 'model-pricing.json');
    const raw = fs.readFileSync(cfgPath, 'utf-8');
    const parsed = JSON.parse(raw);
    costConfig = parsed && parsed.models ? parsed.models : {};
  } catch (_) {}

  const rows = db.prepare(`
    SELECT recorded_at AS rec,
           vendor,
           model_id AS modelId,
           tokens,
           calls
      FROM token_usage_log
     WHERE recorded_at >= ?
  `).all(sinceStr);

  // 按天聚合
  const byDay = {};
  rows.forEach(({ rec, vendor, modelId, tokens, calls }) => {
    const date = rec.slice(0, 10); // 'YYYY-MM-DD'
    if (!byDay[date]) byDay[date] = {};
    if (!byDay[date][modelId]) byDay[date][modelId] = { vendor, tokens: 0, calls: 0, cost: 0 };
    byDay[date][modelId].tokens += tokens;
    byDay[date][modelId].calls += Math.max(0, calls || 1);
    const price = costConfig[modelId];
    if (price) byDay[date][modelId].cost += (tokens / 1e6) * ((price.blendedPerM != null ? price.blendedPerM : (price.inputPerM || 0)));
  });

  return Object.keys(byDay).sort().map((date) => {
    let totalTokens = 0, totalCalls = 0, totalCost = 0;
    const byModel = Object.entries(byDay[date]).map(([modelId, v]) => {
      totalTokens += v.tokens;
      totalCalls += v.calls;
      totalCost += v.cost;
      return { modelId, vendor: v.vendor, tokens: v.tokens, calls: v.calls, cost: parseFloat(v.cost.toFixed(6)) };
    });
    return { date, totalTokens, totalCalls, totalCost: parseFloat(totalCost.toFixed(6)), byModel };
  });
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
 * 按供应商+模型统计 API 调用次数（仅来自增量日志，不含基线）。
 * @returns {{ vendor: string, modelId: string, calls: number }[]}
 */
function getCallStatsByVendorModel() {
  if (!db) init();
  const rows = db.prepare(`
    SELECT vendor, model_id AS modelId, SUM(calls) AS calls
      FROM token_usage_log
     GROUP BY vendor, model_id
     ORDER BY calls DESC
  `).all();
  return rows.map(r => ({ vendor: r.vendor, modelId: r.modelId, calls: r.calls || 0 }));
}

/**
 * 按时间窗口统计 API 调用次数（仅来自增量日志，不含基线）。
 * @param {number} limitDays - 最近多少天
 * @param {number} windowHours - 时间窗口小时数（默认5）
 * @returns {{ date: string, windowStart: number, windowEnd: number, calls: number }[]}
 */
function getCallStatsByHourWindow(limitDays, windowHours = 5) {
  if (!db) init();
  const since = new Date();
  since.setDate(since.getDate() - limitDays);
  const sinceStr = since.toISOString().slice(0, 10);

  // 直接在 SQL 按 date 和 hour 聚合，JS 只做窗口分组
  const rows = db.prepare(`
    SELECT recorded_at, SUM(calls) AS calls
      FROM token_usage_log
     WHERE recorded_at >= ?
     GROUP BY DATE(recorded_at), STRFTIME('%H', recorded_at)
  `).all(sinceStr);

  const result = {};
  rows.forEach(({ recorded_at, calls }) => {
    const date = recorded_at.slice(0, 10); // ISO: "2026-03-24T14:06:03.828Z" -> "2026-03-24"
    const hour = parseInt(recorded_at.slice(11, 13), 10); // hour from position 11-13
    const windowStart = Math.floor(hour / windowHours) * windowHours;
    const windowEnd = windowStart + windowHours;
    const key = `${date}-${windowStart}`;
    if (!result[key]) {
      result[key] = { date, windowStart, windowEnd, calls: 0 };
    }
    result[key].calls += Math.max(0, calls || 1);
  });

  return Object.values(result).sort((a, b) => {
    if (a.date !== b.date) return a.date.localeCompare(b.date);
    return a.windowStart - b.windowStart;
  });
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
  getStatsByDay,
  getCallStatsByVendorModel,
  getCallStatsByHourWindow,
  importFromTokenCumulativeState,
  extractVendor,
  close,
};
