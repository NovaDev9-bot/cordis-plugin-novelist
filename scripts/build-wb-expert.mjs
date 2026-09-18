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
import { fileURLToPath, pathToFileURL } from 'node:url'
import { deflateSync } from 'node:zlib'

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
// 上一版清单必须在写入任何文件**之前**读出来——写在后面会被本次覆盖，
// 于是 --prune 永远看到"新清单"，残留一件也清不掉（本装配器第一版就栽在这）。
const prevManifestPath = path.join(OUT, 'MANIFEST.sha256')
const prevFiles = fsSync.existsSync(prevManifestPath)
  ? fsSync.readFileSync(prevManifestPath, 'utf8').split('\n').map((l) => l.trim().split(/\s{2,}/)[1]).filter(Boolean)
  : null
const report = []
const srcOf = new Map()          // outRel → 源绝对路径（引用改写用；生成件不入表）
const say = (s) => { report.push(s); console.log(s); }
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
  await write('references/' + guideName + '-' + ver + '.md', head + guideText + '\n')
  say('· 机制手册：现导 ' + guideText.length + ' 字符（' + ver + '）')
}

// ── 2b. 落盘模板件，并把对 guide 文件名的引用改写成实际生成名 ─────────────────
// 为什么要改写：启动包把版本号**抄了一份**（5 处），而本装配器按 SECTION 里的最高版本**现算**文件名——
// 每次 guide 升版，包内这 5 处路径就静默断一次（2026-09-18 审计实测：包里写 v7.12，实际生成 v7.13，
// 而这两个文件名的差别对读者不可见，只有点进去才发现文件不存在）。
// 抄写这件事本身不该存在：让装配器改写，则"抄的那份"永远不会漂。零命中也要报——静默零命中＝模式失配。
{
  // 匹配两种写法：具体版本（历史遗留）与占位符 `v7.NN`（推荐——占位符永远不会陈旧）
  const GUIDE_REF = /novelist-guide-v7(?:\.\d+|\.NN)\.md/g
  const guideFile = guideName + '-' + guideVer + '.md'
  let subs = 0
  for (const [rel, text] of tplBuf) {
    subs += (text.match(GUIDE_REF) || []).length
    await write(rel, text.replace(GUIDE_REF, guideFile), tplSrc.get(rel))
  }
  if (subs === 0) say('· ⚠ 启动包里 0 处引用 guide 文件名——要么确实不引用了，要么模式已失配（2026-09-18 基线＝5 处）')
  else say('· 启动包 guide 引用改写：' + subs + ' 处 → ' + guideFile)
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
  // 书库根＝MCP server 的 --root 硬前置（所有 book_dir 都圈在它里面）。
  // **必须显式给**：它是安全边界，不是可以猜的默认值——也就不该把任何人的本机目录名写进本仓。
  const bookRaw = opt('--book-root') || process.env.NF_BOOK_ROOT
  if (!bookRaw) {
    die('缺 --book-root <书库目录>',
      '书库根＝你放书稿的目录（MCP server 的 --root 硬前置，所有 book_dir 都圈在它里面）。'
      + '\n  两种给法：①--book-root <目录>  ②环境变量 NF_BOOK_ROOT。'
      + '\n  它是安全边界，所以本工具**不猜默认值**——给一个你自己的目录即可。')
  }
  const bookRoot = path.resolve(bookRaw)
  if (!fsSync.existsSync(bookRoot)) {
    die('书库根不存在：' + bookRoot, '换一个已存在的目录，或先把它建出来。')
  }
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
  pj.mcpServers = {
    novelist: {
      command: 'node',
      args: ['${CODEBUDDY_PLUGIN_ROOT}/vendor/novelist/mcp/server.mjs'],
      env: { NOVELIST_ROOT: bookRoot },
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
    const PATHPART = '[A-Za-z]:\\\\[^\\s\\u4e00-\\u9fff`）"\'*，。；—、]+'
    const strip = (s) => s.replace(new RegExp(PATHPART, 'g'), '<PATH>')
    if (strip(vt) !== strip(guideText)) {
      const a = strip(vt), b = strip(guideText)
      const at = [...a].findIndex((c, i) => c !== b[i])
      die('内置连接器的机制手册与真源**内容**不一致（去路径后 ' + a.length + ' vs ' + b.length + ' 字符，首个差异在 ' + at + ' 附近）：\n' +
        '  真源: ' + JSON.stringify(b.slice(Math.max(0, at - 40), at + 60)) + '\n' +
        '  内置: ' + JSON.stringify(a.slice(Math.max(0, at - 40), at + 60)))
    }
    const paths = [...new Set((vt.match(new RegExp(PATHPART, 'g')) || []))]
    if (paths.length < 3) die('自证失败：内置手册里只找到 ' + paths.length + ' 条绝对路径（期望 ≥3：沿革件/作家卡目录/词库）——多半已降级成提示语')
    const missing = paths.filter((p) => !fsSync.existsSync(p))
    if (missing.length) die('内置手册指向的路径不存在（静默降级成假路径，写手照找不到）：\n  ' + missing.join('\n  '),
      '把对应资产也装进 vendor/novelist/（见本脚本"内置连接器资产"一节）')
    const vtools = (vendored._internals.TOOLS || []).length
    const stools = ((SRC_MOD._internals || {}).TOOLS || []).length
    if (vtools !== stools) die('内置连接器工具数 ' + vtools + ' ≠ 真源 ' + stools)
    say('· 等价性自证：去路径后与真源逐字一致（' + vt.length + ' 字符）· 工具数 ' + vtools + ' · 内嵌绝对路径 ' + paths.length + ' 条全部存在')
  }
}

// ── 7. 清单（供人工核对与二次复算） ────────────────────────────────────────
{
  const lines = []
  for (const rel of written.slice().sort()) {
    const buf = await fsp.readFile(path.join(OUT, rel))
    lines.push(sha(buf) + '  ' + rel)
  }
  await fsp.writeFile(path.join(OUT, 'MANIFEST.sha256'), lines.join('\n') + '\n')
  say('· 清单：MANIFEST.sha256（' + lines.length + ' 件）')
}

// ── 7b. 清理旧版残留（只删"自己上一版清单里写过、本版不再产出"的文件） ───────
// 不做全目录清理：目标目录在 WorkBuddy 手里，删不属于本装配器的东西风险太大。
if (argv.includes('--prune')) {
  if (!prevFiles) say('· 清理：无上一版清单，跳过')
  else {
    const stale = prevFiles.filter((r) => r !== 'MANIFEST.sha256' && !written.includes(r))
    for (const r of stale) { await fsp.rm(path.join(OUT, r), { force: true }); console.log('  - 清理残留 ' + r) }
    say('· 清理：上一版残留 ' + stale.length + ' 件')
  }
}

// ── 7c. 镜像到已安装缓存位（WorkBuddy 装完会拷一份到 plugins/cache/…） ──────
// 市场目录是源、缓存是拷贝：两边不一致 = 跑起来的不是你刚改的那份。
// 这里做**双向核对**（缺的补、多的删、内容不同的覆盖），不做"只补不删"——
// 只补不删正是缓存静默腐烂的方式。
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
  // 引用可能写成"插件仓相对"或"monorepo 根相对"，两个候选都试
  const ROOTS = [PLUGIN, ROOT]
  const resolveSrc = (t, ownSrcDir) => {
    for (const base of [ownSrcDir, ...ROOTS]) {
      const p = path.resolve(base, t)
      if (srcToOut.has(p)) return srcToOut.get(p)
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
    const next = text.split('\n').map((line) => line.replace(TICK, (whole, raw) => {
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
      if (mapped && mapped !== t) { changed = true; subs++; return '`' + mapped + '`' }
      if (mapped) return whole                       // 已在包内同位置，不动
      // 源仓里解得到、但**没有进包**（如 `preset-starter/agent.cordis.yml`、装配器自身）：
      // 对**包的读者**而言它在包外。这里给包副本补类型，源件保持仓根相对的干净写法——
      // 两边各自正确，源件那份检查也不丢。解都解不到的**不动**，交给 7d 报出来逼人判。
      const inRepo = ROOTS.some((b) => fsSync.existsSync(path.resolve(b, t)))
      if (inRepo) { changed = true; typed++; return whole + '〔仓外〕' }
      return whole
    })).join('\n')
    if (changed) await fsp.writeFile(outAbs, next)
  }
  say('· 包内引用改写：' + subs + ' 条源坐标 → 包坐标 · ' + typed + ' 条只存在于源仓 → 包副本补 〔仓外〕')
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
  for (const r of mdFiles) {
    const abs = path.join(OUT, r)
    const own = path.dirname(abs)
    fsSync.readFileSync(abs, 'utf8').split(/\r?\n/).forEach((line, i) => {
      for (const m of line.matchAll(TICK)) {
        const t = m[1].trim()
        if (!ANYFILE.test(t)) continue
        if (/[\s>|，。；：]/.test(t)) continue     // 命令行/表格/句子片段
        if (/^\.[a-z]+$/i.test(t)) continue        // 光秃秃的扩展名＝在说"文件后缀"
        if (TYPED.test(t) || PLACEHOLDER.test(t)) continue
        const after = line.slice(m.index + m[0].length, m.index + m[0].length + 6)
        if (MARK.test(after)) continue
        refs++
        if (fsSync.existsSync(path.join(OUT, t)) || fsSync.existsSync(path.join(own, t))) { checked++; continue }
        dead.push(r + ':' + (i + 1) + '  ' + t)
      }
    })
  }
  if (mdFiles.length === 0) die('自证失败：装配产物里 0 个 .md——包内引用检查扫了个空')
  if (dead.length) {
    die('包内引用解析不到 ' + dead.length + ' 条（引用的位置在包里不存在）：\n  ' + dead.slice(0, 15).join('\n  ') +
      (dead.length > 15 ? '\n  …… 另有 ' + (dead.length - 15) + ' 条' : ''),
      '要么补上那个文件，要么按文法给它一个类型（〔模板〕/〔包内〕/绝对或符号基底）——不要靠"反正没人查"')
  }
  say('· 包内引用自证：' + checked + '/' + refs + ' 条解析得到（' + mdFiles.length + ' 个 md）')
}

// ── 8. 收束自证 ─────────────────────────────────────────────────────────────
if (written.length < 30) die('自证失败：只装配了 ' + written.length + ' 件（期望 ≥30）——多半是某一路源没读到')
// 〔2026-09-18 卡去名批〕卡文件名改用风格指纹（不点名、不点作品名），本断言随之更新。
// 别写回作者名：公开包出现真名会被去名纪律与公私边界检查双重拦下。
for (const must of ['agents/chief-editor.md', 'agents/author.md', 'scripts/selfcheck.mjs', 'references/protocols/盲读协议.md', 'craft/author-cards/民俗考据-水怪悬疑.md']) {
  if (!written.includes(must)) die('自证失败：关键件缺失 ' + must)
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
