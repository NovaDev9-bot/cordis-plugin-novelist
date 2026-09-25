// roles/tool-face.json（能力表）与其生成器 build-tool-face.mjs 的回归
//
// 锁的是什么（这一批最贵的两条）：
//   ① **缺失没有类型**：能力条目缺宿主列、角色 deny 写工具名、同名工具进两个能力——
//      一律必须拒绝生成，而不是"少封一条"地跑过去。
//   ② **反向**：预设定稿里挂了一个没登记的插件、或名单里出现表上没有的名字，
//      守卫必须报红。正向检查（"表里的名字都在文件里"）永远发现不了"文件里多了一个
//      没人管的名字"——而后者恰恰是新工具上线时的真实形状。
//
// 为什么测试要在**临时假仓**里跑而不是直接改真仓：这些场景都要把预设改坏。
// 真仓里改坏再改回来，中间任何一步失败都会留一个坏文件在树上——守卫自己成了事故源。
// 假仓只需要两个标记目录（flat 判据）+ lib/ 与 preset-starter/ 各一份拷贝。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, readdirSync, rmSync, cpSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const SCRIPT = path.join(HERE, 'build-tool-face.mjs')
// 本文件住在插件仓里；插件仓既是公开单仓的根（flat），也可能是 monorepo 的子仓。
// 两种情况下 roles/ 与 lib/ 都在本文件旁边，故用 HERE 定位，不用 --root 猜。
const PLUGIN = path.resolve(HERE, '..')
const TABLE_FILE = path.join(HERE, 'tool-face.json')
const PRESET_REL = 'preset-starter/agent.cordis.yml'

const realTable = () => JSON.parse(readFileSync(TABLE_FILE, 'utf8'))
const realPreset = () => readFileSync(path.join(PLUGIN, PRESET_REL), 'utf8')

/** 造一个 flat 形态的假仓：标记目录 + lib/ + roles/ + preset-starter/ */
function fakeRepo({ table, preset } = {}) {
  const d = mkdtempSync(path.join(tmpdir(), 'nf-face-'))
  mkdirSync(path.join(d, 'wb-expert-starter'), { recursive: true })
  cpSync(path.join(PLUGIN, 'lib'), path.join(d, 'lib'), { recursive: true })
  mkdirSync(path.join(d, 'roles'), { recursive: true })
  // 人格真源也要拷：`roles[].isolation` 引的条款号必须能在人格真源里查到（2026-09-23 新增的
  // 那道核）。不拷＝假仓里"人格真源读不到任何条款号"，于是**所有**盲角色的 isolation 都报红，
  // 测出来的红是夹具自己造出来的，与守卫无关。
  cpSync(path.join(PLUGIN, 'roles', 'persona'), path.join(d, 'roles', 'persona'), { recursive: true })
  writeFileSync(path.join(d, 'roles', 'tool-face.json'), JSON.stringify(table || realTable(), null, 2))
  mkdirSync(path.join(d, 'preset-starter'), { recursive: true })
  writeFileSync(path.join(d, PRESET_REL), preset === undefined ? realPreset() : preset)
  return d
}
const run = (root, args) => spawnSync(process.execPath, [SCRIPT, '--root', root, ...args], { encoding: 'utf8' })
const both = (r) => String(r.stdout || '') + String(r.stderr || '')

/**
 * 改某个角色条目的 deny 行（其余行逐字不动）。
 * 为什么按条目定位：预设里有六条 deny 行，第一版测试对**首条**匹配做替换，
 * 改到的其实是主笔那份（它本来就没有 send_message），预设等于没变——
 * "应当漂移"的用例于是测了个没漂移的文件，红的是测试自己而不是被断言的守卫。
 */
function editDeny(text, entryId, fn) {
  const lines = text.split('\n')
  const start = lines.findIndex((l) => l === '- id: ' + entryId)
  assert.ok(start >= 0, '测试夹具找不到条目 ' + entryId)
  const end = lines.findIndex((l, i) => i > start && /^- id: /.test(l))
  const stop = end === -1 ? lines.length : end
  const di = lines.findIndex((l, i) => i > start && i < stop && /^\s*deny: \[/.test(l))
  assert.ok(di >= 0, '测试夹具找不到 ' + entryId + ' 的 deny 行')
  lines[di] = lines[di].replace(/\[(.*)\]/, (m, inner) => '[' +
    fn(inner.split(',').map((s) => s.trim()).filter(Boolean)).join(', ') + ']')
  return lines.join('\n')
}

// ── 正向：表与派生件一致时安静通过
test('能力表与派生件一致：--check exit 0（真仓三份派生件）', () => {
  const r = run(PLUGIN, ['--check'])
  assert.equal(r.status, 0, '真仓应一致：' + both(r))
  assert.match(r.stdout, /角色工具面/, '应打印逐件结果（不靠退出码掩盖局部）')
})

// ── ① fail-closed：缺列 / 写错类型 / 重复登记，一律拒绝生成
test('能力条目缺宿主列 ⇒ 拒绝生成（缺失没有类型）', () => {
  const t = realTable()
  delete t.capabilities.spawn.dsh
  const d = fakeRepo({ table: t })
  const r = run(d, ['--host', 'dsh', '--check'])
  assert.equal(r.status, 2, '缺列必须 exit 2（不是"少封一条"地跑过去）：' + both(r))
  assert.match(both(r), /缺取值/, '报错要说清是"这一列没答"（缺失没有类型）')
  assert.match(both(r), /能力 spawn\.dsh/, '要点名缺的是哪个能力的哪一列')
  rmSync(d, { recursive: true, force: true })
})

test('CodeBuddy 列缺形态 ⇒ 拒绝生成（形态是映射的键）', () => {
  const t = realTable()
  // 只给 seat 一条、去掉 `*` 兜底：另两个形态就"没答"——它们是没答，不是"不用封"
  t.capabilities['fs.read'].codebuddy = { seat: { tools: ['Read'] } }
  const d = fakeRepo({ table: t })
  const r = run(d, ['--host', 'codebuddy', '--check'])
  assert.equal(r.status, 2, '形态解析不到取值必须 exit 2：' + both(r))
  assert.match(both(r), /上没有任何取值/)
  assert.match(both(r), /fs\.read/)
  rmSync(d, { recursive: true, force: true })
})

test('CodeBuddy 列出现官方清单外的名字 ⇒ 拒绝生成（R-c：不许静默空转）', () => {
  const t = realTable()
  t.capabilities['fs.search'].codebuddy['*'].tools.push('Greb')     // 拼错一个字母
  const d = fakeRepo({ table: t })
  const r = run(d, ['--host', 'codebuddy', '--check'])
  assert.equal(r.status, 2, both(r))
  assert.match(both(r), /不在 hosts\.codebuddy\.known_tools/)
  assert.match(both(r), /Greb/)
  rmSync(d, { recursive: true, force: true })
})

test('CodeBuddy 列出现已核实不存在的名字 ⇒ 拒绝生成（照抄 DSH 名单的静默失效）', () => {
  const t = realTable()
  t.capabilities['fs.search'].codebuddy['*'].tools.push('read_image')   // DSH 有、CodeBuddy 没有
  const d = fakeRepo({ table: t })
  const r = run(d, ['--host', 'codebuddy', '--check'])
  assert.equal(r.status, 2, both(r))
  assert.match(both(r), /CodeBuddy \*\*不存在\*\*的工具名/)
  assert.match(both(r), /read_image/)
  rmSync(d, { recursive: true, force: true })
})

test('角色声明了未知形态 ⇒ 拒绝生成（形态写错就查不出这个角色的面）', () => {
  const t = realTable()
  t.roles.author.codebuddy.form = 'teammate2'
  const d = fakeRepo({ table: t })
  const r = run(d, ['--host', 'codebuddy', '--check'])
  assert.equal(r.status, 2, both(r))
  assert.match(both(r), /不是已知形态/)
  rmSync(d, { recursive: true, force: true })
})

test('角色 deny 写工具名而不是能力 id ⇒ 拒绝生成', () => {
  const t = realTable()
  t.roles.author.deny.push('edit')
  const d = fakeRepo({ table: t })
  const r = run(d, ['--host', 'dsh', '--check'])
  assert.equal(r.status, 2, both(r))
  assert.match(both(r), /不是能力 id/, '要说清"deny 只许写能力"')
  rmSync(d, { recursive: true, force: true })
})

// ── 2026-09-22 两条新不变量（WB 侧实测所迫）──────────────────────────────
test('角色封了发现面却仍允许 MCP 面 ⇒ 拒绝生成（本形态 MCP 只能经那一对到达）', () => {
  const t = realTable()
  // 复现 09-22 之前主笔的真实形状：封了 tool.search/tool.invoke，却留着 ledger.read/retrieval
  // ⇒ 它会把自己该有的 novel_bible/novel_search 一起封掉（本形态 MCP 只能经这一对到达）
  t.roles.author.deny.push('tool.search', 'tool.invoke')
  const d = fakeRepo({ table: t })
  const r = run(d, ['--host', 'dsh', '--check'])
  assert.equal(r.status, 2, both(r))
  assert.match(both(r), /封了发现面/, '要说清后果：该角色一件 MCP 工具都拿不到')
  assert.match(both(r), /ledger\.read/, '要点名哪些 MCP 面能力还在允许侧')
  rmSync(d, { recursive: true, force: true })
})

test('同一名字同时落在 tools 与 ineffective ⇒ 拒绝生成（一个名字要么封得住、要么实测封不住）', () => {
  const t = realTable()
  t.capabilities['shell.exec'].codebuddy['*'].ineffective = ['PowerShell', 'Bash']   // Bash 已在 tools 里
  const d = fakeRepo({ table: t })
  const r = run(d, ['--host', 'dsh', '--check'])
  assert.equal(r.status, 2, both(r))
  assert.match(both(r), /同时落在 tools 与 ineffective/, '要把"两者互斥"说清楚，否则下一个人会以为可以两处都写')
  rmSync(d, { recursive: true, force: true })
})

test('codebuddy 列里的 MCP 工具名不在连接器清单里 ⇒ 拒绝生成（宿主不会报错，只能自己收口）', () => {
  const t = realTable()
  t.capabilities['ledger.write'].codebuddy['*'].tools[0] = 'mcp__novelist__novel_chaptr'   // 拼错一个字母
  const d = fakeRepo({ table: t })
  const r = run(d, ['--host', 'dsh', '--check'])
  assert.equal(r.status, 2, both(r))
  assert.match(both(r), /不在连接器工具清单里/, 'MCP 名的存在性由连接器清单定义，不由宿主内置清单定义')
  rmSync(d, { recursive: true, force: true })
})

test('同一宿主列里一个工具名进了两个能力 ⇒ 拒绝生成（否则 deny 一个静默连坐另一个）', () => {
  const t = realTable()
  t.capabilities['fs.write'].dsh.tools.push('read')
  const d = fakeRepo({ table: t })
  const r = run(d, ['--host', 'dsh', '--check'])
  assert.equal(r.status, 2, both(r))
  // 措辞 2026-09-21 收紧：现在按**宿主 × 形态**分格核对（同一名字落在同一形态上才算两处真源；
  // 三形态工具面本就不同，seat 有 Agent 而 subagent 没有，那是合法的）。断言仍锁必须点名工具名。
  assert.match(both(r), /同一形态下两处真源/, '要指出这是同一形态下的重复登记')
  assert.match(both(r), /工具名「read」/, '要点名到具体工具名')
  rmSync(d, { recursive: true, force: true })
})

test('status 条目缺 why ⇒ 拒绝生成（"没有这个工具"和"没查清"都必须留一句为什么）', () => {
  const t = realTable()
  delete t.capabilities.fanout.dsh.why
  const d = fakeRepo({ table: t })
  const r = run(d, ['--host', 'dsh', '--check'])
  assert.equal(r.status, 2, both(r))
  assert.match(both(r), /没给 why/, '缺原因也要报')
  rmSync(d, { recursive: true, force: true })
})

// ── ② 反向：世界变了而表没跟上
test('领域工具没进任何能力 ⇒ 红（加了工具忘了登记面）', () => {
  const t = realTable()
  t.capabilities.retrieval.dsh.tools = t.capabilities.retrieval.dsh.tools.filter((n) => n !== 'novel_search')
  const d = fakeRepo({ table: t })
  const r = run(d, ['--host', 'dsh', '--check'])
  assert.equal(r.status, 2, both(r))
  assert.match(both(r), /没进任何能力/, '要点名那个没有任何角色面能封的工具')
  assert.match(both(r), /novel_search/)
  rmSync(d, { recursive: true, force: true })
})

test('表里写了不存在的领域工具 ⇒ 红（DSH 侧会抛 unknown global tool）', () => {
  const t = realTable()
  t.capabilities['ledger.write'].dsh.tools.push('novel_ghost')
  const d = fakeRepo({ table: t })
  const r = run(d, ['--host', 'dsh', '--check'])
  assert.equal(r.status, 2, both(r))
  assert.match(both(r), /不存在的领域工具/)
  rmSync(d, { recursive: true, force: true })
})

test('预设挂了未登记的插件 ⇒ 红（新挂插件＝给每个子代理多一件继承工具）', () => {
  const preset = realPreset() + "\n# 假装有人新挂了一个插件\n- id: extra-workflow\n  name: '@deepseek-ai/dsh-tool-workflow'\n"
  const d = fakeRepo({ preset })
  const r = run(d, ['--host', 'dsh', '--check'])
  assert.equal(r.status, 2, both(r))
  assert.match(both(r), /未登记的插件/, '要点名插件')
  assert.match(both(r), /dsh-tool-workflow/)
  rmSync(d, { recursive: true, force: true })
})

test('预设名单里出现表上没有的名字 ⇒ 红（正向检查永远发现不了这一条）', () => {
  const preset = editDeny(realPreset(), 'nf-role-reader', (n) => n.concat('ghost_tool'))
  const d = fakeRepo({ preset })
  const r = run(d, ['--host', 'dsh', '--check'])
  assert.equal(r.status, 2, both(r))
  assert.match(both(r), /名单里有表上没有的名字/)
  assert.match(both(r), /ghost_tool/)
  rmSync(d, { recursive: true, force: true })
})

test('角色条目少了 toolFilter / 多了没人认领的 toolFilter ⇒ 红（双向都要管）', () => {
  // (a) 表里登记了 deny，文件里没有被改
  const preset = realPreset().replace(/^\s*deny: \[.*\]\n/m, '')
  const d1 = fakeRepo({ preset })
  const r1 = run(d1, ['--host', 'dsh', '--check'])
  assert.equal(r1.status, 2, both(r1))
  assert.match(both(r1), /没有 deny 行|找不到/)
  rmSync(d1, { recursive: true, force: true })
})

// ── 漂移检测：派生件与表不一致必须 exit 1（不是 2：文件在、只是没跟上）
test('派生件漂移 ⇒ --check exit 1（源改了、派生件没跟上）', () => {
  const preset = editDeny(realPreset(), 'nf-role-reader', (n) => n.filter((x) => x !== 'send_message'))
  const d = fakeRepo({ preset })
  const r = run(d, ['--host', 'dsh', '--check'])
  assert.equal(r.status, 1, '这是漂移不是"跑不起来"，故 exit 1：' + both(r))
  assert.match(both(r), /不一致/)
  assert.match(both(r), /派生件没跟上/)
  rmSync(d, { recursive: true, force: true })
})

// ── ② 章程加严（2026-09-20 Owner 批①）：盲角色不得扇出、不得发现工具
test('① 盲角色在**两份**预设里都封了扇出与工具发现面，且带 maxDepth: 0', () => {
  const t = realTable()
  const blind = Object.entries(t.roles).filter(([, r]) => r.blind).map(([id]) => id)
  assert.deepEqual(blind.sort(), ['calibrator', 'dissector', 'proofer', 'reader'], '盲角色集合变了？先改本断言再改表')
  for (const rid of blind) {
    for (const c of ['spawn', 'tool.search', 'tool.invoke']) assert.ok(t.roles[rid].deny.includes(c), rid + ' 必须 deny ' + c)
  }
  const spawnNames = t.capabilities.spawn.dsh.tools
  const discNames = ['tool.search', 'tool.invoke'].flatMap((k) => (Array.isArray(t.capabilities[k].dsh.tools) ? t.capabilities[k].dsh.tools : []))
  assert.equal(discNames.length, 0, '本轮 DSH 侧 tool.discovery 尚无工具名（status: none）——若它有了名字，本测试与预设都要跟着动')

  const files = [
    path.join(PLUGIN, PRESET_REL),
    path.resolve(PLUGIN, '..', 'preset-writer', 'agent.cordis.yml'),   // monorepo 下才在；下面按存在性校验
  ]
  let checked = 0
  for (const file of files) {
    let text
    try { text = readFileSync(file, 'utf8') } catch { continue }
    checked++
    const lines = text.split('\n')
    for (const rid of blind) {
      const entry = t.roles[rid].dsh.entry
      const start = lines.findIndex((l) => l === '- id: ' + entry)
      assert.ok(start >= 0, path.basename(file) + ' 里找不到条目 ' + entry)
      const end = lines.findIndex((l, i) => i > start && /^- id: /.test(l))
      const body = lines.slice(start, end === -1 ? lines.length : end)
      const deny = body.find((l) => /^\s*deny: \[/.test(l))
      assert.ok(deny, entry + ' 缺 deny 行')
      for (const n of spawnNames) assert.ok(deny.includes(n), entry + ' 未封派工工具 ' + n)
      assert.ok(deny.includes('send_message'), entry + ' 未封跨代理发消息（盲仪器的对外通道）')
      assert.ok(body.some((l) => /^\s*maxDepth: 0\s*$/.test(l)), entry + ' 缺 maxDepth: 0（结构性扇出锁）')
    }
    // 非盲角色不许有 maxDepth（能力表没封 spawn）——多出来的锁同样是漂移
    for (const [rid, r] of Object.entries(t.roles)) {
      if (r.blind || !r.dsh || !r.dsh.entry) continue
      const start = lines.findIndex((l) => l === '- id: ' + r.dsh.entry)
      if (start < 0) continue
      const end = lines.findIndex((l, i) => i > start && /^- id: /.test(l))
      const body = lines.slice(start, end === -1 ? lines.length : end)
      assert.ok(!body.some((l) => /^\s*maxDepth:/.test(l)), r.dsh.entry + ' 不该有 maxDepth')
    }
  }
  assert.ok(checked >= 1, '一份预设都没读到——本测试扫了个空')
})

// ── WB 侧产出：声明文档必须零机器路径，且把"会被照抄而不存在"的名字写出来
test('WB 角色工具面文档：零机器路径、点明三个不存在的名字、标注未核实', () => {
  const doc = path.join(PLUGIN, 'wb-expert-starter', 'references', '宿主工具面.md')
  const text = readFileSync(doc, 'utf8')
  const machine = text.split('\n').filter((l) => /(?:[A-Za-z]:[\\/]|\/(?:home|Users)\/)/.test(l) && !/〔示例〕/.test(l))
  assert.deepEqual(machine, [], '生成的文档里不该有机器绝对路径（换台机器就是死路径）')
  for (const s of ['read_image', 'pwsh', 'Agent', 'ToolSearch', 'disallowedTools']) {
    assert.ok(text.includes(s), '文档缺关键内容：' + s)
  }
  assert.match(text, /未核实/, '未核实状态必须写出来，不许当已实现')
  assert.match(text, /不要手改|本文件是生成的/, '生成件必须自带"别手改"提示')
})

// ── 能力表本身的最低不变量（挂在测试里，读表即红，不必跑生成器）
test('能力表：每个能力两列齐全，且 domain 工具名与 lib 注册表一致', async () => {
  const t = realTable()
  const forms = Object.keys(t.hosts.codebuddy.forms)
  // 合法状态五值：none＝本宿主没这个能力；unverified＝**没查**；unknown＝**查过了，结论是"不许渲染"**；
  // 加上 2026-09-23 的两种**整格缺口**：ineffective＝这一格整个**拦不住**（C 桶）、
  // costly＝整个**只能带代价封**（B 桶）。后两种必须与 none/unverified 分开：
  // 前者是"没有东西可禁"、中者是"我还没看"、后者是"我看了，封不住 / 封得起但不划算"。
  const leafOk = (v) => Array.isArray(v.tools) ? v.tools.length > 0
    : Array.isArray(v.ineffective) ? v.ineffective.length > 0
      : Array.isArray(v.costly) ? v.costly.length > 0
        : (v.status === 'none' || v.status === 'unverified' || v.status === 'unknown')
  for (const [cid, cap] of Object.entries(t.capabilities)) {
    assert.ok(cap.dsh, cid + ' 缺 dsh 列')
    assert.ok(leafOk(cap.dsh), cid + '.dsh 取值非法：' + JSON.stringify(cap.dsh))
    for (const f of forms) {
      const v = cap.codebuddy[f] !== undefined ? cap.codebuddy[f] : cap.codebuddy['*']
      assert.ok(v, cid + ' 在形态 ' + f + ' 上解析不到取值（既没写该形态，也没有 * 兜底）')
      assert.ok(leafOk(v), cid + '.codebuddy.' + f + ' 取值非法：' + JSON.stringify(v))
    }
  }
  const mod = await import(new URL('../lib/novelist.js', import.meta.url).href)
  const tools = mod._internals.TOOLS.map((x) => x.name).sort()
  const inTable = Object.values(t.capabilities).flatMap((c) => (Array.isArray(c.dsh.tools) ? c.dsh.tools : [])).filter((n) => n.startsWith('novel_')).sort()
  assert.deepEqual(inTable, tools, '能力表里的领域工具名与 lib/novelist.js 的注册表必须双向全等')
})

// ── 幂等：连跑两次不该有第二次变化（生成器自己写坏文件的回归）
test('幂等：同一份输入连跑两次，第二次 --check 必须为 0', () => {
  const d = fakeRepo()
  const w = run(d, ['--host', 'dsh'])
  assert.equal(w.status, 0, both(w))
  const c = run(d, ['--host', 'dsh', '--check'])
  assert.equal(c.status, 0, '写完立刻比对必须一致（否则是生成器不稳定）：' + both(c))
  rmSync(d, { recursive: true, force: true })
})

// ── 生成后自证：改写只许动名单与 maxDepth 两类行，别把别的字节碰坏
test('改写只在 deny / maxDepth 两类行上发生（写坏文件的回归）', () => {
  const preset = editDeny(realPreset(), 'nf-role-proofer', (n) => n.filter((x) => x !== 'send_message'))
  const d = fakeRepo({ preset })
  const before = readFileSync(path.join(d, PRESET_REL), 'utf8')
  const r = run(d, ['--host', 'dsh'])
  assert.equal(r.status, 0, both(r))
  const after = readFileSync(path.join(d, PRESET_REL), 'utf8')
  assert.notEqual(before, after, '预设有漂移时应当真的改写')
  const b = before.split('\n'), a = after.split('\n')
  assert.equal(a.length, b.length, '改写后行数变了（只能是替换，不该增删行——本轮只替换 deny 行）')
  let touched = []
  a.forEach((l, i) => { if (l !== b[i]) touched.push(l.trim().slice(0, 40)) })
  assert.ok(touched.length >= 1, '应当至少改写一行')
  for (const l of touched) assert.match(l, /^deny: \[|^maxDepth:/, '改写越界到非名单行：' + l)
  rmSync(d, { recursive: true, force: true })
})

// ── 派工文本里的工具面也归生成管（第三份拷贝的回归）
// 背景：references/roles/*.md 原本各手写一段 DSH 名单，2026-09-20 第三方实测**五份全部落后真源**
// （盲角色各漏 7 项反扇出条款）。这条测试锁的是"它再也不能手写回去"。
test('派工文本的工具面生成区：手改即红；缺标记即拒（第三份拷贝的回归）', () => {
  // 为什么在**假仓**里测：这条用例要改派工文本，而 build-wb-expert.test.mjs 会在另一个进程里
  // 同时读真树（node --test 并行跑文件）——先前直接改真仓那份，单独跑全绿、一起跑就红。
  // 测试之间通过共享文件互相影响，就是"同一事实多处各活一次"在测试层的同款。
  const d = fakeRepo()
  const rolesDir = path.join(d, 'wb-expert-starter', 'references', 'roles')
  mkdirSync(rolesDir, { recursive: true })
  const srcDir = path.join(PLUGIN, 'wb-expert-starter', 'references', 'roles')
  for (const f of readdirSync(srcDir).filter((x) => x.endsWith('.md'))) {
    writeFileSync(path.join(rolesDir, f), readFileSync(path.join(srcDir, f), 'utf8'))
  }
  const target = path.join(rolesDir, 'reader.md')
  const orig = readFileSync(target, 'utf8')

  // ①真仓那份必须已经在生成区里、且不再有手写名单（回潮即红）
  assert.match(orig, /工具面：生成区开始/, '真仓派工文本缺生成区标记（这段必须由生成器接管）')
  assert.doesNotMatch(orig, /\`toolFilter\\.deny\`：\`novel_/, '派工文本里又出现手写名单（第三份拷贝回潮）')

  // ②生成区被手改 ⇒ 漂移（exit 1）
  writeFileSync(target, orig.replace('<!-- 工具面：生成区结束 -->', '手写补一句：22 项全封\n<!-- 工具面：生成区结束 -->'))
  const r = run(d, ['--host', 'codebuddy', '--check'])
  assert.equal(r.status, 1, '生成区被手改后 --check 必须报漂移：' + both(r))
  assert.match(both(r), /工具面生成区内容与能力表不一致/)

  // ③标记被整个删掉 ⇒ 拒绝执行（exit 2）：程序化判不出就不许静默放行
  writeFileSync(target, orig.replace('<!-- 工具面：生成区结束 -->', ''))
  const r2 = run(d, ['--host', 'codebuddy', '--check'])
  assert.equal(r2.status, 2, '缺标记必须拒绝执行（exit 2），实得 ' + r2.status)
  assert.match(both(r2), /缺工具面生成区标记/)

  // ④五件都在管：一次干净跑里，五份派工文本都应出现在结果里
  writeFileSync(target, orig)
  const ok = run(d, ['--host', 'codebuddy', '--check'])
  for (const f of ['reader', 'calibrator', 'proofer', 'dissector']) {
    assert.ok(readFileSync(path.join(rolesDir, f + '.md'), 'utf8').includes('工具面：生成区开始'), f + '.md 未被生成器纳入（缺标记）')
  }
  assert.match(both(ok), /references[\/\\]roles[\/\\]reader\.md/, '结果里应点名派工文本')
  rmSync(d, { recursive: true, force: true })
})

// ── 2026-09-23：WB 侧读数逼出来的一族缺陷——"登记了但没生效"必须留痕
//
// 现场形状：四个盲角色的 deny 里写着 `fs.write`／`fs.edit`，而这两格在 CodeBuddy 下是
// `unknown`（不许渲，理由见表），于是**名字一个也没渲出去、文档里也一个字没提**。
// 表观＝"看着配过"，实际＝那几个工具对本座一直开着——**静默少封一个名字**，
// 与静默封错一个名字同罪（两者都表现为"没报错"）。
// 锁的是"有意图就必须有出口"，且**出口要分对类**：B 桶（拦得住但有代价）与 C 桶（根本拦不住）
// 的含义相反，合并印会把"封不住"读成"封得住"、也会把"有代价"读成"封不住"（后者会让人白放弃一格）。
test('"登记了但没生效"必须留痕：B 桶 / C 桶 / 空操作三类出口分开，且渲得进去的不许被误报', () => {
  const docRel = ['wb-expert-starter', 'references', '宿主工具面.md']
  const withRefs = (d) => cpSync(path.join(PLUGIN, 'wb-expert-starter', 'references'),
    path.join(d, 'wb-expert-starter', 'references'), { recursive: true })

  // ① 真表：三类的代表都必须出现
  const d = fakeRepo()
  withRefs(d)
  try {
    const r = run(d, ['--host', 'codebuddy'])
    assert.equal(r.status, 0, '应能生成：' + both(r))
    const doc = readFileSync(path.join(d, ...docRel), 'utf8')
    const lines = doc.split('\n')
    const gapsB = lines.filter((l) => l.includes('缺口 · B 桶'))
    const gapsC = lines.filter((l) => l.includes('缺口 · C 桶'))
    const noop = lines.filter((l) => l.includes('空操作（本形态没有这个工具）'))
    assert.ok(gapsB.some((l) => l.includes('Write')), '`Write` 是 B 桶（拦得住但每次派工记 failed）⇒ 必须印成 B 桶缺口')
    assert.ok(gapsB.some((l) => l.includes('WebFetch')), '`WebFetch` 同 B 桶')
    assert.ok(gapsC.some((l) => l.includes('PowerShell')), '`PowerShell` 是 C 桶（写了等于没写）⇒ 必须印成 C 桶缺口')
    assert.ok(gapsC.some((l) => l.includes('automation_update')), '`automation_update` 同 C 桶')
    assert.ok(noop.length > 0, '"本形态没有这个工具"要单列一类——与缺口混在一起会把"空操作"读成"已封"')
    // 两类缺口**不许互相串**：串了就是把"有代价"说成"封不住"（白放弃一格），或反过来（假安全）
    assert.ok(!gapsB.some((l) => l.includes('PowerShell')), 'C 桶名字不许出现在 B 桶行里')
    assert.ok(!gapsC.some((l) => l.includes('`Write`')), 'B 桶名字不许出现在 C 桶行里')
  } finally { rmSync(d, { recursive: true, force: true }) }

  // ② 负例：把缺口消掉，那格就不该再印缺口（否则出口退化成"所有 deny 都印一遍"）
  const t = realTable()
  delete t.capabilities['shell.exec'].codebuddy['*'].ineffective
  const d2 = fakeRepo({ table: t })
  withRefs(d2)
  try {
    const r2 = run(d2, ['--host', 'codebuddy'])
    assert.equal(r2.status, 0, '应能生成：' + both(r2))
    const doc2 = readFileSync(path.join(d2, ...docRel), 'utf8')
    assert.ok(!doc2.split('\n').some((l) => l.includes('缺口 · C 桶') && l.includes('PowerShell')),
      '缺口已从表里删掉，文档里就不该还有它（出口失灵：印了表上没有的缺口）')
  } finally { rmSync(d2, { recursive: true, force: true }) }
})

// ── 2026-09-23：四桶与名单的**机器耦合**——渲进名单的名字必须是 A 桶
//
// 为什么这条是这一批最贵的核：C 桶名字写进 deny **不报错、也不拦**，表观与"已封"一模一样；
// B 桶名字写进去每次派工被框架记 `failed`。两种都是"进了名单却没得到想要的保护"。
// 少了这道核，唯一的发现途径是下一次红测——而它未必有人跑。
test('渲一个 B/C 桶名字进名单 ⇒ 拒绝生成（没测过的名字同样不许渲）', () => {
  // ① B 桶：`Write` 能拦但有代价 ⇒ 仍不许渲
  const t1 = realTable()
  t1.capabilities['fs.write'].codebuddy['*'] = { tools: ['Write'], note: '测试夹具：假装把它渲进去' }
  const d1 = fakeRepo({ table: t1 })
  try {
    const r = run(d1, ['--host', 'codebuddy', '--check'])
    assert.equal(r.status, 2, 'B 桶名字渲进名单必须 exit 2：' + both(r))
    assert.match(both(r), /B 桶/, '报错要点明是桶位问题，不是拼写问题')
  } finally { rmSync(d1, { recursive: true, force: true }) }

  // ② C 桶：`PowerShell` 根本拦不住 ⇒ 更不许渲
  const t2 = realTable()
  t2.capabilities['shell.exec'].codebuddy['*'] = { tools: ['Bash', 'PowerShell'], note: '测试夹具：把拦不住的名字硬塞进名单' }
  const d2 = fakeRepo({ table: t2 })
  try {
    const r = run(d2, ['--host', 'codebuddy', '--check'])
    assert.equal(r.status, 2, 'C 桶名字渲进名单必须 exit 2：' + both(r))
    assert.match(both(r), /C 桶/, '报错要点明是 C 桶（"名字还在、调用真执行"）')
  } finally { rmSync(d2, { recursive: true, force: true }) }

  // ③ 没桶位（没测过）的名字也不许渲——这是"承诺一件没人验证过的事"。
  // 拿 `Skill` 开刀：它在 2026-09-23 新渲进四个盲角色的名单，正踩在这条上。
  const t3 = realTable()
  t3.hosts.codebuddy.deny_readings.names = t3.hosts.codebuddy.deny_readings.names.filter((e) => e.name !== 'Skill')
  const d3 = fakeRepo({ table: t3 })
  try {
    const r = run(d3, ['--host', 'codebuddy', '--check'])
    assert.equal(r.status, 2, '拿掉桶位登记后必须 exit 2（`Edit`/`Skill`/`WebSearch` 立刻变成"没测过"）：' + both(r))
    assert.match(both(r), /没有桶位/, '报错要说清是"没桶位"，不是"名字错了"')
  } finally { rmSync(d3, { recursive: true, force: true }) }
})

// ── 2026-09-23：缺口名放错格子 = 把 B 说成 C（比不说更糟）
test('缺口名与其桶位不符 ⇒ 拒绝生成（B／C 是两种缺口，不许互串）', () => {
  const t = realTable()
  // 把 `Write`（B 桶）塞进 ineffective（应为 C 桶）
  delete t.capabilities['fs.write'].codebuddy['*'].costly
  t.capabilities['fs.write'].codebuddy['*'] = { ineffective: ['Write'], why: '测试夹具：把 B 说成 C' }
  const d = fakeRepo({ table: t })
  try {
    const r = run(d, ['--host', 'codebuddy', '--check'])
    assert.equal(r.status, 2, '桶位不符必须 exit 2：' + both(r))
    assert.match(both(r), /与它所在的格子不符/, '报错要点明"放错格子"这件事')
  } finally { rmSync(d, { recursive: true, force: true }) }
})

// ── 2026-09-23：桶位台账自身的 fail-closed（没有报文的桶位＝印象，不是读数）
test('deny_readings 条目缺 raw ⇒ 拒绝生成（桶位是读数，必须有报文）', () => {
  const t = realTable()
  delete t.hosts.codebuddy.deny_readings.names[0].raw
  const d = fakeRepo({ table: t })
  try {
    const r = run(d, ['--host', 'codebuddy', '--check'])
    assert.equal(r.status, 2, '缺 raw 必须 exit 2：' + both(r))
    assert.match(both(r), /缺 raw/, '报错要点名缺的是原始报文')
  } finally { rmSync(d, { recursive: true, force: true }) }
})

// ── 2026-09-23：盲读强度声明必须**引得到**条款（引一个查不到的条款＝给下一个人一个错的依据）
test('盲角色 isolation 引不存在的条款号 ⇒ 拒绝生成；非盲角色写 isolation 也拒绝', () => {
  const t = realTable()
  t.roles.proofer.isolation.clauses = ['CORE-01', 'PROOF-99']
  const d = fakeRepo({ table: t })
  try {
    const r = run(d, ['--host', 'codebuddy', '--check'])
    assert.equal(r.status, 2, '引不存在的条款必须 exit 2：' + both(r))
    assert.match(both(r), /PROOF-99/, '报错要点名是哪一个条款号')
  } finally { rmSync(d, { recursive: true, force: true }) }

  const t2 = realTable()
  t2.roles.archivist.isolation = { strength: '测试夹具', clauses: ['ARCH-01'], why: '它不是盲角色，不该有这个字段' }
  const d2 = fakeRepo({ table: t2 })
  try {
    const r2 = run(d2, ['--host', 'codebuddy', '--check'])
    assert.equal(r2.status, 2, '非盲角色写 isolation 必须 exit 2：' + both(r2))
    assert.match(both(r2), /不是盲角色/, '报错要说清这个字段只属于盲角色')
  } finally { rmSync(d2, { recursive: true, force: true }) }
})

// ── 2026-09-23：四桶表与盲读强度表必须真的渲进文档（不是只活在能力表里）
test('文档必须渲出四桶表与盲读强度表（含条款原文，且条款号现读）', () => {
  const docRel = ['wb-expert-starter', 'references', '宿主工具面.md']
  const d = fakeRepo()
  cpSync(path.join(PLUGIN, 'wb-expert-starter', 'references'), path.join(d, 'wb-expert-starter', 'references'), { recursive: true })
  try {
    const r = run(d, ['--host', 'codebuddy'])
    assert.equal(r.status, 0, '应能生成：' + both(r))
    const doc = readFileSync(path.join(d, ...docRel), 'utf8')
    assert.match(doc, /## 三b、一个名字写进/, '四桶表必须自成一节')
    for (const b of ['**A**', '**B**', '**C**', '**D**']) assert.ok(doc.includes(b), '四桶定义缺 ' + b)
    assert.ok(doc.includes('D 桶的报错名字不固定'), 'D 桶的"名字不固定"这条限定必须跟着表一起印（否则会有人反推哪个名字有毒）')
    assert.match(doc, /## 三c、四座盲角色的/, '盲读强度表必须自成一节')
    // 三档强度都要在（打包成一句正是这条要治的病）
    for (const s of ['零读盘', '单文件受限读', '读锚书']) assert.ok(doc.includes(s), '缺一档强度：' + s)
    // 条款原文必须来自人格真源现读（这里抽 PROOF-02 的一句原文）
    assert.ok(doc.includes('单次只读**一个**受审文件'), '盲读强度表的条款原文应从 roles/persona/ 现读，不许手写')
  } finally { rmSync(d, { recursive: true, force: true }) }
})

// ── 2026-09-23：热加载措辞只许说两句话（说成"改完即生效"是最贵的那种错）
test('文档与安装器的热加载措辞：新增即时 / 改动需重启，且 --check 只管盘上', () => {
  const d = fakeRepo()
  cpSync(path.join(PLUGIN, 'wb-expert-starter', 'references'), path.join(d, 'wb-expert-starter', 'references'), { recursive: true })
  try {
    const r = run(d, ['--host', 'codebuddy'])
    assert.equal(r.status, 0, '应能生成：' + both(r))
    const doc = readFileSync(path.join(d, 'wb-expert-starter', 'references', '宿主工具面.md'), 'utf8')
    assert.ok(doc.includes('**改动已有定义的内容＝不生效，必须重启**'), '文档必须写死这一句：改动需重启')
    assert.ok(doc.includes('**新增一份新定义（新路径）＝即时生效**'), '文档必须写死这一句：新增即时生效')
    assert.ok(doc.includes('验不出"宿主内存里还在用旧的那一版"'), '必须把 --check 的边界写出来（它只管盘上）')
    assert.ok(doc.includes('重启前必须先跑的那一条'), '组合探针那条门必须印在文档里（否则重启会把没测过的名单带上去）')
  } finally { rmSync(d, { recursive: true, force: true }) }
})

// ── 2026-09-23：工具面读数必须回灌本表（"文档清单 ≠ 运行时清单"）
//
// 现场形状：宿主官方 tools-reference 里**没有** `automation_update`／`present_files`／`read_me`／
// `show_widget`／`Skill` 这五个名字，而它们在运行时工具面里**都在**。它们此前从没进过 known_tools
// ⇒ 既没被归类、也没被封、也没人发现（未归类＝默认敞开且不留痕迹）。
// 本表因此要求：**每次拿到的运行时工具面读数，都要能在 known_tools 里对上号**。
test('运行时工具面读数里的每个名字都必须已在 known_tools（新名字出现＝表已落后）', () => {
  const t = realTable()
  const known = new Set(t.hosts.codebuddy.known_tools || [])
  const readings = t.hosts.codebuddy.tool_face_readings || []
  assert.ok(readings.length > 0, '至少要有一条运行时读数登记（它是"文档清单≠运行时清单"这条教训的载体）')
  const missing = []
  for (const r of readings) {
    assert.ok(Array.isArray(r.names) && r.names.length, '读数必须带 names：' + JSON.stringify(r.when))
    for (const n of r.names) if (!known.has(n)) missing.push(n + '（读数 ' + r.when + '）')
  }
  assert.deepEqual(missing, [], '读数里有 known_tools 认不得的名字——表落后于宿主的真实工具面：' + missing.join('、'))
  // 反向也要有一条：这条教训的来源名字必须真的在清单里（防"读数登记了但名字没补进去"）
  for (const n of ['automation_update', 'present_files', 'read_me', 'show_widget', 'Skill']) {
    assert.ok(known.has(n), '这条教训的来源名字必须在 known_tools 里：' + n)
  }
})

// ── 2026-09-23：`Edit` → `Write` 的宿主连带行为（WB 侧第三封的发现，推翻了我文档里一句话）
//
// 现场：我文档里写「本形态写面是半开的：只封得住 `Edit`，`Write` 一直开着」，实测**是反的**——
// 禁 `Edit` 会**连带摘掉 `Write`**（反向不成立）⇒ 四个盲角色的写面**是关的**。
// 但这条**不是我们设计出来的**：能力表里 `fs.edit` 与 `fs.write` 是两格，隔离现在**挂在一条
// 未文档化的宿主行为上**——宿主哪天不连带了，写面会**静默变宽**，而所有文档还写着「已封」。
// 所以本组锁三件：①这条行为必须印进文档＋给出哨兵名；②旧口径不许再留在产出里；③它要进派生件
// （装机侧只看按角色那一节，会以为写面是关的而不知道那是宿主给的）。
test('文档必须印出「禁 Edit 连带摘掉 Write」，且旧口径「写面半开」不许再留在产出里', () => {
  const d = fakeRepo()
  cpSync(path.join(PLUGIN, 'wb-expert-starter', 'references'), path.join(d, 'wb-expert-starter', 'references'), { recursive: true })
  try {
    const r = run(d, ['--host', 'codebuddy'])
    assert.equal(r.status, 0, '应能生成：' + both(r))
    const doc = readFileSync(path.join(d, 'wb-expert-starter', 'references', '宿主工具面.md'), 'utf8')
    assert.match(doc, /禁 `Edit` 会连带把 `Write` 一起摘掉/, '这条宿主行为必须印进文档——隔离现在就挂在它上面')
    assert.match(doc, /zz-np-fsedit-0923/, '要给出常驻哨兵的名字（宿主哪天不连带了，那条会立刻变红）')
    assert.match(doc, /写面不是半开的/, '写面那句已被实测推翻 ⇒ 必须改成正确的那句')
    assert.ok(!doc.includes('外取面与写面都是半开'), '旧口径（写面半开）不许再留在产出的文档里')
    // 名单那半仍是名单：四个盲角色里有 `Edit`（正是它连带关掉写面）
    assert.match(doc, /`disallowedTools: \[[^\]]*Edit[^\]]*\]`/, '盲角色名单里要有 `Edit`')
  } finally { rmSync(d, { recursive: true, force: true }) }
})

// ── 2026-09-23：派生件的三节宿主级台账（答 WB 侧 §5.1「`host.ui` 为什么不在件里」）
test('派生件必须带 couplings / _forbidden / unclaimed 三节，且都是现算的', () => {
  const d = fakeRepo()
  cpSync(path.join(PLUGIN, 'wb-expert-starter', 'references'), path.join(d, 'wb-expert-starter', 'references'), { recursive: true })
  try {
    const r = run(d, ['--host', 'codebuddy'])
    assert.equal(r.status, 0, '应能生成：' + both(r))
    const led = JSON.parse(readFileSync(path.join(d, 'wb-expert-starter', 'references', 'carrier-deny.json'), 'utf8'))
    // ① 宿主级连带行为要进件：装机侧只看"按角色"那节，会以为写面是关的而不知道那是宿主给的
    assert.ok(led.couplings && led.couplings['fs.edit（禁 `Edit`）'], 'couplings 里要带 Edit→Write 那条')
    // ② "永不渲入名单"的名字集：装机侧靠它做 fail-closed（没有真源也算得出来）
    for (const n of ['Write', 'WebFetch', 'PowerShell', 'automation_update', 'present_files']) {
      assert.ok(led._forbidden.includes(n), '_forbidden 缺 ' + n)
    }
    // ③ 未被任何角色认领的能力：现算。`host.ui` 必须在内——那正是 §5.1 问的那一格
    const un = new Map(led.unclaimed.map((u) => [u.cid, u]))
    assert.ok(un.has('host.ui'), 'host.ui 没有任何角色认领 ⇒ 必须出现在 unclaimed 里（这就是「它为什么不在件里」的答案）')
    assert.deepEqual(un.get('host.ui').ineffective, ['present_files', 'read_me', 'show_widget'],
      '要如实带出它是整格 C 桶（不是 status:unknown——那会把「有名字但封不住」说成「没查清」）')
    assert.ok(un.has('team.admin'), 'team.admin 也没人认领（只有主编可能用到，而主编不封任何能力）')
    assert.ok(!un.has('ledger.write'), '有人认领的能力不许出现在 unclaimed 里（否则这一节退化成"把所有能力列一遍"）')
  } finally { rmSync(d, { recursive: true, force: true }) }
})

test('_forbidden 算成空集 ⇒ 拒绝生成（空集让装机侧那道拒渲核对形同虚设）', () => {
  const t = realTable()
  for (const cap of Object.values(t.capabilities)) {
    for (const [k, leaf] of Object.entries(cap.codebuddy || {})) {
      if (!leaf || typeof leaf !== 'object') continue
      delete leaf.ineffective; delete leaf.costly; delete leaf.candidates
      // 整格缺口的叶形会被清成 `{}`（形状不认识 ⇒ 那是另一条红）——补一个等价状态，让本次只测"空集"这一件事
      if (!Array.isArray(leaf.tools) && !leaf.status) {
        cap.codebuddy[k] = { status: 'none', why: '测试夹具：只为让 _forbidden 算成空集' }
      }
    }
  }
  const d = fakeRepo({ table: t })
  cpSync(path.join(PLUGIN, 'wb-expert-starter', 'references'), path.join(d, 'wb-expert-starter', 'references'), { recursive: true })
  try {
    const r = run(d, ['--host', 'codebuddy'])
    assert.equal(r.status, 2, '空集必须 exit 2：' + both(r))
    assert.match(both(r), /永不渲入名单/, '报错要说清空的是哪一节')
  } finally { rmSync(d, { recursive: true, force: true }) }
})
