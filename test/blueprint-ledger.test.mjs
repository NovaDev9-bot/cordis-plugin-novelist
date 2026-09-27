// 卷级蓝图与章纲挂靠回归（2026-09-26 总纲批次一 C2/C3）：
//   C2 —— novel_ledger op=blueprint 立卷级蓝图账本件（blueprint.json，四件套：chain 主线因果链 /
//         lines 线网表（foreshadows 与 t-hooks 挂线归位）/ peaks 波峰目标 / milestones 里程碑）；
//         novel_verify 识别蓝图件（KNOWN 顶层清单不报账外条目 + stats.blueprint 报面）。
//   C3 —— 章纲 entry.blueprint_ref 落账；verify 对蓝图已立卷缺挂靠的章纲报 warning（不拦稿），
//         引用未知蓝图 id 报 issue（引用完整性归符号级）；波峰间隔超 peak_gap_target 报 warning。
// 纪律：书无关——全部用合成账本验证（shimFs 内存账本，与 ledger-coverage 同款），跑完即弃。
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
  return {
    files,
    call: (n, a) => { const t = TOOLS.find((x) => x.name === n); if (!t) throw new Error('no tool ' + n); return t.execute(a, exec()) },
    raw: async (n, a) => { try { return { ok: true, value: await TOOLS.find((x) => x.name === n).execute(a, exec()) } } catch (e) { return { ok: false, e } } },
  }
}

const DIR = '/books/bp'
const BODY = (n) => '巷口的灯忽明忽暗，他数着铜钱，一遍又一遍。'.repeat(6) + '第' + n + '章末，他把纸压回原处。'
const outlineEntry = (ch, extra = {}) => Object.assign({ title: '章' + ch, goal: 'g', differentiation: 'X', choice_axis: { chosen: '甲', sacrificed: ['乙'] }, word_min: 100, word_max: 4000 }, extra)

/** 两章合成书（ch1/ch2 已收束，带伏笔 f001 与章末钩子 t001）。 */
async function book2() {
  const b = shimFs()
  await b.call('novel_init', { book_dir: DIR, title: 'T', genre: 'xuanyi', logline: 'L' })
  await b.call('novel_outline', { book_dir: DIR, op: 'write', volume: 1, ch: 1, entry: outlineEntry(1) })
  await b.call('novel_outline', { book_dir: DIR, op: 'write', volume: 1, ch: 2, entry: outlineEntry(2) })
  await b.call('novel_chapter', { book_dir: DIR, ch: 1, title: '章1', text: BODY(1), seeds: [{ id: 'f001', name: '物证来路', due_ch: 10 }], timeline_events: [{ time: '第一日', what: '第一章的大事' }] })
  await b.call('novel_chapter', { book_dir: DIR, ch: 2, title: '章2', text: BODY(2), timeline_events: [{ time: '第二日', what: '第二章的大事' }] })
  const h = await b.call('novel_event', { book_dir: DIR, op: 'append', kind: 'hook', ch: 2, what: '章末钩子：门外有人', why: '把读者带进下一章', actor: '主编' })
  assert.equal(h.ok, true, '夹具钩子应落带：' + JSON.stringify(h))
  const d = await b.call('novel_event', { book_dir: DIR, op: 'append', kind: 'decision', ch: 2, what: '裁定：压住消息先核实', why: '来源不明，先对账再走', actor: '主编' })
  assert.equal(d.ok, true, '夹具决策应落带（非线头类，供 t_hooks 白名单反例用）：' + JSON.stringify(d))
  return b
}

/** 测试用最小蓝图（四件套齐全，挂 f001/t001）。 */
const bpDraft = (over = {}) => Object.assign({
  volume: 1,
  note: '草案待Owner裁定',
  chain: [{ id: 'N1', name: '开局物证', ch_from: 1, ch_to: 2, desc: '门缝里的牛皮纸信封' }],
  lines: [{ id: 'L1', name: '物证线', opening: { ch: 1, what: '物证出现' }, closing: null, foreshadow_ids: ['f001'], t_hooks: ['t001'] }],
  peaks: [{ id: 'P1', ch: 10, name: '第一波峰' }],
  milestones: [{ id: 'M1', kind: '第一幕终点', ch: 12 }],
}, over)

test('C2: op=blueprint 落账 blueprint.json（四件套）＋事件留痕；同卷重交＝整卷替换', async () => {
  const { files, call } = await book2()
  const w = await call('novel_ledger', { book_dir: DIR, op: 'blueprint', blueprint: bpDraft() })
  assert.equal(w.ok, true, JSON.stringify(w))
  assert.deepEqual({ chain: w.result.chain, lines: w.result.lines, peaks: w.result.peaks, milestones: w.result.milestones }, { chain: 1, lines: 1, peaks: 1, milestones: 1 }, '返回四件套计数：' + JSON.stringify(w.result))
  assert.ok(files.has(DIR + '/blueprint.json'), '必须真的落了 blueprint.json')
  const onDisk = JSON.parse(files.get(DIR + '/blueprint.json'))
  assert.equal(onDisk.volumes[0].volume, 1)
  assert.equal(onDisk.volumes[0].status, 'draft', '缺省 status=draft（草案待Owner裁定）：' + JSON.stringify(onDisk.volumes[0].status))
  assert.equal(onDisk.volumes[0].lines[0].foreshadow_ids[0], 'f001', '挂线归位：伏笔 id 在账')
  assert.equal(onDisk.volumes[0].lines[0].t_hooks[0], 't001', '挂线归位：事件带 tNNN 在账')
  assert.equal(onDisk.volumes[0].lines[0].closing, null, '显式 closing=null（跨卷线）必须原样入账——与"未填"可区分：' + JSON.stringify(onDisk.volumes[0].lines[0].closing))
  assert.ok(files.get(DIR + '/events.jsonl').includes('"op":"blueprint_write"'), '事件账必须留痕')
  // 同卷重交＝替换不追加
  const w2 = await call('novel_ledger', { book_dir: DIR, op: 'blueprint', blueprint: bpDraft({ chain: [{ id: 'N1', name: '开局物证', ch_from: 1, ch_to: 3 }] }) })
  assert.equal(w2.ok, true, JSON.stringify(w2))
  const after = JSON.parse(files.get(DIR + '/blueprint.json'))
  assert.equal(after.volumes.length, 1, '同卷重交不得追加第二份：' + JSON.stringify(after.volumes.map((v) => v.volume)))
  assert.equal(after.volumes[0].chain[0].ch_to, 3, '重交内容生效')
})

test('C2: verify 识别蓝图件——不报账外条目，stats.blueprint 报四件套面；没立蓝图的书无此键', async () => {
  const { call } = await book2()
  const v0 = await call('novel_verify', { book_dir: DIR })
  assert.equal(v0.stats.blueprint, undefined, '没立蓝图＝无 stats.blueprint 键（存量书不变）：' + JSON.stringify(v0.stats))
  await call('novel_ledger', { book_dir: DIR, op: 'blueprint', blueprint: bpDraft() })
  const v1 = await call('novel_verify', { book_dir: DIR })
  const outside = v1.warnings.filter((x) => x.includes('账外条目') && x.includes('blueprint'))
  assert.equal(outside.length, 0, '工具自己写的 blueprint.json 不得被自家探针报账外：' + JSON.stringify(v1.warnings))
  assert.ok(v1.stats.blueprint, '立了蓝图必须出现在 stats：' + JSON.stringify(v1.stats))
  assert.deepEqual(v1.stats.blueprint.volumes, [1])
  assert.equal(v1.stats.blueprint.chain_nodes, 1)
  assert.equal(v1.stats.blueprint.peaks, 1)
  assert.equal(v1.stats.blueprint.milestones, 1)
})

test('C2: 确定性拒收——四件套缺件/重复 id/非法里程碑/挂线引用空号/approved 缺件', async () => {
  const { raw } = await book2()
  const cases = [
    [{ volume: 1, chain: [], lines: [], peaks: [], milestones: [] }, /chain 至少要有一个/, '无因果链不是蓝图'],
    [{ volume: 1 }, /必须是数组/, '四件套缺件（键缺失）'],
    [bpDraft({ chain: [{ id: 'N1', name: 'a', ch_from: 2, ch_to: 1 }] }), /ch_from 不得大于 ch_to/, '章区间写反'],
    [bpDraft({ peaks: [{ id: 'N1', ch: 5, name: '重号' }] }), /id 重复/, '与 chain 的 N1 撞号＝章纲挂靠二义'],
    [bpDraft({ lines: [{ id: 'L1', name: 'x', opening: { ch: 1, what: 'o' }, foreshadow_ids: ['f999'] }] }), /未知伏笔 id：f999/, '挂线归位挂空号（伏笔）'],
    [bpDraft({ lines: [{ id: 'L1', name: 'x', opening: { ch: 1, what: 'o' }, t_hooks: ['t999'] }] }), /未知事件带 id：t999/, '挂线归位挂空号（t-hook）'],
    [bpDraft({ lines: [{ id: 'L1', name: 'x', opening: { ch: 1, what: 'o' }, t_hooks: ['t002'] }] }), /kind=decision/, 't_hooks 只挂钩子/欠线两类线头（t002=decision）'],
    [bpDraft({ milestones: [{ id: 'M1', kind: '第四幕终点', ch: 12 }] }), /kind 必须是/, '里程碑四类白名单'],
    [bpDraft({ milestones: [{ id: 'M1', kind: '中点', ch: 12 }, { id: 'M2', kind: '中点', ch: 20 }] }), /kind 重复/, '同卷两个中点＝数据错误'],
    [bpDraft({ status: 'approved', lines: [], peaks: [] }), /approved 要求四件套全部非空/, '拍板对象必须完整'],
    [bpDraft({ peak_gap_target: [12, 8] }), /不得大于 max/, '目标区间反写'],
  ]
  for (const [bp, pat, why] of cases) {
    const r = await raw('novel_ledger', { book_dir: DIR, op: 'blueprint', blueprint: bp })
    assert.equal(r.ok, false, why + '——必须拒收：' + JSON.stringify(r.value || r.e))
    assert.match(String(r.e.message), pat, why + '——报错要说中要害：' + r.e.message)
  }
})

test('C3: 章纲 blueprint_ref 落账并可读回；写入时蓝图已立则当场核对（写错 id 即时提示）', async () => {
  const { files, call } = await book2()
  await call('novel_ledger', { book_dir: DIR, op: 'blueprint', blueprint: bpDraft() })
  const w = await call('novel_outline', { book_dir: DIR, op: 'write', volume: 1, ch: 3, entry: outlineEntry(3, { blueprint_ref: 'N1' }) })
  assert.equal(w.op, 'write', JSON.stringify(w))
  const onDisk = JSON.parse(files.get(DIR + '/outline.json'))
  const ch3 = onDisk.volumes[0].chapters.find((c) => c.chapter_no === 3)
  assert.equal(ch3.blueprint_ref, 'N1', 'blueprint_ref 必须原样落账：' + JSON.stringify(ch3))
  const rd = await call('novel_outline', { book_dir: DIR, op: 'read' })
  assert.equal(rd.outline.volumes[0].chapters.find((c) => c.chapter_no === 3).blueprint_ref, 'N1', 'read 也要带出来')
  // 写时核：蓝图已立，写错 id 当场提示（warn，不拒收——章纲可以先落、错别字留给主编改）
  const bad = await call('novel_outline', { book_dir: DIR, op: 'write', volume: 1, ch: 4, entry: outlineEntry(4, { blueprint_ref: 'NOPE' }) })
  assert.ok(String(bad.warn || '').includes('blueprint_ref 引用未知蓝图 id'), '写时核要提示：' + JSON.stringify(bad.warn))
  // 蓝图未立的卷不做写时核（章纲可以先于蓝图存在）
  const pre = await call('novel_outline', { book_dir: DIR, op: 'write', volume: 2, ch: 11, entry: outlineEntry(11, { blueprint_ref: '任意' }) })
  assert.equal(pre.warn, undefined, '卷 2 没蓝图＝写时核不启用：' + JSON.stringify(pre.warn))
})

test('C3: 蓝图已立卷——缺挂靠报 warning 不拦稿（具名到章），挂了 ref 的章不报', async () => {
  const { call } = await book2()
  // 基线：没蓝图时不得报挂靠 warning（采用门）
  const v0 = await call('novel_verify', { book_dir: DIR })
  assert.equal(v0.warnings.some((x) => x.includes('blueprint_ref')), false, '没蓝图不报挂靠：' + JSON.stringify(v0.warnings))
  await call('novel_ledger', { book_dir: DIR, op: 'blueprint', blueprint: bpDraft() })
  // ch1/ch2 都没挂 → warning 具名两章
  const v1 = await call('novel_verify', { book_dir: DIR })
  const miss = v1.warnings.filter((x) => x.includes('章纲缺蓝图挂靠'))
  assert.equal(miss.length, 1, '缺挂靠必须报出：' + JSON.stringify(v1.warnings))
  assert.ok(miss[0].includes('卷 1') && miss[0].includes('2/2 章'), '要点名卷与章数：' + miss[0])
  assert.equal(v1.ok, true, '缺挂靠是 warning 不是 issue——不拦稿：' + JSON.stringify(v1.issues))
  assert.equal(v1.stats.blueprint.refs_missing, 2, 'stats 报挂靠缺口：' + JSON.stringify(v1.stats.blueprint))
  // ch1 挂上后，只剩 ch2
  await call('novel_outline', { book_dir: DIR, op: 'write', volume: 1, ch: 1, entry: outlineEntry(1, { blueprint_ref: 'N1' }) })
  const v2 = await call('novel_verify', { book_dir: DIR })
  const miss2 = v2.warnings.find((x) => x.includes('章纲缺蓝图挂靠'))
  assert.ok(miss2 && miss2.includes('第 2 章') && !miss2.includes('第 1 章'), '挂了的章不再点名：' + miss2)
  assert.equal(v2.stats.blueprint.refs_missing, 1, JSON.stringify(v2.stats.blueprint))
})

test('C3: 引用未知蓝图 id ⇒ issue（引用完整性归符号级，拦稿）；数组形态同样核', async () => {
  const { call } = await book2()
  await call('novel_ledger', { book_dir: DIR, op: 'blueprint', blueprint: bpDraft() })
  await call('novel_outline', { book_dir: DIR, op: 'write', volume: 1, ch: 1, entry: outlineEntry(1, { blueprint_ref: 'NOPE' }) })
  const v1 = await call('novel_verify', { book_dir: DIR })
  const dangling = v1.issues.filter((x) => x.includes('blueprint_ref 引用未知蓝图 id'))
  assert.equal(dangling.length, 1, '未知 id 必须报 issue：' + JSON.stringify(v1.issues))
  assert.ok(dangling[0].includes('第 1 章') && dangling[0].includes('NOPE'), '要具名到章与 id：' + dangling[0])
  assert.equal(v1.ok, false, '引用完整性是 issue——拦稿：' + JSON.stringify(v1.issues))
  // 数组形态：一个真 id + 一个坏 id → 只点名坏的
  await call('novel_outline', { book_dir: DIR, op: 'write', volume: 1, ch: 1, entry: outlineEntry(1, { blueprint_ref: ['N1', 'NOPE2'] }) })
  const v2 = await call('novel_verify', { book_dir: DIR })
  const d2 = v2.issues.find((x) => x.includes('blueprint_ref 引用未知蓝图 id'))
  assert.ok(d2 && d2.includes('引用未知蓝图 id：NOPE2（'), '数组形态逐个核对（坏名单只有 NOPE2）：' + d2)
  // 全部修好 ⇒ 回绿
  await call('novel_outline', { book_dir: DIR, op: 'write', volume: 1, ch: 1, entry: outlineEntry(1, { blueprint_ref: ['N1', 'P1'] }) })
  const v3 = await call('novel_verify', { book_dir: DIR })
  assert.equal(v3.issues.some((x) => x.includes('blueprint_ref')), false, '修好后必须回绿：' + JSON.stringify(v3.issues))
})

test('C2: 波峰间隔超 peak_gap_target 报 warning；目标区间可由蓝图声明（数据化，不写死）', async () => {
  const { call } = await book2()
  await call('novel_ledger', { book_dir: DIR, op: 'blueprint', blueprint: bpDraft({ peaks: [{ id: 'P1', ch: 3, name: 'a' }, { id: 'P2', ch: 12, name: 'b' }] }) })
  const v0 = await call('novel_verify', { book_dir: DIR })
  assert.equal(v0.warnings.some((x) => x.includes('波峰间隔超目标')), false, '间隔 9 章在 [8,12] 内不报：' + JSON.stringify(v0.warnings))
  await call('novel_ledger', { book_dir: DIR, op: 'blueprint', blueprint: bpDraft({ peaks: [{ id: 'P1', ch: 3, name: 'a' }, { id: 'P2', ch: 30, name: 'b' }] }) })
  const v1 = await call('novel_verify', { book_dir: DIR })
  const gap = v1.warnings.filter((x) => x.includes('波峰间隔超目标'))
  assert.equal(gap.length, 1, '间隔 27 章必须报：' + JSON.stringify(v1.warnings))
  assert.ok(gap[0].includes('27') && gap[0].includes('卷 1'), '要点名间隔与卷：' + gap[0])
  // Owner 自调目标区间后同一布局不报（目标区间是数据不是常量）
  await call('novel_ledger', { book_dir: DIR, op: 'blueprint', blueprint: bpDraft({ peaks: [{ id: 'P1', ch: 3, name: 'a' }, { id: 'P2', ch: 30, name: 'b' }], peak_gap_target: [8, 30] }) })
  const v2 = await call('novel_verify', { book_dir: DIR })
  assert.equal(v2.warnings.some((x) => x.includes('波峰间隔超目标')), false, '目标调宽后不报：' + JSON.stringify(v2.warnings))
})

test('C3: 采用门——蓝图没立的卷不查挂靠（多卷书不误报）', async () => {
  const { call } = await book2()
  await call('novel_ledger', { book_dir: DIR, op: 'blueprint', blueprint: bpDraft() })
  await call('novel_outline', { book_dir: DIR, op: 'write', volume: 2, ch: 11, entry: outlineEntry(11) })
  const v = await call('novel_verify', { book_dir: DIR })
  const miss = v.warnings.filter((x) => x.includes('章纲缺蓝图挂靠'))
  assert.equal(miss.length, 1, '只有立了蓝图的卷报：' + JSON.stringify(v.warnings))
  assert.ok(miss[0].includes('卷 1') && !miss[0].includes('卷 2'), '卷 2 没蓝图＝不查：' + miss[0])
})
