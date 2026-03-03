/**
 * OpenClaw 全量 Agent 状态写入器
 * 数据源：openclaw status --json，自动发现并监控配置中的全部 Agent。
 */

const { execSync } = require('child_process');
const fs = require('fs');
const path = require('path');
const os = require('os');

const OUTPUT_FILE = path.join(__dirname, 'agent-status.json');
const CHECK_INTERVAL_MS = 5000;
const ACTIVE_AGE_MS = 120000; // 2 分钟内有活动视为 thinking
const SESSION_CONTENT_PREVIEW_MAX = 10; // 最多为几个会话读取内容预览
const SESSION_JSONL_LAST_LINES = 50; // 每个会话读取最后 N 行
const PREVIEW_TEXT_LEN = 120; // 每条消息预览最大字符
const PREVIEW_MESSAGES = 4; // 每个会话保留最近几条消息预览

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

/** 读取会话 .jsonl 中真正的最后几条 user/assistant 文本消息（从文件末尾往前扫） */
function readSessionContentPreview(sessionDir, sessionId) {
  const jsonlPath = path.join(sessionDir, sessionId + '.jsonl');
  try {
    const stats = fs.statSync(jsonlPath);
    if (stats.size > SESSION_JSONL_MAX_SIZE) {
      return [{ role: 'system', text: '[日志文件过大，跳过预览以保护性能]' }];
    }
  } catch (e) {
    return null;
  }
  let content;
  try {
    content = fs.readFileSync(jsonlPath, 'utf-8');
  } catch (e) {
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
    } catch (_) {}
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
  } catch (_) {}
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
  } catch (_) {}
  try {
    if (os.platform() === 'darwin') {
      const out = execSync('top -l 1 -n 0 2>/dev/null', { encoding: 'utf-8', maxBuffer: 8192 });
      const m = out.match(/([\d.]+)\s*%\s*idle/);
      if (m) info.cpu = Math.round(100 - parseFloat(m[1]));
    } else if (os.platform() === 'linux') {
      const out = execSync("top -b -n 1 2>/dev/null | grep '^%Cpu' || true", { encoding: 'utf-8', maxBuffer: 4096 });
      const m = out.match(/([\d.]+)\s*%\s*id(?:le)?\b|([\d.]+)\s+id\b/);
      if (m) info.cpu = Math.round(100 - parseFloat(m[1] || m[2]));
    }
    if (info.cpu == null && os.loadavg()[0] != null) {
      const load = os.loadavg()[0];
      const cpus = os.cpus().length;
      info.cpu = Math.min(100, Math.round((load / Math.max(1, cpus)) * 100));
    }
  } catch (_) {}
  try {
    const out = execSync('df -P . 2>/dev/null || df -P / 2>/dev/null', { encoding: 'utf-8', maxBuffer: 4096 });
    const lines = out.trim().split('\n').filter(Boolean);
    const dataLine = lines[lines.length - 1]; // 最后一行是当前目录/根分区数据
    const pct = dataLine.match(/(\d+)%/); // Capacity 列如 "22%" 或 "69% /"，不要求行尾
    if (pct) info.disk = parseInt(pct[1], 10);
  } catch (_) {}
  try {
    if (info.ip) {
      const pingCmd = os.platform() === 'darwin' ? 'ping -c 1 -t 2 8.8.8.8 2>/dev/null' : 'ping -c 1 -W 2 8.8.8.8 2>/dev/null';
      execSync(pingCmd, { encoding: 'utf-8' });
      info.network = '在线';
    } else {
      info.network = '无外网 IP';
    }
  } catch (_) {
    info.network = info.ip ? '离线' : '--';
  }
  return info;
}

function getStatusJson() {
  try {
    const raw = execSync('openclaw status --json 2>/dev/null', {
      encoding: 'utf-8',
      maxBuffer: 2 * 1024 * 1024,
    });
    const start = raw.indexOf('{');
    if (start === -1) return null;
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
    if (end === -1) return null;
    return JSON.parse(raw.slice(start, end + 1));
  } catch (e) {
    return null;
  }
}

function updateStatus() {
  const status = getStatusJson();
  if (!status) {
    try {
      const prev = JSON.parse(fs.readFileSync(OUTPUT_FILE, 'utf-8'));
      prev.lastUpdated = new Date().toISOString();
      prev.gateway = prev.gateway || {};
      prev.gateway.reachable = false;
      prev.gateway.error = 'openclaw status 执行失败';
      prev.system = getSystemInfo();
      fs.writeFileSync(OUTPUT_FILE, JSON.stringify(prev, null, 2));
    } catch (_) {}
    return;
  }

  const byAgent = (status.sessions && status.sessions.byAgent) ? status.sessions.byAgent : [];
  const agentsList = (status.agents && status.agents.agents) ? status.agents.agents : [];
  const heartbeatAgents = (status.heartbeat && status.heartbeat.agents) ? status.heartbeat.agents : [];

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
    return {
      id: a.id,
      name: a.name || a.id,
      color: getColorForIndex(index),
      status: statusStr,
      message,
      lastActive: a.lastUpdatedAt ? new Date(a.lastUpdatedAt).toISOString() : null,
      sessionCount: a.sessionsCount ?? 0,
      totalTokens: recent && recent.totalTokens != null ? recent.totalTokens : null,
      percentUsed: recent && recent.percentUsed != null ? recent.percentUsed : null,
      lastSessionId: recent ? recent.sessionId : null,
      heartbeat: hb ? (hb.enabled ? hb.every : 'off') : 'off',
      workspaceDir: a.workspaceDir || null,
    };
  });

  const gateway = status.gateway
    ? {
        reachable: !!status.gateway.reachable,
        url: status.gateway.url || null,
        latencyMs: status.gateway.connectLatencyMs ?? null,
        version: status.gateway.self && status.gateway.self.version ? status.gateway.self.version : null,
        host: status.gateway.self && status.gateway.self.host ? status.gateway.self.host : null,
        ip: status.gateway.self && status.gateway.self.ip ? status.gateway.self.ip : null,
        error: status.gateway.error || null,
      }
    : { reachable: false, error: '无 gateway 数据' };

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

  const out = {
    lastUpdated: new Date().toISOString(),
    defaultAgentId: (status.agents && status.agents.defaultId) || null,
    agents,
    gateway,
    gatewayService,
    channels: Array.isArray(status.channelSummary) ? status.channelSummary : [],
    sessionsTotal: (status.sessions && status.sessions.count) != null ? status.sessions.count : null,
    recentSessions,
    system,
  };

  fs.writeFileSync(OUTPUT_FILE, JSON.stringify(out, null, 2));

  const activeCount = agents.filter((a) => a.status === 'thinking').length;
  if (activeCount > 0) {
    console.log(`[writer] ${agents.length} agents, ${activeCount} active`);
  }
}

const initial = {
  lastUpdated: new Date().toISOString(),
  defaultAgentId: null,
  agents: [],
  gateway: { reachable: false },
  gatewayService: null,
  channels: [],
  sessionsTotal: null,
  recentSessions: [],
  system: null,
};
if (!fs.existsSync(OUTPUT_FILE)) {
  fs.writeFileSync(OUTPUT_FILE, JSON.stringify(initial, null, 2));
}

console.log('OpenClaw 全量 Agent 状态写入器');
console.log('数据源: openclaw status --json（自动发现全部 Agent）');
console.log('输出:', OUTPUT_FILE);
console.log('间隔:', CHECK_INTERVAL_MS, 'ms');

setInterval(updateStatus, CHECK_INTERVAL_MS);
updateStatus();
