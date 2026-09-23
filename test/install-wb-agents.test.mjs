// 宿主载体安装器（scripts/install-wb-agents.mjs）与其消费的派生件的回归（B1 · 2026-09-22）
//
// 锁的是什么——四条，每条都能红：
//   ① **只渲 enforced**：封名单里出现"实测拦不住"或"只是候选"的名字 ⇒ 拒渲（写进去＝虚假的约束感）。
//   ② **豁免必须带理由**：豁免是"换宿主换理由"的地方；没理由的豁免就是漏封，且从输出上看不出来。
//   ③ **包内 agent 定义零 `disallowedTools`**：官方校验器对前言块做**子串**判断，`disallowedTools:`
//      含 `tools:` ⇒ 渲进包内 MD 立刻不合规。这条是硬约束，不是洁癖。
//   ④ **陈旧门真的会红**：定义是热加载的，"装的时候对过"不作数 ⇒ `--check` 必须能发现改过真源之后
//      载体还停在旧样子，以及没装过的情况（缺件也算红，不许报成"通过"）。
//
// 为什么在临时假仓里跑负例：这些用例都要把派生件/真源改坏。真仓里改坏再改回来，中间任何一步失败
// 都会把一个坏文件留在树上——守卫自己成了事故源。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, readdirSync, rmSync, cpSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const PLUGIN = path.resolve(HERE, '..')
const SCRIPT = path.join(PLUGIN, 'scripts', 'install-wb-agents.mjs')
const TABLE_FILE = path.join(PLUGIN, 'roles', 'tool-face.json')
const AGENTS_DIR = path.join(PLUGIN, 'wb-expert-starter', 'agents')

const realTable = () => JSON.parse(readFileSync(TABLE_FILE, 'utf8'))
// 派生件坐标从表里读，不在这里再写一份（写两份＝又一处会漂的手抄；且文件名含 ASCII 才过得了棘轮）
const LEDGER_REL = 'wb-expert-starter/' + realTable().hosts.codebuddy.carrier_ledger
const realLedger = () => JSON.parse(readFileSync(path.join(PLUGIN, LEDGER_REL), 'utf8'))

/** 造一个只够安装器跑起来的假仓：roles/tool-face.json ＋ 整份包模板 */
function fakeRepo({ ledger } = {}) {
  const d = mkdtempSync(path.join(tmpdir(), 'nf-wbagent-'))
  mkdirSync(path.join(d, 'roles'), { recursive: true })
  cpSync(TABLE_FILE, path.join(d, 'roles', 'tool-face.json'))
  cpSync(path.join(PLUGIN, 'wb-expert-starter'), path.join(d, 'wb-expert-starter'), { recursive: true })
  if (ledger) writeFileSync(path.join(d, LEDGER_REL), JSON.stringify(ledger, null, 2) + '\n')
  return d
}
/** 造一个"装机侧"的假包：装配产物的布局（顶层 references/ ＋ agents/），**没有 roles/** */
function fakePackage({ ledger } = {}) {
  const d = mkdtempSync(path.join(tmpdir(), 'nf-wbpkg-'))
  cpSync(path.join(PLUGIN, 'wb-expert-starter'), d, { recursive: true })
  if (!existsSync(path.join(d, 'references', 'carrier-deny.json'))) {
    throw new Error('夹具前提不成立：包模板里应当有 references/carrier-deny.json（装配产物的布局）')
  }
  if (ledger) writeFileSync(path.join(d, 'references', 'carrier-deny.json'), JSON.stringify(ledger, null, 2) + '\n')
  return d
}
const run = (root, args) => spawnSync(process.execPath, [SCRIPT, '--root', root, ...args], { encoding: 'utf8' })
const both = (r) => String(r.stdout || '') + String(r.stderr || '')

/** 能力表里所有 CodeBuddy 名字：可渲的（tools）与不可渲的（ineffective/candidates） */
function nameSets(table) {
  const ok = new Set(), forbidden = new Set()
  for (const cap of Object.values(table.capabilities || {})) {
    for (const leaf of Object.values(cap.codebuddy || {})) {
      if (!leaf || typeof leaf !== 'object') continue
      for (const n of leaf.tools || []) ok.add(n)
      for (const n of leaf.ineffective || []) forbidden.add(n)   // C 桶：拦不住
      for (const n of leaf.costly || []) forbidden.add(n)        // B 桶：拦得住但有代价（2026-09-23 加）
      for (const n of leaf.candidates || []) forbidden.add(n)
    }
  }
  return { ok, forbidden }
}

// ── ① 真件自洽：封名单只由"已核实生效"的名字组成
test('载体封名单：每个名字都在能力表里、且都不是实测拦不住的', () => {
  const { ok, forbidden } = nameSets(realTable())
  const led = realLedger()
  assert.equal(Object.keys(led.roles).length, 7, '七个角色一个都不能少——少一个就是"这个人的定义没人渲"')
  let total = 0
  for (const [rid, e] of Object.entries(led.roles)) {
    for (const n of e.denyNames) {
      total++
      assert.ok(!forbidden.has(n), rid + ' 的封名单里有实测拦不住/仅候选的名字：「' + n + '」——写进去只会得到虚假的约束感')
      assert.ok(ok.has(n), rid + ' 的封名单里有能力表不认识的名字：「' + n + '」——本形态下不报错、静默空转')
    }
  }
  assert.ok(total > 0, '一个名字都没渲出来？那这份清单等于空转')
  // 反向：能力表里"拦不住的真名字"必须原样带在 skipped 里（缺口要被印出来，不是被丢掉）
  const reader = led.roles.reader
  assert.ok(reader.skipped.some((s) => s.status === 'ineffective'), '试读员的缺口（PowerShell）必须留在派生件里——静默丢掉＝下一个人会再写一次')
})

// ── ② 真件自洽：豁免逐条带理由，且都真的在被封列表里
test('载体封名单：豁免项必须真的被封过、且逐条带理由', () => {
  const table = realTable()
  const led = realLedger()
  for (const [rid, e] of Object.entries(led.roles)) {
    for (const x of e.exempted || []) {
      assert.ok(table.roles[rid].deny.includes(x.cid), rid + ' 豁免了「' + x.cid + '」，可它本来就不在 deny 里——豁免表只许写真被封过的能力')
      assert.ok(String(x.why || '').trim().length > 20, rid + ' 豁免「' + x.cid + '」的理由太短或为空——没理由的豁免就是漏封')
      assert.ok(!e.denyNames.includes(x.cid), rid + ' 的「' + x.cid + '」既在封名单又在豁免表里（两处口径打架）')
    }
  }
  // 现实例：主笔豁免 fs.search（Glob/Grep）——WB 侧运行时裁定的那条，必须有据可查
  const a = led.roles.author
  assert.deepEqual(a.exempted.map((x) => x.cid), ['fs.search'])
  assert.ok(!a.denyNames.includes('Glob') && !a.denyNames.includes('Grep'), '主笔的 Glob/Grep 应处于"有意不封"，不是"悄悄没渲"')
  assert.ok(a.denyNames.includes('Bash'), '主笔的 Bash 应被封——它是一条能把账本文件直接改掉的旁路')
})

// ── ③ 硬约束：包内 agent 定义里不许出现 disallowedTools
test('包内 agents/*.md 零 disallowedTools（官方校验器做子串判断，渲进去立刻不合规）', () => {
  const files = readdirSync(AGENTS_DIR).filter((f) => f.endsWith('.md'))
  assert.ok(files.length >= 2, '包内 agent 定义不见了？先确认路径再改断言')
  for (const f of files) {
    const t = readFileSync(path.join(AGENTS_DIR, f), 'utf8')
    const fm = t.slice(0, t.indexOf('\n---', 4) + 1)
    assert.ok(!fm.includes('disallowedTools'), f + ' 的前言块里出现了 disallowedTools——封名单只能住宿主载体，渲进包内 MD 会立刻不合规')
  }
})

// ── ④ 负例：塞一个"实测拦不住"的名字 ⇒ 拒渲
test('安装器拒渲：封名单里混进实测拦不住的名字（PowerShell）', () => {
  const led = realLedger()
  led.roles.author.denyNames = led.roles.author.denyNames.concat(['PowerShell'])
  const d = fakeRepo({ ledger: led })
  try {
    const r = run(d, ['--dir', path.join(d, 'carrier')])
    assert.equal(r.status, 2, '应当以"没检查成"(2) 退出，实际 ' + r.status + '：' + both(r))
    assert.match(both(r), /PowerShell/)
    assert.match(both(r), /拒渲/)
  } finally { rmSync(d, { recursive: true, force: true }) }
})

// ── ④b 负例：名字不在能力表里（拼错/抄了别宿主）⇒ 拒渲
test('安装器拒渲：封名单里混进能力表不认识的名字', () => {
  const led = realLedger()
  led.roles.reader.denyNames = led.roles.reader.denyNames.concat(['pwsh'])
  const d = fakeRepo({ ledger: led })
  try {
    const r = run(d, ['--dir', path.join(d, 'carrier')])
    assert.equal(r.status, 2)
    assert.match(both(r), /静默空转/)
  } finally { rmSync(d, { recursive: true, force: true }) }
})

// ── ⑤ 负例：豁免缺理由 ⇒ 拒渲
test('安装器拒渲：豁免项没有理由', () => {
  const led = realLedger()
  led.roles.author.exempted = [{ cid: 'fs.search', names: ['Glob', 'Grep'], why: '   ' }]
  const d = fakeRepo({ ledger: led })
  try {
    const r = run(d, ['--dir', path.join(d, 'carrier')])
    assert.equal(r.status, 2)
    assert.match(both(r), /豁免/)
  } finally { rmSync(d, { recursive: true, force: true }) }
})

// ── ⑥ 负例：正文源缺 `## 人格` 锚点 ⇒ 拒渲（不许猜位置）
test('安装器拒渲：正文源缺人格锚点', () => {
  const d = fakeRepo()
  try {
    const f = path.join(d, 'wb-expert-starter', 'references', 'roles', 'reader.md')
    writeFileSync(f, readFileSync(f, 'utf8').replace('## 人格', '## 角色设定'))
    const r = run(d, ['--dir', path.join(d, 'carrier')])
    assert.equal(r.status, 2)
    assert.match(both(r), /锚点/)
  } finally { rmSync(d, { recursive: true, force: true }) }
})

// ── ⑦ 陈旧门：没装 → 红；装上 → 绿；改真源后没重装 → 红
test('陈旧门 --check：缺件算红、装后一致、改过真源又变红', () => {
  const d = fakeRepo()
  const carrier = path.join(d, 'carrier')
  try {
    const miss = run(d, ['--dir', carrier, '--check'])
    assert.equal(miss.status, 1, '没装过必须报红（缺件也算红），不许报成通过')
    assert.match(both(miss), /缺文件/)

    const inst = run(d, ['--dir', carrier])
    assert.equal(inst.status, 0, '安装应成功：' + both(inst))
    const files = readdirSync(carrier)
    assert.equal(files.length, 7, '七个角色七份载体，实得 ' + files.length + '：' + files.join(','))

    const okc = run(d, ['--dir', carrier, '--check'])
    assert.equal(okc.status, 0, '刚装完必须一致：' + both(okc))

    // 改真源（派生件）→ 载体停在旧样子 ⇒ 陈旧门必须红
    const led = JSON.parse(readFileSync(path.join(d, LEDGER_REL), 'utf8'))
    led.roles.reader.description = '试读员：换了一句描述（模拟"改过真源没重装"）。'
    writeFileSync(path.join(d, LEDGER_REL), JSON.stringify(led, null, 2) + '\n')
    const stale = run(d, ['--dir', carrier, '--check'])
    assert.equal(stale.status, 1, '真源改过而未重装必须报陈旧——热加载意味着"装的时候对过"不作数')
    assert.match(both(stale), /不一致/)
  } finally { rmSync(d, { recursive: true, force: true }) }
})

// ── ⑧ 写盘边界：不碰目录里别人的文件；渲染件确实落在该目录
test('安装只写自己的 7 件，不碰同目录别人的文件', () => {
  const d = fakeRepo()
  const carrier = path.join(d, 'carrier')
  mkdirSync(carrier, { recursive: true })
  writeFileSync(path.join(carrier, 'someone-else.md'), '别的专家的定义\n')
  try {
    const r = run(d, ['--dir', carrier])
    assert.equal(r.status, 0)
    assert.ok(existsSync(path.join(carrier, 'someone-else.md')), '安装器把手伸到了别人的文件上')
    const t = readFileSync(path.join(carrier, 'author.md'), 'utf8')
    assert.match(t, /^---\nname: author\n/)
    assert.match(t, /disallowedTools: \[mcp__novelist__novel_chapter/)
    assert.ok(!t.includes('Glob,') && !t.includes('Glob]'), '主笔的 Glob 应处于"有意不封"，不该出现在名单里')
    assert.match(t, /## 人格/, '正文必须含人格段（从锚点起）')
    assert.ok(!t.includes('# 派工文本'), '载体不该把"派工文本"的用法头带进去——那是给主编看的，不是给这个 agent 看的')
  } finally { rmSync(d, { recursive: true, force: true }) }
})

// ── ⑨ 2026-09-23：登记了却渲不进去的**意图**，必须在输出里印出来
//
// 现场形状（WB 侧读数逼出来的）：四个盲角色的 deny 里写着 `fs.write`／`fs.edit`，而这两格在
// CodeBuddy 下是 `unknown`（不许渲）⇒ **名字一个都没渲出去、输出里也一个字没提**。
// 表观＝"看着配过"，实际＝那几个工具对本座一直开着：**静默少封一个名字**，
// 与静默封错一个名字同罪（两者都表现为"没报错"）。
test('安装器把三类"没进名单"的出口分开印出来（B 桶 / C 桶 / 空操作 / 未生效）', () => {
  const d = fakeRepo()
  const carrier = path.join(d, 'carrier')
  try {
    const r = run(d, ['--dir', carrier, '--check'])   // --check 也会打这份摘要
    const out = both(r)
    // C 桶（拦不住）与 B 桶（拦得住但有代价）都必须各有自己的行——**合并＝把两种相反的含义混成一种**
    assert.match(out, /缺口·C 桶/, 'C 桶必须走"缺口"那一条')
    assert.match(out, /缺口·B 桶/, 'B 桶必须走"代价缺口"那一条（2026-09-23 新增：它与 C 桶不是一回事）')
    assert.match(out, /PowerShell/, 'C 桶的代表 `PowerShell` 要点名（否则读者不知道该去封谁）')
    assert.match(out, /Write/, 'B 桶的代表 `Write` 要点名')
    assert.match(out, /空操作/, '"本形态没有这个工具"要单列一条（与缺口混在一起会把空操作读成已封）')
    // 反向：**已渲进名单**的能力不许被误报成"未生效"或缺口（否则出口退化成"所有 deny 都印一遍"）
    const noise = out.split('\n').filter((l) => /意图已登记|缺口/.test(l))
    assert.match(out, /缺口/, '这条用例的前提是确实存在缺口行')
    assert.ok(!out.split('\n').some((l) => /缺口/.test(l) && /`mcp__novelist__/.test(l)),
      'MCP 名是 A 桶、已渲进名单，不该出现在缺口行里：' + noise.join(' | '))
  } finally { rmSync(d, { recursive: true, force: true }) }

  // 合成的「未生效」：安装器**打印的内容全部来自派生件**（连 skipped 也在里面），所以夹具要改派生件。
  // 只改能力表不会影响打印（那条路只管"拒渲"核对）——这一点本身就是"两处各算一遍就会漂"的现场。
  const led = realLedger()
  led.roles.reader.skipped = led.roles.reader.skipped.concat([
    { cid: 'fs.read', status: 'unverified', candidates: ['Read'], why: '测试夹具：假装这一格还没核实' },
  ])
  const d2 = fakeRepo({ ledger: led })
  try {
    const r2 = run(d2, ['--dir', path.join(d2, 'carrier'), '--check'])
    const out2 = both(r2)
    assert.match(out2, /意图已登记/, '渲不进去的 deny 必须在输出里印出来，否则读的人以为已经封了')
    assert.match(out2, /fs\.read/, '要点名是哪一格能力（否则读者不知道该去封谁）')
    assert.match(out2, /仍然开着/, '要说清后果：名字没进名单之前，那件工具对本座仍然开着')
  } finally { rmSync(d2, { recursive: true, force: true }) }
})

// ── 2026-09-23：包侧模式（WB 侧 §5.2 实测：装机侧按我们给的两条命令一条都跑不起来）
//
// 现场：装机侧只有装配产物、**没有 `roles/`**，而旧版安装器把"含 `roles/tool-face.json` 的那一层"
// 当成仓根 ⇒ 装机侧一条命令都跑不了 ⇒ **拿到包的人无法独立核对他机上装的东西**。
// 本组锁三件：①包侧能渲/能装/能跑陈旧门；②**包侧必须明说它核不了什么**（否则"全绿"会被读成"与真源一致"）；
// ③**跨布局不许被报成"陈旧"**——装配器会改写源仓坐标，两个布局下正文段本就不逐字相同，
//   不区分的话，读的人会照着"重装"提示把载体悄悄换成另一种坐标。
test('包侧模式：无 roles/ 也能跑，且必须明说它核不了什么', () => {
  const d = fakePackage()
  const carrier = path.join(d, 'carrier')
  try {
    const r = run(d, ['--dir', carrier])
    const out = both(r)
    assert.equal(r.status, 0, '包侧必须能装：' + out)
    assert.match(out, /运行形态：包侧/, '要说清这次跑在哪种形态（读者才知道手里的"绿"是哪一种绿）')
    assert.match(out, /核不了/, '包侧核不了什么必须印出来——否则"全绿"会被读成"与真源一致"')
    assert.match(out, /这份派生件是否等于真源/, '要点名第一条核不了的：派生件 vs 真源')
    assert.match(out, /属于哪一格能力/, '要点名第二条核不了的：名字的归属')
    // 载体要带布局标记，否则陈旧门没法把"跨布局"与"真陈旧"分开
    const files = readdirSync(carrier).filter((f) => f.endsWith('.md'))
    assert.equal(files.length, 7, '七件都要渲出来：' + files.join('/'))
    assert.match(readFileSync(path.join(carrier, 'reader.md'), 'utf8'), /渲染来源：\*\*包内\*\*/, '载体必须记下渲染来源的布局')
  } finally { rmSync(d, { recursive: true, force: true }) }
})

test('陈旧门：跨布局报「·」且不红；同布局正文段不同才是真陈旧', () => {
  const pkg = fakePackage()
  const repo = fakeRepo()
  const dirA = path.join(pkg, 'carrierA')
  const dirB = path.join(repo, 'carrierB')
  try {
    // ① 仓侧渲一份（标记"仓内"），再拿包侧去 --check ⇒ 应报"跨布局未比"且 **exit 0**
    assert.equal(run(repo, ['--dir', dirB]).status, 0, '仓侧先装一份')
    const cross = run(pkg, ['--dir', dirB, '--check'])
    const outC = both(cross)
    assert.equal(cross.status, 0, '跨布局**不是**陈旧，不许红（红了会诱导人重装、把坐标悄悄换掉）：' + outC)
    assert.match(outC, /名单一致/, '跨布局时**名单**那半仍必须严格比（它是布局无关的承重面）')
    assert.match(outC, /跨布局未比/, '要说清哪半没比、为什么')
    assert.match(outC, /这不是陈旧/, '要正面否掉"陈旧"这个读法')

    // ② 同布局、名单相同、正文段被人动过 ⇒ 真陈旧，必须红
    assert.equal(run(pkg, ['--dir', dirA]).status, 0, '包侧装一份')
    writeFileSync(path.join(dirA, 'reader.md'), readFileSync(path.join(dirA, 'reader.md'), 'utf8') + '\n手改的一行\n')
    const drift = run(pkg, ['--dir', dirA, '--check'])
    assert.equal(drift.status, 1, '同布局正文段不同＝真陈旧，必须 exit 1：' + both(drift))
    assert.match(both(drift), /正文段不同/, '要指出是哪一种不一致')

    // ③ 名单被动过 ⇒ 也红（承重面不一致；这一半跨布局也要比——见 ①）
    writeFileSync(path.join(dirA, 'proofer.md'),
      readFileSync(path.join(dirA, 'proofer.md'), 'utf8').replace(/^disallowedTools: \[/m, 'disallowedTools: [Read, '))
    const drift2 = run(pkg, ['--dir', dirA, '--check'])
    assert.equal(drift2.status, 1, '名单不一致必须 exit 1：' + both(drift2))
    assert.match(both(drift2), /名单与真源不一致/, '要说清是承重那半变了')
  } finally { rmSync(pkg, { recursive: true, force: true }); rmSync(repo, { recursive: true, force: true }) }
})

test('包侧缺 `_forbidden` ⇒ 拒跑（少了它那道拒渲核对就形同虚设）', () => {
  const led = realLedger()
  delete led._forbidden
  const d = fakePackage({ ledger: led })
  try {
    const r = run(d, ['--dir', path.join(d, 'carrier'), '--check'])
    assert.equal(r.status, 2, '缺 _forbidden 必须 exit 2（不许"没有就跳过"）：' + both(r))
    assert.match(both(r), /_forbidden/, '要点名缺的是哪一节')
  } finally { rmSync(d, { recursive: true, force: true }) }
})
