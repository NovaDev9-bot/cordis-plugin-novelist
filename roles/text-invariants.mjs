#!/usr/bin/env node
/**
 * text-invariants.mjs —— 角色/人格/协议**文本层的不变量**守卫（零 LLM，只读）
 *
 * 用法：
 *   node roles/text-invariants.mjs [--root <仓库根>]
 *
 * 退出码：0=全部成立 / 1=有不变被破坏 / 2=**没检查成**（文件找不到、扫到 0 件、规则空转）
 *
 * ── 与 build-tool-face.mjs 的分工
 * 那条管**工具名**（能力表 → 派生件，逐字比对名单）；本脚本管**散文**：
 * 人格段里的义务句、协议里的口径句、SOP 里的数字。两者都是"装配前 fail-closed"，
 * 都挂在装配器第 0 步与 check-all 上。
 *
 * ── 四组不变量，各自的病根
 * ① **禁模式（人格义务句）**：人格段里"你没有 X"是**宿主能力事实**——换个宿主形态就是假话，
 *    而且同一份文件末尾的工具清单会当场证伪它（2026-09-21 实测与分析：被证伪的事实句
 *    不产生行为，只把人格段自己的权威折价）。这一类句子已统一改成义务句"你不得动用"。
 *    治法不是"这次改对"，是**让改回去这件事报红**：故锁成禁模式，而不是锁成"必须有几句"。
 * ② **同句（跨文件同一条口径）**：同一条口径写在两个文件里就会分叉——已实测：
 *    章长窗豁免只打在一处，另一处连"安全窗口/短平快安全区"的措辞都不同。
 *    断言＝两处抽出的**同一条款必须逐字相同**（条款文本本脚本里一个字都不写，现读现比）。
 * ③ **同数（同一份 SOP 里的两个数字）**：手工调用目标"≤3 次/章"与验收步数各写一次，
 *    谁都不权威——实测口径是"按 3 次去砍流程、把验收砍掉"。
 *    断言＝①验收步数从**文本里数出来**（不写常量）；②两处对它的引用必须等于数出来的值。
 *
 * ── 元纪律（本项目 2026-09-18 审计第一性根因）
 * "缺失没有类型"：找不到文件、扫到 0 行、规则一条没匹配上——一律 exit 2，不许当"通过"。
 * 本脚本里**不许出现"应该是几"的手写常量**（除了自身扫描下限）：手写常量就是下一个会漂的副本。
 */
import fsSync from 'node:fs'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const argv = process.argv.slice(2)
const opt = (n) => { const i = argv.indexOf(n); return i !== -1 ? argv[i + 1] : null }
const die = (msg, hint) => {
  console.error('[text-invariants] 拒绝执行：' + msg + (hint ? '\n  提示：' + hint : ''))
  process.exit(2)
}

// 两种落地形态（同 build-tool-face.mjs 的判据；取**最外层**命中者——扁平判据在 monorepo
// 里对插件子仓同样成立，就近取会把 monorepo 根误判成它自己）
const MONO_MARKERS = ['dsh-native', 'vault']
const FLAT_MARKERS = ['wb-expert-starter', 'lib']
const isMono = (d) => MONO_MARKERS.every((m) => fsSync.existsSync(path.join(d, m)))
const isFlat = (d) => FLAT_MARKERS.every((m) => fsSync.existsSync(path.join(d, m)))
function findRoot(start) {
  let cur = path.resolve(start), hit = null
  for (;;) {
    if (isMono(cur) || isFlat(cur)) hit = cur
    const up = path.dirname(cur)
    if (up === cur) return hit
    cur = up
  }
}
const ROOT_RAW = opt('--root') || process.env.NF_REPO_ROOT || findRoot(path.dirname(fileURLToPath(import.meta.url)))
if (!ROOT_RAW) die('没有找到仓库根（mono 需同时有 ' + MONO_MARKERS.join(' 与 ') + '；flat 需同时有 ' + FLAT_MARKERS.join(' 与 ') + '）')
const ROOT = path.resolve(ROOT_RAW)
const PLUGIN = isMono(ROOT) ? path.join(ROOT, 'dsh-native', 'plugin-novelist') : ROOT
const TPL = path.join(PLUGIN, 'wb-expert-starter')
const TABLE_PATH = path.join(PLUGIN, 'roles', 'tool-face.json')
if (!fsSync.existsSync(TABLE_PATH)) {
  die('能力表不存在：' + TABLE_PATH,
    '能力表是"预设/角色在哪"的唯一来源，它不在这个根下。多半是 --root 指错了（给了仓库里的某个子目录，'
    + '或给了一个没有 markers 的目录）：本脚本认两种布局——mono（同时有 dsh-native 与 vault）'
    + '与 flat（同时有 wb-expert-starter 与 lib）。实得 ROOT=' + ROOT + '，PLUGIN=' + PLUGIN)
}
const TABLE = JSON.parse(fsSync.readFileSync(TABLE_PATH, 'utf8'))
const REL = (p) => path.relative(ROOT, p).split(path.sep).join('/')

const read = (p) => fsSync.readFileSync(p, 'utf8')
const mdFilesIn = (d) => (fsSync.existsSync(d) ? fsSync.readdirSync(d).filter((f) => f.endsWith('.md')).sort().map((f) => path.join(d, f)) : [])
const lineOf = (text, needle) => text.split('\n').findIndex((l) => l.includes(needle)) + 1

const violations = []
const notes = []

// ── 扫描面：人格段落在哪，**从头推导**，不手写清单 ─────────────────────────────
// 三条来源：agents/（agent 定义＝人格本体）、references/roles/（派工文本）、预设（生产口径）。
// 预设清单只有一个家：能力表的 hosts.dsh.presets——本脚本不另写一份路径。
const personaFiles = [
  ...mdFilesIn(path.join(TPL, 'agents')),
  ...mdFilesIn(path.join(TPL, 'references', 'roles')),
]
if (personaFiles.length < 3) die('人格/派工文本扫到 ' + personaFiles.length + ' 件（期望 ≥3）——路径变了？0 件不等于干净')
{
  const strip = (t) => { const m = t.match(/^dsh-native\/[^/]+\/(.+)$/); return m ? m[1] : null }
  for (const rel of TABLE.hosts.dsh.presets || []) {
    for (const cand of [path.resolve(ROOT, rel), path.resolve(PLUGIN, strip(rel) || rel)]) {
      if (fsSync.existsSync(cand) && !personaFiles.includes(cand)) personaFiles.push(cand)
    }
  }
}
if (personaFiles.length < 4) die('（含预设）扫描面只有 ' + personaFiles.length + ' 件——至少该命中两份预设，实际没命中')

// ── 不变量 ① 禁模式：人格段不得再用"能力否定句"说工具权限 ──────────────────────
// 三个模式就是这一类的形状（实测语料：9 处落点全部命中其中之一）。
// **正向义务句**统一为「你不得动用」——不锁"每人必须有几句"，只锁"不许说成能力事实"：
// 逐角色配额会逼着人往没有这句话的文本里补一句（补出来的文本＝为了讨好守卫而写的）。
{
  const FORBIDDEN = ['你没有', '也没有账本工具（', '你没有任何']
  const OBLIGATION = '你不得动用'
  let scannedLines = 0
  let obligTotal = 0
  const carriers = []
  for (const f of personaFiles) {
    const lines = read(f).split('\n')
    scannedLines += lines.length
    lines.forEach((l, i) => {
      for (const pat of FORBIDDEN) {
        if (l.includes(pat)) violations.push('① 禁模式：' + REL(f) + ':' + (i + 1) + ' 用了能力否定句「' + pat + '」——它在另一个宿主形态下是假话，且会被同文件末尾的工具清单证伪\n      ' + l.trim().slice(0, 140))
      }
    })
    const n = lines.filter((l) => l.includes(OBLIGATION)).length
    if (n) { obligTotal += n; carriers.push(REL(f) + ' ×' + n) }
  }
  if (scannedLines < 100) die('① 扫描面只有 ' + scannedLines + ' 行（期望上百行）——文件读空了？')
  if (obligTotal === 0) die('① 空转：全部扫描面里一句「' + OBLIGATION + '」都没有——守卫在数一个不存在的东西（整段被删了？）')

  // 正向面**从能力表推导**：凡"在 WB 侧是 agent 定义（agents/）且被 deny 了落账权"的角色，
  // 它的 persona 里必须有义务句——加一个新座位角色而不写这句，这里会红，而不是等下一次审计。
  const seatRoles = Object.entries(TABLE.roles || {}).filter(([, r]) =>
    r.codebuddy && typeof r.codebuddy.file === 'string' && r.codebuddy.file.startsWith('agents/') &&
    Array.isArray(r.deny) && r.deny.includes('ledger.write'))
  if (seatRoles.length === 0) die('① 空转：能力表里没有任何"agent 定义形态 + 被封落账权"的角色（推导式正向面等于没检查）')
  for (const [rid, r] of seatRoles) {
    const f = path.join(TPL, r.codebuddy.file)
    if (!fsSync.existsSync(f)) { violations.push('① 能力表说角色 ' + rid + ' 的 agent 定义在 ' + r.codebuddy.file + '，文件不存在'); continue }
    const t = read(f)
    if (!t.includes(OBLIGATION)) {
      violations.push('① 角色 ' + rid + '（' + r.codebuddy.file + '）被封了落账权，人格段里却没有义务句「' + OBLIGATION + '」——' +
        '封了工具面却不说出口，模型只能靠自己猜边界')
    }
    if (t.includes('【纪律】') === false) die('① 角色 ' + rid + ' 的 ' + r.codebuddy.file + ' 里找不到【纪律】段（人格结构变了？别猜）')
  }
  notes.push('① 禁模式：' + personaFiles.length + ' 件 / ' + scannedLines + ' 行零命中；义务句「' + OBLIGATION + '」共 ' + obligTotal + ' 处（' + carriers.join('、') + '）· 推导式正向面覆盖 ' + seatRoles.length + ' 个座位角色')
}

// ── 不变量 ② 同句：同一条读者画像口径写在哪几处，那几处必须逐字相同 ──────────────
// 扫描面**按内容定**（不按文件名）：凡引用了「番茄读者画像八条」的文件，都是这份画像的化身。
//   ① 取锚句**最后一次**出现处（协议卡开头那句"见文末"是**指路**，条款在它下面）；
//   ② 从那里往后找第一组相邻的 `③…；④…；` —— 用结构定位，不把条款正文写进本脚本；
//   ③ 形状体检：条款里必须含数字（"章节长度窗"是一条数值口径；不含＝这是别的 ④，不是化身）。
// 比较前**剥掉全部空白**：中文文本里"在哪儿折行"是排版不是口径，而各化身的折行方式本就不同
// （预设用折叠标量、协议卡窄栏折行、派工文本一行到底）——按原样比对会把排版差读成口径差。
// 但**字符一个不许差**：剥空白之后剩下的每个字都必须相同，措辞分叉照样报红。
{
  const ANCHOR = '番茄读者画像八条'
  const PAIR = /③[^；]*；④([^；]*；)/
  const norm = (s) => s.replace(/\s+/g, '')
  const carriers = []
  const skipped = []
  for (const f of [...personaFiles, ...mdFilesIn(path.join(PLUGIN, 'preset-starter', 'protocols'))]) {
    const t = norm(read(f))
    const i = t.lastIndexOf(ANCHOR)
    if (i === -1) continue
    const m = t.slice(i).match(PAIR)
    if (!m || !/\d/.test(m[1])) { skipped.push(path.basename(f)); continue }   // 指路件/别的 ④：显式列出，不静默
    carriers.push({ f, clause: m[1] })
  }
  if (carriers.length < 3) {
    die('② 画像 ④ 条款只找到 ' + carriers.length + ' 个化身（期望 ≥3：两份预设 + 派工文本 + 协议卡）——' +
      '要么条款被删了，要么编号/折行形态变了。跳过件：' + (skipped.join('、') || '无'))
  }
  const ref = carriers[0]
  const bad = carriers.filter((c) => c.clause !== ref.clause)
  for (const c of bad) {
    violations.push('② 同句：同一条画像条款（④节奏窗/章长窗）在各化身之间措辞不同——它是**仪器规格**，' +
      '不同＝同一批冷读按几份规格做、跨批趋势线不可比\n' +
      '      基准 ' + REL(ref.f) + '\n        ' + ref.clause + '\n' +
      '      分叉 ' + REL(c.f) + '\n        ' + c.clause)
  }
  notes.push('② 同句：画像 ④ 条款 ' + carriers.length + ' 个化身' + (bad.length ? '·**有 ' + bad.length + ' 处分叉**' : '逐字相同（' + ref.clause.length + ' 字符）') +
    '（' + carriers.map((c) => path.basename(c.f)).join('、') + (skipped.length ? '；引用但未抄条款：' + skipped.join('、') : '') + '）')
}

// ── 不变量 ③ 同数：SOP 里的验收步数与两处对它的引用 ──────────────────────────
// 步数**从文本里数出来**：guide 那一行数 ①-⑩；SKILL §3 数列表项。两个数必须相等（同一份 SOP
// 的同一段流程写成两份、条数不同＝有人在读旧版）。同时：两处写的「≤N 次/章」必须相等，
// 且验收步数声明处写的步数必须等于数出来的值——"3 次"这条指标的真正风险是被拿来砍流程。
{
  const libUrl = pathToFileURL(path.join(PLUGIN, 'lib', 'novelist.js')).href
  let mod
  try { mod = await import(libUrl) } catch (e) { die('③ 导入 lib/novelist.js 失败：' + e.message) }
  const guide = mod._internals && mod._internals.SECTION && mod._internals.SECTION.text
  if (!guide) die('③ lib/novelist.js 的 SECTION.text 取不到')

  const CIRCLED = /[①②③④⑤⑥⑦⑧⑨⑩]/g
  const gLine = guide.split('\n').find((l) => /^一章收束验收（全过才算写完）：/.test(l))
  if (!gLine) die('③ guide 里找不到「一章收束验收（全过才算写完）：」那一行——别猜，先看文本')
  const gSteps = ((gLine.split('。')[0].match(CIRCLED)) || []).length
  if (gSteps < 2) die('③ guide 的验收行只数出 ' + gSteps + ' 步（期望 ≥2）——编号形态变了？')

  const skillDir = path.join(TPL, 'skills')
  const skills = (fsSync.existsSync(skillDir) ? fsSync.readdirSync(skillDir) : [])
    .map((d) => path.join(skillDir, d, 'SKILL.md')).filter((p) => fsSync.existsSync(p))
  const skHits = skills.filter((p) => /^name:\s*novel-editorial\s*$/m.test(read(p)))
  if (skHits.length !== 1) die('③ 按 frontmatter name=novel-editorial 在 ' + skills.length + ' 份 SKILL.md 里命中 ' + skHits.length + ' 份（期望 1）')
  const sk = read(skHits[0])
  const secStart = sk.split('\n').findIndex((l) => /^##\s*3\.\s*一章收束验收/.test(l))
  if (secStart === -1) die('③ ' + REL(skHits[0]) + ' 里找不到「## 3. 一章收束验收」小节')
  const rest = sk.split('\n').slice(secStart + 1)
  const secEnd = rest.findIndex((l) => /^##\s/.test(l))
  const body = (secEnd === -1 ? rest : rest.slice(0, secEnd))
  const skSteps = body.filter((l) => /^\s*\d+\.\s/.test(l)).length
  if (skSteps < 2) die('③ SKILL 的验收小节只数出 ' + skSteps + ' 条列表项（期望 ≥2）')
  if (gSteps !== skSteps) {
    violations.push('③ 同数：同一段「一章收束验收」在 guide 里是 ' + gSteps + ' 步、在 ' + REL(skHits[0]) + ' 里是 ' + skSteps + ' 条——两份 SOP 已经不同版，照哪份做都对不上另一份')
  }

  const bound = (t) => (t.match(/≤\s*(\d+)\s*次\/章/) || [])[1]
  const bg = bound(guide), bs = bound(sk)
  if (!bg) die('③ guide 里找不到「≤N 次/章」这条指标（口径改了？本规则要跟着改，别静默失效）')
  if (!bs) die('③ ' + REL(skHits[0]) + ' 里找不到「≤N 次/章」这条指标')
  if (bg !== bs) violations.push('③ 同数：手工调用目标 guide 写 ≤' + bg + ' 次/章、SKILL 写 ≤' + bs + ' 次/章——同一个指标两个值')

  // 两处提到"验收另有 N 步"时，N 必须等于**数出来**的步数——这是唯一还允许手写的数，
  // 且被现读数核住（加一条验收步而忘了改这个数 ⇒ 红）。
  // 标记「另有 N 步」是机器依赖的措辞：标记消失即 exit 2，不许静默失效（这是本仓对
  // "模式失配→空转→报绿"那条老病的标准治法）。
  const MARK = /另有\s*(\d+)\s*步/
  for (const [who, t] of [['guide', guide], [REL(skHits[0]), sk]]) {
    const m = t.match(MARK)
    if (!m) die('③ ' + who + ' 里找不到「另有 N 步」这个标记——它把"验收步数"与"手工调用目标"分开；' +
      '标记没了本规则就静默失效，宁可红（改口径时同步改本脚本的 MARK）')
    if (Number(m[1]) !== gSteps) {
      violations.push('③ 同数：' + who + ' 里写着「另有 ' + m[1] + ' 步」，而文本里数出来是 ' + gSteps + ' 步——' +
        '手写的数与流程本身不符（"按 3 次砍掉验收"那条风险就是这个形状）')
    }
  }
  notes.push('③ 同数：验收步数 guide=' + gSteps + ' / SKILL=' + skSteps + ' 条（互核一致，声明处均写 ' + gSteps + ' 步）· 手工调用目标 ≤' + bg + ' 次/章（两处一致）')
}

// ── 不变量 ④ 写手侧数字四分界：参照卡里不许出现"会被当成目标"的量 ──────────────
// 病根（2026-09-22 实测，代价当场可测）：派工包里写「对话占比 ≥ 35%」，交回来的验证稿
// 三项全部朝目标过冲（对话占比 45.8%、段均 1.4 行）——**指标对了、语域错了**。
// 机制＝extremal Goodhart：从语料观测出的分布性质一旦变成逐句目标，写手会去凑比例、牺牲真语域。
// 治法不是"这次别写"，是**让写回去这件事报红**——参照卡是派工包里唯一从仓里全文贴进去的件，
// 它可机器检查。**边界（不许让人以为闸门管住了全部）：任务书正文是运行时拼的，本规则管不到，
// 那一段靠 guide 里的纪律条款。**
//
// 四分界（写手侧的合法形状只有前两种）：
//   ① 结构节拍（何事何时发生：300 字内进主题／章末留卡点）＝可以
//   ② 形态上限（"不许超过"：句 ≤20 字／段 ≤5 行）＝可以
//   ③ 篇幅配比（描写占比 X–Y%）＝只进审校侧
//   ④ 文本表层统计（对话占比／句长中位／短句占比）＝不许
// 机器判据故意只拉一条线：**卡里出现百分比，或分布词旁边带数字——即红**。
// 为什么不枚举句式：枚举出来的清单永远缺一项，而这条线只有一端（写手侧）在守。
// 为什么"分布词"还要再要求带数字：卡自身的第六节写着"本卡不含句长/占比类数字"——
// 宽判会把这句声明本身打红（**实测过**：第一版没有数字要求，四张卡里三张被自己的声明打红）。
// **已知可绕**：写成中文数字（"三成五"）能过。绊线的目的是让"顺手写回去"变难，不是防蓄意绕过——
// 这条限度写在输出里，不假装它是完备的。
{
  // 扫描面＝**真源**（改卡发生的地方）；扁平布局（公开仓 clone／CI）下真源也在插件自己身上。
  // 派生传播（真源 → 实例 → 公开）由 vault-sync-check 管："改了真源忘了派生"该在那里报红，
  // 不该在这里报成"内容违规"——两个守卫各报各的病，混在一起人就看不出该动哪一步。
  const ROOT_TPL_CARDS = path.join(ROOT, 'dsh-native', 'vault-template', 'craft', 'author-cards')
  const CARD_DIR = fsSync.existsSync(ROOT_TPL_CARDS) ? ROOT_TPL_CARDS : path.join(PLUGIN, 'craft', 'author-cards')
  if (!fsSync.existsSync(CARD_DIR)) {
    // 「没有参照卡目录」＝这一条**没查**，不是"零违规"。两个消费者都得看得见，所以打 ○ 登记行。
    // 但不 exit 2：老 checkout 与精简夹具里这个目录本就不存在，为它把整条守卫判成"没检查成"，
    // 会把另外三组的信号一起带走（**实测踩到过**：回归夹具没有 craft/，五条用例一起红成 exit 2）。
    notes.push('○ ④ 写手侧数字：本根没有参照卡目录（' + REL(CARD_DIR) + '）——**本条登记为跳过、未查**（不是"零违规"）')
  } else {
  const files = mdFilesIn(CARD_DIR)
  if (files.length < 3) die('④ 参照卡目录只扫到 ' + files.length + ' 件（期望 ≥3）：' + REL(CARD_DIR) + ' ——0 件不等于干净')
  // 目录里有两类件：**卡本体**（进派工包，受本规则约束）与 `_` 开头的**建卡纪律/使用说明**
  // （给编辑看的说明件，不进包，故不约束——但它们必须还在：声明处就在它们里面）。
  const isCard = (p) => !path.basename(p).startsWith('_')
  const cards = files.filter(isCard)
  const docs = files.filter((p) => !isCard(p))
  if (cards.length < 2) die('④ 真卡只剩 ' + cards.length + ' 件（期望 ≥2）——目录里只剩下划线开头的说明件了？')
  if (docs.length === 0) die('④ 卡目录里一份 `_` 开头的建卡纪律/使用说明都没有——本规则的声明处就在那里，它没了规则只剩守卫')

  // 分布统计的判据形态：统计词**右侧紧邻数字**（允许中间夹 ≤4 个非汉字字符：空格/比较符/斜杠）。
  // 为什么不能只看到"占比/比例"就报：中文散文里这些词是普通用词（实测踩到过——
  // 第一版规则把卡里"写手会去凑比例、牺牲真语域"这句解释打成了违规）。**要抓的是"指标"这个形状，
  // 不是这些字本身**；写成"占比 ≥ 35""中位 8–9""句均 7.1 字"才是指标。
  const STAT_NUM = /(?:占比|比例|中位|句均|平均句长)[^\u4e00-\u9fff]{0,4}\d/
  let scannedLines = 0
  let upperBoundSeen = 0
  for (const f of cards) {
    const lines = read(f).split('\n')
    scannedLines += lines.length
    lines.forEach((l, i) => {
      if (/(?:≤|不超过|上限)\s*\d+\s*[字行]/.test(l)) upperBoundSeen++          // 允许面：上限式禁令
      if (/[%％]/.test(l)) {
        violations.push('④ 写手侧数字：' + REL(f) + ':' + (i + 1) + ' 卡里出现百分比——篇幅配比与文本表层统计两类的共同形状，' +
          '两者都已被划出写手侧（写手会把它们当成目标去凑）\n      ' + l.trim().slice(0, 160))
      } else {
        const m = l.match(STAT_NUM)
        if (m) {
          violations.push('④ 写手侧数字：' + REL(f) + ':' + (i + 1) + ' 卡里出现分布统计指标（' + m[0] + '）——同一条边界\n      ' + l.trim().slice(0, 160))
        }
      }
    })
  }
  if (scannedLines < 50) die('④ 卡本体只扫到 ' + scannedLines + ' 行（期望上百行）——读空了？')
  if (upperBoundSeen === 0) {
    violations.push('④ 允许面消失：全部卡里找不到一条上限式禁令（≤N 字 / ≤N 行）——写手侧唯一合法的数字形状不见了。' +
      '若这批卡本就全是语域卡（形态卡另存别处），请改本脚本的允许面断言，别让它静默通过')
  }

  // 声明处：规则必须写在**两个消费者读得到的地方**（主编读 guide、建卡人读纪律件），
  // 否则闸门红了也没人知道该怎么改。标记消失即 exit 2——本仓对"模式失配→空转→报绿"
  // 那条老病的标准治法（同不变量③ 的 MARK）。
  const MARK = '文本表层统计'
  const libUrl2 = pathToFileURL(path.join(PLUGIN, 'lib', 'novelist.js')).href
  const mod2 = await import(libUrl2)
  const guide2 = mod2._internals && mod2._internals.SECTION && mod2._internals.SECTION.text
  if (!guide2) die('④ lib/novelist.js 的 SECTION.text 取不到（与③ 同因）')
  if (!guide2.includes(MARK)) {
    die('④ guide（主编读的那份）里找不到声明标记「' + MARK + '」——规则只剩守卫，读者看不到，闸门红了也不知道怎么改')
  }
  if (!guide2.includes('不进写手派工包')) {
    die('④ guide 里找不到「不进写手派工包」这条口径——它把"这些量归审校侧"说清楚；少了它，读者只看到禁令看不到去处')
  }
  const decl = docs.find((p) => read(p).includes(MARK))
  if (!decl) die('④ ' + REL(CARD_DIR) + ' 下的建卡纪律/使用说明里找不到声明标记「' + MARK + '」')

  notes.push('④ 写手侧数字：卡本体 ' + cards.length + ' 件 / ' + scannedLines + ' 行零命中（面＝' + REL(CARD_DIR) + '）；上限式禁令 ' + upperBoundSeen +
    ' 处（允许面在场）· 声明处＝guide ＋ ' + path.basename(decl) +
    '（不约束 ' + docs.length + ' 件 `_` 说明件；**任务书正文运行时拼，本规则管不到**；中文数字可绕过，绊线不防蓄意）')
  }
}

// ── 输出 ────────────────────────────────────────────────────────────────────
console.log('')
console.log('══════ 文本层不变量（人格义务句 / 跨文件同句 / SOP 同数 / 写手侧数字四分界）══════')
// 登记为跳过的条（`○` 开头）原样打出，不加 ✓——「没查」不许看起来像「查过了」。
for (const n of notes) console.log(n.startsWith('○') ? '  ' + n : '  ✓ ' + n)
if (violations.length) {
  console.log('')
  console.error('✗ ' + violations.length + ' 条不变量被破坏：')
  for (const v of violations) console.error('  - ' + v)
  process.exit(1)
}
console.log('')
const skipped = notes.filter((n) => n.startsWith('○')).length
if (skipped) {
  console.log('  · 通过的是 ' + (notes.length - skipped) + ' 组；另有 ' + skipped + ' 组**登记为跳过、未查**（见上面的 ○ 行）——不写成"全部成立"')
} else {
  console.log('  ✓ 四组不变量全部成立（扫描面 ' + personaFiles.length + ' 件人格/派工文本 + guide + SKILL + 参照卡）')
}
process.exit(0)
