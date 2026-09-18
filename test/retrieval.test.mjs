// A+B 批（2026-09-18）：novel_search（正文受控检索·书目录围栏）＋ novel_context op=factsheet（确定性事实卡投影）。
//
// 存在理由（Owner 拍板）：①正文层原先没有任何查询入口——账本有 novel_ask/novel_context，
// 正文只能靠主编人工塞进派工包；②主笔要能自查旧文（"我第 40 章怎么描写那个玉坠的"），
// 而宿主权限**按工具名不按路径**（D-3：宿主 fs 无根约束），放开 glob/grep 等于放开整块硬盘——
// 所以"只能搜书目录"的门唯一实现方式就是在插件里开。
// factsheet 的口径：**只做确定性几节**（每条带章号坐标），叙述性那节（上章末状态一段话）
// 明标由主编补写，工具不代写、不冒充。
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

// ---------------------------------------------------------------- A：factsheet（确定性事实卡投影）

const cardBook = () => {
  const { files, call } = shimFs()
  const dir = '/books/card'
  files.set(dir + '/project.json', JSON.stringify({ title: '卡书', current_ch: 5 }))
  files.set(dir + '/foreshadows.json', JSON.stringify({ foreshadows: [
    { id: 'F1', name: '玉佩来历', planted_ch: 2, due_ch: 5, status: 'planted', closed_ch: null },
    { id: 'F2', name: '师父行踪', planted_ch: 3, due_ch: 9, status: 'planted', closed_ch: null },
    { id: 'F3', name: '旧债', planted_ch: 1, due_ch: 4, status: 'closed', closed_ch: 4 },
  ] }))
  files.set(dir + '/characters.json', JSON.stringify({ characters: [
    { name: '甲', identity: '镖师', last_seen_ch: 4 },
    { name: '乙', identity: '掌柜', last_seen_ch: 1 },
  ] }))
  files.set(dir + '/bible.json', JSON.stringify({ terms: [{ name: '青玉令', value: '见令如见人', effective_from_ch: 1 }] }))
  files.set(dir + '/timeline.json', JSON.stringify({ events: [
    { ch: 2, time: '第二夜', what: '入城' },
    { ch: 4, time: '第四夜', what: '遇袭' },
    { ch: 9, time: '第九夜', what: '存稿里的事件' },
  ] }))
  files.set(dir + '/editorial/events-tape.jsonl', JSON.stringify({ ts: 'x', id: 't001', kind: 'open_thread', ch: 2, what: '镖局旧账未清', why: '埋', actor: '主编', closes: 8 }) + '\n')
  return { files, call, dir }
}

test('A: factsheet 六节确定性投影（每条带章号坐标）＋叙述节明标由主编补写', async () => {
  const { files, call, dir } = cardBook()
  const before = new Map(files)
  const card = await call('novel_context', { book_dir: dir, op: 'factsheet', ch: 5, near: 3 })

  assert.equal(card.op, 'factsheet')
  assert.equal(card.ch, 5)
  const s = card.sections

  // ① 应兑现（due ≤ ch）——逾期与否逐条标出
  assert.deepEqual(s.due_foreshadows, [{ id: 'F1', name: '玉佩来历', planted_ch: 2, due_ch: 5, overdue: false }])
  // ② 既有钩子＝未来到期伏笔 ＋ 未闭欠线（事件带有效投影）
  assert.deepEqual(s.open_hooks, [
    { kind: 'foreshadow', ref: 'F2', text: '师父行踪', from_ch: 3, due_ch: 9 },
    { kind: 'open_thread', ref: 't001', text: '镖局旧账未清', from_ch: 2, closes: 8 },
  ])
  // ③ 近场人物（近 near 章出现过；本章"实际出场者"由主编按细纲增删）
  assert.deepEqual(s.near_characters, [{ name: '甲', identity: '镖师', last_seen_ch: 4 }])
  // ④ 世界观规则（effective_from_ch ≤ ch）
  assert.deepEqual(s.world_rules, [{ name: '青玉令', value: '见令如见人', from_ch: 1 }])
  // ⑤ 时间线锚（≤ ch，含存稿排除）
  assert.deepEqual(s.timeline_anchors, [
    { ch: 2, time: '第二夜', what: '入城' },
    { ch: 4, time: '第四夜', what: '遇袭' },
  ])
  // ⑥ 禁改清单（近期已收伏笔＝不可反转的既成事实）
  assert.deepEqual(s.frozen_facts, [{ ref: 'F3', text: '旧债', closed_ch: 4 }])
  // 叙述节不代写：明标留给主编
  assert.equal(s.manual, undefined, '叙述节不进 sections（它不是投影出来的）')
  assert.deepEqual(card.manual, ['上章末状态（一段话）——由主编读第 4 章正文后补写；本工具不代写叙述性内容'])
  // 纯只读
  assert.deepEqual(files, before)
})

test('A: factsheet 的 ch 缺省＝current_ch+1（即将写的那一章）', async () => {
  const { call, dir } = cardBook()
  const card = await call('novel_context', { book_dir: dir, op: 'factsheet' })
  assert.equal(card.ch, 6, '缺省应为 current_ch(5)+1')
  // ch=6 时 F1（due 5）已逾期
  assert.deepEqual(card.sections.due_foreshadows, [{ id: 'F1', name: '玉佩来历', planted_ch: 2, due_ch: 5, overdue: true }])
})

test('A: factsheet 对空账本不臆造（各节空数组，manual 照常提示）', async () => {
  const { files, call } = shimFs()
  const dir = '/books/card-empty'
  files.set(dir + '/project.json', JSON.stringify({ title: '空', current_ch: 0 }))
  const card = await call('novel_context', { book_dir: dir, op: 'factsheet' })
  assert.equal(card.ch, 1)
  for (const k of ['due_foreshadows', 'open_hooks', 'near_characters', 'world_rules', 'timeline_anchors', 'frozen_facts']) {
    assert.deepEqual(card.sections[k], [], k + ' 空账本应为空数组（不编造）')
  }
})

// ---------------------------------------------------------------- B：novel_search（正文受控检索）

const searchBook = () => {
  const { files, call } = shimFs()
  const dir = '/books/search'
  files.set(dir + '/manuscript/chapter_001.md', ['第一章 入城', '', '他握着那枚玉坠，指节发白。', '', '雨里没有人说话，玉坠贴着心口发烫。'].join('\n'))
  files.set(dir + '/manuscript/chapter_002.md', ['第二章 夜谈', '', '掌柜说：那枚玉坠来路不正。'].join('\n'))
  files.set(dir + '/manuscript/chapter_003.md', ['第三章', '', '血从指缝里渗出来。', '', '他把玉坠塞进怀里，血还在滴。'].join('\n'))
  files.set(dir + '/manuscript/notes.md', '玉坠 不该被搜到（非章节文件）。')
  files.set(dir + '/versions/chapter_001.v1.md', '旧版里的玉坠不该被搜到（快照不是当前正文）。')
  return { files, call, dir }
}

test('B: 字面检索返回章号＋行号＋片段；多词=AND；空结果明报（不语义、不摘要）', async () => {
  const { call, dir } = searchBook()
  const r = await call('novel_search', { book_dir: dir, q: '玉坠' })
  assert.equal(r.q, '玉坠')
  assert.deepEqual(r.terms, ['玉坠'])
  assert.deepEqual(r.matches.map((m) => [m.ch, m.para]), [[1, 3], [1, 5], [2, 3], [3, 5]])
  assert.ok(r.matches[0].snippet.includes('玉坠'), '片段必须含命中词：' + r.matches[0].snippet)
  assert.equal(r.truncated, false)

  const both = await call('novel_search', { book_dir: dir, q: '玉坠 血' })
  assert.deepEqual(both.matches.map((m) => [m.ch, m.para]), [[3, 5]], '多词=全部命中（AND）')

  const none = await call('novel_search', { book_dir: dir, q: '不存在的东西' })
  assert.deepEqual(none.matches, [])
  assert.match(none.note, /换词|不存在/)
})

test('B: 章范围过滤＋limit 截断明报；只搜当前正文（排除快照与非章节文件）', async () => {
  const { call, dir } = searchBook()
  const win = await call('novel_search', { book_dir: dir, q: '玉坠', window: { from: 2, to: 2 } })
  assert.deepEqual(win.matches.map((m) => m.ch), [2])
  const one = await call('novel_search', { book_dir: dir, q: '玉坠', ch: 1 })
  assert.deepEqual(one.matches.map((m) => m.ch), [1, 1])
  const capped = await call('novel_search', { book_dir: dir, q: '玉坠', limit: 2 })
  assert.equal(capped.matches.length, 2)
  assert.equal(capped.truncated, true, '触碰上限必须明报截断（不静默丢）')
  const all = await call('novel_search', { book_dir: dir, q: '玉坠' })
  assert.ok(all.matches.every((m) => m.ch >= 1 && m.ch <= 3), '只应命中 manuscript/ 的章节正文')
  assert.equal(all.chapters_scanned, 3)
})

test('B: 检索是纯只读；q 必填（空查询=可行动错误）', async () => {
  const { files, call, dir } = searchBook()
  const before = new Map(files)
  await call('novel_search', { book_dir: dir, q: '玉坠' })
  assert.deepEqual(files, before, '检索不得写任何文件')
  await assert.rejects(() => call('novel_search', { book_dir: dir, q: '   ' }), /q 必填|BAD_ARG/)
})
