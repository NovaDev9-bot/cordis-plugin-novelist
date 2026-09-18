// 书目封存（2026-09-18，外部体检 P0-C 处置）：账本此前没有"这本书不写了"的表达方式，
// 于是这个决定只能走到文件系统上（把正文挪走），而账本对此一无所知——
// 《第七封》28 章被移进 废稿-2026-09-16/ 后，status.json 仍写"存稿"、project.json 仍 drafting、
// verify 长期红灯。**根因不是"人不受约束"，是账本缺这类词；没有词，决定就只能在带外发生。**
//
// 四条边界一起锁：
//   ①封存必须带理由（无理由的终结在账上不允许关闭）；
//   ②跳过**已登记退役**的章，未登记的缺照旧报——静默依然失败，只是"有据的缺"与"无据的缺"分开了；
//   ③封存后不再接受正文写入（封存的意义就是这条产线停了）；
//   ④不可重复封存（重复＝有人没读账，报出来比静默覆盖好）。
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
  return { files, call: (n, a) => TOOLS.find((x) => x.name === n).execute(a, exec()) }
}

/** 写到 5 章、只剩 1、3 两章在盘上（模拟"28 章被移走"的缩小版）。 */
async function book() {
  const b = shimFs()
  b.dir = '/books/seal'
  await b.call('novel_init', { book_dir: b.dir, title: '封存测试', genre: 'x', logline: 'y' })
  for (let n = 1; n <= 5; n++) {
    await b.call('novel_outline', { book_dir: b.dir, op: 'write', volume: 1, ch: n, entry: { title: '第' + n + '章', goal: 'g', hook: 'h', differentiation: n === 1 ? 'd' : undefined, choice_axis: n === 1 ? { chosen: 'x' } : undefined } })
    await b.call('novel_chapter', { book_dir: b.dir, ch: n, title: '第' + n + '章', text: '正文。'.repeat(20) })
  }
  for (const n of [2, 4, 5]) b.files.delete(b.dir + '/manuscript/chapter_00' + n + '.md')   // 盘上移走
  return b
}

test('封存①：无理由拒封（无理由的终结在账上不允许关闭）', async () => {
  const b = await book()
  await assert.rejects(() => b.call('novel_ledger', { book_dir: b.dir, op: 'seal_book' }), /reason|理由/)
})

test('封存②：登记退役的章不再算缺陷；未登记的缺照旧报（静默依然失败）', async () => {
  const b = await book()
  const before = await b.call('novel_verify', { book_dir: b.dir })
  assert.ok(before.issues.some((s) => s.includes('缺正文')), '封存前应报缺正文：' + JSON.stringify(before.issues))

  // 只登记第 2 章退役——第 4/5 章仍是"无据的缺"
  const r = await b.call('novel_ledger', { book_dir: b.dir, op: 'seal_book', reason: '纯机制测试品，不发书', retired_chapters: [2] })
  assert.equal(r.ok, true)
  assert.deepEqual(r.result.still_on_disk, [1, 3])
  assert.deepEqual(r.result.unregistered_status_rows, [4, 5], '未登记的缺必须被点出来——否则"登记"就成了洗白手段')

  const v = await b.call('novel_verify', { book_dir: b.dir })
  const miss = v.issues.filter((s) => s.includes('缺正文'))
  assert.ok(miss.some((s) => s.includes('第 4')), '未登记的缺仍要报：' + JSON.stringify(v.issues))
  assert.ok(!miss.some((s) => s.includes('缺正文：1 章')), '已登记的第 2 章不该再单独成一条')
  assert.ok(v.stats.sealed && v.stats.sealed.retired === 1, '封存态应随 stats 出：' + JSON.stringify(v.stats))
})

test('封存③：封存后不再接受正文写入（要续写必须先解封并留痕）', async () => {
  const b = await book()
  await b.call('novel_ledger', { book_dir: b.dir, op: 'seal_book', reason: '封存', retired_chapters: [2, 4, 5] })
  await assert.rejects(
    () => b.call('novel_chapter', { book_dir: b.dir, ch: 6, title: '六', text: '新正文。'.repeat(20) }),
    /已封存|不再接受正文写入/,
  )
})

test('封存④：重复封存被拦（重复＝有人没读账，报出来比静默覆盖好）', async () => {
  const b = await book()
  await b.call('novel_ledger', { book_dir: b.dir, op: 'seal_book', reason: '第一次' })
  await assert.rejects(() => b.call('novel_ledger', { book_dir: b.dir, op: 'seal_book', reason: '第二次' }), /已封存/)
})

// ── 盘面 vs 账本（给智能体看的一致性检查）────────────────────────────────
// 《第七封》28 章被移进 废稿-2026-09-16/ 而账本一无所知。关键分级：
// **含章正文的账外目录 = issue**（章正文是账本必须知道的实体）；其他账外条目 = warning；
// 已封存且全部在退役清单内 = warning（登记过就不算无据）。

test('盘面①：账外目录含未登记退役的章 → issue', async () => {
  const b = await book()
  for (const n of [2, 4]) b.files.set(b.dir + '/废稿/chapter_00' + n + '.md', '正文')
  const v = await b.call('novel_verify', { book_dir: b.dir })
  assert.ok(v.issues.some((s) => s.includes('账外正文') && s.includes('未登记退役')), JSON.stringify(v.issues))
  assert.equal(v.ok, false)
})

test('盘面②：账外目录里的章全部已登记退役 → 降为 warning（登记过就不算无据）', async () => {
  const b = await book()
  await b.call('novel_ledger', { book_dir: b.dir, op: 'seal_book', reason: '封存', retired_chapters: [2, 4, 5] })
  for (const n of [2, 4, 5]) b.files.set(b.dir + '/废稿/chapter_00' + n + '.md', '正文')
  const v = await b.call('novel_verify', { book_dir: b.dir })
  assert.equal(v.issues.some((s) => s.includes('账外正文')), false, '已登记的归档不该报 issue：' + JSON.stringify(v.issues))
  assert.ok(v.warnings.some((s) => s.includes('账外条目') && s.includes('账实一致')), JSON.stringify(v.warnings))
})

test('盘面③：账外普通条目（非章正文）→ warning，不翻 ok', async () => {
  const b = await book()
  b.files.set(b.dir + '/随手记.md', 'x')
  const v = await b.call('novel_verify', { book_dir: b.dir })
  assert.ok(v.warnings.some((s) => s.includes('账外条目：随手记.md')), JSON.stringify(v.warnings))
  assert.equal(v.issues.some((s) => s.includes('随手记')), false, '工作产物允许存在，只是账外')
})

test('盘面④：已知条目与 assemble 产物不误报（全本.md / editorial / versions / manuscript）', async () => {
  const b = await book()
  const v = await b.call('novel_verify', { book_dir: b.dir })
  assert.equal(v.warnings.some((s) => s.includes('账外条目')), false, '账本自己的目录不该被当成账外：' + JSON.stringify(v.warnings))
})

test('封存⑤：封存留痕三处齐（project.sealed / 事件账 / 事件带）', async () => {
  const b = await book()
  await b.call('novel_ledger', { book_dir: b.dir, op: 'seal_book', reason: '纯测试品', retired_chapters: [2, 4, 5], actor: '主编' })
  const proj = JSON.parse(b.files.get(b.dir + '/project.json'))
  assert.equal(proj.status, 'sealed')
  assert.equal(proj.sealed.reason, '纯测试品')
  assert.deepEqual(proj.sealed.retired_chapters, [2, 4, 5])
  assert.ok(b.files.get(b.dir + '/events.jsonl').includes('book_seal'), '事件账要有 book_seal')
  assert.ok(b.files.get(b.dir + '/editorial/events-tape.jsonl').includes('封存'), '事件带要有一条')

  // 已封存的书，verify 立刻转绿（这正是这次处置的目的：别让红灯一直亮着）
  const v = await b.call('novel_verify', { book_dir: b.dir })
  assert.equal(v.issues.some((s) => s.includes('缺正文')), false, JSON.stringify(v.issues))
})
