/**
 * vault-sync-check.mjs —— vault-template ↔ vault 一致性检查器（工程方向v3 §7.1 处置 · A3 附带，2026-09-11）
 * 用法：node vault-sync-check.mjs [<repoRoot>] [--all]
 *       （默认从脚本位置推 ../.. = dsh-native 的上级仓根）
 *
 * 背景：vault-template（随预设发行的模板）与 vault（主编实际读的实例）已双向分叉——
 * 评分卡实例落后两个版本、盲读协议实例超前未回流、三本角色手册实例侧缺失。
 * 本检查器把"一致性"从人肉记忆变成机器断言：同名文件哈希必须一致；单侧存在即报。
 *
 * 比对范围：默认只管【规范文件】——editorial/protocols、editorial/handbooks、craft、
 * market/feedback（这些是"怎么做"的唯一书面来源，分叉=主编读到旧规则）。--all 才逐文件全量比对
 * （vault 的 orders/reports/anchors 等运行数据本就只存在于实例侧，不算分叉）。
 * 退出码：分叉=1（可挂装机流程/CI），干净=0。
 */
import { readdir, readFile } from 'node:fs/promises'
import { createHash } from 'node:crypto'
import path from 'node:path'

const args = process.argv.slice(2)
const all = args.includes('--all')
const repoRoot = path.resolve(args[0] || path.join(import.meta.dirname, '..', '..'))
const TPL = path.join(repoRoot, 'dsh-native', 'vault-template')
const INST = path.join(repoRoot, 'vault')
const CURATED = ['editorial/protocols/', 'editorial/handbooks/', 'craft/', 'market/feedback/']

async function walk(dir, base = dir, acc = {}) {
  let entries
  try { entries = await readdir(dir, { withFileTypes: true }) } catch { return acc }
  for (const e of entries) {
    const p = path.join(dir, e.name)
    if (e.isDirectory()) await walk(p, base, acc)
    else {
      const rel = path.relative(base, p).replace(/\\/g, '/')
      if (!all && !CURATED.some((c) => rel.startsWith(c))) continue
      const buf = await readFile(p)
      acc[rel] = {
        size: buf.length,
        sha256: createHash('sha256').update(buf).digest('hex').slice(0, 16),
      }
    }
  }
  return acc
}

const tplFiles = await walk(TPL)
const instFiles = await walk(INST)

const onlyTpl = Object.keys(tplFiles).filter((f) => !instFiles[f]).sort()
const onlyInst = Object.keys(instFiles).filter((f) => !tplFiles[f]).sort()
const diverged = Object.keys(tplFiles).filter((f) => instFiles[f] && tplFiles[f].sha256 !== instFiles[f].sha256).sort()

console.log(`[vault-sync-check] 模板 ${Object.keys(tplFiles).length} 件 ｜ 实例 ${Object.keys(instFiles).length} 件`)
let bad = 0
if (onlyTpl.length) { bad += onlyTpl.length; console.log(`✗ 实例缺失（模板有、vault 无）${onlyTpl.length} 件：`); for (const f of onlyTpl) console.log(`    - ${f}`) }
if (onlyInst.length) { bad += onlyInst.length; console.log(`✗ 模板缺失（vault 有、模板无）${onlyInst.length} 件：`); for (const f of onlyInst) console.log(`    - ${f}`) }
if (diverged.length) { bad += diverged.length; console.log(`✗ 同名分叉（哈希不一致）${diverged.length} 件：`); for (const f of diverged) console.log(`    - ${f}（模板 ${tplFiles[f].size}B vs 实例 ${instFiles[f].size}B）`) }
if (!bad) console.log('✓ 模板与实例逐文件哈希一致')
else {
  console.log(`\n处置提示：先人裁哪侧是对的（v3 §7.1 建议 vault-template 为唯一真源、vault 为生成物）；`)
  console.log(`裁定后把分叉侧改齐再重跑本检查器。机器只报分叉，不替人裁内容。`)
  process.exit(1)
}
