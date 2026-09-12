/**
 * corpus-falsify.mjs —— A4 语料证伪 runner（工程方向v3 §4.1 A4 · 零 LLM，2026-09-11）
 * 用法：node corpus-falsify.mjs --corpus <语料根目录> --index <corpus-index.csv>
 *         [--books 60] [--chapters 30] [--out <dir>]
 *
 * 干什么：把 style-check（A3 机检层）跑到起点语料库的确定性分层样本上，对灵蟹插件市场/
 * MASTER/formula-detector 那批规范断言逐条给出 成立/不成立/未定 的可复算裁决。
 * 抽样纪律：每作者至多 1 本（取字节数最大=最完整），mulberry32(20260911) 洗牌后取前 N 本——
 * 可复现；锚书 5 本强制全含（它们已被本项目拆解）。
 * 平台口径（I5）：本语料 100% 起点系——裁决对"起点长线好书"成立与否；**不能**直接外推到番茄
 * 短平快，报告里显式标注跨层。
 */
import { readFile, writeFile, mkdir, unlink } from 'node:fs/promises'
import { spawnSync } from 'node:child_process'
import path from 'node:path'

const args = process.argv.slice(2)
const opt = (k, d) => { const i = args.indexOf(k); return i >= 0 ? args[i + 1] : d }
const corpusRoot = opt('--corpus')
const indexPath = opt('--index')
const N_BOOKS = Number(opt('--books', 60)) || 60
const N_CH = Number(opt('--chapters', 30)) || 30
const outDir = path.resolve(opt('--out', '.'))

function mulberry32(a) {
  return function () {
    a |= 0; a = (a + 0x6d2b79f5) | 0
    let t = Math.imul(a ^ (a >>> 15), 1 | a)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

// ---------- 读索引：author -> 最大的一本 ----------
const csv = await readFile(indexPath, 'utf8')
const lines = csv.split('\n').filter(Boolean)
const ANCHORS = ['惊悚乐园', '盗墓笔记', '河神', '超品相师', '狩魂者']
const byAuthor = new Map()
for (const line of lines.slice(1)) {
  const m = line.match(/^"([^"]*)","([^"]*)","(\d+)","(\w+)"/)
  if (!m) continue
  const [, author, book, bytes, enc] = m
  const prev = byAuthor.get(author)
  if (!prev || Number(bytes) > prev.bytes) byAuthor.set(author, { author, book, bytes: Number(bytes), enc })
}
// 锚书作者强制入选（他们的最大一本即锚书本体或同量级作品）
const anchorEntries = []
for (const a of ['三天两觉', '南派三叔', '天下霸唱', '九灯和善']) {
  const e = byAuthor.get(a)
  if (e) { anchorEntries.push(e); byAuthor.delete(a) }
}
const rest = [...byAuthor.values()].sort((a, b) => a.author < b.author ? -1 : 1)
const rnd = mulberry32(20260911)
for (let i = rest.length - 1; i > 0; i--) { const j = Math.floor(rnd() * (i + 1)); [rest[i], rest[j]] = [rest[j], rest[i]] }
const picked = [...anchorEntries, ...rest.slice(0, Math.max(0, N_BOOKS - anchorEntries.length))]
console.log(`[corpus-falsify] 抽样 ${picked.length} 本（锚书作者 ${anchorEntries.length} 强制 + 随机 ${picked.length - anchorEntries.length}，seed=20260911，每本抽 ${N_CH} 章）`)

// ---------- 逐本跑 style-check ----------
const results = []
const SCRIPT = path.join(import.meta.dirname, 'style-check.mjs')
for (let i = 0; i < picked.length; i++) {
  const e = picked[i]
  const file = path.join(corpusRoot, e.author, `${e.book}.txt`)
  const jsonOut = path.join(outDir, `_tmp-a4-${i}.json`)
  const r = spawnSync(process.execPath, [SCRIPT, file, '--sample', String(N_CH), '--json', jsonOut, '--label', e.book], { stdio: 'pipe', encoding: 'utf8' })
  if (r.status !== 0) { console.log(`  ✗ [${i + 1}/${picked.length}] ${e.book}：${(r.stderr || '').split('\n')[0]}`); continue }
  const rep = JSON.parse(await readFile(jsonOut, 'utf8'))
  results.push({ author: e.author, book: e.book, bytes: e.bytes, enc: rep.aggregate.enc_used, chapters_detected: rep.aggregate.chapters_detected, agg: rep.aggregate.avg })
  await unlink(jsonOut).catch(() => {})
  console.log(`  ✓ [${i + 1}/${picked.length}] ${e.book}（${rep.aggregate.enc_used}, ${rep.aggregate.chapters_detected} 章）`)
}

// ---------- 规则裁决 ----------
const med = (xs) => { const s = xs.filter((x) => x != null).sort((a, b) => a - b); return s.length ? s[Math.floor(s.length / 2)] : null }
const share = (xs, f) => { const v = xs.filter((x) => x != null); return v.length ? Math.round(v.filter(f).length / v.length * 1000) / 10 : null }
const R = {
  books: results.length,
  r1_para_gt150_share: { median: med(results.map((r) => r.agg.para_share_gt_150)), books_with_any_violation_pct: share(results.map((r) => r.agg.para_share_gt_150), (x) => x > 0), books_over_5pct: share(results.map((r) => r.agg.para_share_gt_150), (x) => x > 0.05) },
  r2_para_2line_share: { median: med(results.map((r) => r.agg.para_share_le_2line)), books_meeting_70pct: share(results.map((r) => r.agg.para_share_le_2line), (x) => x >= 0.7), books_meeting_60pct: share(results.map((r) => r.agg.para_share_le_2line), (x) => x >= 0.6) },
  r3_simile_strict_per_ch: { median: med(results.map((r) => r.agg.simile_strict_per_chapter)), books_over_3: share(results.map((r) => r.agg.simile_strict_per_chapter), (x) => x > 3), loose_像_median: med(results.map((r) => r.agg.simile_loose_per_chapter)) },
  r4_dialogue_para_share: { median: med(results.map((r) => r.agg.dialogue_para_share)), note: '对话独立成行为排版规范，此处仅报对话段占比分布，格式断言需逐段核排版——裁为部分可测' },
  r5_excl_per_kchar: { median: med(results.map((r) => r.agg.excl_per_kchar)), books_over_3: share(results.map((r) => r.agg.excl_per_kchar), (x) => x > 3) },
  r6_opening_template_rate: { median: med(results.map((r) => r.agg.chapter_opening_template_hit_rate)), books_with_any_hit: share(results.map((r) => r.agg.chapter_opening_template_hit_rate), (x) => x > 0), formula_flag_rate_median: med(results.map((r) => r.agg.formula_flag_rate)) },
  r7_neglex_per_10k: { median: med(results.map((r) => r.agg.neglex_per_10k)), books_over_1: share(results.map((r) => r.agg.neglex_per_10k), (x) => x > 1), books_over_2: share(results.map((r) => r.agg.neglex_per_10k), (x) => x > 2) },
}

const verdicts = [
  { id: 'R1', claim: '每段不超过 150 字（手机阅读）', verdict: R.r1_para_gt150_share.books_with_any_violation_pct > 80 ? `不成立（绝对形式）：${R.r1_para_gt150_share.books_with_any_violation_pct}% 的书存在超 150 字段（中位超标占比 ${(R.r1_para_gt150_share.median * 100).toFixed(1)}%）——好书普遍违反绝对形式；95 分位形式（≤5% 段超标）由 ${(100 - R.r1_para_gt150_share.books_over_5pct).toFixed(0)}% 的书满足` : '部分成立（见分布）' },
  { id: 'R2', claim: '≥70% 段落两行以内（22字/行折算）', verdict: R.r2_para_2line_share.books_meeting_70pct >= 70 ? `成立：${R.r2_para_2line_share.books_meeting_70pct}% 的书达 70%（中位 ${R.r2_para_2line_share.median != null ? (R.r2_para_2line_share.median * 100).toFixed(1) : '?'}%）` : R.r2_para_2line_share.books_meeting_70pct >= 30 ? `非普遍事实（风格变量）：仅 ${R.r2_para_2line_share.books_meeting_70pct}% 的书达 70%，中位 ${R.r2_para_2line_share.median != null ? (R.r2_para_2line_share.median * 100).toFixed(1) : '?'}%——短段倾向存在，但 70% 阈值是那位作者的口味不是好书的共性` : `不成立（阈值形式）：仅 ${R.r2_para_2line_share.books_meeting_70pct}% 的书达 70%；中位 ${R.r2_para_2line_share.median != null ? (R.r2_para_2line_share.median * 100).toFixed(1) : '?'}%` },
  { id: 'R3', claim: '每章比喻 ≤3（strict 标记词代理）', verdict: R.r3_simile_strict_per_ch.books_over_3 <= 20 ? `代理成立：中位 ${R.r3_simile_strict_per_ch.median}/章，仅 ${R.r3_simile_strict_per_ch.books_over_3}% 的书超 3；宽松口径（含"像"）中位 ${R.r3_simile_strict_per_ch.loose_像_median}/章` : `代理不成立：${R.r3_simile_strict_per_ch.books_over_3}% 的书超 3/章` },
  { id: 'R4', claim: '对话需换行（独立成段）', verdict: `未定（部分可测）：对话段占比中位 ${R.r4_dialogue_para_share.median != null ? (R.r4_dialogue_para_share.median * 100).toFixed(1) : '?'}%——排版断言需逐段核格式，本轮只报分布` },
  { id: 'R5', claim: '感叹号密度 ≤3/千字', verdict: R.r5_excl_per_kchar.books_over_3 <= 20 ? `成立：中位 ${R.r5_excl_per_kchar.median}/千字，仅 ${R.r5_excl_per_kchar.books_over_3}% 的书超 3` : `不成立：${R.r5_excl_per_kchar.books_over_3}% 的书超 3/千字` },
  { id: 'R6', claim: '模板开场套话在好书正章中罕见', verdict: R.r6_opening_template_rate.books_with_any_hit <= 30 ? `成立：章首模板开场命中中位 ${(R.r6_opening_template_rate.median * 100).toFixed(1)}%，仅 ${R.r6_opening_template_rate.books_with_any_hit}% 的书出现；公式化旗标率中位 ${(R.r6_opening_template_rate.formula_flag_rate_median * 100).toFixed(1)}%` : `不成立：${R.r6_opening_template_rate.books_with_any_hit}% 的书出现模板开场` },
  { id: 'R7', claim: 'MASTER 负向词库禁词在真实头部作品中罕见', verdict: R.r7_neglex_per_10k.books_over_2 > 50 ? `不成立：禁词密度中位 ${R.r7_neglex_per_10k.median}/万字，${R.r7_neglex_per_10k.books_over_2}% 的书 >2/万字——"严禁使用"清单与头部作品事实大面积冲突，按 I4 应降级为"密度观测项"而非禁令` : `成立/待分层：中位 ${R.r7_neglex_per_10k.median}/万字` },
]

await mkdir(outDir, { recursive: true })
const stamp = '2026-09-11'
await writeFile(path.join(outDir, `A4-规范证伪-数据-${stamp}.json`), JSON.stringify({ sampled: picked, results, rules: R, verdicts, meta: { seed: 20260911, chapters_per_book: N_CH, corpus_root: corpusRoot, platform_caveat: 'I5：语料 100% 起点系，裁决不可直接外推番茄短平快' } }, null, 2), 'utf8')

const md = [`# A4 规范证伪报告（${stamp}）`, '',
  `> 产出：corpus-falsify.mjs（seed=20260911 可复算）对起点语料库分层抽样 ${N_BOOKS} 本 × 每本中段 ${N_CH} 章。`, '',
  '> **平台口径（I5）**：本语料 100% 起点系（2006-2014 长线为主）。下列裁决回答"规范与起点好书的**事实**是否一致"，**不能**直接外推番茄短平快稿。', '',
  '## 裁决总表', '', '| 规范 | 断言 | 裁决 |', '|---|---|---|']
for (const v of verdicts) md.push(`| ${v.id} | ${v.claim} | ${v.verdict} |`)
md.push('', '## 关键数字', '', '```json', JSON.stringify(R, null, 2), '```', '', '## 逐书明细', '', '| 书 | 编码 | 章数 | ≤两行% | >150字% | 感叹号/千字 | 比喻strict/章 | 负向词/万字 | 章首模板% |', '|---|---|---|---|---|---|---|---|---|')
for (const r of results) md.push(`| ${r.book} | ${r.enc} | ${r.chapters_detected} | ${(r.agg.para_share_le_2line * 100).toFixed(1)} | ${(r.agg.para_share_gt_150 * 100).toFixed(1)} | ${r.agg.excl_per_kchar} | ${r.agg.simile_strict_per_chapter} | ${r.agg.neglex_per_10k} | ${(r.agg.chapter_opening_template_hit_rate * 100).toFixed(1)} |`)
await writeFile(path.join(outDir, `A4-规范证伪报告-${stamp}.md`), md.join('\n'), 'utf8')
console.log(`\n[corpus-falsify] 完成：${results.length} 本 → ${path.join(outDir, `A4-规范证伪报告-${stamp}.md`)}`)
for (const v of verdicts) console.log(`  ${v.id}: ${v.verdict.slice(0, 90)}`)
