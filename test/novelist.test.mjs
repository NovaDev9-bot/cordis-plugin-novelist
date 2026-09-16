// 单元测试（node:test，零依赖）：只测确定性内核——字数口径、符号门、章文件名、
// 状态机迁移表完整性。工具执行路径依赖 DSH fs 服务（运行时注入），不在单测范围。
import test from 'node:test'
import assert from 'node:assert/strict'
import { name, inject, apply, _internals } from '../lib/novelist.js'

const { countHan, symbolGate, chapterFile, chapterTitle, CHAPTER_STATES, CHAPTER_TRANSITIONS, TOOLS, loadJson } = _internals

test('module shape: name / inject / apply', () => {
  assert.equal(name, 'novelist')
  assert.deepEqual(inject, ['tools', 'systemPrompt'])
  assert.equal(typeof apply, 'function')
})

test('tool registry: 12 tools, expected names, write tools carry timeoutMs', () => {
  assert.equal(TOOLS.length, 12)
  const names = TOOLS.map((t) => t.name)
  assert.deepEqual(names, [
    'novel_init', 'novel_outline', 'novel_bible', 'novel_chapter',
    'novel_verify', 'novel_count', 'novel_ledger', 'novel_event', 'novel_score', 'novel_ask', 'novel_decide', 'novel_assemble',
  ])
  for (const t of TOOLS) {
    if (['novel_init', 'novel_outline', 'novel_chapter', 'novel_ledger', 'novel_event', 'novel_score', 'novel_assemble'].includes(t.name)) {
      assert.ok(t.timeoutMs > 0, t.name + ' 应声明 timeoutMs')
    }
    assert.equal(typeof t.execute, 'function', t.name + ' 应有 execute')
  }
})

test('countHan: 只数汉字（发布口径）', () => {
  assert.equal(countHan(''), 0)
  assert.equal(countHan('abc 123'), 0)
  assert.equal(countHan('你好世界'), 4)
  assert.equal(countHan('第1章 开学'), 4) // 第/章/开/学，数字与空格不计
})

test('sanitizeOwn: 过滤原型污染键（__proto__/constructor/prototype），其余保留（2026-09-13 审查批）', () => {
  const { sanitizeOwn } = _internals
  // JSON.parse 产生的 __proto__ 是自有键——合并前必须滤除，否则 Object.assign 走 [[Set]] 改目标原型
  const payload = JSON.parse('{"name":"林渡","gender":"男","__proto__":{"polluted":true},"constructor":{"x":1},"prototype":1}')
  const clean = sanitizeOwn(payload)
  assert.deepEqual(Object.keys(clean).sort(), ['gender', 'name'])
  // 直接验证向量被封死：合并进既有对象后原型未变
  const existing = { name: '林渡', gender: '女' }
  Object.assign(existing, sanitizeOwn(payload))
  assert.equal(Object.getPrototypeOf(existing), Object.prototype)
  assert.ok(!('polluted' in {}))
  assert.equal(existing.gender, '男')
})

test('symbolGate: 字数偏离章纲区间只报 issue 不拦稿', () => {
  const under = symbolGate('短文', { word_min: 1000, word_max: 3000 })
  assert.equal(under.han, 2)
  assert.equal(under.issues.length, 1)
  assert.ok(under.issues[0].includes('低于'))

  const over = symbolGate('字'.repeat(3500), { word_min: 1000, word_max: 3000 })
  assert.equal(over.han, 3500)
  assert.ok(over.issues[0].includes('高于'))

  const inWindow = symbolGate('字'.repeat(2000), { word_min: 1000, word_max: 3000 })
  assert.deepEqual(inWindow.issues, [])

  const noOutline = symbolGate('任意长短', null)
  assert.deepEqual(noOutline.issues, [])
})

test('loadJson: 缺失→null；损坏→大声报错（拒当空账本重建）', async () => {
  const files = {
    '/b/bible.json': '{"terms":[] 后缀垃圾整体损坏',
    '/b/ok.json': '{"terms":[]}',
  }
  const fs = {
    resolve: async (p) => p,
    stat: async (p) => (p in files ? {} : null),
    readText: async (p) => files[p],
  }
  assert.equal(await loadJson(fs, '/b', 'none.json'), null)
  assert.deepEqual(await loadJson(fs, '/b', 'ok.json'), { terms: [] })
  await assert.rejects(() => loadJson(fs, '/b', 'bible.json'), /账本文件损坏/)
})

test('readJsonlLines: 末行撕裂容忍（真追加崩溃语义）＋中段损坏大声报错（账不撕页）', async () => {
  const { readJsonlLines } = _internals
  const files = new Map()
  const fs = {
    resolve: async (p) => p,
    stat: async (p) => (files.has(p) ? {} : null),
    readText: async (p) => files.get(p),
    writeText: async (p, s) => { files.set(p, s) },
  }
  files.set('/x/a.jsonl', '{"a":1}\n{"b":2}\n{"torn":')
  assert.equal((await readJsonlLines(fs, '/x/a.jsonl')).length, 2, '末行残行应跳过')
  files.set('/x/b.jsonl', '{"a":1}\n完全不是JSON\n{"c":3}')
  await assert.rejects(() => readJsonlLines(fs, '/x/b.jsonl'), /中段损坏/)
  assert.equal((await readJsonlLines(fs, '/x/none.jsonl')).length, 0, '缺文件=空')
})

test('appendJsonlLine 行尾纪律: 首写必带换行（190 章压测实锤 bug 回归——首写无 \\n 则后续 os-append 并行成脏行）', async () => {
  const { appendJsonlLine } = _internals
  const files = new Map()
  const fs = { // 无 processPath → 强制走降级臂（首写分支）
    resolve: async (p) => p,
    stat: async (p) => (files.has(p) ? {} : null),
    readText: async (p) => files.get(p),
    writeText: async (p, s) => { files.set(p, s) },
  }
  const r1 = await appendJsonlLine(fs, '/x/t.jsonl', '{"a":1}')
  assert.equal(r1.mode, 'rmw-fallback')
  assert.ok(files.get('/x/t.jsonl').endsWith('\n'), '首写必须以换行收尾')
  const r2 = await appendJsonlLine(fs, '/x/t.jsonl', '{"b":2}')
  assert.equal(files.get('/x/t.jsonl'), '{"a":1}\n{"b":2}\n', '两行独立，无合并')
})

test('事件带 append 校验（kind/长度门/必填/open_thread 必带 closes）＋read 有界窗口（粘性留窗/计数/闭线对账防重）', async () => {
  const { appendTape, readTapeWindow } = _internals
  const files = new Map()
  const fs = {
    resolve: async (p) => String(p).replace(/\/+/g, '/'),
    stat: async (p) => (files.has(p) ? { size: files.get(p).length } : null),
    readText: async (p) => { if (!files.has(p)) throw new Error('ENOENT ' + p); return files.get(p) },
    writeText: async (p, s) => { files.set(p, s) },
  }
  const dir = '/books/tape-test'
  await assert.rejects(() => appendTape(fs, dir, { kind: 'bogus', what: 'x', why: 'y', actor: '主编' }), /kind 必须为/)
  await assert.rejects(() => appendTape(fs, dir, { kind: 'decision', what: 'x'.repeat(61), why: 'y', actor: '主编' }), /what 超 60/)
  await assert.rejects(() => appendTape(fs, dir, { kind: 'decision', what: 'x', why: '', actor: '主编' }), /why 必填/)
  await assert.rejects(() => appendTape(fs, dir, { kind: 'open_thread', what: '欠', why: '挂', actor: '主编' }), /closes/)

  const a1 = await appendTape(fs, dir, { kind: 'open_thread', what: '给信时机未定', why: '兑弃书线警示', actor: '主编', closes: 8 })
  assert.equal(a1.id, 't001')
  for (let i = 0; i < 20; i++) await appendTape(fs, dir, { kind: 'decision', what: '决策' + i, why: '节奏', actor: '主编', ch: i + 1 })
  const w = await readTapeWindow(fs, dir)
  assert.equal(w.total, 21)
  assert.ok(w.window.some((e) => e.id === 't001' && e.kind === 'open_thread'), '粘性条目（欠线）永不挤出窗口')
  assert.ok(w.window.filter((e) => e.kind === 'decision').length <= 12, '非粘性窗口 ≤12')
  assert.equal(w.counts.decision, 20)
  assert.equal(w.open_threads.length, 1)
  assert.ok(w.note.includes('计数化'), '更早条目计数化应有注')

  await appendTape(fs, dir, { kind: 'revision', what: '给信提前到 ch7', why: '兑现警示', actor: '主编', closes_thread: 't001' })
  await assert.rejects(() => appendTape(fs, dir, { kind: 'revision', what: '重复闭线', why: '误操作', actor: '主编', closes_thread: 't001' }), /已闭合过/)
  await assert.rejects(() => appendTape(fs, dir, { kind: 'revision', what: '闭未知线', why: '误操作', actor: '主编', closes_thread: 't999' }), /未知欠线/)
  const w2 = await readTapeWindow(fs, dir)
  assert.equal(w2.open_threads.length, 0, '闭线后欠线清单清空')
})

test('verify 扩展: 半提交嫌疑（正文在而 chapter_commit 无）＋事件带欠线逾期', async () => {
  const files = new Map()
  const fs = {
    resolve: async (p) => String(p).replace(/\/+/g, '/'),
    stat: async (p) => (files.has(p) ? { size: files.get(p).length } : null),
    readText: async (p) => { if (!files.has(p)) throw new Error('ENOENT ' + p); return files.get(p) },
    writeText: async (p, s) => { files.set(p, s) },
    listDir: async (p) => [...files.keys()].filter((k) => k.startsWith(p + '/')).map((k) => ({ name: k.slice(p.length + 1).split('/')[0] })),
  }
  const dir = '/books/verify-ext'
  files.set(dir + '/project.json', JSON.stringify({ current_ch: 3 }))
  files.set(dir + '/manuscript/chapter_001.md', '正文一')
  files.set(dir + '/manuscript/chapter_002.md', '正文二')
  files.set(dir + '/manuscript/chapter_003.md', '正文三')
  files.set(dir + '/editorial/events-tape.jsonl', JSON.stringify({ ts: 't', id: 't001', kind: 'open_thread', what: '欠线', why: '挂', closes: 2, actor: '主编' }))
  const exec = () => ({ agent: { ctx: { get: (k) => (k === 'fs' ? fs : undefined) } } })
  const verify = TOOLS.find((t) => t.name === 'novel_verify')
  const v = await verify.execute({ book_dir: dir }, exec())
  assert.ok(v.issues.some((s) => s.includes('半提交嫌疑：第 1 章')), JSON.stringify(v.issues))
  assert.ok(v.issues.some((s) => s.includes('事件带欠线逾期：t001')), JSON.stringify(v.issues))
})

test('判据账 novel_score: 落账-回读往返＋伪引文拒收（F-2 硬闸）＋模式校验', async () => {
  const files = new Map()
  const fs = {
    resolve: async (p) => String(p).replace(/\/+/g, '/'),
    stat: async (p) => (files.has(p) ? { size: files.get(p).length } : null),
    readText: async (p) => { if (!files.has(p)) throw new Error('ENOENT ' + p); return files.get(p) },
    writeText: async (p, s) => { files.set(p, s) },
  }
  const dir = '/books/score-test'
  files.set(dir + '/manuscript/chapter_001.md', '他推开了那扇门。门后站着一个不该出现的人，纸角又掀了一下。'.repeat(2))
  const exec = () => ({ agent: { ctx: { get: (k) => (k === 'fs' ? fs : undefined) } } })
  const call = (args) => TOOLS.find((t) => t.name === 'novel_score').execute(args, exec())

  // 真引文（含标点差异）通过
  const ok = await call({ book_dir: dir, op: 'record', ch: 1, dim: '钩子', score: 2, evidence: '纸角又掀了一下。', judge: '试读员', mode: 'absolute' })
  assert.equal(ok.ok, true)
  // 伪引文拒收（ok:false + rejected，不落账）
  const bad = await call({ book_dir: dir, op: 'record', ch: 1, dim: '钩子', score: 4, evidence: '这句话根本不在正文里出现好吗', judge: '试读员' })
  assert.equal(bad.ok, false)
  assert.ok(bad.rejected.includes('伪引文拒收'))
  // anchored_pair 分值域
  await assert.rejects(() => call({ book_dir: dir, op: 'record', ch: 1, dim: '钩子', score: 3, evidence: '纸角又掀了一下。', judge: '主编', mode: 'anchored_pair' }), /anchored_pair/)
  // 无引文拒收
  await assert.rejects(() => call({ book_dir: dir, op: 'record', ch: 1, dim: '钩子', score: 3, evidence: '', judge: '主编' }), /evidence 必填/)
  // 回读过滤
  files.set(dir + '/editorial/scores.jsonl', files.get(dir + '/editorial/scores.jsonl') || '')
  const rd = await call({ book_dir: dir, op: 'read', dim: '钩子' })
  assert.equal(rd.total, 1)
  assert.equal(rd.records[0].score, 2)
})

test('chapterFile / chapterTitle: 三位零填充往返', () => {
  assert.equal(chapterFile(1), 'chapter_001.md')
  assert.equal(chapterFile(99), 'chapter_099.md')
  assert.equal(chapterFile(127), 'chapter_127.md')
  assert.equal(chapterTitle('chapter_012.md'), 12)
  assert.equal(chapterTitle('note.md'), null)
})

test('chapter state machine: 迁移表封闭且单调（无跨闸跳跃）', () => {
  for (const from of Object.keys(CHAPTER_TRANSITIONS)) {
    assert.ok(CHAPTER_STATES.includes(from), '未知源状态：' + from)
    for (const to of CHAPTER_TRANSITIONS[from]) {
      assert.ok(CHAPTER_STATES.includes(to), from + ' → 未知目标：' + to)
    }
  }
  // 关键不变量：草稿不许直跳发表/定稿（必须过审读闸）
  assert.ok(!CHAPTER_TRANSITIONS['草稿'].includes('已发表'))
  assert.ok(!CHAPTER_TRANSITIONS['草稿'].includes('已定稿'))
  assert.ok(!CHAPTER_TRANSITIONS['已定稿'].includes('草稿'))
  // 打回链路存在
  assert.ok(CHAPTER_TRANSITIONS['待外审'].includes('已发表'))
  assert.ok(CHAPTER_TRANSITIONS['待外审'].includes('打回修订'))
  assert.ok(CHAPTER_TRANSITIONS['打回修订'].includes('待修订'))
})

test('integration: 全账本流程（init→outline→chapter→verify→count→assemble→状态机→冲突仲裁）', async () => {
  // 内存 fs shim：对齐 DSH fs 服务契约（resolve/stat/readText/writeText/listDir；stat 缺失返回 null）
  const files = new Map()
  const fs = {
    resolve: async (p) => String(p).replace(/\/+/g, '/'),
    stat: async (p) => (files.has(p) ? { size: files.get(p).length } : null),
    readText: async (p) => { if (!files.has(p)) throw new Error('ENOENT ' + p); return files.get(p) },
    writeText: async (p, s) => { files.set(p, s) },
    listDir: async (p) => [...files.keys()].filter((k) => k.startsWith(p + '/')).map((k) => ({ name: k.slice(p.length + 1).split('/')[0] })),
  }
  const exec = () => ({ agent: { ctx: { get: (k) => (k === 'fs' ? fs : undefined) } } })
  const call = (n, args) => { const t = TOOLS.find((x) => x.name === n); if (!t) throw new Error('no tool ' + n); return t.execute(args, exec()) }
  const dir = '/books/int-test'

  // init：骨架落地 + 带 schema_version
  const init = await call('novel_init', { book_dir: dir, title: '测试书', genre: 'xuanyi', logline: '一句话' })
  assert.equal(init.ok, true)
  assert.equal(JSON.parse(files.get(dir + '/project.json')).schema_version, 1)
  await assert.rejects(() => call('novel_init', { book_dir: dir, title: 'x', genre: 'x', logline: 'x' }), /书已存在/)

  // outline：卷首章缺差异化槽位应出 warn；补齐后 read 回得来
  const w1 = await call('novel_outline', { book_dir: dir, op: 'write', volume: 1, chapter_no: 1, entry: { title: '开篇', goal: 'g', hook: 'h', word_min: 5, word_max: 100 } })
  assert.ok(w1.warn && w1.warn.includes('differentiation'))
  await call('novel_outline', { book_dir: dir, op: 'write', volume: 1, chapter_no: 1, entry: { title: '开篇', goal: 'g', hook: 'h', word_min: 5, word_max: 100, differentiation: '与榜单头部不同：X' } })
  const r1 = await call('novel_outline', { book_dir: dir, op: 'read' })
  assert.equal(r1.outline.volumes[0].chapters[0].differentiation, '与榜单头部不同：X')

  // chapter：落盘 + 版本快照 + 伏笔幂等 + closes/cast 未知引用记 issue 不静默
  const ch = await call('novel_chapter', { book_dir: dir, ch: 1, title: '开篇', text: '他推开那扇门，里面空无一人。'.repeat(3), seeds: [{ id: 'F1', name: '空屋', due_ch: 3 }], closes: ['NOPE'], cast: ['无名'] })
  assert.equal(ch.ok, true)
  assert.ok(files.has(dir + '/manuscript/chapter_001.md'))
  assert.ok(ch.gate.issues.some((s) => s.includes('NOPE')))
  assert.ok(ch.gate.issues.some((s) => s.includes('无名')))
  const ch2 = await call('novel_chapter', { book_dir: dir, ch: 1, title: '开篇', text: '修订后的正文内容，重读对账再落笔。'.repeat(4), seeds: [{ id: 'F1', name: '空屋', due_ch: 5 }] })
  assert.equal(ch2.rev, 2)
  const fsh = JSON.parse(files.get(dir + '/foreshadows.json'))
  assert.equal(fsh.foreshadows.length, 1)
  assert.equal(fsh.foreshadows[0].due_ch, 5)

  // verify：跳写第 3 章（断档）→ 章纲已写正文缺失 + 章号断档两分支都报
  await call('novel_outline', { book_dir: dir, op: 'write', volume: 1, chapter_no: 2, entry: { title: '第二章', goal: 'g2', hook: 'h2', word_min: 5, word_max: 100, differentiation: 'd' } })
  await call('novel_chapter', { book_dir: dir, ch: 3, title: '第三章', text: '跳写产生的断档场景正文。'.repeat(5) })
  const ver = await call('novel_verify', { book_dir: dir })
  assert.ok(ver.issues.some((s) => s.includes('章纲已写但正文缺失：第 2 章')))
  assert.ok(ver.issues.some((s) => s.includes('章号断档：第 2 章')))

  // count：file 模式汉字口径
  const cnt = await call('novel_count', { file: dir + '/manuscript/chapter_001.md' })
  assert.ok(cnt.han > 0)

  // assemble：已落盘章节（1 与 3）汇编
  const asm = await call('novel_assemble', { book_dir: dir })
  assert.equal(asm.ok, true)
  assert.equal(asm.chapters, 2)

  // 状态机：合法迁移过；跨闸跳跃拒
  const st = await call('novel_ledger', { book_dir: dir, op: 'set_chapter_status', ch: 1, status: '已审' })
  assert.equal(st.result.to, '已审')
  await assert.rejects(() => call('novel_ledger', { book_dir: dir, op: 'set_chapter_status', ch: 1, status: '已发表' }), /非法状态迁移/)

  // 冲突仲裁两分法：性别冲突不静默 → semantic 裁决 accept_new 回写台账
  await call('novel_ledger', { book_dir: dir, op: 'update_character', character: { name: '林一', gender: '男' } })
  const conf = await call('novel_ledger', { book_dir: dir, op: 'update_character', character: { name: '林一', gender: '女' } })
  assert.equal(conf.ok, false)
  const cid = conf.result.conflict.id
  const res = await call('novel_ledger', { book_dir: dir, op: 'resolve_conflict', conflict: { id: cid, scope: 'semantic', verdict: 'accept_new', stance: '编辑部立场：后文明示', evidence: 'ch1 场景3' } })
  assert.equal(res.ok, true)
  assert.equal(JSON.parse(files.get(dir + '/characters.json')).characters[0].gender, '女')

  // decide（v6.7 裁决原语）：Owner 一句话裁决 → 状态派生 + 伏笔改期派生 + 双落档
  await assert.rejects(() => call('novel_decide', { book_dir: dir, ruling: '', actor: 'Owner' }), /ruling 必填/)
  await assert.rejects(() => call('novel_decide', { book_dir: dir, ruling: 'x', actor: '路人' }), /actor 必填/)
  const dec = await call('novel_decide', { book_dir: dir, ruling: 'ch1 细纲通过；F1 改期到 ch9', actor: 'Owner', scope: 'authority', ch: 1, status: '待试读', foreshadow_id: 'F1', due_ch: 9 })
  assert.equal(dec.ok, true)
  assert.equal(JSON.parse(files.get(dir + '/status.json'))[1], '待试读')
  assert.equal(JSON.parse(files.get(dir + '/foreshadows.json')).foreshadows[0].due_ch, 9)
  const tapeLines = files.get(dir + '/editorial/events-tape.jsonl').trim().split('\n').map((l) => JSON.parse(l))
  assert.ok(tapeLines.some((e) => e.kind === 'decision' && e.actor === 'Owner' && e.what.includes('细纲通过')))
  await assert.rejects(() => call('novel_decide', { book_dir: dir, ruling: '跳跃', actor: 'Owner', ch: 1, status: '已发表' }), /非法状态迁移/)
})

test('integration v7.0: novel_chapter 派生模式（decision 落带/advance_to 推进/txn 回执）+ novel_ask 问账本', async () => {
  const files = new Map()
  const fs = {
    resolve: async (p) => String(p).replace(/\/+/g, '/'),
    stat: async (p) => (files.has(p) ? { size: files.get(p).length } : null),
    readText: async (p) => { if (!files.has(p)) throw new Error('ENOENT ' + p); return files.get(p) },
    writeText: async (p, s) => { files.set(p, s) },
    listDir: async (p) => [...files.keys()].filter((k) => k.startsWith(p + '/')).map((k) => ({ name: k.slice(p.length + 1).split('/')[0] })),
  }
  const exec = () => ({ agent: { ctx: { get: (k) => (k === 'fs' ? fs : undefined) } } })
  const call = (n, args) => { const t = TOOLS.find((x) => x.name === n); if (!t) throw new Error('no tool ' + n); return t.execute(args, exec()) }
  const dir = '/books/v7-test'
  files.set(dir + '/outline.json', JSON.stringify({ volumes: [{ volume: 1, chapters: [{ chapter_no: 1, title: '开篇', goal: 'g', hook: 'h', word_min: 10, word_max: 100 }] }] }))
  files.set(dir + '/characters.json', JSON.stringify({ characters: [{ name: '小满', gender: '女', identity: '德音楼学徒', last_seen_ch: 1 }] }))
  files.set(dir + '/bible.json', JSON.stringify({ terms: [{ name: '影绡', value: '德音楼的织梦法器' }] }))
  files.set(dir + '/project.json', JSON.stringify({ current_ch: 0 }))

  // ① chapter 派生模式：一次调用收束（落盘+伏笔+决策落带+状态推进+txn 回执）
  const r = await call('novel_chapter', {
    book_dir: dir, ch: 1, title: '开篇', text: '夜里的德音楼亮着最后一盏灯。'.repeat(4),
    seeds: [{ id: 'f1', name: '玉佩', due_ch: 5 }], cast: ['小满'],
    advance_to: '已审', decision: { what: '第1章按拍点落盘', why: '开篇章' },
  })
  assert.equal(r.ok, true)
  assert.ok(r.derived.some((d) => d.includes('草稿→已审')), '状态派生应回报')
  assert.ok(r.derived.some((d) => d.includes('事件带')), '决策落带应回报')
  assert.equal(JSON.parse(files.get(dir + '/status.json'))[1], '已审')
  const tape = files.get(dir + '/editorial/events-tape.jsonl').trim().split('\n').map((l) => JSON.parse(l))
  assert.ok(tape.some((e) => e.kind === 'decision' && e.what.includes('拍点落盘') && e.actor === '主编' && e.ch === 1), '随章决策应落带')
  const txn = JSON.parse(files.get(dir + '/editorial/txn/chapter_001.json'))
  assert.equal(txn.done, true); assert.equal(txn.ch, 1); assert.ok(txn.steps.includes('manuscript'))
  const evs = files.get(dir + '/events.jsonl').trim().split('\n').map((l) => JSON.parse(l))
  assert.ok(evs.some((e) => e.op === 'chapter_commit' && e.ch === 1))
  assert.ok(evs.some((e) => e.op === 'chapter_status' && e.to === '已审'), '状态推进应记事件账')
  // 非法 advance_to 仍被状态机拦
  await assert.rejects(() => call('novel_chapter', { book_dir: dir, ch: 1, title: '开篇', text: '重稿', advance_to: '已发表' }), /非法状态迁移/)

  // ② novel_ask：实体命中（人物/设定/伏笔，带出处）
  const m1 = await call('novel_ask', { book_dir: dir, q: '小满' })
  assert.equal(m1.ok, true)
  assert.ok(m1.matches.some((x) => x.source === 'characters.json' && x.ref === '小满'))
  assert.ok(!m1.matches.some((x) => x.source === 'foreshadows.json'), '问"小满"不该命中伏笔玉佩（无包含关系）')
  const m1b = await call('novel_ask', { book_dir: dir, q: '玉佩哪来的' })
  assert.ok(m1b.matches.some((x) => x.source === 'foreshadows.json' && x.ref.includes('f1')), '问句包含"玉佩"应命中 f1')
  const m2 = await call('novel_ask', { book_dir: dir, q: '影绡是啥' })
  assert.ok(m2.matches.some((x) => x.source === 'bible.json' && x.ref === '影绡'), '问句包含实体名应命中')
  // 总览路由：伏笔欠线（current_ch 已被 chapter 推到 1，f1 due 5 未逾期）
  const m3 = await call('novel_ask', { book_dir: dir, q: '未兑伏笔' })
  assert.equal(m3.overview.open_foreshadows, 1)
  assert.deepEqual(m3.overview.overdue, [], 'due 5 > current 1，未逾期')
  // 零命中兜底：附总览 + 明说语义判断不归账本
  const m4 = await call('novel_ask', { book_dir: dir, q: '这章写得怎么样' })
  assert.equal(m4.matches.length, 0)
  assert.ok(m4.overview.current_ch >= 1)
  assert.ok(m4.note.includes('不归账本答'))
})
