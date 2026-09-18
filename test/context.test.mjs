// T2/B8 批（2026-09-17）：事实贡献账真实回滚语义 + 权威裁决回溯（事件带投影）+ novel_context。
// 每块先红后绿（TDD）。shim 对齐 DSH fs 服务契约（同 novelist.test.mjs shimFs 惯例）。
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

const charsOf = (files, dir) => JSON.parse(files.get(dir + '/characters.json')).characters
const factsRec = (files, dir, f) => JSON.parse(files.get(dir + '/editorial/facts/' + f))

test('T2 同正文不同事实拒绝同rev覆盖且零副作用', async () => {
  const { files, call } = shimFs()
  const args = { book_dir: '/books/same-rev', ch: 1, title: '一', text: '正文', cast: ['甲'] }
  await call('novel_chapter', args)
  const before = new Map(files)
  await assert.rejects(() => call('novel_chapter', { ...args, cast: [] }), /同 rev/)
  assert.deepEqual(files, before)
})

test('B8 chapter/volume/book 字面量投影、最新显式事实、纯只读', async () => {
  const { files, call } = shimFs()
  const dir = '/books/context'
  files.set(dir + '/project.json', JSON.stringify({ title: '测试书', current_ch: 2 }))
  files.set(dir + '/outline.json', JSON.stringify({ volumes: [
    { volume: 1, chapters: [{ chapter_no: 1, title: '入城', word_min: 10, word_max: 20 }] },
    { volume: 2, chapters: [{ chapter_no: 2, title: '出城', word_min: 30, word_max: 40 }] },
  ] }))
  files.set(dir + '/editorial/facts/chapter_001.v1.json', JSON.stringify({ ch: 1, rev: 1, cast: ['旧人'], seeds: [{ id: 'F1' }], closes: [], timeline: [{ what: '入城' }] }))
  files.set(dir + '/editorial/facts/chapter_001.v2.json', JSON.stringify({ ch: 1, rev: 2, cast: ['甲'] }))
  files.set(dir + '/editorial/facts/chapter_002.v1.json', JSON.stringify({ ch: 2, rev: 1, cast: ['乙'], seeds: [], closes: ['F1'], timeline: [{ what: '出城' }, { what: '关门' }] }))
  const before = new Map(files)
  const chapter = await call('novel_context', { book_dir: dir })
  assert.deepEqual(chapter.detail, [
    { ch: 1, volume: 1, title: '入城', cast: ['甲'], seeds: ['F1'], closes: [], timeline_count: 1, word_min: 10, word_max: 20 },
    { ch: 2, volume: 2, title: '出城', cast: ['乙'], seeds: [], closes: ['F1'], timeline_count: 2, word_min: 30, word_max: 40 },
  ])
  assert.equal(chapter.older_count, 0)
  const volume = await call('novel_context', { book_dir: dir, layer: 'volume' })
  assert.deepEqual(volume.detail, [
    { volume: 1, chapters: 1, cast_count: 1, seeds_count: 1, closes_count: 0, timeline_count: 1, word_min: 10, word_max: 20 },
    { volume: 2, chapters: 1, cast_count: 1, seeds_count: 0, closes_count: 1, timeline_count: 2, word_min: 30, word_max: 40 },
  ])
  const book = await call('novel_context', { book_dir: dir, layer: 'book' })
  assert.deepEqual(book.detail, [{ title: '测试书', chapters: 2, cast_count: 2, seeds_count: 1, closes_count: 1, timeline_count: 3, word_min: 40, word_max: 60 }])
  assert.deepEqual(files, before)
})

test('B8 chapter 默认最近24章、window闭区间显式扩展与收窄', async () => {
  const { files, call } = shimFs()
  const dir = '/books/window'
  files.set(dir + '/outline.json', JSON.stringify({ volumes: [{ volume: 1, chapters: Array.from({ length: 30 }, (_, i) => ({ chapter_no: i + 1 })) }] }))
  const recent = await call('novel_context', { book_dir: dir })
  assert.equal(recent.detail.length, 24)
  assert.equal(recent.detail[0].ch, 7)
  assert.equal(recent.older_count, 6)
  const win = await call('novel_context', { book_dir: dir, window: { from: 2, to: 3 } })
  assert.deepEqual(win.detail.map((e) => e.ch), [2, 3])
  const full = await call('novel_context', { book_dir: dir, window: { from: 1, to: 30 } })
  assert.equal(full.detail.length, 30)
})

test('B8 checkpoint读取最新条目；旧书无tape明确未启用且不写文件', async () => {
  const { files, call } = shimFs()
  const dir = '/books/checkpoint'
  files.set(dir + '/project.json', '{"title":"旧书"}')
  const empty = await call('novel_context', { book_dir: dir, op: 'checkpoint' })
  assert.equal(empty.checkpoint, null)
  assert.match(empty.note, /尚无 checkpoint/)
  await call('novel_event', { book_dir: dir, op: 'append', kind: 'checkpoint', ch: 2, what: '断点二', why: '压缩', actor: '主编' })
  await call('novel_event', { book_dir: dir, op: 'append', kind: 'checkpoint', ch: 9, what: '断点九', why: '压缩', actor: '主编' })
  await call('novel_event', { book_dir: dir, op: 'append', kind: 'decision', what: '不是断点', why: '决策', actor: '主编' })
  const latest = await call('novel_context', { book_dir: dir, op: 'checkpoint' })
  assert.equal(latest.ch, 9)
  assert.equal(latest.checkpoint.what, '断点九')
})

// ---------------------------------------------------------------- review 批（2026-09-17）：稀疏投影一致性 + checkpoint 撤销过滤

test('review①: novel_ask ch 投影与 rebuildLastSeen 同口径——省略 cast 的更高 rev 不清空出场（稀疏声明投影）', async () => {
  const { files, call } = shimFs()
  const dir = '/books/review-ask-proj'
  files.set(dir + '/project.json', JSON.stringify({ title: '投影测试', current_ch: 3 }))
  files.set(dir + '/characters.json', JSON.stringify({ characters: [{ name: '甲', last_seen_ch: 1 }, { name: '乙', last_seen_ch: 3 }] }))
  // ch1：v1 显式声明 甲+乙，v2 省略 cast（不声明）；ch3：v1 显式声明 乙
  files.set(dir + '/editorial/facts/chapter_001.v1.json', JSON.stringify({ ch: 1, rev: 1, cast: ['甲', '乙'] }))
  files.set(dir + '/editorial/facts/chapter_001.v2.json', JSON.stringify({ ch: 1, rev: 2 }))
  files.set(dir + '/editorial/facts/chapter_003.v1.json', JSON.stringify({ ch: 3, rev: 1, cast: ['乙'] }))

  const a = await call('novel_ask', { book_dir: dir, q: '甲', ch: 3 })
  assert.equal(a.matches[0].card.last_seen_ch, 1, '甲 在 ch1 v1 的显式声明必须存活——最高 rev 文件省略 cast ≠ 删除（与 rebuildLastSeen 同口径）：' + JSON.stringify(a.matches[0].card))
  assert.equal(a.matches[0].card.last_seen_ch_full, 1)

  const b = await call('novel_ask', { book_dir: dir, q: '乙', ch: 2 })
  assert.equal(b.matches[0].card.last_seen_ch, 1, '乙 ch3 的声明 > 基准章 2，投影到 ≤2 只剩 ch1：' + JSON.stringify(b.matches[0].card))

  const c = await call('novel_ask', { book_dir: dir, q: '乙', ch: 3 })
  assert.equal(c.matches[0].card.last_seen_ch, 3, '乙 在 ch3 的声明全量可见')
})

test('review②: novel_context checkpoint 过滤被 supersedes 撤销的条目（最新被撤→回退到仍有效者）', async () => {
  const { call } = shimFs()
  const dir = '/books/review-ckpt'
  const c1 = await call('novel_event', { book_dir: dir, op: 'append', kind: 'checkpoint', ch: 2, what: '断点二', why: '压缩', actor: '主编' })
  await call('novel_event', { book_dir: dir, op: 'append', kind: 'checkpoint', ch: 9, what: '断点九', why: '压缩', actor: '主编' })
  assert.equal(c1.id, 't001')
  await call('novel_event', { book_dir: dir, op: 'append', kind: 'decision', what: '撤销断点九', why: '续跑锚作废', actor: '主编', supersedes: 't002' })

  const latest = await call('novel_context', { book_dir: dir, op: 'checkpoint' })
  assert.equal(latest.checkpoint.id, 't001', '被撤销的 t002 不得作为最近检查点返回：' + JSON.stringify(latest.checkpoint))
  assert.equal(latest.ch, 2)

  // 全部检查点被撤销 → 明报尚无（不冒充残留锚）
  await call('novel_event', { book_dir: dir, op: 'append', kind: 'decision', what: '撤销断点二', why: '清理', actor: '主编', supersedes: 't001' })
  const none = await call('novel_context', { book_dir: dir, op: 'checkpoint' })
  assert.equal(none.checkpoint, null)
  assert.match(none.note, /尚无 checkpoint/)
})

// ---------------------------------------------------------------- T2 真实回滚语义（事实贡献账）

test('T2 回滚①: 修订省略 cast 不清空上一版声明（省略≠清空；显式空数组才表示删除）', async () => {
  const { files, call } = shimFs()
  const dir = '/books/t2-omit'
  files.set(dir + '/characters.json', JSON.stringify({ characters: [{ name: '甲' }, { name: '乙' }] }))
  await call('novel_chapter', { book_dir: dir, ch: 1, title: '一', text: '第一章正文。'.repeat(6), cast: ['甲', '乙'] })
  await call('novel_chapter', { book_dir: dir, ch: 3, title: '三', text: '第三章正文。'.repeat(6), cast: ['乙'] })
  const chars = () => charsOf(files, dir)
  assert.equal(chars().find((c) => c.name === '乙').last_seen_ch, 3)

  // 修订第 3 章、不声明 cast：省略 = 本版不做新声明，第 3 章的乙（v1 声明）必须保留
  await call('novel_chapter', { book_dir: dir, ch: 3, title: '三', text: '第三章修订后的正文文字。'.repeat(6), expected_rev: 1 })
  const v2 = factsRec(files, dir, 'chapter_003.v2.json')
  assert.equal('cast' in v2, false, '省略 cast 不得记成 cast:[]（那会与显式删除混淆）')
  assert.equal(chars().find((c) => c.name === '乙').last_seen_ch, 3, '乙 不得因省略被清出第 3 章（真实回滚语义）')
})

test('T2 回滚②: 显式空数组才表示删除——cast:[] 后 last_seen 清空（旧实现静默保留=脏账）', async () => {
  const { files, call } = shimFs()
  const dir = '/books/t2-empty'
  files.set(dir + '/characters.json', JSON.stringify({ characters: [{ name: '甲' }, { name: '乙' }] }))
  await call('novel_chapter', { book_dir: dir, ch: 1, title: '一', text: '第一章正文。'.repeat(6), cast: ['甲', '乙'] })
  const chars = () => charsOf(files, dir)
  assert.equal(chars().find((c) => c.name === '甲').last_seen_ch, 1)

  // 显式声明"本章无人出场"：唯一出场章被抹 → 两人 last_seen 应清空（不是静默保留旧值）
  await call('novel_chapter', { book_dir: dir, ch: 1, title: '一', text: '第一章重写：全员不出场。'.repeat(6), cast: [], expected_rev: 1 })
  assert.equal(chars().find((c) => c.name === '甲').last_seen_ch ?? null, null, '显式 [] 应删除 甲 的出场账')
  assert.equal(chars().find((c) => c.name === '乙').last_seen_ch ?? null, null, '显式 [] 应删除 乙 的出场账')
})

test('T2 回滚③: 恢复旧正文不等于恢复全书事实——回滚后账面不自动倒回，显式重声明才改', async () => {
  const { files, call } = shimFs()
  const dir = '/books/t2-rollback'
  files.set(dir + '/characters.json', JSON.stringify({ characters: [{ name: '甲' }, { name: '丙' }, { name: '丁' }] }))
  await call('novel_chapter', { book_dir: dir, ch: 2, title: '二', text: '第二章第一版。'.repeat(6), cast: ['甲', '丙'] })
  await call('novel_chapter', { book_dir: dir, ch: 2, title: '二', text: '第二章第二版加了丁。'.repeat(6), cast: ['甲', '丙', '丁'], expected_rev: 1 })
  const chars = () => charsOf(files, dir)
  assert.equal(chars().find((c) => c.name === '丁').last_seen_ch, 2)

  // 回滚正文到 v1（回滚不声明 cast）：正文回到旧版，但事实账不自动倒回——
  // 丁/丙 的 last_seen 仍按最近一次显式声明（v2）保留，回滚不是事实恢复操作
  const back = await call('novel_chapter', { book_dir: dir, ch: 2, title: '二', rollback_to_rev: 1 })
  assert.equal(back.rev, 3)
  assert.equal('cast' in factsRec(files, dir, 'chapter_002.v3.json'), false, '回滚未声明 cast=不声明，不冒充空名单')
  assert.equal(chars().find((c) => c.name === '丁').last_seen_ch, 2, '回滚正文不自动删除 丁 的事实（账面不自动倒回）')

  // 显式重声明（v4 带 ['甲']）：丁/丙 才真正被删出第 2 章
  await call('novel_chapter', { book_dir: dir, ch: 2, title: '二', text: '第二章第三版只留甲。'.repeat(6), cast: ['甲'], expected_rev: 3 })
  assert.equal(chars().find((c) => c.name === '甲').last_seen_ch, 2)
  assert.equal(chars().find((c) => c.name === '丙').last_seen_ch ?? null, null, '显式重声明才删除 丙')
  assert.equal(chars().find((c) => c.name === '丁').last_seen_ch ?? null, null, '显式重声明才删除 丁')
})

test('T2 回滚④: append-only——已完成的贡献账不得被同 rev 改写，旧版字节永不被后续提交触碰', async () => {
  const { files, call } = shimFs()
  const dir = '/books/t2-immutable'
  await call('novel_chapter', { book_dir: dir, ch: 1, title: '一', text: '第一章正文。'.repeat(6), cast: ['甲'] })
  const v1Bytes = files.get(dir + '/editorial/facts/chapter_001.v1.json')

  // 固定旧戳，避免同毫秒重写侥幸通过字节比较。
  const stored = JSON.parse(v1Bytes)
  stored.ts = '2000-01-01T00:00:00.000Z'
  files.set(dir + '/editorial/facts/chapter_001.v1.json', JSON.stringify(stored))
  const immutable = files.get(dir + '/editorial/facts/chapter_001.v1.json')
  // 同参重试（deduped）：回执不翻 rev，事实账保持同一份字节（不允许同 rev 改写已完成贡献）
  const r2 = await call('novel_chapter', { book_dir: dir, ch: 1, title: '一', text: '第一章正文。'.repeat(6), cast: ['甲'] })
  assert.equal(r2.deduped, true)
  assert.equal(files.get(dir + '/editorial/facts/chapter_001.v1.json'), immutable, '同参重试不得改写 v1 贡献账')

  // 修订产生 v2 后，v1 依然逐字节保留（append-only）
  await call('novel_chapter', { book_dir: dir, ch: 1, title: '一', text: '第一章修订。'.repeat(6), cast: ['甲', '乙'], expected_rev: 1 })
  assert.equal(files.get(dir + '/editorial/facts/chapter_001.v1.json'), immutable, '旧版贡献账不被后续提交触碰')
  assert.deepEqual(factsRec(files, dir, 'chapter_001.v2.json').cast, ['甲', '乙'])
})
