/**
 * marginal-cost-check.test.mjs —— B1 边际成本累积律闸回归（总纲 §3 B1，2026-09-26）
 * 锁死：①比值输出正确（修 N 引 M）②M≥N EXIT 1 亮红停改（含 M==N 边界）③M<N EXIT 0
 * ④判重口径＝「类别＋锚点句」逐字判等（空白/折行/全角空格归一化；类别不同即不同条）
 * ⑤正文只做锚点存在性提示、不参与计数 ⑥坏输入 EXIT 2（缺字段/坏 JSON/缺文件/空锚点）
 * ⑦0/0 无特例判停（防空清单静默装绿）＋空清单告警。合成两版＋合成清单，全走临时目录，跑完即删（书无关原则）。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, writeFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { spawnSync } from 'node:child_process'

const DIR = import.meta.dirname
const SCRIPT = path.join(DIR, 'marginal-cost-check.mjs')

async function withStage(files, fn) {
  const d = await mkdtemp(path.join(tmpdir(), 'mcc-'))
  const p = {}
  try {
    for (const [name, content] of Object.entries(files)) {
      const fp = path.join(d, name)
      await writeFile(fp, content, 'utf8')
      p[name] = fp
    }
    return await fn(p)
  } finally {
    await rm(d, { recursive: true, force: true })
  }
}

function run(args) {
  const r = spawnSync(process.execPath, [SCRIPT, ...args], { encoding: 'utf8' })
  const lines = (r.stdout || '').split('\n').map((l) => l.trim()).filter(Boolean)
  let summary = null
  if (lines.length) { try { summary = JSON.parse(lines[lines.length - 1]) } catch { /* 坏输入路径没有 JSON 行 */ } }
  return { status: r.status, stderr: r.stderr || '', stdout: r.stdout || '', summary }
}

test('修6引10 复刻：比值输出正确 + M≥N 亮红 EXIT 1 + 新引入条目清单齐', async () => {
  // 合成 rev5：8 条缺陷锚点句在场；rev6：前 6 条修掉（句子消失）、后 2 条原样保留、新增 10 条
  const S = (n) => `缺陷句${n}他在这里。`
  const B = (n) => `新引入句${n}这一行是新毛病。`
  const rev5 = [...Array.from({ length: 8 }, (_, i) => S(i + 1)), '铺垫句原样带过。'].join('')
  const rev6 = [...Array.from({ length: 10 }, (_, i) => B(i + 1)), S(7), S(8), '铺垫句原样带过。'].join('')
  const cats = ['超长句', '碎段', '指代不明', '逻辑断层', '单句段', '套语', '轻重倒', '口径不一']
  const beforeList = cats.map((c, i) => ({ category: c, anchor: S(i + 1), note: `rev5 第${i + 1}条` }))
  // 修订后清单换用中文别名键 + defects 包装，顺带锁死两种输入形状
  const afterList = {
    defects: [
      { 类别: cats[6], 锚点句: S(7), note: 'rev5 已报' },
      { 类别: cats[7], 锚点句: S(8) },
      ...Array.from({ length: 10 }, (_, i) => ({ category: i % 2 ? '超长句' : '逻辑断层', anchor: B(i + 1), severity: '高把握' })),
    ],
  }
  await withStage({ 'rev5.md': rev5, 'rev6.md': rev6, 'before.json': JSON.stringify(beforeList), 'after.json': JSON.stringify(afterList) }, (p) => {
    const r = run([p['rev5.md'], p['rev6.md'], p['before.json'], p['after.json']])
    assert.equal(r.status, 1, 'M(10)≥N(6) 必须 EXIT 1')
    assert.equal(r.summary.fixed, 6)
    assert.equal(r.summary.introduced, 10)
    assert.equal(r.summary.persisted, 2)
    assert.equal(r.summary.verdict, 'STOP')
    assert.equal(r.summary.stop_rule, 'M>=N')
    assert.equal(r.summary.introduced_items.length, 10)
    assert.equal(r.summary.persisted_items.length, 2)
    assert.equal(r.summary.before_distinct, 8)
    assert.equal(r.summary.after_distinct, 12)
    assert.ok(r.stdout.includes('修掉 N = 6'), stdoutLine(r.stdout, '修掉'))
    assert.ok(r.stdout.includes('新引入 M = 10'), stdoutLine(r.stdout, '新引入'))
    assert.ok(r.stdout.includes('⛔'), '必须亮红（⛔）')
    assert.ok(r.stdout.includes('立即停止本轮定向修'), '必须打印停改建议')
    assert.ok(r.stdout.includes('新引入条目清单'), '必须输出新引入条目清单')
    assert.deepEqual(r.summary.persisted_items.map((x) => x.anchor), [S(7), S(8)])
    assert.equal(r.summary.advisories.length, 0, '本场景锚点要么消失要么新增，不应有存在性提示')
  })
})

test('M<N：EXIT 0 收敛放行', async () => {
  const rev1 = '甲句在此。乙句在此。丙句在此。丁句在此。戊句在此。'
  const rev2 = '丙句在此。戊句在此。新丁一句。'
  // 持续未修的丙/戊必须两轮清单都在场（判等键同）——只进一轮就会被算成修掉/新引入
  const before = [{ category: '超长句', anchor: '甲句在此。' }, { category: '碎段', anchor: '乙句在此。' }, { category: '指代不明', anchor: '丁句在此。' }, { category: '超长句', anchor: '丙句在此。' }, { category: '套语', anchor: '戊句在此。' }]
  const after = [{ category: '超长句', anchor: '丙句在此。' }, { category: '套语', anchor: '戊句在此。' }, { category: '套语', anchor: '新丁一句。' }]
  await withStage({ 'r1.md': rev1, 'r2.md': rev2, 'b.json': JSON.stringify(before), 'a.json': JSON.stringify(after) }, (p) => {
    const r = run([p['r1.md'], p['r2.md'], p['b.json'], p['a.json']])
    assert.equal(r.status, 0)
    assert.equal(r.summary.fixed, 3)
    assert.equal(r.summary.introduced, 1)
    assert.equal(r.summary.persisted, 2)
    assert.equal(r.summary.verdict, 'OK')
  })
})

test('M==N 边界：判停（累积律是 ≥ 不是 >）', async () => {
  await withStage({ 'r1.md': '甲。乙。', 'r2.md': '丙。丁。', 'b.json': '[{"category":"超长句","anchor":"甲。"},{"category":"碎段","anchor":"乙。"}]', 'a.json': '[{"category":"套语","anchor":"丙。"},{"category":"指代不明","anchor":"丁。"}]' }, (p) => {
    const r = run([p['r1.md'], p['r2.md'], p['b.json'], p['a.json']])
    assert.equal(r.status, 1, 'M(2)==N(2) 必须 EXIT 1')
    assert.equal(r.summary.verdict, 'STOP')
  })
})

test('判重口径①：锚点句空白/全角空格/折行归一化后判等（同条算持续，不算修掉+新引入）', async () => {
  await withStage({ 'r1.md': '他只念号。', 'r2.md': '他只念号。', 'b.json': '[{"category":"超长句","anchor":"他只念号。"}]', 'a.json': '[{"category":" 超长 句","anchor":"他\\t只念\\u3000号。\\n "}]' }, (p) => {
    const r = run([p['r1.md'], p['r2.md'], p['b.json'], p['a.json']])
    assert.equal(r.status, 1, '修掉0＋新引入0：修订零净效果 ⇒ M≥N 判停（无特例）')
    assert.equal(r.summary.fixed, 0)
    assert.equal(r.summary.introduced, 0)
    assert.equal(r.summary.persisted, 1, '空白归一化后应判等为同一条（持续未修）')
    assert.equal(r.summary.verdict, 'STOP')
  })
})

test('判重口径①：同锚点句不同类别＝不同条（类别参与判等）', async () => {
  await withStage({ 'r1.md': '他只念号。', 'r2.md': '他只念号。', 'b.json': '[{"category":"超长句","anchor":"他只念号。"}]', 'a.json': '[{"category":"指代不明","anchor":"他只念号。"}]' }, (p) => {
    const r = run([p['r1.md'], p['r2.md'], p['b.json'], p['a.json']])
    assert.equal(r.status, 1, '修掉1＋新引入1 ⇒ M≥N 停')
    assert.equal(r.summary.fixed, 1)
    assert.equal(r.summary.introduced, 1)
    assert.equal(r.summary.persisted, 0, '类别不同必须判为不同条，不得并入持续')
  })
})

test('口径③：正文锚点存在性只出提示不计数（疑似二轮漏报/一轮漏报）', async () => {
  const rev1 = '旧句甲。新句丙。'
  const rev2 = '旧句甲。新句丙。别的话。'
  const before = [{ category: '超长句', anchor: '旧句甲。' }]
  const after = [{ category: '碎段', anchor: '新句丙。' }]
  await withStage({ 'r1.md': rev1, 'r2.md': rev2, 'b.json': JSON.stringify(before), 'a.json': JSON.stringify(after) }, (p) => {
    const r = run([p['r1.md'], p['r2.md'], p['b.json'], p['a.json']])
    assert.equal(r.status, 1)
    assert.equal(r.summary.fixed, 1, 'N/M 只由两轮清单判等差决定——提示不得改计数')
    assert.equal(r.summary.introduced, 1)
    assert.equal(r.summary.advisories.length, 2)
    assert.ok(r.summary.advisories.some((a) => a.includes('疑似未真修或二轮仪器漏报')), stdoutLine(r.stdout, '提示'))
    assert.ok(r.summary.advisories.some((a) => a.includes('疑似一轮仪器漏报')))
    assert.ok(r.stdout.includes('不参与计数'), '必须明示提示不参与计数')
  })
})

test('清单内判等键重复：去重计数并告警', async () => {
  const before = [{ category: '超长句', anchor: '甲。' }, { category: '超长句 ', anchor: '甲。' }]
  const after = [{ category: '套语', anchor: '乙。' }]
  await withStage({ 'r1.md': '甲。', 'r2.md': '乙。', 'b.json': JSON.stringify(before), 'a.json': JSON.stringify(after) }, (p) => {
    const r = run([p['r1.md'], p['r2.md'], p['b.json'], p['a.json']])
    assert.equal(r.status, 1, '去重后 N=1、M=1 ⇒ M≥N 判停')
    assert.equal(r.summary.verdict, 'STOP')
    assert.equal(r.summary.fixed, 1, '重复键去重后修掉 1')
    assert.equal(r.summary.before_distinct, 1)
    assert.ok(r.summary.warnings.some((w) => w.includes('判等键重复')), '必须出重复告警')
  })
})

test('坏输入一律 EXIT 2（缺参数/缺文件/坏 JSON/缺字段/空锚点）', async () => {
  assert.equal(run([]).status, 2, '零参数')
  assert.equal(run(['a', 'b', 'c']).status, 2, '参数不足')
  await withStage({ 'r1.md': 'x', 'r2.md': 'x', 'bad.json': '{oops', 'nofield.json': '[{"category":"超长句"}]', 'emptyanchor.json': '[{"category":"超长句","anchor":"\\u3000 "}]', 'ok.json': '[]' }, (p) => {
    const missing = path.join(tmpdir(), 'mcc-missing-' + Date.now() + '.json')
    assert.equal(run([p['r1.md'], p['r2.md'], missing, p['ok.json']]).status, 2, '清单文件不存在')
    const rBad = run([p['r1.md'], p['r2.md'], p['bad.json'], p['ok.json']])
    assert.equal(rBad.status, 2)
    assert.ok(rBad.stderr.includes('不是合法 JSON'), '坏 JSON 报因')
    const rField = run([p['r1.md'], p['r2.md'], p['nofield.json'], p['ok.json']])
    assert.equal(rField.status, 2)
    assert.ok(rField.stderr.includes('缺「类别'), '缺锚点句字段要报清缺哪个')
    const rEmpty = run([p['r1.md'], p['r2.md'], p['emptyanchor.json'], p['ok.json']])
    assert.equal(rEmpty.status, 2, '锚点句去空白后为空＝无法判等')
    assert.ok(run([p['r1.md'], p['r2.md'], p['ok.json'], p['bad.json']]).stdout === '', 'EXIT 2 不得产出机器读数行')
  })
})

test('0/0 无特例：两轮清单均空 ⇒ 仍 EXIT 1 判停＋空清单告警（防错拿空清单静默装绿）', async () => {
  await withStage({ 'r1.md': '正文。', 'r2.md': '正文改。', 'b.json': '[]', 'a.json': '[]' }, (p) => {
    const r = run([p['r1.md'], p['r2.md'], p['b.json'], p['a.json']])
    assert.equal(r.status, 1, 'M(0)≥N(0) 按判据字面判停——不设特例')
    assert.equal(r.summary.verdict, 'STOP')
    assert.equal(r.summary.fixed, 0)
    assert.equal(r.summary.introduced, 0)
    assert.ok(r.summary.warnings.some((w) => w.includes('两轮清单去重后均 0 条')), '必须明示两轮均空，供人工核对转录')
  })
})

function stdoutLine(stdout, key) {
  const line = stdout.split('\n').find((l) => l.includes(key))
  return line ? `实得行：${line.trim()}` : `stdout 全文：${stdout}`
}
