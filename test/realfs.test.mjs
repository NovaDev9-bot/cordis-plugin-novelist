// 批A1/A2 真机验收 —— 真实文件系统（不走 Map shim）：node:fs 临时目录 + 可编程故障注入。
// 存在理由：Map shim 覆盖不到真机分支——O_APPEND 追加、temp+rename 原子发布、真实快照文件、
// 真实 listDir。半提交缺陷（修订中途账务写失败 → 正文已换而回执仍 done）正是在真实工作区
// 动态验证中暴露的，故回归必须双路：本文件（真实 FS）+ novelist.test.mjs（Map shim 快跑）。
import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, rmSync, readFileSync, writeFileSync, existsSync, readdirSync, statSync, utimesSync } from 'node:fs'
import { spawn } from 'node:child_process'
import { tmpdir } from 'node:os'
import { fileURLToPath } from 'node:url'
import { join } from 'node:path'
import { createNodeFsAdapter } from '../mcp/fs-adapter.mjs'
import { _internals } from '../lib/novelist.js'

const { TOOLS } = _internals

/** DSH exec 垫片（工具执行路径只认 exec.agent.ctx.get('fs')）。 */
const execOf = (fs) => ({ agent: { ctx: { get: (k) => (k === 'fs' ? fs : undefined) } } })

// ---------------------------------------------------------------- 真子进程工装（跨进程用例）

const WORKER = fileURLToPath(new URL('./fixtures/lock-worker.mjs', import.meta.url))

/**
 * 起一个真子进程工装（见 test/fixtures/lock-worker.mjs），返回 { child, next, exited }。
 * next() 取下一行 JSON 事件（先到先取；超时抛错，不静默等）。
 */
function worker(t, cmd, opts) {
  const child = spawn(process.execPath, [WORKER, cmd, JSON.stringify(opts)], { stdio: ['ignore', 'pipe', 'pipe'] })
  t.after(() => { try { child.kill('SIGKILL') } catch (e) { /* 已退出 */ } })
  let buf = ''
  const queue = []
  const waiters = []
  const pump = () => {
    let i
    while ((i = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, i)
      buf = buf.slice(i + 1)
      let msg = null
      try { msg = JSON.parse(line) } catch (e) { continue }
      const w = waiters.shift()
      if (w) w(msg)
      else queue.push(msg)
    }
  }
  child.stdout.on('data', (d) => { buf += d; pump() })
  let err = ''
  child.stderr.on('data', (d) => { err += d })
  const next = (timeoutMs = 20_000) => {
    if (queue.length) return Promise.resolve(queue.shift())
    return new Promise((res, rej) => {
      const w = (m) => { clearTimeout(timer); res(m) }
      const timer = setTimeout(() => {
        const i = waiters.indexOf(w)
        if (i >= 0) waiters.splice(i, 1)
        rej(new Error('子进程工装超时（' + timeoutMs + 'ms 内没收到下一行事件）；stderr=' + err.slice(0, 400)))
      }, timeoutMs)
      waiters.push(w)
    })
  }
  const exited = new Promise((res) => child.on('exit', (code) => res(code)))
  return { child, next, exited }
}

/** 真机工装：真实 fs 适配器 + 可选故障注入（默认不注入）。返回 { dir, call, fs, txnPath, msPath }。 */
function bench(t, { faultOn = null } = {}) {
  const root = mkdtempSync(join(tmpdir(), 'nf-txn-'))
  t.after(() => rmSync(root, { recursive: true, force: true }))
  const real = createNodeFsAdapter(root)
  const state = { fault: faultOn }
  const fs = {
    ...real,
    writeText: async (p, s) => {
      // 注意：真机适配器返回 Windows 反斜杠路径，匹配用正则不能用 endsWith('/...')
      if (state.fault && state.fault.test(String(p))) throw new Error('注入故障：账务写入失败（真实 FS 路径）')
      return real.writeText(p, s)
    },
  }
  const exec = () => ({ agent: { ctx: { get: (k) => (k === 'fs' ? fs : undefined) } } })
  const dir = join(root, 'books', 'txn')
  return {
    dir, root, state, fs,
    call: (n, args) => TOOLS.find((x) => x.name === n).execute(args, exec()),
    txnPath: join(dir, 'editorial', 'txn', 'chapter_001.json'),
    msPath: join(dir, 'manuscript', 'chapter_001.md'),
    read: (p) => readFileSync(join(dir, p), 'utf8'),
  }
}

test('A1 真机: 中断（伏笔账写失败）留 pending 回执，恢复重交补齐账务且不翻快照', async (t) => {
  const b = bench(t, { faultOn: /foreshadows\.json$/ })
  const A = '夜里灯下有人影一动不动，门被推开了。'.repeat(4)

  await assert.rejects(
    () => b.call('novel_chapter', { book_dir: b.dir, ch: 1, title: '开篇', text: A, seeds: [{ id: 'F1', name: '空屋' }] }),
    /注入故障/,
    '账务写失败必须让整次提交失败（不静默）',
  )
  assert.ok(existsSync(b.msPath), '正文已落盘')
  assert.equal(JSON.parse(readFileSync(b.txnPath, 'utf8')).status, 'pending', '中断后回执必须显式 pending（不得残留 done）')

  const v1 = await b.call('novel_verify', { book_dir: b.dir })
  assert.ok(v1.issues.some((s) => s.includes('半提交') && s.includes('pending')), 'verify 报 pending 半提交：' + JSON.stringify(v1.issues))

  // 恢复：解除故障，同文本重交 → 补账面（伏笔账此时才真正落盘），回执收束为 done
  b.state.fault = null
  const r = await b.call('novel_chapter', { book_dir: b.dir, ch: 1, title: '开篇', text: A, seeds: [{ id: 'F1', name: '空屋' }] })
  assert.equal(r.ok, true)
  assert.equal(r.deduped, true, '同参重试标记 deduped')
  assert.equal(r.rev, 1, '重试不翻 rev')
  const done = JSON.parse(readFileSync(b.txnPath, 'utf8'))
  assert.equal(done.status, 'done')
  assert.equal(done.content_hash, r.content_hash)
  assert.equal(JSON.parse(b.read('foreshadows.json')).foreshadows.length, 1, '恢复后伏笔账补齐（中断时未写成）')
  assert.equal(existsSync(join(b.dir, 'versions')), false, '同参重试不建版本快照（真机分支）')
})

test('A1 真机: 修订翻版本（快照 v1 = 旧稿逐字）＋事件账不重复记账＋hash 漂移可抓', async (t) => {
  const b = bench(t)
  const A = '夜里灯下有人影一动不动，门被推开了。'.repeat(4)
  const B = A + '修订一句。'

  const r1 = await b.call('novel_chapter', { book_dir: b.dir, ch: 1, title: '开篇', text: A })
  assert.equal(r1.rev, 1)
  const r2 = await b.call('novel_chapter', { book_dir: b.dir, ch: 1, title: '开篇', text: B, expected_rev: 1 })
  assert.equal(r2.rev, 2)
  assert.notEqual(r2.content_hash, r1.content_hash)
  assert.equal(b.read('versions/chapter_001.v1.md'), A, '快照 v1 = 旧稿逐字')

  // 同文本再交（重试语义）：rev 不回退、不新增快照、事件账不重复
  const r3 = await b.call('novel_chapter', { book_dir: b.dir, ch: 1, title: '开篇', text: B })
  assert.equal(r3.deduped, true)
  assert.equal(r3.rev, 2)
  assert.deepEqual(readdirSync(join(b.dir, 'versions')).sort(), ['chapter_001.v1.md'], '重试不新增快照')
  const commits = b.read('events.jsonl').trim().split('\n').map((l) => JSON.parse(l)).filter((e) => e.op === 'chapter_commit')
  assert.equal(commits.length, 2, '两次真提交两条 chapter_commit（重试不重复记账，真机 O_APPEND 分支）')
  assert.equal(commits.every((e) => typeof e.content_hash === 'string'), true, 'commit 事件带正文哈希')

  const v2 = await b.call('novel_verify', { book_dir: b.dir })
  assert.equal(v2.issues.some((s) => s.includes('半提交') || s.includes('content_hash')), false, '干净态零误报：' + JSON.stringify(v2.issues))

  // 绕过工具直改正文 → verify 抓 hash 漂移（正是"回执显示完成而磁盘不是那版"的探测）
  writeFileSync(b.msPath, B + '外部手工改了一句。', 'utf8')
  const v3 = await b.call('novel_verify', { book_dir: b.dir })
  assert.ok(v3.issues.some((s) => s.includes('正文版本') && s.includes('content_hash')), '报 hash 漂移：' + JSON.stringify(v3.issues))
})

test('A1 真机: stale expected_rev 写入前拒绝且零副作用', async (t) => {
  const b = bench(t)
  await b.call('novel_chapter', { book_dir: b.dir, ch: 1, title: '开篇', text: '第一版正文。'.repeat(5) })
  const beforeMs = readFileSync(b.msPath, 'utf8')
  const beforeTxn = readFileSync(b.txnPath, 'utf8')

  await assert.rejects(
    () => b.call('novel_chapter', { book_dir: b.dir, ch: 1, title: '开篇', text: '并发冲突稿。'.repeat(6), expected_rev: 0 }),
    /expected_rev/,
  )
  assert.equal(readFileSync(b.msPath, 'utf8'), beforeMs, '正文未动')
  assert.equal(readFileSync(b.txnPath, 'utf8'), beforeTxn, '回执未动（护栏在立 pending 之前）')
  assert.equal(existsSync(join(b.dir, 'versions')), false, '未建快照')
})

test('A2 真机: 事实贡献账落盘（append-only）＋last_seen 回退＋评分版本过滤', async (t) => {
  const b = bench(t)
  const V1 = '他推开了那扇门，纸角又掀了一下。'.repeat(4)
  mkdirSync(b.dir, { recursive: true })
  writeFileSync(join(b.dir, 'characters.json'), JSON.stringify({ characters: [{ name: '甲' }, { name: '乙' }] }))
  const chars = () => JSON.parse(readFileSync(join(b.dir, 'characters.json'), 'utf8')).characters
  const facts = (f) => JSON.parse(readFileSync(join(b.dir, 'editorial', 'facts', f), 'utf8'))

  // 三章：ch1 甲乙 / ch2 甲 / ch3 乙
  await b.call('novel_chapter', { book_dir: b.dir, ch: 1, title: '一', text: V1, cast: ['甲', '乙'] })
  await b.call('novel_chapter', { book_dir: b.dir, ch: 2, title: '二', text: '第二章正文。'.repeat(6), cast: ['甲'] })
  await b.call('novel_chapter', { book_dir: b.dir, ch: 3, title: '三', text: '第三章正文。'.repeat(6), cast: ['乙'] })
  assert.deepEqual(facts('chapter_003.v1.json').cast, ['乙'], '真机落事实贡献账')
  assert.equal(chars().find((c) => c.name === '乙').last_seen_ch, 3)

  // 改稿删乙 → 回退到最近有效出场；旧版贡献账留档
  await b.call('novel_chapter', { book_dir: b.dir, ch: 3, title: '三', text: '第三章改稿：乙不再出场。'.repeat(6), cast: ['甲'], expected_rev: 1 })
  assert.equal(chars().find((c) => c.name === '乙').last_seen_ch, 1, '真机 last_seen 回退')
  assert.deepEqual(facts('chapter_003.v2.json').cast, ['甲'])
  assert.deepEqual(facts('chapter_003.v1.json').cast, ['乙'], '旧版贡献账保留（append-only）')

  // 评分版本过滤：判 ch1 的 v1 → 改稿升 v2 后默认不回旧判词
  const s1 = await b.call('novel_score', { book_dir: b.dir, op: 'record', ch: 1, dim: '钩子', score: 4, evidence: '纸角又掀了一下。', judge: '试读员' })
  assert.equal(s1.ok, true)
  assert.equal(s1.records[0].ch_rev, 1, '真机：判词绑录分时的 rev')
  assert.equal(typeof s1.records[0].content_hash, 'string', '真机：判词绑正文哈希')
  const rd1 = await b.call('novel_score', { book_dir: b.dir, op: 'read', ch: 1 })
  assert.equal(rd1.total, 1, '当前版判词可见')

  // 改稿升 v2 → 该判词变 stale，默认读不到（不冒充当前版结论）
  await b.call('novel_chapter', { book_dir: b.dir, ch: 1, title: '一', text: V1 + '改稿加一句。', expected_rev: 1 })
  const rd2 = await b.call('novel_score', { book_dir: b.dir, op: 'read', ch: 1 })
  assert.equal(rd2.total, 0, '改稿后旧判词默认不回')
  const rd3 = await b.call('novel_score', { book_dir: b.dir, op: 'read', ch: 1, include_stale: true })
  assert.equal(rd3.total, 1)
  assert.equal(rd3.records[0].stale, true, '真机标 stale 可查')
  assert.equal(rd3.records[0].ch_rev, 1, 'stale 判词保留原绑定版本')
})

test('E2 真机: novel_ask 一次查账（timeline/有效投影/ch 基准）', async (t) => {
  const b = bench(t)
  mkdirSync(b.dir, { recursive: true })
  writeFileSync(join(b.dir, 'characters.json'), JSON.stringify({ characters: [{ name: '甲' }] }))
  await b.call('novel_chapter', { book_dir: b.dir, ch: 1, title: '一', text: '第一章正文。'.repeat(6), cast: ['甲'], timeline_events: [{ time: '第一日', what: '入城' }] })
  await b.call('novel_chapter', { book_dir: b.dir, ch: 2, title: '二', text: '第二章正文。'.repeat(6), cast: ['甲'], timeline_events: [{ time: '第三日', what: '见官' }] })
  await b.call('novel_chapter', { book_dir: b.dir, ch: 5, title: '五', text: '第五章正文。'.repeat(6), cast: ['甲'], timeline_events: [{ time: '第九日', what: '结案' }] })

  const ask = await b.call('novel_ask', { book_dir: b.dir, q: '时间线' })
  assert.equal(ask.overview.timeline.length, 3, '真机 timeline 读取')
  const capped = await b.call('novel_ask', { book_dir: b.dir, q: '甲', ch: 2 })
  assert.equal(capped.matches[0].card.last_seen_ch, 2, '真机 ch=2 投影不报第 5 章出场')
  const sel = await b.call('novel_ask', { book_dir: b.dir, select: { kind: 'timeline', window: { from: 1, to: 2 } } })
  assert.deepEqual(sel.timeline.map((e) => e.ch), [1, 2], '真机结构化选择器窗口')
})

test('@last 调用在真实书目录持锁，而不是把别名当目录', async (t) => {
  const b = bench(t)
  await b.call('novel_init', { book_dir: b.dir, title: '别名', genre: 'dushi', logline: 'L' })
  const readText = b.fs.readText
  let observed = false
  b.fs.readText = async (p) => {
    if (String(p).endsWith('bible.json')) {
      observed = true
      assert.ok(existsSync(join(b.dir, '.novelist.lock')), '读取书账时真实目录必须持锁')
    }
    return readText(p)
  }
  await b.call('novel_bible', { book_dir: '@last', ch: 1, scope: 'all' })
  assert.ok(observed, '实际读到了设定账本')
  assert.equal(existsSync(join(b.dir, '.novelist.lock')), false)
})

// ---------------------------------------------------------------- 批R1 写门（真机）

test('批R1 真机: 写锁——持有期锁文件在位，释放即消失', async (t) => {
  const b = bench(t)
  mkdirSync(b.dir, { recursive: true })
  const lock = await _internals.acquireFileLock(b.fs, b.dir)
  assert.equal(lock.mode, 'file-lock', '有原生路径时必须走真正的文件锁，不能悄悄退化成进程内锁')
  assert.ok(existsSync(join(b.dir, '.novelist.lock')), '持有期锁文件必须在位')
  await lock.release()
  assert.ok(!existsSync(join(b.dir, '.novelist.lock')), '释放后锁文件必须消失（不留残留）')
})

test('批R1 真机: 写锁——第二个持有者等待超时，报可行动错误（不静默并发写）', async (t) => {
  const b = bench(t)
  mkdirSync(b.dir, { recursive: true })
  const held = await _internals.acquireFileLock(b.fs, b.dir)
  t.after(() => held.release())
  await assert.rejects(
    () => _internals.acquireFileLock(b.fs, b.dir, { waitMs: 80, staleMs: 60_000, retryMs: 10 }),
    /写锁等待超时/,
    '抢不到锁必须报错并指明锁文件位置，不能直接写下去',
  )
})

test('批R1 真机: 写锁——陈旧锁（持有者已死）被接管，不留永久死锁', async (t) => {
  const b = bench(t)
  mkdirSync(b.dir, { recursive: true })
  const lp = join(b.dir, '.novelist.lock')
  writeFileSync(lp, JSON.stringify({ pid: 999999, at: '2000-01-01T00:00:00.000Z' }), 'utf8')
  const old = new Date(Date.now() - 10 * 60 * 1000)
  utimesSync(lp, old, old)
  const lock = await _internals.acquireFileLock(b.fs, b.dir, { waitMs: 500, staleMs: 1000, retryMs: 10 })
  assert.equal(lock.mode, 'file-lock', '陈旧锁必须被接管，否则进程崩溃就永久锁死这本书')
  await lock.release()
})

test('批R1 真机: 写门——并发两章提交不丢更新（last_seen 两章都在）+ 无锁残留', async (t) => {
  const b = bench(t)
  await b.call('novel_init', { book_dir: b.dir, title: '并发', genre: 'dushi', logline: 'L' })
  writeFileSync(join(b.dir, 'characters.json'), JSON.stringify({ characters: [{ name: '小满' }] }))
  const A = '夜里灯下有人影一动不动，门被推开了。'.repeat(4)
  const B = '雨落在铁皮棚上，她数到第七下才开口说话。'.repeat(4)
  const cast = ['小满']
  await Promise.all([
    b.call('novel_chapter', { book_dir: b.dir, ch: 1, title: '一', text: A, cast }),
    b.call('novel_chapter', { book_dir: b.dir, ch: 2, title: '二', text: B, cast }),
  ])
  const chars = JSON.parse(b.read('characters.json'))
  const xm = chars.characters.find((c) => c.name === '小满')
  assert.equal(xm.last_seen_ch, 2, '两章串行落账后 last_seen 必须是 2——为 1 说明有一次读改写被覆盖（丢更新）')
  for (const n of ['001', '002']) {
    const rc = JSON.parse(b.read('editorial/txn/chapter_' + n + '.json'))
    assert.equal(rc.status, 'done', '第 ' + n + ' 章回执必须收束为 done')
  }
  assert.ok(!existsSync(join(b.dir, '.novelist.lock')), '全部写完后不许留锁文件')
})

// ---------------------------------------------------------------- 批R2 锁与 @last 可靠性

test('批R2 真机: @last 只在成功调用后更新（失败调用不得污染上次书目录）', async (t) => {
  const b = bench(t)
  _internals.resetLastBook()
  const good = join(b.root, 'books', 'good')
  const typo = join(b.root, 'books', 'typo-不存在')
  await b.call('novel_init', { book_dir: good, title: '甲', genre: 'dushi', logline: 'L' })
  await b.call('novel_chapter', { book_dir: good, ch: 1, title: '一', text: '第一版正文。'.repeat(6) })

  // 失败调用：book_dir 指到不存在的书（requireBook 抛 E_NOT_FOUND）
  await assert.rejects(() => b.call('novel_bible', { book_dir: typo, ch: 1 }), /书目录为空或不存在/)

  // @last 必须仍指向上一本"成功用过"的书——失败调用把别名劫走＝下一次写进错书
  const viaLast = await b.call('novel_bible', { book_dir: '@last', ch: 1 })
  assert.equal(viaLast.ch, 1, '@last 仍须可解析')
  const cnt = await b.call('novel_count', { book_dir: '@last' })
  assert.equal(cnt.chapters, 1, '@last 必须落回上一本成功的书（而不是失败调用指过的目录）')
  assert.equal(cnt.book_dir, good.replace(/\\/g, '/'), '@last 解析结果＝上次成功的书目录（book_dir 回显为归一后的斜杠形式）')
})

test('批R2 真机: @last 按宿主上下文隔离（同工作区的多次取 fs 仍共享；另一个工作区不许继承）', async (t) => {
  const b = bench(t)
  _internals.resetLastBook()
  await b.call('novel_init', { book_dir: b.dir, title: '隔离', genre: 'dushi', logline: 'L' })

  // ① 同一工作区：DSH 的 fs 是 cordis Service，ctx.get('fs') 每次返回**新建 Proxy**
  //    （cordis lib/index.js:123 createTraceable → new Proxy(value, …)），调用方看到的对象身份不稳定。
  //    @last 必须照样记得这本书——按对象身份认上下文在这里会当场落空。
  const proxyA = new Proxy(b.fs, {})
  const proxyB = new Proxy(b.fs, {})
  const viaProxy = (proxy, n, args) => TOOLS.find((x) => x.name === n).execute(args, execOf(proxy))
  assert.equal((await viaProxy(proxyA, 'novel_count', { book_dir: '@last' })).book_dir, b.dir.replace(/\\/g, '/'), '同一工作区的另一个 fs 代理仍认这本"上次的书"')
  assert.equal((await viaProxy(proxyB, 'novel_count', { book_dir: '@last' })).book_dir, b.dir.replace(/\\/g, '/'), '再来一个代理（每次 ctx.get 都是新对象）照样认')

  // ② 另一个工作区（另一个根）：@last 不许继承（凭空继承＝跨工作区串书）
  const otherRoot = mkdtempSync(join(tmpdir(), 'nf-other-'))
  t.after(() => rmSync(otherRoot, { recursive: true, force: true }))
  const otherFs = createNodeFsAdapter(otherRoot)
  const callOther = (n, args) => TOOLS.find((x) => x.name === n).execute(args, execOf(otherFs))
  await assert.rejects(() => callOther('novel_bible', { book_dir: '@last', ch: 1 }), (e) => {
    assert.equal(e.code, 'E_NOT_FOUND', '另一个工作区没有"上次书目录"（got ' + e.message + '）')
    return true
  })
  // 该工作区自己成功用过一本之后，它自己的 @last 才生效，且不影响原工作区
  const otherBook = join(otherRoot, 'books', 'own')
  await callOther('novel_init', { book_dir: otherBook, title: '外', genre: 'dushi', logline: 'L' })
  assert.equal((await callOther('novel_count', { book_dir: '@last' })).book_dir, otherBook.replace(/\\/g, '/'), '本工作区的 @last 指向它自己那本')
  assert.equal((await b.call('novel_count', { book_dir: '@last' })).book_dir, b.dir.replace(/\\/g, '/'), '两个工作区的 @last 互不干扰')
})

test('批R2 真机: 目录别名归一——重复斜杠/尾斜杠/大小写变体落同一把锁与同一条队列', async (t) => {
  const b = bench(t)
  mkdirSync(b.dir, { recursive: true })
  const canon = b.dir.replace(/\\/g, '/')
  const dup = canon.replace('/books/', '/books//') // 重复斜杠（同一目录的另一种写法）
  // 大小写变体只在大小写不敏感的文件系统上才是同一本书；POSIX 上应视作两本书（不归一）
  const caseAlias = process.platform === 'win32' ? canon.slice(0, -3) + 'TXN' : null
  const aliases = [canon + '/', dup, caseAlias].filter(Boolean)

  // ① 同一把锁：规范路径持有期间，任何别名写法都不许再持有（真目录验证，不出现两把锁并存）
  const held = await _internals.acquireFileLock(b.fs, canon, { waitMs: 60, staleMs: 60_000, retryMs: 10 })
  assert.equal(held.mode, 'file-lock')
  for (const alias of aliases) {
    await assert.rejects(
      () => _internals.acquireFileLock(b.fs, alias, { waitMs: 60, staleMs: 60_000, retryMs: 10 }),
      /写锁等待超时/,
      '别名写法必须落同一把锁：' + alias,
    )
  }
  assert.equal(readdirSync(b.dir).filter((n) => n.includes('novelist.lock')).length, 1, '同一本书只许一把锁文件（不出现两把并存）')
  await held.release()

  // ② 同一条队列：同一本书的别名写法不许各铸一条队列（各铸一条＝两个调用交错读写＝丢更新）
  const order = []
  const task = (tag, ms) => () => new Promise((res) => {
    order.push(tag + '-开始')
    setTimeout(() => { order.push(tag + '-结束'); res(tag) }, ms)
  })
  await Promise.all([canon, ...aliases].map((d, i) => _internals.enqueueBook(d, task(['A', 'B', 'C', 'D'][i], i === 0 ? 40 : 5))))
  assert.deepEqual(order, ['A-开始', 'A-结束', 'B-开始', 'B-结束', 'C-开始', 'C-结束', ...(caseAlias ? ['D-开始', 'D-结束'] : [])], '别名必须共用同一条队列')
})

test('批R2 真机: 释放校验所有权——锁被他人接管后，旧持有者释放不得删掉新锁', async (t) => {
  const b = bench(t)
  mkdirSync(b.dir, { recursive: true })
  const lp = join(b.dir, '.novelist.lock')
  const mine = await _internals.acquireFileLock(b.fs, b.dir, { waitMs: 100, staleMs: 60_000, retryMs: 10 })
  assert.equal(mine.mode, 'file-lock')
  const myToken = JSON.parse(readFileSync(lp, 'utf8')).token
  assert.equal(typeof myToken, 'string', '锁内容必须带持有者标识 token——没有它就无从校验"这把锁还是我的"')

  // 模拟接管：锁被删掉后由另一个持有者重建（旧持有者还在跑它那条长操作，之后才走到 release）
  rmSync(lp, { force: true })
  const theirs = await _internals.acquireFileLock(b.fs, b.dir, { waitMs: 100, staleMs: 60_000, retryMs: 10 })
  assert.equal(theirs.mode, 'file-lock', '接管者拿到锁')
  const theirToken = JSON.parse(readFileSync(lp, 'utf8')).token
  assert.notEqual(theirToken, myToken, '接管者的锁是另一把（token 不同）')

  // 旧持有者收尾：盲删＝删掉别人的互斥——两个进程此后同时以为自己在独占
  await mine.release()
  assert.ok(existsSync(lp), '旧持有者释放后，新持有者的锁文件必须还在')
  assert.equal(JSON.parse(readFileSync(lp, 'utf8')).token, theirToken, '留在盘上的仍是接管者那把锁（内容没被旧持有者动过）')

  // 正当持有者释放：锁必须消失（不留残留）
  await theirs.release()
  assert.ok(!existsSync(lp), '正当持有者释放后锁必须消失')
})

test('批R2 真机: 持有者还活着时，操作超过 staleMs 也不得被抢（按存活判定，不按 mtime）', async (t) => {
  const b = bench(t)
  mkdirSync(b.dir, { recursive: true })
  const lp = join(b.dir, '.novelist.lock')
  // 持有者＝本进程（确定活着）；把锁文件 mtime 推老，模拟"长操作期间没碰过锁文件"
  const held = await _internals.acquireFileLock(b.fs, b.dir, { waitMs: 100, staleMs: 50, retryMs: 5, heartbeatMs: 0 })
  const old = new Date(Date.now() - 10 * 60 * 1000)
  utimesSync(lp, old, old)

  await assert.rejects(
    () => _internals.acquireFileLock(b.fs, b.dir, { waitMs: 150, staleMs: 50, retryMs: 5, heartbeatMs: 0 }),
    /写锁等待超时/,
    '持有者活着却按 mtime 抢锁＝两个写者同时进场（拉长 staleMs 只是把窗口推远，不是解法）',
  )
  await held.release()
  assert.ok(!existsSync(lp), '原持有者仍能正常释放')
})

test('批R2 真机: 持有期心跳刷新锁文件（跨机/探不了活的持有者的活证据），释放后停手', async (t) => {
  const b = bench(t)
  mkdirSync(b.dir, { recursive: true })
  const lp = join(b.dir, '.novelist.lock')
  const held = await _internals.acquireFileLock(b.fs, b.dir, { waitMs: 100, staleMs: 9_000, heartbeatMs: 25 })
  assert.equal(held.mode, 'file-lock')
  const old = new Date(Date.now() - 60 * 60 * 1000)
  utimesSync(lp, old, old)
  await new Promise((r) => setTimeout(r, 120))
  assert.ok(statSync(lp).mtimeMs > Date.now() - 60_000, '持有期内 mtime 必须被心跳拉回新鲜（否则跨机持有者会被按年龄判成陈旧）')

  await held.release()
  assert.ok(!existsSync(lp), '释放后锁必须消失')
  await new Promise((r) => setTimeout(r, 120)) // 跨过 ≥3 个心跳周期
  assert.ok(!existsSync(lp), '释放后心跳必须停手（残留定时器会把锁文件"复活"——后来者以为有人持有，或误删）')
})

test('批R2 真机: 异机持有的锁按年龄判定（探不了它的 pid：新鲜不抢、陈旧接管）', async (t) => {
  const b = bench(t)
  mkdirSync(b.dir, { recursive: true })
  const lp = join(b.dir, '.novelist.lock')
  const foreign = (ageMs) => {
    writeFileSync(lp, JSON.stringify({ pid: 999999, host: 'another-host', token: 'foreign', at: new Date().toISOString() }), 'utf8')
    const when = new Date(Date.now() - ageMs)
    utimesSync(lp, when, when)
  }
  // 新鲜：别机的持有者可能正在写 → 不许抢（本机探不到它的 pid，只能靠心跳证活）
  foreign(0)
  await assert.rejects(
    () => _internals.acquireFileLock(b.fs, b.dir, { waitMs: 80, staleMs: 5_000, retryMs: 5 }),
    /写锁等待超时/,
    '别机的新鲜锁不许抢（本机探不了它的存活，只能看年龄）',
  )
  // 陈旧：持有者跨机崩溃/心跳已停 → 接管（否则网络盘上的书永久锁死）
  foreign(60_000)
  const taken = await _internals.acquireFileLock(b.fs, b.dir, { waitMs: 200, staleMs: 5_000, retryMs: 5 })
  assert.equal(taken.mode, 'file-lock', '陈旧的异机锁必须可接管')
  await taken.release()
})

test('批R2 真机: 多个真进程并发 novel_init 同一本新书——只许一个成功，且不留锁', async (t) => {
  const root = mkdtempSync(join(tmpdir(), 'nf-race-'))
  t.after(() => rmSync(root, { recursive: true, force: true }))
  const dir = join(root, 'books', 'race') // 故意还不存在：首次初始化＝没有书目录＝旧实现直接放弃加锁
  const startFile = join(root, 'go')
  const titles = ['甲', '乙', '丙', '丁', '戊']
  // N 个进程（不是 2 个）：进程启动抖动会让两个进程一前一后错开、看起来"没事"，
  // N 个才能把它们挤进同一个窗口——这正是这条测试要覆盖的形状。
  const ws = titles.map((title) => worker(t, 'init', { root, dir, startFile, title, writeDelayMs: 6 }))
  await Promise.all(ws.map((w) => w.next(15_000)))
  writeFileSync(startFile, 'go') // 同时放行（栅栏，不靠 sleep 猜时间）

  const res = await Promise.all(ws.map((w) => w.next(30_000)))
  const done = res.filter((r) => r.event === 'done' && r.ok)
  const failed = res.filter((r) => r.event === 'error')
  assert.equal(done.length, 1, '并发开同一本新书只许一个成功，其余必须报"书已存在"：' + JSON.stringify(res))
  assert.equal(failed.length, titles.length - 1, '其余全部显式报错（不静默当成功）：' + JSON.stringify(res))
  for (const f of failed) assert.match(String(f.message), /书已存在/, '失败原因＝书已存在（它看到的是另一个进程刚落的账本）：' + f.message)

  // 骨架必须是完整一套（不是几个进程各写一半拼出来的）
  const proj = JSON.parse(readFileSync(join(dir, 'project.json'), 'utf8'))
  assert.ok(titles.includes(proj.title), '账本里的书名＝某一个成功者写的：' + proj.title)
  for (const f of ['bible.json', 'characters.json', 'foreshadows.json', 'timeline.json', 'outline.json', 'events.jsonl']) {
    assert.ok(existsSync(join(dir, f)), f + ' 必须落盘（骨架完整）')
  }
  assert.ok(!existsSync(join(dir, '.novelist.lock')), '跑完不许留锁文件')
})

test('批R2 真机: 书目录还不存在时，写类工具也必须持真锁（开书互斥的下半场）', async (t) => {
  const root = mkdtempSync(join(tmpdir(), 'nf-fresh-'))
  t.after(() => rmSync(root, { recursive: true, force: true }))
  const dir = join(root, 'books', 'fresh') // 故意还不存在
  const lp = join(dir, '.novelist.lock')
  const real = createNodeFsAdapter(root)
  let sawLockWhileWriting = false
  const fs = {
    ...real,
    // 探针：落账本的瞬间，书目录里必须已经有一把别人能看见的锁（跨进程互斥的实证）
    writeText: async (p, s) => {
      if (String(p).endsWith('project.json')) sawLockWhileWriting = existsSync(lp)
      return real.writeText(p, s)
    },
  }
  const out = await TOOLS.find((x) => x.name === 'novel_init').execute({ book_dir: dir, title: '新书', genre: 'dushi', logline: 'L' }, execOf(fs))
  assert.equal(out.ok, true)
  assert.equal(sawLockWhileWriting, true, '书目录不存在时也必须先建目录再取真锁——否则两个进程能同时"开同一本新书"')
  assert.ok(existsSync(join(dir, 'project.json')), '骨架落盘')
  assert.ok(!existsSync(lp), '写完不留锁')
})

test('批R2 真机: 真进程持有者活着时，另一进程不得按 mtime 抢锁（长操作超过 staleMs）', async (t) => {
  const root = mkdtempSync(join(tmpdir(), 'nf-live-'))
  t.after(() => rmSync(root, { recursive: true, force: true }))
  const dir = join(root, 'books', 'held')
  mkdirSync(dir, { recursive: true })
  const lp = join(dir, '.novelist.lock')

  const w = worker(t, 'hold', { root, dir, holdMs: 30_000, waitMs: 5_000, staleMs: 60_000, heartbeatMs: 0 })
  const hi = await w.next()
  assert.equal(hi.event, 'acquired', JSON.stringify(hi))
  const info = JSON.parse(readFileSync(lp, 'utf8'))
  assert.equal(info.pid, w.child.pid, '锁文件里的 pid ＝ 真子进程的 pid（证明确实是跨进程的锁）')

  // 模拟"长操作期间没碰过锁文件"：mtime 推老一小时，但持有进程明明还活着
  const old = new Date(Date.now() - 60 * 60 * 1000)
  utimesSync(lp, old, old)

  const fs = createNodeFsAdapter(root)
  const t0 = Date.now()
  await assert.rejects(
    () => _internals.acquireFileLock(fs, dir, { waitMs: 300, staleMs: 50, retryMs: 10, heartbeatMs: 0 }),
    /写锁等待超时/,
    '活着的（别的）进程持有者不许按 mtime 抢——那是两个写者同时进场',
  )
  assert.ok(Date.now() - t0 >= 250, '必须真的等满 waitMs 才报超时，而不是立刻抢到（实测 ' + (Date.now() - t0) + 'ms）')
})

test('批R2 真机: 持有者进程崩溃（锁残留）后另一进程立即接管，不必等满 staleMs', async (t) => {
  const root = mkdtempSync(join(tmpdir(), 'nf-crash-'))
  t.after(() => rmSync(root, { recursive: true, force: true }))
  const dir = join(root, 'books', 'crash')
  mkdirSync(dir, { recursive: true })
  const lp = join(dir, '.novelist.lock')

  const w = worker(t, 'hold', { root, dir, exitHard: true, waitMs: 5_000, staleMs: 30_000 })
  assert.equal((await w.next()).event, 'acquired')
  const code = await w.exited
  assert.equal(code, 3, '子进程按预期硬退出（崩溃模拟：不释放、不清理）')
  assert.ok(existsSync(lp), '崩溃后锁文件残留在盘上——这正是必须能恢复的形状')
  assert.equal(JSON.parse(readFileSync(lp, 'utf8')).pid, w.child.pid, '残留锁是那个已死进程写的')

  const fs = createNodeFsAdapter(root)
  const t0 = Date.now()
  const lock = await _internals.acquireFileLock(fs, dir, { waitMs: 5_000, staleMs: 30_000, retryMs: 10 })
  const took = Date.now() - t0
  assert.equal(lock.mode, 'file-lock', '死进程的锁必须能接管（否则崩一次＝这本书永久锁死）')
  assert.ok(took < 3_000, '接管靠"探活发现已死"，不该等满 staleMs=30s（实测 ' + took + 'ms）')
  await lock.release()
  assert.ok(!existsSync(lp), '接管者释放后不留锁')
})

test('批R2 真机: 两个真进程并发提交两章——跨进程串行落账不丢更新', async (t) => {
  const root = mkdtempSync(join(tmpdir(), 'nf-xproc-'))
  t.after(() => rmSync(root, { recursive: true, force: true }))
  const dir = join(root, 'books', 'xproc')
  const fs = createNodeFsAdapter(root)
  const call = (n, a) => TOOLS.find((x) => x.name === n).execute(a, execOf(fs))
  await call('novel_init', { book_dir: dir, title: 'X', genre: 'dushi', logline: 'L' })
  writeFileSync(join(dir, 'characters.json'), JSON.stringify({ characters: [{ name: '小满' }] }))

  const startFile = join(root, 'go')
  const textA = '夜里灯下有人影一动不动，门被推开了。'.repeat(4)
  const textB = '雨落在铁皮棚上，她数到第七下才开口说话。'.repeat(4)
  // writeDelayMs＝把每次提交的临界区拉长（~10 次写 × 6ms），保证两个进程真的处在同一窗口里
  const a = worker(t, 'chapter', { root, dir, startFile, ch: 1, text: textA, cast: ['小满'], writeDelayMs: 6 })
  const b = worker(t, 'chapter', { root, dir, startFile, ch: 2, text: textB, cast: ['小满'], writeDelayMs: 6 })
  await Promise.all([a.next(10_000), b.next(10_000)])
  writeFileSync(startFile, 'go')
  const [ra, rb] = await Promise.all([a.next(30_000), b.next(30_000)])
  assert.deepEqual([ra.ok, rb.ok], [true, true], '两章都该落成：' + JSON.stringify([ra, rb]))

  const chars = JSON.parse(readFileSync(join(dir, 'characters.json'), 'utf8'))
  assert.equal(chars.characters.find((c) => c.name === '小满').last_seen_ch, 2, '两章串行后 last_seen 必须是 2')
  // 丢更新的硬证据：两章各自要往 status.json 塞自己那条，并发读改写会互相覆盖掉一条
  const stj = JSON.parse(readFileSync(join(dir, 'status.json'), 'utf8'))
  assert.deepEqual(Object.keys(stj).sort(), ['1', '2'], '两章的状态都得在账上——缺一个＝有一次读改写被另一个进程覆盖（丢更新）')
  for (const [n, r] of [['001', ra], ['002', rb]]) {
    const rc = JSON.parse(readFileSync(join(dir, 'editorial', 'txn', 'chapter_' + n + '.json'), 'utf8'))
    assert.equal(rc.status, 'done', '第 ' + n + ' 章回执收束为 done')
    assert.equal(rc.ch, r.ch)
  }
  assert.ok(!existsSync(join(dir, '.novelist.lock')), '跨进程跑完不留锁文件')
})

test('批R2 真机: 两个真进程并发提交同一章——版本分配必须串行（rev 1/2 与快照逐字）', async (t) => {
  const root = mkdtempSync(join(tmpdir(), 'nf-samech-'))
  t.after(() => rmSync(root, { recursive: true, force: true }))
  const dir = join(root, 'books', 'samech')
  const fs = createNodeFsAdapter(root)
  const call = (n, a) => TOOLS.find((x) => x.name === n).execute(a, execOf(fs))
  await call('novel_init', { book_dir: dir, title: 'X', genre: 'dushi', logline: 'L' })

  const startFile = join(root, 'go')
  const textA = '甲版正文：夜里灯下有人影一动不动。'.repeat(4)
  const textB = '乙版正文：雨落在铁皮棚上，她数到第七下。'.repeat(4)
  const a = worker(t, 'chapter', { root, dir, startFile, ch: 1, text: textA })
  const b = worker(t, 'chapter', { root, dir, startFile, ch: 1, text: textB })
  await Promise.all([a.next(10_000), b.next(10_000)])
  writeFileSync(startFile, 'go')
  const [ra, rb] = await Promise.all([a.next(30_000), b.next(30_000)])
  assert.deepEqual([ra.ok, rb.ok], [true, true], JSON.stringify([ra, rb]))

  // 串行的签名：一个人拿到 rev1、另一个人拿到 rev2。并发没锁时双方都会读到"无手稿"→ 都报 rev1
  assert.deepEqual([ra.rev, rb.rev].sort((x, y) => x - y), [1, 2], '同一章两进程并发提交必须一前一后（rev 1/2）：' + JSON.stringify([ra, rb]))
  const firstText = ra.rev === 1 ? textA : textB // 先交那一版
  const secondText = ra.rev === 1 ? textB : textA // 后交那一版
  assert.equal(readFileSync(join(dir, 'versions', 'chapter_001.v1.md'), 'utf8'), firstText, '快照 v1＝先交那一版逐字（历史不重写）')
  assert.equal(readFileSync(join(dir, 'manuscript', 'chapter_001.md'), 'utf8'), secondText, '手稿＝后交那一版逐字')
  assert.ok(!existsSync(join(dir, '.novelist.lock')), '跑完不留锁文件')
})

test('批R2 真机: 上下文根按 DSH 形状（fs.config.cwd）认，不经对象身份', async (t) => {
  const b = bench(t)
  _internals.resetLastBook()
  await b.call('novel_init', { book_dir: b.dir, title: 'DSH', genre: 'dushi', logline: 'L' })
  // DSH 本地 fs 的工作区根在 config.cwd（MCP 适配器才是 root）。这里按该形状套一个新代理：
  // 每次调用都是一个新对象，只有"根"这一个字符串是稳定的。
  const dshLike = (cwd) => new Proxy({
    resolve: b.fs.resolve, stat: b.fs.stat, readText: b.fs.readText,
    writeText: b.fs.writeText, listDir: b.fs.listDir, processPath: b.fs.processPath,
    config: { cwd }, // 无 root 属性：根只在 config.cwd 里（DSH 本地 fs 的形状）
  }, {})
  const callWith = (cwd, n, a) => TOOLS.find((x) => x.name === n).execute(a, execOf(dshLike(cwd)))
  assert.equal((await callWith(b.root, 'novel_count', { book_dir: '@last' })).book_dir, b.dir.replace(/\\/g, '/'), '同一工作区（新代理）仍认这本书')
  await assert.rejects(() => callWith(b.root + '-other', 'novel_bible', { book_dir: '@last', ch: 1 }), (e) => {
    assert.equal(e.code, 'E_NOT_FOUND', '另一个工作区根不许继承 @last（got ' + e.message + '）')
    return true
  })
})

test('批R2 真机: _internals 旧调用姿势不变（拆出 book-access.mjs 的兼容约束）', async (t) => {
  // 拆模块不能改调用姿势：外部（MCP handler/仪器/脚本）直接调 _internals 的这些符号。
  // 单参解析（不带 fs 上下文）＝旧签名，必须照旧能归一、照旧报同一批错误码。
  assert.equal(_internals.bookRootOf({ book_dir: 'C:\\books\\a\\' }), 'C:/books/a', '反斜杠＋尾斜杠归一不变')
  _internals.resetLastBook()
  assert.throws(() => _internals.bookRootOf({ book_dir: '@last' }), (e) => e.code === 'E_NOT_FOUND', '无上下文时 @last 仍明确报错')
  assert.throws(() => _internals.bookRootOf({}), (e) => e.code === 'E_BAD_ARG', '空 book_dir 仍是 E_BAD_ARG')
  // 写门在没有 fs 服务时原样透传（旧路径不因取不到 fs 而抛/挂）
  const gated = _internals.withWriteGate({ name: 'novel_bible', execute: async () => 'passthrough' })
  assert.equal(await gated({ book_dir: '/books/x' }, {}), 'passthrough')
  assert.equal(await gated({ book_dir: '/books/x' }, { agent: { ctx: { get: () => undefined } } }), 'passthrough')
})
