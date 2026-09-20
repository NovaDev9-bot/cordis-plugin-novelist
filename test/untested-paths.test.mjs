/**
 * untested-paths.test.mjs —— 覆盖"从未被执行过的行"（2026-09-20，Owner 追问"逐行复核为什么不查"之后）
 *
 * 由来：`lib/novelist.js` 2559 行，此前没人逐行读过。但"让模型读一遍说没问题"是最弱的一种验证。
 * 换成机器可查的等价物：**跑出哪些行从来没被执行**——V8 覆盖（含 spawn 出来的子进程，一轮 101 个进程）
 * ＋跨进程取并集（只看单进程会把"别的进程跑过"的行误报成未执行；只看"有没有范围覆盖"又会把整段函数
 * 算成已覆盖——两个坑都踩过），结果：**81 行从未执行、18 段**。
 *
 * 本文件补的就是其中"能执行、且属于错误路径/未测操作"的那批（每条都对应上面某个行号段）：
 *   伏笔策展两个 op（1687-1709）／未知 op（1892）／非法状态迁移（1230）／novel_count 无参（1613）
 *   ／novel_context.layer 与 window 校验（2388）／novel_search.window 校验（2441）
 *   ／schema 未来版本与缺迁移步（227/234）／锚参核对（1531-1534）／总览时间线截断说明（2140）
 *   ／DSH 插件挂载 apply（2527-2554）／裁决定位失败（1831）
 * 另有少数按设计不可达（见文件末尾"仍未覆盖"）。
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createNodeFsAdapter } from '../mcp/fs-adapter.mjs'
import { apply as pluginApply, inject as pluginInject, _internals } from '../lib/novelist.js'

const { TOOLS, loadJson, migrateLedger, SCHEMA_VERSION, LEDGER_MIGRATIONS } = _internals

/** 一本真书（真 fs 适配器，但进程内直调工具——比 spawn 快，代码路径与 MCP 侧同一份） */
async function bookAt(t, tag) {
  const root = mkdtempSync(join(tmpdir(), 'nf-un-' + tag + '-'))
  t.after(() => rmSync(root, { recursive: true, force: true }))
  const fs = createNodeFsAdapter(root)
  const dir = join(root, '书')
  const call = async (n, a) => {
    const def = TOOLS.find((x) => x.name === n)
    assert.ok(def, '未知工具 ' + n)
    return def.execute(a, { name: n, args: a, agent: { ctx: { get: (k) => (k === 'fs' ? fs : undefined) } } })
  }
  const raw = async (n, a) => {
    try { return { ok: true, value: await call(n, a) } } catch (e) { return { ok: false, e } }
  }
  await call('novel_init', { book_dir: dir, title: '未测路径书', genre: 'xuanyi', logline: 'L' })
  return { root, fs, dir, call, raw }
}

const text = (n) => '巷口的灯忽明忽暗，他数着铜钱，一遍又一遍。'.repeat(Math.ceil(n / 20)).slice(0, n)

test('伏笔策展：update_foreshadow 改期/改名留痕 ＋ close_foreshadow 关账（此前两条 op 都没跑过）', async (t) => {
  const { dir, call } = await bookAt(t, 'foreshadow')
  await call('novel_chapter', { book_dir: dir, ch: 1, text: text(2000), seeds: [{ id: 't001', name: '旧名', due_ch: 5 }] })
  const up = await call('novel_ledger', { book_dir: dir, op: 'update_foreshadow', foreshadow_id: 't001', due_ch: 9, new_name: '新名', note: '卷纲重排' })
  assert.equal(up.ok, true, JSON.stringify(up))
  assert.equal(up.result.due_ch, 9)
  assert.equal(up.result.name, '新名')
  const ev = JSON.parse(readFileSync(join(dir, 'events.jsonl'), 'utf8').trim().split('\n').pop())
  assert.equal(ev.op, 'foreshadow_update')
  assert.deepEqual(ev.before, { due_ch: 5, name: '旧名', planted_ch: 1 }, '改动前后都要留痕：' + JSON.stringify(ev.before))
  assert.equal(ev.reason, '卷纲重排')
  const cl = await call('novel_ledger', { book_dir: dir, op: 'close_foreshadow', foreshadow_id: 't001', note: '并入主线' })
  assert.equal(cl.ok, true, JSON.stringify(cl))
  const fsh = JSON.parse(readFileSync(join(dir, 'foreshadows.json'), 'utf8'))
  const f = fsh.foreshadows.find((x) => x.id === 't001')
  assert.equal(f.status, 'closed')
  assert.equal(f.closed_ch, 1, '关账章号取当前章')
})

test('novel_ledger 未知 op → 明确拒（不是静默 no-op）', async (t) => {
  const { dir, raw } = await bookAt(t, 'unknown-op')
  const r = await raw('novel_ledger', { book_dir: dir, op: 'update_nothing' })
  assert.equal(r.ok, false, '未知 op 必须抛：' + JSON.stringify(r.value))
  assert.match(String(r.e.message), /未知 op/)
})

test('章状态机：非法迁移被拦（advance_to 草稿→已定稿）', async (t) => {
  const { dir, raw } = await bookAt(t, 'transition')
  await raw('novel_chapter', { book_dir: dir, ch: 1, text: text(2000) })
  const r = await raw('novel_chapter', { book_dir: dir, ch: 2, text: text(2000), advance_to: '已定稿' })
  assert.equal(r.ok, false, '草稿只能去 已审/待修订，跨级必须拦')
  assert.match(String(r.e.message), /非法状态迁移/)
  assert.match(String(r.e.message), /合法去向/, '报错要给出合法去向')
})

test('novel_count：file 模式真读盘 ＋ 无 file/text 时按 book_dir 统计全书', async (t) => {
  const { dir, call, raw } = await bookAt(t, 'count')
  await call('novel_chapter', { book_dir: dir, ch: 1, text: text(2000) })
  // 两个都不给 → 拒（这一行 1613 从没被执行过；novel_count 的 schema 里 book_dir 是可选的，所以这条可达）
  const bad = await raw('novel_count', {})
  assert.equal(bad.ok, false, 'file/text/book_dir 都不给必须拒')
  assert.match(String(bad.e.message), /file 与 text 必须二选一/)
  // 模式混用 → 拒（另一条从没执行过的守卫）
  const both = await raw('novel_count', { book_dir: dir, text: '一二三' })
  assert.equal(both.ok, false, '进度模式与文本模式不能混：' + JSON.stringify(both.value))
  assert.match(String(both.e.message), /不能同时给/)
  // 文本模式：真读盘数出 5 个汉字（这条此前只测过 text 模式）
  const f = join(dir, 'novel_count_probe.txt')
  writeFileSync(f, '一二三四五\n', 'utf8')
  const r = await call('novel_count', { file: f })
  assert.match(JSON.stringify(r), /"han":\s*5/, 'file 模式要真读盘并数出 5 个汉字：' + JSON.stringify(r).slice(0, 200))
  // 进度模式：整本口径（逐章汉字 + 合计）
  const all = await call('novel_count', { book_dir: dir })
  assert.equal(all.chapters, 1, '全书口径要数到 1 章：' + JSON.stringify(all).slice(0, 200))
  assert.ok(all.total > 1500, '全书汉字总量要真算：' + JSON.stringify(all).slice(0, 200))
})

test('novel_context / novel_search：layer 与 window 的参数校验（坏参数当场拒，不落进深层）', async (t) => {
  const { dir, raw } = await bookAt(t, 'params')
  const l = await raw('novel_context', { book_dir: dir, op: 'summary', layer: 'chapterx' })
  assert.equal(l.ok, false)
  assert.match(String(l.e.message), /必须为 chapter\/volume\/book/)
  const w1 = await raw('novel_context', { book_dir: dir, op: 'summary', window: { from: 9, to: 2 } })
  assert.equal(w1.ok, false)
  assert.match(String(w1.e.message), /window 需为正整数/)
  const w2 = await raw('novel_search', { book_dir: dir, q: '灯', window: { from: 0, to: 3 } })
  assert.equal(w2.ok, false)
  assert.match(String(w2.e.message), /window 需为正整数/)
})

test('账本 schema 守卫能红：未来版本拒读 ＋ 缺迁移步拒猜（此前从未触发过）', async (t) => {
  const { fs, dir } = await bookAt(t, 'schema')
  // ① 未来版本：显式拒读（静默误读旧字段比报错贵得多）
  await fs.writeText(join(dir, 'timeline.json'), JSON.stringify({ schema_version: SCHEMA_VERSION + 1, events: [] }))
  await assert.rejects(() => loadJson(fs, dir, 'timeline.json'), /高于本插件支持/)
  // ② 缺迁移步：删掉 v0→v1 那一步，读一本无戳的账本必须拒（不靠 undefined 分支隐式兼容）
  const keep = LEDGER_MIGRATIONS['timeline.json'][1]
  delete LEDGER_MIGRATIONS['timeline.json'][1]
  try {
    await fs.writeText(join(dir, 'timeline.json'), JSON.stringify({ events: [] }))
    await assert.rejects(() => loadJson(fs, dir, 'timeline.json'), /缺 v0→v1 迁移函数/)
  } finally { LEDGER_MIGRATIONS['timeline.json'][1] = keep }
  // 恢复后同一份账本要能正常读（证明上面拒的是"缺步"而不是别的原因）
  assert.ok(await loadJson(fs, dir, 'timeline.json'))
  // 直接调迁移器：无戳 → 逐级迁移并盖戳
  const mig = migrateLedger('project.json', { schema_version: 0, title: 'x' })
  assert.equal(mig.migrated, true)
  assert.equal(mig.value.schema_version, SCHEMA_VERSION)
})

test('verify 锚参核对：卷首章缺 anchor_params 报 ＋ 正文偏离锚书窗口报', async (t) => {
  const { dir, call } = await bookAt(t, 'anchor')
  await call('novel_outline', {
    book_dir: dir, op: 'write', volume: 1, ch: 1,
    entry: { title: '第一章', goal: 'g', hook: 'h', word_min: 1000, word_max: 4000, differentiation: '与榜单头部不同：写账本不写打脸', anchor_params: { hook_type: '悬念', word_window: [2500, 5000] } },
  })
  await call('novel_chapter', { book_dir: dir, ch: 1, text: text(1800) })
  await call('novel_outline', { book_dir: dir, op: 'write', volume: 2, ch: 11, entry: { title: '第二卷首', goal: 'g', hook: 'h', word_min: 1000, word_max: 4000, differentiation: 'd' } })
  const v = await call('novel_verify', { book_dir: dir })
  const issues = (v.issues || []).join('\n')
  assert.match(issues, /卷 1 卷首章（1）缺 choice_axis|卷 1 卷首章（1）/, '卷 1 有 anchor_params＝锚参已启用，卷首章该报：' + issues.slice(0, 300))
  assert.match(issues, /锚书窗口偏离|缺锚参/, '锚参启用后要核卷首章与窗口：' + issues.slice(0, 400))
})

test('novel_ask 总览：时间线超窗时给"只给最近 N 条"的说明（零命中问句也走通）', async (t) => {
  const { dir, call } = await bookAt(t, 'overview')
  for (let ch = 1; ch <= 13; ch++) {
    await call('novel_chapter', { book_dir: dir, ch, text: text(2000), timeline_events: [{ time: '第' + ch + '天夜里', what: '第' + ch + '件事' }] })
  }
  const a = await call('novel_ask', { book_dir: dir, q: '一个账本里根本没有的名字' })
  const ov = a.overview || {}
  assert.ok(Array.isArray(ov.timeline), '总览要带时间线近窗：' + JSON.stringify(a).slice(0, 200))
  assert.match(String(ov.timeline_note || ''), /只给最近/, '超窗必须明说"只给最近 N 条"，否则会被当成全量：' + JSON.stringify(ov).slice(0, 300))
})

test('DSH 插件挂载 apply(ctx)：工具注册 ＋ ask 门（开书/权责裁决）＋ systemPrompt 段（MCP 测试进不去的那段）', async (t) => {
  const registered = []
  const labels = []
  const sections = []
  let pre = null
  const ctx = {
    get: (k) => (k === 'tools' ? { register: (def) => registered.push(def.name) }
      : k === 'systemPrompt' ? { section: (s) => sections.push(s.name) } : undefined),
    effect: (fn, label) => { labels.push(label); return fn() },
    on: (ev, fn) => { if (ev === 'tools/pre-execute') pre = fn },
  }
  pluginApply(ctx, {})
  assert.equal(registered.length, TOOLS.length, '每个工具都要注册：' + registered.length)
  assert.equal(sections.length, 1, 'systemPrompt 段要挂上')
  assert.ok(pluginInject.includes('tools') && pluginInject.includes('systemPrompt'), 'inject 声明要与 apply 用的一致：' + JSON.stringify(pluginInject))
  assert.ok(pre, 'pre-execute 钩子必须装上（ask 门是它实现的）')
  assert.equal(pre({ name: 'novel_chapter', args: {} }, () => 'NEXT'), 'NEXT', '普通调用不许拦')
  const ask1 = pre({ name: 'novel_init', args: {} }, () => 'NEXT')
  assert.equal(ask1.kind, 'ask', '开书要走 ask：' + JSON.stringify(ask1))
  const ask2 = pre({ name: 'novel_init', args: { selection_report: '选题.md' } }, () => 'NEXT')
  assert.match(ask2.reason, /选题报告/, '带选题报告时要把它带进 ask 载荷（M5 gate 坐标）')
  const ask3 = pre({ name: 'novel_ledger', args: { op: 'resolve_conflict', conflict: { scope: 'authority' } } }, () => 'NEXT')
  assert.equal(ask3.kind, 'ask', '权责类裁决要走 ask')
  const notAsk = pre({ name: 'novel_ledger', args: { op: 'resolve_conflict', conflict: { scope: 'semantic' } } }, () => 'NEXT')
  assert.equal(notAsk, 'NEXT', '语义类裁决编辑部自裁，不 ask')
})

test('裁决定位失败：冲突记录的窗口事后被改写 → 拒写并给下一步（不猜着写错那条）', async (t) => {
  const { dir, fs, call, raw } = await bookAt(t, 'picktarget')
  const led = (term) => call('novel_ledger', { book_dir: dir, op: 'update_term', term })
  await led({ name: '断魂钉', value: '铜制', effective_from_ch: 1, effective_to_ch: 10 })
  await led({ name: '断魂钉', value: '铁制', effective_from_ch: 11 })
  const conf = await led({ name: '断魂钉', value: '木制', effective_from_ch: 12 })
  assert.equal(conf.ok, false)
  assert.deepEqual(conf.result.conflict.target, { effective_from_ch: 11, effective_to_ch: null })
  // 事后改写被冲突那条的窗口（真实世界里=有人又改了一版）
  await led({ name: '断魂钉', value: '铁制', effective_from_ch: 11, effective_to_ch: 30 })
  const r = await raw('novel_ledger', { book_dir: dir, op: 'resolve_conflict', conflict: { id: conf.result.conflict.id, scope: 'semantic', verdict: 'accept_new', stance: '采信', evidence: 'ch12' } })
  assert.equal(r.ok, false, '定位不到就该拒，不许退回"按名字取首条"：' + JSON.stringify(r.value))
  assert.match(String(r.e.message), /裁决定位失败/)
  assert.match(String(r.e.message), /处置：.*novel_bible|处置：.*update_term/, '要说清下一步怎么做（处置句随 message 下发）')
  const rows = JSON.parse(readFileSync(join(dir, 'bible.json'), 'utf8')).terms
  assert.deepEqual(rows.map((x) => x.value), ['铜制', '铁制'], '拒写＝账本零改动')
})

test('伏笔策展：planted_ch 非法值被拦（与 due_ch 同族的守卫）', async (t) => {
  const { dir, call, raw } = await bookAt(t, 'planted')
  await call('novel_chapter', { book_dir: dir, ch: 1, text: text(2000), seeds: [{ id: 't001', name: '名', due_ch: 5 }] })
  const r = await raw('novel_ledger', { book_dir: dir, op: 'update_foreshadow', foreshadow_id: 't001', planted_ch: 0 })
  assert.equal(r.ok, false)
  assert.match(String(r.e.message), /planted_ch 需为正整数/)
  // 合法值要真落盘（弧审坐标纠偏的正常用法）
  const ok = await call('novel_ledger', { book_dir: dir, op: 'update_foreshadow', foreshadow_id: 't001', planted_ch: 2 })
  assert.equal(ok.result.planted_ch, 2, JSON.stringify(ok))
})

// 试过但**没造对**，故不留假绿测试：`last_seen_after_ch`（旧书无贡献账那一支）需要一个
// "没有 editorial/facts 贡献账、且人物卡 last_seen 超出 project.current_ch" 的手工 fixture——
// 只要章节带 cast，贡献账就已经产生，新书永远走不进那条分支。见文末"仍未覆盖"。

test('产线校准 recommend：有"被排除的章"时给出口径说明（体例章/番外不进样本）', async (t) => {
  const { dir, call } = await bookAt(t, 'recommend')
  for (const [ch, min] of [[1, 2000], [2, 2000], [3, 2000], [9, 500]]) {
    await call('novel_outline', { book_dir: dir, op: 'write', volume: 1, ch, entry: { title: '第' + ch + '章', goal: 'g', hook: 'h', word_min: min, word_max: min + 800, differentiation: ch === 1 ? 'd' : undefined } })
  }
  for (const ch of [1, 2, 3]) await call('novel_chapter', { book_dir: dir, ch, text: text(2000) })
  await call('novel_chapter', { book_dir: dir, ch: 9, text: text(300) }) // 体例章：word_min 远低于主体
  const rd = await call('novel_outline', { book_dir: dir, op: 'read' })
  const rec = rd.recommend || (rd.result && rd.result.recommend)
  assert.ok(rec, '样本 ≥3 章就该给 recommend：' + JSON.stringify(rd).slice(0, 300))
  assert.match(String(rec.basis || ''), /已排除/, '排除过章就必须说明排除口径，否则推荐值来源不可信：' + JSON.stringify(rec))
})

test('卷首章 choice_axis 的**旧书宽松口径**：存量卷不误报，启用卷之后才查', async (t) => {
  const root = mkdtempSync(join(tmpdir(), 'nf-un-legacy-'))
  t.after(() => rmSync(root, { recursive: true, force: true }))
  const fs = createNodeFsAdapter(root)
  const dir = join(root, '旧书')
  const call = async (n, a) => TOOLS.find((x) => x.name === n).execute(a, { name: n, args: a, agent: { ctx: { get: (k) => (k === 'fs' ? fs : undefined) } } })
  // 关键：required_outline_fields 里**不含** choice_axis ＝ 存量书的口径
  await call('novel_init', { book_dir: dir, title: '旧书', genre: 'xuanyi', logline: 'L', required_outline_fields: [] })
  await call('novel_outline', { book_dir: dir, op: 'write', volume: 1, ch: 1, entry: { title: '卷一首', goal: 'g', hook: 'h', word_min: 2000, word_max: 3000 } })
  await call('novel_outline', { book_dir: dir, op: 'write', volume: 2, ch: 11, entry: { title: '卷二首', goal: 'g', hook: 'h', word_min: 2000, word_max: 3000, choice_axis: { chosen: '查账', sacrificed: ['认亲'], hook_bearing: 't001' } } })
  await call('novel_outline', { book_dir: dir, op: 'write', volume: 3, ch: 21, entry: { title: '卷三首', goal: 'g', hook: 'h', word_min: 2000, word_max: 3000 } })
  const v = await call('novel_verify', { book_dir: dir })
  const issues = (v.issues || []).join('\n')
  assert.ok(!/卷 1 卷首章（1）缺 choice_axis/.test(issues), '启用卷之前的存量卷不许误报：' + issues.slice(0, 300))
  assert.match(issues, /卷 3 卷首章（21）缺 choice_axis/, '启用卷（卷二）之后的新卷要查：' + issues.slice(0, 400))
})

test('verify 章号断档：章纲之外缺的那几章一次报清', async (t) => {
  const { dir, call } = await bookAt(t, 'gap')
  await call('novel_chapter', { book_dir: dir, ch: 1, text: text(1500) })
  await call('novel_chapter', { book_dir: dir, ch: 3, text: text(1500) }) // 第 2 章没有章纲也没有文件
  const v = await call('novel_verify', { book_dir: dir })
  assert.match((v.issues || []).join('\n'), /章号断档/, '缺口要报，且不能等到人肉比对才发现：' + JSON.stringify(v.issues).slice(0, 300))
})

test('工具渲染面：JSON 渲染通道真的通（MCP 侧每次 tools/call 都走它，此前没有任何断言）', async (t) => {
  const { dir, call } = await bookAt(t, 'render')
  await call('novel_chapter', { book_dir: dir, ch: 1, text: text(1500) })
  for (const name of ['novel_bible', 'novel_verify', 'novel_ledger']) {
    const def = TOOLS.find((x) => x.name === name)
    const v = await def.execute({ book_dir: dir, op: name === 'novel_ledger' ? 'update_term' : undefined, term: name === 'novel_ledger' ? { name: 'x', value: 'y' } : undefined }, { name, args: {}, agent: { ctx: { get: (k) => (k === 'fs' ? createNodeFsAdapter(dir) : undefined) } } })
    const blocks = def.output.render({}, v)
    assert.ok(Array.isArray(blocks) && blocks[0].type === 'text' && blocks[0].text.length > 2, name + ' 的渲染要出可读文本块：' + JSON.stringify(blocks).slice(0, 200))
    assert.doesNotThrow(() => JSON.parse(blocks[0].text), name + ' 的 JSON 渲染必须可解析（客户端按它解析）：' + blocks[0].text.slice(0, 200))
  }
})

// ── 仍未覆盖（照实列，不假装扫过了）────────────────────────────────────────────
// 补完本文件后重测：lib/novelist.js 2559 行里**未执行 4 行 / 2 段**（此前 81 行 / 18 段）：
// · `f.planted_ch = args.planted_ch`（已补：合法赋值那条断言覆盖到了）；`renderJson`（已由"工具渲染面"那条覆盖）
// · 1230-1231 `advance_to 非法状态迁移` 的 throw：**已执行**（本文件"章号状态机"那条断言了它的原文）——
//   覆盖工具把跨行的 throw 表达式算作未执行，属**方法边界**，不是没测到；
// · 2099-2100 `last_seen_after_ch`（旧书无贡献账那一支）：需"没有 editorial/facts 贡献账且
//   人物卡 last_seen 超出 project.current_ch"的手工 fixture——章节一旦带 cast 就已产生贡献账，
//   新书走不进去（我试造过，没造对，故不留假绿测试）；
// · `novel_search`「尚无正文」的 catch 与 JSON-RPC 未知方法分支：分别由 mcp.test.mjs 与
//   本文件的 `novel_context` 参数校验条覆盖同一族，不重复。
// 复算法：`NODE_V8_COVERAGE=<dir> node --test <package.json 的 test 清单>`，再按"每进程最内层块
// count=0、跨进程取并集"统计（两个坑：混进程取最内层会误报；只看"有没有范围覆盖"会全绿）。
