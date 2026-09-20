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

/** 对一组路径产清单；返回 { files:[{path,sha256,bytes}], root_hash }（path 为 base 相对、统一 / 分隔） */
export function manifestOf(targets, base = process.cwd()) {
  const { files, missing } = collectFiles(targets)
  if (missing) throw new Error('路径不存在：' + missing)
  if (files.length === 0) throw new Error('扫到 0 个文件（0 件不等于干净——目录空或路径错？）')
  const rows = files.map((f) => ({ path: path.relative(base, f).split(path.sep).join('/'), sha256: hashFile(f), bytes: statSync(f).size }))
  const root = sha256(rows.map((r) => r.sha256 + '  ' + r.path).join('\n'))
  return { files: rows, root_hash: root }
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
  const base = path.resolve(opt('--base', process.cwd()))
  let m
  try { m = manifestOf(clean, base) } catch (e) {
    console.error('[blind-manifest] 没检查成：' + e.message)
    process.exit(2)
  }
  const doc = { generated_at: new Date().toISOString(), base, count: m.files.length, root_hash: m.root_hash, files: m.files }
  const out = opt('--out')
  if (out) { writeFileSync(path.resolve(out), JSON.stringify(doc, null, 2) + '\n'); console.log('[blind-manifest] ' + m.files.length + ' 件 → ' + path.resolve(out) + ' · root_hash=' + m.root_hash.slice(0, 16)) }
  else console.log(JSON.stringify(doc, null, 2))
  for (const f of m.files) console.log('  ' + f.sha256.slice(0, 12) + '  ' + f.path)
  process.exit(0)
}
