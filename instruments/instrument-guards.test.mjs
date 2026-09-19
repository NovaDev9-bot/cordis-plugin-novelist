/**
 * instrument-guards.test.mjs —— 仪器"没检查成"守卫回归（2026-09-19 第三方审计批）
 * 锁死四类此前静默撒谎的行为：
 *   ① style-check 无参调用 → 用法提示 exit 2（旧：炸在 path.resolve(undefined)，提示不可达）
 *   ② structure-check 书目录不存在 → exit 2 零输出（旧：产出"全 0 空报告"+null 泄漏，EXIT 0）
 *   ③ instrument-aggregate 书目录不存在 → exit 2 不建目录不写文件（旧：凭空造目录树写报告）
 *   ④ build-blind-pool 的 seed 真进洗牌（旧：只进 key 不进洗牌，可复算承诺失效）
 *      ＋ corpus-falsify 锚书作者从 ANCHORS 单源反查（旧：第二份硬编码名单，ANCHORS 死代码）
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, mkdir, writeFile, readFile, rm } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { spawnSync, execFileSync } from 'node:child_process'

const DIR = import.meta.dirname
const STYLE = path.join(DIR, 'style-check.mjs')
const STRUCT = path.join(DIR, 'structure-check.mjs')
const AGG = path.join(DIR, 'instrument-aggregate.mjs')
const POOL = path.join(DIR, 'build-blind-pool.mjs')
const FALSIFY = path.join(DIR, 'corpus-falsify.mjs')

test('style-check 无参调用 → 用法提示 exit 2（判空必须在 resolve 之前）', () => {
  const r = spawnSync(process.execPath, [STYLE], { encoding: 'utf8' })
  assert.equal(r.status, 2, '应 exit 2，实得 ' + r.status + '（exit 1+TypeError＝判空不可达的旧病）')
  assert.match(r.stderr, /用法/, '应打印用法而不是堆栈：' + r.stderr.slice(0, 200))
})

test('structure-check 书目录不存在 → exit 2，不产出"全 0 报告"、不泄漏 null', () => {
  const ghost = path.join(tmpdir(), 'no-such-book-' + Date.now() + '-' + Math.random().toString(36).slice(2))
  const r = spawnSync(process.execPath, [STRUCT, ghost], { encoding: 'utf8' })
  assert.equal(r.status, 2, '应 exit 2，实得 ' + r.status)
  assert.match(r.stderr, /没检查成/, '要报"没检查成"而不是空报告：' + r.stderr.slice(0, 200))
  assert.doesNotMatch(r.stdout, /null/, 'stdout 不许有 null 泄漏：' + r.stdout.slice(0, 200))
  assert.equal(existsSync(ghost), false, '不许凭空创建书目录')
})

test('instrument-aggregate 书目录不存在 → exit 2，不建目录不写文件', async () => {
  const d = await mkdtemp(path.join(tmpdir(), 'ia-guard-'))
  const ghost = path.join(d, 'ghost-book')
  const r = spawnSync(process.execPath, [AGG, ghost], { encoding: 'utf8' })
  assert.equal(r.status, 2, '应 exit 2，实得 ' + r.status)
  assert.match(r.stderr, /没检查成/, '要报"没检查成"：' + r.stderr.slice(0, 200))
  assert.equal(existsSync(ghost), false, '不许凭空创建书目录（本仪器唯一的磁盘副作用缺陷）')
  await rm(d, { recursive: true, force: true })
})

test('build-blind-pool：seed 真进洗牌——同 seed 复算一致，异 seed 排列不同', async () => {
  const d = await mkdtemp(path.join(tmpdir(), 'pool-guard-'))
  const armA = path.join(d, 'a'), armB = path.join(d, 'b')
  await mkdir(armA, { recursive: true }); await mkdir(armB, { recursive: true })
  const body = '他推开那扇门，里面空无一人，只有一张落满灰的桌子。'.repeat(6)
  for (let i = 1; i <= 3; i++) {
    await writeFile(path.join(armA, `第${i}章.md`), `第${i}章 试写\n` + body, 'utf8')
    await writeFile(path.join(armB, `chapter_00${i}.md`), `chapter 00${i}\n` + body, 'utf8')
  }
  const runPool = async (seed) => {
    execFileSync(process.execPath, [POOL, armA, armB, path.join(d, 'pool-' + seed), path.join(d, 'key-' + seed + '.json'), String(seed)], { stdio: 'pipe' })
    return JSON.parse(await readFile(path.join(d, 'key-' + seed + '.json'), 'utf8'))
  }
  const slotMap = (k) => Object.fromEntries(Object.entries(k.key).map(([s, v]) => [s, v.arm + ':' + v.ch]))
  const k7 = await runPool(7)
  const k7b = await runPool(7)
  assert.deepEqual(slotMap(k7), slotMap(k7b), '同 seed 两次构建，盲池映射必须可复算（built_at 除外）')
  assert.equal(k7.seed, 7, 'key.seed 必须是用户传入的 seed')
  const k8 = await runPool(8)
  assert.notDeepEqual(slotMap(k7), slotMap(k8), '不同 seed 洗出同一排列＝seed 没进洗牌（旧病）')
  await rm(d, { recursive: true, force: true })
})

test('corpus-falsify：锚书作者从 ANCHORS 反查强制入选（名单单源，不再靠第二份硬编码）', async () => {
  const d = await mkdtemp(path.join(tmpdir(), 'cf-guard-'))
  const corpus = path.join(d, 'corpus')
  const anchorAuthor = '测试锚书作者甲', plainAuthor = '测试普通作者乙'
  await mkdir(path.join(corpus, anchorAuthor), { recursive: true })
  await mkdir(path.join(corpus, plainAuthor), { recursive: true })
  const body = '他把刀横在膝上，火光把影子钉在墙上，风从缝隙里挤进来，吹得火星明明灭灭。'.repeat(8)
  await writeFile(path.join(corpus, anchorAuthor, '惊悚乐园.txt'), '第一章 入场\n' + body, 'utf8')
  await writeFile(path.join(corpus, plainAuthor, '普通书.txt'), '第一章 开场\n' + body, 'utf8')
  const index = path.join(d, 'index.csv')
  await writeFile(index, [
    '"作者","书名","字节数","编码"',
    `"${anchorAuthor}","惊悚乐园","${body.length * 3}","utf8"`,
    `"${plainAuthor}","普通书","${body.length * 3}","utf8"`,
  ].join('\n'), 'utf8')
  const r = spawnSync(process.execPath, [FALSIFY, '--corpus', corpus, '--index', index, '--books', '2', '--chapters', '1', '--out', d], { encoding: 'utf8' })
  assert.equal(r.status, 0, '应成功：' + (r.stderr || r.stdout).slice(0, 300))
  assert.match(r.stdout, /锚书作者 1 强制/, '锚书作者（惊悚乐园→甲）必须被强制入选：' + r.stdout.slice(0, 300))
  assert.match(r.stdout, /✓ .*惊悚乐园/, '锚书本体应出现在抽样明细里')
  await rm(d, { recursive: true, force: true })
})
