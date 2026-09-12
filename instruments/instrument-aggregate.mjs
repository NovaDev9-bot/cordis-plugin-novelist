/**
 * instrument-aggregate.mjs —— 语义仪器聚合器（V3 P3 · ZCode 壳，零 LLM；A1 修复 2026-09-11）
 * 用法：node instrument-aggregate.mjs <book_dir> [--baseline <calibration-baseline.json>]
 *          [--anchor-chapters <锚书章目录>] [--last 20] [--out <dir>]
 *
 * 吃判据账（editorial/scores.jsonl）产出：①按维分布（absolute 1-5）；②z 三档（≤-1σ/±1σ/≥+1σ——
 * A-3 三档制，禁连续值伪精度）；③test-retest 信度（同 ch+dim+judge+mode 多条→within-1/exact/ICC(2,1)
 * 三口径 + 量程使用检验——A-4 kill 判据；A1 起：常数/二值仪表不再假绿）；④anchored_pair 胜负分布
 * （A1 起分维）；⑤风格漂移（相邻章 char 3-gram 的 Jensen-Shannon 距离，F-4；--anchor-chapters 时以
 * 锚书自然漂移 p95 为阈值报出带章）。
 * A1 修复（工程方向v3 §4.1 A1，2026-09-11）：sd=0 / n<5 / 无基线 → 显式 unmeasurable + 告警，不再静默
 * 跳过；手工 bias 常数挂警示（I3：应急数，待标定曲线取代）；两轴冲突（成对判 vs 绝对 z 分档）→
 * report.verdict_blocked 阻断达标结论（F3 处置）。
 * 注：calibration-baseline.json 的 per_book 块已核实无消费方（工程方向v3 §八.2）——B-1 再锚定时清理。
 */
import { readFile, writeFile, mkdir, readdir } from 'node:fs/promises'
import { stat as fstat } from 'node:fs/promises'
import path from 'node:path'

const args = process.argv.slice(2)
const opt = (k, d) => { const i = args.indexOf(k); return i >= 0 ? args[i + 1] : d }
const bookDir = path.resolve(args[0])
const outDir = path.resolve(opt('--out', path.join(bookDir, 'editorial')))
const lastN = Number(opt('--last', 20)) || 20

const readJsonl = async (f) => {
  try { return (await readFile(f, 'utf8')).split('\n').filter(Boolean).map((l) => { try { return JSON.parse(l) } catch { return null } }).filter(Boolean) }
  catch { return [] }
}

// ---------- ①②③④ 判据账聚合 ----------
const scores = await readJsonl(path.join(bookDir, 'editorial/scores.jsonl'))
const report = { generated_at: new Date().toISOString(), book: path.basename(bookDir), scores_total: scores.length, dims: {}, anchored_pair: {}, test_retest: null }

let baseline = null
const bl = opt('--baseline')
if (bl) baseline = JSON.parse(await readFile(bl, 'utf8'))

const byDim = {}
for (const s of scores) { if (s.mode !== 'anchored_pair') { (byDim[s.dim] = byDim[s.dim] || []).push(s) } }
const warnings = []
const unmeasurable = []
for (const [dim, list] of Object.entries(byDim)) {
  const dist = {}; for (const s of list) dist[s.score] = (dist[s.score] || 0) + 1
  const mean = list.reduce((a, s) => a + s.score, 0) / list.length
  const distinct = Object.keys(dist).map(Number).sort((a, b) => a - b)
  const d = { n: list.length, dist, mean: Math.round(mean * 100) / 100, distinct_values: distinct }
  // 仪表登记（I3/F5）：判官实际只用 ≤2 个取值的维度必须显式标注，不得与 5 分制混装同精度
  if (distinct.length === 1) { d.instrument = 'constant（判官恒定输出，0 信息量）'; warnings.push(`维度「${dim}」判官恒定输出 ${distinct[0]} 分——常数仪表，任何信度门在其上恒为满分（假绿）`) }
  else if (distinct.length === 2) { d.instrument = 'binary（判官实际二值——如为存在性判定请登记为二值仪表，勿混入 5 分制 z 报告）' }
  const bl = baseline && baseline[dim]
  if (baseline && !bl) { d.baseline_status = 'unanchored（无基线，z 不可算）' }
  else if (bl && !(bl.sd > 0)) { d.baseline_status = 'unmeasurable：基线 sd=0（除零，z 不存在）'; unmeasurable.push({ dim, reason: `sd=0（n=${bl.n}，锚书样本全同分）` }) ; warnings.push(`维度「${dim}」基线 sd=0 → z 静默跳过改为显式不可测（I3）`) }
  else if (bl && bl.n < 5) { d.baseline_status = `unmeasurable：基线 n=${bl.n}<5（样本不足）`; unmeasurable.push({ dim, reason: `n=${bl.n}<5` }); warnings.push(`维度「${dim}」基线 n=${bl.n}<5 → 显式不可测（I3）`) }
  else if (bl) {
    // 同源通胀偏置修正（J3 混排盲评实测的我方判高差值，calibration-baseline.dim.bias）：先扣 bias 再算 z
    const bias = (bl.bias && bl.bias.correction) || 0
    if (bias) {
      d.bias_applied = { correction: bias, provenance: bl.bias.provenance || 'unknown' }
      warnings.push(`维度「${dim}」z 计算扣了手工常数 bias=${bias}（${bl.bias.provenance || '来源不明'}）——I3 要求改为按维度标定的偏置曲线，此数仅应急`)
    }
    const z = (x) => (x - bias - bl.mean) / bl.sd
    const bands = { 'le-1sigma': 0, within: 0, 'ge+1sigma': 0 }
    for (const s of list) { const zz = z(s.score); bands[zz <= -1 ? 'le-1sigma' : zz >= 1 ? 'ge+1sigma' : 'within']++ }
    d.z_bands = bands
    d.baseline_status = 'ok'
  }
  report.dims[dim] = d
}

const pairs = scores.filter((s) => s.mode === 'anchored_pair')
if (pairs.length) {
  const dist = { '-1': 0, 0: 0, 1: 0 }
  for (const s of pairs) dist[String(s.score)]++
  const byDimPairs = {}
  for (const s of pairs) { (byDimPairs[s.dim] = byDimPairs[s.dim] || { '-1': 0, 0: 0, 1: 0 }); byDimPairs[s.dim][String(s.score)]++ }
  const perDim = {}
  for (const [dim, dd] of Object.entries(byDimPairs)) perDim[dim] = { n: dd['-1'] + dd['0'] + dd['1'], dist: dd, win_rate: Math.round(dd['1'] / (dd['-1'] + dd['0'] + dd['1']) * 1000) / 10 }
  report.anchored_pair = { n: pairs.length, dist, win_rate: Math.round(dist['1'] / pairs.length * 1000) / 10, by_dim: perDim }
}

// test-retest：同 (ch,dim,judge,mode) 出现≥2 次 → 相邻两次为一对
const groups = {}
for (const s of scores) {
  if (s.mode === 'anchored_pair') continue
  const k = [s.ch, s.dim, s.judge, s.mode].join('|')
  ;(groups[k] = groups[k] || []).push(s)
}
let pairN = 0, agreeN = 0, exactN = 0
const allAbs = scores.filter((s) => s.mode !== 'anchored_pair')
const scaleUsage = {}
for (const s of allAbs) { scaleUsage[s.score] = (scaleUsage[s.score] || 0) + 1 }
const distinctAll = Object.keys(scaleUsage).map(Number).sort((a, b) => a - b)
const topShare = allAbs.length ? Math.max(...Object.values(scaleUsage)) / allAbs.length : 0
// ICC(2,1)（双向随机、单次测量、一致性口径）：k=2 的配对可算；方差退化时返回 null
function icc21(pairsOfScores) {
  const n = pairsOfScores.length
  if (n < 3) return null
  const k = 2
  let gMean = 0; for (const [a, b] of pairsOfScores) gMean += a + b
  gMean /= n * k
  let ssr = 0, sse = 0
  for (const [a, b] of pairsOfScores) {
    const rm = (a + b) / k
    ssr += k * (rm - gMean) ** 2
    sse += (a - rm) ** 2 + (b - rm) ** 2 // k=2 时列效应并入残差（一致性口径）
  }
  const msr = ssr / (n - 1), mse = sse / (n * (k - 1))
  if (msr + mse === 0) return null
  return (msr - mse) / (msr + (k - 1) * mse)
}
const pairScoresArr = []
for (const list of Object.values(groups)) {
  const sorted = list.sort((a, b) => (a.ts < b.ts ? -1 : 1))
  for (let i = 1; i < sorted.length; i++) { pairN++; if (Math.abs(sorted[i].score - sorted[i - 1].score) <= 1) agreeN++; if (sorted[i].score === sorted[i - 1].score) exactN++; pairScoresArr.push([sorted[i - 1].score, sorted[i].score]) }
}
if (pairN) {
  const within1 = agreeN / pairN, exact = exactN / pairN
  const icc = icc21(pairScoresArr)
  const scaleOk = distinctAll.length >= 3
  let verdict, failReasons = []
  if (within1 < 0.7) failReasons.push('within-1 <70%（原 A-4 kill 判据）')
  if (!scaleOk) failReasons.push(`量程未使用：全部绝对判词只出现 ${distinctAll.length} 个取值 [${distinctAll.join(', ')}]（top 取值占比 ${(topShare * 100).toFixed(1)}%）——常数/二值仪表上 within-1 与 exact 恒为满分，信度门假绿（F2/F5）`)
  if (icc === null) failReasons.push('ICC 不可算（配对 n<3 或方差退化）')
  else if (icc < 0.4) failReasons.push(`ICC(2,1)=${icc.toFixed(3)} <0.40（差）`)
  verdict = failReasons.length ? `FAIL——${failReasons.join('；')}` : `PASS（within1≥70% 且量程≥3 取值 且 ICC≥0.4）`
  report.test_retest = {
    pairs: pairN, within1_rate: Math.round(within1 * 1000) / 10, exact_rate: Math.round(exact * 1000) / 10,
    icc_2_1: icc === null ? null : Math.round(icc * 1000) / 1000,
    scale_usage: { distinct_values: distinctAll, top_share: Math.round(topShare * 1000) / 1000 },
    verdict,
  }
}

// ---------- ⑤b 两轴冲突（F3）：绝对 z 分档 vs 成对判胜负打架 → 阻断达标结论 ----------
const axisConflicts = []
if (report.anchored_pair && report.anchored_pair.by_dim) {
  for (const [dim, pd] of Object.entries(report.anchored_pair.by_dim)) {
    const d = report.dims[dim]
    if (!d || !d.z_bands || pd.n < 5) continue
    const total = d.n || 1
    const lowShare = d.z_bands['le-1sigma'] / total, highShare = d.z_bands['ge+1sigma'] / total
    if (pd.win_rate >= 60 && lowShare >= 0.5) axisConflicts.push({ dim, pair_win_rate: pd.win_rate, absolute_low_share: Math.round(lowShare * 100) / 100, rule: '成对判显著获胜但绝对分档过半落"低"——reliability-report.md 预言的升级主编裁决条件成立，达标结论挂起' })
    else if (pd.win_rate <= 40 && highShare >= 0.5) axisConflicts.push({ dim, pair_win_rate: pd.win_rate, absolute_high_share: Math.round(highShare * 100) / 100, rule: '成对判显著落败但绝对分档过半落"高"——两轴矛盾，达标结论挂起' })
  }
}
if (axisConflicts.length) {
  report.axis_conflicts = axisConflicts
  report.verdict_blocked = axisConflicts.map((c) => c.dim)
  for (const c of axisConflicts) warnings.push(`两轴冲突[${c.dim}]：${c.rule}`)
}

// ---------- ⑤ 风格漂移（F-4） ----------
const HAN = /[\u4e00-\u9fff]/g
function trigrams(text) {
  const t = (text.match(HAN) || []).join('')
  const m = new Map()
  for (let i = 0; i + 3 <= t.length; i++) { const g = t.slice(i, i + 3); m.set(g, (m.get(g) || 0) + 1) }
  return m
}
function jsd(m1, m2) {
  const keys = new Set([...m1.keys(), ...m2.keys()])
  const n1 = [...m1.values()].reduce((a, b) => a + b, 0), n2 = [...m2.values()].reduce((a, b) => a + b, 0)
  let js = 0
  for (const k of keys) {
    const p = (m1.get(k) || 0) / n1, q = (m2.get(k) || 0) / n2, m = (p + q) / 2
    if (p > 0) js += 0.5 * p * Math.log2(p / m)
    if (q > 0) js += 0.5 * q * Math.log2(q / m)
  }
  return js
}
const chapterFiles = (await readdir(path.join(bookDir, 'manuscript')).catch(() => [])).filter((f) => /^chapter_\d+\.md$/.test(f)).sort()
if (chapterFiles.length >= 2) {
  const recent = chapterFiles.slice(-lastN)
  const grams = []
  for (const f of recent) grams.push(trigrams(await readFile(path.join(bookDir, 'manuscript', f), 'utf8')))
  const series = []
  for (let i = 1; i < grams.length; i++) series.push({ from: Number(recent[i - 1].match(/\d+/)[0]), to: Number(recent[i].match(/\d+/)[0]), jsd: Math.round(jsd(grams[i - 1], grams[i]) * 10000) / 10000 })
  const vals = series.map((s) => s.jsd).sort((a, b) => a - b)
  const drift = { chapters: recent.length, series, median: vals[Math.floor(vals.length / 2)], max: vals[vals.length - 1] }
  const ac = opt('--anchor-chapters')
  if (ac && await fstat(ac).then(() => true).catch(() => false)) {
    const afiles = (await readdir(ac)).filter((f) => /\.md$/.test(f)).sort()
    const avals = []
    for (let i = 1; i < Math.min(afiles.length, 60); i++) {
      const g1 = trigrams(await readFile(path.join(ac, afiles[i - 1]), 'utf8'))
      const g2 = trigrams(await readFile(path.join(ac, afiles[i]), 'utf8'))
      avals.push(jsd(g1, g2))
    }
    avals.sort((a, b) => a - b)
    drift.anchor_p95 = Math.round(avals[Math.floor(0.95 * (avals.length - 1))] * 10000) / 10000
    drift.flagged = series.filter((s) => s.jsd > drift.anchor_p95).map((s) => s.to)
  }
  report.style_drift = drift
}

await mkdir(outDir, { recursive: true })
report.warnings = warnings
report.unmeasurable_dims = unmeasurable
const outFile = path.join(outDir, 'instrument-report.json')
await writeFile(outFile, JSON.stringify(report, null, 2), 'utf8')
console.log(`[instrument-aggregate] ${report.book}：${report.scores_total} 条判词 → ${outFile}`)
if (warnings.length) { console.log(`⚠ 告警 ${warnings.length} 条：`); for (const w of warnings) console.log(`  ⚠ ${w}`) }
if (report.verdict_blocked) console.log(`⛔ 两轴冲突，达标结论阻断：${report.verdict_blocked.join('、')}`)
console.log(JSON.stringify({ dims: Object.keys(report.dims), anchored_pair: report.anchored_pair.n || 0, test_retest: report.test_retest && { verdict: report.test_retest.verdict, exact: report.test_retest.exact_rate, icc: report.test_retest.icc_2_1 }, unmeasurable: report.unmeasurable_dims, drift_median: report.style_drift && report.style_drift.median, flagged: report.style_drift && report.style_drift.flagged }))
