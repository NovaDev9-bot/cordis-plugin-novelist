/**
 * e2e-acceptance.test.mjs —— 真书工程端到端验收（2026-09-20，Owner 令）
 *
 * 为什么要有它：一批"未复验"项（ISS-06 **行为级**、novel_init→章→verify 全链、四个仪器第一次吃真书）
 * 此前卡在"没有真书"上。其实**造一本一次性真书**就能验——数据是模拟的，**代码路径全是真的**：
 * 真进程（spawn server + 真 JSON-RPC）+ 真 fs + 真账本。造出来的书全在 tmpdir，`t.after` 即删。
 *
 * 覆盖四段（每段都能红）：
 *   ① 全链：建书 → 章纲 → 两章正文（伏笔/时间线/出场/章末钩子）→ verify
 *   ② ISS-06 **行为级**：造真冲突（同名两版本、窗口重叠、值不同）→ 按 target 生效窗裁决 →
 *      读回账本核对「被定位那条改了、首条同名没动」（此前只有单测级覆盖）
 *   ③ ISS-06 legacy 分支：把冲突事件的 target 抹掉（＝修复前写下的旧事件）→ 同名多条时**拒写**
 *   ④ REC-05 链：派工包 → 输入哈希清单 → 复算一致；改一个字节 → 必须对不上（"输入污染"能红）
 *   ⑤ 四个零 LLM 仪器吃真书：style-check / structure-check / batch-report / instrument-aggregate
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { spawn, spawnSync } from 'node:child_process'
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const PLUGIN = join(HERE, '..')
const SERVER = join(PLUGIN, 'mcp', 'server.mjs')
const INSTR = join(PLUGIN, 'instruments')
const PROTO = '2025-06-18'

/** 真进程客户端：spawn server，按行收发 JSON-RPC（与宿主接法同构）。 */
function client(t, args) {
  const child = spawn(process.execPath, [SERVER, ...args], { stdio: ['pipe', 'pipe', 'pipe'] })
  t.after(() => { try { child.kill('SIGKILL') } catch { /* 已退出 */ } })
  let buf = ''
  let stderr = ''
  const queue = []
  const waiters = []
  child.stdout.on('data', (d) => {
    buf += d
    let i
    while ((i = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, i)
      buf = buf.slice(i + 1)
      if (!line.trim()) continue
      try { const m = JSON.parse(line); const w = waiters.shift(); if (w) w(m); else queue.push(m) } catch { /* 非 JSON 行忽略 */ }
    }
  })
  child.stderr.on('data', (d) => { stderr += d })
  const next = (ms = 20_000) => (queue.length ? Promise.resolve(queue.shift()) : new Promise((res, rej) => {
    const timer = setTimeout(() => rej(new Error('server 超时；stderr=' + stderr.slice(0, 400))), ms)
    waiters.push((m) => { clearTimeout(timer); res(m) })
  }))
  let id = 0
  /** 调一次工具；工具级错误（isError）**不抛**，由调用方断言——它本身是被测行为。 */
  const raw = async (name, a) => {
    const myId = ++id
    child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id: myId, method: 'tools/call', params: { name, arguments: a } }) + '\n')
    const resp = await next()
    assert.equal(resp.id, myId, '响应 id 必须对上：' + JSON.stringify(resp).slice(0, 200))
    return resp.result
  }
  const call = async (name, a) => {
    const r = await raw(name, a)
    assert.equal(r.isError, false, name + ' 不该失败：' + JSON.stringify(r).slice(0, 400))
    const t0 = r.content.map((x) => x.text).join('\n')
    try { return JSON.parse(t0) } catch { return t0 }
  }
  return { child, call, raw, stderrText: () => stderr, rpc: async (method, params) => {
    const myId = ++id
    child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id: myId, method, ...(params ? { params } : {}) }) + '\n')
    return next()
  } }
}

/** 模拟真实正文：够长、有对话有动作、每章开头不同（避免重复提交被判重）。 */
function chapterText(seedLine, repeats = 46) {
  const paras = [
    '雨点砸在铁皮棚顶上，声音像有人从上往下数铜钱。他站在门口没有进去，先看了一眼那双沾泥的鞋。',
    '“这条巷子昨晚上有人抬东西出去。”老人说这句话的时候没有看他，眼睛盯着灶膛里那点将灭的火。',
    '他把手里的纸摊开又合上，指腹在那道折痕上来回蹭了三遍，才开口问了一句价钱。',
    '巷口那盏路灯忽明忽暗，墙上的影子跟着一起晃，像有个人贴着墙根走了一整夜，始终没走到头。',
    '钱是要还的，这话他从小听到大。可他没想到，要还的是这样一笔——借条上按的手印，他认得。',
    '他退出去时回头看了一眼，帘子后面没有人，只有一张空凳子和凳子上一圈还没散的热气。',
  ]
  return [seedLine, ...Array.from({ length: repeats }, (_, i) => paras[i % paras.length])].join('\n')
}

/** 建一本一次性的书（真进程、真 fs），返回 { root, dir, c }。 */
async function makeBook(t, tag) {
  const root = mkdtempSync(join(tmpdir(), 'nf-acc-' + tag + '-'))
  t.after(() => rmSync(root, { recursive: true, force: true }))
  const c = client(t, ['--root', root])
  const dir = join(root, '验收书')
  await c.call('novel_init', { book_dir: dir, title: '验收书', genre: 'xuanyi', logline: '他只想把欠的钱还上，可这条巷子不让他还' })
  return { root, dir, c }
}

// ── ① 全链 ──────────────────────────────────────────────────────────────────
test('端到端①：真进程建书 → 章纲 → 两章正文 → verify（全链真跑）', async (t) => {
  const { dir, c } = await makeBook(t, 'chain')
  await c.call('novel_outline', {
    book_dir: dir, op: 'write', volume: 1, ch: 1,
    entry: { title: '巷子里的账', goal: '主角发现借钱的人三年前就死了', hook: '账本上多出一行他自己没写过的字', word_min: 1500, word_max: 3200 },
  })
  await c.call('novel_outline', {
    book_dir: dir, op: 'write', volume: 1, ch: 2,
    entry: { title: '第二把钥匙', goal: '主角拿到死者留下的钥匙', hook: '钥匙能打开的柜子里是空的，但柜底有新的划痕', word_min: 1500, word_max: 3200 },
  })
  const r1 = await c.call('novel_chapter', {
    book_dir: dir, ch: 1, title: '巷子里的账',
    text: chapterText('第一章 巷子里的账\n'),
    cast: ['陈默', '老周'],
    seeds: [{ id: 't001', name: '多出来的那一行字', due_ch: 6 }],
    hook: { what: '账本上多出一行不是他写的字', why: '读者要知道那是谁写的' },
    timeline_events: [{ time: '第三天夜里', what: '陈默第一次走进那条巷子' }],
  })
  // 写章返回的是**可读回执文本**（不是 JSON 对象）：从回执里取 rev 与字数
  assert.match(String(r1), /已落盘/, '写章应回可读回执：' + String(r1).slice(0, 240))
  assert.ok(Number((String(r1).match(/rev (\d+)/) || [])[1]) >= 1, '回执必须带 rev：' + String(r1).slice(0, 240))
  assert.ok(Number((String(r1).match(/(\d+) 汉字/) || [])[1]) > 1500, '回执必须带实测汉字数：' + String(r1).slice(0, 240))
  const r2 = await c.call('novel_chapter', {
    book_dir: dir, ch: 2, title: '第二把钥匙',
    text: chapterText('第二章 第二把钥匙\n'),
    cast: ['陈默'],
    closes: ['t001'],
    hook: { what: '柜子是空的，柜底却有新的划痕', why: '空柜子比满柜子更让人不安' },
  })
  assert.match(String(r2), /已落盘/, '第二章也要落盘回执：' + String(r2).slice(0, 240))
  // 正文真落盘
  const ch1 = readFileSync(join(dir, 'manuscript', 'chapter_001.md'), 'utf8')
  assert.ok((ch1.match(/[\u4e00-\u9fff]/g) || []).length > 1500, '第一章正文汉字数应过 1500')
  // verify 全量：不判好坏只记账，必须能跑完并给出条目
  const v = await c.call('novel_verify', { book_dir: dir })
  const vs = JSON.stringify(v)
  assert.ok(vs.length > 2, 'verify 必须有输出（不许空对象）：' + vs.slice(0, 200))
  t.diagnostic('verify 首段：' + vs.slice(0, 300))
  // verify 真的在按门查：这本模拟书**故意没给**卷首章必答字段（differentiation/choice_axis），
  // 它就该当场报出来——"仪器跑完且发现了该发现的"，比"跑完没崩"强一档
  assert.ok(Array.isArray(v.issues) && v.issues.some((s) => /differentiation/.test(s)),
    'verify 应报出卷首章缺必答字段（证明门真在跑）：' + JSON.stringify(v.issues))
  // 章状态机：两章都在账上
  const st = JSON.parse(readFileSync(join(dir, 'status.json'), 'utf8'))
  assert.ok(st['1'] && st['2'], '两章都要在状态账上：' + JSON.stringify(st))
  // 事件账（events.jsonl）记写章；事件带（editorial/events-tape.jsonl）记钩子（v7.9 起 kind=hook 并入事件带）
  const readLines = (p) => readFileSync(p, 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l))
  const ledgerEv = readLines(join(dir, 'events.jsonl'))
  assert.ok(ledgerEv.some((e) => e.op === 'chapter_commit'), '事件账要有写章条目：' + JSON.stringify(ledgerEv.map((e) => e.op)))
  const tape = readLines(join(dir, 'editorial', 'events-tape.jsonl'))
  assert.ok(tape.some((e) => e.kind === 'hook'), '章末钩子要进事件带（kind=hook）：' + JSON.stringify(tape.map((e) => e.kind || e.op)))
  assert.ok(tape.some((e) => e.kind === 'hook' && e.ch === 1), '钩子要带章号坐标：' + JSON.stringify(tape.filter((e) => e.kind === 'hook')))
})

// ── ②③ ISS-06 行为级 ────────────────────────────────────────────────────────
test('端到端②：真冲突按 target 生效窗裁决——被定位那条改、首条同名不动（ISS-06 行为级）', async (t) => {
  const { dir, c } = await makeBook(t, 'conflict')
  const led = (a) => c.call('novel_ledger', Object.assign({ book_dir: dir, op: 'update_term' }, a))
  // 两条版本记录：窗口不重叠＝口径演进
  await led({ term: { name: '青玉令', value: '见令如见人', effective_from_ch: 1, effective_to_ch: 10 } })
  await led({ term: { name: '青玉令', value: '见令如见鬼', effective_from_ch: 11 } })
  // 真冲突：新值落在**第二条**（窗口 11+）里
  const conf = await led({ term: { name: '青玉令', value: '第三口径', effective_from_ch: 12 } })
  assert.equal(conf.ok, false, '窗口重叠且值不同＝真冲突：' + JSON.stringify(conf).slice(0, 300))
  assert.deepEqual(conf.result.conflict.target, { effective_from_ch: 11, effective_to_ch: null }, '冲突必须带被冲突记录的 target 坐标')
  const r = await c.call('novel_ledger', {
    book_dir: dir, op: 'resolve_conflict',
    conflict: { id: conf.result.conflict.id, scope: 'semantic', verdict: 'accept_new', stance: '采信新值', evidence: 'ch12 正文与旧口径矛盾' },
  })
  assert.equal(r.ok, true, '裁决应成功：' + JSON.stringify(r))
  const rows = JSON.parse(readFileSync(join(dir, 'bible.json'), 'utf8')).terms.filter((x) => x.name === '青玉令')
  assert.equal(rows.length, 2, '裁决只改值，不新增/删除版本记录')
  assert.equal(rows[0].value, '见令如见人', '**首条同名记录不许被改写**（旧实现的静默错写就在这）')
  assert.equal(rows[1].value, '第三口径', '被冲突的那条（窗口 11+）才该被改写')
})

test('端到端③：legacy 冲突事件（无 target）＋同名多条 → 拒写并说明（ISS-06 legacy 分支）', async (t) => {
  const { dir, c } = await makeBook(t, 'legacy')
  const led = (a) => c.call('novel_ledger', Object.assign({ book_dir: dir, op: 'update_term' }, a))
  await led({ term: { name: '断魂钉', value: '铜制', effective_from_ch: 1, effective_to_ch: 10 } })
  await led({ term: { name: '断魂钉', value: '铁制', effective_from_ch: 11 } })
  const conf = await led({ term: { name: '断魂钉', value: '木制', effective_from_ch: 12 } })
  assert.equal(conf.ok, false)
  // 抹掉 target ＝ 模拟修复前写下的旧事件（旧账本里就是没有这个字段）
  const tapePath = join(dir, 'events.jsonl')
  const lines = readFileSync(tapePath, 'utf8').trim().split('\n').map((l) => {
    const e = JSON.parse(l)
    if (e.op === 'conflict') delete e.target
    return JSON.stringify(e)
  })
  writeFileSync(tapePath, lines.join('\n') + '\n', 'utf8')
  const r = await c.raw('novel_ledger', {
    book_dir: dir, op: 'resolve_conflict',
    conflict: { id: conf.result.conflict.id, scope: 'semantic', verdict: 'accept_new', stance: '采信新值', evidence: 'ch12' },
  })
  assert.equal(r.isError, true, '同名多条 + 无 target ＝ 判不出写哪条，必须拒写而不是猜：' + JSON.stringify(r).slice(0, 300))
  const msg = r.content.map((x) => x.text).join('\n')
  assert.match(msg, /拒写|无法判定/, '拒写要说清原因：' + msg.slice(0, 300))
  const rows = JSON.parse(readFileSync(join(dir, 'bible.json'), 'utf8')).terms.filter((x) => x.name === '断魂钉')
  assert.deepEqual(rows.map((x) => x.value), ['铜制', '铁制'], '拒写＝账本一个字节都不许动')
})

// ── ④ REC-05：输入哈希清单能红 ──────────────────────────────────────────────
test('端到端④：派工包输入哈希清单——复算一致；改一个字节即对不上（能红）', async (t) => {
  const root = mkdtempSync(join(tmpdir(), 'nf-acc-manifest-'))
  t.after(() => rmSync(root, { recursive: true, force: true }))
  const pack = join(root, '派工包')
  mkdirSync(pack, { recursive: true })
  writeFileSync(join(pack, '正文包1.md'), '第一章 正文片段……\n', 'utf8')
  writeFileSync(join(pack, '档案.md'), '读者档案八条……\n', 'utf8')
  const MAN = join(INSTR, 'blind-manifest.mjs')
  const out1 = join(root, 'm1.json')
  const run = (out) => spawnSync(process.execPath, [MAN, pack, '--out', out], { encoding: 'utf8', cwd: root })
  assert.equal(run(out1).status, 0)
  const m1 = JSON.parse(readFileSync(out1, 'utf8'))
  // 复算：同一输入再来一次必须同哈希（这就是"交付件回填 root_hash"能对上的前提）
  const out2 = join(root, 'm2.json')
  assert.equal(run(out2).status, 0)
  const m2 = JSON.parse(readFileSync(out2, 'utf8'))
  assert.equal(m1.root_hash, m2.root_hash, '同输入复算必须同 root_hash')
  assert.equal(m1.files.length, 2)
  // 改一个字节（＝盲角色读了别的版本 / 包被事后动过）→ 必须对不上
  writeFileSync(join(pack, '正文包1.md'), '第一章 正文片段…。\n', 'utf8')
  const out3 = join(root, 'm3.json')
  assert.equal(run(out3).status, 0)
  const m3 = JSON.parse(readFileSync(out3, 'utf8'))
  assert.notEqual(m1.root_hash, m3.root_hash, '一个字节变了 root_hash 必须变——"输入污染"要靠这条能红')
})

// ── ⑤ 四个零 LLM 仪器第一次吃真书 ───────────────────────────────────────────
test('端到端⑤：四个仪器吃同一本真书（建书后即跑，输出可解析）', async (t) => {
  const { dir, c } = await makeBook(t, 'instr')
  await c.call('novel_outline', {
    book_dir: dir, op: 'write', volume: 1, ch: 1,
    entry: { title: '巷子里的账', goal: '发现借钱的人已死', hook: '账本上多出一行字', word_min: 1500, word_max: 3200 },
  })
  await c.call('novel_chapter', {
    book_dir: dir, ch: 1, title: '巷子里的账',
    text: chapterText('第一章 巷子里的账\n'),
    cast: ['陈默'], seeds: [{ id: 't001', name: '多出来的那一行字', due_ch: 6 }],
    hook: { what: '账本上多出一行不是他写的字', why: '读者要知道是谁写的' },
  })
  // 判词账喂**真实形状**的数据（{ch,dim,judge,mode,score}）——仪器要吃的是真数据，不是空账：
  // 空账只能证明"它不崩"，喂真数据才证明"它算得对"（两种取值分布 + 成对判 + 恒定输出都要出现）
  mkdirSync(join(dir, 'editorial'), { recursive: true })
  const scoreLines = [
    { ch: 1, dim: '钩子', judge: 'j1', mode: 'absolute', score: 4 },
    { ch: 1, dim: '钩子', judge: 'j2', mode: 'absolute', score: 3 },
    { ch: 1, dim: '三问', judge: 'j1', mode: 'absolute', score: 2 },
    { ch: 1, dim: '三问', judge: 'j2', mode: 'absolute', score: 4 },
    { ch: 1, dim: '人味', judge: 'j1', mode: 'absolute', score: 3 },
    { ch: 1, dim: '人味', judge: 'j2', mode: 'absolute', score: 3 },
    { ch: 1, dim: '钩子', judge: 'j1', mode: 'anchored_pair', score: 1 },
    { ch: 1, dim: '钩子', judge: 'j2', mode: 'anchored_pair', score: 0 },
  ]
  writeFileSync(join(dir, 'editorial', 'scores.jsonl'), scoreLines.map((x) => JSON.stringify(x)).join('\n') + '\n', 'utf8')
  const run = (script, args) => spawnSync(process.execPath, [join(INSTR, script), ...args], { encoding: 'utf8' })
  const cases = [
    ['style-check.mjs', [join(dir, 'manuscript', 'chapter_001.md')], /汉字|句|词/],
    ['structure-check.mjs', [dir], /章|结构|开合/],
    ['batch-report.mjs', [dir], /章|伏笔|事件/],
    ['instrument-aggregate.mjs', [dir], /条判词/],
  ]
  for (const [script, args, sentinel] of cases) {
    const r = run(script, args)
    const out = String(r.stdout || '') + String(r.stderr || '')
    assert.equal(r.status, 0, script + ' 吃真书应 exit 0，实得 ' + r.status + '：' + out.slice(0, 400))
    assert.match(out, sentinel, script + ' 输出应可读（含 ' + sentinel + '）：' + out.slice(0, 400))
  }
  // 聚合仪器必须**真算**：均值/取值分布/成对胜率/恒定仪表标注都要对上
  const rep = JSON.parse(readFileSync(join(dir, 'editorial', 'instrument-report.json'), 'utf8'))
  assert.equal(rep.scores_total, scoreLines.length, '判词总数要对上：' + rep.scores_total)
  assert.equal(rep.dims['钩子'].n, 2)
  assert.equal(rep.dims['钩子'].mean, 3.5, '均值要真算出来：' + JSON.stringify(rep.dims['钩子']))
  assert.deepEqual(rep.dims['三问'].distinct_values, [2, 4], '取值分布要对上')
  assert.equal(rep.dims['人味'].instrument && /constant/.test(rep.dims['人味'].instrument), true, '恒定输出的维度必须被标注为常数仪表（假绿防线）')
  assert.equal(rep.anchored_pair.n, 2)
  assert.equal(rep.anchored_pair.win_rate, 50, '成对胜率要真算：' + JSON.stringify(rep.anchored_pair))
})
