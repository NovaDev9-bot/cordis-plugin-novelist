/**
 * style-check.mjs —— L1 机检层·文体观测器（工程方向v3 §4.1 A3 · ZCode 壳，零 LLM，2026-09-11）
 * 用法：node style-check.mjs <file> [--enc auto|utf8|gbk] [--sample N] [--json <out.json>] [--label X]
 *
 * 干四件事（数据全部来自 style-lexicon.json，I4：词库=数据不是散文）：
 *   ①公式化检测复活：模板开场(8)/万金油过渡(8)/强调滥用(3)/三连排比(5)+阈值——旧引擎在役资产，
 *     权重失传处改为去重命中类别数，透明可算；
 *   ②文体分布：段落字长（≤两行占比/超150字占比/中位/p90）、句长、对话段占比；
 *   ③负向词库密度：MASTER+humanizer 提取的词汇级清单，按类报密度（每万字）；
 *   ④感叹号密度与比喻标记计数（R3/R5 证伪靶）。
 * 纪律：本工具是观测器——报数+软警告，永不作语义质量门禁（仓库 AGENTS.md 纪律七）。
 * 编码：auto 先试 UTF-8（含 BOM 剥离），出现 U+FFFD 即回退 GBK（Node full-ICU TextDecoder）。
 */
import { readFile, writeFile } from 'node:fs/promises'
import path from 'node:path'

const args = process.argv.slice(2)
const opt = (k, d) => { const i = args.indexOf(k); return i >= 0 ? args[i + 1] : d }
const file = path.resolve(args[0])
if (!file) { console.error('用法：node style-check.mjs <file> [--enc auto|utf8|gbk] [--sample N] [--json out] [--label X] [--lexicon my.json]'); process.exit(2) }

// 词库叠加语义：内置为底，--lexicon 提供的顶层键覆盖之（典型用法=只给 negative_lexicon）
const LEX = JSON.parse(await readFile(path.join(import.meta.dirname, 'style-lexicon.json'), 'utf8'))
const lexArg = opt('--lexicon')
if (lexArg) Object.assign(LEX, JSON.parse(await readFile(lexArg, 'utf8')))

// ---------- 编码探测 ----------
const raw = await readFile(file)
let encUsed = 'utf8'
let text = new TextDecoder('utf-8', { fatal: false }).decode(raw)
if (text.charCodeAt(0) === 0xfeff) text = text.slice(1)
if (text.includes('\uFFFD')) {
  const g = new TextDecoder('gbk').decode(raw)
  if (!g.includes('\uFFFD')) { text = g; encUsed = 'gbk' }
}
const encArg = opt('--enc', 'auto')
if (encArg === 'gbk') { text = new TextDecoder('gbk').decode(raw); encUsed = 'gbk' }
else if (encArg === 'utf8') { text = new TextDecoder('utf-8').decode(raw); encUsed = 'utf8' }
text = text.replace(/\r\n?/g, '\n')

// ---------- 章切分与抽样 ----------
const CH_RE = /^\s*(第[零一二三四五六七八九十百千万0-9]+[章回节卷][^\n]{0,60}|Chapter\s+\d+[^\n]{0,60})\s*$/
function chapterize(t) {
  const lines = t.split('\n')
  const chapters = []
  let cur = null
  for (const line of lines) {
    if (CH_RE.test(line)) { if (cur) chapters.push(cur); cur = { title: line.trim(), body: [] } }
    else if (cur) cur.body.push(line)
  }
  if (cur) chapters.push(cur)
  return chapters.filter((c) => c.body.join('').replace(/\s/g, '').length >= 200) // 滤目录残片
}
let units
const chapters = chapterize(text)
const sampleN = Number(opt('--sample', 0)) || 0
if (chapters.length >= 3) {
  let picked = chapters
  if (sampleN > 0 && sampleN < chapters.length) {
    // 均匀抽样偏中部（开篇/结尾体裁特殊，取中段代表常规正章）
    const mid = chapters.slice(Math.floor(chapters.length * 0.2), Math.ceil(chapters.length * 0.9))
    picked = []
    const step = mid.length / sampleN
    for (let i = 0; i < sampleN; i++) picked.push(mid[Math.floor(i * step)])
  }
  units = picked.map((c) => ({ title: c.title, text: c.body.join('\n') }))
} else {
  units = [{ title: '(whole)', text }]
}

// ---------- 指标 ----------
const HAN = /[\u4e00-\u9fff]/g
const hanCount = (s) => (s.match(HAN) || []).length
const quantile = (sorted, q) => sorted.length ? sorted[Math.min(sorted.length - 1, Math.floor(q * sorted.length))] : 0

const FD = LEX.formula_detector
const TPL_RES = FD.template_openings.map((t) => ({ label: t.label, re: new RegExp(t.regex, 'g') }))
const TP_RES = FD.triple_parallel.map((t) => ({ label: t.label, re: new RegExp(t.regex, 'g') }))

function checkUnit(u) {
  const t = u.text
  const paras = t.split('\n').map((l) => l.trim()).filter((l) => l.length > 0)
  const paraLens = paras.map((l) => l.length).sort((a, b) => a - b)
  const sentences = t.split(/[。！？!?；;]+/).map((s) => s.trim()).filter(Boolean)
  const sentLens = sentences.map((s) => s.length).sort((a, b) => a - b)
  const han = hanCount(t)
  const twoLine = 2 * LEX.chars_per_line

  // 公式化四组
  const tpl = {}; let tplHits = 0
  for (const { label, re } of TPL_RES) { re.lastIndex = 0; const m = t.match(re); if (m) { tpl[label] = m.length; tplHits += m.length } }
  const trans = {}; let transHits = 0
  for (const w of FD.generic_transitions) { const n = t.split(w).length - 1; if (n) { trans[w] = n; transHits += n } }
  const emph = {}; let emphHits = 0
  for (const w of FD.emphasis_abuse) { const n = t.split(w).length - 1; if (n) { emph[w] = n; emphHits += n } }
  const tp = {}; let tpHits = 0
  for (const { label, re } of TP_RES) { re.lastIndex = 0; const m = t.match(re); if (m) { tp[label] = m.length; tpHits += m.length } }
  const formulaScore = [Object.keys(tpl).length, Object.keys(trans).length, Object.keys(emph).length, Object.keys(tp).length].filter((x) => x > 0).length

  // 负向词库
  const lex = {}; let lexHits = 0
  for (const [cat, words] of Object.entries(LEX.negative_lexicon)) {
    let c = 0; const hits = {}
    for (const w of words) { const n = t.split(w).length - 1; if (n) { hits[w] = n; c += n } }
    if (c) { lex[cat] = { count: c, per_10k: han ? Math.round(c / han * 10000 * 100) / 100 : null, hits }; lexHits += c }
  }

  // 感叹号 / 比喻标记
  const excl = (t.match(/！/g) || []).length
  const simileStrict = LEX.simile_markers.strict.reduce((a, w) => a + (t.split(w).length - 1), 0)
  const simileLoose = t.split(LEX.simile_markers.loose_像).length - 1

  // 对话段占比（对话标点开头的段 + 含成对话号的段）
  const dlgParas = paras.filter((l) => /^[「『"'“]/.test(l) || /[「『][^」』]{1,}[」』]/.test(l)).length

  // 章首段（模板开场只看每章第一段；正则自带 ^ 锚，直接测）
  const firstPara = paras[0] || ''
  const openingHit = TPL_RES.some(({ re }) => { re.lastIndex = 0; return re.test(firstPara) })

  return {
    title: u.title, han_chars: han,
    paragraphs: {
      n: paras.length,
      median: quantile(paraLens, 0.5), p90: quantile(paraLens, 0.9), max: paraLens[paraLens.length - 1] || 0,
      share_le_2line: paras.length ? Math.round(paraLens.filter((l) => l <= twoLine).length / paras.length * 1000) / 1000 : null,
      share_gt_150: paras.length ? Math.round(paraLens.filter((l) => l > 150).length / paras.length * 1000) / 1000 : null,
    },
    sentences: { n: sentLens.length, median: quantile(sentLens, 0.5), p90: quantile(sentLens, 0.9), share_gt_40: sentLens.length ? Math.round(sentLens.filter((l) => l > 40).length / sentLens.length * 1000) / 1000 : null },
    dialogue_para_share: paras.length ? Math.round(dlgParas / paras.length * 1000) / 1000 : null,
    exclam: { count: excl, per_kchar: han ? Math.round(excl / han * 1000 * 100) / 100 : null },
    simile: { strict: simileStrict, strict_per_10k: han ? Math.round(simileStrict / han * 10000 * 100) / 100 : null, loose_像: simileLoose },
    formula: {
      score_distinct_categories: formulaScore,
      threshold: FD.thresholds.formula_score_distinct_categories,
      flag: formulaScore >= FD.thresholds.formula_score_distinct_categories,
      template_openings: tpl, generic_transitions: trans, emphasis_abuse: emph, triple_parallel: tp,
      chapter_opening_template_hit: openingHit,
    },
    negative_lexicon: { total_hits: lexHits, per_10k: han ? Math.round(lexHits / han * 10000 * 100) / 100 : null, by_cat: lex },
  }
}

const unitReports = units.map(checkUnit)
const n = unitReports.length || 1
const avg = (f) => Math.round(unitReports.reduce((a, u) => a + (f(u) || 0), 0) / n * 1000) / 1000
const agg = {
  label: opt('--label', path.basename(file)), file, enc_used: encUsed,
  units: units.length, chapters_detected: chapters.length, sampled: units.length !== chapters.length,
  avg: {
    han_chars: Math.round(unitReports.reduce((a, u) => a + u.han_chars, 0) / n),
    para_median: avg((u) => u.paragraphs.median), para_p90: avg((u) => u.paragraphs.p90),
    para_share_le_2line: avg((u) => u.paragraphs.share_le_2line), para_share_gt_150: avg((u) => u.paragraphs.share_gt_150),
    sent_share_gt_40: avg((u) => u.sentences.share_gt_40),
    dialogue_para_share: avg((u) => u.dialogue_para_share),
    excl_per_kchar: avg((u) => u.exclam.per_kchar),
    simile_strict_per_chapter: avg((u) => u.simile.strict), simile_loose_per_chapter: avg((u) => u.simile.loose_像),
    formula_flag_rate: avg((u) => (u.formula.flag ? 1 : 0)),
    chapter_opening_template_hit_rate: avg((u) => (u.formula.chapter_opening_template_hit ? 1 : 0)),
    neglex_per_10k: avg((u) => u.negative_lexicon.per_10k),
  },
}

const out = opt('--json')
if (out) await writeFile(out, JSON.stringify({ aggregate: agg, units: unitReports }, null, 2), 'utf8')

const A = agg.avg
console.log(`[style-check] ${agg.label}（enc=${encUsed}, 章=${chapters.length}, 抽=${units.length}）`)
console.log(`  段落: 中位 ${A.para_median} 字 / p90 ${A.para_p90} / ≤两行 ${(A.para_share_le_2line * 100).toFixed(1)}% / >150字 ${(A.para_share_gt_150 * 100).toFixed(1)}%`)
console.log(`  句长>40字占比 ${(A.sent_share_gt_40 * 100).toFixed(1)}% ｜ 对话段占比 ${(A.dialogue_para_share * 100).toFixed(1)}%`)
console.log(`  感叹号 ${A.excl_per_kchar}/千字 ｜ 比喻(strict) ${A.simile_strict_per_chapter}/章 ｜ 负向词 ${A.neglex_per_10k}/万字`)
console.log(`  公式化旗标率 ${(A.formula_flag_rate * 100).toFixed(1)}% ｜ 章首模板开场命中率 ${(A.chapter_opening_template_hit_rate * 100).toFixed(1)}%`)
