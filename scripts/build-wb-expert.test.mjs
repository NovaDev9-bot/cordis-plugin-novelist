// build-wb-expert.mjs 回归：锁住本装配器踩过的坑，别再踩第二次
//
// 锁的是什么：
//   ① 源扫到 0 件必须 exit 2（"没装成"不许静默返回成功）
//   ② 版本号必须取文中最高的 v7.N（取首个匹配会得到沿革起点 v7.10，文件名就错了）
//   ③ --prune 只删自己上一版清单里的文件，且必须真的删掉
//   ④ 装配产物里机制手册是现导的（长度达标、含哨兵词），不是过期副本
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync, readdirSync } from 'node:fs'
import fsSync from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const SCRIPT = path.join(HERE, 'build-wb-expert.mjs')
// 本仓是**公开单仓**形态：脚本在 scripts/，仓库根＝上一层（插件根＝仓库根）。
// 装配器也认 monorepo 形态（dsh-native/plugin-novelist），那条路径由私有仓的守卫覆盖。
const REPO_ROOT = path.resolve(HERE, '..')

const tmp = (p) => mkdtempSync(path.join(tmpdir(), p))
const walk = (d) => readdirSync(d, { withFileTypes: true }).flatMap((e) => e.isDirectory() ? walk(path.join(d, e.name)) : [path.join(d, e.name)])

// 书库根＝MCP server 的 --root 硬前置，**必须显式给**（它是安全边界，本工具不猜默认值）。
// 所以测试自己造一个临时书库根：测试不该依赖"跑它的这台机器上恰好有哪些目录"，
// 那正是本仓反复吃过的静默降级。
const BOOK_ROOT = path.join(tmp('nf-books-'), 'books')
mkdirSync(BOOK_ROOT, { recursive: true })

// 注意：opt() 取**首个** --root，所以调用方自己给了 --root 时不能再加默认值——
// 本测试第一版就栽在这（默认值在前，测"找不到仓库根"的那条永远测的是真仓库）。
const run = (args) => {
  const argv = args.includes('--root') ? args : ['--root', REPO_ROOT, ...args]
  return spawnSync(process.execPath, [SCRIPT, '--book-root', BOOK_ROOT, ...argv], { encoding: 'utf8' })
}

const build = (dir) => {
  const r = run(['--out', dir])
  assert.equal(r.status, 0, '装配应成功：' + r.stdout + r.stderr)
  return r
}

test('装配：产出 ≥40 件且关键件齐（含派工角色、协议、仪器、头像）', () => {
  const out = path.join(tmp('nf-wb-'), 'plugins', 'novel-forge-editorial')
  build(out)
  const files = walk(out).map((f) => path.relative(out, f).split(path.sep).join('/'))
  assert.ok(files.length >= 40, '件数过少：' + files.length)
  for (const must of [
    '.codebuddy-plugin/plugin.json', 'agents/chief-editor.md', 'agents/author.md',
    'references/roles/reader.md', 'references/roles/calibrator.md', 'references/roles/proofer.md',
    'references/protocols/盲读协议.md', 'scripts/style-check.mjs', 'scripts/style-lexicon.json',
    'scripts/selfcheck.mjs', 'MANIFEST.sha256', 'avatars/expert.png',
  ]) assert.ok(files.includes(must), '缺关键件：' + must)
  // 清单行数 = 清单外文件数（MANIFEST 自己不入清单）
  const manifest = readFileSync(path.join(out, 'MANIFEST.sha256'), 'utf8').trim().split('\n')
  assert.equal(manifest.length, files.filter((f) => f !== 'MANIFEST.sha256').length, '清单与实际产出不匹配')
})

test('专家自带连接器：mcpServers 指向包内 + vendor 资产齐全 + 手册与真源同文', async () => {
  const out = path.join(tmp('nf-wb-'), 'plugins', 'novel-forge-editorial')
  build(out)
  const pj = JSON.parse(readFileSync(path.join(out, '.codebuddy-plugin', 'plugin.json'), 'utf8'))
  assert.ok(pj.mcpServers && pj.mcpServers.novelist, '没声明 mcpServers = 专家只有脑子没有手')

  const cfg = pj.mcpServers.novelist
  const arg = (cfg.args || [])[0] || ''
  assert.match(arg, /\$\{[A-Z_]*PLUGIN_ROOT\}\//, 'server 路径必须走 PLUGIN_ROOT 变量（否则换机即失效）')
  const rel = arg.replace(/^\$\{[A-Z_]*PLUGIN_ROOT\}\//, '')
  assert.ok(fsSync.existsSync(path.join(out, rel)), 'mcpServers 指向的 server 不在包内：' + rel)
  assert.ok(cfg.env && cfg.env.NOVELIST_ROOT, '缺 NOVELIST_ROOT（server 启动硬前置，没有它直接 exit 2）')
  assert.ok(fsSync.existsSync(cfg.env.NOVELIST_ROOT), 'NOVELIST_ROOT 指向的目录不存在：' + cfg.env.NOVELIST_ROOT)

  // server.mjs 会 require('../package.json') 取版本号；少了它启动即崩
  for (const must of [
    'vendor/novelist/mcp/server.mjs', 'vendor/novelist/lib/novelist.js', 'vendor/novelist/lib/book-access.mjs',
    'vendor/novelist/package.json', 'vendor/novelist/instruments/style-lexicon.json',
    // 卡名自 2026-09-18 起用风格指纹（不点名/不点作品名）；本断言随之更新，
    // 别改回作者名——公开包含真名会被边界与去名纪律双重拦下。
    'vendor/novelist/craft/author-cards/民俗考据-水怪悬疑.md',
  ]) assert.ok(fsSync.existsSync(path.join(out, must)), '内置连接器缺件：' + must)

  // 手册同文（去绝对路径后）+ 内嵌路径全部存在 —— 这一条抓的是"资产没跟走 → 静默降级成假路径"
  const srcText = (await import(pathToFileURL(path.join(REPO_ROOT, 'lib', 'novelist.js')).href))._internals.SECTION.text
  const vText = (await import(pathToFileURL(path.join(out, 'vendor/novelist/lib/novelist.js')).href))._internals.SECTION.text
  const PATHPART = '[A-Za-z]:\\\\[^\\s\\u4e00-\\u9fff`）"\'*，。；—、]+'
  const strip = (s) => s.replace(new RegExp(PATHPART, 'g'), '<PATH>')
  assert.equal(strip(vText), strip(srcText), '内置手册与真源内容不一致')
  const paths = [...new Set(vText.match(new RegExp(PATHPART, 'g')) || [])]
  assert.ok(paths.length >= 3, '内置手册里的绝对路径少于 3 条（多半已降级成提示语）：' + paths.length)
  for (const p of paths) assert.ok(fsSync.existsSync(p), '内置手册指向的路径不存在（假路径）：' + p)
})

test('机制手册是现导的，且版本号取文中最高 v7.N（不是沿革起点）', () => {
  const out = path.join(tmp('nf-wb-'), 'plugins', 'novel-forge-editorial')
  build(out)
  const guides = readdirSync(path.join(out, 'references')).filter((f) => /^novelist-guide-v7\.\d+\.md$/.test(f))
  assert.equal(guides.length, 1, '机制手册应恰好一件，实得 ' + JSON.stringify(guides))
  const text = readFileSync(path.join(out, 'references', guides[0]), 'utf8')
  assert.ok(text.length > 8000, '手册疑似截断：' + text.length)
  for (const s of ['章状态机', '事件带']) assert.ok(text.includes(s), '手册缺哨兵词：' + s)

  // 与源真值对齐：lib 的 SECTION 里出现的最大 v7.N
  const src = readFileSync(path.join(REPO_ROOT, 'lib', 'novelist.js'), 'utf8')
  const maxV = 'v7.' + Math.max(...[...src.matchAll(/v7\.(\d+)/g)].map((m) => Number(m[1])))
  assert.equal(guides[0], 'novelist-guide-' + maxV + '.md', '文件名版本号不是文中最高版本（源=' + maxV + '）')
})

test('--prune 只清上一版清单里的残留，且确实清掉', () => {
  const out = path.join(tmp('nf-wb-'), 'plugins', 'novel-forge-editorial')
  build(out)
  // 造一个"上一版写过、本版不再产出"的残留，并登记进清单
  const stale = 'references/roles/zz-stale.md'
  writeFileSync(path.join(out, stale), 'stale\n')
  writeFileSync(path.join(out, 'MANIFEST.sha256'), readFileSync(path.join(out, 'MANIFEST.sha256'), 'utf8') + 'deadbeef  ' + stale + '\n')
  // 另造一个不在清单里的无关文件：不许被动
  writeFileSync(path.join(out, 'NOT-MINE.txt'), 'keep me\n')

  const r = run(['--out', out, '--prune'])
  assert.equal(r.status, 0, r.stdout + r.stderr)
  assert.equal(existsSync(path.join(out, stale)), false, '清单里的残留应被清掉')
  assert.equal(existsSync(path.join(out, 'NOT-MINE.txt')), true, '不在清单里的文件不许动')
})

test('自证：仓库根找不到 / 源为空 时必须 exit 2，不许假装成功', () => {
  const empty = tmp('nf-empty-')
  const r1 = run(['--out', path.join(empty, 'plugins', 'x'), '--root', empty])
  assert.equal(r1.status, 2, '找不到仓库根应 exit 2，实得 ' + r1.status)
  assert.match(r1.stderr, /无法执行/, '应打印中文原因而不是堆栈')

  // 仓库根存在但模板目录被掏空 → 也必须 exit 2（0 件不等于"没有变化"）
  // 两种布局各测一次：装配器自 2026-09-18 起同时认 flat（公开单仓）与 mono（私有仓），
  // 只测一条等于另一条没人管——而它俩的判据（标记目录）正是最容易写歪的地方。
  for (const [label, mk] of [
    ['flat', (d) => {
      mkdirSync(path.join(d, 'wb-expert-starter'), { recursive: true })
      mkdirSync(path.join(d, 'lib'), { recursive: true })
    }],
    ['mono', (d) => {
      mkdirSync(path.join(d, 'dsh-native', 'vault'), { recursive: true })
      mkdirSync(path.join(d, 'vault'), { recursive: true })
      mkdirSync(path.join(d, 'dsh-native', 'plugin-novelist', 'wb-expert-starter'), { recursive: true })
    }],
  ]) {
    const fake = tmp('nf-fake-')
    mk(fake)
    const r2 = run(['--out', path.join(fake, 'plugins', 'x'), '--root', fake])
    assert.equal(r2.status, 2, label + ' 布局下模板为空应 exit 2，实得 ' + r2.status)
    assert.match(r2.stderr, /0 件|是空的/, label + ' 报错要说清是空目录（0 件 ≠ 没有变化）：' + r2.stderr)
    rmSync(fake, { recursive: true, force: true })
  }
})
