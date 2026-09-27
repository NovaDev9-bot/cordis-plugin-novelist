/**
 * marginal-cost-check.mjs —— 修订边际成本累积律闸（总纲 §3 B1 [P0]，2026-09-26）
 *
 * 背景：ch2 rev5→rev6 实测「修 6 引 10」后停手——这是本轮最值钱的发现，但
 * 「新引入 vs 修掉」靠主编手数。本脚本把它机器化：修掉 N／新引入 M／新引入条目清单，
 * M ≥ N 亮红（EXIT 1）并打印停改建议——**新引入 ≥ 修掉 ⇒ 立即停止修订**
 * （chapter-cycle SKILL §1.2「修正边际成本累积律」的机器闸）。
 *
 * 用法：node marginal-cost-check.mjs <修订前正文> <修订后正文> <修订前仪器缺陷清单.json> <修订后仪器缺陷清单.json>
 *
 * 输入清单 JSON（仪器回执是自由文本，主编转录成此结构；顶层数组，或
 * { "defects": [...] } / { "items": [...] }）。每条缺陷至少两字段（别名任一）：
 *   类别   ＝ category | 类别 | type | 病类 | kind
 *   锚点句 ＝ anchor | 锚点 | 锚点句 | quote | 原句 | 引文
 * 可选 note/备注/说明、severity/级别/把握——只随报告回显，不参与判定。
 *
 * ── 判重口径（写死，不改）──────────────────────────────────────────────
 * 1. 缺陷条目按「类别＋锚点句」判等：两字段各自**去除全部空白**（含全角空格 U+3000
 *    与换行——仪器回执常有折行/空格噪声）后**逐字相等**才算同一条；标点与全半角
 *    原样参与，不做模糊／前缀／包含匹配。类别或锚点句去空白后为空 ⇒ EXIT 2。
 * 2. 交集＝持续未修（既不算修掉也不算新引入）；前有后无＝修掉；前无后有＝新引入。
 *    同一清单内判等键重复 ⇒ 去重计数并出告警，不重复计账。
 * 3. 正文两版只做「锚点存在性复核」，**提示不计数**：修掉候选若锚点句仍逐字出现在
 *    修订后正文 ⇒ 提示"疑似未真修或二轮漏报"；新引入候选若锚点句在修订前正文已存在
 *    ⇒ 提示"疑似一轮漏报，非本轮新引入"。是否真修是语义判定，归主编——代码只做账
 *    （分工纪律：判定归模型、代码做壳；N/M 永远只由两轮清单的判等差决定）。
 * 4. **无特例**：M ≥ N 一律判停——包括 0/0（两轮清单判等后完全重合＝修订零净效果、
 *    硬伤数未下降，同样适用停改；两轮均空则另出告警"请核对清单转录"，防错拿
 *    空清单静默装绿——本仓最忌讳的失败模式）。
 *
 * ── 退出码 ─────────────────────────────────────────────────────────────
 *   0 ＝ M < N（边际成本收敛，可继续）　1 ＝ M ≥ N（亮红：立即停止定向修）
 *   2 ＝ 没检查成（参数缺失/文件不存在/JSON 不合法/条目缺字段——沿用
 *        structure-check 的纪律："没检查成"不许报成 0 条 0 判词）
 */
import { readFile } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import path from 'node:path'

const USAGE = '用法：node marginal-cost-check.mjs <修订前正文> <修订后正文> <修订前仪器缺陷清单.json> <修订后仪器缺陷清单.json>'
const die = (msg) => { console.error('[marginal-cost-check] 没检查成：' + msg); console.error(USAGE); process.exit(2) }

const argv = process.argv.slice(2)
if (argv.length !== 4) die(argv.length ? '需要 4 个位置参数（得 ' + argv.length + ' 个）' : '缺 4 个位置参数：两版正文＋两轮缺陷清单')
const [beforeTextPath, afterTextPath, beforeListPath, afterListPath] = argv.map((p) => path.resolve(p))
for (const p of [beforeTextPath, afterTextPath, beforeListPath, afterListPath]) {
  if (!existsSync(p)) die('文件不存在 ' + p)
}

// 判重口径①：去全部空白（含全角空格/换行）后逐字比对
const squash = (s) => String(s).replace(/[\s\u3000]+/g, '')
const FIELD_ALIASES = {
  category: ['category', '类别', 'type', '病类', 'kind'],
  anchor: ['anchor', '锚点', '锚点句', 'quote', '原句', '引文'],
  note: ['note', '备注', '说明'],
  severity: ['severity', '级别', '把握'],
}

async function parseList(p) {
  let j
  try { j = JSON.parse(await readFile(p, 'utf8')) } catch (e) { die(path.basename(p) + ' 不是合法 JSON（' + e.message + '）') }
  const arr = Array.isArray(j) ? j : Array.isArray(j?.defects) ? j.defects : Array.isArray(j?.items) ? j.items : null
  if (!arr) die(path.basename(p) + ' 顶层须为数组，或含 defects/items 数组的对象')
  const label = path.basename(p)
  return arr.map((it, i) => {
    if (!it || typeof it !== 'object' || Array.isArray(it)) die(label + ' 第 ' + (i + 1) + ' 条不是对象')
    const grab = (k) => { for (const a of FIELD_ALIASES[k]) if (it[a] != null && it[a] !== '') return it[a]; return null }
    const category = grab('category'), anchor = grab('anchor')
    if (category == null || anchor == null) die(label + ' 第 ' + (i + 1) + ' 条缺「类别(category/类别/type/病类)」或「锚点句(anchor/锚点/锚点句/quote/原句/引文)」——判等键二者缺一不可')
    if (!squash(category) || !squash(anchor)) die(label + ' 第 ' + (i + 1) + ' 条的类别/锚点句去空白后为空，无法判等')
    return { category: String(category), anchor: String(anchor), note: grab('note') == null ? '' : String(grab('note')), severity: grab('severity') == null ? '' : String(grab('severity')) }
  })
}

const [beforeText, afterText] = await Promise.all([readFile(beforeTextPath, 'utf8'), readFile(afterTextPath, 'utf8')])
const beforeRaw = await parseList(beforeListPath)
const afterRaw = await parseList(afterListPath)

const keyOf = (d) => squash(d.category) + '\u241F' + squash(d.anchor) // 判重口径①：类别＋锚点句
function dedupe(list) {
  const map = new Map()
  const dupKeys = []
  for (const d of list) {
    const k = keyOf(d)
    if (map.has(k)) dupKeys.push(k)
    else map.set(k, d)
  }
  return { map, dupKeys }
}
const before = dedupe(beforeRaw)
const after = dedupe(afterRaw)

const fixedItems = [], introducedItems = [], persistedItems = []
for (const [k, d] of before.map) {
  if (after.map.has(k)) persistedItems.push(d)
  else fixedItems.push(d)
}
for (const [k, d] of after.map) {
  if (!before.map.has(k)) introducedItems.push(d)
}

const N = fixedItems.length, M = introducedItems.length
// 判据（写死）：新引入 ≥ 修掉 ⇒ 停。无 0/0 特例（见头注口径④）。
const verdict = M >= N ? 'STOP' : 'OK'
const exitCode = verdict === 'STOP' ? 1 : 0

// 口径③：正文只做锚点存在性复核——提示不计数，语义判定归主编
const show = (s) => { const t = squash(s); return t.length > 30 ? t.slice(0, 30) + '…' : t }
const advisories = []
for (const d of fixedItems) {
  if (squash(afterText).includes(squash(d.anchor))) advisories.push(`修掉项「[${d.category}] ${show(d.anchor)}」的锚点句仍逐字出现在修订后正文——疑似未真修或二轮仪器漏报，请人工复核`)
}
for (const d of introducedItems) {
  if (squash(beforeText).includes(squash(d.anchor))) advisories.push(`新引入项「[${d.category}] ${show(d.anchor)}」的锚点句在修订前正文已存在——疑似一轮仪器漏报，非本轮新引入`)
}
const warnings = []
for (const [name, dd] of [['修订前清单', before], ['修订后清单', after]]) {
  if (dd.dupKeys.length) warnings.push(`${name}内 ${dd.dupKeys.length} 条判等键重复（类别＋锚点句），已按判重口径去重计数`)
}
if (before.map.size === 0 && after.map.size === 0) warnings.push('两轮清单去重后均 0 条——请核对清单转录是否拿错/漏转；按判据 M≥N 本轮仍判停')

const red = (s) => (process.stdout.isTTY ? '\x1b[31m' + s + '\x1b[0m' : s)
const green = (s) => (process.stdout.isTTY ? '\x1b[32m' + s + '\x1b[0m' : s)
const fmt = (d) => `  ${d.category}｜${show(d.anchor)}${d.severity ? '｜' + d.severity : ''}${d.note ? '｜' + d.note : ''}`

console.log(`[marginal-cost-check] ${path.basename(beforeTextPath)} → ${path.basename(afterTextPath)}｜修订前清单 ${before.map.size} 条 → 修订后 ${after.map.size} 条（判等键＝类别＋锚点句，去重后）`)
console.log(`  修掉 N = ${N}`)
console.log(`  新引入 M = ${M}`)
console.log(`  持续未修 = ${persistedItems.length}`)
if (verdict === 'STOP') {
  console.log(red(`⛔ 亮红：新引入(${M}) ≥ 修掉(${N}) —— 修订边际成本在累积，立即停止本轮定向修！`))
  console.log('   停改建议（二选一，chapter-cycle SKILL §1.2）：① 另派主笔重写本章（换上下文，不许在旧稿上继续打补丁）；② 如实收束，把本轮缺陷逐条入台账。')
} else {
  console.log(green(`✅ 新引入(${M}) < 修掉(${N}) —— 边际成本收敛，可继续（仍须按 §1.2 做 diff 复核与机器复量）。`))
}
if (M > 0) {
  console.log(`新引入条目清单（${M} 条）：`)
  for (const d of introducedItems) console.log('  ' + fmt(d))
}
if (advisories.length) {
  console.log('提示（不参与计数，语义判定归主编）：')
  for (const a of advisories) console.log('  ⚠ ' + a)
}
if (warnings.length) {
  console.log('告警：')
  for (const w of warnings) console.log('  ⚠ ' + w)
}
const strip = (d) => ({ category: d.category, anchor: d.anchor, note: d.note, severity: d.severity })
// 机器读数行（最后一行 stdout，供管线/测试解析）
console.log(JSON.stringify({
  generated_at: new Date().toISOString(),
  before_text: beforeTextPath, after_text: afterTextPath, before_list: beforeListPath, after_list: afterListPath,
  before_total: beforeRaw.length, after_total: afterRaw.length,
  before_distinct: before.map.size, after_distinct: after.map.size,
  fixed: N, introduced: M, persisted: persistedItems.length,
  verdict, stop_rule: verdict === 'STOP' ? 'M>=N' : null,
  fixed_items: fixedItems.map(strip),
  introduced_items: introducedItems.map(strip),
  persisted_items: persistedItems.map(strip),
  advisories, warnings,
}))
process.exitCode = exitCode
