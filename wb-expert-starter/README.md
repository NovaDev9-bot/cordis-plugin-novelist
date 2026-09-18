> 引用基底：包内

# 编剧部（novel-forge-editorial）

> 〔引用基底说明〕本目录（`wb-expert-starter/`）是**启动包模板**，不是装配产物。
> 里面的 `references/…`、`scripts/…` 指的是**装出来的那个包里的位置**——那些文件由
> `scripts/build-wb-expert.mjs` 生成，模板里本来就没有。故按 `包内` 声明：本仓不解析其引用。
> 依据 `docs/引用文法.md` §二.1。**不是豁免**：真要验证该由装配器的自检去验（它已经在验）。

NarrativeForge 的**两座位制网文编辑部**，打包成 WorkBuddy 专家。装的是"**谁在说话 + 怎么干活**"；"**能干原来干不了的事**"那一半由 **novelist 连接器**提供。

> **专家是脑子和人格，连接器是手。两个都要装。**

---

## 一、它是什么

| 你有什么 | 它给你什么 |
|---|---|
| novelist 连接器（`novel_*` 十五个工具） | **手**：账本读写、字数口径、状态机、检索 |
| 本专家包 | **人 + 工作台**：主编与主笔两座位、门控、流程、仪器用法、盲读纪律 |

只有连接器 = 一堆没有说明书的螺丝刀（上一轮体检报告的结论）。
只有专家包 = 有嘴没手，`novel_*` 全不可用。

---

## 二、包内结构

```
novel-forge-editorial/
├─ .codebuddy-plugin/plugin.json   # expertType: "team"（主编 lead + 主笔 member）
├─ agents/
│  ├─ chief-editor.md              # 主编：编排/裁决/落账权/门控（+ 宿主适配层）
│  └─ author.md                    # 主笔：署提案 + 亲自执笔（+ 宿主适配层）
├─ skills/
│  ├─ novel-editorial/             # 主流程 SOP：查账→派工→落账→收束验收
│  ├─ blind-read/                  # 盲读：派工纪律五条 + 投递分层 + 成对判
│  ├─ kaishu-topic/                # 开书选题（扫榜 → 报告 → Owner 拍板 → novel_init）
│  ├─ arc-review/                  # 弧审（三问 + 报告与结构化账单双落）
│  └─ dissect/                     # 拆书（三红线 + beats jsonl）
├─ references/
│  ├─ novelist-guide-v7.NN.md      # ★ 机制手册全文（= novel_guide 工具同版）
│  │                               #   `NN` 是**占位符**：装配时由 build-wb-expert.mjs 按
│  │                               #   guide 实际版本改写（现为 v7.13）。**不要在这里写死版本号**——
│  │                               #   写死了每次 guide 升版都会静默断链，2026-09-18 审计实测踩过。
│  ├─ protocols/                   # 九份协议模板（盲读/A-B/批审/事件带/选题/画像卡…）
│  ├─ handbooks/                   # 主编手册 / 写手施工须知 / 策划手册
│  └─ roles/                       # 五个按需工种的派工提示词全文
│                                  # （试读员/结构校准员/校对员/拆书员/档案员）
├─ scripts/                        # 零 LLM 仪器（Node，直接可跑）
│  ├─ style-check.mjs + style-lexicon.json    # 文体机检：L1 硬规则 / L2 密度观测 / L3 正向锚
│  ├─ structure-check.mjs                     # 结构检查：伏笔曝光曲线 / 爽点间隔
│  ├─ batch-report.mjs                        # 批末日报
│  ├─ instrument-aggregate.mjs                # 判据聚合
│  ├─ corpus-falsify.mjs                      # 语料证伪 runner
│  ├─ build-blind-pool.mjs / batch-aggregate.mjs / platform-export.mjs
│  └─ selfcheck.mjs                           # 包自证守卫：`node scripts/selfcheck.mjs`（0 件扫描=不通过）
├─ craft/author-cards/             # 作家个体参照卡（写手的锚，派工时贴进包）
└─ avatars/
```

---

## 三、使用前提（必读）

1. **连接器已装**：`~/.workbuddy/mcp.json` 里要有 `novelist`，且书库根 `--root` 指向你的书库目录。
2. **接活第一件事**：调一次 `novel_guide` 取机制手册——**宿主不保证把连接器的 `initialize.instructions` 交给模型**（MCP 规范把这条留给了客户端）。本包 `references/novelist-guide-v7.NN.md`〔模板〕 是同版全文，可作离线兜底。

---

## 四、必须如实标注的能力边界

WorkBuddy 与 DSH 的差距不是性能差距，是**约束强度**差距。打包时写进文档，别让人误以为拿到完整版：

| 机制 | DSH 形态 | **WorkBuddy 形态** |
|---|---|---|
| 主笔落账权隔离 | `toolFilter.deny` 逐名封死子代理写工具 | **封不住**（子代理继承完整工具面，不支持按名过滤）→ 降级为**软约束**，靠交付后 `novel_verify` 反证 |
| 盲角色输入隔离 | deny 22 项（含 `read`/`novel_*`），机器封死 | **封不住** → 降级为「只读派工包」**纪律条款**，盲读证据力低于 DSH 形态 |
| 开书/汇编 ask 门 | 宿主 ask 门拦工具调用 | **无宿主级门** → 自守门（呈报 Owner 并等确认） |

> 一句话：**这里的盲读是软隔离样本，不是机器隔离样本。** 引用它做判断时要带上这条限定。

---

## 五、装了以后怎么用（三条最常用）

| 你想干的事 | 说 |
|---|---|
| 开一本新书 | "开一本新的连载网文：先扫榜做选题，再建书工程账本" |
| 写下一章 | "写下一章（先交提案，我拍板后再写正文）" |
| 体检账实一致性 | "体检这本书的账实一致性，把 issue 和 warning 分清单列出来" |
| 跑盲读 | "对最近几章跑一次盲读，只交读感记录，不给写作建议" |

---

## 六、来源与真源

- 人格、协议、仪器、作家卡、机制手册均来自 `cordis-plugin-novelist`（NarrativeForge 书线插件）的仓内真源；装配过程见 **`dsh-native/plugin-novelist/scripts/build-wb-expert.mjs`**〔2026-09-18 更正：原写 `dsh-native/scripts/build-wb-expert.mjs`——该路径不存在，装配器在插件仓内〕。
- 人格为 **Owner 手工资产，逐字照搬，不得随意改写**；本包只在文件末尾追加「宿主适配层」说明宿主差异。
- 机制口径的**唯一真源是工具层**（连接器工具描述 + `novel_guide`）。本包文档与工具层若有出入，**以工具层为准**。
