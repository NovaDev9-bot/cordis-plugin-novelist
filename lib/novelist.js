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

/**
 * 追加一行 JSONL（真追加，E-1 修复 2026-09-05 审查批）：优先 processPath 桥接 OS 追加原语
 * （O_APPEND——崩溃至多撕末行，不重写全量、无读改写丢更新窗口）；processPath 不可用时降级
 * 读改写（fs 服务 writeText 后端本身 temp+rename 原子发布——dsh-fs-local 源码 :466-485 实查，
 * 单写者下降级安全，仅失去 O(1) 与撕裂免疫；verify 半提交检测兜底）。
 */
async function appendJsonlLine(fs, file, line) {
  const target = await fs.resolve(file)
  try {
    const procPath = await fs.processPath(target)
    const { appendFile, stat, open } = await import('node:fs/promises')
    // 行尾守卫（issue-004 · 2026-09-07 修复）：文件存在且末字节非 \n 时先补换行再追加——
    // 历史版本落盘缺尾换行会把下一行粘进同一物理行（两段各自合法 JSON，verify 报中段损坏）。
    const prev = await stat(procPath).catch(() => null)
    if (prev && prev.size > 0) {
      const fh = await open(procPath, 'r')
      try {
        const buf = Buffer.alloc(1)
        const { bytesRead } = await fh.read(buf, 0, 1, prev.size - 1)
        if (bytesRead === 1 && buf[0] !== 0x0a) await appendFile(procPath, '\n', 'utf8')
      } finally { await fh.close() }
    }
    await appendFile(procPath, line + '\n', 'utf8')
    return { target, mode: 'os-append' }
  } catch (e) {
    // 降级读改写（writeText 后端 temp+rename 原子）。**行尾纪律（压测实锤 bug 修复
    // 2026-09-05）**：两臂必须同样以 \n 收尾——首行落盘若无换行，后续 os-append 会直接
    // 接在其后造成两行合并脏行（appendFile 不建父目录→首写常落此臂）。
    const st = await fs.stat(target)
    let existing = ''
    if (st) { existing = await fs.readText(target) }
    await fs.writeText(target, existing ? existing.replace(/\n?$/, '\n') + line + '\n' : line + '\n')
    return { target, mode: 'rmw-fallback' }
  }
}

async function appendEvent(fs, dir, event) {
  const line = JSON.stringify(Object.assign({ at: new Date().toISOString() }, event))
  return (await appendJsonlLine(fs, dir + '/events.jsonl', line)).target
}

/**
 * 读全部 JSONL 行（事件账/事件带共用）。撕裂容忍（真追加的崩溃语义）：**末行**解析失败
 * =写一半的残行，跳过；**非末行**解析失败=账目中段损坏，大声报错拒静默（账不撕页）。
 */
async function readJsonlLines(fs, file) {
  const target = await fs.resolve(file)
  const st = await fs.stat(target)
  if (!st) return []
  const lines = (await fs.readText(target)).split('\n').filter(Boolean)
  for (let i = 0; i < lines.length; i++) {
    try { JSON.parse(lines[i]) } catch (e) {
      if (i === lines.length - 1) { lines.pop(); break }
      throw new Error('JSONL 中段损坏（非末行解析失败，拒静默跳过）：' + file + ' 第 ' + (i + 1) + ' 行')
    }
  }
  return lines
}

/** 读全部事件（JSON 行数组），供裁决生效时回查冲突记录。 */
async function readEvents(fs, dir) {
  return readJsonlLines(fs, dir + '/events.jsonl')
}

// ---------------------------------------------------------------- 事件带（events-tape，0.4.0 新增）

/** 事件带 kind：decision=决策 / verdict=判词 / revision=修订 / open_thread=欠线 / checkpoint=抗压缩检查点。 */
const TAPE_KINDS = ['decision', 'verdict', 'revision', 'open_thread', 'checkpoint']
/** 粘性类（审查批 C-1）：欠线与检查点永不摘要、始终全量留窗；安全阀上限防带子失控。 */
const TAPE_STICKY_KINDS = new Set(['open_thread', 'checkpoint'])
const TAPE_WINDOW = 12
const TAPE_STICKY_CAP = 40

function tapeFile(dir) { return dir + '/editorial/events-tape.jsonl' }

async function readTapeEntries(fs, dir) {
  const lines = await readJsonlLines(fs, tapeFile(dir))
  const entries = []
  for (const l of lines) { try { entries.push(JSON.parse(l)) } catch (e) { /* readJsonlLines 已把关 */ } }
  return entries
}

async function appendTape(fs, dir, args) {
  const kind = args.kind
  if (!TAPE_KINDS.includes(kind)) throw new Error('kind 必须为：' + TAPE_KINDS.join('/') + '（got ' + kind + '）')
  const what = String(args.what || '')
  const why = String(args.why || '')
  if (!what) throw new Error('what 必填（≤60 字：做了/判了什么）')
  if (!why) throw new Error('why 必填（≤60 字：为什么）')
  if (what.length > 60) throw new Error('what 超 60 字（当前 ' + what.length + '，防膨胀纪律——蒸馏后再记）')
  if (why.length > 60) throw new Error('why 超 60 字（当前 ' + why.length + '，防膨胀纪律——蒸馏后再记）')
  if (!args.actor) throw new Error('actor 必填（谁记的：主编/策划/档案员…）')
  const entries = await readTapeEntries(fs, dir)
  const entry = { ts: new Date().toISOString(), id: 't' + String(entries.length + 1).padStart(3, '0'), kind }
  if (args.ch != null) entry.ch = args.ch
  entry.what = what
  entry.why = why
  if (args.ref) entry.ref = String(args.ref)
  entry.actor = String(args.actor)
  if (kind === 'open_thread') {
    if (!Number.isInteger(args.closes) || args.closes < 1) throw new Error('open_thread 必填 closes（预期收线章号，正整数）')
    entry.closes = args.closes
  }
  if (args.closes_thread) {
    const target = entries.find((e) => e.id === args.closes_thread && e.kind === 'open_thread')
    if (!target) throw new Error('closes_thread 引用未知欠线 id：' + args.closes_thread + '（先 read 对账）')
    if (entries.some((e) => e.closes_thread === args.closes_thread)) throw new Error('欠线 ' + args.closes_thread + ' 已闭合过（append-only，勿重复闭线）')
    entry.closes_thread = String(args.closes_thread)
  }
  const r = await appendJsonlLine(fs, tapeFile(dir), JSON.stringify(entry))
  return { ok: true, id: entry.id, kind, mode: r.mode }
}

/** 有界窗口读：近 12 条非粘性全量 + open_thread/checkpoint 全量留窗（封顶 40）+ 更早计数 + 未闭欠线清单。 */
async function readTapeWindow(fs, dir) {
  const entries = await readTapeEntries(fs, dir)
  if (!entries.length) return { total: 0, window: [], counts: {}, open_threads: [], note: '事件带为空' }
  const closed = new Set(entries.filter((e) => e.closes_thread).map((e) => e.closes_thread))
  const stickyAll = entries.filter((e) => TAPE_STICKY_KINDS.has(e.kind) && !(e.kind === 'open_thread' && closed.has(e.id)))
  const sticky = stickyAll.slice(-TAPE_STICKY_CAP)
  const stickyIds = new Set(sticky.map((e) => e.id))
  const others = entries.filter((e) => !stickyIds.has(e.id))
  const windowTail = others.slice(-TAPE_WINDOW)
  const windowIds = new Set(windowTail.map((e) => e.id))
  const counts = {}
  for (const e of others) { counts[e.kind] = (counts[e.kind] || 0) + 1 }
  const window = entries.filter((e) => windowIds.has(e.id) || stickyIds.has(e.id)) // 保持带序
  const open_threads = entries.filter((e) => e.kind === 'open_thread' && !closed.has(e.id)).map((e) => ({ id: e.id, what: e.what, closes: e.closes }))
  const ret = { total: entries.length, window, counts, open_threads }
  const notes = []
  const older = others.length - windowTail.length
  if (older > 0) notes.push('更早 ' + older + ' 条 decision/revision/verdict 已计数化（open_thread/checkpoint 永不摘要）')
  if (stickyAll.length > TAPE_STICKY_CAP) notes.push('粘性条目 ' + stickyAll.length + ' 超安全阀 ' + TAPE_STICKY_CAP + '，仅留最近——欠线/checkpoint 积压过多，该收线/归档了')
  if (notes.length) ret.note = notes.join('；')
  return ret
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
        selection_report: { type: 'string', description: '可选：选题报告文件绝对路径（生产书必带=选题协议 gate——随 Owner ask 载荷呈审，M5）' },
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
      if (args.selection_report) {
        const project = await loadJson(fs, dir, 'project.json')
        project.selection_report = String(args.selection_report)
        await saveJson(fs, dir, 'project.json', project)
      }
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
          entry: { type: 'object', additionalProperties: true, description: 'write 时传入：{ title, goal, hook, word_min, word_max, scenes: [], differentiation?, anchor_params? }。卷首章必答 differentiation=与榜单头部哪里不一样（差异化槽位）。anchor_params（v6.5，P2 拆书参数落位）：{ hook_type, beat_pattern, rhythm_ref, word_window:[min,max] }——只存档不判，verify 对 word_window 出窗报 warn、卷首章缺失报 warn（书内启用锚参后才检查）' },
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
      // 半提交检测（E-2，2026-09-05 审查批）：正文已落但事件账无 chapter_commit=写入中断的半状态
      // （novel_chapter 写入序=正文先写、commit 事件最后，崩在中间则此项抓出——此前 verify 五项全盲）
      const committed = new Set()
      for (const l of await readEvents(fs, dir)) {
        try { const e = JSON.parse(l); if (e && e.op === 'chapter_commit' && Number.isInteger(e.ch)) committed.add(e.ch) } catch (e2) { /* readEvents 已把关 */ }
      }
      for (const n of chapters) {
        if (!committed.has(n)) issues.push('半提交嫌疑：第 ' + n + ' 章正文已落盘但事件账无 chapter_commit（写入中断？——对账后补记或同章重提交）')
      }
      // 事件带欠线逾期（v6.5）：open_thread 预期章已过且未闭（带不存在=未启用，静默跳过）
      const tapeLines = await readJsonlLines(fs, tapeFile(dir))
      if (tapeLines.length) {
        const tapeEntries = []
        for (const l of tapeLines) { try { tapeEntries.push(JSON.parse(l)) } catch (e) { /* 已把关 */ } }
        const closedIds = new Set(tapeEntries.filter((e) => e.closes_thread).map((e) => e.closes_thread))
        for (const e of tapeEntries) {
          if (e.kind === 'open_thread' && !closedIds.has(e.id) && Number.isInteger(e.closes) && e.closes < cur) {
            issues.push('事件带欠线逾期：' + e.id + '「' + e.what + '」预期 ' + e.closes + ' 章收线，当前 ' + cur + '（收线/闭线或改期）')
          }
        }
      }
      // 锚参核对（v6.5，P2 起生效）：书内出现过 anchor_params 才启用（存量书不误报）
      let anchorsAdopted = false
      for (const vol of outline.volumes || []) { for (const c of vol.chapters || []) { if (c.anchor_params) anchorsAdopted = true } }
      if (anchorsAdopted) {
        for (const vol of outline.volumes || []) {
          const chs = (vol.chapters || []).slice().sort((a, b) => a.chapter_no - b.chapter_no)
          if (chs.length && !chs[0].anchor_params) issues.push('卷 ' + vol.volume + ' 卷首章（' + chs[0].chapter_no + '）缺锚参 anchor_params（P2 拆书参数应随纲落位）')
          for (const c of chs) {
            const ww = c.anchor_params && c.anchor_params.word_window
            if (Array.isArray(ww) && ww.length === 2 && c.chapter_no > cur - 10 && chapters.includes(c.chapter_no)) {
              const t = await fs.readText(await fs.resolve(dir + '/manuscript/' + chapterFile(c.chapter_no)))
              const h = countHan(t)
              if (h < ww[0] || h > ww[1]) issues.push('锚书窗口偏离：第 ' + c.chapter_no + ' 章 ' + h + ' 汉字，锚参窗口 [' + ww[0] + ',' + ww[1] + ']（warn 级，业务参数不拦稿）')
            }
          }
        }
      }
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

  // 5.5 novel_count：只读字数核数。工具本身不设角色限制，但 preset deny 名单按角色收口
  // （2026-09-05 对齐实测：写手/策划/档案员可调；试读/校准/校对被 deny——盲角色不核字数，防非盲信号渗入）。
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

  // 6.5 novel_event：事件带（编排层记忆，0.4.0 新增——V3 P1）
  {
    name: 'novel_event',
    timeoutMs: 120000,
    description: '事件带（编辑部编排记忆，book_dir/editorial/events-tape.jsonl）：记"为什么这么干+判了什么+还欠什么"。与 events.jsonl 分工：账本事件=发生了什么（工具口径自动记）；事件带=决策理由/判词/修订/欠线/checkpoint（编辑部口径）。op=append 追加（what/why 各≤60 字，open_thread 必带 closes 预期章）；op=read 有界窗口（近 12 条全量＋open_thread/checkpoint 永不摘要＋更早计数＋未闭欠线清单）。注入规则：写手=主编任务书内注摘要段（工具面 deny）；试读员/校准员/校对员禁看（盲读红线）；策划/档案员可 read。主编压缩触发前记 checkpoint=抗压缩记忆，兼批级断点续跑锚。',
    parameters: bookDirParam({
      properties: {
        op: { type: 'string', enum: ['append', 'read'], description: 'append=追加一条；read=读有界窗口' },
        kind: { type: 'string', description: 'append 时必填：decision|verdict|revision|open_thread|checkpoint' },
        ch: { type: 'integer', description: 'append 时可选：关联章号' },
        what: { type: 'string', description: 'append 时必填：做了/判了什么（≤60 字）' },
        why: { type: 'string', description: 'append 时必填：为什么（≤60 字）' },
        ref: { type: 'string', description: 'append 时可选：关联工件（orders/board/报告路径或伏笔 id）' },
        actor: { type: 'string', description: 'append 时必填：记录者（主编/策划/档案员…）' },
        closes: { type: 'integer', description: 'kind=open_thread 必填：预期收线章号（正整数）' },
        closes_thread: { type: 'string', description: '可选：闭合某条欠线 id（verify 对账防重复闭线）' },
      },
      required: ['book_dir', 'op'],
    }),
    output: {
      schema: { type: 'object', properties: { ok: { type: 'boolean' }, id: { type: 'string' }, kind: { type: 'string' }, mode: { type: 'string' }, total: { type: 'integer' }, window: { type: 'array' }, counts: { type: 'object', additionalProperties: true }, open_threads: { type: 'array' }, note: { type: 'string' } }, additionalProperties: false },
      render: (a, v) => renderJson(v),
    },
    async execute(args, exec) {
      const fs = exec.agent.ctx && exec.agent.ctx.get ? exec.agent.ctx.get('fs') : undefined
      if (!fs) throw new Error('fs 服务不可用')
      const dir = bookRootOf(args)
      if (args.op === 'append') return appendTape(fs, dir, args)
      return readTapeWindow(fs, dir)
    },
  },

  // 6.6 novel_score：判据账（V3 P3·0.5.0 新增）——判官判词结构化落盘 scores.jsonl
  {
    name: 'novel_score',
    timeoutMs: 120000,
    description: '判据账：判官判词结构化落盘（book_dir/editorial/scores.jsonl）——仪器产出有家、回收环有数据底座。op=record 落一条：{ch, dim 维度, score 分, evidence 正文原句引文, judge 判官, mode}；**evidence 子串核验（硬闸）**：规范化标点/空白后必须命中该章 manuscript 正文，伪引文拒收（证据引用制从纪律升机器，审查批 F-2）。op=read 按 ch/dim 过滤回读。mode=absolute（绝对分 1-5）｜anchored_pair（锚书参照成对判：1=胜/0=平/-1=负）。写权=判官工位经主编转手或主编直录。z 不在工具算（instrument-aggregate 离线聚合出，防当拍脑袋）。',
    parameters: bookDirParam({
      properties: {
        op: { type: 'string', enum: ['record', 'read'], description: 'record=落一条判词；read=回读' },
        ch: { type: 'integer', description: '章号（record 必填）' },
        dim: { type: 'string', description: '维度（record 必填；词汇表见评分卡 v2，如 钩子/节奏/爽点/文笔/一致性/篇幅）' },
        score: { type: 'integer', description: 'record 必填：absolute 模式 1-5；anchored_pair 模式 -1/0/1' },
        evidence: { type: 'string', description: 'record 必填：正文原句引文（会被子串核验——不在该章正文里的引文拒收）' },
        judge: { type: 'string', description: 'record 必填：判官标识（试读员/校准员/主编…）' },
        mode: { type: 'string', enum: ['absolute', 'anchored_pair'], description: '缺省 absolute' },
        note: { type: 'string', description: 'record 可选：判词说明 ≤60 字' },
      },
      required: ['book_dir', 'op'],
    }),
    output: {
      schema: { type: 'object', properties: { ok: { type: 'boolean' }, id: { type: 'string' }, records: { type: 'array' }, total: { type: 'integer' }, rejected: { type: 'string' } }, additionalProperties: false },
      render: (a, v) => renderJson(v),
    },
    async execute(args, exec) {
      const fs = exec.agent.ctx && exec.agent.ctx.get ? exec.agent.ctx.get('fs') : undefined
      if (!fs) throw new Error('fs 服务不可用')
      const dir = bookRootOf(args)
      const scoreFile = dir + '/editorial/scores.jsonl'
      if (args.op === 'record') {
        if (!Number.isInteger(args.ch) || args.ch < 1) throw new Error('ch 必填（正整数）')
        if (!args.dim) throw new Error('dim 必填（维度）')
        if (!args.judge) throw new Error('judge 必填')
        const mode = args.mode || 'absolute'
        if (mode === 'absolute' && (!(args.score >= 1 && args.score <= 5))) throw new Error('absolute 模式 score 取 1-5')
        if (mode === 'anchored_pair' && ![-1, 0, 1].includes(args.score)) throw new Error('anchored_pair 模式 score 取 -1/0/1')
        const ev = String(args.evidence || '')
        if (!ev) throw new Error('evidence 必填（证据引用制：无引文判词无效）')
        // 子串核验（F-2 硬闸）：规范化后必须命中该章正文
        const STRIP_RE = /[\s，。、；：？！""''（）《》【】…—\-·~\u3000,.:;?!"'()<>[\]]/g
        const norm = (s) => s.replace(STRIP_RE, '')
        const nev = norm(ev)
        if (nev.length < 6) throw new Error('evidence 规范化后不足 6 字（引文过短无法核验）')
        const msTarget = await fs.resolve(dir + '/manuscript/' + chapterFile(args.ch))
        const st = await fs.stat(msTarget)
        if (!st) throw new Error('该章正文不存在：' + args.ch + '（先落稿再判分）')
        const body = norm(await fs.readText(msTarget))
        if (!body.includes(nev)) {
          return { ok: false, rejected: 'evidence 子串核验未命中该章正文（伪引文拒收——审查批 F-2 硬闸）：' + ev.slice(0, 30) + '…' }
        }
        const rec = { ts: new Date().toISOString(), ch: args.ch, dim: String(args.dim), score: args.score, evidence: ev, judge: String(args.judge), mode }
        if (args.note) rec.note = String(args.note).slice(0, 60)
        const r = await appendJsonlLine(fs, scoreFile, JSON.stringify(rec))
        return { ok: true, records: [rec], total: 1, id: 'append:' + r.mode }
      }
      // read
      const lines = await readJsonlLines(fs, scoreFile)
      let recs = lines.map((l) => { try { return JSON.parse(l) } catch (e) { return null } }).filter(Boolean)
      if (args.ch != null) recs = recs.filter((x) => x.ch === args.ch)
      if (args.dim) recs = recs.filter((x) => x.dim === args.dim)
      return { ok: true, records: recs, total: recs.length }
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
    'novelist-guide v6.5 · 机制细则唯一真源（novelist 插件同版注入；preset persona 只含决策原则与指针）。书工程 = book_dir（一部书一个目录；novel_* 工具一律显式传 book_dir 绝对路径）。身份与协作框架见 persona 段。v6 增量（2026-09-04）：冷读审法换三问量表、前情事实卡、盲角色派工纪律四条；v6.1：编辑部五角色→六角色（+结构校准员，one-shot 纯盲只见正文）；v6.2：P0 回改定稿前 A/B 冷读门、商业工位（书名简介/责编评分卡）；v6.3（修订轮）：校对员 one-shot+交付预算纪律（preset 侧）、编排熔断、写手落盘无题首行；v6.4（W-1 双臂实测后）：角色传输二分——策划/档案员=常驻同事（continuable 起+s2s session_id 唤醒），写手/试读/校准/校对=一次性前台 spawn（盲读与写入口安全不进同事线）；v6.5（V3 P1，2026-09-05）：事件带 novel_event（决策/判词/欠线/checkpoint 落带=编排层记忆与抗压缩记忆）＋仪器纪律预告（轻量门三查/检查点全量/证据引用制，细则随 P3 评分卡 v2）＋锚参字段与 selection_report gate＋版本戳三处对齐。',
    '工作流（每章）：novel_bible 查设定（写前必查，防吃书）＋novel_event read 有界窗口（续航：未闭欠线＋近期决策）→ 定章纲（novel_outline write，卷首章必答差异化槽位 differentiation）→ 正文（你直接产出文本）→ novel_chapter 落盘（参数携带正文；符号门只记账不判好坏）→ novel_event append 本章决策（kind=decision，why 必填）→ novel_verify 自检 → 章状态机流转（见下条）→ 试读员/校对员子代理审（编辑部协作）→ 意见进修订单回改（新版本）→ 处置落带（kind=verdict/revision）。',
    '章状态机（迁移唯一入口=你的 novel_ledger set_chapter_status，子代理不碰状态机）：草稿→已审（你收稿）→待试读（派试读员）→已试读（意见已回）→待修订（内审回改中）→已定稿→存稿→待外审→已发表；外审打回→打回修订。待修订=内审意见回改，打回修订=外审（平台）打回（note 记平台原因），两态勿混用。回改落盘=同章号重新 novel_chapter 提交（携修订后全文），旧版自动留快照绝不静默覆盖；回改后置已审，重走内审分级（主编裁定并注理由）：P0/语义级改动（情节/人设/伏笔/结构）→ 重新派试读员，**定稿前按 A-B 冷读协议（editorial/protocols/A-B冷读协议.md）双 Reader 交换顺序盲读新旧版**；纯文字级（校对 P2 批，裁定无情节影响）→ 只过校对免重试读。',
    '一章收束验收（全过才算写完）：①字数在章纲 word_min/word_max 区间（novel_count 工具口径）②novel_verify 无 P0，或 P0 已挂 board/issue-NNN ③seeds/closes/cast/timeline_events 已随章登记 ④试读/校对 P0 已回改或已挂修订单（P1/P2 可攒批）⑤状态已推进到正确闸口。P0 未清，章不许进已定稿/存稿。',
    '编辑部协作框架（趋同目标/非对抗/你汇总取舍呈 Owner）：唯一 home 在 persona 段（preset 注入），此处不重复；六角色派工见下条。',
    '事件带纪律（v6.5，novel_event）：落带三类必记——①每章决策 kind=decision（章纲/调度/取舍，why 必填）；②判词与回改处置 kind=verdict/revision（随状态流转）；③自设欠线 kind=open_thread（必带 closes 预期章，verify 追逾期；闭线用 closes_thread 对账防重复）。写手侧=任务书内注"事件带摘要段"（≤15 行，从 read 结果手拼——未闭欠线必含），工具面 deny 不直调；试读员/结构校准员/校对员禁看事件带（盲读红线：判官不许知道编辑部意图）；策划/档案员可 read。**主编压缩触发前：当轮推理摘要 kind=checkpoint 落带**——文件不被压缩吃掉=抗压缩记忆；兼批级断点续跑锚：续跑=查 status.json 最后已定稿章→read 带尾→重建调度位→从下一章 outline 起（0.1.2 无头收束丢子代理+断供中断皆有前科，长批必须可续）。',
    '仪器纪律（v6.5 预告，细则随 P3 评分卡 v2 落地）：每章轻量门三查（钩子在/承诺兑/事实对账——二元问题，与试读合并一次调用）；检查点章（卷首尾/大转折）全量评分卡；一切判词必须带正文原句引用+位置（无引用判词无效；P3 起落判据账 scores.jsonl 并做子串核验）。量表锚点只给判官工位，永不进写手任务书（Goodhart 面最小化——写手拿读者契约+结构参数，皆源自锚书而非量表）。',
    '派工分工（六角色）：写手=纯执笔成文（润色填充，不产结构）；试读员=每章冷读审（三问分级量表+落脚检查+复述核查；协议与量表格式=editorial/protocols/盲读协议.md；常规章两包投递保首读时序，风险章四~六包全协议；one-shot 每章新实例）；结构校准员=每章轻扫八类结构病（证据制：原句引文+病类+反误判检查+最小撤回范围+把握分级，证据不足不报，B 路阈值提高一档；one-shot 纯盲只见正文，弧审时全卷扫描）；校对员=发稿前文字审（错字/标点/人名地名一致性）；档案员=写前设定对账+周期一致性审计；策划=开书/卷级聊法与骨架。各审各的，不重复派工。',
    '前情事实卡（Q2，会话即抛·档案即记忆）：派写手/试读员前的连续性材料由你从账本拼装——本章应兑现伏笔 due 清单+既有钩子+出场人物卡摘要，全带章号坐标；模板=editorial/protocols/前情事实卡.md。连续性判断吃事实卡不吃会话记忆：任何角色的会话上下文都可丢弃后凭账本+事实卡恢复工作状态。',
    '盲角色派工纪律（Q6 四条，违者交付无效）：①中性命名——给盲角色（试读员/A-B Reader/结构校准员）的任务名只说"按档案提交读感记录"，禁带答案表述（如"检查逻辑跳跃/验证伏笔"）；②输入隔离——盲角色只收 读者档案+正文包（试读员另收前情事实卡；校准员只见正文），无大纲/无写作意图/无旧稿/无检测信息/无预期答案，包内出现即原样退回并报"输入污染"；③诚实降级——开不出新实例只能标"自审降级"留痕，不得冒充盲读完成；④Owner 反馈撤销制——Owner 说"看不懂/不好看"=立即撤销对应通过并回改，冷读漏检不得反驳 Owner。',
    '修订单与事项板（editorial/ 工作区，per-role 独立文件免锁）：章/块内具体意见进修订单（orders/block-XXX/：试读员-意见/档案员-审计/校对-批注/主编-汇总），条目结论式≤3行+证据坐标+P0/P1/P2；跨章规则与重复模式进事项板（board/issue-NNN，append-only，状态机：待处理→编辑部立场→待Owner→已裁决/已驳回）。已发表后修订批处理：攒批一次改完一次重审（平台每次改动触发重审）。',
    '商业工位（M2/M3）：novel_outline 定稿后策划交书名候选×5+简介×2（协议=editorial/protocols/书名简介工位.md；主编合并后呈 Owner 三选一/二选一，书名=点开率生死线不自主决定）；存稿≥10 章起主编按 editorial/protocols/责编评分卡-番茄.md 自评（五维带证据坐标，<17 分不送外审，≥20 分才呈送）。',
    '弧级审查：每 5-10 章一次（锚定事件块边界，每卷至少 1 次）。异常触发分两期：未发表期（写作长跑）=试读连续 2 章 P0 / 修订单未处理积压>5 条（含弧审订单）；已发表期追加=外审打回率>30%（一个事件块内）。默认锚 Owner 可调、bible 可覆盖。三问=弧线在轨还是漂移、伏笔收支、差异化是否真落地；全部带证据坐标禁"我觉得"；产出 reports/弧审-卷X-弧Y.md；写手不列席，意见经修订单回流（跨块弧审意见落 orders/arc-卷X-弧Y/ 并计入积压锚，章内意见仍走 block-XXX）。',
    '纪律：正文/台账唯一写入口 = 工具，绝不绕过工具直改文件（账本唯一写入口）；语义判定（好坏/取舍）归模型与编辑部，代码只做壳；重大变更（开书 novel_init/汇编 novel_assemble）走 Owner ask 卡，你不自批。editorial 工作区（修订单 orders/、事项板 board/、弧审报告 reports/）与 .drafts 交付件 = 编辑/子代理的工作产物，允许 write/edit 直写（单写者免锁）；"唯一写入口=工具"特指小说数据账本（bible/characters/foreshadows/timeline/outline/manuscript/versions/status/事件账）。',
    '多轮写作纪律（试产实弹教训 2026-09-01）：写手续写/扩写前必须重读受影响正文全文与相关台账——新插入的设定、观察、细节先与既有正文对账再落笔（分段扩写不回读=同章吃书 P0 的主产地）；bible 词条随情节演进及时改口径；修订注记等元信息绝不写入正文（只存在于版本快照与修订单）。',
    '子代理编排纪律（2026-09 多轮实弹实测修订）：①派工后必须拿到交付或失败结论才许收束回合——0.1.2 起（截至 DSH 0.1.2 实测；升级后以当版实测为准，勿凭本句假设）job_output **不追踪子代理**（实测 unknown job），依赖结果的派工一律前台 spawn（run_in_background:false）同步拿全文；后台 continuable 子代理 settle 时运行时会自动向父代理发通知（含结果与最终消息），等通知期间禁收束回合。禁止"我会等待"然后停笔（headless 下一收束=运行结束，子代理变孤儿，实测一次全丢）。同一子代理同任务**连续 2 次零交付/失败即熔断**：改由主编终校替代，修订单留痕"自审降级+原因"，事后挂事项板复盘——角色故障不许拖死主链（F7：2026-09-04 实测 8.5min 空等教训）。**角色传输二分（v6.4，W-1 双臂实测裁定）**：策划/档案员走同事线——后台 continuable spawn 起常驻、记 agent_id、经 s2s_message(session_id) 派活唤醒（W-1 实测 4/4 回信零降级，档案员对账质量优于一次性 spawn）；同事线故障或 2 分钟无回信即降级一次性前台 spawn（留痕），不许挂死主链。写手/试读员/结构校准员/校对员**永远一次性前台 spawn**（盲读输入隔离与账本写入口安全不进同事线）。同事会话上下文只当缓存：真相永远在账本，任何同事可丢弃后凭账本+事实卡重建。②写手交付必须落盘成文件（.drafts/ 或临时件），交付即用 novel_count 核数（工具口径），自报字数只作参考（历史虚高 37%-63%；2026-09-03 验壳实测 v4-flash 自估 960 vs 实测 969 偏差约 1%，但仍以工具口径为准）；正文文件**首行不写章标题**（对齐 manuscript 无题首行惯例，novel_count 文件口径=入稿口径，免标题字数换算，F5）。③单回复写作上限约 1 万汉字（实测 10506）：章纲 word_min>10000 的章走分段写作协议——每段一交付一落盘一核数，主编拼装后一次 novel_chapter 提交。',
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
          let reason = ASK_REASONS[exec.name] || ASK_FALLBACK
          if (exec.name === 'novel_init' && exec.args && exec.args.selection_report) {
            reason += '；选题报告（M5 gate）=' + exec.args.selection_report
          }
          return { kind: 'ask', reason }
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

const _internals = { countHan, symbolGate, chapterFile, chapterTitle, CHAPTER_STATES, CHAPTER_TRANSITIONS, TOOLS, loadJson, appendJsonlLine, readJsonlLines, appendTape, readTapeWindow, TAPE_KINDS }

export { name, apply, inject, _internals }
