// batch-aggregate.mjs 单元测试（OSS 布局：引擎在 ../instruments/）
import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, writeFileSync, mkdirSync, readdirSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

const SCRIPT = fileURLToPath(new URL('../instruments/batch-aggregate.mjs', import.meta.url))

function run(chapter, samples, extra = []) {
  const dir = mkdtempSync(path.join(tmpdir(), 'ba-'))
  const chap = path.join(dir, 'ch.md')
  writeFileSync(chap, chapter, 'utf8')
  const sdir = path.join(dir, 'samples')
  mkdirSync(sdir)
  samples.forEach((s, i) => writeFileSync(path.join(sdir, 's' + i + '.json'), JSON.stringify(s), 'utf8'))
  const out = spawnSync(process.execPath, [SCRIPT, chap, sdir, '--write', dir, ...extra], { encoding: 'utf8' })
  const aggFile = readdirSync(dir).find((f) => f.startsWith('_aggregate-'))
  const agg = aggFile ? JSON.parse(readFileSync(path.join(dir, aggFile), 'utf8')) : null
  return { stdout: out.stdout, stderr: out.stderr, code: out.status, agg }
}

test('聚合引擎：同段同类两票升级、单报盲存、伪引文拒收、审计件落盘', () => {
  const chapter = ['第一段。夜里的德音楼亮着最后一盏灯，灯下有人影一动不动。', '第二段。小满推门进来，手里攥着一块玉佩。', '第三段。雨停了，檐下还在滴水。'].join('\n')
  const samples = [
    { sampler: 'R1', opinions: [
      { evidence: '夜里的德音楼亮着最后一盏灯', issue: '开场无钩', p0: false, kind: 'A1' },
      { evidence: '檐下还在滴水', issue: '收尾仓促', p0: false, kind: 'B8' },
    ] },
    { sampler: 'R2', opinions: [
      { evidence: '灯下有人影一动不动', issue: '人影无后文', p0: true, kind: 'A1' },
      { evidence: '这句根本不在正文里出现好吗', issue: '编的', p0: false, kind: 'X' },
    ] },
    { sampler: 'R3', opinions: [] },
  ]
  const { stdout, code, agg } = run(chapter, samples)
  assert.equal(code, 0)
  assert.ok(stdout.includes('3 采样员'), '采样员计数')
  assert.ok(stdout.includes('伪引文拒收'), '伪引文被拒并计数')
  assert.ok(stdout.includes('×2票'), '两票簇升级（R1/R2 同段同类 A1）')
  assert.ok(stdout.includes('第1段'), '段落坐标正确')
  assert.ok(stdout.includes('单报 1 条已盲存'), '单报不展示只盲存')
  assert.ok(agg, '审计件落盘')
  assert.equal(agg.samples, 3)
  assert.equal(agg.rejected.length, 1, '伪引文进审计件')
  assert.equal(agg.escalated.length, 1, '一簇升级')
  assert.equal(agg.escalated[0].votes, 2)
  assert.equal(agg.single_blind.length, 1, 'B8 单报盲存')
})

test('聚合引擎：p0 严重单报进待复核通道（不隐没、不自动确诊）', () => {
  const chapter = '第一段。夜里的德音楼亮着最后一盏灯，灯下有人影一动不动。'
  const samples = [
    { sampler: 'R1', opinions: [{ evidence: '夜里的德音楼亮着最后一盏灯', issue: '主角动机断裂', p0: true, kind: 'A1' }] },
    { sampler: 'R2', opinions: [{ evidence: '灯下有人影一动不动', issue: '收尾仓促', p0: false, kind: 'B8' }] },
  ]
  const { stdout, agg } = run(chapter, samples)
  assert.ok(stdout.includes('待复核'), 'p0 单报在 stdout 以待复核名义可见（不静默隐没）')
  assert.equal(agg.p0_review.length, 1, 'p0 单报进独立待复核通道')
  assert.equal(agg.p0_review[0].para, '0')
  assert.equal(agg.p0_review[0].p0, true, '待复核记录保留 p0 标记')
  assert.equal(agg.single_blind.length, 1, '非 p0 单报维持盲存不展示')
  assert.equal(agg.escalated.length, 0, '未达 k 票不升级为确认分歧')
})

test('聚合引擎：--k=3 时两票簇降为盲存（阈值可调）', () => {
  const chapter = '第一段。夜里的德音楼亮着最后一盏灯，灯下有人影一动不动。'
  const samples = [
    { sampler: 'R1', opinions: [{ evidence: '夜里的德音楼亮着最后一盏灯', issue: '无钩', kind: 'A1' }] },
    { sampler: 'R2', opinions: [{ evidence: '灯下有人影一动不动', issue: '无后文', kind: 'A1' }] },
  ]
  const { stdout, agg } = run(chapter, samples, ['--k=3'])
  assert.ok(stdout.includes('无——本批无分歧升级'), 'k=3 两票不升级')
  assert.equal(agg.single_blind.length, 1, '两票簇整体转盲存')
})
