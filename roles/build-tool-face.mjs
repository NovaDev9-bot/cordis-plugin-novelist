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
// ── 桶位台账（deny_readings）：**一个名字写进 deny 之后到底会怎样**，是"能不能渲进名单"的唯一判据。
// 2026-09-23 WB 侧实测：同一张名单里三种名字命运完全不同——A 桶真拦得住、B 桶拦得住但每次派工被
// 框架记 `failed`、C 桶**写了等于没写**（名字还在、调用真执行）。少了这道核，"往名单里塞一个封不住
// 的名字"要等下一次红测才被发现，而它的表观与"已封"完全一样。
const BUCKETS = new Set(['A', 'B', 'C', 'D'])
const bucketOf = new Map()      // 工具名 → 'A'|'B'|'C'|'D'
const inertNames = new Set()    // 存在、但本形态下不可用（渲它无害也无用，故与"没桶位"区分开）
for (const t of (TABLE.hosts.codebuddy ? TABLE.hosts.codebuddy.inert_tools_verified || [] : [])) {
  if (t && typeof t.tool === 'string') inertNames.add(t.tool)
}
// MCP 一族走通配：表里登记一条 `mcp__novelist__*`，15 个真名不必逐个抄一遍
// （逐个抄＝同一事实 15 处各活一次，加一个工具就漏一处）
function bucketFor(name) {
  if (bucketOf.has(name)) return bucketOf.get(name)
  if (name.startsWith('mcp__')) return bucketOf.get('mcp__novelist__*') || null
  return null
}
// 表合法性的累积错误（checkLeaf 与各段核对都往里写，最后一次性报）。声明提前到这里：
// 下面的「人格条款号」核对也要用它，而它在文件里的书写位置晚于本节。
const errs = []
// ── 人格真源里的条款号（code → 正文）：`isolation.clauses` 引的条款必须**真的存在**。
// 为什么从人格真源现读、而不在能力表里抄一份条款正文：抄一份＝同一事实两处各活一次；人格改了条款，
// 能力表那份不会跟着变，而**引用对不上时没有任何东西会报错**（这条坑本项目已经踩过多次）。
const personaCodes = new Map()      // code → { who: [角色/文件名], text: 段正文 }
{
  let files = []
  const dir = path.join(PLUGIN, 'roles', 'persona')
  try { files = fsSync.readdirSync(dir).filter((f) => f.endsWith('.json')).sort() } catch { /* 目录缺失＝下面核对全数报红，不静默通过 */ }
  for (const f of files) {
    let j = null
    try { j = JSON.parse(fsSync.readFileSync(path.join(dir, f), 'utf8')) } catch (e) {
      errs.push('人格真源 ' + f + ' 解析不了：' + e.message); continue
    }
    const who = f.replace(/\.json$/, '')
    for (const s of (j.segments || [])) {
      if (!s || typeof s.code !== 'string' || !s.code.trim()) continue
      const text = String(s.text || '').replace(/\s+/g, ' ').trim()
      const hit = personaCodes.get(s.code)
      if (!hit) { personaCodes.set(s.code, { who: [who], text }); continue }
      hit.who.push(who)
      if (hit.text !== text) {
        errs.push('条款「' + s.code + '」在人格真源里有两份**正文不同**的拷贝（' + hit.who.join('/') + '）——' +
          '同一条款号两种说法，引用它的人拿到哪一份取决于读哪份文件')
      }
    }
  }
  if (!personaCodes.size) {
    errs.push('人格真源里读不到任何条款号（roles/persona/*.json 的 segments[].code）——' +
      'isolation 引条款的核对会因此**全数失效**（空集比报错更危险）')
  }
}

// ── 推导的原语（提到校验之前：重复登记核对必须按**宿主 × 形态**做，而形态只有解析后才定得下来）
const CAP_ORDER = Object.keys(TABLE.capabilities)
// 解析到"该能力在该宿主该形态下"的那条取值：CodeBuddy 侧键是形态（显式形态优先，`*` 兜底）。
function leafOf(cap, host, form) {
  if (host === 'dsh') return cap.dsh
  const cb = cap.codebuddy
  return cb[form] !== undefined ? cb[form] : cb['*']
}
// ── 1. 表自身的合法性（fail-closed：形状不对就不许往下走）
// （`errs` 的声明在上面的「桶位台账」一节——人格条款号核对那一段也要用它。）
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
// 缺口名的公共核对（`ineffective` / `costly`）：名字必须真、且**桶位必须与所在的格子一致**。
// 为什么按"所在格子"核而不是只核存在性：这两格是两种不同的缺口——`costly` 拦得住但有代价（B 桶）、
// `ineffective` 根本拦不住（C 桶）。放错格子＝把 B 说成 C，而下一个人会照这个结论做决定。
function checkGapNames(v, ctx, keys) {
  for (const k of keys) {
    const arr = v[k]
    if (arr === undefined) continue
    if (!Array.isArray(arr) || !arr.length) {
      errs.push(ctx + '.' + k + ' 必须是至少一项的数组（它是"实测拦不住 / 拦得有代价的真名字"，不是名单）')
      continue
    }
    const want = k === 'ineffective' ? 'C' : 'B'
    for (const n of arr) {
      if (Array.isArray(v.tools) && v.tools.includes(n)) {
        errs.push(ctx + ' 的「' + n + '」同时落在 tools 与 ' + k + ' 里——两者互斥（一个名字要么渲进名单，要么只当缺口）')
      }
      if (ghostTools.has(n)) errs.push(ctx + '.' + k + ' 里写着已核实**不存在**的名字「' + n + '」——不存在的东西当不了缺口')
      else if (knownTools.size && !knownTools.has(n)) errs.push(ctx + '.' + k + ' 里的「' + n + '」不在 hosts.codebuddy.known_tools 里——它必须是**真名字**（"封不住的真名字"才有资格当缺口公开）')
      const got = bucketOf.get(n)
      if (got && got !== want) {
        errs.push(ctx + '.' + k + ' 里的「' + n + '」在 deny_readings 里是 ' + got + ' 桶，与它所在的格子不符（' + k + ' ⇒ 应为 ' + want + ' 桶）——把 B 说成 C 比不说更糟')
      }
    }
  }
}

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
    // 桶位耦合同样要核（见角色核对之后那道渲染面核对）——这里只做"缺口名必须与桶一致"。
    checkGapNames(v, ctx, ['ineffective', 'costly'])
  } else if (Array.isArray(v.ineffective) || Array.isArray(v.costly)) {
    // 整格缺口（2026-09-23 新增）：**这一格整个封不住**（C 桶）或**整个只能带代价封**（B 桶）——
    // 于是没有可渲的名字。它与 `status:none`（本宿主不给你这个工具）是两件事，必须分开表达：
    // 前者渲了是**空操作**，后者渲了是**假安全**。
    const k = Array.isArray(v.ineffective) ? 'ineffective' : 'costly'
    if (!v.why || !String(v.why).trim()) {
      errs.push(ctx + ' 是整格 ' + k + ' 却没给 why——整格缺口说的是"这一格为什么封不住"，不写就是让人自己猜')
    }
    checkGapNames(v, ctx, [k])
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
  // ── 桶位台账自身的合法性（2026-09-23）：它是"渲不渲"的唯一判据，坏掉的后果是**静默渲错**
  {
    const where = 'hosts.codebuddy.deny_readings'
    const dr = TABLE.hosts.codebuddy ? TABLE.hosts.codebuddy.deny_readings : undefined
    if (!dr || typeof dr !== 'object') errs.push(where + ' 缺——四桶（A/B/C/D）是"能不能渲进名单"的唯一判据，不能只活在文档里')
    else {
      if (!dr.buckets || typeof dr.buckets !== 'object') errs.push(where + '.buckets 缺（四桶的定义要在表里）')
      else for (const b of BUCKETS) if (!dr.buckets[b] || !String(dr.buckets[b]).trim()) errs.push(where + '.buckets 缺 ' + b + ' 桶的定义')
      if (!Array.isArray(dr.names) || !dr.names.length) errs.push(where + '.names 必须是至少一条的数组（0 条＝一个名字都没测过，那就不该有这张表）')
      else for (const [i, e] of dr.names.entries()) {
        const w = where + '.names[' + i + ']'
        if (!e || typeof e.name !== 'string' || !e.name.trim()) { errs.push(w + ' 缺 name'); continue }
        if (knownTools.size && !knownTools.has(e.name)) errs.push(w + ' 的「' + e.name + '」不在 known_tools 里——桶位只对**本宿主的真名字**有意义')
        if (ghostTools.has(e.name)) errs.push(w + ' 的「' + e.name + '」已被列进 nonexistent_tools_verified——一个名字不可能既存在又不存在')
        if (!BUCKETS.has(e.bucket)) errs.push(w + ' 的 bucket「' + e.bucket + '」不是 A/B/C/D')
        if (!e.raw || !String(e.raw).trim()) errs.push(w + ' 缺 raw（原始报文）——桶位是**读数**不是印象：没有报文支撑的桶位就是印象')
        if (bucketOf.has(e.name)) errs.push(w + ' 的「' + e.name + '」重复登记')
        bucketOf.set(e.name, e.bucket)
      }
      const ba = dr.bulk_attested
      if (ba && typeof ba === 'object') {
        for (const b of BUCKETS) for (const n of (ba[b] || [])) {
          const prev = bucketOf.get(n)
          if (prev && prev !== b) errs.push(where + ' 的「' + n + '」两处桶位不一致（' + prev + ' vs ' + b + '）')
          bucketOf.set(n, b)
        }
      } else {
        errs.push(where + '.bulk_attested 缺——批量标注的那批（最常渲的几个名字）不登记，' +
          '这条耦合核对就只对逐条表有效，而对名单里最常出现的名字失效')
      }
    }
  }
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
    // 宿主豁免（2026-09-22 新增）：豁免是"换宿主换理由"的地方，所以**没有理由的豁免就是漏封**。
    const exList = r.codebuddy && r.codebuddy.denyExempt
    if (exList !== undefined) {
      if (!Array.isArray(exList)) errs.push('角色 ' + rid + '.codebuddy.denyExempt 必须是数组（每项 {cap, why}）')
      else {
        for (const e of exList) {
          if (!e || typeof e !== 'object') { errs.push('角色 ' + rid + ' 的 denyExempt 项不是对象：' + JSON.stringify(e)); continue }
          if (!r.deny.includes(e.cap)) errs.push('角色 ' + rid + ' 豁免了「' + e.cap + '」，可它本来就不在 deny 里——' +
            '豁免表只许写**真被封过**的能力（写错名字＝你以为豁免了一件事，其实什么都没发生）')
          if (!e.why || !String(e.why).trim()) errs.push('角色 ' + rid + ' 豁免「' + e.cap + '」却没给 why——' +
            '豁免是"换宿主换理由"的地方，没理由的豁免就是漏封')
          if (e.cap === 'tool.search' || e.cap === 'tool.invoke') errs.push('角色 ' + rid + ' 试图豁免发现面（' + e.cap + '）——' +
            'WB 侧运行时实测：发现面就是绕过面，豁免它等于把整条 MCP 面还回去')
        }
      }
    }
    const exCaps = new Set(Array.isArray(exList) ? exList.map((e) => e && e.cap).filter(Boolean) : [])
    // 盲读强度声明（2026-09-23 WB 侧点出）：四座盲角色的隔离强度**实测三档**（零读盘／单文件受限读／
    // 读锚书工作必需），打包成一句"四座盲读隔离"会把三档混成一种。声明进表 → 生成器渲成表；
    // 而引的条款号**必须真的在人格真源里**——引用一个查不到的条款，等于给下一个人一个错的依据。
    if (r.blind) {
      const iso = r.isolation
      if (!iso || !iso.strength || !String(iso.strength).trim()) errs.push('盲角色 ' + rid + ' 缺 isolation.strength——"盲"必须带强度（四座实测三档，不是一种）')
      if (!iso || !iso.why || !String(iso.why).trim()) errs.push('盲角色 ' + rid + ' 缺 isolation.why——强度差在哪儿必须写出来，否则读者只会记住"它们是盲的"')
      const cl = iso && iso.clauses
      if (!Array.isArray(cl) || !cl.length) errs.push('盲角色 ' + rid + ' 的 isolation.clauses 必须是至少一项的数组（依据条款号）')
      else for (const code of cl) {
        if (!personaCodes.has(code)) {
          errs.push('盲角色 ' + rid + ' 的 isolation 引了条款「' + code + '」，但人格真源里没有这个 code' +
            '（roles/persona/' + rid + '.json 与 _shared.json 都查过）——引用一个不存在的条款，等于给下一个人一个查不到的依据')
        }
      }
    } else if (r.isolation) {
      errs.push('角色 ' + rid + ' 不是盲角色（没有 blind: true）却写了 isolation——那是"盲读强度"，不是通用字段')
    }
    const effDeny = r.deny.filter((c) => !exCaps.has(c))

    // 耦合不变量（2026-09-22 WB 侧实测所迫）：本形态 MCP 只能经 ToolSearch→DeferExecuteTool 到达，
    // 所以「封发现面」与「还允许用任何 MCP 工具」在物理上不相容——封了发现面＝该角色一件 MCP 工具都拿不到。
    // 主笔正踩在这条上（它要 novel_bible/novel_search，却曾被 09-20 的权宜封了发现面）。
    // 两张名单都查：DSH 面用 r.deny（无豁免），本形态面用 effDeny（豁免后仍成立才放行）。
    for (const [label, list] of [['DSH 面', r.deny], ['本形态面（豁免后）', effDeny]]) {
      if (!(list.includes('tool.search') || list.includes('tool.invoke'))) continue
      const missing = MCP_CAPS.filter((c) => !list.includes(c))
      if (missing.length) errs.push('角色 ' + rid + ' 在' + label + '封了发现面（tool.search/tool.invoke），却仍允许 MCP 面能力 ' + missing.join(' / ') +
        '——本形态 MCP 只能经这一对到达：封了发现面＝该角色一件 MCP 工具都拿不到（两处口径打架，装配期拦下）')
    }
    for (const h of HOSTS) if (!r[h]) errs.push('角色 ' + rid + ' 缺 ' + h + ' 列（映射缺一列就是"这个宿主上它是什么"没答）')
    if (r.codebuddy && !FORMS.includes(r.codebuddy.form)) {
      errs.push('角色 ' + rid + '.codebuddy.form 不是已知形态（实得 ' + JSON.stringify(r.codebuddy && r.codebuddy.form) + '）——形态是映射的键，没它就查不出这个角色的面')
    }
    // ── 渲染面的桶位核对（2026-09-23）：**只有会被渲出去的名字才需要桶位**。
    // 为什么按"渲出来的表"核、而不是逐能力核：一条能力列里的名字可能根本没有角色 deny 它
    // （如主编座位的 `Agent`／`TeamCreate`——主编不封任何能力），对那些名字要求桶位＝逼人去测
    // 一件没人用的事。真正的承诺是"**进名单的名字都测过**"，所以就在这里按名单核。
    if (Array.isArray(r.deny) && r.codebuddy && FORMS.includes(r.codebuddy.form)) {
      const exCaps2 = new Set((Array.isArray(r.codebuddy.denyExempt) ? r.codebuddy.denyExempt : [])
        .map((e) => e && e.cap).filter(Boolean))
      for (const cid of r.deny) {
        if (exCaps2.has(cid) || !TABLE.capabilities[cid]) continue
        const v = leafOf(TABLE.capabilities[cid], 'codebuddy', r.codebuddy.form)
        // 解析不到取值／不是名单形态：那是别处的红（`checkLeaf` 与"形态解析不到"各有一条），
        // 这里**不许崩**——守卫自己抛 TypeError 会把真正的错因埋掉（本文件第一版就栽在这种地方）。
        if (!v || !Array.isArray(v.tools)) continue
        for (const n of v.tools) {
          if (inertNames.has(n)) continue    // 惰性名：渲它无害也无用（已在 inert_tools_verified 如实登记）
          const b = bucketFor(n)
          if (!b) {
            errs.push('角色 ' + rid + ' 会把「' + n + '」渲进名单（能力 ' + cid + '），但它在 deny_readings 里**没有桶位**——' +
              '没测过的名字不许渲：渲进名单等于对外承诺一件没人验证过的事（C 桶的表观与"已封"一模一样）')
          } else if (b !== 'A') {
            errs.push('角色 ' + rid + ' 会把「' + n + '」渲进名单（能力 ' + cid + '），可它是 ' + b + ' 桶——' +
              'B 桶拦得住但每次派工被框架记 failed；C 桶名字还在工具面里、调用真执行')
          }
        }
      }
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
  // 宿主豁免（2026-09-22 新增）：同一角色在不同宿主上"该不该封"**可以不同**，但必须逐条带理由。
  // 现实例：DSH 形态封 `Glob`/`Grep`，是因为那边主笔没有路径知识、放开等于整块硬盘；
  // 本形态主笔要按 AUTH-11 重读受影响正文，只读面不构成落账旁路 ⇒ 那条理由在你这儿不成立。
  const exempt = host === 'codebuddy' && Array.isArray(r.codebuddy.denyExempt) ? r.codebuddy.denyExempt : []
  const names = []
  const skipped = []      // 本宿主/本形态没有、或还没核实的（要看得见，不是"跳过"）
  const exempted = []     // 有意不封的（同样要看得见——静默少封一个名字＝虚假的安全感）
  for (const cid of CAP_ORDER) {
    if (!r.deny.includes(cid)) continue
    const ex = exempt.find((e) => e && e.cap === cid)
    if (ex) {
      const v = leafOf(TABLE.capabilities[cid], host, form)
      exempted.push({ cid, names: Array.isArray(v.tools) ? v.tools : [], why: String(ex.why).trim() })
      continue
    }
    const v = leafOf(TABLE.capabilities[cid], host, form)
    if (Array.isArray(v.tools)) {
      names.push(...v.tools)
      // 渲了名字、但同格里还有**缺口名**（拦不住 / 拦得有代价）：两者都进 skipped，
      // 由文档与安装器按 status 分别印——"渲了一半"这件事不许被沉默掉
      for (const k of ['ineffective', 'costly']) {
        if (Array.isArray(v[k]) && v[k].length) skipped.push({ cid, status: k, names: v[k], why: v.note || '' })
      }
    }
    // 整格缺口：这一格整个封不住（C 桶）或整个只能带代价封（B 桶），没有可渲的名字
    else if (Array.isArray(v.ineffective)) skipped.push({ cid, status: 'ineffective', names: v.ineffective, why: v.why })
    else if (Array.isArray(v.costly)) skipped.push({ cid, status: 'costly', names: v.costly, why: v.why })
    else skipped.push({ cid, status: v.status, why: v.why, candidates: v.candidates || [] })
  }
  return { names, skipped, exempted, form }
}
const roleIds = Object.keys(TABLE.roles)

// 「**没有任何角色认领的能力**」＝ 没有任何角色的**有效** deny 里出现过的能力（现算）。
// 为什么要有它：WB 侧 §5.1 问「`automation.write` 进了派生件、`host.ui` 没进，为什么」——
// 答案是"派生件原本只有按角色那一节，而 `host.ui` 不在任何角色名单里 ⇒ 它没有落点可去"。
// 但**"没有角色要封它"本身是个事实，不该因此从产出里消失**（那正是「未归类＝默认敞开且没人知道」的另一面）。
// 两处要用（文档 §三b 尾 ＋ 派生件 `unclaimed` 节）⇒ **一处实现，不许各算一遍**。
function unclaimedCapabilities() {
  const claimed = new Set()
  for (const rid of roleIds) {
    const r = TABLE.roles[rid]
    const ex = new Set((Array.isArray(r.codebuddy && r.codebuddy.denyExempt) ? r.codebuddy.denyExempt : [])
      .map((e) => e && e.cap).filter(Boolean))
    for (const c of (r.deny || [])) if (!ex.has(c)) claimed.add(c)
  }
  return CAP_ORDER.filter((cid) => !claimed.has(cid))
}

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
  const enfZh = { enforced: '**宿主强制**（已在本机核实到源码级）', 'declared-unverified': '**只有声明，未核实是否生效**', 'proven-mechanism': '**机制已实测 · 载体已建**（落点＝宿主配置目录下的 agent 定义，由 `scripts/install-wb-agents.mjs` 装盘；**改已有文件要重启宿主才生效**，见 §七）' }
  L.push((enfZh[host.enforcement] || host.enforcement) + '。' + host.enforcement_note)
  L.push('')
  L.push('对比 DSH 形态：那边的角色工具面是**宿主强制**的——子代理的 deny 名单由宿主在挂载期编译，写错名字直接挂载失败（不是失败在第一次派工），')
  L.push('而且过滤作用于子代理继承到的整个工具面。本形态是**同一个机制（`disallowedTools`）＋已实测的三种命运**：名单里哪个名字真拦得住，')
  L.push('由 §三b 的四桶说了算——**第三节的名单不再等同于"已经封掉什么"**，它必须与四桶一起读。')
  L.push('')
  L.push('三种形态（映射的键，不是角色的属性）：')
  L.push('')
  for (const f of FORMS) L.push('- **' + f + '**：' + host.forms[f])
  L.push('')
  L.push('## 三、角色 × 能力（本宿主工具真名）')
  L.push('')
  L.push('| 角色 | 形态 | 封掉的能力 | 本宿主工具真名 | 本形态没有/未核实 |')
  L.push('|---|---|---|---|---|')
  const exemptRows = []
  for (const rid of roleIds) {
    const r = TABLE.roles[rid]
    const { names, skipped, exempted, form } = faceOf(rid, 'codebuddy')
    const seat = r.codebuddy && r.codebuddy.seat ? '（' + seatZh[r.codebuddy.seat] + '）' : ''
    const un = skipped.map((s) => s.cid + '（' + (s.status === 'none' ? '本形态无此工具' : '未核实') + '）')
    const denyCell = r.deny.length
      ? r.deny.join('、') + (exempted.length ? '　**（本形态有意豁免：' + exempted.map((e) => e.cid).join('、') + '）**' : '')
      : '（不封任何能力）'
    if (exempted.length) exemptRows.push({ zh: r.zh, rid, exempted })
    L.push('| ' + r.zh + seat + ' | ' + form + ' | ' + denyCell + ' | ' +
      (names.length ? names.map((n) => '`' + n + '`').join(' ') : '—') + ' | ' + (un.length ? un.join('；') : '—') + ' |')
  }
  L.push('')
  L.push('「封掉的能力」一列是宿主无关口径（与 DSH 形态同一张表推导）；「工具真名」一列才是可以写进 disallowedTools 的东西。')
  L.push('同一列里既有名字又有"—"，差别不是重不重要，而是**这个形态下有没有这个工具**：没有工具可禁时，那条 deny 是空操作。')
  L.push('')
  // ── 三b. 四桶（2026-09-23）：**一个名字写进名单之后会怎样**——本文件里最该带走的一张表。
  // 为什么单列一节而不并进 §三 的表：§三 回答"该封什么"，这一节回答"封得成吗"。混在一起，
  // 读者会把名单里的名字与"已封"当同义词——而 C 桶的表观与"已封"**一模一样**（不报错、也不拦）。
  {
    const dr = host.deny_readings || {}
    L.push('## 三b、一个名字写进 `disallowedTools` 之后会怎样（四桶 · 2026-09-23 实测）')
    L.push('')
    L.push('同一张名单里，名字的命运**不是一种**。这张表是本形态唯一能回答"封不封得住"的东西，' +
      '也是"哪个名字可以进生产名单"的唯一判据。')
    L.push('')
    L.push('| 桶 | 机器表现 |')
    L.push('|---|---|')
    for (const b of ['A', 'B', 'C', 'D']) {
      if (dr.buckets && dr.buckets[b]) L.push('| **' + b + '** | ' + dr.buckets[b] + ' |')
    }
    L.push('')
    L.push('| 名字 | 桶 | 原始报文（逐字） |')
    L.push('|---|---|---|')
    for (const e of (dr.names || [])) {
      L.push('| `' + e.name + '` | **' + e.bucket + '** | ' + String(e.raw || '').replace(/\n/g, ' ') + ' |')
    }
    L.push('')
    const ba = dr.bulk_attested || {}
    for (const b of ['A', 'B', 'C', 'D']) {
      const list = (ba[b] || []).filter(Boolean)
      if (list.length) L.push('- **' + b + ' 桶**（批量标注，非本轮逐条重取）：' + list.map((n) => '`' + n + '`').join('、'))
    }
    L.push('')
    for (const n of (dr.bucket_notes || [])) L.push(n)
    L.push('')
    // §三b 尾：**没有任何角色认领的能力**（现算）。WB 侧 §5.1 问的"host.ui 为什么不在任何名单里"，
    // 答案要落在这份文档里——不能让读者去猜是漏了还是有意。
    {
      const un = unclaimedCapabilities()
      L.push('**没有任何角色认领的能力（现算）**：' + (un.length
        ? un.map((cid) => '`' + cid + '`（' + TABLE.capabilities[cid].zh + '）').join('、') +
          ' —— 它们在本宿主下的名字**不会出现在任何一座的名单里**。分两种，别混：' +
          '①**按设计不需要封**（如 `host.ui` 的交付/自述/展示面：不与书数据打交道，登记进能力表只为**不让它们成为「未归类名字」**）；' +
          '②**只有主编可能用到、而主编不封任何能力**（如 `team.admin`）。' +
          '**这就是「它为什么不在任何名单里」的答案**——不必去猜是漏了还是有意。'
        : '本次为空（每个能力都至少被一个角色认领）。'))
      L.push('')
    }
  }
  // ── 三c. 四座盲角色的"盲"不是同一个强度（2026-09-23 WB 侧逐座对账时发现）
  // 声明在能力表（roles[].isolation），条款号经生成器核对**真的在人格真源里**才渲出来——
  // 引用一个查不到的条款＝给下一个人一个错的依据。
  {
    const blindRoles = roleIds.filter((r) => TABLE.roles[r].blind && TABLE.roles[r].isolation)
    if (!blindRoles.length) die('能力表里没有任何带 isolation 声明的盲角色——0 件不等于没问题（这一节会整段消失，而它正是"别打包说"的落点）')
    L.push('## 三c、四座盲角色的「盲」**不是同一个强度**（别打包成一句"四座盲读隔离"）')
    L.push('')
    L.push('逐座对账实测到的差别。**它们是有意为之**，但对外口径必须分开写——一句话打包会把三种强度混成一种，' +
      '而其中一座（拆书员）的活本来就要求读盘。')
    L.push('')
    L.push('| 座 | 隔离强度 | 依据条款 | 条款原文（从人格真源现读） |')
    L.push('|---|---|---|---|')
    for (const rid of blindRoles) {
      const r = TABLE.roles[rid]
      const cell = (s) => String(s).replace(/\|/g, '／').replace(/\s+/g, ' ').trim()
      const txt = r.isolation.clauses.map((c) => {
        const hit = personaCodes.get(c)
        const body = hit ? (hit.text.length > 88 ? hit.text.slice(0, 88) + '…' : hit.text) : '（条款号在人格真源里查不到——生成器本该拦住）'
        return '`' + c + '`：' + body
      }).join('<br>')
      L.push('| ' + cell(r.zh) + ' | **' + cell(r.isolation.strength) + '** | ' +
        r.isolation.clauses.map((c) => '`' + c + '`').join('、') + ' | ' + cell(txt) + ' |')
    }
    L.push('')
    for (const rid of blindRoles) {
      L.push('- **' + TABLE.roles[rid].zh + '**：' + TABLE.roles[rid].isolation.why)
    }
    L.push('')
    L.push('**机器层与纪律层要分清**：上表只有「零读盘」那一档是机器全封的；' +
      '「单文件受限读」的"只读**一个**"**在宿主层做不出来**（deny 只有整工具粒度，没有"只许读一个文件"的写法）' +
      '⇒ 那一档的后半段是纪律。对外写隔离强度时**带上这一条**，别把纪律层的承诺写成机器层的保证。')
    L.push('')
  }
  if (exemptRows.length) {
    L.push('### 本形态有意**不封**的能力（豁免必须带理由，写在这里而不是悄悄少写一个名字）')
    L.push('')
    for (const row of exemptRows) {
      for (const e of row.exempted) {
        L.push('- **' + row.zh + '**：`' + e.cid + '`（对应本宿主工具 ' +
          (e.names.length ? e.names.map((n) => '`' + n + '`').join('、') : '（本形态无此工具）') + '）')
        L.push('  - 理由：' + e.why)
      }
    }
    L.push('')
    L.push('为什么要把豁免也印出来：**静默少封一个名字，与静默封错一个名字一样，都是虚假的安全感**——' +
      '两者的表观都是"没报错"。这张表是唯一能让人看出"这里本该有封锁，但按本宿主的形态有意没做"的地方。')
    L.push('')
  }
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
  // 载体件数**现算**，不在文档里写死（写死＝发一个不会跟着变的数）
  const carrierCount = roleIds.filter((r) => TABLE.roles[r].codebuddy && TABLE.roles[r].codebuddy.agentdef).length
  L.push('## 六、与 DSH 形态的强度差异（读者需要知道的那部分）')
  L.push('')
  L.push('| 机制 | DSH 形态 | 本形态（现状） |')
  L.push('|---|---|---|')
  L.push('| 落账权隔离（只有主编能写账本） | 宿主强制：子代理 deny 掉写账本工具 | **已实测拦得住**（`disallowedTools` 中性同形探针 → `Permission to use … has been denied.`）；载体已建 **' +
    carrierCount + ' 件**、由 `scripts/install-wb-agents.mjs` 装盘。⚠ **装盘 ≠ 生效**：改动**已有**定义文件要重启宿主（见 §七） |')
  L.push('| 盲读输入隔离（盲角色只能读派工包） | 宿主强制：读写文件工具全封 | **机器一层 ＋ 纪律一层**，且**四座强度不一**（见 §三c：零读盘／单文件受限读／读锚书工作必需）。机器那层的作用范围见 §三b 四桶 |')
  L.push('| 盲角色不得发现/执行未加载的工具 | 宿主强制：本预设根本没挂这条通道 | **实测：通道存在且可执行**；**对盲角色已一层封掉**（`ToolSearch`＋`DeferExecuteTool` 一对都渲进了名单）——⚠ 封它＝该座一件 MCP 都拿不到（耦合不变量在装配期拦） |')
  L.push('')
  L.push('**本形态的残留面（2026-09-23 实测，别读成"都封了"）**：三个 A 桶名字此前一直开着，现已渲进名单' +
    '（`WebSearch`／`Edit`／`Skill`）；**剩下的六个仍开着，且在本形态封不干净**——')
  L.push('')
  L.push('| 仍开着的名字 | 为什么 |')
  L.push('|---|---|')
  L.push('| `Write`／`WebFetch` | **B 桶**：拦得住，但每次派工被框架记 `failed` ⇒ 按纪律不渲（**写面与外取面因此是半开的**） |')
  L.push('| `automation_update`／`present_files`／`read_me`／`show_widget` | **C 桶**：写了等于没写（名字仍在、调用真执行）⇒ 收口只能走 DSH 侧或改宿主 |')
  L.push('')
  L.push('引用本形态的隔离结论做重要判断时，请带上这两条限定。日常写作不受影响。')
  L.push('')
  L.push('## 七、给实测用：只含已核实真名的声明片段（先确认落点，再抄）')
  L.push('')
  L.push('下表这几条只由已核实的真名组成（含已实测的 MCP 名），可以直接拿去做运行时红测。')
  L.push('')
  L.push('**载体落点有两个，两级都会被读（2026-09-24 订正）。** 项目级 `<工作区>/.codebuddy/agents/<name>.md`；用户级 `<宿主配置目录>/agents/<name>.md`。')
  L.push('两级都在热加载监视里（日志两侧各有触发：`[HotReload] Triggered by agents change: …\\.codebuddy\\agents/…` 与 `…\\.workbuddy/agents/…`，`[HotReload] Completed for agents`）。')
  L.push('⇒ **同名文件同时出现在两级时谁生效，宿主不定义优先级，本项目也不做互检**——与"用户级 mcp.json 同名静默盖掉包内声明"同族。装完载体后请核一遍另一级有没有同名文件。')
  L.push('1. **包内 `agents/` 不是注册载体**——宿主组件装载器不枚举专家包（日志里 11 个插件各有 `Loaded plugin components for …`，本包一次都没出现）；包内那两份的真实用途是**人格文本的权威来源**，往里补前言块不会让它进表。')
  L.push('2. **热加载是两句话，不是一句（2026-09-23 同文件 A/B 实测）**：**新增一份新定义（新路径）＝即时生效**（同会话内零重启即可派起来）；**改动已有定义的内容＝不生效，必须重启**（装载器有一条按路径的 `already loaded, skipping` 去重，内容冻结在**首次读取的那一版**）。⇒ 纪律照这个写：**改真源 → 重跑安装器 → 重启宿主 → 重跑 `--check` 验哈希**；只有"新增一份新角色"才不需重启。')
  L.push('3. **deny 拦得住**：中性同形探针 `disallowedTools:[mcp__novelist__novel_chapter]` → `Error: Permission to use mcp__novelist__novel_chapter has been denied.`（拦在权限层，未到工具本体）。')
  L.push('')
  L.push('**红测必须用中性同形探针，不要借本座。**WB 侧第一版让"主笔去调它自己被禁的工具"，它**以纪律为由拒发**——')
  L.push('**人格纪律与机器 deny 是混淆变量**，那样测出来的"拒"分不清是谁干的。')
  L.push('**主笔（作者座）的口径（2026-09-23 升级）**：本座读数**已取到**（WB 侧换问法：**只让它列名、不让它调任何工具**，这样纪律与机器拦不会混成同一变量）——')
  L.push('直接可调用面 **21 名**（`Bash` 与本包绑的 8 个 MCP 写入口**都不在其中**）、deferred 注册池 **68 名含全部 15 个 `mcp__novelist__*`**（落账名**可见**）。')
  L.push('⇒ 口径＝**机器两层（挂载期摘名 ＋ 调用期拒绝）＋ 纪律一层**。**仍不许写「主笔已被机器封死」**：`Write`／`Edit` 在本座开着（有意），且落账名可见。')
  L.push('⚠ 两条标注要一起抄：①21 名与 68 名池都是**本座自陈枚举**（非宿主硬返回）；②调用期那半仍是**同形探针**，不是本座自测。')
  L.push('⚠ 另：**探针必须附基线**（WB 侧 09-23 加的一条纪律）——单座自陈没有对照时，既不能证「封住了」，也不能证「从未有过」；这是本项目「自陈不是读数」的镜像。')
  L.push('')
  L.push('**两条省事的取证路径（先走第 1 条，不用重启也不用派探针）**：')
  L.push('1. 日志行 `[AgentTask] agent lookup failed | requested="X" | available=[...]`——那行 `available` 就是现成仪器，直接看"宿主这一刻加载了哪些 agent"。')
  L.push('2. 用户级目录＝app 进程环境变量的 `CODEBUDDY_CONFIG_DIR` 下的 `agents/`（**本机该变量指向宿主自己的配置目录 `.workbuddy`** ⇒ 实为 `~/.workbuddy/agents/`）；')
  L.push('   **以环境变量为准，不要照抄本条的字面值**——换个装法就会分叉。（本节不写机器绝对路径：包内文档零机器路径是硬门。）')
  L.push('')
  L.push('**载体怎么装（2026-09-22 B1 落地）：三层分工，别混。**')
  L.push('1. **人格文本** ＝ 包内 `agents/*.md`〔模板〕（真源＝`roles/persona/`），**不带封名单**——官方校验器对前言块做**子串**判断（出现 `tools:` 即报错），' +
    '而 `disallowedTools:` 含该子串 ⇒ **封名单渲进包内 MD 会立刻不合规**。')
  L.push('2. **宿主载体** ＝ 宿主配置目录下的 `agents/<name>.md`，由安装器**在包内文本之上补前言块与封名单**（名字从能力表现渲，**只渲 enforced**）。')
  L.push('3. **陈旧门** ＝ 安装器 `--check` 逐文件比 sha256。⚠ **它只管盘上**：它比的是"载体文件与真源一致不一致"，' +
    '**验不出"宿主内存里还在用旧的那一版"**——这两件事从 2026-09-23 起必须分开说，否则会出现' +
    '「`--check` 全绿、跑的还是上一版」的假绿灯。')
  L.push('')
  L.push('**五个工种的正文源在 `references/roles/`（派工文本），但那不是定义载体**——往里加前言块不会有任何效果；' +
    '它们的**定义**由安装器生成到宿主载体目录。耦合不变量（封发现面者必须封掉全部 MCP 面能力）在装配期拦。')
  L.push('')
  for (const rid of roleIds) {
    const r = TABLE.roles[rid]
    const { names, skipped, exempted } = faceOf(rid, 'codebuddy')
    if (!names.length && !exempted.length) continue
    const src = r.codebuddy && r.codebuddy.file ? r.codebuddy.file : '—'
    const def = r.codebuddy && r.codebuddy.agentdef ? r.codebuddy.agentdef : '（未登记 agentdef）'
    // 载体路径写成符号形态（`<宿主配置目录>/…`）：它**不在本包内**，写成包内相对路径会被包内引用自证
    // 判成悬空——而那正是"装作它在包里"的错误来源（2026-09-22 实测：这样写会被装配期拦下）。
    // 名单构成**现算**：对外那句「N 个 `mcp__novelist__*` ＋ …」必须由名单本身数出来。手写一个数＝
    // 发一个不会跟着名单变的数（本项目栽过：同一份名单在不同文档里数字不同）。
    const mcp = names.filter((n) => n.startsWith('mcp__'))
    const rest = names.filter((n) => !n.startsWith('mcp__'))
    const how = mcp.length
      ? '（' + mcp.length + ' 个 `mcp__novelist__*`' + (rest.length ? ' ＋ ' + rest.map((n) => '`' + n + '`').join('／') : '') + '）'
      : ''
    L.push('- **' + r.zh + '**（正文源 `' + src + '` → 载体 `<宿主配置目录>/' + def + '`，形态 ' + r.codebuddy.form + '）：`disallowedTools: [' + names.join(', ') + ']`　' + how)
    for (const e of exempted) {
      L.push('  - 本形态有意**不封**：`' + e.cid + '`' + (e.names.length ? '（`' + e.names.join('`, `') + '`）' : '') +
        '——理由：' + e.why)
    }
    // 缺口分三类印，**不许合并**：它们对"现在安不安全"的含义完全不同——
    // C 桶＝写了等于没写、B 桶＝封住了但每次派工被记 failed、none＝根本没有东西可禁。
    for (const s of (skipped || [])) {
      if (s.status === 'ineffective') {
        L.push('  - **⚠ 缺口 · C 桶（写了等于没写，故不渲）**：能力 `' + s.cid + '` 的 `' + s.names.join('`, `') +
          '`——写进去之后**名字仍在工具面里、调用真的会执行**。**不许写进去装作封住了**：静默列进去＝虚假的约束感。' +
          '本行是**如实标注**，不是"以后会修"。')
      } else if (s.status === 'costly') {
        L.push('  - **⚠ 缺口 · B 桶（拦得住，但有代价，故不渲）**：能力 `' + s.cid + '` 的 `' + s.names.join('`, `') +
          '`——写进去名字会被摘掉，但**每次派工都被框架记 `failed`**。按纪律不进生产名单；' +
          '**但这是缺口、不是已封**：这一格对本座仍然是半开的。')
      } else if (s.status === 'none') {
        L.push('  - ○ 空操作（本形态没有这个工具）：能力 `' + s.cid + '`——禁了不报错也不生效。' +
          '属"没有东西可禁"，与上面两类缺口**不是一回事**（把它读成"已封"是过度乐观）。')
      } else {
        L.push('  - **⚠ 意图已登记、本形态尚未生效**（`' + s.status + '`）：能力 `' + s.cid + '`' +
          (s.candidates && s.candidates.length ? '（候选名 `' + s.candidates.join('`, `') + '`）' : '') +
          '——' + (s.why || '未核实') +
          '。**这不等于已封**：名字没渲进名单之前，该工具对本座仍然是开着的。')
      }
    }
    L.push('  - 落点：宿主配置目录下的 `agents/`（见上第 2 条；安装器 `--check` 可验**盘上**是否陈旧）')
  }
  L.push('')
  L.push('预期：**A 桶**名字应当直接失败或被拒；**B／C 桶的不会**（见 §三b 与该座的缺口行）——' +
    '它们凭什么被挡，那是纪律层的事。**若 A 桶名字照样能调通，说明本形态的 deny 不生效**——' +
    '那就要如实降级到"纪律约束"，并把这条写进交付说明，而不是当它生效了。')
  L.push('')
  L.push('**重启前必须先跑的那一条（2026-09-23 起生效的门）**：本名单里 `Edit`／`Skill`／`WebSearch` 三个名字的读数，' +
    '都是**在"只封它一个"的探针座上**取到的；**「目标座这一整份名单 ＋ 它们」这个组合没有测过**。' +
    '而 D 桶（座位直接起不来）的报错名字**不固定**（单测报它自己、三项同写报 `Read`）⇒ **不许拿单名读数反推组合安全**。' +
    '做法：**新建**一份探针文件（新路径＝即时生效），前言块照抄目标座的 `disallowedTools` 全名单，派一次，' +
    '看它起不起得来、`TOOLS=` 里那几个名字在不在。**过了再重启；不过就回退名单。**' +
    '（为什么用新文件：改动已有文件要重启，而这条探针的**全部意义**恰恰是在重启**之前**确认。）')
  L.push('')
  L.push('两条本宿主实测纪律：①**"热加载"是两句话，不是一句**——2026-09-23 WB 侧用同文件 A/B 钉死了：' +
    '**新增一份新定义（新路径）＝即时生效**（同会话内零重启即可派起来）；' +
    '**改动已有定义的内容＝不生效，必须重启**（`AgentLoader.loadFromPaths` 有一条按路径的 `already loaded, skipping` 去重，' +
    '内容冻结在**首次读取的那一版**）。⇒ 纪律照这个写：**「改真源 → 重跑安装器 → 重启宿主 → 重跑 `--check` 验哈希」；' +
    '只有「新增一份新角色」才不需重启。** 别写"改完即生效"——那是两句承诺里错的那一句。' +
    '②"某工具缺席"类结论拿不到硬证据（不在清单里就发不起调用）——唯一出口是**强行发起一次对它的调用**，逼调度层回 `Tool Not Found`。')
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
      '**WorkBuddy 侧（载体已建，名单与缺口都在生成件里）**：本角色应封的能力与**本宿主工具真名**见 `../宿主工具面.md`〔包内〕（生成件）。' +
      '**deny 机制已实测拦得住**（同形中性探针 → `Permission to use … has been denied.`），落点＝**宿主载体**（`<宿主配置目录>/agents/*.md`，由 `scripts/install-wb-agents.mjs` 从能力表渲染安装）。' +
      '**两件如实标注**：①已实测拦不住的名字（`PowerShell`）**不渲进名单**，但也**不许当成封住了**；②本形态的盲读隔离＝**机器拦一层＋纪律一层**，' +
      '证据力仍低于 DSH 形态（那边是宿主在挂载期强制编译名单）——交付说明照此写，别写成"已机器封死"。',
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

// ── 七、宿主载体封名单（机器可读派生件，2026-09-22 B1）
// 它属于 codebuddy 侧产物（宿主载体是 CodeBuddy 的工作方式），所以**必须留在 wants('codebuddy') 里**——
// 放在门外会让 `--host dsh` 这条路径也去写 references/，而只跑 DSH 侧的场合未必有那个目录
// （2026-09-22 实测：一放出门外，工具面回归里两条 `--host dsh` 的用例当场红）。
// 为什么把它吐成文件而不是让安装器自己再算一遍：宿主载体（<宿主配置目录>/agents/*.md）
// 里的封名单必须与本生成器**同一份实现**——再算一遍就是第二份实现，而第二份实现就是下一次漂移。
// 安装器（scripts/install-wb-agents.mjs）只消费本件：它负责写盘与陈旧检查，不负责决定封什么。
{
  // 坐标从表里读，不写死在代码里：路径含中文，而约定一致性棘轮禁止代码里出现中文路径字面量
  // （2026-09-22 实测：写死当场把 cjk_paths_in_code 从 0 顶到 1）。表里那条是**包内相对**坐标。
  const rel = 'wb-expert-starter/' + TABLE.hosts.codebuddy.carrier_ledger
  const full = path.resolve(PLUGIN, rel)
  const roles = {}
  for (const rid of roleIds) {
    const r = TABLE.roles[rid]
    const cb = r.codebuddy || {}
    const { names, skipped, exempted, form } = faceOf(rid, 'codebuddy')
    roles[rid] = {
      zh: r.zh,
      form,
      agentdef: cb.agentdef || null,
      sourceText: cb.file || null,
      description: cb.description || null,
      maxTurns: cb.maxTurns || null,
      denyNames: names,
      exempted,
      skipped,
    }
  }
  // ── 两节宿主级台账（2026-09-23）：起因是 WB 侧 §5.1 的质疑——"`automation.write` 进了派生件、
  // `host.ui` 没进，两者对『是否与该座相关』是同级的，至少是口径不一"。
  // `forbiddenNames` 让**装机侧**（没有真源 `roles/`）也能 fail-closed 核对；
  // `unclaimedCaps` 让"这个能力为什么不在任何名单里"**在件里就有答案**，不必让读者猜是漏了还是有意。
  const forbiddenNames = new Set()
  for (const cid of CAP_ORDER) {
    for (const leaf of Object.values(TABLE.capabilities[cid].codebuddy || {})) {
      if (!leaf || typeof leaf !== 'object') continue
      for (const n of leaf.ineffective || []) forbiddenNames.add(n)
      for (const n of leaf.costly || []) forbiddenNames.add(n)
      for (const n of leaf.candidates || []) forbiddenNames.add(n)
    }
  }
  if (!forbiddenNames.size) {
    die('派生件自证失败：算出来的「永不渲入名单」名字集是空的——空集比报错更危险：'
      + '它会让装机侧那道 fail-closed 核对形同虚设（而且装机侧没有真源可以对照，只能采信这份件）')
  }
  const unclaimedCaps = unclaimedCapabilities().map((cid) => {
    const cap = TABLE.capabilities[cid]
    const v = leafOf(cap, 'codebuddy', FORMS[0])
    const out = { cid, zh: cap.zh }
    // 三种叶形都要如实带出来：渲得进名单的（tools）／整格缺口（ineffective、costly）／没有取值（status）。
    // 只写 status 会把 `host.ui` 印成 `unknown`——而它其实**有名字、只是实测封不住**，那是两件不同的事。
    if (v && Array.isArray(v.tools)) out.tools = v.tools
    else if (v && Array.isArray(v.ineffective)) out.ineffective = v.ineffective
    else if (v && Array.isArray(v.costly)) out.costly = v.costly
    else out.status = (v && v.status) || 'unknown'
    if (v && v.why) out.why = v.why
    return out
  })
  // 空数组是**合法**状态（每个能力都有角色认领）——与"扫不到就报绿"不同：这里的 0 可达且可解释。
  // 但**不许静默**：件里要带一句人话说明，读者不必去猜是漏了还是真没有。
  const unclaimedNote = unclaimedCaps.length
    ? '**没有任何角色认领的能力**（现算，不是手写）：这些能力在本宿主下的名字不会出现在任何一座的名单里。'
      + '分两种，别混：①**按设计不需要封**（如 `host.ui` 的交付/自述/展示面——它们不与书数据打交道，'
      + '登记进能力表只为**不让它们成为「未归类名字」**）；②**只有主编可能用到、而主编不封任何能力**（如 `team.admin`）。'
      + '列出来是为了让"它为什么不在任何名单里"**在件里就有答案**，而不是要读者去猜是漏了还是有意。'
    : '**没有任何角色认领的能力：本次为空**（每个能力都至少被一个角色认领）——'
      + '这是可达且可解释的状态，不是"扫不到"；若它长期为空，说明这个字段可以删掉，而不是留着当一个永远空的出口。'

  const payload = {
    _generated_by: 'roles/build-tool-face.mjs',
    _source: REL_TABLE,
    _note: '机器可读派生件：宿主载体（agent 定义）的前言块与封名单由它说了算。**手改无效**——' +
      '跑生成器重生成。为什么单列一份：包内 agent 定义**不许**带 disallowedTools（官方校验器做子串判断，' +
      '`disallowedTools:` 含 `tools:` ⇒ 渲进包内 MD 立刻不合规），所以封名单只能由宿主载体承载，' +
      '而载体是派生件——派生件必须由生成器给，不许安装器自己再算一遍（那就是第二份实现）。',
    // ── 宿主级两节（2026-09-23 补，起因是 WB 侧 §5.1 的质疑：「`automation.write` 进了派生件、`host.ui` 没进，
    // 两者对『是否与该座相关』是同级的，至少是口径不一」）。
    // 答案是：这份件原本**只有按角色分的一节**（每座渲什么、跳什么），而 `host.ui` 不在任何角色名单里
    // ⇒ 它没有"落点"可去。**但"没有角色要封它"本身是个事实，不该因此从件里消失**（那就是本项目
    // 「未归类＝默认敞开且没人知道」的另一个面）。故补两节：宿主级连带行为 ＋ 未被任何角色认领的能力。
    couplings: TABLE.hosts.codebuddy.couplings || {},
    _couplings_note: '**禁一条会顺带影响什么**（宿主级事实，不属于任何单个角色）。为什么必须进这份件：' +
      '写面隔离现在就挂在 `fs.edit` → `Write` 那条**未文档化的宿主连带行为**上——装机侧若只看按角色那一节，' +
      '会以为写面是关的而不知道它是**宿主给的**；宿主哪天不连带，隔离静默变宽，而件里一个字都不会变。',
    _forbidden: [...forbiddenNames].sort(),
    _forbidden_note: '**任何时候都不许渲进名单的名字**（实测拦不住／拦得有代价／只是候选）。带着它，安装器在' +
      '**没有真源（`roles/tool-face.json`）的装机侧**也能做 fail-closed 核对——否则装机侧只能采信这份件，' +
      '无法判断"名单里这个字是不是本来就不该渲"。',
    unclaimed: unclaimedCaps,
    _unclaimed_note: unclaimedNote,
    roles,
  }
  const next = JSON.stringify(payload, null, 2) + '\n'
  const prev = fsSync.existsSync(full) ? fsSync.readFileSync(full, 'utf8') : null
  const shortRel = path.relative(ROOT, full).split(path.sep).join('/')
  if (prev === next) results.push({ rel: shortRel, status: 'ok', note: '宿主载体封名单与能力表一致' })
  else if (CHECK) results.push({ rel: shortRel, status: 'drift', note: '宿主载体封名单与能力表不一致' })
  else { await fsp.writeFile(full, next); results.push({ rel: shortRel, status: 'written', note: '宿主载体封名单已刷新' }) }
  }
}   // ← 关 `if (wants('codebuddy'))`

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
