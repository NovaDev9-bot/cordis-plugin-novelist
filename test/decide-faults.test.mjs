/**
 * decide-faults.test.mjs —— novel_decide 故障点回归（2026-09-19，挂账综合 #9）
 *
 * 为什么存在：总台账挂账"decision 重试去重/并发/全故障点未测（H4 只覆盖 chapter 事务）"。
 * 实测抓到两个真缺陷，本文件既是它们的修复回归、也锁住"不许再犯"：
 *   ① **部分应用**：旧实现"派生①（章状态）写盘 → 派生②（伏笔改期）才校验"——②抛错时
 *      status.json 已被改而裁决没落任何档，verify 也看不见。修法＝全部校验先行。
 *   ② **同参重交重复落档**：novel_chapter 的 decision/hook 在 S8 已接内容判等幂等
 *      （appendTapeOnce），novel_decide 是同一写入形状却没接——重交一次就多一条裁决。
 * 并发用例走真子进程工装（同 realfs.test.mjs 的理由：进程内队列会掩盖跨进程互斥）。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createNodeFsAdapter } from '../mcp/fs-adapter.mjs'
import { _internals } from '../lib/novelist.js'

const { TOOLS } = _internals
const WORKER = fileURLToPath(new URL('./fixtures/lock-worker.mjs', import.meta.url))

/** 进程内调用（校验/幂等用例——单进程语义，不需要真子进程） */
function bench(t) {
  const root = mkdtempSync(join(tmpdir(), 'nf-decide-'))
  t.after(() => rmSync(root, { recursive: true, force: true }))
  const real = createNodeFsAdapter(root)
  const exec = { agent: { ctx: { get: (k) => (k === 'fs' ? real : undefined) } } }
  const call = (n, args) => TOOLS.find((x) => x.name === n).execute(args, exec)
  const dir = join(root, 'books', 'decide')
  return { root, dir, call }
}
const tapeOf = (dir) => existsSync(join(dir, 'editorial', 'events-tape.jsonl'))
  ? readFileSync(join(dir, 'editorial', 'events-tape.jsonl'), 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l))
  : []
const eventsOf = (dir) => existsSync(join(dir, 'events.jsonl'))
  ? readFileSync(join(dir, 'events.jsonl'), 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l))
  : []

test('校验先行：派生②（未知伏笔）报错时，派生①（章状态）不许已写盘', async (t) => {
  const b = bench(t)
  await b.call('novel_init', { book_dir: b.dir, title: 'decide 故障台', genre: 'dushi', logline: 'L' })
  // 章状态合法 + 伏笔 id 不存在：旧实现会把 status.json 先改掉，然后才在②处炸
  await assert.rejects(
    () => b.call('novel_decide', { book_dir: b.dir, ruling: 'ch1 细纲通过', actor: 'Owner', ch: 1, status: '已审', foreshadow_id: '不存在', due_ch: 9 }),
    /伏笔不存在/,
  )
  // 校验先行后 status.json 可能根本没被创建（这正是要的行为）
  const st = existsSync(join(b.dir, 'status.json')) ? JSON.parse(readFileSync(join(b.dir, 'status.json'), 'utf8')) : {}
  assert.equal(st['1'] ?? '草稿', '草稿', 'status.json 不许在半途被改（部分应用＝无回执的脏状态）')
  assert.equal(eventsOf(b.dir).filter((e) => e.op === 'owner_ruling').length, 0, '裁决不许已落事件账')
  assert.equal(tapeOf(b.dir).filter((e) => e.kind === 'decision').length, 0, '裁决不许已落事件带')
})

test('同参重交幂等：第二次调用返回原 id 且不重复落档', async (t) => {
  const b = bench(t)
  await b.call('novel_init', { book_dir: b.dir, title: 'decide 幂等台', genre: 'dushi', logline: 'L' })
  const args = { book_dir: b.dir, ruling: 'ch1 细纲通过；F1 改期到 ch9', actor: 'Owner', ch: 1, status: '已审' }
  const first = await b.call('novel_decide', args)
  const again = await b.call('novel_decide', args)
  assert.equal(again.id, first.id, '同参重交必须返回同一条裁决')
  assert.equal(again.deduped, true, '重交要明示 deduped（不许装成新裁决）')
  assert.equal(tapeOf(b.dir).filter((e) => e.kind === 'decision' && !e.supersedes).length, 1, '事件带只许一条')
  assert.equal(eventsOf(b.dir).filter((e) => e.op === 'owner_ruling').length, 1, '事件账只许一条 owner_ruling')
})

test('不同裁决同章不误伤：内容不同就各落各的', async (t) => {
  const b = bench(t)
  await b.call('novel_init', { book_dir: b.dir, title: 'decide 区分台', genre: 'dushi', logline: 'L' })
  const a = await b.call('novel_decide', { book_dir: b.dir, ruling: 'ch1 细纲通过，按第一方案走', actor: 'Owner', ch: 1, status: '已审' })
  // 合法迁移只有一条路可走时，第二条只能改裁决内容、状态维持（用不带动 status 的调用）
  const c = await b.call('novel_decide', { book_dir: b.dir, ruling: 'ch1 细纲改按第二方案走', actor: 'Owner', ch: 1 })
  assert.notEqual(a.id, c.id)
  assert.equal(tapeOf(b.dir).filter((e) => e.kind === 'decision' && !e.supersedes).length, 2, '两条不同裁决都要在')
})

test('跨进程并发：两个真进程同时裁决不同的章，双双落地互不吞并', async (t) => {
  const root = mkdtempSync(join(tmpdir(), 'nf-decide-cc-'))
  t.after(() => rmSync(root, { recursive: true, force: true }))
  const dir = join(root, 'books', 'cc')
  mkdirSync(dir, { recursive: true })
  await TOOLS.find((x) => x.name === 'novel_init').execute(
    { book_dir: dir, title: '并发裁决台', genre: 'dushi', logline: 'L' },
    { agent: { ctx: { get: (k) => (k === 'fs' ? createNodeFsAdapter(root) : undefined) } } },
  )
  const startFile = join(root, 'barrier')
  const opts = (ch) => ({ root, dir, startFile, args: { book_dir: dir, ruling: '并发裁决 ch' + ch, actor: '主编', ch, status: '已审' } })
  const workers = [1, 2].map((ch) => {
    const child = spawn(process.execPath, [WORKER, 'decide', JSON.stringify(opts(ch))], { stdio: ['ignore', 'pipe', 'pipe'] })
    t.after(() => { try { child.kill('SIGKILL') } catch (e) { /* 已退出 */ } })
    return { child, ch, buf: '', queue: [], waiters: [] }
  })
  const next = (w, timeoutMs = 20_000) => new Promise((res, rej) => {
    const pump = () => {
      let i
      while ((i = w.buf.indexOf('\n')) >= 0) {
        const line = w.buf.slice(0, i); w.buf = w.buf.slice(i + 1)
        try { w.queue.push(JSON.parse(line)) } catch (e) { continue }
      }
      if (w.queue.length) { res(w.queue.shift()); return }
      const timer = setTimeout(() => rej(new Error('worker 超时')), timeoutMs)
      w.waiters.push(() => { clearTimeout(timer); res(w.queue.shift()) })
    }
    w.child.stdout.on('data', (d) => { w.buf += d; pump() })
    pump()
  })
  for (const w of workers) await next(w)          // 等 ready
  writeFileSync(startFile, 'go', 'utf8')          // 栅栏：两个进程"同时"动手
  const done = await Promise.all(workers.map((w) => next(w)))
  for (const d of done) assert.equal(d.ok, true, JSON.stringify(d))
  const st = JSON.parse(readFileSync(join(dir, 'status.json'), 'utf8'))
  assert.equal(st['1'], '已审', 'ch1 的裁决不丢')
  assert.equal(st['2'], '已审', 'ch2 的裁决不丢')
  assert.equal(tapeOf(dir).filter((e) => e.kind === 'decision').length, 2, '两条裁决都在事件带上')
})
