# cordis-plugin-novelist

**一套以文件账本为状态载体的长篇写作工具链**，跑在 [DSH（DeepSeek Harness）](https://www.npmjs.com/package/@deepseek-ai/dsh) 上，也可作为独立 MCP server 接到任何客户端。本仓四件东西：

| 件 | 是什么 | 给谁用 |
|---|---|---|
| **插件**（`lib/`，详见 [README-plugin.md](README-plugin.md)） | 十三个确定性工具（`novel_*`）：每部书一个目录，读写账本文件（项目/设定/人物/伏笔/时间线/章纲/状态）、正文与版本快照、追加式事件日志（JSONL）、以及编辑工作区（事务回执、逐版事实快照、评分、决策记录）。章节提交是事务性的——回执绑正文哈希、`expected_rev` 乐观并发、同文本重试幂等、编辑期快照、可回滚到任意旧版。代码做记账，模型做写作 | 想在 agent 宿主上做长篇连续性生产的人 |
| **MCP server**（`mcp/`，详见 [mcp/README.md](mcp/README.md)） | 同一套工具的 MCP（Model Context Protocol）形态：执行逻辑零改动复用，路径安全由 fs 适配层自担（书库根在启动时强制校验：词法 + realpath 双防线），工具说明与机制文档走 prompts 注入 | 不用 DSH 的智能体用户（Claude Code / ZCode / Cursor 等任意 MCP 客户端） |
| **编辑部 starter 预设**（`preset-starter/`） | 两座位制预设（主编 + 主笔，其余按需 one-shot）：人格提示词、防自批的工具白名单（子代理禁止写类工具，落盘权只在主编）、盲读输入隔离，附冷读协议与前情事实卡模板 | 想要现成协作编排（而非裸工具集）的 DSH 用户 |
| **仪器**（`instruments/`） | 零 LLM 的确定性检查与统计层：文体机检（正则规则）、语料证伪、判据聚合、盲池构建、批量日报生成 | 想量化验证写作规范或判官可靠性的人（不依赖 DSH，纯 Node） |

## 为什么是"运行逻辑"而不是"又一个 AI 写作插件"

我们不认为当前任何模型能自主写出能赚钱的长篇。两个月的对照实验把我们按在这个结论上：

1. **文笔层已经够用。**机检无红旗、盲判官四分档、与真人的差距不在句子层。
2. **瓶颈在上游：结构与选题。**同一写手换大纲做对照——统计平均值拼装的大纲产出"被量化后的平庸"；真人爆款的节拍 1:1 移植能提升文笔/一致性维，但整体仍在真人水位之下。**结构 > 文笔，实验证实。**
3. **编制不买质量。**六角色编辑部管线 vs 通用智能体挂一份技能文件：盲评 3:3 打平。钱应该花在仪器上，不是花在角色编排上。

所以本仓的论点：**模型负责生成，代码负责确定性和测量，人只做一件事——当判官**（盲读判词、方向投票、终验）。其余全部可以制度化。

## 仪器层：我们把圈内流行规范拿去验了一遍

`instruments/corpus-falsify.mjs` 对 59 本起点头部作品（分层抽样、种子可复算）逐条验证流行写作规范，代表性结果：

| 流行规范 | 验证结果 |
|---|---|
| 感叹号 ≤3/千字 | **不成立**：59.3% 的好书超标 |
| "严禁使用"类负向词清单 | **不成立**（作为质量判据）：84.7% 的好书里这些词常见（中位 4.2/万字）——它们区分的是"AI 稿/人稿"，区分不了"好/坏" |
| ≥70% 段落控制在两行以内 | 非普遍事实：仅 33.9% 的书达标——是那位作者的口味，不是行业线 |
| 模板开场套话在好书正章罕见 | 成立（章首命中中位 0%） |

我们还发现自己管线掉进了对称的坑：**过度规避**——禁词压到 0、感叹号压到 0，同样偏离人类分布。**人味 = 落在人类分布带内，不是越干净越好。**仪器的正确用法是测**双向偏差**。

判据信度同理：宽松判据（within-1 一致率）下，一个只会恒定打 4 分的判官能拿满分信度。`instrument-aggregate.mjs` 强制报 exact agreement、ICC(2,1)、量程使用分布，sd=0 / n<5 的维度显式"不可测"，绝对分与成对判两把尺子打架时**阻断达标结论**。

## 快速开始

```bash
# 一、DSH 插件（任选其一）
dsh plugin --profile <你的profile> add github:NovaDev9-bot/cordis-plugin-novelist   # 从本仓装
dsh plugin --profile <你的profile> add <本仓本地路径>                                  # 本地装
# 装好后该 profile 的会话即带 novel_* 13 工具与 novelist-guide（无需其他配置）
# 想要现成的编辑部编排（主编/主笔人格与协作框架）→ preset-starter/（v0.8.0 起公开）

# 二、MCP server（不用 DSH 的智能体：Claude Code / ZCode / Cursor 等任意 MCP 客户端）
node mcp/server.mjs --root <书库根目录>    # 路径安全硬前置：所有 book_dir 圈在书库根内
# 客户端注册与差异说明见 mcp/README.md（工具与 guide 和 DSH 形态同源）

# 三、仓库自检（Node ≥ 20）
git clone https://github.com/NovaDev9-bot/cordis-plugin-novelist.git
cd cordis-plugin-novelist
npm test                                          # 插件测试
node --test mcp/test/mcp.test.mjs                 # MCP 测试（根安全+协议+工具全链）
node --test instruments/style-check.test.mjs instruments/instrument-aggregate.test.mjs   # 仪器测试

# 四、仪器单用（不依赖任何宿主，纯 Node——机检/证伪/聚合任何人的书稿都能用）
node instruments/style-check.mjs 某章.txt                    # 文体机检（GBK 自动识别；--lexicon 叠加负向词库）
node instruments/corpus-falsify.mjs --corpus <语料根> --index <索引.csv> --out <输出>    # 用你自己的语料证伪规范
node instruments/instrument-aggregate.mjs <书工程目录> --baseline <calibration-baseline.json>  # 判据聚合
node instruments/batch-report.mjs <book_dir> --write         # 生产批日报（章状态/伏笔收支/待裁事项）
```

> 边界说明：本仓=账本工具+编辑部 starter 编排+测量仪器。starter 预设（2026-09-17 起人格公开版）与生产预设同源：机制不变，公开侧不含本机私有路径与档案库引用，读者画像卡随包提供。

## 设计红线

- **判定归模型、代码做壳**：机检只报数+软警告，永不作语义质量门禁；符号级护栏（章号/版本链/引文核验）才用确定性代码。
- **一切判断锚正文原句**：判据账 evidence 子串核验硬闸，伪引文当场拒收。
- **词库=数据不是散文**：`style-lexicon.json` 是 JSON。发布版只含自有资产（旧引擎 formula-detector 正则），`negative_lexicon` 是**空扩展槽**——放入你自己的 `{类别:[词...]}` 即生效，或 `--lexicon your.json` 叠加。第三方市场提取内容已按边界移除。
- **novel_count 只返回计数**：`file` 模式读取任意指定路径文本，但输出仅 汉字数/字节数/行数/来源路径——不回显内容（计数-only，侧信道面=文件长度指纹）。工具面按角色 deny 收口见 preset。

## License

MIT。所有实验数字可复算（种子与口径随文件注明），欢迎推翻我们。
