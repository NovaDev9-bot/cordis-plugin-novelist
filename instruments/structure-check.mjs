/**
 * structure-check.mjs —— 结构仪器（只读，零 LLM，零依赖）
 *
 * 用法：node structure-check.mjs <book_dir> [--json out.json] [--praise-min 3] [--ch N]
 *
 * ── 为什么只有两个量（结构审计批 2026-09-18，Owner 拍板）────────────────────
 * 结构层面的问题里，只有两类**能从账本算出来**，其余全是语义判断：
 *   ① 伏笔曝光曲线——每章挂着多少条未收的线、其中多少条已过 due。输入是
 *      foreshadows.json 的 planted_ch/due_ch/closed_ch，纯算术。
 *   ② 爽点间隔——连续多少"测过的"章没有爽点。输入是判据账 scores.jsonl 里
 *      dim=爽点 的判词，纯计数。
 * 「反转是不是真的反转」「这章节奏松不松」「幕结构对不对」——这些算不出来。
 * 硬要算就只能让代码假装能判语义，产出一串看起来精确的假数字；那比不测更坏，
 * 因为它会被当成证据引到裁决里（判据降权条款 R8 的原意正在此处）。
 * 所以本仪器**显式列出它测不了什么**，并把"没测"和"测到没有"分开报——
 * 把未测章当成"没有爽点"，是这类仪器最典型的撒谎方式。
 *
 * ── 纪律 ────────────────────────────────────────────────────────────────
 * 观测器，不是闸门：报数+描述性统计，永不判"结构好不好"。判定归编辑部与 Owner。
 * 只读：不写 book_dir 里任何文件（--json 写你指定的路径，默认不写）。
 */
import { readFile, writeFile, readdir } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { createHash } from 'node:crypto'
import path from 'node:path'

const argv = process.argv.slice(2)
const opt = (k, d) => { const i = argv.indexOf(k); return i >= 0 ? argv[i + 1] : d }
const VALUE_FLAGS = new Set(['--json', '--praise-min', '--ch'])
let bookDir = null
for (let i = 0; i < argv.length; i++) {
  if (VALUE_FLAGS.has(argv[i])) { i++; continue }
  if (!argv[i].startsWith('--')) { bookDir = argv[i]; break }
}
if (!bookDir) {
  console.error('用法：node structure-check.mjs <book_dir> [--json out.json] [--praise-min 3] [--ch N]')
  process.exit(2)
}
const BOOK = path.resolve(bookDir)
// 书目录不存在＝**没检查成**，不是"全部为 0"——路径配错或账本丢失时静默产出空报告并 EXIT 0，
// CI 与人都无法发现"书丢了"，且 null 会直接进用户报告（2026-09-19 第三方审计实测）。
if (!existsSync(BOOK)) {
  console.error('[structure-check] 没检查成：书目录不存在 ' + BOOK + '（"书不存在"不许报成"0 章 0 条"——那是把没测当没有）')
  process.exit(2)
}
const PRAISE_MIN = Number(opt('--praise-min', 3))
const ONLY_CH = opt('--ch') ? Number(opt('--ch')) : null

const readJsonSafe = async (p, fallback) => { try { return JSON.parse(await readFile(p, 'utf8')) } catch (e) { return fallback } }
const readJsonlSafe = async (p) => {
  let raw = ''
  try { raw = await readFile(p, 'utf8') } catch (e) { return [] }
  const out = []
  for (const line of raw.split('\n')) {
    const t = line.trim()
    if (!t) continue
    try { out.push(JSON.parse(t)) } catch (e) { /* 撕裂残行：readJsonlLines 的同类容忍，不因半行炸整个仪器 */ }
  }
  return out
}
const sha256 = (s) => createHash('sha256').update(s, 'utf8').digest('hex')
const chapterName = (n) => 'chapter_' + String(n).padStart(3, '0') + '.md'
const han = (s) => (s.match(/[\u4e00-\u9fff]/g) || []).length

// ---------------------------------------------------------------- 读账本

const project = await readJsonSafe(path.join(BOOK, 'project.json'), {})
const fsh = await readJsonSafe(path.join(BOOK, 'foreshadows.json'), { foreshadows: [] })
const outline = await readJsonSafe(path.join(BOOK, 'outline.json'), { volumes: [] })
const scores = await readJsonlSafe(path.join(BOOK, 'editorial', 'scores.jsonl'))
const arcs = await readJsonlSafe(path.join(BOOK, 'editorial', 'arcs.jsonl'))
const tape = await readJsonlSafe(path.join(BOOK, 'editorial', 'events-tape.jsonl'))

let msFiles = []
try { msFiles = (await readdir(path.join(BOOK, 'manuscript'))).filter((f) => /^chapter_\d+\.md$/.test(f)) } catch (e) { /* 无正文目录 */ }
const written = msFiles.map((f) => Number(f.match(/(\d+)/)[1])).sort((a, b) => a - b)
const cur = ONLY_CH || project.current_ch || (written.length ? written[written.length - 1] : 0)
const maxCh = written.length ? written[written.length - 1] : 0

// 正文哈希（爽点判词的 stale 过滤要用）：只在需要时读正文
const msHash = new Map()
async function hashOf(ch) {
  if (msHash.has(ch)) return msHash.get(ch)
  let h = null
  try { h = sha256(await readFile(path.join(BOOK, 'manuscript', chapterName(ch)), 'utf8')) } catch (e) { /* 该章无正文 */ }
  msHash.set(ch, h)
  return h
}

// ---------------------------------------------------------------- ① 伏笔曝光曲线

const fs_ = fsh.foreshadows || []
// 在某章"还挂着"= 已埋且尚未收。收的时点优先取 closed_ch（这样曲线能反映"第 5 章才收"，
// 而不是从埋下那天就当它不存在）；旧账本只有 status 没有 closed_ch 时退化为"埋下即算收"，
// 不猜一个假的收线章。
const closedAt = (f) => (Number.isInteger(f.closed_ch) ? f.closed_ch : (f.status === 'closed' ? f.planted_ch : Infinity))
const curve = []
for (let ch = 1; ch <= maxCh; ch++) {
  const openList = fs_.filter((f) => Number.isInteger(f.planted_ch) && f.planted_ch <= ch && ch < closedAt(f))
  const overdueList = openList.filter((f) => Number.isInteger(f.due_ch) && f.due_ch < ch)
  curve.push({
    ch,
    open: openList.length,
    overdue: overdueList.length,
    planted: fs_.filter((f) => f.planted_ch === ch).length,
    closed: fs_.filter((f) => f.closed_ch === ch).length,
  })
}
const closedPairs = fs_.filter((f) => Number.isInteger(f.planted_ch) && Number.isInteger(f.closed_ch) && f.closed_ch >= f.planted_ch)
const payoffDistances = closedPairs.map((f) => f.closed_ch - f.planted_ch).sort((a, b) => a - b)
const median = (arr) => (arr.length ? (arr.length % 2 ? arr[(arr.length - 1) / 2] : Math.round((arr[arr.length / 2 - 1] + arr[arr.length / 2]) / 2)) : null)
const maxOpen = curve.reduce((m, r) => (r.open > m.open ? r : m), { ch: null, open: 0 })
const firstPlant = fs_.reduce((m, f) => (Number.isInteger(f.planted_ch) && f.planted_ch < m ? f.planted_ch : m), Infinity)
const zeroOpen = curve.filter((r) => r.open === 0 && firstPlant !== Infinity && r.ch > firstPlant).map((r) => r.ch)

const foreshadow = {
  curve, // 每章一行；长书用 --json 取全量，终端只打抽样
  stats: {
    planted_total: fs_.filter((f) => Number.isInteger(f.planted_ch)).length,
    closed_total: closedPairs.length,
    open_at_end: curve.length ? curve[curve.length - 1].open : 0,
    overdue_at_end: curve.length ? curve[curve.length - 1].overdue : 0,
    max_open: curve.length ? maxOpen.open : null,
    max_open_ch: maxOpen.ch,
    mean_open: curve.length ? Number((curve.reduce((s, r) => s + r.open, 0) / curve.length).toFixed(2)) : null,
    zero_open_chapters: zeroOpen,
    payoff_distance_median: median(payoffDistances),
    payoff_distance_max: payoffDistances.length ? payoffDistances[payoffDistances.length - 1] : null,
    payoff_samples: payoffDistances.length,
  },
}

// ---------------------------------------------------------------- ② 爽点间隔（判据账）

const praiseRecs = scores.filter((r) => String(r.dim || '').trim() === '爽点')
const praiseByCh = new Map()
let praiseStale = 0
let praiseLegacy = 0
for (const r of praiseRecs) {
  if (!Number.isInteger(r.ch)) continue
  const curHash = await hashOf(r.ch)
  // 版本口径与 novel_score read 一致：改稿后旧版判词不再冒充当前版结论。
  // 无 content_hash（批A2 之前的旧判词）= legacy，计入但标记，不静默丢弃。
  if (r.content_hash && curHash && r.content_hash !== curHash) { praiseStale++; continue }
  if (!r.content_hash) praiseLegacy++
  const prev = praiseByCh.get(r.ch)
  const abs = r.mode === 'anchored_pair' ? null : (typeof r.score === 'number' ? r.score : null)
  const entry = prev || { ch: r.ch, max: null, judges: 0, anchored_only: true, legacy: false }
  entry.judges++
  entry.legacy = entry.legacy || !r.content_hash
  if (abs != null) { entry.anchored_only = false; entry.max = entry.max == null ? abs : Math.max(entry.max, abs) }
  praiseByCh.set(r.ch, entry)
}
const measuredYes = []
const measuredNo = []
const unmeasured = []
for (const ch of written) {
  const e = praiseByCh.get(ch)
  if (!e || e.anchored_only) { unmeasured.push(ch); continue }
  if (e.max >= PRAISE_MIN) measuredYes.push(ch); else measuredNo.push(ch)
}
// 连续"测过且没爽点"的run=间隔。被未测章打断的run单独标注（不能把没测当没有）
const runs = []
let run = null
for (const ch of written) {
  if (measuredNo.includes(ch)) { if (!run) run = { from: ch, to: ch, length: 1 }; else { run.to = ch; run.length++ } }
  else { if (run) { runs.push(run); run = null } }
}
if (run) runs.push(run)
for (const r of runs) r.bordered_by_unmeasured = unmeasured.includes(r.from - 1) || unmeasured.includes(r.to + 1)
const praise = {
  threshold: PRAISE_MIN,
  records: praiseRecs.length,
  stale_filtered: praiseStale,
  legacy_unhashed: praiseLegacy,
  measured_with: measuredYes.length,
  measured_without: measuredNo.length,
  unmeasured_chapters: unmeasured,
  gaps: runs.sort((a, b) => b.length - a.length),
  max_gap: runs.length ? Math.max(...runs.map((r) => r.length)) : 0,
  rule: '有爽点=任一位判官 absolute 分 ≥' + PRAISE_MIN + '（取每章最大分）；anchored_pair 判词是成对比较，不折算成绝对有无',
}

// ---------------------------------------------------------------- ③ 承重章（来自弧审账单）

const loadBearing = {
  entries: arcs.map((a) => ({ volume: a.volume, arc: a.arc, from: a.ch_from, to: a.ch_to, load_bearing_ch: a.load_bearing_ch, reversal: a.reversal, verdict: a.verdict })),
  chapters: [...new Set(arcs.map((a) => a.load_bearing_ch).filter(Number.isInteger))].sort((a, b) => a - b),
}

// ---------------------------------------------------------------- ④ 钩子（事件带 hook 条目）

const revoked = new Set(tape.filter((e) => e.supersedes).map((e) => e.supersedes))
const activeTape = tape.filter((e) => !revoked.has(e.id))
const closedThreads = new Set(activeTape.filter((e) => e.closes_thread).map((e) => e.closes_thread))
const hooks = activeTape.filter((e) => e.kind === 'hook')
const openHooks = hooks.filter((h) => !closedThreads.has(h.id))
const hooksReport = {
  total: hooks.length,
  open: openHooks.length,
  open_ages: openHooks.filter((h) => Number.isInteger(h.ch)).map((h) => ({ id: h.id, ch: h.ch, age: maxCh - h.ch, what: h.what })).sort((a, b) => b.age - a.age),
  chapters_without_hook: written.filter((n) => !hooks.some((h) => h.ch === n)),
}

// ---------------------------------------------------------------- ⑤ 测不了什么（显式）

const unmeasurable = [
  '反转/爽点是否"真"成立（是否只是作者自嗨的假爽点）——语义判断，归试读员与 Owner 裁决',
  '节奏松紧、信息密度、情绪强度——文本语义量，本仪器不产生任何此类数字',
  '幕/中点结构是否成立——本项目结构方法为"节拍移植+策略池"，不采用幕式骨架；即便采用也无账本可算',
  '本弧"差异化是否真落地"——只有弧审账单里的 reviewer 人工结论（见 load_bearing.entries[].verdict），仪器不复核',
  '伏笔"该不该现在收"——due_ch 是当初排期，逾期只说明排期没兑现，不说明排期定错了',
]

// ---------------------------------------------------------------- 报告

const sample = (arr, n) => (arr.length <= n ? arr : arr.filter((_, i) => i % Math.ceil(arr.length / n) === 0))
const coverage = {
  book_dir: BOOK,
  current_ch: cur,
  chapters_written: written.length,
  foreshadows: fs_.length,
  score_records: scores.length,
  praise_records: praiseRecs.length,
  arc_entries: arcs.length,
  hook_entries: hooks.length,
}
const report = { coverage, foreshadow, praise, load_bearing: loadBearing, hooks: hooksReport, unmeasurable }

const L = []
L.push('结构仪器报告 · ' + BOOK)
L.push('账本覆盖：正文 ' + written.length + ' 章（至第 ' + maxCh + ' 章）／伏笔 ' + fs_.length + ' 条／判据账 ' + scores.length + ' 条（其中爽点 ' + praiseRecs.length + '）／弧审账单 ' + arcs.length + ' 条／钩子 ' + hooks.length + ' 条')
L.push('')
L.push('① 伏笔曝光曲线（每章挂着多少条未收的线）')
L.push('  埋下 ' + foreshadow.stats.planted_total + '／已收 ' + foreshadow.stats.closed_total + '／当前未收 ' + foreshadow.stats.open_at_end + '（其中已过 due ' + foreshadow.stats.overdue_at_end + '）')
// 全未测（无章可算）时整句报"未测"，不打印 0——数字 0 与"没测"必须是两种输出
// （2026-09-20 复核：旧写法括号里声明未测、数字仍打 0 与"全程均值 0 条"，自相矛盾）
L.push(foreshadow.stats.max_open == null
  ? '  峰值与均值：未测（账本无章可算——"没测"不等于"测到 0 条"）'
  : '  峰值 未收 ' + foreshadow.stats.max_open + ' 条 @第 ' + (foreshadow.stats.max_open_ch == null ? '—' : foreshadow.stats.max_open_ch) + ' 章；全程均值 ' + foreshadow.stats.mean_open + ' 条')
L.push('  埋→收间隔：中位 ' + (foreshadow.stats.payoff_distance_median ?? '—') + ' 章／最长 ' + (foreshadow.stats.payoff_distance_max ?? '—') + ' 章（样本 ' + foreshadow.stats.payoff_samples + '）')
L.push('  零未收伏笔的章：' + (zeroOpen.length ? zeroOpen.slice(0, 12).join('/') + (zeroOpen.length > 12 ? ' 等共 ' + zeroOpen.length + ' 章' : '') : '无'))
if (curve.length) {
  L.push('  曲线抽样（章:未收/逾期）：' + sample(curve, 12).map((r) => r.ch + ':' + r.open + '/' + r.overdue).join('  '))
}
L.push('')
L.push('② 爽点间隔（判据账口径，阈值 absolute ≥' + PRAISE_MIN + '）')
L.push('  测过有爽点 ' + praise.measured_with + ' 章／测过无爽点 ' + praise.measured_without + ' 章／**未测 ' + unmeasured.length + ' 章**')
if (praiseStale) L.push('  已按版本过滤掉改稿前的旧版判词 ' + praiseStale + ' 条' + (praiseLegacy ? '（其中无 hash 的旧判词 ' + praiseLegacy + ' 条按 legacy 计入）' : ''))
if (runs.length) {
  L.push('  最长空档 ' + praise.max_gap + ' 章：' + runs.slice(0, 6).map((r) => '第 ' + r.from + '-' + r.to + ' 章(' + r.length + ')' + (r.bordered_by_unmeasured ? '〔邻接未测章，空档可能被低估〕' : '')).join('  '))
} else {
  L.push('  未测到连续空档（注意：样本不足时"没有空档"不等于"每章都有爽点"）')
}
if (unmeasured.length) L.push('  ⚠ 未测章不计入任何统计："没测"≠"没有"——未测章：' + unmeasured.slice(0, 15).join('/') + (unmeasured.length > 15 ? ' 等' : ''))
L.push('')
L.push('③ 承重章（来自弧审账单，人工结论）')
if (!arcs.length) L.push('  无弧审账单（editorial/arcs.jsonl 为空）——本项无数据')
else for (const a of loadBearing.entries) L.push('  卷' + a.volume + ' ' + a.arc + '：第 ' + a.from + '-' + a.to + ' 章，承重点第 ' + a.load_bearing_ch + ' 章，' + a.verdict + '｜翻转：' + a.reversal)
L.push('')
L.push('④ 钩子（事件带 kind=hook）')
if (!hooks.length) L.push('  无钩子记录')
else {
  L.push('  共 ' + hooks.length + ' 条，未兑现 ' + openHooks.length + ' 条')
  for (const h of hooksReport.open_ages.slice(0, 8)) L.push('    ' + h.id + ' 第 ' + h.ch + ' 章（已过 ' + h.age + ' 章）「' + h.what + '」')
  if (hooksReport.chapters_without_hook.length) L.push('  无钩子记录的章：' + hooksReport.chapters_without_hook.slice(0, 12).join('/') + (hooksReport.chapters_without_hook.length > 12 ? ' 等共 ' + hooksReport.chapters_without_hook.length + ' 章' : ''))
}
L.push('')
L.push('⑤ 本仪器测不了的（列出来是纪律，不是免责）')
for (const u of unmeasurable) L.push('  ✗ ' + u)

const text = L.join('\n')
console.log(text)
const jsonOut = opt('--json')
if (jsonOut) {
  await writeFile(path.resolve(jsonOut), JSON.stringify(report, null, 2), 'utf8')
  console.log('\n[JSON] ' + path.resolve(jsonOut))
}
