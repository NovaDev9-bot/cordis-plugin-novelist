#!/usr/bin/env node
/**
 * selfcheck.mjs —— 专家包自证守卫（零依赖）
 *
 * 用法：node selfcheck.mjs [--root <包根>]
 *
 * 退出码：0=干净 / 1=有 findings / 2=**没检查成**（0 件扫描不算通过）
 *
 * 为什么要有它：包装配是机械活，出错的样子是"文件在、但引用的东西不在"或
 * "路径改了没人发现"。这类错误不会报错，只会让专家安静地缺一块。
 * 所以本守卫**每一条都报扫到了几件**——0 件 = 失败，不是"通过"。
 */
import { readFileSync, existsSync, readdirSync, statSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { spawnSync } from 'node:child_process'

const argv = process.argv.slice(2)
const opt = (n) => { const i = argv.indexOf(n); return i !== -1 ? argv[i + 1] : null }

const here = path.dirname(fileURLToPath(import.meta.url))
const rootRaw = opt('--root') || path.resolve(here, '..')
const root = path.resolve(rootRaw)
if (!existsSync(path.join(root, '.codebuddy-plugin', 'plugin.json'))) {
  console.error('[selfcheck] 无法执行：' + root + ' 下没有 .codebuddy-plugin/plugin.json（根不是专家包根）')
  process.exit(2)
}

const findings = []
const report = []
const say = (s) => { report.push(s); console.log(s) }

const rel = (p) => path.join(root, p)
const listDir = (p) => { try { return readdirSync(rel(p)) } catch { return [] } }
const isFile = (p) => { try { return statSync(rel(p)).isFile() } catch { return false } }

// ── 1. plugin.json ──────────────────────────────────────────────────────────
const pjPath = rel('.codebuddy-plugin/plugin.json')
let pj = null
try { pj = JSON.parse(readFileSync(pjPath, 'utf8')) } catch (e) { findings.push('plugin.json 解析失败：' + e.message) }
if (!pj) { say('✗ plugin.json 不可读，后续检查跳过'); console.error(report.join('\n')); process.exit(2) }
say('· plugin.json 解析通过：name=' + pj.name + ' version=' + pj.version + ' expertType=' + pj.expertType)

// ── 2. 声明路径存在性（自证：声明了几条就必须核几条） ────────────────────────
const declared = []
for (const a of pj.agents || []) declared.push(['agents[]', a])
for (const s of pj.skills || []) declared.push(['skills[]', s])
if (pj.avatar) declared.push(['avatar', pj.avatar])
for (const m of pj.members || []) if (m.avatar) declared.push(['members.' + m.id + '.avatar', m.avatar])
if (declared.length === 0) { console.error('[selfcheck] 自证失败：plugin.json 没有声明任何路径'); process.exit(2) }

let checked = 0, checkedSkills = 0
for (const [where, p] of declared) {
  const target = p.replace(/^\.\//, '')
  if (!existsSync(rel(target))) { findings.push(where + ' 声明的路径不存在：' + p); continue }
  checked++
  if (where === 'skills[]') {
    const skillMd = path.join(target, 'SKILL.md')
    if (!isFile(skillMd)) { findings.push(where + ' ' + p + ' 缺 SKILL.md'); continue }
    checkedSkills++
    const head = readFileSync(rel(skillMd), 'utf8').slice(0, 600)
    const m = head.match(/^---\r?\n([\s\S]*?)\r?\n---/)
    if (!m) { findings.push('SKILL.md 缺 frontmatter：' + skillMd); continue }
    const nm = (m[1].match(/^name:\s*(.+)$/m) || [])[1]
    const want = path.basename(target)
    if (!nm) findings.push('SKILL.md frontmatter 缺 name：' + skillMd)
    else if (nm.trim() !== want) findings.push('SKILL.md name(' + nm.trim() + ') 与目录名(' + want + ') 不一致')
    if (!/^description:/m.test(m[1])) findings.push('SKILL.md frontmatter 缺 description：' + skillMd)
  }
}
say('· 声明路径核验：' + checked + '/' + declared.length + ' 存在（其中 skills ' + checkedSkills + ' 个）')

// ── 3. 团队型一致性 ─────────────────────────────────────────────────────────
if (pj.expertType === 'team') {
  if (!pj.teamInfo) findings.push('expertType=team 但缺 teamInfo')
  else {
    const ids = new Set((pj.members || []).map((m) => m.id))
    if (!ids.has(pj.teamInfo.leadAgent)) findings.push('teamInfo.leadAgent(' + pj.teamInfo.leadAgent + ') 不在 members[] 里')
    for (const m of pj.teamInfo.memberAgents || []) if (!ids.has(m)) findings.push('teamInfo.memberAgents 成员 ' + m + ' 不在 members[] 里')
    for (const m of pj.members || []) if (!isFile('agents/' + m.id + '.md')) findings.push('members[] 的 id ' + m.id + ' 没有对应 agents/' + m.id + '.md')
  }
  if (pj.agentName !== (pj.teamInfo || {}).leadAgent) findings.push('agentName 与 teamInfo.leadAgent 不一致')
}

// ── 3b. 内置连接器（专家自带的"手"） ────────────────────────────────────────
// 只装专家不带连接器 = 有嘴没手。本包若声明 mcpServers，就必须真有那个 server，
// 且其依赖（vendor 根的 package.json —— server.mjs 会 require 它取版本号）必须齐。
{
  const mcp = pj.mcpServers
  if (!mcp || typeof mcp !== 'object' || Object.keys(mcp).length === 0) {
    findings.push('plugin.json 没有 mcpServers：专家不带工具，用户必须另开连接器才有 novel_*（有嘴没手）')
  } else {
    for (const [name, cfg] of Object.entries(mcp)) {
      const paths = [cfg.command, ...(cfg.args || [])].filter((s) => typeof s === 'string')
        .filter((s) => s.includes('PLUGIN_ROOT'))
        .map((s) => s.replace(/\$\{[A-Z_]*PLUGIN_ROOT\}/g, '').replace(/^[/\\]/, ''))
      if (paths.length === 0) { findings.push('mcpServers.' + name + ' 没有任何指向包内的路径（没写 ${...PLUGIN_ROOT}）'); continue }
      for (const p of paths) if (!isFile(p)) findings.push('mcpServers.' + name + ' 指向包内文件但不存在：' + p)
      if (cfg.env && cfg.env.NOVELIST_ROOT && !existsSync(cfg.env.NOVELIST_ROOT)) {
        findings.push('mcpServers.' + name + ' 的 NOVELIST_ROOT 指向不存在的目录：' + cfg.env.NOVELIST_ROOT)
      }
      // 书库根解析（装配器 2026-09-19 起只写 args --root，env 不再写——根的声明只此一处）。
      // 缺根＝server.mjs 启动即退出；根不存在＝所有 book_dir 都会被路径守卫拒。
      const ri = (cfg.args || []).indexOf('--root')
      const bookRootCfg = ri !== -1 && cfg.args[ri + 1] ? cfg.args[ri + 1] : (cfg.env && cfg.env.NOVELIST_ROOT)
      if (!bookRootCfg) findings.push('mcpServers.' + name + ' 没有书库根（args --root 或 env NOVELIST_ROOT）——server.mjs 启动即退出，全部 novel_* 不可用')
      else if (!existsSync(bookRootCfg)) findings.push('mcpServers.' + name + ' 的书库根指向不存在的目录：' + bookRootCfg)
      else say('· 书库根：' + bookRootCfg)
      say('· 内置连接器：' + name + ' → ' + paths.join(', '))
    }
    // 连接器冒烟：按 plugin.json 声明的 command/args **真起一次** server 并走 initialize 握手。
    // 配置烂（路径错/参数错/vendor 缺件）在这里现形——"schema 能加载 + novel_guide 能跑"
    // 不等于"连接器能用"（2026-09-19 审计实测：路径守卫拒掉一切 book_dir 时，前面两样照样正常）。
    for (const [name, cfg] of Object.entries(mcp)) {
      if (cfg.command !== 'node') continue
      const sargs = (cfg.args || []).map((s) => String(s).replace(/\$\{CODEBUDDY_PLUGIN_ROOT\}/g, root))
      const r = spawnSync(process.execPath, sargs, {
        input: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'selfcheck-smoke', version: '0.0.0' } } }) + '\n',
        encoding: 'utf8', timeout: 20000,
      })
      let ok = false, info = ''
      for (const line of String(r.stdout || '').split('\n')) {
        const t = line.trim(); if (!t) continue
        try { const j = JSON.parse(t); if (j.id === 1 && j.result && j.result.serverInfo) { ok = true; info = j.result.serverInfo.name + ' v' + j.result.serverInfo.version; break } } catch { /* 混入的非 JSON 行忽略 */ }
      }
      if (!ok) findings.push('连接器冒烟失败（initialize 无应答）：mcpServers.' + name + ' —— ' + String(r.stderr || '').split('\n')[0] + (r.status == null ? '（超时）' : ''))
      else say('· 连接器冒烟：initialize 应答正常（' + info + '）')
    }
    if (!isFile('vendor/novelist/package.json')) findings.push('缺 vendor/novelist/package.json（server.mjs require 它取版本号，少了会启动即崩）')
    for (const f of ['vendor/novelist/mcp/server.mjs', 'vendor/novelist/lib/novelist.js', 'vendor/novelist/lib/book-access.mjs']) {
      if (!isFile(f)) findings.push('内置连接器缺件：' + f)
    }
  }
}

// ── 4. 关键资产存在性 + 基数自证 ────────────────────────────────────────────
const assets = [
  ['机制手册', () => listDir('references').filter((f) => /^novelist-guide-.*\.md$/.test(f)), 1],
  ['协议模板', () => listDir('references/protocols').filter((f) => f.endsWith('.md')), 5],
  ['派工角色', () => listDir('references/roles').filter((f) => f.endsWith('.md')), 4],
  ['作家卡', () => listDir('craft/author-cards').filter((f) => f.endsWith('.md')), 3],
  ['仪器脚本', () => listDir('scripts').filter((f) => f.endsWith('.mjs')), 4],
  ['技能', () => listDir('skills').filter((d) => isFile(path.join('skills', d, 'SKILL.md'))), 4],
  ['头像', () => listDir('avatars').filter((f) => f.endsWith('.png')), 3],
]
for (const [label, fn, min] of assets) {
  const got = fn()
  if (got.length < min) findings.push('资产不足：' + label + ' 只有 ' + got.length + ' 件（期望 ≥' + min + '）——0 件不等于没问题')
  say('· ' + label + '：' + got.length + ' 件' + (got.length ? '（' + got.slice(0, 3).join('/') + (got.length > 3 ? '…' : '') + '）' : ''))
}

// ── 5. 内容级：机制手册非空且是真中文（防导出截断/乱码） ─────────────────────
{
  const g = listDir('references').filter((f) => /^novelist-guide-.*\.md$/.test(f))
  // 恰好一份：多份＝旧版残留没清（升级/重装没跟上），读者无法知道哪份是现行口径
  // （2026-09-19 审计实测：缓存里 v7.12 与真源 v7.13 并存，人格与 skill 各说各话）
  if (g.length > 1) findings.push('机制手册有 ' + g.length + ' 份（' + g.join('、') + '）——旧版残留没清，"唯一真源"有了两个互斥的化身')
  for (const f of g) {
    const t = readFileSync(rel('references/' + f), 'utf8')
    if (t.length < 8000) findings.push('机制手册疑似截断：' + f + ' 仅 ' + t.length + ' 字符')
    // 中文占比：正文是中文散文， punctuation/markdown 会打断"连续中文"，
    // 故用总量+占比双判（连续 50 字的写法是本守卫第一版写错过的断言）
    const cjk = (t.match(/[\u4e00-\u9fa5]/g) || []).length
    const ratio = cjk / t.length
    if (cjk < 2000) findings.push('机制手册中文字数过少（' + cjk + ' 字，期望 ≥2000）：' + f)
    if (ratio < 0.4) findings.push('机制手册中文占比过低（' + Math.round(ratio * 100) + '%，期望 ≥40%——疑似乱码/编码错）：' + f)
    for (const sentinel of ['章状态机', '事件带']) if (!t.includes(sentinel)) findings.push('机制手册缺哨兵词「' + sentinel + '」：' + f)
  }
  if (g.length) say('· 机制手册哨兵核验：' + g.length + ' 件通过长度/中文占比/哨兵三查')
}

// ── 6. 人格文件：身份首句必须在（防改写/防截断） ─────────────────────────────
{
  const agents = listDir('agents').filter((f) => f.endsWith('.md'))
  let ok = 0
  for (const f of agents) {
    const t = readFileSync(rel('agents/' + f), 'utf8')
    if (t.length < 1500) { findings.push('人格文件过短（疑似截断）：agents/' + f); continue }
    if (!t.includes('【身份】')) { findings.push('人格文件缺【身份】段：agents/' + f); continue }
    ok++
  }
  if (ok === 0) findings.push('自证失败：agents/ 下没有任何一件通过人格核验')
  say('· 人格核验：' + ok + '/' + agents.length + ' 通过')
}

// ── 7. 全包乱码扫描（U+FFFD = 编码事故指纹） ────────────────────────────────
{
  const walk = (d) => readdirSync(rel(d), { withFileTypes: true }).flatMap((e) => e.isDirectory() ? walk(path.join(d, e.name)) : [path.join(d, e.name)])
  let scanned = 0
  for (const f of walk('.')) {
    if (!/\.(md|json|mjs)$/.test(f)) continue
    scanned++
    const t = readFileSync(rel(f), 'utf8')
    if (t.includes('\uFFFD')) findings.push('检测到替换字符 U+FFFD（编码事故）：' + f)
  }
  if (scanned === 0) { console.error('[selfcheck] 自证失败：扫到 0 个文本文件'); process.exit(2) }
  say('· 乱码扫描：' + scanned + ' 个文本文件')
}

// ── 7b. 引用可达性：md 里的反引号包内路径，在**这份包里**必须真的存在 ────────
// 与装配器 7d 同源（那边守装配时刻，这边守**已装状态**——缓存拷贝/手工改动/半截升级
// 都会让"装配时可达"的包在磁盘上烂掉）。skill 内引用按 skill 自身目录解析（宿主语义基准）。
{
  const TICK = /`([^`\n]{2,140}?)`/g
  const ANYFILE = /\.(md|mjs|js|json|yml|yaml|txt|jsonl|csv)$/i
  const MARK = /^〔(已撤|模板|示例|私有|仓外|包内)〕/
  const TYPED = /^(https?:|mailto:|~\/|[A-Za-z]:[\\/]|\/|<|\$\{)/
  const PLACEHOLDER = /(YYYY|MM-DD|NN|XXX|卷N|第N|模型名_轮次|issue-NNN|弧X-弧Y|卷X-弧Y|book_dir)/
  const walkMd = (d) => readdirSync(rel(d), { withFileTypes: true }).flatMap((e) => e.isDirectory() ? walkMd(path.join(d, e.name)) : (e.name.endsWith('.md') ? [path.join(d, e.name)] : []))
  let refs = 0, okRefs = 0
  for (const f of walkMd('.')) {
    const own = path.dirname(rel(f))
    readFileSync(rel(f), 'utf8').split(/\r?\n/).forEach((line, i) => {
      for (const m of line.matchAll(TICK)) {
        const t = m[1].trim()
        if (!ANYFILE.test(t)) continue
        if (/[\s>|，。；：]/.test(t)) continue
        if (/^\.[a-z]+$/i.test(t)) continue
        if (TYPED.test(t) || PLACEHOLDER.test(t)) continue
        if (MARK.test(line.slice(m.index + m[0].length, m.index + m[0].length + 6))) continue
        refs++
        if (existsSync(path.join(root, t)) || existsSync(path.join(own, t))) okRefs++
        else findings.push('引用不可达（包根与文件自身目录都解析不到）：' + f + ':' + (i + 1) + ' → ' + t)
      }
    })
  }
  if (refs === 0) findings.push('自证失败：引用可达性扫到 0 条引用——模式失配还是正则写坏？0 条不等于没问题')
  say('· 引用可达性：' + okRefs + '/' + refs + ' 条解析得到（包根或自身目录基准）')
}

// ── 8. 仪器可跑（语法级） ───────────────────────────────────────────────────
{
  const scripts = listDir('scripts').filter((f) => f.endsWith('.mjs'))
  let pass = 0
  for (const f of scripts) {
    const r = spawnSync(process.execPath, ['--check', rel('scripts/' + f)], { encoding: 'utf8' })
    if (r.status !== 0) findings.push('仪器语法错误：scripts/' + f + ' —— ' + String(r.stderr || '').split('\n')[0])
    else pass++
  }
  if (pass === 0) findings.push('自证失败：scripts/ 下没有一个 .mjs 通过语法检查')
  say('· 仪器语法：' + pass + '/' + scripts.length + ' 通过 node --check')
}

// ── 9. 头像必须是真 PNG ─────────────────────────────────────────────────────
{
  const pngs = listDir('avatars').filter((f) => f.endsWith('.png'))
  for (const f of pngs) {
    const b = readFileSync(rel('avatars/' + f))
    if (b.length < 100 || b.readUInt32BE(0) !== 0x89504e47) findings.push('头像不是有效 PNG：avatars/' + f)
  }
  say('· 头像 PNG 魔数核验：' + pngs.length + ' 件')
}

// ── 收束 ────────────────────────────────────────────────────────────────────
console.log('')
if (findings.length) {
  console.error('[selfcheck] ✗ ' + findings.length + ' 条 findings：')
  findings.forEach((f) => console.error('  - ' + f))
  process.exit(1)
}
console.error('[selfcheck] ✓ 干净 · 包根=' + root)
process.exit(0)
