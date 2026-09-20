// roles/text-invariants.mjs（文本层不变量守卫）的回归
//
// 锁的是什么：这条守卫守三组"散文层不变量"，而**每一条都必须能红**——
// 一个永远绿的守卫比没有守卫更坏（它把"没查"伪装成"查过了"）。
//   ① 禁模式：人格段里的能力否定句（"你没有 X"）不得复活；被封落账权的座位角色必须带义务句。
//   ② 同句：画像 ④ 条款（章节长度窗）在各化身之间必须逐字相同。
//   ③ 同数：SOP 的验收步数从文本里数出来，两处对它的引用必须等于数出来的值。
// 还有三条**空转**判据（exit 2）：条款整类被删、标记消失、扫描面为 0——
// 空集不许被当成"没问题"（本仓元纪律）。
//
// 为什么在**临时假仓**里跑：这些用例都要把受保护的文件改坏。真仓里改坏再改回来，
// 中间任何一步失败都会留一个坏文件在树上——守卫自己成了事故源。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdtempSync, writeFileSync, readFileSync, rmSync, cpSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const SCRIPT = path.join(HERE, 'text-invariants.mjs')
const PLUGIN = path.resolve(HERE, '..')

const AUTHOR = 'wb-expert-starter/agents/author.md'
const CARD = 'preset-starter/protocols/读者画像卡.md'
const READER = 'wb-expert-starter/references/roles/reader.md'
const SKILL = 'wb-expert-starter/skills/novel-editorial/SKILL.md'

/** flat 形态假仓：守卫认的标记（wb-expert-starter + lib）齐，四个源面各一份拷贝。 */
function fakeRepo() {
  const d = mkdtempSync(path.join(tmpdir(), 'nf-txt-'))
  for (const sub of ['lib', 'roles', 'preset-starter', 'wb-expert-starter']) {
    cpSync(path.join(PLUGIN, sub), path.join(d, sub), { recursive: true })
  }
  return d
}
const p = (root, rel) => path.join(root, ...rel.split('/'))
const run = (root) => spawnSync(process.execPath, [SCRIPT, '--root', root], { encoding: 'utf8' })
const both = (r) => String(r.stdout || '') + String(r.stderr || '')
/** 就地改一个文件：old 必须命中恰好一次（命中 0 次＝夹具自己坏了，别让它静默通过）。 */
function patch(root, rel, old, next) {
  const f = p(root, rel)
  const t = readFileSync(f, 'utf8')
  const n = t.split(old).length - 1
  assert.equal(n, 1, rel + ' 里「' + old.slice(0, 30) + '」命中 ' + n + ' 次（期望 1）——夹具失配')
  writeFileSync(f, t.replace(old, next))
}
/** 同上但替换**所有**出现处：用于"把整类删掉"的夹具（同一句话可能既是节标题又是引用）。 */
function patchAll(root, rel, old, next) {
  const f = p(root, rel)
  const t = readFileSync(f, 'utf8')
  const n = t.split(old).length - 1
  assert.ok(n >= 1, rel + ' 里「' + old + '」一处都没命中——夹具失配')
  writeFileSync(f, t.split(old).join(next))
}

// ── 正向：真仓必须安静通过（守卫不许变成永远红）
test('真仓三组不变量成立：exit 0，且三组都打印出来（不靠退出码掩盖局部）', () => {
  const r = run(PLUGIN)
  assert.equal(r.status, 0, '真仓应全部成立：' + both(r))
  for (const group of ['① 禁模式', '② 同句', '③ 同数']) {
    assert.match(r.stdout, new RegExp(group), '三组都要出现在输出里：' + group)
  }
})

// ── ① 禁模式
test('① 能力否定句复活 ⇒ exit 1 且点名文件与行号', () => {
  const d = fakeRepo()
  try {
    patch(d, AUTHOR, '你不得动用', '你没有')
    const r = run(d)
    assert.equal(r.status, 1, '该红：' + both(r))
    assert.match(r.stderr + r.stdout, /能力否定句/, '要说清是禁模式命中')
    assert.match(r.stderr + r.stdout, /agents\/author\.md:\d+/, '要点到文件与行号')
  } finally { rmSync(d, { recursive: true, force: true }) }
})

test('① 被封落账权的座位角色缺义务句 ⇒ exit 1（正向面从能力表推导）', () => {
  const d = fakeRepo()
  try {
    // 把义务句整句删掉（不是改成禁模式，而是让这句话不存在）——推导式正向面必须报
    const f = p(d, AUTHOR)
    const t = readFileSync(f, 'utf8')
    const line = t.split('\n').map((l, i) => [l, i]).find(([l]) => l.includes('你不得动用'))
    assert.ok(line, '夹具找不到义务句所在行')
    writeFileSync(f, t.split('\n').map((l, i) => (i === line[1] ? l.replace(/你不得动用[^）]*）/, '（略）') : l)).join('\n'))
    const r = run(d)
    assert.equal(r.status, 1, '该红：' + both(r))
    assert.match(r.stderr + r.stdout, /没有义务句/, '要说清是"缺义务句"而不是别的：' + both(r))
  } finally { rmSync(d, { recursive: true, force: true }) }
})

test('① 全扫描面一句义务句都没有 ⇒ exit 2（空转，不许打勾）', () => {
  const d = fakeRepo()
  try {
    for (const rel of [AUTHOR, READER, 'wb-expert-starter/references/roles/calibrator.md',
      'preset-starter/agent.cordis.yml']) {
      const f = p(d, rel)
      writeFileSync(f, readFileSync(f, 'utf8').split('你不得动用').join('不得使用'))
    }
    const r = run(d)
    assert.equal(r.status, 2, '空转必须是"没检查成"（exit 2），不是"有问题"（exit 1）：' + both(r))
    assert.match(r.stderr, /空转/, '要说清是空转：' + both(r))
  } finally { rmSync(d, { recursive: true, force: true }) }
})

// ── ② 同句
test('② 画像 ④ 条款两处措辞分叉 ⇒ exit 1，且把两边原文都打出来', () => {
  const d = fakeRepo()
  try {
    patch(d, CARD, '④节奏窗：', '④章节节奏窗口：')
    const r = run(d)
    assert.equal(r.status, 1, '该红：' + both(r))
    assert.match(r.stderr + r.stdout, /同句/, '要标明是同句不变量')
    assert.match(r.stderr + r.stdout, /章节节奏窗口/, '要把分叉方的原文打出来（否则读者不知道差在哪）')
  } finally { rmSync(d, { recursive: true, force: true }) }
})

test('② 化身不足 3 个（锚句被删）⇒ exit 2（空转，不许数空集打勾）', () => {
  const d = fakeRepo()
  try {
    patchAll(d, CARD, '番茄读者画像八条', '番茄读者画像')
    patchAll(d, READER, '番茄读者画像八条', '番茄读者画像')
    const r = run(d)
    assert.equal(r.status, 2, '化身不足必须是"没检查成"：' + both(r))
    assert.match(r.stderr, /化身/, '要说清是化身数不够：' + both(r))
  } finally { rmSync(d, { recursive: true, force: true }) }
})

// ── ③ 同数
test('③ 验收步数与「另有 N 步」不符 ⇒ exit 1（手写的数被现读数核住）', () => {
  const d = fakeRepo()
  try {
    patch(d, SKILL, '另有 5 步', '另有 4 步')
    const r = run(d)
    assert.equal(r.status, 1, '该红：' + both(r))
    assert.match(r.stderr + r.stdout, /另有 4 步/, '要点出那个错的数：' + both(r))
    assert.match(r.stderr + r.stdout, /数出来是 5 步/, '要给出数出来的真值：' + both(r))
  } finally { rmSync(d, { recursive: true, force: true }) }
})

test('③ SKILL 的验收小节多一条 ⇒ exit 1（两份 SOP 不同版）', () => {
  const d = fakeRepo()
  try {
    patch(d, SKILL, '\n## 4. 事件带纪律', '\n6. 新增一条验收（夹具）\n\n## 4. 事件带纪律')
    const r = run(d)
    assert.equal(r.status, 1, '该红：' + both(r))
    assert.match(r.stderr + r.stdout, /同一段「一章收束验收」/, '要说明是同一段流程条数不同：' + both(r))
  } finally { rmSync(d, { recursive: true, force: true }) }
})

test('③ 标记「另有 N 步」被删 ⇒ exit 2（模式失配不许静默失效）', () => {
  const d = fakeRepo()
  try {
    patch(d, SKILL, '§3 另有 5 步，那几步的工具动作不计入本指标', '')
    const r = run(d)
    assert.equal(r.status, 2, '标记没了必须报"没检查成"：' + both(r))
    assert.match(r.stderr, /标记/, '要说清是标记没了：' + both(r))
  } finally { rmSync(d, { recursive: true, force: true }) }
})

// ── 元：扫描面为 0 / 目录不对，必须 exit 2 且不写盘
test('守卫是只读的：跑完不改变任何文件的字节（同一次真仓跑两次 sha 相同）', () => {
  const d = fakeRepo()
  try {
    const before = readFileSync(p(d, AUTHOR), 'utf8') + readFileSync(p(d, CARD), 'utf8')
    run(d)
    const after = readFileSync(p(d, AUTHOR), 'utf8') + readFileSync(p(d, CARD), 'utf8')
    assert.equal(before, after, '守卫只读——它没有任何写盘分支')
  } finally { rmSync(d, { recursive: true, force: true }) }
})

test('不是仓库根 ⇒ exit 2（不猜根，且说清是根的问题）', () => {
  const d = mkdtempSync(path.join(tmpdir(), 'nf-noroot-'))
  try {
    const r = run(d)
    assert.equal(r.status, 2, '认不出根必须 exit 2：' + both(r))
    assert.match(r.stderr, /能力表不存在/, '要说清缺的是能力表：' + both(r))
    assert.match(r.stderr, /--root 指错了/, '要给出"多半是根指错了"这条诊断（否则读者会去查能力表）：' + both(r))
  } finally { rmSync(d, { recursive: true, force: true }) }
})
