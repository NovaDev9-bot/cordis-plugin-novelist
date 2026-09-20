#!/usr/bin/env node
/**
 * build-wb-expert.mjs —— 从仓内真源装配 WorkBuddy 专家包（编剧部）
 *
 * 用法：
 *   node scripts/build-wb-expert.mjs --out <专家包目录> [--root <仓库根>] [--check]
 *        [--book-root <书库目录>] [--handbooks <作业手册目录>] [--prune] [--mirror <已装目录>]
 *
 * 住哪：**公开仓**（scripts/），因为它要能被克隆者直接跑一次就装上 WorkBuddy。
 * 私有仓经 plugin-novelist 子仓调用它，作业手册用 --handbooks 指过去。
 *
 * 为什么要有它：WorkBuddy 专家包是**派生件**——人格来自 preset-starter、协议来自
 * preset-starter/protocols（公开脱敏版）、仪器与作家卡来自同仓、机制手册来自
 * lib/novelist.js 的 SECTION。手工拼一次能跑，但没人复算得出来，改一次源就对不上一次。
 * 本脚本把"装配过程"本身变成真源：模板（人手写的那部分）在
 * wb-expert-starter/，机械复制的那部分每次从源读。
 *
 * 退出码：0=成功 / 1=自证发现不一致（--check 时） / 2=没装配成（源扫到 0 件等）
 */
import { promises as fsp } from 'node:fs'
import fsSync from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import crypto from 'node:crypto'
import { spawnSync } from 'node:child_process'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { deflateSync } from 'node:zlib'
import { stripAbsPaths, absPaths } from './abs-path.mjs'

// 两种落地形态都要认（2026-09-18 本脚本从私有仓搬进公开仓）：
//   ① mono：私有仓 —— ROOT/dsh-native/{vault,plugin-novelist}
//   ② flat：公开仓 clone —— ROOT/{wb-expert-starter,lib,mcp}
// 判据是标记目录，不是路径猜谜；认不出就报错，不回落一个假默认。
const MONO_MARKERS = ['dsh-native', 'vault']
const FLAT_MARKERS = ['wb-expert-starter', 'lib']
const MARKERS = [...MONO_MARKERS, ...FLAT_MARKERS]
const argv = process.argv.slice(2)
const opt = (n) => { const i = argv.indexOf(n); return i !== -1 ? argv[i + 1] : null }
const CHECK = argv.includes('--check')

function die(msg, hint) {
  console.error('[build-wb-expert] 无法执行：' + msg + (hint ? '\n  提示：' + hint : ''))
  process.exit(2)
}
const isMono = (d) => MONO_MARKERS.every((m) => fsSync.existsSync(path.join(d, m)))
const isFlat = (d) => FLAT_MARKERS.every((m) => fsSync.existsSync(path.join(d, m)))
function findRoot(start) {
  let cur = path.resolve(start)
  for (;;) {
    if (isMono(cur) || isFlat(cur)) return cur
    const up = path.dirname(cur)
    if (up === cur) return null
    cur = up
  }
}

const rootRaw = opt('--root') || process.env.NF_REPO_ROOT || findRoot(path.dirname(fileURLToPath(import.meta.url)))
if (!rootRaw) die('没有找到仓库根（两种形态都不匹配）',
  '认两种：① monorepo（同时有 ' + MONO_MARKERS.join(' 与 ') + '）'
  + '② 公开单仓（同时有 ' + FLAT_MARKERS.join(' 与 ') + '）。用 --root <仓库根> 或环境变量 NF_REPO_ROOT 指定。')
const ROOT = path.resolve(rootRaw)
// 插件根：monorepo 在 dsh-native/plugin-novelist，公开单仓就是 ROOT 自己。
const PLUGIN = isMono(ROOT) ? path.join(ROOT, 'dsh-native', 'plugin-novelist') : ROOT

// 作业手册（主编/策划/写手三份作业规程）：**不在发布清单里**，公开克隆里没有这个目录。
// 所以它是**可选的**——给了就用，没给就明说"本次不含"，不做静默跳过（少 3 件要看得见）。
// 默认值只在 monorepo 形态下有意义；flat 形态别去拼一个不存在的路径，直接报"未指定"。
// 作业手册默认源：mono（私有仓）读真源模板；flat（公开仓 clone）读插件仓内的派生副本。
// 两处都要有——2026-09-18 前 flat 下 HB_DEFAULT=null，包**默认就缺这一层**（虽打印"本次不含"，
// 但对"clone 完照一条命令装"的用户来说，缺件应当是意外而不是默认）。
const HB_DEFAULT = isMono(ROOT)
  ? path.join(ROOT, 'dsh-native', 'vault-template', 'editorial', 'handbooks')
  : path.join(PLUGIN, 'editorial', 'handbooks')
const HB_RAW = opt('--handbooks') || process.env.NF_HANDBOOKS || HB_DEFAULT
const HANDBOOKS = HB_RAW && fsSync.existsSync(HB_RAW) ? HB_RAW : null

const outRaw = opt('--out') || process.env.NF_WB_EXPERT_OUT
if (!outRaw) die('缺 --out <专家包目录>', '例：--out %USERPROFILE%\\.workbuddy\\plugins\\marketplaces\\my-experts\\plugins\\novel-forge-editorial')
const TARGET = path.resolve(outRaw)
// 〔2026-09-18 审计修复 E7〕--check 必须**只读比对**，不许写盘。
// 旧实现的 --check 照常全量写目标目录，只在末尾打一句"本次为装配校验，未与既有内容比对"——
// 也就是说它既没比对又把校验变成了破坏性写入，而文件头还承诺了一个不可达的 exit 1。
// 现在：--check 装配到临时目录，再与目标逐文件哈希比对，有差异 exit 1。
if (CHECK && !fsSync.existsSync(TARGET)) {
  die('--check 需要目标目录已存在才能比对：' + TARGET, '先正常装配一次，再用 --check 验证"源改了但包装配没跟上"')
}
const OUT = CHECK ? fsSync.mkdtempSync(path.join(os.tmpdir(), 'nf-wb-check-')) : TARGET

const written = []
let SRC_MOD = null       // 真源 lib 模块句柄（等价性断言要用它的 TOOLS 数）
let bookRoot = null      // 书库根（第 0a 步校验并解析，第 6b 步注入 plugin.json）

// 上一版清单必须在写入任何文件**之前**读出来——写在后面会被本次覆盖，
// 于是 --prune 永远看到"新清单"，残留一件也清不掉（本装配器第一版就栽在这）。
const prevManifestPath = path.join(OUT, 'MANIFEST.sha256')
const prevFiles = fsSync.existsSync(prevManifestPath)
  ? fsSync.readFileSync(prevManifestPath, 'utf8').split('\n').map((l) => l.trim().split(/\s{2,}/)[1]).filter(Boolean)
  : null
const report = []
const srcOf = new Map()          // outRel → 源绝对路径（引用改写用；生成件不入表）
const say = (s) => { report.push(s); console.log(s); }

// ── 0a. 参数校验必须在**任何写盘之前**（2026-09-21 第三方复核 §六.1 修）
// 实测事故：漏 `--book-root` 时，装配器**先写了一部分包**再 die——而退出码 2 的语义是
// "没检查成"，最容易被读成"什么都没动"，实际包已经被写脏（plugin.json 丢了书库根、
// 源仓坐标漏进包、selfcheck 当场红 6 条引用不可达）。判据＝缺参数时目标目录逐字节零变化。
// 残留风险（如实登记，不假装根治）：这是"校验前移"，不是原子替换——运行中途其它 die
// （某路源文件缺失等）仍会留下半成品。要根治得改成"临时目录装配 + 校验通过后原子替换"，
// 那时 --prune/清单读取/市场根推导三处都要跟着改，属另一件事。
{
  const bookRaw = opt('--book-root') || process.env.NF_BOOK_ROOT
  if (!bookRaw) {
    die('缺 --book-root <书库目录>',
      '书库根＝你放书稿的目录（MCP server 的 --root 硬前置，所有 book_dir 都圈在它里面）。'
      + '\n  两种给法：①--book-root <目录>  ②环境变量 NF_BOOK_ROOT。'
      + '\n  它是安全边界，所以本工具**不猜默认值**——给一个你自己的目录即可。'
      + '\n  （本判定在写盘之前，缺参数时目标目录零变化）')
  }
  bookRoot = path.resolve(bookRaw)
  if (!fsSync.existsSync(bookRoot)) {
    die('书库根不存在：' + bookRoot, '换一个已存在的目录，或先把它建出来。（本判定在写盘之前）')
  }
}

// ── 0b. 角色工具面 / 文本层不变量：装配前先核对"派生件与真源一致"（fail-closed）
// 为什么放在装配最前面：`references/宿主工具面.md`、角色名单、人格义务句、画像条款都是
// **派生或有不变量的文本**，装配器只负责搬运。搬运一份过期的生成物＝把上一个版本的谎话
// 打进包里，而包里没人会报。
// 判定不许由本脚本再写一份（同一事实两处判定＝本项目最贵的那类缺陷），一律调 roles/ 下的
// 守卫脚本；红了就装配失败，连带它的原话一起打印。
// --root 取 PLUGIN：本装配器在 mono/flat 两种布局下都从**插件仓**取源，校验范围与取源范围一致。
{
  const guards = [
    {
      rel: 'roles/build-tool-face.mjs', args: ['--check'], label: '角色工具面',
      what: '能力表 roles/tool-face.json 是真源；生成物（预设名单、宿主工具面文档）手改无效',
    },
    {
      rel: 'roles/text-invariants.mjs', args: [], label: '文本层不变量',
      what: '人格义务句禁模式 / 画像条款跨化身同句 / SOP 同数——三组都由它守着，改文本时别绕过它',
    },
  ]
  for (const g of guards) {
    const gen = path.join(PLUGIN, g.rel)
    if (!fsSync.existsSync(gen)) {
      die('缺' + g.label + '守卫：' + gen, '本仓新增的 roles/ 必须在发布清单里（package.json 的 files）')
    }
    const r = spawnSync(process.execPath, [gen, '--root', PLUGIN].concat(g.args), { encoding: 'utf8' })
    const out = ((r.stdout || '') + (r.stderr || '')).trimEnd()
    if (r.status !== 0) {
      die(g.label + '守卫未通过（退出码 ' + r.status + '）——先跑：node ' + g.rel + '\n' + out, g.what)
    }
    say('· ' + g.label + '：与真源一致（已核对）')
  }
}
const sha = (buf) => crypto.createHash('sha256').update(buf).digest('hex')
const write = async (rel, data, srcAbs) => {
  const norm = rel.split(path.sep).join('/')      // 清单/自证一律用 / 口径（Windows path.join 给的是 \）
  const p = path.join(OUT, norm)
  await fsp.mkdir(path.dirname(p), { recursive: true })
  await fsp.writeFile(p, data)
  written.push(norm)
  if (srcAbs) srcOf.set(norm, path.resolve(srcAbs))   // 供"源坐标→包坐标"引用改写（见 7c2）
}
const copyDir = async (src, destRel, filter) => {
  if (!fsSync.existsSync(src)) die('源目录不存在：' + src)
  const names = await fsp.readdir(src)
  let n = 0
  for (const name of names) {
    if (filter && !filter(name)) continue
    const s = path.join(src, name)
    await write(path.join(destRel, name), await fsp.readFile(s), s)
    n++
  }
  if (n === 0) die('自证失败：' + src + ' 扫到 0 件（0 件不等于"没有变化"——多半是路径错了）')
  return n
}

// ── 1. 模板（人手写的那部分） ───────────────────────────────────────────────
const TPL = path.join(PLUGIN, 'wb-expert-starter')
if (!fsSync.existsSync(TPL)) die('模板目录不存在：' + TPL)
const walk = (d) => fsSync.readdirSync(d, { withFileTypes: true }).flatMap((e) => e.isDirectory() ? walk(path.join(d, e.name)) : [path.join(d, e.name)])
const tplFiles = walk(TPL)
if (tplFiles.length === 0) die('自证失败：模板目录 ' + TPL + ' 是空的')
// marketplace.json 不落在包内——它在"市场根"的 .codebuddy-plugin/ 下（见下）
// 先读进内存不落盘：启动包里对 guide 文件名的引用要等 guide 版本算出来才能改写（见下方 2b）
const tplBuf = new Map()
const tplSrc = new Map()
for (const f of tplFiles) {
  const rel = path.relative(TPL, f).split(path.sep).join('/')
  if (rel === 'marketplace.json') continue
  tplBuf.set(rel, await fsp.readFile(f, 'utf8'))
  tplSrc.set(rel, f)
}
say('· 模板：' + (tplFiles.length - 1) + ' 件（agents/skills/plugin.json/README/selfcheck）')

// ── 1b. 市场清单：<市场根>/.codebuddy-plugin/marketplace.json ───────────────
// 约定落位 = <市场根>/plugins/<包名>（WorkBuddy 官方与本机 my-experts 同构）
{
  const mkRoot = path.resolve(opt('--marketplace-root') || path.join(CHECK ? TARGET : OUT, '..', '..'))
  const src = path.join(TPL, 'marketplace.json')
  if (!fsSync.existsSync(src)) die('模板缺 marketplace.json：' + src)
  if (CHECK) { say('· 市场清单：--check 模式跳过写入') } else
  if (!fsSync.existsSync(path.join(mkRoot, 'plugins'))) {
    console.warn('[build-wb-expert] 跳过市场清单：' + mkRoot + ' 下没有 plugins/ 目录（不像市场根）。用 --marketplace-root 指定。')
  } else {
    const dest = path.join(mkRoot, '.codebuddy-plugin', 'marketplace.json')
    await fsp.mkdir(path.dirname(dest), { recursive: true })
    await fsp.writeFile(dest, await fsp.readFile(src))
    say('· 市场清单：' + dest)
  }
}

// ── 2. 机制手册（从 lib/novelist.js 的 SECTION 现导，杜绝过期副本） ──────────
let guideText = '', guideName = '', guideVer = ''
{
  const libUrl = pathToFileURL(path.join(PLUGIN, 'lib', 'novelist.js')).href
  let mod
  try { mod = await import(libUrl) } catch (e) { die('导入 lib/novelist.js 失败：' + e.message) }
  SRC_MOD = mod
  const SECTION = mod._internals && mod._internals.SECTION
  if (!SECTION || !SECTION.text) die('lib/novelist.js 没导出 SECTION.text')
  guideText = SECTION.text
  guideName = SECTION.name
  if (guideText.length < 8000) die('自证失败：导出的 SECTION.text 只有 ' + guideText.length + ' 字符（疑似截断）')
  const cjk = (guideText.match(/[\u4e00-\u9fa5]/g) || []).length
  if (cjk / guideText.length < 0.4) die('自证失败：SECTION.text 中文占比 ' + Math.round(cjk / guideText.length * 100) + '%（疑似乱码）')
  const vers = [...guideText.matchAll(/v7\.(\d+)/g)].map((m) => Number(m[1]))
  if (vers.length === 0) die('自证失败：SECTION.text 里找不到任何 v7.N 版本标记，无法定文件名')
  // 取文中最高版本＝当前生效口径（文本开头写的是"沿革起点"，直接取首个匹配会得到旧版本号）
  const ver = 'v7.' + Math.max(...vers)
  guideVer = ver
  const head = '# ' + guideName + ' ' + ver + '（工具层同版注入 · 机制细则唯一真源）\n\n' +
    '> 本文件由 lib/novelist.js 的 SECTION 原文导出（chars=' + guideText.length + '）。\n' +
    '> 宿主不一定注入 MCP initialize.instructions —— 接活前先调 novel_guide 工具取同版全文，或以本文件为准。\n' +
    '> **工具层优先**：本文件与工具 description 若有出入，以工具描述为准。\n\n---\n\n'
  // 静态导出副本的路径改写：SECTION.text 里的绝对路径是**真源机**在 import 时算出来的
  // （沿真源 lib/ 位置），原样烤进包里就是死路径（2026-09-19 审计实测：包内手册带着装配机的
  // H 盘路径，离线兜底那份谁也读不到）。改写成包内坐标（vendor 资产已随包）；认不出的
  // 绝对路径 die，不猜——改写后不允许残留任何机器路径。
  const GUIDE_PKG_MAP = [
    ['lib/guide-history.md', 'vendor/novelist/lib/guide-history.md'],
    ['craft/author-cards', 'vendor/novelist/craft/author-cards'],
    ['instruments/style-lexicon.json', 'vendor/novelist/instruments/style-lexicon.json'],
  ]
  let staticGuide = guideText
  for (const raw of absPaths(staticGuide)) {
    const p = raw.replace(/[\\/]+$/, '')            // 目录路径常带尾分隔符（…\craft\author-cards\）
    const norm = p.split(path.sep).join('/').replace(/\\/g, '/')
    const hit = GUIDE_PKG_MAP.find(([suf]) => norm.toLowerCase().endsWith(suf.toLowerCase()))
    if (!hit) die('静态机制手册里有认不出的绝对路径（不猜：往 GUIDE_PKG_MAP 加映射，或修真源文本）：' + raw)
    const tail = /[\\/]$/.test(raw) ? '/' : ''
    staticGuide = staticGuide.split(raw).join(hit[1] + tail)
  }
  // 文件名**不带版本号**（2026-09-20 复核 REC-07）：版本只活在 GUIDE_VERSION 常量与本文件首行。
  // 带版本号时每次升版都要全包重对齐引用——那是"每版都可能漏一处"的复现装置；
  // 稳定文件名把这类断链从根上删掉（本批同时保留对历史 vX.Y 形态引用的改写，供存量模板过渡）。
  await write('references/' + guideName + '.md', head + staticGuide + '\n')
  say('· 机制手册：现导 ' + guideText.length + ' 字符（' + ver + '，文件名 novelist-guide.md 不带版本号）')
}

// ── 2b. 落盘模板件，并把历史版本的 guide 文件名引用收敛到稳定名 ───────────────
// 2026-09-18：启动包把版本号抄了 5 处，装配器按现算版本改文件名——每次升版都可能漏一处（实测漏过）。
// 2026-09-20（REC-07）：文件名去版本号后，引用永不需要改；本段降级为**过渡改写**——
// 存量模板里若还写着 `novelist-guide-v7.12.md` / `-v7.NN.md` 占位符，一律收敛到稳定名。
// 零命中是**正常**（新形态），但必须报数：跳过的每一类都要看得见，不静默。
{
  const GUIDE_REF = /novelist-guide-v7(?:\.\d+|\.NN)\.md/g
  const guideFile = guideName + '.md'
  let subs = 0
  for (const [rel, text] of tplBuf) {
    subs += (text.match(GUIDE_REF) || []).length
    // 收敛后顺手摘掉占位符标记〔模板〕——此刻它已是包内实件，
    // 留着标记会让 7d 的引用自证把它当"占位符不查"放过去（自证就该查它）
    const out = text.replace(GUIDE_REF, guideFile).split('`' + guideFile + '`〔模板〕').join('`' + guideFile + '`')
    await write(rel, out, tplSrc.get(rel))
  }
  say('· 启动包 guide 引用：' + (subs ? subs + ' 处历史版本名 → 收敛到 ' + guideFile : '0 处历史版本名（常规——文件名已稳定）'))
}

// ── 3. 协议与作业手册 ───────────────────────────────────────────────────────
// 协议取自 preset-starter/protocols —— 那是同步器按 sync-allowlist 的脱敏规则
// 派生出来的**公开版**，与 GitHub 上同文。所以装配出来的包内容与公开面一致，
// 不需要另做一份"干净协议"：纯净版一直只有一份，就是公开仓。
// 作业手册是唯一不在发布清单里的输入，故走 HANDBOOKS（可缺）。
say('· 协议模板（公开脱敏版）：' + await copyDir(path.join(PLUGIN, 'preset-starter', 'protocols'), 'references/protocols', (f) => f.endsWith('.md')) + ' 件')
if (HANDBOOKS) {
  say('· 作业手册：' + await copyDir(HANDBOOKS, 'references/handbooks', (f) => f.endsWith('.md')) + ' 件（源=' + HANDBOOKS + '）')
} else {
  say('· 作业手册：**本次不含**（' + (HB_RAW ? HB_RAW + ' 不存在' : '未指定 --handbooks') + '）。缺的是主编/主笔两份作业规程——')
  say('  工具、协议、卡、人格都不受影响；要含进去就用 --handbooks <目录> 指定。')
}

// ── 4. 仪器（排除测试文件；style-lexicon.json 必须随行） ─────────────────────
say('· 仪器脚本：' + await copyDir(path.join(PLUGIN, 'instruments'), 'scripts', (f) => f.endsWith('.mjs') && !f.endsWith('.test.mjs')) + ' 件')
{
  const lex = path.join(PLUGIN, 'instruments', 'style-lexicon.json')
  if (!fsSync.existsSync(lex)) die('词库缺失：' + lex)
  await write('scripts/style-lexicon.json', await fsp.readFile(lex), lex)
}

// ── 5. 作家个体参照卡 ───────────────────────────────────────────────────────
// 卡只此一份（真源与公开同文，见 sync-allowlist 的 _sanitize_卡条说明）：
// 卡里**带原文范例**，并且**每张都有出处行**——主笔的 glob/grep 被 deny，
// 只给"该作品第 N 章"这种坐标它 read 不出来，卡就是空转的；而贴了别人的正文就必须署出处。
say('· 作家卡：' + await copyDir(path.join(PLUGIN, 'craft', 'author-cards'), 'craft/author-cards', (f) => f.endsWith('.md')) + ' 件')

// ── 6. 头像（程序生成，无外部素材） ─────────────────────────────────────────
{
  const W = 512, H = 512
  const crcTable = (() => { const t = []; for (let n = 0; n < 256; n++) { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; t[n] = c >>> 0 } return t })()
  const crc32 = (buf) => { let c = 0xffffffff; for (const b of buf) c = crcTable[(c ^ b) & 0xff] ^ (c >>> 8); return (c ^ 0xffffffff) >>> 0 }
  const chunk = (type, data) => {
    const len = Buffer.alloc(4); len.writeUInt32BE(data.length)
    const body = Buffer.concat([Buffer.from(type, 'ascii'), data])
    const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(body))
    return Buffer.concat([len, body, crc])
  }
  const png = (rgba) => {
    const ihdr = Buffer.alloc(13)
    ihdr.writeUInt32BE(W, 0); ihdr.writeUInt32BE(H, 4); ihdr[8] = 8; ihdr[9] = 6
    const raw = Buffer.alloc((W * 4 + 1) * H)
    for (let y = 0; y < H; y++) rgba.copy(raw, y * (W * 4 + 1) + 1, y * W * 4, (y + 1) * W * 4)
    return Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
      chunk('IHDR', ihdr), chunk('IDAT', deflateSync(raw, { level: 9 })), chunk('IEND', Buffer.alloc(0))])
  }
  const mk = (bg) => { const b = Buffer.alloc(W * H * 4); for (let i = 0; i < W * H; i++) { b[i * 4] = bg[0]; b[i * 4 + 1] = bg[1]; b[i * 4 + 2] = bg[2]; b[i * 4 + 3] = 255 } return b }
  const px = (b, x, y, c, a = 1) => { if (x < 0 || y < 0 || x >= W || y >= H) return; const i = (y * W + x) * 4; b[i] = Math.round(b[i] * (1 - a) + c[0] * a); b[i + 1] = Math.round(b[i + 1] * (1 - a) + c[1] * a); b[i + 2] = Math.round(b[i + 2] * (1 - a) + c[2] * a) }
  const rect = (b, x0, y0, w, h, c, a = 1, r = 0) => { for (let y = y0; y < y0 + h; y++) for (let x = x0; x < x0 + w; x++) { if (r) { const dx = Math.min(x - x0, x0 + w - 1 - x), dy = Math.min(y - y0, y0 + h - 1 - y); if (dx < r && dy < r && (r - dx) ** 2 + (r - dy) ** 2 > r * r) continue } px(b, x, y, c, a) } }
  const disc = (b, cx, cy, rad, c, a = 1) => { for (let y = cy - rad; y <= cy + rad; y++) for (let x = cx - rad; x <= cx + rad; x++) if ((x - cx) ** 2 + (y - cy) ** 2 <= rad * rad) px(b, x, y, c, a) }
  const nib = (b, cx, top, halfW, hgt, c) => { for (let i = 0; i < hgt; i++) { const w = Math.round(halfW * (1 - i / hgt)); for (let x = cx - w; x <= cx + w; x++) px(b, x, top + i, c, 1) } }

  const expert = mk([26, 38, 62])
  rect(expert, 96, 116, 320, 280, [238, 241, 247], 1, 18)
  rect(expert, 254, 116, 4, 280, [26, 38, 62], 0.85)
  for (let i = 0; i < 5; i++) { rect(expert, 130, 168 + i * 36, 96, 10, [26, 38, 62], 0.30, 5); rect(expert, 286, 168 + i * 36, 96, 10, [26, 38, 62], 0.30, 5) }
  rect(expert, 130, 348, 60, 10, [196, 96, 74], 0.95, 5)
  disc(expert, 400, 112, 26, [196, 96, 74], 1)

  const chief = mk([24, 34, 56])
  rect(chief, 112, 128, 288, 256, [238, 241, 247], 1, 16)
  for (let i = 0; i < 6; i++) rect(chief, 144, 168 + i * 34, 224, 8, [24, 34, 56], 0.28, 4)
  rect(chief, 144, 168, 96, 8, [24, 34, 56], 0.62, 4)
  rect(chief, 144, 270, 150, 8, [196, 96, 74], 0.95, 4)
  disc(chief, 384, 356, 30, [196, 96, 74], 1)
  rect(chief, 371, 354, 12, 22, [238, 241, 247], 1, 3)

  const author = mk([38, 30, 26])
  nib(author, 256, 120, 46, 168, [238, 236, 230])
  rect(author, 252, 240, 8, 40, [238, 236, 230], 1)
  disc(author, 256, 292, 12, [238, 236, 230], 1)
  rect(author, 128, 356, 256, 12, [196, 120, 74], 0.95, 6)
  rect(author, 168, 392, 176, 8, [238, 236, 230], 0.35, 4)

  await write('avatars/expert.png', png(expert))
  await write('avatars/chief-editor.png', png(chief))
  await write('avatars/author.png', png(author))
  say('· 头像：3 件（程序生成 512×512 PNG）')
}

// ── 6b. 内置连接器（vendor/novelist）：专家自带"手" ─────────────────────────
// 为什么必须自带：WorkBuddy 里"连接器（工具）"与"专家（人格）"是两个独立开关，
// 只装专家 = 有嘴没手。专家可以在包内声明 mcpServers 自带 MCP server
// （官方 sheetagent 等就这么做，用 ${CODEBUDDY_PLUGIN_ROOT} 指包内路径）。
// 模板里的 plugin.json 保持机器无关，mcpServers 由本装配器按当机书库根注入。
{
  // 书库根已在第 0a 步校验并解析（bookRoot）——判定前移到任何写盘之前，此处只用不判。
  const pkgJson = JSON.parse(fsSync.readFileSync(path.join(PLUGIN, 'package.json'), 'utf8'))

  const vendorFiles = [
    ['mcp/server.mjs', 'mcp/server.mjs'], ['mcp/handler.mjs', 'mcp/handler.mjs'], ['mcp/fs-adapter.mjs', 'mcp/fs-adapter.mjs'],
    ['lib/novelist.js', 'lib/novelist.js'], ['lib/book-access.mjs', 'lib/book-access.mjs'], ['lib/guide-history.md', 'lib/guide-history.md'],
  ]
  let vn = 0
  for (const [from, to] of vendorFiles) {
    const src = path.join(PLUGIN, from)
    if (!fsSync.existsSync(src)) die('内置连接器缺件：' + src)
    await write('vendor/novelist/' + to, await fsp.readFile(src), src)
    vn++
  }
  if (vn === 0) die('自证失败：内置连接器一件也没装进包')
  // server.mjs 会 require('../package.json') 取版本号——vendor 根必须有一份
  await write('vendor/novelist/package.json', JSON.stringify({
    name: 'novelist-vendor', version: pkgJson.version, private: true, type: 'module',
  }, null, 2) + '\n')
  say('· 内置连接器：vendor/novelist ' + (vn + 1) + ' 件（mcp/ + lib/ + package.json）')

  // 资产也要跟着走：lib/novelist.js 用 import.meta.url 相对解析自己的资产
  // （../craft/author-cards/、../instruments/style-lexicon.json），落位一变就**静默降级**
  // 成提示语（existsSync 失败走 fallback），指南里就出现"与本插件同目录"这种假路径——
  // 写手照着找找不到，L1 词库层与作家卡层直接空转，全程不报错。
  await write('vendor/novelist/instruments/style-lexicon.json', await fsp.readFile(path.join(PLUGIN, 'instruments', 'style-lexicon.json')), path.join(PLUGIN, 'instruments', 'style-lexicon.json'))
  {
    const cards = await fsp.readdir(path.join(PLUGIN, 'craft', 'author-cards'))
    let n = 0
    for (const f of cards) {
      if (!f.endsWith('.md')) continue
      await write('vendor/novelist/craft/author-cards/' + f, await fsp.readFile(path.join(PLUGIN, 'craft', 'author-cards', f)), path.join(PLUGIN, 'craft', 'author-cards', f))
      n++
    }
    if (n === 0) die('自证失败：作家卡一件也没装进 vendor')
    say('· 内置连接器资产：词库 1 件 + 作家卡 ' + n + ' 件（跟着走，否则指南里的路径是假的）')
  }

  const pjPath = path.join(OUT, '.codebuddy-plugin', 'plugin.json')
  const pj = JSON.parse(fsSync.readFileSync(pjPath, 'utf8'))
  // 书库根走 args `--root`（server.mjs 解析顺序：--root → env NOVELIST_ROOT）。
  // 〔2026-09-19 审计 P0-1 修〕此前只写 env：藏在 plugin.json 深处不可见，排查时看起来
  // 像调用方 book_dir 写错；改 args 后一眼可见，env 不再写（根的声明只此一处）。
  pj.mcpServers = {
    novelist: {
      command: 'node',
      args: ['${CODEBUDDY_PLUGIN_ROOT}/vendor/novelist/mcp/server.mjs', '--root', bookRoot],
      defer_loading: true,
    },
  }
  fsSync.writeFileSync(pjPath, JSON.stringify(pj, null, 2) + '\n')
  say('· mcpServers 注入：novelist → 书库根=' + bookRoot)

  // 等价性硬断言：内置连接器吐出的机制手册必须与真源**同文**，且它塞给模型的每条
  // 绝对路径都必须真的在盘上。
  //
  // 为什么不能直接比字符串：手册里内嵌三个"按文件位置解析"的绝对路径（沿革件/作家卡目录/
  // 词库），内置副本与真源在**不同目录**，路径本就不同——第一版断言写成逐字相等，被自己的
  // 守卫抓了个正着。真正的不变量是两条：
  //   ① 去掉绝对路径后逐字相同 → 内容没有漂移；
  //   ② 内置副本给出的每条绝对路径都存在 → 没有静默降级成"（与本插件同目录）"这类假路径。
  // ② 正是 `existsSync` 失败走 fallback 而不报错留下的坑：路径没了，指南照发，写手照着找不到。
  {
    let vendored
    try { vendored = await import(pathToFileURL(path.join(OUT, 'vendor', 'novelist', 'lib', 'novelist.js')).href) }
    catch (e) { die('内置连接器 import 失败：' + e.message) }
    const vt = vendored._internals && vendored._internals.SECTION && vendored._internals.SECTION.text
    if (!vt) die('内置连接器的 SECTION.text 取不到')

    // 路径正则要排除 CJK 与破折号：手册里路径后面常常直接跟中文（"…guide-history.md——只在对…"），
    // 用 [^\s…] 会把整句中文一起当成路径，于是"路径不存在"变成假警报（本断言第二版踩的坑）
    // 2026-09-19：正则移进 `scripts/abs-path.mjs`——它与本文件被抄成两份，且两份都只认
    // Windows 盘符，linux CI 因此整条装配失败（详见该文件头注）。这里只 import，不再自带副本。
    if (stripAbsPaths(vt) !== stripAbsPaths(guideText)) {
      const a = stripAbsPaths(vt), b = stripAbsPaths(guideText)
      const at = [...a].findIndex((c, i) => c !== b[i])
      die('内置连接器的机制手册与真源**内容**不一致（去路径后 ' + a.length + ' vs ' + b.length + ' 字符，首个差异在 ' + at + ' 附近）：\n' +
        '  真源: ' + JSON.stringify(b.slice(Math.max(0, at - 40), at + 60)) + '\n' +
        '  内置: ' + JSON.stringify(a.slice(Math.max(0, at - 40), at + 60)))
    }
    const paths = absPaths(vt)
    if (paths.length < 3) die('自证失败：内置手册里只找到 ' + paths.length + ' 条绝对路径（期望 ≥3：沿革件/作家卡目录/词库）——多半已降级成提示语')
    const missing = paths.filter((p) => !fsSync.existsSync(p))
    if (missing.length) die('内置手册指向的路径不存在（静默降级成假路径，写手照找不到）：\n  ' + missing.join('\n  '),
      '把对应资产也装进 vendor/novelist/（见本脚本"内置连接器资产"一节）')
    // 〔2026-09-20 复核 REC-01〕判据从"在本机存在"加严为"**在包内**"——
    // 存在性只管装配机，跨机器安装时唯一有意义的不变量是"这些路径都在包里"。
    // 比较必须**先归一化**：同一目录可有两种字面（junction `F:\c-moved\…` vs `C:\Users\…`、
    // Windows 8.3 短名）——本仓在 fs 适配层栽过同款，这里是同一族的第三处。
    const canon = (p) => { try { return fsSync.realpathSync.native(p).toLowerCase() } catch { return path.resolve(p).toLowerCase() } }
    const outCanon = canon(OUT)
    const outside = paths.filter((p) => { const a = canon(p); return a !== outCanon && !a.startsWith(outCanon + path.sep) })
    if (outside.length) die('内置手册的绝对路径指向**包外**（换台机器即死路径）：\n  ' + outside.join('\n  '),
      'vendor 资产必须随包（见"内置连接器资产"一节）；包外引用对读者不存在')
    const vtools = (vendored._internals.TOOLS || []).length
    const stools = ((SRC_MOD._internals || {}).TOOLS || []).length
    if (vtools !== stools) die('内置连接器工具数 ' + vtools + ' ≠ 真源 ' + stools)
    say('· 等价性自证：去路径后与真源逐字一致（' + vt.length + ' 字符）· 工具数 ' + vtools + ' · 内嵌绝对路径 ' + paths.length + ' 条全部存在且**全在包内**')
  }
}

// ── 7b. 清理旧版残留（只删"自己上一版清单里写过、本版不再产出"的文件） ───────
// 不做全目录清理：目标目录在 WorkBuddy 手里，删不属于本装配器的东西风险太大。
// **顺序**：本段不读刚写的清单（用的是脚本启动时读的 prevFiles），故可留在改写之前。
if (argv.includes('--prune')) {
  if (!prevFiles) say('· 清理：无上一版清单，跳过')
  else {
    const stale = prevFiles.filter((r) => r !== 'MANIFEST.sha256' && !written.includes(r))
    for (const r of stale) { await fsp.rm(path.join(OUT, r), { force: true }); console.log('  - 清理残留 ' + r) }
    say('· 清理：上一版残留 ' + stale.length + ' 件')
  }
}

// ── 7c2. 装配期引用改写：把"源坐标"的引用改写成"包坐标" ──────────────────────
// 2026-09-18 修 guide 文件名时只治了那一个点；09-19 加上面那条自证才看见全貌：
// **装配产物里 50 条引用按仓库视角写**（`dsh-native/plugin-novelist/instruments/x.mjs`），
// 而包里那些文件在 `scripts/`；`skills/blind-read/SKILL.md` 指着
// `dsh-native/plugin-novelist/wb-expert-starter/references/roles/reader.md`，
// 而包里就在它旁边 `references/roles/reader.md`。**读者点进去全是空的，而没有任何东西会报。**
//
// 改写用的是**源→包映射**，不是猜：引用能解析到某个已装配的源文件，就换成它在包内的位置；
// 解析不到的**一律不动**，交给下面 7d 报出来逼人给类型（猜错比不猜坏）。
{
  const TICK = /`([^`\n]{2,140}?)`/g
  const ANYFILE = /\.(md|mjs|js|json|yml|yaml|txt|jsonl|csv)$/i
  const MARK = /^〔(已撤|模板|示例|私有|仓外|包内)〕/
  const TYPED = /^(https?:|mailto:|~\/|[A-Za-z]:[\\/]|\/|<)/
  const PLACEHOLDER = /(YYYY|MM-DD|NN|XXX|卷N|第N|模型名_轮次|issue-NNN|弧X-弧Y|卷X-弧Y)/
  const BOOK_FILES = new Set(['project.json', 'timeline.json', 'events.jsonl', 'events-tape.jsonl', 'bible.json',
    'characters.json', 'foreshadows.json', 'status.json', 'scores.jsonl', 'outline.json', 'arcs.jsonl'])
  const srcToOut = new Map()
  for (const [outRel, srcAbs] of srcOf) if (!srcToOut.has(srcAbs)) srcToOut.set(srcAbs, outRel)
  // 引用可能写成三种坐标，逐条试（**不猜顺序**：能解到哪个就是哪个）：
  //   ① 文件自身所在源目录（相对写法）
  //   ② 插件仓根 / monorepo 根
  //   ③ **monorepo 前缀剥掉后的子仓坐标**——〔2026-09-19 对抗复核补〕
  //      公开仓直接克隆（flat）时 PLUGIN == ROOT，`dsh-native/` 这个前缀根本不存在，
  //      于是 `skills/blind-read/SKILL.md` 里那 5 条 `dsh-native/plugin-novelist/wb-expert-starter/…`
  //      一条都改不动、全被判死，**公开仓"克隆后跑一次"这条路直接 exit 2**。
  const ROOTS = [PLUGIN, ROOT]
  const stripPrefix = (t) => { const m = t.match(/^dsh-native\/[^/]+\/(.+)$/); return m ? m[1] : null }
  const resolveSrc = (t, ownSrcDir) => {
    const cands = [t]
    const sp = stripPrefix(t)
    if (sp) cands.push(sp)
    for (const base of [ownSrcDir, ...ROOTS]) {
      for (const c of cands) {
        const p = path.resolve(base, c)
        if (srcToOut.has(p)) return srcToOut.get(p)
      }
    }
    return null
  }
  let subs = 0, typed = 0
  for (const outRel of written.filter((r) => r.endsWith('.md'))) {
    const outAbs = path.join(OUT, outRel)
    const srcAbs = srcOf.get(outRel)
    const ownSrcDir = srcAbs ? path.dirname(srcAbs) : path.dirname(outAbs)
    const text = fsSync.readFileSync(outAbs, 'utf8')
    let changed = false
    const next = text.split('\n').map((line) => line.replace(TICK, (whole, raw, off, str) => {
      const t = raw.trim()
      if (!ANYFILE.test(t)) return whole
      if (/[\s>|，。；：]/.test(t)) return whole
      if (/^\.[a-z]+$/i.test(t)) return whole
      if (TYPED.test(t) || PLACEHOLDER.test(t)) return whole
      // 书工程内的相对路径（`status.json`、`editorial/arcs.jsonl`）：包外，属"这本书的目录"，
      // 给符号基底而不是当成包内路径——否则读者会以为包里有这么个文件。
      if (BOOK_FILES.has(t) || /^(editorial|manuscript|versions|\.drafts)\//.test(t)) {
        changed = true; typed++; return '`<book_dir>/' + t + '`'
      }
      const mapped = resolveSrc(t, ownSrcDir)
      // skill 内引用按 **skill 自身目录** 解析（WB 宿主加载 skill 的语义基准，2026-09-19
      // 审计 P0-2 实测 20/20 断链）——包根相对写法在包根下存在、运行时点进去全是空的。
      // 只要目标解析得到（无论 ref 写的是源坐标还是已与包坐标同形），一律改成 skill 相对
      // （../../references/...），包根与 skill 两种基准下都成立。
      if (outRel.startsWith('skills/') && mapped) {
        changed = true; subs++
        let relp = path.posix.relative(path.posix.dirname(outRel), mapped)
        if (!relp.startsWith('.')) relp = './' + relp
        return '`' + relp + '`'
      }
      if (mapped && mapped !== t) { changed = true; subs++; return '`' + mapped + '`' }
      if (mapped) return whole                       // 已在包内同位置，不动（agent 等包根基准件）
      // skill 内引用补改写（不走 srcToOut 映射的那批，如 `references/protocols/*.md`——
      // 协议源在 preset-starter/protocols/，引用却写成包根坐标）：包根下存在、skill 目录
      // 下不存在的 → 改写成 skill 相对。包根坐标在 WB 运行时同样全是死链。
      if (outRel.startsWith('skills/') && !TYPED.test(t)) {
        const ownOutDir = path.posix.dirname(outRel)
        if (fsSync.existsSync(path.join(OUT, t)) && !fsSync.existsSync(path.join(OUT, ownOutDir, t))) {
          let relp = path.posix.relative(ownOutDir, t)
          if (!relp.startsWith('.')) relp = './' + relp
          changed = true; subs++
          return '`' + relp + '`'
        }
      }
      // 源仓里解得到、但**没有进包**（如 `preset-starter/agent.cordis.yml`、装配器自身）：
      // 对**包的读者**而言它在包外。这里给包副本补类型，源件保持仓根相对的干净写法——
      // 两边各自正确，源件那份检查也不丢。解都解不到的**不动**，交给 7d 报出来逼人判。
      const inRepo = ROOTS.some((b) => fsSync.existsSync(path.resolve(b, t)) || (stripPrefix(t) && fsSync.existsSync(path.resolve(b, stripPrefix(t)))))
      // 已有类型标记的（〔私有〕/〔模板〕…）不再叠〔仓外〕——否则 mono/flat 两种根解析下
      // 一个叠一个不叠，同一份源装出两种字节（2026-09-19 实测：WB 门禁首跑红就是它）
      if (inRepo && str.slice(off + whole.length, off + whole.length + 1) !== '〔') { changed = true; typed++; return whole + '〔仓外〕' }
      return whole
    })).join('\n')
    if (changed) await fsp.writeFile(outAbs, next)
  }
  say('· 包内引用改写：' + subs + ' 条源坐标 → 包坐标 · ' + typed + ' 条只存在于源仓 → 包副本补 〔仓外〕')

  // ── 7c2b. 命令行形态：`node <路径>.mjs …` 里的**路径 token** 单独改写 ──────────
  // 为什么另开一条通道：上面的判定以"反引号整段就是一个路径"为前提，**含空格即整条跳过**——
  // 而读者真正会照抄的恰恰是命令。2026-09-20 第三方复核实测：`node instruments/batch-aggregate.mjs`
  // 等命令行照抄即 MODULE_NOT_FOUND，且 7d 与 selfcheck 同源跳过、双双报绿（盲区是镜像的）。
  {
    const CMD = /(\bnode\s+)([^\s`"'<>|]+\.(?:mjs|js))/g
    let csubs = 0
    const cmdTargets = []
    for (const outRel of written.filter((r) => r.endsWith('.md'))) {
      const outAbs = path.join(OUT, outRel)
      const srcAbs = srcOf.get(outRel)
      const ownSrcDir = srcAbs ? path.dirname(srcAbs) : path.dirname(outAbs)
      const text = fsSync.readFileSync(outAbs, 'utf8')
      const next = text.split('\n').map((line) => line.replace(CMD, (whole, pre, t) => {
        if (TYPED.test(t) || PLACEHOLDER.test(t)) return whole
        const mapped = resolveSrc(t, ownSrcDir)
        const target = mapped || (fsSync.existsSync(path.join(OUT, t)) ? t : null)
        if (!target) { cmdTargets.push({ rel: outRel, t, mapped: null }); return whole }
        let out = target
        if (outRel.startsWith('skills/')) {
          let relp = path.posix.relative(path.posix.dirname(outRel), target)
          if (!relp.startsWith('.')) relp = './' + relp
          out = relp
        }
        if (out === t) return whole
        csubs++
        return pre + out
      })).join('\n')
      if (next !== text) await fsp.writeFile(outAbs, next)
    }
    say('· 命令行改写：' + csubs + ' 处 node <路径> → 包坐标' + (cmdTargets.length ? ' · ' + cmdTargets.length + ' 处解析不到（交给 7d 核算）' : ''))
  }
}

// ── 7d. 包内引用自证：模板里的反引号路径，在**装出来的包**里必须真的存在 ──────
// `wb-expert-starter/README.md` 声明 `包内` 时说"该由装配器的自检去验（它已经在验）"——
// 2026-09-19 自查发现**当时没有任何一处真在验**：selfcheck 只核 plugin.json 声明的路径，
// 本脚本的 --check 只比哈希。那句话是"把没查写成验过了"的文案版，现在把它变成真的。
// 规则与私有仓 `docs/引用文法.md` 同源：有类型的不查，判不出的报出来。
{
  const TICK = /`([^`\n]{2,140}?)`/g
  const ANYFILE = /\.(md|mjs|js|json|yml|yaml|txt|jsonl|csv)$/i
  const MARK = /^〔(已撤|模板|示例|私有|仓外|包内)〕/
  const TYPED = /^(https?:|mailto:|~\/|[A-Za-z]:[\\/]|\/|<)/
  const PLACEHOLDER = /(YYYY|MM-DD|NN|XXX|卷N|第N|模型名_轮次|issue-NNN|弧X-弧Y|卷X-弧Y)/
  const mdFiles = written.filter((r) => r.endsWith('.md'))
  let refs = 0, checked = 0
  const dead = []
  // 跳过理由逐类计数（2026-09-20 第三方复核 REC-08）：静默跳过不可接受——
  // 报"44/44 绿"却不告诉人它没检查什么，读者会当成全覆盖（而命令行走的正是跳过那条路）。
  const skipped = { 含空格: 0, 类型化: 0, 已标记: 0, 非文件: 0, 扩展名: 0 }
  for (const r of mdFiles) {
    const abs = path.join(OUT, r)
    const own = path.dirname(abs)
    fsSync.readFileSync(abs, 'utf8').split(/\r?\n/).forEach((line, i) => {
      for (const m of line.matchAll(TICK)) {
        const t = m[1].trim()
        if (!ANYFILE.test(t)) { skipped.非文件++; continue }
        if (/[\s>|，。；：]/.test(t)) { skipped.含空格++; continue }   // 命令行/表格/句子片段（命令行另有专道，见下）
        if (/^\.[a-z]+$/i.test(t)) { skipped.扩展名++; continue }    // 光秃秃的扩展名＝在说"文件后缀"
        if (TYPED.test(t) || PLACEHOLDER.test(t)) { skipped.类型化++; continue }
        const after = line.slice(m.index + m[0].length, m.index + m[0].length + 6)
        if (MARK.test(after)) { skipped.已标记++; continue }
        refs++
        if (fsSync.existsSync(path.join(OUT, t)) || fsSync.existsSync(path.join(own, t))) { checked++; continue }
        dead.push(r + ':' + (i + 1) + '  ' + t)
      }
    })
  }
  if (mdFiles.length === 0) die('自证失败：装配产物里 0 个 .md——包内引用检查扫了个空')
  // 〔2026-09-19 对抗复核补〕**0 条引用也是失败**：本仓元纪律"空集不等于干净"。
  // 此前只挡了"0 个 md"，把规则写坏到 0 条匹配时会打印"0/0 条解析得到"并放行。
  if (refs === 0) die('自证失败：包内引用自证扫到 0 条引用（' + mdFiles.length + ' 个 md）——模式失配还是正则写坏？0 条不等于没问题')

  // ── 命令行形态：`node <路径>.mjs` 的路径必须可达（2026-09-20 复核 ISS-02）
  // 与 7c2b 同源但独立核验：只信改写结果，不复用它的判定，免得同一个 bug 两边一起绿。
  {
    const CMD = /(\bnode\s+)([^\s`"'<>|]+\.(?:mjs|js))/g
    let crefs = 0, cok = 0
    const cdead = []
    for (const r of mdFiles) {
      const abs = path.join(OUT, r)
      const own = path.dirname(abs)
      fsSync.readFileSync(abs, 'utf8').split(/\r?\n/).forEach((line, i) => {
        for (const m of line.matchAll(CMD)) {
          const t = m[2]
          if (TYPED.test(t) || PLACEHOLDER.test(t)) continue
          crefs++
          if (fsSync.existsSync(path.join(OUT, t)) || fsSync.existsSync(path.join(own, t))) { cok++; continue }
          cdead.push(r + ':' + (i + 1) + '  ' + t)
        }
      })
    }
    if (crefs === 0) die('自证失败：命令行形态自证扫到 0 条 node <路径> 引用——模式失配？0 条不等于没问题')
    if (cdead.length) {
      die('命令行引用的脚本在包里不存在（照抄即 MODULE_NOT_FOUND）' + cdead.length + ' 处：\n  ' + cdead.slice(0, 15).join('\n  '),
        '命令行形态必须写成包内真实位置（如 scripts/xxx.mjs）；在 skills/ 里用 skill 相对形')
    }
    say('· 命令行自证：' + cok + '/' + crefs + ' 条 node <路径> 可达')
  }

  if (dead.length) {
    die('包内引用解析不到 ' + dead.length + ' 条（引用的位置在包里不存在）：\n  ' + dead.slice(0, 15).join('\n  ') +
      (dead.length > 15 ? '\n  …… 另有 ' + (dead.length - 15) + ' 条' : ''),
      '要么补上那个文件，要么按文法给它一个类型（〔模板〕/〔包内〕/绝对或符号基底）——不要靠"反正没人查"')
  }
  say('· 包内引用自证：' + checked + '/' + refs + ' 条解析得到（' + mdFiles.length + ' 个 md）· 跳过 ' +
    (Object.entries(skipped).filter(([, v]) => v).map(([k, v]) => k + ' ' + v).join('／') || '0') + '（命令行形态另列，不再跳过）')
}

// ── 7d2. 机器路径硬门（2026-09-20 复核 REC-01）：**文档里**零机器绝对路径 ──────
// 判据从"这条路径在装配机上存在"改成"包内文档不该有机器路径"——前者在 A 机器装配、
// B 机器安装时给不出任何保证（2026-09-19 的 P1-4 就是这么漏的：路径确实存在，只是不存在于别人的机器上）。
// 扫描面只收 `.md`（读者照着做的那些）：`.mjs` 里的 `C:/x` 是正则与示例常量（首跑 7 处命中里 6 处是它），
// `.codebuddy-plugin/plugin.json` 的 `--root` 按契约**就该**是本机值——两处都不是"文档在指路"。
// 例外＝行内带类型标记（〔示例〕/〔模板〕/〔仓外〕/〔私有〕：在讲"路径长什么样"，不是指路）。
{
  const MACHINE = /(?:[A-Za-z]:[\\/][^\s`"'）)】」>]*|(?<![\w.@-])\/(?:home|Users)\/[^\s`"'）)】」>]*)/g
  const MARKED = /〔(示例|模板|仓外|已撤|私有)〕/
  let scanned = 0
  const hits = []
  for (const r of written.filter((x) => x.endsWith('.md'))) {
    const lines = fsSync.readFileSync(path.join(OUT, r), 'utf8').split(/\r?\n/)
    lines.forEach((line, i) => {
      scanned++
      if (MARKED.test(line)) return
      for (const m of line.matchAll(MACHINE)) hits.push(r + ':' + (i + 1) + '  ' + m[0])
    })
  }
  if (scanned === 0) die('自证失败：机器路径扫描扫到 0 行')
  if (hits.length) {
    die('包内文档残留机器绝对路径 ' + hits.length + ' 处（换台机器就是死路径——判据是"零机器路径"，不是"在我这存在"）：\n  ' +
      hits.slice(0, 12).join('\n  ') + (hits.length > 12 ? '\n  …… 另有 ' + (hits.length - 12) + ' 处' : ''),
      '改成包内坐标/占位符；确实在讲"路径长什么样"的行，给它一个 〔示例〕 标记')
  }
  say('· 机器路径硬门：' + scanned + ' 行文档零命中（判据＝包内文档零机器路径，不看它在不在本机）')
}

// ── 7e. 清单（供人工核对与二次复算） ────────────────────────────────────────
// 〔2026-09-19 对抗复核修〕**必须在 7c2 之后**：此前它排在改写之前，于是 58 条清单里
// 19 条哈希是**改写前**的字节——清单是"供二次复算"的，复算的人会算出不一致而以为自己错了。
{
  const lines = []
  for (const rel of written.slice().sort()) {
    const buf = await fsp.readFile(path.join(OUT, rel))
    lines.push(sha(buf) + '  ' + rel)
  }
  await fsp.writeFile(path.join(OUT, 'MANIFEST.sha256'), lines.join('\n') + '\n')
  say('· 清单：MANIFEST.sha256（' + lines.length + ' 件）')
}

// ── 7f. 镜像到已安装缓存位（WorkBuddy 装完会拷一份到 plugins/cache/…） ──────
// 市场目录是源、缓存是拷贝：两边不一致 = 跑起来的不是你刚改的那份。
// 这里做**双向核对**（缺的补、多的删、内容不同的覆盖），不做"只补不删"——
// 只补不删正是缓存静默腐烂的方式。
// 〔2026-09-19 对抗复核修〕**必须在 7c2 之后**：此前它排在改写之前，于是
// **镜像里拷到的是改写前的包**（实测 19 个文件与 OUT 不同），而脚本当场打印"逐文件哈希一致"
// ——两个目录确实一致，只不过一致在一份没人要的内容上。WorkBuddy 真正跑的就是这份镜像。
if (opt('--mirror') && !CHECK) {
  const MIR = path.resolve(opt('--mirror'))
  if (!fsSync.existsSync(MIR)) die('镜像目标不存在：' + MIR, '镜像目标必须是已存在的安装目录（不自动创建，避免写错路径凭空造一份）')
  const existing = walk(MIR).map((f) => path.relative(MIR, f).split(path.sep).join('/'))
  let added = 0, updated = 0, removed = 0
  for (const r of existing) {
    if (!written.includes(r) && r !== 'MANIFEST.sha256') { await fsp.rm(path.join(MIR, r), { force: true }); removed++ }
  }
  for (const r of written) {
    const s = path.join(OUT, r), d = path.join(MIR, r)
    const sb = await fsp.readFile(s)
    if (!fsSync.existsSync(d)) { await fsp.mkdir(path.dirname(d), { recursive: true }); await fsp.writeFile(d, sb); added++ }
    else if (sha(await fsp.readFile(d)) !== sha(sb)) { await fsp.writeFile(d, sb); updated++ }
  }
  // 收尾自证：逐文件哈希必须一致
  const after = walk(MIR).map((f) => path.relative(MIR, f).split(path.sep).join('/'))
  const bad = written.filter((r) => sha(fsSync.readFileSync(path.join(MIR, r))) !== sha(fsSync.readFileSync(path.join(OUT, r))))
  const extra = after.filter((r) => !written.includes(r) && r !== 'MANIFEST.sha256')
  if (bad.length || extra.length) die('镜像收尾自证失败：内容不一致 ' + bad.length + ' 件、多出 ' + JSON.stringify(extra))
  say('· 镜像：+' + added + ' ~' + updated + ' -' + removed + ' → ' + MIR + '（逐文件哈希一致）')
}

// ── 8. 收束自证 ─────────────────────────────────────────────────────────────
if (written.length < 30) die('自证失败：只装配了 ' + written.length + ' 件（期望 ≥30）——多半是某一路源没读到')
// 〔2026-09-18 卡去名批〕卡文件名改用风格指纹（不点名、不点作品名），本断言随之更新。
// 别写回作者名：公开包出现真名会被去名纪律与公私边界检查双重拦下。
for (const must of ['agents/chief-editor.md', 'agents/author.md', 'scripts/selfcheck.mjs', 'references/protocols/盲读协议.md', 'craft/author-cards/民俗考据-水怪悬疑.md']) {
  if (!written.includes(must)) die('自证失败：关键件缺失 ' + must)
}

// ── 8b. 作家卡双份必须逐字节相同（2026-09-20 第三方复核 X3 → fail-closed）
// 卡在包内**必须有两份**：`craft/author-cards/`（派工取用、读者照着读的那份）与
// `vendor/novelist/craft/author-cards/`（**连接器运行期资产**——lib/novelist.js 用
// import.meta.url 相对解析它，删了那一路会让手册里的路径静默降级成"与本插件同目录"的假路径，
// 写手照着找不到而全程不报错）。所以合并成一份不是选项。
// 两份都由本脚本从同一源写成，但**7c2 的引用改写是按 .md 逐文件跑的**——"同一源"推不出
// "同一结果"，所以这里在**全部改写之后**逐文件比 sha256，而不是相信构造。
// 放第 8 步而不是第 0 步：断言必须在 7c2 之后才有意义（改写会动这些 .md）。
{
  const rels = written.filter((r) => /^craft\/author-cards\/.+\.md$/.test(r))
  if (!rels.length) die('自证失败：包内 craft/author-cards/ 一件 .md 都没有（卡这一层空转）')
  let same = 0
  for (const r of rels) {
    const a = path.join(OUT, r)
    const b = path.join(OUT, 'vendor', 'novelist', r)
    if (!fsSync.existsSync(b)) die('自证失败：vendor 侧缺作家卡 ' + r + '（连接器运行期解析不到＝卡层静默降级）')
    const [ha, hb] = [sha(await fsp.readFile(a)), sha(await fsp.readFile(b))]
    if (ha !== hb) {
      die('自证失败：作家卡两份不一致——' + r + '（craft ' + ha.slice(0, 12) + ' vs vendor ' + hb.slice(0, 12) + '）',
        '两份由同一源写出，不一致只能来自改写通道；对齐来源后再装配（别手改包内任何一份）')
    }
    same++
  }
  say('· 作家卡双份自证：' + same + ' 件 craft ↔ vendor 逐字节相同')
}
console.log('')
if (CHECK) {
  // 与目标逐文件哈希比对：只报"源已改但包装配没跟上"，不写目标
  const relsOf = (base) => walk(base).map((f) => path.relative(base, f).split(path.sep).join('/')).filter((r) => r !== 'MANIFEST.sha256')
  const want = relsOf(OUT), have = new Set(relsOf(TARGET))
  const missing = want.filter((r) => !have.has(r))
  const extra = [...have].filter((r) => !want.includes(r))
  const differ = want.filter((r) => have.has(r) && sha(fsSync.readFileSync(path.join(OUT, r))) !== sha(fsSync.readFileSync(path.join(TARGET, r))))
  fsSync.rmSync(OUT, { recursive: true, force: true })
  console.log('[build-wb-expert] --check · 比对目标=' + TARGET)
  console.log('  生成 ' + want.length + ' 件 ｜ 目标 ' + have.size + ' 件')
  if (missing.length) console.log('  目标缺少（源有、包没有）：' + missing.slice(0, 8).join(', ') + (missing.length > 8 ? ' 等 ' + missing.length + ' 件' : ''))
  if (extra.length) console.log('  目标多出（包有、源不再产出）：' + extra.slice(0, 8).join(', ') + (extra.length > 8 ? ' 等 ' + extra.length + ' 件' : ''))
  if (differ.length) console.log('  内容不同：' + differ.slice(0, 8).join(', ') + (differ.length > 8 ? ' 等 ' + differ.length + ' 件' : ''))
  const bad = missing.length + extra.length + differ.length
  console.log(bad === 0 ? '✓ 已装配的包与源一致' : '✗ 有差异 ' + bad + ' 件——源改了但包装配没跟上，跑一次不带 --check 的装配')
  process.exit(bad === 0 ? 0 : 1)
}
console.log('[build-wb-expert] ✓ 装配完成 · ' + written.length + ' 件 · out=' + OUT)
process.exit(0)
