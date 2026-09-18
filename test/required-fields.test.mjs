// 必答字段清单（总台账 S9，2026-09-18）：verify 从"字段出现过才查"改为"按清单查该有的有没有"。
//
// 为什么必须改：旧口径带一个后门——检查以"书内出现过 choice_axis"为启用条件，于是
// **整本书都没用该字段 = 检查整体不启用 = 缺失静默通过**。"永不采用"与"有意不用"在账上无法区分。
// 实证：fangxiangyi-01 的章纲全无 choice_axis（载荷产出于 2026-09-05，而该字段是 ADR-034 / 09-13 才定的），
// novel_verify 当时输出 0 issues / 0 warnings。
//
// 三条边界一起锁：
//   ①新书缺必答字段 → issues（严格）；
//   ②旧书（project.json 无该清单）→ 保持原宽松口径，**不误报存量书**（不迁移是刻意的）；
//   ③显式登记空清单 → 该书自愿不受此约束（口径写在书上，而不是靠"用不用字段"暗示）。
import test from 'node:test'
import assert from 'node:assert/strict'
import { _internals } from '../lib/novelist.js'

const { TOOLS } = _internals

function shimFs(files = new Map()) {
  const fs = {
    resolve: async (p) => String(p).replace(/\/+/g, '/'),
    stat: async (p) => (files.has(p) ? { size: files.get(p).length } : null),
    readText: async (p) => { if (!files.has(p)) throw new Error('ENOENT ' + p); return files.get(p) },
    writeText: async (p, s) => { files.set(p, s) },
    listDir: async (p) => [...files.keys()].filter((k) => k.startsWith(p + '/')).map((k) => ({ name: k.slice(p.length + 1).split('/')[0] })),
  }
  const exec = () => ({ agent: { ctx: { get: (k) => (k === 'fs' ? fs : undefined) } } })
  return { files, call: (n, a) => TOOLS.find((x) => x.name === n).execute(a, exec()) }
}

/** 建书 + 写一条卷首章纲（entry 可控），返回 {call, dir, files}。 */
async function bookWith({ entry, initExtra = {}, legacy = false }) {
  const { files, call } = shimFs()
  const dir = '/books/rf'
  await call('novel_init', Object.assign({ book_dir: dir, title: '必答字段测试', genre: 'x', logline: 'y' }, initExtra))
  if (legacy) {
    // 模拟"合并前建的老书"：project.json 里没有 required_outline_fields
    const p = JSON.parse(files.get(dir + '/project.json'))
    delete p.required_outline_fields
    files.set(dir + '/project.json', JSON.stringify(p))
  }
  await call('novel_outline', { book_dir: dir, op: 'write', volume: 1, ch: 1, entry })
  return { files, call, dir }
}

const FULL = { title: '开篇', goal: 'g', hook: 'h', differentiation: '与榜单头部不同：X', choice_axis: { chosen: '甲', sacrificed: ['乙'] } }

test('S9①：新书卷首章缺必答字段 → verify 报 issues（不再静默通过）', async () => {
  const { call } = await bookWith({ entry: { title: '开篇', goal: 'g', hook: 'h', differentiation: 'X' } })
  const v = await call('novel_verify', { book_dir: '/books/rf' })
  assert.equal(v.ok, false, '缺 choice_axis 必须让 verify 变红：' + JSON.stringify(v.issues))
  assert.ok(v.issues.some((i) => i.includes('缺必答字段') && i.includes('choice_axis')), JSON.stringify(v.issues))
})

test('S9①b：字段带齐 → verify 不受影响（不能只有"报红"没有"变绿"）', async () => {
  const { call } = await bookWith({ entry: FULL })
  const v = await call('novel_verify', { book_dir: '/books/rf' })
  assert.equal(v.issues.some((i) => i.includes('缺必答字段')), false, JSON.stringify(v.issues))
})

test('S9②：旧书（无清单）保持宽松口径——存量书不误报', async () => {
  const { call } = await bookWith({ entry: { title: '开篇', goal: 'g', hook: 'h', differentiation: 'X' }, legacy: true })
  const v = await call('novel_verify', { book_dir: '/books/rf' })
  assert.equal(v.issues.some((i) => i.includes('缺必答字段')), false,
    '无清单＝合并前的老书，必须仍走"出现过才查"的宽松口径：' + JSON.stringify(v.issues))
})

test('S9③：显式登记空清单＝自愿不受约束（口径写在书上，不靠"用不用字段"暗示）', async () => {
  const { call } = await bookWith({ entry: { title: '开篇', goal: 'g', hook: 'h' }, initExtra: { required_outline_fields: [] } })
  const v = await call('novel_verify', { book_dir: '/books/rf' })
  assert.equal(v.issues.some((i) => i.includes('缺必答字段')), false, JSON.stringify(v.issues))
})

test('S9④：清单可自定义（登记什么就查什么）', async () => {
  const { call } = await bookWith({ entry: { title: '开篇', goal: 'g', hook: 'h', anchor_params: { word_window: [1, 2] } }, initExtra: { required_outline_fields: ['anchor_params'] } })
  const v = await call('novel_verify', { book_dir: '/books/rf' })
  assert.equal(v.issues.some((i) => i.includes('缺必答字段')), false, '登记了 anchor_params 且已带，不该报：' + JSON.stringify(v.issues))
})

test('S9⑤：novel_init 把清单落进 project.json（口径随书走，不靠记忆）', async () => {
  const { files } = await bookWith({ entry: FULL })
  const p = JSON.parse(files.get('/books/rf/project.json'))
  assert.deepEqual(p.required_outline_fields, ['differentiation', 'choice_axis'], '缺省清单必须是现行裁定要求的两项')
})
