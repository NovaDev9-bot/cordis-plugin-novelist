#!/usr/bin/env node
/**
 * build-tool-face.mjs —— 从**能力表**生成各宿主的角色工具面（`roles/tool-face.json` → 派生件）
 *
 * 用法：
 *   node roles/build-tool-face.mjs [--host dsh|codebuddy|all] [--check] [--root <仓库根>]
 *
 * 退出码：0=一致（或已写入）/ 1=--check 发现漂移 / 2=表本身不合法或推导不出来
 *
 * ── 为什么要有它（这条是根因，不是背景）
 * 六份 `toolFilter.deny` 名单此前**手写在同一仓的两份预设里**（私有生产预设 + 公开
 * preset-starter），另有一份散文版散在 WB 派工文本里——同一事实三处各活一次。它们的
 * 内容当时逐字相同，所以没人发现问题；而"当时的相同"正是漂移的开始方式：改一处、漏两处，
 * 谁都不会报。跨宿主直抄更糟：`Task` 与 `read_image` 在 CodeBuddy 根本不存在（2026-09-20
 * 一手核实），照抄过去的名单是**静默空转**——看起来封了，其实一条也没封。
 *
 * 所以这里不是"把名单抽出来复用"，是给它一个**类型**：
 *   能力（宿主无关）  →  每个宿主各自的工具真名  →  每份派生件（预设 / 文档）
 * 宿主差异只允许活在各能力的 `dsh` / `codebuddy` 两列里；缺一列＝本脚本拒绝生成。
 *
 * ── 三条判定（都会真的报红，不是装饰）
 * ① 缺列即失败：每个能力对每个宿主都必须有取值（工具名数组 / status:none / status:unverified）。
 *    "缺失没有类型"是本项目 2026-09-18 审计定下的第一性根因——不填、填 null、写错字，
 *    在这里是三种不同的事，必须分别表达。
 * ② 名字必须是实存的：DSH 侧列进 deny 的工具名若不存在，`tools.restrict()` 直接抛错
 *    （挂载期失败）；CodeBuddy 侧写错则是静默空转。故本脚本反向核对——预设里挂了未登记的
 *    插件、插件多出一个没进任何能力的工具、名单里出现表上没有的名字，一律报红。
 * ③ 领域工具名不手写：`novel_*` 一律从 `lib/novelist.js` 的 TOOLS 现读核对，双向全等于表。
 *    加了第 16 个工具而没登记面 → 报"没有任何角色面能封它"。
 */
import { promises as fsp } from 'node:fs'
import fsSync from 'node:fs'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

// 两种落地形态都要认（同 build-wb-expert.mjs 的判据：标记目录，不猜路径）
const MONO_MARKERS = ['dsh-native', 'vault']
const FLAT_MARKERS = ['wb-expert-starter', 'lib']
const argv = process.argv.slice(2)
const opt = (n) => { const i = argv.indexOf(n); return i !== -1 ? argv[i + 1] : null }
const CHECK = argv.includes('--check')
const HOST_ARG = opt('--host') || 'all'
if (!['dsh', 'codebuddy', 'all'].includes(HOST_ARG)) {
  console.error('[tool-face] --host 只认 dsh / codebuddy / all，收到：' + HOST_ARG); process.exit(2)
}

function die(msg, hint) {
  console.error('[tool-face] 拒绝执行：' + msg + (hint ? '\n  提示：' + hint : ''))
  process.exit(2)
}
const isMono = (d) => MONO_MARKERS.every((m) => fsSync.existsSync(path.join(d, m)))
const isFlat = (d) => FLAT_MARKERS.every((m) => fsSync.existsSync(path.join(d, m)))
// 取**最外层**命中的祖先：扁平判据（wb-expert-starter + lib）在 monorepo 里对插件子仓也成立，
// 就近取会把 monorepo 根误判成它自己——于是两份预设只找到一份，而"只找到一份"不报错。
// （本脚本第一版就栽在这：私有生产预设被静默漏掉，输出依旧全绿。）
function findRoot(start) {
  let cur = path.resolve(start)
  let hit = null
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
// --table：只给测试与置换表用（红测要拿一份被改坏的表跑，验证守卫真的会红）。
// 常态一律用仓内真源；写别的路径时下面会打印出来，不静默。
const TABLE_PATH = path.resolve(opt('--table') || path.join(PLUGIN, 'roles', 'tool-face.json'))
if (!fsSync.existsSync(TABLE_PATH)) die('能力表不存在：' + TABLE_PATH)
const TABLE = JSON.parse(fsSync.readFileSync(TABLE_PATH, 'utf8'))
// 文档里引用的真源坐标必须与**布局无关**：mono（check-all）与 flat（WB 装配器）两条路径
// 生成同一份包字节，否则两边永远互相判漂移。插件根相对坐标在两种布局下是同一个串。
const REL_TABLE = path.relative(PLUGIN, TABLE_PATH).split(path.sep).join('/')

const HOSTS = ['dsh', 'codebuddy']
const FORMS = Object.keys((TABLE.hosts.codebuddy || {}).forms || {})
const knownTools = new Set(TABLE.hosts.codebuddy ? TABLE.hosts.codebuddy.known_tools || [] : [])
const ghostTools = new Set(TABLE.hosts.codebuddy ? TABLE.hosts.codebuddy.nonexistent_tools_verified || [] : [])
// ── 推导的原语（提到校验之前：重复登记核对必须按**宿主 × 形态**做，而形态只有解析后才定得下来）
const CAP_ORDER = Object.keys(TABLE.capabilities)
// 解析到"该能力在该宿主该形态下"的那条取值：CodeBuddy 侧键是形态（显式形态优先，`*` 兜底）。
function leafOf(cap, host, form) {
  if (host === 'dsh') return cap.dsh
  const cb = cap.codebuddy
  return cb[form] !== undefined ? cb[form] : cb['*']
}
// ── 1. 表自身的合法性（fail-closed：形状不对就不许往下走）
const errs = []
// 工具名 → 能力：**按宿主 × 形态分桶**。同一名字出现在同一能力的不同形态列里是合法的
// （三形态工具面本就不同：seat 有 Agent、subagent 没有），而落到**同一形态**上的两个能力
// 同时持有它，就是"两处真源"——deny 一个会静默连坐另一个。
const toolOwners = {}   // 'host:form' → Map(工具名 → 能力 id)
const mcpNames = []     // codebuddy 列里形如 mcp__<server>__<tool> 的名字（后置按连接器工具清单校验）
// 「能被 MCP 名封住」的能力全集——本形态 MCP 只能经 ToolSearch→DeferExecuteTool 到达，
// 故封发现面与"还允许其中任何一件"互斥（角色校验里用它做耦合不变量）。
const MCP_CAPS = ['ledger.write', 'ledger.read', 'tape.write', 'ledger.ask', 'decision.write', 'retrieval']
const reportedDupe = new Set()   // 'host:form:工具名'——同一格同一名字只报一次（下面两条通道会同时命中同一处）
const ownerKey = (host, form) => host + ':' + (host === 'dsh' ? '*' : form)
function checkLeaf(v, ctx, host, form, cid) {
  if (v === undefined) {
    errs.push(ctx + ' 缺取值——缺失没有类型：数组＝这些工具名，{"status":"none"}＝本宿主没有这个能力，{"status":"unverified","why":"…"}＝说不清（必须带 why）')
    return
  }
  if (Array.isArray(v.tools)) {
    if (!v.tools.length) errs.push(ctx + ' 的工具名数组是空的（空数组＝没封任何东西，别用空数组表达"没有"）')
    const key = ownerKey(host, form)
    if (!toolOwners[key]) toolOwners[key] = new Map()
    for (const n of v.tools) {
      if (typeof n !== 'string' || !n.trim()) { errs.push(ctx + ' 里有非法工具名：' + JSON.stringify(n)); continue }
      if (host === 'codebuddy') {
        // R-c（WB 侧点名）：「deny 一个不存在的名字必须装配期报红」——两重判定：
        // ①已核实不存在的名字直接拒；②不在官方清单里的名字也拒（拼错、抄错宿主都落在这里）。
        // 只在 DSH 侧靠 restrict() 抛错是不够的：那边是宿主替我们 fail-closed，
        // 这边没有宿主兜底，必须自己收口。
        if (ghostTools.has(n)) errs.push(ctx + ' 里写着 CodeBuddy **不存在**的工具名「' + n + '」——这正是静默空转（看起来封了，其实一条也没封）')
        else if (n.startsWith('mcp__')) {
          // MCP 工具名的"存在性"由**连接器自己的工具清单**定义，不由宿主内置清单定义
          // （宿主内置清单里当然没有 mcp__*）。形状＝mcp__<server>__<tool>；
          // 工具那一段另有后置校验（NOVEL_TOOLS 读进来之后），此处只收口形状。
          const m = /^mcp__([a-z0-9_-]+)__([a-z0-9_]+)$/i.exec(n)
          if (!m) errs.push(ctx + ' 里的「' + n + '」形如 MCP 工具名但形状不合法（应为 mcp__<server>__<tool>）')
          else mcpNames.push({ ctx, name: n, server: m[1], tool: m[2] })
        }
        else if (knownTools.size && !knownTools.has(n)) errs.push(ctx + ' 里的「' + n + '」不在 hosts.codebuddy.known_tools（官方内置工具清单）里——拼错了？还是抄了别的宿主的名字？')
      }
      const prev = toolOwners[key].get(n)
      if (prev) {
        errs.push('工具名「' + n + '」在 ' + key + ' 这一格被能力 ' + prev + ' 与 ' + cid + ' 同时登记——同一形态下两处真源：deny 其中一个会静默连坐另一个')
        reportedDupe.add(key + ':' + n)
      }
      toolOwners[key].set(n, cid)    }
    // ineffective＝**真名字、但实测拦不住**（2026-09-22：`PowerShell` 写进 deny 仍在工具面里、
    // 且调用真的执行了）。它与 tools 互斥，渲染器不渲它，但**必须列进文档当缺口**——
    // 静默列进去＝虚假的约束感；静默丢掉＝下一个人会再写一次。
    if (v.ineffective !== undefined) {
      if (!Array.isArray(v.ineffective) || !v.ineffective.length) errs.push(ctx + '.ineffective 必须是至少一项的数组（它是"实测拦不住的真名字"，不是名单）')
      else for (const n of v.ineffective) {
        if (v.tools.includes(n)) errs.push(ctx + ' 的「' + n + '」同时落在 tools 与 ineffective 里——两者互斥（一个名字要么封得住，要么实测封不住）')
        if (ghostTools.has(n)) errs.push(ctx + '.ineffective 里写着已核实**不存在**的名字「' + n + '」')
        else if (knownTools.size && !knownTools.has(n)) errs.push(ctx + '.ineffective 里的「' + n + '」不在 hosts.codebuddy.known_tools 里——它必须是**真名字**（"拦不住的真名字"才有资格当缺口公开）')
      }
    }
  } else if (v.status === 'none' || v.status === 'unverified' || v.status === 'unknown') {
    if (!v.why || !String(v.why).trim()) errs.push(ctx + ' 写了 status=' + v.status + ' 却没给 why（"没有这个工具"和"没查清"都必须留一句为什么）')
    // candidates＝给实测用的候选名（如 mcp__novelist__novel_chapter）：它不是名单，故不进
    // toolOwners、不参与生成，只出现在文档里——但塞一个已核实不存在的名字进去，等于让下一轮
    // 实测白跑一次，所以也拦。
    if (v.candidates !== undefined) {
      if (!Array.isArray(v.candidates) || !v.candidates.length) errs.push(ctx + '.candidates 必须是至少一项的数组（它是实测候选，不是名单）')
      else for (const c of v.candidates) {
        if (typeof c !== 'string' || !c.trim()) errs.push(ctx + '.candidates 里有非法名：' + JSON.stringify(c))
        else if (ghostTools.has(c)) errs.push(ctx + '.candidates 里写着已核实**不存在**的名字「' + c + '」')
      }
    }
  } else {
    errs.push(ctx + ' 的取值形状不认识：' + JSON.stringify(v))
  }
}
{
  if (TABLE.schema !== 1) errs.push('schema 不是 1')
  if (!FORMS.length) errs.push('hosts.codebuddy.forms 为空（CodeBuddy 侧必须按形态分列：实测三形态工具面不同）')
  if (!knownTools.size) errs.push('hosts.codebuddy.known_tools 为空（没有它就无法对 CodeBuddy 列做 fail-closed 核对）')
  // inert（**存在、但本形态下不可用**）也必须过同一道核：名字要真在官方清单里、形态要存在、why 必填。
  // 不加这道核，这一格就会变成"把没查清的东西塞进一个看起来更严谨的箱子"——
  // 而它存在的全部理由恰恰是**别让读者把惰性读成已封**。
  for (const [i, t] of (TABLE.hosts.codebuddy.inert_tools_verified || []).entries()) {
    const where = 'hosts.codebuddy.inert_tools_verified[' + i + ']'
    if (!t || typeof t.tool !== 'string' || !t.tool.trim()) { errs.push(where + ' 缺 tool'); continue }
    if (knownTools.size && !knownTools.has(t.tool)) errs.push(where + ' 的「' + t.tool + '」不在 known_tools 里——"存在但不可用"的前提是它**存在**')
    if (ghostTools.has(t.tool)) errs.push(where + ' 的「' + t.tool + '」已被列进 nonexistent_tools_verified——两格互斥（一个名字不可能既存在又不存在）')
    if (!FORMS.includes(t.form)) errs.push(where + ' 的 form「' + t.form + '」不是已知形态（' + FORMS.join(' / ') + '）')
    if (!t.why || !String(t.why).trim()) errs.push(where + ' 缺 why（"为什么在你这儿不可用"必须留一句，最好带硬返回原文）')
    if (!t.consequence || !String(t.consequence).trim()) errs.push(where + ' 缺 consequence（"于是该怎么办"——只写不可用不写后果，读者会自己猜）')
  }
  for (const [cid, cap] of Object.entries(TABLE.capabilities || {})) {
    if (!cap.zh) errs.push('能力 ' + cid + ' 缺 zh 说明')
    checkLeaf(cap.dsh, '能力 ' + cid + '.dsh', 'dsh', '*', cid)
    const cb = cap.codebuddy
    if (cb === undefined) { errs.push('能力 ' + cid + ' 缺 codebuddy 列'); continue }
    const keys = Object.keys(cb)
    if (!keys.length) { errs.push('能力 ' + cid + '.codebuddy 是空对象'); continue }
    for (const k of keys) {
      if (k !== '*' && !FORMS.includes(k)) errs.push('能力 ' + cid + '.codebuddy 的键「' + k + '」不是形态（可用 * 兜底，或 ' + FORMS.join(' / ') + '）')
      checkLeaf(cb[k], '能力 ' + cid + '.codebuddy.' + k, 'codebuddy', k, cid)
    }
    // 每个形态都必须能解析到一条取值（显式写，或由 `*` 兜底）——解析不到＝这个能力在这个
    // 形态上"没答"，而不是"不用封"。
    for (const f of FORMS) {
      if (cb[f] === undefined && cb['*'] === undefined) errs.push('能力 ' + cid + ' 在形态 ' + f + ' 上没有任何取值（既没写 ' + f + '，也没有 * 兜底）')
    }
  }
  for (const [rid, r] of Object.entries(TABLE.roles || {})) {
    if (!r.zh) errs.push('角色 ' + rid + ' 缺 zh')
    if (!Array.isArray(r.deny)) { errs.push('角色 ' + rid + ' 缺 deny 数组'); continue }
    for (const c of r.deny) {
      if (!TABLE.capabilities[c]) errs.push('角色 ' + rid + ' 的 deny 里写着「' + c + '」，它不是能力 id——deny 只许写能力（写工具名＝把宿主差异搬回宿主无关层，等于没拆）')
    }
    // 耦合不变量（2026-09-22 WB 侧实测所迫）：本形态 MCP 只能经 ToolSearch→DeferExecuteTool 到达，
    // 所以「封发现面」与「还允许用任何 MCP 工具」在物理上不相容——封了发现面＝该角色一件 MCP 工具都拿不到。
    // 主笔正踩在这条上（它要 novel_bible/novel_search，却曾被 09-20 的权宜封了发现面）。
    if (Array.isArray(r.deny) && (r.deny.includes('tool.search') || r.deny.includes('tool.invoke'))) {
      const missing = MCP_CAPS.filter((c) => !r.deny.includes(c))
      if (missing.length) errs.push('角色 ' + rid + ' 封了发现面（tool.search/tool.invoke），却仍允许 MCP 面能力 ' + missing.join(' / ') +
        '——本形态 MCP 只能经这一对到达：封了发现面＝该角色一件 MCP 工具都拿不到（两处口径打架，装配期拦下）')
    }
    for (const h of HOSTS) if (!r[h]) errs.push('角色 ' + rid + ' 缺 ' + h + ' 列（映射缺一列就是"这个宿主上它是什么"没答）')
    if (r.codebuddy && !FORMS.includes(r.codebuddy.form)) {
      errs.push('角色 ' + rid + '.codebuddy.form 不是已知形态（实得 ' + JSON.stringify(r.codebuddy && r.codebuddy.form) + '）——形态是映射的键，没它就查不出这个角色的面')
    }
  }
}
if (!Object.keys(TABLE.capabilities || {}).length) errs.push('能力表为空')
if (!Object.keys(TABLE.roles || {}).length) errs.push('角色表为空')
// 解析后再核一遍重复登记：上面按**原键**分桶，查不出「`*` 兜底」与「显式形态列」撞在同一形态上的情况。
// 这里用 leafOf（与生成时同一套解析）逐个 (宿主, 形态) 取解析结果再查——同一形态下两处真源，
// deny 一个会静默连坐另一个，那种洞在名单里看不出来。
{
  const resolved = {}
  for (const cid of CAP_ORDER) {
    const cap = TABLE.capabilities[cid]
    if (!cap) continue
    for (const [host, form] of [['dsh', '*']].concat(FORMS.map((f) => ['codebuddy', f]))) {
      const v = leafOf(cap, host, form)
      if (!v || !Array.isArray(v.tools)) continue
      const key = ownerKey(host, form)
      if (!resolved[key]) resolved[key] = new Map()
      for (const n of v.tools) {
        const prev = resolved[key].get(n)
        if (prev && prev !== cid && !reportedDupe.has(key + ':' + n)) {
          errs.push('工具名「' + n + '」在 ' + key + '（**解析后**）被能力 ' + prev + ' 与 ' + cid + ' 同时持有——' +
            '`*` 兜底与显式形态列撞在同一形态上，deny 其中一个会连坐另一个')
        } else resolved[key].set(n, cid)
      }
    }
  }
}
if (errs.length) die('能力表不合法（' + errs.length + ' 条）：\n  ' + errs.join('\n  '), '改 ' + REL_TABLE + ' 后重跑')

// ── 2. 推导：角色 → 该宿主的工具名（按能力声明顺序拼接，顺序稳定＝生成结果可逐字比对）
// 原语 CAP_ORDER / leafOf 定义在校验之前（那里的重复登记核对要用它们）——此处不再重复定义。
function faceOf(roleId, host) {
  const r = TABLE.roles[roleId]
  const form = host === 'codebuddy' ? r.codebuddy.form : null
  const names = []
  const skipped = []      // 本宿主/本形态没有、或还没核实的（要看得见，不是"跳过"）
  for (const cid of CAP_ORDER) {
    if (!r.deny.includes(cid)) continue
    const v = leafOf(TABLE.capabilities[cid], host, form)
    if (Array.isArray(v.tools)) {
      names.push(...v.tools)
      if (Array.isArray(v.ineffective) && v.ineffective.length) skipped.push({ cid, status: 'ineffective', names: v.ineffective, why: v.note || '' })
    }
    else skipped.push({ cid, status: v.status, why: v.why, candidates: v.candidates || [] })
  }
  return { names, skipped, form }
}
const roleIds = Object.keys(TABLE.roles)

// ── 3. DSH 侧：两份预设的外科改写 + 反向核对
const knownByHost = { dsh: new Set(), codebuddy: new Set() }
for (const cid of CAP_ORDER) {
  const d = TABLE.capabilities[cid].dsh
  if (Array.isArray(d.tools)) for (const n of d.tools) knownByHost.dsh.add(n)
  for (const f of ['*'].concat(FORMS)) {
    const cb = TABLE.capabilities[cid].codebuddy[f]
    if (cb && Array.isArray(cb.tools)) for (const n of cb.tools) knownByHost.codebuddy.add(n)
  }
}
// 领域工具名不手写：从 lib/novelist.js 现读，双向核对
let NOVEL_TOOLS = null
let GUIDE_TEXT = null
{
  const lib = path.join(PLUGIN, 'lib', 'novelist.js')
  if (!fsSync.existsSync(lib)) die('缺 lib/novelist.js（领域工具真源）')
  let mod
  try { mod = await import(pathToFileURL(lib).href) } catch (e) { die('导入 lib/novelist.js 失败：' + e.message) }
  NOVEL_TOOLS = ((mod._internals || {}).TOOLS || []).map((t) => t.name)
  GUIDE_TEXT = ((mod._internals || {}).SECTION || {}).text || ''
  if (!GUIDE_TEXT) die('lib/novelist.js 的 SECTION.text 取不到（术语对照的坐标来源——术语表必须由手册现读派生，不许手写）')
  if (!NOVEL_TOOLS.length) die('lib/novelist.js 的 _internals.TOOLS 取不到（工具名真源）')
  const inTable = CAP_ORDER.flatMap((cid) => {
    const v = TABLE.capabilities[cid].dsh
    return Array.isArray(v.tools) ? v.tools.filter((n) => n.startsWith('novel_')) : []
  })
  const missing = NOVEL_TOOLS.filter((n) => !inTable.includes(n))
  if (missing.length) die('领域工具没进任何能力：' + missing.join(', ') +
    '\n  （加了工具而没登记面 ⇒ 没有任何角色的 deny 名单能封住它——这正是"同一事实多处各活一次"的另一面）',
    '在 ' + REL_TABLE + ' 的对应能力里登记；新工具该进哪个能力＝它属于"写账本"还是"读账本"')
  const ghost = inTable.filter((n) => !NOVEL_TOOLS.includes(n))
  if (ghost.length) die('能力表里写着不存在的领域工具：' + ghost.join(', ') +
    '\n  （DSH 侧会抛 `tools.restrict() names unknown global tool`：挂载期直接失败；改名后忘了改表就是这条）')
  for (const n of NOVEL_TOOLS) knownByHost.dsh.add(n)
  console.log('· 领域工具真源：lib/novelist.js 现读 ' + NOVEL_TOOLS.length + ' 个，与能力表双向全等')
  // MCP 名（codebuddy 列）按**连接器自己的工具清单**校验——比宿主内置清单更强的判据：
  // 形状对不代表工具对，写错一个字母就是静默空转（宿主对 deny 名单里不存在的 MCP 名不会报错）。
  if (mcpNames.length) {
    const servers = new Set(mcpNames.map((e) => e.server))
    if (servers.size > 1) die('MCP 名里出现了多个 server 前缀：' + [...servers].join(' / ') +
      '——本包只有一个连接器，多前缀说明有名字抄错了', 'MCP 工具名只有一种合法来源：连接器自己的工具清单')
    const bad = mcpNames.filter((e) => !NOVEL_TOOLS.includes(e.tool))
    if (bad.length) die('MCP 名里的工具段不在连接器工具清单里：' + bad.map((e) => e.name).join(', ') +
      '\n  （连接器现读 ' + NOVEL_TOOLS.length + ' 个：' + NOVEL_TOOLS.join(', ') + '）',
      '改 ' + REL_TABLE + ' 里那几条的名字；名字写错＝deny 一个不存在的 MCP 工具，宿主不报错、静默空转')
    console.log('· MCP 名校验：' + mcpNames.length + ' 条，server=' + [...servers][0] + '，工具段全部命中连接器清单')
  }
}

// ── 术语对照（A2）：术语 → 手册里出现它的那一条 ────────────────────────────────
// 为什么要有它：派工指令里会出现这些词（主编口头常用），而五份派工文本里此前**一个都没有**——
// 2026-09-20 第三方实测（`grep -c`：三原语/章状态机 在主编侧 2 处、在派工文本 0 处）。
// 术语不必背，但要**找得到**：所以坐标（节标题）全部从手册现读，本文件不写一个字面。
// 选词是编辑决策（哪几个词算"会遇到的"），坐标是派生——选错了改这个数组，抄错了它自己会红。
const GLOSSARY_TERMS = ['三原语', '章状态机', '事件带', '生效窗', '前情事实卡']
function glossaryRows() {
  const lines = GUIDE_TEXT.split('\n').filter((l) => l.trim())
  const titleOf = (l) => (l.split('（')[0] || '').trim()
  const rows = []
  for (const term of GLOSSARY_TERMS) {
    // 优先"标题里就有这个词"的那一条（那才是它的家），否则退回第一次出现处
    let idx = lines.findIndex((l) => titleOf(l).includes(term))
    if (idx === -1) idx = lines.findIndex((l) => l.includes(term))
    if (idx === -1) {
      die('术语「' + term + '」在手册里找不到——术语表必须由手册现读派生：这个词要么已不在手册，' +
        '要么写法变了。改 GLOSSARY_TERMS 或修手册，别在生成物里留一个指不到的手册坐标')
    }
    const base = titleOf(lines[idx]) || lines[idx].slice(0, 16)
    // 同名节不止一条时补条号（手册里有两处「工作流」：卷级开局 / 每章），否则只给标题
    const sameTitle = lines.filter((l) => titleOf(l) === base).length
    rows.push('| ' + term + ' | ' + base + (sameTitle > 1 ? '（第 ' + (idx + 1) + ' 条）' : '') + ' |')
  }
  if (!rows.length) die('术语对照生成了 0 行——空集不是"没有术语要列"')
  return rows
}

// 解析预设：只做行级扫描（不引 YAML 依赖），定位六个角色条目与它们的三行
function scanPreset(text) {
  const lines = text.split('\n')
  const entries = []          // { id, start, end }
  lines.forEach((l, i) => {
    const m = l.match(/^- id:\s*(\S+)\s*$/)
    if (m) entries.push({ id: m[1], start: i, end: lines.length })
  })
  entries.forEach((e, i) => { if (i + 1 < entries.length) e.end = entries[i + 1].start })
  const mounted = new Set()
  for (const l of lines) {
    const m = l.match(/^\s*-?\s*name:\s*(.+?)\s*$/)
    if (m) mounted.add(m[1].replace(/^['"]|['"]$/g, ''))
  }
  const blocks = {}
  for (const e of entries) {
    const body = lines.slice(e.start, e.end)
    const denyIdx = body.findIndex((l) => /^\s*deny:\s*\[/.test(l))
    const bgIdx = body.findIndex((l) => /^\s*backgroundMode:\s*\S+/.test(l))
    const depthIdx = body.findIndex((l) => /^\s*maxDepth:/.test(l))
    blocks[e.id] = {
      hasToolFilter: body.some((l) => /^\s*toolFilter:/.test(l)),
      denyLine: denyIdx === -1 ? null : e.start + denyIdx,
      denyNames: denyIdx === -1 ? null : body[denyIdx].match(/\[(.*)\]/)[1].split(',').map((s) => s.trim()).filter(Boolean),
      bgLine: bgIdx === -1 ? null : e.start + bgIdx,
      depthLine: depthIdx === -1 ? null : e.start + depthIdx,
      start: e.start, end: e.end, lines: body,
    }
  }
  return { lines, entries, mounted, blocks }
}

function resolvePresets() {
  const out = []
  for (const rel of TABLE.hosts.dsh.presets || []) {
    for (const cand of [path.resolve(ROOT, rel), path.resolve(PLUGIN, rel.replace(/^dsh-native\/[^/]+\//, ''))]) {
      if (fsSync.existsSync(cand) && !out.includes(cand)) out.push(cand)
    }
  }
  return out
}

async function dshWork() {
  const presets = resolvePresets()
  if (!presets.length) die('约定的预设一份都没找到：' + (TABLE.hosts.dsh.presets || []).join(' / '),
    'mono 形态应在 ' + ROOT + '；flat 形态（公开仓 clone）只该有 preset-starter 那份')
  const planned = []      // { file, lines, changed }
  for (const file of presets) {
    const text = fsSync.readFileSync(file, 'utf8')
    const { lines, entries, mounted, blocks } = scanPreset(text)
    const rel = path.relative(ROOT, file).split(path.sep).join('/')
    if (entries.length < 5) die(rel + ' 只解析出 ' + entries.length + ' 个顶层条目——行级扫描失配（文件结构变了？）')

    // ③ 反向：预设挂载的每个插件都必须在 packages 台账里
    const unregistered = [...mounted].filter((n) => !(TABLE.hosts.dsh.packages || {})[n])
    if (unregistered.length) die(rel + ' 挂了未登记的插件：' + unregistered.join(', ') +
      '\n  （新挂一个插件＝给每个子代理多一件继承工具；没登记就没有任何角色面能封它）',
      '在 ' + REL_TABLE + ' 的 hosts.dsh.packages 里登记它提供的模型可见工具名（不注册工具就写空数组 + note）')
    // packages 台账里的工具名也并入"实存名字集"
    for (const [, v] of Object.entries(TABLE.hosts.dsh.packages || {})) {
      if (Array.isArray(v.tools)) for (const n of v.tools) knownByHost.dsh.add(n)
    }
    // ② 反向：名单里的名字必须实存
    for (const [id, b] of Object.entries(blocks)) {
      if (!b.denyNames) continue
      const ghost = b.denyNames.filter((n) => !knownByHost.dsh.has(n))
      if (ghost.length) die(rel + ' 的 ' + id + ' 名单里有表上没有的名字：' + ghost.join(', ') +
        '\n  （DSH 侧 restrict() 对未知名字直接抛错；这个名字既没进能力表、也不在 packages 台账里）')
    }
    // ④ 角色 ↔ 条目 双射
    const tableRoles = roleIds.filter((r) => TABLE.roles[r].dsh && TABLE.roles[r].dsh.entry)
    const tableEntries = new Set(tableRoles.map((r) => TABLE.roles[r].dsh.entry))
    const presetFiltered = Object.keys(blocks).filter((id) => blocks[id].hasToolFilter)
    for (const id of presetFiltered) if (!tableEntries.has(id)) die(rel + ' 的 ' + id + ' 有 toolFilter 但能力表里没有这个角色条目（谁在写这份名单？）')
    for (const id of tableEntries) if (!blocks[id]) die(rel + ' 里找不到能力表登记的角色条目 ' + id)
    for (const id of tableEntries) if (!blocks[id].hasToolFilter) die(rel + ' 的 ' + id + ' 在能力表里登记了 deny，文件里却没有 toolFilter: 段（表与文件不同步）')

    // 生成/核对：全部改动先收集成"行号 → 动作"，最后**一趟**合成。
    // 为什么不是边算边改：第一版直接对数组赋值 + splice，第一个 splice 之后所有行号整体
    // 位移，后面几个角色的名单就写到了别人的行上（实测把 toolFilter 行覆盖成了 deny 行，
    // 文件当场坏掉）。行号是**原文件**的坐标系，动作收集期内一个都不许失效。
    const sets = new Map()          // 行号 → 新内容
    const removals = new Set()      // 行号 → 删除
    const inserts = new Map()       // 行号 → [插入其后的行]
    const diffs = []
    for (const rid of tableRoles) {
      const entry = TABLE.roles[rid].dsh.entry
      const b = blocks[entry]
      const { names } = faceOf(rid, 'dsh')
      const line = b.denyLine === null ? null : lines[b.denyLine]
      const me = (line ? line.match(/^(\s*)/)[1] : '      ')     // toolFilter 子项的缩进
      const ci = (b.bgLine === null ? null : lines[b.bgLine].match(/^(\s*)/)[1]) || me   // config 直属项缩进
      if (line === null) die(rel + ' 的 ' + entry + ' 没有 deny 行（能力表登记了名单，文件里却找不到）')
      const want = me + 'deny: [' + names.join(', ') + ']'
      if (line !== want) { diffs.push(rid + '（' + entry + '）名单不一致'); sets.set(b.denyLine, want) }

      // spawn 锁：deny 了 spawn 的角色必须带 maxDepth: 0（结构性锁，不靠名字——名字写错在
      // DSH 侧会抛错，但"将来多挂一个 spawn 工具"不会；深度锁不依赖名单完整性）
      const locksSpawn = TABLE.roles[rid].deny.includes('spawn')
      if (locksSpawn) {
        if (b.depthLine === null) {
          if (b.bgLine === null) die(rel + ' 的 ' + entry + ' 缺 backgroundMode 行——maxDepth 插入点定位不到（不猜位置）')
          const anchor = b.bgLine
          if (!inserts.has(anchor)) inserts.set(anchor, [])
          inserts.get(anchor).push(ci + 'maxDepth: 0')
          diffs.push(rid + ' 补 maxDepth: 0')
        } else if (lines[b.depthLine].trim() !== 'maxDepth: 0') {
          diffs.push(rid + ' 的 maxDepth 不是 0（能力表封了 spawn，应有 = 0）')
          sets.set(b.depthLine, ci + 'maxDepth: 0')
        }
      } else if (b.depthLine !== null) {
        diffs.push(rid + ' 不该有 maxDepth（能力表里没封 spawn）')
        removals.add(b.depthLine)
      }
    }
    const next = []
    lines.forEach((l, i) => {
      if (removals.has(i)) return
      next.push(sets.has(i) ? sets.get(i) : l)
      if (inserts.has(i)) next.push(...inserts.get(i))
    })
    const outText = next.join('\n')
    // 生成后自证：把产出**重新解析一遍**，逐角色核对名单与 maxDepth——
    // 直接相信"我刚写的就是对的"正是把坏文件写进仓的那条路。
    {
      const re = scanPreset(outText)
      for (const rid of tableRoles) {
        const entry = TABLE.roles[rid].dsh.entry
        const want = faceOf(rid, 'dsh').names
        const got = re.blocks[entry] ? re.blocks[entry].denyNames : null
        if (!got || got.join(',') !== want.join(',')) die('生成后自证失败：' + rel + ' 的 ' + entry + ' 重解析名单对不上能力表')
        const hasDepth = re.blocks[entry].depthLine !== null
        const needDepth = TABLE.roles[rid].deny.includes('spawn')
        if (hasDepth !== needDepth) die('生成后自证失败：' + rel + ' 的 ' + entry + ' maxDepth 存在性不对（有=' + hasDepth + ' 应有=' + needDepth + '）')
      }
      if (re.entries.length !== entries.length) die('生成后自证失败：' + rel + ' 顶层条目数从 ' + entries.length + ' 变成 ' + re.entries.length)
    }
    planned.push({ file, rel, text, next: outText, diffs })
  }
  return planned
}

// ── 4. CodeBuddy 侧：产出一份**声明**文档（受宿主强制的部分未实测，故不写进 agent 定义）
function codebuddyDoc() {
  const host = TABLE.hosts.codebuddy
  const rel = host.artifact
  const L = []
  const seatZh = { lead: 'lead', member: 'member' }
  L.push('# 角色工具面（本宿主：WorkBuddy / CodeBuddy）')
  L.push('')
  L.push('> **本文件是生成的**，由 `' + REL_TABLE + '`〔仓外〕产出（生成器 `' + path.relative(PLUGIN, path.join(PLUGIN, 'roles', 'build-tool-face.mjs')).split(path.sep).join('/') + '`〔仓外〕）。')
  L.push('> 不要手改：改表 → 重跑生成器。装配器每次装配都会核对，不一致即装配失败——手改会在下一次装配时被抹掉，而不是悄悄生效。')
  L.push('> 生成时点（表内 updated 字段）：' + TABLE.updated + '。')
  L.push('')
  L.push('## 一、这份文件在回答什么')
  L.push('')
  L.push('同一个编辑部有两个宿主形态：DSH（原生预设）与 WorkBuddy（本专家包）。两边人格相同、机制相同，但**宿主能执行什么约束完全不同**。')
  L.push('这份文件把差异写清楚，只为一件事：**不让读者以为本形态拥有它没有的强制力**。')
  L.push('')
  L.push('- 「能力」是宿主无关的（写账本 / 读文件 / 跑命令 / 派生子代理 / 把没加载的工具翻出来 …）。')
  L.push('- 「工具真名」是宿主相关的：同一个能力在两个宿主下名字不同，**且一方的真名拿到另一方可能根本不存在**。')
  L.push('- 本宿主还要再按**形态**分一次：主编座位 / 团队成员 / 普通子代理三者的工具面实测不同，同一份名单在三种形态下不是同一件事。')
  L.push('')
  L.push('## 二、本形态的强制力现状（先说结论）')
  L.push('')
  const enfZh = { enforced: '**宿主强制**（已在本机核实到源码级）', 'declared-unverified': '**只有声明，未核实是否生效**', 'proven-mechanism': '**机制已实测 · 载体未落地**（落点在项目级定义，本包尚未投放）' }
  L.push((enfZh[host.enforcement] || host.enforcement) + '。' + host.enforcement_note)
  L.push('')
  L.push('对比 DSH 形态：那边的角色工具面是**宿主强制**的——子代理的 deny 名单由宿主在挂载期编译，写错名字直接挂载失败（不是失败在第一次派工），')
  L.push('而且过滤作用于子代理继承到的整个工具面。本形态目前只有**声明**：下面第三节的名单是"应该封掉什么"，不是"已经封掉什么"。')
  L.push('')
  L.push('三种形态（映射的键，不是角色的属性）：')
  L.push('')
  for (const f of FORMS) L.push('- **' + f + '**：' + host.forms[f])
  L.push('')
  L.push('## 三、角色 × 能力（本宿主工具真名）')
  L.push('')
  L.push('| 角色 | 形态 | 封掉的能力 | 本宿主工具真名 | 本形态没有/未核实 |')
  L.push('|---|---|---|---|---|')
  for (const rid of roleIds) {
    const r = TABLE.roles[rid]
    const { names, skipped, form } = faceOf(rid, 'codebuddy')
    const seat = r.codebuddy && r.codebuddy.seat ? '（' + seatZh[r.codebuddy.seat] + '）' : ''
    const un = skipped.map((s) => s.cid + '（' + (s.status === 'none' ? '本形态无此工具' : '未核实') + '）')
    L.push('| ' + r.zh + seat + ' | ' + form + ' | ' + (r.deny.length ? r.deny.join('、') : '（不封任何能力）') + ' | ' +
      (names.length ? names.map((n) => '`' + n + '`').join(' ') : '—') + ' | ' + (un.length ? un.join('；') : '—') + ' |')
  }
  L.push('')
  L.push('「封掉的能力」一列是宿主无关口径（与 DSH 形态同一张表推导）；「工具真名」一列才是可以写进 disallowedTools 的东西。')
  L.push('同一列里既有名字又有"—"，差别不是重不重要，而是**这个形态下有没有这个工具**：没有工具可禁时，那条 deny 是空操作。')
  L.push('')
  if (host.couplings && Object.keys(host.couplings).length) {
    L.push('### 连带影响（禁一条会顺带影响什么）')
    L.push('')
    for (const [k, v] of Object.entries(host.couplings)) L.push('- `' + k + '`：' + v)
    L.push('')
  }
  L.push('## 四、未核实清单（**不许当已实现**）')
  L.push('')
  const unverified = []
  for (const cid of CAP_ORDER) {
    const cb = TABLE.capabilities[cid].codebuddy
    for (const f of ['*'].concat(FORMS)) {
      const v = cb[f]
      if (!v || v.status !== 'unverified') continue
      const hit = unverified.find((u) => u.cid === cid)
      if (hit) hit.forms.push(f)
      else unverified.push({ cid, why: v.why, cands: v.candidates || [], forms: [f] })
    }
  }
  if (unverified.length) {
    L.push('这些能力在本宿主下**封不封得住还不知道**：名字形态、或"deny 认不认这个写法"未核实（写错＝静默空转：看起来封了，其实一条也没封）。')
    L.push('')
    for (const u of unverified) {
      L.push('- ' + u.cid + '（' + TABLE.capabilities[u.cid].zh + '）：' + u.why)
      if (u.cands.length) L.push('  - 实测候选：' + u.cands.map((c) => '`' + c + '`').join(' '))
    }
  } else {
    L.push('（无）')
  }
  L.push('')
  L.push('## 五、会被照抄、但在本宿主不存在的名字')
  L.push('')
  L.push('从 DSH 名单直抄过来会**静默空转**的名字（本宿主官方内置工具清单里没有它们）：')
  L.push('')
  L.push('| 名字 | 为什么会被写进来 | 本宿主真名 |')
  L.push('|---|---|---|')
  L.push('| `read_image` | DSH 侧真有一个独立图像读工具 | 无独立工具（图像并入 `Read`） |')
  L.push('| `pwsh` | DSH 在 Windows 上的 shell 工具叫这个 | `PowerShell`（Windows 专属；另有 `Bash`） |')
  L.push('| `Task` | 别的宿主用 `Task` 派生子代理 | `Agent`（本宿主的 `Task*` 六件是任务清单，不是派生） |')
  L.push('')
  L.push('另有一类**同向**的坑：名字真实存在，但在本形态**缺席**（如团队成员形态的 `Agent`/`TeamCreate`）——')
  L.push('禁它们不是"封住了"，是**空操作**（没有工具可禁）。第三节的「本形态没有/未核实」一列就是为它设的。')
  L.push('')
  // ── 五b. 第三格：**存在、但本形态下不可用**（与"不存在""已封"都不同类，故单列）
  // 2026-09-21 第三方实测加的一格。混进第五节＝读者把"惰性"读成"已封"；
  // 混进"已核实不存在"＝说了一个假话（名字真在官方清单里）。
  {
    const inert = host.inert_tools_verified || []
    L.push('## 五b、存在、但**本形态下不可用**的名字（不许读成"已封"）')
    L.push('')
    if (!inert.length) {
      L.push('（无——本宿主暂无"名字存在但本形态惰性"的实测条目）')
    } else {
      L.push('这一类与上一节**后果同类、成因不同**：上一节是名字不存在；这里是名字存在、能发起调用，但会被宿主拒。')
      L.push('')
      for (const t of inert) {
        L.push('- `' + t.tool + '` @ **' + t.form + '**：' + t.why)
        if (t.consequence) L.push('  - 于是怎么办：' + t.consequence)
      }
    }
    L.push('')
  }
  L.push('## 六、与 DSH 形态的强度差异（读者需要知道的那部分）')
  L.push('')
  L.push('| 机制 | DSH 形态 | 本形态（现状） |')
  L.push('|---|---|---|')
  L.push('| 落账权隔离（只有主编能写账本） | 宿主强制：子代理 deny 掉写账本工具 | **机制已实测拦得住**（`disallowedTools` 中性同形探针红测），但**须把定义投放到项目级落点**；本包当前投放数＝**0**，故现状仍等于纯纪律 |')
  L.push('| 盲读输入隔离（盲角色只能读派工包） | 宿主强制：读写文件工具全封 | 同上（同一机制）。五工种定义建好之前＝纯纪律 |')
  L.push('| 盲角色不得发现/执行未加载的工具 | 宿主强制：本预设根本没挂这条通道 | **实测：通道存在且可执行**；但**对盲角色可以封**（`ToolSearch`+`DeferExecuteTool` 一对，封了＝切断全部 MCP）——机制已实测，定义未建 |')
  L.push('')
  L.push('引用本形态的盲读结论做重要判断时，请带上这条限定。日常写作不受影响。')
  L.push('')
  L.push('## 七、给实测用：只含已核实真名的声明片段（★读之前先看"落点"在不在）')
  L.push('')
  L.push('下表这几条**只由已核实的真名组成**（含已实测的 MCP 名），可以直接拿去做运行时红测。')
  L.push('')
  L.push('**★ 落点只有一处是真的：项目级自定义 agent 定义 `<工作区>/.codebuddy/agents/<name>.md`。**')
  L.push('三条 2026-09-22 实测（WB 侧 `[硬返回]` ＋ 宿主源码，仓侧已独立读源码复核前两条）：')
  L.push('1. **包内 `agents/` 不是注册载体**——宿主组件装载器**不枚举专家包**（日志里 11 个插件各有 `Loaded plugin components for …`，本包一次都没出现）；包内那两份的真实用途是**人格文本的权威来源**，往里补前言块不会让它进表。')
  L.push('2. **项目级定义当次生效**（实测不需重启；插件内定义才随组件加载、改完要重启——两条路别混）。')
  L.push('3. **deny 真拦得住**：中性同形探针 `disallowedTools:[mcp__novelist__novel_chapter]` → `Error: Permission to use mcp__novelist__novel_chapter has been denied.`（拦在权限层，未到工具本体）。')
  L.push('')
  L.push('**★ 红测必须用中性同形探针，不要借本座。**WB 侧第一版让"主笔去调它自己被禁的工具"，它**以纪律为由拒发**——')
  L.push('**人格纪律与机器 deny 是混淆变量**，那样测出来的"拒"分不清是谁干的。')
  L.push('另：**主笔本座至今没有机械读数**（两次自守拒发）⇒ 口径只能写"机制已实测成立（同形配置）"，**不许写成"主笔已被机器封死"**。')
  L.push('')
  L.push('**★ 两条省事的取证路径（先走第 1 条，不用重启也不用派探针）**：')
  L.push('1. 日志行 `[AgentTask] agent lookup failed | requested="X" | available=[...]`——那行 `available` 就是现成仪器，直接看"宿主这一刻加载了哪些 agent"。')
  L.push('2. 用户级目录＝app 进程环境变量的 `CODEBUDDY_CONFIG_DIR` 下的 `agents/`（**本机该变量指向宿主自己的配置目录 `.workbuddy`** ⇒ 实为 `~/.workbuddy/agents/`）；')
  L.push('   **以环境变量为准，不要照抄本条的字面值**——换个装法就会分叉。（本节不写机器绝对路径：包内文档零机器路径是硬门。）')
  L.push('')
  L.push('**★ 五个工种的落点＝待建**：`references/roles/` 下的件是派工文本、不是 agent 定义（往里加 frontmatter 不会有任何效果）。')
  L.push('要建就建成**项目级定义**（路径同上）；且**建之前先过耦合不变量**——本形态 MCP 只能经 `ToolSearch`→`DeferExecuteTool` 到达，')
  L.push('**封发现面的角色必须同时封掉全部 MCP 面能力**（生成器会在装配期拦下不满足者）。')
  L.push('')
  for (const rid of roleIds) {
    const r = TABLE.roles[rid]
    const { names, skipped } = faceOf(rid, 'codebuddy')
    if (!names.length) continue
    const f = r.codebuddy && r.codebuddy.file ? r.codebuddy.file : '—'
    const isAgentDef = f.startsWith('agents/')
    L.push('- **' + r.zh + '**（' + f + '，形态 ' + r.codebuddy.form + '）：`disallowedTools: [' + names.join(', ') + ']`')
    const gaps = (skipped || []).filter((s) => s.status === 'ineffective')
    for (const g of gaps) {
      L.push('  - **⚠ 缺口（已实测拦不住，故不写进名单）**：`' + g.names.join('`, `') + '`（能力 ' + g.cid + '）——' +
        '写进 `disallowedTools` 后**它仍在工具面里、且调用真的会执行**。**不许写进去装作封住了**：静默列进去＝虚假的约束感。' +
        '本行是**如实标注**，不是"以后会修"。')
    }
    L.push('  - 落点：' + (isAgentDef
      ? '**包内 `agents/` 不是注册载体**（组件装载器不枚举专家包）。本行是**人格文本的权威来源**；要让它真的生效，需把同一份文本投放成**项目级定义** `<工作区>/.codebuddy/agents/<name>.md`（投放即生效、不用重启；见本节开头）'
      : '**待建**——`' + f + '` 是派工文本、不是 agent 定义。要建就建成**项目级定义**（路径同左）；建前先过耦合不变量：封发现面者必须封掉全部 MCP 面能力'))
  }
  L.push('')
  L.push('预期：加上之后该 agent 调这些工具应当直接失败或被拒。**若照样能调通，说明本形态的 deny 不生效**——那就要如实降级到"纪律约束"，并把这条写进交付说明，而不是当它生效了。')
  L.push('')
  L.push('两条本宿主实测纪律：①agent 定义**不热加载**，改完必须重启，验证天然跨会话；②"某工具缺席"类结论拿不到硬证据（不在清单里就发不起调用）——唯一出口是**强行发起一次对它的调用**，逼调度层回 `Tool Not Found`。')
  L.push('')
  L.push('---')
  L.push('')
  L.push('## 附：怎么自己核这份文件')
  L.push('')
  L.push('1. 本宿主官方工具清单里应能找到第三节引号内的全部名字（「本形态没有/未核实」列出的那批除外）。')
  L.push('2. 第五节的名字在本宿主清单里**应当找不到**——找到了说明我搞错了宿主，请指出来。')
  L.push('3. 第三节的名单与「封掉的能力」一列应由同一张能力表推导；若你看到两边对不上，是生成器的 bug。')

  // 生成后自证：文档里不许把"已核实不存在"的名字当工具真名写出去（第五节那张对照表除外）。
  // 生成的文档自己也要过一遍 fail-closed——不然这条纪律只管输入不管输出。
  {
    const body = L.join('\n')
    for (const n of ghostTools) {
      // 豁免两类行：①第五节那张"名字 → 为什么会被写进来 → 真名"对照表（首格就是 `名字`，
      // 它讲的就是这些名字不存在）；②正文里解释这条坑的句子。其余位置出现＝真把不存在的
      // 名字当工具真名写进了包。
      const bad = body.split('\n').filter((l) => l.includes('`' + n + '`') &&
        !/^\| `/.test(l.trim()) && !/静默空转|不存在|本宿主真名|坑/.test(l))
      if (bad.length) die('生成后自证失败：文档把已核实不存在的名字「' + n + '」当工具真名写了：\n  ' + bad.slice(0, 3).join('\n  '))
    }
  }
  return { rel, text: L.join('\n') + '\n' }
}

// ── 5. 执行
const results = []
const wants = (h) => HOST_ARG === 'all' || HOST_ARG === h
if (wants('dsh')) {
  const planned = await dshWork()
  for (const p of planned) {
    if (!p.diffs.length) { results.push({ rel: p.rel, status: 'ok', note: '名单与能力表一致' }); continue }
    if (CHECK) { results.push({ rel: p.rel, status: 'drift', note: p.diffs.join('；') }); continue }
    await fsp.writeFile(p.file, p.next)
    results.push({ rel: p.rel, status: 'written', note: p.diffs.length + ' 处：' + p.diffs.join('；') })
  }
}
if (wants('codebuddy')) {
  const doc = codebuddyDoc()
  // 产物路径同样要认两种布局：表里写的是 monorepo 坐标（dsh-native/plugin-novelist/…），
  // 公开单仓 clone 里没有这个前缀——与预设用同一套剥前缀规则，不再写第二份判定。
  const stripPrefix = (t) => { const m = t.match(/^dsh-native\/[^/]+\/(.+)$/); return m ? m[1] : null }
  const cands = [path.resolve(ROOT, doc.rel)]
  const sp = stripPrefix(doc.rel)
  if (sp) cands.push(path.resolve(PLUGIN, sp))
  const abs = cands.find((c) => fsSync.existsSync(path.dirname(c)))
  if (!abs) die('产出目录不存在（两种布局都没命中）：' + doc.rel,
    '表里 hosts.codebuddy.artifact 的坐标要能在 mono 与 flat 两种根下解析到同一份文件')
  const cur = fsSync.existsSync(abs) ? fsSync.readFileSync(abs, 'utf8') : null
  if (cur === doc.text) results.push({ rel: doc.rel, status: 'ok', note: '与能力表一致' })
  else if (CHECK) results.push({ rel: doc.rel, status: 'drift', note: cur === null ? '文件不存在' : '内容与能力表不一致' })
  else { await fsp.writeFile(abs, doc.text); results.push({ rel: doc.rel, status: 'written', note: cur === null ? '新建' : '内容已按能力表重写' }) }

  // ── 4b. 派工文本里的"工具面"区也归生成管
  // 为什么：`references/roles/*.md` 里原本各手写一段 DSH 名单——那是同一事实的**第三份拷贝**，
  // 而且 2026-09-20 第三方实测**五份全部落后真源**（盲角色各漏 7 项反扇出条款）。
  // 治法不是"这次改对"，是把这一段也变成生成区：名单只活在能力表里，派工文本只留指针。
  {
    const BEGIN = '<!-- 工具面：生成区开始'
    const END = '<!-- 工具面：生成区结束 -->'
    const genRel = path.relative(PLUGIN, path.join(PLUGIN, 'roles', 'build-tool-face.mjs')).split(path.sep).join('/')
    const names = roleIds
      .filter((r) => TABLE.roles[r].codebuddy && TABLE.roles[r].codebuddy.file &&
        TABLE.roles[r].codebuddy.file.startsWith('references/roles/'))
      .map((r) => ({ rid: r, rel: TABLE.roles[r].codebuddy.file }))
    if (!names.length) die('能力表里没有任何 references/roles/ 派工文本登记——0 件不等于没问题（这段扫描等于空转）')
    const block = [
      '<!-- 工具面：生成区开始（真源＝能力表 ' + REL_TABLE + '，生成器 ' + genRel +
        '；本段由本次生成写入 **' + names.length + '** 份派工文本——份数是现算的，不在文档里手写） -->',
      '**DSH 侧（宿主强制）**：本角色在 DSH 预设里的 `toolFilter.deny` 名单（含 2026-09-20 起的扇出/发现面封锁与 `maxDepth: 0` 深度锁）**由能力表生成，不在本文件复述**——复述就是第三份会过期的拷贝：2026-09-20 第三方实测，这批派工文本里的名单**全部**落后真源（盲角色各漏 7 项反扇出条款）。要查实际名单就读能力表，或跑生成器 `--check`。',
      '',
      '**WorkBuddy 侧（只有声明，未核实生效）**：本角色应封的能力与**本宿主工具真名**见 `../宿主工具面.md`〔包内〕（生成件）。本形态下宿主**未证实**执行 deny，故一律按纪律约束对待，交付说明须标注"软隔离、证据力低于 DSH 形态"。',
      '',
      '**术语对照**（派工指令里会遇到这些词；坐标**从机制手册现读**，按同一份手册读细则）：',
      '',
      '| 术语 | 手册里出现处 |',
      '|---|---|',
      ...glossaryRows(),
      '',
      '> 给这一格的理由：术语不必背，但要**找得到**——2026-09-20 第三方实测，这些词此前只活在主编侧与手册里，派工文本里一个都没有（`grep -c` 主编 2 / 派工 0）。',
      END,
    ].join('\n')
    for (const { rel: fileRel } of names) {
      const stripPrefix2 = (t) => { const m = t.match(/^dsh-native\/[^/]+\/(.+)$/); return m ? m[1] : null }
      const full = [path.resolve(PLUGIN, 'wb-expert-starter', fileRel), path.resolve(PLUGIN, 'wb-expert-starter', stripPrefix2(fileRel) || fileRel)]
        .find((c) => fsSync.existsSync(c))
      if (!full) die('派工文本不存在：' + fileRel + '（能力表里登记的路径要能在包模板下解析到）')
      const src = fsSync.readFileSync(full, 'utf8')
      const bi = src.indexOf(BEGIN)
      const ei = src.indexOf(END)
      if (bi === -1 || ei === -1 || ei < bi) die(fileRel + ' 缺工具面生成区标记（`' + BEGIN + '` … `' + END + '`）——本文件该段必须由生成器接管')
      const next = src.slice(0, bi) + block + src.slice(ei + END.length)
      const shortRel = path.relative(ROOT, full).split(path.sep).join('/')
      if (next === src) results.push({ rel: shortRel, status: 'ok', note: '工具面生成区与能力表一致' })
      else if (CHECK) results.push({ rel: shortRel, status: 'drift', note: '工具面生成区内容与能力表不一致' })
      else { await fsp.writeFile(full, next); results.push({ rel: shortRel, status: 'written', note: '工具面生成区已刷新' }) }
    }
  }
}

console.log('')
console.log('══════ 角色工具面（能力表 → 派生件）══════')
for (const r of results) console.log('  ' + (r.status === 'drift' ? '✗' : '✓') + ' ' + r.rel.padEnd(50) + ' ' + r.status + ' · ' + r.note)
const drift = results.filter((r) => r.status === 'drift')
if (drift.length) {
  console.log('\n✗ ' + drift.length + ' 份派生件与能力表不一致（源改了、派生件没跟上）。跑一次不带 --check 的生成：')
  console.log('  node ' + path.relative(process.cwd(), fileURLToPath(import.meta.url)).split(path.sep).join('/'))
  process.exit(1)
}
process.exit(0)
