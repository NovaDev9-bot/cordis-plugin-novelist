// 结构审计修正批（2026-09-18，Owner 拍板）：
//   ① 钩子账并入事件带（kind=hook/payoff）——不另立 hooks.json，与欠线共用埋/兑/闭线同一套生命周期
//   ② novel_verify 拆出 warnings（业务提示不翻 ok）——卷尾结算每次卷末必然出一条，混进 issues 等于
//      "每收一卷必红"，红灯贬值后真问题也看不见
//   ③ 卷尾结算清单（告警行，非硬闸，跨界延续不罚）
//   ④ 弧审结构化账单（novel_ledger op=arc_review → editorial/arcs.jsonl）
//   ⑤ structure-check.mjs 结构仪器（只算两个可计算量，其余明标不可测）
import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, writeFileSync, readFileSync, mkdirSync } from 'node:fs'
import { execFileSync } from 'node:child_process'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { createNodeFsAdapter } from '../mcp/fs-adapter.mjs'
import { _internals } from '../lib/novelist.js'

const { TOOLS } = _internals

function shimFs(files = new Map()) {
  const fs = {
    resolve: async (p) => String(p).replace(/\/+/g, '/'),
    stat: async (p) => (files.has(p) ? { size: files.get(p).length } : null),
    readText: async (p) => { if (!files.has(p)) throw new Error('ENOENT ' + p); return files.get(p) },
    writeText: async (p, s) => { files.set(p, s) },
    listDir: async (p) => [...files.keys()].filter((k) => k.startsWith(p + '/')).map((k) => ({ name: k.slice(p.length + 1).split('/')[0] })),
  }
  const exec = () => ({ agent: { ctx: { get: (k) => (k === 'fs' ? fs : undefined) } } })
  return { files, fs, exec, call: (n, a) => { const t = TOOLS.find((x) => x.name === n); if (!t) throw new Error('no tool ' + n); return t.execute(a, exec()) } }
}

/** 一本已写到第 12 章的书：卷 1 覆盖 1-6 章，正文与回执齐备。 */
function seededBook() {
  const { files, call } = shimFs()
  const dir = '/books/hooked'
  files.set(dir + '/project.json', JSON.stringify({ title: '钩子书', current_ch: 12 }))
  files.set(dir + '/foreshadows.json', JSON.stringify({ foreshadows: [
    { id: 'F1', name: '玉佩来历', planted_ch: 1, due_ch: 6, status: 'planted', closed_ch: null },
    { id: 'F2', name: '师父行踪', planted_ch: 2, due_ch: 30, status: 'planted', closed_ch: null },
  ] }))
  files.set(dir + '/characters.json', JSON.stringify({ characters: [{ name: '林一', identity: '镖师', last_seen_ch: 12 }] }))
  files.set(dir + '/bible.json', JSON.stringify({ terms: [] }))
  files.set(dir + '/timeline.json', JSON.stringify({ events: [] }))
  files.set(dir + '/outline.json', JSON.stringify({ volumes: [
    { volume: 1, chapters: [1, 2, 3, 4, 5, 6].map((n) => ({ chapter_no: n, title: '章' + n, differentiation: '差异', anchor_params: {} })) },
    { volume: 2, chapters: [7, 8, 9, 10, 11, 12].map((n) => ({ chapter_no: n, title: '章' + n, differentiation: '差异', anchor_params: {} })) },
  ] }))
  for (let n = 1; n <= 12; n++) {
    const f = 'chapter_' + String(n).padStart(3, '0')
    files.set(dir + '/manuscript/' + f + '.md', '第' + n + '章正文。'.repeat(20))
    files.set(dir + '/editorial/txn/' + f + '.json', JSON.stringify({ ch: n, rev: 1, han: 120, status: 'done', done: true }))
  }
  files.set(dir + '/events.jsonl', [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12].map((n) => JSON.stringify({ op: 'chapter_commit', ch: n, rev: 1 })).join('\n') + '\n')
  return { files, call, dir }
}

const tapeOf = (files, dir) => {
  const raw = files.get(dir + '/editorial/events-tape.jsonl') || ''
  return raw.split('\n').filter(Boolean).map((l) => JSON.parse(l))
}

// ---------------------------------------------------------------- ① 钩子账

test('钩子①：novel_chapter hook 参数落事件带 kind=hook，未闭钩子进 open_hooks', async () => {
  const { files, call, dir } = seededBook()
  const r = await call('novel_chapter', { book_dir: dir, ch: 1, title: '开篇', text: '他推开门。', hook: { what: '门后传来母亲的声音', why: '读者想知道母亲为何在此' } })
  assert.equal(r.ok, true)
  assert.ok(r.derived.some((d) => d.startsWith('钩子 t')), '返回值应报出钩子条目 id：' + JSON.stringify(r.derived))

  const tape = tapeOf(files, dir)
  const h = tape.find((e) => e.kind === 'hook')
  assert.equal(h.ch, 1)
  assert.equal(h.what, '门后传来母亲的声音')
  assert.equal(h.actor, '主编')

  const win = await call('novel_event', { book_dir: dir, op: 'read' })
  assert.deepEqual(win.open_hooks.map((x) => x.id), [h.id], '未闭钩子必须完整可查（账记了问不出来等于没记）')
})

test('钩子②：pays_hooks 走欠线同一套闭线对账；重复闭线拦；未知 id 在写盘前就拦下', async () => {
  const { files, call, dir } = seededBook()
  await call('novel_chapter', { book_dir: dir, ch: 1, title: '开篇', text: '他推开门。', hook: { what: '门后的声音' } })
  const h = tapeOf(files, dir).find((e) => e.kind === 'hook')

  const r2 = await call('novel_chapter', { book_dir: dir, ch: 2, title: '第二章', text: '门后是空的。', pays_hooks: [h.id] })
  assert.equal(r2.ok, true)
  assert.ok(r2.derived.some((d) => d.includes('兑现 ' + h.id)))
  const tape = tapeOf(files, dir)
  assert.equal(tape.find((e) => e.kind === 'payoff').closes_thread, h.id)
  assert.deepEqual((await call('novel_event', { book_dir: dir, op: 'read' })).open_hooks, [])

  // 重复闭线：拒（重复闭线会让兑现率统计失真）
  await assert.rejects(() => call('novel_chapter', { book_dir: dir, ch: 3, title: '第三章', text: '又一天。', pays_hooks: [h.id] }), /已闭合过/)

  // 未知 id：必须在正文落盘之前拦下——否则正文已写、回执停 pending，参数错误伪装成半提交
  // （用第 13 章＝书中还不存在的章，才能确证"没落盘"，而不是被夹具里已有的文件骗过去）
  await assert.rejects(() => call('novel_chapter', { book_dir: dir, ch: 13, title: '第十三章', text: '新章正文。', pays_hooks: ['t999'] }), /引用未知钩子/)
  assert.equal(files.has(dir + '/manuscript/chapter_013.md'), false, '参数错不该留下半章正文')
  assert.equal(files.has(dir + '/editorial/txn/chapter_013.json'), false, '也不该留下 pending 回执')
})

test('钩子③：同文本重交幂等——钩子不重复入账，也不丢（事件带是本章账务最后一步）', async () => {
  const { files, call, dir } = seededBook()
  const args = { book_dir: dir, ch: 1, title: '开篇', text: '同一段正文。', hook: { what: '同一个钩子' }, decision: { what: '同一个决策', why: '同一理由' } }
  const a = await call('novel_chapter', args)
  assert.equal(a.ok, true)
  const b = await call('novel_chapter', args)
  assert.equal(b.deduped, true, '同文本必须判为重试')
  const tape = tapeOf(files, dir)
  assert.equal(tape.filter((e) => e.kind === 'hook').length, 1, '重试不得重复记钩子')
  assert.equal(tape.filter((e) => e.kind === 'decision').length, 1, '重试不得重复记决策（旧实现此处缺陷已随本批修正）')
})

test('钩子④：钩子不占窗口位——190 章后事件带窗口里仍是决策，不是钩子墙', async () => {
  const { files, call, dir } = seededBook()
  const lines = []
  for (let n = 1; n <= 30; n++) {
    lines.push(JSON.stringify({ ts: 'x', id: 't' + String(n).padStart(3, '0'), kind: 'hook', ch: n, what: '钩子' + n, why: 'w', actor: '主编' }))
  }
  lines.push(JSON.stringify({ ts: 'x', id: 't900', kind: 'decision', ch: 31, what: '一个重要决策', why: 'w', actor: '主编' }))
  files.set(dir + '/editorial/events-tape.jsonl', lines.join('\n') + '\n')

  const win = await call('novel_event', { book_dir: dir, op: 'read' })
  assert.ok(win.window.some((e) => e.kind === 'decision' && e.id === 't900'), '决策必须留在窗口里（旧形状会被 30 条钩子挤出画框）')
  assert.equal(win.window.filter((e) => e.kind === 'hook').length, 0, '钩子只计数不占窗')
  assert.equal(win.counts.hook, 30)
  assert.equal(win.open_hooks.length, 30)
  assert.match(win.note, /只计数不占窗口/)
})

test('钩子⑤：hook 不接受 closes（有期限的线是欠线不是钩子）；超期在 verify 走 warnings 不翻 ok', async () => {
  const { files, call, dir } = seededBook()
  await assert.rejects(() => call('novel_event', { book_dir: dir, op: 'append', kind: 'hook', ch: 1, what: 'x', why: 'y', actor: '主编', closes: 9 }), /hook 不接受 closes/)

  // 第 1 章埋钩子、12 章过去仍未兑现 → 超期告警（warnings）
  await call('novel_chapter', { book_dir: dir, ch: 1, title: '开篇', text: '他推开门。', hook: { what: '门后的声音' } })
  const v = await call('novel_verify', { book_dir: dir, ch: 12 })
  assert.ok(v.warnings.some((w) => w.includes('钩子超期未兑现')), '超期钩子应出现在 warnings：' + JSON.stringify(v.warnings))
  assert.equal(v.issues.some((i) => i.includes('钩子超期')), false, '业务提示不得混进 issues')
})

test('钩子⑥：近窗漏记钩子＝issues（记录缺失是硬清单），且不追溯采用钩子之前的章', async () => {
  const { files, call, dir } = seededBook()
  await call('novel_chapter', { book_dir: dir, ch: 10, title: '第十章', text: '第十章正文。', hook: { what: '第十章的钩子' } })
  const v = await call('novel_verify', { book_dir: dir, ch: 12 })
  const gap = v.issues.find((i) => i.includes('无章末钩子记录'))
  assert.ok(gap, '第 11/12 章漏记应报 issue：' + JSON.stringify(v.issues))
  assert.ok(!/第 1\/2\/3/.test(gap), '不得把采用钩子之前的老章一起刷出来：' + gap)
  assert.equal(v.ok, false)

  // 补记后归零
  await call('novel_chapter', { book_dir: dir, ch: 11, title: '第十一章', text: '第十一章正文。', hook: { what: '第十一章的钩子' } })
  await call('novel_chapter', { book_dir: dir, ch: 12, title: '第十二章', text: '第十二章正文。', hook: { what: '第十二章的钩子' } })
  const v2 = await call('novel_verify', { book_dir: dir, ch: 12 })
  assert.equal(v2.issues.some((i) => i.includes('无章末钩子记录')), false)
})

// ---------------------------------------------------------------- ②③ 卷尾结算

test('结算：卷收束后一个批次内报结算清单（warnings，不翻 ok），过了宽限静默', async () => {
  const { files, call, dir } = seededBook()
  // 卷 1 = 第 1-6 章，全部已写；第 6 章处结算
  const v = await call('novel_verify', { book_dir: dir, ch: 6 })
  const settle = v.warnings.find((w) => w.startsWith('卷 1 结算'))
  assert.ok(settle, '卷末应报结算清单：' + JSON.stringify(v.warnings))
  assert.match(settle, /卷内未收伏笔 2 条/)
  assert.match(settle, /跨卷延续是允许的/)
  assert.equal(v.ok, true, '结算不是硬闸——ok 不该被它翻掉')

  // 过了宽限期（> VOLUME_SETTLE_GRACE 章）不再提
  const v2 = await call('novel_verify', { book_dir: dir, ch: 12 })
  assert.equal(v2.warnings.some((w) => w.startsWith('卷 1 结算')), false, '结算只报一个批次，过后静默')
  assert.equal(v2.warnings.some((w) => w.startsWith('卷 2 结算')), true, '当前卷末照常在窗内')
})

// ---------------------------------------------------------------- ④ 弧审账单

test('弧审①：结构化账单落 editorial/arcs.jsonl，字段做确定性核对', async () => {
  const { files, call, dir } = seededBook()
  const base = { book_dir: dir, op: 'arc_review', arc: { volume: 1, arc: '弧1·入城', ch_from: 1, ch_to: 6, load_bearing_ch: 4, reversal: '林一从旁观者变成当事人', differentiation: '已落地：市井细节密度', verdict: '在轨', evidence: 'ch4 场景2 与 ch2 场景1 对照', reviewer: '档案员', plant_harvest: [{ id: 'F1' }, { id: 'F2' }] } }

  // 缺字段 / 承重点越界 / verdict 自由文本 / 引用不存在的伏笔：四类都拒
  await assert.rejects(() => call('novel_ledger', Object.assign({}, base, { arc: Object.assign({}, base.arc, { evidence: undefined }) })), /缺字段/)
  await assert.rejects(() => call('novel_ledger', Object.assign({}, base, { arc: Object.assign({}, base.arc, { load_bearing_ch: 99 }) })), /不在弧区间/)
  await assert.rejects(() => call('novel_ledger', Object.assign({}, base, { arc: Object.assign({}, base.arc, { verdict: '挺好的' }) })), /在轨\/漂移\/待定/)
  await assert.rejects(() => call('novel_ledger', Object.assign({}, base, { arc: Object.assign({}, base.arc, { plant_harvest: [{ id: 'FX' }] }) })), /未知伏笔/)

  const ok = await call('novel_ledger', base)
  assert.equal(ok.ok, true)
  assert.equal(ok.result.load_bearing_ch, 4)
  assert.equal(ok.result.plant_harvest, 2)
  const rec = JSON.parse(files.get(dir + '/editorial/arcs.jsonl').trim())
  assert.equal(rec.verdict, '在轨')
  assert.equal(rec.plant_harvest[1].status, 'planted', '伏笔收支对要带回落款时的真实状态，不是只存一个 id')
})

test('弧审②：novel_ask 能问出弧账（kind=arcs）；verify 对已过宽限的卷追缺账', async () => {
  const { files, call, dir } = seededBook()
  // 采用门：一条账单都没有＝未启用，不误报存量书
  const v0 = await call('novel_verify', { book_dir: dir, ch: 12 })
  assert.equal(v0.issues.some((i) => i.includes('无弧审账单')), false, '未启用的书不该被追账')

  await call('novel_ledger', { book_dir: dir, op: 'arc_review', arc: { volume: 2, arc: '弧2', ch_from: 7, ch_to: 12, load_bearing_ch: 10, reversal: '从守到攻', differentiation: '已落地', verdict: '待定', evidence: 'ch10', reviewer: '档案员' } })
  const v1 = await call('novel_verify', { book_dir: dir, ch: 12 })
  assert.ok(v1.issues.some((i) => i.includes('卷 1 已过') && i.includes('无弧审账单')), '已启用的书里，过了宽限的卷要被追账：' + JSON.stringify(v1.issues))

  const ask = await call('novel_ask', { book_dir: dir, q: '弧审情况' })
  assert.equal(ask.arcs.length, 1)
  assert.equal(ask.arcs[0].load_bearing_ch, 10)
  const sel = await call('novel_ask', { book_dir: dir, q: '取数', select: { kind: 'arcs' } })
  assert.equal(sel.arcs.length, 1)
})

// ---------------------------------------------------------------- 真机（真 fs 适配器，不走 Map shim）

test('真机：钩子→兑现→结构仪器全链（真实文件，非 shim）', async (t) => {
  const root = mkdtempSync(path.join(tmpdir(), 'nf-hook-real-'))
  t.after(() => rmSync(root, { recursive: true, force: true }))
  const fs = createNodeFsAdapter(root)
  const exec = () => ({ agent: { ctx: { get: (k) => (k === 'fs' ? fs : undefined) } } })
  const call = (n, a) => TOOLS.find((x) => x.name === n).execute(a, exec())
  const dir = path.join(root, 'books', 'real').replace(/\\/g, '/')

  await call('novel_init', { book_dir: dir, title: '真机钩子书', genre: 'xuanyi', logline: '一句话' })
  for (const n of [1, 2, 3]) {
    await call('novel_outline', { book_dir: dir, op: 'write', volume: 1, chapter_no: n, entry: { title: '章' + n, differentiation: '差异' } })
  }
  await call('novel_chapter', { book_dir: dir, ch: 1, title: '一', text: '第一章正文。'.repeat(10), hook: { what: '门外有人叫他的名字' }, seeds: [{ id: 'F1', name: '叫名字的人', due_ch: 3 }] })
  const h = JSON.parse(readFileSync(path.join(root, 'books', 'real', 'editorial', 'events-tape.jsonl'), 'utf8').trim().split('\n').filter((l) => l.includes('"hook"'))[0])
  assert.equal(h.kind, 'hook')

  await call('novel_chapter', { book_dir: dir, ch: 2, title: '二', text: '第二章正文。'.repeat(10), pays_hooks: [h.id] })
  await call('novel_chapter', { book_dir: dir, ch: 3, title: '三', text: '第三章正文。'.repeat(10), hook: { what: '第三章的钩子' }, closes: ['F1'] })

  const tape = readFileSync(path.join(root, 'books', 'real', 'editorial', 'events-tape.jsonl'), 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l))
  assert.equal(tape.filter((e) => e.kind === 'payoff').length, 1, '真机上兑现条目确实落盘')
  assert.equal(JSON.parse(readFileSync(path.join(root, 'books', 'real', 'foreshadows.json'), 'utf8')).foreshadows[0].status, 'closed')

  // 真机跑一遍结构仪器：钩子/伏笔两条账都要真读出来
  const out = path.join(root, 'r.json')
  execFileSync(process.execPath, [path.join(import.meta.dirname, '..', 'instruments', 'structure-check.mjs'), path.join(root, 'books', 'real'), '--json', out], { encoding: 'utf8' })
  const rep = JSON.parse(readFileSync(out, 'utf8'))
  assert.equal(rep.hooks.total, 2)
  assert.equal(rep.hooks.open, 1, 't001 已兑现，只剩第 3 章那条未闭')
  assert.equal(rep.foreshadow.curve.find((c) => c.ch === 3).open, 0, 'F1 第 3 章已收')
})

// ---------------------------------------------------------------- ⑤ 结构仪器

test('仪器：structure-check 只算两个可计算量，"未测"与"测到没有"分开报', () => {
  const base = mkdtempSync(path.join(tmpdir(), 'nf-struct-'))
  try {
    const book = path.join(base, 'book')
    mkdirSync(path.join(book, 'manuscript'), { recursive: true })
    mkdirSync(path.join(book, 'editorial'), { recursive: true })
    writeFileSync(path.join(book, 'project.json'), JSON.stringify({ title: '仪器书', current_ch: 6 }), 'utf8')
    // 伏笔：F1 第 1 章埋、第 5 章收（间隔 4）；F2 第 2 章埋、due 3 逾期未收
    writeFileSync(path.join(book, 'foreshadows.json'), JSON.stringify({ foreshadows: [
      { id: 'F1', name: 'A', planted_ch: 1, due_ch: 3, status: 'closed', closed_ch: 5 },
      { id: 'F2', name: 'B', planted_ch: 2, due_ch: 3, status: 'planted', closed_ch: null },
    ] }), 'utf8')
    writeFileSync(path.join(book, 'outline.json'), JSON.stringify({ volumes: [] }), 'utf8')
    for (let n = 1; n <= 6; n++) {
      writeFileSync(path.join(book, 'manuscript', 'chapter_' + String(n).padStart(3, '0') + '.md'), '第' + n + '章正文。'.repeat(10), 'utf8')
    }
    // 判据账：第 1、2 章有爽点；第 3、4 章测了没有；第 5、6 章压根没测
    const body = (n) => readFileSync(path.join(book, 'manuscript', 'chapter_' + String(n).padStart(3, '0') + '.md'), 'utf8')
    const ev = (n) => body(n).slice(0, 12)
    const lines = [
      { ch: 1, dim: '爽点', score: 4, mode: 'absolute', evidence: ev(1) },
      { ch: 2, dim: '爽点', score: 5, mode: 'absolute', evidence: ev(2) },
      { ch: 3, dim: '爽点', score: 2, mode: 'absolute', evidence: ev(3) },
      { ch: 4, dim: '爽点', score: 1, mode: 'absolute', evidence: ev(4) },
      { ch: 2, dim: '爽点', score: 5, mode: 'absolute', evidence: ev(2), content_hash: 'deadbeef' }, // 改稿后的陈旧判词
    ]
    writeFileSync(path.join(book, 'editorial', 'scores.jsonl'), lines.map((l) => JSON.stringify(l)).join('\n') + '\n', 'utf8')
    writeFileSync(path.join(book, 'editorial', 'arcs.jsonl'), JSON.stringify({ volume: 1, arc: '弧1', ch_from: 1, ch_to: 6, load_bearing_ch: 4, reversal: 'R', verdict: '在轨' }) + '\n', 'utf8')
    writeFileSync(path.join(book, 'editorial', 'events-tape.jsonl'), [
      JSON.stringify({ ts: 'x', id: 't001', kind: 'hook', ch: 2, what: '钩子A', why: 'w', actor: '主编' }),
      JSON.stringify({ ts: 'x', id: 't002', kind: 'hook', ch: 3, what: '钩子B', why: 'w', actor: '主编' }),
      JSON.stringify({ ts: 'x', id: 't003', kind: 'payoff', ch: 4, what: '兑现钩子 t001', why: 'w', actor: '主编', closes_thread: 't001' }),
    ].join('\n') + '\n', 'utf8')

    const out = path.join(base, 'r.json')
    const stdout = execFileSync(process.execPath, [path.join(import.meta.dirname, '..', 'instruments', 'structure-check.mjs'), book, '--json', out], { encoding: 'utf8' })
    const r = JSON.parse(readFileSync(out, 'utf8'))

    // ① 曝光曲线：第 5 章 F1 收掉、F2 仍在挂 → 未收 1
    assert.equal(r.foreshadow.curve.find((x) => x.ch === 4).open, 2)
    assert.equal(r.foreshadow.curve.find((x) => x.ch === 5).open, 1)
    assert.equal(r.foreshadow.curve.find((x) => x.ch === 6).overdue, 1, 'F2 due 3 未收，第 6 章应计一条逾期')
    assert.equal(r.foreshadow.stats.payoff_distance_median, 4)
    // ② 爽点间隔：第 3-4 章是确认的空档（第 5-6 章未测，不能算进空档）
    assert.deepEqual(r.praise.gaps.map((g) => [g.from, g.to, g.length]), [[3, 4, 2]])
    assert.deepEqual(r.praise.unmeasured_chapters, [5, 6])
    assert.equal(r.praise.stale_filtered, 1, '改稿前的旧版判词按版本过滤掉')
    // ③④ 承重章与钩子
    assert.deepEqual(r.load_bearing.chapters, [4])
    assert.equal(r.hooks.open, 1)
    assert.equal(r.hooks.open_ages[0].id, 't002')
    // ⑤ 不可测清单必须非空（列出来是纪律），且终端报告要打出来
    assert.ok(r.unmeasurable.length >= 4)
    assert.ok(stdout.includes('本仪器测不了的'))
    assert.ok(stdout.includes('"没测"≠"没有"'), '未测章必须显式标出：' + stdout.split('\n').filter((l) => l.includes('未测')).join('|'))
  } finally { rmSync(base, { recursive: true, force: true }) }
})
