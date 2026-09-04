/**
 * novelist —— 长篇小说「文件账本」领域工具插件（DSH / deepseek-harness）。
 *
 * 定位：给 AI 编辑部（主编/写手/审稿子代理）一套确定性的账本读写壳——
 *   - export { name, apply, inject, _internals }；挂载 = profile 组合条目 name: file:///<本文件绝对路径>；
 *   - 工具经 tools.register 注册（参数 = 模型线 wire JSON Schema）；
 *   - 全部工具为**文件账本读写**，无 HTTP、无数据库、无 LLM 调用；
 *   - 符号级门（字数区间 vs 章纲、closes/cast 引用完整性、伏笔逾期、版本链）用确定性代码；
 *     语义判定（好坏/取舍）一律归模型/子代理——代码只做壳，不做审美。
 *
 * 实战来源：30 章级长跑多轮实弹修订（2026-08/09）——幂等入账、模型自报字数虚高
 * 37%-63%（故字数唯一口径=工具数汉字）、单回复写作上限约 1 万汉字（分段写作协议）、
 * 工具返回禁带 undefined 键（DSH 无损 JSON 校验整单拒收）、写工具声明 timeoutMs。
 *
 * 官方契约（实测）：execute 内取服务 = exec.agent.ctx.get('fs')（ToolRunContext 本身无 ctx
 * 字段——dsh-plugin/lib/domain-tools.js:287 实测；fs 服务 writeText 自动建父目录）。
 */
const name = 'novelist'
const inject = ['tools', 'systemPrompt']

/** 写工具超时：45 分钟（对应引擎线 LLM_TIMEOUT=2700 实测档；官方 timeout-policy 执行）。 */
const WRITE_TIMEOUT_MS = 2700_000

/** 卷级门 + 异常挂起：只有三件大事需要 Owner ask（审阅 A）。 */
const ASK_TOOLS = new Set(['novel_init', 'novel_assemble'])
const ASK_REASONS = {
  novel_init: '新建书工程（一次性，落全套账本骨架）——需你确认开书。',
  novel_assemble: '汇编导出对外件——需你确认发布。',
}
const ASK_FALLBACK = '此操作需要你确认。'

// ---------------------------------------------------------------- 工具

/** 书目录 = book_dir（一部书一个根目录），全部账本文件都在其下。 */
const BOOK_DIR = {
  type: 'string',
  description: '书目录绝对路径（含 book_id，如 /path/to/your-project/books/my-book）。',
}

function bookDirParam(extra) {
  return Object.assign({ type: 'object', properties: { book_dir: BOOK_DIR }, required: ['book_dir'], additionalProperties: false }, extra)
}

function textBlock(text) {
  return [{ type: 'text', text }]
}

function renderJson(value) {
  return textBlock(JSON.stringify(value, null, 2))
}

// ---------------------------------------------------------------- 账本 IO（fs 服务）

/** fs 服务无 mkdir，但 writeText 自动建父目录（dsh-fs-local:464，三核验 §10.1 实测）。 */
async function loadJson(fs, dir, fileName) {
  const target = await fs.resolve(dir + '/' + fileName)
  const st = await fs.stat(target)
  if (!st) return null
  const raw = await fs.readText(target)
  // 损坏 ≠ 缺失：JSON 解析失败必须大声报错——静默当空账本返回会导致上层重建账本、数据丢失
  try { return JSON.parse(raw) } catch (e) { throw new Error('账本文件损坏（JSON 解析失败，拒当空账本重建——先修文件再继续）：' + target + '：' + (e && e.message)) }
}

async function saveJson(fs, dir, fileName, value) {
  const target = await fs.resolve(dir + '/' + fileName)
  await fs.writeText(target, JSON.stringify(value, null, 2))
  return target
}

async function appendEvent(fs, dir, event) {
  const file = dir + '/events.jsonl'
  const target = await fs.resolve(file)
  const st = await fs.stat(target)
  let existing = ''
  if (st) { existing = await fs.readText(target) }
  const line = JSON.stringify(Object.assign({ at: new Date().toISOString() }, event))
  await fs.writeText(target, existing ? existing + '\n' + line : line)
  return target
}

/** 读全部事件（JSON 行数组），供裁决生效时回查冲突记录。 */
async function readEvents(fs, dir) {
  const target = await fs.resolve(dir + '/events.jsonl')
  const st = await fs.stat(target)
  if (!st) return []
  return (await fs.readText(target)).split('\n').filter(Boolean)
}

function bookRootOf(args) {
  const dir = String(args.book_dir || '').trim()
  if (!dir) throw new Error('book_dir 不能为空')
  return dir.replace(/\\/g, '/').replace(/\/+$/, '')
}

/** 章节文件编号：chapter_001.md … */
function chapterFile(ch) {
  return 'chapter_' + String(ch).padStart(3, '0') + '.md'
}

function chapterTitle(fileName) {
  const m = /^chapter_(\d+)\.md$/.exec(fileName)
  return m ? Number(m[1]) : null
}

// ---------------------------------------------------------------- 符号门（确定性，写入口内联）

/** 字数口径：只数汉字（与引擎 quality_gate 同口径）。 */
function countHan(text) {
  return (text.match(/[\u4e00-\u9fff]/g) || []).length
}

/**
 * 内联符号门：**只做账本会计，不判好坏**。
 * - 代词-性别检查已删（试图用符号判语义，错位检查）；
 * - 字数是发布节奏的业务参数（章纲 word_min/word_max），偏离只报 issue 不拦稿；
 * - 拦稿仅限结构性错误（章号非法等，在 execute 硬拦）。
 * 返回 { han, issues }：issues 为非阻塞警示清单，随 chapter_commit 入事件账。
 */
function symbolGate(text, outlineEntry) {
  const issues = []
  const han = countHan(text)
  if (outlineEntry) {
    if (outlineEntry.word_min && han < outlineEntry.word_min) {
      issues.push('字数低于章纲下限：' + han + ' < ' + outlineEntry.word_min + '（业务参数，不拦稿）')
    }
    if (outlineEntry.word_max && han > outlineEntry.word_max) {
      issues.push('字数高于章纲上限：' + han + ' > ' + outlineEntry.word_max + '（业务参数，不拦稿）')
    }
  }
  return { han, issues }
}

/**
 * 产线校准建议（2026-09-03）：按已落盘章节实测汉字分布推荐章纲字数窗口。
 * 样本 ≥3 章才出建议（小样本噪声大）；p25/p75 取整到百位；只建议不替人定（业务参数归人）。
 */
async function recommendWordWindow(fs, dir) {
  let files = []
  try { files = await fs.listDir(await fs.resolve(dir + '/manuscript')) } catch (e) { return null }
  const hans = []
  for (const e of files || []) {
    if (!/^chapter_\d+\.md$/.test(e.name)) continue
    const t = await fs.readText(await fs.resolve(dir + '/manuscript/' + e.name))
    const h = countHan(t)
    if (h > 0) hans.push(h)
  }
  if (hans.length < 3) return null
  hans.sort((a, b) => a - b)
  const q = (p) => hans[Math.min(hans.length - 1, Math.floor(p * (hans.length - 1)))]
  const sMax = Math.ceil(q(0.75) / 100) * 100
  const sMin = Math.min(Math.max(1000, Math.floor(q(0.25) / 100) * 100), Math.max(100, sMax - 100))
  return {
    sample: hans.length, min: hans[0], max: hans[hans.length - 1], median: q(0.5),
    suggest_word_min: sMin, suggest_word_max: sMax,
  }
}

// ---------------------------------------------------------------- 章状态机

/** 章级状态词汇与合法迁移表（平台无关命名；落具体平台时做映射）。 */
const CHAPTER_STATES = ['草稿', '已审', '待试读', '已试读', '待修订', '已定稿', '存稿', '待外审', '已发表', '打回修订']
const CHAPTER_TRANSITIONS = {
  '草稿': ['已审', '待修订'],
  '已审': ['待试读', '待修订'],
  '待试读': ['已试读', '待修订'],
  '已试读': ['待修订', '已定稿'],
  '待修订': ['已审', '已定稿'],
  '已定稿': ['存稿', '待修订'],
  '存稿': ['待外审', '已定稿'],
  '待外审': ['已发表', '打回修订'],
  '已发表': ['打回修订'],
  '打回修订': ['待修订', '已定稿'],
}

// ---------------------------------------------------------------- 工具定义

const TOOLS = [
  // 1. novel_init：建书骨架（一次性）
  {
    name: 'novel_init',
    timeoutMs: WRITE_TIMEOUT_MS,
    description: '新建一部书工程：落 project/bible/characters/foreshadows/timeline/outline 全套空账本 + manuscript 目录。一次性，幂等（已存在则报错）。',
    parameters: bookDirParam({
      properties: {
        title: { type: 'string', description: '书名' },
        genre: { type: 'string', description: '类型（番茄档：dushi/xuanhuan/xuanyi…）' },
        logline: { type: 'string', description: '一句话故事（主编与 Owner 定稿后写）' },
      },
      required: ['book_dir', 'title', 'genre', 'logline'],
    }),
    output: {
      schema: { type: 'object', properties: { ok: { type: 'boolean' }, book_dir: { type: 'string' }, created: { type: 'array', items: { type: 'string' } } }, additionalProperties: false },
      render: (a, v) => textBlock(v.ok ? '建书成功：' + v.book_dir + '（' + v.created.join('、') + '）' : '建书失败'),
    },
    async execute(args, exec) {
      const fs = exec.agent.ctx && exec.agent.ctx.get ? exec.agent.ctx.get('fs') : undefined
      if (!fs) throw new Error('fs 服务不可用')
      const dir = bookRootOf(args)
      const project = await loadJson(fs, dir, 'project.json')
      if (project) throw new Error('书已存在：' + dir)
      const created = []
      await saveJson(fs, dir, 'project.json', {
        book_id: dir.split('/').pop(),
        title: args.title, genre: args.genre, logline: args.logline,
        status: 'drafting', current_ch: 0, volumes: [],
        schema_version: 1,
      }); created.push('project.json')
      await saveJson(fs, dir, 'bible.json', { terms: [] }); created.push('bible.json')
      await saveJson(fs, dir, 'characters.json', { characters: [] }); created.push('characters.json')
      await saveJson(fs, dir, 'foreshadows.json', { foreshadows: [] }); created.push('foreshadows.json')
      await saveJson(fs, dir, 'timeline.json', { events: [] }); created.push('timeline.json')
      await saveJson(fs, dir, 'outline.json', { volumes: [] }); created.push('outline.json')
      await appendEvent(fs, dir, { op: 'book_init', book_id: args.title })
      return { ok: true, book_dir: dir, created }
    },
  },

  // 2. novel_outline：写/读卷章纲
  {
    name: 'novel_outline',
    timeoutMs: WRITE_TIMEOUT_MS,
    description: '读或写卷/章大纲。op=read 返回全卷章纲（含每章目标/钩子/字数区间）；op=write 写入一章纲（主编定稿）。大纲是正文的唯一依据。read/write 均附产线校准建议 recommend（按已落盘章节实测汉字分布推荐的 word_min/word_max，样本≥3 章才出）。',
    parameters: bookDirParam({
      properties: {
        op: { type: 'string', enum: ['read', 'write'], description: 'read=读全卷纲；write=写一章纲' },
        volume: { type: 'integer', description: '卷号（write 必填）' },
        chapter_no: { type: 'integer', description: '章号（write 必填）' },
          entry: { type: 'object', additionalProperties: true, description: 'write 时传入：{ title, goal, hook, word_min, word_max, scenes: [], differentiation? }。卷首章必答 differentiation=与榜单头部哪里不一样（差异化槽位）' },
      },
      required: ['book_dir', 'op'],
    }),
    output: {
      schema: { type: 'object', properties: { op: { type: 'string' }, outline: { type: 'object', additionalProperties: true }, warn: { type: 'string' }, recommend: { type: 'object', additionalProperties: true } }, additionalProperties: false },
      render: (a, v) => textBlock(JSON.stringify(v.outline || {}, null, 2) + (v.recommend ? '\n产线校准建议（已落盘 ' + v.recommend.sample + ' 章实测分布：min ' + v.recommend.min + ' / 中位 ' + v.recommend.median + ' / max ' + v.recommend.max + '）：建议 word_min=' + v.recommend.suggest_word_min + '、word_max=' + v.recommend.suggest_word_max + '（只建议不替人定）' : '')),
    },
    async execute(args, exec) {
      const fs = exec.agent.ctx && exec.agent.ctx.get ? exec.agent.ctx.get('fs') : undefined
      if (!fs) throw new Error('fs 服务不可用')
      const dir = bookRootOf(args)
      const outline = await loadJson(fs, dir, 'outline.json') || { volumes: [] }
      // 输出值禁带 undefined 键（DSH 对工具返回做无损 JSON 校验会整单拒收——2026-09-03 验壳实测）：
      // 可选字段一律条件挂键，绝不 `key: x || undefined`
      if (args.op === 'read') {
        const ret = { op: 'read', outline }
        const rec = await recommendWordWindow(fs, dir)
        if (rec) ret.recommend = rec
        return ret
      }
      if (!args.volume || !args.chapter_no || !args.entry) throw new Error('write 需要 volume/chapter_no/entry')
      let vol = outline.volumes.find((v) => v.volume === args.volume)
      if (!vol) { vol = { volume: args.volume, chapters: [] }; outline.volumes.push(vol) }
      const idx = vol.chapters.findIndex((c) => c.chapter_no === args.chapter_no)
      const entry = Object.assign({}, args.entry, { chapter_no: args.chapter_no })
      if (idx >= 0) vol.chapters[idx] = entry; else vol.chapters.push(entry)
      vol.chapters.sort((a, b) => a.chapter_no - b.chapter_no)
      await saveJson(fs, dir, 'outline.json', outline)
      const firstNo = vol.chapters.length ? vol.chapters[0].chapter_no : args.chapter_no
      const warns = []
      if (args.chapter_no === firstNo && !args.entry.differentiation) warns.push('卷首章缺差异化槽位 differentiation（必答：与榜单头部哪里不一样；即时提示以当前最小章号为准，终判在 novel_verify）')
      // 参数压测实测（2026-09-01）：写手子代理单回复上限约 1 万汉字（10506 实测），
      // 且模型自报字数虚高 37%-63%。下限超 1 万即提示分段写作协议——只提示不拦（业务参数）。
      if (Number(args.entry.word_min) > 10000) warns.push('章纲 word_min=' + args.entry.word_min + ' 超过写手单回复上限（实测约 1 万汉字）：本章程必须走分段写作协议（多次交付+落盘+主编拼装核数，novel_count 口径）')
      const warn = warns.length ? warns.join('；') : null
      await appendEvent(fs, dir, Object.assign({ op: 'outline_write', volume: args.volume, chapter_no: args.chapter_no }, warn ? { warn } : {}))
      // 同上：可选字段条件挂键，禁 undefined（无损 JSON 校验）
      const ret = { op: 'write', outline }
      if (warn) ret.warn = warn
      const rec = await recommendWordWindow(fs, dir)
      if (rec) ret.recommend = rec
      return ret
    },
  },

  // 3. novel_bible：写前必查（防吃书）
  {
    name: 'novel_bible',
    description: '查设定库（bible/人物/伏笔/时间线），按当前章过滤生效窗口，输出带证据章。写正文前必查（防吃书）。',
    parameters: bookDirParam({
      properties: {
        ch: { type: 'integer', description: '当前写作章号（过滤事实有效期）' },
        scope: { type: 'string', enum: ['all', 'term', 'character', 'foreshadow', 'timeline'], description: '查询范围' },
        name: { type: 'string', description: '可选：精确查找某个术语/人物' },
      },
      required: ['book_dir', 'ch'],
    }),
    output: {
      schema: { type: 'object', properties: { ch: { type: 'integer' }, terms: { type: 'array' }, characters: { type: 'array' }, foreshadows: { type: 'array' }, timeline: { type: 'array' } }, additionalProperties: false },
      render: (a, v) => renderJson(v),
    },
    async execute(args, exec) {
      const fs = exec.agent.ctx && exec.agent.ctx.get ? exec.agent.ctx.get('fs') : undefined
      if (!fs) throw new Error('fs 服务不可用')
      const dir = bookRootOf(args)
      const ch = args.ch
      const eff = (x) => x && (x.effective_from_ch == null || x.effective_from_ch <= ch) && (x.effective_to_ch == null || ch <= x.effective_to_ch)
      const pick = (name, arr, cond) => {
        const list = (arr || []).filter(cond)
        return name ? list.filter((x) => (x.name || '').includes(name)) : list
      }
      const bible = await loadJson(fs, dir, 'bible.json') || { terms: [] }
      const chars = await loadJson(fs, dir, 'characters.json') || { characters: [] }
      const fsh = await loadJson(fs, dir, 'foreshadows.json') || { foreshadows: [] }
      const tml = await loadJson(fs, dir, 'timeline.json') || { events: [] }
      return {
        ch,
        terms: (args.scope === 'all' || args.scope === 'term') ? pick(args.name, bible.terms, eff) : [],
        characters: (args.scope === 'all' || args.scope === 'character') ? pick(args.name, chars.characters, eff) : [],
        foreshadows: (args.scope === 'all' || args.scope === 'foreshadow') ? (fsh.foreshadows || []).filter((f) => f.status !== 'closed') : [],
        timeline: (args.scope === 'all' || args.scope === 'timeline') ? (tml.events || []).filter((e) => e.ch == null || e.ch <= ch) : [],
      }
    },
  },

  // 4. novel_chapter：正文落盘 + 自动记账 + 内联符号门（唯一正稿写入口）
  {
    name: 'novel_chapter',
    timeoutMs: WRITE_TIMEOUT_MS,
    description: '提交一章正文：正文参数携带（唯一写入口）→ 落盘 manuscript/chapter_XXX.md + 版本快照 + 伏笔埋/收 + 时间线 append + 出场人物 cast + 事件账 + 状态初始化（草稿）。落盘即跑符号门（只记账不判好坏：字数 vs 章纲区间、closes/cast 引用完整性），问题记 issue 不拦稿。',
    parameters: bookDirParam({
      properties: {
        ch: { type: 'integer', description: '章号（与 outline 一致）' },
        title: { type: 'string', description: '本章标题' },
        text: { type: 'string', description: '本章正文（模型产出，参数携带）' },
        seeds: { type: 'array', items: { type: 'object', additionalProperties: true }, description: '可选：本章新埋伏笔 [{ id, name, due_ch }]' },
        closes: { type: 'array', items: { type: 'string' }, description: '可选：本章回收的伏笔 id 列表' },
        timeline_events: { type: 'array', items: { type: 'object', additionalProperties: true }, description: '可选：本章发生的时间线事件 [{ time, what }]' },
        cast: { type: 'array', items: { type: 'string' }, description: '可选：本章出场人物名（用于人物卡出场章登记）' },
      },
      required: ['book_dir', 'ch', 'title', 'text'],
    }),
    output: {
      schema: { type: 'object', properties: { ok: { type: 'boolean' }, ch: { type: 'integer' }, han: { type: 'number' }, rev: { type: 'integer' }, gate: { type: 'object', additionalProperties: true } }, additionalProperties: false },
      render: (a, v) => textBlock(v.ok ? '章 ' + v.ch + ' 已落盘（' + v.han + ' 汉字，rev ' + v.rev + '）' + (v.gate && v.gate.issues && v.gate.issues.length ? '；门警示：' + v.gate.issues.join('；') : '') : '落盘被拦：' + JSON.stringify(v)),
    },
    async execute(args, exec) {
      const fs = exec.agent.ctx && exec.agent.ctx.get ? exec.agent.ctx.get('fs') : undefined
      if (!fs) throw new Error('fs 服务不可用')
      const dir = bookRootOf(args)
      const text = String(args.text || '')
      const ch = Number(args.ch)
      if (!Number.isInteger(ch) || ch < 1) throw new Error('ch 必须为正整数')
      const outline = await loadJson(fs, dir, 'outline.json') || { volumes: [] }
      let outlineEntry = null
      for (const vol of outline.volumes || []) {
        const e = (vol.chapters || []).find((c) => c.chapter_no === ch)
        if (e) { outlineEntry = e; break }
      }
      const gate = symbolGate(text, outlineEntry)
      if (gate.han > 0 && (!args.cast || args.cast.length === 0)) gate.issues.push('[P2 提示] 本章未携带 cast（纯过场可接受；收束验收③需随章登记出场人物，主编裁定）')
      const msTarget = await fs.resolve(dir + '/manuscript/' + chapterFile(ch))
      const oldSt = await fs.stat(msTarget)
      let rev = 1
      if (oldSt) {
        const vDir = dir + '/versions'
        let vers = []
        try { vers = await fs.listDir(await fs.resolve(vDir)) } catch (e) { /* versions 目录尚不存在 */ }
        const base = chapterFile(ch).replace(/\.md$/, '')
        const versNames = (vers || []).map((e) => e.name).filter((n) => n.startsWith(base + '.v'))
        rev = versNames.length + 2 // 重交时：已有快照数 + 手稿本体 1 + 本次新稿 1
        const oldText = await fs.readText(msTarget)
        await fs.writeText(await fs.resolve(vDir + '/' + base + '.v' + (rev - 1) + '.md'), oldText)
      }
      await fs.writeText(msTarget, text)
      const fsh = await loadJson(fs, dir, 'foreshadows.json') || { foreshadows: [] }
      for (const s of (args.seeds || [])) {
        // 幂等语义（实测 bug 修复）：同章修订重提交不得重复入账——
        // 已在账的伏笔按更新处理（due_ch 可改），不 push 第二条
        const ex = fsh.foreshadows.find((x) => x.id === s.id)
        if (ex) { if (s.due_ch != null) ex.due_ch = s.due_ch; continue }
        fsh.foreshadows.push({ id: s.id, name: s.name, planted_ch: ch, due_ch: s.due_ch || ch + 30, status: 'planted', closed_ch: null })
      }
      for (const cid of (args.closes || [])) {
        const f = fsh.foreshadows.find((x) => x.id === cid)
        if (!f) { gate.issues.push('closes 引用未知伏笔 id：' + cid + '（已记 issue，不静默）'); continue }
        if (f.status !== 'closed') { f.status = 'closed'; f.closed_ch = ch }
      }
      await saveJson(fs, dir, 'foreshadows.json', fsh)
      const tml = await loadJson(fs, dir, 'timeline.json') || { events: [] }
      for (const e of (args.timeline_events || [])) {
        // 幂等语义（实测 bug 修复）：同章修订重提交，相同事件（ch+time+what
        // 逐字相同）不重复 append——修订换版本快照，不换账
        const dup = tml.events.some((x) => x.ch === ch && x.time === e.time && x.what === e.what)
        if (!dup) tml.events.push(Object.assign({ ch }, e))
      }
      await saveJson(fs, dir, 'timeline.json', tml)
      if (args.cast && args.cast.length) {
        const cj = await loadJson(fs, dir, 'characters.json') || { characters: [] }
        for (const nm of args.cast) {
          const c = cj.characters.find((x) => x.name === nm)
          if (c) { c.last_seen_ch = ch } else { gate.issues.push('cast 未建人物卡：' + nm + '（不自动造卡——核对章纲或先 novel_ledger update_character）') }
        }
        await saveJson(fs, dir, 'characters.json', cj)
      }
      const project = await loadJson(fs, dir, 'project.json') || { current_ch: 0 }
      if (ch > project.current_ch) { project.current_ch = ch; await saveJson(fs, dir, 'project.json', project) }
      const stj = await loadJson(fs, dir, 'status.json') || {}
      if (!stj[ch]) { stj[ch] = '草稿'; await saveJson(fs, dir, 'status.json', stj) }
      await appendEvent(fs, dir, Object.assign({ op: 'chapter_commit', ch, rev, han: gate.han }, gate.issues.length ? { issues: gate.issues } : {}))
      return { ok: true, ch, han: gate.han, rev, gate }
    },
  },

  // 5. novel_verify：符号级自检（只读）
  {
    name: 'novel_verify',
    description: '一致性机检：伏笔逾期（due_ch 未收）/版本链连续/章纲-正文存在性/章号断档。只出问题清单，不做语义判定（语义审稿归试读员/校对员子代理）。',
    parameters: bookDirParam({ properties: { ch: { type: 'integer', description: '可选：只看某章；缺省全量' } }, required: ['book_dir'] }),
    output: {
      schema: { type: 'object', properties: { ok: { type: 'boolean' }, issues: { type: 'array' }, stats: { type: 'object', additionalProperties: true } }, additionalProperties: false },
      render: (a, v) => renderJson(v),
    },
    async execute(args, exec) {
      const fs = exec.agent.ctx && exec.agent.ctx.get ? exec.agent.ctx.get('fs') : undefined
      if (!fs) throw new Error('fs 服务不可用')
      const dir = bookRootOf(args)
      const issues = []
      const project = await loadJson(fs, dir, 'project.json') || { current_ch: 0 }
      const fsh = await loadJson(fs, dir, 'foreshadows.json') || { foreshadows: [] }
      const outline = await loadJson(fs, dir, 'outline.json') || { volumes: [] }
      const msDir = await fs.resolve(dir + '/manuscript')
      let files = []
      try { files = await fs.listDir(msDir) } catch (e) { /* 无目录 */ }
      const chapters = (files || []).map((e) => chapterTitle(e.name)).filter((n) => n != null).sort((a, b) => a - b)
      const cur = args.ch || project.current_ch || 0
      for (const f of fsh.foreshadows || []) {
        if (f.status === 'planted' && f.due_ch != null && f.due_ch < cur) issues.push('伏笔逾期未收：「' + f.name + '」（埋于 ' + f.planted_ch + '，due ' + f.due_ch + '，当前 ' + cur + '）')
      }
      for (const vol of outline.volumes || []) {
        for (const c of vol.chapters || []) {
          if (c.chapter_no > cur) continue
          if (!chapters.includes(c.chapter_no)) issues.push('章纲已写但正文缺失：第 ' + c.chapter_no + ' 章「' + (c.title || '') + '」')
        }
      }
      for (let n = 1; n <= cur; n++) {
        if (!chapters.includes(n)) issues.push('章号断档：第 ' + n + ' 章文件缺失')
      }
      // 版本链连续：每章快照 v1..vN 不跳号（符号层管版本链）
      let vfiles = []
      try { vfiles = await fs.listDir(await fs.resolve(dir + '/versions')) } catch (e) { /* 无目录 */ }
      const byChapter = {}
      const vPattern = /^chapter_(\d+)\.v(\d+)\.md$/
      for (const e of (vfiles || [])) {
        const m = vPattern.test(e.name) ? e.name.match(vPattern) : null
        if (m) { (byChapter[m[1]] = byChapter[m[1]] || []).push(Number(m[2])) }
      }
      for (const chKey of Object.keys(byChapter)) {
        const nums = byChapter[chKey].sort((a, b) => a - b)
        for (let i = 0; i < nums.length; i++) {
          if (nums[i] !== i + 1) { issues.push('版本链跳号：第 ' + Number(chKey) + ' 章快照应为 v' + (i + 1) + ' 实为 v' + nums[i]); break }
        }
      }
      const stj = await loadJson(fs, dir, 'status.json') || {}
      const statusDist = {}
      for (const k of Object.keys(stj)) { statusDist[stj[k]] = (statusDist[stj[k]] || 0) + 1 }
      for (const vol of outline.volumes || []) {
        const chs = (vol.chapters || []).slice().sort((a, b) => a.chapter_no - b.chapter_no)
        if (chs.length && !chs[0].differentiation) issues.push('卷 ' + vol.volume + ' 卷首章（' + chs[0].chapter_no + '）缺差异化槽位 differentiation（必答"与榜单头部哪里不一样"）')
      }
      return {
        ok: issues.length === 0,
        issues,
        stats: { current_ch: cur, chapters_written: chapters.length, foreshadows_open: (fsh.foreshadows || []).filter((f) => f.status !== 'closed').length, status: statusDist },
      }
    },
  },

  // 5.5 novel_count：只读字数核数（全体角色可用，含子代理——不在 deny 名单）
  // 由来（2026-09-01 实测）：写手自报字数虚高 37%-63%（17150 自报 vs 10506 实测），
  // 模型心算不可信；字数唯一可信口径 = 工具数 [\u4e00-\u9fff]。给子代理一个免 deny 的自核入口。
  {
    name: 'novel_count',
    description: '只读字数核数（不写任何文件，写手/试读员/校对员均可用）：按 novel_chapter 同口径 [\\u4e00-\\u9fff] 数汉字。交付前自核、验收核数一律用它——模型自报字数不可信（实测虚高 37%-63%）。',
    parameters: {
      type: 'object',
      properties: {
        file: { type: 'string', description: '可选：待数文本文件的绝对路径（与 text 二选一）' },
        text: { type: 'string', description: '可选：直接携带待数文本（与 file 二选一）' },
      },
      additionalProperties: false,
    },
    output: {
      schema: { type: 'object', properties: { han: { type: 'number' }, bytes: { type: 'number' }, lines: { type: 'number' }, source: { type: 'string' } }, additionalProperties: false },
      render: (a, v) => textBlock('汉字 ' + v.han + ' / 字节 ' + v.bytes + ' / 行 ' + v.lines + '（口径 [\\u4e00-\\u9fff]，来源 ' + v.source + '）'),
    },
    async execute(args, exec) {
      const fs = exec.agent.ctx && exec.agent.ctx.get ? exec.agent.ctx.get('fs') : undefined
      let text = null
      let source = 'text'
      if (args.file) {
        if (!fs) throw new Error('fs 服务不可用（file 模式需要）')
        text = await fs.readText(await fs.resolve(String(args.file)))
        source = String(args.file)
      } else if (args.text != null) {
        text = String(args.text)
      } else {
        throw new Error('file 与 text 必须二选一')
      }
      return {
        han: countHan(text),
        bytes: Buffer.byteLength(text, 'utf8'),
        lines: text.split('\n').length,
        source,
      }
    },
  },

  // 6. novel_ledger：台账定向增改 + 冲突仲裁
  {
    name: 'novel_ledger',
    timeoutMs: WRITE_TIMEOUT_MS,
    description: '台账定向操作。op=update_character 增改人物卡（值冲突不静默，返回 conflict 需 resolve_conflict 仲裁后才生效）；op=update_term 增改设定词条；op=update_foreshadow 伏笔策展（改 due_ch/名/planted_ch，重排卷纲与弧审坐标纠偏用）；op=resolve_conflict 落仲裁（两分法：semantic=编辑部证据裁决不 ask / authority=Owner 权责裁决走 ask 且否决必带理由）；op=close_foreshadow 手动闭伏笔；op=set_chapter_status 章状态机迁移。',
    parameters: bookDirParam({
      properties: {
        op: { type: 'string', enum: ['update_character', 'update_term', 'update_foreshadow', 'resolve_conflict', 'close_foreshadow', 'set_chapter_status'], description: '操作类型' },
        character: { type: 'object', additionalProperties: true, description: 'update_character 时：{ name, gender?, identity?, effective_from_ch?, evidence_ch? }' },
        term: { type: 'object', additionalProperties: true, description: 'update_term 时：{ name, value, effective_from_ch?, evidence_ch? }' },
        conflict: { type: 'object', additionalProperties: true, description: 'resolve_conflict 时（两分法）：{ id, scope: "semantic"|"authority", verdict: "accept_new"|"keep_old", stance?, evidence?, reason? }。semantic=语义/事实冲突，编辑部立场 stance + 证据坐标 evidence 必填，不 ask；authority=权责/商业冲突，Owner ask 裁，否决（keep_old）必带 reason（ADR 铁律）' },
        foreshadow_id: { type: 'string', description: 'close_foreshadow / update_foreshadow 时：伏笔 id' },
        due_ch: { type: 'integer', description: 'update_foreshadow 时：新到期章号' },
        planted_ch: { type: 'integer', description: 'update_foreshadow 时：新埋设章号（弧审台账坐标纠偏；正常埋设由 novel_chapter seeds 自动记，勿用于覆盖正当坐标）' },
        new_name: { type: 'string', description: 'update_foreshadow 时：新名称（可选）' },
        ch: { type: 'integer', description: 'set_chapter_status 时：章号' },
        status: { type: 'string', description: 'set_chapter_status 时：目标状态，合法值 ' + CHAPTER_STATES.join('/') },
        note: { type: 'string', description: 'set_chapter_status / update_foreshadow / close_foreshadow 时可选：备注（状态迁移=如外审打回原因；伏笔改期/闭伏笔=理由留痕，防"洗逾期"无法复盘）' },
      },
      required: ['book_dir', 'op'],
    }),
    output: {
      schema: { type: 'object', properties: { ok: { type: 'boolean' }, result: { type: 'object', additionalProperties: true } }, additionalProperties: false },
      render: (a, v) => renderJson(v),
    },
    async execute(args, exec) {
      const fs = exec.agent.ctx && exec.agent.ctx.get ? exec.agent.ctx.get('fs') : undefined
      if (!fs) throw new Error('fs 服务不可用')
      const dir = bookRootOf(args)
      if (args.op === 'update_foreshadow') {
        // 伏笔策展（2026-09-01 拆章战役加）：重排卷纲/节奏调整后改 due_ch、改名。
        // 只改字段不开闭（开闭走 seeds/closes/close_foreshadow）；改动记事件账。
        const fsh = await loadJson(fs, dir, 'foreshadows.json') || { foreshadows: [] }
        const f = fsh.foreshadows.find((x) => x.id === args.foreshadow_id)
        if (!f) throw new Error('伏笔不存在：' + args.foreshadow_id)
        const before = { due_ch: f.due_ch, name: f.name, planted_ch: f.planted_ch }
        if (args.due_ch != null) {
          if (!Number.isInteger(args.due_ch) || args.due_ch < 1) throw new Error('due_ch 需为正整数')
          f.due_ch = args.due_ch
        }
        if (args.planted_ch != null) {
          if (!Number.isInteger(args.planted_ch) || args.planted_ch < 1) throw new Error('planted_ch 需为正整数')
          f.planted_ch = args.planted_ch
        }
        if (args.new_name) f.name = String(args.new_name)
        await saveJson(fs, dir, 'foreshadows.json', fsh)
        await appendEvent(fs, dir, { op: 'foreshadow_update', id: args.foreshadow_id, before, after: { due_ch: f.due_ch, name: f.name, planted_ch: f.planted_ch }, reason: args.note || undefined })
        return { ok: true, result: { updated: args.foreshadow_id, due_ch: f.due_ch, name: f.name, planted_ch: f.planted_ch != null ? f.planted_ch : null } }
      }
      if (args.op === 'close_foreshadow') {
        const fsh = await loadJson(fs, dir, 'foreshadows.json') || { foreshadows: [] }
        const f = fsh.foreshadows.find((x) => x.id === args.foreshadow_id)
        if (!f) throw new Error('伏笔不存在：' + args.foreshadow_id)
        f.status = 'closed'; f.closed_ch = f.closed_ch || (await loadJson(fs, dir, 'project.json') || { current_ch: 0 }).current_ch
        await saveJson(fs, dir, 'foreshadows.json', fsh)
        await appendEvent(fs, dir, { op: 'foreshadow_close', id: args.foreshadow_id, reason: args.note || undefined })
        return { ok: true, result: { closed: args.foreshadow_id } }
      }
      if (args.op === 'set_chapter_status') {
        const to = args.status
        if (!CHAPTER_STATES.includes(to)) throw new Error('未知状态：' + to + '（合法：' + CHAPTER_STATES.join('/') + '）')
        if (!Number.isInteger(args.ch) || args.ch < 1) throw new Error('set_chapter_status 需要 ch（正整数）')
        const st = await loadJson(fs, dir, 'status.json') || {}
        const from = st[args.ch] || '草稿'
        if (from !== to && !(CHAPTER_TRANSITIONS[from] || []).includes(to)) {
          throw new Error('非法状态迁移：' + from + ' → ' + to + '（合法去向：' + ((CHAPTER_TRANSITIONS[from] || []).join('/') || '无') + '）')
        }
        st[args.ch] = to
        await saveJson(fs, dir, 'status.json', st)
        await appendEvent(fs, dir, { op: 'chapter_status', ch: args.ch, from, to, note: args.note || null })
        return { ok: true, result: { ch: args.ch, from, to } }
      }
      if (args.op === 'resolve_conflict') {
        const c = args.conflict || {}
        if (!c.id) throw new Error('resolve_conflict 需要 conflict.id')
        if (c.scope !== 'semantic' && c.scope !== 'authority') throw new Error('resolve_conflict 需要 conflict.scope（两分法）：semantic=语义/事实冲突（编辑部证据裁决）/ authority=权责/商业冲突（Owner 裁）')
        if (c.scope === 'semantic' && !c.stance) throw new Error('语义类裁决必须带编辑部立场 stance（编辑部先立场，不拿 Owner 拍板当懒政挡箭牌）')
        if (c.scope === 'semantic' && !c.evidence) throw new Error('语义类裁决必须带证据坐标 evidence（章号/伏笔 id/事件账条目）')
        if (c.scope === 'authority' && !c.reason) throw new Error('权责类裁决必须带理由 reason（ADR 铁律：无理由的否决在账上不允许关闭）')
        // 裁决生效闭环：accept_new 时把冲突值写回台账——否则冲突值永远无法经工具变更（死锁）
        if (c.verdict === 'accept_new') {
          const conf = (await readEvents(fs, dir))
            .map((l) => { try { return JSON.parse(l) } catch (e) { return null } })
            .filter((e) => e && e.op === 'conflict' && e.id === c.id).pop()
          if (conf && conf.kind === 'character_gender') {
            const cj2 = await loadJson(fs, dir, 'characters.json') || { characters: [] }
            const ch2 = cj2.characters.find((x) => x.name === conf.name)
            if (ch2) { ch2.gender = conf.new; await saveJson(fs, dir, 'characters.json', cj2) }
          } else if (conf && conf.kind === 'term_value') {
            const bible2 = await loadJson(fs, dir, 'bible.json') || { terms: [] }
            const t2 = bible2.terms.find((x) => x.name === conf.name)
            if (t2) { t2.value = conf.new; await saveJson(fs, dir, 'bible.json', bible2) }
          }
        }
        await appendEvent(fs, dir, { op: 'conflict_resolved', id: c.id, scope: c.scope, verdict: c.verdict, stance: c.stance || null, evidence: c.evidence || null, reason: c.reason || null })
        return { ok: true, result: { resolved: c.id, scope: c.scope, verdict: c.verdict } }
      }
      if (args.op === 'update_character') {
        const cj = await loadJson(fs, dir, 'characters.json') || { characters: [] }
        const c = args.character
        if (!c || !c.name) throw new Error('update_character 需要 character.name')
        const existing = cj.characters.find((x) => x.name === c.name)
        if (existing && existing.gender && c.gender && existing.gender !== c.gender) {
          const conflictId = 'c_' + Date.now()
          await appendEvent(fs, dir, { op: 'conflict', id: conflictId, scope: 'semantic', kind: 'character_gender', name: c.name, old: existing.gender, new: c.gender })
          return { ok: false, result: { conflict: { id: conflictId, kind: 'character_gender', name: c.name, old: existing.gender, new: c.gender, message: '性别与既有卡冲突，请 resolve_conflict 仲裁' } } }
        }
        if (existing) Object.assign(existing, c); else cj.characters.push(c)
        await saveJson(fs, dir, 'characters.json', cj)
        await appendEvent(fs, dir, { op: 'character_update', name: c.name })
        return { ok: true, result: { saved: c.name } }
      }
      if (args.op === 'update_term') {
        const bible = await loadJson(fs, dir, 'bible.json') || { terms: [] }
        const t = args.term
        if (!t || !t.name) throw new Error('update_term 需要 term.name')
        const existing = bible.terms.find((x) => x.name === t.name)
        if (existing && t.value && existing.value !== t.value) {
          const conflictId = 't_' + Date.now()
          await appendEvent(fs, dir, { op: 'conflict', id: conflictId, scope: 'semantic', kind: 'term_value', name: t.name, old: existing.value, new: t.value })
          return { ok: false, result: { conflict: { id: conflictId, kind: 'term_value', name: t.name, old: existing.value, new: t.value, message: '词条值冲突，请 resolve_conflict 仲裁' } } }
        }
        if (existing) Object.assign(existing, t); else bible.terms.push(t)
        await saveJson(fs, dir, 'bible.json', bible)
        await appendEvent(fs, dir, { op: 'term_update', name: t.name })
        return { ok: true, result: { saved: t.name } }
      }
      throw new Error('未知 op：' + args.op)
    },
  },

  // 7. novel_assemble：汇编导出（对外件，ask 门）
  {
    name: 'novel_assemble',
    timeoutMs: WRITE_TIMEOUT_MS,
    description: '汇编全书：按章序合并 manuscript → 单文件 Markdown + 目录 + 统计（章数/总字数/伏笔状态表）。导出件用于发书验收。',
    parameters: bookDirParam({ properties: { out: { type: 'string', description: '可选：导出文件绝对路径；缺省 book_dir/全本.md' } }, required: ['book_dir'] }),
    output: {
      schema: { type: 'object', properties: { ok: { type: 'boolean' }, out: { type: 'string' }, chapters: { type: 'number' }, han: { type: 'number' } }, additionalProperties: false },
      render: (a, v) => textBlock(v.ok ? '已汇编 ' + v.chapters + ' 章 / ' + v.han + ' 汉字 → ' + v.out : '汇编失败'),
    },
    async execute(args, exec) {
      const fs = exec.agent.ctx && exec.agent.ctx.get ? exec.agent.ctx.get('fs') : undefined
      if (!fs) throw new Error('fs 服务不可用')
      const dir = bookRootOf(args)
      const msDir = await fs.resolve(dir + '/manuscript')
      let files = []
      try { files = await fs.listDir(msDir) } catch (e) { throw new Error('尚无正文：' + dir) }
      const chapters = files.map((e) => e.name).filter((n) => /^chapter_\d+\.md$/.test(n)).sort()
      if (!chapters.length) throw new Error('尚无正文')
      let body = '# 全本\n\n'
      let han = 0
      for (const f of chapters) {
        const t = await fs.readText(await fs.resolve(dir + '/manuscript/' + f))
        body += '## ' + f + '\n\n' + t + '\n\n'
        han += countHan(t)
      }
      const out = args.out ? String(args.out) : dir + '/全本.md'
      await fs.writeText(await fs.resolve(out), body)
      await appendEvent(fs, dir, { op: 'assemble', out, chapters: chapters.length })
      return { ok: true, out, chapters: chapters.length, han }
    },
  },
]

// ---------------------------------------------------------------- prompt section

const SECTION = {
  name: 'novelist-guide',
  order: 150,
  text: [
    'novelist-guide v6.3 · 机制细则唯一真源（novelist 插件同版注入；preset persona 只含决策原则与指针）。书工程 = book_dir（一部书一个目录；novel_* 工具一律显式传 book_dir 绝对路径）。身份与协作框架见 persona 段。v6 增量（2026-09-04）：冷读审法换三问量表、前情事实卡、盲角色派工纪律四条；v6.1：编辑部五角色→六角色（+结构校准员，one-shot 纯盲只见正文）；v6.2：P0 回改定稿前 A/B 冷读门、商业工位（书名简介/责编评分卡）；v6.3（修订轮）：校对员 one-shot+交付预算纪律（preset 侧）、编排熔断、写手落盘无题首行。',
    '工作流（每章）：novel_bible 查设定（写前必查，防吃书）→ 定章纲（novel_outline write，卷首章必答差异化槽位 differentiation）→ 正文（你直接产出文本）→ novel_chapter 落盘（参数携带正文；符号门只记账不判好坏）→ novel_verify 自检 → 章状态机流转（见下条）→ 试读员/校对员子代理审（编辑部协作）→ 意见进修订单回改（新版本）。',
    '章状态机（迁移唯一入口=你的 novel_ledger set_chapter_status，子代理不碰状态机）：草稿→已审（你收稿）→待试读（派试读员）→已试读（意见已回）→待修订（内审回改中）→已定稿→存稿→待外审→已发表；外审打回→打回修订。待修订=内审意见回改，打回修订=外审（平台）打回（note 记平台原因），两态勿混用。回改落盘=同章号重新 novel_chapter 提交（携修订后全文），旧版自动留快照绝不静默覆盖；回改后置已审，重走内审分级（主编裁定并注理由）：P0/语义级改动（情节/人设/伏笔/结构）→ 重新派试读员，**定稿前按 A-B 冷读协议（editorial/protocols/A-B冷读协议.md）双 Reader 交换顺序盲读新旧版**；纯文字级（校对 P2 批，裁定无情节影响）→ 只过校对免重试读。',
    '一章收束验收（全过才算写完）：①字数在章纲 word_min/word_max 区间（novel_count 工具口径）②novel_verify 无 P0，或 P0 已挂 board/issue-NNN ③seeds/closes/cast/timeline_events 已随章登记 ④试读/校对 P0 已回改或已挂修订单（P1/P2 可攒批）⑤状态已推进到正确闸口。P0 未清，章不许进已定稿/存稿。',
    '编辑部协作框架（趋同目标/非对抗/你汇总取舍呈 Owner）：唯一 home 在 persona 段（preset 注入），此处不重复；五角色派工见下条。',
    '派工分工（六角色）：写手=纯执笔成文（润色填充，不产结构）；试读员=每章冷读审（三问分级量表+落脚检查+复述核查；协议与量表格式=editorial/protocols/盲读协议.md；常规章两包投递保首读时序，风险章四~六包全协议；one-shot 每章新实例）；结构校准员=每章轻扫八类结构病（证据制：原句引文+病类+反误判检查+最小撤回范围+把握分级，证据不足不报，B 路阈值提高一档；one-shot 纯盲只见正文，弧审时全卷扫描）；校对员=发稿前文字审（错字/标点/人名地名一致性）；档案员=写前设定对账+周期一致性审计；策划=开书/卷级聊法与骨架。各审各的，不重复派工。',
    '前情事实卡（Q2，会话即抛·档案即记忆）：派写手/试读员前的连续性材料由你从账本拼装——本章应兑现伏笔 due 清单+既有钩子+出场人物卡摘要，全带章号坐标；模板=editorial/protocols/前情事实卡.md。连续性判断吃事实卡不吃会话记忆：任何角色的会话上下文都可丢弃后凭账本+事实卡恢复工作状态。',
    '盲角色派工纪律（Q6 四条，违者交付无效）：①中性命名——给盲角色（试读员/A-B Reader/结构校准员）的任务名只说"按档案提交读感记录"，禁带答案表述（如"检查逻辑跳跃/验证伏笔"）；②输入隔离——盲角色只收 读者档案+正文包（试读员另收前情事实卡；校准员只见正文），无大纲/无写作意图/无旧稿/无检测信息/无预期答案，包内出现即原样退回并报"输入污染"；③诚实降级——开不出新实例只能标"自审降级"留痕，不得冒充盲读完成；④Owner 反馈撤销制——Owner 说"看不懂/不好看"=立即撤销对应通过并回改，冷读漏检不得反驳 Owner。',
    '修订单与事项板（editorial/ 工作区，per-role 独立文件免锁）：章/块内具体意见进修订单（orders/block-XXX/：试读员-意见/档案员-审计/校对-批注/主编-汇总），条目结论式≤3行+证据坐标+P0/P1/P2；跨章规则与重复模式进事项板（board/issue-NNN，append-only，状态机：待处理→编辑部立场→待Owner→已裁决/已驳回）。已发表后修订批处理：攒批一次改完一次重审（平台每次改动触发重审）。',
    '商业工位（M2/M3）：novel_outline 定稿后策划交书名候选×5+简介×2（协议=editorial/protocols/书名简介工位.md；主编合并后呈 Owner 三选一/二选一，书名=点开率生死线不自主决定）；存稿≥10 章起主编按 editorial/protocols/责编评分卡-番茄.md 自评（五维带证据坐标，<17 分不送外审，≥20 分才呈送）。',
    '弧级审查：每 5-10 章一次（锚定事件块边界，每卷至少 1 次）。异常触发分两期：未发表期（写作长跑）=试读连续 2 章 P0 / 修订单未处理积压>5 条（含弧审订单）；已发表期追加=外审打回率>30%（一个事件块内）。默认锚 Owner 可调、bible 可覆盖。三问=弧线在轨还是漂移、伏笔收支、差异化是否真落地；全部带证据坐标禁"我觉得"；产出 reports/弧审-卷X-弧Y.md；写手不列席，意见经修订单回流（跨块弧审意见落 orders/arc-卷X-弧Y/ 并计入积压锚，章内意见仍走 block-XXX）。',
    '纪律：正文/台账唯一写入口 = 工具，绝不绕过工具直改文件（账本唯一写入口）；语义判定（好坏/取舍）归模型与编辑部，代码只做壳；重大变更（开书 novel_init/汇编 novel_assemble）走 Owner ask 卡，你不自批。editorial 工作区（修订单 orders/、事项板 board/、弧审报告 reports/）与 .drafts 交付件 = 编辑/子代理的工作产物，允许 write/edit 直写（单写者免锁）；"唯一写入口=工具"特指小说数据账本（bible/characters/foreshadows/timeline/outline/manuscript/versions/status/事件账）。',
    '多轮写作纪律（试产实弹教训 2026-09-01）：写手续写/扩写前必须重读受影响正文全文与相关台账——新插入的设定、观察、细节先与既有正文对账再落笔（分段扩写不回读=同章吃书 P0 的主产地）；bible 词条随情节演进及时改口径；修订注记等元信息绝不写入正文（只存在于版本快照与修订单）。',
    '子代理编排纪律（2026-09 多轮实弹实测修订）：①派工后必须拿到交付或失败结论才许收束回合——0.1.2 起（截至 DSH 0.1.2 实测；升级后以当版实测为准，勿凭本句假设）job_output **不追踪子代理**（实测 unknown job），依赖结果的派工一律前台 spawn（run_in_background:false）同步拿全文；后台 continuable 子代理 settle 时运行时会自动向父代理发通知（含结果与最终消息），等通知期间禁收束回合。禁止"我会等待"然后停笔（headless 下一收束=运行结束，子代理变孤儿，实测一次全丢）。同一子代理同任务**连续 2 次零交付/失败即熔断**：改由主编终校替代，修订单留痕"自审降级+原因"，事后挂事项板复盘——角色故障不许拖死主链（F7：2026-09-04 实测 8.5min 空等教训）。②写手交付必须落盘成文件（.drafts/ 或临时件），交付即用 novel_count 核数（工具口径），自报字数只作参考（历史虚高 37%-63%；2026-09-03 验壳实测 v4-flash 自估 960 vs 实测 969 偏差约 1%，但仍以工具口径为准）；正文文件**首行不写章标题**（对齐 manuscript 无题首行惯例，novel_count 文件口径=入稿口径，免标题字数换算，F5）。③单回复写作上限约 1 万汉字（实测 10506）：章纲 word_min>10000 的章走分段写作协议——每段一交付一落盘一核数，主编拼装后一次 novel_chapter 提交。',
    '冲突两分法（novel_ledger resolve_conflict）：语义/事实冲突（哪个设定版本更自洽）你带编辑部立场 stance+证据坐标 evidence 裁（scope=semantic，不 ask）；权责/商业冲突（retcon/方向/题材/开书）呈 Owner（scope=authority，走 ask），否决必须带 reason——无理由的否决在账上不允许关闭。裁决必须引用工具返回的**真实 conflict id**才生效（伪造 id 不会回写台账）。',
    '伏笔/人物/时间线随写随记：novel_chapter 的 seeds/closes/cast/timeline_events 参数携带；冲突不静默；closes/cast 引用未知 id/名会记 issue，不静默吞掉。',
    'obs 第二大脑（可选外部参考库，路径自定）= 检索型参考库：只在需要审美/市场/方法论时**定向查具体卡**，禁止整库整夹批量读入上下文；检索姿势=fs-search（glob/grep）按关键词定向找卡、命中后 read 单卡；引用必带出处（卡名+原路径）；卡头"验证状态"为未验证/待验证的不得当真理引用；obs 与账本/ADR 冲突时以账本+ADR 为准。',
    '失败恢复：工具报错先读报错原文定位（章号断档/引用未知 id/非法状态迁移/参数缺失），可修则修再重试；需裁决的挂事项板或走 ask，绝不静默吞错、绝不绕过工具直改文件救场。',
  ].join('\n'),
}

// ---------------------------------------------------------------- apply

function apply(ctx, config) {
  const tools = ctx.get('tools')
  if (tools !== undefined) {
    for (const def of TOOLS) {
      ctx.effect(() => tools.register(def), 'novelist: register ' + def.name)
    }
    // 卷级门 + 异常挂起：只有三件大事 ask（审阅 A；novel_ledger 仅 resolve_conflict 需 ask）
    ctx.on('tools/pre-execute', (exec, next) => {
      if (exec && exec.name) {
        if (ASK_TOOLS.has(exec.name)) {
          return { kind: 'ask', reason: ASK_REASONS[exec.name] || ASK_FALLBACK }
        }
        if (exec.name === 'novel_ledger' && exec.args && exec.args.op === 'resolve_conflict' && exec.args.conflict && exec.args.conflict.scope === 'authority') {
          return { kind: 'ask', reason: '权责类冲突仲裁（retcon/开书/汇编/方向类）需要你确认裁决；否决必须带理由（ADR 铁律）。' }
        }
      }
      return next()
    })
  }
  const systemPrompt = ctx.get('systemPrompt')
  if (systemPrompt !== undefined) {
    ctx.effect(() => systemPrompt.section(SECTION), 'novelist: prompt section')
  }
}

const _internals = { countHan, symbolGate, chapterFile, chapterTitle, CHAPTER_STATES, CHAPTER_TRANSITIONS, TOOLS, loadJson }

export { name, apply, inject, _internals }
