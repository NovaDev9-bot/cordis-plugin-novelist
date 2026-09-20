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
  // 2026-09-18 审计 P0 修复：deny 是按"工具名清单"手工枚举的，而"写能力"的判据是"会不会落盘"——
  // 两者不同源，v7.0/v7.4 新增 novel_decide（改章状态机/落事件带）与 novel_score（写判据账）时
  // 只给盲角色补了名单，主笔这边漏了：他能自批状态迁移、自写"裁决"、冒名 judge。
  // 清单枚举型红线在工具增加时必然漂移，故此处把写类全家显式钉死。
  for (const t of ['novel_decide', 'novel_score']) {
    assert.ok(deny.includes(t), '主笔必须 deny ' + t + '（写类：状态机/事件带/判据账——防自批不变量是构造性的，不能只靠纪律）')
  }
  for (const keep of ['novel_bible', 'novel_count', 'novel_ask', 'read', 'write']) {
    assert.equal(deny.includes(keep), false, '主笔应保留 ' + keep + '（写前查设定 / 交付自核字数 / 重读纪律）')
  }
  // B 批（2026-09-18）：宿主权限按工具名不按路径，主笔被 deny glob/grep＝连书目录都搜不了；
  // novel_search 是"只能搜书目录"的门，主笔必须保留（Owner 拍板：主笔要能自查旧文）。
  assert.equal(deny.includes('novel_search'), false, '主笔必须保留 novel_search——这是他自查旧文的唯一通道（放开 glob 等于放开整块硬盘）')
})

test('预设：每个 deny 名单里的工具名都是真存在或已知宿主工具（防拼写笔误静默失效）', () => {
  // 已知宿主工具名**不再在本文件里手写一份**（2026-09-20）：原先这里有一张 HOST_TOOLS 常量表，
  // 与 roles/tool-face.json 是同一事实的第二处。名单加了派工工具（nf_*）之后这张表当场过期，
  // 报出来的句子是"拼写错误"——真正过期的却是这张副本。现在统一从能力表取（宿主工具名的唯一真源），
  // 再加 lib 注册表里的 novel_*；两边都取不到的名字才叫笔误。
  const TABLE = JSON.parse(readFileSync(new URL('../roles/tool-face.json', import.meta.url), 'utf8'))
  const KNOWN = new Set(_internals.TOOLS.map((t) => t.name))
  for (const cap of Object.values(TABLE.capabilities)) {
    if (cap.dsh && Array.isArray(cap.dsh.tools)) for (const n of cap.dsh.tools) KNOWN.add(n)
  }
  for (const v of Object.values(TABLE.hosts.dsh.packages || {})) {
    if (Array.isArray(v.tools)) for (const n of v.tools) KNOWN.add(n)
  }
  assert.ok(KNOWN.size >= 20, '已知工具名集合过小（能力表没读到？）：' + KNOWN.size)
  const roles = [...YML.matchAll(/^- id: (nf-role-[a-z]+)/gm)].map((m) => m[1])
  assert.ok(roles.length >= 6, '应解析出全部角色块，实得 ' + roles.length)
  for (const role of roles) {
    if (['nf-role-reader', 'nf-role-calibrator', 'nf-role-proofer', 'nf-role-dissector'].includes(role)) {
      assert.ok(denyOf(role).includes('novel_context'), role + ' 必须隔离账本上下文')
      assert.ok(denyOf(role).includes('novel_search'), role + ' 必须隔离正文检索（盲读只见派工包）')
    }
    for (const t of denyOf(role)) {
      assert.ok(KNOWN.has(t), role + ' 的 deny 含未知工具名（拼写错误会让 deny 静默失效）：' + t)
    }
  }
})

test('预设：盲角色另封扇出与工具发现，并带结构性深度锁（2026-09-20 Owner 批①）', () => {
  // 为什么单列一条：这不是"多封几个名字"，是**能力层**的缺口——盲角色若能派生子代理，
  // 就等于开了一条绕过派工包的取数通道（子代理去读账本再回报），名单封得再全也白封。
  // 名字锁与深度锁两件都要有：前者管当下，后者管"将来多挂一个派工工具"（名字锁不会报，深度锁照锁）。
  const lines = YML.split('\n')
  for (const role of ['nf-role-reader', 'nf-role-calibrator', 'nf-role-proofer', 'nf-role-dissector']) {
    const deny = denyOf(role)
    for (const t of ['nf_author', 'nf_archivist', 'nf_reader', 'nf_calibrator', 'nf_proof', 'nf_dissector']) {
      assert.ok(deny.includes(t), role + ' 必须封派工工具 ' + t)
    }
    assert.ok(deny.includes('send_message'), role + ' 必须封跨代理发消息（盲仪器的对外通道）')
    const start = lines.findIndex((l) => l === '- id: ' + role)
    const end = lines.findIndex((l, i) => i > start && /^- id: /.test(l))
    const body = lines.slice(start, end === -1 ? lines.length : end)
    assert.ok(body.some((l) => /^\s*maxDepth: 0\s*$/.test(l)), role + ' 缺 maxDepth: 0（深度锁）')
  }
  // 非盲角色不许带这把锁：多出来的锁同样是漂移，且会静默掐掉它们的正常工作流
  for (const role of ['nf-role-author', 'nf-role-archivist']) {
    const start = lines.findIndex((l) => l === '- id: ' + role)
    const end = lines.findIndex((l, i) => i > start && /^- id: /.test(l))
    const body = lines.slice(start, end === -1 ? lines.length : end)
    assert.equal(body.some((l) => /^\s*maxDepth:/.test(l)), false, role + ' 不该有 maxDepth')
  }
})
