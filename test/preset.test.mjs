// 预设静态不变量（防自批 + 盲读闭合）——纯文本解析，不引 YAML 依赖。
// 存在理由：v7.0/v7.4 新增的 novel_ask/novel_decide/novel_score 没被补进盲角色 deny 名单，
// 盲读红线在工具面留了缺口（novel_ask 能读出账本+事件带+欠线，正好是盲角色不该看的东西）。
// 这类缺口没有编译期报错、没有运行时报错，只有"有人对着名单比一遍"才发现——本文件就是那个比对。
import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { _internals } from '../lib/novelist.js'

const YML = readFileSync(new URL('../preset-starter/agent.cordis.yml', import.meta.url), 'utf8')

/** 取某角色块的 deny 名单（块 = 从 `- id: <role>` 到下一个 `- id:` 或文件尾）。 */
function denyOf(role) {
  const start = YML.indexOf('- id: ' + role)
  assert.ok(start >= 0, '预设里找不到角色块：' + role)
  const rest = YML.slice(start)
  const next = rest.indexOf('\n- id: ', 1)
  const block = next >= 0 ? rest.slice(0, next) : rest
  const m = block.match(/deny: \[([^\]]*)\]/)
  assert.ok(m, role + ' 块内应有 deny 名单')
  return m[1].split(',').map((s) => s.trim()).filter(Boolean)
}

/** 工具面无遗漏：每个已注册工具都必须被显式点名（deny 或明确允许），杜绝"新工具默认可用"。 */
test('预设：盲读工种 deny 覆盖账本读写与查询面（含 v7.0/v7.4/v7.8 新工具）', () => {
  for (const role of ['nf-role-reader', 'nf-role-calibrator']) {
    const deny = denyOf(role)
    for (const t of ['novel_chapter', 'novel_ledger', 'novel_outline', 'novel_bible', 'novel_verify', 'novel_count', 'novel_event', 'novel_ask', 'novel_decide', 'novel_score', 'novel_context', 'novel_search']) {
      assert.ok(deny.includes(t), role + ' 应 deny ' + t + '（盲读红线：一切输入只来自派工包）')
    }
    for (const t of ['read', 'write', 'edit', 'glob', 'grep', 'pwsh']) {
      assert.ok(deny.includes(t), role + ' 应封 ' + t + '（纯盲内联）')
    }
  }
})

test('预设：主笔 deny 写类与事件带，但保留查设定、自核字数与**正文检索**（自查旧文的唯一通道）', () => {
  const deny = denyOf('nf-role-author')
  for (const t of ['novel_chapter', 'novel_ledger', 'novel_init', 'novel_assemble', 'novel_outline', 'novel_event', 'edit', 'glob', 'grep', 'pwsh']) {
    assert.ok(deny.includes(t), '主笔应 deny ' + t + '（落账权唯一在主编）')
  }
  for (const keep of ['novel_bible', 'novel_count', 'novel_ask', 'read', 'write']) {
    assert.equal(deny.includes(keep), false, '主笔应保留 ' + keep + '（写前查设定 / 交付自核字数 / 重读纪律）')
  }
  // B 批（2026-09-18）：宿主权限按工具名不按路径，主笔被 deny glob/grep＝连书目录都搜不了；
  // novel_search 是"只能搜书目录"的门，主笔必须保留（Owner 拍板：主笔要能自查旧文）。
  assert.equal(deny.includes('novel_search'), false, '主笔必须保留 novel_search——这是他自查旧文的唯一通道（放开 glob 等于放开整块硬盘）')
})

test('预设：每个 deny 名单里的工具名都是真存在或已知宿主工具（防拼写笔误静默失效）', () => {
  // 已知宿主工具名（非 novel_*）：一旦拼错，deny 静默失效=红线纸面化，所以这里点名核对
  const HOST_TOOLS = new Set(['read', 'write', 'edit', 'glob', 'grep', 'pwsh', 'read_image'])
  const REGISTERED = new Set(_internals.TOOLS.map((t) => t.name))
  const roles = [...YML.matchAll(/^- id: (nf-role-[a-z]+)/gm)].map((m) => m[1])
  assert.ok(roles.length >= 6, '应解析出全部角色块，实得 ' + roles.length)
  for (const role of roles) {
    if (['nf-role-reader', 'nf-role-calibrator', 'nf-role-proofer', 'nf-role-dissector'].includes(role)) {
      assert.ok(denyOf(role).includes('novel_context'), role + ' 必须隔离账本上下文')
      assert.ok(denyOf(role).includes('novel_search'), role + ' 必须隔离正文检索（盲读只见派工包）')
    }
    for (const t of denyOf(role)) {
      assert.ok(REGISTERED.has(t) || HOST_TOOLS.has(t), role + ' 的 deny 含未知工具名（拼写错误会让 deny 静默失效）：' + t)
    }
  }
})
