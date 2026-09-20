#!/usr/bin/env node
/**
 * novelist MCP server —— IO 壳（G1，v0.8.0）。
 *
 * 把 novelist 十二工具暴露为 MCP（Model Context Protocol）stdio server，
 * 任何 MCP 客户端（Claude Code / ZCode / Cursor / 其他智能体）可插。
 * 协议逻辑见 handler.mjs；fs 适配与书库根安全见 fs-adapter.mjs。
 *
 * 用法：
 *   node mcp/server.mjs --root <书库根目录>
 *   NOVELIST_ROOT=<书库根目录> node mcp/server.mjs
 *
 * 客户端注册（以 Claude Code 类配置为例）：
 *   {"mcpServers":{"novelist":{"command":"node","args":["<仓库路径>/mcp/server.mjs","--root","<书库根>"]}}}
 *
 * 注意：MCP 形态无宿主 ask 门（DSH 侧 novel_init/novel_assemble 需 Owner 确认）——
 * 由客户端自身的人工审批机制承担（MCP 规范要求 human in the loop）。
 */
import { promises as fsp } from 'node:fs'
import path from 'node:path'
import readline from 'node:readline'
import { createNodeFsAdapter } from './fs-adapter.mjs'
import { createMcpHandler } from './handler.mjs'
import { _internals } from '../lib/novelist.js'
import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'

const require_ = createRequire(import.meta.url)
const PKG = require_('../package.json')

const stderr = (s) => process.stderr.write('[novelist-mcp] ' + s + '\n')

// 书库根解析（优先级：--root → NF_BOOK_ROOT → NOVELIST_ROOT）。
// 〔2026-09-20 复核 REC-03.1〕NF_BOOK_ROOT 是**运行期可覆盖**入口：宿主配置里的 --root 烤在
// plugin.json 里（跨机器要重装），环境变量给一条不动机器文件的换根路径。
// 同时记下**来源**——"根对不对"必须可发现（随 initialize 与 novel_guide 下发，见 handler）。
function parseRoot(argv) {
  const i = argv.indexOf('--root')
  if (i !== -1 && argv[i + 1]) return { root: argv[i + 1], source: 'args --root' }
  if (process.env.NF_BOOK_ROOT) return { root: process.env.NF_BOOK_ROOT, source: 'env NF_BOOK_ROOT' }
  if (process.env.NOVELIST_ROOT) return { root: process.env.NOVELIST_ROOT, source: 'env NOVELIST_ROOT' }
  return null
}

const rootParsed = parseRoot(process.argv.slice(2))
if (!rootParsed) {
  stderr('缺少 --root <目录> 或环境变量 NF_BOOK_ROOT / NOVELIST_ROOT，退出。MCP 无宿主沙箱，路径安全由书库根自担——这是启动硬前置。')
  process.exit(2)
}
const rootInput = rootParsed.root
const rootSource = rootParsed.source
const rootAbs = path.resolve(rootInput)
await fsp.mkdir(rootAbs, { recursive: true })
const root = await fsp.realpath(rootAbs)

const adapter = createNodeFsAdapter(root, { rootSource })
const handler = createMcpHandler({
  adapter,
  TOOLS: _internals.TOOLS,
  SECTION: _internals.SECTION,
  serverInfo: { name: 'novelist', title: 'Novelist 文件账本', version: PKG.version },
  rootInfo: root + '（来源：' + rootSource + '）',
  connectorInfo: fileURLToPath(import.meta.url) + ' · v' + PKG.version,
})
stderr('ready · root=' + root + '（' + rootSource + '） · tools=' + _internals.TOOLS.length + ' · v' + PKG.version)

// 〔2026-09-20 复核 REC-04 的判据，固定在这一行〕"账本能不能记谁落的账"取决于宿主是否把
// 会话/任务身份交给**连接器进程**——宿主自己知道（它的审计日志按 sessionId 记每次工具调用），
// 但 MCP 只规定 clientInfo（＝宿主名），不传调用方身份。这行让"收到没收到"成为每次启动都
// 可见的事实，而不是一次性探针的结论：**absent 就说明该形态下归属没有可机器验证的来源**，
// 谁都不必再猜、也不必去编一个"自报名字"的假机制。
{
  const idKeys = Object.keys(process.env).filter((k) => /SESSION|AGENT|EXPERT|CONVERSATION|TOOL_CALL/i.test(k)).sort()
  stderr(idKeys.length
    ? 'identity-env=present(' + idKeys.length + ') · ' + idKeys.slice(0, 6).join(',')
    : 'identity-env=absent · 宿主未向连接器下发身份键（本形态下落账归属无机器可验来源）')
}

const rl = readline.createInterface({ input: process.stdin, terminal: false })
// 串行队列：逐行 await 前一行完成再处理——响应顺序与请求顺序一致（JSON-RPC 按 id 匹配
// 本不强制有序，但客户端实现普遍假设有序；工具均为短操作，串行无吞吐损失）。
let queue = Promise.resolve()
rl.on('line', (line) => {
  queue = queue
    .then(() => handler.handleLine(line))
    .then((resp) => { if (resp) process.stdout.write(JSON.stringify(resp) + '\n') })
    .catch((e) => stderr('未预期错误：' + ((e && e.message) || e)))
})
rl.on('close', () => { stderr('stdin 关闭，退出'); process.exit(0) })
