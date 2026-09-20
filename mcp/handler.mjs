/**
 * novelist MCP —— 协议处理（G1，v0.8.0）。
 *
 * MCP stdio transport：newline-delimited JSON-RPC 2.0（UTF-8；日志/诊断走 stderr）。
 * 本文件只做协议逻辑（可测纯函数，不碰 stdin/stdout/process）；IO 壳见 server.mjs。
 *
 * 协议来源：modelcontextprotocol.io 规范 2025-06-18（lifecycle/tools/prompts/transports）。
 * - initialize → 回显客户端版本（在支持清单内）或回我们支持的最新版
 * - tools/list → 本插件全部工具（schema 现成于 lib TOOLS[].parameters → inputSchema）
 * - tools/call → 伪造 exec（agent.ctx.get('fs') 返回适配器）注入 lib 执行；渲染优先
 *   output.render（其返回 [{type:'text',text}] 恰为 MCP content 格式）；执行错误走
 *   isError:true（规范：业务错误入 result，协议错误入 JSON-RPC error）
 * - prompts/list|get → novelist-guide（lib SECTION 全文，与 DSH 侧 systemPrompt 同源同版）
 */
const SUPPORTED_VERSIONS = ['2025-06-18', '2024-11-05']

/**
 * 入参运行时校验（批C，2026-09-17）：按 tools/list 已公示的 schema 做 required/type/enum/
 * 未知键预检——DSH 宿主侧有架构校验，MCP 侧没有；缺参/类型错若直落 execute，报出来的是
 * 深层 TypeError（"Cannot read properties of undefined"），调用方看不懂也不知道该补什么。
 * 纯确定性、零 LLM：只查结构，不做语义判断（值与业务规则的校验仍在各工具内）。
 */
/**
 * 本校验器支持的 JSON Schema 关键字白名单。
 * 为什么要有白名单：schema 里出现本校验器不认识的关键字（如 pattern/minimum/anyOf）时，
 * 旧实现会**静默跳过**——工具对外公示的契约与实际校验强度不一致，且没有任何信号。
 * 现在改为：启动时扫全部 schema，出现白名单外关键字即报错（宁可启动失败，不可带盲区上线）。
 */
const SUPPORTED_KEYWORDS = new Set(['type', 'properties', 'required', 'additionalProperties', 'enum', 'items', 'description', 'default'])

/** 扫一个 schema 的白名单外关键字（递归）。返回形如 ['select.pattern'] 的路径列表。 */
export function schemaBlindSpots(schema, at = '') {
  const out = []
  if (!schema || typeof schema !== 'object' || Array.isArray(schema)) return out
  for (const [k, v] of Object.entries(schema)) {
    const here = at ? at + '.' + k : k
    if (!SUPPORTED_KEYWORDS.has(k)) { out.push(here); continue }
    if (k === 'properties' && v && typeof v === 'object') {
      for (const [pk, pv] of Object.entries(v)) out.push(...schemaBlindSpots(pv, here + '.' + pk))
    } else if (k === 'items') {
      out.push(...schemaBlindSpots(v, here + '[]'))
    }
  }
  return out
}

/** 值 → 类型名（用于错误消息；number 区分有限/非有限）。 */
function typeOf(v) {
  if (typeof v === 'number') return Number.isFinite(v) ? 'number' : 'not-finite'
  if (Array.isArray(v)) return 'array'
  if (v === null) return 'null'
  return typeof v
}

/**
 * 递归校验（批R5）：旧实现只查顶层，42 处嵌套的 `additionalProperties:false` 形同虚设——
 * `select:{kind:'timeline', 打错的键:1}`、`seeds:[{id}]` 这类嵌套结构从来没被查过。
 * path 标出出错位置（如 select.window.from），让调用方一次改对。
 */
function validateNode(schema, value, at, errs) {
  if (!schema || typeof schema !== 'object') return
  const label = (k) => (at ? (k ? at + '.' + k : at) : k)
  const t = schema.type
  if (t === 'object') {
    if (typeof value !== 'object' || Array.isArray(value) || value === null) errs.push(label('') + ' 需为对象（got ' + typeOf(value) + '）')
  } else if (t) {
    const got = typeOf(value)
    if (t === 'integer' && !Number.isInteger(value)) errs.push(label('') + ' 需为整数（got ' + got + '）')
    else if (t === 'number' && typeof value !== 'number') errs.push(label('') + ' 需为数字（got ' + got + '）')
    else if (t === 'string' && typeof value !== 'string') errs.push(label('') + ' 需为字符串（got ' + got + '）')
    else if (t === 'boolean' && typeof value !== 'boolean') errs.push(label('') + ' 需为布尔（got ' + got + '）')
    else if (t === 'array' && !Array.isArray(value)) errs.push(label('') + ' 需为数组（got ' + got + '）')
  }
  if (Array.isArray(schema.enum) && !schema.enum.includes(value)) {
    errs.push(label('') + ' 取值须为 ' + schema.enum.join('/') + '（got ' + JSON.stringify(value) + '）')
  }
  if (Array.isArray(value)) {
    if (schema.items) value.forEach((v, i) => validateNode(schema.items, v, (at || '参数') + '[' + i + ']', errs))
    return
  }
  if (value && typeof value === 'object') {
    const props = schema.properties || {}
    for (const r of (schema.required || [])) {
      if (value[r] === undefined || value[r] === null) errs.push(at ? '缺少必填字段 ' + label(r) : '缺少必填参数 ' + r)
    }
    for (const [k, v] of Object.entries(value)) {
      const p = props[k]
      if (!p) {
        if (schema.additionalProperties === false) errs.push('未知参数 ' + label(k) + '（本工具不接受该参数，检查拼写）')
        continue
      }
      if (v === undefined || v === null) continue
      validateNode(p, v, label(k), errs)
    }
  }
}

function validateArgs(schema, args) {
  const errs = []
  if (!schema || schema.type !== 'object') return errs
  validateNode(schema, args, '', errs)
  return errs
}

export function createMcpHandler({ adapter, TOOLS, SECTION, serverInfo, rootInfo, connectorInfo }) {
  if (!adapter) throw new Error('createMcpHandler: adapter 必填')
  if (!Array.isArray(TOOLS) || !TOOLS.length) throw new Error('createMcpHandler: TOOLS 必填')
  if (!SECTION || typeof SECTION.text !== 'string' || !SECTION.text) throw new Error('createMcpHandler: SECTION 必填（lib 侧 text 为 join 后的完整字符串）')

  // schema 自查（批R5）：对公示的 inputSchema 做白名单扫描——出现校验器不认识的关键字就是静默盲区
  // （公示的约束不会被强制执行）。宁可在装配期失败，不带盲区上线。
  const blindSpots = []
  for (const t of TOOLS) blindSpots.push(...schemaBlindSpots(t.parameters, t.name))
  if (blindSpots.length) throw new Error('createMcpHandler: schema 含校验器不支持的关键字（这些约束不会被强制执行）：' + blindSpots.join('、'))

  const guideText = SECTION.text

  async function dispatch(msg) {
    const m = msg.method
    if (m === 'initialize') {
      const requested = (msg.params && msg.params.protocolVersion) || ''
      return {
        protocolVersion: SUPPORTED_VERSIONS.includes(requested) ? requested : SUPPORTED_VERSIONS[0],
        capabilities: { tools: { listChanged: false }, prompts: { listChanged: false } },
        serverInfo,
        // 与 DSH 插件 systemPrompt 同源同版：机制细则全文随 initialize 下发，
        // 客户端无需主动拉 prompts/get 即拿到全部纪律（状态机/事件带/批审/派工）。
        // 〔2026-09-20 复核 REC-03.2〕末尾带上**本次生效的书库根＋来源**：根错配时
        // 此前只能靠"故意触发一次越界"才知道，成本太高（实测使用者会以为工具坏了）。
        instructions: '长篇小说文件账本工具集（确定性代码做壳，语义判断归模型）。工具一律显式传 book_dir 绝对路径，且必须落在书库根（--root）内。'
          + (rootInfo ? '本次生效书库根＝' + rootInfo + '。' : '')
          + '机制细则全文如下：\n\n' + guideText,
      }
    }
    if (m === 'ping') return {}
    if (m === 'tools/list') {
      return { tools: TOOLS.map((t) => ({ name: t.name, description: t.description, inputSchema: t.parameters })) }
    }
    if (m === 'tools/call') {
      const name = msg.params && msg.params.name
      const def = TOOLS.find((t) => t.name === name)
      if (!def) throw Object.assign(new Error('Unknown tool: ' + name), { code: -32602 })
      const args = (msg.params && msg.params.arguments) || {}
      // 结构预检（批C）：缺参/类型错/未知键当场回可读错误，不落进 execute 变深层 TypeError
      const argErrs = validateArgs(def.parameters, args)
      if (argErrs.length) {
        return { content: [{ type: 'text', text: '参数校验失败（' + def.name + '）：' + argErrs.join('；') + '。请按 tools/list 的 inputSchema 重发。' }], isError: true }
      }
      const exec = { name, args, agent: { ctx: { get: (k) => (k === 'fs' ? adapter : undefined) } } }
      try {
        const value = await def.execute(args, exec)
        const content = def.output && typeof def.output.render === 'function'
          ? def.output.render(args, value)
          : [{ type: 'text', text: JSON.stringify(value, null, 2) }]
        // novel_guide 是"我在哪儿"的工具：附一行**本次生效书库根＋来源**（REC-03.2）。
        // 意义在于把"根对不对"变成一眼可见，而不是必须故意触发一次越界才知道。
        if (name === 'novel_guide' && rootInfo) content.push({ type: 'text', text: '〔本次生效书库根〕' + rootInfo })
        // 〔2026-09-20 复核 N-1〕"跑的是哪份连接器"也必须可查：宿主用户级配置里的**同名 server 会盖掉
        // 包内声明**，而两方都不报错（第三方实测本机实际跑的是源仓工作树、不是包内 vendor 副本——
        // 对上架是陷阱：用户手工加过一次同名 server，包内那份就永远不被使用）。附一行执行文件位置，
        // 任何人在会话里就能看出自己接的是哪一份，不必去翻宿主配置。
        if (name === 'novel_guide' && connectorInfo) content.push({ type: 'text', text: '〔连接器〕' + connectorInfo })
        return { content, isError: false }
      } catch (e) {
        return { content: [{ type: 'text', text: String((e && e.message) || e) }], isError: true }
      }
    }
    if (m === 'prompts/list') {
      return { prompts: [{ name: SECTION.name, title: 'Novelist Guide', description: 'novelist 机制细则（与 DSH 插件同版注入的 systemPrompt 全文）：每章工作流/状态机/事件带纪律/批审协议/派工分工。' }] }
    }
    if (m === 'prompts/get') {
      const name = msg.params && msg.params.name
      if (name !== SECTION.name) throw Object.assign(new Error('Unknown prompt: ' + name), { code: -32602 })
      return {
        description: 'novelist 机制细则（' + SECTION.name + '）',
        messages: [{ role: 'user', content: { type: 'text', text: guideText } }],
      }
    }
    if (m === 'resources/list') return { resources: [] } // 未声明该 capability，防御性空响应
    throw Object.assign(new Error('Method not found: ' + m), { code: -32601 })
  }

  /**
   * 处理一行消息。返回响应对象（request），或 null（notification/坏行——不该有响应输出）。
   * MCP 不使用 JSON-RPC 批量（规范明确），行首为 '[' 的按坏行忽略。
   */
  async function handleLine(line) {
    const trimmed = String(line || '').trim()
    if (!trimmed) return null
    let msg
    try { msg = JSON.parse(trimmed) } catch { return null }
    if (!msg || typeof msg !== 'object' || Array.isArray(msg)) return null
    if (msg.method === undefined || msg.method === null) return null
    // JSON-RPC：无 id = notification（notifications/initialized 等）——一律静默接收。
    if (msg.id === undefined || msg.id === null) return null
    let result, error
    try { result = await dispatch(msg) } catch (e) {
      error = { code: (e && Number.isInteger(e.code)) ? e.code : -32603, message: String((e && e.message) || e) }
    }
    return error
      ? { jsonrpc: '2.0', id: msg.id, error }
      : { jsonrpc: '2.0', id: msg.id, result }
  }

  return { handleLine }
}
