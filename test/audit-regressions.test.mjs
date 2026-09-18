// 2026-09-18 三路审计的回归锁定：每条都对应一个**已实跑复现**的缺陷。
// 纪律：修复必须带能红的回归；只改文案不改断言的，记为未完成。
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
const mk = async (dir) => {
  const b = shimFs()
  await b.call('novel_init', { book_dir: dir, title: 'T', genre: 'xuanyi', logline: 'L' })
  return b
}

// T2：novel_bible 只传 book_dir+ch（不传 scope）曾返回四个空数组
test('审计T2: novel_bible 不传 scope＝查全部（不得返回假空账）', async () => {
  const b = await mk('/books/t2')
  await b.call('novel_ledger', { book_dir: '/books/t2', op: 'update_term', term: { name: '青玉令', value: '见令如见人', effective_from_ch: 1 } })
  const r = await b.call('novel_bible', { book_dir: '/books/t2', ch: 1 })
  assert.equal(r.terms.length, 1, '不传 scope 必须等同 all，否则"写前必查"拿到的是假空账：' + JSON.stringify(r))
  assert.equal(TOOLS.find((t) => t.name === 'novel_bible').parameters.properties.scope.default, 'all', 'schema 也要声明 default')

  const one = await b.call('novel_bible', { book_dir: '/books/t2', ch: 1, scope: 'foreshadow' })
  assert.equal(one.terms.length, 0, '显式 scope 仍按指定范围过滤')
})

// T3：novel_init 打在"有账本、缺 project.json"的目录上曾静默清空账本
test('审计T3: 有账本但缺 project.json 时 novel_init 必须拒，不得覆盖', async () => {
  const b = await mk('/books/t3')
  await b.call('novel_ledger', { book_dir: '/books/t3', op: 'update_term', term: { name: '青玉令', value: '重要设定', effective_from_ch: 1 } })
  b.files.delete('/books/t3/project.json')

  await assert.rejects(
    () => b.call('novel_init', { book_dir: '/books/t3', title: 'T2', genre: 'xuanyi', logline: 'L2' }),
    (e) => e.code === 'E_PRECONDITION' && /已有账本/.test(e.message),
    '必须拒并说清"已有账本"，否则会把 bible 整文件覆盖成空骨架还报成功',
  )
  const terms = JSON.parse(b.files.get('/books/t3/bible.json')).terms
  assert.equal(terms.length, 1, '账本必须原样保留：' + JSON.stringify(terms))
})

// T6：payoff 描述说"须带 closes_thread"，实现曾不校验
test('审计T6: kind=payoff 不带 closes_thread 必须拒（描述与实现同口径）', async () => {
  const b = await mk('/books/t6')
  await b.call('novel_outline', { book_dir: '/books/t6', op: 'write', volume: 1, chapter_no: 1, entry: { word_min: 200, word_max: 4000 } })
  await b.call('novel_chapter', { book_dir: '/books/t6', ch: 1, title: '一', text: '正文。'.repeat(50), hook: { what: '门后的声音' } })

  const ok = await b.call('novel_event', { book_dir: '/books/t6', op: 'append', kind: 'payoff', what: '兑现', why: 'w', actor: '主编', closes_thread: 't001' })
  assert.equal(ok.ok, true)

  const b2 = await mk('/books/t6b')
  await b2.call('novel_outline', { book_dir: '/books/t6b', op: 'write', volume: 1, chapter_no: 1, entry: { word_min: 200, word_max: 4000 } })
  await b2.call('novel_chapter', { book_dir: '/books/t6b', ch: 1, title: '一', text: '正文。'.repeat(50), hook: { what: '门后的声音' } })
  await assert.rejects(
    () => b2.call('novel_event', { book_dir: '/books/t6b', op: 'append', kind: 'payoff', what: '空兑现', why: 'w', actor: '主编' }),
    (e) => e.code === 'E_BAD_ARG',
    '不带 closes_thread 的 payoff 是"账上多一条兑现、实际什么都没闭合"',
  )
})

// T5：resolve_conflict 用不存在的冲突 id 曾返回 ok:true
test('审计T5: resolve_conflict 引用不存在的冲突 id 必须拒（不许把 no-op 报成成功）', async () => {
  const b = await mk('/books/t5')
  // verdict 先走白名单（另一条断言），故此处用合法值，把用例逼到"id 不存在"这一条
  await assert.rejects(
    () => b.call('novel_ledger', { book_dir: '/books/t5', op: 'resolve_conflict', conflict: { id: '不存在-x', scope: 'semantic', stance: 's', evidence: 'e', verdict: 'keep_old' } }),
    (e) => e.code === 'E_NOT_FOUND',
    'ok:true 会让调用方以为裁决生效',
  )
  await assert.rejects(
    () => b.call('novel_ledger', { book_dir: '/books/t5', op: 'resolve_conflict', conflict: { id: 'x', scope: 'semantic', stance: 's', evidence: 'e', verdict: '随便什么' } }),
    (e) => e.code === 'E_BAD_ARG',
    'verdict 必须白名单：accept_new / keep_old',
  )
})

// T7：未知 op 曾被静默当写分支执行
test('审计T7: 未知 op 必须拒（不许静默落到写分支）', async () => {
  const b = await mk('/books/t7')
  await assert.rejects(
    () => b.call('novel_outline', { book_dir: '/books/t7', op: '写', volume: 1, chapter_no: 1, entry: { word_min: 200, word_max: 4000 } }),
    (e) => e.code === 'E_BAD_ARG',
    '拼错的 op 落进写分支＝契约外输入被当成合法指令',
  )
  const outline = JSON.parse(b.files.get('/books/t7/outline.json'))
  assert.equal(outline.volumes.length, 0, '拒了就不许有副作用')
})
