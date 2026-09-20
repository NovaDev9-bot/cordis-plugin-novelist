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

// ── 输入哈希清单（2026-09-20 复核 REC-05）：软隔离的第一条机器可查段 ──────────
const MANIFEST = path.join(DIR, 'blind-manifest.mjs')

test('blind-manifest：确定性清单——同内容同 root_hash，改一字节即变；0 件/坏路径 exit 2', async () => {
  const d = await mkdtemp(path.join(tmpdir(), 'bm-'))
  const dir = path.join(d, 'pkg')
  await mkdir(dir, { recursive: true })
  await writeFile(path.join(dir, 'a.md'), '第一章 正文甲\n', 'utf8')
  await writeFile(path.join(dir, 'b.md'), '第二章 正文乙\n', 'utf8')
  const run = (args) => spawnSync(process.execPath, [MANIFEST, ...args], { encoding: 'utf8' })
  // 无参 → 用法 exit 2（判空前置纪律）
  const noArg = run([])
  assert.equal(noArg.status, 2, '无参应 exit 2，实得 ' + noArg.status)
  assert.match(noArg.stderr, /用法/)
  // 坏路径 → 没检查成 exit 2（0 件不是干净）
  const ghost = run([path.join(d, 'no-such-dir')])
  assert.equal(ghost.status, 2, '坏路径应 exit 2，实得 ' + ghost.status)
  assert.match(ghost.stderr, /没检查成/)
  // 确定性：两次同内容 → root_hash 相同
  const out1 = path.join(d, 'm1.json'), out2 = path.join(d, 'm2.json')
  assert.equal(run([dir, '--out', out1]).status, 0)
  assert.equal(run([dir, '--out', out2]).status, 0)
  const m1 = JSON.parse(await readFile(out1, 'utf8')), m2 = JSON.parse(await readFile(out2, 'utf8'))
  assert.equal(m1.count, 2)
  assert.equal(m1.root_hash, m2.root_hash, '同内容两次产清单必须同 root_hash（可复算）')
  // 改一字节 → root_hash 必变（这是"读了包外的东西哈希对不上"的底层保证）
  await writeFile(path.join(dir, 'b.md'), '第二章 正文丙\n', 'utf8')
  const out3 = path.join(d, 'm3.json')
  run([dir, '--out', out3])
  const m3 = JSON.parse(await readFile(out3, 'utf8'))
  assert.notEqual(m1.root_hash, m3.root_hash, '内容变了 root_hash 必须变')
  await rm(d, { recursive: true, force: true })
})

test('blind-manifest：跨 cwd / 换绝对位置——同相对结构 root_hash 不变（复核 N-2 修正）', async () => {
  // 为什么这条要在：清单存在的理由是"可复算比对"，而旧实现 base 取 cwd ⇒ 换个目录跑 root_hash 就变
  // （2026-09-20 本机实跑复现）。这两条断言把"与 cwd 无关""跨机同结构同哈希"从承诺变成回归。
  const d = await mkdtemp(path.join(tmpdir(), 'bm-port-'))
  const mkPkg = async (loc) => {
    await mkdir(path.join(loc, 'pkg', 'a'), { recursive: true })
    await mkdir(path.join(loc, 'pkg', 'b'), { recursive: true })
    await writeFile(path.join(loc, 'pkg', 'a', 'x.md'), '甲\n', 'utf8')
    await writeFile(path.join(loc, 'pkg', 'b', 'y.md'), '乙\n', 'utf8')
    return path.join(loc, 'pkg')
  }
  const p1 = await mkPkg(path.join(d, 'one'))
  const p2 = await mkPkg(path.join(d, 'two'))
  const run = (pkg, cwd, out) => spawnSync(process.execPath, [MANIFEST, pkg, '--out', out], { encoding: 'utf8', cwd })
  const o1 = path.join(d, 'p1.json'), o2 = path.join(d, 'p2.json'), o3 = path.join(d, 'p3.json')
  assert.equal(run(p1, d, o1).status, 0)
  assert.equal(run(p1, tmpdir(), o2).status, 0, '换 cwd 也要能跑')
  assert.equal(run(p2, d, o3).status, 0, '换绝对位置也要能跑')
  const b1 = await readFile(o1, 'utf8'), b2 = await readFile(o2, 'utf8')
  assert.equal(b1, b2, '同一输入换 cwd 必须逐字节相同（旧实现 base 取 cwd → root_hash 会变）')
  const m1 = JSON.parse(b1), m3 = JSON.parse(await readFile(o3, 'utf8'))
  assert.equal(m1.root_hash, m3.root_hash, '相对结构相同 ⇒ root_hash 相同（这就是跨机比对量）')
  assert.equal(m1.files.map((f) => f.path).join(','), 'a/x.md,b/y.md', 'paths 必须是相对公共基准的形式：' + JSON.stringify(m1.files.map((f) => f.path)))
  await rm(d, { recursive: true, force: true })
})

test('build-blind-pool 自动产输入清单：blind-manifest.json 在位且 key.manifest_root 对上（REC-05）', async () => {
  const d = await mkdtemp(path.join(tmpdir(), 'pool-mf-'))
  const armA = path.join(d, 'a'), armB = path.join(d, 'b'), pool = path.join(d, 'pool')
  await mkdir(armA, { recursive: true }); await mkdir(armB, { recursive: true })
  const body = '他推开那扇门，里面空无一人，只有一张落满灰的桌子。'.repeat(6)
  for (let i = 1; i <= 3; i++) {
    await writeFile(path.join(armA, `第${i}章.md`), `第${i}章 试写\n` + body, 'utf8')
    await writeFile(path.join(armB, `chapter_00${i}.md`), `chapter 00${i}\n` + body, 'utf8')
  }
  execFileSync(process.execPath, [POOL, armA, armB, pool, path.join(d, 'key.json'), '20260920'], { stdio: 'pipe' })
  const mf = JSON.parse(await readFile(path.join(pool, 'blind-manifest.json'), 'utf8'))
  const key = JSON.parse(await readFile(path.join(d, 'key.json'), 'utf8'))
  assert.equal(mf.pool_files.length, 6, '清单必须覆盖本次入池的 6 件')
  assert.equal(key.manifest_root, mf.pool_root_hash, 'key 记的 root 必须与清单一致（单一真值）')
  for (const f of mf.pool_files) assert.match(f.sha256, /^[0-9a-f]{64}$/, '每件都要有 sha256：' + f.path)
  assert.ok(mf.source_files.length >= 6, '来源文件哈希也要记（两臂各 3 章）')
  await rm(d, { recursive: true, force: true })
})
