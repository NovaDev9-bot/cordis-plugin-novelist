/**
 * server-e2e.test.mjs —— 真起 server 子进程、用外部客户端经 stdio 说 JSON-RPC（2026-09-19）
 *
 * 为什么存在：mcp.test.mjs 的 15 项协议测试全部走**进程内 handler**——它们证明
 * "协议逻辑对"，但证明不了"**另一个进程**把它当 MCP 服务器用也行"。而那正是宿主
 * （WorkBuddy / 任何 MCP 客户端）的真实姿势：spawn → 按行读写 JSON-RPC → 死活不管内部。
 * 这一条对应 H5 挂账的"外部 MCP 客户端验收"半边（另一半＝DSH 真实多代理运行时，
 * 挂首个生产批，见总台账）。
 *
 * 覆盖四个只有真进程才暴露的口：
 *   ① 启动硬前置（--root 缺失必须退场，不是挂着装好）
 *   ② initialize → initialized 通知 → tools/list 的完整握手序
 *   ③ tools/call 走一遍真 fs（建书）并渲染成文本
 *   ④ 坏行（非 JSON）不崩服务，后续请求照答
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const SERVER = join(dirname(fileURLToPath(import.meta.url)), '..', 'server.mjs')  // 本文件在 mcp/test/ 下，server 在上一级
const PROTO = '2025-06-18' // MCP 规范版本（与 handler 支持清单同源；清单外会被回退处理）

/** 外部客户端视图：一个 spawn 的 server + 按行收发的 JSON-RPC。 */
function client(t, args = []) {
  const child = spawn(process.execPath, [SERVER, ...args], { stdio: ['pipe', 'pipe', 'pipe'] })
  t.after(() => { try { child.kill('SIGKILL') } catch (e) { /* 已退出 */ } })
  let buf = ''
  const queue = []
  const waiters = []
  let stderr = ''
  child.stdout.on('data', (d) => {
    buf += d
    let i
    while ((i = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, i)
      buf = buf.slice(i + 1)
      if (!line.trim()) continue
      try { const m = JSON.parse(line); const w = waiters.shift(); if (w) w(m); else queue.push(m) } catch (e) { continue }
    }
  })
  child.stderr.on('data', (d) => { stderr += d })
  const send = (obj) => new Promise((res) => child.stdin.write(JSON.stringify(obj) + '\n', res))
  const next = (timeoutMs = 15_000) => {
    if (queue.length) return Promise.resolve(queue.shift())
    return new Promise((res, rej) => {
      const timer = setTimeout(() => rej(new Error('server 响应超时；stderr=' + stderr.slice(0, 300))), timeoutMs)
      waiters.push((m) => { clearTimeout(timer); res(m) })
    })
  }
  const rpc = async (id, method, params) => { await send({ jsonrpc: '2.0', id, method, ...(params ? { params } : {}) }); return next() }
  return { child, send, next, rpc, stderrText: () => stderr }
}

test('启动硬前置：缺 --root 必须退场并给可读原因', async (t) => {
  const c = client(t)
  const code = await new Promise((res) => c.child.on('exit', res))
  assert.notEqual(code, 0, '不该无声地挂着一个没有书库根的 server')
  assert.match(c.stderrText(), /root|书库根|NOVELIST_ROOT/i, '退场原因要可读')
})

test('外部客户端完整会话：握手 → 15 工具 → 真建书 → 坏行不崩', async (t) => {
  const booksRoot = c_root(t)
  const c = client(t, ['--root', booksRoot])
  // ① 握手
  const init = await c.rpc(1, 'initialize', { protocolVersion: PROTO, capabilities: {}, clientInfo: { name: 'e2e-external-client', version: '0' } })
  assert.equal(init.result.serverInfo.name.length > 0, true, JSON.stringify(init).slice(0, 200))
  await c.send({ jsonrpc: '2.0', method: 'notifications/initialized' })   // 通知：无响应
  // ② 工具清单（外部客户端看到的面）
  const list = await c.rpc(2, 'tools/list', {})
  const names = list.result.tools.map((x) => x.name)
  assert.equal(names.length, 15, '外部客户端应看到 15 个工具：' + names.join(','))
  assert.ok(names.includes('novel_search') && names.includes('novel_decide'), '新工具必须出现在对外清单里')
  // ③ 真建书（渲染文本走 isError=false 的 content）
  const call = await c.rpc(3, 'tools/call', { name: 'novel_init', arguments: { book_dir: join(booksRoot, 'e2e书'), title: '外部客户端建的书', genre: 'dushi', logline: 'L' } })
  assert.equal(call.result.isError, false, JSON.stringify(call.result).slice(0, 300))
  assert.match(call.result.content[0].text, /建书成功|project\.json/)
  // ④ 坏行：服务不许崩，后续请求照答
  c.child.stdin.write('这{{不是 JSON\n')
  const ping = await c.rpc(4, 'tools/list', {})
  assert.equal(ping.result.tools.length, 15, '坏行之后 server 仍应正常应答')
})

function c_root(t) {
  // 独立的 books 根：书必须建在 server 的 --root 里，e2e 才是真路径
  const dir = mkdtempSync(join(tmpdir(), 'nf-mcp-e2e-root-'))
  t.after(() => rmSync(dir, { recursive: true, force: true }))
  return dir
}
