/**
 * blueprint-diff.mjs —— dissector 自解剖：成稿章区间实测账 vs 卷级蓝图对照（总纲批次三 C6，2026-09-26）
 *
 * 用法：node blueprint-diff.mjs <book_dir> [--from N] [--to M] [--json out.json]
 *
 * ── 它是什么 ────────────────────────────────────────────────────────────
 * C6"拆书自解剖"＝对成稿章区间产出**实测节拍表 vs 蓝图对照**。本脚本承担其中
 * **确定性的一半**（纯算术，零 LLM）：
 *   逐章：成稿落盘与否／汉字数／波峰-基线档位／章纲 blueprint_ref 挂靠核对／所在线网拍点；
 *   蓝图侧：chain 节点章区间落盘覆盖／peaks、milestones 落盘状态／lines 的 opening/beat/closing
 *   坐标 vs foreshadows.json 实际 planted_ch/closed_ch 对账。
 * **语义的另一半显式留白**（每章列出蓝图节点功能与章纲 hook_type 声明，等 dissector
 * 盲读判读"落没落进文本"）——代码不冒充判义（分工纪律：判定归模型、代码做壳）。
 *
 * ── 锚定红线（不可破）─────────────────────────────────────────────────
 * 本脚本与它的对照表**只进审校侧（dissector 派工）**，**绝不进生成派工包**——
 * 蓝图对账不注入写作（I4：绝不注入生成）。chapter-cycle SKILL 的 dissector 派工行
 * 已写死这句；谁把对照表塞进主笔派工包＝破线，按翻车清单处置。
 *
 * ── 输入（全部只读）──────────────────────────────────────────────────
 *   <book_dir>/blueprint.json   卷级蓝图（novel_ledger op=blueprint 落，批次一 C2）。
 *                               **未立 ⇒ EXIT 2 没检查成**——没有对照对象就不许产出"全绿"空表。
 *   <book_dir>/outline.json     章纲（blueprint_ref / anchor_params.hook_type 在此）。
 *   <book_dir>/foreshadows.json 线网对账用（planted_ch/closed_ch 实际值）。
 *   <book_dir>/manuscript/chapter_NNN.md  成稿（chapterFile() 同名规则，padStart 3）。
 *
 * ── 退出码 ─────────────────────────────────────────────────────────────
 *   0 ＝ 对照表已产出（观测器，不是闸门：缺口在表内列明，判"好不好"归编辑部与 Owner）
 *   2 ＝ 没检查成（书目录不存在／蓝图未立／区间非法——"没检查成"不许报成空表）
 */
import { readFile, readdir } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import path from 'node:path'

const argv = process.argv.slice(2)
const opt = (k, d) => { const i = argv.indexOf(k); return i >= 0 ? argv[i + 1] : d }

let bookDir = null
for (let i = 0; i < argv.length; i++) {
  if (argv[i] === '--json') { i++; continue }
  if (!argv[i].startsWith('--')) { bookDir = argv[i]; break }
}
const USAGE = '用法：node blueprint-diff.mjs <book_dir> [--from N] [--to M] [--json out.json]'
if (!bookDir) {
  console.error(USAGE)
  process.exit(2)
}
const BOOK = path.resolve(bookDir)
if (!existsSync(BOOK)) {
  console.error('[blueprint-diff] 没检查成：书目录不存在 ' + BOOK + '（书丢了不许报成空表）')
  process.exit(2)
}

const readJsonSafe = async (p, fallback) => { try { return JSON.parse(await readFile(p, 'utf8')) } catch (e) { return fallback } }
const chapterName = (n) => 'chapter_' + String(n).padStart(3, '0') + '.md'
const han = (s) => (s.match(/[\u4e00-\u9fff]/g) || []).length
const intOr = (v) => (Number.isInteger(v) ? v : null)

// ---------------------------------------------------------------- 读账本
const bpd = await readJsonSafe(path.join(BOOK, 'blueprint.json'), null)
if (!bpd || !Array.isArray(bpd.volumes) || bpd.volumes.length === 0) {
  console.error('[blueprint-diff] 没检查成：蓝图未立（<book_dir>/blueprint.json 缺失或空）——先 novel_ledger op=blueprint 立卷级蓝图（总纲 C2）。没有对照对象＝没法自解剖，不许产出"全绿"空表。')
  process.exit(2)
}
const outline = await readJsonSafe(path.join(BOOK, 'outline.json'), { volumes: [] })
const fshJson = await readJsonSafe(path.join(BOOK, 'foreshadows.json'), { foreshadows: [] })
const foreshadows = fshJson.foreshadows || []

const outlineCh = new Map()
for (const vol of outline.volumes || []) for (const c of vol.chapters || []) outlineCh.set(c.chapter_no, { ...c, volume: vol.volume ?? null })

let msFiles = []
try { msFiles = (await readdir(path.join(BOOK, 'manuscript'))).filter((f) => /^chapter_\d+\.md$/.test(f)) } catch (e) { /* 无正文目录＝全部待写 */ }
const hanCache = new Map()
const msHan = async (ch) => {
  if (hanCache.has(ch)) return hanCache.get(ch)
  const p = path.join(BOOK, 'manuscript', chapterName(ch))
  let h = null
  if (existsSync(p)) { try { h = han(await readFile(p, 'utf8')) } catch (e) { h = null } }
  hanCache.set(ch, h)
  return h
}

// 蓝图卷集合（v1 只按章区间对照全部卷；区间过滤在逐章循环里做）
const allBpIds = new Map() // id -> {type, item, volume}
for (const v of bpd.volumes) {
  for (const n of v.chain || []) allBpIds.set(n.id, { type: 'chain', item: n, volume: v.volume })
  for (const l of v.lines || []) allBpIds.set(l.id, { type: 'lines', item: l, volume: v.volume })
  for (const p of v.peaks || []) allBpIds.set(p.id, { type: 'peaks', item: p, volume: v.volume })
  for (const m of v.milestones || []) allBpIds.set(m.id, { type: 'milestones', item: m, volume: v.volume })
}
const peakChs = new Map() // ch -> [peakId]
for (const v of bpd.volumes) for (const p of v.peaks || []) if (Number.isInteger(p.ch)) peakChs.set(p.ch, [...(peakChs.get(p.ch) || []), v.volume + ':' + p.id])

// 章区间：--from/--to 缺省＝章纲∪成稿∪蓝图坐标的覆盖范围
const chSet = new Set()
for (const k of outlineCh.keys()) chSet.add(k)
for (const f of msFiles) chSet.add(Number(f.match(/(\d+)/)[1]))
for (const v of bpd.volumes) {
  for (const n of v.chain || []) {
    // chain 节点跨度内的每一章都进逐章表（dissector 要逐章判语义，不许内部章漏表）；
    // 跨度 >200 章＝异常蓝图，退化为只加端点防炸
    if (intOr(n.ch_from) != null && intOr(n.ch_to) != null && n.ch_to >= n.ch_from && n.ch_to - n.ch_from <= 200) {
      for (let c = n.ch_from; c <= n.ch_to; c++) chSet.add(c)
    } else {
      if (intOr(n.ch_from) != null) chSet.add(n.ch_from)
      if (intOr(n.ch_to) != null) chSet.add(n.ch_to)
    }
  }
  for (const p of v.peaks || []) if (intOr(p.ch) != null) chSet.add(p.ch)
  for (const m of v.milestones || []) if (intOr(m.ch) != null) chSet.add(m.ch)
  for (const l of v.lines || []) {
    if (l.opening && intOr(l.opening.ch) != null) chSet.add(l.opening.ch)
    if (l.closing && intOr(l.closing.ch) != null) chSet.add(l.closing.ch)
    for (const b of l.beat || []) if (intOr(b.ch) != null) chSet.add(b.ch)
  }
}
const allChs = [...chSet].filter((n) => Number.isInteger(n) && n > 0).sort((a, b) => a - b)
const FROM = opt('--from') ? Number(opt('--from')) : (allChs[0] ?? 1)
const TO = opt('--to') ? Number(opt('--to')) : (allChs[allChs.length - 1] ?? 1)
if (!Number.isInteger(FROM) || !Number.isInteger(TO) || TO < FROM) {
  console.error('[blueprint-diff] 没检查成：区间非法 --from ' + opt('--from') + ' --to ' + opt('--to'))
  process.exit(2)
}
const chs = allChs.filter((n) => n >= FROM && n <= TO)
if (!chs.length) {
  console.error('[blueprint-diff] 没检查成：区间 ch' + FROM + '–ch' + TO + ' 内既无章纲也无成稿也无蓝图坐标（把没测当没有＝最典型的撒谎方式，不产出空表）')
  process.exit(2)
}

const inRange = (ch) => Number.isInteger(ch) && ch >= FROM && ch <= TO
const linesAt = (ch) => {
  const out = []
  for (const v of bpd.volumes) for (const l of v.lines || []) {
    if (l.opening && l.opening.ch === ch) out.push(v.volume + ':' + l.id + '@opening')
    for (const b of l.beat || []) if (b.ch === ch) out.push(v.volume + ':' + l.id + '@beat')
    if (l.closing && l.closing.ch === ch) out.push(v.volume + ':' + l.id + '@closing')
  }
  return out
}
const resolveRefs = (ref) => {
  const refs = Array.isArray(ref) ? ref : (ref != null ? [ref] : [])
  return refs.map((r) => (allBpIds.has(r) ? r + '(' + allBpIds.get(r).type + ')' : r + '(未知id!)'))
}

// ---------------------------------------------------------------- 逐章实测行
const rows = []
const gaps = []
for (const ch of chs) {
  const o = outlineCh.get(ch) || null
  const h = await msHan(ch)
  const landed = h != null && h > 0
  const refsRaw = o ? (Array.isArray(o.blueprint_ref) ? o.blueprint_ref : (o.blueprint_ref != null ? [o.blueprint_ref] : [])) : []
  const refs = resolveRefs(o ? o.blueprint_ref : null)
  const row = {
    ch,
    title: o ? (o.title ?? null) : null,
    in_outline: !!o,
    manuscript: landed ? { han: h, file: chapterName(ch) } : null,
    tier: peakChs.has(ch) ? '波峰档' : '基线档',
    tier_ids: peakChs.get(ch) || [],
    hook_type_declared: o && o.anchor_params ? (o.anchor_params.hook_type ?? null) : null,
    blueprint_ref: refsRaw.length ? refs : null,
    lines: linesAt(ch),
  }
  rows.push(row)
  if (o && !refsRaw.length) gaps.push({ ch, gap: '章纲缺蓝图挂靠 blueprint_ref（蓝图已立卷：章纲该是全局件的一次展开；warning 级，novel_verify 同口径）' })
  for (const r of refs) if (r.endsWith('(未知id!)')) gaps.push({ ch, gap: '章纲 blueprint_ref 引用未知蓝图 id：' + r + '（挂靠落空；verify 对此报 issue）' })
  if (!o && landed) gaps.push({ ch, gap: '成稿在而章纲不在册（体例章/残章或账实漂移——verify 同款提示）' })
}

// ---------------------------------------------------------------- 蓝图侧对账
const bpCheck = { chain: [], peaks: [], milestones: [], lines: [] }
for (const v of bpd.volumes) {
  for (const n of v.chain || []) {
    if (!Number.isInteger(n.ch_from) || !Number.isInteger(n.ch_to)) continue
    const span = []
    for (let c = Math.max(n.ch_from, FROM); c <= Math.min(n.ch_to, TO); c++) span.push(c)
    const landedChs = []
    for (const c of span) if ((await msHan(c)) != null && (await msHan(c)) > 0) landedChs.push(c)
    bpCheck.chain.push({ id: n.id, name: n.name ?? null, ch_from: n.ch_from, ch_to: n.ch_to, landed: landedChs.length, span_in_range: span.length })
    if (span.length && landedChs.length === 0) gaps.push({ ch: n.ch_from, gap: 'chain 节点 ' + n.id + '（' + (n.name ?? '') + ' ch' + n.ch_from + '–' + n.ch_to + '）区间内零成稿' })
  }
  for (const p of v.peaks || []) {
    if (!inRange(p.ch)) continue
    const landed = (await msHan(p.ch)) != null && (await msHan(p.ch)) > 0
    bpCheck.peaks.push({ id: p.id, ch: p.ch, name: p.name ?? null, landed })
    if (!landed) gaps.push({ ch: p.ch, gap: '波峰 ' + p.id + '（' + (p.name ?? '') + '）未落盘' })
  }
  for (const m of v.milestones || []) {
    if (!inRange(m.ch)) continue
    const landed = (await msHan(m.ch)) != null && (await msHan(m.ch)) > 0
    bpCheck.milestones.push({ id: m.id, kind: m.kind, ch: m.ch, landed })
    if (!landed) gaps.push({ ch: m.ch, gap: '里程碑 ' + m.id + '（' + m.kind + '）未落盘' })
  }
  for (const l of v.lines || []) {
    const entry = { id: l.id, name: l.name ?? null }
    for (const [key, obj] of [['opening', l.opening], ['closing', l.closing]]) {
      if (!obj || !inRange(obj.ch)) continue
      const landed = (await msHan(obj.ch)) != null && (await msHan(obj.ch)) > 0
      entry[key] = { ch: obj.ch, landed }
    }
    for (const fid of l.foreshadow_ids || []) {
      const f = foreshadows.find((x) => x.id === fid)
      if (!f) { entry['f:' + fid] = 'foreshadows.json 无此 id（挂空号＝没法对账）'; gaps.push({ ch: l.opening ? l.opening.ch : FROM, gap: '线 ' + l.id + ' 的 foreshadow_ids 引用不存在的伏笔 ' + fid }) ; continue }
      const drift = []
      if (l.opening && Number.isInteger(f.planted_ch) && f.planted_ch !== l.opening.ch) drift.push('实际 planted_ch=' + f.planted_ch + ' vs 蓝图 opening.ch=' + l.opening.ch)
      if (l.closing && Number.isInteger(f.closed_ch) && f.closed_ch !== l.closing.ch) drift.push('实际 closed_ch=' + f.closed_ch + ' vs 蓝图 closing.ch=' + l.closing.ch)
      entry['f:' + fid] = drift.length ? '漂移：' + drift.join('；') : '合（planted=' + f.planted_ch + ', closed=' + (f.closed_ch ?? '未闭') + '）'
      if (drift.length) gaps.push({ ch: l.opening ? l.opening.ch : FROM, gap: '线 ' + l.id + ' / 伏笔 ' + fid + ' 蓝图坐标与账本实值漂移（' + drift.join('；') + '）' })
    }
    bpCheck.lines.push(entry)
  }
}

// ---------------------------------------------------------------- 输出
const result = {
  instrument: 'blueprint-diff',
  book_dir: BOOK,
  range: { from: FROM, to: TO },
  blueprint_volumes: (bpd.volumes || []).map((v) => ({ volume: v.volume, status: v.status ?? null, chain: (v.chain || []).length, lines: (v.lines || []).length, peaks: (v.peaks || []).length, milestones: (v.milestones || []).length })),
  rows,
  blueprint_check: bpCheck,
  gaps,
  semantic_blank: '每章的钩子型是否落进文本／节拍是否按蓝图功能落笔＝语义判定，归 dissector 盲读（对照 chapter-cycle SKILL G5 固定问句集：Q1 钩子读成人还是读成物／Q2 落板有无停留／Q3 代价与核心拍咬不咬合）。本脚本只算确定性账，不冒充判义。',
  anchor_red_line: '本对照表只进审校侧（dissector 派工），绝不进生成派工包（I4：蓝图对账不注入写作）。',
}

console.log('=== 蓝图对照（dissector 自解剖 · 确定性半边）：ch' + FROM + '–ch' + TO + ' ===')
console.log('口径：只算确定性账（成稿存在性/汉字数/档位/挂靠/线网坐标）；节拍是否落进文本＝语义判定归 dissector——代码不判义。')
console.log('锚定红线：本表只进审校侧，绝不进生成派工包（I4）。')
console.log('蓝图：' + result.blueprint_volumes.map((v) => '卷' + v.volume + '(' + v.status + ') chain' + v.chain + '/lines' + v.lines + '/peaks' + v.peaks + '/ms' + v.milestones).join(' ｜ '))
console.log('')
console.log('── 逐章实测 ──')
for (const r of rows) {
  console.log('ch' + String(r.ch).padStart(3, '0')
    + ' ｜ ' + (r.manuscript ? '落盘 ' + r.manuscript.han + ' 汉字' : '未落盘')
    + ' ｜ ' + r.tier + (r.tier_ids.length ? '(' + r.tier_ids.join('/') + ')' : '')
    + ' ｜ 章纲' + (r.in_outline ? '在册' + (r.title ? '《' + r.title + '》' : '') : '缺')
    + ' ｜ hook_type声明=' + (r.hook_type_declared ?? '—')
    + ' ｜ 挂靠=' + (r.blueprint_ref ? r.blueprint_ref.join(',') : '—')
    + ' ｜ 所在线=' + (r.lines.length ? r.lines.join(',') : '—'))
}
console.log('')
console.log('── 蓝图侧对账（区间内）──')
for (const c of bpCheck.chain) console.log('chain ' + c.id + '（' + (c.name ?? '') + ' ch' + c.ch_from + '–' + c.ch_to + '）：已落盘 ' + c.landed + '/' + c.span_in_range)
for (const p of bpCheck.peaks) console.log('peak  ' + p.id + '（' + (p.name ?? '') + ' @ch' + p.ch + '）：' + (p.landed ? '已落盘' : '未落盘'))
for (const m of bpCheck.milestones) console.log('mile  ' + m.id + '（' + m.kind + ' @ch' + m.ch + '）：' + (m.landed ? '已落盘' : '未落盘'))
for (const l of bpCheck.lines) {
  const parts = []
  if (l.opening) parts.push('opening@ch' + l.opening.ch + (l.opening.landed ? '✓' : '✗未落盘'))
  if (l.closing) parts.push('closing@ch' + l.closing.ch + (l.closing.landed ? '✓' : '✗未落盘'))
  for (const [k, v] of Object.entries(l)) if (k.startsWith('f:')) parts.push(k + ' ' + v)
  console.log('line  ' + l.id + '（' + (l.name ?? '') + '）：' + (parts.join(' ｜ ') || '区间内无坐标'))
}
console.log('')
console.log('── 缺口清单（确定性部分；' + gaps.length + ' 条）──')
for (const g of gaps) console.log('  [ch' + g.ch + '] ' + g.gap)
console.log('')
console.log('── 语义留白（归 dissector 盲读；代码只列声明不判义）──')
for (const r of rows) {
  if (r.in_outline) console.log('  ch' + r.ch + '：蓝图挂靠 ' + (r.blueprint_ref ? r.blueprint_ref.join(',') : '（缺——审校时连带判"本章服务全局件哪一块"是否成立）') + '；hook_type 声明=' + (r.hook_type_declared ?? '—') + ' ⇒ 按固定问句 Q1 验"读成人还是读成物"，节拍按 G5 问句 Q2/Q3 验。')
}

const jsonOut = opt('--json')
if (jsonOut) {
  const { writeFile } = await import('node:fs/promises')
  await writeFile(path.resolve(jsonOut), JSON.stringify(result, null, 2), 'utf8')
  console.log('[blueprint-diff] JSON 已写 ' + path.resolve(jsonOut))
}
process.exit(0)
