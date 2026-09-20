// 盲读来源凭证（整改总计划 P2·C1 / 盲读协议 v1.3，2026-09-21）
//
// 为什么单列一条回归：非 DSH 宿主**没有工具级 deny**，盲读只能是软隔离——
// 而"切包即产输入清单、交付件回填 root_hash"是软隔离里**唯一机器可查的那一段**。
// 在它落地之前，一份缺凭证的读感记录不会报任何错，只会被当成与别的记录同强度使用。
// 判据（可复算，不靠人看）：夹具造读感记录 → ①缺 root_hash 时 verify 出 warning 且**点名**该文件；
// ②补上 root_hash 后该 warning 消失；③一份记录都没有时**不报**（没有派工不等于缺陷）。
//
// 用真 fs（不是 Map shim）：本检查走 listDir/stat.isDirectory/readText 三件套，
// 而 shim 的 stat 只返回 {size}——那会让本检查在 shim 下静默退化成空转（"绿"是假的）。
import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createNodeFsAdapter } from '../mcp/fs-adapter.mjs'
import { _internals } from '../lib/novelist.js'

const { TOOLS } = _internals
const execOf = (fs) => ({ agent: { ctx: { get: (k) => (k === 'fs' ? fs : undefined) } } })

async function makeBook(t, tag) {
  const root = mkdtempSync(join(tmpdir(), 'nf-creds-' + tag + '-'))
  t.after(() => rmSync(root, { recursive: true, force: true }))
  const fs = createNodeFsAdapter(root, { rootSource: 'test:blind-credentials' })
  const dir = join(root, '凭证书')
  const call = (n, a) => TOOLS.find((x) => x.name === n).execute(a, execOf(fs))
  await call('novel_init', { book_dir: dir, title: '凭证书', genre: 'xuanyi', logline: '他只想把欠的钱还上，可这条巷子不让他还' })
  return { root, dir, call }
}
const warningOf = (r) => (r.warnings || []).find((w) => w.includes('缺来源凭证'))
const mkRecord = (dir, rel, body) => {
  const p = join(dir, ...rel.split('/'))
  mkdirSync(join(p, '..'), { recursive: true })
  writeFileSync(p, body, 'utf8')
}

test('盲读凭证①：缺 root_hash 的读感记录必须被点名报出（warning，不判 issue）', async (t) => {
  const { dir, call } = await makeBook(t, 'missing')
  mkRecord(dir, 'editorial/blind-samples/批-测试/S1.json', JSON.stringify({ sampler: 'S1', opinions: [] }, null, 1))
  mkRecord(dir, 'orders/block-001/试读员-意见.md', '# 试读员-意见 · 第1章（包1/2）\n## 量表\n（略）\n')

  const r = await call('novel_verify', { book_dir: dir })
  const w = warningOf(r)
  assert.ok(w, '缺凭证必须出 warning：' + JSON.stringify(r.warnings || []))
  assert.match(w, /2\/2 份/, '要点名数量：' + w)
  assert.match(w, /blind-samples\/批-测试\/S1\.json/, '要点名到具体文件（主编要能直接去补）：' + w)
  assert.match(w, /试读员-意见\.md/, 'orders 下的单发记录同样要点名：' + w)
  assert.match(w, /来源不可考，证据力降级/, '文案要写死，别让读者当成格式问题：' + w)
  assert.match(w, /回填主体＝主编/, '代填主体必须点名——那只能证到"输入一致"，不证明输入唯一：' + w)
  assert.equal((r.issues || []).some((i) => i.includes('缺来源凭证')), false, '存量书会成片缺凭证：判 issue 等于把红灯贬值')
})

test('盲读凭证②：回填后该 warning 消失（守卫不许变成永远红）', async (t) => {
  const { dir, call } = await makeBook(t, 'ok')
  mkRecord(dir, 'editorial/blind-samples/批-测试/S1.json',
    JSON.stringify({ root_hash: 'a'.repeat(64), backfilled_by: '主编', opinions: [] }, null, 1))
  mkRecord(dir, 'orders/block-001/试读员-意见.md', '# 试读员-意见 · 第1章（包1/2）\n输入清单 root_hash: ' + 'a'.repeat(64) + '｜回填主体: 主编\n## 量表\n（略）\n')

  const r = await call('novel_verify', { book_dir: dir })
  assert.equal(warningOf(r), undefined, '补上凭证后不许再报：' + JSON.stringify(warningOf(r)))
})

test('盲读凭证③：一份读感记录都没有时不报（没派工 ≠ 缺陷）', async (t) => {
  const { dir, call } = await makeBook(t, 'none')
  const r = await call('novel_verify', { book_dir: dir })
  assert.equal(warningOf(r), undefined, '尚未派工盲读时不该出现凭证类 warning：' + JSON.stringify(warningOf(r)))
})

test('盲读凭证④：非读感记录（修订单等）不进这一类（不误报）', async (t) => {
  const { dir, call } = await makeBook(t, 'other')
  mkRecord(dir, 'orders/block-001/主编-汇总.md', '# 主编-汇总 · 第1章\n（合并意见）\n')
  const r = await call('novel_verify', { book_dir: dir })
  assert.equal(warningOf(r), undefined, '主编汇总不是盲读记录，不该要 root_hash：' + JSON.stringify(warningOf(r)))
})
