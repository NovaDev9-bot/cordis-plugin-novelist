#!/usr/bin/env node
/**
 * persona-roundtrip.test.mjs —— 人格真源 ↔ 化身的**往返回归**（生成器 roles/build-persona.mjs）
 *
 * ── 被钉住的三件事
 *   真源 = `roles/persona/*.json`（每个角色一份 + `_shared.json` 公共池）＝一处；
 *   化身 = **九份载体**（两份预设的 YAML 折叠标量 + 七份派工文本/座位卡的 md 正文），七个角色各三份＝21 份化身；
 *   生成器 = `roles/build-persona.mjs`（`--check` 只判定、不带 `--check` 与 `--apply` 写盘）。
 *
 * ── 四组用例（每组一个"必须能被机器回答的问题"）
 *   ① 重算即真：临时副本上 `--check` 全绿；**手改化身一个字**（绕过真源）必须报红，且指到"哪份化身 § 哪个锚点 · 第几段"。
 *   ② A1 回归（本批验收核心）：改真源里**一条义务段的一个字**，`--apply` 之后**引用它的化身全部跟着变、未引用它的一个都不变**（两组数字都要打出来）。
 *   ③ 单点性：同一句义务在真源里只有一个家（跨角色同类句已上提到 `_shared.json` 的，算一处）。
 *   ④ 空转判据：真源目录清空 / 某角色 carriers 为空 / 锚点被删 → 生成器 **exit 2**，不许以 0（通过）或 1（不符）退出。
 *
 * ── 跑在哪份数据上（真仓只读，变异只发生在临时副本里）
 * 全部用例都在**真数据的临时副本**上跑：把 `roles/persona/` 整个目录、生成器对侧的能力表
 * `roles/tool-face.json`、以及真源 `carriers[].path` 里登记的那九份载体，按**原样相对路径**复制到一个
 * 临时仓根下，再用 `--root` 指过去。真仓一个字节都不动（复制保真由 1a 逐字节断言）。
 *   · 为什么能力表也在复制清单里：生成器拿它做反向核对、也是预设路径的唯一家（build-persona.mjs 的 ④）——
 *     少了它 `--check` 直接 exit 2。这不是"多加一份"，它是生成器的既定输入之一。
 *   · 为什么临时根下要建一个空的 `vault/`：生成器用「同时有 `dsh-native/` 与 `vault/`」判定 mono 布局
 *     （build-persona.mjs:110-113）；少了它布局判成 `'?'`，当场 exit 2。
 *
 * ── 本文件里没有一句人格正文
 * 段文本、锚点名、化身路径一律从真源现读（段文本只用于"改一个字"与"字面搜索"），
 * 测试不另抄一份"期望字符串"——抄一份就是本项目最贵的那类缺陷：同一件事两个手写处。
 */
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { after, test } from 'node:test'

// ── 落位与布局（判据与生成器同源，取**最外层**命中者）────────────────────────
// 为什么不能"往上数两级"：公开仓是**单仓 clone**，插件自己就是仓根——数两级会把仓根解析成
// 它的父目录（2026-09-21 实测：本文件第一版如此，CI 四作业全红、本机 mono 下一路绿）。
// 生成器 build-persona.mjs:108-122 的判据是：mono＝仓根同时有 dsh-native/ 与 vault/，
// flat＝同时有 wb-expert-starter/ 与 lib/；两者都命中时取最外层（插件子仓也满足扁平判据）。
const HERE = path.dirname(fileURLToPath(import.meta.url))       // …/plugin-novelist/roles
const PLUGIN = path.resolve(HERE, '..')                         // …/plugin-novelist
const MONO_MARKERS = ['dsh-native', 'vault']
const FLAT_MARKERS = ['wb-expert-starter', 'lib']
const hasAll = (d, ms) => ms.every((m) => fs.existsSync(path.join(d, m)))
function findRepo(start) {
  let cur = path.resolve(start), hit = null
  for (;;) {
    if (hasAll(cur, MONO_MARKERS) || hasAll(cur, FLAT_MARKERS)) hit = cur
    const up = path.dirname(cur)
    if (up === cur) return hit
    cur = up
  }
}
const REPO = findRepo(HERE)
assert.ok(REPO, '没有找到仓库根（mono 需 ' + MONO_MARKERS.join('+') + '；flat 需 ' + FLAT_MARKERS.join('+') + '）')
const LAYOUT = hasAll(REPO, MONO_MARKERS) ? 'mono' : 'flat'
function rel(abs) { return path.relative(REPO, abs).split(path.sep).join('/') }
/** 真源里 carriers[].path 一律写成 mono 坐标（`dsh-native/<x>/…`）；flat 下落到插件根即去掉前缀。 */
const normRel = (p) => (LAYOUT === 'flat' ? p.replace(/^dsh-native\/[^/]+\//, '') : p)
/** 载体在真仓里的实际位置：原样路径 + 去前缀两条候选，命中一条才算在盘（与生成器同口径）。 */
function carrierSrc(p) {
  const cands = [...new Set([path.join(REPO, p), path.join(PLUGIN, p.replace(/^dsh-native\/[^/]+\//, ''))])]
  return cands.find((x) => fs.existsSync(x)) || null
}
const GEN = path.join(HERE, 'build-persona.mjs')
const SRC = path.join(HERE, 'persona')
const TABLE_REL = rel(path.join(HERE, 'tool-face.json'))
const PERSONA_REL = rel(SRC)

// ── 真源现读（只读，一个字节都不写）─────────────────────────────────────────
const stripWS = (s) => String(s).replace(/\s+/g, '')
const RES = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')

const SRC_FILES = fs.readdirSync(SRC).filter((f) => f.endsWith('.json')).sort()
const SHARED_FILE = '_shared.json'
const ROLE_FILES = SRC_FILES.filter((f) => !f.startsWith('_'))
assert.ok(ROLE_FILES.length > 0, '真源目录里没有任何角色 *.json：' + PERSONA_REL)
const ROLE_DOCS = ROLE_FILES.map((f) => ({ file: f, doc: JSON.parse(fs.readFileSync(path.join(SRC, f), 'utf8')) }))
const SHARED_DOC = SRC_FILES.includes(SHARED_FILE) ? JSON.parse(fs.readFileSync(path.join(SRC, SHARED_FILE), 'utf8')) : null
const SHARED_SEGS = SHARED_DOC ? SHARED_DOC.segments : []

/** 21 份化身（角色 × 载体）＝真源声明的全部；`declared` 是真源坐标，`rel` 是本布局下的落位 */
const CARRIERS_DECLARED = []
for (const { doc } of ROLE_DOCS) {
  for (const c of doc.carriers) CARRIERS_DECLARED.push({ role: doc.role, id: c.id, declared: c.path, rel: normRel(c.path), src: carrierSrc(c.path), kind: c.kind, anchor: c.anchor, segments: c.segments })
}
const key = (c) => c.role + '/' + c.id
/** 本布局下真在盘上的化身；缺的进 ABSENT（只为 flat 的生产预设开口，且必须被打出来）。
 *  与生成器同一条豁免（build-persona.mjs:512-519）：flat 里没有生产预设是登记在案的缺，
 *  mono 里缺一份就是被挪走/改名了——不静默跳过。 */
const ABSENT = CARRIERS_DECLARED.filter((c) => !c.src)
const CARRIERS = CARRIERS_DECLARED.filter((c) => c.src)
for (const c of ABSENT) {
  assert.ok(LAYOUT === 'flat' && c.kind === 'yaml-persona',
    '载体在本布局（' + LAYOUT + '）下找不到：' + c.declared + '（' + c.role + '/' + c.id + '）——mono 里两份预设都在，缺就是被挪走/改名了，不静默跳过')
}
/** 九份载体（真源口径，布局无关）／本布局下在盘的那些 */
const ALL_RELS = [...new Set(CARRIERS_DECLARED.map((c) => c.declared))].sort()
const CARRIER_RELS = [...new Set(CARRIERS.map((c) => c.rel))].sort()
/** 段 id → 文本 / 层（角色段 + 公共池） */
const SEG_TEXT = new Map()
const SEG_LAYER = new Map()
const SEG_HOME = new Map()   // 段 id → 它声明在哪个文件里（角色的家只有一个）
for (const { file, doc } of ROLE_DOCS) {
  for (const s of doc.segments) { SEG_TEXT.set(s.id, s.text); SEG_LAYER.set(s.id, s.layer); SEG_HOME.set(s.id, file) }
}
for (const s of SHARED_SEGS) { SEG_TEXT.set(s.id, s.text); SEG_LAYER.set(s.id, s.layer); SEG_HOME.set(s.id, SHARED_FILE) }

// ── 临时副本 ────────────────────────────────────────────────────────────────
const TEMP_ROOTS = []
function makeRepo(tag) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'nf-persona-rt-' + tag + '-'))
  assert.ok(!root.startsWith(REPO + path.sep), '临时仓根落在了真仓里——"不许动真仓"这条纪律由机器兜底：' + root)
  TEMP_ROOTS.push(root)
  // 临时根必须与**当前布局**同形，否则生成器对临时根判出的布局与化身落位对不上：
  // mono＝建 vault/（与 dsh-native/ 一起构成判据）；flat＝建 lib/（与 wb-expert-starter/ 一起构成判据）。
  if (LAYOUT === 'mono') fs.mkdirSync(path.join(root, 'vault'), { recursive: true })
  else fs.mkdirSync(path.join(root, 'lib'), { recursive: true })
  const copyRel = (r) => {
    const src = carrierSrc(r)   // 同生成器口径：原样路径 + 去 dsh-native/<x>/ 前缀两条候选
    assert.ok(src, '临时副本缺源文件：' + r)
    const to = path.join(root, r)
    fs.mkdirSync(path.dirname(to), { recursive: true })
    fs.copyFileSync(src, to)
  }
  copyRel(TABLE_REL)
  fs.mkdirSync(path.join(root, PERSONA_REL), { recursive: true })
  for (const f of SRC_FILES) fs.copyFileSync(path.join(SRC, f), path.join(root, PERSONA_REL, f))
  for (const r of CARRIER_RELS) copyRel(r)
  return root
}
after(() => {
  if (process.env.NF_PERSONA_RT_KEEP) {
    console.log('（NF_PERSONA_RT_KEEP=1：临时副本留在 ' + TEMP_ROOTS.length + ' 个目录里）')
    for (const r of TEMP_ROOTS) console.log('    ' + r)
    return
  }
  for (const r of TEMP_ROOTS) fs.rmSync(r, { recursive: true, force: true })
})

function runGen(root, args = []) {
  const r = spawnSync(process.execPath, [GEN, ...args, '--root', root], { encoding: 'utf8' })
  assert.equal(r.error, undefined, '生成器没跑起来：' + (r.error && r.error.message))
  assert.ok(Number.isInteger(r.status), '生成器没有正常退出（status=' + r.status + '）')
  return { status: r.status, stdout: r.stdout, stderr: r.stderr, out: String(r.stdout) + String(r.stderr) }
}

// ── 化身正文区的定位（与生成器的 locateYamlScalar / locateMdRegion 同口径）────
// 测试需要一个**独立**的"这一段在哪"的判据：只核整份文件"变了没变"是糊的——一份预设里装着
// 七个角色的锚块，改 archivist 会让整份文件变字节，却不能说 chief-editor 的化身"跟着变了"。
function locateRegion(lines, c) {
  if (c.kind === 'yaml-persona') {
    const idLine = lines.findIndex((l) => new RegExp('^\\s*-\\s*id:\\s*' + RES(c.anchor) + '\\s*$').test(l))
    let keyLine = -1
    if (idLine === -1) {
      keyLine = lines.findIndex((l) => new RegExp('^\\s*' + RES(c.anchor) + ':\\s*>-[ \\t]*$').test(l))
    } else {
      let stop = lines.length
      for (let i = idLine + 1; i < lines.length; i++) if (/^\s*-\s*id:/.test(lines[i])) { stop = i; break }
      for (let i = idLine + 1; i < stop; i++) if (/^\s*persona\s*:/.test(lines[i])) { keyLine = i; break }
    }
    if (keyLine === -1) return null
    const indent = lines[keyLine].match(/^\s*/)[0].length
    let end = keyLine + 1
    while (end < lines.length) {
      const l = lines[end]
      if (l.trim() !== '' && l.match(/^\s*/)[0].length <= indent) break
      end++
    }
    return { start: keyLine + 1, end }
  }
  const h = lines.findIndex((l) => l.trim() === c.anchor)
  if (h === -1) return null
  let stop = -1
  for (let i = h + 1; i < lines.length; i++) if (lines[i].trim() === '---') { stop = i; break }
  if (stop === -1) return null
  return { start: h + 1, end: stop }
}
function regionOf(text, c) {
  const lines = text.split(/\r?\n/)
  const loc = locateRegion(lines, c)
  return loc ? lines.slice(loc.start, loc.end).join('\n') : null
}
function regionAt(root, c) {
  const reg = regionOf(fs.readFileSync(path.join(root, c.rel), 'utf8'), c)
  assert.ok(reg !== null, '定位不到化身正文区（这是测试自己的定位器坏了，不许当成"没变"）：'
    + key(c) + ' ' + c.rel + ' § ' + c.anchor)
  return reg
}
/** 21 份化身的正文区快照（键＝角色/化身 id） */
function snapshot(root) {
  const m = new Map()
  for (const c of CARRIERS) m.set(key(c), regionAt(root, c))
  return m
}

// ── 变异工具 ────────────────────────────────────────────────────────────────
/** 真源里那些正文**一个都不含**的字符——用它做哨兵，"变了的化身必须含它／没变的化身不许含它"才是判据 */
const SENTINELS = ['※', '‡', '‰', '⌀', '‽']
function pickSentinel() {
  const corpus = [...SRC_FILES.map((f) => fs.readFileSync(path.join(SRC, f), 'utf8')),
    ...CARRIER_RELS.map((r) => fs.readFileSync(path.join(REPO, r), 'utf8'))].join('')
  const s = SENTINELS.find((c) => !corpus.includes(c))
  assert.ok(s, '候选哨兵字符在真源/九份载体里都出现过——换一组哨兵：' + SENTINELS.join(''))
  return s
}
/** 把段文本里**第一个汉字**换成哨兵：只动一个字符、段内不折行（段数不变），且不碰 markdown 记号 */
function mutateFirstChar(text, to) {
  const cjk = /[\u4e00-\u9fff]/
  let i = text.search(cjk)
  if (i < 0) i = text.search(/\S/)
  assert.ok(i >= 0, '段文本里没有非空白字符，"改一个字"无从谈起')
  return { from: text[i], to, at: i, text: text.slice(0, i) + to + text.slice(i + 1) }
}
/** 手改**化身**（不通过真源）：只把正文区里第 n 段的第一个非空白字符换掉 */
function handEditRegion(abs, c, paraIndex, to) {
  const text = fs.readFileSync(abs, 'utf8')
  const eol = text.includes('\r\n') ? '\r\n' : '\n'
  const lines = text.split(/\r?\n/)
  const loc = locateRegion(lines, c)
  assert.ok(loc, '定位不到正文区：' + abs + ' § ' + c.anchor)
  const region = lines.slice(loc.start, loc.end)
  // 段边界＝空行分段（与生成器的 regionParas 同口径：连续非空行成一段，空行分段）
  const inner = []
  for (const [i, l] of region.entries()) {
    if (l.trim() === '') { if (inner.length && inner[inner.length - 1][1] === -1) inner[inner.length - 1][1] = i; continue }
    if (!inner.length || inner[inner.length - 1][1] !== -1) inner.push([i, -1])
  }
  for (const b of inner) if (b[1] === -1) b[1] = region.length
  assert.ok(inner.length >= paraIndex, '这份化身的正文区只有 ' + inner.length + ' 段，取不到第 ' + paraIndex + ' 段：' + abs)
  const [start, end] = inner[paraIndex - 1]
  let hit = -1
  let col = -1
  for (let i = start; i < end; i++) { const j = region[i].search(/\S/); if (j !== -1) { hit = i; col = j; break } }
  assert.ok(hit !== -1, '第 ' + paraIndex + ' 段里没有非空白字符：' + abs)
  const from = region[hit][col]
  const to2 = from === to ? '甲' : to
  region[hit] = region[hit].slice(0, col) + to2 + region[hit].slice(col + 1)
  fs.writeFileSync(abs, lines.slice(0, loc.start).concat(region, lines.slice(loc.end)).join(eol))
  return { from, to: to2, paragraph: paraIndex, paraCount: inner.length }
}

// ── 单点性：字面搜索 ────────────────────────────────────────────────────────
/**
 * 把段文本按它在 json 文件里的**原样**（转义后）形态全域搜索。为什么不搜原始文本：
 * 段文本里带 `"`（如「作者想干什么」的引号）在盘上是 `\"`，直接搜原文会漏。
 */
function literalHits(text) {
  const needle = JSON.stringify(text).slice(1, -1)
  const hits = []
  for (const f of SRC_FILES) {
    const raw = fs.readFileSync(path.join(SRC, f), 'utf8')
    let n = 0
    for (let i = raw.indexOf(needle); i !== -1; i = raw.indexOf(needle, i + 1)) n++
    if (n) hits.push({ file: f, n })
  }
  return hits
}
const totalHits = (hits) => hits.reduce((n, h) => n + h.n, 0)
function pickLocalObligation() {
  for (const { file, doc } of ROLE_DOCS) {
    const ids = doc.carriers.map((c) => c.id)
    for (const s of doc.segments) {
      if (s.layer !== 'obligation' || s.usedBy.length !== ids.length || s.usedBy.length < 2) continue
      const refs = doc.carriers
        .filter((c) => c.segments.includes(s.id))
        // flat 布局缺的化身（私有预设）不算"预期会变"的那一批——预期必须按**在盘载体**算，
        // 否则断言拿真源声明的 3 去比实际会变的 2，报出来的是"少了三份化身"这种假红。
        .filter((c) => carrierSrc(c.path))
        .map((c) => ({ role: doc.role, id: c.id, rel: normRel(c.path), kind: c.kind, anchor: c.anchor, segments: c.segments }))
      return { file, role: doc.role, id: s.id, usedBy: s.usedBy, refs }
    }
  }
  assert.fail('真源里找不到"被该角色全部化身引用"的本角色义务段——A1 回归没有可用的实验对象')
}

// ═══ ① 重算即真 ═════════════════════════════════════════════════════════════
test('1 重算即真：临时副本 --check 全绿；手改化身一个字（绕过真源）必须报红并指到"哪份化身 § 哪个锚点 · 第几段"', async (t) => {
  await t.test('1a 临时副本是真数据的原样副本（九份载体 · 21 份化身；flat 布局按登记豁免私有预设），--check 全绿', () => {
    const root = makeRepo('1a')
    for (const f of SRC_FILES) {
      assert.ok(fs.readFileSync(path.join(SRC, f)).equals(fs.readFileSync(path.join(root, PERSONA_REL, f))),
        '临时副本里的真源与真仓不是同一份字节：' + PERSONA_REL + '/' + f)
    }
    assert.equal(ALL_RELS.length, 9, '真源声明的载体不是九份，脚本的复制清单与真源对不上：' + ALL_RELS.join('、'))
    assert.equal(ABSENT.length + CARRIERS.length, CARRIERS_DECLARED.length, '在盘化身数 + 缺的化身数 ≠ 真源声明数（有化身既没复制也没登记）')
    if (ABSENT.length) {
      // 缺的必须**被数出来并打出来**：mono 的"三份化身少了一份"曾经只降级成提示行、退出码仍 0
      console.log('[1a] 本布局（' + LAYOUT + '）缺 ' + ABSENT.length + ' 份化身／'
        + new Set(ABSENT.map((c) => c.declared)).size + ' 份载体（私有生产预设，公开 clone 里不存在，与生成器同一条豁免）：'
        + [...new Set(ABSENT.map((c) => c.declared))].join('、'))
    }
    console.log('[1a] 在盘 ' + CARRIERS.length + '/' + CARRIERS_DECLARED.length + ' 份化身 · '
      + CARRIER_RELS.length + '/' + ALL_RELS.length + ' 份载体（' + LAYOUT + ' 布局）')
    for (const r of CARRIER_RELS) {
      assert.ok(fs.readFileSync(path.join(REPO, r)).equals(fs.readFileSync(path.join(root, r))),
        '临时副本里的载体与真仓不是同一份字节：' + r)
    }
    assert.equal(CARRIERS_DECLARED.length, 21, '真源声明的化身不是 21 份（七个角色 × 三份载体）：' + CARRIERS_DECLARED.length)
    const r = runGen(root, ['--check'])
    assert.equal(r.status, 0, '临时副本的 --check 不是 0（真源与化身本应逐段相同）：\n' + r.out)
    assert.ok(r.stdout.includes(CARRIERS.length + '/' + CARRIERS.length),
      '--check 的收束行没有报出 ' + CARRIERS.length + '/' + CARRIERS.length + ' 化身全对：\n' + r.stdout)
    console.log('[1a] 临时副本 ' + root)
    console.log('[1a] ' + CARRIERS.length + ' 份化身 / ' + CARRIER_RELS.length + ' 份载体逐字节原样复制 · --check exit 0 且 ' + CARRIERS.length + '/' + CARRIERS.length)
  })

  await t.test('1b 手改 YAML 预设里 chief-editor 的第 2 段一个字 → --check 报红，指名到"哪份化身 § prefix · 第 2 段"', () => {
    const root = makeRepo('1b')
    const c = CARRIERS.find((x) => x.role === 'chief-editor' && x.kind === 'yaml-persona')
    assert.ok(c, '真源里找不到 chief-editor 的 YAML 化身')
    const to = pickSentinel()
    const e = handEditRegion(path.join(root, c.rel), c, 2, to)
    const r = runGen(root, ['--check'])
    assert.equal(r.status, 1, '手改了化身，--check 却不是 1（1＝化身与真源字符不同）：\n' + r.out)
    assert.ok(r.stderr.includes(c.rel), '报红没有指名哪份化身（缺路径 ' + c.rel + '）：\n' + r.stderr)
    assert.ok(r.stderr.includes('§ ' + c.anchor), '报红没有指名哪个锚点（缺 `§ ' + c.anchor + '`）：\n' + r.stderr)
    assert.ok(r.stderr.includes('第 2 段字符不同'), '报红没有指名第几段（缺「第 2 段字符不同」）：\n' + r.stderr)
    assert.ok(r.stderr.includes(e.from) && r.stderr.includes(e.to),
      '报红没有把"真源 vs 化身"的那个字打出来（' + e.from + ' → ' + e.to + '）：\n' + r.stderr)
    console.log('[1b] 手改 ' + c.rel + ' § ' + c.anchor + ' 第 ' + e.paragraph + ' 段（共 ' + e.paraCount + ' 段）：'
      + JSON.stringify(e.from) + '→' + JSON.stringify(e.to) + '（没通过真源）→ --check exit 1，报红指名到化身与段号')
  })

  await t.test('1c 手改 md 派工文本里 reader 的第 3 段一个字 → --check 报红，指名到"哪份化身 § ## 人格 · 第 3 段"', () => {
    const root = makeRepo('1c')
    const c = CARRIERS.find((x) => x.role === 'reader' && x.kind === 'md-persona')
    assert.ok(c, '真源里找不到 reader 的 md 化身')
    const to = pickSentinel()
    const e = handEditRegion(path.join(root, c.rel), c, 3, to)
    const r = runGen(root, ['--check'])
    assert.equal(r.status, 1, '手改了 md 化身，--check 却不是 1：\n' + r.out)
    assert.ok(r.stderr.includes(c.rel), '报红没有指名哪份化身（缺路径 ' + c.rel + '）：\n' + r.stderr)
    assert.ok(r.stderr.includes('§ ' + c.anchor), '报红没有指名哪个锚点（缺 `§ ' + c.anchor + '`）：\n' + r.stderr)
    assert.ok(r.stderr.includes('第 3 段字符不同'), '报红没有指名第几段（缺「第 3 段字符不同」）：\n' + r.stderr)
    console.log('[1c] 手改 ' + c.rel + ' § ' + c.anchor + ' 第 ' + e.paragraph + ' 段（共 ' + e.paraCount + ' 段）：'
      + JSON.stringify(e.from) + '→' + JSON.stringify(e.to) + '（没通过真源）→ --check exit 1，报红指名到化身与段号')
  })
})

// ═══ ② A1 回归（本批验收核心）═══════════════════════════════════════════════
test('2 A1 回归：改真源里一条义务段一个字 → --apply 之后只有引用它的化身跟着变', async (t) => {
  await t.test('2a 本角色义务段：变了的化身数 = 该段 usedBy 的长度；没引用的一个都不变', () => {
    const target = pickLocalObligation()
    const root = makeRepo('2a')
    const pre = runGen(root, ['--check'])
    assert.equal(pre.status, 0, '实验开始前临时副本就不干净：\n' + pre.out)

    const before = snapshot(root)
    const sentinel = pickSentinel()

    // 改真源（临时副本里）：只动一个字符，段内不折行 ⇒ 段数不变，不该退化成"段数不符"（那是 exit 2）
    const abs = path.join(root, PERSONA_REL, target.file)
    const doc = JSON.parse(fs.readFileSync(abs, 'utf8'))
    const seg = doc.segments.find((s) => s.id === target.id)
    assert.ok(seg, '真源里找不到段 ' + target.id)
    const m = mutateFirstChar(seg.text, sentinel)
    seg.text = m.text
    fs.writeFileSync(abs, JSON.stringify(doc, null, 2) + '\n')

    const drift = runGen(root, ['--check'])
    assert.equal(drift.status, 1, '真源改了、化身没跟上，--check 应当是 1（不是 2、也不是 0）：\n' + drift.out)

    const ap = runGen(root, ['--apply'])
    assert.equal(ap.status, 0, '--apply 没成功：\n' + ap.out)

    const after = snapshot(root)
    const changed = [...before.keys()].filter((k) => before.get(k) !== after.get(k)).sort()
    const unchanged = [...before.keys()].filter((k) => before.get(k) === after.get(k)).sort()
    const expected = target.refs.map(key).sort()

    console.log('[A1-2a] 真源改动：' + PERSONA_REL + '/' + target.file + ' 的 ' + target.id
      + '（改 1 字：' + JSON.stringify(m.from) + ' → ' + JSON.stringify(m.to) + '）')
    console.log('[A1-2a] 引用它的化身（预期变）：' + expected.length + ' 份 · 该段 usedBy 声明 ' + seg.usedBy.length
      + ' 份（差 ' + (seg.usedBy.length - expected.length) + ' 份＝本布局不存在的载体）'
      + '（' + expected.join('、') + '）')
    console.log('[A1-2a] --apply 后**跟着变的化身**：' + changed.length + ' 份（' + changed.join('、') + '）')
    console.log('[A1-2a] 未引用它的化身（预期不变）：' + unchanged.length + ' 份 · 实际**一个都没变**：' + unchanged.length + ' 份'
      + '；全部化身 ' + CARRIERS.length + ' 份')

    assert.equal(changed.length, expected.length,
      '跟着变的化身数（' + changed.length + '）≠ 本布局在盘的"引用它的化身"数（' + expected.length + '）：' + changed.join('、'))
    assert.deepEqual(changed, expected, '跟着变的化身与"引用它的化身"不是同一批')
    assert.equal(unchanged.length, CARRIERS.length - expected.length)
    for (const k of changed) {
      assert.ok(stripWS(after.get(k)).includes(m.to), '变了的化身里没有这个字（改的不是它？）：' + k)
    }
    for (const k of unchanged) {
      assert.ok(!after.get(k).includes(m.to), '没引用它的化身却也跟着变了：' + k)
    }
    const post = runGen(root, ['--check'])
    assert.equal(post.status, 0, '--apply 之后 --check 不是 0（写盘没让化身跟上真源）：\n' + post.out)
  })

  await t.test('2b 公共池义务段：一个家 → 四个角色的全部化身都跟着变（usedBy 写的是角色名，故必须按角色摊开数）', () => {
    const sharedObl = SHARED_SEGS.filter((s) => s.layer === 'obligation')
    assert.ok(sharedObl.length, '公共池里没有义务段——2b 没有可用的实验对象')
    const seg0 = sharedObl.slice().sort((a, b) => b.usedBy.length - a.usedBy.length)[0]
    assert.ok(SHARED_DOC, '真源里没有 ' + SHARED_FILE)

    const root = makeRepo('2b')
    const pre = runGen(root, ['--check'])
    assert.equal(pre.status, 0, '实验开始前临时副本就不干净：\n' + pre.out)

    const before = snapshot(root)
    const sentinel = pickSentinel()

    const abs = path.join(root, PERSONA_REL, SHARED_FILE)
    const doc = JSON.parse(fs.readFileSync(abs, 'utf8'))
    const seg = doc.segments.find((s) => s.id === seg0.id)
    assert.ok(seg, '公共池里找不到段 ' + seg0.id)
    const m = mutateFirstChar(seg.text, sentinel)
    seg.text = m.text
    fs.writeFileSync(abs, JSON.stringify(doc, null, 2) + '\n')

    const ap = runGen(root, ['--apply'])
    assert.equal(ap.status, 0, '--apply 没成功：\n' + ap.out)

    const after = snapshot(root)
    const changed = [...before.keys()].filter((k) => before.get(k) !== after.get(k)).sort()
    const unchanged = [...before.keys()].filter((k) => before.get(k) === after.get(k)).sort()
    // 引用它＝它的 usedBy 里那几个角色，**每一个角色的每一份化身**
    const expected = CARRIERS.filter((c) => c.segments.includes(seg0.id)).map(key).sort()
    const roles = [...new Set(expected.map((k) => k.split('/')[0]))].sort()

    console.log('[A1-2b] 真源改动：' + PERSONA_REL + '/' + SHARED_FILE + ' 的 ' + seg0.id
      + '（改 1 字：' + JSON.stringify(m.from) + ' → ' + JSON.stringify(m.to) + '）')
    console.log('[A1-2b] 该段 usedBy 写的是**角色名**，长度 ' + seg0.usedBy.length + '（' + seg0.usedBy.join('、') + '）'
      + ' ⇒ 摊到化身：' + expected.length + ' 份（' + roles.length + ' 个角色 × 各 ' + (expected.length / roles.length) + ' 份）')
    console.log('[A1-2b] --apply 后**跟着变的化身**：' + changed.length + ' 份（' + changed.join('、') + '）')
    console.log('[A1-2b] 未引用它的化身：' + unchanged.length + ' 份 · 实际**一个都没变**：' + unchanged.length + ' 份')

    assert.equal(roles.length, seg0.usedBy.length, '跟着变的角色数（' + roles.length + '）≠ usedBy 的长度（' + seg0.usedBy.length + '）')
    assert.deepEqual(changed, expected, '跟着变的化身与"引用它的角色 × 它们的全部化身"不是同一批')
    assert.equal(unchanged.length, CARRIERS.length - expected.length)
    for (const k of changed) assert.ok(stripWS(after.get(k)).includes(m.to), '变了的化身里没有这个字：' + k)
    for (const k of unchanged) assert.ok(!after.get(k).includes(m.to), '没引用它的化身却也跟着变了：' + k)
    const post = runGen(root, ['--check'])
    assert.equal(post.status, 0, '--apply 之后 --check 不是 0：\n' + post.out)
  })
})

// ═══ ③ 单点性 ═══════════════════════════════════════════════════════════════
test('3 单点性：同一句义务在真源里只有一个家（上提到 _shared.json 的也算一处）', async (t) => {
  await t.test('3a A1 那条本角色义务句：在 ' + PERSONA_REL + ' 下全域字面搜索，命中数 = 1', () => {
    const target = pickLocalObligation()
    const hits = literalHits(SEG_TEXT.get(target.id))
    assert.equal(totalHits(hits), 1,
      '段 ' + target.id + ' 的文本在真源里命中了 ' + totalHits(hits) + ' 处（' + hits.map((h) => h.file + '×' + h.n).join('、')
      + '）——同一句义务有第二个家，改一处就会漏另一处')
    assert.equal(hits[0].file, target.file, '这一处不在它的家在的那份文件里：' + hits[0].file + ' ≠ ' + target.file)
    console.log('[单点 3a] ' + target.id + '（' + target.file + '）：全域字面搜索命中 ' + totalHits(hits) + ' 处（' + hits[0].file + '）')
  })

  await t.test('3b 跨角色同类句已上提到 ' + SHARED_FILE + '：仍算 1 处，四个旧家 0 处', () => {
    assert.ok(SHARED_DOC, '真源里没有 ' + SHARED_FILE + '——公共池不存在，这一条没有对象')
    assert.ok(SHARED_SEGS.length, SHARED_FILE + ' 里 0 个段')
    const rows = []
    for (const s of SHARED_SEGS) {
      const hits = literalHits(s.text)
      assert.equal(totalHits(hits), 1, '共享段 ' + s.id + ' 的文本命中了 ' + totalHits(hits) + ' 处：'
        + hits.map((h) => h.file + '×' + h.n).join('、'))
      assert.equal(hits[0].file, SHARED_FILE, '共享段 ' + s.id + ' 的家不在 ' + SHARED_FILE + '：' + hits[0].file)
      // 它上提之前的那些家（usedBy 里的角色自己的真源）必须一处都不剩——上提没上干净＝还留着会漂的副本
      for (const rn of s.usedBy) {
        const f = ROLE_FILES.find((x) => x === rn + '.json') || (rn + '.json')
        const raw = fs.readFileSync(path.join(SRC, f), 'utf8')
        const needle = JSON.stringify(s.text).slice(1, -1)
        assert.ok(!raw.includes(needle), '共享段 ' + s.id + ' 在角色 ' + rn + ' 的真源里还留着一份（' + f + '）——上提没上干净')
      }
      rows.push(s.id + '（usedBy ' + s.usedBy.length + ' 个角色：' + s.usedBy.join('、') + '）')
    }
    console.log('[单点 3b] ' + SHARED_SEGS.length + ' 个共享段各命中 1 处（都在 ' + SHARED_FILE + '），'
      + '四个角色的旧家 0 处：' + rows.join(' · '))
  })

  await t.test('3c 全部义务段：没有两句是同一句（逐段文本两两不同）', () => {
    const obligations = []
    for (const { file, doc } of ROLE_DOCS) {
      for (const s of doc.segments) if (s.layer === 'obligation') obligations.push({ file, id: s.id, text: s.text })
    }
    for (const s of SHARED_SEGS) if (s.layer === 'obligation') obligations.push({ file: SHARED_FILE, id: s.id, text: s.text })
    assert.ok(obligations.length > 0, '真源里 0 个义务段——空集不等于干净')
    const byText = new Map()
    for (const o of obligations) {
      const k = stripWS(o.text)
      if (!byText.has(k)) byText.set(k, [])
      byText.get(k).push(o.id + '@' + o.file)
    }
    const dup = [...byText.values()].filter((v) => v.length > 1)
    assert.equal(dup.length, 0, '同一句义务被声明了两次：' + dup.map((v) => v.join(' | ')).join('；'))
    console.log('[单点 3c] ' + obligations.length + ' 个义务段（角色段 + 公共池）逐段文本两两不同：0 组重复')

    // ── 只报告、不设门禁（判读权在人）───────────────────────────────────────
    // "字面搜索命中数 = 1"这条口径对**已登记的那两种形状**会给出 >1：① 同一句被 _note 当场引用；
    // ② 本段文本是另一个**更长的段**的子串（于是生成出来的正文里这句话出现两次）。
    // 它们不是"同一声明重复登记"（3c 已断言为 0），但②确实是一个会漂的家：改短的、长的那份不动。
    // 把它升级成红灯＝当场把 check-all 弄红，而那是数据口径、不是生成器能力——留给 Owner 拍板，故只报告。
    const odd = []
    for (const o of obligations) {
      const hits = literalHits(o.text)
      const n = totalHits(hits)
      if (n === 1) continue
      const parts = hits.map((h) => {
        const doc = h.file === SHARED_FILE ? SHARED_DOC : ROLE_DOCS.find((d) => d.file === h.file).doc
        const exact = doc.segments.filter((s) => JSON.stringify(s.text) === JSON.stringify(o.text)).length
        const inside = doc.segments.filter((s) => s.id !== o.id && s.text.includes(o.text)).map((s) => s.id)
        const rest = h.n - exact - inside.length
        return h.file + '×' + h.n + '（段声明 ' + exact + ' 处'
          + (inside.length ? ' + 被段 ' + inside.join('、') + ' 逐字包含 ' + inside.length + ' 处' : '')
          + (rest > 0 ? ' + 其余 ' + rest + ' 处（落在 _note 的引文里，不进化身）' : '') + '）'
      })
      odd.push('  ⚠ ' + o.id + '@' + o.file + '：字面命中 ' + n + ' 处 —— ' + parts.join('；'))
    }
    if (odd.length) {
      console.log('[单点 3c] 只报告（**不判定**）：字面命中不止一处的义务段 ' + odd.length + ' 个——')
      for (const l of odd) console.log(l)
      console.log('     （口径由 Owner 拍板：②那类"被更长的段逐字包含"是真正会漂的家（改短的、长的那份不动），'
        + '收干净之后这条才能升级成门禁；①那类落在 _note 的引文不进化身，本不构成第二个家。）')
    } else {
      console.log('[单点 3c] 只报告：字面命中不止一处的义务段 0 个')
    }
  })
})

// ═══ ④ 空转判据 ═════════════════════════════════════════════════════════════
test('4 空转判据：真源清空 / 某角色 carriers 为空 / 锚点被删 → exit 2（不许以 0 或 1 退出）', async (t) => {
  const assert2 = (r, what, re) => {
    assert.notEqual(r.status, 0, what + '：不许以 0（通过）退出\n' + r.out)
    assert.notEqual(r.status, 1, what + '：真正的不符是 1，判定不了才是 2——这不是"漂移"，是"算不出来"\n' + r.out)
    assert.equal(r.status, 2, what + '：应当 exit 2\n' + r.out)
    assert.match(r.stderr, re, what + '：exit 2 但没说清判定不了的原因\n' + r.out)
  }

  await t.test('4a 真源目录被清空（0 个角色 *.json）', () => {
    const root = makeRepo('4a')
    for (const f of fs.readdirSync(path.join(root, PERSONA_REL))) fs.rmSync(path.join(root, PERSONA_REL, f))
    const r = runGen(root, ['--check'])
    assert2(r, '真源目录清空', /真源目录里没有任何角色/)
    console.log('[空转 4a] 真源目录清空 → exit ' + r.status + '：' + r.stderr.split('\n')[0].trim())
  })

  await t.test('4b 真源目录整个不在', () => {
    const root = makeRepo('4b')
    fs.rmSync(path.join(root, PERSONA_REL), { recursive: true, force: true })
    const r = runGen(root, ['--check'])
    assert2(r, '真源目录不在', /真源目录不存在/)
    console.log('[空转 4b] 真源目录不在 → exit ' + r.status + '：' + r.stderr.split('\n')[0].trim())
  })

  await t.test('4c 某角色的 carriers 为空（这个角色的化身在哪，没有答案）', () => {
    const root = makeRepo('4c')
    const f = ROLE_FILES[0]
    const doc = JSON.parse(fs.readFileSync(path.join(root, PERSONA_REL, f), 'utf8'))
    doc.carriers = []
    fs.writeFileSync(path.join(root, PERSONA_REL, f), JSON.stringify(doc, null, 2) + '\n')
    const r = runGen(root, ['--check'])
    assert2(r, 'carriers 为空', /没有任何化身/)
    console.log('[空转 4c] ' + f + ' 的 carriers = [] → exit ' + r.status + '：' + r.stderr.split('\n')[0].trim())
  })

  await t.test('4d 预设里的 YAML 锚点被删/改名', () => {
    const root = makeRepo('4d')
    const c = CARRIERS.find((x) => x.role === 'archivist' && x.kind === 'yaml-persona')
    const abs = path.join(root, c.rel)
    const out = fs.readFileSync(abs, 'utf8').split(/\r?\n/)
      .map((l) => (new RegExp('^\\s*-\\s*id:\\s*' + RES(c.anchor) + '\\s*$').test(l) ? l.replace(c.anchor, c.anchor + '-renamed') : l))
      .join('\n')
    fs.writeFileSync(abs, out)
    const r = runGen(root, ['--check'])
    assert2(r, 'YAML 锚点被删', /找不到锚点/)
    assert.ok(r.stderr.includes(c.anchor), 'exit 2 没指名是哪个锚点：\n' + r.stderr)
    console.log('[空转 4d] ' + c.rel + ' § ' + c.anchor + ' 锚点被改名 → exit ' + r.status + '：' + r.stderr.split('\n')[0].trim())
  })

  await t.test('4e 派工文本的 md 锚点被删', () => {
    const root = makeRepo('4e')
    const c = CARRIERS.find((x) => x.role === 'reader' && x.kind === 'md-persona')
    const abs = path.join(root, c.rel)
    const out = fs.readFileSync(abs, 'utf8').split(/\r?\n/)
      .map((l) => (l.trim() === c.anchor ? l.replace(c.anchor, c.anchor + '（改）') : l)).join('\n')
    fs.writeFileSync(abs, out)
    const r = runGen(root, ['--check'])
    assert2(r, 'md 锚点被删', /找不到锚点/)
    console.log('[空转 4e] ' + c.rel + ' § ' + c.anchor + ' 锚点被删 → exit ' + r.status + '：' + r.stderr.split('\n')[0].trim())
  })

  await t.test('4f 锚点被删 + 写盘模式（--apply）：仍 exit 2，且一份文件都没写', () => {
    const root = makeRepo('4f')
    const c = CARRIERS.find((x) => x.role === 'archivist' && x.kind === 'yaml-persona')
    const abs = path.join(root, c.rel)
    const out = fs.readFileSync(abs, 'utf8').split(/\r?\n/)
      .map((l) => (new RegExp('^\\s*-\\s*id:\\s*' + RES(c.anchor) + '\\s*$').test(l) ? l.replace(c.anchor, c.anchor + '-renamed') : l))
      .join('\n')
    fs.writeFileSync(abs, out)
    const before = new Map(CARRIER_RELS.map((r) => [r, fs.readFileSync(path.join(root, r))]))
    const r = runGen(root, ['--apply'])
    assert2(r, '锚点被删 + --apply', /找不到锚点/)
    for (const rl of CARRIER_RELS) {
      assert.ok(before.get(rl).equals(fs.readFileSync(path.join(root, rl))),
        '判定不了的时候写盘了：' + rl + '——"算不出对齐后长什么样就不落盘"这条纪律破了')
    }
    console.log('[空转 4f] 锚点被删 + --apply → exit ' + r.status + '，九份载体逐字节未动')
  })
})

// ═══ ⑤ 条款号（A3 · 2026-09-22）═══════════════════════════════════════════════
// 为什么单独立一组：条款此前只能引到"纪律⑤"——位置号会漂（ASVS 自家 README 明说），
// 于是改稿后引用指向别处。稳定号是"能被引用的前提"（SARIF §3.49.3：id SHALL be stable）。
// 这组钉两件事：真源里义务段**都有号且不撞号**；号**真的渲染进了每一个化身**（不是只活在真源里）。
test('5 条款号：每个义务段都有稳定号、全局不撞号、且在每个化身里都渲染成 〔CODE〕', () => {
  const CODE_RE = /^[A-Z]{2,6}-\d{2}$/
  const seen = new Map()
  const ALLSEG = [
    ...ROLE_DOCS.flatMap((r) => r.doc.segments.map((s) => ({ f: r.file, s }))),
    ...(SHARED_DOC ? SHARED_DOC.segments.map((s) => ({ f: SHARED_FILE, s })) : []),
  ]
  let obl = 0
  for (const { f, s } of ALLSEG) {
    if (s.layer !== 'obligation') continue
    obl++
    assert.ok(s.code, f + ' 的义务段「' + s.id + '」没有稳定号——引用只能退回到"纪律⑤"那种位置说法')
    assert.ok(CODE_RE.test(s.code), f + ' 的「' + s.id + '」条款号格式不对（要 <前缀>-<两位序号>）：' + s.code)
    assert.ok(!seen.has(s.code), '条款号撞号：' + s.code + ' 同时属于 ' + seen.get(s.code) + ' 与 ' + s.id)
    seen.set(s.code, s.id)
  }
  assert.ok(obl > 0, '真源里一个义务段都没有——这组守卫会空转（空转必须报错，不许打成通过）')

  let checked = 0
  for (const c of CARRIERS) {
    const txt = fs.readFileSync(path.join(REPO, c.rel), 'utf8')
    for (const id of c.segments) {
      const hit = ALLSEG.find((x) => x.s.id === id)
      if (!hit || !hit.s.code) continue
      assert.ok(txt.includes('〔' + hit.s.code + '〕'),
        c.rel + ' 里找不到条款号 〔' + hit.s.code + '〕（' + id + '）——号只在真源里，引用还是落不到纸上')
      checked++
    }
  }
  assert.ok(checked > 0, '一条渲染都没核到——夹具坏了，别当成通过')
  console.log('[条款号] ' + seen.size + ' 个稳定号 · 覆盖 ' + obl + ' 个义务段 · 化身里核到 ' + checked + ' 处渲染')
})
