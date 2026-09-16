/**
 * novelist MCP 测试（G1，v0.8.0）：fs 适配层（根安全+DSH 语义）+ 工具全链（走适配器）
 * + MCP 协议层（handler：initialize/tools/prompts/错误通道/通知静默）。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, writeFileSync, symlinkSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { createNodeFsAdapter } from '../fs-adapter.mjs'
import { createMcpHandler } from '../handler.mjs'
import { _internals } from '../../lib/novelist.js'

const { TOOLS } = _internals

// ---------------------------------------------------------------- 适配层：根安全

test('适配层：书库根为空直接拒（启动硬前置）', () => {
  assert.throws(() => createNodeFsAdapter(''), /书库根为空/)
  assert.throws(() => createNodeFsAdapter(null), /书库根为空/)
})

test('适配层：根外绝对路径被拒；.. 逃逸被拒；根内通过', async () => {
  const base = mkdtempSync(path.join(tmpdir(), 'nf-mcp-sec-'))
  try {
    const root = path.join(base, 'root')
    mkdirSync(root, { recursive: true })
    const outside = path.join(base, 'outside.txt')
    writeFileSync(outside, 'x', 'utf8')
    const fs = createNodeFsAdapter(root)
    await assert.rejects(() => fs.resolve(outside), /路径越界/)
    await assert.rejects(() => fs.resolve(path.join(root, '..', 'outside.txt')), /路径越界/)
    await assert.rejects(() => fs.readText(outside), /路径越界/)
    await assert.rejects(() => fs.writeText(outside, 'y'), /路径越界/)
    const ok = await fs.resolve(path.join(root, 'books', 'a'))
    assert.equal(ok, path.resolve(root, 'books', 'a'))
  } finally { rmSync(base, { recursive: true, force: true }) }
})

test('适配层：symlink 指出根外被拒（realpath 防线）', async () => {
  const base = mkdtempSync(path.join(tmpdir(), 'nf-mcp-sym-'))
  try {
    const root = path.join(base, 'root')
    mkdirSync(path.join(root, 'books'), { recursive: true })
    const secret = path.join(base, 'secret.txt')
    writeFileSync(secret, 's', 'utf8')
    try { symlinkSync(secret, path.join(root, 'books', 'link.txt')) } catch { return } // 无符号链接权限的平台跳过
    const fs = createNodeFsAdapter(root)
    await assert.rejects(() => fs.resolve(path.join(root, 'books', 'link.txt')), /路径越界/)
    await assert.rejects(() => fs.readText(path.join(root, 'books', 'link.txt')), /路径越界/)
  } finally { rmSync(base, { recursive: true, force: true }) }
})

test('适配层：根内目录名以 .. 开头不误杀（精确逃逸判定）', async () => {
  const base = mkdtempSync(path.join(tmpdir(), 'nf-mcp-dot-'))
  try {
    const root = path.join(base, 'root')
    const dotDir = path.join(root, '..stash')
    mkdirSync(dotDir, { recursive: true })
    const fs = createNodeFsAdapter(root)
    const p = await fs.resolve(dotDir)
    assert.equal(p, path.resolve(dotDir))
  } finally { rmSync(base, { recursive: true, force: true }) }
})

// ---------------------------------------------------------------- 适配层：DSH fs 语义

test('适配层：stat 缺失→null；writeText 自动建父目录；listDir 出 {name,kind}', async () => {
  const base = mkdtempSync(path.join(tmpdir(), 'nf-mcp-sem-'))
  try {
    const fs = createNodeFsAdapter(base)
    assert.equal(await fs.stat(path.join(base, 'none.json')), null)
    const deep = path.join(base, 'books', 'demo', 'project.json')
    await fs.writeText(deep, '{"ok":true}')
    const st = await fs.stat(deep)
    assert.ok(st && st.size > 0)
    const entries = await fs.listDir(path.join(base, 'books'))
    assert.deepEqual(entries.map((e) => e.name), ['demo'])
    assert.equal(entries[0].kind, 'dir')
    assert.equal(await fs.readText(deep), '{"ok":true}')
    // processPath = 真实路径直通（os-append 臂可用）
    assert.equal(await fs.processPath(deep), path.resolve(deep))
  } finally { rmSync(base, { recursive: true, force: true }) }
})

// ---------------------------------------------------------------- lib 导出面

test('lib 导出面：SECTION 已入 _internals（MCP prompts 同源）', () => {
  assert.ok(_internals.SECTION, 'SECTION 必须导出（MCP guide 走同源，禁复制防漂移）')
  assert.equal(_internals.SECTION.name, 'novelist-guide')
  assert.ok(typeof _internals.SECTION.text === 'string' && _internals.SECTION.text.length > 0)
})

// ---------------------------------------------------------------- 工具全链（经适配器）

test('工具全链：init→outline→chapter→verify→count 全走适配器；根外 init 被拦', async () => {
  const base = mkdtempSync(path.join(tmpdir(), 'nf-mcp-chain-'))
  try {
    const fs = createNodeFsAdapter(base)
    const exec = { agent: { ctx: { get: (k) => (k === 'fs' ? fs : undefined) } } }
    const call = (name, args) => TOOLS.find((t) => t.name === name).execute(args, exec)

    const dir = path.join(base, 'books', 'demo').replace(/\\/g, '/')
    const init = await call('novel_init', { book_dir: dir, title: '测试书', genre: 'xuanyi', logline: '一句话' })
    assert.equal(init.ok, true)
    assert.ok(init.created.includes('project.json'))

    await call('novel_outline', { book_dir: dir, op: 'write', volume: 1, chapter_no: 1, entry: { title: '开篇', goal: 'g', hook: 'h', word_min: 5, word_max: 100, differentiation: '与榜单头部不同：X' } })
    const ch = await call('novel_chapter', { book_dir: dir, ch: 1, title: '开篇', text: '他推开那扇门，里面空无一人。'.repeat(3), seeds: [{ id: 'F1', name: '空屋', due_ch: 3 }] })
    assert.equal(ch.ok, true)
    const verify = await call('novel_verify', { book_dir: dir })
    assert.equal(verify.ok, true)
    assert.deepEqual(verify.issues, [])
    const count = await call('novel_count', { file: dir + '/manuscript/chapter_001.md' })
    assert.ok(count.han > 0, 'count 的 file 模式在根内正常')

    // 根外一律拒：init 圈外 book_dir / count 圈外 file（提示注入与幻觉指路统一防线）
    const outside = path.join(base, '..', 'nf-mcp-outside-book')
    await assert.rejects(() => call('novel_init', { book_dir: outside, title: 'x', genre: 'x', logline: 'x' }), /路径越界/)
    const secretFile = path.join(path.parse(base).dir, 'nf-mcp-secret.txt')
    writeFileSync(secretFile, '圈外文件', 'utf8')
    await assert.rejects(() => call('novel_count', { file: secretFile }), /路径越界/)
    rmSync(secretFile, { force: true })
  } finally { rmSync(base, { recursive: true, force: true }) }
})

// ---------------------------------------------------------------- MCP 协议层（handler）

async function makeHandler(base) {
  const fs = createNodeFsAdapter(base)
  return {
    handler: createMcpHandler({ adapter: fs, TOOLS, SECTION: _internals.SECTION, serverInfo: { name: 'novelist', version: 'test' } }),
    exec: { agent: { ctx: { get: (k) => (k === 'fs' ? fs : undefined) } } },
  }
}

const req = (id, method, params) => JSON.stringify({ jsonrpc: '2.0', id, method, params })

test('协议：initialize 结构与版本协商（支持清单内回显，清单外回退）', async () => {
  const base = mkdtempSync(path.join(tmpdir(), 'nf-mcp-proto-'))
  try {
    const { handler } = await makeHandler(base)
    const r1 = await handler.handleLine(req(1, 'initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 't', version: '0' } }))
    assert.equal(r1.result.protocolVersion, '2025-06-18')
    assert.ok(r1.result.capabilities.tools)
    assert.ok(r1.result.capabilities.prompts)
    assert.equal(r1.result.serverInfo.name, 'novelist')
    const r2 = await handler.handleLine(req(2, 'initialize', { protocolVersion: '2099-01-01' }))
    assert.equal(r2.result.protocolVersion, '2025-06-18', '未知版本回退到支持的最新版')
  } finally { rmSync(base, { recursive: true, force: true }) }
})

test('协议：tools/list 出 12 工具带 inputSchema；tools/call 走 render 渲染', async () => {
  const base = mkdtempSync(path.join(tmpdir(), 'nf-mcp-tools-'))
  try {
    const { handler } = await makeHandler(base)
    const listed = await handler.handleLine(req(1, 'tools/list', {}))
    assert.equal(listed.result.tools.length, TOOLS.length)
    assert.equal(listed.result.tools.length, 12)
    const cnt = listed.result.tools.find((t) => t.name === 'novel_count')
    assert.ok(cnt.inputSchema.properties.text, 'inputSchema 来自 lib parameters')

    const called = await handler.handleLine(req(2, 'tools/call', { name: 'novel_count', arguments: { text: '你好世界' } }))
    assert.equal(called.result.isError, false)
    assert.equal(called.result.content[0].type, 'text')
    assert.ok(called.result.content[0].text.includes('4'), 'render 渲染汉字计数')
  } finally { rmSync(base, { recursive: true, force: true }) }
})

test('协议：执行错误走 isError 通道；未知工具/未知方法走 JSON-RPC error', async () => {
  const base = mkdtempSync(path.join(tmpdir(), 'nf-mcp-err-'))
  try {
    const { handler } = await makeHandler(base)
    const bad = await handler.handleLine(req(1, 'tools/call', { name: 'novel_init', arguments: { book_dir: path.join(base, 'a'), title: 't', genre: 'g', logline: 'l' } }))
    assert.equal(bad.result.isError, false)
    const dup = await handler.handleLine(req(2, 'tools/call', { name: 'novel_init', arguments: { book_dir: path.join(base, 'a'), title: 't', genre: 'g', logline: 'l' } }))
    assert.equal(dup.result.isError, true, '重复建书=业务错误入 result.isError')
    assert.ok(dup.result.content[0].text.includes('书已存在'))

    const unknownTool = await handler.handleLine(req(3, 'tools/call', { name: 'nope', arguments: {} }))
    assert.equal(unknownTool.error.code, -32602)
    const unknownMethod = await handler.handleLine(req(4, 'cards/shuffle', {}))
    assert.equal(unknownMethod.error.code, -32601)
  } finally { rmSync(base, { recursive: true, force: true }) }
})

test('协议：prompts/list/get 走 novelist-guide 同源全文；通知与坏行静默（无响应）', async () => {
  const base = mkdtempSync(path.join(tmpdir(), 'nf-mcp-prompts-'))
  try {
    const { handler } = await makeHandler(base)
    const pl = await handler.handleLine(req(1, 'prompts/list', {}))
    assert.equal(pl.result.prompts[0].name, 'novelist-guide')
    const pg = await handler.handleLine(req(2, 'prompts/get', { name: 'novelist-guide' }))
    const text = pg.result.messages[0].content.text
    assert.equal(pg.result.messages[0].role, 'user')
    assert.ok(text.includes('novelist-guide v'), 'guide 全文与 lib 同源（禁复制）')
    const badPrompt = await handler.handleLine(req(3, 'prompts/get', { name: 'other' }))
    assert.equal(badPrompt.error.code, -32602)

    assert.equal(await handler.handleLine('{"jsonrpc":"2.0","method":"notifications/initialized"}'), null, '通知无响应')
    assert.equal(await handler.handleLine('   '), null, '空行无响应')
    assert.equal(await handler.handleLine('不是JSON'), null, '坏行无响应')
    assert.equal(await handler.handleLine('[{"jsonrpc":"2.0"}]'), null, 'MCP 不用批量，数组行忽略')
  } finally { rmSync(base, { recursive: true, force: true }) }
})
