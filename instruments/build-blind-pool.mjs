/**
 * build-blind-pool.mjs —— P-EXP 盲池构建（PLAN-PEX 判评前置 · 零 LLM）
 * 用法：node build-blind-pool.mjs [armA_dir] [armB_dir] [pool_name] [key_name] [seed]
 *   默认：P-EXP-1（a-book vs b-arm 草稿）；P-EXP-2 例：node build-blind-pool.mjs lab/p-exp/a-book/manuscript lab/p-exp/b2-book/manuscript blind-pool-2 blind-key-2 20260912
 *
 * 吃两臂各 3 章 → 去标识（剥章题/文件头/臂痕迹行）→ mulberry32(seed) 洗牌 → 盲池 + key。
 * 纪律：key 文件（slot→来源映射）判官永不可见；洗牌种子可复算。
 */
import { readdir, readFile, writeFile, mkdir } from 'node:fs/promises'
import path from 'node:path'

const ROOT = path.resolve(import.meta.dirname, '..')
const argv = process.argv.slice(2)
const ARM_A_DIR = argv[0] || 'lab/p-exp/a-book/manuscript'
const ARM_B_DIR = argv[1] || 'lab/p-exp/b-arm/4-正文'
const POOL_NAME = argv[2] || 'blind-pool'
const KEY_NAME = argv[3] || 'blind-key'
const SEED = Number(argv[4]) || 20260912
// 绝对路径直用、相对路径落 ROOT（默认值是仓内 lab 坐标；测试与跨仓复跑需要绝对路径）
const atRoot = (p) => path.isAbsolute(p) ? path.resolve(p) : path.join(ROOT, p)
const OUT = atRoot(POOL_NAME)
const KEY_PATH = atRoot(KEY_NAME.endsWith('.json') ? KEY_NAME : KEY_NAME + '.json')

function mulberry32(a) {
  return function () {
    a |= 0; a = (a + 0x6d2b79f5) | 0
    let t = Math.imul(a ^ (a >>> 15), 1 | a)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

// 去标识：剥文件头章题行、臂自标行（如"第X章"标题、校准卡引用头），统一空白
function stripIdent(text) {
  const lines = text.replace(/\r\n?/g, '\n').split('\n')
  const kept = []
  for (const line of lines) {
    const t = line.trim()
    if (!t) { kept.push(''); continue }
    // 章题/标题行（第X章、Chapter N、markdown 标题、书名号短行）
    if (/^第[零一二三四五六七八九十百千万0-9]+[章回节]/.test(t) || /^Chapter\s+\d+/i.test(t)) continue
    if (/^#{1,6}\s/.test(t)) continue // markdown 标题（含 # 第X章 形态，B 臂指纹）
    if (/^《.+》$/.test(t) && t.length <= 20) continue
    // 臂痕迹行（草稿标记/自检卡头）
    if (/^(草稿|校准自检|完稿自检|校准卡)/.test(t)) continue
    kept.push(t)
  }
  return kept.join('\n').replace(/\n{3,}/g, '\n\n').trim()
}

const sources = []
// 通用收集器：chapter_NNN.md 或 第N章*.md 两种命名都认
async function collect(dir, arm) {
  const files = (await readdir(atRoot(dir)).catch(() => []))
  const picked = []
  for (const f of files.sort()) {
    let ch = null
    if (/^chapter_\d+\.md$/.test(f)) ch = Number(f.match(/\d+/)[0])
    else { const m = f.match(/^第([123])章/); if (m) ch = Number(m[1]) }
    if (ch && ch <= 3) picked.push({ arm, ch, file: path.join(atRoot(dir), f) })
  }
  return picked.slice(0, 3)
}
sources.push(...(await collect(ARM_A_DIR, 'A')), ...(await collect(ARM_B_DIR, 'B')))
if (sources.length !== 6) { console.error(`✗ 期望 6 章，实得 ${sources.length}（A=${sources.filter(s=>s.arm==='A').length} B=${sources.filter(s=>s.arm==='B').length}）——两臂齐件后再跑`); process.exit(1) }

const slots = sources.map((_, i) => `slot-${i + 1}`)
// 洗 slot 顺序（不动来源数组，映射可复算）。
// 〔2026-09-19 第三方审计修〕种子必须真进洗牌：旧代码 `mulberry32(20260912)` 硬编码，
// 用户传的 seed 只进 key 不进洗牌——按 key 复算不出同一盲池，可复算性承诺失效。
const order = sources.map((_, i) => i)
const rnd = mulberry32(SEED)
for (let i = order.length - 1; i > 0; i--) { const j = Math.floor(rnd() * (i + 1)); [order[i], order[j]] = [order[j], order[i]] }

await mkdir(OUT, { recursive: true })
const key = {}
for (let i = 0; i < slots.length; i++) {
  const src = sources[order[i]]
  const text = stripIdent(await readFile(src.file, 'utf8'))
  await writeFile(path.join(OUT, `${slots[i]}.md`), text + '\n', 'utf8')
  key[slots[i]] = { arm: src.arm, ch: src.ch, source_file: path.relative(ROOT, src.file).replace(/\\/g, '/') }
}
await writeFile(KEY_PATH, JSON.stringify({ seed: SEED, built_at: new Date().toISOString(), key }, null, 2), 'utf8')
console.log(`[blind-pool] 6 章入池 → ${path.relative(ROOT, OUT)}（种子 ${SEED}；key 落 ${KEY_PATH}，判官永不可见）`)
for (const [slot, info] of Object.entries(key)) console.log(`  ${slot} ← ${info.arm} ch${info.ch}`)
