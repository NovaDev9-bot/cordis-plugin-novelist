---
name: novel-editorial
version: 0.1.0
plugin-id: novel-forge-editorial
description: "编剧部主流程 SOP——把「写一章」拆成可核对的账务动作：查账 → 派工 → 落账 → 收束验收。触发词：写下一章、接着写、开新书、建书工程、章纲、细纲、落账、体检这本书、账实一致、断点续跑、续跑、这本书写到哪了、改稿、回改、arc、卷结算、章节状态、定稿、存稿。"
---

# 编剧部主流程

> **机制细则的唯一真源是 `references/novelist-guide.md`（= 连接器 `novel_guide` 工具的同版全文）。**
> 本文件是操作清单，负责"下一步做什么"；两份若有出入，**以工具层（工具描述 + novel_guide）为准**。
> 本专家依赖 **novelist 连接器**。`novel_*` 不可用时先报"连接器未就绪"，**不许用记忆假装记账**。

## 0. 每轮开场

1. 调一次 `novel_guide` 取手册全文（宿主不保证注入连接器的 instructions）。
2. `novel_ask` 一次查账（实体卡 + 伏笔欠线 + 时间线 + 事件带窗口一次拼好）。
3. 有一个以上未闭欠线时，先看 `novel_verify` 的 `issues`（硬清单）——**P0 未清不许开新章**。

## 1. 每章的五步（主编手工工具调用目标 ≤3 次/章）

| 步 | 动作 | 工具 |
|---|---|---|
| ① | 查账，组装派工包 | `novel_ask`（要"写到某章为止"就带 `ch`，按 ≤ch 投影） |
| ② | 派主笔 → 交细纲三行 → **呈 Owner 点头** | 无工具（派工包结构，见下） |
| ③ | 主笔同会话续写正文 → 收束落账 | `novel_chapter`（正文+`seeds`/`closes`/`cast`/`timeline`/`hook`/`advance_to` 一次带齐） |
| ④ | 批审 | 盲采样（`skills/blind-read`）→ `instruments/batch-aggregate.mjs` |
| ⑤ | 意见回流 | `novel_decide`（裁决+状态迁移+落带一次完成） |

**派工包结构（v7.14：固定层＋检索三段）**：
固定层（少一层＝那一层空转）：
1. 前情事实卡（`novel_context op=factsheet`，六节确定性投影）
2. **前一章正文逐字**（禁摘要替代——摘要会打断文脉）
3. 上章反馈卡（Owner 裁决摘要 + 审稿分歧点，不许只给绿灯）
4. 章纲（放末位）
5. **零编排对白混入**（防主笔把编排语气写进人物嘴）
6. **个体参照卡全文**——把本卷定下的那张作家卡内容**贴进包**（见 `craft/author-cards/`）。

检索三段（**各带硬上限**）：原文锚点＝与本章直接相关的 3–5 条前文片段（章号＋行号＋片段，每条 ≤200 汉字、合计 ≤1200）｜未闭义务＝只列本章要接的未闭欠线／未兑现钩子（≤10 条）｜账本事实＝`factsheet` 原样投影。**"相关的都塞"是明确禁止项**（干扰针越多越差；1–2k 汉字即满分召回，多给不增召回只增干扰）。

**危险章先证据后落笔（v7.14）**：危险章＝卷内中段／多线交汇章／上一章机检旗标章。此类章的派工包加一行指令——**动笔前先输出「本章依据清单」**（引用哪些账本条目与锚点，带章号坐标）；主编收稿对照，清单外的设定出现＝无来源新设定。

> 为什么必须贴全文：主笔在 DSH 侧 `glob/grep` 被 deny（权限按工具名不按路径），只给目录名等于没给；**留在库里不贴进包＝这一格空转**。

## 2. 章状态机（子代理不碰状态机）

```
草稿 → 已审 → 待试读 → 已试读 → 待修订 → 已定稿 → 存稿 → 待外审 → 已发表
外审打回 → 打回修订
```
- 迁移入口只有三处：`novel_chapter advance_to` / `novel_decide status` / `novel_ledger set_chapter_status`（同一张迁移表、同一套合法性校验）。
- **待修订 = 内审意见回改**；**打回修订 = 外审（平台）打回**（note 记平台原因）。两态勿混用。
- 回改落盘 = 同章号重新 `novel_chapter` 提交修订后全文，旧版自动留快照，**绝不静默覆盖**。
- 回改后置「已审」重走内审分级：P0/语义级改动 → 重派试读 + 定稿前 A-B 双读交换顺序盲读新旧版；纯文字级 → 只过校对。

## 3. 一章收束验收（全过才算写完）

1. 字数在章纲 `word_min`/`word_max` 区间（**`novel_count` 工具口径——模型自报虚高 37%-63%**）
2. `novel_verify` 无 P0（`issues` 空；`warnings` 里的钩子超期与卷尾结算要过目但不拦稿），或 P0 已挂 `board/issue-NNN`
3. `seeds`/`closes`/`cast`/`timeline_events`/`hook` 已随章登记
4. 试读/校对 P0 已回改或已挂修订单（P1/P2 可攒批）
5. 状态已推进到正确闸口

## 4. 事件带纪律（抗压缩记忆 + 断点续跑锚）

落带必记：每章决策 `decision`（why 必填）／判词与回改 `verdict`+`revision`／自设欠线 `open_thread`（必带 `closes`）／章末钩子 `hook`（由 `novel_chapter` 的 hook 参数落，`pays_hooks` → `payoff` 闭线）。
**压缩触发前**：当轮推理摘要 `checkpoint` 落带；续跑 = 查 `status.json` 最后已定稿章 → read 带尾 → 重建调度位 → 从下一章 outline 起。

## 5. WorkBuddy 形态的三处降级（必须自守，且不得对外宣称等价）

| 机制 | DSH | WorkBuddy |
|---|---|---|
| 主笔落账权隔离 | `toolFilter.deny` 逐名封死 | **封不住** → 靠纪律 + 交付后 `novel_verify` 反证 |
| 盲角色输入隔离 | deny `read/glob/grep/novel_*` | **封不住** → 「只读派工包」纪律条款（见 `skills/blind-read`） |
| 开书/汇编 ask 门 | 宿主 ask 门拦调用 | **无宿主门** → 自守门：`novel_init`/`novel_assemble` 前显式呈报并等 Owner 确认 |

## 6. 仪器（零 LLM，不许用模型判断冒充读数）

```
node <包>/scripts/style-check.mjs <文件> [--json out]        # 文体机检（L1 硬规则/L2 密度观测/L3 正向锚）
node <包>/scripts/structure-check.mjs <book_dir>             # 结构检查（伏笔曝光曲线 / 爽点间隔；"没测"与"测到没有"分开报）
node <包>/scripts/batch-report.mjs <book_dir> --write        # 批末日报（≤5 分钟扫读）
node <包>/scripts/instrument-aggregate.mjs ...               # 判据聚合
```
跑不了就如实标「未测」——**观测器不是闸门，报数不判"好不好"**。

## 7. 红线（不可偏离）

账本唯一写入口=工具（`editorial/` 工作区与 `.drafts` 交付件除外，**绝不绕过工具直改账本文件**）；盲角色输入隔离；Owner ask 门（开书/汇编/权责仲裁）；章状态机合法迁移；判词必带正文原句引用+位置（**无引用判词无效**）；判据降权（量表/z-score 只守门，"写得好"的证据唯 Owner 裁决 + 真人语料个体范本）。

**非红线可偏离**：你判断有更优解时，可偏离任何非红线流程，只需 `novel_event` 记一条 `decision`（what=偏离点，why=理由）——偏离要留痕，不必请示。
