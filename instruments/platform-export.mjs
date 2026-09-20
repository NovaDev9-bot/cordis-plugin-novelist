/**
 * platform-export.mjs —— B9 平台格式化导出（零 LLM、零外部依赖；2026-09-17）
 * 用法：node instruments/platform-export.mjs --book <书目录> --platform=tomato|qidian
 *         [--out <输出文件>] [--header] [--dry-run] [--json <报告文件>]
 *
 * 干什么：把 book_dir/manuscript/chapter_XXX.md 按章序合成一份单文件 txt（喂平台后台的导入/粘贴口）。
 * 只做**确定性格式化**，绝不做内容改写：
 *   ① 章标题行规范化 →「第N章 标题」。章号以文件名 chapter_XXX.md 为准（仓库口径）；标题优先取正文首行
 *      已有的章节标题行，其次取 outline.json 该章 entry.title（两者都没有则只出「第N章」）。标题字段自带
 *      「第N章」前缀时先剥前缀，防「第3章 第三章」。
 *   ② 段落间空行规范：一个非空行 = 一段（本仓正文约定不硬折行），段间统一 1 个空行，连续空行并成 1 个；
 *      段首缩进（如全角空格）原样保留，不动。
 *   ③ 去行尾空白（含全角空格 U+3000）；④ CRLF/CR → LF；⑤ --header 时文件头加书籍信息块（书名取自 project.json）。
 * 不做什么：敏感词替换、错别字/标点修正、任何正文增删改。**本工具不内置敏感词检测**——仓内没有权威词表，
 *   自造清单等于把"没查"伪装成"查过了"；要查敏感词请用 style-check.mjs --lexicon 自带词表（只报不改）。
 *
 * 平台差异（**未核实，可调**）：本仓没有平台官方导出规范的实据，下表是坊间软惯例、不是规则，照做不保证过审：
 *   - 章标题编号写法：番茄=阿拉伯数字（第1章）｜起点=中文数字（第一章）——常见说法，**未核实**；
 *   - 段间空行：两平台统一 1 个空行（本工具口径；平台后台是否要求段间无空行 **未核实**）；
 *   - 换行/编码：两平台统一 LF + UTF-8（**未核实**：有说法称部分平台 txt 导入偏好 GBK/CRLF；本工具不据"听说"
 *     切编码——"编码不符"是明确的失败信号，静默产出乱码更难查）。
 *   要改平台行为：改下方 PLATFORMS 表一行即可；不确定就保持现状（保持现状 = 不编造）。
 *
 * 统计口径（与账本一致）：总汉字数 = 逐章 manuscript 全文 /[\u4e00-\u9fff]/g 求和，与 lib 的 countHan 同正则、
 *   与 novel_count/novel_verify 的书级 total 同算法（**不含**导出时新加的章标题行与书籍信息块）。
 *
 * 退出码：0 成功（含 --dry-run）；1 书目录/正文不可用；2 参数错误（含未知 platform）。
 */
import { readFileSync, writeFileSync, mkdirSync, existsSync, statSync, readdirSync } from 'node:fs'
import path from 'node:path'

// 用法串里的目录名**按自身位置现算**：同一份脚本在 DSH 形态住在 instruments/、专家包住在 scripts/，
// 写死任何一个都会在另一种形态里指向不存在的路径（2026-09-20 复核 ISS-01 的同族）
const USAGE = '用法：node ' + path.basename(import.meta.dirname) + '/platform-export.mjs --book <书目录> --platform=tomato|qidian [--out <文件>] [--header] [--dry-run] [--json <报告>]'
const argv = process.argv.slice(2)

/** 收 --k=v 与 --k v 两种写法；缺值或后跟另一个 flag 时返回空串（视为缺参）。 */
function argVal(name) {
  const eq = argv.find((a) => a.startsWith(name + '='))
  if (eq !== undefined) return eq.slice(name.length + 1)
  const i = argv.indexOf(name)
  if (i < 0) return undefined
  const v = argv[i + 1]
  return v === undefined || v.startsWith('--') ? '' : v
}
function die(msg, code = 2) { console.error('[platform-export] ' + msg); process.exit(code) }

// 平台差异表（**未核实，可调**：见文件头"平台差异"——改这里一行，不要照抄别处规则）
const PLATFORMS = {
  tomato: { label: '番茄', numeral: 'arabic' }, // 第1章 标题
  qidian: { label: '起点', numeral: 'chinese' }, // 第一章 标题
}
const ALIASES = { tomato: 'tomato', fanqie: 'tomato', 番茄: 'tomato', qidian: 'qidian', 起点: 'qidian' }

// ---------- 参数 ----------
const bookOpt = argVal('--book')
if (!bookOpt) die('缺少 --book <书目录>。\n' + USAGE)
const bookDir = path.resolve(bookOpt)
if (!existsSync(bookDir) || !statSync(bookDir).isDirectory()) die('书目录不存在或不是目录：' + bookDir, 1)

const platformRaw = argVal('--platform')
if (!platformRaw) die('缺少 --platform（必填，不给默认值——平台决定标题编号写法，静默替你选一个就是编规则）。\n' + USAGE)
const platform = ALIASES[platformRaw] || ALIASES[String(platformRaw).toLowerCase()]
if (!platform) die(`未知 platform：${platformRaw}（支持 tomato｜qidian，或中文别名 番茄｜起点）`, 2)
const P = PLATFORMS[platform]

const dryRun = argv.includes('--dry-run')
const wantHeader = argv.includes('--header')
const outOpt = argVal('--out')
if (outOpt === '') die('--out 给了但没给路径。\n' + USAGE)
const jsonOpt = argVal('--json')
if (jsonOpt === '') die('--json 给了但没给路径。\n' + USAGE)

const loadJson = (p, d) => { try { return JSON.parse(readFileSync(p, 'utf8')) } catch { return d } }
const countHan = (t) => (String(t).match(/[\u4e00-\u9fff]/g) || []).length // 与 lib/novelist.js countHan 同正则

const project = loadJson(path.join(bookDir, 'project.json'), {})
const bookTitle = typeof project.title === 'string' && project.title.trim() ? project.title.trim() : null

// ---------- 章清单（章号以文件名 chapter_XXX.md 为准，按数值章序排） ----------
const msDir = path.join(bookDir, 'manuscript')
if (!existsSync(msDir)) die('尚无正文：缺目录 ' + msDir, 1)
const files = []
for (const name of readdirSync(msDir)) {
  const m = /^chapter_(\d+)\.md$/.exec(name)
  if (m) files.push({ name, ch: Number(m[1]) })
  else if (/^chapter_.*\.md$/.test(name)) console.error('[platform-export] ⚠ 忽略文件名不合规范（应 chapter_XXX.md）：' + name)
}
if (!files.length) die('尚无正文：' + msDir + ' 下没有 chapter_XXX.md', 1)
files.sort((a, b) => a.ch - b.ch)
const dup = files.map((f) => f.ch).filter((v, i, arr) => arr.indexOf(v) !== i)
if (dup.length) die('章号重复（同一章号有多个文件）：' + [...new Set(dup)].join('、'), 1)

const outline = loadJson(path.join(bookDir, 'outline.json'), { volumes: [] })
const outlineTitle = new Map()
for (const vol of outline.volumes || []) for (const c of vol.chapters || []) {
  if (c && Number.isInteger(c.chapter_no)) outlineTitle.set(c.chapter_no, String(c.title || ''))
}

// ---------- 章标题 ----------
const ZH_DIGITS = '零一二三四五六七八九'
const ZH_UNITS = ['', '十', '百', '千']
/** 阿拉伯数字 → 中文数字（1..9999；超出常识章号回退阿拉伯数字，不编造中文写法）。 */
function zhNum(n) {
  if (!Number.isInteger(n) || n <= 0 || n > 9999) return String(n)
  const s = String(n)
  let out = ''
  for (let i = 0; i < s.length; i++) {
    const d = Number(s[i]); const pos = s.length - 1 - i
    if (d === 0) { if (!out.endsWith('零') && i < s.length - 1) out += '零'; continue }
    out += ZH_DIGITS[d] + ZH_UNITS[pos]
  }
  return out.replace(/零+$/, '').replace(/^一十/, '十')
}
const numText = (ch) => (P.numeral === 'chinese' ? zhNum(ch) : String(ch))

const ZH_HEAD = /^第\s*([0-9０-９零一二三四五六七八九十百千万两]+)\s*([章回节卷])\s*([\s\S]*)$/
const EN_HEAD = /^(?:chapter|part)\s+([0-9]+)\s*[:：.、,，]?\s*([\s\S]*)$/i
const TITLE_PREFIX = /^第\s*[0-9０-９零一二三四五六七八九十百千万两]+\s*[章回节卷]\s*[:：.、]?\s*/

/**
 * 单章规范化。返回 { heading, body, paras, han, warnings }。
 * han 数的是**原始正文全文**（含文件里已有的标题行）——与 novel_count/novel_verify 的逐章口径一致。
 */
function normalizeChapter(raw, ch, msTitle) {
  const warnings = []
  const lines = String(raw).replace(/^\uFEFF/, '').replace(/\r\n?/g, '\n')
    .split('\n').map((l) => l.replace(/[ \t\u3000]+$/, '')) // ③ 去行尾空白
  // ① 首行是不是章节标题行
  let head = null
  const firstNonEmpty = lines.findIndex((l) => l.trim() !== '')
  if (firstNonEmpty >= 0) {
    const l = lines[firstNonEmpty].trim()
    const zh = ZH_HEAD.exec(l)
    const en = zh ? null : EN_HEAD.exec(l)
    if (zh) head = { at: firstNonEmpty, numRaw: zh[1], unit: zh[2], title: zh[3].trim() }
    else if (en) head = { at: firstNonEmpty, numRaw: en[1], unit: '章', title: en[2].trim() }
  }
  // 章号以文件名为准；正文里的编号只对纯阿拉伯写法做一致性提示（中文数字不做数值比对，避免误报）
  if (head && /^[0-9]+$/.test(head.numRaw) && Number(head.numRaw) !== ch) {
    warnings.push(`第${ch}章：正文标题行写的是「第${head.numRaw}${head.unit}」与文件名 chapter_${String(ch).padStart(3, '0')}.md 章号不一致——已按文件名编号导出`)
  }
  let title = head && head.title ? head.title : String(msTitle || '')
  title = title.replace(TITLE_PREFIX, '').trim()
  const heading = '第' + numText(ch) + '章' + (title ? ' ' + title : '')
  // ② 段落：标题行之后（没有标题行则全文）的非空行 = 段；段间 1 空行
  const start = head ? head.at + 1 : 0
  const paras = []
  for (let i = start; i < lines.length; i++) if (lines[i].trim() !== '') paras.push(lines[i])
  return { heading, body: paras.join('\n\n'), paras: paras.length, han: countHan(raw), warnings }
}

// ---------- 逐章处理 ----------
const chapters = []
const warnings = []
let han = 0
for (const f of files) {
  const c = normalizeChapter(readFileSync(path.join(msDir, f.name), 'utf8'), f.ch, outlineTitle.get(f.ch))
  han += c.han
  warnings.push(...c.warnings)
  chapters.push({ ch: f.ch, file: f.name, heading: c.heading, body: c.body, paras: c.paras, han: c.han })
}

// ---------- 组装 ----------
const headerLine = wantHeader && bookTitle ? '《' + bookTitle + '》' : null
if (wantHeader && !bookTitle) console.error('[platform-export] ⚠ --header 已给但 project.json 无 title——不生成书籍信息块')
const blocks = chapters.map((c) => c.heading + (c.body ? '\n\n' + c.body : ''))
const outText = (headerLine ? headerLine + '\n\n' : '') + blocks.join('\n\n') + '\n'
const bytes = Buffer.byteLength(outText, 'utf8')

const safeName = (bookTitle || path.basename(bookDir)).replace(/[\\/:*?"<>|\u0000-\u001f]/g, '_').trim() || 'book'
const outPath = outOpt ? path.resolve(outOpt) : path.join(bookDir, 'export', safeName + '.' + platform + '.txt')

// ---------- 报告与落盘 ----------
console.log(`[platform-export] ${P.label}（${platform}）· 章 ${chapters.length} · 正文汉字 ${han} · ${dryRun ? '预计' : ''}输出 ${bytes} 字节`)
console.log(`  ${dryRun ? '目标（未写）' : '输出'}：${outPath}`)
for (const c of chapters) console.log(`  ${c.file} → 「${c.heading}」 ${c.paras} 段 / ${c.han} 汉字`)
for (const w of warnings) console.error('[platform-export] ⚠ ' + w)

if (dryRun) {
  console.log('[platform-export] dry-run：未写任何文件（去掉 --dry-run 才落盘）')
} else {
  mkdirSync(path.dirname(outPath), { recursive: true })
  writeFileSync(outPath, outText, 'utf8')
  console.log('[platform-export] 已落盘：' + outPath)
}

// --json = 显式请求的机器可读报告（审计件）：--dry-run 只保证不写导出 txt，不拦这份显式报告
if (jsonOpt) {
  const jp = path.resolve(jsonOpt)
  const report = {
    tool: 'platform-export.mjs', ts: new Date().toISOString(),
    platform, platform_label: P.label, numeral: P.numeral,
    out: outPath, dry_run: dryRun, header: !!headerLine,
    chapters: chapters.length, han, bytes,
    chapters_detail: chapters.map((c) => ({ ch: c.ch, file: c.file, heading: c.heading, paras: c.paras, han: c.han })),
    warnings,
  }
  mkdirSync(path.dirname(jp), { recursive: true })
  writeFileSync(jp, JSON.stringify(report, null, 2), 'utf8')
  console.log('[platform-export] 报告：' + jp)
}
