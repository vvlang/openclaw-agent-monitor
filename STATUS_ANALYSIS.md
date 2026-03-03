# OpenClaw status 目录分析与图形化监控方案

## 一、当前 `/Users/vvlang/.clawdbot/status` 结构

| 文件 | 作用 |
|------|------|
| **agent-status.json** | 前端消费的**唯一数据源**：各 Agent 状态（idle/thinking/checking/error）、最后更新时间。当前若只跑 log-tailer 则只有 1 个 agent。 |
| **agent-status-writer.js** | 轮询 `openclaw sessions --active 5 --json` 每 2 秒，按 `agentId` 匹配 5 个 TARGET_AGENTS，写入 agent-status.json。**问题**：`sessions --active` 返回的 path 只指向**单个** agent 的 sessions 文件，多 agent 需用 `openclaw status --json` 的 `sessions.byAgent`。 |
| **log-tailer.js** | 监听**单个** session 的 `.jsonl` 文件（路径写死为 main 的某会话），用 `fs.watch` 解析新行的 role/toolCalls，更新 agent-status.json 里**一个** agent 的 status/message。适合单 agent 实时“思考/工具调用”展示，不适合多 agent。 |
| **agent-dashboard.html** | 读取 agent-status.json，展示：顶部 5 个 Agent 卡片（状态灯 + 名称 + 消息）、实时活动日志（状态变化时打点）、右侧原始 JSON。依赖 writer 或 tailer 持续写入。 |
| **mind-data-v2.json** | 另一份 5 agent 的静态/缓存数据，与 agent-status.json 可能不同步。 |

## 二、OpenClaw 官方可用的数据源

- **`openclaw status --json`**（推荐作为监控主数据源）
  - `heartbeat.agents[]`：各 agent 的 heartbeat 开关与间隔
  - `sessions.byAgent[]`：每个 agent 的会话数量、最近会话列表（sessionId、updatedAt、age、inputTokens、outputTokens、percentUsed、model、flags）
  - `sessions.recent`：全局最近会话（含 agentId）
  - `agents.agents[]`：每个 agent 的 id、name、workspaceDir、sessionsCount、lastUpdatedAt、lastActiveAgeMs、bootstrapPending
  - `gateway`：mode、url、reachable、connectLatencyMs、self.host/ip/version、error
  - `gatewayService`：LaunchAgent 安装/加载/运行状态
  - `channelSummary[]`：Telegram、iMessage 等配置摘要
  - `os`、`update`、`memoryPlugin`、`securityAudit` 等

- **`openclaw sessions --active <minutes> --json`**
  - 返回**当前默认/单一路径**下的活跃会话，结构为 `{ path, count, activeMinutes, sessions[] }`，适合“最近 N 分钟有活动”的简单判断，但**不按 agent 分片**，多 agent 需多次调用或改用 status --json。

## 三、现有问题小结

1. **数据源分散**：writer 用 sessions --active（单 agent 视角），tailer 只盯一个 jsonl，dashboard 期望 5 个 agent，导致 agent-status.json 里常只有 1 个 agent。
2. **多 agent 状态未统一**：应用 `openclaw status --json` 的 `sessions.byAgent` + `agents.agents` 可得到每个 agent 的会话数、最后活动时间、是否“正在活跃”（如 age < 2 分钟）。
3. **图形化信息不足**：缺少 Gateway 是否可达、通道摘要、最近会话列表、每 agent 的 token 使用/上下文占用等，这些 status --json 都有。

## 四、推荐方案：基于 `openclaw status --json` 的图形化监控

1. **统一写入层**  
   - 新写或重写 **agent-status-writer.js**：每 5–10 秒执行 `openclaw status --json`，从 stderr 中滤掉插件日志，只解析 JSON。  
   - 从输出中提取：  
     - `agents.agents` → 每个 agent 的 id、name、sessionsCount、lastActiveAgeMs、lastUpdatedAt  
     - `sessions.byAgent` → 每个 agent 最近会话的 token/percentUsed  
     - `gateway`、`gatewayService`、`channelSummary`  
   - 定义“活跃”规则：例如 `lastActiveAgeMs < 120000`（2 分钟内）或该 agent 有 session 且 `age < 120000` 则状态为 `thinking`，否则 `idle`。  
   - 写入 **agent-status.json** 的扩展结构，例如：  
     - `agents[]`：id, name, color, status, message, lastActive, sessionCount, totalTokens, percentUsed, lastSessionId  
     - `gateway`：reachable, url, latencyMs, version, serviceStatus  
     - `channels`：channelSummary 简短列表  
     - `lastUpdated`

2. **仪表盘增强（agent-dashboard.html）**  
   - 保留顶部 5 个 Agent 卡片，用上述 status 驱动，显示：状态灯、名称、会话数、最近活动、简要 token/上下文占用。  
   - 新增：Gateway 状态（可达/延迟/版本）、通道摘要一行、可选“最近会话”列表（来自 sessions.recent，带 agentId、sessionId、age、percentUsed）。  
   - 实时活动日志：可保留“状态变化”打点，或改为“最近会话变更”事件（例如某 agent 新会话/最近会话更新）。

3. **log-tailer.js 的定位**  
   - 保留为**可选**：只关心“当前一个会话的实时思考/工具调用”时再开；与 writer 同时运行时，writer 以 status 为准写多 agent，tailer 可只更新 main 的 message 字段（需约定合并逻辑，或 tailer 只写单独文件由 dashboard 二次合并）。

## 五、实施后的效果

- 单一数据源：`openclaw status --json` → agent-status.json。  
- 5 个 Agent 状态一致、可区分 idle/thinking，并带会话数、token、上下文占用。  
- 图形化监控包含：Gateway 健康、通道配置、最近会话一览，便于运维与排障。
