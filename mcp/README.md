# novelist MCP server

把 novelist 十二工具暴露为 [MCP（Model Context Protocol）](https://modelcontextprotocol.io) stdio server——任何 MCP 客户端（Claude Code / ZCode / Cursor / 任意智能体）插上即用，不依赖 DSH 宿主。

## 架构

```
MCP 客户端 ──stdio(NDJSON/JSON-RPC 2.0)── server.mjs（IO 壳）
                                          ├─ handler.mjs（协议逻辑，可测纯函数）
                                          ├─ fs-adapter.mjs（node:fs 实现 DSH fs 语义 + 书库根安全）
                                          └─ ../lib/novelist.js（零改动复用：工具执行逻辑+guide 同源）
```

- **lib 零改动复用**：工具执行时伪造 `exec.agent.ctx.get('fs')` 注入适配器——与 DSH 插件共用同一份执行代码与 novelist-guide（MCP prompts 通道，禁复制防漂移）。
- **路径安全（启动硬前置）**：MCP 无宿主工作区沙箱，本 server 以 `--root` 书库根自担——所有路径（含 `novel_count` 的 file 模式）圈在根内：词法校验（`../` 逃逸/跨盘拒绝）+ 已存在路径 realpath 校验（symlink 指出根外拒绝）。无 `--root` 拒绝启动。
- **无宿主 ask 门**：DSH 侧 `novel_init`/`novel_assemble` 需 Owner 确认；MCP 形态由客户端自身的人工审批机制承担（MCP 规范要求 human in the loop）。

## 用法

```bash
node mcp/server.mjs --root <书库根目录>
# 或
NOVELIST_ROOT=<书库根目录> node mcp/server.mjs
```

客户端注册（以 Claude Code 类配置为例）：

```json
{
  "mcpServers": {
    "novelist": {
      "command": "node",
      "args": ["<仓库路径>/mcp/server.mjs", "--root", "<你的书库根目录>"]
    }
  }
}
```

启动后建议先取一次 guide（机制细则与 DSH 插件同版）：

```
prompts/get → novelist-guide
```

## 与 DSH 插件形态的差异

| 维度 | DSH 插件（`dsh plugin add`） | MCP（本目录） |
| --- | --- | --- |
| 宿主 | DSH（deepseek-harness） | 任意 MCP 客户端 |
| 工作区约束 | 宿主 fs 服务自带 | `--root` 书库根自担（硬前置） |
| ask 门（init/assemble 需人工确认） | 宿主 ask 机制 | 客户端审批机制 |
| novelist-guide 注入 | systemPrompt 自动注入 | prompts 通道按需取 |
| 事件带 os-append 臂 | processPath 桥接 | 适配层直通真实路径 |

## 测试

```bash
node --test mcp/test/mcp.test.mjs
```

覆盖：适配层根安全（越界/`..` 逃逸/symlink/`..` 前缀目录名不误杀）、DSH fs 语义（stat 缺失→null/writeText 建父目录/listDir）、工具全链（init→outline→chapter→verify→count 走适配器+根外拦截）、MCP 协议层（initialize 版本协商/tools/prompts/错误通道/通知静默）。
