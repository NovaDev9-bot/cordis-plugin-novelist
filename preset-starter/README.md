# 编辑部 starter 预设（公开版）

与 novelist 插件配套的**两座位制编辑部预设**：主编（常驻主智能体，三段式人格+裁量条款）+ 主笔（作者+执笔一体，continuable 同事线）+ 按需工种（档案员/拆书员/试读员/结构校准员/校对员，one-shot）。职责分工、防自批不变量（子代理一律 deny 写类工具，落盘权唯一在主编）、盲读输入隔离都写在 agent.cordis.yml 里。

本预设是本仓作者生产用预设的人格公开版；子代理模型统一 deepseek-flash（主编模型可按 DSH 官方方式自选）。

## 公开边界

人格全量公开不等于配置文件与生产用预设逐字相同：本机私有路径、内部档案库与协议引用需按公开包及用户自己的材料落位；公开版另有工具拒绝访问约束。读者画像三卡随本目录公开，未移除。私有作家档案、选题数据与内部知识库不随包提供，使用时由用户准备自己的材料。

## 安装（DSH / deepseek-harness）

> **DSH 0.2.0-rc.2 起预设机制已换**：注册表**不再扫描目录**，`~/.dsh/.agent-presets/<id>/`
> 那套（0.1.5 的姿势）已经失效——拷进去不会出现在模式选择器里。0.2.0 的预设是 profile
> 补丁层里的一行 `@deepseek-ai/dsh-agent-preset` 声明，且由 **bundle** 携带。下面的第 2 步
> 就是替你生成这个 bundle 并装进 profile。

```bash
# 1) 装插件（给工具与 novelist-guide）
dsh plugin --profile web add cordis-plugin-novelist
#    （或本地包路径：dsh plugin --profile web add <本仓路径>）

# 2) 渲染并声明预设（生成 bundle = 人格与协作框架的载体，并装进 profile）
node scripts/install-preset.mjs --profile web --install
#    只看会生成什么、不写盘：node scripts/install-preset.mjs --dry-run
#    装了之后核对真源与装机位是否一致：node scripts/install-preset.mjs --check

# 3) 启动后在模式选择器里选「编辑部 starter（公开版）」（界面措辞以你所用 DSH 版本为准）
dsh web
```

不想用脚本也可以手动挂载：先 `node scripts/install-preset.mjs`（不带 `--install`）拿到生成目录
`~/.dsh/.agent-presets/editorial-starter/bundle/`，再用 `plugin_manager` 工具的 `install_bundle`
（target = 该目录）装进 profile。**别**把 `agent.cordis.yml` 直接并进 profile 补丁层——裸条目
会被补丁算法当成"对既有条目的 id 覆盖"，基座没有该 id，于是警告后静默跳过（插件不加载）。
工具行见文件底部（`name: 'cordis-plugin-novelist'`；未装插件时改为 `file:///<本仓绝对路径>/lib/novelist.js`，
但那条路只在同机可用）。

## 附带协议（复制进你的书工程）

书工程开出来后（`novel_init`），把本目录 `protocols/` 三件复制到 `<book_dir>/editorial/protocols/`：

| 文件 | 用途 |
|---|---|
| `preset-starter/protocols/A-B冷读协议.md` | 语义级回改定稿前的隐藏版本盲读（防"改完重审"的带期望验证） |
| `preset-starter/protocols/前情事实卡.md` | 每章派工前的连续性材料模板（带章号坐标，会话即抛·档案即记忆） |
| `preset-starter/protocols/读者画像卡.md` | 冷读派工三选一画像及默认番茄画像；主编将选定卡全文附进派工包，盲角色不自行读文件 |

## 日报脚本

主编人格里的批末日报引用 `instruments/batch-report.mjs`（章状态/新章/伏笔收支/判据账/待裁事项，纯账本零 LLM）：

```bash
node instruments/batch-report.mjs <book_dir> --write
# 日报落 <book_dir>/editorial/reports/日报-YYYY-MM-DD.md
```

## 与 MCP 形态的关系

不跑 DSH 也能用工具：见 [`mcp/`](../mcp/)（任何 MCP 客户端可插，路径圈在书库根内）。预设是 DSH 专属的协作编排层；MCP 形态下由你的智能体宿主自带的编排承担。
