/**
 * instrument-aggregate.test.mjs —— A1 修复回归（工程方向v3 §4.1 A1，2026-09-11）
 * 锁死四个行为：①sd=0 / n<5 显式不可测不静默；②常数仪表信度门假绿 → FAIL；③两轴冲突 →
 * verdict_blocked；④exact/ICC 正常出数。夹具全为合成数据，跑真实校准库见 lab/calibration。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, mkdir, writeFile, readFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { execFileSync } from 'node:child_process'

const SCRIPT = path.join(import.meta.dirname, 'instrument-aggregate.mjs')

async function runFixture({ scores, baseline }) {
  const dir = await mkdtemp(path.join(tmpdir(), 'ia-'))
  await mkdir(path.join(dir, 'editorial'), { recursive: true })
  await writeFile(path.join(dir, 'editorial', 'scores.jsonl'), scores.map((s) => JSON.stringify(s)).join('\n'), 'utf8')
  const args = [dir]
  if (baseline) {
    const bl = path.join(dir, 'bl.json')
    await writeFile(bl, JSON.stringify(baseline), 'utf8')
    args.push('--baseline', bl, '--out', path.join(dir, 'editorial'))
  }
  execFileSync(process.execPath, [SCRIPT, ...args], { stdio: 'pipe' })
  return JSON.parse(await readFile(path.join(dir, 'editorial', 'instrument-report.json'), 'utf8'))
}

const ts = (i) => `2026-09-11T00:00:0${i}.000Z`

test('sd=0 与 n<5 的基线维度 → 显式不可测 + 告警（不静默跳过）', async () => {
  const scores = [
    { ts: ts(1), ch: 1, dim: '题材与赛道', score: 4, judge: 'j', mode: 'absolute' },
    { ts: ts(2), ch: 1, dim: '开篇留人', score: 4, judge: 'j', mode: 'absolute' },
  ]
  const baseline = { '题材与赛道': { mean: 4, sd: 0, n: 12 }, '开篇留人': { mean: 4, sd: 1, n: 3 } }
  const r = await runFixture({ scores, baseline })
  assert.equal(r.dims['题材与赛道'].baseline_status.includes('sd=0'), true)
  assert.equal(r.dims['开篇留人'].baseline_status.includes('n=3'), true)
  assert.equal(r.unmeasurable_dims.length, 2)
  assert.equal(r.warnings.some((w) => w.includes('sd=0')), true)
  assert.equal(r.dims['题材与赛道'].z_bands, undefined)
})

test('常数仪表：within-1/exact 恒满分但量程检验 → 信度门 FAIL（假绿堵死）', async () => {
  const scores = []
  for (let ch = 1; ch <= 8; ch++) for (let i = 0; i < 2; i++) scores.push({ ts: ts(i), ch, dim: '人味去AI味', score: 5, judge: 'j', mode: 'absolute' })
  const r = await runFixture({ scores })
  assert.equal(r.test_retest.within1_rate, 100)
  assert.equal(r.test_retest.exact_rate, 100)
  assert.equal(r.test_retest.verdict.includes('FAIL'), true)
  assert.equal(r.test_retest.verdict.includes('量程未使用'), true)
  assert.equal(r.test_retest.scale_usage.distinct_values.length, 1)
})

test('两轴冲突：成对判显著胜 + 绝对分档过半低 → verdict_blocked 阻断', async () => {
  const scores = [
    // 绝对轴：爽点维 8 条全部落低档（mean=4.92+bias 后 1-4 全"低"）
    ...[1, 2, 3, 4, 5, 6, 7, 8].map((ch) => ({ ts: ts(1), ch, dim: '爽点兑现密度', score: 4, judge: 'j', mode: 'absolute' })),
    // 成对轴：同维 8 胜 0 平 2 负 = 80%
    ...[1, 1, 1, 1, 1, 1, 1, 1, -1, -1].map((sc, i) => ({ ts: ts(2), ch: 100 + i, dim: '爽点兑现密度', score: sc, judge: 'p', mode: 'anchored_pair' })),
  ]
  const baseline = { '爽点兑现密度': { mean: 3.92, sd: 0.67, n: 12, bias: { correction: 1 } } }
  const r = await runFixture({ scores, baseline })
  assert.equal(r.axis_conflicts.length, 1)
  assert.equal(r.verdict_blocked[0], '爽点兑现密度')
  assert.equal(r.dims['爽点兑现密度'].z_bands['le-1sigma'], 8)
  assert.equal(r.anchored_pair.by_dim['爽点兑现密度'].win_rate, 80)
})

test('正常量程 + 有方差：exact/ICC 出数，PASS', async () => {
  const scores = []
  const pat = [2, 3, 4, 5, 3, 4, 2, 5, 4, 3]
  for (let ch = 1; ch <= 10; ch++) {
    scores.push({ ts: ts(1), ch, dim: '期待管理', score: pat[ch - 1], judge: 'j', mode: 'absolute' })
    scores.push({ ts: ts(2), ch, dim: '期待管理', score: pat[ch - 1], judge: 'j', mode: 'absolute' }) // 完全复测一致
  }
  const r = await runFixture({ scores })
  assert.equal(r.test_retest.exact_rate, 100)
  assert.ok(r.test_retest.icc_2_1 > 0.9)
  assert.equal(r.test_retest.verdict.startsWith('PASS'), true)
})

test('手工 bias 常数 → 挂 I3 警示', async () => {
  const scores = [{ ts: ts(1), ch: 1, dim: '爽点兑现密度', score: 4, judge: 'j', mode: 'absolute' }]
  const baseline = { '爽点兑现密度': { mean: 3.92, sd: 0.67, n: 12, bias: { correction: 1, provenance: 'J3' } } }
  const r = await runFixture({ scores, baseline })
  assert.equal(r.warnings.some((w) => w.includes('手工常数') && w.includes('I3')), true)
  assert.equal(r.dims['爽点兑现密度'].bias_applied.correction, 1)
})
