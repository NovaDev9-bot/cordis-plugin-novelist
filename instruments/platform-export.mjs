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
 * 平台规则（**每条带出处**；2026-09-22 重做。此前这里写的是一张"坊间软惯例"表，没有出处——
 *   等于把"听说"和"规范"混在一处，谁也没法判哪条能照抄。现在的规矩是两条二选一：
 *   ① 有官方/权威依据 → **照抄它的写法**，附 URL 与原文摘句；
 *   ② 没有公开规范 → **必须显式写"未证实"并说明查过什么**（缺失没有类型：不写＝读者以为是规范）。
 *   规则本体在下方 RULE_SPEC（一处真源），清单与报告都从它生成，不另手抄一份。）
 *   已核到官方原文的（番茄作家帮助中心 / 阅文帮助中心，均为公开页面）：
 *     - 单章字数：番茄 1000–50000 字（不足 1000 无法点「下一步」）｜起点 正文分卷首章 ≥1000 字（男频短篇 ≥300）
 *     - 分段：番茄明写"请使用换行键进行分段，**不要使用空格键**"
 *     - 段间空行：番茄明写"段落内的空格、段落之间多余空行**发布后自动消失**"⇒ 手工加空行无害但多余
 *     - 驳回原因（番茄）：全文繁体／外文／乱码／**未分段**／章节空白／内容重复／**章节乱序**
 *     - 作品信息：番茄书名限"中英文、阿拉伯数字、中文符叹号/逗号/问号/中括号/冒号"、简介 ≤500 字；
 *       起点简介 20–500 字、扉页寄语 ≤32 汉字
 *   **没有公开规范、只能实测的**（本工具一律不据"听说"行事，只列出来让你去传一次）：
 *     章节标题写法（起点官方检索"标题"＝0 条）／段落缩进与段间空行（起点检索"排版"＝0 条）／
 *     换行编码 LF 还是 CRLF／文件编码 UTF-8 还是 GBK／单文件导入是否支持／番茄"自动排版"实际产出什么。
 *   ⇒ 这些进 `--checklist` 生成的**上传前核对清单**（附实测方法），不写进导出规则。
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
const USAGE = '用法：node ' + path.basename(import.meta.dirname) + '/platform-export.mjs --book <书目录> --platform=tomato|qidian [--out <文件>] [--header] [--dry-run] [--json <报告>] [--checklist <文件>]'
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

/**
 * 规则表（**一处真源**：检查、清单、--json 报告全从它生成，不另手抄）。
 * 每条二选一：`source`（官方出处＋原文摘句）或 `unverified`（为什么没有公开规范）。
 * 新增规则时若两个都没有，`assertRuleSpec()` 直接拒绝运行——**不许有无来源的规则**。
 */
const RULE_SPEC = {
  chapter_min_han: {
    kind: 'threshold', applies: ['tomato', 'qidian'], value: 1000, unit: '汉字',
    claim: '单章 ≥1000 汉字，否则平台侧发不出去',
    source: {
      org: '番茄小说 作家帮助中心',
      url: 'https://fanqienovel.com/writer/zone/help/article?rank1=10006&rank2=10162&rank3=10164',
      quote: '章节字数至少1000字……必须满足1000字，否则无法发布，即无法点击「下一步」',
      also: '阅文帮助中心（起点）：本站要求标准小说新书正文分卷首章需满1000字，未达要求的作品不会进入待审列表（男频短篇分类要求300字）',
    },
  },
  chapter_max_han: {
    kind: 'threshold', applies: ['tomato'], value: 50000, unit: '汉字',
    claim: '单章 ≤50000 汉字（番茄）',
    source: {
      org: '番茄小说 作家帮助中心',
      url: 'https://fanqienovel.com/writer/zone/help/article?rank1=10006&rank2=10162&rank3=10164',
      quote: '章节字数至多50000字',
    },
  },
  paragraph_separator: {
    kind: 'format', applies: ['tomato'], value: '换行符（禁空格）',
    claim: '分段只能用换行键；用空格凑排版会被判"排版有误"',
    source: {
      org: '番茄小说 作家帮助中心',
      url: 'https://fanqienovel.com/writer/zone/help/article?rank1=10006&rank2=10162&rank3=10165',
      quote: '请使用换行键进行分段，不要使用空格键',
    },
  },
  blank_between_paragraphs: {
    kind: 'format', applies: ['tomato'], value: '无害但多余（平台会自动吃掉）',
    claim: '段间空行不需要手工维护——发布后自动消失',
    source: {
      org: '番茄小说 作家帮助中心',
      url: 'https://fanqienovel.com/writer/zone/help/article?rank1=10006&rank2=10162&rank3=10165',
      quote: '段落内的空格、段落之间多余空行发布后自动消失',
    },
  },
  reject_reasons: {
    kind: 'check', applies: ['tomato'],
    claim: '这几类会直接被判驳回：全文繁体／外文／乱码／未分段／章节空白／内容重复／章节乱序',
    source: {
      org: '番茄小说 作家帮助中心',
      url: 'https://fanqienovel.com/writer/zone/help/article?rank1=10019&rank2=10116&rank3=0',
      quote: '存在图片破损、全文繁体、外文、乱码、未分段、章节空白、内容重复、字体混乱、章节乱序等问题',
    },
  },
  title_charset: {
    kind: 'charset', applies: ['tomato'],
    claim: '书名只允许中英文、阿拉伯数字与中文叹号/逗号/问号/中括号/冒号',
    source: {
      org: '番茄小说 作家帮助中心',
      url: 'https://fanqienovel.com/writer/zone/help/article?rank1=10006&rank2=10140&rank3=10144',
      quote: '书名只支持中英文、阿拉伯数字，中文符叹号、逗号、问号、中括号、冒号',
    },
  },
  intro_len: {
    kind: 'threshold', applies: ['tomato', 'qidian'], value: [20, 500], unit: '字',
    claim: '简介 20–500 字（番茄 ≤500；起点 20–500）',
    source: {
      org: '番茄小说 作家帮助中心 / 阅文帮助中心',
      url: 'https://fanqienovel.com/writer/zone/help/article?rank1=10006&rank2=10140&rank3=10144',
      quote: '简介 500 字以内｜起点：作品简介字和字符总数要求20~500个字',
    },
  },
  few_paragraphs_threshold: {
    kind: 'check', applies: ['tomato'],
    // 官方只说"几个大段"会判排版有误，没给阈值 ⇒ 阈值是我们的猜测，必须标出来（别把猜测写成规范）
    unverified: '番茄只说"一个章节只有几个大段的，章节因内容排版有误而无法通过审核"，**没有给段数阈值**；'
      + '本工具的"≥1000 汉字且段数 <5 报疑似未分段"是按常识定的哨兵，不是官方值',
  },
  title_numeral: {
    kind: 'format', applies: ['tomato', 'qidian'], value: '番茄阿拉伯数字（第1章）｜起点中文数字（第一章）',
    unverified: '两平台官方帮助中心对**章节标题写法**零规定（起点帮助中心全文仅 14 条 FAQ，检索"标题/排版/格式"＝0 条）；'
      + '本表的编号写法是坊间惯例，**未证实**',
  },
  newline_encoding: {
    kind: 'format', applies: ['tomato', 'qidian'], value: 'LF',
    unverified: '两平台均无公开的换行/编码规范；坊间称部分平台 txt 导入偏好 GBK/CRLF，未见官方来源。'
      + '本工具统一 UTF-8 + LF：**"编码不符"是明确的失败信号，静默产出乱码更难查**',
  },
  single_file_import: {
    kind: 'format', applies: ['tomato', 'qidian'], value: '单文件 txt',
    unverified: '番茄"批量发布"仅限完本签约；起点草稿箱的导入格式未公开。**这份 txt 怎么进后台，须你实测一次**',
  },
}

/** 规则表自检：每条必须有 source 或 unverified——不许存在"没来源也没标未证实"的规则。 */
function assertRuleSpec() {
  const bad = Object.entries(RULE_SPEC).filter(([, r]) => !r.source && !r.unverified).map(([k]) => k)
  if (bad.length) die('规则表里有既没有出处、也没标"未证实"的规则：' + bad.join('、'), 2)
}
assertRuleSpec()

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
// --checklist：生成"上传前核对清单"（有官方依据的照抄项 ＋ 无公开规范须实测项 ＋ 实测方法）
const listOpt = argVal('--checklist')
if (listOpt === '') die('--checklist 给了但没给路径。\n' + USAGE)

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
// 规则检查（2026-09-22）：命中即出，每条都带 rule 名（报告里可对账到 RULE_SPEC 的出处）。
// 阈值/段落数这类"我们定的哨兵"与被官方明写的驳回原因分开放——读者要能一眼看出哪条是规范。
const chapters = []
const warnings = []
const ruleHits = []
const hit = (rule, msg, ch) => { const line = ch ? `第${ch}章：${msg}` : msg; warnings.push(line); ruleHits.push({ rule, ch: ch ?? null, msg: line }) }
let han = 0
const MIN_HAN = RULE_SPEC.chapter_min_han.value
const MAX_HAN = RULE_SPEC.chapter_max_han.value
for (const f of files) {
  const raw = readFileSync(path.join(msDir, f.name), 'utf8')
  const c = normalizeChapter(raw, f.ch, outlineTitle.get(f.ch))
  han += c.han
  warnings.push(...c.warnings)
  chapters.push({ ch: f.ch, file: f.name, heading: c.heading, body: c.body, paras: c.paras, han: c.han })
  // ① 空章（官方驳回原因：章节空白）——判据是**有没有段落内容**（c.paras），不是文件总汉字：
  //    文件名/标题行自带汉字，用总汉字判空章永远判不出来（"第3章"就有 3 个汉字）。
  if (c.paras === 0) hit('reject_reasons', '空章：正文区一个段落都没有（0 段）——平台的驳回原因里写着"章节空白"', f.ch)
  // ② 字数门槛（官方硬门槛：番茄不足 1000 发不出去；超过 50000 也不行）
  else if (c.han < MIN_HAN) hit('chapter_min_han', `${c.han} 汉字 < ${MIN_HAN}——平台侧会拦住发布（起点首章同理）`, f.ch)
  else if (platform === 'tomato' && c.han > MAX_HAN) hit('chapter_max_han', `${c.han} 汉字 > ${MAX_HAN}——超出后台上限`, f.ch)
  // ③ 乱码（官方驳回原因：乱码）——U+FFFD 是解码失败留下的替换字符，出现即说明链路里已经坏过
  if (raw.includes('\uFFFD')) hit('reject_reasons', '正文里有替换字符 U+FFFD（解码失败的痕迹）——官方把"乱码"列为驳回原因', f.ch)
  // ④ 疑似未分段（**我们的哨兵，不是官方阈值**：见 RULE_SPEC.few_paragraphs_threshold）
  if (c.han >= MIN_HAN && c.paras < 5) {
    hit('few_paragraphs_threshold', `${c.paras} 段 / ${c.han} 汉字——番茄只对"只有几个大段"的章判排版有误（**它没给阈值**，5 是本工具定的哨兵）`, f.ch)
  }
}
// ⑤ 章号断档／乱序（官方驳回原因：章节乱序）
for (let i = 1; i < chapters.length; i++) {
  if (chapters[i].ch !== chapters[i - 1].ch + 1) {
    hit('reject_reasons', `章号不连续：第 ${chapters[i - 1].ch} 章之后直接是第 ${chapters[i].ch} 章——平台把"章节乱序"列为驳回原因`, null)
  }
}
// ⑥ 作品信息（书级）：番茄书名字符集、简介字数。字段取自 project.json；缺字段＝不检查（不是"通过"）
const TOMATO_TITLE_OK = /^[\u4e00-\u9fffA-Za-z0-9！，？【】：]+$/
if (platform === 'tomato' && bookTitle && !TOMATO_TITLE_OK.test(bookTitle)) {
  hit('title_charset', '书名含番茄不允许的字符（官方只支持中英文、阿拉伯数字与 ！，？【】：）：' + bookTitle, null)
}
const introText = typeof project.logline === 'string' ? project.logline.trim() : ''
if (introText) {
  const [lo, hi] = RULE_SPEC.intro_len.value
  if (introText.length < lo || introText.length > hi) {
    hit('intro_len', `project.json 的 logline 有 ${introText.length} 字，超出简介口径 ${lo}–${hi}——**若平台简介填的就是它**，先改短再上传`, null)
  }
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

// ---------- 规则出处两栏（清单与报告共用这一份） ----------
const withSource = Object.entries(RULE_SPEC).filter(([, r]) => r.source)
const unverified = Object.entries(RULE_SPEC).filter(([, r]) => r.unverified)
if (unverified.length) {
  console.log('[platform-export] 无公开规范、须你实测 ' + unverified.length + ' 项：' + unverified.map(([, r]) => r.claim || '').join('；'))
  console.log('  （细节与实测方法：--checklist <文件> 生成「上传前核对清单」）')
}
if (ruleHits.length) console.error('[platform-export] 规则命中 ' + ruleHits.length + ' 条（含本工具自定的哨兵，逐条见报告 rule_hits）——**只是提示，本工具不改正文**')

if (listOpt) {
  const lp = path.resolve(listOpt)
  const L = []
  L.push('# 上传前核对清单（' + P.label + '）')
  L.push('')
  L.push('> 生成：`platform-export.mjs --checklist`。规则**只有一处真源**（脚本内 RULE_SPEC），本件是它的展开；')
  L.push('> 与导出产物一一对应，改规则请改脚本，别改本件。')
  L.push('')
  L.push('## 一、有官方依据（照抄，不要改写法）')
  L.push('')
  L.push('| 规则 | 值 | 出处 | 原文摘句 |')
  L.push('|---|---|---|---|')
  for (const [, r] of withSource) {
    const val = Array.isArray(r.value) ? r.value.join('–') : (r.value === undefined ? '—' : String(r.value))
    L.push('| ' + (r.claim || '') + ' | ' + val + ' | [' + r.source.org + '](' + r.source.url + ') | ' + String(r.source.quote || '').replace(/\|/g, '\\|') + (r.source.also ? '（另：' + r.source.also + '）' : '') + ' |')
  }
  L.push('')
  L.push('## 二、无公开规范 —— 必须实测（别当规范用）')
  L.push('')
  for (const [, r] of unverified) L.push('- **' + (r.claim || '') + '**：' + r.unverified)
  L.push('')
  L.push('## 三、实测方法（一次做完，之后回填）')
  L.push('')
  L.push('1. 用**真实作家账号**进后台，把本工具导出的 txt 上传或粘贴一次（不是本地看，是让平台吃一遍）。')
  L.push('2. 记下后台回执：能不能进下一步、有没有驳回原因、发布之后标题与段落长什么样、有没有乱码。')
  L.push('3. 把上面"须实测"逐条改成「已实测：结论 ＋ 日期 ＋ 平台」——**没回填就永远是未证实**，下一批照着它做决定的人会以为它已经验过。')
  L.push('')
  L.push('## 四、本工具不做的（避免误以为它替你办了）')
  L.push('')
  L.push('- 不改正文一个字节：敏感词、错别字、标点一律不动（仓内没有权威词表，自造清单＝把"没查"伪装成"查过了"）。')
  L.push('- 不据"听说"切编码：统一 UTF-8 + LF；编码不符是明确失败信号，静默产出乱码更难查。')
  mkdirSync(path.dirname(lp), { recursive: true })
  writeFileSync(lp, L.join('\n') + '\n', 'utf8')
  console.log('[platform-export] 上传前核对清单：' + lp)
}

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
    // 规则出处（2026-09-22）：报告里带全表，第三方可据此复算"哪条有官方依据、哪条是未证实的"
    rule_spec: Object.fromEntries(Object.entries(RULE_SPEC).map(([k, r]) => [k, {
      claim: r.claim || null, value: r.value === undefined ? null : r.value, applies: r.applies || null,
      source: r.source || null, unverified: r.unverified || null,
    }])),
    rule_hits: ruleHits,
  }
  mkdirSync(path.dirname(jp), { recursive: true })
  writeFileSync(jp, JSON.stringify(report, null, 2), 'utf8')
  console.log('[platform-export] 报告：' + jp)
}
