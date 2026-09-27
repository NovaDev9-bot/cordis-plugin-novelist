// 字数窗口按章功能分档回归（2026-09-26 总纲批次二 C7）：
//   novel_outline 的字数窗口从常数改为两档——波峰章（蓝图 peaks 表点名）/基线章（其余），
//   档位由蓝图波峰表定（novel_ledger op=blueprint 落的 blueprint.json）；
//   蓝图未立回退现行常数 [3000,4000]（两档同值＝不分档）。
//   ①read 必带 word_windows（fallback / blueprint 两形态，note 说明档位与 Owner 旋钮）；
//   ②write 缺省窗口按本章档位自动补窗（applied='tier'），显式窗口尊重不覆盖
//     （applied='entry'，另附 tier_window 对照），落账值与返回一致；
//   ③默认档位 50 万字数学自洽：波峰占比按 peak_gap_target 缺省中值 10 章/峰 ⇒
//     225×基线均值 1900＋25×波峰均值 2900＝500,000＝250 章×2000（恒等式）。
// 纪律：书无关——全部用合成账本验证（shimFs 内存账本，与 blueprint-ledger 同款），跑完即弃。
import test from 'node:test'
import assert from 'node:assert/strict'
import { _internals } from '../lib/novelist.js'

const { TOOLS, WORD_WINDOW_BASELINE, WORD_WINDOW_PEAK, WORD_WINDOW_FALLBACK } = _internals

function shimFs(files = new Map()) {
  const fs = {
    resolve: async (p) => String(p).replace(/\/+/g, '/'),
    stat: async (p) => (files.has(p) ? { size: files.get(p).length } : null),
    readText: async (p) => { if (!files.has(p)) throw new Error('ENOENT ' + p); return files.get(p) },
    writeText: async (p, s) => { files.set(p, s) },
    listDir: async (p) => [...files.keys()].filter((k) => k.startsWith(p + '/')).map((k) => ({ name: k.slice(p.length + 1).split('/')[0] })),
    remove: async (p) => { files.delete(p) },
  }
  const exec = () => ({ agent: { ctx: { get: (k) => (k === 'fs' ? fs : undefined) } } })
  return {
    files,
    call: (n, a) => { const t = TOOLS.find((x) => x.name === n); if (!t) throw new Error('no tool ' + n); return t.execute(a, exec()) },
  }
}

const DIR = '/books/c7'
const entry = (over = {}) => Object.assign({ title: '章', goal: 'g', hook: 'h', differentiation: 'X' }, over)

/** 一本只有章纲的合成书（可选先立蓝图）。 */
async function book(tiersBlueprint) {
  const b = shimFs()
  await b.call('novel_init', { book_dir: DIR, title: 'T', genre: 'xuanyi', logline: 'L' })
  if (tiersBlueprint) {
    const w = await b.call('novel_ledger', { book_dir: DIR, op: 'blueprint', blueprint: tiersBlueprint })
    assert.equal(w.ok, true, '蓝图应落账：' + JSON.stringify(w))
  }
  return b
}

const bp = (over = {}) => Object.assign({
  volume: 1, status: 'draft', note: 'C7 回归草案',
  chain: [{ id: 'N1', name: '开局', ch_from: 1, ch_to: 12 }],
  lines: [{ id: 'L1', name: '主线', opening: { ch: 1, what: '起' }, closing: null }],
  peaks: [{ id: 'P1', ch: 10, name: '波峰一' }, { id: 'P2', ch: 3, name: '小高潮' }],
  milestones: [{ id: 'M1', kind: '卷终', ch: 12 }],
}, over)

test('C7: 无蓝图 read → word_windows.mode=fallback，两档同值回退现行常数 [3000,4000]，note 说明', async () => {
  const { call } = await book()
  const rd = await call('novel_outline', { book_dir: DIR, op: 'read' })
  const wv = rd.word_windows
  assert.ok(wv, 'read 必带 word_windows（C7）')
  assert.equal(wv.mode, 'fallback', JSON.stringify(wv))
  assert.deepEqual(wv.baseline, { word_min: 3000, word_max: 4000 }, '基线档回退现行常数：' + JSON.stringify(wv.baseline))
  assert.deepEqual(wv.peak, { word_min: 3000, word_max: 4000 }, '波峰档同值＝不分档：' + JSON.stringify(wv.peak))
  assert.deepEqual(wv.peak_chapters, [], '无蓝图＝无波峰章')
  assert.ok(wv.note.includes('回退现行常数') && wv.note.includes('novel_ledger op=blueprint'), 'note 必须说明回退与去立蓝图：' + wv.note)
})

test('C7: 无蓝图 write 缺省窗口 → 按回退常数补窗（applied=tier），落账生效', async () => {
  const { call, files } = await book()
  const w = await call('novel_outline', { book_dir: DIR, op: 'write', volume: 1, ch: 1, entry: entry() })
  assert.equal(w.word_window.applied, 'tier', JSON.stringify(w.word_window))
  assert.equal(w.word_window.tier, 'baseline')
  assert.deepEqual([w.word_window.word_min, w.word_window.word_max], [3000, 4000], '回退常数补窗')
  const onDisk = JSON.parse(files.get(DIR + '/outline.json'))
  assert.deepEqual([onDisk.volumes[0].chapters[0].word_min, onDisk.volumes[0].chapters[0].word_max], [3000, 4000], '落账生效')
})

test('C7: 蓝图波峰表定档 → read 报 peak_chapters；波峰章/基线章 write 缺省各按档补窗', async () => {
  const { call, files } = await book(bp())
  const rd = await call('novel_outline', { book_dir: DIR, op: 'read' })
  const wv = rd.word_windows
  assert.equal(wv.mode, 'blueprint', JSON.stringify(wv))
  assert.deepEqual(wv.peak_chapters, [3, 10], '波峰表点名章号升序去重：' + JSON.stringify(wv.peak_chapters))
  assert.deepEqual(wv.baseline, WORD_WINDOW_BASELINE, '基线档=常量')
  assert.deepEqual(wv.peak, WORD_WINDOW_PEAK, '波峰档=常量')
  assert.ok(wv.note.includes('Owner 可调旋钮'), 'note 必须标 Owner 旋钮：' + wv.note)
  assert.ok(wv.peak_ids.includes('P1') && wv.peak_ids.includes('P2'), '波峰 id 可追溯')

  const base = await call('novel_outline', { book_dir: DIR, op: 'write', volume: 1, ch: 2, entry: entry() })
  assert.equal(base.word_window.tier, 'baseline')
  assert.deepEqual([base.word_window.word_min, base.word_window.word_max], [WORD_WINDOW_BASELINE.word_min, WORD_WINDOW_BASELINE.word_max], '基线章按基线档补窗：' + JSON.stringify(base.word_window))
  const peak = await call('novel_outline', { book_dir: DIR, op: 'write', volume: 1, ch: 3, entry: entry() })
  assert.equal(peak.word_window.tier, 'peak')
  assert.deepEqual([peak.word_window.word_min, peak.word_window.word_max], [WORD_WINDOW_PEAK.word_min, WORD_WINDOW_PEAK.word_max], '波峰章按波峰档补窗：' + JSON.stringify(peak.word_window))
  const onDisk = JSON.parse(files.get(DIR + '/outline.json'))
  const c2 = onDisk.volumes[0].chapters.find((c) => c.chapter_no === 2)
  const c3 = onDisk.volumes[0].chapters.find((c) => c.chapter_no === 3)
  assert.deepEqual([c2.word_min, c2.word_max], [WORD_WINDOW_BASELINE.word_min, WORD_WINDOW_BASELINE.word_max])
  assert.deepEqual([c3.word_min, c3.word_max], [WORD_WINDOW_PEAK.word_min, WORD_WINDOW_PEAK.word_max])
})

test('C7: 显式窗口尊重不覆盖（applied=entry＋tier_window 对照），落账保持显式值', async () => {
  const { call, files } = await book(bp())
  const w = await call('novel_outline', { book_dir: DIR, op: 'write', volume: 1, ch: 4, entry: entry({ word_min: 5000, word_max: 6000 }) })
  assert.equal(w.word_window.applied, 'entry', JSON.stringify(w.word_window))
  assert.deepEqual([w.word_window.word_min, w.word_window.word_max], [5000, 6000], 'word_window 报生效值=显式值')
  assert.deepEqual(w.word_window.tier_window, { word_min: WORD_WINDOW_BASELINE.word_min, word_max: WORD_WINDOW_BASELINE.word_max }, '档位缺省窗另附对照')
  const onDisk = JSON.parse(files.get(DIR + '/outline.json'))
  const c4 = onDisk.volumes[0].chapters.find((c) => c.chapter_no === 4)
  assert.deepEqual([c4.word_min, c4.word_max], [5000, 6000], '落账保持显式值')
})

test('C7: 显式只给一头（word_min 有/word_max 无）→ 不自动补，尊重半声明不臆造另一半', async () => {
  const { call } = await book(bp())
  const w = await call('novel_outline', { book_dir: DIR, op: 'write', volume: 1, ch: 6, entry: entry({ word_min: 2000 }) })
  assert.equal(w.word_window.applied, 'entry', JSON.stringify(w.word_window))
  assert.equal(w.word_window.word_min, 2000)
  assert.equal(w.word_window.word_max, undefined, '不臆造缺的那头')
})

test('C7: 默认档位 50 万字数学自洽（225×基线均值＋25×波峰均值＝250×2000 恒等）＋fallback=现行常数', () => {
  const center = (w) => (w.word_min + w.word_max) / 2
  const total = 225 * center(WORD_WINDOW_BASELINE) + 25 * center(WORD_WINDOW_PEAK)
  assert.equal(total, 250 * 2000, '波峰占比按 peak_gap_target 缺省中值 10 章/峰（25/250）：实得 ' + total)
  assert.deepEqual(WORD_WINDOW_FALLBACK, { word_min: 3000, word_max: 4000 }, '回退档=v6.7 起现行常数')
})

test('C7: 蓝图存在但 peaks 为空 → 仍 fallback（无波峰表则无从定档，不臆造）', async () => {
  const { call } = await book(bp({ peaks: [] }))
  const rd = await call('novel_outline', { book_dir: DIR, op: 'read' })
  assert.equal(rd.word_windows.mode, 'fallback', JSON.stringify(rd.word_windows))
  assert.deepEqual(rd.word_windows.baseline, { word_min: 3000, word_max: 4000 })
})
