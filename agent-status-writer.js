/**
 * OpenClaw 全量 Agent 状态写入器
 * 数据源：openclaw status --json，自动发现并监控配置中的全部 Agent。
 */

const { execSync, exec, spawn } = require('child_process');
const fs = require('fs');
const path = require('path');
const os = require('os');
const http = require('http');
const https = require('https');
const url = require('url');

/** Gateway 直连探测超时（毫秒），当 status 报离线时用此探测修正 */
const GATEWAY_PROBE_TIMEOUT_MS = 3000;
/** 当 status 未提供 gateway.url 时使用的备用 URL（OpenClaw 默认端口 18789） */
const GATEWAY_FALLBACK_URL = process.env.OPENCLAW_MONITOR_GATEWAY_URL || 'http://127.0.0.1:18789';
const OUTPUT_FILE = path.join(__dirname, 'agent-status.json');

/** 将 ws/wss URL 转为 http/https，供 Control UI 链接使用（浏览器打开需 http） */
function toHttpUrl(anyUrl) {
  if (!anyUrl || typeof anyUrl !== 'string') return anyUrl;
  const s = anyUrl.trim();
  if (s.startsWith('ws://')) return 'http://' + s.slice(5);
  if (s.startsWith('wss://')) return 'https://' + s.slice(6);
  return s;
}
const COST_CONFIG_FILE = path.join(__dirname, 'model-pricing.json');

/**
 * 直连请求 gateway URL，用于在 status 报离线时做一次备用检测（避免插件/超时导致误报）
 * @param {string} gatewayUrl - 如 http://127.0.0.1:18789
 * @returns {Promise<boolean>}
 */
function probeGatewayUrl(gatewayUrl) {
  if (!gatewayUrl || typeof gatewayUrl !== 'string') return Promise.resolve(false);
  return new Promise((resolve) => {
    let parsed;
    try {
      parsed = url.parse(gatewayUrl);
    } catch (_) {
      resolve(false);
      return;
    }
    const protocol = parsed.protocol === 'https:' ? https : http;
    const pathToUse = parsed.pathname && parsed.pathname !== '/' ? parsed.pathname : '/';
    const opts = {
      hostname: parsed.hostname,
      port: parsed.port || (parsed.protocol === 'https:' ? 443 : 80),
      path: pathToUse,
      method: 'GET',
      timeout: GATEWAY_PROBE_TIMEOUT_MS,
    };
    const req = protocol.get(opts, (res) => {
      resolve(res.statusCode >= 200 && res.statusCode < 500);
      res.resume();
    });
    req.on('error', () => resolve(false));
    req.on('timeout', () => {
      req.destroy();
      resolve(false);
    });
    req.setTimeout(GATEWAY_PROBE_TIMEOUT_MS);
  });
}

/**
 * 通过 openclaw health --json 判断 Gateway 是否可达（该命令向运行中的 Gateway 请求健康快照）
 * 使用 spawn + 读完整 JSON 后 kill，避免插件导致进程不退出。
 * @returns {Promise<boolean>}
 */
function getGatewayReachableViaHealth() {
  return new Promise((resolve) => {
    const timeoutMs = Math.min(20000, Math.max(5000, GATEWAY_PROBE_TIMEOUT_MS * 2));
    let raw = '';
    let resolved = false;
    const child = spawn('openclaw', ['health', '--json'], {
      stdio: ['ignore', 'pipe', 'pipe'],
      shell: false,
      env: process.env,
    });
    const timer = setTimeout(() => {
      if (resolved) return;
      resolved = true;
      try {
        child.kill('SIGKILL');
      } catch (_) {}
      resolve(false);
    }, timeoutMs);
    function tryParse() {
      const start = raw.indexOf('{');
      if (start === -1) return;
      let depth = 0;
      let end = -1;
      for (let i = start; i < raw.length; i++) {
        if (raw[i] === '{') depth++;
        if (raw[i] === '}') {
          depth--;
          if (depth === 0) {
            end = i;
            break;
          }
        }
      }
      if (end === -1) return;
      try {
        JSON.parse(raw.slice(start, end + 1));
        if (resolved) return;
        resolved = true;
        clearTimeout(timer);
        try {
          child.kill('SIGKILL');
        } catch (_) {}
        resolve(true);
      } catch (_) {}
    }
    child.stdout.on('data', (chunk) => {
      raw += chunk.toString('utf-8');
      if (raw.length > 512 * 1024) raw = raw.slice(-256 * 1024);
      tryParse();
    });
    child.stderr.on('data', () => {});
    child.on('error', () => {
      if (!resolved) {
        resolved = true;
        clearTimeout(timer);
        resolve(false);
      }
    });
    child.on('close', () => {
      if (resolved) return;
      tryParse();
      if (!resolved) {
        resolved = true;
        clearTimeout(timer);
        resolve(false);
      }
    });
  });
}

/** 拉取 openclaw health --json，用于通道/聊天工具健康（per-channel probe summaries） */
const HEALTH_CMD_TIMEOUT_MS = 12000;
function getHealthJson() {
  return new Promise((resolve) => {
    let raw = '';
    let resolved = false;
    const child = spawn('openclaw', ['health', '--json'], {
      stdio: ['ignore', 'pipe', 'pipe'],
      shell: false,
      env: process.env,
    });
    const timer = setTimeout(() => {
      if (resolved) return;
      resolved = true;
      try {
        child.kill('SIGKILL');
      } catch (_) {}
      resolve(null);
    }, HEALTH_CMD_TIMEOUT_MS);
    function tryParse() {
      const start = raw.indexOf('{');
      if (start === -1) return;
      let depth = 0;
      let end = -1;
      for (let i = start; i < raw.length; i++) {
        if (raw[i] === '{') depth++;
        if (raw[i] === '}') {
          depth--;
          if (depth === 0) {
            end = i;
            break;
          }
        }
      }
      if (end === -1) return;
      try {
        const data = JSON.parse(raw.slice(start, end + 1));
        if (resolved) return;
        resolved = true;
        clearTimeout(timer);
        try {
          child.kill('SIGKILL');
        } catch (_) {}
        resolve(data);
      } catch (_) {}
    }
    child.stdout.on('data', (chunk) => {
      raw += chunk.toString('utf-8');
      if (raw.length > 512 * 1024) raw = raw.slice(-256 * 1024);
      tryParse();
    });
    child.stderr.on('data', () => {});
    child.on('error', () => {
      if (!resolved) {
        resolved = true;
        clearTimeout(timer);
        resolve(null);
      }
    });
    child.on('close', () => {
      if (resolved) return;
      tryParse();
      if (!resolved) {
        resolved = true;
        clearTimeout(timer);
        resolve(null);
      }
    });
  });
}

/** 拉取 openclaw models status --json，用于模型健康（可用性/鉴权） */
function getModelsStatusJson() {
  return new Promise((resolve) => {
    const timeoutMs = Math.max(COMMAND_TIMEOUT_MS, 10000);
    let raw = '';
    let resolved = false;
    const child = spawn('openclaw', ['models', 'status', '--json'], {
      stdio: ['ignore', 'pipe', 'pipe'],
      shell: false,
      env: process.env,
    });
    const timer = setTimeout(() => {
      if (resolved) return;
      resolved = true;
      try {
        child.kill('SIGKILL');
      } catch (_) {}
      resolve(null);
    }, timeoutMs);
    function tryParse() {
      const start = raw.indexOf('{');
      if (start === -1) return;
      let depth = 0;
      let end = -1;
      for (let i = start; i < raw.length; i++) {
        if (raw[i] === '{') depth++;
        if (raw[i] === '}') {
          depth--;
          if (depth === 0) {
            end = i;
            break;
          }
        }
      }
      if (end === -1) return;
      try {
        const data = JSON.parse(raw.slice(start, end + 1));
        if (resolved) return;
        resolved = true;
        clearTimeout(timer);
        try {
          child.kill('SIGKILL');
        } catch (_) {}
        resolve(data);
      } catch (_) {}
    }
    child.stdout.on('data', (chunk) => {
      raw += chunk.toString('utf-8');
      if (raw.length > 512 * 1024) raw = raw.slice(-256 * 1024);
      tryParse();
    });
    child.stderr.on('data', () => {});
    child.on('error', () => {
      if (!resolved) {
        resolved = true;
        clearTimeout(timer);
        resolve(null);
      }
    });
    child.on('close', () => {
      if (resolved) return;
      tryParse();
      if (!resolved) {
        resolved = true;
        clearTimeout(timer);
        resolve(null);
      }
    });
  });
}

/** 从 health JSON 中归一化出 channelHealth 数组（兼容多种字段名与嵌套结构） */
function normalizeChannelHealthFromHealth(healthJson) {
  if (!healthJson || typeof healthJson !== 'object') return [];
  let list = healthJson.channels || healthJson.channelProbes || healthJson.probes || healthJson.probeResults || [];
  if (!Array.isArray(list)) {
    if (healthJson.channelSummary && Array.isArray(healthJson.channelSummary)) {
      list = healthJson.channelSummary.map((ch) => (typeof ch === 'object' && ch != null) ? ch : { channel: ch, ok: true });
    } else {
      list = [];
    }
  }
  if (list.length === 0) {
    const keys = Object.keys(healthJson);
    for (const k of keys) {
      const v = healthJson[k];
      if (Array.isArray(v) && v.length > 0 && v[0] && typeof v[0] === 'object' && (v[0].channel != null || v[0].name != null || v[0].id != null || v[0].type != null)) {
        list = v;
        break;
      }
    }
  }
  return list.map((item) => {
    const channel = item.channel || item.name || item.id || item.type || item.channelType || 'unknown';
    const ok = item.ok === true || item.healthy === true || item.connected === true || item.status === 'ok' || item.success === true;
    const err = item.error || item.message || item.reason || (ok ? null : '探测失败');
    const channelKey = String(channel).toLowerCase();
    return { channel: channelKey, healthy: !!ok, error: err || null };
  });
}

/** 从 models status JSON 中归一化出 modelHealth 数组 */
function normalizeModelHealthFromModelsStatus(modelsJson) {
  if (!modelsJson || typeof modelsJson !== 'object') return [];
  const list = modelsJson.models || modelsJson.list || [];
  if (!Array.isArray(list)) {
    const defaultId = modelsJson.defaultModel || modelsJson.resolvedDefault;
    if (defaultId) {
      return [{ modelId: String(defaultId), available: true, error: null }];
    }
    return [];
  }
  return list.map((m) => {
    const id = m.id || m.modelId || m.model || '';
    const ok = m.available === true || m.healthy === true || (m.error == null && m.unavailable !== true);
    return { modelId: String(id), available: !!ok, error: m.error || m.message || null };
  });
}

/** Token 累计状态：按 Agent 记录上一会话 id/tokens，用于增量累加 */
const TOKEN_CUMULATIVE_STATE_FILE = path.join(__dirname, 'token-cumulative-state.json');
const OPENCLAW_DIR = process.env.OPENCLAW_DIR || path.join(os.homedir(), '.openclaw');

/** 从 OpenClaw 配置文件收集所有模型 ID（models.providers、agents.defaults.models、agents.list[].model） */
function getModelIdsFromOpenClawConfig() {
  const ids = new Set();
  const configPath = path.join(OPENCLAW_DIR, 'openclaw.json');
  const fallbackPath = path.join(OPENCLAW_DIR, 'clawdbot.json');
  let raw;
  try {
    raw = fs.readFileSync(configPath, 'utf-8');
  } catch (_) {
    try {
      raw = fs.readFileSync(fallbackPath, 'utf-8');
    } catch (__) {
      return [];
    }
  }
  let config;
  try {
    config = JSON.parse(raw);
  } catch (_) {
    return [];
  }
  const providers = config.models && config.models.providers;
  if (providers && typeof providers === 'object') {
    for (const [provName, prov] of Object.entries(providers)) {
      const list = prov.models;
      if (!Array.isArray(list)) continue;
      for (const m of list) {
        if (!m || !m.id) continue;
        const id = String(m.id).startsWith(provName + '/') ? m.id : provName + '/' + m.id;
        ids.add(id);
      }
    }
  }
  const agentDefaults = config.agents && config.agents.defaults;
  if (agentDefaults && agentDefaults.models && typeof agentDefaults.models === 'object') {
    for (const id of Object.keys(agentDefaults.models)) ids.add(id);
  }
  if (agentDefaults && agentDefaults.model && agentDefaults.model.primary) {
    ids.add(agentDefaults.model.primary);
  }
  const agentList = config.agents && config.agents.list;
  if (Array.isArray(agentList)) {
    for (const a of agentList) {
      if (a && a.model) ids.add(a.model);
    }
  }
  return Array.from(ids).sort();
}

/** 从 OpenClaw 配置读取每个 Agent 使用的模型 ID（agents.list[].model，缺省用 agents.defaults.model.primary） */
function getAgentModelFromOpenClawConfig() {
  const configPath = path.join(OPENCLAW_DIR, 'openclaw.json');
  const fallbackPath = path.join(OPENCLAW_DIR, 'clawdbot.json');
  let raw;
  try {
    raw = fs.readFileSync(configPath, 'utf-8');
  } catch (_) {
    try {
      raw = fs.readFileSync(fallbackPath, 'utf-8');
    } catch (__) {
      return {};
    }
  }
  let config;
  try {
    config = JSON.parse(raw);
  } catch (_) {
    return {};
  }
  const defaultModel = (config.agents && config.agents.defaults && config.agents.defaults.model && config.agents.defaults.model.primary)
    ? config.agents.defaults.model.primary
    : null;
  const out = {};
  const agentList = config.agents && config.agents.list;
  if (Array.isArray(agentList)) {
    for (const a of agentList) {
      if (a && a.id) out[a.id] = a.model || defaultModel || null;
    }
  }
  return out;
}

/** 从 OpenClaw 配置读取每个 Agent 绑定的通道（bindings[].agentId + match.channel），用于仪表盘展示对接的聊天工具 */
function getAgentChannelsFromConfig() {
  const configPath = path.join(OPENCLAW_DIR, 'openclaw.json');
  const fallbackPath = path.join(OPENCLAW_DIR, 'clawdbot.json');
  let raw;
  try {
    raw = fs.readFileSync(configPath, 'utf-8');
  } catch (_) {
    try {
      raw = fs.readFileSync(fallbackPath, 'utf-8');
    } catch (__) {
      return {};
    }
  }
  let config;
  try {
    config = JSON.parse(raw);
  } catch (_) {
    return {};
  }
  const out = {};
  const bindings = config.bindings;
  if (Array.isArray(bindings)) {
    for (const b of bindings) {
      if (!b || !b.agentId) continue;
      const ch = b.match && b.match.channel;
      if (ch && typeof ch === 'string') {
        if (!out[b.agentId]) out[b.agentId] = [];
        if (!out[b.agentId].includes(ch)) out[b.agentId].push(ch);
      }
    }
  }
  return out;
}

/** 从 OpenClaw 配置读取模型列表摘要（用于仪表盘「模型列表」：id、name、contextWindow、maxTokens、reasoning） */
function getModelsSummaryFromConfig() {
  const configPath = path.join(OPENCLAW_DIR, 'openclaw.json');
  const fallbackPath = path.join(OPENCLAW_DIR, 'clawdbot.json');
  let raw;
  try {
    raw = fs.readFileSync(configPath, 'utf-8');
  } catch (_) {
    try {
      raw = fs.readFileSync(fallbackPath, 'utf-8');
    } catch (__) {
      return [];
    }
  }
  let config;
  try {
    config = JSON.parse(raw);
  } catch (_) {
    return [];
  }
  const list = [];
  const providers = config.models && config.models.providers;
  if (providers && typeof providers === 'object') {
    for (const [provName, prov] of Object.entries(providers)) {
      const models = prov.models;
      if (!Array.isArray(models)) continue;
      for (const m of models) {
        if (!m || !m.id) continue;
        const id = String(m.id).startsWith(provName + '/') ? m.id : provName + '/' + m.id;
        list.push({
          id,
          name: m.name || m.id,
          provider: provName,
          contextWindow: m.contextWindow != null ? m.contextWindow : null,
          maxTokens: m.maxTokens != null ? m.maxTokens : null,
          reasoning: !!(m.reasoning),
        });
      }
    }
  }
  return list;
}

/** 从 OpenClaw 配置读取插件/技能摘要（plugins.entries + skills.entries，用于仪表盘「插件/技能」） */
function getPluginsSummaryFromConfig() {
  const configPath = path.join(OPENCLAW_DIR, 'openclaw.json');
  const fallbackPath = path.join(OPENCLAW_DIR, 'clawdbot.json');
  let raw;
  try {
    raw = fs.readFileSync(configPath, 'utf-8');
  } catch (_) {
    try {
      raw = fs.readFileSync(fallbackPath, 'utf-8');
    } catch (__) {
      return { plugins: { enabled: [], disabled: [] }, skills: { enabled: [], disabled: [] } };
    }
  }
  let config;
  try {
    config = JSON.parse(raw);
  } catch (_) {
    return { plugins: { enabled: [], disabled: [] }, skills: { enabled: [], disabled: [] } };
  }
  const pluginsEnabled = [];
  const pluginsDisabled = [];
  const pe = config.plugins && config.plugins.entries;
  if (pe && typeof pe === 'object') {
    for (const [id, ent] of Object.entries(pe)) {
      if (ent && ent.enabled) pluginsEnabled.push(id);
      else pluginsDisabled.push(id);
    }
  }
  const skillsEnabled = [];
  const skillsDisabled = [];
  const se = config.skills && config.skills.entries;
  if (se && typeof se === 'object') {
    for (const [id, ent] of Object.entries(se)) {
      if (ent && ent.enabled) skillsEnabled.push(id);
      else skillsDisabled.push(id);
    }
  }
  return { plugins: { enabled: pluginsEnabled, disabled: pluginsDisabled }, skills: { enabled: skillsEnabled, disabled: skillsDisabled } };
}

const DEFAULT_COST_CONFIG = {
  models: {
    'anthropic/claude-sonnet-4': { inputPerM: 3, outputPerM: 15 },
    'anthropic/claude-opus-4': { inputPerM: 15, outputPerM: 75 },
    'anthropic/claude-3-5-haiku': { inputPerM: 0.8, outputPerM: 4 },
    'openai/gpt-4o-mini': { inputPerM: 0.15, outputPerM: 0.6 },
    'openai/gpt-4o': { inputPerM: 2.5, outputPerM: 10 },
    'google/gemini-2.0-flash': { inputPerM: 0.1, outputPerM: 0.4 },
  },
};
const CHECK_INTERVAL_MS = parseInt(process.env.OPENCLAW_MONITOR_INTERVAL_MS || '5000', 10) || 5000;
const COMMAND_TIMEOUT_MS = parseInt(process.env.OPENCLAW_MONITOR_TIMEOUT_MS || '5000', 10) || 5000;
const ACTIVE_AGE_MS = 120000; // 2 分钟内有活动视为 thinking
const SESSION_CONTENT_PREVIEW_MAX = process.env.OPENCLAW_MONITOR_NO_CONTENT_PREVIEW === '1' ? 0 : 10; // 为 0 时不写入会话内容预览（避免敏感信息进同步文件）
const SESSION_JSONL_LAST_LINES = 50; // 每个会话读取最后 N 行
const PREVIEW_TEXT_LEN = 120; // 每条消息预览最大字符
const PREVIEW_MESSAGES = 4; // 每个会话保留最近几条消息预览
const REDACT_PATHS = process.env.OPENCLAW_MONITOR_REDACT_PATHS === '1'; // 为 1 时不输出本机绝对路径（workspaceDir、gateway.url 等）
const MEMORY_ENABLED = process.env.OPENCLAW_MONITOR_NO_MEMORY !== '1'; // 为 1 时关闭角色记忆拉取
const MEMORY_INTERVAL_MS = parseInt(process.env.OPENCLAW_MONITOR_MEMORY_INTERVAL_MS || '30000', 10) || 30000; // 角色记忆单独轮询间隔，默认 30s，避免阻塞主轮询
const MEMORY_LIMIT = Math.min(100, Math.max(5, parseInt(process.env.OPENCLAW_MONITOR_MEMORY_LIMIT || '30', 10) || 30)); // 每个 scope 最多拉取条数
const MEMORY_TEXT_LEN = 200; // 每条记忆预览最大字符，超出截断

// 按索引循环使用，支持任意数量 Agent
const COLOR_PALETTE = [
  'bg-violet-500',
  'bg-blue-500',
  'bg-emerald-500',
  'bg-amber-500',
  'bg-rose-500',
  'bg-cyan-500',
  'bg-orange-500',
  'bg-fuchsia-500',
  'bg-lime-500',
  'bg-sky-500',
];

function getColorForIndex(index) {
  return COLOR_PALETTE[index % COLOR_PALETTE.length];
}

/** 从 message.content 数组提取纯文本 */
function extractTextFromContent(content) {
  if (!Array.isArray(content)) return '';
  return content
    .filter((c) => c && c.type === 'text' && typeof c.text === 'string')
    .map((c) => c.text)
    .join(' ')
    .replace(/\s+/g, ' ')
    .trim();
}

const SESSION_JSONL_MAX_SIZE = 50 * 1024 * 1024; // 50MB，超过则跳过读取以保护性能

/** 进程内写入锁：避免 updateStatus 与 updateMemory 并发写 agent-status.json 导致数据损坏 */
let statusFileWriteInProgress = false;
function safeWriteStatusFile(data) {
  if (statusFileWriteInProgress) return false;
  statusFileWriteInProgress = true;
  try {
    fs.writeFileSync(OUTPUT_FILE, JSON.stringify(data, null, 2));
    return true;
  } finally {
    statusFileWriteInProgress = false;
  }
}

/** 读取会话 .jsonl 中真正的最后几条 user/assistant 文本消息（从文件末尾往前扫） */
function readSessionContentPreview(sessionDir, sessionId) {
  const jsonlPath = path.join(sessionDir, sessionId + '.jsonl');
  try {
    const stats = fs.statSync(jsonlPath);
    if (stats.size > SESSION_JSONL_MAX_SIZE) {
      return [{ role: 'system', text: '[日志文件过大，跳过预览以保护性能]' }];
    }
  } catch (e) {
    if (SESSION_CONTENT_PREVIEW_MAX > 0) console.warn('[writer] readSessionContentPreview stat:', e.message || e);
    return null;
  }
  let content;
  try {
    content = fs.readFileSync(jsonlPath, 'utf-8');
  } catch (e) {
    if (SESSION_CONTENT_PREVIEW_MAX > 0) console.warn('[writer] readSessionContentPreview readFile:', e.message || e);
    return null;
  }
  const lines = content.trim().split('\n').filter(Boolean);
  const lastLines = lines.slice(-SESSION_JSONL_LAST_LINES);
  const messages = [];
  // 从最后一行往前遍历，只收集 user/assistant 文本消息，满 PREVIEW_MESSAGES 条即止
  for (let i = lastLines.length - 1; i >= 0 && messages.length < PREVIEW_MESSAGES; i--) {
    try {
      const row = JSON.parse(lastLines[i]);
      if (row.type !== 'message' || !row.message) continue;
      const role = row.message.role;
      if (role !== 'user' && role !== 'assistant') continue;
      const text = extractTextFromContent(row.message.content);
      if (!text) continue;
      messages.push({
        role,
        text: text.length > PREVIEW_TEXT_LEN ? text.slice(0, PREVIEW_TEXT_LEN) + '…' : text,
      });
    } catch (e) {
      if (SESSION_CONTENT_PREVIEW_MAX > 0) console.warn('[writer] readSessionContentPreview parse line:', e.message || e);
    }
  }
  // 当前 messages 为 [最新, 次新, ...]，已是最新在前，直接返回
  return messages;
}

/** 采集本机系统信息：CPU、内存、磁盘、IP、网络 */
function getSystemInfo() {
  const info = {
    cpu: null,
    memory: null,
    disk: null,
    ip: null,
    network: null,
    platform: os.platform(),
  };
  try {
    const totalMem = os.totalmem();
    const freeMem = os.freemem();
    const usedPct = totalMem > 0 ? Math.round(((totalMem - freeMem) / totalMem) * 100) : null;
    info.memory = {
      usedPct,
      totalGb: (totalMem / (1024 ** 3)).toFixed(1),
      freeGb: (freeMem / (1024 ** 3)).toFixed(1),
    };
  } catch (e) {
    console.warn('[writer] getSystemInfo memory:', e.message || e);
  }
  try {
    const ifaces = os.networkInterfaces();
    for (const name of Object.keys(ifaces || {})) {
      for (const i of ifaces[name] || []) {
        if (i.family === 'IPv4' && !i.internal) {
          info.ip = i.address;
          break;
        }
      }
      if (info.ip) break;
    }
  } catch (e) {
    console.warn('[writer] getSystemInfo networkInterfaces:', e.message || e);
  }
  try {
    if (os.platform() === 'darwin') {
      const out = execSync('top -l 1 -n 0 2>/dev/null', { encoding: 'utf-8', maxBuffer: 8192, timeout: COMMAND_TIMEOUT_MS });
      const m = out.match(/([\d.]+)\s*%\s*idle/);
      if (m) info.cpu = Math.round(100 - parseFloat(m[1]));
    } else if (os.platform() === 'linux') {
      const out = execSync("top -b -n 1 2>/dev/null | grep '^%Cpu' || true", { encoding: 'utf-8', maxBuffer: 4096, timeout: COMMAND_TIMEOUT_MS });
      const m = out.match(/([\d.]+)\s*%\s*id(?:le)?\b|([\d.]+)\s+id\b/);
      if (m) info.cpu = Math.round(100 - parseFloat(m[1] || m[2]));
    }
    // top 失败时用 loadavg 估算 CPU（非实测值，仅作回退）
    if (info.cpu == null && os.loadavg()[0] != null) {
      const load = os.loadavg()[0];
      const cpus = os.cpus().length;
      info.cpu = Math.min(100, Math.round((load / Math.max(1, cpus)) * 100));
    }
  } catch (e) {
    console.warn('[writer] getSystemInfo cpu/top:', e.message || e);
  }
  try {
    const out = execSync('df -P . 2>/dev/null || df -P / 2>/dev/null', { encoding: 'utf-8', maxBuffer: 4096, timeout: COMMAND_TIMEOUT_MS });
    const lines = out.trim().split('\n').filter(Boolean);
    const dataLine = lines[lines.length - 1]; // 最后一行是当前目录/根分区数据
    const pct = dataLine.match(/(\d+)%/); // Capacity 列如 "22%" 或 "69% /"，不要求行尾
    if (pct) info.disk = parseInt(pct[1], 10);
  } catch (e) {
    console.warn('[writer] getSystemInfo df:', e.message || e);
  }
  try {
    if (info.ip) {
      // ⚠️ 硬编码命令，切勿从环境变量或外部输入构建命令以防止命令注入
      const pingCmd = os.platform() === 'darwin' ? 'ping -c 1 -t 2 8.8.8.8 2>/dev/null' : 'ping -c 1 -W 2 8.8.8.8 2>/dev/null';
      execSync(pingCmd, { encoding: 'utf-8', timeout: COMMAND_TIMEOUT_MS });
      info.network = '在线';
    } else {
      info.network = '无外网 IP';
    }
  } catch (e) {
    if (info.ip) console.warn('[writer] getSystemInfo ping:', e.message || e);
    info.network = info.ip ? '离线' : '--';
  }
  return info;
}

/**
 * 拉取 openclaw status --json。使用 spawn + 流式读取，读到完整 JSON 后立即 kill 子进程，
 * 避免在安装插件（如 openclaw-self-healing）后 CLI 加载插件导致进程不退出、execSync 超时无数据。
 * @see https://github.com/openclaw/openclaw/issues/11843
 */
function getStatusJson() {
  return new Promise((resolve) => {
    const timeoutMs = Math.max(COMMAND_TIMEOUT_MS, 15000);
    let raw = '';
    let resolved = false;
    const child = spawn('openclaw', ['status', '--json'], {
      stdio: ['ignore', 'pipe', 'pipe'],
      shell: false,
      env: process.env,
    });
    const timer = setTimeout(() => {
      if (resolved) return;
      resolved = true;
      try {
        child.kill('SIGKILL');
      } catch (_) {}
      console.warn('[writer] getStatusJson: 超时', timeoutMs, 'ms');
      resolve(null);
    }, timeoutMs);
    function tryParse() {
      const start = raw.indexOf('{');
      if (start === -1) return;
      let depth = 0;
      let end = -1;
      for (let i = start; i < raw.length; i++) {
        if (raw[i] === '{') depth++;
        if (raw[i] === '}') {
          depth--;
          if (depth === 0) {
            end = i;
            break;
          }
        }
      }
      if (end === -1) return;
      try {
        const data = JSON.parse(raw.slice(start, end + 1));
        if (resolved) return;
        resolved = true;
        clearTimeout(timer);
        try {
          child.kill('SIGKILL');
        } catch (_) {}
        resolve(data);
      } catch (_) {}
    }
    child.stdout.on('data', (chunk) => {
      raw += chunk.toString('utf-8');
      if (raw.length > 2 * 1024 * 1024) {
        raw = raw.slice(-1024 * 1024);
      }
      tryParse();
    });
    child.stderr.on('data', () => {});
    child.on('error', (e) => {
      if (resolved) return;
      resolved = true;
      clearTimeout(timer);
      console.warn('[writer] getStatusJson:', e.message || e);
      resolve(null);
    });
    child.on('close', () => {
      if (resolved) return;
      tryParse();
      if (!resolved) {
        resolved = true;
        clearTimeout(timer);
        resolve(null);
      }
    });
  });
}

/** 解析 memory-pro list 的 stdout 为条目数组（首行可能是 [plugins]...，需从换行后的 [ 开始） */
const MEMORY_DEBUG = process.env.OPENCLAW_MONITOR_MEMORY_DEBUG === '1';
/** scope 最大长度，防止超长输入导致 DoS；与 GET /memory?scope= 校验一致 */
const MEMORY_SCOPE_MAX_LENGTH = 128;
const MEMORY_JSON_MAX_LENGTH = 1024 * 1024; // 1MB，与 exec maxBuffer 配合，防止过大 JSON 解析
const MEMORY_JSON_MAX_DEPTH = 100; // 最大嵌套深度，防止恶意深层 JSON 导致堆栈溢出

/** 粗略扫描 JSON 片段的最大括号嵌套深度（不解析字符串内容，仅统计 [ { ] }） */
function getJsonSliceMaxDepth(slice) {
  let depth = 0;
  let maxDepth = 0;
  let inString = false;
  let escape = false;
  let quote = '';
  for (let i = 0; i < slice.length; i++) {
    const c = slice[i];
    if (escape) {
      escape = false;
      continue;
    }
    if (inString) {
      if (c === '\\') escape = true;
      else if (c === quote) inString = false;
      continue;
    }
    if (c === '"' || c === "'") {
      inString = true;
      quote = c;
      continue;
    }
    if (c === '[' || c === '{') {
      depth++;
      if (depth > maxDepth) maxDepth = depth;
      continue;
    }
    if (c === ']' || c === '}') depth--;
  }
  return maxDepth;
}

function parseMemoryListOutput(raw, scopeForLog) {
  const lineStart = raw.indexOf('\n[');
  const start = lineStart >= 0 ? lineStart + 1 : raw.indexOf('[');
  if (start === -1) {
    if (MEMORY_DEBUG) console.log('[writer] memory parse', scopeForLog, 'rawLen=', raw.length, 'no [ found, head=', raw.slice(0, 120));
    return [];
  }
  const end = raw.lastIndexOf(']');
  if (end === -1 || end < start) {
    if (MEMORY_DEBUG) console.log('[writer] memory parse', scopeForLog, 'start=', start, 'end=', end, 'rawLen=', raw.length);
    return [];
  }
  try {
    const slice = raw.slice(start, end + 1);
    if (slice.length > MEMORY_JSON_MAX_LENGTH) {
      if (MEMORY_DEBUG) console.log('[writer] memory parse', scopeForLog, 'slice too long', slice.length);
      return [];
    }
    if (getJsonSliceMaxDepth(slice) > MEMORY_JSON_MAX_DEPTH) {
      if (MEMORY_DEBUG) console.log('[writer] memory parse', scopeForLog, 'max depth exceeded');
      return [];
    }
    const arr = JSON.parse(slice);
    if (!Array.isArray(arr)) {
      if (MEMORY_DEBUG) console.log('[writer] memory parse', scopeForLog, 'not array');
      return [];
    }
    const out = arr.map((entry) => ({
      id: entry.id || null,
      text: typeof entry.text === 'string'
        ? (entry.text.length > MEMORY_TEXT_LEN ? entry.text.slice(0, MEMORY_TEXT_LEN) + '…' : entry.text)
        : '',
      category: entry.category || null,
      importance: entry.importance != null ? entry.importance : null,
      timestamp: entry.timestamp != null ? entry.timestamp : null,
    })).filter((e) => e.text);
    if (MEMORY_DEBUG) console.log('[writer] memory parse', scopeForLog, 'rawArrLen=', arr.length, 'afterFilter=', out.length);
    return out;
  } catch (e) {
    if (MEMORY_DEBUG) console.warn('[writer] memory parse', scopeForLog, 'JSON error', e.message, 'sliceHead=', raw.slice(start, start + 150));
    return [];
  }
}

/** 异步拉取某 scope 的记忆（不阻塞主轮询） */
function getMemoryForScopeAsync(scope) {
  return new Promise((resolve) => {
    exec(
      `openclaw memory-pro list --scope "${scope}" --json --limit ${MEMORY_LIMIT} 2>/dev/null`,
      { encoding: 'utf-8', maxBuffer: 2 * 1024 * 1024, timeout: COMMAND_TIMEOUT_MS, env: process.env },
      (err, stdout) => {
        if (err) {
          console.warn('[writer] memory', scope, 'exec err', err.message || err);
          resolve([]);
          return;
        }
        const raw = stdout || '';
        if (MEMORY_DEBUG || raw.length < 10) console.log('[writer] memory', scope, 'stdoutLen=', raw.length, 'head=', raw.slice(0, 100));
        const entries = parseMemoryListOutput(raw, scope);
        console.log('[writer] memory', scope, '->', entries.length, '条');
        resolve(entries);
      }
    );
  });
}

async function updateStatus() {
  const status = await getStatusJson();
  if (!status) {
    // 【修复 #2】命令失败时，标记错误但不覆盖旧数据
    console.error('[writer] openclaw status 执行失败，标记错误状态');
    try {
      const prev = JSON.parse(fs.readFileSync(OUTPUT_FILE, 'utf-8'));
      prev.lastUpdated = new Date().toISOString();
      prev.gateway = prev.gateway || {};
      prev.gateway.reachable = false;
      prev.gateway.error = 'openclaw status 执行失败';
      prev.system = getSystemInfo();
      prev.error = { message: 'Gateway status fetch failed', time: new Date().toISOString() };
      // 原子写入
      const tempFile = OUTPUT_FILE + '.tmp';
      fs.writeFileSync(tempFile, JSON.stringify(prev, null, 2));
      fs.renameSync(tempFile, OUTPUT_FILE);
    } catch (e) {
      console.warn('[writer] updateStatus read/write prev on status fail:', e.message || e);
    }
    return;
  }

  const byAgent = (status.sessions && status.sessions.byAgent) ? status.sessions.byAgent : [];
  const agentsList = (status.agents && status.agents.agents) ? status.agents.agents : [];
  const heartbeatAgents = (status.heartbeat && status.heartbeat.agents) ? status.heartbeat.agents : [];
  const agentModelFromConfig = getAgentModelFromOpenClawConfig();
  const agentChannelsFromConfig = getAgentChannelsFromConfig();

  const agents = agentsList.map((a, index) => {
    const lastActiveAgeMs = a.lastActiveAgeMs != null ? a.lastActiveAgeMs : null;
    const isActive = lastActiveAgeMs != null && lastActiveAgeMs < ACTIVE_AGE_MS;
    const sessionInfo = byAgent.find((b) => b.agentId === a.id);
    const recent = (sessionInfo && sessionInfo.recent && sessionInfo.recent[0]) ? sessionInfo.recent[0] : null;
    const hb = heartbeatAgents.find((h) => h.agentId === a.id);
    const statusStr = isActive ? 'thinking' : 'idle';
    let message = isActive
      ? `活动中 (${(lastActiveAgeMs / 1000).toFixed(0)}s 前)`
      : (a.sessionsCount > 0 ? `${a.sessionsCount} 会话` : '等待中...');
    if (recent && recent.percentUsed != null) {
      message += ` · 上下文 ${recent.percentUsed}%`;
    }
    const modelId = agentModelFromConfig[a.id] != null ? agentModelFromConfig[a.id] : (a.model || null);
    const boundChannels = Array.isArray(agentChannelsFromConfig[a.id]) ? agentChannelsFromConfig[a.id] : [];
    return {
      id: a.id,
      name: a.name || a.id,
      color: getColorForIndex(index),
      status: statusStr,
      message,
      model: modelId,
      boundChannels,
      lastActive: a.lastUpdatedAt ? new Date(a.lastUpdatedAt).toISOString() : null,
      sessionCount: a.sessionsCount ?? 0,
      totalTokens: recent && recent.totalTokens != null ? recent.totalTokens : null,
      percentUsed: recent && recent.percentUsed != null ? recent.percentUsed : null,
      lastSessionId: recent ? recent.sessionId : null,
      heartbeat: hb ? (hb.enabled ? hb.every : 'off') : 'off',
      workspaceDir: REDACT_PATHS ? null : (a.workspaceDir || null),
    };
  });

  let prevData = null;
  try {
    prevData = JSON.parse(fs.readFileSync(OUTPUT_FILE, 'utf-8'));
  } catch (_) {}
  if (MEMORY_ENABLED) {
    agents.forEach((a, i) => {
      a.memoryEntries = (prevData && Array.isArray(prevData.agents) && prevData.agents[i] && Array.isArray(prevData.agents[i].memoryEntries))
        ? prevData.agents[i].memoryEntries
        : [];
    });
  }

  // Token 累计：根据当前各 Agent 最近会话的 sessionId/totalTokens 做增量累加并持久化；同时按模型（modelId）累计
  let tokenState = { byAgent: {}, byModel: {} };
  try {
    const raw = fs.readFileSync(TOKEN_CUMULATIVE_STATE_FILE, 'utf-8');
    const parsed = JSON.parse(raw);
    if (parsed && typeof parsed.byAgent === 'object') tokenState.byAgent = parsed.byAgent;
    if (parsed && typeof parsed.byModel === 'object') tokenState.byModel = parsed.byModel;
  } catch (_) {}
  const cumulativeByAgent = {};
  let tokenCumulativeGlobal = 0;
  agents.forEach((a) => {
    const sessionId = a.lastSessionId || null;
    const totalTokens = a.totalTokens != null ? Number(a.totalTokens) : 0;
    const modelId = (a.model && typeof a.model === 'string' ? a.model.trim() : '') || 'unknown';
    let rec = tokenState.byAgent[a.id];
    if (!rec) rec = { cumulativeTokens: 0, lastSessionId: null, lastTotalTokens: 0, lastModelId: null };
    if (rec.lastModelId == null) rec.lastModelId = null;
    if (sessionId != null && totalTokens >= 0) {
      if (rec.lastSessionId === sessionId) {
        const delta = totalTokens - rec.lastTotalTokens;
        if (delta > 0) {
          rec.cumulativeTokens += delta;
          tokenState.byModel[modelId] = (tokenState.byModel[modelId] || 0) + delta;
        }
        rec.lastTotalTokens = totalTokens;
      } else {
        if (rec.lastSessionId != null) {
          rec.cumulativeTokens += rec.lastTotalTokens;
          const lastModel = rec.lastModelId || 'unknown';
          tokenState.byModel[lastModel] = (tokenState.byModel[lastModel] || 0) + rec.lastTotalTokens;
        }
        rec.lastSessionId = sessionId;
        rec.lastTotalTokens = totalTokens;
        rec.lastModelId = modelId;
      }
    }
    tokenState.byAgent[a.id] = rec;
    cumulativeByAgent[a.id] = rec.cumulativeTokens;
    tokenCumulativeGlobal += rec.cumulativeTokens;
  });
  try {
    fs.writeFileSync(TOKEN_CUMULATIVE_STATE_FILE, JSON.stringify(tokenState, null, 2), 'utf-8');
  } catch (e) {
    console.warn('[writer] token-cumulative-state 写入失败:', e.message || e);
  }
  // 为每个 agent 挂上累计值，供仪表盘展示
  agents.forEach((a) => {
    a.cumulativeTokens = cumulativeByAgent[a.id] != null ? cumulativeByAgent[a.id] : null;
  });

  // 按模型（modelId）汇总当前与累计 Token：当前 = 各 Agent 当前会话归属到其当前模型；累计 = 按会话归属到当时使用的模型
  const tokenByModelMap = {};
  agents.forEach((a) => {
    const modelId = (a.model && typeof a.model === 'string' ? a.model.trim() : '') || 'unknown';
    if (!tokenByModelMap[modelId]) tokenByModelMap[modelId] = { modelId, current: 0, cumulative: tokenState.byModel[modelId] || 0 };
    const cur = a.totalTokens != null ? Number(a.totalTokens) : 0;
    tokenByModelMap[modelId].current += cur;
  });
  // 确保所有在 byModel 里出现过的模型都有行（即使当前没有 agent 在用）
  Object.keys(tokenState.byModel || {}).forEach((mid) => {
    if (!tokenByModelMap[mid]) tokenByModelMap[mid] = { modelId: mid, current: 0, cumulative: tokenState.byModel[mid] };
  });
  const tokenByModel = Object.values(tokenByModelMap).sort((a, b) => (b.cumulative || 0) - (a.cumulative || 0));

  let gateway = status.gateway
    ? {
        reachable: !!status.gateway.reachable,
        url: REDACT_PATHS ? null : (status.gateway.url || null),
        latencyMs: status.gateway.connectLatencyMs ?? null,
        version: status.gateway.self && status.gateway.self.version ? status.gateway.self.version : null,
        host: REDACT_PATHS ? null : (status.gateway.self && status.gateway.self.host ? status.gateway.self.host : null),
        ip: REDACT_PATHS ? null : (status.gateway.self && status.gateway.self.ip ? status.gateway.self.ip : null),
        error: status.gateway.error || null,
      }
    : { reachable: false, error: '无 gateway 数据' };

  // 当 status 报离线时，用直连 URL 探测和 openclaw health --json 做备用判定
  if (!gateway.reachable) {
    const urlToProbe = gateway.url || GATEWAY_FALLBACK_URL;
    let probeOk = await probeGatewayUrl(urlToProbe);
    if (!probeOk) {
      try {
        const parsed = url.parse(urlToProbe);
        const base = (parsed.protocol || 'http:') + '//' + (parsed.hostname || '127.0.0.1') + ':' + (parsed.port || (parsed.protocol === 'https:' ? 443 : 18789));
        probeOk = await probeGatewayUrl(base + '/health');
      } catch (_) {}
    }
    if (!probeOk) {
      probeOk = await getGatewayReachableViaHealth();
    }
    if (probeOk) {
      gateway = { ...gateway, reachable: true, error: null };
      console.log('[writer] gateway 状态已由直连/health 探测修正为在线');
    }
  }

  let channelHealth = [];
  let modelHealth = [];
  if (gateway.reachable) {
    const [healthJson, modelsJson] = await Promise.all([getHealthJson(), getModelsStatusJson()]);
    channelHealth = normalizeChannelHealthFromHealth(healthJson);
    if (channelHealth.length === 0 && Array.isArray(status.channelSummary) && status.channelSummary.length > 0) {
      channelHealth = status.channelSummary.map((ch) => {
        const name = typeof ch === 'string' ? ch : (ch.name || ch.channel || ch.id || 'channel');
        return { channel: String(name).toLowerCase(), healthy: true, error: null };
      });
    }
    if (channelHealth.length === 0) {
      const channelSet = new Set();
      agents.forEach((a) => {
        const arr = Array.isArray(a.boundChannels) ? a.boundChannels : [];
        arr.forEach((c) => { if (c && typeof c === 'string') channelSet.add(String(c).toLowerCase()); });
      });
      channelHealth = Array.from(channelSet).map((c) => ({ channel: c, healthy: true, error: null }));
    }
    modelHealth = normalizeModelHealthFromModelsStatus(modelsJson);
    if (modelHealth.length === 0) {
      const modelIds = getModelIdsFromOpenClawConfig();
      modelHealth = modelIds.map((id) => ({ modelId: id, available: true, error: null }));
    }
  }

  const gatewayService = status.gatewayService
    ? {
        label: status.gatewayService.label,
        installed: status.gatewayService.installed,
        loaded: status.gatewayService.loadedText,
        runtime: status.gatewayService.runtimeShort,
      }
    : null;

  // 最近会话 + 会话内容预览
  let recentSessions = (status.sessions && status.sessions.recent) ? status.sessions.recent.slice(0, 20) : [];
  const sessionDirsByAgent = {};
  byAgent.forEach((b) => {
    sessionDirsByAgent[b.agentId] = path.dirname(b.path);
  });
  recentSessions = recentSessions.map((s, idx) => {
    const out = { ...s };
    if (idx < SESSION_CONTENT_PREVIEW_MAX) {
      const sessionDir = sessionDirsByAgent[s.agentId];
      if (sessionDir && s.sessionId) {
        const preview = readSessionContentPreview(sessionDir, s.sessionId);
        if (preview && preview.length) out.contentPreview = preview;
      }
    }
    return out;
  });

  const system = getSystemInfo();

  const rawControlUrl = gateway.reachable ? (gateway.url || GATEWAY_FALLBACK_URL) : null;
  const controlUiUrl = rawControlUrl ? toHttpUrl(rawControlUrl) : null;

  const out = {
    lastUpdated: new Date().toISOString(),
    defaultAgentId: (status.agents && status.agents.defaultId) || null,
    agents,
    gateway,
    gatewayService,
    controlUiUrl,
    channels: Array.isArray(status.channelSummary) ? status.channelSummary : [],
    channelHealth,
    modelHealth,
    sessionsTotal: (status.sessions && status.sessions.count) != null ? status.sessions.count : null,
    recentSessions,
    system,
    memoryGlobal: MEMORY_ENABLED ? (prevData && Array.isArray(prevData.memoryGlobal) ? prevData.memoryGlobal : []) : null,
    tokenCumulative: { byAgent: cumulativeByAgent, global: tokenCumulativeGlobal },
    tokenByModel,
    modelsSummary: getModelsSummaryFromConfig(),
    pluginsSummary: getPluginsSummaryFromConfig(),
  };

  if (!safeWriteStatusFile(out)) {
    // 写入锁被 updateMemory 占用，跳过本轮，下一轮 5s 再写
  }

  const activeCount = agents.filter((a) => a.status === 'thinking').length;
  if (activeCount > 0) {
    console.log(`[writer] ${agents.length} agents, ${activeCount} active`);
  }
}

/** 单独、低频、异步拉取角色记忆，不阻塞主轮询与页面 */
function updateMemory() {
  if (!MEMORY_ENABLED) return;
  let data;
  try {
    data = JSON.parse(fs.readFileSync(OUTPUT_FILE, 'utf-8'));
  } catch (e) {
    console.warn('[writer] updateMemory read:', e.message || e);
    return;
  }
  const agents = data.agents || [];
  const scopes = ['global'].concat(agents.map((a) => 'agent:' + a.id));
  Promise.allSettled(scopes.map((scope) => getMemoryForScopeAsync(scope)))
    .then((outcomes) => {
      const results = outcomes.map((o, i) => {
        if (o.status === 'fulfilled') return o.value;
        console.warn('[writer] updateMemory scope 失败:', scopes[i], (o.reason && (o.reason.message || o.reason)) || o.reason);
        return [];
      });
      let latest;
      try {
        latest = JSON.parse(fs.readFileSync(OUTPUT_FILE, 'utf-8'));
      } catch (_) {
        return;
      }
      if (!MEMORY_ENABLED) return;
      latest.memoryGlobal = Array.isArray(results[0]) ? results[0] : [];
      const ag = latest.agents || [];
      for (let i = 0; i < ag.length; i++) {
        ag[i].memoryEntries = Array.isArray(results[i + 1]) ? results[i + 1] : [];
      }
      const tryWrite = () => {
        if (safeWriteStatusFile(latest)) {
          const total = latest.memoryGlobal.length + ag.reduce((sum, a) => sum + (a.memoryEntries || []).length, 0);
          if (total > 0) console.log('[writer] 角色记忆已更新，共', total, '条');
        } else {
          setTimeout(tryWrite, 50);
        }
      };
      tryWrite();
    })
    .catch((e) => console.warn('[writer] updateMemory:', e.message || e));
}

const initial = {
  lastUpdated: new Date().toISOString(),
  defaultAgentId: null,
  agents: [],
  gateway: { reachable: false },
  gatewayService: null,
  channels: [],
  channelHealth: [],
  modelHealth: [],
  tokenByModel: [],
  sessionsTotal: null,
  recentSessions: [],
  system: null,
  memoryGlobal: null,
};
if (!fs.existsSync(OUTPUT_FILE)) {
  fs.writeFileSync(OUTPUT_FILE, JSON.stringify(initial, null, 2));
}

console.log('OpenClaw 全量 Agent 状态写入器');
console.log('数据源: openclaw status --json（自动发现全部 Agent）');
console.log('输出:', OUTPUT_FILE);
console.log('间隔:', CHECK_INTERVAL_MS, 'ms');
if (REDACT_PATHS) console.log('路径脱敏: 已开启');
if (SESSION_CONTENT_PREVIEW_MAX === 0) console.log('会话内容预览: 已关闭');
if (MEMORY_ENABLED) console.log('角色记忆: 已开启 (异步, 间隔', MEMORY_INTERVAL_MS, 'ms, 每 scope 最多', MEMORY_LIMIT, '条)');
else console.log('角色记忆: 已关闭');

const SERVER_PORT = parseInt(process.env.OPENCLAW_MONITOR_PORT || '3880', 10) || 3880;

function serveMemoryApi(req, res) {
  const parsed = url.parse(req.url, true);
  if (parsed.pathname !== '/memory' || req.method !== 'GET') return false;
  const scope = parsed.query && parsed.query.scope;
  if (!scope || typeof scope !== 'string') {
    console.log('[writer] GET /memory 缺少 scope');
    res.writeHead(400, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'missing scope' }));
    return true;
  }
  if (scope.length > MEMORY_SCOPE_MAX_LENGTH) {
    console.log('[writer] GET /memory scope 超长', scope.length);
    res.writeHead(400, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'scope too long' }));
    return true;
  }
  // 格式：global 或 agent:<id>；Agent ID 允许字母数字、下划线、点、连字符，若 OpenClaw 规范更严可在此收紧
  const safe = /^(global|agent:[a-zA-Z0-9_.-]+)$/.test(scope) ? scope : null;
  if (!safe) {
    console.log('[writer] GET /memory 非法 scope', scope);
    res.writeHead(400, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'invalid scope' }));
    return true;
  }
  console.log('[writer] GET /memory?scope=' + safe);
  res.setHeader('Content-Type', 'application/json');
  res.setHeader('Access-Control-Allow-Origin', '*');
  getMemoryForScopeAsync(safe)
    .then((entries) => {
      console.log('[writer] GET /memory?scope=' + safe, '响应', entries.length, '条');
      res.end(JSON.stringify(entries));
    })
    .catch((e) => {
      console.warn('[writer] GET /memory', safe, 'error', e.message || e);
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: String(e.message || e) }));
    });
  return true;
}

function serveStatic(req, res) {
  const parsed = url.parse(req.url, true);
  let filePath = parsed.pathname === '/' || parsed.pathname === '' ? '/agent-dashboard.html' : parsed.pathname;
  if (filePath === '/agent-status.json') {
    try {
      const data = fs.readFileSync(OUTPUT_FILE, 'utf-8');
      res.setHeader('Content-Type', 'application/json');
      res.end(data);
    } catch (_) {
      res.writeHead(404);
      res.end('Not Found');
    }
    return true;
  }
  // 路径遍历防护：只允许单段文件名，禁止 ..、.、空及路径分隔符（含 Windows \）
  const normalized = filePath.replace(/\\/g, '/').split('/').filter(Boolean);
  const filename = normalized.length ? normalized[normalized.length - 1] : '';
  if (!filename || filename === '.' || filename === '..' || filename.includes('..') || /[/\\]/.test(filename)) {
    res.writeHead(404);
    res.end('Not Found');
    return true;
  }
  const rootDir = path.resolve(__dirname);
  const localPath = path.resolve(rootDir, filename);
  // 严格校验：解析后的路径必须在 rootDir 下（不允许等于 rootDir，防止符号链接等绕过）
  const rootPrefix = path.resolve(rootDir) + path.sep;
  if (!localPath.startsWith(rootPrefix)) {
    res.writeHead(403);
    res.end('Forbidden');
    return true;
  }
  try {
    const data = fs.readFileSync(localPath);
    const ext = path.extname(localPath);
    const ct = ext === '.json' ? 'application/json' : ext === '.html' ? 'text/html; charset=utf-8' : 'application/octet-stream';
    res.setHeader('Content-Type', ct);
    res.end(data);
  } catch (_) {
    res.writeHead(404);
    res.end('Not Found');
  }
  return true;
}

function readCostConfig() {
  try {
    const raw = fs.readFileSync(COST_CONFIG_FILE, 'utf-8');
    const data = JSON.parse(raw);
    return data && typeof data.models === 'object' ? data : DEFAULT_COST_CONFIG;
  } catch (_) {
    return DEFAULT_COST_CONFIG;
  }
}

function writeCostConfig(data) {
  const out = data && typeof data.models === 'object' ? { models: data.models } : DEFAULT_COST_CONFIG;
  try {
    fs.writeFileSync(COST_CONFIG_FILE, JSON.stringify(out, null, 2), 'utf-8');
    console.log('[writer] cost-config 已保存');
  } catch (e) {
    console.error('[writer] cost-config 保存失败:', e.message || e);
    throw e;
  }
}

function serveCostConfigApi(req, res) {
  const parsed = url.parse(req.url, true);
  if (parsed.pathname !== '/cost-config') return false;
  res.setHeader('Content-Type', 'application/json');
  res.setHeader('Access-Control-Allow-Origin', '*');
  if (req.method === 'GET') {
    const cost = readCostConfig();
    const modelIdsFromConfig = getModelIdsFromOpenClawConfig();
    res.end(JSON.stringify({ models: cost.models, modelIdsFromConfig }));
    return true;
  }
  if (req.method === 'POST') {
    const chunks = [];
    let totalSize = 0;
    let bodyTooLarge = false;
    const MAX_BODY_SIZE = 10 * 1024 * 1024; // 10MB，防止恶意超大 body 导致内存耗尽
    req.on('data', (chunk) => {
      totalSize += chunk.length;
      if (totalSize > MAX_BODY_SIZE) {
        bodyTooLarge = true;
        res.writeHead(413, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'request body too large' }));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => {
      if (bodyTooLarge) return;
      try {
        const body = Buffer.concat(chunks).toString('utf-8');
        const data = JSON.parse(body);
        if (!data || typeof data.models !== 'object') {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'invalid body, need { models: { ... } }' }));
          return;
        }
        writeCostConfig(data);
        res.end(JSON.stringify(readCostConfig()));
      } catch (e) {
        const isWriteError = e.code && ['ENOSPC', 'EACCES', 'EROFS', 'EPERM', 'ENOENT'].includes(e.code);
        res.writeHead(isWriteError ? 500 : 400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: String(e.message || e) }));
      }
    });
    return true;
  }
  res.writeHead(405);
  res.end('Method Not Allowed');
  return true;
}

const server = http.createServer((req, res) => {
  if (serveMemoryApi(req, res)) return;
  if (serveCostConfigApi(req, res)) return;
  serveStatic(req, res);
});

server.listen(SERVER_PORT, () => {
  console.log('监控仪表盘: http://localhost:' + SERVER_PORT + '/agent-dashboard.html');
  console.log('交互式记忆: GET /memory?scope=global 或 ?scope=agent:<id>');
});

let updateStatusRunning = false;
setInterval(() => {
  if (updateStatusRunning) return;
  updateStatusRunning = true;
  updateStatus().finally(() => { updateStatusRunning = false; });
}, CHECK_INTERVAL_MS);
updateStatus();
if (MEMORY_ENABLED) {
  setInterval(updateMemory, MEMORY_INTERVAL_MS);
  setTimeout(updateMemory, 2000);
}
