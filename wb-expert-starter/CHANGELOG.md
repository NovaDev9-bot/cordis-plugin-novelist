> 引用基底：包内

# 变更与更正史（novel-forge-editorial）

> 为什么单开这份：**留痕是资产，但它不该占第一屏**（2026-09-20 第三方评审 W8）。
> 第一屏回答"这是什么、怎么用"；"哪句曾经写错、什么时候收回的"回答在这里。
> 迁入时**原文照搬、不删不改口**——只挪位置，不动结论。

---

## 2026-09-22 · agent 定义补前言块并登记（v0.1.7）；落点口径更正

**改了什么**：① `agents/chief-editor.md`、`agents/author.md` 各加一个前言块（`name` / `description`）；② `.codebuddy-plugin/plugin.json` 新增 `agents: ["./agents/chief-editor.md", "./agents/author.md"]` 登记；③ `README` §三.3 补一句"当用户级同名存在时，包内 `.codebuddy-plugin/plugin.json` 的 `--root` 根本不参与，改它等于白改"；④ `references/宿主工具面.md` §七（生成件，真源＝`roles/tool-face.json`）的"落点"口径更正。

**原文（改前）**：

> ②包内两个 agent 定义目前**都没有 frontmatter**，要声明必须先新建 frontmatter 块…
> 那几个工种的 agent 定义**尚未建立**（要建就得先回答"宿主接不接受只有 frontmatter + 指针的定义"这个问题）。

**为什么改（判据＝宿主源码 ＋ 宿主日志，2026-09-22）**：WB 侧三个探针 `subagent_type` 全部硬失败（`Task agent X is not available`，0–2ms）。当时那边得出的结论是"自定义 agent 定义在本宿主挂不上 ⇒ 这条路不通"。**读宿主本机装机后，三条都比那个结论更靠前**：

1. **探针放错了目录。** 宿主解析器 `getProjectAgentsDir(){ return join(this.getWorkDir(), ".codebuddy", "agents") }`——项目级自定义 agent 定义在 **`<工作区>/.codebuddy/agents/`**（用户级是 `(CODEBUDDY_CONFIG_DIR || ~/.codebuddy)/agents/`）。探针放的是 `.workbuddy/agents/`，**宿主从未读它**。（全文只有这一种写法，无 `.workbuddy/agents` 变体。）
2. **`author` 失败是另一条机理，且它提示了真正的缺口。** 宿主 `Task` 按名查 `agentManager.get(X)`，查不到即硬错，并打一行 `[AgentTask] agent lookup failed | requested="X" | available=[...]`。**那行 available 列表就是现成的仪器**——实测那一刻它是：`[compact,…,Plan,Explore,general-purpose,cli,create,sheet-agent,doc-converter,doc-formatter,doc-writer]`：**有别的已启用插件的 agent，没有本包的**。对照同机所有插件：**576 份 agent 定义全部带前言块**，本包那两份是少数例外 ⇒ 本包的 agent 从来没进过注册表。
3. **落点不但存在、接线也在。** `parseAgentFile` 解析 `name/description/tools/disallowedTools/skills/mcpServers/model/effort/isolation/maxTurns/background/initialPrompt/memory`，其中 `permissionMode`/`hooks`/`mcpServers` **被显式忽略并告警**（与 09-18 实测一致）；`AgentTask` 组子会话 options 时做 `[...mainSession.options.disallowedTools, ...agentConfig.disallowedTools]` ⇒ **子代理会继承它自己 agent 定义里的 deny**。

**改后**：落点**已建立**（结构对齐本机可工作样本）；但 `disallowedTools` 是否真能拦住调用**仍未红测**（R-a 未跑）⇒ 三处口径一律保持"**未证实生效**、按软隔离对待"，**没有一处在说它生效了**。§七 同时写死三条省事取证路径（先 grep 那行日志、再放对目录、五工种落点仍待建且"先证明能派，再谈封"）。

---

## 2026-09-21 · 能力口径按运行时实测收紧（v0.1.6）

**改了什么**：`README` §四（能力边界表）与两处 agent 定义的「宿主适配层」、`skills/blind-read` 与 `skills/novel-editorial` 里关于"WorkBuddy 封不住工具名"的表述。

**原文（改前）**：

> | 主笔落账权隔离 | `toolFilter.deny` 逐名封死子代理写工具 | **封不住**（子代理继承完整工具面，不支持按名过滤）→ 降级为**软约束**… |
> | 盲角色输入隔离 | deny 名单逐名封死 `read`/`novel_*` | **封不住** → 降级为「只读派工包」**纪律条款**… |
>
> …DSH 形态下你的工具面由 `toolFilter.deny` 逐名封死。**WorkBuddy 封不住工具名**——你现在拿得到全量工具，包括落账工具和 shell。

**为什么改**：三处实测（判据＝宿主硬返回，2026-09-20/21）说明"封不住"这个说法**既不准确、又掩盖了真正的洞**：
① `Agent`/`TeamCreate`/`TeamDelete` 在子代理与成员形态**本就缺席**——禁它们是**空操作**（不是"封不住"，是"没有可封的东西"）；
② 真正的洞是**发现面**：`ToolSearch` + `DeferExecuteTool` 在两种形态都在，实测能列出并**真的执行** `mcp__novelist__*`（含唯一写入口 `novel_chapter`）——**发现面就是绕过面**；
③ `disallowedTools` 到底生不生效**至今未跑**（R-a）——所以正确口径是"**未证实生效**"，不是"封不住"（后者把一个未测的结论说成了已知结论）。
另加一格 `SendMessage@subagent`：名字真实存在，但不在团里时调用被宿主拒——**存在、本形态不可用**，与"不存在""已封"都不同类，混在一起会被读成"已封"。

**改后**：可核的四格——DSH＝宿主强制；本形态＝**未证实生效**（按软隔离对待）；名字不存在（`Task`/`read_image`/`pwsh`）；名字存在但本形态惰性（`SendMessage@subagent`）。逐角色对照见 `references/宿主工具面.md`（生成件）。

---

## 2026-09-21 · 人格段"能力否定句"→"义务否定句"（A1 收正）

**改了什么**：人格段里的一类**能力否定句**改为**义务否定句**，共 9 处（3 角色 × 3 落点：WB 侧 `agents/author.md`、`references/roles/reader.md`、`references/roles/calibrator.md`，另加两份 DSH 预设 `preset-starter/` 与 `preset-writer/` 各 3 处）。

原文形如"**你没有** `novel_chapter`/…"、"**也没有**账本工具（…）"、"**你没有任何**账本工具（…）"，现统一为"**你不得动用**"。

**为什么改**：原句是 **DSH 形态的能力事实**，在 WB 形态下为假——同一份文件末尾的「宿主适配层」又写着"你现在拿得到全量工具"，
两处直接互斥；而更靠后、且被工具清单证实的那句会赢，代价是**人格段自己的权威被这一处矛盾折价**（护栏失效，不是风格问题）。
改后人格段与工具清单不再互斥（一个说权限、一个说禁令），两形态同时为真。

**改了什么是可核的**：除这 9 处情态动词外，人格文本**一字未动**——枚举、括号里的理由、句序与折行位置全部保持原样
（折叠标量 `>-` 渲染出的空白与改前逐位一致）。**这是人格资产的唯一一处登记收正**，其后仍按"逐字照搬"维持。
自 2026-09-21 起，这一类句子由 `roles/text-invariants.mjs` 守着（能力否定句复活即装配失败）。

---

## 2026-09-19 · 收回"它已经在验"（引用自证）

**原文（改前）**：本句此前写着"**不是豁免**：真要验证该由装配器的自检去验（**它已经在验**）"。

**为什么改**：那半句是假的——当时 `selfcheck` 只核 `.codebuddy-plugin/plugin.json` 声明的路径、装配器只比哈希，**没有任何一处真在验**，
而装配产物里实际有 50 条引用指着不存在的位置。

**改后**：已是真的。装配器在装配期改写源坐标引用（7c2），并对产出的包逐条自证（7d，解析不到就 `exit 2`）。
同时"不是豁免"也改了——**它就是豁免**（本仓不查），区别只在于：写在文件里、有理由、有兜底。
