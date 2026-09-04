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

test('tool registry: 8 tools, expected names, write tools carry timeoutMs', () => {
  assert.equal(TOOLS.length, 8)
  const names = TOOLS.map((t) => t.name)
  assert.deepEqual(names, [
    'novel_init', 'novel_outline', 'novel_bible', 'novel_chapter',
    'novel_verify', 'novel_count', 'novel_ledger', 'novel_assemble',
  ])
  for (const t of TOOLS) {
    if (['novel_init', 'novel_outline', 'novel_chapter', 'novel_ledger', 'novel_assemble'].includes(t.name)) {
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
})
