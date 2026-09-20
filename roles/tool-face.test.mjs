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

test('同一宿主列里一个工具名进了两个能力 ⇒ 拒绝生成（否则 deny 一个静默连坐另一个）', () => {
  const t = realTable()
  t.capabilities['fs.write'].dsh.tools.push('read')
  const d = fakeRepo({ table: t })
  const r = run(d, ['--host', 'dsh', '--check'])
  assert.equal(r.status, 2, both(r))
  assert.match(both(r), /两个能力同时登记/, '要指出重复登记的工具名')
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
  const leafOk = (v) => Array.isArray(v.tools) ? v.tools.length > 0 : (v.status === 'none' || v.status === 'unverified')
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
