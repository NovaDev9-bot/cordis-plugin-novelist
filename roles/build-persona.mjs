#!/usr/bin/env node
/**
 * build-persona.mjs —— 从**人格真源**生成各化身的人格段（`roles/persona/*.json` → 派生件）
 *
 * 用法：
 *   node roles/build-persona.mjs [--check] [--only <role>] [--root <仓库根>]
 *
 * ── 写盘契约（与**第一例** build-tool-face.mjs 同一套，本脚本不发明第三种语义）
 *   带 --check：**只判定，一个字节都不写**。
 *     0 = 每一份化身都与真源逐段相同
 *     1 = 有化身与真源**字符**不同（段落对得齐）——源改了、化身没跟上
 *     2 = **判定不了**（找不到锚点 / 段数不符 / 真源读不到 json / 比对化身数=0 /
 *         报不出两份预设里的任何一份 …）——结构问题优先于漂移
 *   不带 --check（＝写盘）：**把每一份"内容与真源不同"的化身按真源重写**——YAML 折叠标量与
 *     md 段落两条路都写，md 不开例外（locateMdRegion + reflow 算出来的新内容就是该落盘的内容）。
 *     写盘后 0 = 盘上已与真源对齐。
 *     2 = 判定不了（同上，结构问题）⇒ **整体不写盘**：算不出"对齐后长什么样"就不落盘，不猜。
 *   `--apply` 是"写盘"的显式写法（同一个模式，不是第三个语义）——留着只为兼容
 *   roles/persona/*.json 的 _note 里那句 `node roles/build-persona.mjs --apply`。
 *   没有 --force / --yes 这类要人记得住的开关：--check 判定，不带 --check 写盘，两种模式够了。
 *
 * ── 为什么要有它（根因，不是背景）
 * 人格此前是手抄的：同一句话活在三份化身里（两份预设的折叠标量 + 派工文本一行到底），改一处
 * 漏三处，没有任何机器会报。本脚本是"能力表 × build-tool-face.mjs"那套做法的**第二例**，
 * 对象从工具名换成散文：真源是 `roles/persona/*.json`（一处），化身是生成物（多份）。
 * 同一条纪律：本脚本里**不写任何一句人格正文**——正文只从真源读，比对只按结构定位。
 *
 * ── 判定（都会真的报红，不是装饰）
 * ① 比对单位＝**段落列表**：按空行切段，段内**去掉所有空白**后逐段比较。空白是排版不是口径
 *    （仓内既有惯例，见 text-invariants.mjs 的 norm）：预设用折叠标量、派工文本一行到底，
 *    折行方式本就不同，按原样比会把排版差读成口径差。**段数不同＝不符**（对不齐就不比，
 *    免得"这段配那段"配出假绿）。
 * ② 只碰一个标量/一段正文：YAML 只改锚块里 `persona: >-`（或裸键 `prefix: >-`）这一个标量的
 *    正文行——注释、缩进、toolFilter、maxDepth 一个字节都不碰；Markdown 只核「## 人格」到
 *    下一个 `---` 之间的正文（同文件里的「## 工具面（生成区）」是另一台生成器
 *    build-tool-face.mjs 的地盘）。正文两侧的空行按原样保留（空行是排版，不借机重排）。
 *    ——**md 的段内软折行是排版，不触发写盘**：CommonMark 软换行渲染为空格，改它不动口径，
 *    却会让"七份 md 逐字节不变"这条字节纪律失效。所以 **内容**已与真源相同（段边界对齐 +
 *    逐段字符相同）的 md 化身，即使盘上排的是软折行也**不动它的字节**（只在报告里点名）。
 *    但**内容**不同（真源改了、化身没跟上）时，md 与 YAML 一视同仁：按真源重写这一段，
 *    重写出来的自然就是"一段一行"的规范形态——**不为 md 开例外，也不只让 YAML 生效**。
 *    （这条纪律是刻意设计：排版差不该被当成口径差，也不该让"重排一次"把七份 md 全改一遍。）
 *    YAML 折叠标量另有一条：折行会往正文里塞进源文本没有的空格（`…最心疼的` ／ `稿子。`
 *    折起来变出一个空格），所以**内容相同也要重排成"一段一行"**（字节变、口径不变），报告里点名。
 *    **一份文件可能被多个角色各改一段**（一份预设里 7 个锚块）：写盘必须按文件**合并成一次**
 *    （同一份 raw 上算出的多份新内容逐个 writeFileSync 会互相覆盖，只剩最后一份——只登记一个
 *    角色时看不出来，登记七个就丢掉六个）。
 * ③ 段内不折行：真源里的段文本必须是一行；要段边界就自带空行。段文本里出现单个换行＝exit 2
 *    （宁可红，也不写出一行被悄悄折成两行的正文）。
 * ④ 反向核对（真源漏管的化身＝下一个会漂的副本）：凡能力表 `hosts.dsh.presets` 里列出、且
 *    真的含本角色锚块的预设，以及能力表 `roles.<role>.codebuddy.file` 指的那份文件，
 *    都必须是本角色真源登记过的化身——没登记＝exit 2。预设清单只有一个家（能力表），
 *    本脚本不另写一份路径。
 * ⑤ 两种落地形态都要认：mono（dsh-native/ + vault/ 的私有仓）与 flat（公开仓 clone）。
 *    flat 里没有生产预设——**至少命中一份预设**，一份都没有＝exit 2；缺的那份显式登记，
 *    不静默跳过。mono 里两份预设都在，所以**缺预设化身也报红**（与 md 化身同族：少了一份
 *    ≠ 干净；不静默跳过）。
 * ⑥ 层与段 id 互核：id 里的缩写（obl/aud/host）必须与 layer 全名说同一件事——不然改一个字段
 *    就换了层，"义务"于是没有类型（aud/host＝"合法可不同"，obligation＝"跨化身逐字相同"）。
 * ⑦ 义务层必须被该角色的**全部**化身引用：obligation 的强度整个挂在覆盖率上，只核
 *    usedBy ↔ 化身清单互相吻合挡不住"从某份化身上悄悄摘掉、顺手删掉 usedBy"。
 *  另有一项**只报告、不判定**：人格真源覆盖了能力表里的几个角色（少登记几个角色在结果上
 *    与"全覆盖"长得一样，故显式打出来；未迁移的角色不是缺陷，故不设门禁）。
 * ⑧ 跨角色共享（可选真源 `roles/persona/_shared.json`）：文件在，其中的 `shared.<层>.<短名>`
 *    就是**公共池**——任何角色的任何化身都能引用它（同一句义务在多个角色身上只写一遍，改一处
 *    全部角色跟着走）；文件不在＝没有这一层，不报错、不造默认值。公共池的 `usedBy` 写的是
 *    **角色名**（写化身 id 说不清是谁的：`dsh-prod` 七个角色各有一份，重名），生成器双向核对
 *    "登记的角色 ↔ 真的引用了它的角色"；`shared.obl.*` 同样要求"该角色的每一份化身都引用"。
 *    角色文件里**不许**再出现 `shared.` 前缀的段 id——公共池只有一个家。
 *
 * ── 元纪律（本项目 2026-09-18 审计第一性根因）
 * "缺失没有类型"：找不到锚点、读不到真源目录、段数不符、比对化身数=0——一律 exit 2，
 * 不许当"通过"，不许回落默认值，不许拿写死的期望字符串充数。
 * 报告里另有一项**只报告、不判定**的信息：重排后字节是否与盘上相同。折叠标量必然"会变"
 * （5 行折行排成 1 行，字节变、口径不变），所以它不能当门禁——只让 reviewer 一眼看出
 * 哪几份化身这次真的动了字节。
 * 另：写盘这条路**写盘前先自跑一遍比对**——把每一份"待写内容"合并出来、重新定位锚点、解析回
 * 段落，与真源逐段核对（重排函数与解析函数是两套代码，得让它们互相证明，不借"上面刚比过"
 * 的信任）；任何一份读不回原样 ⇒ **整体不写盘、退出 2**。写盘**后**再核对一次：写下去的
 * 内容 == 计划内容，**凡不在计划里的化身，字节必须与写前快照逐字节相同**，且**凡不在计划里
 * 的化身，其正文区必须与写前逐字相同**（字节纪律由机器兜底，不靠"我只改了该改的"这句自述）。
 * 一处文件里的多个 edit 落盘前先核**区间不重叠**：重叠意味着后一次 splice 会写到别人的行上
 * （build-tool-face.mjs 第一版正是栽在这——行号在 splice 后整体位移，名单写进了别人的条目）。
 */
import fsSync from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const argv = process.argv.slice(2)
const opt = (n) => { const i = argv.indexOf(n); return i !== -1 && argv[i + 1] !== undefined ? argv[i + 1] : null }
// 两条路：带 --check 只判定；不带 --check＝写盘（`--apply` 是同一个模式的显式写法）。
// 与第一例 build-tool-face.mjs 相同——`CHECK = argv.includes('--check')`，其余一律是写盘。
const CHECK = argv.includes('--check')
const APPLY_ALIAS = argv.includes('--apply')

const die = (msg, hint) => {
  console.error('[persona] 拒绝执行：' + msg + (hint ? '\n  提示：' + hint : ''))
  process.exit(2)
}
if (CHECK && APPLY_ALIAS) die('--check 与 --apply 是同一个开关的两面：给了 --check 就只判定、不写盘')
const MODE = CHECK ? 'check' : 'apply'
const ONLY = opt('--only')
if (ONLY !== null && (ONLY === '' || ONLY.startsWith('--'))) {
  die('--only 后面要跟一个角色名（能力表 roles 里的键，如 archivist）')
}
if (MODE === 'check' && argv.includes('--only') && ONLY === null) die('--only 后面要跟一个角色名')

// 两种落地形态（同 build-tool-face.mjs / text-invariants.mjs 的判据；取**最外层**命中者——
// 扁平判据在 monorepo 里对插件子仓同样成立，就近取会把 monorepo 根误判成它自己）
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
const LAYOUT = isMono(ROOT) ? 'mono' : (isFlat(ROOT) ? 'flat' : '?')
if (LAYOUT === '?') {
  die('--root 指的这个目录既不像 mono 也不像 flat：' + ROOT,
    'mono 判据＝同时有 ' + MONO_MARKERS.join(' 与 ') + '；flat 判据＝同时有 ' + FLAT_MARKERS.join(' 与 '))
}
const PLUGIN = isMono(ROOT) ? path.join(ROOT, 'dsh-native', 'plugin-novelist') : ROOT
const TPL = path.join(PLUGIN, 'wb-expert-starter')
const REL = (p) => path.relative(ROOT, p).split(path.sep).join('/')
const REL_PLUGIN = (p) => path.relative(PLUGIN, p).split(path.sep).join('/')

// ── 真源：roles/persona/*.json ───────────────────────────────────────────────
const PERSONA_DIR = path.join(PLUGIN, 'roles', 'persona')
if (!fsSync.existsSync(PERSONA_DIR)) {
  die('真源目录不存在：' + REL_PLUGIN(PERSONA_DIR),
    '人格真源就在插件仓的 roles/persona/ 下（与 roles/tool-face.json 同一层）——它不在这个根下，'
    + '多半是 --root 指错了。实得 ROOT=' + ROOT + '，PLUGIN=' + PLUGIN)
}
// `_` 开头的不是角色：`_shared.json` 是跨角色共享段的公共池（下面单独加载，见 ⑧）。
const personaFiles = fsSync.readdirSync(PERSONA_DIR).filter((f) => f.endsWith('.json') && !f.startsWith('_')).sort()
if (personaFiles.length === 0) {
  die('真源目录里没有任何角色 *.json：' + REL_PLUGIN(PERSONA_DIR)
    + '（0 件不等于干净——这一轮该有很多角色；`_shared.json` 是公共池、不是角色，顶不了数）')
}

// 能力表是真源的对侧（角色有哪些化身、预设路径的唯一家）。它不在＝落位不对，宁可红。
const TABLE_PATH = path.join(PLUGIN, 'roles', 'tool-face.json')
if (!fsSync.existsSync(TABLE_PATH)) die('能力表不存在：' + REL_PLUGIN(TABLE_PATH), '人格真源的化身清单要与能力表互核，缺一不可')
const TABLE = JSON.parse(fsSync.readFileSync(TABLE_PATH, 'utf8'))

const LAYERS = ['obligation', 'audience', 'host']
const KINDS = ['yaml-persona', 'md-persona']

// ── 条款锚点（A3 · 2026-09-22）───────────────────────────────────────────────
// 真源段可带 `code`（稳定号）。带 code 的段在**所有化身**里渲染成「〔CODE〕正文」——
// 引用用稳定号，序号只作导航。业界依据（原文摘句与 URL 见 docs/planning/整改总计划_2026-09-21.md §九）：
//   · NASA NPR 7150.2D：位置号（3.12.1）＋稳定号 [SWE-052] 并存，**引用只写稳定号**；
//   · SARIF v2.1.0 §3.49.3：rule id **SHALL** be stable、SHOULD be opaque；§3.49.4
//     `deprecatedIds`：改号必须留旧号映射（旧号不得回收）；
//   · OWASP ASVS：纯位置号会随版本漂移（其 README 明说）——所以这里**不**用「纪律⑤」式位置号。
// 格式：`<角色前缀>-<两位序号>`；序号一经发布不改、不复用（要改就进 deprecated 清单）。
const CODE_RE = /^[A-Z]{2,6}-\d{2}$/
const CODES = new Map()   // code -> 段 id（跨角色查重；同一段出现在多个化身里不算撞号）
function renderSeg(s, where) {
  if (typeof s.text !== 'string') die(where + '：段「' + s.id + '」没有 text')
  if (s.code === undefined) return s.text
  if (typeof s.code !== 'string' || !CODE_RE.test(s.code)) {
    die(where + '：段「' + s.id + '」的 code 必须是「<前缀>-<两位序号>」（如 AUTH-03），收到「' + s.code + '」',
      '序号要**不透明**（SARIF §3.49.3）：别把语义写进号里——规则实现改了，语义化的号会长期误导读者')
  }
  if (CODES.has(s.code) && CODES.get(s.code) !== s.id) {
    die(where + '：条款号撞号「' + s.code + '」——' + CODES.get(s.code) + ' 与 ' + s.id + ' 用了同一个号',
      '稳定号的唯一意义是可引用：撞号＝两个条款共用一个引用。改号只许进 deprecated 清单，不许回收旧号')
  }
  CODES.set(s.code, s.id)
  // 号插在**前导空白之后**：段的段落边界由前导换行决定，插在换行之前会把段落结构改掉。
  const lead = /^\s*/.exec(s.text)[0]
  return lead + '〔' + s.code + '〕' + s.text.slice(lead.length)
}

// ── 跨角色共享段（可选真源 roles/persona/_shared.json）──────────────────────
// 文件不在＝没有这一层，不报错、不造默认值（"缺失没有类型"管的是"该有的缺了要报"，不是
// "没造的东西也要报"）。在，则其中的段是公共池：任何角色的任何化身都能引用它。
const SHARED_PATH = path.join(PERSONA_DIR, '_shared.json')
const sharedSegs = new Map()    // 段 id -> 段文本
const sharedUsedBy = new Map()  // 段 id -> [角色名]
if (fsSync.existsSync(SHARED_PATH)) {
  const w = REL_PLUGIN(SHARED_PATH)
  let sd
  try { sd = JSON.parse(fsSync.readFileSync(SHARED_PATH, 'utf8')) } catch (e) { die('共享真源读不出来：' + w + '：' + e.message) }
  if (!Array.isArray(sd.segments) || sd.segments.length === 0) {
    die(w + '：segments 必须是非空数组',
      '共享池里 0 个段＝这个文件没有存在的理由；要么写段，要么删掉它（删掉＝没有共享层，本脚本照样跑）')
  }
  for (const s of sd.segments) {
    if (!s || typeof s.id !== 'string' || !/^shared\.(obl|aud|host)\.[a-z0-9.-]+$/.test(s.id)) {
      die(w + '：共享段的 id 必须写成 `shared.<层>.<短名>`（层用 obl/aud/host 缩写），收到「' + (s && s.id) + '」',
        '共享段之所以能被任何角色引用，靠的就是这个前缀——写成角色名前缀等于把公共池私有化了，'
        + '也就等于同一句话又抄成了两份')
    }
    if (sharedSegs.has(s.id)) die(w + '：共享段 id 重复「' + s.id + '」——同一处只能有一个家')
    if (!LAYERS.includes(s.layer)) die(w + '：段「' + s.id + '」的 layer 只认 ' + LAYERS.join(' / ') + '，收到「' + s.layer + '」')
    const abb = /^shared\.(obl|aud|host)\./.exec(s.id)[1]
    const want = { obl: 'obligation', aud: 'audience', host: 'host' }[abb]
    if (s.layer !== want) {
      die(w + '：段「' + s.id + '」的 id 写着 ' + abb + '（＝' + want + '），layer 却是「' + s.layer + '」',
        '层有两种写法（id 缩写 / layer 全名），就必须互核——不然改一个字段就换了层，义务层就没了类型')
    }
    if (typeof s.text !== 'string' || s.text.trim() === '') die(w + '：段「' + s.id + '」的 text 必须是非空字符串')
    assertNoSoftWrap(s.text, w + '：段「' + s.id + '」')
    if (!Array.isArray(s.usedBy)) {
      die(w + '：段「' + s.id + '」的 usedBy 必须是数组（可空；写**角色名**，不是化身 id——化身 id 在各角色间重名）')
    }
    sharedSegs.set(s.id, renderSeg(s, w))
    sharedUsedBy.set(s.id, [...new Set(s.usedBy)])
  }
}

// ── 纯文本工具（本脚本不含任何人格正文）────────────────────────────────────
const stripWS = (s) => s.replace(/\s+/g, '')            // \s 含 U+3000 全角空格
const splitLines = (t) => t.split(/\r?\n/)
const eolOf = (t) => (t.includes('\r\n') ? '\r\n' : '\n')
// 「正文区」→ 段落列表（已剥空白）：非空行连成一段，空行分段。
// 折叠标量与 Markdown 段落共用这一套解析——两者的折行都是排版。
function regionParas(lines) {
  const out = []
  let cur = []
  for (const l of lines) {
    if (l.trim() === '') { if (cur.length) { out.push(cur.join(' ')); cur = [] } } else cur.push(l.trim())
  }
  if (cur.length) out.push(cur.join(' '))
  return out.map(stripWS)
}
function splitBlankEdges(lines) {
  let a = 0
  while (a < lines.length && lines[a].trim() === '') a++
  let b = 0
  while (b < lines.length - a && lines[lines.length - 1 - b].trim() === '') b++
  return { lead: lines.slice(0, a), body: lines.slice(a, lines.length - b), trail: lines.slice(lines.length - b) }
}
// 真源拼出来的段落：段与段直接相接（不插分隔符），需段边界就自带空行。
// 段内不许折行——真源里一个换行就是"一行被悄悄折成两行"的种子（角色段与共享段共用这一条）。
function assertNoSoftWrap(text, ctx) {
  for (const p of String(text).replace(/\r\n/g, '\n').split(/\n{2,}/)) {
    if (p.includes('\n')) {
      die('段文本里出现了单个换行（段内不折行）：' + ctx,
        '要段边界就写空行（空行＝段边界）；正文一行到底，折行交给生成器按化身形态决定')
    }
  }
}
function paragraphsOfJoined(joined, ctx) {
  assertNoSoftWrap(joined, ctx)
  return joined.replace(/\r\n/g, '\n').split(/\n{2,}/).map((p) => p.trim()).filter((p) => p !== '')
}
// 重排：每段一行、不折行；段之间一个空行；缩进＝盘上检出的正文缩进串（不动排版风格）
function reflow(paras, indent) {
  const out = []
  paras.forEach((p, i) => { if (i) out.push(''); out.push(indent + p) })
  return out
}
// 定位差异窗口（用**已剥空白**的字符串，给 reviewer 看得见的最小差）
function diffWindow(ref, got) {
  let i = 0
  while (i < ref.length && i < got.length && ref[i] === got[i]) i++
  let j = 0
  while (j < ref.length - i && j < got.length - i && ref[ref.length - 1 - j] === got[got.length - 1 - j]) j++
  return { ref: ref.slice(i, ref.length - j), got: got.slice(i, got.length - j), at: i }
}

// ── 锚与正文区定位 ─────────────────────────────────────────────────────────
// YAML：`- id: <anchor>` 块里的 `persona: >-`，或裸键 `<anchor>: >-`（如 prefix）。
// 只认 `>-` 折叠标量：检出的写法不是 `>-` 就报红——口径改了要同步改脚本，不静默。
function locateYamlScalar(text, anchor, ctx) {
  const lines = splitLines(text)
  const esc = anchor.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  const idLine = lines.findIndex((l) => new RegExp('^\\s*-\\s*id:\\s*' + esc + '\\s*$').test(l))
  let keyLine = -1
  if (idLine === -1) {
    keyLine = lines.findIndex((l) => new RegExp('^\\s*' + esc + ':\\s*>-[ \\t]*$').test(l))
    if (keyLine === -1) {
      die('找不到锚点：' + ctx + '（既没有 `- id: ' + anchor + '`，也没有裸键 `' + anchor + ': >-`）',
        '锚点是"真源 ↔ 化身"唯一的对接口；它被改名/移动了就报红，本脚本不猜别的块')
    }
  } else {
    const blockEnd = lines.findIndex((l, i) => i > idLine && /^\s*-\s*id:/.test(l))
    const stop = blockEnd === -1 ? lines.length : blockEnd
    for (let i = idLine + 1; i < stop; i++) {
      if (/^\s*persona\s*:/.test(lines[i])) {
        if (!/^\s*persona:\s*>-[ \t]*$/.test(lines[i])) {
          die('锚点 ' + anchor + ' 的 persona 标量不是 `>-` 折叠标量：' + ctx + ' 第 ' + (i + 1) + ' 行「' + lines[i].trim() + '」',
            '本脚本只认 `>-`（段落各写一行）；换成别的标量形态要同步改脚本，不静默')
        }
        keyLine = i
        break
      }
    }
    if (keyLine === -1) {
      die('锚点 `- id: ' + anchor + '` 的块里找不到 `persona:` 标量：' + ctx,
        '锚块从第 ' + (idLine + 1) + ' 行到第 ' + stop + ' 行')
    }
  }
  const indent = lines[keyLine].match(/^\s*/)[0].length
  let end = keyLine + 1
  while (end < lines.length) {
    const l = lines[end]
    if (l.trim() !== '' && l.match(/^\s*/)[0].length <= indent) break
    end++
  }
  return { lines, keyLine, end, indent, eol: eolOf(text) }
}
// Markdown：`<anchor>`（## 人格）到下一个 `---` 之间的正文
function locateMdRegion(text, anchor, ctx) {
  const lines = splitLines(text)
  const h = lines.findIndex((l) => l.trim() === anchor)
  if (h === -1) die('找不到锚点：' + ctx + '（没有一行是 `' + anchor + '`）')
  let stop = -1
  for (let i = h + 1; i < lines.length; i++) {
    if (lines[i].trim() === '---') { stop = i; break }
  }
  if (stop === -1) die('锚点 `' + anchor + '` 之后找不到收口行 `---`：' + ctx, '本段是"标题到下一个 --- 之间"；收口没了就不敢猜边界')
  return { lines, head: h, stop, eol: eolOf(text) }
}

// ── 真源校验（结构问题一律 exit 2：账没记对，谈不上比对）─────────────────────
function validate(doc, file) {
  const where = REL_PLUGIN(file)
  if (typeof doc.role !== 'string' || doc.role === '') die(where + '：role 必须是非空字符串')
  if (typeof doc.zh !== 'string' || doc.zh === '') die(where + '：zh 必须是非空字符串')
  if (!Array.isArray(doc.segments) || doc.segments.length === 0) die(where + '：segments 必须是非空数组')
  if (!Array.isArray(doc.carriers) || doc.carriers.length === 0) {
    die(where + '：角色「' + doc.role + '」在真源里没有任何化身（carriers 必须是非空数组）',
      '化身＝这个角色的正文实际活在哪几份盘上的文件里；不登记就等于没人管它——'
      + '0 份不等于干净，等于"这个角色的化身在哪"这件事没有答案')
  }
  const segIds = new Set()
  for (const s of doc.segments) {
    if (typeof s.id !== 'string' || s.id === '') die(where + '：段的 id 必须是非空字符串')
    // 公共池只有一个家：`shared.` 前缀的段写在 _shared.json 里，不写在角色文件里。
    // （两个家＝同一句话又能被抄成两份，正是本脚本头要防的东西。）
    if (/^shared\./.test(s.id)) {
      die(where + '：段「' + s.id + '」写在角色文件里，但 `shared.` 前缀是公共池的专利',
        '跨角色共享的段改到 roles/persona/_shared.json（一处），角色的 carriers 照旧按顺序引用它的 id')
    }
    // 段 id 里**必须带层**（含共享段）：层从 id 可推，是下一条"层互核"的前提。
    // （旧形态 `shared.` 只匹配字面前缀，等于"跨角色共享"这条从来没真正可用；改成 shared.<层>.<短名>）
    if (!/^(?:shared|[a-z0-9-]+)\.(obl|aud|host)\.[a-z0-9.-]+$/.test(s.id)) {
      die(where + '：段 id 形态不对「' + s.id + '」', '段 id ＝ 角色.层.短名（层写 obl/aud/host）；跨角色共享的段写 shared.层.短名')
    }
    if (segIds.has(s.id)) die(where + '：段 id 重复「' + s.id + '」——同一处只能有一个家')
    segIds.add(s.id)
    if (!LAYERS.includes(s.layer)) die(where + '：段「' + s.id + '」的 layer 只认 ' + LAYERS.join(' / ') + '，收到「' + s.layer + '」')
    // 层不是自由字段：id 里的缩写（obl/aud/host）与 layer 全名必须说同一件事。
    // 只校验 layer ∈ LAYERS 会留下"改一个字段就换层"的路径——把一条义务降格成 aud 全绿过关，
    // 义务层于是没有类型（正是本脚本头要防的"缺失没有类型"：在该概念身上恰恰不成立）。
    const abb = /^(?:shared|[a-z0-9-]+)\.(obl|aud|host)\./.exec(s.id)
    const want = { obl: 'obligation', aud: 'audience', host: 'host' }[abb[1]]
    if (s.layer !== want) {
      die(where + '：段「' + s.id + '」的 id 写着 ' + abb[1] + '（＝' + want + '），layer 却是「' + s.layer + '」',
        '层有两种写法（id 缩写 / layer 全名），就必须互核——不然改一个字段就换了层，义务层就没了类型')
    }
    if (typeof s.text !== 'string' || s.text.trim() === '') die(where + '：段「' + s.id + '」的 text 必须是非空字符串')
    if (!Array.isArray(s.usedBy) || s.usedBy.length === 0) die(where + '：段「' + s.id + '」的 usedBy 必须是非空数组')
  }
  const carrierIds = new Set()
  const carrierSpots = new Set()
  for (const c of doc.carriers) {
    if (typeof c.id !== 'string' || c.id === '') die(where + '：化身的 id 必须是非空字符串')
    if (carrierIds.has(c.id)) die(where + '：化身 id 重复「' + c.id + '」')
    carrierIds.add(c.id)
    // 一个角色在同一份文件的同一个锚点上只能登记**一个**化身：两个＝同一段正文被登记两次，
    // 重排时会算出两条互相重叠的行区间（合并写盘要么错位、要么后写的盖掉先写的）。
    const spot = c.path + '\u0000' + c.kind + '\u0000' + c.anchor
    if (carrierSpots.has(spot)) {
      die(where + '：化身「' + c.id + '」与另一个化身指向同一处（' + c.path + ' § ' + c.anchor + '）',
        '同一段正文只有一个家；重复登记会让重排算出两条重叠的改写区间')
    }
    carrierSpots.add(spot)
    for (const k of ['path', 'anchor', 'host', 'audience']) {
      if (typeof c[k] !== 'string' || c[k] === '') die(where + '：化身「' + c.id + '」的 ' + k + ' 必须是非空字符串')
    }
    if (!KINDS.includes(c.kind)) die(where + '：化身「' + c.id + '」的 kind 只认 ' + KINDS.join(' / ') + '，收到「' + c.kind + '」')
    if (!Array.isArray(c.segments) || c.segments.length === 0) die(where + '：化身「' + c.id + '」的 segments 必须是非空数组')
    for (const id of c.segments) {
      if (!segIds.has(id) && !sharedSegs.has(id)) {
        die(where + '：化身「' + c.id + '」引用了一个不存在的段 id「' + id + '」',
          '缺引用＝这条纪律在这个化身上没有人执行；要么补段，要么从 segments 里去掉'
          + '（跨角色共享的段写在 roles/persona/_shared.json 的 `shared.<层>.<短名>` 下，'
          + (sharedSegs.size ? '本轮的公共池里有 ' + sharedSegs.size + ' 段' : '本轮没有这个文件——公共池是空的') + '）')
      }
    }
  }
  // usedBy 必须与化身清单**双向**对得上（写漏了＝下一次审计才发现的漂移种子）
  for (const s of doc.segments) {
    const declared = [...new Set(s.usedBy)].sort()
    for (const id of declared) {
      if (!carrierIds.has(id)) die(where + '：段「' + s.id + '」的 usedBy 写了一个不存在的化身 id「' + id + '」')
    }
    const actual = doc.carriers.filter((c) => c.segments.includes(s.id)).map((c) => c.id).sort()
    if (declared.join(',') !== actual.join(',')) {
      die(where + '：段「' + s.id + '」的 usedBy 与实际化身清单对不上',
        'usedBy 写＝' + (declared.join('、') || '（空）') + '；实际用它＝' + (actual.join('、') || '（没有化身用它）'))
    }
  }
  // 义务层＝"跨化身必须逐字相同"，它的强度整个挂在"覆盖全部化身"上。
  // 只核 usedBy ↔ 化身清单互相吻合是不够的：一条义务从某份化身上消失、只要同步把 usedBy 里那个 id
  // 删掉，就是完全合法的结构（--check 全绿、--apply 照写）。覆盖率这位此前没人守——
  // archivist.json 的 _note 里那句"usedBy 应覆盖该角色的全部化身"只是人记得住，不是机器认得。
  for (const s of doc.segments) {
    if (s.layer !== 'obligation') continue
    const missing = doc.carriers.filter((c) => !c.segments.includes(s.id)).map((c) => c.id)
    if (missing.length) {
      die(where + '：义务段「' + s.id + '」没有被全部化身引用（缺 ' + missing.join('、') + '）',
        'obligation 的语义＝跨化身逐字相同，故 usedBy 必须覆盖该角色的每一份化身；'
        + '只想给一部分化身，就把它移到 audience/host 层——但那是口径变化，得人拍板，不是改一个字段的事')
    }
  }
  return doc
}

const roles = []
for (const f of personaFiles) {
  const abs = path.join(PERSONA_DIR, f)
  let doc
  try { doc = JSON.parse(fsSync.readFileSync(abs, 'utf8')) } catch (e) { die('真源读不出来：' + REL_PLUGIN(abs) + '：' + e.message) }
  roles.push(validate(doc, abs))
}
if (roles.length === 0) die('真源目录读得到、但没有一个角色被载入（0 个角色不等于干净）')
// 重复的 role 键＝两个家管同一件事，先报红再说（也是"缺失没有类型"的同族：写重了没人会报）
for (const [i, r] of roles.entries()) {
  const dup = roles.findIndex((x) => x.role === r.role)
  if (dup !== i) die('真源里有两个角色都叫「' + r.role + '」：' + REL_PLUGIN(path.join(PERSONA_DIR, personaFiles[dup])) + ' 与 ' + REL_PLUGIN(path.join(PERSONA_DIR, personaFiles[i])))
}

// ── 公共池 ↔ 角色互核（"同一句话只写一遍"必须能被机器核对，不是人记得住）──────
if (sharedSegs.size) {
  const roleNames = roles.map((r) => r.role).sort()
  for (const [id, used] of sharedUsedBy) {
    for (const rn of used) {
      if (!roleNames.includes(rn)) {
        die(REL_PLUGIN(SHARED_PATH) + '：共享段「' + id + '」的 usedBy 写了角色「' + rn + '」，真源里没有这个角色',
          '现有角色：' + roleNames.join('、') + '（usedBy 写的是**角色名**——化身 id 在各角色间重名，写化身 id 说不清是谁的）')
      }
    }
    const want = used.slice().sort()
    const actual = roles.filter((r) => r.carriers.some((c) => c.segments.includes(id))).map((r) => r.role).sort()
    if (want.join(',') !== actual.join(',')) {
      die(REL_PLUGIN(SHARED_PATH) + '：共享段「' + id + '」的 usedBy 与实际引用对不上',
        'usedBy 写＝' + (want.join('、') || '（空）') + '；实际引用它＝' + (actual.join('、') || '（没有角色用它）')
        + '——共享段被最后一个角色摘掉而 usedBy 忘了改，这条就是唯一的报警器')
    }
  }
  // 义务层在公共池里同样是"跨化身逐字相同"：登记使用它的角色，每一份化身都必须引用它
  for (const [id, used] of sharedUsedBy) {
    if (!/^shared\.obl\./.test(id)) continue
    for (const rn of used) {
      const r = roles.find((x) => x.role === rn)
      const missing = r.carriers.filter((c) => !c.segments.includes(id)).map((c) => c.id)
      if (missing.length) {
        die(REL_PLUGIN(SHARED_PATH) + '：共享义务段「' + id + '」没有被角色 ' + rn + ' 的全部化身引用（缺 ' + missing.join('、') + '）',
          'obligation 的语义＝跨化身逐字相同，故 usedBy 覆盖到哪个角色，那个角色的每一份化身都要引用它；'
          + '只想给一部分化身，就把它移到 audience/host 层——但那是口径变化，得人拍板')
      }
    }
  }
}
const picked = ONLY === null ? roles : roles.filter((r) => r.role === ONLY)
if (picked.length === 0) {
  die('--only ' + ONLY + '：真源里没有这个角色', '现有角色：' + roles.map((r) => r.role).join('、'))
}

// ── 化身路径解析（mono / flat 两种布局；两处都存在且不是同一个文件＝不敢猜）────
function resolveCarrier(c) {
  const cands = [path.resolve(ROOT, c.path)]
  const stripped = c.path.replace(/^dsh-native\/[^/]+\//, '')
  if (stripped !== c.path) cands.push(path.resolve(PLUGIN, stripped))
  const uniq = [...new Set(cands)]
  const hits = uniq.filter((p) => fsSync.existsSync(p))
  if (hits.length > 1) {
    die('化身「' + c.id + '」的路径在两种布局下都命中，且不是同一个文件：' + hits.map((p) => REL(p)).join(' 与 '),
      '就近取会把 monorepo 根误判成它自己（build-tool-face.mjs 的第一版就栽在这）——请把 path 写成唯一坐标')
  }
  return { abs: hits.length === 1 ? hits[0] : null, cands: uniq }
}

// ── 反向核对：真源漏管的化身＝下一份会漂的副本 ───────────────────────────────
// 预设清单只有一个家（能力表 hosts.dsh.presets），本脚本不另写一份路径。
for (const role of picked) {
  const yamlAnchors = [...new Set(role.carriers.filter((c) => c.kind === 'yaml-persona').map((c) => c.anchor))]
  const declared = new Set(role.carriers.map((c) => resolveCarrier(c).abs).filter(Boolean))
  for (const rel of (TABLE.hosts && TABLE.hosts.dsh && TABLE.hosts.dsh.presets) || []) {
    const cand = [path.resolve(ROOT, rel), path.resolve(PLUGIN, rel.replace(/^dsh-native\/[^/]+\//, ''))].filter((p) => fsSync.existsSync(p))
    if (cand.length === 0) continue
    const t = fsSync.readFileSync(cand[0], 'utf8')
    for (const a of yamlAnchors) {
      if (t.includes('- id: ' + a) && !declared.has(cand[0])) {
        die('能力表列的预设里有 ' + role.role + ' 的人格块（`- id: ' + a + '`），但真源没登记这份化身：' + REL(cand[0]),
          '又一份没人管的手抄——把它加进 roles/persona/' + role.role + '.json 的 carriers')
      }
    }
  }
  const cbFile = TABLE.roles && TABLE.roles[role.role] && TABLE.roles[role.role].codebuddy && TABLE.roles[role.role].codebuddy.file
  if (typeof cbFile === 'string' && cbFile !== '') {
    const want = path.resolve(TPL, cbFile)
    if (fsSync.existsSync(want) && !declared.has(want)) {
      die('能力表说角色 ' + role.role + ' 的派工文本在 ' + REL(want) + '，但真源没登记这份化身',
        'roles/tool-face.json 与 roles/persona/' + role.role + '.json 必须说同一件事——把它加进 carriers')
    }
  }
}

// ── 逐化身比对 ──────────────────────────────────────────────────────────────
const problems = { structural: [], drift: [] }
const skipped = []
// 每份"写盘时会改字节"的化身：reason='drift'（内容与真源不同，按真源重写，md 与 YAML 都走这条）
// ｜reason='fold'（内容已一致，只把 YAML 折叠标量重排成"一段一行"）。
const plans = []
const editsByPath = new Map() // 一份文件被多个角色各改一段：写盘必须按文件合并成一次
const rawByPath = new Map()   // 写前快照：用来证明"没列入计划的化身一个字节都没动"
const keptRegions = []        // 写前快照（逐化身）：不在计划里的化身，正文区必须逐字未动
const mdSoft = []             // 只报告：md 上"段内折行 ≠ 一段一行"的位置（排版，不改字节）
const lines = []
const summaries = []

for (const role of picked) {
  const segText = new Map(role.segments.map((s) => [s.id, renderSeg(s, '角色 ' + role.role)]))
  for (const [id, t] of sharedSegs) segText.set(id, t) // 公共池：任何角色的任何化身都能引用
  const rows = []
  let matched = 0
  const resolved = []
  for (const c of role.carriers) {
    const r = resolveCarrier(c)
    if (!r.abs) {
      // 预设化身找不到：只有 flat（公开仓 clone）里才允许缺——公开仓本就没有生产预设，属登记在案的缺。
      // mono 私有仓里两份预设都在，缺一份就是被挪走/改名了：与 md 化身同族，报红，不静默跳过。
      // （此前一律 skipped+continue，于是"三份化身少了一份"只降级成提示行，退出码仍 0、末行仍 ✓——
      //  而 --check 的退出码是唯一能挂 CI 的门。）
      if (c.kind === 'yaml-persona' && LAYOUT === 'flat') {
        skipped.push(REL(r.cands[0]) + '（' + c.id + '：盘上不存在——flat 布局里没有生产预设，按约定认）')
        continue
      }
      die('化身「' + c.id + '」在本布局（' + LAYOUT + '）下找不到：' + r.cands.map((p) => REL(p)).join(' / '),
        c.kind === 'yaml-persona'
          ? 'mono 布局里两份预设都在——找不到就是被挪走/改名了，不静默跳过（只有 flat 才允许缺生产预设）'
          : '派工文本/协议卡是两种布局下都在的件——找不到就是路径变了，不静默跳过')
    }
    resolved.push(c.id)
  }
  const resolvedC = role.carriers.filter((c) => resolved.includes(c.id))
  if (resolvedC.filter((c) => c.kind === 'yaml-persona').length === 0) {
    die('角色 ' + role.role + ' 的两份预设一份都没命中（比对面只剩 ' + resolved.length + ' 份非预设化身）',
      '至少命中一份才谈得上比对；预设清单见能力表 hosts.dsh.presets')
  }
  if (resolved.length === 0) die('角色 ' + role.role + ' 比对化身数＝0——0 不等于干净')

  for (const c of resolvedC) {
    const r = resolveCarrier(c)
    const raw = fsSync.readFileSync(r.abs, 'utf8')
    rawByPath.set(r.abs, raw)
    const ctx = REL(r.abs) + ' § ' + c.anchor
    const joined = c.segments.map((id) => segText.get(id)).join('')
    const jsonParas = paragraphsOfJoined(joined, '角色 ' + role.role + ' 的化身「' + c.id + '」')
    const label = '  ' + (c.id + '            ').slice(0, 12) + ' ' + REL(r.abs) + ' § ' + c.anchor
    // 两条路都必须能算出"按真源对齐后这一段长什么样"，md 不开例外：
    // edit 只记"改哪几行"（不记整份文件的内容）——同一份文件上多个锚块的 edit 最后合并成一次写盘。
    let edit = null
    let diskParas
    let bodyLines = 0
    let where
    if (c.kind === 'yaml-persona') {
      const loc = locateYamlScalar(raw, c.anchor, ctx)
      const region = loc.lines.slice(loc.keyLine + 1, loc.end)
      const edges = splitBlankEdges(region)
      // 缩进＝盘上检出的正文缩进**串**（不是数）：缩进风格是排版，一个字节都不碰
      const bodyIndent = edges.body.length ? edges.body[0].match(/^\s*/)[0] : ' '.repeat(loc.indent + 2)
      diskParas = regionParas(edges.body)
      bodyLines = edges.body.length
      where = 'persona 标量（第 ' + (loc.keyLine + 1) + ' 行 `>-`）'
      edit = { start: loc.keyLine + 1, end: loc.end, newLines: [...edges.lead, ...reflow(jsonParas, bodyIndent), ...edges.trail], eol: loc.eol, lines: loc.lines, role: role.role, id: c.id, anchor: c.anchor, kind: c.kind }
    } else {
      const loc = locateMdRegion(raw, c.anchor, ctx)
      const region = loc.lines.slice(loc.head + 1, loc.stop)
      const edges = splitBlankEdges(region)
      diskParas = regionParas(edges.body)
      bodyLines = edges.body.length
      where = '正文（第 ' + (loc.head + 2) + '–' + loc.stop + ' 行，止于 `---`）'
      edit = { start: loc.head + 1, end: loc.stop, newLines: [...edges.lead, ...reflow(jsonParas, ''), ...edges.trail], eol: loc.eol, lines: loc.lines, role: role.role, id: c.id, anchor: c.anchor, kind: c.kind }
    }
    const newContent = edit.lines.slice(0, edit.start).concat(edit.newLines, edit.lines.slice(edit.end)).join(edit.eol)
    // 写前快照里的"这一段正文区"（与写后用同一套定位 + 同一套 join 比）——用来证明
    // **不在写盘计划里的化身，其正文区逐字未动**（md 的排版纪律由机器兜底，不靠自述）。
    const regionBefore = edit.lines.slice(edit.start, edit.end).join(edit.eol)
    const jsonStripped = jsonParas.map(stripWS)
    // 登记一处改写：内容漂移（reason='drift'）与折叠重排（reason='fold'）都从这儿进 plans——
    // edit 按文件归并，写盘时同一份 raw 上一趟落盘。
    const plan = (reason) => {
      plans.push({ abs: r.abs, id: c.id, role: role.role, kind: c.kind, anchor: c.anchor, srcStripped: jsonStripped, where, reason })
      const g = editsByPath.get(r.abs)
      if (g) g.edits.push(edit)
      else editsByPath.set(r.abs, { eol: edit.eol, lines: edit.lines, edits: [edit] })
    }
    if (diskParas.length !== jsonStripped.length) {
      problems.structural.push(label + '\n      段数不符：真源拼出 ' + jsonStripped.length + ' 段，盘上 ' + where
        + ' 是 ' + diskParas.length + ' 段——段边界动了，对不齐就不比')
      rows.push(label + '\n      ✗ 段数不符（真源 ' + jsonStripped.length + ' / 盘上 ' + diskParas.length + '）')
      continue
    }
    const bad = []
    for (let i = 0; i < diskParas.length; i++) {
      if (diskParas[i] !== jsonStripped[i]) {
        const d = diffWindow(jsonStripped[i], diskParas[i])
        bad.push('      第 ' + (i + 1) + ' 段字符不同（已剥空白，从第 ' + (d.at + 1) + ' 字起）：\n'
          + '        真源：…' + d.ref.slice(0, 120) + '…\n'
          + '        化身：…' + d.got.slice(0, 120) + '…')
      }
    }
    if (bad.length) {
      // **内容**不同＝化身没跟上真源。--check 只判定（下面 exit 1）；写盘这条路就按真源重写这一段——
      // md 与 YAML 一视同仁：两条路的 edit 上面都已算出来，这里不给 md 开例外。
      problems.drift.push(label + '\n' + bad.join('\n'))
      rows.push(label + '\n      ✗ ' + bad.length + ' 段与真源不同（已剥空白）'
        + (MODE === 'apply' ? '· **按真源重写**' : '· 要跟上真源就跑一次不带 --check 的生成'))
      plan('drift')
      continue
    }
    matched++
    // 内容一致之后的字节口径：YAML 折叠标量重排＝去掉折行往正文里塞的空格 ⇒ **该写**；
    // md 的段内软折行是排版（CommonMark 软换行渲染为空格）⇒ **不写**，七份 md 必须逐字节不变。
    // 于是"内容一致"的 md 化身盘上即规范：段边界对齐 + 逐段字符相同 ＝ 已是最新，只报告不动它。
    // （**只在内容一致时**才守这条：内容不同就该重写，见上面那一支。）
    const canonDiffers = newContent !== raw
    const isMd = c.kind === 'md-persona'
    if (isMd && canonDiffers) mdSoft.push(REL(r.abs) + ' § ' + c.anchor + '（' + where + '：' + bodyLines + ' 行排成 ' + diskParas.length + ' 段）')
    const bytesSame = isMd ? true : !canonDiffers
    rows.push(label + '\n      ✓ 段 ' + diskParas.length + '/' + jsonStripped.length + ' 逐段相同（已剥空白）· '
      + (isMd
        ? '**不改字节**（段内折行是排版' + (canonDiffers ? '：盘上有软折行，见下面的只报告行' : '') + '）'
        : '重排后字节' + (bytesSame ? '不变（已是"一段一行"的规范形态）' : '**会变**（折叠重排：字节变、口径不变）')))
    if (!bytesSame) plan('fold')
    else keptRegions.push({ abs: r.abs, kind: c.kind, anchor: c.anchor, region: regionBefore })
  }
  lines.push(role.role + '（' + role.zh + '）· 真源 ' + role.segments.length + ' 段 · ' + resolvedC.length + ' 份化身')
  lines.push(...rows, '  ' + (matched === resolvedC.length ? '✓' : '✗') + ' ' + role.role + '：' + matched + '/' + resolvedC.length + ' 化身与真源逐段相同', '')
  summaries.push({ role: role.role, matched, total: resolvedC.length })
}

// ── 输出 ────────────────────────────────────────────────────────────────────
console.log('')
console.log('══════ 人格真源（roles/persona/*.json → 化身）══════')
console.log('  真源：' + REL_PLUGIN(PERSONA_DIR) + '（' + roles.length + ' 个角色）· 能力表：' + REL_PLUGIN(TABLE_PATH))
console.log('  根  ：' + ROOT + '（' + LAYOUT + ' 布局）· 模式：'
  + (MODE === 'check' ? '--check（只判定、不写盘）' : '写盘（不带 --check）') + (ONLY ? ' · --only ' + ONLY : ''))
// 覆盖面对照（**只报告、不判定**）：本脚本只遍历 roles/persona/*.json，所以"少登记几个角色"这件事
// 在结果上与"名录已全覆盖"长得一模一样（0 个 json 会 die，1 个不会）。这里把差距显式打出来，
// 免得"1 个角色"被读成"全部角色"。要不要把它升级成门禁，是人拍板的事（尚未迁移的角色不是缺陷）。
const tableRoles = Object.keys((TABLE.roles) || {}).sort()
const srcRoles = roles.map((r) => r.role).sort()
const uncovered = tableRoles.filter((r) => !srcRoles.includes(r))
console.log('  角色覆盖：能力表 ' + tableRoles.length + ' 个 · 人格真源 ' + srcRoles.length + ' 个'
  + (uncovered.length ? '——未登记真源 ' + uncovered.length + ' 个（' + uncovered.join('、') + '），它们的化身不在比对面内' : '（已全覆盖）'))
if (ONLY) console.log('  --only：只比 ' + ONLY + ' 这一个角色；其余角色不比对，反向核对也不走它们。上面那行覆盖数不受 --only 影响。')
if (skipped.length) console.log('  显式登记跳过：\n    - ' + skipped.join('\n    - '))
console.log('')
for (const l of lines) console.log(l)
const totalResolved = summaries.reduce((n, s) => n + s.total, 0)
const totalMatched = summaries.reduce((n, s) => n + s.matched, 0)
if (totalResolved === 0) die('比对化身数＝0——0 不等于干净')
if (mdSoft.length) {
  console.log('  只报告（**不改字节**）：md 上"段内折行 ≠ 一段一行"的位置 ' + mdSoft.length + ' 处——\n    - '
    + mdSoft.join('\n    - '))
  console.log('    （段内软折行是排版：CommonMark 软换行渲染为空格，改它不改变口径。这些位置的段边界与逐段字符都'
    + '已与真源对齐，故生成器不因排版改 md 的字节——七份 md 在 --apply 下逐字节不变。）')
  console.log('')
}

const driftPlans = plans.filter((p) => p.reason === 'drift')   // 内容与真源不同 ⇒ 按真源重写
const foldPlans = plans.filter((p) => p.reason === 'fold')     // 内容已一致 ⇒ 只重排 YAML 折叠标量
const SRC_HINT = REL_PLUGIN(path.join(PERSONA_DIR, (picked[0] || roles[0]).role + '.json'))

// ── 判定：结构问题优先于漂移（"缺失没有类型"的本项目元纪律）───────────────────
// 判定不了 ＝ exit 2，**两种模式都停在这一步**：锚点找不到 / 段数不符就算不出"对齐后长什么样"，
// 写盘这条路也不许猜（不落盘、不回落默认值、不拿写死的期望字符串充数）。
if (problems.structural.length) {
  console.error('✗ ' + problems.structural.length + ' 份化身**结构**对不上（对不齐就不比，先看真源与化身的段边界）：')
  for (const p of problems.structural) console.error('  ' + p)
  console.error('')
  console.error('真源：' + SRC_HINT + '；段数/锚点对不齐＝判定不了，**写盘这条路也停在这一步**'
    + '（先看清是段边界动了还是锚点被改名，再决定改真源还是改化身）。')
  die('结构性问题 ' + problems.structural.length + ' 份：算不出"对齐后这一段长什么样"，逐段重排无从谈起')
}

// ── 带 --check：只判定，一个字节都不写 ────────────────────────────────────────
if (MODE === 'check') {
  if (problems.drift.length) {
    console.error('✗ ' + problems.drift.length + ' 份化身与真源**字符**不同（源改了、化身没跟上）：')
    for (const p of problems.drift) console.error('  ' + p)
    console.error('')
    console.error('真源：' + SRC_HINT)
    console.error('（--check 只判定、不改盘。要让化身跟上真源，跑一次**不带 --check** 的生成：'
      + '  node roles/build-persona.mjs' + (ONLY ? ' --only ' + ONLY : '') + '）')
    console.error('（真源要跟上化身就改真源——谁对由人拍板，本脚本不替谁改谁。）')
    process.exit(1)
  }
  console.log('✓ 全部一致：' + picked.length + ' 个角色 · ' + totalMatched + '/' + totalResolved + ' 化身与真源逐段相同'
    + '（--check 只比对、未写盘' + (foldPlans.length ? '；其中 ' + foldPlans.length + ' 份 YAML 折叠标量若重排会改字节' : '') + '）')
  console.log('  字节纪律：写盘只会动 ' + new Set(foldPlans.map((p) => p.abs)).size + ' 份 YAML 的折叠标量；'
    + (totalMatched - foldPlans.length) + ' 份化身（含全部 md）逐字节不动')
  process.exit(0)
}

if (MODE === 'apply') {
  if (driftPlans.length) {
    console.log('· 写盘：' + driftPlans.length + ' 份化身与真源**字符**不同，按真源重写（段号与起始字）：')
    for (const p of problems.drift) console.log('  ' + p)
    console.log('  （md 与 YAML 一视同仁；内容已一致、只是盘上排了软折行的 md 不在其列，见上面的只报告行。）')
    console.log('')
  }
  // ① 区间不重叠核对：行号是**原文件**的坐标系，两个 [start,end) 相交＝后一次 splice 会写到别人的行上。
  //    （build-tool-face.mjs 第一版正是栽在这：splice 之后行号整体位移，名单写进了别人的条目，
  //     文件当场坏掉。这里让"重叠"根本进不了写盘这一步。）
  for (const [abs, g] of editsByPath) {
    const es = [...g.edits].sort((a, b) => a.start - b.start)
    for (let i = 1; i < es.length; i++) {
      if (es[i].start < es[i - 1].end) {
        die('写盘计划里两处改写区间重叠：' + REL(abs) + '（' + es[i - 1].role + '/' + es[i - 1].id
          + ' 的 ' + es[i - 1].start + '–' + es[i - 1].end + ' 与 ' + es[i].role + '/' + es[i].id
          + ' 的 ' + es[i].start + '–' + es[i].end + '）',
          '重复登记同一处已在校验里拦下；这里再拦一次——区间重叠会让后一次 splice 覆盖别人的行')
      }
    }
  }
  // ①b 按文件合并：同一份 raw 上算出的多个锚块 edit 必须落进**同一个** lines 数组再写一次。
  //    （逐个 writeFileSync 会让后一份覆盖前一份——一份预设里 7 个角色各改一段，就只剩最后一段。）
  const composed = new Map()
  for (const [abs, g] of editsByPath) {
    const out = g.lines.slice()
    for (const e of [...g.edits].sort((a, b) => b.start - a.start)) out.splice(e.start, e.end - e.start, ...e.newLines)
    composed.set(abs, out.join(g.eol))
  }
  // ② 写盘**前**自跑一遍比对：把"待写内容"重新定位锚点、解析回段落，与真源逐段核对。
  //    不借"上面刚比过"的信任——重排与解析是两套代码，得让它们互相证明。任何一份不过 ⇒ 整体不写盘。
  const failed = []
  for (const p of plans) {
    const text = composed.get(p.abs)
    if (text === undefined) { failed.push(p.role + ' / ' + p.id + '（' + REL(p.abs) + '：计划里的文件没有合成结果）'); continue }
    const loc = p.kind === 'yaml-persona'
      ? locateYamlScalar(text, p.anchor, '写盘前自检 ' + REL(p.abs) + ' § ' + p.anchor)
      : locateMdRegion(text, p.anchor, '写盘前自检 ' + REL(p.abs) + ' § ' + p.anchor)
    const got = p.kind === 'yaml-persona'
      ? regionParas(splitBlankEdges(loc.lines.slice(loc.keyLine + 1, loc.end)).body)
      : regionParas(splitBlankEdges(loc.lines.slice(loc.head + 1, loc.stop)).body)
    if (got.length !== p.srcStripped.length || got.some((g, i) => g !== p.srcStripped[i])) {
      failed.push(p.role + ' / ' + p.id + ' · ' + REL(p.abs) + ' § ' + p.anchor
        + '（重排后读回 ' + got.length + ' 段，真源 ' + p.srcStripped.length + ' 段）')
    }
  }
  if (failed.length) {
    die('写盘前自检未过：' + failed.length + ' 份"待写内容"重排后读不回真源，**整体不写盘**：\n    - ' + failed.join('\n    - '),
      '写盘前的自检——重排出来的东西必须先能读回原样（段边界与逐段字符都对得上）才允许落盘；'
      + '本脚本不靠"上面刚比过"这句信任，重排与解析是两套代码，得让它们互相证明')
  }
  // ③ 写盘
  let wrote = 0
  for (const [abs, content] of composed) {
    fsSync.writeFileSync(abs, content)
    wrote++
    console.log('  → 已写入 ' + REL(abs) + '（' + editsByPath.get(abs).edits.map((e) => e.role + '/' + e.id).join('、') + '）')
  }
  // ④ 写后核对：写下去的内容 == 计划内容；**没写过的化身，字节必须与写前快照逐字节相同**。
  //    字节纪律由机器兜底，不靠"我只改了该改的"这句自述。
  for (const [abs, content] of composed) {
    if (fsSync.readFileSync(abs, 'utf8') !== content) {
      die('写盘后核对失败（盘上内容 ≠ 计划内容）：' + REL(abs))
    }
  }
  const touched = new Set(composed.keys())
  for (const [abs, before] of rawByPath) {
    if (touched.has(abs)) continue
    if (fsSync.readFileSync(abs, 'utf8') !== before) {
      die('写盘后核对失败：' + REL(abs) + ' 不在写盘计划里，字节却动了',
        '字节纪律＝只有计划里的化身可以变；已是最新的化身、以及内容已一致只是排了软折行的 md，必须逐字节不动')
    }
  }
  // ④c 逐化身再核一次：**不在写盘计划里的化身，其正文区必须与写前逐字相同**——含"同一份文件里
  //     别的锚块"（整份文件的字节核对管不到被写文件里的邻居；而一条算错的改写区间正是从邻居身上
  //     溢出去的）。md 的排版纪律由此由机器兜底，不靠"我只改了该改的"这句自述。
  for (const k of keptRegions) {
    const now = fsSync.readFileSync(k.abs, 'utf8')
    let loc
    let start
    let end
    if (k.kind === 'yaml-persona') {
      loc = locateYamlScalar(now, k.anchor, '写盘后核对 ' + REL(k.abs) + ' § ' + k.anchor)
      start = loc.keyLine + 1
      end = loc.end
    } else {
      loc = locateMdRegion(now, k.anchor, '写盘后核对 ' + REL(k.abs) + ' § ' + k.anchor)
      start = loc.head + 1
      end = loc.stop
    }
    if (loc.lines.slice(start, end).join(loc.eol) !== k.region) {
      die('写盘后核对失败：' + REL(k.abs) + ' § ' + k.anchor + ' 不在写盘计划里，正文区字节却动了',
        '字节纪律＝只有计划里的化身可以变；md 的段内软折行是排版，永不因此改字节')
    }
  }
  const mdDrift = driftPlans.filter((p) => p.kind === 'md-persona').length
  const yamlDrift = driftPlans.length - mdDrift
  console.log('')
  console.log('✓ 写盘完成：' + wrote + ' 份文件 · ' + plans.length + ' 处锚块按真源对齐'
    + '（内容漂移重写：md ' + mdDrift + ' / YAML ' + yamlDrift + '；折叠标量重排：YAML ' + foldPlans.length + '）')
  console.log('  写盘前自检 ' + plans.length + '/' + plans.length + ' 通过 · 写后核对：计划外的 ' + keptRegions.length
    + ' 份化身正文区逐字未动（含全部"内容已一致"的 md）· 区间不重叠已核')
  process.exit(0)
}
// MODE 只有 check / apply 两条路：带 --check 的那条在判定后 exit，落到这里的一定是写盘。
