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
 * 3. **陈旧门** ＝ `--check` 逐文件比内容 sha256 —— 定义是**热加载**的，"装的时候对过"不作数。
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

// ── 仓根：与 wb-package-check / build-wb-expert 同源的判据（取最外层命中者）
function findRoot(start) {
  let cur = path.resolve(start)
  for (;;) {
    const isPlugin = existsSync(path.join(cur, 'wb-expert-starter')) && existsSync(path.join(cur, 'lib'))
    if (isPlugin) return cur
    const up = path.dirname(cur)
    if (up === cur) return null
    cur = up
  }
}
const ROOT = path.resolve(opt('--root') || process.env.NF_REPO_ROOT || findRoot(HERE) || '')
if (!ROOT || !existsSync(path.join(ROOT, 'roles', 'tool-face.json'))) {
  die('找不到插件仓根（含 roles/tool-face.json 的那一层）', '用 --root <插件仓根> 或环境变量 NF_REPO_ROOT 指定')
}
const PKG = path.join(ROOT, 'wb-expert-starter')
const sha256 = (t) => createHash('sha256').update(t, 'utf8').digest('hex').slice(0, 16)

// 能力表先读（坐标写死在表里，不写进本脚本源码：路径含中文，而约定一致性棘轮禁止代码里出现中文路径字面量）
const TABLE = (() => {
  try { return JSON.parse(readFileSync(path.join(ROOT, 'roles', 'tool-face.json'), 'utf8')) } catch (e) {
    die('能力表读不了：' + e.message)
  }
})()
const LEDGER_PATH = TABLE.hosts && TABLE.hosts.codebuddy && TABLE.hosts.codebuddy.carrier_ledger
if (!LEDGER_PATH) die('能力表缺 hosts.codebuddy.carrier_ledger——它是"宿主载体封名单在哪"的唯一声明', '补进 roles/tool-face.json 后重跑生成器')
const LEDGER = path.join(PKG, LEDGER_PATH)
if (!existsSync(LEDGER)) {
  die('缺宿主载体封名单派生件：' + LEDGER_PATH,
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
  const ok = new Set(), forbidden = new Set()
  for (const cap of Object.values(TABLE.capabilities || {})) {
    for (const leaf of Object.values(cap.codebuddy || {})) {
      if (!leaf || typeof leaf !== 'object') continue
      for (const n of leaf.tools || []) ok.add(n)
      for (const n of leaf.ineffective || []) forbidden.add(n)   // 实测拦不住的真名字
      for (const n of leaf.candidates || []) forbidden.add(n)    // 只是候选，没核过
    }
  }
  if (!ok.size) die('能力表里没有任何 CodeBuddy 工具名（0 件不等于没问题）')
  for (const [rid, entry] of Object.entries(PAYLOAD.roles)) {
    for (const n of entry.denyNames || []) {
      if (forbidden.has(n)) die('角色 ' + rid + ' 的封名单里有「' + n + '」——它是**已实测拦不住 / 仅候选**的名字（能力表里落在 ineffective/candidates）⇒ 拒渲。' +
        '写进去只会得到虚假的约束感：名单上看着封了，调用照跑。', '重跑生成器 node roles/build-tool-face.mjs；生成器还吐它，那是生成器的 bug')
      if (!ok.has(n)) die('角色 ' + rid + ' 的封名单里有「' + n + '」——能力表里任何一处的 tools 都没有这个名字（拼错了？还是抄了别的宿主的名字？）⇒ 拒渲。' +
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
function render(rid, entry) {
  if (!entry.agentdef) die('角色 ' + rid + ' 没登记 codebuddy.agentdef——' +
    '没登记载体就不许装（"装到哪"没答，装出来的东西没人读）', '在 ' + PAYLOAD._source + ' 里补 agentdef 后重跑生成器')
  if (!entry.sourceText) die('角色 ' + rid + ' 没登记 codebuddy.file（正文源）')
  if (!entry.description) die('角色 ' + rid + ' 缺 codebuddy.description——前言块的 description 是宿主查表时显示的那句话，空着等于没名字')

  const src = [path.join(PKG, entry.sourceText), path.join(ROOT, entry.sourceText)].find((c) => existsSync(c))
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
console.log('[install-wb-agents] 名单来源：' + LEDGER_PATH + '（生成件）')
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
      console.log('      ⚠ 缺口：「' + (s.names || []).join('」「') + '」实测**拦不住**（写进去它照样执行）⇒ 不渲，如实标注')
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
  let drift = 0, missing = 0
  for (const p of plan) {
    if (!existsSync(p.dest)) { console.log('  ✗ 缺文件：' + path.basename(p.dest) + '（还没装过）'); missing++; continue }
    const onDisk = readFileSync(p.dest, 'utf8')
    if (onDisk === p.content) console.log('  ✓ ' + path.basename(p.dest) + ' 与真源一致')
    else { console.log('  ✗ ' + path.basename(p.dest) + ' **与真源不一致**（热加载 ⇒ 载体随时可能是旧的那份：装了以后改过真源、或有人手改过载体）'); drift++ }
  }
  if (drift || missing) {
    console.log('\n✗ 陈旧/缺失 ' + (drift + missing) + ' 件。跑一次不带 --check 的安装：')
    console.log('  node scripts/install-wb-agents.mjs --dir "' + DIR + '"')
    process.exit(1)
  }
  console.log('\n✓ 全部 ' + plan.length + ' 件与真源一致（陈旧门通过）')
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
console.log('  定义是**热加载**的——不需要重启宿主，但也因此**没有"装过就算数"**：改真源后重跑本工具，或跑 --check 验陈旧。')
console.log('  回滚：删掉上述 ' + plan.length + ' 个文件即可（本工具不碰目录里别人的文件）。')
