# cordis-plugin-novelist

**一套"人当法官、机器当产线、仪器做公证"的长篇小说量产运行逻辑**，跑在 [DSH（DeepSeek Harness）](https://www.npmjs.com/package/@deepseek-ai/dsh) 上。本仓两件东西：

| 件 | 是什么 | 给谁用 |
|---|---|---|
| **插件**（`lib/`，详见 [README-plugin.md](README-plugin.md)） | novelist 十工具：文件账本制度的确定性实现——项目/设定集/人物/伏笔/时间线/章纲/正文/状态机/事件带/判据账，代码管记账，模型管写作 | 任何想在 agent 宿主上做长篇连续性生产的人 |
| **仪器**（`instruments/`） | 零 LLM 测量层：文体机检、语料证伪、判据聚合、盲池构建 | 任何想**量化验证写作规范/判官可靠性**的人（不依赖 DSH，纯 Node） |

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
git clone https://github.com/NovaDev9-bot/cordis-plugin-novelist.git
cd cordis-plugin-novelist

# 插件测试（Node ≥ 20）
npm test

# 仪器测试（11 项）
node --test instruments/style-check.test.mjs instruments/instrument-aggregate.test.mjs

# 文体机检单章（GBK 自动识别；--lexicon 叠加你自己的负向词库）
node instruments/style-check.mjs 某章.txt

# 用你自己的语料证伪规范（先生成索引 CSV：author,book,bytes,enc）
node instruments/corpus-falsify.mjs --corpus <语料根目录> --index <索引.csv> --out <输出目录>

# 判据账聚合（sd=0/常数仪表/两轴冲突都会被点名）
node instruments/instrument-aggregate.mjs <书工程目录> --baseline <calibration-baseline.json>
```

## 设计红线

- **判定归模型、代码做壳**：机检只报数+软警告，永不作语义质量门禁；符号级护栏（章号/版本链/引文核验）才用确定性代码。
- **一切判断锚正文原句**：判据账 evidence 子串核验硬闸，伪引文当场拒收。
- **词库=数据不是散文**：`style-lexicon.json` 是 JSON。发布版只含自有资产（旧引擎 formula-detector 正则），`negative_lexicon` 是**空扩展槽**——放入你自己的 `{类别:[词...]}` 即生效，或 `--lexicon your.json` 叠加。第三方市场提取内容已按边界移除。

## License

MIT。所有实验数字可复算（种子与口径随文件注明），欢迎推翻我们。
