#!/usr/bin/env node
/**
 * MiniMax Token Plan remains 查询脚本（交互式输入 API Key）。
 *
 * 安全原则：
 * - 不把 key 写入任何文件、不输出 key 到控制台
 * - 仅在你运行脚本时从终端读取
 *
 * 用法：
 *   npm run minimax-tokenplan
 *   或直接：
 *     node scripts/minimax-tokenplan-remains.js
 *
 * 也支持环境变量方式（仍不写入磁盘）：
 *   MINIMAX_TOKENPLAN_KEY="..." node scripts/minimax-tokenplan-remains.js
 */

const readline = require('readline');

const ENDPOINT = 'https://www.minimax.io/v1/api/openplatform/coding_plan/remains';

function hideInputPrompt(question) {
  return new Promise((resolve) => {
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout });

    // 让终端不回显输入字符（raw mode + 逐字符接收，尽量兼容 macOS）
    process.stdin.resume();
    if (process.stdin.isTTY) process.stdin.setRawMode(true);

    process.stdout.write(question);

    let buf = '';
    const onData = (b) => {
      const ch = String(b);
      if (ch === '\n' || ch === '\r') {
        process.stdout.write('\n');
        cleanup();
        resolve(buf);
        return;
      }
      if (ch === '\u0003') { // Ctrl+C
        cleanup();
        process.exit(130);
      }
      // 退格处理
      if (ch === '\u007f' || ch === '\b') {
        if (buf.length > 0) buf = buf.slice(0, -1);
        return;
      }
      // 普通字符
      buf += ch;
    };

    function cleanup() {
      process.stdin.setRawMode(false);
      rl.close();
      process.stdin.off('data', onData);
    }

    process.stdin.on('data', onData);
  });
}

function toISO(ms) {
  try {
    const d = new Date(ms);
    if (!isNaN(d.getTime())) return d.toISOString();
  } catch (_) {}
  return null;
}

function extractUsefulFields(obj) {
  if (!obj || typeof obj !== 'object') return {};

  // 尝试从返回结构里抽取常见字段名；字段名可能在版本中变化，因此只做“尽力而为”
  const candidates = [];
  const keys = Object.keys(obj);
  for (const k of keys) {
    const lk = k.toLowerCase();
    if (lk.includes('remain') || lk.includes('left') || lk.includes('quota') || lk.includes('used') || lk.includes('used') ||
        lk.includes('reset') || lk.includes('next') || lk.includes('window') || lk.includes('time')) {
      candidates.push(k);
    }
  }

  // 另外递归找少量深层关键字（避免把整个响应都 dump 太长）
  function walk(o, path = []) {
    if (!o || typeof o !== 'object') return;
    if (Array.isArray(o)) {
      o.forEach((v, i) => walk(v, path.concat('[' + i + ']')));
      return;
    }
    for (const [k, v] of Object.entries(o)) {
      const lk = k.toLowerCase();
      const p2 = path.concat(k).join('.');
      if (typeof v === 'number' || typeof v === 'string' || typeof v === 'boolean') {
        if (
          lk.includes('remain') || lk.includes('left') ||
          lk.includes('used') || lk.includes('quota') ||
          lk.includes('reset') || lk.includes('next') ||
          lk.includes('window') || lk.includes('expires') || lk.includes('expire')
        ) {
          candidates.push(p2);
        }
      }
      walk(v, path.concat(k));
    }
  }
  try { walk(obj, []); } catch (_) {}

  const out = { rawKeysHint: candidates.slice(0, 30) };

  // 直接提供一个“人类易读”摘要：优先找最像 used/remaining 的字段
  const text = JSON.stringify(obj);
  const lower = text.toLowerCase();
  // 只要能找到这些片段，就尽量展示
  const usedGuess = lower.includes('used') ? '可能包含 used 字段' : null;
  const remainGuess = lower.includes('remain') || lower.includes('left') ? '可能包含 remaining 字段' : null;
  out.summaryHint = [usedGuess, remainGuess].filter(Boolean);
  return out;
}

async function main() {
  const envKey = process.env.MINIMAX_TOKENPLAN_KEY;
  let apiKey = envKey && String(envKey).trim() ? String(envKey).trim() : null;

  if (!apiKey) {
    apiKey = await hideInputPrompt('输入 MiniMax Token Plan API Key（输入不会回显）：');
    apiKey = String(apiKey).trim();
  }

  if (!apiKey) {
    console.error('API Key 不能为空');
    process.exit(2);
  }

  const res = await fetch(ENDPOINT, {
    method: 'GET',
    headers: {
      Authorization: 'Bearer ' + apiKey,
      'Content-Type': 'application/json',
    },
  });

  const txt = await res.text();
  if (!res.ok) {
    console.error('请求失败:', res.status, res.statusText);
    console.error('响应内容（不含 key）:\n' + txt.slice(0, 2000));
    process.exit(1);
  }

  let json;
  try {
    json = JSON.parse(txt);
  } catch (e) {
    console.log('接口返回的不是 JSON，原文如下：\n' + txt);
    process.exit(0);
  }

  // 输出“摘要” + “完整 JSON”（方便你确认字段名）
  console.log('\n== MiniMax Token Plan remains ==');
  const extracted = extractUsefulFields(json);
  if (extracted && (extracted.summaryHint || extracted.rawKeysHint)) {
    if (extracted.summaryHint && extracted.summaryHint.length) console.log('摘要提示:', extracted.summaryHint.join('；'));
    if (extracted.rawKeysHint && extracted.rawKeysHint.length) console.log('字段线索（前 30 个）：', extracted.rawKeysHint.join(', '));
  }
  console.log('\n完整响应：\n' + JSON.stringify(json, null, 2));
}

main().catch((e) => {
  console.error(e && (e.stack || e.message) ? (e.stack || e.message) : e);
  process.exit(1);
});

