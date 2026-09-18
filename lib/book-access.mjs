/**
 * 书目录访问层（novelist）：书目录别名归一 + "@last" 记忆 + 写门（进程内队列 + 跨进程文件锁）。
 *
 * 为什么单独成文件：这三件事共用同一个"书目录身份"——归一后的目录既是队列键、又是锁的落点、
 * 又是 @last 记下的值。三处口径分叉过一次（"@last 先解析再入锁"的修复），放一起才有一个真源。
 * lib/novelist.js 继续在 _internals 里原样导出这些符号（bookRootOf / resetLastBook /
 * acquireFileLock / enqueueBook / LOCK_DEFAULTS / withWriteGate），对外 API 不变；
 * 错误码表 ERR/fail 一并移入本文件（锁要发 E_LOCK_TIMEOUT），novelist.js 反向 import 同一对象。
 */
import { randomUUID } from 'node:crypto'
import { hostname } from 'node:os'
import { dirname } from 'node:path'

// ---------------------------------------------------------------- 错误码（批R4）

/**
 * 结构化错误：`code` 供调用方程序化判断，`message` 供人读，`hint` 给处置办法。
 * 标准做法是 `error.code`，但 MCP 与 DSH 两条通道对本插件都只透传 message 文本，
 * 所以码同时编进消息前缀——两条通道都不改协议也能看见。
 * 只给**调用方能据以区别对待**的失败类发码；其余业务校验失败保持普通 Error（不作无意义分类）。
 */
const ERR = {
  BAD_ARG: 'E_BAD_ARG',
  NOT_FOUND: 'E_NOT_FOUND',
  CONFLICT: 'E_CONFLICT',
  PRECONDITION: 'E_PRECONDITION',
  LOCK_TIMEOUT: 'E_LOCK_TIMEOUT',
  LEDGER_CORRUPT: 'E_LEDGER_CORRUPT',
  SCHEMA_FUTURE: 'E_SCHEMA_FUTURE',
  MIGRATION_MISSING: 'E_MIGRATION_MISSING',
}

function fail(code, message, hint) {
  const e = new Error('[' + code + '] ' + message + (hint ? '（处置：' + hint + '）' : ''))
  e.code = code
  return e
}

// ---------------------------------------------------------------- 书目录身份（别名归一）

/**
 * Windows 文件系统大小写不敏感：'C:/Books/x' 与 'c:/books/X' 是同一个目录，而 JS 的 Map 键
 * 大小写敏感——不归一就会出现"同一本书两条队列/两把锁"（进程内两个工具调用交错读写＝丢更新）。
 * 只对**队列键/锁键**做大小写折算（lockKeyOf），不回写 book_dir 本体：回显保持调用方写的原貌，
 * 免得把用户的路径静默改成小写。POSIX 大小写敏感，'x' 与 'X' 是两本书，绝不折算（折算会把
 * 两本不同的书串成一把锁，还可能把锁文件建到错目录）。
 */
const CASE_INSENSITIVE_FS = process.platform === 'win32'

/**
 * 规范化书目录：反斜杠→斜杠、折叠重复斜杠、去尾斜杠、去 '.' 段、盘符大写。
 * 别名归一的意义：同一本书的任何写法必须落到同一个身份上——否则进程内队列与跨进程锁各认一套，
 * 互斥就只覆盖了"写法恰好一致"的调用。
 * 不做的事（有意的边界）：
 *  - 不消解 '..'：词法消解在符号链接下会算错真实路径，且本函数不接触文件系统；
 *  - 不改大小写：见 CASE_INSENSITIVE_FS 注释（大小写折算只在 lockKeyOf 里做）；
 *  - 不解析符号链接：真实路径归一只在 fs 适配层（MCP realpath 守卫）做。
 */
function normalizeBookDir(raw) {
  const s = String(raw == null ? '' : raw).trim()
  if (!s) return ''
  const unified = s.replace(/\\/g, '/')
  // UNC（'//server/share'）与 POSIX 根（'/x'）的前导斜杠原样保留，不能折叠成一个
  const lead = unified.startsWith('//') ? '//' : (unified.startsWith('/') ? '/' : '')
  const body = unified.slice(lead.length).split('/').filter((seg) => seg !== '' && seg !== '.')
  const out = lead + body.join('/')
  if (!out || out === lead) return out // '' 或 '/'（根目录本身）
  // 盘符大小写统一（Windows 上 'c:/x' 与 'C:/x' 等价；驱动器号大写不影响后续读写）
  return out.replace(/^([a-zA-Z]):(?=\/|$)/, (m, d) => d.toUpperCase() + ':')
}

/**
 * 队列键 / 锁键：归一 + 平台相关的大小写折算。'x'、'x/'、'x//'、'X'（Windows）→ 同一键。
 * 用途边界：这个键只用来**认身份**（Map 键），落盘路径仍用 normalizeBookDir 的结果
 * （POSIX 上大小写敏感，绝不能拿折算后的键当路径去写文件）。
 */
function lockKeyOf(dir) {
  const n = normalizeBookDir(dir)
  return CASE_INSENSITIVE_FS ? n.toLowerCase() : n
}

/** 锁文件路径（书目录内；放在书目录里＝"谁占着这本书"对任何进程都一眼可见）。 */
function lockPathOf(dir) { return normalizeBookDir(dir) + '/.novelist.lock' }

// ---------------------------------------------------------------- "@last" 记忆（批U1 / 批R2）

/**
 * 本进程内最近一次**成功**使用的书目录，按宿主上下文分桶：
 *  ① 只在调用成功返回后写入（批R2）——旧实现在 execute 之前的 bookRootOf 里就写，任何失败调用
 *     （book_dir 打错、书不存在、参数被拒）都会把别名劫到那本上，下一次 `@last` 就写进错书。
 *  ② 分桶的键是**字符串**（服务自报的工作区根，见 ctxKeyOf），不是 fs 对象本身；
 *     读不到根时统一落 'global' 单桶＝旧行为。
 */
let LAST_BY_CTX = new Map()

/** 上下文位：显式传了 fs/宿主对象才算"有上下文"；直接调 bookRootOf(args) 的旧姿势落 'global' 桶。 */
function isCtxObject(ctx) { return ctx !== null && (typeof ctx === 'object' || typeof ctx === 'function') }

/**
 * 上下文键：把"哪个宿主/工作区"折成一个字符串。
 * 为什么**不能**拿 fs 对象当键（2026-09-17 查证）：DSH 的 fs 是 cordis Service，
 * `ctx.get('fs')` 每次调用都返回**新建的 Proxy**（cordis lib/index.js:123 createTraceable →
 * `new Proxy(value, …)`，每个调用方拿到不同对象），对象身份在真宿主里天然不稳定——
 * 按身份分桶会让 @last 每次都落空（本机测试用稳定 shim 恰好看不出这个错，属"看着对跑起来错"）。
 * 取服务自报的根（MCP 适配器=root；DSH 本地 fs=config.cwd）当键：字符串值穿过 Proxy 原样返回，
 * 同一工作区的任意代理都得到同一个键。读不到根时退回 `global`＝**进程级单桶**（旧行为，
 * 不回归；代价是少了"两个工作区互不串书"这一层隔离，如实降级不假装）。
 */
const CTX_ROOT_KEYS = ['root', 'workspaceRoot', 'workspace', 'cwd']
function readCtxRoot(ctx) {
  if (!isCtxObject(ctx)) return null
  const str = (obj, k) => {
    try {
      const v = obj == null ? null : obj[k]
      return typeof v === 'string' && v ? v : null
    } catch (e) { return null } // 代理/宿主怪癖：读不到就当没有，绝不因探上下文把工具调用搞崩
  }
  for (const k of CTX_ROOT_KEYS) { const v = str(ctx, k); if (v) return v }
  let cfg = null
  try { cfg = ctx.config || null } catch (e) { cfg = null } // DSH 本地 fs 的根在 config.cwd
  if (isCtxObject(cfg)) for (const k of CTX_ROOT_KEYS) { const v = str(cfg, k); if (v) return v }
  return null
}

function ctxKeyOf(ctx) {
  if (!isCtxObject(ctx)) return 'global'
  const root = readCtxRoot(ctx)
  return root ? 'root:' + lockKeyOf(root) : 'global'
}

function readLastBook(ctx) {
  return LAST_BY_CTX.get(ctxKeyOf(ctx)) || null
}

function writeLastBook(ctx, dir) {
  LAST_BY_CTX.set(ctxKeyOf(ctx), dir)
}

/** 记下"这个上下文成功用过这本书"（只该在调用成功后被调一次）。 */
function rememberBook(ctx, dir) {
  const n = normalizeBookDir(dir)
  if (n) writeLastBook(ctx, n)
}

/** 清空"上次书目录"（测试隔离用；同时也给宿主在切换工作区时一个显式重置口）。 */
function resetLastBook() {
  LAST_BY_CTX = new Map()
}

/**
 * 解析书目录：'@last' 取本上下文上次成功用过的书目录，其余走别名归一。
 * **纯函数**（批R2）：不再有"顺手记下 @last"的副作用——记忆只由写门在调用成功后提交。
 */
function bookRootOf(args, ctx) {
  const raw = String((args && args.book_dir) || '').trim()
  if (!raw) throw fail(ERR.BAD_ARG, 'book_dir 不能为空', '传书目录绝对路径；同一进程内再次操作同一本书可传 "@last"')
  if (raw === '@last') {
    const last = readLastBook(ctx)
    if (!last) throw fail(ERR.NOT_FOUND, 'book_dir="@last" 没有可用的上次书目录（本上下文还没成功用过任何一本书）', '先带绝对路径成功调用一次，之后再传 "@last"')
    return last
  }
  const dir = normalizeBookDir(raw)
  if (!dir) throw fail(ERR.BAD_ARG, 'book_dir 不能为空', '传书目录绝对路径；同一进程内再次操作同一本书可传 "@last"')
  return dir
}

// ---------------------------------------------------------------- 写门（并发互斥，批R1）

/**
 * 写门 = 同一本书的写操作互斥，两级：
 *   ①进程内队列（enqueueBook）：同一 book_dir 的调用串行，防同进程内两个工具调用交错读写。
 *   ②跨进程文件锁（acquireFileLock）：DSH 插件与 MCP server 是两个进程，可以同时指向同一本书。
 *     缺这把锁时，双方各自"读—改—写"会静默丢更新（后写覆盖先写，无人报错）。
 *
 * 锁文件 = <book_dir>/.novelist.lock，内容 {pid, host, token, at}。
 * 陈旧判定的口径（批R2）：**先看持有者是不是还活着，再看年龄**——
 *   - 本机锁：pid 存活（process.kill(pid,0) 不抛）→ 不算陈旧，绝不抢（活着的持有者跑一次长操作
 *     超过 staleMs 是常态，按 mtime 抢＝谁慢谁被抢）；pid 已死（ESRCH）→ 立即接管（崩溃恢复
 *     不必等满 staleMs）；
 *   - 探不了活的锁（别的机器持有 / 无 pid / 内容损坏）：退回年龄判定（mtime 超过 staleMs＝陈旧），
 *     并靠**持有者心跳**（heartbeatMs 周期刷新 mtime）给"活着但探不了"的持有者留下活证据。
 *   - 拉长 staleMs 不是这个问题的解法（只是把抢锁窗口推远，长操作照样被抢）。
 * 书目录还不存在时（首次开书）也必须有互斥：写类工具先建目录再取锁（见 WRITE_TOOLS）。
 * 后端不提供原生路径时（内存 fs 适配器 / 测试 shim）退回①，且**如实降级**——不假装有跨进程互斥。
 */
const LOCK_DEFAULTS = { waitMs: 30_000, staleMs: 30_000, retryMs: 40, heartbeatMs: null, createDir: false }

/** 本机主机名：锁内容记它，才分得清"同一个 pid 号"是本机进程还是别机的（别机的探不了活）。 */
const HOST = (() => { try { return hostname() } catch (e) { return null } })()

const WRITE_QUEUES = new Map()

/** 同一本书的调用串行（先进先出）；队列排空后自动清理，防 Map 无界增长。 */
function enqueueBook(dir, fn) {
  const key = lockKeyOf(dir)
  const tail = WRITE_QUEUES.get(key) || Promise.resolve()
  const run = tail.then(() => fn(), () => fn())
  const settle = run.then(() => {}, () => {})
  WRITE_QUEUES.set(key, settle)
  settle.then(() => { if (WRITE_QUEUES.get(key) === settle) WRITE_QUEUES.delete(key) })
  return run
}

/** 取跨进程写锁。返回 {mode, token, release}；release 必须被 finally 调用，否则锁要挂到陈旧超时才被接管。 */
async function acquireFileLock(fs, dir, opts) {
  const cfg = Object.assign({}, LOCK_DEFAULTS, opts || {})
  const rel = lockPathOf(dir)
  let procPath
  try {
    procPath = await fs.processPath(await fs.resolve(rel))
  } catch (e) {
    return { mode: 'in-process-only', token: null, release: async () => ({ released: false, reason: 'no-native-path' }) }
  }
  const { open, stat, rm, readFile, utimes, mkdir } = await import('node:fs/promises')
  // 持有者标识（批R2）：释放要凭它校验"这把锁还是我的"。用随机 token 而不是 pid——
  // pid 会被复用，同名同 pid 的重建锁会让旧持有者误判所有权。
  const token = randomUUID()
  const startedAt = new Date().toISOString()
  const deadline = Date.now() + cfg.waitMs
  // 心跳（批R2）：持有期内周期性把锁文件 mtime 刷成当前时间。作用不是"延长过期时间"，
  // 而是让**探不了活的锁**（别机持有、pid 不可见）在年龄判定下有"还活着"的证据。
  const heartbeatMs = cfg.heartbeatMs == null ? Math.max(1000, Math.floor(cfg.staleMs / 3)) : cfg.heartbeatMs
  let hb = null
  const stopHeartbeat = () => { if (hb) { clearInterval(hb); hb = null } }

  for (;;) {
    try {
      const fh = await open(procPath, 'wx')
      try {
        await fh.writeFile(JSON.stringify({ pid: process.pid, host: HOST, token, at: new Date().toISOString(), startedAt }), 'utf8')
      } finally { await fh.close() }
      if (heartbeatMs > 0) {
        hb = setInterval(() => {
          // 只刷自己那把锁：锁已被接管/删除时必须停手（否则是在替别人的锁续期，或把已释放的锁"复活"）
          readFile(procPath, 'utf8').then((raw) => {
            let info = null
            try { info = JSON.parse(raw) } catch (e) { info = null }
            if (!info || info.token !== token) { stopHeartbeat(); return }
            const now = new Date()
            return utimes(procPath, now, now)
          }).catch(() => stopHeartbeat())
        }, heartbeatMs)
        if (typeof hb.unref === 'function') hb.unref() // 心跳不得拖住进程退出
      }
      return {
        mode: 'file-lock',
        token,
        release: async () => {
          stopHeartbeat()
          // 释放校验所有权（批R2）：只删**自己写的那把**。锁被别人接管（陈旧接管/人工删除重建）后
          // 盲删＝删掉别人的互斥——两个进程此后同时以为自己在独占，比不加锁更危险。
          try {
            const raw = await readFile(procPath, 'utf8')
            let info = null
            try { info = JSON.parse(raw) } catch (e) { info = null }
            if (!info || info.token !== token) return { released: false, reason: 'not-owner' }
            await rm(procPath, { force: true })
            return { released: true }
          } catch (e) {
            return { released: false, reason: 'gone' } // 锁文件已不在＝已无锁可释放
          }
        },
      }
    } catch (e) {
      if (e && e.code === 'ENOENT') {
        // 书目录还不存在＝这本书还没开（novel_init 首次落盘前）。**不能**就此放弃互斥：
        // 两个进程同时开同一本新书会各自"读到空账本→写全套骨架"，两边都报成功，
        // 磁盘上留下互相覆盖的半套骨架（实测：并发写时 rename 还会撞出 EPERM）。
        // 写类工具先建目录再取锁；只读工具不建（一次打错的 book_dir 不该凭空造出目录）。
        if (!cfg.createDir) return { mode: 'no-book-dir', token: null, release: async () => ({ released: false, reason: 'no-book-dir' }) }
        // 用 processPath 的父目录（绝对 OS 路径）建，而不是拼好的相对 book_dir——
        // 相对路径会相对**本进程**的 cwd 建，可能建到宿主工作区之外
        await mkdir(dirname(procPath), { recursive: true }).catch(() => {})
        continue
      }
      if (!e || e.code !== 'EEXIST') throw e
      if (await lockIsStale(procPath, cfg, { stat, readFile })) {
        await rm(procPath, { force: true }).catch(() => {})
        continue
      }
      if (Date.now() > deadline) {
        throw fail(ERR.LOCK_TIMEOUT, '写锁等待超时：另一进程正在写这本书（' + normalizeBookDir(dir) + '）。等它写完再重试；若确认无进程在写，删掉 ' + rel + ' 后重试。')
      }
      await new Promise((r) => setTimeout(r, cfg.retryMs))
    }
  }
}

/**
 * 进程存活探测：true=活 / false=已死 / null=探不了（不敢判死，交回年龄判定）。
 * EPERM＝进程存在但不属于本用户（活着）；ESRCH＝不存在（死了）；其余（平台怪癖/权限）＝未知。
 */
function isProcessAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return null
  if (pid === process.pid) return true
  try { process.kill(pid, 0); return true } catch (e) {
    if (e && e.code === 'ESRCH') return false
    if (e && e.code === 'EPERM') return true
    return null
  }
}

/**
 * 锁能否被接管。顺序＝先探活、再判年龄（批R2）：活着的持有者即便超过 staleMs 也不抢；
 * 已死的立即接管（崩溃恢复）；探不了活的（别机/无 pid/内容损坏）才退回年龄判定。
 */
async function lockIsStale(procPath, cfg, io) {
  const st = await io.stat(procPath).catch(() => null)
  if (!st) return true // 锁已消失：可直接重来（下一次 open('wx') 见分晓）
  let info = null
  try { info = JSON.parse(await io.readFile(procPath, 'utf8')) } catch (e) { info = null }
  if (info && info.host && HOST && info.host !== HOST) {
    // 别机持有的锁：本机探不了它的 pid（同号进程在别机），只能按年龄——心跳保证活着的它 mtime 是新鲜的
    return Date.now() - st.mtimeMs > cfg.staleMs
  }
  const live = info ? isProcessAlive(info.pid) : null
  if (live === true) return false // 持有者活着 → 不陈旧（等它释放；等待上限由 waitMs 收口）
  if (live === false) return true  // 持有者已死 → 立即接管（崩溃恢复）
  return Date.now() - st.mtimeMs > cfg.staleMs // 探不了活（无 pid / 内容损坏 / 未知错误）→ 年龄判定
}

/**
 * 会写账本的工具：书目录不存在时也要取锁（createDir，先建目录再锁）。
 * ⚠ 维护警示：新增任何**会写文件**的工具都必须加进这个集合——漏了它，这本书还不存在时
 * 该工具会退回无锁路径（并发开书/并发首写＝丢更新）。只读工具**不**进此集合：
 * 只读不该为一次打错的 book_dir 凭空建目录（读类失败是 NOT_FOUND，不是"顺手把书造出来"）。
 */
const WRITE_TOOLS = new Set([
  'novel_init', 'novel_outline', 'novel_chapter', 'novel_ledger', 'novel_event', 'novel_score', 'novel_decide', 'novel_assemble',
])

/**
 * 把 execute 包进写门。只读工具也走同一把锁——按工具逐个分辨读写，判错一次就是静默丢更新；
 * 同一本书的读串行代价相对一次 LLM 调用可忽略。
 * 顺序（批R2）：**先解析别名（@last/归一）→ 再入队 → 再加锁**；解析前入队会把 '@last' 当成
 * 目录名铸出一条查不到的键。@last 记忆只在 inner 成功返回后提交。
 */
function withWriteGate(def) {
  const inner = def.execute
  const createDir = WRITE_TOOLS.has(def.name)
  return async function gatedExecute(args, exec) {
    const fs = exec && exec.agent && exec.agent.ctx && exec.agent.ctx.get ? exec.agent.ctx.get('fs') : undefined
    const rawDir = args && typeof args.book_dir === 'string' && args.book_dir ? args.book_dir : null
    if (!fs || !rawDir) return inner(args, exec)
    const dir = bookRootOf(args, fs)
    const resolvedArgs = Object.assign({}, args, { book_dir: dir })
    return enqueueBook(dir, async () => {
      const lock = await acquireFileLock(fs, dir, { createDir })
      try {
        const out = await inner(resolvedArgs, exec)
        rememberBook(fs, dir) // 只有成功返回才记 @last（失败调用不得把别名劫走）
        return out
      } finally { await lock.release() }
    })
  }
}

export {
  ERR, fail,
  normalizeBookDir, lockKeyOf, lockPathOf,
  bookRootOf, rememberBook, resetLastBook,
  LOCK_DEFAULTS, HOST, WRITE_TOOLS, enqueueBook, acquireFileLock, lockIsStale, isProcessAlive, withWriteGate,
}
