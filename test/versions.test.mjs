// 版本一致性（批E，2026-09-17）：包版本与公开预设的版本声明必须同步。
//
// 为什么需要断言而不是靠人记得：历史上出现过"版本戳三处不同步"（插件取证实锤），
// 靠纪律记住三处一起改是不可靠的——能自动查的就不要留在纪律里。
// 说明：guide 的 v7.x 是**机制版本**，与包版本（0.8.x）是两套口径，不要求相等，
// 只要求格式良好且单调可读；本测试查的是"同一套口径内部的声明是否一致"。
import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import path from 'node:path'
import { _internals } from '../lib/novelist.js'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const read = (rel) => readFileSync(path.join(ROOT, rel), 'utf8')

test('批E: 版本一致性——package.json 与公开预设声明的版本必须同源', () => {
  const pkg = JSON.parse(read('package.json'))
  assert.match(pkg.version, /^\d+\.\d+\.\d+$/, '包版本必须是 semver')
  const preset = read('preset-starter/agent.cordis.yml')
  const m = preset.match(/公开版·v(\d+\.\d+\.\d+)/)
  assert.ok(m, '预设文件头应声明版本（形如「公开版·v0.8.0」）')
  assert.equal(m[1], pkg.version, '预设声明版本与 package.json 不一致——两处必须一起改（本测试就是为了逼出这件事）')
})

test('批E: guide 机制版本格式良好，且沿革件指针指向真实文件', () => {
  const guide = _internals.SECTION.text
  const m = guide.match(/novelist-guide v(\d+\.\d+)/)
  assert.ok(m, 'guide 头部应含机制版本（形如 v7.7）')
  const ptr = guide.match(/([A-Za-z]:[\\/][^\s]*guide-history\.md|\/[^\s]*guide-history\.md)/)
  assert.ok(ptr, 'guide 必须给出沿革件的绝对路径（相对路径对模型不可解）')
  assert.ok(readFileSync(ptr[1], 'utf8').length > 0, '指针指向的沿革件必须真实存在且非空：' + ptr[1])
})

test('批E: 工具数量口径一致（防"文档说 12 个、实际变了没人发现"）', () => {
  const n = _internals.TOOLS.length
  assert.equal(n, 14, 'novel_search 注册后应有 14 个工具')
  const desc = read('package.json').match(/(\d+|Twelve|Eleven|Thirteen|Fourteen) deterministic novel_\* tools/i)
  assert.ok(desc, 'package.json 描述应声明工具数量')
  const words = { twelve: 12, eleven: 11, thirteen: 13, fourteen: 14 }
  const claimed = /^\d+$/.test(desc[1]) ? Number(desc[1]) : words[desc[1].toLowerCase()]
  assert.equal(claimed, n, 'package.json 描述的工具数与实际不符（实际 ' + n + '）')
  const names = _internals.TOOLS.map((t) => t.name)
  for (const f of ['README.md', 'mcp/README.md']) {
    const s = read(f)
    if (/\d+ 个工具|1[0-9] tools/.test(s)) assert.ok(s.includes(String(n)) || s.includes('十二') || s.includes('十三') || s.includes('十四'), f + ' 里的工具数与实际不符')
  }
  assert.equal(new Set(names).size, n, '工具名不得重复')
})
