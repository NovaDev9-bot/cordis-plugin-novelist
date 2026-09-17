/**
 * novelist MCP —— 协议处理（G1，v0.8.0）。
 *
 * MCP stdio transport：newline-delimited JSON-RPC 2.0（UTF-8；日志/诊断走 stderr）。
 * 本文件只做协议逻辑（可测纯函数，不碰 stdin/stdout/process）；IO 壳见 server.mjs。
 *
 * 协议来源：modelcontextprotocol.io 规范 2025-06-18（lifecycle/tools/prompts/transports）。
 * - initialize → 回显客户端版本（在支持清单内）或回我们支持的最新版
 * - tools/list → 12 工具（schema 现成于 lib TOOLS[].parameters → inputSchema）
 * - tools/call → 伪造 exec（agent.ctx.get('fs') 返回适配器）注入 lib 执行；渲染优先
 *   output.render（其返回 [{type:'text',text}] 恰为 MCP content 格式）；执行错误走
 *   isError:true（规范：业务错误入 result，协议错误入 JSON-RPC error）
 * - prompts/list|get → novelist-guide（lib SECTION 全文，与 DSH 侧 systemPrompt 同源同版）
 */
const SUPPORTED_VERSIONS = ['2025-06-18', '2024-11-05']

export function createMcpHandler({ adapter, TOOLS, SECTION, serverInfo }) {
  if (!adapter) throw new Error('createMcpHandler: adapter 必填')
  if (!Array.isArray(TOOLS) || !TOOLS.length) throw new Error('createMcpHandler: TOOLS 必填')
  if (!SECTION || typeof SECTION.text !== 'string' || !SECTION.text) throw new Error('createMcpHandler: SECTION 必填（lib 侧 text 为 join 后的完整字符串）')

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
        instructions: '长篇小说文件账本工具集（确定性代码做壳，语义判断归模型）。工具一律显式传 book_dir 绝对路径，且必须落在书库根（--root）内。机制细则全文如下：\n\n' + guideText,
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
      const exec = { name, args, agent: { ctx: { get: (k) => (k === 'fs' ? adapter : undefined) } } }
      try {
        const value = await def.execute(args, exec)
        const content = def.output && typeof def.output.render === 'function'
          ? def.output.render(args, value)
          : [{ type: 'text', text: JSON.stringify(value, null, 2) }]
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
