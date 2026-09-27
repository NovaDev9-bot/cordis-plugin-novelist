// 书目分类（2026-09-26 总纲批次三 D3）：练手/正典进账。
// 由来：练手标记此前只住在会话工作区头注，账本侧 project.json 无标记——只看书目录无法判断
// 这本书进不进正典，违背"账本=system of record"。落点：project.json.classification
// （书目级生命周期元数据，与 status/sealed 同族；bible 的 terms 是世界观词条，不放这）。
// 写入三口：novel_init 建书声明（缺省 canonical）｜novel_ledger op=classify_book 补记/改判｜
// op=seal_book 封存时一并声明（总纲原文："seal_book 语义旁加练手/正典分类"）。
// verify 可读：stats.classification 随书出（仅带标记的书有此键；旧书未标记不出键，不误报存量书）。
// 验收（2026-09-26 定案）：模拟书带标记落账、verify 可读——本文件即守卫。
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

async function book() {
  const b = shimFs()
  b.dir = '/books/classify'
  await b.call('novel_init', { book_dir: b.dir, title: '分类测试', genre: 'x', logline: 'y' })
  return b
}

test('分类①：novel_init 带分类落账；缺省＝canonical（正典生产是常态，练手须显式声明）', async () => {
  const b = shimFs()
  b.dir = '/books/a'
  await b.call('novel_init', { book_dir: b.dir, title: '练手书', genre: 'x', logline: 'y', classification: 'practice' })
  const proj1 = JSON.parse(b.files.get(b.dir + '/project.json'))
  assert.equal(proj1.classification, 'practice')

  b.dir = '/books/b'
  await b.call('novel_init', { book_dir: b.dir, title: '正典书', genre: 'x', logline: 'y' })
  const proj2 = JSON.parse(b.files.get(b.dir + '/project.json'))
  assert.equal(proj2.classification, 'canonical')
})

test('分类②：novel_init 非法值显式拒收（不静默归 canonical）', async () => {
  const b = shimFs()
  b.dir = '/books/c'
  await assert.rejects(
    () => b.call('novel_init', { book_dir: b.dir, title: 'x', genre: 'x', logline: 'y', classification: 'test' }),
    /classification/,
  )
})

test('分类③：op=classify_book 补记落账（project + 事件账 + 事件带三处留痕）', async () => {
  const b = await book()
  const r = await b.call('novel_ledger', { book_dir: b.dir, op: 'classify_book', classification: 'practice', reason: '2026-09-26 定案：试写样书补记', actor: '主编' })
  assert.equal(r.ok, true)
  assert.equal(r.result.classification, 'practice')
  assert.equal(r.result.from, 'canonical', 'init 已缺省落 canonical，补记的 from 应如实报')

  const proj = JSON.parse(b.files.get(b.dir + '/project.json'))
  assert.equal(proj.classification, 'practice')
  assert.ok(b.files.get(b.dir + '/events.jsonl').includes('book_classify'), '事件账要有 book_classify')
  assert.ok(b.files.get(b.dir + '/editorial/events-tape.jsonl').includes('书目分类'), '事件带要留痕')
})

test('分类④：op=classify_book 非法值拒收（两档之外没有第三种书）', async () => {
  const b = await book()
  await assert.rejects(
    () => b.call('novel_ledger', { book_dir: b.dir, op: 'classify_book', classification: 'demo' }),
    /classification/,
  )
})

test('分类⑤：seal_book 语义旁带分类——封存时一并落账，事件账随记；不带＝不动原字段', async () => {
  const b = await book()
  await b.call('novel_ledger', { book_dir: b.dir, op: 'seal_book', reason: '练手写完归档', seal_status: 'sealed', classification: 'practice' })
  const proj = JSON.parse(b.files.get(b.dir + '/project.json'))
  assert.equal(proj.sealed.reason, '练手写完归档')
  assert.equal(proj.classification, 'practice')
  const evt = b.files.get(b.dir + '/events.jsonl')
  assert.ok(evt.includes('book_seal'), '事件账要有 book_seal')
  assert.ok(evt.includes('"classification":"practice"'), 'book_seal 事件应随记分类')

  // 不带 classification 的封存：原字段原样保留
  const b2 = await book()
  await b2.call('novel_ledger', { book_dir: b.dir, op: 'classify_book', classification: 'practice', reason: '先补记' })
  await b2.call('novel_ledger', { book_dir: b.dir, op: 'seal_book', reason: '不带分类的封存' })
  const proj2 = JSON.parse(b2.files.get(b2.dir + '/project.json'))
  assert.equal(proj2.classification, 'practice', '封存未带分类＝不改写既有分类')
})

test('分类⑥：verify 可读——带标记的书 stats.classification 出；未标记旧书无此键', async () => {
  const b = await book()
  const before = await b.call('novel_verify', { book_dir: b.dir })
  assert.equal(before.stats.classification, 'canonical', 'init 缺省即落 canonical，verify 应读到')
  // 模拟"存量旧书"：手工删掉该字段再 verify——旧书无字段＝未标记，不推断不误报
  const projOld = JSON.parse(b.files.get(b.dir + '/project.json'))
  delete projOld.classification
  b.files.set(b.dir + '/project.json', JSON.stringify(projOld, null, 2))
  const vOld = await b.call('novel_verify', { book_dir: b.dir })
  assert.ok(!('classification' in vOld.stats), '旧书未标记＝无此键（存量书不误报）')

  // 补记后 verify 可读
  await b.call('novel_ledger', { book_dir: b.dir, op: 'classify_book', classification: 'practice', reason: '2026-09-26 定案 补记' })
  const v = await b.call('novel_verify', { book_dir: b.dir })
  assert.equal(v.stats.classification, 'practice', '带标记落账后 verify 必须可读：' + JSON.stringify(v.stats))
  assert.equal(v.ok, true)
})
