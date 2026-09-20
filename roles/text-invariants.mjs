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
 * ── 三组不变量，各自的病根
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

// ── 输出 ────────────────────────────────────────────────────────────────────
console.log('')
console.log('══════ 文本层不变量（人格义务句 / 跨文件同句 / SOP 同数）══════')
for (const n of notes) console.log('  ✓ ' + n)
if (violations.length) {
  console.log('')
  console.error('✗ ' + violations.length + ' 条不变量被破坏：')
  for (const v of violations) console.error('  - ' + v)
  process.exit(1)
}
console.log('')
console.log('  ✓ 三组不变量全部成立（扫描面 ' + personaFiles.length + ' 件人格/派工文本 + guide + SKILL）')
process.exit(0)
