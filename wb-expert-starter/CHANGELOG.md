> 引用基底：包内

# 变更与更正史（novel-forge-editorial）

> 为什么单开这份：**留痕是资产，但它不该占第一屏**（2026-09-20 第三方评审 W8）。
> 第一屏回答"这是什么、怎么用"；"哪句曾经写错、什么时候收回的"回答在这里。
> 迁入时**原文照搬、不删不改口**——只挪位置，不动结论。

---

## 2026-09-22（当晚五次）· 五条文案对齐官方校验器；市场卡片恢复一句话（v0.1.10）

**改了什么**：① `profession.zh` 改「编剧部」（与 `displayName.zh` **同值**，官方 team 型硬要求）；② `tags` 4→3（**砍「连续性账本」**）；③ `quickPrompts` 4→3（**砍「对最近几章跑一次盲读」**）；④ `displayDescription.zh` 91 字 → **46 字**（把「长篇网文生产线」挪进来）；⑤ `defaultInitPrompt` 与 `quickPrompts[0]` **逐字对齐**；⑥ `description` 由 524 字中文长段改为**英文一句话**——官方 `register_expert.py` 会把它**原样抄进市场卡片**，那段能力口径更正记录因此迁来本件（原文照录于下，一字未改）。

**为什么这么砍**（判据写在这里，免得下一个人凭喜好重排）：
- **市场标签是"用户会搜的词"，快捷提示是"点下去就有结果的动作"**——不是把内部最有技术含量的名词摆上去。
- 「连续性账本」是内部行话，用户不会拿它搜 ⇒ 留「网文连载」（品类）／「编辑部流程」（形态）／「盲读校准」（差异化能力）。
- 快捷提示里「盲读」那条最依赖上下文解释，且与「账实体检」功能重叠 ⇒ 留下的三条＝**开书 → 写章 → 体检**，是新用户最短的一条价值路径。

**能力口径（原 `description` 全文照录，2026-09-22 自该字段迁入）**：
> NarrativeForge 编剧部：两座位制（主编+主笔）长篇网文生产线，配 novelist 文件账本连接器使用——章状态机、事件带、伏笔收支、盲读三角、四个零 LLM 仪器。**能力口径（v0.1.8 又一次更正，这次是按实测）**：`disallowedTools` 的**机制已实测拦得住**（中性同形探针 → `Error: Permission to use mcp__novelist__novel_chapter has been denied.`），但**落点不在本包内**——宿主组件装载器**不枚举专家包**，包内 `agents/` 那两份只是**人格文本的权威来源**、不是注册载体；**真正的落点是项目级 `<工作区>/.codebuddy/agents/*.md`**（投放即生效）。**本包当前投放数＝0 ⇒ 现状仍按软隔离对待**，证据力低于 DSH 形态。另：实测**发现面可用**——`ToolSearch`+`DeferExecuteTool` 是到达一切 MCP 工具的唯一路径（故主笔不能封它，五个盲角色正相反）。角色工具面与落点细则见 references/宿主工具面.md（生成件，真源＝能力表）。

**四条"判定不做"登记**（官方审计 §六 P2 机制选项；2026-09-22 Owner 授权按建议拍板）：
1. **不启用** `assistantDisplayName`／`assistantProfession`——用途未测（审计件 U 系列明写"不知道"），而它改的是**对话侧助手身份显示**，解决不了任何已证问题；**未测字段不进发布件**。
2. **暂不声明** `connectorIds`——U2 明确"不知道宿主拿它做什么"（是否驱动依赖就绪／一键连接未知）。声明一个语义未确认的依赖字段，风险是宿主据此做就绪检查而在干净机器上失败。**替代做法**：`description` 与本件直写"需要 novelist 连接器"。
3. **不改名** `scripts/` → 官方 `bin/`——官方骨架不生成 `scripts/`（不禁止也不认），而 `bin` 的宿主语义同属未测；改名要牵动装配器、包内引用与门禁三处，收益不确定。
4. **不吸收**官方主理人四段（成员表／SOP／协作机制铁律／协作规则）到主理人人格里——**约束内容未缺**（"主编不得代笔""落账权不在主笔"等已在义务段），而**那四段是流程文本**；本项目的分层是**人格管声音、手册管流程**（`references/handbooks/主编手册.md` 已含工种调用决策表），把制度塞回人格正是这层设计要避免的事。官方校验器亦不查它（只查字面形态）。

---

## 2026-09-22（当晚三次）· 对齐官方 expert-manager 校验；deny 三态入表（v0.1.9）

**改了什么**：① 新增 `settings.json`（`{"agent":"chief-editor"}`）；② `.codebuddy-plugin/plugin.json` 补顶层 `leader`；③ 两个 agent 定义的前言块补 `displayName`/`profession`/`maxTurns`（主理人 150／成员 50）；④ 修 `references/handbooks/主编手册.md` 三处断链；⑤ 能力表引入 **`ineffective` / `status:unknown`** 两格，渲染器只渲 `tools` 并把缺口印在文档里。

**为什么改**：
1. **官方校验器（`expert-manager` 自带）复跑出 4 error ＋ 2 warning**（仓侧独立复算，与 WB 侧一致）。其中 `settings.json` 是真缺口——它是**"包级绑定主代理"那条通道**（缺了它，以插件形式加载时主编人格不会合成到默认 agent 上），不是格式洁癖。`leader` 是宿主读的顶层字段（`members[].role` 优先级更高，故属应收尽收）。
2. **三处断链**：主编手册里三条指向协议件的相对引用，**按文件所在目录解析会差一级**（落进该目录下一个不存在的子目录）。**这是我装配自证的一个假绿**——它按包根解析，而读者的基准是**文件所在目录**。改法用 `../` 回退一级：**它在包内与书工程内两种布局下都对**（两边的相对关系相同）。
3. **deny 三态**（WB 侧逐名红测）：同一个字段里写下去的名字，结局有三种——
   `Read`/`Glob`/`Grep`/`Bash`/`ToolSearch`/`DeferExecuteTool`：**从工具面整个消失**（enforced）；
   `mcp__novelist__*`：列着、**调用时被拒**（enforced）；**`PowerShell`：列着、且真的执行了**（ineffective，`PowerShell`/`powershell`/`pwsh` 三种写法都无效）；
   `Write`+`Edit`+`WebFetch` 同时写：**agent 直接起不来**（fatal，三项之一未二分）。
   ⇒ 表里加 `ineffective`（与 `tools` 互斥、渲染器不渲、**必须当缺口印出来**）与 `status:unknown`（查过了、结论是不许渲染——与 unverified 分开：前者"我没看"，后者"我看了，不能写"）。
   ⇒ **落地效果**：`shell.exec` 只渲 `Bash`，`PowerShell` 变成文档里的显式缺口；`fs.write`/`fs.edit` 退出渲染 ⇒ 主笔的名单不再含 `Edit`/`Write`（它本来就必须能写交付件）。
   **不许写"盲读已封死"**：准确口径是**半机器强制**（读取面＋发现面真封住，`PowerShell` 是已实测缺口）。

**仍未修的（等 Owner 拍文案）**：`profession`≠`displayName`、`tags` 4→3、`quickPrompts` 4→3、`displayDescription.zh` 超长、`defaultInitPrompt` 与 `quickPrompts[0]` 不一致——**这五条是定位/文案，不是工程判断**，故不擅自改。

**★ 一条新增硬约束（写死进本节与 §七）**：官方校验器对前言块做的是**子串**判断 `'tools:' in frontmatter`，而 `disallowedTools:` **含有** `tools:` ⇒ **deny 名单永远不许渲进包内的 agent 定义**（渲一次，包就不合规）。deny 只能住在宿主载体里。

---

## 2026-09-22（当晚二次）· 机制实测了，但落点不在包里（v0.1.8）

**改了什么**：① `.codebuddy-plugin/plugin.json` 的 description 与 `references/宿主工具面.md` §二/§六/§七（生成件，真源＝能力表）的落点与 enforcement 口径；② 能力表里六条 MCP 能力从 `status:unverified`（只有候选名）**翻成已核实名**；③ **撤销主笔 deny 里的 `tool.search` / `tool.invoke`**；④ 生成器新增两条不变量与两条反例回归。

**原文（改前）**：

> **0.1.7 起落点已建立**（两个 agent 定义带 frontmatter＋在 plugin.json 的 `agents` 登记…），但 **`disallowedTools` 是否真能拦住调用仍未证**（R-a 红测未跑）…
> 落点：**是 agent 定义**（`agents/` 下的件），且 0.1.7 起已带前言块…

**为什么改（两层，都不是推理，是读数）**：

1. **0.1.7 那次对齐打空了。** WB 侧在 0.1.7 装好并**重启之后**再试：`author` 仍不在 `Task` 的表里。翻宿主启动日志看到：`Loaded plugin components for …: N agent(s)` **枚举了 11 个插件，本包一次都没出现**（同日志只有 `[AgentManager] volatile plugin agent override updated: chief-editor (source=本包)`——专家包走的是「单槽绑定 lead」那条路）。⇒ **组件装载器根本不枚举专家包**，所以补前言块、补 `agents` 登记，都是对着一条永远不会被走到的路做的。包内那两份的真实身份回到它们的本分：**人格文本的权威来源**。
2. **真正的落点被找到并实测了三件事**：`<工作区>/.codebuddy/agents/*.md`（项目级）——**能派**（`Task(subagent_type="author")` 一次成功）、**人格注入**（自报并准确引用 `AUTH-01…19` 条款号）、**deny 拦得住**（中性同形探针 → `Error: Permission to use mcp__novelist__novel_chapter has been denied.`，拦在权限层未到工具本体）。

**改后**：`enforcement` → `proven-mechanism`（**机制已实测 · 载体未落地**）；**本包当前生效的 deny ＝ 0 条**，口径仍是软隔离。
**分层如实记**：deny 读数来自**同形配置的中性座位**；**主笔本座无机械读数**（两次自守拒发）⇒ 只能写「机制已实测成立（同形配置）」，**不许写成「主笔已被机器封死」**。

**撤销主笔那两条 deny 的理由**：09-20 封 `tool.search`/`tool.invoke`，是因为当时 MCP 名 deny **不生效**（那时这条路压根没有落点），只能把「唯一能绕过 deny 面的通道」整个砍掉当**权宜**。现在 MCP 名 deny 已实测生效，**权宜的因被消除**；而本形态 `ToolSearch`→`DeferExecuteTool` 是**到达一切 MCP 工具的唯一路径**（含主笔该有的 `novel_bible`/`novel_search`）⇒ 继续封它＝把自己该有的面一起封掉。收口改由**生成器的耦合不变量**守：**封发现面者必须同时封掉全部 MCP 面能力**（不满足即装配期报红，已配反例回归）。

**另加**：codebuddy 列里的 MCP 工具名改按**连接器自己的工具清单**校验（比宿主内置清单更强的判据——形状对不代表工具对，拼错一个字母宿主不报错、静默空转）；配反例回归。

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
