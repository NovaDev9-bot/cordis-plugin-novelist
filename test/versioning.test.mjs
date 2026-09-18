// 生效窗语义（2026-09-18，Owner 质询后重做）：bible 词条与人物卡都是**带时间窗的事实**，
// 但存储是"一个名字一条记录、覆盖写"——语义与存储错配，于是任何一次正常的设定演进
// （旧值 [1,10] → 新值 [11,∞)）都被报成冲突，要 Owner 仲裁；而如果只把冲突条件改成
// "窗口不重叠就不算冲突"，覆盖写会把旧窗口连值一起毁掉——"第 5 章时青玉令是什么"
// 从此查不到，误报换成了静默吃书，更糟。
//
// 真解＝**版本记录 + 窗口重叠判定**：
//   ① 读：按 ch 投影到"窗口包含 ch 的那一条"（novel_bible 早已按窗过滤，只是此前不可能有多条）；
//   ② 写：新写入与既有记录的窗口**重叠**时按同一条修正（真冲突/真更正），
//          **不重叠**时追加一条新版本记录——旧窗口与旧值原样保留；
//   ③ 冲突：仅当"窗口重叠 且 值不同"才拦（无窗口字段＝全书窗，与任何窗重叠
//          ——旧账本行为因此完全不变）。
import test from 'node:test'
import assert from 'node:assert/strict'
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

const book = async () => {
  const b = shimFs()
  b.dir = '/books/ver'
  await b.call('novel_init', { book_dir: b.dir, title: '窗书', genre: 'xuanyi', logline: 'L' })
  return b
}
const terms = (files, dir) => JSON.parse(files.get(dir + '/bible.json')).terms

test('生效窗①: 窗口不重叠＝正常设定演进（不报冲突，且旧窗口与旧值原样保留）', async () => {
  const b = await book()
  await b.call('novel_ledger', { book_dir: b.dir, op: 'update_term', term: { name: '青玉令', value: '见令如见人', effective_from_ch: 1, effective_to_ch: 10 } })
  const r = await b.call('novel_ledger', { book_dir: b.dir, op: 'update_term', term: { name: '青玉令', value: '见令如见鬼', effective_from_ch: 11 } })
  assert.equal(r.ok, true, '窗口不重叠的演进不是冲突：' + JSON.stringify(r))
  assert.equal(terms(b.files, b.dir).length, 2, '必须是两条版本记录（旧窗口不被覆盖写毁掉）')
})

test('生效窗②: 按章投影各取各的（改口径不回头篡改历史）', async () => {
  const b = await book()
  await b.call('novel_ledger', { book_dir: b.dir, op: 'update_term', term: { name: '青玉令', value: '见令如见人', effective_from_ch: 1, effective_to_ch: 10 } })
  await b.call('novel_ledger', { book_dir: b.dir, op: 'update_term', term: { name: '青玉令', value: '见令如见鬼', effective_from_ch: 11 } })
  const at5 = await b.call('novel_bible', { book_dir: b.dir, ch: 5, scope: 'term' })
  const at12 = await b.call('novel_bible', { book_dir: b.dir, ch: 12, scope: 'term' })
  assert.equal(at5.terms[0].value, '见令如见人', '第 5 章时该词条仍是旧值（窗口投影）')
  assert.equal(at12.terms[0].value, '见令如见鬼')
  // 事实卡的世界观规则同口径（不得只按 from 过滤、漏掉 to——那会把已过期口径带进新章）
  const card = await b.call('novel_context', { book_dir: b.dir, op: 'factsheet', ch: 12 })
  assert.equal(card.sections.world_rules.length, 1)
  assert.equal(card.sections.world_rules[0].value, '见令如见鬼')
  const card5 = await b.call('novel_context', { book_dir: b.dir, op: 'factsheet', ch: 5 })
  assert.equal(card5.sections.world_rules[0].value, '见令如见人')
})

test('生效窗③: 窗口重叠且值不同＝真冲突（照旧拦，走仲裁）', async () => {
  const b = await book()
  await b.call('novel_ledger', { book_dir: b.dir, op: 'update_term', term: { name: '血月', value: '凶兆', effective_from_ch: 1 } })
  const conf = await b.call('novel_ledger', { book_dir: b.dir, op: 'update_term', term: { name: '血月', value: '吉兆', effective_from_ch: 5 } })
  assert.equal(conf.ok, false, '同一条词条在重叠窗口上换值＝真冲突，不许静默')
  assert.equal(conf.result.conflict.kind, 'term_value')
  assert.equal(terms(b.files, b.dir)[0].value, '凶兆', '冲突未裁决前账本不得改动')
})

test('生效窗④: 窗口重叠但值相同＝重复声明（不冲突，补字段）', async () => {
  const b = await book()
  await b.call('novel_ledger', { book_dir: b.dir, op: 'update_term', term: { name: '血月', value: '凶兆', effective_from_ch: 1 } })
  const again = await b.call('novel_ledger', { book_dir: b.dir, op: 'update_term', term: { name: '血月', value: '凶兆', evidence_ch: 7 } })
  assert.equal(again.ok, true)
  assert.equal(terms(b.files, b.dir).length, 1, '同窗同值＝修正补字段，不新增版本')
  assert.equal(terms(b.files, b.dir)[0].evidence_ch, 7)
})

test('生效窗⑤: 向后兼容——无窗口字段的老账本行为完全不变（仍拦）', async () => {
  const b = await book()
  await b.call('novel_ledger', { book_dir: b.dir, op: 'update_term', term: { name: '旧词', value: 'A' } })
  const conf = await b.call('novel_ledger', { book_dir: b.dir, op: 'update_term', term: { name: '旧词', value: 'B' } })
  assert.equal(conf.ok, false, '无窗口＝全书窗（与任何窗重叠），老账本照旧报冲突')
})

test('生效窗⑥: 人物性别同样纳入窗口（人设演进不再被当成吃书）', async () => {
  const b = await book()
  await b.call('novel_ledger', { book_dir: b.dir, op: 'update_character', character: { name: '林一', gender: '男', effective_from_ch: 1, effective_to_ch: 20 } })
  const r = await b.call('novel_ledger', { book_dir: b.dir, op: 'update_character', character: { name: '林一', gender: '女', effective_from_ch: 21 } })
  assert.equal(r.ok, true, '窗口不重叠的性别演进不是冲突')
  const chars = JSON.parse(b.files.get(b.dir + '/characters.json')).characters
  assert.equal(chars.length, 2, '两条版本记录并存')
})

// ── 时间线版本绑定（2026-09-18，外部体检 P1-D 处置）──────────────────────────
// 现象：改稿后旧叙述不退役、新版追加，事实层出现"平行版本"——
// 实测《第七封》79 条 timeline 里有 16 组同 ch+time 的双叙述（文本略有差异，
// 故旧的"同文本去重"抓不住）。与 term/character 是同一族问题，故用同一套口径：
// 事件带版本戳，读路径按各章**当前 rev** 投影；旧叙述原样留档但不进当前账。

test('时间线版本①: 改稿后只认当前版的叙述（旧版留档不进账）', async () => {
  const b = await book()
  await b.call('novel_chapter', { book_dir: b.dir, ch: 1, title: '一', text: '初稿正文。'.repeat(10), timeline_events: [{ time: '第一夜', what: '旧版叙述：他去了码头' }] })
  const ask1 = await b.call('novel_ask', { book_dir: b.dir, q: '时间线' })
  assert.equal(ask1.overview.timeline.length, 1, '初稿后应只有一条')

  // 改稿：换一版叙述（逐字不同，旧去重抓不住）+ 新增一条
  await b.call('novel_chapter', { book_dir: b.dir, ch: 1, title: '一', text: '改稿正文。'.repeat(10), timeline_events: [{ time: '第一夜', what: '新版叙述：他去了戏楼' }, { time: '第二夜', what: '新增：灯灭了' }] })
  const onDisk = JSON.parse(b.files.get(b.dir + '/timeline.json')).events
  assert.equal(onDisk.length, 3, 'append-only：磁盘上三条都在（旧叙述原样留档）')

  const ask2 = await b.call('novel_ask', { book_dir: b.dir, q: '时间线' })
  assert.equal(ask2.overview.timeline.length, 2, '当前账只认新版两条：' + JSON.stringify(ask2.overview.timeline))
  assert.ok(!ask2.overview.timeline.some((e) => e.what.includes('旧版叙述')), '旧版叙述不得进当前账')
  assert.ok(ask2.overview.timeline.some((e) => e.what.includes('新版叙述')))
})

test('时间线版本②: 无 rev 的旧事件仍全留（不误伤存量书）', async () => {
  const b = await book()
  // 手工塞一条"合并前产生"的事件（无 rev 字段）
  b.files.set(b.dir + '/timeline.json', JSON.stringify({ events: [{ ch: 1, time: '从前', what: '没有版本戳的旧事件' }] }))
  await b.call('novel_chapter', { book_dir: b.dir, ch: 1, title: '一', text: '正文。'.repeat(10), timeline_events: [{ time: '现在', what: '带版本戳的新事件' }] })
  const ask = await b.call('novel_ask', { book_dir: b.dir, q: '时间线' })
  assert.equal(ask.overview.timeline.length, 2, 'legacy 事件必须保留——宁可多给不可少给：漏报事实比多报更危险')
})

test('时间线版本③: novel_bible 的 timeline 与 novel_ask 同口径（处处一致）', async () => {
  const b = await book()
  await b.call('novel_chapter', { book_dir: b.dir, ch: 1, title: '一', text: '初稿。'.repeat(10), timeline_events: [{ time: 'T', what: '旧' }] })
  await b.call('novel_chapter', { book_dir: b.dir, ch: 1, title: '一', text: '改稿。'.repeat(10), timeline_events: [{ time: 'T', what: '新' }] })
  const bib = await b.call('novel_bible', { book_dir: b.dir, ch: 5, scope: 'timeline' })
  assert.equal(bib.timeline.length, 1, 'bible 也走同一投影：' + JSON.stringify(bib.timeline))
  assert.equal(bib.timeline[0].what, '新')
})
