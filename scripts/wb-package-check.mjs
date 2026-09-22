#!/usr/bin/env node
/**
 * wb-package-check.mjs —— WB 专家包一致性独立入口（只读比对，零写盘）
 *
 * 用法：
 *   node scripts/wb-package-check.mjs                        # 默认比对本机已装的市场目录
 *   node scripts/wb-package-check.mjs --package <专家包目录>
 *   node scripts/wb-package-check.mjs --package <目录> --root <仓根> [--book-root <书库根>]
 *   npm run check:wb-package
 *
 * 为什么要有它（2026-09-20 第三方复核 ISS-07）：门禁此前只活在 `check-all` 的第 11 步里，
 * 而 check-all 在没有装 WB 包的机器上**显式跳过**——第三方拿不到独立复跑入口，
 * "门禁只有自己能跑"等于没有外部监督。
 *
 * 它做什么：把"市场目录里的装配产物"与"当前真源的现装结果"逐文件哈希比对。
 * 书库根**从已装 plugin.json 自提取**——装配器 --check 也要传 --book-root，传错根会假红
 * （plugin.json 是被比对的件之一，里面就写着根）。
 *
 * 退出码：0=一致 / 1=有差异 / 2=**没检查成**（包不存在、plugin.json 解析不出根、装配器自身失败）
 * —— 2 不是 0：没检查成不许报成通过。
 */
import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { existsSync, readFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const argv = process.argv.slice(2)
const opt = (n) => { const i = argv.indexOf(n); return i !== -1 ? argv[i + 1] : null }
const HERE = path.dirname(fileURLToPath(import.meta.url))

function die(msg, hint) {
  console.error('[wb-package-check] 没检查成：' + msg + (hint ? '\n  提示：' + hint : ''))
  process.exit(2)
}

// 仓根：默认从本脚本位置往上找（scripts/ 的上一级＝插件仓；插件仓的上一级可能是 monorepo）
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
if (!ROOT || !existsSync(path.join(ROOT, 'scripts', 'build-wb-expert.mjs'))) {
  die('找不到插件仓根（含 scripts/build-wb-expert.mjs 的那一层）',
    '用 --root <插件仓根> 或环境变量 NF_REPO_ROOT 指定')
}

const PKG = path.resolve(opt('--package') || path.join(
  process.env.USERPROFILE || process.env.HOME || '', '.workbuddy', 'plugins', 'marketplaces', 'my-experts', 'plugins', 'novel-forge-editorial'))
const pjPath = path.join(PKG, '.codebuddy-plugin', 'plugin.json')
if (!existsSync(pjPath)) {
  die('专家包不存在或缺 plugin.json：' + PKG,
    '默认路径针对本机 my-experts 市场；别的机器/别的市场用 --package <目录> 指定')
}

// ── --entries：两份连接器入口的一致性（X2 · 2026-09-22）─────────────────────
// 同名两处：①包内 `vendor/novelist/mcp/server.mjs`（跟着包走，对外唯一那份）；
// ②用户级 <用户目录>/.workbuddy/mcp.json 的 novelist（**本机生效**的那份——同名时用户级胜出）。
// 两处都在时，它们指向的连接器文件必须**逐字节相同**：不同＝本机跑的和对外发的不是同一份代码，
// 而这种漂移在两边都不报错（本机永远绿、拿到包的人是旧的）。加这条正是为了让它会报。
if (argv.includes('--entries')) {
  const sha = (p) => createHash('sha256').update(readFileSync(p)).digest('hex')
  const readEntry = (p, label) => {
    if (!existsSync(p)) return null
    let j
    try { j = JSON.parse(readFileSync(p, 'utf8')) } catch (e) { die(label + ' 解析失败：' + p + '：' + e.message) }
    const cfg = (j.mcpServers || j.mcp_servers || {}).novelist
    if (!cfg || !Array.isArray(cfg.args)) die(label + ' 里没有可解析的 novelist 入口：' + p)
    const file = path.resolve(String(cfg.args[0]).replace('${CODEBUDDY_PLUGIN_ROOT}', PKG))
    const i = cfg.args.indexOf('--root')
    return { path: p, file, root: i !== -1 ? cfg.args[i + 1] : (cfg.env && cfg.env.NOVELIST_ROOT) || null }
  }
  const pkgEntry = readEntry(pjPath, '包内 plugin.json')
  const userEntry = readEntry(path.resolve(opt('--user-mcp') || path.join(
    process.env.USERPROFILE || process.env.HOME || '', '.workbuddy', 'mcp.json')), '用户级 mcp.json')
  const list = [['包内', pkgEntry], ['用户级', userEntry]].filter(([, e]) => e)
  if (list.length === 0) die('两处入口都没解析出来（包内 ' + pjPath + '）')
  for (const [label, e] of list) console.log('[entries] ' + label + ' → ' + e.file + '（书库根 ' + e.root + '）')
  if (list.length === 1) {
    // 只有一份＝判据（"两份若都在则必须相同"）在此处空成立——**明写出来**，不当成"查过了"
    console.log('[entries] 本机只有一份入口（另一处不存在）：判据在本机为空，未做比对（登记，不并入"已核"）')
    process.exit(0)
  }
  for (const [, e] of list) if (!existsSync(e.file)) die('入口指向的连接器文件不存在：' + e.file)
  const a = sha(pkgEntry.file)
  const b = sha(userEntry.file)
  if (a !== b) {
    console.error('[entries] ✗ 两份入口不是同一份代码：')
    console.error('    包内   ' + a.slice(0, 16) + '  ' + pkgEntry.file)
    console.error('    用户级 ' + b.slice(0, 16) + '  ' + userEntry.file)
    console.error('  含义：本机生效的是**用户级**那份（同名时用户级胜出），对外发出去的是**包内**那份。')
    console.error('  处置：重装配包到最新真源，或把用户级入口指回同一份代码。')
    process.exit(1)
  }
  if (pkgEntry.root !== userEntry.root) {
    console.error('[entries] ✗ 两份入口的书库根不同：包内 ' + pkgEntry.root + ' ／ 用户级 ' + userEntry.root)
    process.exit(1)
  }
  console.log('[entries] ✓ 两份入口逐字节相同（' + a.slice(0, 16) + '）· 书库根一致（' + pkgEntry.root + '）')
  console.log('  生效＝用户级那份；对外唯一＝包内那份。')
  process.exit(0)
}

let bookRoot = opt('--book-root')
if (!bookRoot) {
  let pj
  try { pj = JSON.parse(readFileSync(pjPath, 'utf8')) } catch (e) { die('plugin.json 解析失败：' + e.message) }
  const cfg = pj.mcpServers && pj.mcpServers.novelist
  const i = cfg && Array.isArray(cfg.args) ? cfg.args.indexOf('--root') : -1
  bookRoot = i !== -1 ? cfg.args[i + 1] : (cfg && cfg.env && cfg.env.NOVELIST_ROOT) || null
  if (!bookRoot) die('已装 plugin.json 里解析不出书库根（args --root / env NOVELIST_ROOT 都没有）',
    '用 --book-root <书库根> 显式指定')
  console.log('[wb-package-check] 书库根（从已装 plugin.json 自提取）＝' + bookRoot)
}
if (!existsSync(bookRoot)) die('书库根不存在：' + bookRoot, '换一个已存在的目录（--book-root）')

console.log('[wb-package-check] 包＝' + PKG)
console.log('[wb-package-check] 源＝' + ROOT)
const r = spawnSync(process.execPath, [
  path.join(ROOT, 'scripts', 'build-wb-expert.mjs'), '--check',
  '--root', ROOT, '--out', PKG, '--book-root', bookRoot,
], { encoding: 'utf8', stdio: 'inherit' })
if (r.status === null) die('装配器未能执行（超时或被杀）')
if (r.status === 0) {
  console.log('[wb-package-check] ✓ 已装包与真源一致')
  console.log('  想再核"包自身是否自洽"：node ' + path.join(PKG, 'scripts', 'selfcheck.mjs'))
}
process.exit(r.status === 0 ? 0 : r.status === 1 ? 1 : 2)
