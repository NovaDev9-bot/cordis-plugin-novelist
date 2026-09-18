/**
 * 真实独立 OS 进程工装（测试用）：在**另一个 node 进程**里跑 novelist 工具或锁原语。
 *
 * 存在理由：跨进程互斥只能由"真的两个进程"验证——同一进程里的 Promise.all 会被进程内队列
 * 掩盖（队列串行 ≠ 跨进程互斥）。本工装与父进程只靠 stdout 的 JSON 行通信，每行一个事件：
 *   {event:'ready'}                        —— 已就绪，等栅栏
 *   {event:'acquired'|'released'|'done'}    —— 阶段结果
 *   {event:'error', message, code}          —— 失败（退出码 1）
 * 起跑栅栏（startFile）：父进程落文件后子进程才动手，把"同时"做成确定性的，不靠 sleep 猜。
 *
 * 用法：node lock-worker.mjs <init|chapter|hold> '<json opts>'
 */
import { existsSync } from 'node:fs'
import { createNodeFsAdapter } from '../../mcp/fs-adapter.mjs'
import { _internals } from '../../lib/novelist.js'

const { TOOLS } = _internals

const [cmd, rawOpts] = process.argv.slice(2)
const opts = JSON.parse(rawOpts || '{}')
const realFs = createNodeFsAdapter(opts.root)
// 写放大（可选）：给每次 writeText 加一点延迟，把"临界区"拉长到远超进程间启动抖动——
// 并发用例靠这个变确定（抖动 3-15ms vs 临界区几百 ms），不是靠 sleep 猜。
const fs = opts.writeDelayMs
  ? { ...realFs, writeText: async (p, s) => { await new Promise((r) => setTimeout(r, opts.writeDelayMs)); return realFs.writeText(p, s) } }
  : realFs
const exec = { agent: { ctx: { get: (k) => (k === 'fs' ? fs : undefined) } } }
const call = (n, args) => TOOLS.find((x) => x.name === n).execute(args, exec)

/** 写一行并**等 flush 完成**——崩溃用例要在 exit 前确保父进程真的收到了这行。 */
const emit = (obj) => new Promise((res) => process.stdout.write(JSON.stringify(obj) + '\n', res))

async function waitBarrier(file) {
  if (!file) return
  while (!existsSync(file)) await new Promise((r) => setTimeout(r, 3))
}

try {
  if (cmd === 'init') {
    await emit({ event: 'ready' })
    await waitBarrier(opts.startFile)
    const out = await call('novel_init', { book_dir: opts.dir, title: opts.title, genre: 'dushi', logline: 'L' })
    await emit({ event: 'done', ok: out.ok, title: opts.title, book_dir: out.book_dir })
  } else if (cmd === 'chapter') {
    await emit({ event: 'ready' })
    await waitBarrier(opts.startFile)
    const out = await call('novel_chapter', { book_dir: opts.dir, ch: opts.ch, title: '第' + opts.ch + '章', text: opts.text, cast: opts.cast })
    await emit({ event: 'done', ok: out.ok, ch: out.ch, rev: out.rev })
  } else if (cmd === 'hold') {
    const lock = await _internals.acquireFileLock(fs, opts.dir, {
      waitMs: opts.waitMs || 5_000,
      staleMs: opts.staleMs || 30_000,
      retryMs: 10,
      heartbeatMs: opts.heartbeatMs,
    })
    await emit({ event: 'acquired', mode: lock.mode, token: lock.token })
    if (opts.exitHard) process.exit(3) // 模拟崩溃：不释放、不清理（锁文件留在盘上）
    await new Promise((r) => setTimeout(r, opts.holdMs || 1_000))
    await lock.release()
    await emit({ event: 'released' })
  } else {
    throw new Error('未知工装命令：' + cmd)
  }
} catch (e) {
  await emit({ event: 'error', message: e && e.message, code: (e && e.code) || null })
  process.exitCode = 1
}
