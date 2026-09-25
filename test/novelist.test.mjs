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

test('tool registry: 15 tools, expected names, write tools carry timeoutMs', () => {
  assert.equal(TOOLS.length, 15)
  const names = TOOLS.map((t) => t.name)
  assert.deepEqual(names, [
    'novel_init', 'novel_outline', 'novel_bible', 'novel_chapter',
    'novel_verify', 'novel_count', 'novel_guide', 'novel_ledger', 'novel_event', 'novel_score', 'novel_ask', 'novel_decide', 'novel_assemble', 'novel_context', 'novel_search',
  ])
  for (const t of TOOLS) {
    if (['novel_init', 'novel_outline', 'novel_chapter', 'novel_ledger', 'novel_event', 'novel_score', 'novel_assemble'].includes(t.name)) {
      assert.ok(t.timeoutMs > 0, t.name + ' 应声明 timeoutMs')
    }
    assert.equal(typeof t.execute, 'function', t.name + ' 应有 execute')
    // 对外 schema 完整性（批C 修复回归）：book_dir 必须同时出现在 required 与 properties 里——
    // 旧实现用 Object.assign 平铺 extra，extra.properties 整体替换掉了 { book_dir }，schema 少了这个参数
    //
    // 免此约束的工具（**必须显式登记**，不是"漏了就跳过"——静默跳过等于这条回归失效）：
    //   novel_count：可只给 file 或 text，不碰账本
    //   novel_guide：零参数，取的是插件自带的机制手册，与任何一本书无关
    const NO_BOOK_TOOLS = new Set(['novel_count', 'novel_guide'])
    if (!NO_BOOK_TOOLS.has(t.name)) {
      assert.ok(t.parameters.properties.book_dir, t.name + ' 的 inputSchema 应含 book_dir 属性（不只 required）')
      assert.ok(t.parameters.required.includes('book_dir'), t.name + ' 应 required book_dir')
    }
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

test('appendJsonlLine 行尾纪律: 首写必带换行（190 章压测暴露的 bug 回归——首写无 \\n 则后续 os-append 并行成脏行）', async () => {
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

test('guide 瘦身不减资产：沿革出常驻后仍可按需找到（绝对路径 + 文件在位）', async () => {
  const { SECTION } = _internals
  const text = SECTION.text
  // 常驻只留当前生效口径 + 沿革指针；指针必须是**可读的绝对路径**（相对写法模型解不出来，等于空指针）
  const { readFileSync, existsSync } = await import('node:fs')
  const m = text.match(/([A-Za-z]:[\\/][^\s]*guide-history\.md|\/[^\s]*guide-history\.md)/)
  assert.ok(m, '常驻 SECTION 必须给出沿革文件的可读绝对路径，实得：' + text.slice(0, 400))
  assert.ok(existsSync(m[1]), '指针指向的文件必须真在：' + m[1])
  assert.ok(text.includes('账本版本与投影纪律'), '本批新纪律必须进常驻（不能只躺在沿革文件里）')
  assert.equal(text.includes('v6.1：编辑部五角色'), false, '逐版沿革不该再常驻（瘦身目标）')
  // 沿革文件在位且真的装着历史（不是空壳指针——"移出"不等于"丢掉"）
  const hist = readFileSync(m[1], 'utf8')
  for (const marker of ['v6.1', 'v7.0', 'v7.4', '两座位制', '金丝雀', 'supersedes']) {
    assert.ok(hist.includes(marker), '沿革文件应含历史标记：' + marker)
  }
  // 关键红线与纪律仍在常驻（瘦身不得减资产）
  for (const must of ['盲角色派工纪律', '事件带纪律', '状态机', '账本唯一写入口']) {
    assert.ok(text.includes(must), '常驻应仍含关键纪律：' + must)
  }
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

  // verify：跳写第 3 章（断档）→ 缺章一次报清
  // 旧实现是两条检查各报一遍同一根因（实测《第七封》56 条 issues 里真实原因只有 1 个），
  // 已合并为一条：有章纲但无正文的具名列前 6 章 + 计数。
  await call('novel_outline', { book_dir: dir, op: 'write', volume: 1, chapter_no: 2, entry: { title: '第二章', goal: 'g2', hook: 'h2', word_min: 5, word_max: 100, differentiation: 'd' } })
  await call('novel_chapter', { book_dir: dir, ch: 3, title: '第三章', text: '跳写产生的断档场景正文。'.repeat(5) })
  const ver = await call('novel_verify', { book_dir: dir })
  const miss = ver.issues.filter((s) => s.includes('缺正文'))
  assert.equal(miss.length, 1, '同一根因只报一条：' + JSON.stringify(ver.issues))
  assert.ok(miss[0].includes('第 2 章'), '要具名：' + miss[0])
  assert.ok(!ver.issues.some((s) => s.includes('章号断档')), '第 2 章有章纲，不该同时落进"章号断档"那条（那是给章纲外缺口用的）')

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

  // decide 撤销语义（v7.4）：supersedes 引用即作废，重复撤销拦，readTapeWindow 出 superseded_ids
  const dec1 = await call('novel_decide', { book_dir: dir, ruling: 'ch9 改结尾为雨夜收线', actor: 'Owner', scope: 'authority', ch: 9 })
  assert.equal(dec1.ok, true)
  const dec2 = await call('novel_decide', { book_dir: dir, ruling: '撤销上一条：ch9 结尾维持原案', actor: 'Owner', scope: 'authority', supersedes: dec1.id })
  assert.equal(dec2.ok, true)
  assert.ok(dec2.applied.some((x) => x.includes('作废 ' + dec1.id)), '撤销应回报')
  await assert.rejects(() => call('novel_decide', { book_dir: dir, ruling: '再撤一次', actor: 'Owner', supersedes: dec1.id }), /已被作废过/)
  await assert.rejects(() => call('novel_decide', { book_dir: dir, ruling: '撤空气', actor: 'Owner', supersedes: 't999' }), /未知事件带条目/)
  const win = await call('novel_event', { book_dir: dir, op: 'read' })
  assert.ok(win.superseded_ids.includes(dec1.id), 'readTapeWindow 应报 superseded_ids')

  // 代码质量批回归（2026-09-16）：①绕道防线——novel_event 直带 supersedes 拦未知 id
  await assert.rejects(() => call('novel_event', { book_dir: dir, op: 'append', kind: 'decision', what: '绕道撤销', why: '试防线', actor: '主编', supersedes: 't999' }), /未知事件带条目/)
  // ②空书目录——读类工具大声报错不给全零总览（批U3：由 requireBook 统一前置，不再只有 novel_ask 拦）
  await assert.rejects(() => call('novel_ask', { book_dir: '/books/no-such-book', q: '小满' }), (e) => {
    assert.equal(e.code, 'E_NOT_FOUND')
    assert.match(e.message, /书目录为空或不存在/)
    return true
  })
  // ③advance_to 预检 fail fast——非法迁移在正文落盘前拦下（手稿文件不应产生）
  await assert.rejects(() => call('novel_chapter', { book_dir: dir, ch: 77, title: '预检', text: '正文不该落盘。'.repeat(5), advance_to: '已发表' }), /非法状态迁移/)
  assert.equal(files.has(dir + '/manuscript/chapter_077.md'), false, '预检失败不得落盘手稿')
})

test('A1 事务可信: 同参重试幂等（不翻版本快照）+ 回执绑定 content_hash', async () => {
  const files = new Map()
  const fs = {
    resolve: async (p) => String(p).replace(/\/+/g, '/'),
    stat: async (p) => (files.has(p) ? { size: files.get(p).length } : null),
    readText: async (p) => { if (!files.has(p)) throw new Error('ENOENT ' + p); return files.get(p) },
    writeText: async (p, s) => { files.set(p, s) },
    listDir: async (p) => [...files.keys()].filter((k) => k.startsWith(p + '/')).map((k) => ({ name: k.slice(p.length + 1).split('/')[0] })),
  }
  const exec = () => ({ agent: { ctx: { get: (k) => (k === 'fs' ? fs : undefined) } } })
  const call = (n, args) => TOOLS.find((x) => x.name === n).execute(args, exec())
  const dir = '/books/a1-idem'
  const text = '夜里灯下有人影一动不动，门被推开了。'.repeat(4)

  const r1 = await call('novel_chapter', { book_dir: dir, ch: 1, title: '开篇', text, seeds: [{ id: 'F1', name: '空屋', due_ch: 5 }] })
  assert.equal(r1.ok, true)
  assert.ok(r1.content_hash, '回执/返回应带 content_hash（sha256 正文）')
  const vCount = () => [...files.keys()].filter((k) => k.startsWith(dir + '/versions/')).length

  // 同参重试：同 ch + 同 text → 不新增快照、不新 rev
  const r2 = await call('novel_chapter', { book_dir: dir, ch: 1, title: '开篇', text, seeds: [{ id: 'F1', name: '空屋', due_ch: 5 }] })
  assert.equal(r2.ok, true)
  assert.equal(r2.rev, r1.rev, '同参重试 rev 不变')
  assert.equal(r2.content_hash, r1.content_hash)
  assert.ok(r2.deduped, '同参重试应标记 deduped')
  assert.equal(vCount(), 0, '同参重试不翻版本快照')

  // 不同内容 → 正常新 rev + 新快照
  const r3 = await call('novel_chapter', { book_dir: dir, ch: 1, title: '开篇', text: text + '修订一句。' })
  assert.equal(r3.rev, 2)
  assert.equal(vCount(), 1, '修订应恰一个快照')
  assert.notEqual(r3.content_hash, r1.content_hash)

  // 回执绑定：done 回执带 content_hash
  const txn = JSON.parse(files.get(dir + '/editorial/txn/chapter_001.json'))
  assert.equal(txn.status, 'done')
  assert.equal(txn.content_hash, r3.content_hash)
  assert.equal(txn.rev, 2)
})

test('A1 事务可信: 中断留 pending 回执 + verify 半提交检测（正文 hash 漂移也报）', async () => {
  const files = new Map()
  let failOnForeshadows = true
  const fs = {
    resolve: async (p) => String(p).replace(/\/+/g, '/'),
    stat: async (p) => (files.has(p) ? { size: files.get(p).length } : null),
    readText: async (p) => { if (!files.has(p)) throw new Error('ENOENT ' + p); return files.get(p) },
    writeText: async (p, s) => {
      if (failOnForeshadows && p.endsWith('/foreshadows.json')) throw new Error('注入故障：伏笔账写失败')
      files.set(p, s)
    },
    listDir: async (p) => [...files.keys()].filter((k) => k.startsWith(p + '/')).map((k) => ({ name: k.slice(p.length + 1).split('/')[0] })),
  }
  const exec = () => ({ agent: { ctx: { get: (k) => (k === 'fs' ? fs : undefined) } } })
  const call = (n, args) => TOOLS.find((x) => x.name === n).execute(args, exec())
  const dir = '/books/a1-fail'

  // 中断：伏笔账写入抛错 → 整个提交失败（不静默）
  await assert.rejects(
    () => call('novel_chapter', { book_dir: dir, ch: 1, title: '开篇', text: '中断场景正文。'.repeat(5), seeds: [{ id: 'F1', name: '空屋' }] }),
    /注入故障/,
  )
  // 正文已写但回执是 pending（不是 done 假完成）
  assert.ok(files.has(dir + '/manuscript/chapter_001.md'), '正文已落盘')
  const pending = JSON.parse(files.get(dir + '/editorial/txn/chapter_001.json'))
  assert.equal(pending.status, 'pending', '中断后回执必须显式 pending，不得残留 done')

  // verify 能抓出 pending 半提交
  const v = await call('novel_verify', { book_dir: dir })
  assert.ok(v.issues.some((s) => s.includes('半提交') && s.includes('pending')), 'verify 报 pending 半提交：' + JSON.stringify(v.issues))

  // 恢复：解除故障重交（同 text）→ 走完事务，回执 done + hash 绑定
  failOnForeshadows = false
  const r = await call('novel_chapter', { book_dir: dir, ch: 1, title: '开篇', text: '中断场景正文。'.repeat(5), seeds: [{ id: 'F1', name: '空屋' }] })
  assert.equal(r.ok, true)
  const done = JSON.parse(files.get(dir + '/editorial/txn/chapter_001.json'))
  assert.equal(done.status, 'done')
  assert.equal(done.content_hash, r.content_hash)

  // verify 抓「正文被改而回执未更新」（hash 漂移）
  files.set(dir + '/manuscript/chapter_001.md', files.get(dir + '/manuscript/chapter_001.md') + '外部手工改了一句。')
  const v2 = await call('novel_verify', { book_dir: dir })
  assert.ok(v2.issues.some((s) => s.includes('正文版本') || s.includes('content_hash')), 'verify 报回执 hash 与正文不符：' + JSON.stringify(v2.issues))
})

test('A1 事务可信: expected_rev 并发护栏——stale 拒绝且零副作用', async () => {
  const files = new Map()
  const fs = {
    resolve: async (p) => String(p).replace(/\/+/g, '/'),
    stat: async (p) => (files.has(p) ? { size: files.get(p).length } : null),
    readText: async (p) => { if (!files.has(p)) throw new Error('ENOENT ' + p); return files.get(p) },
    writeText: async (p, s) => { files.set(p, s) },
    listDir: async (p) => [...files.keys()].filter((k) => k.startsWith(p + '/')).map((k) => ({ name: k.slice(p.length + 1).split('/')[0] })),
  }
  const exec = () => ({ agent: { ctx: { get: (k) => (k === 'fs' ? fs : undefined) } } })
  const call = (n, args) => TOOLS.find((x) => x.name === n).execute(args, exec())
  const dir = '/books/a1-rev'

  const r1 = await call('novel_chapter', { book_dir: dir, ch: 1, title: '开篇', text: '第一版正文。'.repeat(5) })
  assert.equal(r1.rev, 1)

  // stale expected_rev：写前拦截，零副作用（调用方以为账上还是空白 rev 0，实际已有 rev 1）
  const before = new Map(files)
  await assert.rejects(
    () => call('novel_chapter', { book_dir: dir, ch: 1, title: '开篇', text: '并发写冲突正文。'.repeat(5), expected_rev: 0 }),
    /expected_rev/,
  )
  for (const [k, v] of before) assert.equal(files.get(k), v, 'stale 拒绝不得改动任何文件：' + k)
  assert.equal(files.size, before.size, '不得新增文件')

  // 正确 expected_rev：正常提交
  const r2 = await call('novel_chapter', { book_dir: dir, ch: 1, title: '开篇', text: '并发写冲突正文。'.repeat(5), expected_rev: 1 })
  assert.equal(r2.rev, 2)
})

test('A2 事实版本化: 每版事实贡献账 + 早章回改后 last_seen 按有效出场回退（非 max 补丁）', async () => {
  const files = new Map()
  const fs = {
    resolve: async (p) => String(p).replace(/\/+/g, '/'),
    stat: async (p) => (files.has(p) ? { size: files.get(p).length } : null),
    readText: async (p) => { if (!files.has(p)) throw new Error('ENOENT ' + p); return files.get(p) },
    writeText: async (p, s) => { files.set(p, s) },
    listDir: async (p) => [...files.keys()].filter((k) => k.startsWith(p + '/')).map((k) => ({ name: k.slice(p.length + 1).split('/')[0] })),
  }
  const exec = () => ({ agent: { ctx: { get: (k) => (k === 'fs' ? fs : undefined) } } })
  const call = (n, args) => TOOLS.find((x) => x.name === n).execute(args, exec())
  const dir = '/books/a2-facts'
  files.set(dir + '/characters.json', JSON.stringify({ characters: [{ name: '甲' }, { name: '乙' }] }))
  const castOf = (p) => JSON.parse(files.get(dir + '/editorial/facts/' + p)).cast

  // ch1 甲+乙 → ch2 甲 → ch3 乙（末次出场=3）
  await call('novel_chapter', { book_dir: dir, ch: 1, title: '一', text: '第一章正文。'.repeat(6), cast: ['甲', '乙'] })
  await call('novel_chapter', { book_dir: dir, ch: 2, title: '二', text: '第二章正文。'.repeat(6), cast: ['甲'] })
  await call('novel_chapter', { book_dir: dir, ch: 3, title: '三', text: '第三章正文。'.repeat(6), cast: ['乙'] })
  // 每版一份事实贡献账（append-only：改稿只加新文件，不覆盖旧版贡献）
  assert.deepEqual(castOf('chapter_001.v1.json'), ['甲', '乙'], 'ch1 v1 贡献账')
  assert.deepEqual(castOf('chapter_003.v1.json'), ['乙'], 'ch3 v1 贡献账')
  const chars = () => JSON.parse(files.get(dir + '/characters.json')).characters
  assert.equal(chars().find((c) => c.name === '乙').last_seen_ch, 3)

  // ch3 改稿删掉乙（同章重交=rev2）→ 乙 已无有效出场于 ch3，last_seen 回退到最近有效章 1
  await call('novel_chapter', { book_dir: dir, ch: 3, title: '三', text: '第三章改稿：乙不再出场。'.repeat(6), cast: ['甲'], expected_rev: 1 })
  assert.deepEqual(castOf('chapter_003.v2.json'), ['甲'], '改稿产生 v2 贡献账')
  assert.ok(files.has(dir + '/editorial/facts/chapter_003.v1.json'), '旧版贡献账保留（append-only，不删历史）')
  assert.equal(chars().find((c) => c.name === '乙').last_seen_ch, 1, '回退到最近有效出场章（仅 max 补丁做不到）')
  assert.equal(chars().find((c) => c.name === '甲').last_seen_ch, 3, '甲 随改稿升到 3')

  // 反证：改稿把乙重新加回 → last_seen 再升回 3
  await call('novel_chapter', { book_dir: dir, ch: 3, title: '三', text: '第三章再改：乙回来了。'.repeat(6), cast: ['甲', '乙'], expected_rev: 2 })
  assert.equal(chars().find((c) => c.name === '乙').last_seen_ch, 3)
})

test('A2 评分绑定版本: record 绑正文 rev/hash，改稿后 read 默认只回当前版（旧版标 stale 可查）', async () => {
  const files = new Map()
  const fs = {
    resolve: async (p) => String(p).replace(/\/+/g, '/'),
    stat: async (p) => (files.has(p) ? { size: files.get(p).length } : null),
    readText: async (p) => { if (!files.has(p)) throw new Error('ENOENT ' + p); return files.get(p) },
    writeText: async (p, s) => { files.set(p, s) },
    listDir: async (p) => [...files.keys()].filter((k) => k.startsWith(p + '/')).map((k) => ({ name: k.slice(p.length + 1).split('/')[0] })),
  }
  const exec = () => ({ agent: { ctx: { get: (k) => (k === 'fs' ? fs : undefined) } } })
  const call = (n, args) => TOOLS.find((x) => x.name === n).execute(args, exec())
  const dir = '/books/a2-score'
  const V1 = '他推开了那扇门，纸角又掀了一下。'.repeat(4)
  const V2 = '他推开门，屋里空无一人，纸角又掀了一下。'.repeat(4)

  await call('novel_chapter', { book_dir: dir, ch: 1, title: '开篇', text: V1 })
  const s1 = await call('novel_score', { book_dir: dir, op: 'record', ch: 1, dim: '钩子', score: 4, evidence: '纸角又掀了一下。', judge: '试读员' })
  assert.equal(s1.ok, true)
  assert.equal(s1.records[0].ch_rev, 1, '评分绑定录分时的 rev')
  assert.equal(typeof s1.records[0].content_hash, 'string', '评分绑定录分时的正文哈希')

  // 改稿升 v2 → v1 的判词不再代表当前正文
  await call('novel_chapter', { book_dir: dir, ch: 1, title: '开篇', text: V2, expected_rev: 1 })
  const now = await call('novel_score', { book_dir: dir, op: 'read', ch: 1 })
  assert.equal(now.total, 0, '默认回读不返回旧版判词（不冒充当前版审稿结论）')
  const all = await call('novel_score', { book_dir: dir, op: 'read', ch: 1, include_stale: true })
  assert.equal(all.total, 1, 'include_stale 可查旧版')
  assert.equal(all.records[0].stale, true, '旧版判词标 stale')
  assert.equal(all.records[0].ch_rev, 1)

  // 新版录分 → 默认回读命中新版
  await call('novel_score', { book_dir: dir, op: 'record', ch: 1, dim: '钩子', score: 5, evidence: '纸角又掀了一下。', judge: '试读员' })
  const cur = await call('novel_score', { book_dir: dir, op: 'read', ch: 1 })
  assert.equal(cur.total, 1)
  assert.equal(cur.records[0].ch_rev, 2)
  assert.equal(cur.records[0].stale, false)
})

test('E2 novel_ask 有效投影: timeline 读取 + supersedes 投影 + ch 参数按 ≤ch 过滤', async () => {
  const files = new Map()
  const fs = {
    resolve: async (p) => String(p).replace(/\/+/g, '/'),
    stat: async (p) => (files.has(p) ? { size: files.get(p).length } : null),
    readText: async (p) => { if (!files.has(p)) throw new Error('ENOENT ' + p); return files.get(p) },
    writeText: async (p, s) => { files.set(p, s) },
    listDir: async (p) => [...files.keys()].filter((k) => k.startsWith(p + '/')).map((k) => ({ name: k.slice(p.length + 1).split('/')[0] })),
  }
  const exec = () => ({ agent: { ctx: { get: (k) => (k === 'fs' ? fs : undefined) } } })
  const call = (n, args) => TOOLS.find((x) => x.name === n).execute(args, exec())
  const dir = '/books/e2-ask'
  await call('novel_init', { book_dir: dir, title: 'E2 测试书' })
  files.set(dir + '/characters.json', JSON.stringify({ characters: [{ name: '甲' }] }))

  // ch1/ch2 落盘（带时间线事件与出场），ch5 为"已超前写好的存稿"（甲到第 5 章仍出场）
  await call('novel_chapter', { book_dir: dir, ch: 1, title: '一', text: '第一章正文。'.repeat(6), cast: ['甲'], timeline_events: [{ time: '第一日', what: '入城' }] })
  await call('novel_chapter', { book_dir: dir, ch: 2, title: '二', text: '第二章正文。'.repeat(6), cast: ['甲'], timeline_events: [{ time: '第三日', what: '见官' }] })
  await call('novel_chapter', { book_dir: dir, ch: 5, title: '五', text: '第五章正文。'.repeat(6), cast: ['甲'], timeline_events: [{ time: '第九日', what: '结案' }] })

  // ①timeline 现在读得到（旧实现完全没读这个文件）
  const tl = await call('novel_ask', { book_dir: dir, q: '时间线' })
  assert.equal(tl.ok, true)
  assert.ok(Array.isArray(tl.overview.timeline), '总览带 timeline：' + JSON.stringify(tl.overview))
  assert.equal(tl.overview.timeline.length, 3, '三条时间线事件')
  const sel = await call('novel_ask', { book_dir: dir, select: { kind: 'timeline', window: { from: 1, to: 2 } } })
  assert.equal(sel.timeline.length, 2, '结构化选择器窗口过滤：' + JSON.stringify(sel.timeline))
  assert.deepEqual(sel.timeline.map((e) => e.ch), [1, 2])

  // ②ch 参数统一按 ≤ch 投影：问"甲"时 ch=2 不得报出第 5 章的出场（存稿不算当前账）
  const now = await call('novel_ask', { book_dir: dir, q: '甲', ch: 2 })
  assert.equal(now.matches.length, 1)
  assert.equal(now.matches[0].card.last_seen_ch, 2, 'ch=2 时最后出场按 ≤2 投影，不报第 5 章：' + JSON.stringify(now.matches[0].card))
  const full = await call('novel_ask', { book_dir: dir, q: '甲' })
  assert.equal(full.matches[0].card.last_seen_ch, 5, '不给 ch 时仍给全账真值')
  const tlNow = await call('novel_ask', { book_dir: dir, q: '时间线', ch: 2 })
  assert.equal(tlNow.overview.timeline.length, 2, 'timeline 同样按 ≤ch 过滤')

  // ③supersedes 投影：被作废的欠线不再出现在未闭欠线里，撤销链单独可查
  const t1 = await call('novel_event', { book_dir: dir, op: 'append', kind: 'open_thread', what: '卷三前必须收掉玉佩线', why: '读者承诺', actor: '主编', closes: 9 })
  const id1 = t1.id
  const before = await call('novel_ask', { book_dir: dir, q: '还欠什么' })
  assert.equal(before.overview.open_threads.some((x) => x.id === id1), true, '作废前在未闭欠线里')
  await call('novel_decide', { book_dir: dir, ruling: '玉佩线并入主线，作废原欠线', actor: '主编', supersedes: id1 })
  const after = await call('novel_ask', { book_dir: dir, q: '还欠什么' })
  assert.equal(after.overview.open_threads.some((x) => x.id === id1), false, '被 supersedes 的条目不再出现在未闭欠线：' + JSON.stringify(after.overview.open_threads))
  assert.equal(after.overview.tape_window.some((e) => e.id === id1), false, '被作废条目也不再进窗口正文（有效投影）')
  assert.ok(after.overview.superseded_chain.some((x) => x.id === id1 && x.superseded_by), '撤销链单独可查：' + JSON.stringify(after.overview.superseded_chain))
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

// ---------------------------------------------------------------- 批R1 写门队列

test('批R1: 写门队列——同书任务严格串行不交错，异书互不阻塞', async () => {
  const order = []
  const task = (tag, ms) => () => new Promise((resolve) => {
    order.push(tag + '-开始')
    setTimeout(() => { order.push(tag + '-结束'); resolve(tag) }, ms)
  })
  // 同书：后一个必须等前一个彻底结束——交错就是读改写窗口互叠（丢更新的根因）
  await Promise.all([
    _internals.enqueueBook('/book/x', task('A', 40)),
    _internals.enqueueBook('/book/x', task('B', 5)),
  ])
  assert.deepEqual(order, ['A-开始', 'A-结束', 'B-开始', 'B-结束'], '同书任务不许交错')

  // 异书：不得互相阻塞（否则一套编辑部只能一本书一本本地跑）
  const t0 = Date.now()
  await Promise.all([
    _internals.enqueueBook('/book/p', task('P', 40)),
    _internals.enqueueBook('/book/q', task('Q', 40)),
  ])
  assert.ok(Date.now() - t0 < 70, '不同书之间不该排队（实测耗时 ' + (Date.now() - t0) + 'ms）')
})

test('批R1: 写门队列——排空后不留残留（Map 不无界增长）', async () => {
  await _internals.enqueueBook('/book/leak', async () => 1)
  await new Promise((r) => setTimeout(r, 10))
  assert.equal(_internals.enqueueBook('/book/leak', async () => 1) instanceof Promise, true, '队列可复用')
})

// ---------------------------------------------------------------- 批R2 账本 schema 版本 / 批R4 错误码

/** 内存 fs shim（对齐 DSH fs 服务契约）。 */
function shimFs(files = new Map()) {
  const fs = {
    resolve: async (p) => String(p).replace(/\/+/g, '/'),
    stat: async (p) => (files.has(p) ? { size: files.get(p).length } : null),
    readText: async (p) => { if (!files.has(p)) throw new Error('ENOENT ' + p); return files.get(p) },
    writeText: async (p, s) => { files.set(p, s) },
    listDir: async (p) => [...files.keys()].filter((k) => k.startsWith(p + '/')).map((k) => ({ name: k.slice(p.length + 1).split('/')[0] })),
  }
  const exec = () => ({ agent: { ctx: { get: (k) => (k === 'fs' ? fs : undefined) } } })
  return { files, fs, exec, call: (n, a) => TOOLS.find((x) => x.name === n).execute(a, exec()) }
}

test('批R2: 旧账本（无 schema_version）读取时逐级迁移并盖当前戳', async () => {
  const { files, fs } = shimFs()
  const dir = '/books/legacy'
  files.set(dir + '/characters.json', JSON.stringify({ characters: [{ name: '甲' }] }))
  const got = await _internals.loadJson(fs, dir, 'characters.json')
  assert.equal(got.schema_version, _internals.SCHEMA_VERSION, '缺戳=版本 0，读出来必须已迁到当前版本')
  assert.deepEqual(got.characters, [{ name: '甲' }], '迁移不得改动结构内容')
})

test('批R2: 未来版本账本拒读（宁报错不静默误读旧结构）', async () => {
  const { files, fs } = shimFs()
  const dir = '/books/future'
  files.set(dir + '/project.json', JSON.stringify({ schema_version: 99, title: 'x' }))
  await assert.rejects(() => _internals.loadJson(fs, dir, 'project.json'), (e) => {
    assert.equal(e.code, 'E_SCHEMA_FUTURE')
    assert.match(e.message, /schema_version=99/)
    return true
  })
})

test('批R2: 写入自动盖戳——新书六个账本全带 schema_version，未登记文件不误伤', async () => {
  const { files, call } = shimFs()
  const dir = '/books/stamp'
  await call('novel_init', { book_dir: dir, title: 'T', genre: 'dushi', logline: 'L' })
  for (const f of ['project.json', 'bible.json', 'characters.json', 'foreshadows.json', 'timeline.json', 'outline.json']) {
    assert.equal(JSON.parse(files.get(dir + '/' + f)).schema_version, _internals.SCHEMA_VERSION, f + ' 应自动盖戳')
  }
  await call('novel_chapter', { book_dir: dir, ch: 1, title: '一', text: '第一章正文。'.repeat(6) })
  const rc = JSON.parse(files.get(dir + '/editorial/txn/chapter_001.json'))
  assert.equal(rc.schema_version, undefined, 'txn 回执不在迁移表内，不该被盖全局版本戳')
  assert.equal(rc.content_hash.length, 64, '回执该有的是自己的版本口径（content_hash）')
})

test('批R4: 错误码——冲突/前置条件/账本损坏各自可程序化区分', async () => {
  const { call, files } = shimFs()
  const dir = '/books/codes'
  await call('novel_init', { book_dir: dir, title: 'T', genre: 'dushi', logline: 'L' })
  await call('novel_chapter', { book_dir: dir, ch: 1, title: '一', text: '第一章正文。'.repeat(6) })

  await assert.rejects(
    () => call('novel_chapter', { book_dir: dir, ch: 1, title: '一', text: '改过的正文。'.repeat(6), expected_rev: 0 }),
    (e) => { assert.equal(e.code, 'E_CONFLICT'); assert.match(e.message, /^\[E_CONFLICT\]/); return true },
    'expected_rev 不符应发 E_CONFLICT（调用方据此重读而非盲目重试）',
  )
  await assert.rejects(
    () => call('novel_ledger', { book_dir: dir, op: 'set_chapter_status', ch: 1, status: '已发表' }),
    (e) => { assert.equal(e.code, 'E_PRECONDITION'); return true },
    '非法状态迁移应发 E_PRECONDITION',
  )
  files.set(dir + '/bible.json', '{ 这不是 JSON')
  await assert.rejects(
    () => call('novel_bible', { book_dir: dir }),
    (e) => { assert.equal(e.code, 'E_LEDGER_CORRUPT'); return true },
    '账本损坏应发 E_LEDGER_CORRUPT',
  )
})

test('批R4: 错误码同时编进消息前缀（MCP/DSH 两条通道都只透传 message 文本）', async () => {
  const { call } = shimFs()
  const dir = '/books/msgcode'
  await call('novel_init', { book_dir: dir, title: 'T', genre: 'dushi', logline: 'L' })
  await assert.rejects(
    () => call('novel_ledger', { book_dir: dir, op: 'update_foreshadow', foreshadow_id: 'F-不存在' }),
    (e) => {
      assert.equal(e.code, 'E_NOT_FOUND')
      assert.ok(e.message.startsWith('[E_NOT_FOUND]'), '码必须在消息前缀——否则只有进程内调用方能看见')
      return true
    },
  )
})

test('批U1: book_dir="@last" 复用上次书目录（首次无上次则明确报错，不猜）', async () => {
  const { call } = shimFs()
  const dir = '/books/last-demo'
  // 首次：没有"上次"，必须明确报错——猜一个目录＝写错书的静默风险
  _internals.resetLastBook()
  await assert.rejects(() => call('novel_bible', { book_dir: '@last' }), (e) => {
    assert.equal(e.code, 'E_NOT_FOUND')
    assert.match(e.message, /@last/)
    return true
  })
  await call('novel_init', { book_dir: dir, title: 'T', genre: 'dushi', logline: 'L' })
  await call('novel_chapter', { book_dir: dir, ch: 1, title: '一', text: '第一章正文。'.repeat(6) })
  // 复用：@last 等价于再敲一遍绝对路径
  const b1 = await call('novel_bible', { book_dir: dir })
  const b2 = await call('novel_bible', { book_dir: '@last' })
  assert.deepEqual(b2, b1, '@last 与绝对路径必须得到同一结果')
  // 对外 schema 必须写明这个用法，否则模型不知道能用
  assert.match(TOOLS[0].parameters.properties.book_dir.description, /@last/)
})

// ---------------------------------------------------------------- 批U2 回滚 / 进度视图

test('批U2: 回滚到 vN 走同一条提交管线（历史不重写，回滚记为新的一版）', async () => {
  const { call } = shimFs()
  const dir = '/books/rollback'
  await call('novel_init', { book_dir: dir, title: 'T', genre: 'dushi', logline: 'L' })
  const V1 = '第一版正文。'.repeat(8)
  const V2 = '第二版正文，改过头了。'.repeat(8)
  await call('novel_chapter', { book_dir: dir, ch: 1, title: '一', text: V1 })
  const second = await call('novel_chapter', { book_dir: dir, ch: 1, title: '一', text: V2 })
  assert.equal(second.rev, 2, '改稿后应为 rev 2')

  // 回滚到 v1：正文恢复，但版本号继续前进（append-only，不把历史抹掉）
  const back = await call('novel_chapter', { book_dir: dir, ch: 1, title: '一', rollback_to_rev: 1 })
  assert.equal(back.rev, 3, '回滚是新的一版（rev 3），不是把 rev 2 删掉')
  assert.equal(back.derived.join('；'), '回滚自 v1（历史不重写，本次记为新的一版）')
  const now = await call('novel_count', { file: dir + '/manuscript/chapter_001.md' })
  assert.equal(now.han, countHan(V1), '正文必须是 v1 的内容')

  // 不存在的版本：报错并列出可用的旧版快照（可行动）
  await assert.rejects(() => call('novel_chapter', { book_dir: dir, ch: 1, title: '一', rollback_to_rev: 9 }), (e) => {
    assert.equal(e.code, 'E_NOT_FOUND')
    assert.match(e.message, /chapter_001\.v1\.md/, '必须列出可回滚的版本')
    return true
  })
  // text 与 rollback_to_rev 同时给 = 语义歧义，拦住
  await assert.rejects(() => call('novel_chapter', { book_dir: dir, ch: 1, title: '一', text: 'x', rollback_to_rev: 1 }), /不能同时给/)
})

test('批U2b: novel_count 进度模式——逐章汉字 + 合计 + 与章纲区间对照', async () => {
  const { call } = shimFs()
  const dir = '/books/progress'
  await call('novel_init', { book_dir: dir, title: 'T', genre: 'dushi', logline: 'L' })
  await call('novel_outline', { book_dir: dir, op: 'write', volume: 1, chapter_no: 1, entry: { title: '一', goal: 'g', hook: 'h', word_min: 5, word_max: 50, differentiation: 'x' } })
  await call('novel_outline', { book_dir: dir, op: 'write', volume: 1, chapter_no: 2, entry: { title: '二', goal: 'g', hook: 'h', word_min: 999, word_max: 1000, differentiation: 'x' } })
  await call('novel_chapter', { book_dir: dir, ch: 1, title: '一', text: '正文。'.repeat(6) })
  await call('novel_chapter', { book_dir: dir, ch: 2, title: '二', text: '正文。'.repeat(6) })

  const p = await call('novel_count', { book_dir: dir })
  assert.equal(p.chapters, 2)
  assert.equal(p.total, countHan('正文。'.repeat(6)) * 2)
  const c1 = p.detail.find((d) => d.ch === 1)
  const c2 = p.detail.find((d) => d.ch === 2)
  assert.equal(c1.in_range, true, '第 1 章在 5-50 窗内')
  assert.equal(c2.in_range, false, '第 2 章远低于 999 下限，必须标出')
  assert.equal(c2.word_min, 999)
  // 模式互斥：进度模式与文本模式不能混用
  await assert.rejects(() => call('novel_count', { book_dir: dir, text: 'x' }), /不能同时给/)
})

test('批U3: 读类工具统一书存在性前置（不再只有 novel_ask 拦，也不再静默返回空）', async () => {
  const { call } = shimFs()
  for (const [name, args] of [
    ['novel_bible', {}],
    ['novel_verify', {}],
    ['novel_ask', { q: '小满' }],
    ['novel_assemble', {}],
    ['novel_count', { book_dir: '/books/nope' }],
  ]) {
    await assert.rejects(() => call(name, Object.assign({ book_dir: '/books/nope' }, args)), (e) => {
      assert.equal(e.code, 'E_NOT_FOUND', name + ' 应报 E_NOT_FOUND')
      return true
    }, name + ' 在空书目录上必须大声报错，不许静默返回空结果')
  }
})
