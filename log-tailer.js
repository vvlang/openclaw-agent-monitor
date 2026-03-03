/**
 * OpenClaw Log Tailer & Broadcaster (方案 C - 终极版)
 * 监听当前会话的 .jsonl 日志文件，实时捕获 AI 的思考和动作，并广播到 status 文件。
 * 原理：使用 fs.watch 或 tail 逻辑，检测文件新增行，解析 JSON，更新 agent-status.json
 */

const fs = require('fs');
const path = require('path');

// 配置：当前会话的日志文件路径
const LOG_FILE = '/Users/vvlang/.openclaw/agents/main/sessions/ba79d7cd-5484-4c22-8ea4-5487b03604e3.jsonl';
const OUTPUT_FILE = path.join(__dirname, 'agent-status.json');
const AGENT_ID = 'main';
const AGENT_NAME = '总指挥';

console.log(`👂 Log Tailer Started...`);
console.log(`📍 Watching: ${LOG_FILE}`);
console.log(`📡 Broadcasting to: ${OUTPUT_FILE}`);

// 读取最后 10 行作为初始状态，避免遗漏
function readLastLines(filePath, linesCount = 10) {
    try {
        const content = fs.readFileSync(filePath, 'utf-8');
        const lines = content.trim().split('\n').slice(-linesCount);
        return lines.map(l => JSON.parse(l));
    } catch (e) {
        return [];
    }
}

// 解析日志行，提取“思考”和“工具调用”
function parseLogEntry(entry) {
    if (!entry) return null;
    
    // 典型的 OpenClaw 日志结构：
    // { role: 'user' | 'assistant' | 'system', content: '...', toolCalls: [...] }
    // 或者 { type: 'thought', text: '...' }
    
    const result = {
        timestamp: new Date().toISOString(),
        agent: AGENT_ID,
        status: 'idle',
        message: '',
        detail: ''
    };

    if (entry.role === 'assistant') {
        if (entry.toolCalls && entry.toolCalls.length > 0) {
            // 正在调用工具
            result.status = 'tool_call';
            result.message = `调用工具：${entry.toolCalls.map(t => t.name || t.function?.name).join(', ')}`;
            result.detail = JSON.stringify(entry.toolCalls, null, 2);
        } else if (entry.content) {
            // 正在回复（思考结束）
            result.status = 'thinking';
            result.message = '正在生成回复...';
            result.detail = entry.content.substring(0, 100) + '...';
        }
    } else if (entry.role === 'system') {
        result.status = 'idle';
        result.message = '系统消息';
    }

    return result;
}

// 初始化状态
let statusData = {
    lastUpdated: new Date().toISOString(),
    agents: [
        { id: AGENT_ID, name: AGENT_NAME, color: 'bg-purple-500', status: 'checking', message: '监听日志中...' }
    ]
};

// 写入初始状态
fs.writeFileSync(OUTPUT_FILE, JSON.stringify(statusData, null, 2));

// 监听文件变化
let lastSize = fs.statSync(LOG_FILE).size;
let lastLineCount = 0;

fs.watch(LOG_FILE, (eventType) => {
    if (eventType === 'change') {
        try {
            const stats = fs.statSync(LOG_FILE);
            if (stats.size > lastSize) {
                // 文件变大，说明有新内容
                const content = fs.readFileSync(LOG_FILE, 'utf-8');
                const lines = content.trim().split('\n');
                const newLines = lines.slice(lastLineCount);
                
                if (newLines.length > 0) {
                    // 处理新增的行
                    newLines.forEach(line => {
                        try {
                            const entry = JSON.parse(line);
                            const parsed = parseLogEntry(entry);
                            if (parsed && parsed.status !== 'idle') {
                                // 更新状态
                                statusData.lastUpdated = new Date().toISOString();
                                statusData.agents[0] = {
                                    ...statusData.agents[0],
                                    ...parsed,
                                    agent: AGENT_ID,
                                    name: AGENT_NAME
                                };
                                fs.writeFileSync(OUTPUT_FILE, JSON.stringify(statusData, null, 2));
                                console.log(`📡 [${parsed.status}] ${parsed.message}`);
                            }
                        } catch (e) {
                            // ignore parse error
                        }
                    });
                    
                    lastLineCount = lines.length;
                }
                lastSize = stats.size;
            }
        } catch (e) {
            console.error("Error watching file:", e.message);
        }
    }
});

// 初始化 lastLineCount
try {
    const content = fs.readFileSync(LOG_FILE, 'utf-8');
    lastLineCount = content.trim().split('\n').length;
    console.log(`✅ Initial lines: ${lastLineCount}`);
} catch (e) {
    console.error("Error reading initial file:", e.message);
}

console.log(`🟢 Monitoring started. Waiting for new logs...`);
