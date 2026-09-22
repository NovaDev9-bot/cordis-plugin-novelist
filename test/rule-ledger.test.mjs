// 规矩进账本（novel_ledger op=rule，2026-09-22）：这本书的世界法则要有版本痕迹。
//
// 为什么单独立账：候选 A「规矩的修订者」的机制本身＝"看得见规矩的版本痕迹"，而原先账本九个 op
// 没有一个服务"规矩"——规矩只活在作者记忆与正文里，读者逐条拆的时候没人能核。更关键的是：
// 规矩"被改了一笔"必须是**追加一条新窗**，不能同名覆盖——覆盖＝把机制本身删掉。
// 采用门跟 anchor_params 同款：书里一条规矩都没声明 ⇒ 本项不启用（存量书不误报）。
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

const DIR = '/books/rl'
async function book() {
  const { files, call } = shimFs()
  await call('novel_init', { book_dir: DIR, title: '规矩账本测试', genre: 'x', logline: 'y' })
  return { files, call }
}
const FULL = { title: '开篇', goal: 'g', hook: 'h', differentiation: 'X', choice_axis: { chosen: '甲', sacrificed: ['乙'] } }

test('规矩①采用门：书里一条规矩都没有 ⇒ verify 不为「章纲没写 rules_used」报任何东西', async () => {
  const { call } = await book()
  await call('novel_outline', { book_dir: DIR, op: 'write', volume: 1, ch: 1, entry: FULL })
  const v = await call('novel_verify', { book_dir: DIR })
  assert.equal(v.issues.some((i) => i.includes('规矩')), false, '采用门失效（存量书会被误报）：' + JSON.stringify(v.issues))
  const fs2 = await call('novel_bible', { book_dir: DIR, ch: 1, scope: 'rule' })
  assert.deepEqual(fs2.rules, [], '没声明规矩时 scope=rule 必须回空数组（不是 undefined——空与没查分不开）')
})

test('规矩②落账与三处投影：bible scope=rule 与 factsheet「规矩」节都按生效窗给', async () => {
  const { call } = await book()
  const w = await call('novel_ledger', { book_dir: DIR, op: 'rule', rule: { name: '闸规', text: '戌时落闸，闸开不渡人', source: '老闸守口传', effective_from_ch: 1 } })
  assert.equal(w.ok, true, JSON.stringify(w))
  assert.equal(w.result.saved, '闸规')
  assert.equal(w.result.versions, 1)

  const b = await call('novel_bible', { book_dir: DIR, ch: 3, scope: 'rule' })
  assert.equal(b.rules.length, 1)
  assert.equal(b.rules[0].name, '闸规')
  assert.equal(b.rules[0].text, '戌时落闸，闸开不渡人')

  const card = await call('novel_context', { book_dir: DIR, op: 'factsheet', ch: 2 })
  assert.equal(card.sections.rules.length, 1, '事实卡必须带规矩节：' + JSON.stringify(card.sections.rules))
  assert.equal(card.sections.rules[0].name, '闸规')
  assert.equal(card.sections.rules[0].source, '老闸守口传')
  assert.equal(card.sections.rules[0].versions, 1)

  // name 过滤（bible 的既有语义，规矩一并遵守）
  const b2 = await call('novel_bible', { book_dir: DIR, ch: 3, scope: 'rule', name: '不存在' })
  assert.equal(b2.rules.length, 0)
})

test('规矩③版本痕迹：不重叠窗＝"被改了一笔"（追加一条，旧版本原样留档，各按章取各的）', async () => {
  const { call } = await book()
  await call('novel_ledger', { book_dir: DIR, op: 'rule', rule: { name: '闸规', text: '戌时落闸', effective_from_ch: 1, effective_to_ch: 5 } })
  const w2 = await call('novel_ledger', { book_dir: DIR, op: 'rule', rule: { name: '闸规', text: '亥时落闸（有人改了一笔）', effective_from_ch: 6 } })
  assert.equal(w2.ok, true, '改规矩必须是合法追加，不是冲突：' + JSON.stringify(w2))
  assert.equal(w2.result.versioned, true)
  assert.equal(w2.result.versions, 2, '同名两条版本记录并存')

  const old = await call('novel_bible', { book_dir: DIR, ch: 3, scope: 'rule' })
  assert.equal(old.rules.length, 1)
  assert.equal(old.rules[0].text, '戌时落闸', '第 3 章应当看到旧版')
  const now = await call('novel_bible', { book_dir: DIR, ch: 8, scope: 'rule' })
  assert.equal(now.rules[0].text, '亥时落闸（有人改了一笔）', '第 8 章应当看到新版')

  const card = await call('novel_context', { book_dir: DIR, op: 'factsheet', ch: 8 })
  assert.equal(card.sections.rules[0].versions, 2, '事实卡要带版本数——"这条规矩被改过几笔"正是这本书的机制')
})

test('规矩④同窗不同正文＝真冲突：不写盘、返回 conflict；裁决胜诉后正文被回写（不是死锁）', async () => {
  const { files, call } = await book()
  await call('novel_ledger', { book_dir: DIR, op: 'rule', rule: { name: '闸规', text: '戌时落闸', effective_from_ch: 1 } })
  const before = files.get(DIR + '/rules.json')
  const c = await call('novel_ledger', { book_dir: DIR, op: 'rule', rule: { name: '闸规', text: '亥时落闸', effective_from_ch: 1 } })
  assert.equal(c.ok, false, '同窗不同正文必须返回 conflict：' + JSON.stringify(c))
  assert.equal(c.result.conflict.kind, 'rule_text')
  assert.equal(files.get(DIR + '/rules.json'), before, '冲突时账本一个字节都不许动')

  // 语义类裁决：stance + evidence 必填（两分法纪律）
  const bad = await call('novel_ledger', { book_dir: DIR, op: 'resolve_conflict', conflict: { id: c.result.conflict.id, scope: 'semantic', verdict: 'accept_new' } })
    .then(() => null, (e) => e)
  assert.ok(bad, '缺 stance/evidence 的语义裁决必须被拒')

  const r = await call('novel_ledger', {
    book_dir: DIR, op: 'resolve_conflict',
    conflict: { id: c.result.conflict.id, scope: 'semantic', verdict: 'accept_new', stance: '以旧闸志为准', evidence: 'ch1 正文' },
  })
  assert.equal(r.ok, true, JSON.stringify(r))
  const after = JSON.parse(files.get(DIR + '/rules.json'))
  assert.equal(after.rules.length, 1, '胜诉回写是改这一条，不是追加')
  assert.equal(after.rules[0].text, '亥时落闸', '裁决胜诉后正文必须真的变了（否则"裁决生效"是假的）')
})

test('规矩⑤入参纪律：缺 text 拒收（规矩写不清楚＝给自己埋雷）', async () => {
  const { call } = await book()
  const e = await call('novel_ledger', { book_dir: DIR, op: 'rule', rule: { name: '闸规' } }).then(() => null, (x) => x)
  assert.ok(e, '缺 rule.text 必须拒收')
  const e2 = await call('novel_ledger', { book_dir: DIR, op: 'rule', rule: { text: '有正文没名字' } }).then(() => null, (x) => x)
  assert.ok(e2, '缺 rule.name 必须拒收')
})

test('规矩⑥verify：章纲 rules_used 必须存在且在该章生效；合法时不报', async () => {
  const { call } = await book()
  await call('novel_ledger', { book_dir: DIR, op: 'rule', rule: { name: '闸规', text: '戌时落闸', effective_from_ch: 1, effective_to_ch: 5 } })

  // 引用不存在的规矩
  await call('novel_outline', { book_dir: DIR, op: 'write', volume: 1, ch: 1, entry: Object.assign({}, FULL, { rules_used: ['停灵规'] }) })
  const v1 = await call('novel_verify', { book_dir: DIR })
  assert.equal(v1.ok, false)
  assert.ok(v1.issues.some((i) => i.includes('停灵规') && i.includes('账本里没有')), JSON.stringify(v1.issues))

  // 引用的规矩在本章不生效（窗止于 5）
  await call('novel_outline', { book_dir: DIR, op: 'write', volume: 1, ch: 8, entry: Object.assign({}, FULL, { title: '后章', rules_used: ['闸规'] }) })
  const v2 = await call('novel_verify', { book_dir: DIR })
  assert.ok(v2.issues.some((i) => i.includes('第 8 章') && i.includes('不在任何版本的生效窗内')), JSON.stringify(v2.issues))

  // 合法：第 3 章用第 1 版
  await call('novel_outline', { book_dir: DIR, op: 'write', volume: 1, ch: 3, entry: Object.assign({}, FULL, { title: '中章', rules_used: ['闸规'] }) })
  const v3 = await call('novel_verify', { book_dir: DIR })
  assert.equal(v3.issues.some((i) => i.includes('规矩') && i.includes('第 3 章')), false, JSON.stringify(v3.issues))
})

test('规矩⑦verify 兜底：手改账本造出"同窗两套正文"要报（工具拦不住的那一路）', async () => {
  const { files, call } = await book()
  await call('novel_ledger', { book_dir: DIR, op: 'rule', rule: { name: '闸规', text: '戌时落闸', effective_from_ch: 1 } })
  // 绕过工具直接改账本，模拟外部导入/手改
  files.set(DIR + '/rules.json', JSON.stringify({ rules: [
    { name: '闸规', text: '戌时落闸', effective_from_ch: 1 },
    { name: '闸规', text: '亥时落闸', effective_from_ch: 1 },
  ] }))
  const v = await call('novel_verify', { book_dir: DIR })
  assert.equal(v.ok, false)
  assert.ok(v.issues.some((i) => i.includes('同一生效窗里有两套正文')), JSON.stringify(v.issues))
})
