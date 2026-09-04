// 单元测试（node:test，零依赖）：只测确定性内核——字数口径、符号门、章文件名、
// 状态机迁移表完整性。工具执行路径依赖 DSH fs 服务（运行时注入），不在单测范围。
import test from 'node:test'
import assert from 'node:assert/strict'
import { name, inject, apply, _internals } from '../lib/novelist.js'

const { countHan, symbolGate, chapterFile, chapterTitle, CHAPTER_STATES, CHAPTER_TRANSITIONS, TOOLS } = _internals

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
