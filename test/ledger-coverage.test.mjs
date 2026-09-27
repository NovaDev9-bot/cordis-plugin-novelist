// 账本完整性回归（2026-09-26 总纲批次一 D1/D2）：
//   D2 —— novel_ledger op=rule 写 rules.json，而 novel_verify「账外条目」检查的已知清单漏登记它：
//         工具自己的产物被自家探针报成账外（内部不一致，试写样书实测复现）。已知清单扩容后，
//         探针不得钝化——来路不明的顶层条目仍须报（最后一段断言）。
//   D1 —— 覆盖断言：已收束章（chapter_commit 在账）缺本章 timeline 条目/事实贡献账记录 ⇒
//         warning（不拦稿）；补齐 ⇒ 绿；全书无一条时间线＝未启用，不报（存量书不误报）。
// 纪律：书无关——全部用合成账本验证（shimFs 内存账本，与 audit-regressions 同款）。
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
    remove: async (p) => { files.delete(p) },
  }
  const exec = () => ({ agent: { ctx: { get: (k) => (k === 'fs' ? fs : undefined) } } })
  return { files, call: (n, a) => { const t = TOOLS.find((x) => x.name === n); if (!t) throw new Error('no tool ' + n); return t.execute(a, exec()) } }
}

const DIR = '/books/lc'
const BODY = (n) => '巷口的灯忽明忽暗，他数着铜钱，一遍又一遍。'.repeat(6) + '第' + n + '章末，他把纸压回原处。'

/** 三章合成书：默认三章都带 timeline_events（绿基线）；ch2Timeline=false 时 ch2 漏带（复刻试写样书 D1 现场）。 */
async function book3(ch2Timeline = true) {
  const b = shimFs()
  await b.call('novel_init', { book_dir: DIR, title: 'T', genre: 'xuanyi', logline: 'L' })
  for (const ch of [1, 2, 3]) {
    await b.call('novel_outline', { book_dir: DIR, op: 'write', volume: 1, ch, entry: { title: '章' + ch, goal: 'g', differentiation: 'X', choice_axis: { chosen: '甲', sacrificed: ['乙'] }, word_min: 200, word_max: 4000 } })
    const args = { book_dir: DIR, ch, title: '章' + ch, text: BODY(ch) }
    if (ch !== 2 || ch2Timeline) args.timeline_events = [{ time: '第' + ch + '日', what: '第' + ch + '章的大事' }]
    await b.call('novel_chapter', args)
  }
  return b
}

test('D2: op=rule 写下的 rules.json 不得被 verify 报成「账外条目」；探针不钝化', async () => {
  const { files, call } = shimFs()
  await call('novel_init', { book_dir: DIR, title: 'T', genre: 'xuanyi', logline: 'L' })
  const w = await call('novel_ledger', { book_dir: DIR, op: 'rule', rule: { name: '闸规', text: '戌时落闸，闸开不渡人', effective_from_ch: 1 } })
  assert.equal(w.ok, true, JSON.stringify(w))
  assert.ok(files.has(DIR + '/rules.json'), 'op=rule 必须真的落了 rules.json')
  const v = await call('novel_verify', { book_dir: DIR })
  const outside = v.warnings.filter((x) => x.includes('账外条目'))
  assert.equal(outside.length, 0, '工具自己写的 rules.json 被自家 verify 报账外（D2 内部不一致）：' + JSON.stringify(outside))
  // 探针不钝化对照：真正来路不明的顶层条目仍要报
  files.set(DIR + '/来历不明/note.txt', 'x')
  const v2 = await call('novel_verify', { book_dir: DIR })
  assert.ok(v2.warnings.some((x) => x.includes('账外条目') && x.includes('来历不明')), '已知清单扩容不得把探针钝化：' + JSON.stringify(v2.warnings))
})

test('D1: 缺一章 timeline ⇒ verify 报 warning 具名到章且不拦稿；补齐 ⇒ 绿', async () => {
  const { files, call } = await book3()
  // 基线：三章都有时间线时不得报
  const v0 = await call('novel_verify', { book_dir: DIR })
  assert.equal(v0.warnings.some((x) => x.includes('时间线覆盖缺口')), false, '三章齐时不应报：' + JSON.stringify(v0.warnings))
  // 故意挖掉 ch2 的条目（复刻"ch2 收束时漏带 timeline_events"）
  const tml = JSON.parse(files.get(DIR + '/timeline.json'))
  tml.events = tml.events.filter((e) => e.ch !== 2)
  files.set(DIR + '/timeline.json', JSON.stringify(tml, null, 2))
  const v1 = await call('novel_verify', { book_dir: DIR })
  const gap = v1.warnings.filter((x) => x.includes('时间线覆盖缺口'))
  assert.equal(gap.length, 1, '缺章必须报出：' + JSON.stringify(v1.warnings))
  assert.ok(gap[0].includes('第 2 章'), '要具名到章：' + gap[0])
  assert.equal(v1.ok, true, '覆盖缺口是 warning 不是 issue——不拦稿：' + JSON.stringify(v1.issues))
  // 补齐 ⇒ 绿
  tml.events.push({ ch: 2, rev: 1, time: '第二日', what: '补记的账' })
  files.set(DIR + '/timeline.json', JSON.stringify(tml, null, 2))
  const v2 = await call('novel_verify', { book_dir: DIR })
  assert.equal(v2.warnings.some((x) => x.includes('时间线覆盖缺口')), false, '补齐后必须回到绿：' + JSON.stringify(v2.warnings))
})

test('D1: 全书无一条时间线＝未启用，不给存量书刷屏（采用门）', async () => {
  const b = shimFs()
  await b.call('novel_init', { book_dir: DIR, title: 'T', genre: 'xuanyi', logline: 'L' })
  for (const ch of [1, 2]) {
    await b.call('novel_outline', { book_dir: DIR, op: 'write', volume: 1, ch, entry: { title: '章' + ch, goal: 'g', differentiation: 'X', choice_axis: { chosen: '甲', sacrificed: ['乙'] }, word_min: 200, word_max: 4000 } })
    await b.call('novel_chapter', { book_dir: DIR, ch, title: '章' + ch, text: BODY(ch) })
  }
  const v = await b.call('novel_verify', { book_dir: DIR })
  assert.equal(v.warnings.some((x) => x.includes('时间线覆盖缺口')), false, '一条时间线都没有的书＝未启用，不报：' + JSON.stringify(v.warnings))
})

test('D1: 已收束章缺 facts 贡献账 ⇒ warning；贡献账全无（纯旧书形态）不启用不报', async () => {
  const { files, call } = await book3()
  // 挖掉 ch2 的贡献账文件（启用期内出现空洞——手改/外部导入那一路）
  const factKey = [...files.keys()].find((k) => k.startsWith(DIR + '/editorial/facts/chapter_002.'))
  assert.ok(factKey, '提交应产出 ch2 贡献账文件：' + [...files.keys()].filter((k) => k.includes('/facts/')).join(','))
  files.delete(factKey)
  const v1 = await call('novel_verify', { book_dir: DIR })
  assert.ok(v1.warnings.some((x) => x.includes('事实贡献账覆盖缺口') && x.includes('第 2 章')), JSON.stringify(v1.warnings))
  assert.equal(v1.ok, true, '覆盖缺口不拦稿：' + JSON.stringify(v1.issues))
  // 全删（纯旧书形态）⇒ 不启用
  for (const k of [...files.keys()]) if (k.startsWith(DIR + '/editorial/facts/')) files.delete(k)
  const v2 = await call('novel_verify', { book_dir: DIR })
  assert.equal(v2.warnings.some((x) => x.includes('事实贡献账覆盖缺口')), false, '纯旧书不启用不报：' + JSON.stringify(v2.warnings))
})
