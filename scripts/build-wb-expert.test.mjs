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
import { stripAbsPaths, absPaths } from './abs-path.mjs'

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

// 装配器的第 0 步会调角色工具面生成器的 --check（fail-closed）。假仓里放一个"永远通过"的
// 桩：本组用例要测的是"源被掏空"，不该被前置检查的缺失抢答——两条都是 exit 2，
// 但报错说的不是同一件事，混在一起就没人再看得懂红的是哪一层。
const stubRoleFaceGenerator = (repo) => {
  // 位置跟 PLUGIN 走：flat 下是仓根，mono 下是 dsh-native/plugin-novelist。
  const base = fsSync.existsSync(path.join(repo, 'dsh-native')) ? path.join(repo, 'dsh-native', 'plugin-novelist') : repo
  const dir = path.join(base, 'roles')
  mkdirSync(dir, { recursive: true })
  writeFileSync(path.join(dir, 'build-tool-face.mjs'), 'process.exit(0)\n')
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
  // 〔2026-09-19 审计 P0-1 修〕书库根走 args `--root`（可见、单一来源）；env 不再写——
  // "两处都写"必然只改一处，没改到的那处就是下一次事故的埋点。
  const ri = cfg.args.indexOf('--root')
  assert.ok(ri !== -1 && cfg.args[ri + 1], '缺 args --root（server 启动硬前置，没有它直接 exit 2）')
  assert.ok(fsSync.existsSync(cfg.args[ri + 1]), '--root 指向的目录不存在：' + cfg.args[ri + 1])
  assert.ok(!cfg.env || !cfg.env.NOVELIST_ROOT, 'env NOVELIST_ROOT 应已移除（根的声明只此一处）')

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
  // 2026-09-19：正则与本装配器共用 `scripts/abs-path.mjs`。此前这里另抄了一份**只认
  // Windows 盘符**的版本，于是 linux CI 上 POSIX 路径剥不掉 → 断言假红（本机 Windows 全绿）。
  // 断言与实现共用一份，才不会一边改一边忘。
  assert.equal(stripAbsPaths(vText), stripAbsPaths(srcText), '内置手册与真源内容不一致')
  const paths = absPaths(vText)
  assert.ok(paths.length >= 3, '内置手册里的绝对路径少于 3 条（多半已降级成提示语）：' + paths.length)
  for (const p of paths) assert.ok(fsSync.existsSync(p), '内置手册指向的路径不存在（假路径）：' + p)
})

test('机制手册：文件名去版本号，版本以首行与 GUIDE_VERSION 为准（2026-09-20 REC-07）', () => {
  const out = path.join(tmp('nf-wb-'), 'plugins', 'novel-forge-editorial')
  build(out)
  const guides = readdirSync(path.join(out, 'references')).filter((f) => /^novelist-guide.*\.md$/.test(f))
  assert.deepEqual(guides, ['novelist-guide.md'], '机制手册应是唯一一份 novelist-guide.md（带版本号的旧形态会导致每版升版都要全包对齐引用），实得 ' + JSON.stringify(guides))
  const text = readFileSync(path.join(out, 'references', guides[0]), 'utf8')
  assert.ok(text.length > 8000, '手册疑似截断：' + text.length)
  for (const s of ['章状态机', '事件带']) assert.ok(text.includes(s), '手册缺哨兵词：' + s)

  // 版本真值：源里 GUIDE_VERSION 常量；首行必须标同一个版本（文件名不再承载版本信息）
  const src = readFileSync(path.join(REPO_ROOT, 'lib', 'novelist.js'), 'utf8')
  const liveV = (src.match(/GUIDE_VERSION\s*=\s*'([^']+)'/) || [])[1]
  assert.ok(liveV, '源里读不到 GUIDE_VERSION')
  const headV = (text.slice(0, 200).match(/\b(v7\.\d+)\b/) || [])[1]
  assert.equal(headV, liveV, '手册首行版本(' + headV + ') 与 GUIDE_VERSION(' + liveV + ') 不一致')
  // 包内不得再有带版本号的历史形态
  assert.equal(readdirSync(path.join(out, 'references')).filter((f) => /^novelist-guide-v7\.\d+\.md$/.test(f)).length, 0, '包内出现带版本号的手册（旧形态残留）')
})

test('skill 内引用按 **skill 自身目录**解析可达（2026-09-19 审计 P0-2：宿主基准=skill 目录）', () => {
  const out = path.join(tmp('nf-wb-'), 'plugins', 'novel-forge-editorial')
  build(out)
  const skillsDir = path.join(out, 'skills')
  const PLACEHOLDER = /(YYYY|MM-DD|NN|XXX|卷N|第N|模型名_轮次|issue-NNN|弧X-弧Y|卷X-弧Y)/
  let refs = 0
  for (const s of readdirSync(skillsDir)) {
    const base = path.join(skillsDir, s)
    const md = readFileSync(path.join(base, 'SKILL.md'), 'utf8')
    for (const m of md.matchAll(/`([^`\n]{2,140}?)`/g)) {
      const t = m[1].trim()
      if (!/\.(md|mjs|json)$/i.test(t)) continue
      if (/^(https?:|mailto:|~\/|[A-Za-z]:[\\/]|\/|<|\$\{)/.test(t)) continue
      if (/[\s>|，。；：]/.test(t)) continue
      if (PLACEHOLDER.test(t)) continue                  // 书工程内模板坐标（reports/弧审-卷X-弧Y.md 等）
      if (/〔/.test(m[0])) continue                      // 带类型标注的（〔模板〕/〔包内〕等）不查
      refs++
      assert.ok(fsSync.existsSync(path.join(base, t)), 'skill 内引用按 skill 目录解析不到（运行时就是死链）：' + s + ' → ' + t)
    }
  }
  assert.ok(refs >= 5, 'skill 引用条数异常少（模式失配？）：' + refs)
})

test('静态机制手册零机器绝对路径，且包内坐标真实存在（2026-09-19 审计 P1-4）', () => {
  const out = path.join(tmp('nf-wb-'), 'plugins', 'novel-forge-editorial')
  build(out)
  const guides = readdirSync(path.join(out, 'references')).filter((f) => /^novelist-guide/.test(f))
  const text = readFileSync(path.join(out, 'references', guides[0]), 'utf8')
  // "机器路径"＝盘符/家目录形状；`/editorial/...` 这类是 <book_dir>/ 坐标（abs-path 正则
  // 会把反引号里的 `…>/editorial/arcs.jsonl` 误配成 POSIX 绝对路径），不算机器路径
  const machine = absPaths(text).filter((p) => /^[A-Za-z]:[\\/]/.test(p) || /^\/(home|Users)\//.test(p))
  assert.equal(machine.length, 0, '静态手册残留机器绝对路径（离线兜底那份谁也读不到）：' + JSON.stringify(machine))
  // 改写目标不是"更漂亮的死路径"——包内坐标必须真实存在
  for (const p of ['vendor/novelist/lib/guide-history.md', 'vendor/novelist/craft/author-cards', 'vendor/novelist/instruments/style-lexicon.json']) {
    assert.ok(fsSync.existsSync(path.join(out, p)), '手册改写后的包内坐标不存在：' + p)
  }
})

test('命令行引用改写：`node instruments/x.mjs` → 包内 scripts/（2026-09-20 复核 ISS-01 的回归）', () => {
  const out = path.join(tmp('nf-wb-'), 'plugins', 'novel-forge-editorial')
  build(out)
  // 两条真源文档里的命令行必须指向包内真实位置（旧包 4 处的形态＝裸 instruments/，照抄即崩）
  const t = readFileSync(path.join(out, 'references/protocols', '批审协议.md'), 'utf8')
  assert.match(t, /node scripts\/batch-aggregate\.mjs/, '命令行未被改写到包内 scripts/')
  assert.doesNotMatch(t, /node instruments\//, '包内文档残留裸 instruments/ 命令行（照抄即 MODULE_NOT_FOUND）')
  const card = readFileSync(path.join(out, 'craft/author-cards', '_使用说明.md'), 'utf8')
  assert.doesNotMatch(card, /node instruments\//, '作家卡使用说明残留裸 instruments/ 命令行')
  assert.match(card, /node scripts\/build-author-card\.mjs/, '使用说明的命令行应指向包内 scripts/')
})

test('断链命令行必须让装配红（自证的覆盖面回归——此前含空格整条跳过）', () => {
  const out = path.join(tmp('nf-wb-'), 'plugins', 'novel-forge-editorial')
  build(out)
  // 往已装配包里塞一条指向不存在脚本的命令行，再用 selfcheck（已装状态守卫）复检：必须红
  const target = path.join(out, 'references', 'protocols', '批审协议.md')
  writeFileSync(target, readFileSync(target, 'utf8') + '\n参考：`node instruments/no-such-tool.mjs`\n')
  const r = spawnSync(process.execPath, [path.join(out, 'scripts', 'selfcheck.mjs')], { encoding: 'utf8' })
  assert.equal(r.status, 1, 'selfcheck 应报红（exit 1），实得 ' + r.status + '；输出：' + (r.stdout || '').slice(-400))
  assert.match(String(r.stdout) + String(r.stderr), /no-such-tool\.mjs/, '报错要点名那条断链命令')
})

test('角色工具面随包发布，且装配时与能力表核对（fail-closed）', () => {
  const out = path.join(tmp('nf-wb-'), 'plugins', 'novel-forge-editorial')
  build(out)
  const doc = path.join(out, 'references', '宿主工具面.md')
  assert.ok(fsSync.existsSync(doc), '包内缺宿主工具面文档（角色工具面的声明面）')
  const text = readFileSync(doc, 'utf8')
  // 盲角色的扇出/工具发现必须写进随包声明——2026-09-20 Owner 批① 的 WB 侧落点
  for (const s of ['Agent', 'ToolSearch', 'DeferExecuteTool', '试读员', 'disallowedTools']) {
    assert.ok(text.includes(s), '宿主工具面文档缺关键内容：' + s)
  }
  // 反向：装配前会调生成器的 --check，派生件过期必须装配失败（不是装完再报）
  const preset = path.join(REPO_ROOT, 'preset-starter', 'agent.cordis.yml')
  const orig = readFileSync(preset, 'utf8')
  try {
    writeFileSync(preset, orig.replace(/^(\s*deny: \[)(.*?)(\])$/m, '$1$2, ghost_tool$3'))
    const r = run(['--out', path.join(tmp('nf-wb-'), 'plugins', 'x')])
    assert.equal(r.status, 2, '派生件与能力表不一致时装配必须失败，实得 ' + r.status + '：' + r.stdout + r.stderr)
    assert.match(String(r.stderr), /角色工具面|不一致/, '报错要说清是角色工具面的问题')
  } finally {
    writeFileSync(preset, orig)     // 无论断言成败都还原，别把坏文件留在树上
  }
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

test('自证：仓库根找不到 / 源为空 时必须 exit 2，不许假装成功', () => {  const empty = tmp('nf-empty-')
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
      stubRoleFaceGenerator(d)
    }],
    ['mono', (d) => {
      mkdirSync(path.join(d, 'dsh-native', 'vault'), { recursive: true })
      mkdirSync(path.join(d, 'vault'), { recursive: true })
      mkdirSync(path.join(d, 'dsh-native', 'plugin-novelist', 'wb-expert-starter'), { recursive: true })
      stubRoleFaceGenerator(d)
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

test('路径识别必须跨平台：POSIX 绝对路径同样要剥掉（linux CI 假红的根因）', () => {
  // 锁住 2026-09-19 的病：正则只认 Windows 盘符（`C:\…`），于是 linux CI 上
  // `/home/runner/…` 剥不掉 → "去路径后逐字一致"永远不成立 → 装配器 die → 四条回归全灭。
  // 本机 Windows 全绿，谁都看不出来；只有 CI 换平台才暴露。
  assert.equal(stripAbsPaths('/home/runner/work/x/y.md'), '<PATH>')
  assert.equal(stripAbsPaths('C:\\Users\\a\\b.md'), '<PATH>')
  assert.equal(stripAbsPaths('C:/Users/a/b.md'), '<PATH>')
  // 相对写法不许被当成绝对路径（误报会把"路径不存在"变成噪音）
  for (const rel of ['editorial/protocols/盲读协议.md', 'dsh-native/plugin-novelist/lib/novelist.js', 'A/B 两种给法']) {
    assert.equal(stripAbsPaths(rel), rel, '相对写法被误判成绝对路径：' + rel)
  }
  assert.equal(absPaths('/a/b/c.md').length, 1)
  assert.equal(absPaths('见 /a/b 与 /a/b').length, 1, '同一路径应去重')
})
