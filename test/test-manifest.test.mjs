/**
 * test-manifest.test.mjs —— **测试清单的自证**：每个 *.test.mjs 都必须有入口会跑
 *
 * 为什么要有它：2026-09-19 实测发现仓里三个测试文件**没有任何入口会跑**
 * （`instruments/style-check.test.mjs`、`instruments/instrument-aggregate.test.mjs`、
 *  `scripts/build-wb-expert.test.mjs`）——而 `package.json` 的 test 脚本是**手写的文件清单**，
 * 新增测试文件时漏登记一次，它就永久沉默。代价当场印证过：装配器回归 5 条里 4 条红，
 * 没有任何人知道（`check-all` 只跑 package.json 那份清单）。
 *
 * "没有执行入口的守卫等于没有守卫"——这条纪律写在 `check-all.mjs` 的文件头，
 * 而这条纪律自己此前没有执行入口。本文件补上：**清单完整性由测试自己断言**。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readdirSync, readFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = path.resolve(fileURLToPath(new URL('..', import.meta.url)))
const pkg = JSON.parse(readFileSync(path.join(ROOT, 'package.json'), 'utf8'))
const listed = new Set((pkg.scripts.test.match(/[\w./-]+\.test\.mjs/g) || []).map((p) => p.split(path.sep).join('/')))

const SKIP_DIRS = new Set(['node_modules', '.git', 'vendor'])
function walk(dir, out = []) {
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    if (e.name.startsWith('.') || SKIP_DIRS.has(e.name)) continue
    const p = path.join(dir, e.name)
    if (e.isDirectory()) walk(p, out)
    else if (e.name.endsWith('.test.mjs')) out.push(path.relative(ROOT, p).split(path.sep).join('/'))
  }
  return out
}

test('清单自证：仓里每个 *.test.mjs 都在 package.json 的 test 脚本里', () => {
  const found = walk(ROOT)
  // 空集自证：扫到 0 件时不是"干净"，是路径/过滤写错了
  assert.ok(found.length >= 10, '只扫到 ' + found.length + ' 个测试文件，太少——多半是遍历写错了')
  const orphans = found.filter((f) => !listed.has(f))
  assert.deepEqual(orphans, [], '这些测试文件没有任何入口会跑（写进 package.json 的 test 脚本）：\n  ' + orphans.join('\n  '))
})

test('清单自证：test 脚本里写的每个文件都真实存在（防改名后留死引用）', () => {
  const missing = [...listed].filter((f) => !existsRel(f))
  assert.deepEqual(missing, [], 'test 脚本指向不存在的文件：\n  ' + missing.join('\n  '))
})

function existsRel(rel) {
  try { readFileSync(path.join(ROOT, rel)); return true } catch { return false }
}
