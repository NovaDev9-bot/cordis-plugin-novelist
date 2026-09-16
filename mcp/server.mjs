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

const require_ = createRequire(import.meta.url)
const PKG = require_('../package.json')

const stderr = (s) => process.stderr.write('[novelist-mcp] ' + s + '\n')

function parseRoot(argv) {
  const i = argv.indexOf('--root')
  if (i !== -1 && argv[i + 1]) return argv[i + 1]
  if (process.env.NOVELIST_ROOT) return process.env.NOVELIST_ROOT
  return null
}

const rootInput = parseRoot(process.argv.slice(2))
if (!rootInput) {
  stderr('缺少 --root <目录> 或 NOVELIST_ROOT，退出。MCP 无宿主沙箱，路径安全由书库根自担——这是启动硬前置。')
  process.exit(2)
}
const rootAbs = path.resolve(rootInput)
await fsp.mkdir(rootAbs, { recursive: true })
const root = await fsp.realpath(rootAbs)

const adapter = createNodeFsAdapter(root)
const handler = createMcpHandler({
  adapter,
  TOOLS: _internals.TOOLS,
  SECTION: _internals.SECTION,
  serverInfo: { name: 'novelist', title: 'Novelist 文件账本', version: PKG.version },
})
stderr('ready · root=' + root + ' · tools=' + _internals.TOOLS.length + ' · v' + PKG.version)

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
