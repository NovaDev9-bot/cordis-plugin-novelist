/**
 * build-author-card.mjs —— 写手参照卡骨架生成器（只读锚书，零 LLM，零依赖）
 *
 * 用法：node build-author-card.mjs --book <锚书目录> [--out <卡文件>] [--json out.json]
 *
 * ── 为什么要有它（依据，不是偏好）────────────────────────────────────────────
 * 让 LLM 语域偏移，最强的手段是**给它看目标语域的原文**；把风格写成数字
 * （句长中位/短句占比）**无证据支持且有反证**——强制表层统计分布的路线被提示与 LoRA
 * 一致优于；追加可核验的对齐约束反而**降低**风格归属准确率（Wang et al. 2025，
 * 400+ 作者/4 万次生成）。机制＝extremal Goodhart：可被优化的代理目标会挤出真语域。
 * 所以本工具干两件事，且**两件事的输出严格分开**：
 *   ① 给写手的：锚段 + 按场景功能挑的范例候选 + 空槽（语域指南/禁令/黑名单由人填）；
 *   ② 给审校的：句长中位/短句占比/对话段占比 —— **只进 stderr 与 --json，永不进卡正文**。
 *
 * ── 卡的形态（写死在 _模板与建卡纪律.md，本工具按它产出）────────────────────
 * 一 语域指南（一句话，禁数字）／二 锚段／三 同场景范例 3–5 条／
 * 四 这个作者不会做的事／五 AI 腔黑名单／六 数字去哪了。
 *
 * ── 范例候选怎么挑（规则写死，不许改成"主题相似度"）────────────────────────
 * 按**场景功能**分四类：对话密集／动作密集／心理描写／场景铺陈，每类挑 1 条。
 * 判据是**可计算的代理量**，不是语义判断：
 *   对话密集 = 引号内汉字占比最高
 *   动作密集 = 动作动词密度最高（次/千字）
 *   心理描写 = 心理标记密度最高（次/千字）
 *   场景铺陈 = 段落长度分布最厚（且对话/动作/心理三项都低）
 * **明确不用主题相似度**：实证按内容相似度选范例会降低风格归属。
 * 某类在锚书里测不到合格段落 → 报"本锚书未测到该类"，**不拿别的类顶替**（"没测"≠"没有"）。
 *
 * ── 自证（写进断言，不靠人记得）────────────────────────────────────────────
 * · 锚书扫到 0 个章节文件 → **exit 2**：没测不等于没有；
 * · 产出的卡里必须 **0 个数字型风格断言**（卡正文不得出现 `\d+%` 或"中位/占比"这类词）——
 *   出现即 exit 1（这是本工具的存在理由，宁可炸也不产出一张自带 Goodhart 的卡）。
 *
 * ── 本工具测不了什么（列出来是纪律，不是免责）──────────────────────────────
 * 语域指南写得对不对、禁令是不是这位作者真不做的事、AI 腔黑名单该收哪些词——
 * 这三样**只能人来填**（卡里留空槽）。代理量能挑出"像对话戏的段落"，
 * 挑不出"这段是不是好例句"。判定归编辑部与 Owner。
 *
 * 退出码：0=生成成功 / 1=产出未通过自证（形态或数字断言） / 2=没测成（用法错/锚书不存在/0 章节）
 */
import { readFile, writeFile, readdir } from 'node:fs/promises'
import path from 'node:path'

const argv = process.argv.slice(2)
const opt = (k, d) => { const i = argv.indexOf(k); return i >= 0 ? argv[i + 1] : d }
const USAGE = '用法：node build-author-card.mjs --book <锚书目录> [--out <卡文件>] [--json out.json]'

/** 没测成：用法错、锚书不存在、0 章节。一律 exit 2——把"没检查"与"检查到没有"分开。 */
function die(msg, hint) {
  console.error('[build-author-card] 无法执行：' + msg + (hint ? '\n  提示：' + hint : ''))
  process.exit(2)
}

const bookArg = opt('--book')
if (!bookArg) die('缺 --book <锚书目录>', USAGE)
const BOOK = path.resolve(bookArg)
const OUT = opt('--out') ? path.resolve(opt('--out')) : null
const JSON_OUT = opt('--json') ? path.resolve(opt('--json')) : null

// ---------------------------------------------------------------- 读文本（UTF-8 → GBK 回退）

const readTextSafe = async (p) => {
  const raw = await readFile(p)
  let t = new TextDecoder('utf-8', { fatal: false }).decode(raw)
  if (t.charCodeAt(0) === 0xfeff) t = t.slice(1)
  if (t.includes('\uFFFD')) {
    const g = new TextDecoder('gbk').decode(raw)
    if (!g.includes('\uFFFD')) t = g
  }
  return t.replace(/\r\n?/g, '\n')
}

// ---------------------------------------------------------------- 锚书发现

/** 非章节的目录（账本、报告、依赖）：fallback 扫描时跳过，免得把手册当正文。 */
const SKIP_DIRS = new Set(['.git', 'node_modules', 'editorial', 'snapshots', 'craft', 'instruments'])

async function discover() {
  let st = null
  try { st = await readdir(path.join(BOOK, 'manuscript'), { withFileTypes: true }) } catch (e) { /* 无 manuscript/ */ }
  if (st) {
    const chs = st.filter((e) => e.isFile() && /^chapter_\d+\.md$/.test(e.name))
      .map((e) => ({ n: Number(e.name.match(/(\d+)/)[1]), file: path.join(BOOK, 'manuscript', e.name) }))
      .sort((a, b) => a.n - b.n)
    if (chs.length) {
      const units = []
      for (const c of chs) units.push({ label: '第 ' + c.n + ' 章', sort: c.n, text: await readTextSafe(c.file) })
      return { mode: 'manuscript', units }
    }
  }
  // fallback：任意 *.md / *.txt（跳过账本与依赖目录）
  const found = []
  async function walk(dir) {
    let entries = []
    try { entries = await readdir(dir, { withFileTypes: true }) } catch (e) { return }
    for (const e of entries) {
      if (e.name.startsWith('.')) continue
      const p = path.join(dir, e.name)
      if (e.isDirectory()) { if (!SKIP_DIRS.has(e.name)) await walk(p) }
      else if (/\.(md|txt)$/i.test(e.name)) found.push(p)
    }
  }
  await walk(BOOK)
  found.sort()
  const units = []
  let i = 0
  for (const p of found) {
    i++
    units.push({ label: path.relative(BOOK, p).replace(/\\/g, '/'), sort: i, text: await readTextSafe(p) })
  }
  return { mode: 'files', units }
}

// 自证：0 个章节文件＝没测成，不是"这本书没有风格"
let units = []
try { units = (await discover()).units } catch (e) { die('读锚书失败：' + BOOK + '（' + (e && e.code ? e.code : e) + '）') }
if (!units.length) {
  die('锚书里扫到 0 个章节文件：' + BOOK,
    '认两种布局：① <锚书>/manuscript/chapter_NNN.md ② 目录下任意 *.md / *.txt（会跳过 editorial/ 等账本目录）。' +
    '\n  0 件不等于"这本书没有风格"——是没测成，所以退出码是 2 而不是 0')
}

// ---------------------------------------------------------------- 段落切分

const HAN = /[\u4e00-\u9fff]/g
const hanzi = (s) => (s.match(HAN) || []).length
const MIN_WIN = 150      // 范例候选的字数带下限（模板：每条 150–400 字）
const MAX_WIN = 400
const MIN_ANCHOR = 100   // 锚段（模板：100–200 字）
const MAX_ANCHOR = 200

/** 标题行／元数据行不是正文段落：切窗时剔掉。 */
const isMeta = (l) =>
  /^#{1,6}\s/.test(l) || /^[-*_]{3,}$/.test(l) ||
  /^\s*(第[零一二三四五六七八九十百千万0-9]+[章回节卷][^\n]{0,40})$/.test(l) ||
  /^\s*(Chapter\s+\d+[^\n]{0,40})$/i.test(l) || l.length < 2

function paragraphsOf(text) {
  return text.split('\n').map((l) => l.trim()).filter((l) => l && !isMeta(l))
}

/** 单段超过上限时按句末切块，保证任一窗口都能落进带内。 */
function splitLong(paras) {
  const out = []
  for (const p of paras) {
    if (hanzi(p) <= MAX_WIN) { out.push(p); continue }
    let buf = ''
    for (const s of p.split(/(?<=[。！？…”」』])/)) {
      if (hanzi(buf + s) > MAX_WIN && buf) { out.push(buf); buf = s } else buf += s
    }
    if (buf) out.push(buf)
  }
  return out
}

/** 连续段落累加成 [MIN_WIN, MAX_WIN] 的窗口；超上限则在句末截断。 */
function windowsOf(paras) {
  const out = []
  let buf = []
  let acc = 0
  const flush = () => {
    if (!buf.length) return
    let t = buf.join('\n')
    if (hanzi(t) > MAX_WIN) {
      let cut = ''
      for (const s of t.split(/(?<=[。！？…”」』])/)) {
        if (hanzi(cut + s) > MAX_WIN) break
        cut += s
      }
      t = hanzi(cut) >= MIN_WIN ? cut : t.slice(0, MAX_WIN)
    }
    if (hanzi(t) >= MIN_WIN) out.push(t)
    buf = []
    acc = 0
  }
  for (const p of splitLong(paras)) {
    buf.push(p)
    acc += hanzi(p)
    if (acc >= MIN_WIN) flush()
  }
  return out
}

// ---------------------------------------------------------------- 代理量（可计算，非语义判断）

const ACTION_VERBS = ['冲', '扑', '抓', '拽', '扯', '踢', '踹', '砍', '劈', '砸', '撞', '夺', '推', '拉',
  '扔', '甩', '挥', '抬', '翻', '跃', '窜', '爬', '跑', '奔', '追', '踏', '踩', '压', '扭', '挡',
  '举', '拖', '拎', '摁', '掐', '按住', '挣开', '倒退', '扑倒', '闪身', '格挡']
const PSY_MARKS = ['心里', '心想', '想到', '觉得', '思绪', '回忆', '记忆', '脑海', '意识到', '明白',
  '知道', '怕', '慌', '恐惧', '后悔', '纠结', '犹豫', '茫然', '难受', '忍住', '默念', '盘算', '琢磨', '发冷']

/**
 * 引号形态普查——把"这本书没有对白"与"这本书的引号我不认识"分开。
 * 实测踩过：一份用 ASCII 直引号的锚书，对话密集类被判成"未测到"——
 * 那是量具没认出来，不是这本书没有对话。所以普查结果要印出来（stderr）。
 */
const QUOTE_FORMS = {
  '直角引号「」': /[「」『』]/g,
  '弯引号“”': /[“”]/g,
  '直引号"': /["＂]/g,
}
const quoteCensus = (t) => Object.fromEntries(
  Object.entries(QUOTE_FORMS).map(([k, re]) => [k, (t.match(re) || []).length]))
const hasAnyQuote = (t) => Object.values(quoteCensus(t)).some((n) => n > 0)

/** 引号内汉字占比——对话量的代理量。三种印法都认：语料来自哪里不可控，
 *  直引号（开闭同形）按出现次序交替配对，其余按开闭异形配对。 */
function dialogueRatio(t) {
  let inQ = 0
  for (const [open, close] of [['「', '」'], ['『', '』'], ['“', '”']]) {
    let i = 0
    for (;;) {
      const a = t.indexOf(open, i)
      if (a < 0) break
      const b = t.indexOf(close, a + 1)
      if (b < 0) break
      inQ += hanzi(t.slice(a + 1, b)); i = b + 1
    }
  }
  for (const q of ['"', '＂']) {
    const at = []
    for (let i = t.indexOf(q); i >= 0; i = t.indexOf(q, i + 1)) at.push(i)
    for (let k = 0; k + 1 < at.length; k += 2) inQ += hanzi(t.slice(at[k] + 1, at[k + 1]))
  }
  const total = hanzi(t)
  return total ? inQ / total : 0
}
const per1000 = (t, words) => {
  const n = words.reduce((a, w) => a + t.split(w).length - 1, 0)
  const h = hanzi(t)
  return h ? n / h * 1000 : 0
}
const meanPara = (t) => {
  const ps = t.split('\n').map((x) => x.trim()).filter(Boolean)
  return ps.length ? ps.reduce((a, p) => a + hanzi(p), 0) / ps.length : 0
}

const measure = (t) => ({
  dlg: dialogueRatio(t),
  act: per1000(t, ACTION_VERBS),
  psy: per1000(t, PSY_MARKS),
  para: meanPara(t),
  chars: hanzi(t),
})

const CLASSES = [
  { key: '对话密集', pick: (c) => c.dlg, why: '本锚书里对白最密的一档：场景几乎全靠人物对白推进，叙述只留必要的动作交代。' },
  { key: '动作密集', pick: (c) => c.act, why: '本锚书里动作最紧的一档：身体动作与位移连着写，几乎没有停下来解释的句子。' },
  { key: '心理描写', pick: (c) => c.psy, why: '本锚书里内心戏最重的一档：情绪与念头在人物内部展开，叙述贴着人物的感受走。' },
  { key: '场景铺陈', pick: (c) => c.para, why: '本锚书里铺陈最厚的一档：段落长、信息密，环境与器物一层层铺开，对白与动作都退到后面。' },
]

// ---------------------------------------------------------------- 挑范例候选（每类 1 条，互不重叠）

const all = []
for (const u of units) {
  let off = 0
  for (const w of windowsOf(paragraphsOf(u.text))) {
    all.push({ unit: u, text: w, ...measure(w), off })
    off += w.length
  }
}
if (!all.length) {
  die('锚书读到了 ' + units.length + ' 个章节文件，但切不出任何 150 字以上的正文段落：' + BOOK,
    '是不是整个文件都是标题/目录？先人工确认锚书文本形态，别把"切不出窗口"当成"这本书没有范例"')
}

const used = []
const candidates = []
const missing = []

/**
 * 合格判据（**用锚书自身的分布/有无定标，不写死绝对阈值**）：
 *   前三类要"某项最高"，前提是这本书里**确实存在该项**（密度/占比 > 0）——
 *   一本一句对白都没有的书，不该被贴上"对话密集"的标签（那是"测不到"，不是"没有"）。
 *   场景铺陈是**残余类**：先看"不是对话戏"（引号内汉字不高于全书中位），再取段落最厚的一条。
 * 为什么不写死阈值、为什么不用 `>` 中位：小样本下中位会被顶成最大值或 0，
 * 于是"高于中位""低于中位"两个谓词同时取空（本工具实测踩过两次：固定阈值与中位比较各一次）。
 * 代理量只用来**排先后**，不用来**判合格**——判合格一旦依赖阈值，就变成了另一种数字靶子。
 */
const median = (xs) => {
  const s = [...xs].sort((a, b) => a - b)
  return s.length ? s[Math.floor(s.length / 2)] : 0
}
const mid = {
  dlg: median(all.map((w) => w.dlg)),
  act: median(all.map((w) => w.act)),
  psy: median(all.map((w) => w.psy)),
  para: median(all.map((w) => w.para)),
}
const predicateOf = (key) => ({
  对话密集: (c) => c.dlg > 0,
  动作密集: (c) => c.act > 0,
  心理描写: (c) => c.psy > 0,
  // 残余类用 <= 不用 <：中位常常正好是 0（全书大量段落一句对白都没有），
  // 写成严格小于就永远取不到窗口——本工具实测踩过一次，别改回去。
  场景铺陈: (c) => c.dlg <= mid.dlg,
}[key])

for (const cls of CLASSES) {
  const ok = predicateOf(cls.key)
  const pool = all.filter((w) => !used.includes(w) && ok(w))
  if (!pool.length) { missing.push(cls.key); continue }
  pool.sort((a, b) => cls.pick(b) - cls.pick(a) || a.unit.sort - b.unit.sort || a.off - b.off)
  const top = pool[0]
  used.push(top)
  candidates.push({ cls: cls.key, why: cls.why, ...top, rank: pool.length })
}
// 候选按锚书顺序排列（读起来是"这本书的几副嗓子"，不是按分数排队）
candidates.sort((a, b) => a.unit.sort - b.unit.sort || a.off - b.off)

// 锚段：取第一个章节单元的开头（放任务书开头，用来立语域）
let anchor = null
for (const u of units) {
  const paras = paragraphsOf(u.text)
  let buf = ''
  for (const p of paras) {
    buf += (buf ? '\n' : '') + p
    if (hanzi(buf) >= MIN_ANCHOR) break
  }
  if (hanzi(buf) < MIN_ANCHOR) continue
  if (hanzi(buf) > MAX_ANCHOR) {
    let cut = ''
    for (const s of buf.split(/(?<=[。！？…”」』])/)) {
      if (hanzi(cut + s) > MAX_ANCHOR) break
      cut += s
    }
    buf = hanzi(cut) >= MIN_ANCHOR ? cut : buf.slice(0, MAX_ANCHOR)
  }
  anchor = { text: buf, label: u.label }
  break
}

// ---------------------------------------------------------------- 审校侧统计（只进 stderr / --json）

const allText = units.map((u) => u.text).join('\n')
const census = quoteCensus(allText)
const noQuoteBook = !hasAnyQuote(allText)
const sentences = allText.split(/[。！？!?；;]+/).map((s) => s.trim()).filter(Boolean)
const sentLens = sentences.map(hanzi).sort((a, b) => a - b)
const quantile = (sorted, q) => (sorted.length ? sorted[Math.min(sorted.length - 1, Math.floor(q * sorted.length))] : null)
const parasAll = allText.split('\n').map((l) => l.trim()).filter((l) => l && !isMeta(l))
const dlgParas = parasAll.filter((p) => dialogueRatio(p) > 0).length

const reviewStats = {
  _归属: '审校侧口径——**不进写手派工包**（本工具把它印在 stderr 与 --json，卡正文里 0 个）',
  chapters_scanned: units.length,
  hanzi_total: hanzi(allText),
  sentence_median_hanzi: quantile(sentLens, 0.5),
  short_sentence_ratio: sentLens.length ? Math.round(sentLens.filter((n) => n <= 6).length / sentLens.length * 10000) / 10000 : null,
  dialogue_para_ratio: parasAll.length ? Math.round(dlgParas / parasAll.length * 10000) / 10000 : null,
}

const selectionReport = {
  book_medians: {
    dlg: Math.round(mid.dlg * 1000) / 1000,
    act: Math.round(mid.act * 10) / 10,
    psy: Math.round(mid.psy * 10) / 10,
    para_mean: Math.round(mid.para * 10) / 10,
  },
  candidates: candidates.map((c) => ({
    class: c.cls, where: c.unit.label, chars: c.chars,
    dlg: Math.round(c.dlg * 1000) / 1000, act: Math.round(c.act * 10) / 10,
    psy: Math.round(c.psy * 10) / 10, para_mean: Math.round(c.para * 10) / 10,
  })),
  classes_not_measured: missing,
  anchor_source: anchor ? anchor.label : null,
}

// ---------------------------------------------------------------- 卡正文

const STATS_NOTE = [
  '## 六、数字去哪了',
  '本卡**不含**句长/占比类数字。那些量已移到审校侧（style-check / structure-check），',
  '标注"不进写手派工包"。理由：可被优化的代理目标会挤出真语域（Goodhart · extremal）。',
].join('\n')

function buildCard() {
  const L = []
  L.push('# （待填：风格指纹名） · （待填：作品特征描述）')
  L.push('')
  L.push('> 性质：写手参照卡（**不是赏析、不是规格清单**）。字数预算 600–2000。')
  L.push('> 使用方式：随派工包**全文**贴给主笔（留在库里不贴＝这一格空转）。')
  L.push('> 生成：本卡由 build-author-card 生成，范例来自你自己的锚书。卡名用**风格指纹**（形态描述），不点名、不点作品名。')
  L.push('')
  L.push('## 一、语域指南（一句话，禁数字）')
  L.push('（待填：一句话定性，**禁数字**。例：冷硬克制，靠动作和对话推进，叙述者不解释情绪。）')
  L.push('')
  L.push('## 二、锚段（放任务书开头）')
  L.push(anchor ? anchor.text + '\n\n（锚段取自' + anchor.label + '开头）' : '（自备：用 build-author-card 从你的锚书生成）')
  L.push('')
  L.push('## 三、同场景范例 3–5 条')
  L.push('按**即将写的场景类型**取用：对话戏配对话戏、动作段配动作段。**不要按主题相似度选**——按内容相似度选范例会降低风格归属。')
  L.push('')
  for (const c of candidates) {
    L.push('### ' + c.cls + '（' + c.unit.label + '）')
    L.push(c.text)
    L.push('')
    L.push('> 为什么是这条：' + c.why + '（本锚书该类候选中测得最靠前的一条）')
    L.push('')
  }
  if (missing.length) {
    L.push('（本次锚书里未测到合格段落的功能类：' + missing.join('、') + '——**未测到不等于没有**，'
      + '要这一类范例就换一本锚书或补一段进语料，别拿别的类顶替。）')
    L.push('')
  }
  L.push('## 四、这个作者不会做的事（3–6 条，决策级）')
  L.push('（待填：照上面的范例读，写"它绝不这么做"的硬边界。例：不用第二人称、不写心声括号、不连用三个比喻。）')
  L.push('')
  L.push('## 五、AI 腔黑名单（5–15 个词/句式）')
  L.push('（待填：压掉模型默认腔用的词/句式清单。写你在这份锚书里看不到、但在模型稿里反复出现的那些。）')
  L.push('')
  L.push(STATS_NOTE)
  L.push('')
  return L.join('\n')
}

const card = buildCard()

// ---------------------------------------------------------------- 自证：卡里 0 个数字型风格断言

/**
 * 定型元说明必须**点名**那些量（"本卡不含句长/占比类数字"），才说得出"这些不进卡"；
 * 所以扫描前先摘掉定型段与那条禁令提示——否则断言会咬到自己的模板。
 * 剩下（语域指南/锚段/范例/禁令/黑名单）才是"风格断言"该干净的地方。
 */
const stripFixedMeta = (t) => t
  .replace(/## 六、数字去哪了[\s\S]*$/, '')
  .replace(/^\*\*禁止出现任何数字、百分比、比例。\*\*$/m, '')

const PERCENT_RE = /\d\s*[%％]/
const QUANT_WORDS = ['中位', '均值', '平均数', '标准差', '分位', '占比', '百分比', '比例', '百分点', '句长', '密度', '频率', '比值']
const body = stripFixedMeta(card)

const violations = []
const pm = body.match(PERCENT_RE)
if (pm) violations.push('出现数字百分比：' + pm[0])
for (const w of QUANT_WORDS) if (body.includes(w)) violations.push('出现量化词：' + w)

// 语域指南一节更是**一个数字都不许有**（写手第一眼看到的就是它）
const guideSec = (card.match(/## 一、语域指南[^\n]*\n([\s\S]*?)\n## /) || [, ''])[1]
const guideDigits = guideSec.match(/\d+/)
if (guideDigits) violations.push('语域指南一节出现数字：' + guideDigits[0])

if (candidates.length < 3) violations.push('范例候选只有 ' + candidates.length + ' 条（模板要求 3–5 条）')
if (candidates.length > 5) violations.push('范例候选有 ' + candidates.length + ' 条（模板要求 3–5 条）')
for (const h of ['## 一、语域指南', '## 二、锚段', '## 三、同场景范例', '## 四、这个作者不会做的事', '## 五、AI 腔黑名单', '## 六、数字去哪了']) {
  if (!card.includes(h)) violations.push('缺小节：' + h)
}
if (!card.includes('本卡由 build-author-card 生成，范例来自你自己的锚书')) violations.push('缺生成声明')

const cardChars = hanzi(card)
if (cardChars > 2000) violations.push('卡正文 ' + cardChars + ' 字，超出模板预算上限 2000')

if (violations.length) {
  console.error('[build-author-card] 自证失败——产出不符卡片形态（宁可不产出，也不产出一张自带代理目标的卡）：')
  for (const v of violations) console.error('  ✗ ' + v)
  process.exit(1)
}

// ---------------------------------------------------------------- 输出（卡 → stdout/--out；数字 → stderr/--json）

console.error('[build-author-card] 锚书=' + BOOK + '（' + units.length + ' 个章节文件，模式=' + (units[0].label.startsWith('第 ') ? 'manuscript' : 'files') + '）')
console.error('[build-author-card] 范例候选 ' + candidates.length + ' 条：' + candidates.map((c) => c.cls + '@' + c.unit.label).join('、'))
console.error('[build-author-card] 引号普查：' + Object.entries(census).map(([k, v]) => k + ' ×' + v).join(' ｜ '))
if (missing.length) {
  console.error('[build-author-card] 未测到合格段落的功能类：' + missing.join('、') + '（未测到≠没有；未用别的类顶替）')
  if (missing.includes('对话密集') && noQuoteBook) {
    console.error('[build-author-card]   ⚠ 全书一个引号都没有——"对话密集未测到"多半是**语料不带引号**，'
      + '不是"这本书没有对白"：直引号/弯引号/直角引号本工具都认，裸文本没有引号则判不了对白。')
  }
}
console.error('[build-author-card] 锚段来源：' + (anchor ? anchor.label + '（' + hanzi(anchor.text) + ' 字）' : '（锚书首章不足 ' + MIN_ANCHOR + ' 字，未取）'))
console.error('[build-author-card] 卡正文 ' + cardChars + ' 字；数字型风格断言 0 个（已断言：卡正文无 `\\d+%` 与量化词，语域指南一节无数字）')
console.error('')
console.error('── 以下是审校侧口径，**不进写手派工包**（给 style-check / structure-check 对手，别贴给主笔）')
console.error('   句长中位 ' + reviewStats.sentence_median_hanzi + ' 字 ｜ 短句占比 ' + reviewStats.short_sentence_ratio +
  ' ｜ 对话段占比 ' + reviewStats.dialogue_para_ratio + ' ｜ 锚书汉字 ' + reviewStats.hanzi_total)
console.error('   候选实测代理量（挑选依据，可复核）：')
for (const c of selectionReport.candidates) {
  console.error('     ' + c.class + ' @' + c.where + '  引号内汉字占比 ' + c.dlg + ' ｜ 动作动词密度/千字 ' + c.act +
    ' ｜ 心理标记密度/千字 ' + c.psy + ' ｜ 段均长 ' + c.para_mean + ' 字')
}
console.error('   全书窗口中位（定标用）：引号内汉字占比 ' + selectionReport.book_medians.dlg +
  ' ｜ 动作 ' + selectionReport.book_medians.act + ' ｜ 心理 ' + selectionReport.book_medians.psy +
  ' ｜ 段均长 ' + selectionReport.book_medians.para_mean)

if (OUT) {
  await writeFile(OUT, card, 'utf8')
  console.error('\n[build-author-card] 卡已写入 ' + OUT)
} else {
  process.stdout.write(card)
}
if (JSON_OUT) {
  await writeFile(JSON_OUT, JSON.stringify({
    _说明: 'build-author-card 的完整实测输出。卡正文里 0 个数字；数字全在这里（给审校/诊断，不进写手派工包）。',
    book: BOOK, generated_from: selectionReport, review_side_stats: reviewStats,
  }, null, 2) + '\n', 'utf8')
  console.error('[build-author-card] 实测 JSON → ' + JSON_OUT)
}
process.exit(0)
