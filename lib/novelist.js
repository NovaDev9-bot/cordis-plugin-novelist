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
import { createHash } from 'node:crypto'
import { existsSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
// 书目录访问层（别名归一 / @last 记忆 / 写门）单独成文件，见 lib/book-access.mjs 头注；
// ERR/fail 也随之移入该文件（同一对象，_internals.ERR 身份不变）。
import {
  ERR, fail, bookRootOf, resetLastBook,
  LOCK_DEFAULTS, enqueueBook, acquireFileLock, withWriteGate,
} from './book-access.mjs'

const name = 'novelist'
const inject = ['tools', 'systemPrompt']

/** 正文哈希（sha256 hex，utf8）：回执绑定与同参重试判等的唯一口径（全量不截断，截断放大碰撞面）。 */
function sha256Hex(text) {
  return createHash('sha256').update(String(text), 'utf8').digest('hex')
}

/**
 * 机制沿革文件的本机绝对路径（随包发布，与本文件同目录）。
 * 为什么不用相对写法"lib/guide-history.md"：那句话对模型不可解——它不知道插件装在哪儿，
 * "按需查阅"就成了空指针（可发现性验收要的是模型真能读到）。插件按 file:/// 装载，
 * import.meta.url 在 DSH 与 MCP 两种形态下都指向本文件，故此处能算出真实可读路径。
 */
const GUIDE_HISTORY_PATH = (() => {
  try { return fileURLToPath(new URL('./guide-history.md', import.meta.url)) } catch (e) { return 'guide-history.md（与本插件同目录）' }
})()

/**
 * 作家档案卡（个体参照卡）目录的**绝对路径**。
 *
 * 为什么必须是绝对路径：主笔的 glob/grep 被 deny（宿主权限按工具名不按路径，放开＝放开整块硬盘），
 * 它只能按精确路径 read。给相对路径或只给目录名＝等于没给。台账里已有同族事故记录
 * （guide 沿革指针写成相对路径，模型解不出＝空指针）。
 * 路径按插件自身位置算，故 DSH 与 MCP 两种形态下都成立；目录不存在时如实降级为提示串，
 * 不编一个看起来像路径的假值。
 */
const CRAFT_CARDS_PATH = (() => {
  try {
    const p = fileURLToPath(new URL('../craft/author-cards/', import.meta.url))
    return existsSync(p) ? p : 'craft/author-cards/（本插件安装目录下没有 craft/ —— 该目录缺失或被移动；包内含 craft/，若确实没有可从仓库安装，或向主编要卡内容）'
  } catch (e) { return 'craft/author-cards/（本插件安装目录下没有 craft/ —— 该目录缺失或被移动；包内含 craft/，若确实没有可从仓库安装，或向主编要卡内容）' }
})()

/** 文体词库（L1 硬规则 / L2 密度观测 / L3 正向锚）的绝对路径，同上理由：主笔只能按精确路径 read。 */
const LEXICON_PATH = (() => {
  try {
    const p = fileURLToPath(new URL('../instruments/style-lexicon.json', import.meta.url))
    return existsSync(p) ? p : 'instruments/style-lexicon.json（与本插件同目录）'
  } catch (e) { return 'instruments/style-lexicon.json（与本插件同目录）' }
})()

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
  description: '书目录绝对路径（含 book_id，如 /path/to/your-project/books/my-book）。同一进程内连续操作同一本书时，可传 "@last" 复用上次成功使用的书目录（省去重复长路径；首次必须给绝对路径）。',
}

/**
 * 统一参数骨架：book_dir 必填 + 各工具自有参数。
 * 注意：这里必须**合并 properties/required**，不能用 Object.assign 平铺——
 * 平铺会让 extra.properties 整体替换掉 { book_dir }，导致 book_dir 只出现在 required 里、
 * 不在 properties 里：对外 inputSchema 少一个参数（模型/严格客户端看不见 book_dir 及其说明）。
 */
function bookDirParam(extra) {
  const base = { type: 'object', properties: { book_dir: BOOK_DIR }, required: ['book_dir'], additionalProperties: false }
  if (!extra) return base
  return Object.assign({}, base, extra, {
    properties: Object.assign({}, base.properties, extra.properties),
    required: [...new Set([...base.required, ...(extra.required || [])])],
  })
}

function textBlock(text) {
  return [{ type: 'text', text }]
}

function renderJson(value) {
  return textBlock(JSON.stringify(value, null, 2))
}

// ---------------------------------------------------------------- 账本 IO（fs 服务）

/** fs 服务无 mkdir，但 writeText 自动建父目录（dsh-fs-local:464，三核验 §10.1 实测）。 */
// 错误码表 ERR / fail() 见 lib/book-access.mjs（写门要发 E_LOCK_TIMEOUT，两处共用一个真源）。

// ---------------------------------------------------------------- 账本 schema 版本
/** 当前账本 schema 版本。写入时盖戳，读取时按戳逐级迁移。缺戳＝版本 0（本机制上线前的文件）。 */
const SCHEMA_VERSION = 1

/**
 * 逐级迁移函数表：文件 → { 目标版本: (上一版) => 本版 }。
 * v0→v1 的实际内容＝补盖戳（结构未变）；这张表的意义不是"现在要转什么"，而是：
 * ①后续结构变更必须在这里留一个显式落点，不能靠读取路径的 undefined 分支隐式兼容；
 * ②读到**未来版本**变成显式拒读（静默误读旧字段比报错贵得多）。
 * 未登记的文件（facts 贡献账等）不盖戳、不迁移——它们各自带 ch/rev，不走全局版本。
 */
const LEDGER_MIGRATIONS = {
  'project.json': { 1: (x) => x },
  'bible.json': { 1: (x) => x },
  'characters.json': { 1: (x) => x },
  'foreshadows.json': { 1: (x) => x },
  'timeline.json': { 1: (x) => x },
  'outline.json': { 1: (x) => x },
}

/**
 * 书目录内的相对路径唯一真源。
 *
 * 为什么需要它：这些字面量此前散在 39 处 `dir + '/...'` 拼接里。改一次目录名要一次改对 39 处，
 * 漏一处不报错、只是那个功能静默坏掉——与"两处同名文件各自演进"是同一类缺陷。
 * 现在路径只在这里出现一次，引用一律走 pth()。
 *
 * 边界：manuscript/ 与 versions/ 下的**文件名**（chapter_XXX.md 等）由 chapterFile() 负责，
 * 不重复登记——但目录段必须从这里取。
 */
const LEDGER_PATHS = {
  project: 'project.json',
  bible: 'bible.json',
  characters: 'characters.json',
  foreshadows: 'foreshadows.json',
  timeline: 'timeline.json',
  outline: 'outline.json',
  status: 'status.json',
  events: 'events.jsonl',
  manuscript: 'manuscript',
  versions: 'versions',
  fulltext: '全本.md',
  txn: 'editorial/txn',
  facts: 'editorial/facts',
  scores: 'editorial/scores.jsonl',
  arcs: 'editorial/arcs.jsonl',
  tape: 'editorial/events-tape.jsonl',
}
function pth(dir, key) {
  const seg = LEDGER_PATHS[key]
  if (!seg) throw fail(ERR.BAD_ARG, '未知账本路径键：' + key, '用 LEDGER_PATHS 里登记过的键；新路径先登记再引用')
  return dir + '/' + seg
}

/**
 * 各章**当前正文版本号**（读 editorial/txn/ 的 done 回执）。
 * 用途＝时间线的版本投影：改稿后只认当前 rev 产出的叙述，旧叙述留档不进账。
 * 无回执的章（旧书/未落稿）返回 undefined → 调用方按"全部保留"处理（不误伤存量）。
 */
async function currentRevsOf(fs, dir) {
  const revs = new Map()
  let files = []
  try { files = await fs.listDir(await fs.resolve(pth(dir, 'txn'))) } catch (e) { return revs }
  for (const f of files || []) {
    const m = f.name.match(/^chapter_(\d+)\.json$/)
    if (!m) continue
    const rc = await loadJson(fs, pth(dir, 'txn'), f.name)
    if (rc && rc.status === 'done' && Number.isInteger(rc.rev)) revs.set(Number(m[1]), rc.rev)
  }
  return revs
}

/**
 * 时间线有效投影：保留 ①无 rev 的旧事件（legacy，不误伤存量）②该章的**最新一次声明**。
 * 无回执的章一律全留——**宁可多给不可少给**：漏报事实比多报更危险（读者/判官会当它不存在）。
 *
 * 〔2026-09-18 P0 修复〕口径从"必须精确等于当前 rev"改成"取 ≤ 当前 rev 的最新一次声明"。
 * 旧口径在改稿时静默丢事实：重交同章（rev 2）时若没带 timeline_events（回改只携正文的最常见形态），
 * 或带的与上一版逐字相同（判重不追加），账上那条就停在 rev 1，而投影要求 rev===2——于是该章时间线
 * 从 novel_ask / novel_bible / factsheet **全部读取路径消失，磁盘上却还在，零报错**。
 * 与 facts 层的稀疏声明（省略≠删除）对齐后：省略＝沿用上一次声明，改了内容＝新声明覆盖旧的。
 */
function projectTimeline(events, revs) {
  const list = events || []
  const newestAll = new Map()   // ch → 账上最高 rev
  const newestLe = new Map()    // ch → ≤ 当前 rev 的最高 rev
  for (const e of list) {
    if (e.ch == null || e.rev == null) continue
    if (newestAll.get(e.ch) == null || e.rev > newestAll.get(e.ch)) newestAll.set(e.ch, e.rev)
    const cur = revs.get(e.ch)
    if (cur != null && e.rev <= cur && (newestLe.get(e.ch) == null || e.rev > newestLe.get(e.ch))) newestLe.set(e.ch, e.rev)
  }
  return list.filter((e) => {
    if (e.rev == null) return true
    const cur = revs.get(e.ch)
    if (cur == null) return true
    // 正常取"≤ 当前 rev 的最新声明"；账上全比当前 rev 还新（异常路径）时保守全留
    const want = newestLe.has(e.ch) ? newestLe.get(e.ch) : newestAll.get(e.ch)
    return e.rev === want
  })
}

/** 迁移一个账本对象。返回 {value, migrated, from}；未来版本与缺迁移函数一律抛错。 */
function migrateLedger(fileName, value) {
  // 未登记的文件（txn 回执／facts 贡献账等）不参与全局版本：它们各有自己的版本口径（ch/rev/hash）。
  const table = LEDGER_MIGRATIONS[fileName]
  if (!table) return { value, migrated: false, from: SCHEMA_VERSION }
  if (!value || typeof value !== 'object' || Array.isArray(value)) return { value, migrated: false, from: SCHEMA_VERSION }
  const from = Number.isInteger(value.schema_version) ? value.schema_version : 0
  if (from > SCHEMA_VERSION) {
    throw fail(ERR.SCHEMA_FUTURE, '账本 ' + fileName + ' 的 schema_version=' + from + ' 高于本插件支持的 ' + SCHEMA_VERSION + '（这份账本是更新版工具写的）', '升级 novelist 插件后再打开这本书；不要用旧版工具继续写')
  }
  if (from === SCHEMA_VERSION) return { value, migrated: false, from }
  let cur = value
  for (let v = from + 1; v <= SCHEMA_VERSION; v++) {
    const step = table[v]
    if (typeof step !== 'function') {
      throw fail(ERR.MIGRATION_MISSING, '账本 ' + fileName + ' 缺 v' + (v - 1) + '→v' + v + ' 迁移函数（拒绝猜旧结构）', '在 lib/novelist.js 的 LEDGER_MIGRATIONS 补上该步；不要手工改账本文件')
    }
    cur = step(cur)
  }
  return { value: Object.assign({}, cur, { schema_version: SCHEMA_VERSION }), migrated: true, from }
}

async function loadJson(fs, dir, fileName) {
  const target = await fs.resolve(dir + '/' + fileName)
  const st = await fs.stat(target)
  if (!st) return null
  const raw = await fs.readText(target)
  // 损坏 ≠ 缺失：JSON 解析失败必须大声报错——静默当空账本返回会导致上层重建账本、数据丢失
  let parsed
  try { parsed = JSON.parse(raw) } catch (e) {
    throw fail(ERR.LEDGER_CORRUPT, '账本文件损坏（JSON 解析失败）：' + target + '：' + (e && e.message), '先修好该文件再继续；工具拒绝把它当空账本重建')
  }
  return migrateLedger(fileName, parsed).value
}

async function saveJson(fs, dir, fileName, value) {
  const target = await fs.resolve(dir + '/' + fileName)
  // 登记在迁移表里的账本文件一律盖当前版本戳（写一次即完成迁移，不留"读时迁移、写时不戳"的漂移）
  const out = (LEDGER_MIGRATIONS[fileName] && value && typeof value === 'object' && !Array.isArray(value))
    ? Object.assign({}, value, { schema_version: SCHEMA_VERSION })
    : value
  await fs.writeText(target, JSON.stringify(out, null, 2))
  return target
}

/**
 * 追加一行 JSONL（真追加；E-1）：优先 processPath 桥接 OS 追加原语
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
  return (await appendJsonlLine(fs, pth(dir, 'events'), line)).target
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
      throw fail(ERR.LEDGER_CORRUPT, 'JSONL 中段损坏（非末行解析失败，拒静默跳过）：' + file + ' 第 ' + (i + 1) + ' 行', '修好该行后重跑；工具不会跳过中段坏行继续（那等于篡改账目顺序）')
    }
  }
  return lines
}

/** 读全部事件（JSON 行数组），供裁决生效时回查冲突记录。 */
async function readEvents(fs, dir) {
  return readJsonlLines(fs, pth(dir, 'events'))
}

// ---------------------------------------------------------------- 写门（并发互斥）

// 写门（进程内队列 enqueueBook + 跨进程文件锁 acquireFileLock + 工具包装 withWriteGate）
// 见 lib/book-access.mjs——与 book_dir 别名归一、@last 记忆共用同一个"书目录身份"。

// ---------------------------------------------------------------- 事实贡献账（facts-ledger 事实贡献账）

/** 稀疏贡献投影：每个字段沿用最近一次显式声明，[] 才是删除；不回写历史文件。 */
async function readFactDeclarations(fs, dir) {
  let entries = []
  try { entries = await fs.listDir(await fs.resolve(pth(dir, 'facts'))) } catch (e) { /* 旧书 */ }
  const records = []
  for (const e of entries || []) {
    if (!/^chapter_\d+\.v\d+\.json$/.test(e.name)) continue
    const rec = await loadJson(fs, pth(dir, 'facts'), e.name)
    if (rec) records.push(rec)
  }
  records.sort((a, b) => a.ch - b.ch || a.rev - b.rev)
  const chapters = new Map()
  const knownCast = new Set()
  for (const rec of records) {
    const current = chapters.get(rec.ch) || {}
    for (const key of ['cast', 'seeds', 'closes', 'timeline']) {
      if (Object.hasOwn(rec, key)) current[key] = rec[key]
    }
    for (const nm of rec.cast || []) knownCast.add(nm)
    chapters.set(rec.ch, current)
  }
  return { chapters, knownCast }
}

/** 只记录调用者实际声明的字段，正文回滚不隐式恢复旧版事实。 */
function factDeclaration(args) {
  const rec = {}
  if (Object.hasOwn(args, 'seeds')) rec.seeds = args.seeds.map((s) => ({ id: s.id, name: s.name, due_ch: s.due_ch == null ? null : s.due_ch }))
  if (Object.hasOwn(args, 'closes')) rec.closes = args.closes.map(String)
  if (Object.hasOwn(args, 'timeline_events')) rec.timeline = args.timeline_events.map((e) => ({ time: e.time == null ? null : e.time, what: e.what == null ? null : e.what }))
  if (args.cast !== undefined) rec.cast = args.cast.map(String)
  return rec
}

/** 单章单版事实贡献账文件名（与 versions/ 同版本号口径）。 */
function factsFileOf(ch, rev) {
  return 'chapter_' + String(ch).padStart(3, '0') + '.v' + rev + '.json'
}

/**
 * 读有效事实投影：每章取最高 rev（改稿只增新贡献文件，旧版留档不参与投影）。
 * 返回 { effective: Map<ch, {rev, file}>, fromCh }；无贡献账（纯旧书）= 空投影。
 */
async function readEffectiveFacts(fs, dir) {
  let entries = []
  try { entries = await fs.listDir(await fs.resolve(pth(dir, 'facts'))) } catch (e) { /* 尚未启用 */ }
  const pattern = /^chapter_(\d+)\.v(\d+)\.json$/
  const effective = new Map()
  for (const e of (entries || [])) {
    const m = e.name.match(pattern)
    if (!m) continue
    const ch = Number(m[1]); const rev = Number(m[2])
    const cur = effective.get(ch)
    if (!cur || rev > cur.rev) effective.set(ch, { rev, file: e.name })
  }
  const fromCh = effective.size ? Math.min(...effective.keys()) : null
  return { effective, fromCh }
}

/**
 * last_seen 按有效出场重建——**修订删人物后必须能回退**：旧实现只在提交时
 * `last_seen_ch = ch`（单调 max 补丁），早章回改删掉某角色的出场后，账上仍留着他"最后出场"，
 * 一致性与前情事实卡都会带错人。
 * 口径：以有效贡献账（每章最高 rev）重算每人最近出场章；**只覆盖有贡献账记录的人物**——
 * 纯旧书章节（无贡献账）的人物一律不动（防误回退历史书）；贡献账覆盖期起点之前的
 * 既有 last_seen（legacy 部分）按原值参与取大。
 *
 * 真实回滚语义：**省略 ≠ 清空，显式空数组才表示删除**。
 * last_seen 不再逐版直读 cast（那是"最后写的赢"，把"省略"误当"清空"）——改按
 * readFactDeclarations 的稀疏投影：每章出场 = 该章最近一次**显式声明**（`cast` 键存在）；
 * 显式 `cast: []` 才把该章出场真正删掉；没声明过 cast 的章节不参与投影。
 * 恢复旧正文（rollback）不隐式恢复旧版事实：回滚产生的 rev 不带 cast = 无声明 = 账面不变。
 */
async function rebuildLastSeen(fs, dir) {
  const { effective, fromCh } = await readEffectiveFacts(fs, dir)
  if (!effective.size) return { changed: [], skipped: 'no-facts' }
  const { chapters, knownCast } = await readFactDeclarations(fs, dir)
  const seen = new Map()
  for (const [ch, rec] of chapters) {
    for (const nm of rec.cast || []) { if (ch > (seen.get(nm) || 0)) seen.set(nm, ch) }
  }
  const cj = await loadJson(fs, dir, 'characters.json')
  if (!cj || !cj.characters) return { changed: [], skipped: 'no-characters' }
  const changed = []
  for (const c of cj.characters) {
    if (!knownCast.has(c.name)) continue
    const legacyPart = (Number.isInteger(c.last_seen_ch) && c.last_seen_ch < fromCh) ? c.last_seen_ch : 0
    const next = Math.max(seen.get(c.name) || 0, legacyPart) || null
    if (c.last_seen_ch !== next) { changed.push(c.name + ':' + (c.last_seen_ch == null ? '无' : c.last_seen_ch) + '→' + (next == null ? '无' : next)); c.last_seen_ch = next }
  }
  if (changed.length) await saveJson(fs, dir, 'characters.json', cj)
  return { changed, skipped: null }
}

// ---------------------------------------------------------------- 事件带（events-tape，0.4.0 新增）

/**
 * 事件带 kind：decision=决策 / verdict=判词 / revision=修订 / open_thread=欠线 /
 * hook=章末钩子/ checkpoint=抗压缩检查点。
 *
 * hook 为什么并进事件带而不是另立 hooks.json（Owner 拍板）：钩子与欠线是同一根因果链
 * 上的两端——欠线=对读者许下的长程承诺，钩子=把读者拽进下一章的短程拉力，两者的
 * 生命周期（埋下→兑现→对账）一模一样。另建文件＝同一件事有两个写入口、两条清理路径、
 * 两份会漂移的账；并进事件带则白拿现成的 append-only、supersedes 作废投影、closes_thread
 * 闭线对账与有界窗口读。hook 不进粘性类：每章一条，190 章就是 190 条粘性条目，
 * 会直接顶爆 TAPE_STICKY_CAP 并让"欠线积压"的告警失去意义——未闭钩子另有 open_hooks 专列。
 */
const TAPE_KINDS = ['decision', 'verdict', 'revision', 'open_thread', 'hook', 'payoff', 'checkpoint']
/** 粘性类：欠线与检查点永不摘要、始终全量留窗；安全阀上限防带子失控。 */
const TAPE_STICKY_KINDS = new Set(['open_thread', 'checkpoint'])
/**
 * 静默类：hook/payoff 每章各一条，不占窗口位、只计数。
 *
 * 为什么必须分出来：窗口是"最近发生了什么"的滚动画框（默认 12 条）。190 章的书带 380+ 条
 * hook/payoff，且都排在同章的 decision 之后——窗口会被它们整块占满，decision/verdict 全被
 * 挤出画框，事件带最该看的那部分反而看不见了。这两类的高频不代表高信息：真正要看的
 * 是"还欠哪些钩子"，由 open_hooks 完整列出（不受窗口与上限裁剪）。
 */
const TAPE_QUIET_KINDS = new Set(['hook', 'payoff'])
/** 可闭类：closes_thread 能闭合的条目（欠线＋章末钩子共用闭线对账，防重复闭线）。 */
const TAPE_CLOSABLE_KINDS = new Set(['open_thread', 'hook'])
const TAPE_WINDOW = 12
const TAPE_STICKY_CAP = 40
/**
 * 钩子超期阈值（章）：钩子埋下后当前章推进超过这么多章仍未记录兑现，verify 报一条。
 * 取 8 的理由：读者档案的钩子半衰期是 1-3 章（章末钩子多为"下一章就答"），8 章≈2.4-3.2 万汉字，
 * 到这时读者早忘了当初被什么拽住——这时它已经不是一个钩子，是一条忘了收的线。
 * 这是告警阈值不是硬闸：长线钩子（卷级反转的引信）由主编在 novel_ledger update_foreshadow
 * 里转记伏笔（伏笔有 due_ch 与逾期对账），钩子账只该装短程拉力。
 */
// 机制手册版本戳：**唯一一处**定义，头部文案引用它。
// 此前头部硬编码旧版号而正文已到两版之后——下游智能体据此自报版本，报到的是过时口径。
// versions.test 断言它与正文里出现的最高版一致（口径漂移必须由断言抓，不靠人记得改）。
const GUIDE_VERSION = 'v7.13'
const HOOK_STALE_CHAPTERS = 8
/** 钩子覆盖告警的检视窗（章）：只查最近这么多章有没有漏记钩子，防旧书全量刷屏。 */
const HOOK_COVERAGE_WINDOW = 10
/** 卷尾结算的提醒宽限（章）：卷收束后仍报结算清单的章数（6 章≈一个批次），过了就静默。 */
const VOLUME_SETTLE_GRACE = 6

function tapeFile(dir) { return pth(dir, 'tape') }

async function readTapeEntries(fs, dir) {
  const lines = await readJsonlLines(fs, tapeFile(dir))
  const entries = []
  for (const l of lines) { try { entries.push(JSON.parse(l)) } catch (e) { /* readJsonlLines 已把关 */ } }
  return entries
}

async function appendTape(fs, dir, args) {
  const kind = args.kind
  if (!TAPE_KINDS.includes(kind)) throw fail(ERR.BAD_ARG, 'kind 必须为：' + TAPE_KINDS.join('/') + '（got ' + kind + '）')
  const what = String(args.what || '')
  const why = String(args.why || '')
  if (!what) throw fail(ERR.BAD_ARG, 'what 必填（≤60 字：做了/判了什么）')
  if (!why) throw fail(ERR.BAD_ARG, 'why 必填（≤60 字：为什么）')
  if (what.length > 60) throw fail(ERR.BAD_ARG, 'what 超 60 字（当前 ' + what.length + '）', '防膨胀纪律：蒸馏后再记')
  if (why.length > 60) throw fail(ERR.BAD_ARG, 'why 超 60 字（当前 ' + why.length + '）', '防膨胀纪律：蒸馏后再记')
  if (!args.actor) throw fail(ERR.BAD_ARG, 'actor 必填（谁记的：主编/主笔/档案员…）')
  const entries = await readTapeEntries(fs, dir)
  // id 单调递增取现存最大尾号+1（防 append-only 被人为清理历史行后 length+1 重号；撕裂残行不可解析不参与计算）
  const maxSeq = entries.reduce((m, e) => { const n = Number(String(e.id || '').replace(/^t/, '')); return Number.isInteger(n) && n > m ? n : m }, 0)
  const entry = { ts: new Date().toISOString(), id: 't' + String(maxSeq + 1).padStart(3, '0'), kind }
  if (args.ch != null) entry.ch = args.ch
  entry.what = what
  entry.why = why
  if (args.ref) entry.ref = String(args.ref)
  if (args.supersedes) {
    // 防线在本体：novel_decide 已校验，此处纵深防御——直走 novel_event 的
    // 调用方带 supersedes 时同样拦未知 id 与重复作废，防绕道写脏撤销链
    const target = entries.find((e) => e.id === String(args.supersedes))
    if (!target) throw fail(ERR.NOT_FOUND, 'supersedes 引用未知事件带条目：' + args.supersedes, '先 novel_event op=read 对账')
    if (entries.some((e) => e.supersedes === target.id)) throw fail(ERR.CONFLICT, '条目 ' + target.id + ' 已被作废过', 'append-only：勿重复撤销，如需再改请用新条目覆盖语义')
    entry.supersedes = String(args.supersedes)
  }
  entry.actor = String(args.actor)
  if (kind === 'open_thread') {
    if (!Number.isInteger(args.closes) || args.closes < 1) throw fail(ERR.BAD_ARG, 'open_thread 必填 closes（预期收线章号，正整数）')
    entry.closes = args.closes
  }
  if (kind === 'hook' && args.closes != null) {
    // 有明确兑现期限的线＝欠线不是钩子。让它走 open_thread，才拿得到逾期对账（verify 追 due）。
    throw fail(ERR.BAD_ARG, 'hook 不接受 closes（钩子=章末短程拉力，无期限概念）', '有明确兑现章的长线请用 kind=open_thread')
  }
  // 〔2026-09-18 审计修复〕payoff 的描述写着"须带 closes_thread"，实现却不校验：
  // 不带也能落一条"兑现"，实际什么都没闭合——账上多一条，open_hooks 仍挂着，verify 继续报超期。
  // 重复闭线有拦、漏闭线无拦，兑现率统计只会单向偏乐观。这里把描述兑现成校验。
  if (kind === 'payoff' && !args.closes_thread) {
    throw fail(ERR.BAD_ARG, 'payoff 必填 closes_thread（兑现哪条钩子/欠线；闭线对账靠它）',
      '先 novel_event op=read 看 open_threads/open_hooks 拿 id；payoff 是"闭线载体"，必须指名闭的是哪条')
  }
  if (args.closes_thread) {
    const target = entries.find((e) => e.id === args.closes_thread && TAPE_CLOSABLE_KINDS.has(e.kind))
    if (!target) throw fail(ERR.NOT_FOUND, 'closes_thread 引用未知欠线/钩子 id：' + args.closes_thread, '先 novel_event op=read 对账')
    if (entries.some((e) => e.closes_thread === args.closes_thread)) throw fail(ERR.CONFLICT, '欠线/钩子 ' + args.closes_thread + ' 已闭合过', 'append-only：勿重复闭线')
    entry.closes_thread = String(args.closes_thread)
  }
  const r = await appendJsonlLine(fs, tapeFile(dir), JSON.stringify(entry))
  return { ok: true, id: entry.id, kind, mode: r.mode }
}

/**
 * 幂等追加：同 kind + 同 ch + 逐字同 what 且未被作废的条目已在带 =
 * 这是重试/断点续跑，不重复入账。
 *
 * 为什么必须内容判等而不是"本次调用是否 deduped"：novel_chapter 的账务步骤里，事件带是最后
 * 落的那一步。崩在"正文已写、带未落"之间时，重交的正文逐字相同（deduped=true），但带里
 * 确实什么都没有——此时跳过就永久丢失这条钩子/决策，不跳过则双份。只有回读带子对内容，
 * 才能两种情况都判对。（此前 decision 是无条件追加：重试即重复记一条决策。）
 */
async function appendTapeOnce(fs, dir, args) {
  const entries = await readTapeEntries(fs, dir)
  const revoked = new Set(entries.filter((e) => e.supersedes).map((e) => e.supersedes))
  const dup = entries.find((e) => !revoked.has(e.id) && e.kind === args.kind && (e.ch ?? null) === (args.ch ?? null) && String(e.what) === String(args.what))
  if (dup) return { ok: true, id: dup.id, kind: args.kind, mode: 'deduped' }
  const r = await appendTape(fs, dir, args)
  return { ok: true, id: r.id, kind: r.kind, mode: r.mode }
}

/** 有界窗口读：近 12 条非粘性全量 + open_thread/checkpoint 全量留窗（封顶 40）+ 更早计数 + 未闭欠线清单。 */
async function readTapeWindow(fs, dir) {
  const entries = await readTapeEntries(fs, dir)
  if (!entries.length) return { total: 0, window: [], counts: {}, open_threads: [], open_hooks: [], superseded_ids: [], superseded_chain: [], note: '事件带为空' }
  // 有效投影：被 supersedes 作废的条目不再进窗口正文/未闭欠线——append-only 不改
  // 历史，但消费端只认有效条目；撤销链（谁作废了谁）单独可查，不静默丢失作废这个事实。
  const superseded_ids = [...new Set(entries.filter((e) => e.supersedes).map((e) => e.supersedes))]
  const revoked = new Set(superseded_ids)
  const superseded_chain = entries.filter((e) => e.supersedes).map((e) => {
    const t = entries.find((x) => x.id === e.supersedes)
    return { id: e.supersedes, kind: t ? t.kind : null, what: t ? t.what : null, superseded_by: e.id, at: e.at }
  })
  const active = entries.filter((e) => !revoked.has(e.id))
  const closed = new Set(active.filter((e) => e.closes_thread).map((e) => e.closes_thread))
  const stickyAll = active.filter((e) => TAPE_STICKY_KINDS.has(e.kind) && !(e.kind === 'open_thread' && closed.has(e.id)))
  const sticky = stickyAll.slice(-TAPE_STICKY_CAP)
  const stickyIds = new Set(sticky.map((e) => e.id))
  const others = active.filter((e) => !stickyIds.has(e.id))
  const windowable = others.filter((e) => !TAPE_QUIET_KINDS.has(e.kind))
  const windowTail = windowable.slice(-TAPE_WINDOW)
  const windowIds = new Set(windowTail.map((e) => e.id))
  const counts = {}
  for (const e of others) { counts[e.kind] = (counts[e.kind] || 0) + 1 }
  const window = active.filter((e) => windowIds.has(e.id) || stickyIds.has(e.id)) // 保持带序
  const open_threads = active.filter((e) => e.kind === 'open_thread' && !closed.has(e.id)).map((e) => ({ id: e.id, what: e.what, ch: e.ch ?? null, closes: e.closes }))
  // 未闭钩子：钩子不进粘性窗口（每章一条会把安全阀顶爆），但"还欠哪些钩子"必须完整可查，
  // 否则账记了等于没记。按埋设章升序＝最可能被读者遗忘的排最前。
  const open_hooks = active.filter((e) => e.kind === 'hook' && !closed.has(e.id))
    .map((e) => ({ id: e.id, what: e.what, ch: e.ch ?? null }))
    .sort((a, b) => (a.ch == null ? Infinity : a.ch) - (b.ch == null ? Infinity : b.ch))
  const ret = { total: entries.length, active_total: active.length, window, counts, open_threads, open_hooks, superseded_ids, superseded_chain }
  const notes = []
  const older = windowable.length - windowTail.length
  if (older > 0) notes.push('更早 ' + older + ' 条 decision/revision/verdict 已计数化（open_thread/checkpoint 永不摘要）')
  if (stickyAll.length > TAPE_STICKY_CAP) notes.push('粘性条目 ' + stickyAll.length + ' 超安全阀 ' + TAPE_STICKY_CAP + '，仅留最近——欠线/checkpoint 积压过多，该收线/归档了')
  const quietCount = (counts.hook || 0) + (counts.payoff || 0)
  if (quietCount) notes.push('钩子/兑现 ' + quietCount + ' 条只计数不占窗口（hook ' + (counts.hook || 0) + ' / payoff ' + (counts.payoff || 0) + '；未闭钩子见 open_hooks）')
  if (open_hooks.length) notes.push('未闭钩子 ' + open_hooks.length + ' 条——超 ' + HOOK_STALE_CHAPTERS + ' 章未见兑现的会在 novel_verify 报出')
  if (revoked.size) notes.push('已作废 ' + revoked.size + ' 条（supersedes 有效投影已排除，撤销链见 superseded_chain）')
  if (notes.length) ret.note = notes.join('；')
  return ret
}

// ---------------------------------------------------------------- 弧审账单（arcs.jsonl）

/**
 * 弧审结构化账单：append-only JSONL，一弧一条（book_dir/editorial/arcs.jsonl）。
 *
 * 为什么不并进事件带（与钩子的处理相反）：事件带是**叙述性**编排记忆（what/why 各 ≤60 字），
 * 装不下弧审要留下的结构化坐标（承重点章号/价值翻转/伏笔收支对），硬塞进去只能把它压成散文，
 * 那就退回了"弧审只产出报告"的老问题。而弧审条目每 5-10 章才一条（一部 50 万字长篇 ≈ 十几条），
 * 不存在"两个生命周期"的量级问题——它只有这一个生命周期。
 *
 * 存在的意义：把"弧审"从一份会漂移的散文报告，变成可被仪器读取的数据（structure-check 靠它
 * 标出承重章、算伏笔收支），也让"这个弧到底承重点在哪"有账可查而不是每次重新拍。
 */
function arcsFile(dir) { return pth(dir, 'arcs') }

async function readArcs(fs, dir) {
  const lines = await readJsonlLines(fs, arcsFile(dir))
  const arcs = []
  for (const l of lines) { try { arcs.push(JSON.parse(l)) } catch (e) { /* readJsonlLines 已把关 */ } }
  return arcs
}

/**
 * "@last" 记忆+ bookRootOf（别名归一/@last 解析）见 lib/book-access.mjs。
 * 为什么不是"省略 book_dir 就用上次那本"：多本书并存时，省略＝写错书的静默风险，
 * 与刚修掉的"读改写丢更新"是同一类错误。所以只在**显式传 `@last`** 时才启用——
 * 省掉的是重复敲长绝对路径，不是省掉"指向哪本书"这个决定。
 * 批R2 起：记忆只在调用成功返回后由写门提交（bookRootOf 本身是纯函数），且按 fs 上下文分桶。
 */

/**
 * 读类工具的书存在性前置：六个账本文件一个都不在＝书目录指错了。
 * 为什么必须显式拦：不拦就是"静默返回全零/空清单"，调用方会把它当成"这本书还没写"——
 * 与 2026-09-07 修掉的 novel_ask 空书假绿是同一类缺陷，此前只修了一个工具。
 */
async function requireBook(fs, dir) {
  for (const f of ['project.json', 'bible.json', 'characters.json', 'foreshadows.json', 'timeline.json', 'outline.json', 'events.jsonl']) {
    if (await fs.stat(await fs.resolve(dir + '/' + f))) return dir
  }
  // manuscript/ 或 editorial/ 有内容也算书已存在（账本文件可被外部工具搬走，正文目录在就还在写这本书）
  for (const d of ['manuscript', 'editorial']) {
    try {
      const list = await fs.listDir(await fs.resolve(dir + '/' + d))
      if (list && list.length) return dir
    } catch (e) { /* 目录不存在 */ }
  }
  throw fail(ERR.NOT_FOUND, '书目录为空或不存在：' + dir, '核对 book_dir 是否指向书根目录；新书先跑 novel_init')
}

/**
 * 键消毒（原型污染防护）：模型线传入的 JSON 经 JSON.parse 后
 * "__proto__"/"constructor"/"prototype" 是自有键；Object.assign 走 [[Set]] 会触发
 * Object.prototype.__proto__ setter 改写目标对象原型（开源面威胁模型=调用方即 LLM，
 * 不可默认可信）。合并前过滤这三键，其余原样。
 */
/**
 * 生效窗重叠判定（2026-09-18，Owner 质询后重做冲突语义）。
 * bible 词条与人物卡是**带时间窗的事实**，存储却是"一名一条、覆盖写"——语义与存储错配，
 * 于是正常的设定演进（旧值 [1,10] → 新值 [11,∞)）被报成冲突要 Owner 仲裁。
 * 但**只改冲突条件会造出更坏的错**：覆盖写会把旧窗口连值一起毁掉，"第 5 章时该词条是什么"
 * 从此查不到（误报换成静默吃书）。真解＝版本记录 + 重叠判定：
 *   读=按 ch 投影到窗口包含 ch 的那条；写=重叠则修正同条，不重叠则追加新版本记录；
 *   冲突=仅当"窗口重叠且值不同"。**无窗字段＝全书窗**（与任何窗重叠）→ 旧账本行为不变。
 */
function windowsOverlap(a, b) {
  const from = (x) => (x && x.effective_from_ch != null ? x.effective_from_ch : -Infinity)
  const to = (x) => (x && x.effective_to_ch != null ? x.effective_to_ch : Infinity)
  return from(a) <= to(b) && from(b) <= to(a)
}

/** 生效窗按章命中（与 novel_bible 的 eff() 同口径）。 */
function windowCovers(x, ch) {
  return x.effective_from_ch == null || x.effective_from_ch <= ch
    ? (x.effective_to_ch == null || ch <= x.effective_to_ch)
    : false
}

function sanitizeOwn(obj) {
  const out = {}
  for (const k of Object.keys(Object(obj))) {
    if (k === '__proto__' || k === 'constructor' || k === 'prototype') continue
    out[k] = obj[k]
  }
  return out
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
/**
 * 产线校准建议：按已落盘章实测分布推荐字数窗。
 *
 * 修过一次真事故：正稿被移走/回改后，manuscript/ 里可能只剩**体例章与残章**
 * （实测：《第七封》28 章被移出 manuscript/ 后只剩 3 个文件——后记 124 字、ch30 942 字、ch1 2296 字，
 * 于是推荐 900-1000，而这本书的章长是 2000-3200）。它会自我标注"样本≥3 章才出"，
 * 给出的却是一种**有依据的错觉**——比不给建议更坏。
 *
 * 所以三条纪律：
 *   ①**只在章纲在册的章上算**（章纲外的东西——后记/番外/残章——不进样本）；
 *   ②**排除体例章**：章纲自身声明的窗口明显低于全书主体（< 主体中位的 40%）的章不算常规章；
 *   ③**回报样本与排除明细**，让"建议从哪来"可见——不给无法追溯的建议。
 */
async function recommendWordWindow(fs, dir) {
  let files = []
  try { files = await fs.listDir(await fs.resolve(pth(dir, 'manuscript'))) } catch (e) { return null }
  const outline = await loadJson(fs, dir, 'outline.json') || { volumes: [] }
  const inOutline = new Map()
  for (const vol of outline.volumes || []) for (const c of vol.chapters || []) inOutline.set(c.chapter_no, c)
  // 章纲声明的窗口分布 → 体例章判定基准（用声明值判，不用正文现值判——正文可能正在被搬动）
  const declared = [...inOutline.values()].map((c) => c.word_min).filter((x) => Number.isInteger(x) && x > 0).sort((a, b) => a - b)
  const declaredMedian = declared.length ? declared[Math.floor((declared.length - 1) / 2)] : null
  const isSpecial = (c) => declaredMedian != null && Number.isInteger(c.word_min) && c.word_min < declaredMedian * 0.4

  const hans = []
  const excluded = []
  for (const e of files || []) {
    if (!/^chapter_\d+\.md$/.test(e.name)) continue
    const no = Number(e.name.match(/(\d+)/)[1])
    const entry = inOutline.get(no)
    const t = await fs.readText(await fs.resolve(pth(dir, 'manuscript') + '/' + e.name))
    const h = countHan(t)
    if (h <= 0) continue
    if (!entry) { excluded.push({ ch: no, han: h, why: '不在章纲内（体例章/番外/残章）' }); continue }
    if (isSpecial(entry)) { excluded.push({ ch: no, han: h, why: '体例章（章纲声明窗口 ' + entry.word_min + ' 远低于主体）' }); continue }
    hans.push(h)
  }
  if (hans.length < 3) return null
  hans.sort((a, b) => a - b)
  const q = (p) => hans[Math.min(hans.length - 1, Math.floor(p * (hans.length - 1)))]
  const sMax = Math.ceil(q(0.75) / 100) * 100
  const sMin = Math.min(Math.max(1000, Math.floor(q(0.25) / 100) * 100), Math.max(100, sMax - 100))
  const ret = {
    sample: hans.length, min: hans[0], max: hans[hans.length - 1], median: q(0.5),
    suggest_word_min: sMin, suggest_word_max: sMax,
  }
  // 追溯性：排除了什么、为什么——建议不是凭空来的
  if (excluded.length) {
    ret.basis = '样本＝章纲在册的常规章 ' + hans.length + ' 章；已排除 ' + excluded.length + ' 章（' +
      excluded.slice(0, 5).map((x) => 'ch' + x.ch + ' ' + x.han + '字 ' + x.why).join('；') +
      (excluded.length > 5 ? ' 等' : '') + '）'
  }
  return ret
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

/** B8：只投影章纲与事实声明，不读正文、不推断语义；未知字段用 null，不冒充零。 */
async function contextChapters(fs, dir) {
  const outline = await loadJson(fs, dir, 'outline.json') || { volumes: [] }
  const { chapters } = await readFactDeclarations(fs, dir)
  const rows = new Map()
  for (const vol of outline.volumes || []) {
    for (const c of vol.chapters || []) {
      rows.set(c.chapter_no, { ch: c.chapter_no, volume: vol.volume ?? null, title: c.title ?? null, word_min: c.word_min ?? null, word_max: c.word_max ?? null })
    }
  }
  for (const ch of chapters.keys()) {
    if (!rows.has(ch)) rows.set(ch, { ch, volume: null, title: null, word_min: null, word_max: null })
  }
  return [...rows.values()].sort((a, b) => a.ch - b.ch).map((row) => {
    const fact = chapters.get(row.ch) || {}
    return { ...row, cast: fact.cast ?? null, seeds: fact.seeds ? fact.seeds.map((s) => s.id) : null,
      closes: fact.closes ?? null, timeline_count: fact.timeline ? fact.timeline.length : null }
  })
}

/** 卷/书只给计数与区间合计；任一章字段未知，该字段合计也未知。 */
function aggregateContext(rows) {
  const unique = (key) => rows.some((r) => r[key] == null) ? null : new Set(rows.flatMap((r) => r[key])).size
  const sum = (key) => rows.some((r) => r[key] == null) ? null : rows.reduce((n, r) => n + r[key], 0)
  return { chapters: rows.length, cast_count: unique('cast'), seeds_count: unique('seeds'), closes_count: unique('closes'),
    timeline_count: sum('timeline_count'), word_min: sum('word_min'), word_max: sum('word_max') }
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
        required_outline_fields: {
          type: 'array', items: { type: 'string' },
          description: '可选：本卷纲**必答字段清单**（缺省 = ["differentiation","choice_axis"]，即现行裁定要求随卷首章纲存档的字段）。' +
            '为什么要有它：verify 原先按"书内出现过该字段才启用"判，于是"整本书都没用"与"有意不用"在账上长得一样——**永不采用即永不检查**。' +
            '新书按清单查（缺即 issues），未登记清单的旧书仍走原宽松口径（不误报存量书）。',
        },
      },
      required: ['book_dir', 'title', 'genre', 'logline'],
    }),
    output: {
      schema: { type: 'object', properties: { ok: { type: 'boolean' }, book_dir: { type: 'string' }, created: { type: 'array', items: { type: 'string' } } }, additionalProperties: false },
      render: (a, v) => textBlock(v.ok ? '建书成功：' + v.book_dir + '（' + v.created.join('、') + '）' : '建书失败'),
    },
    async execute(args, exec) {
      const fs = exec.agent.ctx && exec.agent.ctx.get ? exec.agent.ctx.get('fs') : undefined
      if (!fs) throw fail(ERR.PRECONDITION, 'fs 服务不可用', '工具执行需要宿主注入 fs 服务；当前执行上下文里拿不到')
      const dir = bookRootOf(args)
      const project = await loadJson(fs, dir, 'project.json')
      if (project) throw fail(ERR.PRECONDITION, '书已存在：' + dir)
      // 〔2026-09-18 审计修复〕存在性闸不能只看 project.json 一件。
      // 旧实现只查它，于是"有账本、缺 project.json"的目录（外部搬文件/手工处置后很常见）
      // 会被当成空地：下面几次 saveJson 把 bible/characters/foreshadows/timeline/outline
      // **整文件覆盖成空骨架**，还返回"建书成功"——账本数据直接丢，零报错。
      const existingLedgers = []
      for (const f of ['bible.json', 'characters.json', 'foreshadows.json', 'timeline.json', 'outline.json']) {
        if (await loadJson(fs, dir, f)) existingLedgers.push(f)
      }
      if (existingLedgers.length) {
        throw fail(ERR.PRECONDITION,
          '目录里已有账本（但缺 project.json）：' + existingLedgers.join('、') + ' —— ' + dir,
          '这不是新书目录。要接着写就补回 project.json（或从备份恢复）；确要重建时，先把这些账本移走再跑 novel_init')
      }
      const created = []
      const newProject = {
        book_id: dir.split('/').pop(),
        title: args.title, genre: args.genre, logline: args.logline,
        status: 'drafting', current_ch: 0, volumes: [],
        schema_version: 1,
      }
      if (args.selection_report) newProject.selection_report = String(args.selection_report)
      // 必答字段清单（缺省＝现行裁定要求随卷首章纲存档的字段）。写成清单而不是靠"字段出现过"判，
      // 是因为后者自带"永不采用即永不检查"的后门：整本书都没用某字段时，检查整体不启用、缺失静默通过。
      // 区分「未提供」（→ 用缺省清单）与「显式为空数组」（→ 自愿不受约束）。
      // 混为一谈的话，"我明确不要这条约束"会被静默改写成"我要缺省约束"——同一族缺陷。
      const req = Object.hasOwn(args, 'required_outline_fields')
        ? (Array.isArray(args.required_outline_fields) ? args.required_outline_fields.map(String) : [])
        : ['differentiation', 'choice_axis']
      newProject.required_outline_fields = req
      await saveJson(fs, dir, 'project.json', newProject); created.push('project.json')
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
        // 章号入参正名 ch（与其余 13 个工具一致）；chapter_no 保留为**兼容别名**——
        // 它是章纲条目里的字段名（数据），不是入参该用的名字。同义词只留一个正名，
        // 旧名继续接受（不破坏既有调用方），新写的一律用 ch。
        ch: { type: 'integer', description: '章号（write 必填；旧名 chapter_no 仍接受）' },
        chapter_no: { type: 'integer', description: '（兼容别名，等价于 ch；新代码请用 ch）' },
          entry: { type: 'object', additionalProperties: true, description: 'write 时传入：{ title, goal, hook, word_min, word_max, differentiation?, anchor_params?, choice_axis? }。卷首章必答 differentiation=与榜单头部哪里不一样（差异化槽位）。anchor_params（v6.5，P2 拆书参数落位）：{ hook_type, beat_pattern, rhythm_ref, word_window:[min,max] }——只存档不判，verify 对 word_window 出窗报 warn、卷首章缺失报 warn（书内启用锚参后才检查）。choice_axis（v6.6，ADR-034 C-3 戏剧选择落盘）：{ chosen: 选中走向一句话, sacrificed: [被放弃项逐条], hook_bearing: 挂哪条卷内伏笔 }——戏剧选择呈报（3 互斥走向 Owner 三选一）选中项的代价清单，verify 对启用卷核卷首章必带' },
      },
      required: ['book_dir', 'op'],
    }),
    output: {
      schema: { type: 'object', properties: { op: { type: 'string' }, outline: { type: 'object', additionalProperties: true }, warn: { type: 'string' }, recommend: { type: 'object', additionalProperties: true } }, additionalProperties: false },
      render: (a, v) => textBlock(JSON.stringify(v.outline || {}, null, 2) + (v.recommend ? '\n产线校准建议（已落盘 ' + v.recommend.sample + ' 章实测分布：min ' + v.recommend.min + ' / 中位 ' + v.recommend.median + ' / max ' + v.recommend.max + '）：建议 word_min=' + v.recommend.suggest_word_min + '、word_max=' + v.recommend.suggest_word_max + '（只建议不替人定）' : '')),
    },
    async execute(args, exec) {
      const fs = exec.agent.ctx && exec.agent.ctx.get ? exec.agent.ctx.get('fs') : undefined
      if (!fs) throw fail(ERR.PRECONDITION, 'fs 服务不可用', '工具执行需要宿主注入 fs 服务；当前执行上下文里拿不到')
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
      // 〔2026-09-18 审计修复〕op 白名单：此前"非 read 即写"，拼错的 op（如 op='写'）会被
      // 静默当成写指令执行——契约外输入落盘，调用方还以为只是查询。
      if (args.op !== 'write') {
        throw fail(ERR.BAD_ARG, 'unknown op：' + String(args.op) + '（本工具只接受 read / write）',
          '未知 op 不再静默落到写分支；写章纲请显式传 op="write"')
      }
      // 章号正名 ch（与其余 13 个工具一致）；chapter_no 是兼容别名——它是章纲条目的**字段名**，
      // 不该同时当入参名。同义词只留一个正名，旧名继续接受（不破坏既有调用方）。
      const chNo = args.ch != null ? args.ch : args.chapter_no
      if (!args.volume || !chNo || !args.entry) throw fail(ERR.BAD_ARG, 'write 需要 volume/ch/entry')
      let vol = outline.volumes.find((v) => v.volume === args.volume)
      if (!vol) { vol = { volume: args.volume, chapters: [] }; outline.volumes.push(vol) }
      const idx = vol.chapters.findIndex((c) => c.chapter_no === chNo)
      const entry = Object.assign(sanitizeOwn(args.entry), { chapter_no: chNo })
      if (idx >= 0) vol.chapters[idx] = entry; else vol.chapters.push(entry)
      vol.chapters.sort((a, b) => a.chapter_no - b.chapter_no)
      await saveJson(fs, dir, 'outline.json', outline)
      const firstNo = vol.chapters.length ? vol.chapters[0].chapter_no : chNo
      const warns = []
      if (chNo === firstNo && !args.entry.differentiation) warns.push('卷首章缺差异化槽位 differentiation（必答：与榜单头部哪里不一样；即时提示以当前最小章号为准，终判在 novel_verify）')
      // 参数压测实测（2026-09-01）：写手子代理单回复上限约 1 万汉字（10506 实测），
      // 且模型自报字数虚高 37%-63%。下限超 1 万即提示分段写作协议——只提示不拦（业务参数）。
      if (Number(args.entry.word_min) > 10000) warns.push('章纲 word_min=' + args.entry.word_min + ' 超过写手单回复上限（实测约 1 万汉字）：本章程必须走分段写作协议（多次交付+落盘+主编拼装核数，novel_count 口径）')
      const warn = warns.length ? warns.join('；') : null
      await appendEvent(fs, dir, Object.assign({ op: 'outline_write', volume: args.volume, chapter_no: chNo }, warn ? { warn } : {}))
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
        scope: { type: 'string', default: 'all', enum: ['all', 'term', 'character', 'foreshadow', 'timeline'], description: '查询范围（缺省 all）' },
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
      if (!fs) throw fail(ERR.PRECONDITION, 'fs 服务不可用', '工具执行需要宿主注入 fs 服务；当前执行上下文里拿不到')
      const dir = await requireBook(fs, bookRootOf(args))
      const ch = args.ch
      // 〔2026-09-18 审计修复〕scope 缺省＝all。此前它既非必填也无 default，
      // 于是 `novel_bible {book_dir, ch}`（写前查设定的最自然写法）返回四个空数组，
      // 与"账上确实没有这些设定"完全不可区分——主笔据此会以为没有设定可查。
      const scope = args.scope || 'all'
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
        terms: (scope === 'all' || scope === 'term') ? pick(args.name, bible.terms, eff) : [],
        characters: (scope === 'all' || scope === 'character') ? pick(args.name, chars.characters, eff) : [],
        foreshadows: (scope === 'all' || scope === 'foreshadow') ? (fsh.foreshadows || []).filter((f) => f.status !== 'closed') : [],
        // 时间线按**当前版本**投影后再按基准章过滤：改稿后的旧叙述不进当前账（与 facts/score 同口径）
        timeline: (scope === 'all' || scope === 'timeline')
          ? projectTimeline(tml.events, await currentRevsOf(fs, dir)).filter((e) => e.ch == null || e.ch <= ch)
          : [],
      }
    },
  },

  // 4. novel_chapter：正文落盘 + 自动记账 + 内联符号门（唯一正稿写入口）
  {
    name: 'novel_chapter',
    timeoutMs: WRITE_TIMEOUT_MS,
    description: '提交一章正文（v7.0·R1 三原语之"写章节"=一次调用收束全章账务）：正文参数携带（唯一写入口）→ 落盘 manuscript/chapter_XXX.md + 版本快照 + 伏笔埋/收 + 时间线 append + 出场人物 cast + 事件账 + 状态初始化（草稿）+ 完成回执（editorial/txn/）。落盘即跑符号门（只记账不判好坏：字数 vs 章纲区间、closes/cast 引用完整性），问题记 issue 不拦稿。可选派生（v7.0）：decision={what,why} 随章落事件带（免单独 novel_event append）；advance_to 落盘后状态自动推进（非法迁移拦，合法值同 set_chapter_status）；**hook={what,why} 记本章章末钩子＋pays_hooks=[tNNN] 记本章兑现的钩子**（v7.9：钩子并入事件带 kind=hook，不另立账本——与欠线共用埋下/兑现/闭线对账同一套生命周期）。',
    parameters: bookDirParam({
      properties: {
        ch: { type: 'integer', description: '章号（与 outline 一致）' },
        title: { type: 'string', description: '可选：本章标题——给了就与章纲登记的标题交叉核对，不一致记门警示（交错章强信号，不拦稿）；省略则跳过核对' },
        text: { type: 'string', description: '本章正文（模型产出，参数携带）' },
        seeds: { type: 'array', items: { type: 'object', additionalProperties: true }, description: '可选：本章新埋伏笔 [{ id, name, due_ch }]' },
        closes: { type: 'array', items: { type: 'string' }, description: '可选：本章回收的伏笔 id 列表' },
        timeline_events: { type: 'array', items: { type: 'object', additionalProperties: true }, description: '可选：本章发生的时间线事件 [{ time, what }]' },
        cast: { type: 'array', items: { type: 'string' }, description: '可选：本章出场人物名（用于人物卡出场章登记）' },
        advance_to: { type: 'string', description: '可选（v7.0 派生）：落盘后章状态自动推进（合法值 ' + CHAPTER_STATES.join('/') + '；非法迁移拦）' },
        decision: { type: 'object', additionalProperties: true, description: '可选（v7.0 派生）：随章决策落事件带 { what ≤60字, why ≤60字 }——免单独 novel_event append（actor 固定=主编）。重交同一正文时按 kind+ch+what 判重，不重复入账。' },
        hook: { type: 'object', additionalProperties: true, description: '可选（v7.10 派生）：本章章末钩子，落事件带 kind=hook { what ≤60字=钩子本身, why ≤60字=它靠什么拽住读者 }。每章一条是读者契约第⑤条（章末必须有下章钩子）；未兑现的钩子进 open_hooks，超 ' + HOOK_STALE_CHAPTERS + ' 章未见兑现 verify 报一条。有明确兑现章的长线用 seeds（伏笔，有 due_ch 逾期对账），不要用 hook。' },
        pays_hooks: { type: 'array', items: { type: 'string' }, description: '可选（v7.10 派生）：本章兑现掉的钩子 id 列表（事件带 tNNN）——闭线走与欠线同一套对账（closes_thread），重复闭线拦。' },
        expected_rev: { type: 'integer', description: '可选（v7.5 并发护栏）：调用方声明"我读到的账上 rev"。与实际不符→写入前抛错（零副作用），防并发双写；新章报 0。返回值 rev = 本次提交后的版本号。' },
        rollback_to_rev: { type: 'integer', description: '可选（批U2 回滚）：把正文恢复到第 N 版快照（versions/chapter_XXX.vN.md）。正文由快照提供，因此不要同时给 text。回滚同样走正常提交管线——历史不重写，回滚本身记为新的一版。' },
      },
      required: ['book_dir', 'ch'],
    }),
    output: {
      schema: { type: 'object', properties: { ok: { type: 'boolean' }, ch: { type: 'integer' }, han: { type: 'number' }, rev: { type: 'integer' }, content_hash: { type: 'string' }, deduped: { type: 'boolean' }, gate: { type: 'object', additionalProperties: true }, derived: { type: 'array', items: { type: 'string' } }, txn: { type: 'string' } }, additionalProperties: false },
      render: (a, v) => textBlock(v.ok ? '章 ' + v.ch + ' 已落盘（' + v.han + ' 汉字，rev ' + v.rev + (v.deduped ? '，同参重试未翻版本' : '') + '，' + String(v.content_hash || '').slice(0, 12) + '）' + (v.derived && v.derived.length ? '；派生：' + v.derived.join('；') : '') + (v.gate && v.gate.issues && v.gate.issues.length ? '；门警示：' + v.gate.issues.join('；') : '') : '落盘被拦：' + JSON.stringify(v)),
    },
    async execute(args, exec) {
      const fs = exec.agent.ctx && exec.agent.ctx.get ? exec.agent.ctx.get('fs') : undefined
      if (!fs) throw fail(ERR.PRECONDITION, 'fs 服务不可用', '工具执行需要宿主注入 fs 服务；当前执行上下文里拿不到')
      const dir = bookRootOf(args)
      const ch = Number(args.ch)
      if (!Number.isInteger(ch) || ch < 1) throw fail(ERR.BAD_ARG, 'ch 必须为正整数')
      // 封存闸：封存/废弃的书不再接受正文写入——封存的意义就在于"这条产线停了"。
      // 要续写必须先解封（novel_decide 记理由并清掉 sealed 块），让"重新开工"也是一次留痕决定。
      {
        const proj = await loadJson(fs, dir, 'project.json')
        if (proj && proj.sealed) {
          throw fail(ERR.PRECONDITION, '本书已' + (proj.status === 'abandoned' ? '废弃' : '封存') + '（' + proj.sealed.at + '：' + proj.sealed.reason + '），不再接受正文写入',
            '要续写先解封：novel_decide 记下解封理由并清除 project.json 的 sealed 块（封存/解封都是一次留痕决定）')
        }
      }
      // 回滚：从 versions/ 恢复某一版正文，走的是**同一条提交管线**——
      // 不新开第二条写路径（双写路径分叉是这个项目已经吃过亏的形状）。
      // 语义上回滚不重写历史：它本身记为新的一版，旧版快照全部保留。
      let text
      let rolledBackFrom = null
      if (args.rollback_to_rev != null) {
        if (args.text) throw fail(ERR.BAD_ARG, 'text 与 rollback_to_rev 不能同时给', '回滚时不要带 text（正文由快照提供）；正常提交时不要带 rollback_to_rev')
        const n = Number(args.rollback_to_rev)
        if (!Number.isInteger(n) || n < 1) throw fail(ERR.BAD_ARG, 'rollback_to_rev 必须为正整数（got ' + args.rollback_to_rev + '）')
        const base = chapterFile(ch).replace(/\.md$/, '')
        const snap = pth(dir, 'versions') + '/' + base + '.v' + n + '.md'
        if (!(await fs.stat(await fs.resolve(snap)))) {
          let avail = []
          try {
            avail = (await fs.listDir(await fs.resolve(pth(dir, 'versions')))).map((e) => e.name).filter((x) => x.startsWith(base + '.v')).sort()
          } catch (e) { /* versions 目录不存在 = 没有可回滚的版本 */ }
          throw fail(ERR.NOT_FOUND, '第 ' + ch + ' 章没有 v' + n + ' 版本快照', avail.length ? '该书可用的旧版快照：' + avail.join('、') : '这一章还没有任何旧版快照（首次落盘不产生快照；改过一次才会有 v1）')
        }
        text = await fs.readText(await fs.resolve(snap))
        rolledBackFrom = n
      } else {
        text = String(args.text || '')
        if (!text) throw fail(ERR.BAD_ARG, 'text 必填（或改用 rollback_to_rev 从快照恢复）', '提交新正文传 text；恢复到旧版传 rollback_to_rev')
      }
      const outline = await loadJson(fs, dir, 'outline.json') || { volumes: [] }
      let outlineEntry = null
      for (const vol of outline.volumes || []) {
        const e = (vol.chapters || []).find((c) => c.chapter_no === ch)
        if (e) { outlineEntry = e; break }
      }
      const gate = symbolGate(text, outlineEntry)
      // 标题交叉核对（2026-09-19 第三方审计修：title 曾是必填参数但 execute 全程没读过它——
      // schema 不诚实）。给了 title 就与章纲登记比对，不一致＝交错章的强信号。
      // **记门警示不拦稿**——与符号门"只记账不判好坏"的口径一致：章纲标题后改属合法演进，硬拒会拦住正当改稿。
      if (args.title != null && outlineEntry && outlineEntry.title != null && String(args.title) !== String(outlineEntry.title)) {
        gate.issues.push('[P1 提示] title 与章纲不一致：传入「' + args.title + '」≠ 章纲第 ' + ch + ' 章「' + outlineEntry.title + '」——确认没交错章；若章纲标题确已更新，先 novel_outline 更正或省略 title 重交')
      }
      if (gate.han > 0 && (!args.cast || args.cast.length === 0)) gate.issues.push('[P2 提示] 本章未携带 cast（纯过场可接受；收束验收③需随章登记出场人物，主编裁定）')
      // advance_to 预检（fail fast）——非法迁移在正文落盘/快照翻倍之前拦下，
      // 否则正文已写而状态未推，调用方整重试会导致版本快照无谓翻倍
      if (args.advance_to) {
        const to = String(args.advance_to)
        if (!CHAPTER_STATES.includes(to)) throw fail(ERR.BAD_ARG, 'advance_to 未知状态：' + to + '（合法：' + CHAPTER_STATES.join('/') + '）')
        const preSt = (await loadJson(fs, dir, 'status.json') || {})
        const preFrom = preSt[ch] || '草稿'
        if (preFrom !== to && !(CHAPTER_TRANSITIONS[preFrom] || []).includes(to)) {
          throw fail(ERR.PRECONDITION, 'advance_to 非法状态迁移：' + preFrom + ' → ' + to + '（合法去向：' + ((CHAPTER_TRANSITIONS[preFrom] || []).join('/') || '无') + '；正文尚未落盘，可改参重交或改用 ledger set_chapter_status）')
        }
      }
      // 钩子预检（同 advance_to 的道理）：事件带是本章账务的最后一步，参数错（未知钩子 id /
      // 重复闭线 / what 超长）若留到那一步才抛，正文已经落盘、回执停在 pending——调用方看到一个
      // "半提交"，而这本来是个可以在零副作用阶段拦下的参数错误。所以写盘前先把带子读一遍对账。
      const wantsHook = !!(args.hook && args.hook.what)
      const paysHooks = (args.pays_hooks || []).map((x) => String(x))
      if (wantsHook) {
        if (String(args.hook.what).length > 60) throw fail(ERR.BAD_ARG, 'hook.what 超 60 字（当前 ' + String(args.hook.what).length + '）', '防膨胀纪律：钩子写成一句话（≤60 字），细节留在细纲')
        if (args.hook.why != null && String(args.hook.why).length > 60) throw fail(ERR.BAD_ARG, 'hook.why 超 60 字（当前 ' + String(args.hook.why).length + '）', '≤60 字：它靠什么拽住读者')
      }
      if (paysHooks.length) {
        const tapeAll = await readTapeEntries(fs, dir)
        const closedAlready = new Set(tapeAll.filter((e) => e.closes_thread).map((e) => e.closes_thread))
        for (const hid of paysHooks) {
          const target = tapeAll.find((e) => e.id === hid)
          if (!target || !TAPE_CLOSABLE_KINDS.has(target.kind)) throw fail(ERR.NOT_FOUND, 'pays_hooks 引用未知钩子/欠线 id：' + hid, '先 novel_event op=read 看 open_hooks/open_threads 拿真实 id（钩子 id 形如 t012）')
          if (closedAlready.has(hid)) throw fail(ERR.CONFLICT, '钩子/欠线 ' + hid + ' 已闭合过（append-only，勿重复闭线）', '重复闭线会让"兑现率"统计失真，去掉该 id 重交')
        }
      }
      const msTarget = await fs.resolve(pth(dir, 'manuscript') + '/' + chapterFile(ch))
      const oldSt = await fs.stat(msTarget)
      // 只读探测当前版本号：快照 v1..vN 存在时手稿本体 = rev N+1；无手稿 = rev 0。
      // expected_rev 并发护栏与 rev 分配共用同一探测，保证"声明值 = 写前账上值"。
      let versNames = []
      if (oldSt) {
        let vers = []
        try { vers = await fs.listDir(await fs.resolve(pth(dir, 'versions'))) } catch (e) { /* versions 目录尚不存在 */ }
        const base = chapterFile(ch).replace(/\.md$/, '')
        versNames = (vers || []).map((e) => e.name).filter((n) => n.startsWith(base + '.v'))
      }
      const curRev = oldSt ? versNames.length + 1 : 0
      if (args.expected_rev != null) {
        const want = Number(args.expected_rev)
        if (!Number.isInteger(want) || want < 0) throw fail(ERR.BAD_ARG, 'expected_rev 必须为非负整数（got ' + args.expected_rev + '）')
        if (want !== curRev) throw fail(ERR.CONFLICT, 'expected_rev 不符（并发写保护）：账上当前 rev ' + curRev + '，调用方声明 ' + want + '——正文与全部账目均未改动', '重读该章后再交；不要盲目重试同样的声明值')
      }
      const contentHash = sha256Hex(text)
      // 同参重试幂等：正文逐字相同（sha256 判等）= 上次提交的重试/断点续跑，不再翻版本
      // 快照、不再改写正文；账务步骤（伏笔/时间线/cast/状态）照走——中断恢复正需它们补齐。
      let deduped = false
      let rev = curRev + 1
      let oldText = null
      if (oldSt) {
        oldText = await fs.readText(msTarget)
        if (sha256Hex(oldText) === contentHash) { deduped = true; rev = curRev }
      }
      const declaration = factDeclaration(args)
      const existingFacts = await loadJson(fs, pth(dir, 'facts'), factsFileOf(ch, rev))
      if (existingFacts && (!deduped || Object.entries(declaration).some(([key, value]) => JSON.stringify(existingFacts[key]) !== JSON.stringify(value)))) {
        throw fail(ERR.CONFLICT, '第 ' + ch + ' 章 rev ' + rev + ' 的事实贡献已存在：同 rev 不得改写', '重试保留原声明或省略；修改正文与事实时提交新版本')
      }
      const txnFile = 'chapter_' + String(ch).padStart(3, '0') + '.json'
      const txnDir = pth(dir, 'txn')
      // 提交日志化：正文落盘前先立 pending 回执——中断则残留 pending 可判定
      // （旧实现只有末尾 done 回执：中途崩=磁盘上什么都没有，verify 无从知道账务没收束）
      await saveJson(fs, txnDir, txnFile, { ch, rev, han: gate.han, content_hash: contentHash, status: 'pending', ts: new Date().toISOString() })
      if (!deduped) {
        if (oldSt) {
          await fs.writeText(await fs.resolve(pth(dir, 'versions') + '/' + chapterFile(ch).replace(/\.md$/, '') + '.v' + (rev - 1) + '.md'), oldText)
        }
        await fs.writeText(msTarget, text)
      }
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
        // 幂等语义：同章修订重提交，相同事件（ch+time+what 逐字相同）不重复 append
        // ——修订换版本快照，不换账
        const dup = tml.events.some((x) => x.ch === ch && x.time === e.time && x.what === e.what)
        // **事件带版本戳**（与 facts/score 同一套版本绑定口径）：改稿后旧版叙述不退役、
        // 新版追加，事实层会出现"平行版本"（实测：《第七封》79 条里有 16 组同 ch+time 的双叙述，
        // 文本略有差异故旧的"同文本去重"抓不住）。记下 rev，读路径按各章**当前 rev** 投影，
        // 旧叙述原样留档但不进当前账——append-only 不改历史，消费端只认有效版本。
        if (!dup) tml.events.push(Object.assign({ ch, rev }, e))
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
      // 事实贡献账：本版"这章贡献了什么事实"单独留档——共享账（foreshadows/timeline/
      // characters）是聚合态，改稿会覆盖掉"上一版贡献了什么"，回退与版本化裁决就没了依据。
      // 每章每版一份，append-only（改稿只加新文件，旧版贡献不删）。
      const derived = []
      if (rolledBackFrom != null) derived.push('回滚自 v' + rolledBackFrom + '（历史不重写，本次记为新的一版）')
      if (!existingFacts) {
        await saveJson(fs, pth(dir, 'facts'), factsFileOf(ch, rev), {
          ch, rev, content_hash: contentHash, ts: new Date().toISOString(), ...declaration,
        })
      }
      // last_seen 按有效出场重建：改稿删人物必须能回退，单调 max 补丁做不到
      const seenSync = await rebuildLastSeen(fs, dir)
      if (seenSync.changed.length) derived.push('last_seen 重建 ' + seenSync.changed.join('；'))
      const project = await loadJson(fs, dir, 'project.json') || { current_ch: 0 }
      if (ch > project.current_ch) { project.current_ch = ch; await saveJson(fs, dir, 'project.json', project) }
      const stj = await loadJson(fs, dir, 'status.json') || {}
      if (!stj[ch]) { stj[ch] = '草稿'; await saveJson(fs, dir, 'status.json', stj) }
      // 事件账幂等：同章同正文哈希的 chapter_commit 已在账 = 重试/续跑，不重复记账
      // （rev 变了才是修订，正常追加；旧事件无 content_hash 字段 → 判不等，保持旧追加语义）
      const commitLogged = (await readEvents(fs, dir)).some((l) => {
        try { const e = JSON.parse(l); return e && e.op === 'chapter_commit' && e.ch === ch && e.content_hash === contentHash } catch (e2) { return false }
      })
      if (!commitLogged) await appendEvent(fs, dir, Object.assign({ op: 'chapter_commit', ch, rev, han: gate.han, content_hash: contentHash }, gate.issues.length ? { issues: gate.issues } : {}))
      // v7.0 派生层（R1 写章节原语）：状态推进 + 随章决策落带 + 完成回执——全部可选、全部幂等安全
      if (args.advance_to) {
        const to = String(args.advance_to)
        if (!CHAPTER_STATES.includes(to)) throw fail(ERR.BAD_ARG, 'advance_to 未知状态：' + to + '（合法：' + CHAPTER_STATES.join('/') + '）')
        const from = stj[ch] || '草稿'
        if (from !== to) {
          if (!(CHAPTER_TRANSITIONS[from] || []).includes(to)) {
            throw fail(ERR.PRECONDITION, 'advance_to 非法状态迁移：' + from + ' → ' + to + '（合法去向：' + ((CHAPTER_TRANSITIONS[from] || []).join('/') || '无') + '）')
          }
          stj[ch] = to
          await saveJson(fs, dir, 'status.json', stj)
          await appendEvent(fs, dir, { op: 'chapter_status', ch, from, to, note: 'novel_chapter 派生' })
          derived.push('状态 ' + from + '→' + to)
        }
      }
      if (args.decision && args.decision.what) {
        const d = args.decision
        const t = await appendTapeOnce(fs, dir, { kind: 'decision', ch, what: String(d.what), why: String(d.why || '本章落盘决策'), actor: '主编' })
        derived.push('事件带 ' + t.id)
      }
      // 章末钩子：钩子与欠线同一条因果链，共用一个账本一套闭线对账。
      // 走 appendTapeOnce 而非 appendTape：事件带是本章账务的最后一步，断点续跑重交同一正文时
      // 必须"已落的不重记、没落的补上"，只有回读带子对内容才判得对（见 appendTapeOnce 注释）。
      if (args.hook && args.hook.what) {
        const h = await appendTapeOnce(fs, dir, { kind: 'hook', ch, what: String(args.hook.what), why: String(args.hook.why || '章末牵引，把读者带进下一章'), actor: '主编' })
        derived.push('钩子 ' + h.id + (h.mode === 'deduped' ? '（已在账）' : ''))
      }
      for (const hid of (args.pays_hooks || [])) {
        const c = await appendTapeOnce(fs, dir, { kind: 'payoff', ch, what: '兑现钩子 ' + hid, why: '本章回收该钩子', actor: '主编', ref: String(hid), closes_thread: String(hid) })
        derived.push('兑现 ' + hid + (c.mode === 'deduped' ? '（已在账）' : ''))
      }
      // 账务收束：pending → done。done 才代表"这章真的写完入账"；中断留 pending 由 verify 报半提交。
      // done 之外的字段全部保留（steps/derived 供断点续跑回读），rev/hash 供 verify 对账。
      const receipt = { ch, rev, han: gate.han, content_hash: contentHash, status: 'done', done: true, ts: new Date().toISOString(), steps: ['manuscript', 'snapshot', 'foreshadows', 'timeline', 'cast', 'project', 'status', 'events'], derived, deduped }
      if (rolledBackFrom != null) receipt.rollback_from_rev = rolledBackFrom
      await saveJson(fs, txnDir, txnFile, receipt)
      return { ok: true, ch, han: gate.han, rev, content_hash: contentHash, deduped, gate, derived, txn: 'editorial/txn/' + txnFile }
    },
  },

  // 5. novel_verify：符号级自检（只读）
  {
    name: 'novel_verify',
    description: '一致性机检（只出清单，不做语义判定——语义审稿归试读员/校对员子代理）。**issues=硬清单**（ok 由它决定）：伏笔逾期（due_ch 未收）/版本链连续/章纲-正文存在性/章号断档/提交回执对账（pending=半提交、done 但 content_hash 与正文不符=正文被绕过工具改动）/章末钩子漏记/卷已过宽限期无弧审账单。**warnings=业务提示**（不影响 ok）：钩子超期未兑现（> ' + HOOK_STALE_CHAPTERS + ' 章）／卷尾结算清单（卷末 ' + VOLUME_SETTLE_GRACE + ' 章内报一次，列出该卷未收的伏笔/欠线/钩子；跨界延续是允许的，这里只作结算记录，不是罚）。',
    parameters: bookDirParam({ properties: { ch: { type: 'integer', description: '可选：只看某章；缺省全量' } }, required: ['book_dir'] }),
    output: {
      schema: { type: 'object', properties: { ok: { type: 'boolean' }, issues: { type: 'array' }, warnings: { type: 'array' }, stats: { type: 'object', additionalProperties: true } }, additionalProperties: false },
      render: (a, v) => renderJson(v),
    },
    async execute(args, exec) {
      const fs = exec.agent.ctx && exec.agent.ctx.get ? exec.agent.ctx.get('fs') : undefined
      if (!fs) throw fail(ERR.PRECONDITION, 'fs 服务不可用', '工具执行需要宿主注入 fs 服务；当前执行上下文里拿不到')
      const dir = await requireBook(fs, bookRootOf(args))
      // issues=账目不一致/记录缺失/纪律违规（可判"这是错的"）；warnings=需要人判断的业务提示
      // （钩子超期、卷尾结算）。分开的理由：卷尾结算每次卷末必然出一条，
      // 混进 issues 就等于"每收一卷 verify 必红"，红灯贬值后真问题也跟着看不见了。
      const issues = []
      const warnings = []
      const project = await loadJson(fs, dir, 'project.json') || { current_ch: 0 }
      const fsh = await loadJson(fs, dir, 'foreshadows.json') || { foreshadows: [] }
      const outline = await loadJson(fs, dir, 'outline.json') || { volumes: [] }
      const msDir = await fs.resolve(pth(dir, 'manuscript'))
      let files = []
      try { files = await fs.listDir(msDir) } catch (e) { /* 无目录 */ }
      const chapters = (files || []).map((e) => chapterTitle(e.name)).filter((n) => n != null).sort((a, b) => a - b)
      const cur = args.ch || project.current_ch || 0
      for (const f of fsh.foreshadows || []) {
        if (f.status === 'planted' && f.due_ch != null && f.due_ch < cur) issues.push('伏笔逾期未收：「' + f.name + '」（埋于 ' + f.planted_ch + '，due ' + f.due_ch + '，当前 ' + cur + '）')
      }
      //
      // 缺章核对**一次报清**（原来是两条检查各报一遍，同一根因报两轮）。
      // 实测：《第七封》28 章被移出 manuscript/ 后，verify 出 56 条 issues，而真实原因只有 1 个
      // ——"有章纲、没正文"。两条清单（"章纲已写但正文缺失" + "章号断档"）讲的是同一件事。
      // 这与 issues/warnings 拆分的动机同源（红灯贬值后真问题也看不见），只是这一族在 issues 内部。
      // 现在：按"在章纲内 / 不在章纲内"分两组，每组**具名列出前 N 条**、其余计数化。
      const inOutlineNos = new Set()
      for (const vol of outline.volumes || []) for (const c of vol.chapters || []) if (c.chapter_no <= cur) inOutlineNos.add(c.chapter_no)
      // 已**登记退役**的章（seal_book 的 retired_chapters）：它们不在 manuscript/ 里是**有据的**，
      // 不算缺陷。未登记的缺照旧报——静默依然失败，只是"有据的缺"与"无据的缺"被区分开了。
      const retired = new Set(((project.sealed && project.sealed.retired_chapters) || []).map(Number))
      const missingPlanned = [...inOutlineNos].filter((n) => !chapters.includes(n) && !retired.has(n)).sort((a, b) => a - b)
      const missingUnplanned = []
      for (let n = 1; n <= cur; n++) if (!chapters.includes(n) && !inOutlineNos.has(n) && !retired.has(n)) missingUnplanned.push(n)
      const CAP = 6
      const nameList = (arr) => arr.slice(0, CAP).join('/') + (arr.length > CAP ? ' 等' : '')
      if (missingPlanned.length) {
        issues.push('缺正文：' + missingPlanned.length + ' 章有章纲但 manuscript/ 里没有文件 —— 第 ' + nameList(missingPlanned) +
          ' 章（共 ' + missingPlanned.length + ' 章）。对账后二选一：补回正文，或把这批章的账务表示补齐（章状态/事件带）让账实一致')
      }
      if (missingUnplanned.length) {
        issues.push('章号断档：' + missingUnplanned.length + ' 章在章纲之外也缺文件 —— 第 ' + nameList(missingUnplanned) + ' 章（共 ' + missingUnplanned.length + ' 章）')
      }
      // 版本链连续：每章快照 v1..vN 不跳号（符号层管版本链）
      let vfiles = []
      try { vfiles = await fs.listDir(await fs.resolve(pth(dir, 'versions'))) } catch (e) { /* 无目录 */ }
      const byChapter = {}
      const vPattern = /^chapter_(\d+)\.v(\d+)\.md$/
      for (const e of (vfiles || [])) {
        const m = e.name.match(vPattern)
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
      // 半提交检测（E-2）：正文已落但事件账无 chapter_commit=写入中断的半状态
      // （novel_chapter 写入序=正文先写、commit 事件最后，崩在中间则此项抓出——此前 verify 五项全盲）
      const committed = new Set()
      for (const l of await readEvents(fs, dir)) {
        try { const e = JSON.parse(l); if (e && e.op === 'chapter_commit' && Number.isInteger(e.ch)) committed.add(e.ch) } catch (e2) { /* readEvents 已把关 */ }
      }
      for (const n of chapters) {
        if (!committed.has(n)) issues.push('半提交嫌疑：第 ' + n + ' 章正文已落盘但事件账无 chapter_commit（写入中断？——对账后补记或同章重提交）')
      }
      // 回执对账：pending 回执=账务未收束的真半提交（正文可能已换而伏笔/时间线没收）；
      // done 回执的 content_hash 与正文不符=正文被外部改动而回执过期。旧回执无 hash 字段 → legacy 静默跳过。
      let txnFiles = []
      try { txnFiles = await fs.listDir(await fs.resolve(pth(dir, 'txn'))) } catch (e) { /* 未启用 txn */ }
      const txnPattern = /^chapter_(\d+)\.json$/
      for (const e of (txnFiles || [])) {
        const m = e.name.match(txnPattern)
        if (!m) continue
        const n = Number(m[1])
        const rc = await loadJson(fs, pth(dir, 'txn'), e.name)
        if (!rc) continue
        if (rc.status === 'pending') {
          issues.push('半提交：第 ' + n + ' 章提交中断（回执 pending，账务未收束）——对账后同章重交即可补齐（同文本重试幂等，不翻版本快照）')
          continue
        }
        if (rc.content_hash && chapters.includes(n)) {
          const curText = await fs.readText(await fs.resolve(pth(dir, 'manuscript') + '/' + chapterFile(n)))
          const nowHash = sha256Hex(curText)
          if (nowHash !== rc.content_hash) {
            issues.push('正文版本与回执不符：第 ' + n + ' 章 content_hash 漂移（回执 ' + String(rc.content_hash).slice(0, 12) + '… 实为 ' + nowHash.slice(0, 12) + '…）——正文被绕过工具改动，或回执对应的是旧 rev')
          }
        }
      }
      // 事件带欠线逾期：open_thread 预期章已过且未闭（带不存在=未启用，静默跳过）
      const tapeLines = await readJsonlLines(fs, tapeFile(dir))
      const tapeEntries = []
      for (const l of tapeLines) { try { tapeEntries.push(JSON.parse(l)) } catch (e) { /* 已把关 */ } }
      // 有效投影：被 supersedes 作废的条目不参与逾期/未闭判定——
      // 旧实现这里没做投影，一条被撤销的欠线会在撤销后继续报逾期（同族缺陷，随钩子账一并修正）。
      const revokedTape = new Set(tapeEntries.filter((e) => e.supersedes).map((e) => e.supersedes))
      const activeTape = tapeEntries.filter((e) => !revokedTape.has(e.id))
      if (tapeLines.length) {
        const closedIds = new Set(activeTape.filter((e) => e.closes_thread).map((e) => e.closes_thread))
        for (const e of activeTape) {
          if (e.kind === 'open_thread' && !closedIds.has(e.id) && Number.isInteger(e.closes) && e.closes < cur) {
            issues.push('事件带欠线逾期：' + e.id + '「' + e.what + '」预期 ' + e.closes + ' 章收线，当前 ' + cur + '（收线/闭线或改期）')
          }
        }
        // 章末钩子：两查——①超期未兑现（warn 级）②近窗漏记。
        const hookEntries = activeTape.filter((e) => e.kind === 'hook')
        const openHooks = hookEntries.filter((e) => !closedIds.has(e.id))
        for (const h of openHooks) {
          if (!Number.isInteger(h.ch)) continue
          const age = cur - h.ch
          if (age > HOOK_STALE_CHAPTERS) {
            warnings.push('钩子超期未兑现：' + h.id + '（第 ' + h.ch + ' 章「' + h.what + '」）已过 ' + age + ' 章无兑现记录——短程钩子该收就收；真是长线就转成伏笔 seeds 走 due_ch 逾期对账')
          }
        }
        if (hookEntries.length) {
          // 覆盖缺口只在已启用的窗口内查（HOOK_COVERAGE_WINDOW 章），且不早于首次采用钩子的章：
          // 否则给一本跑了 190 章、今天才开始记钩子的书刷出 190 条"缺钩子"。
          const adoptedFrom = hookEntries.reduce((m, h) => (Number.isInteger(h.ch) && h.ch < m ? h.ch : m), Infinity)
          const hookChs = new Set(hookEntries.map((h) => h.ch))
          const missing = chapters.filter((n) => n >= adoptedFrom && n <= cur && n > cur - HOOK_COVERAGE_WINDOW && !hookChs.has(n))
          if (missing.length) {
            issues.push('近 ' + HOOK_COVERAGE_WINDOW + ' 章有 ' + missing.length + ' 章无章末钩子记录：第 ' + missing.slice(0, 8).join('/') + (missing.length > 8 ? ' 章等' : ' 章') + '（读者契约⑤：每章结尾必须有下章钩子；纯过场章由主编裁定并留痕）')
          }
        }
      }
      // 卷尾结算：卷收束后仍报一个批次（VOLUME_SETTLE_GRACE 章）的结算清单，之后静默。
      // 这是结算不是硬闸——跨卷延续是正当手法（该卷埋的线在下一卷收），此处只把"这一卷留下了
      // 什么没结"摆到台面上，不计罚、不拦稿。
      for (const vol of outline.volumes || []) {
        const chs = (vol.chapters || []).map((c) => c.chapter_no).filter((n) => Number.isInteger(n)).sort((a, b) => a - b)
        if (!chs.length) continue
        const first = chs[0]
        const last = chs[chs.length - 1]
        if (!(last <= cur && cur - last < VOLUME_SETTLE_GRACE)) continue
        // 只在"该卷已写完"时结算：还在写的卷报结算等于催稿，是噪音。
        if (!chs.every((n) => chapters.includes(n))) continue
        const unfClosed = (fsh.foreshadows || []).filter((f) => f.status !== 'closed' && Number.isInteger(f.planted_ch) && f.planted_ch >= first && f.planted_ch <= last)
        const closedAll = new Set(activeTape.filter((e) => e.closes_thread).map((e) => e.closes_thread))
        const volThreads = activeTape.filter((e) => e.kind === 'open_thread' && !closedAll.has(e.id) && Number.isInteger(e.ch) && e.ch >= first && e.ch <= last)
        const volHooks = activeTape.filter((e) => e.kind === 'hook' && !closedAll.has(e.id) && Number.isInteger(e.ch) && e.ch >= first && e.ch <= last)
        const parts = []
        if (unfClosed.length) parts.push('卷内未收伏笔 ' + unfClosed.length + ' 条（' + unfClosed.slice(0, 4).map((f) => f.id + '「' + f.name + '」' + (f.due_ch != null ? 'due ' + f.due_ch : '')).join('／') + (unfClosed.length > 4 ? ' 等' : '') + '）')
        if (volThreads.length) parts.push('卷内未闭欠线 ' + volThreads.length + ' 条（' + volThreads.slice(0, 4).map((t) => t.id).join('／') + '）')
        if (volHooks.length) parts.push('卷内未兑现钩子 ' + volHooks.length + ' 条（' + volHooks.slice(0, 4).map((t) => t.id).join('／') + '）')
        if (!parts.length) parts.push('卷内线头全部结清')
        warnings.push('卷 ' + vol.volume + ' 结算（末章 ' + last + '，已过 ' + (cur - last) + ' 章）：' + parts.join('；') + '——跨卷延续是允许的，这里只作结算记录')
      }
      // ── 盘面 vs 账本（**给智能体看的一致性检查**，不是给人读的仪器报告）──────────────
      //
      // 由来：外部体检发现《第七封》28 章被移进 `废稿-2026-09-16/` 而账本一无所知——账本上是一条
      // 完整闭合零 P0 的胜利曲线。**账本会自洽，仪器不会。**
      //
      // 但根因不是"人不受约束"（拿文件管理器处置东西是天经地义的），而是**账本缺表达这类事实的词**：
      // 没有"这本书不写了/这批章退役了"的词，决定就只能发生在带外。所以本检查有两重身份：
      //   ①一致性探测：盘上有、账上没有的东西报出来；
      //   ②**账本词汇覆盖率的探针**——它经常报，说明又出现了一类没有对应工具的决定。
      //
      // 分级（不搞一言堂）：
      //   顶层未知条目含 chapter_NNN.md → **issue**（那是章的正文本体，账必须知道）；
      //   其余未知条目 → warning（工作产物本就允许存在，只是账外）；
      //   已封存的书：含且仅含"已登记退役章"的目录降为 warning（登记过就不算无据）。
      {
        const KNOWN = new Set(['project.json', 'bible.json', 'characters.json', 'foreshadows.json', 'timeline.json', 'outline.json', 'status.json', 'events.jsonl', 'manuscript', 'versions', 'editorial', '全本.md'])
        let top = []
        try { top = (await fs.listDir(await fs.resolve(dir))) || [] } catch (e) { /* 读不到就不报（自证由别处把关） */ }
        const unknown = top.map((e) => e.name).filter((n) => !n.startsWith('.') && !KNOWN.has(n)).sort()
        for (const name of unknown) {
          // 看它是不是含章正文（章文件才是账本必须知道的实体）
          let inner = []
          try { inner = ((await fs.listDir(await fs.resolve(dir + '/' + name))) || []).map((e) => e.name) } catch (e) { /* 是文件不是目录 */ }
          const innerChs = inner.map((n) => chapterTitle(n)).filter((n) => n != null)
          if (!innerChs.length) { warnings.push('账外条目：' + name + '（不在账本已知清单内；若是有意的处置请用工具留痕，否则这是账外改动）'); continue }
          const unretired = innerChs.filter((n) => !retired.has(n))
          if (project.sealed && !unretired.length) {
            warnings.push('账外条目：' + name + '/（含 ' + innerChs.length + ' 章正文，全部在已登记退役清单内——封存处置的归档目录，账实一致）')
          } else {
            issues.push('账外正文：' + name + '/ 里有 ' + innerChs.length + ' 章正文而账本不知道' +
              (unretired.length ? '（其中 ' + unretired.length + ' 章未登记退役：第 ' + unretired.slice(0, 6).join('/') + (unretired.length > 6 ? ' 等' : '') + '）' : '') +
              ' —— 章正文是账本必须知道的实体：要么移回 manuscript/，要么用 novel_ledger op=seal_book 登记退役')
          }
        }
      }

      // 人物欲望缺口（warning）：guide 要求 characters.json 记 want（贯穿欲求）/opposed_by（压力来源）——
      // "主笔的人物欲望设计不落账，换会话就重建不出来"，而长篇最典型的死法正是"主角连续多章没有想要的东西"。
      // 此前**没有任何检查项**：存量书（口径变更前建的）缺这两栏是静默的。这里报出来，但不翻 ok
      // （存量书不该因为新口径集体变红——那正是红灯贬值的成因）。
      {
        const cj = await loadJson(fs, dir, 'characters.json') || { characters: [] }
        const all = cj.characters || []
        const noWant = all.filter((c) => c.want == null)
        if (all.length && noWant.length) {
          warnings.push('人物卡缺 want（贯穿欲求）：' + noWant.length + '/' + all.length + ' 条 —— ' +
            noWant.slice(0, 6).map((c) => c.name).join('、') + (noWant.length > 6 ? ' 等' : '') +
            '。guide 要求人物欲望进账（不落账换会话就重建不出来）；补法：novel_ledger op=update_character 带 want/opposed_by')
        }
      }
      // 弧审账单核对（ADR-034 弧级审查纪律）：卷收束且过了宽限期仍无结构化弧审条目 → 报一条。
      // 采用门与 choice_axis/anchor_params 同法：书内一条弧审条目都没有＝尚未启用，不误报存量书。
      const arcs = await readArcs(fs, dir)
      if (arcs.length) {
        const reviewed = new Set(arcs.map((a) => String(a.volume)))
        for (const vol of outline.volumes || []) {
          const chs = (vol.chapters || []).map((c) => c.chapter_no).filter((n) => Number.isInteger(n)).sort((a, b) => a - b)
          if (!chs.length) continue
          const last = chs[chs.length - 1]
          if (!(last <= cur - VOLUME_SETTLE_GRACE)) continue
          if (!reviewed.has(String(vol.volume))) {
            issues.push('卷 ' + vol.volume + ' 已过 ' + (cur - last) + ' 章无弧审账单（editorial/arcs.jsonl）——弧级审查纪律=每卷至少 1 次，结构化条目由 novel_ledger op=arc_review 落')
          }
        }
      }
      // 卷首章必答字段核对（清单驱动）
      //
      // 旧口径＝"以首个含 choice_axis 的章所在卷为启用卷"（存量书不误报），但它自带一个后门：
      // **整本书都没用某字段 → 检查整体不启用 → 缺失静默通过**。"永不采用"与"有意不用"在账上长得一样。
      // 实测（2026-09-18）：fangxiangyi-01 的章纲全无 choice_axis（因该载荷产出早于这条裁定），verify 输出 0 issues。
      //
      // 新口径＝**新书按 project.json 的 required_outline_fields 清单查**（该有的有没有）；
      // 未登记清单的旧书仍走原宽松口径（不误报存量书）。两条共存，不迁移。
      // 有清单＝按清单查（清单为空＝自愿不受约束，也是明确口径）；无清单＝合并前的老书，走宽松口径。
      const hasManifest = Array.isArray(project.required_outline_fields)
      const reqFields = hasManifest ? project.required_outline_fields.map(String) : null
      if (hasManifest && reqFields.length) {
        for (const vol of outline.volumes || []) {
          const chs = (vol.chapters || []).slice().sort((a, b) => a.chapter_no - b.chapter_no)
          if (!chs.length) continue
          const miss = reqFields.filter((f) => chs[0][f] == null)
          if (miss.length) {
            issues.push('卷 ' + vol.volume + ' 卷首章（' + chs[0].chapter_no + '）缺必答字段：' + miss.join('/') +
              '（本书 project.required_outline_fields 已登记这些字段为必答；裁定依据见 guide 卷级开局与 ADR-034）')
          }
        }
      } else {
        // 旧书宽松口径：以首个含 choice_axis 的章所在卷为启用卷，只查该卷及之后（存量卷不误报）
        let choiceMinVol = Infinity
        for (const vol of outline.volumes || []) { for (const c of vol.chapters || []) { if (c.choice_axis && vol.volume < choiceMinVol) choiceMinVol = vol.volume } }
        if (choiceMinVol !== Infinity) {
          for (const vol of outline.volumes || []) {
            if (vol.volume < choiceMinVol) continue
            const chs = (vol.chapters || []).slice().sort((a, b) => a.chapter_no - b.chapter_no)
            if (chs.length && !chs[0].choice_axis) issues.push('卷 ' + vol.volume + ' 卷首章（' + chs[0].chapter_no + '）缺 choice_axis（ADR-034：戏剧选择代价清单应随卷首章纲存档）')
          }
        }
      }
      // 锚参核对（P2 起生效）：书内出现过 anchor_params 才启用（存量书不误报）
      let anchorsAdopted = false
      for (const vol of outline.volumes || []) { for (const c of vol.chapters || []) { if (c.anchor_params) anchorsAdopted = true } }
      if (anchorsAdopted) {
        for (const vol of outline.volumes || []) {
          const chs = (vol.chapters || []).slice().sort((a, b) => a.chapter_no - b.chapter_no)
          if (chs.length && !chs[0].anchor_params) issues.push('卷 ' + vol.volume + ' 卷首章（' + chs[0].chapter_no + '）缺锚参 anchor_params（P2 拆书参数应随纲落位）')
          for (const c of chs) {
            const ww = c.anchor_params && c.anchor_params.word_window
            if (Array.isArray(ww) && ww.length === 2 && c.chapter_no > cur - 10 && chapters.includes(c.chapter_no)) {
              const t = await fs.readText(await fs.resolve(pth(dir, 'manuscript') + '/' + chapterFile(c.chapter_no)))
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
        warnings,
        stats: Object.assign(
          { current_ch: cur, chapters_written: chapters.length, foreshadows_open: (fsh.foreshadows || []).filter((f) => f.status !== 'closed').length, status: statusDist },
          // 书目终结态随 stats 出（智能体一眼能看到"这本是封存的"），不塞进 issues/warnings
          project.sealed ? { book_status: project.status, sealed: { at: project.sealed.at, reason: project.sealed.reason, retired: (project.sealed.retired_chapters || []).length } } : {},
        ),
      }
    },
  },

  // 5.5 novel_count：只读字数核数。工具本身不设角色限制，但 preset deny 名单按角色收口
  // （2026-09-05 对齐实测：写手/策划/档案员可调；试读/校准/校对被 deny——盲角色不核字数，防非盲信号渗入）。
  // 〔2026-09-18 口径收敛〕上句的"写手/策划"即今日的**主笔**——两职能已合并为一，此处保留的是历史实测的原名，判定等价。
  // 由来（2026-09-01 实测）：写手自报字数虚高 37%-63%（17150 自报 vs 10506 实测），
  // 模型心算不可信；字数唯一可信口径 = 工具数 [\u4e00-\u9fff]。给子代理一个免 deny 的自核入口。
  {
    name: 'novel_count',
    description: '只读字数核数（不写任何文件，写手/试读员/校对员均可用）：按 novel_chapter 同口径 [\\u4e00-\\u9fff] 数汉字。交付前自核、验收核数一律用它——模型自报字数不可信（实测虚高 37%-63%）。两种模式：①文本模式（file 或 text）数一段文本；②进度模式（带 book_dir）数整本书——逐章汉字 + 合计 + 与章纲字数区间的对照（哪章超窗/欠量一眼可见）。',
    parameters: {
      type: 'object',
      properties: {
        file: { type: 'string', description: '可选（文本模式）：待数文本文件的绝对路径（与 text 二选一）' },
        text: { type: 'string', description: '可选（文本模式）：直接携带待数文本（与 file 二选一）' },
        book_dir: { type: 'string', description: '可选（进度模式）：书目录绝对路径（可传 "@last"）。给了就数全书并对照章纲区间，此时不要给 file/text。' },
      },
      additionalProperties: false,
    },
    output: {
      schema: { type: 'object', properties: { han: { type: 'number' }, bytes: { type: 'number' }, lines: { type: 'number' }, source: { type: 'string' }, book_dir: { type: 'string' }, chapters: { type: 'number' }, total: { type: 'number' }, detail: { type: 'array', items: { type: 'object', additionalProperties: true } } }, additionalProperties: false },
      render: (a, v) => textBlock(v.detail
        ? '全书 ' + v.chapters + ' 章 / 合计 ' + v.total + ' 汉字' + (v.detail.some((d) => d.in_range === false) ? '；超窗或欠量：' + v.detail.filter((d) => d.in_range === false).map((d) => 'ch' + d.ch + '(' + d.han + ')').join('、') : '')
        : '汉字 ' + v.han + ' / 字节 ' + v.bytes + ' / 行 ' + v.lines + '（口径 [\\u4e00-\\u9fff]，来源 ' + v.source + '）'),
    },
    async execute(args, exec) {
      const fs = exec.agent.ctx && exec.agent.ctx.get ? exec.agent.ctx.get('fs') : undefined
      // 进度模式：带 book_dir 就数整本书并与章纲字数区间对照。
      // 为什么合进这个工具而不是新开一个：字数口径必须唯一（交付前自核、验收核数都用它），
      // 开第二个计数器就等于制造两套口径——那正是"模型自报字数不可信"的成因。
      if (args.book_dir != null) {
        if (args.file || args.text) throw fail(ERR.BAD_ARG, 'book_dir 与 file/text 不能同时给', '数整本书只给 book_dir；数单段文本只给 file 或 text')
        if (!fs) throw fail(ERR.PRECONDITION, 'fs 服务不可用', '工具执行需要宿主注入 fs 服务；当前执行上下文里拿不到')
        const dir = await requireBook(fs, bookRootOf(args))
        const outline = (await loadJson(fs, dir, 'outline.json')) || { volumes: [] }
        const range = new Map()
        for (const vol of outline.volumes || []) for (const e of (vol.chapters || [])) range.set(e.chapter_no, e)
        let entries = []
        try { entries = await fs.listDir(await fs.resolve(pth(dir, 'manuscript'))) } catch (e) { /* 还没写正文 */ }
        const detail = []
        let total = 0
        for (const name of (entries || []).map((e) => e.name).filter((n) => /^chapter_\d+\.md$/.test(n)).sort()) {
          const ch = Number(name.slice(8, -3))
          const han = countHan(await fs.readText(await fs.resolve(pth(dir, 'manuscript') + '/' + name)))
          const r = range.get(ch)
          const hasRange = r && r.word_min != null && r.word_max != null
          total += han
          detail.push({ ch, han, word_min: r ? r.word_min : null, word_max: r ? r.word_max : null, in_range: hasRange ? (han >= r.word_min && han <= r.word_max) : null })
        }
        return { book_dir: dir, chapters: detail.length, total, detail }
      }
      let text = null
      let source = 'text'
      if (args.file) {
        if (!fs) throw fail(ERR.PRECONDITION, 'fs 服务不可用', 'file 模式需要宿主注入 fs 服务')
        text = await fs.readText(await fs.resolve(String(args.file)))
        source = String(args.file)
      } else if (args.text != null) {
        text = String(args.text)
      } else {
        throw fail(ERR.BAD_ARG, 'file 与 text 必须二选一')
      }
      return {
        han: countHan(text),
        bytes: Buffer.byteLength(text, 'utf8'),
        lines: text.split('\n').length,
        source,
      }
    },
  },

  // 5.6 novel_guide：机制手册的工具入口（只读，零参数）
  //
  // 为什么需要一个工具来取手册，而不是只靠 MCP 的 initialize.instructions：
  // 服务端**确实**把 guide 放在 initialize 的 instructions 字段里（长度随 guide 版本增长，v7.13 时约 12k 字符——**不要写死数字**，旧注释里那个"11436"是更早版本的值，2026-09-18 审计据它误判过一次），
  // 但 MCP 规范里客户端**是否**把它放进模型上下文由客户端决定——实测腾讯 WorkBuddy 就不回灌，
  // 于是模型手里有 14 个工具却不知道每章流程、状态机合法值、v7.10 钩子账怎么用。
  // 工具列表则是**一定会**进上下文的：给手册一个工具入口，任何宿主都有一条可靠通道。
  // （DSH 侧另有 systemPrompt 注入，那条路不需要本工具；本工具主要服务非 DSH 宿主。）
  {
    name: 'novel_guide',
    description: '取 novelist 机制手册全文（每章工作流/三原语/状态机合法值/事件带与钩子账纪律/批审协议/派工分工/盲读红线）。**接手任何 novelist 任务前先调一次**——宿主不一定把指南注入上下文（MCP 的 initialize.instructions 由客户端决定是否采用）。返回的就是插件同版注入的那份文本，无副本、无删节。',
    parameters: { type: 'object', properties: {}, required: [] },
    output: {
      schema: { type: 'object', properties: { name: { type: 'string' }, chars: { type: 'number' }, text: { type: 'string' } }, additionalProperties: false },
      render: (a, v) => textBlock(v.text),
    },
    async execute() {
      return { name: SECTION.name, chars: SECTION.text.length, text: SECTION.text }
    },
  },

  // 6. novel_ledger：台账定向增改 + 冲突仲裁
  {
    name: 'novel_ledger',
    timeoutMs: WRITE_TIMEOUT_MS,
    description: '台账定向操作。**op=seal_book 封存/废弃书目**（终结态的账务表示：写终结态 + 登记退役章；此前账本没有表达"这本书不写了"的词，于是这个决定只能走到文件系统上而账本一无所知——《第七封》28 章被移出 manuscript/ 后账本仍说"存稿"、verify 长期红灯。**根因不是人不受约束，是账本缺这类词**）。op=update_character 增改人物卡（值冲突不静默，返回 conflict 需 resolve_conflict 仲裁后才生效）；op=update_term 增改设定词条；op=update_foreshadow 伏笔策展（改 due_ch/名/planted_ch，重排卷纲与弧审坐标纠偏用）；op=resolve_conflict 落仲裁（两分法：semantic=编辑部证据裁决不 ask / authority=Owner 权责裁决走 ask 且否决必带理由）；op=close_foreshadow 手动闭伏笔；op=set_chapter_status 章状态机迁移；**op=arc_review 落弧审结构化账单**（editorial/arcs.jsonl，append-only）——把弧审从散文报告变成可被仪器读的数据：承重点章号/价值翻转/伏笔收支对/差异化是否落地/在轨还是漂移，伏笔 id 与承重点章号做确定性核对（引用不存在的伏笔＝拒收）。',
    parameters: bookDirParam({
      properties: {
        op: { type: 'string', enum: ['update_character', 'update_term', 'update_foreshadow', 'resolve_conflict', 'close_foreshadow', 'set_chapter_status', 'arc_review', 'seal_book'], description: '操作类型' },
        reason: { type: 'string', description: 'op=seal_book 必填：封存/废弃的理由（无理由的终结在账上不允许关闭）' },
        seal_status: { type: 'string', enum: ['sealed', 'abandoned'], description: 'op=seal_book 可选：sealed=封存留档（缺省）／abandoned=废弃' },
        retired_chapters: { type: 'array', items: { type: 'integer' }, description: 'op=seal_book 可选：被退役的章号列表——**登记过的缺正文不再是缺陷**（未登记的缺仍报，静默依然失败）' },
        arc: {
          type: 'object', additionalProperties: true,
          description: 'op=arc_review 必填：{ volume 卷号, arc 弧名, ch_from, ch_to 起止章, load_bearing_ch 承重点章号（须在起止区间内）, reversal 价值翻转（什么从什么变成什么）, differentiation 差异化是否真落地, verdict 在轨|漂移|待定, evidence 证据坐标, reviewer 审查者, plant_harvest 可选=[{id 伏笔id}] 本弧的埋收对 }',
        },
        character: { type: 'object', additionalProperties: true, description: 'update_character 时：{ name, gender?, identity?, want?, opposed_by?, effective_from_ch?, effective_to_ch?, evidence_ch? }。want=贯穿欲求（全书级一句话：这个人物到底要什么）；opposed_by=主要压力来源（人物名或势力名）——**人物欲望必须进账**，否则"凭账本重建工作状态"重建不出欲望（guide 铁律），长篇最典型的死法是主角连续多章没有想要的东西。窗口字段语义见 update_term。' },
        term: { type: 'object', additionalProperties: true, description: 'update_term 时：{ name, value, effective_from_ch?, effective_to_ch?, evidence_ch? }。**生效窗语义（2026-09-18）**：同一名字可有**多条版本记录**——窗口不重叠的新值是"口径演进"，追加一条（旧窗口与旧值原样保留，按 ch 投影各取各的）；窗口重叠且值不同才是真冲突，走 resolve_conflict。缺窗口字段＝全书窗（旧账本行为不变）。' },
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
      if (!fs) throw fail(ERR.PRECONDITION, 'fs 服务不可用', '工具执行需要宿主注入 fs 服务；当前执行上下文里拿不到')
      const dir = bookRootOf(args)
      if (args.op === 'update_foreshadow') {
        // 伏笔策展（2026-09-01 拆章战役加）：重排卷纲/节奏调整后改 due_ch、改名。
        // 只改字段不开闭（开闭走 seeds/closes/close_foreshadow）；改动记事件账。
        const fsh = await loadJson(fs, dir, 'foreshadows.json') || { foreshadows: [] }
        const f = fsh.foreshadows.find((x) => x.id === args.foreshadow_id)
        if (!f) throw fail(ERR.NOT_FOUND, '伏笔不存在：' + args.foreshadow_id)
        const before = { due_ch: f.due_ch, name: f.name, planted_ch: f.planted_ch }
        if (args.due_ch != null) {
          if (!Number.isInteger(args.due_ch) || args.due_ch < 1) throw fail(ERR.BAD_ARG, 'due_ch 需为正整数')
          f.due_ch = args.due_ch
        }
        if (args.planted_ch != null) {
          if (!Number.isInteger(args.planted_ch) || args.planted_ch < 1) throw fail(ERR.BAD_ARG, 'planted_ch 需为正整数')
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
        if (!f) throw fail(ERR.NOT_FOUND, '伏笔不存在：' + args.foreshadow_id)
        f.status = 'closed'; f.closed_ch = f.closed_ch || (await loadJson(fs, dir, 'project.json') || { current_ch: 0 }).current_ch
        await saveJson(fs, dir, 'foreshadows.json', fsh)
        await appendEvent(fs, dir, { op: 'foreshadow_close', id: args.foreshadow_id, reason: args.note || undefined })
        return { ok: true, result: { closed: args.foreshadow_id } }
      }
      if (args.op === 'arc_review') {
        // 弧审账单：弧级审查的**结构化产出**。报告（reports/弧审-卷X-弧Y.md）仍然是给人读的，
        // 但结论必须同时落成数据——否则"这个弧承重点在第几章""伏笔收支对不对"每次都得重新通读全卷，
        // 而且没法被仪器消费（structure-check 的承重章标记就吃这份账）。
        const a = args.arc
        if (!a || typeof a !== 'object' || Array.isArray(a)) throw fail(ERR.BAD_ARG, 'arc_review 需要 arc 对象', '见工具描述里的字段清单')
        const need = ['volume', 'arc', 'ch_from', 'ch_to', 'load_bearing_ch', 'reversal', 'differentiation', 'verdict', 'evidence', 'reviewer']
        const missing = need.filter((k) => a[k] == null || String(a[k]).trim() === '')
        if (missing.length) throw fail(ERR.BAD_ARG, 'arc_review 缺字段：' + missing.join('/'), '弧审三问必须逐条结构化落账（弧线在轨还是漂移=verdict／伏笔收支=plant_harvest／差异化是否真落地=differentiation），不接受"报告里写了"')
        if (!Number.isInteger(a.volume) || a.volume < 1) throw fail(ERR.BAD_ARG, 'arc.volume 需为正整数（got ' + a.volume + '）')
        for (const k of ['ch_from', 'ch_to', 'load_bearing_ch']) {
          if (!Number.isInteger(a[k]) || a[k] < 1) throw fail(ERR.BAD_ARG, 'arc.' + k + ' 需为正整数（got ' + a[k] + '）')
        }
        if (a.ch_from > a.ch_to) throw fail(ERR.BAD_ARG, 'arc.ch_from 不得大于 ch_to（' + a.ch_from + ' > ' + a.ch_to + '）', '弧的起止章写反了')
        if (a.load_bearing_ch < a.ch_from || a.load_bearing_ch > a.ch_to) {
          throw fail(ERR.BAD_ARG, 'arc.load_bearing_ch=' + a.load_bearing_ch + ' 不在弧区间 [' + a.ch_from + ',' + a.ch_to + '] 内', '承重点必须是本弧的某一章——它定义了"这个弧靠哪一章立住"')
        }
        if (!['在轨', '漂移', '待定'].includes(a.verdict)) throw fail(ERR.BAD_ARG, 'arc.verdict 必须是 在轨/漂移/待定（got ' + a.verdict + '）', '三问第一问的答案是三选一，不接受自由文本——自由文本没法聚合')
        // 伏笔收支对：引用的 id 必须是真伏笔（引用不存在的 id = 一份没法对账的账单，与伪引文同类）
        const fshA = await loadJson(fs, dir, 'foreshadows.json') || { foreshadows: [] }
        const harvest = []
        for (const h of (a.plant_harvest || [])) {
          const id = String(h && h.id ? h.id : h)
          const f = (fshA.foreshadows || []).find((x) => x.id === id)
          if (!f) throw fail(ERR.NOT_FOUND, 'arc.plant_harvest 引用未知伏笔 id：' + id, '先 novel_ask kind=foreshadows 或 novel_event read 核对真实 id')
          harvest.push({ id, name: f.name ?? null, planted_ch: f.planted_ch ?? null, closed_ch: f.closed_ch ?? null, status: f.status ?? null })
        }
        const rec = {
          ts: new Date().toISOString(), volume: a.volume, arc: String(a.arc), ch_from: a.ch_from, ch_to: a.ch_to,
          load_bearing_ch: a.load_bearing_ch, reversal: String(a.reversal), differentiation: String(a.differentiation),
          verdict: a.verdict, evidence: String(a.evidence), reviewer: String(a.reviewer), plant_harvest: harvest,
        }
        if (a.note) rec.note = String(a.note).slice(0, 120)
        const r = await appendJsonlLine(fs, arcsFile(dir), JSON.stringify(rec))
        await appendEvent(fs, dir, { op: 'arc_review', volume: a.volume, arc: rec.arc, load_bearing_ch: a.load_bearing_ch, verdict: a.verdict })
        return { ok: true, result: { recorded: rec.arc, volume: rec.volume, load_bearing_ch: rec.load_bearing_ch, verdict: rec.verdict, plant_harvest: harvest.length, mode: r.mode } }
      }
      if (args.op === 'seal_book') {
        // 封存（书目终结态的**账务表示**）。
        //
        // 为什么需要这个 op：账本此前没有"这本书不写了"的表达方式，于是这个决定只能走到文件系统上
        // （把正文挪走），而账本对此一无所知——《第七封》28 章被移进 废稿-2026-09-16/ 后，
        // status.json 仍写"存稿"、project.json 仍 drafting、事件带带尾停在 08 天，verify 长期红灯。
        // **根因不是"人不受约束"，是账本没有表达这类事实的词**；没有词，决定就只能在带外发生。
        //
        // 语义：写入终结态 + **登记被退役的章**（登记过的缺正文不再是缺陷，未登记的缺仍报——
        // 静默依然失败，只是"有据的缺"与"无据的缺"被区分开了）。
        const reason = String(args.reason || args.note || '').trim()
        if (!reason) throw fail(ERR.BAD_ARG, 'seal_book 必填 reason', '封存是一次决定性动作，必须留下"为什么"——无理由的终结在账上不允许关闭')
        const status = String(args.seal_status || 'sealed')
        if (!['sealed', 'abandoned'].includes(status)) throw fail(ERR.BAD_ARG, 'seal_status 只能是 sealed（封存留档）或 abandoned（废弃）')
        const retired = (args.retired_chapters || []).map(Number).filter((n) => Number.isInteger(n) && n > 0)
        const proj = await loadJson(fs, dir, 'project.json') || {}
        if (proj.sealed) throw fail(ERR.CONFLICT, '本书已封存于 ' + proj.sealed.at, '封存不可重复；如需续写先 novel_decide 显式解封并记理由')
        const stj = await loadJson(fs, dir, 'status.json') || {}
        // 被退役的章：**保留原状态**（它确实曾经写完过），另在 sealed 块登记退役事实——
        // 不把章状态改成"没写过"，那是改写历史；退的是"它现在不在 manuscript/ 里"这件事。
        const onDisk = new Set()
        try { for (const e of (await fs.listDir(await fs.resolve(pth(dir, 'manuscript')))) || []) { const m = e.name.match(/^chapter_(\d+)\.md$/); if (m) onDisk.add(Number(m[1])) } } catch (e) { /* 无目录 */ }
        proj.status = status
        proj.sealed = {
          at: new Date().toISOString(), reason, retired_chapters: retired.sort((a, b) => a - b),
          still_on_disk: [...onDisk].sort((a, b) => a - b),
          note: args.note ? String(args.note) : undefined,
        }
        if (proj.sealed.note === undefined) delete proj.sealed.note
        await saveJson(fs, dir, 'project.json', proj)
        await appendEvent(fs, dir, { op: 'book_seal', status, reason, retired_count: retired.length, still_on_disk: proj.sealed.still_on_disk })
        await appendTape(fs, dir, { kind: 'decision', what: '封存：' + reason.slice(0, 40), why: '书目终结态（退役 ' + retired.length + ' 章，盘上留 ' + onDisk.size + ' 章）', actor: String(args.actor || '主编') })
        return { ok: true, result: { status, retired: retired.length, still_on_disk: proj.sealed.still_on_disk, unregistered_status_rows: Object.keys(stj).map(Number).filter((n) => !retired.includes(n) && !onDisk.has(n)).sort((a, b) => a - b) } }
      }
      if (args.op === 'set_chapter_status') {
        const to = args.status
        if (!CHAPTER_STATES.includes(to)) throw fail(ERR.BAD_ARG, '未知状态：' + to + '（合法：' + CHAPTER_STATES.join('/') + '）')
        if (!Number.isInteger(args.ch) || args.ch < 1) throw fail(ERR.BAD_ARG, 'set_chapter_status 需要 ch（正整数）')
        const st = await loadJson(fs, dir, 'status.json') || {}
        const from = st[args.ch] || '草稿'
        if (from !== to && !(CHAPTER_TRANSITIONS[from] || []).includes(to)) {
          throw fail(ERR.PRECONDITION, '非法状态迁移：' + from + ' → ' + to + '（合法去向：' + ((CHAPTER_TRANSITIONS[from] || []).join('/') || '无') + '）')
        }
        st[args.ch] = to
        await saveJson(fs, dir, 'status.json', st)
        await appendEvent(fs, dir, { op: 'chapter_status', ch: args.ch, from, to, note: args.note || null })
        return { ok: true, result: { ch: args.ch, from, to } }
      }
      if (args.op === 'resolve_conflict') {
        const c = args.conflict || {}
        if (!c.id) throw fail(ERR.BAD_ARG, 'resolve_conflict 需要 conflict.id')
        // 〔2026-09-18 审计修复〕verdict 白名单 + 冲突 id 存在性。
        // 旧实现两者都不校验：随便传个 id 也回 ok:true 并写一条"已裁决"的事件账——
        // "改了台账"与"什么都没改"在返回值上不可区分，调用方以为裁决生效了。
        if (c.verdict !== 'accept_new' && c.verdict !== 'keep_old') {
          throw fail(ERR.BAD_ARG, 'resolve_conflict 的 verdict 只能是 accept_new 或 keep_old（实得：' + String(c.verdict) + '）',
            '两分法下的裁决必须明确"采信新值"还是"维持旧值"')
        }
        if (c.scope !== 'semantic' && c.scope !== 'authority') throw fail(ERR.BAD_ARG, 'resolve_conflict 需要 conflict.scope（两分法）', 'semantic=语义/事实冲突（编辑部证据裁决）｜authority=权责/商业冲突（Owner 裁）')
        if (c.scope === 'semantic' && !c.stance) throw fail(ERR.BAD_ARG, '语义类裁决必须带编辑部立场 stance', '编辑部先立场，不拿 Owner 拍板当懒政挡箭牌')
        if (c.scope === 'semantic' && !c.evidence) throw fail(ERR.BAD_ARG, '语义类裁决必须带证据坐标 evidence', '章号/伏笔 id/事件账条目')
        if (c.scope === 'authority' && !c.reason) throw fail(ERR.BAD_ARG, '权责类裁决必须带理由 reason', 'ADR 铁律：无理由的否决在账上不允许关闭')
        // 裁决生效闭环：accept_new 时把冲突值写回台账——否则冲突值永远无法经工具变更（死锁）
        // ⚠ 维护警示：回写分支是 conflict kind 白名单（现=character_gender/term_value）——
        // update_character/update_term 之外新增冲突产生点时必须同步此处的回写分支，否则新 kind 裁决胜诉也无法生效
        // 〔2026-09-18 审计修复〕冲突 id 必须真实存在——否则 ok:true 会把 no-op 报成"裁决已生效"
        const conf = (await readEvents(fs, dir))
          .map((l) => { try { return JSON.parse(l) } catch (e) { return null } })
          .filter((e) => e && e.op === 'conflict' && e.id === c.id).pop()
        if (!conf) {
          throw fail(ERR.NOT_FOUND, '未知的冲突 id：' + c.id,
            '只有账上存在一条未裁决的 conflict 事件才能仲裁（novel_ledger op=update_character/update_term 触发冲突时返回的 id 才是有效的）')
        }
        if (c.verdict === 'accept_new') {
          if (conf.kind === 'character_gender') {
            const cj2 = await loadJson(fs, dir, 'characters.json') || { characters: [] }
            const ch2 = cj2.characters.find((x) => x.name === conf.name)
            if (ch2) { ch2.gender = conf.new; await saveJson(fs, dir, 'characters.json', cj2) }
          } else if (conf.kind === 'term_value') {
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
        if (!c || !c.name) throw fail(ERR.BAD_ARG, 'update_character 需要 character.name')
        const sameName = cj.characters.filter((x) => x.name === c.name)
        // 真冲突＝窗口重叠且性别不同（不重叠＝人设演进，照常落账；无窗字段＝全书窗）
        const clash = sameName.find((x) => windowsOverlap(x, c) && x.gender && c.gender && x.gender !== c.gender)
        if (clash) {
          const conflictId = 'c_' + Date.now()
          await appendEvent(fs, dir, { op: 'conflict', id: conflictId, scope: 'semantic', kind: 'character_gender', name: c.name, old: clash.gender, new: c.gender })
          return { ok: false, result: { conflict: { id: conflictId, kind: 'character_gender', name: c.name, old: clash.gender, new: c.gender, message: '性别与既有人物卡在同一生效窗内冲突，请 resolve_conflict 仲裁' } } }
        }
        const target = sameName.find((x) => windowsOverlap(x, c))
        if (target) Object.assign(target, sanitizeOwn(c)); else cj.characters.push(sanitizeOwn(c))
        await saveJson(fs, dir, 'characters.json', cj)
        await appendEvent(fs, dir, { op: 'character_update', name: c.name })
        return { ok: true, result: { saved: c.name, versioned: !target } }
      }
      if (args.op === 'update_term') {
        const bible = await loadJson(fs, dir, 'bible.json') || { terms: [] }
        const t = args.term
        if (!t || !t.name) throw fail(ERR.BAD_ARG, 'update_term 需要 term.name')
        const sameName = bible.terms.filter((x) => x.name === t.name)
        const clash = sameName.find((x) => windowsOverlap(x, t) && x.value && t.value && x.value !== t.value)
        if (clash) {
          const conflictId = 't_' + Date.now()
          await appendEvent(fs, dir, { op: 'conflict', id: conflictId, scope: 'semantic', kind: 'term_value', name: t.name, old: clash.value, new: t.value })
          return { ok: false, result: { conflict: { id: conflictId, kind: 'term_value', name: t.name, old: clash.value, new: t.value, message: '词条值在同一生效窗内冲突，请 resolve_conflict 仲裁（若这是口径演进，请给新值一个不重叠的 effective_from_ch）' } } }
        }
        const target = sameName.find((x) => windowsOverlap(x, t))
        if (target) Object.assign(target, sanitizeOwn(t)); else bible.terms.push(sanitizeOwn(t))
        await saveJson(fs, dir, 'bible.json', bible)
        await appendEvent(fs, dir, { op: 'term_update', name: t.name })
        return { ok: true, result: { saved: t.name, versioned: !target } }
      }
      throw fail(ERR.BAD_ARG, '未知 op：' + args.op)
    },
  },

  // 6.5 novel_event：事件带（编排层记忆，0.4.0 新增——V3 P1）
  {
    name: 'novel_event',
    timeoutMs: 120000,
    description: '事件带（编辑部编排记忆，book_dir/editorial/events-tape.jsonl）：记"为什么这么干+判了什么+还欠什么"。与 events.jsonl 分工：账本事件=发生了什么（工具口径自动记）；事件带=决策理由/判词/修订/欠线/钩子/checkpoint（编辑部口径）。op=append 追加（what/why 各≤60 字，open_thread 必带 closes 预期章，hook 不接受 closes）；op=read 有界窗口（近 12 条全量＋open_thread/checkpoint 永不摘要＋更早计数＋**未闭欠线 open_threads＋未闭钩子 open_hooks**；hook/payoff 每章各一条，只计数不占窗口）。闭线（欠线与钩子共用 closes_thread 对账防重复）。**钩子一般不必直接调本工具**：随章落带走 novel_chapter 的 hook/pays_hooks。注入规则：主笔=主编任务书内注摘要段（工具面 deny）；试读员/校准员/校对员禁看（盲读红线）；档案员可 read。主编压缩触发前记 checkpoint=抗压缩记忆，兼批级断点续跑锚。',
    parameters: bookDirParam({
      properties: {
        op: { type: 'string', enum: ['append', 'read'], description: 'append=追加一条；read=读有界窗口' },
        kind: { type: 'string', description: 'append 时必填：decision|verdict|revision|open_thread|hook|payoff|checkpoint（hook=章末钩子，无期限；payoff=兑现某条钩子/欠线，须带 closes_thread）' },
        ch: { type: 'integer', description: 'append 时可选：关联章号' },
        what: { type: 'string', description: 'append 时必填：做了/判了什么（≤60 字）' },
        why: { type: 'string', description: 'append 时必填：为什么（≤60 字）' },
        ref: { type: 'string', description: 'append 时可选：关联工件（orders/board/报告路径或伏笔 id）' },
        actor: { type: 'string', description: 'append 时必填：记录者（主编/主笔/档案员…）' },
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
      if (!fs) throw fail(ERR.PRECONDITION, 'fs 服务不可用', '工具执行需要宿主注入 fs 服务；当前执行上下文里拿不到')
      const dir = bookRootOf(args)
      if (args.op === 'append') return appendTape(fs, dir, args)
      return readTapeWindow(fs, dir)
    },
  },

  // 6.6 novel_score：判据账（V3 P3·0.5.0 新增）——判官判词结构化落盘 scores.jsonl
  {
    name: 'novel_score',
    timeoutMs: 120000,
    description: '判据账：判官判词结构化落盘（book_dir/editorial/scores.jsonl）——仪器产出有家、回收环有数据底座。op=record 落一条：{ch, dim 维度, score 分, evidence 正文原句引文, judge 判官, mode}；**evidence 子串核验（硬闸）**：规范化标点/空白后必须命中该章 manuscript 正文，伪引文拒收（证据引用制从纪律升机器，审查批 F-2）。**版本绑定**：每条判词自动绑 ch_rev + content_hash（判的是哪一版正文）。op=read 按 ch/dim 过滤回读；**带 ch 时默认只回当前正文版本的判词**（改稿后旧版判词不再冒充当前版结论；include_stale=true 可连旧版一起取，逐条标 stale/legacy）。mode=absolute（绝对分 1-5）｜anchored_pair（锚书参照成对判：1=胜/0=平/-1=负）。写权=判官工位经主编转手或主编直录。z 不在工具算（instrument-aggregate 离线聚合出，防当拍脑袋）。',
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
        include_stale: { type: 'boolean', description: 'read 可选：连同旧版正文的判词一起回读（逐条标 stale）；缺省 false=只回当前版' },
      },
      required: ['book_dir', 'op'],
    }),
    output: {
      schema: { type: 'object', properties: { ok: { type: 'boolean' }, id: { type: 'string' }, records: { type: 'array' }, total: { type: 'integer' }, rejected: { type: 'string' } }, additionalProperties: false },
      render: (a, v) => renderJson(v),
    },
    async execute(args, exec) {
      const fs = exec.agent.ctx && exec.agent.ctx.get ? exec.agent.ctx.get('fs') : undefined
      if (!fs) throw fail(ERR.PRECONDITION, 'fs 服务不可用', '工具执行需要宿主注入 fs 服务；当前执行上下文里拿不到')
      const dir = bookRootOf(args)
      const scoreFile = pth(dir, 'scores')
      if (args.op === 'record') {
        if (!Number.isInteger(args.ch) || args.ch < 1) throw fail(ERR.BAD_ARG, 'ch 必填（正整数）')
        if (!args.dim) throw fail(ERR.BAD_ARG, 'dim 必填（维度）')
        if (!args.judge) throw fail(ERR.BAD_ARG, 'judge 必填')
        const mode = args.mode || 'absolute'
        if (mode === 'absolute' && (!(args.score >= 1 && args.score <= 5))) throw fail(ERR.BAD_ARG, 'absolute 模式 score 取 1-5')
        if (mode === 'anchored_pair' && ![-1, 0, 1].includes(args.score)) throw fail(ERR.BAD_ARG, 'anchored_pair 模式 score 取 -1/0/1')
        const ev = String(args.evidence || '')
        if (!ev) throw fail(ERR.BAD_ARG, 'evidence 必填', '证据引用制：无引文判词无效')
        // 子串核验（F-2 硬闸）：规范化后必须命中该章正文
        const STRIP_RE = /[\s，。、；：？！""''（）《》【】…—\-·~\u3000,.:;?!"'()<>[\]]/g
        const norm = (s) => s.replace(STRIP_RE, '')
        const nev = norm(ev)
        if (nev.length < 6) throw fail(ERR.BAD_ARG, 'evidence 规范化后不足 6 字（引文过短无法核验）')
        const msTarget = await fs.resolve(pth(dir, 'manuscript') + '/' + chapterFile(args.ch))
        const st = await fs.stat(msTarget)
        if (!st) throw fail(ERR.NOT_FOUND, '该章正文不存在：' + args.ch, '先落稿再判分')
        const rawBody = await fs.readText(msTarget)
        const body = norm(rawBody)
        if (!body.includes(nev)) {
          return { ok: false, rejected: 'evidence 子串核验未命中该章正文（伪引文拒收——审查批 F-2 硬闸）：' + ev.slice(0, 30) + '…' }
        }
        // 版本绑定：判词绑"判的是哪一版正文"。hash 取自磁盘正文真身（不规范化——
        // 绑的就是那串字节）；rev 取自该章 done 回执且回执 hash 与正文一致（对不上=正文被绕过
        // 工具改动或半提交，rev 记 null 不冒充某版）。
        const curHash = sha256Hex(rawBody)
        const rc = await loadJson(fs, pth(dir, 'txn'), 'chapter_' + String(args.ch).padStart(3, '0') + '.json')
        const chRev = (rc && rc.status === 'done' && rc.content_hash === curHash && Number.isInteger(rc.rev)) ? rc.rev : null
        const rec = { ts: new Date().toISOString(), ch: args.ch, dim: String(args.dim), score: args.score, evidence: ev, judge: String(args.judge), mode, ch_rev: chRev, content_hash: curHash }
        if (args.note) rec.note = String(args.note).slice(0, 60)
        const r = await appendJsonlLine(fs, scoreFile, JSON.stringify(rec))
        return { ok: true, records: [rec], total: 1, id: 'append:' + r.mode }
      }
      // read（版本过滤）：带 ch 查询时默认只回"当前正文版本"的判词——改稿后旧版判词
      // 不再冒充当前版审稿结论；include_stale=true 可连同旧版一起取（逐条标 stale/legacy）。
      const lines = await readJsonlLines(fs, scoreFile)
      let recs = lines.map((l) => { try { return JSON.parse(l) } catch (e) { return null } }).filter(Boolean)
      if (args.ch != null) recs = recs.filter((x) => x.ch === args.ch)
      if (args.dim) recs = recs.filter((x) => x.dim === args.dim)
      if (args.ch != null) {
        const msTarget = await fs.resolve(pth(dir, 'manuscript') + '/' + chapterFile(args.ch))
        const st = await fs.stat(msTarget)
        const curHash = st ? sha256Hex(await fs.readText(msTarget)) : null
        recs = recs.map((x) => Object.assign({}, x, { legacy: !x.content_hash, stale: !(x.content_hash && curHash && x.content_hash === curHash) }))
        if (!args.include_stale) recs = recs.filter((x) => !x.stale)
      }
      return { ok: true, records: recs, total: recs.length }
    },
  },

  // 6.8 novel_ask：问账本原语（总蓝图 R1）——语义查询入口，代码替主编跑"查哪几个文件+拼过滤条件"
  {
    name: 'novel_ask',
    timeoutMs: 120000,
    description: '问账本原语（v7.0·R1 三原语之"问账本"）：一句语义问句路由到 characters/bible/foreshadows/timeline/status/事件带，代码组装带出处的答案（零 LLM、确定性）。擅答：①实体卡（人物/设定/伏笔，名字精确或包含匹配）②状态与进度总览（"写到哪/哪些章待改"）③时间线事件（"时间线/发生了什么"，按 ch 投影）④事件带近窗、未闭欠线**与未闭章末钩子**（"最近干了什么/还欠什么"；**supersedes 有效投影**：被作废条目不进窗口/欠线，撤销链单独可查）⑤伏笔逾期清单⑥**弧审账单**（"弧审/承重点/在轨"或 select.kind=arcs —— 承重点章号/价值翻转/伏笔收支对，见 v7.10）。**ch 参数=基准章投影**：时间线只回 ≤ch、人物 last_seen 按有效事实投影到 ≤ch（超前存稿不算当前账）。**select 结构化选择器**（可选，与 q 并存）做确定性取数：{entity 实体名 | kind=characters/bible/foreshadows/timeline/status/tape | window:{from,to}}。答不了的（好不好/语义判断）明说"不归账本答"。一次调用替代"bible 手填过滤+event read+verify 翻账"三次搬运。',
    parameters: bookDirParam({
      properties: {
        q: { type: 'string', description: '问句或实体名（如"小满"/"t019"/"现在写到哪了"/"未兑伏笔"）；与 select 至少给一个' },
        ch: { type: 'integer', description: '可选：基准章号（逾期/时间线/last_seen 一律按 ≤ch 投影，缺省=current_ch；不给 ch 时人物 last_seen 给全账真值）' },
        select: {
          type: 'object',
          additionalProperties: false,
          description: '可选：结构化选择器（确定性取数，不靠问句分词）',
          properties: {
            entity: { type: 'string', description: '实体名（等价 q 的实体匹配路径）' },
            kind: { type: 'string', enum: ['characters', 'bible', 'foreshadows', 'timeline', 'status', 'tape', 'arcs'], description: '按账本种类取数（arcs=弧审结构化账单）' },
            window: { type: 'object', additionalProperties: false, properties: { from: { type: 'integer' }, to: { type: 'integer' } }, description: '章号窗口（timeline 用；闭区间）' },
          },
        },
      },
      required: ['book_dir'],
    }),
    output: {
      schema: { type: 'object', properties: { ok: { type: 'boolean' }, q: { type: 'string' }, matches: { type: 'array', items: { type: 'object', additionalProperties: true } }, timeline: { type: 'array', items: { type: 'object', additionalProperties: true } }, overview: { type: 'object', additionalProperties: true }, note: { type: 'string' } }, additionalProperties: false },
      render: (a, v) => renderJson(v),
    },
    async execute(args, exec) {
      const fs = exec.agent.ctx && exec.agent.ctx.get ? exec.agent.ctx.get('fs') : undefined
      if (!fs) throw fail(ERR.PRECONDITION, 'fs 服务不可用', '工具执行需要宿主注入 fs 服务；当前执行上下文里拿不到')
      const dir = await requireBook(fs, bookRootOf(args))
      const sel = (args.select && typeof args.select === 'object') ? args.select : null
      const q = String(args.q || sel && sel.entity || '').trim()
      const kind = sel && sel.kind ? String(sel.kind) : null
      if (!q && !kind) throw fail(ERR.BAD_ARG, 'q 必填（问句或实体名）；或给 select.kind 结构化取数')
      // 书工程存在性闸：book_dir 打错时大声报错，不给"全零总览"的静默假象
      const proj = await loadJson(fs, dir, 'project.json')
      if (!proj) throw fail(ERR.NOT_FOUND, '书工程不存在（拒答空账本）：' + dir, '核对 book_dir 或先 novel_init')
      const cj = await loadJson(fs, dir, 'characters.json') || { characters: [] }
      const bible = await loadJson(fs, dir, 'bible.json') || { terms: [] }
      const fsh = await loadJson(fs, dir, 'foreshadows.json') || { foreshadows: [] }
      const tml = await loadJson(fs, dir, 'timeline.json') || { events: [] }
      const project = proj
      const statusJ = await loadJson(fs, dir, 'status.json') || {}
      const cur = Number.isInteger(args.ch) ? args.ch : (project.current_ch || 0)
      const chGiven = Number.isInteger(args.ch)
      // ① 实体匹配（人物/设定/伏笔；精确 > 包含，双方包含都认——中文实体名常被问句包裹）
      // select.kind 收窄匹配面：指定 kind 时只在该账本里找（结构化取数不吃其它账本的误命中）
      const matches = []
      const inChars = !kind || kind === 'characters'
      const inBible = !kind || kind === 'bible'
      const inFsh = !kind || kind === 'foreshadows'
      if (inChars) {
        for (const c of cj.characters) {
          if (c.name && (c.name === q || c.name.includes(q) || q.includes(c.name) || (c.identity && String(c.identity).includes(q)))) {
            matches.push({ source: 'characters.json', ref: c.name, card: Object.assign({}, c) })
          }
        }
      }
      if (inBible) {
        for (const t of bible.terms) {
          if (t.name && (t.name === q || t.name.includes(q) || q.includes(t.name) || String(t.value || '').includes(q))) {
            matches.push({ source: 'bible.json', ref: t.name, card: Object.assign({}, t) })
          }
        }
      }
      if (inFsh) {
        for (const f of fsh.foreshadows) {
          if (f.id === q || (f.name && (f.name.includes(q) || q.includes(f.name)))) {
            matches.push({ source: 'foreshadows.json', ref: f.id + ' ' + (f.name || ''), card: Object.assign({}, f) })
          }
        }
      }
      // ①b 基准章投影（ch 参数统一口径）：人物 last_seen 按"≤ch 的有效事实"给——
      // 超前写好的存稿不算"当前账"（旧实现直接回全账真值，把 ch20 的出场答进 ch10 的问）。
      // review 批修正：必须走 readFactDeclarations 的**稀疏声明投影**（省略 cast 的更高 rev
      // ≠ 删除），否则与 rebuildLastSeen 两套口径（同一次 omission 一边保留一边清空）。
      if (chGiven && matches.length) {
        const { chapters: decls } = await readFactDeclarations(fs, dir)
        const seen = new Map()
        if (decls.size) {
          for (const [fch, decl] of decls) {
            if (fch > cur) continue
            for (const nm of (decl.cast || [])) { if (fch > (seen.get(nm) || 0)) seen.set(nm, fch) }
          }
        }
        for (const m of matches) {
          if (m.source !== 'characters.json' || !Number.isInteger(m.card.last_seen_ch)) continue
          const full = m.card.last_seen_ch
          if (decls.size) {
            const proj = seen.has(m.card.name) ? seen.get(m.card.name) : null
            m.card.last_seen_ch = proj
            m.card.last_seen_ch_full = full
          } else if (full > cur) {
            m.card.last_seen_after_ch = true // 无贡献账（旧书）时不静默改数，标注"该值超出基准章"
          }
        }
      }
      // ② 总览（问句提到状态/进度/伏笔/事件带，或实体零命中时兜底给全景）
      const overview = { current_ch: cur }
      const wantsStatus = /状态|进度|写到哪|哪些章|待改|存稿|定稿/.test(q) || kind === 'status'
      const wantsFsh = /伏笔|欠线|未兑|未收|逾期/.test(q) || kind === 'foreshadows'
      const wantsTape = /最近|事件|带|干了什么|决策/.test(q) || kind === 'tape'
      const wantsTimeline = /时间线|大事记|发生了什么|什么时候|编年/.test(q) || kind === 'timeline'
      const wantsArc = /弧审|弧线|承重|在轨|漂移/.test(q) || kind === 'arcs'
      // 时间线：ch 给定=只回 ≤ch（存稿不算当前账）；select.window 再收窄（闭区间）
      let tlEvents = projectTimeline(tml.events, await currentRevsOf(fs, dir)).slice()
      if (chGiven) tlEvents = tlEvents.filter((e) => e.ch == null || e.ch <= cur)
      const win = sel && sel.window ? sel.window : null
      if (win) {
        if (Number.isInteger(win.from)) tlEvents = tlEvents.filter((e) => (e.ch == null ? 0 : e.ch) >= win.from)
        if (Number.isInteger(win.to)) tlEvents = tlEvents.filter((e) => (e.ch == null ? 0 : e.ch) <= win.to)
      }
      if (wantsStatus || matches.length === 0) {
        const dist = {}
        for (const k of Object.keys(statusJ)) dist[statusJ[k]] = (dist[statusJ[k]] || 0) + 1
        overview.chapter_status = dist
      }
      if (wantsFsh || matches.length === 0) {
        const open = (fsh.foreshadows || []).filter((f) => f.status === 'planted')
        overview.open_foreshadows = open.length
        overview.overdue = open.filter((f) => f.due_ch != null && f.due_ch < cur).map((f) => ({ id: f.id, name: f.name, due_ch: f.due_ch, planted_ch: f.planted_ch }))
      }
      // 总览里的 timeline 必须**有界**：显式问时间线才给全量，否则只给最近 N 条 + 总数 + 明报。
      // 旧实现是"问句含时间线关键词 **或** 实体零命中就倒全量"——于是问"现在写到哪了"也会拿回
      // 79 条时间线（实测 6872 字符，占该次返回 8820 字符总览的 78%）。事件带早就用粘性窗口
      // 解决过同一问题（hook/payoff 只计数不占窗口），这里是同一套设计语言补到 timeline 上。
      const TL_WINDOW = 12
      if (wantsTimeline) {
        overview.timeline = tlEvents
        overview.timeline_total = tlEvents.length
      } else if (matches.length === 0) {
        overview.timeline = tlEvents.slice(-TL_WINDOW)
        overview.timeline_total = tlEvents.length
        if (tlEvents.length > TL_WINDOW) {
          overview.timeline_note = '总览只给最近 ' + TL_WINDOW + ' 条（共 ' + tlEvents.length + ' 条）；要看全量或按窗口取，用 select{kind:"timeline"} 或 select{kind:"timeline",window:{from,to}}'
        }
      } else {
        overview.timeline_total = tlEvents.length
      }
      if (wantsTape || matches.length === 0) {
        const tape = await readTapeWindow(fs, dir)
        overview.tape_window = tape.window
        overview.open_threads = tape.open_threads
        // 未闭钩子：钩子不进窗口（每章一条会把画框占满），所以问"还欠什么"时单独带出来——
        // 账上记了却问不出来，等于没记。
        if (tape.open_hooks && tape.open_hooks.length) overview.open_hooks = tape.open_hooks
        if (tape.superseded_chain && tape.superseded_chain.length) overview.superseded_chain = tape.superseded_chain
      }
      const note = matches.length
        ? '实体命中 ' + matches.length + ' 条（出处见 source/ref）；总览按问句附送'
        : '无实体命中——附账本总览；"好不好/该怎么改"类语义判断不归账本答（走试读员/校准员/主编）'
      const ret = { ok: true, q, matches, overview, note }
      if (kind === 'timeline') ret.timeline = tlEvents
      if (wantsArc) ret.arcs = await readArcs(fs, dir)
      return ret
    },
  },

  // 6.7 novel_decide：裁决原语（总蓝图 R1/R5）——"说一句话，账自动动"
  {
    name: 'novel_decide',
    timeoutMs: 120000,
    description: '裁决原语（v6.7·R1 三原语之"做裁决"）：Owner 或主编的一句话裁决当场生效并落档（R5 裁决记账——说过的话下次不用说第二遍）。携带 target 时自动执行派生：target.ch+target.status=章状态机自动迁移（非法迁移拦）；target.foreshadow_id+target.due_ch=伏笔自动改期留痕。事件账+事件带双落（actor 必填：Owner|主编）。语义文本（修订单正文）仍由主编组织，本工具只管"裁决生效+落档"。',
    parameters: bookDirParam({
      properties: {
        ruling: { type: 'string', description: '必填：裁决一句话（≤120 字。如"ch7 细纲通过，按三行执行"/"这类节奏平，禁用"/"f2 改期，卷三再收"）' },
        actor: { type: 'string', description: '必填：裁决人（Owner|主编）——Owner 裁决是"好/不好"的唯一合法来源（R8）' },
        scope: { type: 'string', enum: ['semantic', 'authority'], description: '两分法：semantic=编辑部语义裁决 / authority=Owner 权责裁决' },
        ch: { type: 'integer', description: '可选：涉章号（与 status 搭配自动迁移状态）' },
        status: { type: 'string', description: '可选：目标章状态（合法值 ' + CHAPTER_STATES.join('/') + '）' },
        foreshadow_id: { type: 'string', description: '可选：涉伏笔 id（与 due_ch 搭配自动改期）' },
        due_ch: { type: 'integer', description: '可选：伏笔新到期章' },
        ref: { type: 'string', description: '可选：关联工件（细纲三行/呈报/日报路径）' },
        supersedes: { type: 'string', description: '可选（v7.4 撤销语义）：作废的事件带条目 id（如上一条裁决 t012）——append-only 不改历史，新条目引用旧条目即作废；聚合/消费端按 readTapeWindow 的 superseded_ids 过滤非活跃裁决（毒舌评审 实例3-#11）' },
        applicability: { type: 'string', enum: ['book', 'general', 'temp'], description: '可选：裁决作用域（主编改进方向4）——book=仅本书/general=跨书通则/temp=临时（R2 批处理器聚合时按作用域加权：general 全权重、book 限本书、temp 仅参考，防"这本的爽点误判那本"）' },
      },
      required: ['book_dir', 'ruling', 'actor'],
    }),
    output: {
      schema: { type: 'object', properties: { ok: { type: 'boolean' }, id: { type: 'string' }, applied: { type: 'array', items: { type: 'string' } }, deduped: { type: 'boolean' } }, additionalProperties: false },
      render: (a, v) => textBlock(v.ok ? '裁决已生效并落档（' + v.applied.join('；') + '）' : '裁决落档失败'),
    },
    async execute(args, exec) {
      const fs = exec.agent.ctx && exec.agent.ctx.get ? exec.agent.ctx.get('fs') : undefined
      if (!fs) throw fail(ERR.PRECONDITION, 'fs 服务不可用', '工具执行需要宿主注入 fs 服务；当前执行上下文里拿不到')
      const dir = bookRootOf(args)
      const ruling = String(args.ruling || '').trim()
      if (!ruling) throw fail(ERR.BAD_ARG, 'ruling 必填（裁决一句话）')
      if (ruling.length > 120) throw fail(ERR.BAD_ARG, 'ruling 超 120 字（当前 ' + ruling.length + '）')
      const actor = String(args.actor || '')
      if (actor !== 'Owner' && actor !== '主编') throw fail(ERR.BAD_ARG, 'actor 必填：Owner|主编')
      const applied = []
      // 双落档参数先算好（校验、幂等门、落档三段都要用）
      const tapeArgs = { kind: 'decision', what: ruling.slice(0, 60), why: (actor + ' 裁决·' + (args.scope || 'semantic') + '·' + (args.applicability || 'book')), actor }
      if (args.ch != null) tapeArgs.ch = args.ch
      if (args.ref) tapeArgs.ref = String(args.ref)
      if (args.supersedes) tapeArgs.supersedes = String(args.supersedes)

      // ── 阶段一：全部校验先行 ────────────────────────────────────────────────
      // 为什么（2026-09-19 decide 故障点实测）：旧实现"派生①写盘 → 派生②才校验"，
      // ②抛错时 status.json 已被改而裁决没落档——**部分应用且无任何回执可查**，
      // verify 也看不见。改后：任何一笔写盘之前，所有可失败的判定先做完——
      // 要么全做，要么在第一笔写盘前就报错。
      let st, from, fsh, targetF, beforeDue
      if (args.ch != null && args.status) {
        const to = args.status
        if (!CHAPTER_STATES.includes(to)) throw fail(ERR.BAD_ARG, '未知状态：' + to + '（合法：' + CHAPTER_STATES.join('/') + '）')
        if (!Number.isInteger(args.ch) || args.ch < 1) throw fail(ERR.BAD_ARG, 'ch 需为正整数')
        st = await loadJson(fs, dir, 'status.json') || {}
        from = st[args.ch] || '草稿'
        if (from !== to && !(CHAPTER_TRANSITIONS[from] || []).includes(to)) {
          throw fail(ERR.PRECONDITION, '非法状态迁移：' + from + ' → ' + to + '（合法去向：' + ((CHAPTER_TRANSITIONS[from] || []).join('/') || '无') + '）')
        }
      }
      if (args.foreshadow_id && args.due_ch != null) {
        if (!Number.isInteger(args.due_ch) || args.due_ch < 1) throw fail(ERR.BAD_ARG, 'due_ch 需为正整数')
        fsh = await loadJson(fs, dir, 'foreshadows.json') || { foreshadows: [] }
        targetF = fsh.foreshadows.find((x) => x.id === args.foreshadow_id)
        if (!targetF) throw fail(ERR.NOT_FOUND, '伏笔不存在：' + args.foreshadow_id)
        beforeDue = targetF.due_ch
      }
      let target
      if (args.supersedes) {
        const entries = await readTapeEntries(fs, dir)
        target = entries.find((e) => e.id === String(args.supersedes))
        if (!target) throw fail(ERR.NOT_FOUND, 'supersedes 引用未知事件带条目：' + args.supersedes, '先 novel_event op=read 对账')
        if (entries.some((e) => e.supersedes === target.id)) throw fail(ERR.CONFLICT, '条目 ' + target.id + ' 已被作废过', 'append-only：勿重复撤销；如需再改，用新裁决覆盖语义')
      }

      // ── 阶段二：重试幂等门（先于一切写盘）──────────────────────────────────
      // S8 给 novel_chapter 的 decision/hook 加了内容判等幂等；novel_decide 是同一
      // 写入形状却没接——同参重交会重复落一条裁决＋一条 owner_ruling 事件。
      // 同款修法：同 kind+ch+what 的**未作废**裁决已存在＝同参重交，不再写任何东西
      // （派生副作用本身幂等），返回原 id。崩在半途的重交在这里收敛。
      const pre = await readTapeEntries(fs, dir)
      const revoked = new Set(pre.filter((e) => e.supersedes).map((e) => e.supersedes))
      const dup = pre.find((e) => !revoked.has(e.id) && e.kind === tapeArgs.kind && (e.ch ?? null) === (tapeArgs.ch ?? null) && String(e.what) === String(tapeArgs.what))
      if (dup) return { ok: true, id: dup.id, applied: ['重试幂等：同内容裁决已落档 ' + dup.id + '，未重复执行'], deduped: true }

      // ── 阶段三：应用（此时已无任何"后面才会发现"的失败）────────────────────
      if (st) {
        const to = args.status
        st[args.ch] = to
        await saveJson(fs, dir, 'status.json', st)
        await appendEvent(fs, dir, { op: 'chapter_status', ch: args.ch, from, to, note: 'novel_decide 派生' })
        applied.push('章' + args.ch + ' 状态 ' + from + '→' + to)
      }
      if (targetF) {
        targetF.due_ch = args.due_ch
        await saveJson(fs, dir, 'foreshadows.json', fsh)
        await appendEvent(fs, dir, { op: 'foreshadow_update', id: args.foreshadow_id, before: { due_ch: beforeDue }, after: { due_ch: targetF.due_ch }, reason: 'novel_decide 派生：' + ruling.slice(0, 60) })
        applied.push('伏笔 ' + args.foreshadow_id + ' due ' + beforeDue + '→' + args.due_ch)
      }
      // 双落档：事件账 + 事件带（Owner 裁决=记账平面的第一等公民）
      await appendEvent(fs, dir, { op: actor === 'Owner' ? 'owner_ruling' : 'decision', ruling, scope: args.scope || null, ref: args.ref || null, applicability: args.applicability || 'book' })
      if (target) applied.push('作废 ' + target.id + '（' + String(target.what || '').slice(0, 30) + '）')
      const t = await appendTapeOnce(fs, dir, tapeArgs)
      applied.push('事件带 ' + t.id)
      return { ok: true, id: t.id, applied }
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
      if (!fs) throw fail(ERR.PRECONDITION, 'fs 服务不可用', '工具执行需要宿主注入 fs 服务；当前执行上下文里拿不到')
      const dir = await requireBook(fs, bookRootOf(args))
      const msDir = await fs.resolve(pth(dir, 'manuscript'))
      let files = []
      try { files = await fs.listDir(msDir) } catch (e) { throw fail(ERR.NOT_FOUND, '尚无正文（manuscript/ 不存在）：' + dir, '先 novel_chapter 落稿再汇编') }
      const chapters = files.map((e) => e.name).filter((n) => /^chapter_\d+\.md$/.test(n)).sort()
      if (!chapters.length) throw fail(ERR.NOT_FOUND, '尚无正文（manuscript/ 里没有 chapter_NNN.md）', '先 novel_chapter 落稿再汇编')
      let body = '# 全本\n\n'
      let han = 0
      for (const f of chapters) {
        const t = await fs.readText(await fs.resolve(pth(dir, 'manuscript') + '/' + f))
        body += '## ' + f + '\n\n' + t + '\n\n'
        han += countHan(t)
      }
      const out = args.out ? String(args.out) : pth(dir, 'fulltext')
      await fs.writeText(await fs.resolve(out), body)
      await appendEvent(fs, dir, { op: 'assemble', out, chapters: chapters.length })
      return { ok: true, out, chapters: chapters.length, han }
    },
  },
  {
    name: 'novel_context',
    description: '账本分层回看（只读、零 LLM）：op=summary 按 chapter/volume/book 投影章纲标题、出场 cast、埋收伏笔 id、时间线条数与章纲字数区间；未知字段为 null，不推断正文。chapter 缺省只给最近 24 章明细，更早仅计数，window={from,to} 闭区间可显式扩展。volume/book 只给聚合计数，不代替读正文。op=checkpoint 返回事件带最近检查点与章号，无则明报尚无 checkpoint。op=factsheet 按章投影"前情事实卡"的**确定性六节**（应兑现伏笔/既有钩子（未来到期伏笔＋未闭欠线＋**未闭章末钩子 tNNN**）/近场人物/世界观规则/时间线锚/禁改清单，每条带章号坐标；ch 缺省=current_ch+1，near=近场人物窗口默认 8 章）；叙述性一节（上章末状态一段话）**不代写**，由主编补。读取账本与编辑部意图，盲角色禁用。',
    parameters: bookDirParam({ properties: {
      op: { type: 'string', enum: ['summary', 'checkpoint', 'factsheet'], default: 'summary' },
      layer: { type: 'string', enum: ['chapter', 'volume', 'book'], default: 'chapter' },
      window: { type: 'object', additionalProperties: false, properties: { from: { type: 'integer' }, to: { type: 'integer' } } },
      ch: { type: 'integer', description: 'factsheet 用：目标章（缺省=current_ch+1）' },
      near: { type: 'integer', description: 'factsheet 用：近场人物窗口章数（缺省 8）' },
    } }),
    output: {
      // 封闭 schema：additionalProperties:true 时调用方无法从契约枚举"会拿到哪些键"。
      // 三 op 的返回键取并集——宁可宽一点，也要让键集是**可枚举**的。
      schema: {
        type: 'object',
        properties: {
          op: { type: 'string' }, layer: { type: 'string' },
          total: { type: 'integer' }, older_count: { type: 'integer' }, detail: { type: 'array' },
          checkpoint: { type: 'object' }, ch: { type: 'integer' }, near: { type: 'integer' },
          sections: { type: 'object' }, manual: { type: 'array' }, note: { type: 'string' },
        },
        additionalProperties: false,
      },
      render: (a, v) => renderJson(v),
    },
    async execute(args, exec) {
      const fs = exec.agent.ctx && exec.agent.ctx.get ? exec.agent.ctx.get('fs') : undefined
      if (!fs) throw fail(ERR.PRECONDITION, 'fs 服务不可用', '工具执行需要宿主注入 fs 服务；当前执行上下文里拿不到')
      const dir = await requireBook(fs, bookRootOf(args))
      const op = args.op || 'summary'
      if (op === 'checkpoint') {
        const entries = await readTapeEntries(fs, dir)
        // review 批修正：被 supersedes 撤销的 checkpoint 不得作为续跑锚返回——
        // 与事件带有效投影同口径（append-only 不改历史，但消费端只认有效条目）。
        const revoked = new Set(entries.filter((e) => e.supersedes).map((e) => e.supersedes))
        const checkpoint = entries.filter((e) => e.kind === 'checkpoint' && !revoked.has(e.id)).at(-1) || null
        return checkpoint ? { op, checkpoint, ch: checkpoint.ch ?? null } : { op, checkpoint: null, ch: null, note: '尚无 checkpoint' }
      }
      if (op === 'factsheet') {
        // 确定性六节投影：只搬账本里**已经存在**的事实，不判断、不概括、不代写。
        // 叙述性内容（上章末状态一段话）留给主编——工具拼不出"有脑子的概括"，冒充反而更糟。
        const project = await loadJson(fs, dir, 'project.json') || {}
        const ch = Number.isInteger(args.ch) ? args.ch : (Number.isInteger(project.current_ch) ? project.current_ch : 0) + 1
        if (!Number.isInteger(ch) || ch < 1) throw fail(ERR.BAD_ARG, 'ch 需为正整数（缺省=current_ch+1）')
        const near = Number.isInteger(args.near) && args.near > 0 ? Math.min(args.near, 50) : 8
        const fsh = await loadJson(fs, dir, 'foreshadows.json') || { foreshadows: [] }
        const cj = await loadJson(fs, dir, 'characters.json') || { characters: [] }
        const bible = await loadJson(fs, dir, 'bible.json') || { terms: [] }
        const tml = await loadJson(fs, dir, 'timeline.json') || { events: [] }
        const tape = await readTapeWindow(fs, dir)
        const all = fsh.foreshadows || []
        const planted = all.filter((f) => f.status === 'planted')
        const sections = {
          due_foreshadows: planted.filter((f) => f.due_ch != null && f.due_ch <= ch)
            .sort((a, b) => a.due_ch - b.due_ch)
            .map((f) => ({ id: f.id, name: f.name, planted_ch: f.planted_ch, due_ch: f.due_ch, overdue: f.due_ch < ch })),
          open_hooks: [
            ...planted.filter((f) => f.due_ch == null || f.due_ch > ch)
              .sort((a, b) => (a.due_ch == null ? Infinity : a.due_ch) - (b.due_ch == null ? Infinity : b.due_ch))
              .map((f) => ({ kind: 'foreshadow', ref: f.id, text: f.name, from_ch: f.planted_ch ?? null, due_ch: f.due_ch ?? null })),
            ...(tape.open_threads || []).map((t) => ({ kind: 'open_thread', ref: t.id, text: t.what, from_ch: t.ch ?? null, closes: t.closes ?? null })),
            // 未闭钩子：上一章埋的钩子正是本章要接住的东西——事实卡缺了它，主笔就是在盲续。
            ...(tape.open_hooks || []).map((h) => ({ kind: 'hook', ref: h.id, text: h.what, from_ch: h.ch ?? null, closes: null })),
          ],
          near_characters: (cj.characters || []).filter((c) => Number.isInteger(c.last_seen_ch) && c.last_seen_ch < ch && c.last_seen_ch >= ch - near)
            .sort((a, b) => b.last_seen_ch - a.last_seen_ch)
            .map((c) => ({ name: c.name, identity: c.identity ?? null, want: c.want ?? null, opposed_by: c.opposed_by ?? null, last_seen_ch: c.last_seen_ch })),
          world_rules: (bible.terms || []).filter((t) => windowCovers(t, ch))
            .map((t) => ({ name: t.name, value: t.value, from_ch: t.effective_from_ch ?? null, to_ch: t.effective_to_ch ?? null })),
          timeline_anchors: projectTimeline(tml.events, await currentRevsOf(fs, dir)).filter((e) => e.ch == null || e.ch <= ch).slice(-5)
            .map((e) => ({ ch: e.ch ?? null, time: e.time ?? null, what: e.what ?? null })),
          frozen_facts: all.filter((f) => f.status === 'closed' && Number.isInteger(f.closed_ch) && f.closed_ch <= ch && f.closed_ch >= ch - 20)
            .sort((a, b) => b.closed_ch - a.closed_ch)
            .map((f) => ({ ref: f.id, text: f.name, closed_ch: f.closed_ch })),
        }
        return {
          op, ch, near, sections,
          manual: ['上章末状态（一段话）——由主编读第 ' + (ch - 1) + ' 章正文后补写；本工具不代写叙述性内容'],
          note: '只投影账本里已存在的确定性事实（每条带章号坐标）；与账本冲突时以账本为准。近场人物=近 ' + near + ' 章出现过的人，本章实际出场者由主编按细纲增删。',
        }
      }
      if (op !== 'summary') throw fail(ERR.BAD_ARG, 'op 必须为 summary/checkpoint/factsheet')
      const layer = args.layer || 'chapter'
      if (!['chapter', 'volume', 'book'].includes(layer)) throw fail(ERR.BAD_ARG, 'layer 必须为 chapter/volume/book')
      const window = args.window
      if (window && (typeof window !== 'object' || Array.isArray(window) ||
        Object.entries(window).some(([k, v]) => !['from', 'to'].includes(k) || !Number.isInteger(v) || v < 1) ||
        (window.from != null && window.to != null && window.from > window.to))) {
        throw fail(ERR.BAD_ARG, 'window 需为正整数字段 from/to 的闭区间（from ≤ to）')
      }
      const all = await contextChapters(fs, dir)
      const rows = window ? all.filter((r) => (window.from == null || r.ch >= window.from) && (window.to == null || r.ch <= window.to)) : all
      if (layer === 'chapter') {
        const detail = window ? rows : rows.slice(-24)
        return { op, layer, total: all.length, older_count: window ? all.filter((r) => detail.length && r.ch < detail[0].ch).length : all.length - detail.length, detail }
      }
      if (layer === 'volume') {
        const groups = new Map()
        for (const row of rows) { if (!groups.has(row.volume)) groups.set(row.volume, []); groups.get(row.volume).push(row) }
        return { op, layer, detail: [...groups].map(([volume, group]) => ({ volume, ...aggregateContext(group) })) }
      }
      const project = await loadJson(fs, dir, 'project.json')
      return { op, layer, detail: [{ title: project ? project.title ?? null : null, ...aggregateContext(rows) }] }
    },
  },
  {
    name: 'novel_search',
    description: '正文检索（只读、零 LLM、书目录围栏）：在 book_dir/manuscript/ 的**当前正文**里做字面查找，返回 章号＋行号＋命中片段——用于"我前面某章是怎么写的"这类自查（主笔可直调）。多词空格分隔=全部命中（AND）；ch 或 window={from,to} 限定章范围；触碰 limit 会明报截断。**不做语义近似、不做摘要、不读版本快照**；命中是候选不是事实——引用或改稿前先读原章核对，账本才是真值。',
    parameters: bookDirParam({ properties: {
      q: { type: 'string', description: '查询词（字面；空格分隔多词=AND）' },
      ch: { type: 'integer', description: '可选：只搜这一章' },
      window: { type: 'object', additionalProperties: false, properties: { from: { type: 'integer' }, to: { type: 'integer' } } },
      limit: { type: 'integer', description: '命中片段上限（缺省 12，超限截断并明报）' },
      context: { type: 'integer', description: '片段上下文汉字数（缺省 24）' },
    }, required: ['book_dir', 'q'] }),
    output: {
      // 命中是候选不是事实，故同时返回扫描面与截断标志，让调用方自己判断"这条召回值不值得信"。
      schema: {
        type: 'object',
        properties: {
          q: { type: 'string' }, terms: { type: 'array' }, chapters_scanned: { type: 'integer' },
          total_returned: { type: 'integer' }, truncated: { type: 'boolean' },
          matches: { type: 'array' }, note: { type: 'string' },
        },
        additionalProperties: false,
      },
      render: (a, v) => renderJson(v),
    },
    async execute(args, exec) {
      const fs = exec.agent.ctx && exec.agent.ctx.get ? exec.agent.ctx.get('fs') : undefined
      if (!fs) throw fail(ERR.PRECONDITION, 'fs 服务不可用', '工具执行需要宿主注入 fs 服务；当前执行上下文里拿不到')
      const dir = await requireBook(fs, bookRootOf(args))
      const q = String(args.q == null ? '' : args.q).trim()
      if (!q) throw fail(ERR.BAD_ARG, 'q 必填（要查的字面词；空格分隔多词=全部命中）', '例：q="玉坠"；q="玉坠 血"=两词同段才命中')
      const terms = q.split(/\s+/).filter(Boolean).map((t) => t.toLowerCase())
      const limit = Number.isInteger(args.limit) && args.limit > 0 ? Math.min(args.limit, 50) : 12
      const ctxLen = Number.isInteger(args.context) && args.context > 0 ? Math.min(args.context, 80) : 24
      const win = args.window
      if (win && (typeof win !== 'object' || Array.isArray(win) ||
        Object.entries(win).some(([k, v]) => !['from', 'to'].includes(k) || !Number.isInteger(v) || v < 1) ||
        (win.from != null && win.to != null && win.from > win.to))) {
        throw fail(ERR.BAD_ARG, 'window 需为正整数字段 from/to 的闭区间（from ≤ to）')
      }
      let names = []
      try { names = (await fs.listDir(await fs.resolve(pth(dir, 'manuscript')))).map((e) => e.name) } catch (e) { /* 尚无正文 */ }
      const chapters = names
        .map((n) => { const m = /^chapter_(\d+)\.md$/.exec(n); return m ? { name: n, ch: Number(m[1]) } : null })
        .filter(Boolean).sort((a, b) => a.ch - b.ch)
      const inRange = (c) => (Number.isInteger(args.ch) ? c === args.ch : true) &&
        (!win || ((win.from == null || c >= win.from) && (win.to == null || c <= win.to)))
      const matches = []
      let scanned = 0
      let truncated = false
      for (const { name, ch } of chapters) {
        if (!inRange(ch)) continue
        scanned += 1
        const text = String(await fs.readText(await fs.resolve(pth(dir, 'manuscript') + '/' + name))).replace(/\r\n?/g, '\n')
        const lines = text.split('\n')
        for (let i = 0; i < lines.length; i++) {
          const line = lines[i]
          if (!line.trim()) continue
          const low = line.toLowerCase()
          if (!terms.every((t) => low.includes(t))) continue
          const at = low.indexOf(terms[0])
          const start = Math.max(0, at - ctxLen)
          const end = Math.min(line.length, at + terms[0].length + ctxLen)
          matches.push({
            ch, para: i + 1,
            snippet: (start > 0 ? '…' : '') + line.slice(start, end) + (end < line.length ? '…' : ''),
          })
          if (matches.length >= limit) { truncated = true; break }
        }
        if (truncated) break
      }
      return {
        q, terms, chapters_scanned: scanned, total_returned: matches.length, truncated, matches,
        note: matches.length
          ? '命中=字面候选，不是事实：引用/改稿前先读原章核对（本工具不语义近似、不摘要、不读快照）。'
          : '无命中：该字面在已扫章节中不存在——换近义词或用更短的词再试（本工具不做语义近似）。',
      }
    },
  },
]

// ---------------------------------------------------------------- prompt section

/**
 * 写门就地生效：DSH 侧（apply 注册）与 MCP 侧（server.mjs 取自 _internals.TOOLS）消费的是同一份
 * TOOLS，包在这里两条路径同时覆盖——分两处包就有漏一条的风险（2026-09-17 双份实现分叉实案的同类）。
 */
for (const def of TOOLS) def.execute = withWriteGate(def)

const SECTION = {
  name: 'novelist-guide',
  order: 150,
  text: [
    'novelist-guide ' + GUIDE_VERSION + ' · 机制细则唯一真源（novelist 插件同版注入；preset persona 只含决策原则与指针）。书工程 = book_dir（一部书一个目录；novel_* 工具一律显式传 book_dir 绝对路径）。身份与协作框架见 persona 段。**机制沿革（v6→v7 逐版增量：新增机制/口径修正/作废条款）见 ' + GUIDE_HISTORY_PATH + '——只在对某版细节有疑问时定向读，不必常驻上下文；本条以下各段即为当前生效口径。**',
    '钩子账·卷尾结算·弧审账单·结构仪器（v7.10，2026-09-18 结构审计修正批）：①**章末钩子进事件带**（kind=hook，不另立 hooks.json）——钩子与欠线是同一条因果链的两端（欠线=长程承诺，钩子=把读者拽进下一章的短程拉力），生命周期一模一样，所以共用埋下/兑现/闭线同一套对账：`novel_chapter` 带 `hook={what,why}`（各 ≤60 字）落一条，`pays_hooks=[tNNN]` 表示本章兑现（闭线载体 kind=payoff，重复闭线拦）。hook 不接受 closes——有明确兑现章的长线用 seeds（伏笔，走 due_ch 逾期对账）。未闭钩子在 `novel_event op=read` 的 **open_hooks** 完整列出（钩子每章一条，190 章 = 380+ 条，**只计数不占窗口**，否则事件带窗口会被钩子墙挤满、决策反而看不见）；`novel_context op=factsheet` 的「既有钩子」节也带上未闭钩子（上一章埋的钩子正是本章要接住的东西）。②**novel_verify 拆两个清单**：`issues`=硬清单（ok 由它决定：伏笔逾期/版本链/章纲缺失/断档/回执对账/**近 10 章漏记章末钩子**/**卷过宽限期无弧审账单**）；`warnings`=业务提示（**钩子超期未兑现** >' + HOOK_STALE_CHAPTERS + ' 章／**卷尾结算清单**）——跨界延续是允许的，告警不是罚；分开是因为结算清单每次卷末必出一条，混进 issues 就成了"每收一卷必红"，红灯贬值后真问题也看不见。③**卷尾结算**：卷写完且收束后 ' + VOLUME_SETTLE_GRACE + ' 章内（一个批次）报一次「卷 N 结算」——卷内未收伏笔/未闭欠线/未兑现钩子逐类点名，过后静默。④**弧审必须落结构化账单**：`novel_ledger op=arc_review` 落 `editorial/arcs.jsonl`（append-only）——弧名/起止章/**承重点章号（须在区间内）**/价值翻转/差异化是否落地/在轨或漂移/证据坐标/伏笔收支对（引用不存在的伏笔 id 拒收）。报告（reports/弧审-卷X-弧Y.md）照旧给人读，但结论必须同时是数据——否则"这弧承重点在哪""伏笔收支对不对"每次都得重新通读全卷，仪器也消费不了。`novel_ask kind=arcs` 可问出。⑤**结构仪器 `structure-check.mjs <book_dir>`**（只读离线，零 LLM；脚本随发布物走——DSH 形态在本插件 instruments/，专家包在包内 scripts/，以你所在形态的实际位置为准）：**只算两个能从账本算出来的量**——伏笔曝光曲线（每章挂着多少条未收的线、多少条已过 due、埋→收间隔）与爽点间隔（判据账 dim=爽点 口径，连续几章无爽点）；**把"没测"与"测到没有"分开报**（未测章不计入任何统计——把没测当没有是这类仪器最典型的撒谎方式），并**显式列出它测不了什么**（反转是否真、节奏松紧、幕结构、差异化落地）。观测器不是闸门：报数+描述性统计，永不判"结构好不好"。',
    '生效窗与人物欲求（v7.9，2026-09-18 结构审计批）：①**词条/人物卡是带生效窗的版本记录**——同一名字可有多条记录，按 ch 投影取"窗口包含本章"的那条。窗口不重叠的新值＝口径演进（追加一条，旧值与旧窗口原样留档，**不回头篡改历史**）；**窗口重叠且值不同才是真冲突**（走 resolve_conflict 仲裁）。缺窗口字段＝全书窗（旧账本行为不变）。写作纪律：设定/人设演进一律给新值一个从新章起算的 effective_from_ch（必要时给旧值补 effective_to_ch），别用同名覆盖去"更正历史"。②**人物欲望必须进账**——characters.json 记 want（贯穿欲求，全书级一句话）与 opposed_by（主要压力来源）；主笔的"人物欲望设计"若不落账，换会话就重建不出来（账本是唯一可重建源），而长篇最典型的死法正是"主角连续多章没有想要的东西"。③结构校准员的病类目录＝**九类**（A1-A4 形成过程被结论替代 ＋ B5-B9 叙事组织过满；旧称"八类"是 v6.6 加回 B9 后未同步的名字，已统一为九类）。',
    '检索与事实卡（v7.8，2026-09-18 A+B 批）：①**正文检索 novel_search**——在 manuscript/ 当前正文里做字面查找，返回 章号＋行号＋命中片段；多词空格分隔=AND；ch/window 限定章范围；触碰 limit 明报截断。**它是候选召回不是事实源**（引用/改稿前读原章核对；账本才是真值），不做语义近似、不做摘要、不读版本快照。**主笔可直调**（自查旧文的唯一通道：宿主权限按工具名不按路径，主笔被 deny glob/grep＝连书目录都搜不了；放开=放开整块硬盘）。盲角色（试读员/校准员/校对员/拆书员）连同 novel_context 一并 deny。②**前情事实卡投影 novel_context op=factsheet**——按章投影六节确定性事实：应兑现伏笔（due ≤ ch，逐条标逾期）/既有钩子（未来到期伏笔＋未闭欠线＋**未闭章末钩子 tNNN**，见 v7.10）/近场人物（近 near 章出现过，缺省 8）/世界观规则（effective ≤ ch）/时间线锚（≤ ch 最近 5 条）/禁改清单（近 20 章已收伏笔）；ch 缺省=current_ch+1，每条带章号坐标。**叙述性一节（上章末状态一段话）不代写**——返回里明标由主编读上一章正文后补写。近场人物≠本章实际出场者：主编按细纲增删。',
    '账本版本与投影纪律（v7.5-v7.7，2026-09-17 批A1/A2/E2，novel_chapter/novel_verify/novel_score/novel_ask）：①**回执与事务**——novel_chapter 回执 status=pending→done＋content_hash（sha256 正文），正文落盘前先立 pending；中断残留 pending=半提交（同文本重交幂等补齐：不翻版本快照、不重复记账、账务步骤照走）；expected_rev 声明"我读到的账上 rev"（不符=写入前拒绝、零副作用；新章报 0）；断点续跑判定=读 editorial/txn/ 的 status，不是"正文文件在不在"；novel_verify 回执对账（pending=半提交；done 但 hash 与正文不符=正文被绕过工具改动）。②**事实贡献账** editorial/facts/chapter_XXX.vN.json——每章每版记"本版贡献了哪些事实"（seeds/closes/timeline/cast），append-only；人物 last_seen 按有效出场投影重建（改稿删人物会回退到最近有效章；纯旧书无贡献账的人物不动）。③**判词绑版本**——novel_score 每条判词自动绑 ch_rev+content_hash，read 带 ch 时默认只回当前正文版本的判词（include_stale=true 连旧版取，逐条标 stale/legacy）。④**novel_ask 有效投影**——timeline 纳入读取；被 supersedes 作废的条目不进事件带窗口与未闭欠线（撤销链 superseded_chain 单独可查）；ch=基准章（时间线只回 ≤ch、人物 last_seen 投影到 ≤ch——超前存稿不算当前账）；select{entity｜kind=characters/bible/foreshadows/timeline/status/tape｜window:{from,to}} 结构化取数。',
    '工作流（卷级开局，v6.7 呈报制）：走向呈报=**主笔出** 3 互斥走向（v7.2 两座位制：卷级走向血肉署名提案权在作者——v6.7 原文"主编出"是并座前的口径，已作废）（各带：代价=放弃项逐条点名/承诺=挂卷内伏笔位/个体参照=语料库哪位作家哪段气质）→ Owner 定音（不代行）→ 选中走向代价清单以 choice_axis 落卷首章纲；结构骨架按策略池选法（单源节拍移植=v0：锚池=语料库全集按需，节拍级、可跨题材），统计参数只作守门尺防贫血，锚定目标=分布尾部。',
    '工作流（每章，v7.0 三原语执行流——主编手工工具调用目标 ≤3 次/章）：动笔前细纲三行呈 Owner——①本章拍点（一句话节拍）②章末钩子③个体参照；关键章（卷首/卷尾/大转折/伏笔兑现/钩子切换）加展开细纲 Owner 全看，常规章三行点头、每 3 章抽 1 章展开，抽看见平/漂移则连续 3 章升格；章长窗默认 3000-4000 汉字，日节奏默认 6 章/批。执行：①novel_ask 一次查账（实体卡+伏笔欠线+时间线+事件带窗口由它一次拼好，替代 bible 手填过滤+event read+verify 翻账；查"写到某章为止"就带 ch——它按 ≤ch 投影，存稿不算当前账；要确定取数用 select）→ ②主编组装派工包派主笔（**六层配方**：前情事实卡/前一章正文逐字（禁摘要替代）/上章反馈卡（Owner 裁决摘要+审稿分歧点——生成端的反馈回路，不许只给绿灯）/章纲末位/零编排对白混入/**个体参照卡**——把本卷走向呈报里定下的那张作家卡**内容全文贴进包**，取卡处＝' + CRAFT_CARDS_PATH + '。为什么必须贴全文：主笔的 glob/grep 被 deny（宿主权限按工具名不按路径），它只能按精确路径 read，只给目录名等于没给；个体参照留在库里＝这一格空转）→ 主笔交细纲三行提案 → 呈 Owner 点头 → 主笔同会话续写正文 → ③novel_chapter 一次收束（参数携带正文+seeds/closes/cast/timeline+decision 随章落带+**hook 落本章章末钩子／pays_hooks 兑现旧钩子**+advance_to 状态推进；完成回执落 editorial/txn/，断点续跑以回执 status=done 为准——残留 pending=半提交，同文本重交幂等补齐）→ ④批审（v7.4 起：主编按批审协议并行 spawn 盲采样员 N=2-3（近全票才加采至 6）→意见落 editorial/blind-samples/ → batch-aggregate 聚合 → 只看分歧点；过渡期单发试读/校准仍可用，批审为默认）→ ⑤意见回流入 novel_decide（裁决+状态迁移+落带一次完成；撤销=同工具 supersedes 引用旧条目）。**批末金丝雀**：每批随机抽 1 章走 A-B 盲读冷读（平信号哨兵，生产环路唯一能报"平"的通道，不得归零；细纲呈报趋稳后随 R4 降档条款上调频率）。novel_bible/novel_event/novel_ledger set_chapter_status 保留为细粒度兜底，常规章不再单独调用；novel_verify 批末跑一次全量（含新章符号门复核）。',
    '章状态机（迁移入口=工具三处：novel_chapter advance_to / novel_decide status 派生 / novel_ledger set_chapter_status——同一张迁移表同一套合法性校验，子代理不碰状态机）：草稿→已审（你收稿）→待试读（派试读员）→已试读（意见已回）→待修订（内审回改中）→已定稿→存稿→待外审→已发表；外审打回→打回修订。待修订=内审意见回改，打回修订=外审（平台）打回（note 记平台原因），两态勿混用。回改落盘=同章号重新 novel_chapter 提交（携修订后全文），旧版自动留快照绝不静默覆盖；回改后置已审，重走内审分级（主编裁定并注理由）：P0/语义级改动（情节/人设/伏笔/结构）→ 重新派试读员，**定稿前按 A-B 冷读协议（editorial/protocols/A-B冷读协议.md）双 Reader 交换顺序盲读新旧版**；纯文字级（校对 P2 批，裁定无情节影响）→ 只过校对免重试读。',
    '一章收束验收（全过才算写完）：①字数在章纲 word_min/word_max 区间（novel_count 工具口径）②novel_verify 无 P0（issues 空；warnings 里的钩子超期与卷尾结算需过目但不拦稿），或 P0 已挂 board/issue-NNN ③seeds/closes/cast/timeline_events/**hook（本章章末钩子）** 已随章登记 ④试读/校对 P0 已回改或已挂修订单（P1/P2 可攒批）⑤状态已推进到正确闸口。P0 未清，章不许进已定稿/存稿。',
    '编辑部协作框架（趋同目标/非对抗/你汇总取舍呈 Owner）：基调与身份见 persona【身份】段；六角色派工分工 home=下条（persona 不再重复分工明细，单一真源防口径分叉）。',
    '事件带纪律（v6.5，novel_event；v7.10 增 hook/payoff）：落带必记——①每章决策 kind=decision（章纲/调度/取舍，why 必填）；②判词与回改处置 kind=verdict/revision（随状态流转）；③自设欠线 kind=open_thread（必带 closes 预期章，verify 追逾期；闭线用 closes_thread 对账防重复）；④**章末钩子 kind=hook**（随 novel_chapter 的 hook 参数落，兑现由 pays_hooks→kind=payoff 闭线）。闭线用 closes_thread 对账防重复（欠线与钩子共用同一套）。写手侧=任务书内注"事件带摘要段"（≤15 行，从 read 结果手拼——未闭欠线必含），工具面 deny 不直调；试读员/结构校准员/校对员禁看事件带（盲读红线：判官不许知道编辑部意图）；档案员可 read（主笔不直调，工具面 deny）。**主编压缩触发前：当轮推理摘要 kind=checkpoint 落带**——文件不被压缩吃掉=抗压缩记忆；兼批级断点续跑锚：续跑=查 status.json 最后已定稿章→read 带尾→重建调度位→从下一章 outline 起（0.1.2 无头收束丢子代理+断供中断皆有前科，长批必须可续）。',
    '文体词库三层（v7.11）：词库=' + LEXICON_PATH + '。**三层各有各的用法，混用会同时制造误报与空转**——①**L1 硬规则**（`forbidden_lexicon`：评论文体套话「说白了/综上所述/值得注意的是/意味着什么/本质上/换句话说/不可否认」＋教科书开头）＝命中即问题，**随派工包把清单给主笔**（同个体参照卡：不贴进包＝写手拿不到＝这一层空转），每条附替换建议。②**L2 密度观测**（`negative_lexicon`）＝**只报密度不判违规**：76 词在《惊悚乐园》等头部作品里中位 3.577/万字、78% 的书超阈值——它区分的是"AI 稿/人稿"，区分不了"好/坏"；且**压到 0 同样是偏离人类分布**（双向偏差）。③**L3 正向锚**（`positive_lexicon`）＝"该往哪写"，但它是**第一人称博主声音**，只可用于**特定角色口吻/主角内心吐槽**，不得改叙述层（叙述者不评判/不跳出）。④标点（冒号/破折号）是**观测项不是禁令**：头部作品 4.795/千字，按禁令处理只会误报。⑤**剔除项登记**（`excluded_lexicon`）：卡兹克那份 MIT 词表里的「首先/其次/最后」是普通连词（"最后他走了"），列进小说禁词即误报——剔除理由已入账，别再捞回来。',
    '仪器纪律（v6.5 预告，细则随 P3 评分卡 v2 落地）：每章轻量门三查（钩子在/承诺兑/事实对账——二元问题，与试读合并一次调用）；检查点章（卷首尾/大转折）全量评分卡；一切判词必须带正文原句引用+位置（无引用判词无效；P3 起落判据账 scores.jsonl 并做子串核验——批A2 起每条判词绑 ch_rev+content_hash，回读默认只回当前正文版本，改稿后旧判词标 stale 不再冒充结论）。量表锚点只给判官工位，永不进写手任务书（Goodhart 面最小化——写手拿读者契约+**原文范例**：范例是"铺开目标语域"，量表是"可被优化的代理目标"，两者不是一回事）。**〔v6.7 判据降权（R8）〕量表/评分卡/锚书 z-score 一律为守门工具（一致性/通顺/结构完整）；任何"这章写得好/动人/会上头"的结论不得引用它们为证据——"好"的证据唯二：Owner 裁决记录+语料库个体范本。** **〔v7.13 结构参数同样降权（2026-09-18 调研修正）〕句长中位/短句占比/对话比这类**统计量属守门与诊断工具，与量表同地位、同样不进写手任务书**。理由有实证：把风格写成数字无证据支持，且强制表层统计分布的路线"consistently outperformed by prompting and LoRA"；追加可核验的对齐约束（长度对齐）反而**降低**风格归属准确率（Wang et al. 2025，400+ 作者/4 万次生成）。机制＝extremal Goodhart：从语料观测出的分布性质一旦变成逐句目标，模型会去凑比例、牺牲真语域。**写手侧只给：定性语域指南（禁数字）+ 同场景原文范例 + 锚段 + "这个作者不会做的事"清单 + AI 腔黑名单**（详见 craft/author-cards 建卡纪律）。**',
    '派工分工（v7.2 两座位制+按需工种+仪器）：**常设两座位**——主编=编排/裁决/落账权/ask 门；**主笔=作者+执笔一体**（原策划+写手合并：卷级 3 互斥走向血肉署名提案、章级细纲三行提案、人物欲望设计；两段式会话=提案→Owner 门→同会话续写；continuable 同事线；deny=不碰落账/不碰事件带/不碰 shell）。**按需工种**（一次性 spawn 不占编制）——档案员（弧审/写前对账时才叫，v7.2 降格按需）；拆书员（锚书解剖批处理）；试读员=每章冷读审（三问分级量表+落脚检查+复述核查；协议=editorial/protocols/盲读协议.md；one-shot 每章新实例）；结构校准员=每章轻扫九类结构病（证据制，one-shot 纯盲只见正文，弧审时全卷扫描）；校对员=发稿前文字审。**〔过渡期条款〕**试读员/校准员/校对员为 R2 批处理器上线前的过渡工种——R2 上线后收编为并行盲采样（角色撤销、测量保留，主编只见聚合分歧点）。各审各的，不重复派工。文中旧称"写手"皆指主笔的执笔职能。',
    '前情事实卡（Q2，会话即抛·档案即记忆）：派写手/试读员前的连续性材料由你从账本拼装——本章应兑现伏笔 due 清单+既有钩子（**含未闭章末钩子 tNNN，v7.10**）+出场人物卡摘要，全带章号坐标；**底稿直接取 novel_context op=factsheet**（六节确定性投影一次给齐，别手翻六个文件），只有叙述节（上章末状态一段话）与本章实际出场者是你要补的；模板=editorial/protocols/前情事实卡.md。连续性判断吃事实卡不吃会话记忆：任何角色的会话上下文都可丢弃后凭账本+事实卡恢复工作状态。',
    '盲角色派工纪律（Q6 五条，违者交付无效）：①中性命名——给盲角色（试读员/A-B Reader/结构校准员）的任务名只说"按档案提交读感记录"，禁带答案表述（如"检查逻辑跳跃/验证伏笔"）；②输入隔离——盲角色只收 读者档案+正文包（试读员另收前情事实卡；校准员只见正文），无大纲/无写作意图/无旧稿/无检测信息/无预期答案，包内出现即原样退回并报"输入污染"；**②b 只读派工包**（v7.12）——**盲角色只读派工包里的东西，不得调用任何工具去查账本/大纲/伏笔/事件带**（DSH 侧由 preset deny 封死工具面；非 DSH 宿主如 MCP 客户端封不住权限，故这条是**纪律条款**而不仅是机器约束）。理由不是防它使坏，是防**测量失真**：盲角色是仪器不是帮手，它一旦读到"作者想干什么/哪里埋了伏笔/后面要收什么"，就会对真读者看不懂的地方说"清楚"、对断裂说"这是伏笔"——**被污染的盲读不会报错，它会交回一份通顺、有理由、很客气但没有用的数据**。派工包给少了就报"输入不足"，不要自己去取；③诚实降级——开不出新实例只能标"自审降级"留痕，不得冒充盲读完成；④Owner 反馈撤销制——Owner 说"看不懂/不好看"=立即撤销对应通过并回改，冷读漏检不得反驳 Owner。',
    '修订单与事项板（editorial/ 工作区，per-role 独立文件免锁）：章/块内具体意见进修订单（orders/block-XXX/：试读员-意见/档案员-审计/校对-批注/主编-汇总），条目结论式≤3行+证据坐标+P0/P1/P2；跨章规则与重复模式进事项板（board/issue-NNN，append-only，状态机：待处理→编辑部立场→待Owner→已裁决/已驳回）。已发表后修订批处理：攒批一次改完一次重审（平台每次改动触发重审）。',
    '商业工位（M2/M3）：novel_outline 定稿后**主笔**交书名候选×5+简介×2（协议=editorial/protocols/书名简介工位.md；主编合并后呈 Owner 三选一/二选一，书名=点开率生死线不自主决定）；存稿≥10 章起主编按 editorial/protocols/责编评分卡-番茄.md 自评（**六维**带证据坐标，**<20 分不送外审，≥24 分才呈送**——口径以卡片 v2.2 为准，卡片自己注明"五维/<17/≥20"是已作废旧版）。〔2026-09-18 口径收敛〕原写"策划交书名候选"——策划自 v7.2 起即主笔。',
    '弧级审查：每 5-10 章一次（锚定事件块边界，每卷至少 1 次）。异常触发分两期：未发表期（写作长跑）=试读连续 2 章 P0 / 修订单未处理积压>5 条（含弧审订单）；已发表期追加=外审打回率>30%（一个事件块内）。默认锚 Owner 可调、bible 可覆盖。三问=弧线在轨还是漂移、伏笔收支、差异化是否真落地；全部带证据坐标禁"我觉得"；产出 reports/弧审-卷X-弧Y.md **＋一条结构化账单（v7.10 起必落：novel_ledger op=arc_review → editorial/arcs.jsonl，把承重点章号/价值翻转/伏笔收支对/三问结论一起落成数据；由主编落账——档案员只读不写；只写报告不落账单＝弧审成果不可被仪器消费、下次还得重新通读全卷）**；写手不列席，意见经修订单回流（跨块弧审意见落 orders/arc-卷X-弧Y/ 并计入积压锚，章内意见仍走 block-XXX）。',
    '纪律：正文/台账唯一写入口 = 工具，绝不绕过工具直改文件（账本唯一写入口）；语义判定（好坏/取舍）归模型与编辑部，代码只做壳；重大变更（开书 novel_init/汇编 novel_assemble）走 Owner ask 卡，你不自批。editorial 工作区（修订单 orders/、事项板 board/、弧审报告 reports/）与 .drafts 交付件 = 编辑/子代理的工作产物，允许 write/edit 直写（单写者免锁）；"唯一写入口=工具"特指小说数据账本（bible/characters/foreshadows/timeline/outline/manuscript/versions/status/事件账）。',
    '多轮写作纪律（试产实弹教训 2026-09-01）：写手续写/扩写前必须重读受影响正文全文与相关台账——新插入的设定、观察、细节先与既有正文对账再落笔（分段扩写不回读=同章吃书 P0 的主产地）；bible 词条随情节演进及时改口径；修订注记等元信息绝不写入正文（只存在于版本快照与修订单）。',
    '子代理编排纪律（2026-09 多轮实弹实测修订）：①派工后必须拿到交付或失败结论才许收束回合——0.1.2 起（截至 DSH 0.1.2 实测；升级后以当版实测为准，勿凭本句假设）job_output **不追踪子代理**（实测 unknown job），依赖结果的派工一律前台 spawn（run_in_background:false）同步拿全文；后台 continuable 子代理 settle 时运行时会自动向父代理发通知（含结果与最终消息），等通知期间禁收束回合。禁止"我会等待"然后停笔（headless 下一收束=运行结束，子代理变孤儿，实测一次全丢）。同一子代理同任务**连续 2 次零交付/失败即熔断**：改由主编终校替代，修订单留痕"自审降级+原因"，事后挂事项板复盘——角色故障不许拖死主链（F7：2026-09-04 实测 8.5min 空等教训）。**角色传输二分（v6.4 W-1 实测裁定；v7.2 修订）**：主笔走同事线——后台 continuable spawn（章内两段式：提案段→主编回传 Owner 裁定→s2s_message(session_id) 唤醒同会话续写）、记 agent_id；同事线故障或 2 分钟无回信即降级一次性前台 spawn（留痕），不许挂死主链。试读员/结构校准员/校对员**永远一次性前台 spawn**（盲读输入隔离与账本写入口安全不进同事线）。〔v6.4 原口径：策划/档案员走同事线——v7.2 起策划并入主笔、档案员降按需 one-shot（R1 后账本自动派生），常驻同事线只剩主笔。〕同事会话上下文只当缓存：真相永远在账本，任何同事可丢弃后凭账本+事实卡重建。②写手交付必须落盘成文件（.drafts/ 或临时件），交付即用 novel_count 核数（工具口径），自报字数只作参考（历史虚高 37%-63%；2026-09-03 验壳实测 v4-flash 自估 960 vs 实测 969 偏差约 1%，但仍以工具口径为准）；正文文件**首行不写章标题**（对齐 manuscript 无题首行惯例，novel_count 文件口径=入稿口径，免标题字数换算，F5）。③单回复写作上限约 1 万汉字（实测 10506）：章纲 word_min>10000 的章走分段写作协议——每段一交付一落盘一核数，主编拼装后一次 novel_chapter 提交。',
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

const _internals = { countHan, symbolGate, chapterFile, chapterTitle, CHAPTER_STATES, CHAPTER_TRANSITIONS, TOOLS, SECTION, loadJson, saveJson, appendJsonlLine, readJsonlLines, appendTape, readTapeWindow, TAPE_KINDS, sanitizeOwn, enqueueBook, acquireFileLock, LOCK_DEFAULTS, withWriteGate, ERR, fail, SCHEMA_VERSION, LEDGER_MIGRATIONS, migrateLedger, bookRootOf, resetLastBook }

export { name, apply, inject, _internals }
