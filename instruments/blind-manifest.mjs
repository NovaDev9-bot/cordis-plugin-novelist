#!/usr/bin/env node
/**
 * blind-manifest.mjs —— 输入哈希清单（盲读/盲池的"我依据的输入"取证，零 LLM，只读）
 *
 * 用法：
 *   node blind-manifest.mjs <文件|目录>... [--out <manifest.json>] [--base <相对根>]
 *   npm 侧示例：node scripts/blind-manifest.mjs editorial/blind-samples/批-2026-09-20 --out 派工包清单.json
 *
 * 为什么要有它（2026-09-20 第三方复核 REC-05）：非 DSH 宿主没有 toolFilter.deny，
 * 盲读只能是"只读派工包"的**纪律条款**——软隔离。软隔离此前**没有能红的回归**：
 * 盲角色读了包外的东西，不会报错，只会交回一份通顺、有理由、很客气但没有用的数据。
 * 本工具把"派工包 = 哪些文件、各是什么哈希"变成可复算的数据：
 *   ① 派工时生成清单（本工具）随派工包发放；
 *   ② 交付件回填它的 root_hash（或逐文件哈希）；
 *   ③ 聚合/主编校验不一致 → 判"输入污染"（与 Q6②b 只读派工包是同一条链上的机器可查段）。
 *
 * 判据（与全仓守卫同族）：**0 件 = 没检查成**（exit 2），不是"干净"；
 * 清单里的 root_hash ＝ 排序后的 "sha256  path" 行的 sha256——只要有一字节不同就变。
 *
 * 跨机可比（2026-09-20 复核 N-2 修正）：
 *   · `base` 默认取**输入集合的最近公共祖先**（同盘），不再是 cwd——`files[].path` 一律相对它；
 *   · 清单里**没有任何时间戳/机器名**，所以同一输入集合在任何 cwd 重算 ⇒ **逐字节相同**；
 *   · 把同一相对结构的包拷到别的机器（绝对位置不同）重算 ⇒ **`root_hash` 相同**（`base` 字段会不同，
 *     它只是给人读的绝对路径）。**唯一跨机比对量 = `root_hash`**。
 *   旧实现的 base 取 cwd：换个目录跑 root_hash 就变——2026-09-20 本机实跑复现（复核方当时观察到
 *   的"root_hash 跨 cwd 稳定"与实现不符），故按构造修掉，不靠"用的时候记得带 --base"。
 */
import { createHash } from 'node:crypto'
import { readFileSync, writeFileSync, readdirSync, statSync } from 'node:fs'
import path from 'node:path'
import { pathToFileURL } from 'node:url'

const argv = process.argv.slice(2)
const opt = (k, d) => { const i = argv.indexOf(k); return i >= 0 ? argv[i + 1] : d }

export const sha256 = (buf) => createHash('sha256').update(buf).digest('hex')
export const hashFile = (p) => sha256(readFileSync(p))

/** 收集文件（目录递归，跳过隐藏项与 node_modules） */
export function collectFiles(targets) {
  const out = []
  for (const t of targets) {
    const abs = path.resolve(t)
    const st = statSync(abs, { throwIfNoEntry: false })
    if (!st) return { files: [], missing: abs }
    if (st.isFile()) { out.push(abs); continue }
    for (const e of readdirSync(abs, { withFileTypes: true })) {
      if (e.name.startsWith('.') || e.name === 'node_modules') continue
      const p = path.join(abs, e.name)
      if (e.isDirectory()) out.push(...collectFiles([p]).files)
      else out.push(p)
    }
  }
  return { files: out.sort(), missing: null }
}

/**
 * 输入集合的公共基准目录：文件取所在目录、目录取自身，多目标取最近公共祖先。
 * 跨盘符（没有公共目录）或路径不存在 → null（由调用方报"算不出基准"，不静默退回 cwd）。
 */
export function commonBaseOf(targets) {
  const dirs = []
  for (const t of targets) {
    const abs = path.resolve(t)
    const st = statSync(abs, { throwIfNoEntry: false })
    if (!st) return null
    dirs.push(st.isDirectory() ? abs : path.dirname(abs))
  }
  if (!dirs.length) return null
  let cur = dirs[0]
  for (const d of dirs.slice(1)) {
    const a = cur.split(path.sep)
    const b = d.split(path.sep)
    let i = 0
    while (i < a.length && i < b.length && a[i].toLowerCase() === b[i].toLowerCase()) i++
    cur = a.slice(0, i).join(path.sep)
  }
  if (!cur) return null                        // 跨盘符：只有空串公共
  if (/^[A-Za-z]:$/.test(cur)) cur += path.sep // 只共到盘符 → 归一成盘根
  return cur
}

/** 对一组路径产清单；base 缺省＝输入集公共基准（⇒ 与 cwd 无关，可复算）。 */
export function manifestOf(targets, base = null) {
  const b = base ? path.resolve(base) : commonBaseOf(targets)
  if (!b) throw new Error('算不出输入集的公共基准（跨盘符或路径不存在）——请显式给 --base <相对根>')
  const { files, missing } = collectFiles(targets)
  if (missing) throw new Error('路径不存在：' + missing)
  if (files.length === 0) throw new Error('扫到 0 个文件（0 件不等于干净——目录空或路径错？）')
  const rows = files
    .map((f) => ({ path: path.relative(b, f).split(path.sep).join('/'), sha256: hashFile(f), bytes: statSync(f).size }))
    // 按**相对路径**排序（不是绝对路径）：换机器/换绝对位置时顺序不变，root_hash 才可比
    .sort((x, y) => (x.path < y.path ? -1 : x.path > y.path ? 1 : 0))
  const root = sha256(rows.map((r) => r.sha256 + '  ' + r.path).join('\n'))
  return { base: b, files: rows, root_hash: root }
}

// ── CLI（被 import 时不执行）────────────────────────────────────────────────
const isMain = process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href
if (isMain) {
  const clean = []
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--out' || argv[i] === '--base') { i++; continue }
    if (!argv[i].startsWith('--')) clean.push(argv[i])
  }
  if (clean.length === 0) {
    console.error('用法：node blind-manifest.mjs <文件|目录>... [--out <manifest.json>] [--base <相对根>]')
    process.exit(2)
  }
  let m
  try { m = manifestOf(clean, opt('--base', null)) } catch (e) {
    console.error('[blind-manifest] 没检查成：' + e.message)
    process.exit(2)
  }
  // 不写 generated_at：清单里出现时间戳，同一输入集合就没法逐字节比对了——
  // 而"这份清单有没有被改过、是不是同一份输入"正是它存在的理由（批次日期在派工包自己的命名里）。
  const doc = { base: m.base, count: m.files.length, root_hash: m.root_hash, files: m.files }
  const out = opt('--out')
  if (out) { writeFileSync(path.resolve(out), JSON.stringify(doc, null, 2) + '\n'); console.log('[blind-manifest] ' + m.files.length + ' 件 → ' + path.resolve(out) + ' · root_hash=' + m.root_hash.slice(0, 16)) }
  else console.log(JSON.stringify(doc, null, 2))
  for (const f of m.files) console.log('  ' + f.sha256.slice(0, 12) + '  ' + f.path)
  process.exit(0)
}
