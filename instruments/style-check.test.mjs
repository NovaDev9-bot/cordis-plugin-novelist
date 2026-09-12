/**
 * style-check.test.mjs —— A3 机检层回归（工程方向v3 §4.1 A3，2026-09-11）
 * 锁死：公式化四组检测、负向词库命中、段落/感叹号度量、章切分、GBK 回退、vault 分叉检查器。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, mkdir, writeFile, readFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { execFileSync } from 'node:child_process'

const DIR = import.meta.dirname
const STYLE = path.join(DIR, 'style-check.mjs')
const VAULT = path.join(DIR, 'vault-sync-check.mjs')

async function runStyle(content, extra = []) {
  const d = await mkdtemp(path.join(tmpdir(), 'sc-'))
  const f = path.join(d, 'sample.txt')
  await writeFile(f, content, 'utf8')
  const out = path.join(d, 'out.json')
  execFileSync(process.execPath, [STYLE, f, '--json', out, ...extra], { stdio: 'pipe' })
  return JSON.parse(await readFile(out, 'utf8'))
}

test('公式化检测：AI 腔样本四组全中 → 旗标；干净样本不中', async () => {
  const ai = ['那是一个寒冷的夜晚，他走进了城。',
    '与此同时，守卫动了。然而就在这时，铃声响起。',
    '这简直难以置信。他竟然来了。她居然笑了。',
    '这不是恐惧，而是兴奋，而是期待。',
    '他深吸一口气，看向远处。'].join('\n')
  const r1 = await runStyle(ai)
  assert.ok(r1.units[0].formula.score_distinct_categories >= 3, `应≥3，实得 ${r1.units[0].formula.score_distinct_categories}`)
  assert.equal(r1.units[0].formula.flag, true)
  assert.ok(r1.units[0].formula.template_openings['那是一个…的夜晚'] >= 1)
  assert.ok(r1.units[0].formula.generic_transitions['与此同时'] >= 1)
  assert.ok(r1.units[0].formula.emphasis_abuse['简直'] >= 1)
  assert.ok(r1.units[0].formula.triple_parallel['不是…而是…而是'] >= 1)

  const clean = ['他把刀往背上一挎，走了。',
    '山道上有霜。萧尘走得快，鞋底打滑，他骂了一声。',
    '「多少钱？」他问。',
    '「两个铜板。」'].join('\n')
  const r2 = await runStyle(clean)
  assert.equal(r2.units[0].formula.flag, false)
})

test('负向词库扩展槽：--lexicon 自备词库按类计数', async () => {
  const d0 = await mkdtemp(path.join(tmpdir(), 'sc-'))
  const lexFile = path.join(d0, 'my-lex.json')
  await writeFile(lexFile, JSON.stringify({ negative_lexicon: { 我的测试类: ['瞳孔剧烈收缩', '倒吸一口凉气'] } }), 'utf8')
  const f = path.join(d0, 'sample.txt')
  await writeFile(f, '他瞳孔剧烈收缩，倒吸一口凉气。', 'utf8')
  const out = path.join(d0, 'out.json')
  execFileSync(process.execPath, [STYLE, f, '--json', out, '--lexicon', lexFile], { stdio: 'pipe' })
  const r = JSON.parse(await readFile(out, 'utf8'))
  const cats = r.units[0].negative_lexicon.by_cat
  assert.ok(cats['我的测试类'].hits['瞳孔剧烈收缩'] >= 1)
  assert.ok(cats['我的测试类'].hits['倒吸一口凉气'] >= 1)
})


test('段落与感叹号度量：已知结构精确出数', async () => {
  const paras = ['短段。', 'b'.repeat(160) + '。', '叹！又叹！再叹！']
  const r = await runStyle(paras.join('\n'))
  const u = r.units[0]
  assert.equal(u.paragraphs.n, 3)
  assert.equal(u.paragraphs.share_gt_150, Math.round(1 / 3 * 1000) / 1000)
  assert.equal(u.exclam.count, 3)
})

test('章切分：第X章识别 + 目录残片滤除（<200字）', async () => {
  const t = '第一章 起点\n' + '正文'.repeat(200) + '\n第二章 残片\n只有一行\n第三章 又一章\n' + '内容'.repeat(200) + '\n第四章 末章\n' + '结尾'.repeat(200)
  const r = await runStyle(t)
  assert.equal(r.aggregate.chapters_detected, 3, `应识别 3 章（残片被滤），实得 ${r.aggregate.chapters_detected}`)
  assert.equal(r.units.length, 3)
})

test('GBK 自动回退：非法 UTF-8 字节走 GBK 解码', async () => {
  const d = await mkdtemp(path.join(tmpdir(), 'sc-'))
  const f = path.join(d, 'gbk.txt')
  await writeFile(f, Buffer.from([0xc4, 0xe3, 0xba, 0xc3, 0xa3, 0xa1]), // 你好！ in GBK
  )
  const out = path.join(d, 'out.json')
  execFileSync(process.execPath, [STYLE, f, '--json', out], { stdio: 'pipe' })
  const r = JSON.parse(await readFile(out, 'utf8'))
  assert.equal(r.aggregate.enc_used, 'gbk')
  assert.equal(r.units[0].exclam.count, 1)
})

test('vault-sync-check：规范文件分叉/缺失可检出，退出码 1', async () => {
  const d = await mkdtemp(path.join(tmpdir(), 'vs-'))
  await mkdir(path.join(d, 'dsh-native', 'vault-template', 'editorial', 'protocols'), { recursive: true })
  await mkdir(path.join(d, 'vault', 'editorial', 'protocols'), { recursive: true })
  await mkdir(path.join(d, 'vault', 'editorial', 'orders'), { recursive: true }) // 运行数据：不应报
  await writeFile(path.join(d, 'dsh-native', 'vault-template', 'editorial', 'protocols', 'a.md'), '模板版', 'utf8')
  await writeFile(path.join(d, 'vault', 'editorial', 'protocols', 'a.md'), '实例改过', 'utf8')
  await writeFile(path.join(d, 'dsh-native', 'vault-template', 'editorial', 'protocols', 'b.md'), '手册', 'utf8') // 实例缺失
  await writeFile(path.join(d, 'vault', 'editorial', 'orders', '运行数据.md'), 'x', 'utf8') // 不在白名单
  let r
  try { execFileSync(process.execPath, [VAULT, d], { stdio: 'pipe', encoding: 'utf8' }); r = { status: 0, stdout: '' } }
  catch (e) { r = { status: e.status, stdout: e.stdout } }
  assert.equal(r.status, 1)
  assert.ok(r.stdout.includes('同名分叉'))
  assert.ok(r.stdout.includes('b.md'))
  assert.ok(!r.stdout.includes('运行数据'), '运行数据不应算分叉')
})
