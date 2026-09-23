#!/usr/bin/env node
/**
 * install-wb-agents.mjs —— 把七个角色的 agent 定义从真源渲进**宿主载体目录**（B1，2026-09-22）
 *
 * 用法：
 *   node scripts/install-wb-agents.mjs --dir <宿主 agents 目录>              # 装 / 更新
 *   node scripts/install-wb-agents.mjs --dir <目录> --check                  # 陈旧门（只读，不写盘）
 *   node scripts/install-wb-agents.mjs --dir <目录> --dry-run                # 只打印要写什么
 *   node scripts/install-wb-agents.mjs --print reader                        # 打印某个角色的渲好全文
 *
 * 不给 --dir 时的默认：`${CODEBUDDY_CONFIG_DIR || ~/.codebuddy}/agents`
 *   ⚠ WorkBuddy 装机把该环境变量指向**宿主自己的配置目录**（不叫 `.codebuddy`），而裸 shell 读不到它
 *   ⇒ 默认值在那种机器上会落到宿主**不读**的位置。**推荐显式给 --dir**；给错目录的后果是"装了但没人读"。
 *
 * ── 为什么分三层（不许合并）─────────────────────────────────────────────
 * 1. **人格文本** ＝ 包内 `agents/*.md`（主笔/主编）或 `references/roles/*.md`（五个工种）
 *      —— **不带封名单**。理由：官方校验器对前言块做**子串**判断（出现 `tools:` 即报错），
 *      而 `disallowedTools:` 含该子串 ⇒ 封名单渲进包内 MD 会**立刻不合规**。
 * 2. **宿主载体** ＝ 本工具渲的 `<dir>/<role>.md` —— 前言块 + 封名单（名字来自生成器的派生件，
 *      **只渲 enforced**；实测拦不住的名字不渲，但会在输出里当缺口印出来）。
 * 3. **陈旧门** ＝ `--check` 逐文件比内容 sha256。⚠ **它只管盘上**：验的是"载体文件与真源一致不一致"，
 *      **验不出"宿主内存里还在用旧的那一版"**——两件事必须分开说（见下）。
 *
 * ── 装盘 ≠ 生效（2026-09-23 WB 侧同文件 A/B 定案，别写错）────────────────
 * **新增一份新定义（新路径）＝即时生效**（同会话内零重启即可派起来）；
 * **改动已有定义的内容＝不生效，必须重启宿主**（`AgentLoader.loadFromPaths` 有一条按路径的
 * `already loaded, skipping` 去重，内容冻结在首次读取的那一版）。
 * ⇒ 纪律照这个写：**「改真源 → 重跑安装器 → 重启宿主 → 重跑 --check 验哈希」**；
 *   只有「新增一份新角色」才不需重启。**别写"改完即生效"**——那是两句承诺里错的那一句。
 *
 * 本工具**不决定封什么**：名单只是消费 `roles/build-tool-face.mjs` 的派生件
 * （`wb-expert-starter/references/宿主载体封名单.json`）。安装器自己再算一遍＝第二份实现＝下一次漂移。
 *
 * 退出码：0 = 已装 / 一致；1 = `--check` 发现漂移或缺文件；2 = **没检查成**（真源缺、锚点找不到、目录写不了）
 *   —— 2 不是 0：没检查成不许报成通过。
 */
import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs'
import { createHash } from 'node:crypto'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const argv = process.argv.slice(2)
const opt = (n) => { const i = argv.indexOf(n); return i !== -1 ? argv[i + 1] : null }
const CHECK = argv.includes('--check')
const DRY = argv.includes('--dry-run')
const HERE = path.dirname(fileURLToPath(import.meta.url))

function die(msg, hint) {
  console.error('[install-wb-agents] 没检查成：' + msg + (hint ? '\n  提示：' + hint : ''))
  process.exit(2)
}

// ── 两种运行形态（2026-09-23 补 · 起因＝WB 侧 §5.2 实测：装机侧按我们给的两条命令跑不起来）
// ① **仓侧**（有真源 `roles/tool-face.json`，即开发/门禁场合）：全功能——渲、装、陈旧门，
//    并且**能回答"这份派生件是否等于真源"**（那一步由生成器 `--check` 负责）。
// ② **包侧**（只有装配产物、没有 `roles/`，即拿到专家包的人）：**渲、装、陈旧门照旧能跑**，
//    名单与"永不渲入的名字"都从派生件里读；但**核不了**两件事——"派生件是否等于真源"、
//    "名单里某个名字属于哪一格能力"（两件都缺同一个东西：真源）。
//    ⇒ **包侧模式必须在输出里明说它核不了什么**：否则装机侧会把"全绿"读成"与真源一致"，
//      而那正是本项目反复栽的"绿了，但绿的不是你以为的那件事"。
function findRepoRoot(start) {
  let cur = path.resolve(start)
  for (;;) {
    if (existsSync(path.join(cur, 'roles', 'tool-face.json'))) return cur
    const up = path.dirname(cur)
    if (up === cur) return null
    cur = up
  }
}
/** 包侧形态的判据：`references/carrier-deny.json` 所在的那一层就是包根（装配产物的布局）。 */
function findPackageRoot(start) {
  let cur = path.resolve(start)
  for (;;) {
    const ledger = path.join(cur, 'references', 'carrier-deny.json')
    if (existsSync(ledger)) return { root: cur, ledger }
    const up = path.dirname(cur)
    if (up === cur) return null
    cur = up
  }
}
const EXPLICIT = opt('--root') || process.env.NF_REPO_ROOT
const ROOT = path.resolve(EXPLICIT || findRepoRoot(HERE) || '')
const REPO_MODE = !!ROOT && existsSync(path.join(ROOT, 'roles', 'tool-face.json'))
const PKG_ROOT = REPO_MODE ? path.join(ROOT, 'wb-expert-starter') : (findPackageRoot(EXPLICIT || HERE) || {}).root
const MODE = REPO_MODE ? 'repo' : 'package'
if (!PKG_ROOT) {
  die('两种形态都没命中：既找不到真源（含 `roles/tool-face.json` 的那一层），也找不到装配产物（含 `references/carrier-deny.json` 的那一层）',
    '仓侧用 --root <插件仓根>；包侧用 --root <专家包目录>（或直接 cd 进包里跑）')
}
const sha256 = (t) => createHash('sha256').update(t, 'utf8').digest('hex').slice(0, 16)

// 能力表只在**仓侧**存在（包侧没有 `roles/`）——判据不是"那个目录在不在"，而是这次跑在哪种形态
const TABLE = REPO_MODE
  ? (() => {
      try { return JSON.parse(readFileSync(path.join(ROOT, 'roles', 'tool-face.json'), 'utf8')) } catch (e) {
        die('能力表读不了：' + e.message)
      }
    })()
  : null
// 派生件坐标：仓侧从真源读（那是唯一声明）；包侧按装配产物的固定布局推——**并且在输出里明说这是推出来的**
const LEDGER_REL = TABLE
  ? (TABLE.hosts && TABLE.hosts.codebuddy && TABLE.hosts.codebuddy.carrier_ledger)
  : path.join('references', 'carrier-deny.json')
if (TABLE && !LEDGER_REL) die('能力表缺 hosts.codebuddy.carrier_ledger——它是"宿主载体封名单在哪"的唯一声明', '补进 roles/tool-face.json 后重跑生成器')
const LEDGER = path.join(PKG_ROOT, LEDGER_REL)
if (!existsSync(LEDGER)) {
  die('缺宿主载体封名单派生件：' + LEDGER_REL,
    '先跑生成器：node roles/build-tool-face.mjs（本件由生成器吐，不许安装器自己算）')
}

let PAYLOAD
try { PAYLOAD = JSON.parse(readFileSync(LEDGER, 'utf8')) } catch (e) {
  die('宿主载体封名单解析不了：' + e.message, '重跑生成器 node roles/build-tool-face.mjs')
}
if (!PAYLOAD || !PAYLOAD.roles || !Object.keys(PAYLOAD.roles).length) die('宿主载体封名单里没有任何角色（0 件不等于没问题）')

// ── 对**派生件本身**的 fail-closed 核对
// 为什么安装器还要再核一遍：生成器管的是"生成时对不对"，而写进宿主的是**盘上这个文件**——
// 它能被手改、能被半截写入、能从旧版本捡回来。写盘的那一方必须自己判一次，否则"只渲 enforced"
// 就只是一句关于生成器的承诺，不是关于**这次装的东西**的保证。
{
  const forbidden = new Set(), ok = new Set()
  let okSource = ''
  if (REPO_MODE) {
    for (const cap of Object.values(TABLE.capabilities || {})) {
      for (const leaf of Object.values(cap.codebuddy || {})) {
        if (!leaf || typeof leaf !== 'object') continue
        for (const n of leaf.tools || []) ok.add(n)
        for (const n of leaf.ineffective || []) forbidden.add(n)   // 实测拦不住的真名字（C 桶）
        for (const n of leaf.costly || []) forbidden.add(n)        // 拦得住但有代价（B 桶）：按纪律也不进名单
        for (const n of leaf.candidates || []) forbidden.add(n)    // 只是候选，没核过
      }
    }
    if (!ok.size) die('能力表里没有任何 CodeBuddy 工具名（0 件不等于没问题）')
    okSource = '能力表里任何一处的 tools'
  } else {
    // 包侧：没有真源，"永不渲入的名字"只能来自派生件自带的那一节。**缺了就必须拒跑**——
    // 少这一节，这道核对会退化成"每个名字都在它自己的并集里"的恒真式（表观全绿、实际没核）。
    const f = PAYLOAD._forbidden
    if (!Array.isArray(f) || !f.length) {
      die('包侧形态缺 `_forbidden`（派生件里那份"永不渲入名单"的名字集）——没它这道拒渲核对形同虚设',
        '包侧算不出它（需要真源）⇒ 在仓里重跑生成器，让派生件带上这一节')
    }
    for (const n of f) forbidden.add(n)
    for (const e of Object.values(PAYLOAD.roles)) for (const n of e.denyNames || []) ok.add(n)
    okSource = '本件各角色名单的并集（**弱判据：只说明"这份件自洽"，不说明"这个名字属于哪一格能力"**）'
  }
  for (const [rid, entry] of Object.entries(PAYLOAD.roles)) {
    for (const n of entry.denyNames || []) {
      if (forbidden.has(n)) die('角色 ' + rid + ' 的封名单里有「' + n + '」——它是**已实测拦不住 / 拦得有代价 / 仅候选**的名字（' +
        (REPO_MODE ? '能力表里落在 ineffective/costly/candidates' : '派生件 `_forbidden`') + '）⇒ 拒渲。' +
        '写进去只会得到虚假的约束感：名单上看着封了，调用照跑。', '重跑生成器 node roles/build-tool-face.mjs；生成器还吐它，那是生成器的 bug')
      if (!ok.has(n)) die('角色 ' + rid + ' 的封名单里有「' + n + '」——' + okSource + ' 里都没有这个名字（拼错了？还是抄了别的宿主的名字？）⇒ 拒渲。' +
        '本形态的教训：名字不存在时宿主**不报错**，那条 deny 是静默空转。')
    }
    for (const e of entry.exempted || []) {
      if (!e.cid || !String(e.why || '').trim()) die('角色 ' + rid + ' 的豁免项缺 cid 或 why——' +
        '豁免是"换宿主换理由"的地方：没理由的豁免就是漏封，静默少封一个名字＝虚假的安全感')
    }
  }
}

// ── 载体目录
const DIR_FLAG = opt('--dir')
const DIR = DIR_FLAG
  ? path.resolve(DIR_FLAG)
  : path.join(process.env.CODEBUDDY_CONFIG_DIR && process.env.CODEBUDDY_CONFIG_DIR.trim()
    ? process.env.CODEBUDDY_CONFIG_DIR.trim()
    : path.join(os.homedir(), '.codebuddy'), 'agents')
const DIR_HOW = DIR_FLAG
  ? '--dir 显式指定'
  : (process.env.CODEBUDDY_CONFIG_DIR && process.env.CODEBUDDY_CONFIG_DIR.trim()
    ? '环境变量 CODEBUDDY_CONFIG_DIR'
    : '默认 ~/.codebuddy（**裸 shell 读不到宿主的 CODEBUDDY_CONFIG_DIR**，WorkBuddy 装机上这个默认值多半是错的）')

// ── 渲染（正文源 → 前言块 + 正文）
const ANCHOR = '## 人格'
// 渲染来源的**布局标记**：写进载体、`--check` 时读回来。
// 为什么必须有它（2026-09-23 实测当场撞出来的）：装配器会把「源仓坐标」改写成「包内坐标」，
// 于是**同一个人格在两个布局下渲出来不是逐字相同**。没有这个标记，包侧 `--check` 会把
// 「换了个布局渲的」报成「陈旧」，而读的人会照着提示**重装**——那会把载体静默换成另一种坐标。
const LAYOUT = REPO_MODE ? '仓内' : '包内'
function render(rid, entry) {
  if (!entry.agentdef) die('角色 ' + rid + ' 没登记 codebuddy.agentdef——' +
    '没登记载体就不许装（"装到哪"没答，装出来的东西没人读）', '在 ' + PAYLOAD._source + ' 里补 agentdef 后重跑生成器')
  if (!entry.sourceText) die('角色 ' + rid + ' 没登记 codebuddy.file（正文源）')
  if (!entry.description) die('角色 ' + rid + ' 缺 codebuddy.description——前言块的 description 是宿主查表时显示的那句话，空着等于没名字')

  // 正文源的解析顺序随形态：包侧只在包内找（`ROOT` 在包侧是"用户给的 --root"，指过去可能撞上不相关目录里的同名文件）
  const cands = [path.join(PKG_ROOT, entry.sourceText)]
  if (REPO_MODE) cands.push(path.join(ROOT, entry.sourceText))
  const src = cands.find((c) => existsSync(c))
  if (!src) die('正文源不存在：' + entry.sourceText + '（包模板与仓根下都找不到）')
  const text = readFileSync(src, 'utf8')
  const at = text.indexOf('\n' + ANCHOR)
  if (at === -1) die(entry.sourceText + ' 里找不到锚点 `' + ANCHOR + '`——' +
    '人格段的位置是渲染的基准，找不到就不许猜（猜错的位置会把别段当人格渲进去）')
  const body = text.slice(at + 1)      // 从 `## 人格` 起，含它

  const fm = ['---', 'name: ' + rid, 'description: ' + entry.description]
  if (entry.maxTurns) fm.push('maxTurns: ' + entry.maxTurns)
  if (entry.denyNames.length) fm.push('disallowedTools: [' + entry.denyNames.join(', ') + ']')
  fm.push('---')

  const head = [
    '',
    '# ' + entry.zh + '（' + rid + '）',
    '',
    '> 本文件由 `scripts/install-wb-agents.mjs` 从包内真源渲染：**人格**来自 `roles/persona/`（生成件），' +
      '**封名单**来自 `roles/tool-face.json` 的能力表。**勿手改**——改了 `--check` 会报陈旧。',
    '> 渲染来源：**' + LAYOUT + '** · 正文源 `' + entry.sourceText + '`（源文本 sha256 ' + sha256(text) + '）。' +
      '⚠ 这个标记是给 `--check` 用的：**装配器会把源仓坐标改写成包内坐标**，所以同一个人格在两个布局下**不是逐字相同**；' +
      '有了它，`--check` 才能把「换布局渲的」与「真陈旧」分开，而不是让人照着一句"重装"把载体悄悄换成另一种坐标。',
    '> 包内那份 `' + entry.sourceText + '` 是**人格文本的权威来源**，它**不带封名单**（官方校验器禁止 `disallowedTools` 出现在包内 MD）；' +
      '封名单只活在宿主载体里，也就是本文件。',
    '',
  ]
  return fm.join('\n') + '\n' + head.join('\n') + '\n' + body
}

const plan = []
for (const [rid, entry] of Object.entries(PAYLOAD.roles)) {
  const content = render(rid, entry)
  const dest = path.join(DIR, path.basename(entry.agentdef))
  plan.push({ rid, entry, dest, content, sha: sha256(content) })
}

if (opt('--print')) {
  const one = plan.find((p) => p.rid === opt('--print'))
  if (!one) die('没这个角色：' + opt('--print') + '（有：' + plan.map((p) => p.rid).join(' / ') + '）')
  process.stdout.write(one.content)
  process.exit(0)
}

// ── 输出：每个角色一句话 + 缺口 + 豁免（都要看得见）
console.log('[install-wb-agents] 载体目录：' + DIR + '（来自' + DIR_HOW + '）')
console.log('[install-wb-agents] 名单来源：' + LEDGER_REL + '（生成件）')
console.log('[install-wb-agents] 运行形态：' + (REPO_MODE
  ? '仓侧（有真源 `roles/tool-face.json`）——可核「派生件 == 真源」？**不核**：那是生成器 `--check` 的活，本工具只消费派生件'
  : '包侧（只有装配产物，没有 `roles/`）'))
if (!REPO_MODE) {
  console.log('  ⚠ 包侧形态**核不了**两件事，别把这里的全绿读成"与真源一致"：')
  console.log('     ① 这份派生件是否等于真源（那需要 `roles/`，本机没有）；')
  console.log('     ② 名单里某个名字属于哪一格能力（同一个原因）⇒ 本模式只剩"' + '「不含永不渲入的名字」' + '"这一道硬核对。')
  console.log('     要核这两件：在带真源的仓里跑 `node roles/build-tool-face.mjs --check`。')
}
console.log('')
for (const p of plan) {
  const e = p.entry
  console.log('  ' + e.zh.padEnd(6) + ' ' + path.basename(p.dest).padEnd(18) +
    ' 形态=' + String(e.form).padEnd(9) + ' 封 ' + String(e.denyNames.length).padStart(2) + ' 名' +
    (e.exempted.length ? ' ｜ 本形态有意不封 ' + e.exempted.length + ' 项' : ''))
  for (const x of e.exempted) {
    console.log('      · 不封「' + x.cid + '」' + (x.names.length ? '（' + x.names.join('/') + '）' : '') + '——' + x.why.split('。')[0] + '。')
  }
  for (const s of e.skipped) {
    if (s.status === 'ineffective') {
      console.log('      ⚠ 缺口·C 桶：「' + (s.names || []).join('」「') + '」**实测拦不住**（写进去它照样执行）⇒ 不渲，如实标注')
    } else if (s.status === 'costly') {
      // 2026-09-23 补：B 桶（拦得住但每次派工被框架记 failed）。它与 C 桶**不是一回事**——
      // 混着印会让读者把"封住了但有代价"读成"封不住"，然后据此把这一格整个放弃。
      console.log('      ⚠ 缺口·B 桶：「' + (s.names || []).join('」「') + '」**拦得住但有代价**（每次派工被框架记 failed）⇒ 不渲，如实标注')
    } else if (s.status === 'none') {
      console.log('      ○ 空操作：「' + s.cid + '」本形态没有这个工具 ⇒ 禁了不报错也不生效（不是缺口，是没有东西可禁）')
    } else if (s.status) {
      // 2026-09-23 补：登记了却渲不进去的**意图**也要印出来。
      // 不印＝这一座看起来"该封的都封了"，实际那几个工具对它一直开着（静默少封一个名字）。
      console.log('      ⚠ 意图已登记、**尚未生效**（' + s.status + '）：' + s.cid +
        (s.candidates && s.candidates.length ? '（候选名 ' + s.candidates.join('/') + '）' : '') +
        ' ⇒ 名字没进名单之前，该工具对本座**仍然开着**')
    }
  }
}
console.log('')

// ── --check：陈旧门（只读）
if (CHECK) {
  let drift = 0, missing = 0, crossLayout = 0
  // 名单行是**布局无关**的那一半（它由真源派生、装配器不改它）⇒ 跨布局时也能严格比。
  const denyOf = (t) => { const m = t.match(/^disallowedTools: \[(.*)\]$/m); return m ? m[1] : '(无名单)' }
  const layoutOf = (t) => { const m = t.match(/渲染来源：\*\*(仓内|包内)\*\*/); return m ? m[1] : null }
  for (const p of plan) {
    if (!existsSync(p.dest)) { console.log('  ✗ 缺文件：' + path.basename(p.dest) + '（还没装过）'); missing++; continue }
    const onDisk = readFileSync(p.dest, 'utf8')
    const name = path.basename(p.dest)
    if (onDisk === p.content) { console.log('  ✓ ' + name + ' 与真源一致（**盘上**·' + LAYOUT + '）'); continue }
    // 不完全相同：先看**承重的那一半**（名单）。名单不一致＝真陈旧，红。
    if (denyOf(onDisk) !== denyOf(p.content)) {
      console.log('  ✗ ' + name + ' **名单与真源不一致**（真陈旧：改了真源没重装，或有人手改过载体）'); drift++; continue
    }
    // 名单一致、内容不同：要么是同一布局下正文段改过（真陈旧），要么是**换布局渲的**（不是陈旧）。
    const lp = layoutOf(onDisk)
    if (lp && lp !== LAYOUT) {
      console.log('  · ' + name + ' **名单一致**；正文段**跨布局未比**（本机这份是「' + lp + '」渲的，本次按「' + LAYOUT +
        '」比对）——装配器会把源仓坐标改写成包内坐标，两个布局下正文段本就不逐字相同。**这不是陈旧，别照"重装"提示把它换掉**')
      crossLayout++; continue
    }
    console.log('  ✗ ' + name + ' **与真源不一致**（同布局、名单相同、正文段不同：改了真源没重装，或有人手改过载体）'); drift++
  }
  if (drift || missing) {
    console.log('\n✗ 陈旧/缺失 ' + (drift + missing) + ' 件。跑一次不带 --check 的安装：')
    console.log('  node scripts/install-wb-agents.mjs --dir "' + DIR + '"')
    process.exit(1)
  }
  console.log('\n✓ 全部 ' + plan.length + ' 件通过（陈旧门通过，**仅指盘上**）' +
    (crossLayout ? '；其中 ' + crossLayout + ' 件是**跨布局**比对（名单严格比过、正文段未比——见上「·」行）' : ''))
  console.log('  ⚠ 本门验不出"宿主内存里是不是还在用旧的那一版"：**改动已有定义要重启宿主才生效**。')
  console.log('    改过的件若要确认真的在跑，唯一办法是重启后看派工回执里的 `SELF=`／`OBL=` 原文或再取一次工具面读数。')
  process.exit(0)
}

if (DRY) {
  console.log('[--dry-run] 不写盘。以下是将要写入的内容（首 20 行 / 共 N 行）：')
  for (const p of plan) {
    console.log('\n───── ' + p.dest + ' ｜ sha256:' + p.sha + ' ｜ ' + p.content.split('\n').length + ' 行')
    console.log(p.content.split('\n').slice(0, 20).join('\n'))
  }
  process.exit(0)
}

// ── 安装
mkdirSync(DIR, { recursive: true })
let wrote = 0, same = 0
for (const p of plan) {
  const prev = existsSync(p.dest) ? readFileSync(p.dest, 'utf8') : null
  if (prev === p.content) { same++; continue }
  writeFileSync(p.dest, p.content)
  wrote++
  console.log('  ' + (prev === null ? '＋ 新建' : '↻ 更新') + ' ' + path.basename(p.dest) + '（' + p.content.split('\n').length + ' 行 · sha256:' + p.sha + '）')
}
console.log('\n✓ 装好：新建/更新 ' + wrote + ' 件，' + same + ' 件本来就一致 · 目录＝' + DIR)
console.log('  ⚠ **装盘 ≠ 生效**：新增一份新定义即时生效；**改动已有定义的内容要重启宿主**（宿主内存里那一版冻结在首次读取）。')
console.log('     所以改完真源的正规序列是：**重跑本工具 → 重启宿主 → 重跑 --check 验哈希**。')
console.log('  回滚：删掉上述 ' + plan.length + ' 个文件即可（本工具不碰目录里别人的文件）。')
