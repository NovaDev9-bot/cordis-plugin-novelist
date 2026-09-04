# cordis-plugin-novelist

**File-ledger domain tools for long-form fiction production on [DSH](https://github.com/deepseek-ai/deepseek-harness) (`dsh`).**

一个「文件账本」插件：给 AI 编辑部（主编 / 写手 / 审稿子代理）8 个确定性的 `novel_*` 工具，把长篇小说生产中**能用代码管死的事**（账本、字数、伏笔、版本链、状态机、冲突仲裁流程）交给代码；**语义判断（写得好不好、怎么改）留给模型**。代码做壳，模型做智能。

A plain-file book ledger + 8 deterministic tools for multi-agent long-form fiction: the code does accounting, the model does the writing. No HTTP, no database, no LLM calls inside the plugin — just files and invariants.

---

## Why / 为什么做这个

长篇（30 章以上）AI 协作写作的失败模式几乎都不是"写得差"，而是**账乱了**：

- 写手自报字数虚高（我们实测 37%–63%）→ 字数唯一可信口径 = 工具数汉字
- 伏笔埋了没人收、人设前后打架、时间线漂移 → 随写随记进账本，机检逾期/冲突
- 同章修订覆盖丢稿 → 版本快照链 v1..vN，绝不静默覆盖
- "AI 自己说自己检查过了" → 状态机 + 验收门，状态迁移唯一入口在工具里

所以本插件把**单一写入口**做成硬约束：正文/台账的一切变更必须经工具，工具内联符号门（只记账不判好坏），语义审稿归子代理。

## Tools / 工具一览

| 工具 | 作用 |
|---|---|
| `novel_init` | 新建书工程：落全套空账本骨架（一次性，幂等防重） |
| `novel_outline` | 读/写卷章纲；附产线校准建议（按已落盘章节实测汉字分布推荐字数窗口，只建议不替人定） |
| `novel_bible` | 写前必查：设定/人物/伏笔/时间线按当前章过滤生效窗口（防吃书） |
| `novel_chapter` | **唯一正稿写入口**：正文参数携带 → 落盘 + 版本快照 + 伏笔埋/收 + 时间线 + cast + 事件账 + 内联符号门 |
| `novel_verify` | 一致性机检：伏笔逾期 / 章纲-正文存在性 / 章号断档 / 版本链跳号（只出问题清单，不做语义判定） |
| `novel_count` | 只读字数核数（汉字口径 `[\u4e00-\u9fff]`）——写手/审稿子代理交付自核都用它，模型自报字数不作数 |
| `novel_ledger` | 台账定向增改：人物卡/设定词条/伏笔策展/章状态机迁移/**冲突仲裁两分法**（语义类编辑部证据裁决 / 权责类人类拍板，否决必带理由） |
| `novel_assemble` | 汇编全书导出单文件（章数/总字数/伏笔状态表统计） |

## Ledger layout / 账本目录

一部书一个 `book_dir`，全部是纯文件（git 友好、任何工具可读）：

```
<book_dir>/
  project.json        # 书元信息、当前章、schema_version（账本格式版本号）
  bible.json          # 设定词条（生效窗口 effective_from/to_ch）
  characters.json     # 人物卡（性别/身份/最后出场章）
  foreshadows.json    # 伏笔账（planted_ch / due_ch / status）
  timeline.json       # 时间线事件
  outline.json        # 卷章纲（goal/hook/word_min/word_max/差异化槽位）
  manuscript/         # chapter_001.md …（正文，无题首行惯例）
  versions/           # chapter_001.v1.md …（修订快照链）
  status.json         # 章状态机：草稿→已审→待试读→…→已发表
  events.jsonl        # 事件账（append-only，一切操作的审计轨迹）
```

## Install / 安装

DSH profile 组合条目按 `file://` 绝对路径挂载（Windows 路径 `/` 分隔）：

```yaml
# <你的 profile>/agent.cordis.yml 或 --patch 补丁层的 - insert: 条目
- id: novelist
  name: file:///C:/path/to/cordis-plugin-novelist/lib/novelist.js
```

> `name` 必须是 `file://` URL：headless `--patch` 路径下裸 Windows 绝对路径 import 会报
> `ERR_UNSUPPORTED_ESM_URL_SCHEME`。npm 包发布后可直接 `dsh plugin --profile <p> add <路径>`。

无任何运行时依赖（零 npm 依赖、零构建，单文件 ES module）。要求 Node ≥ 22（DSH 同款）。

跑测试（8 用例 = 7 单元 + 1 全链路集成：init→outline→chapter→verify→count→assemble→状态机→冲突仲裁，内存 fs shim 驱动）：

```sh
node --test test/novelist.test.mjs
```

## Design principles / 设计原则

1. **代码做壳，模型做智能**：符号级不变量（字数区间、引用完整性、版本链、状态迁移合法性）用确定性代码；好坏/取舍一律归模型与编辑部。试图用正则判语义的检查一律不做。
2. **单一写入口**：正文与数据账本的一切变更必须经工具（参数携带正文，而非让模型自由写文件）；审稿意见、修订单等**编辑工作产物**允许直写——两域分离。
3. **冲突不静默**：人设/设定值冲突返回 conflict 对象，必须经 `resolve_conflict` 仲裁才生效；裁决分两类——语义类要立场+证据坐标，权责类走人类 ask 且否决必带理由。
4. **幂等入账**：同章重提交不重复记伏笔/时间线（修订换快照，不换账）。
5. **字数口径唯一**：只数汉字 `[\u4e00-\u9fff]`；`novel_count` 对全体角色开放（含子代理）。
6. **工具返回禁带 undefined 键**：DSH 对工具返回做无损 JSON 校验，undefined 键会整单拒收（实测坑）。

插件同时注入 `novelist-guide` 系统提示段（order 150）：章节工作流、验收门、子代理编排纪律（前台 spawn 同步等交付、熔断、分段写作协议）、盲审派工纪律等实战约定，与工具同版发布。

## Battle-tested lessons / 实战来源

来自 30 章级长跑的多轮实弹修订（2026-08/09）：模型自报字数虚高 37%–63%；单回复写作上限约 1 万汉字（超限章节走分段写作协议：每段一交付一落盘一核数，主编拼装）；`job_output` 不追踪子代理（依赖交付的派工一律前台 spawn）——这些数字都写进了工具描述与 guide，供后来者少踩坑。

## Contributing

Issues / PRs welcome — especially: more deterministic gates (things code can prove, not judge), platform status mappings (chapter states are named generically for mapping onto publishing platforms), and i18n of tool descriptions.

## License

MIT
