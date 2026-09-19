/**
 * novelist MCP —— fs 适配层 + workspace 根安全（G1，v0.8.0）。
 *
 * lib/novelist.js 面向 DSH fs 服务编程（resolve/stat/readText/writeText/listDir/processPath，
 * 全 async）。MCP 形态没有宿主 fs 服务，本文件用 node:fs 实现同语义适配器，经伪造的
 * exec.agent.ctx.get('fs') 注入——lib 执行逻辑零改动。
 *
 * 路径安全（MCP 形态硬前置）：DSH 宿主有工作区根约束，MCP server 没有——本层自担。
 * 所有路径（含 novel_count 的 file 模式）一律圈在书库根内：词法校验（path.relative 防
 * ../ 逃逸与跨盘绝对路径）+ 已存在路径 realpath 校验（防 symlink 指出根外）。威胁模型=
 * 模型幻觉指路/提示注入，非本地恶意进程（机器是用户自己的）。
 */
import { promises as fsp } from 'node:fs'
import { realpathSync } from 'node:fs'
import path from 'node:path'

/**
 * 归一化路径：对"最深的已存在祖先"取 realpath，再拼回尚未存在的尾部。
 * 为什么不能直接 fsp.realpath(root)：书库根可能尚未创建（MCP server 可先起后建书库）；
 * 为什么必须归一：Windows 上 8.3 短名（`RUNNER~1`）与长名（`runneradmin`）、symlink/junction
 * 会让"同一个目录"有两种字面路径——CI windows-latest 上 tmpdir() 就是短名，realpath 展开
 * 成长名，未归一的根会把全部根内路径误判越界（2026-09-18 实测 25 项失败）。
 * **必须用 native 实现**：`realpathSync`（JS 实现）不展开 8.3 短名，而守卫侧的 `fsp.realpath`
 * 走 libuv（native）会展开——两侧不同实现正是这个缺陷第二次复发的直接原因（首修即踩）。
 */
const realpathNative = realpathSync.native || realpathSync

function canonicalize(p) {
  let cur = path.resolve(p)
  const tail = []
  for (;;) {
    try {
      const real = realpathNative(cur)
      return tail.length ? path.join(real, ...tail) : real
    } catch {
      const parent = path.dirname(cur)
      if (parent === cur) return path.resolve(p) // 到盘根仍不存在（真不存在）→ 退回词法形
      tail.unshift(path.basename(cur))
      cur = parent
    }
  }
}

export function createNodeFsAdapter(rootInput) {
  if (!rootInput || !String(rootInput).trim()) {
    throw new Error('[novelist-mcp] 书库根为空：启动必须带 --root <目录> 或环境变量 NOVELIST_ROOT（MCP 无宿主沙箱，所有路径必须圈在根内）')
  }
  const root = path.resolve(String(rootInput).trim())
  // 词法根与归一化根可能是两种字面（短名/链接）——**两形都算根内**（同一个目录）。
  const canonRoot = canonicalize(root)
  const bases = canonRoot === root ? [root] : [root, canonRoot]
  const within = (base, p) => {
    const rel = path.relative(base, p)
    return !(rel === '..' || rel.startsWith('..' + path.sep) || path.isAbsolute(rel))
  }
  // 逃逸判定：对任一"根的字面形"都不在内部才算越界。
  // 注意不能用 startsWith('..') 一刀切——根内目录名 '..foo' 会被误杀。
  const escaped = (p) => !bases.some((b) => within(b, p))
  const guard = (p, what) => {
    // 候选路径也要过同一套归一化再比：客户端给的可能是短名/链接的字面形（windows runner 的
    // tmpdir 是 RUNNER~1），而 server 启动时已把根 realpath 成长名（runneradmin）——两形
    // 同目录。只在字面层比会把"根内的合法路径"误判成越界（2026-09-19 真进程 e2e 在
    // windows runner 实测抓到；与下方 canonicalize 的注释同族，但那是根侧、这是候选侧）。
    if (escaped(canonicalize(p))) throw new Error('[novelist-mcp] 路径越界被拒（' + what + '；书库根=' + root + '）：' + p)
  }
  // 已存在路径的真实路径也必须在根内（symlink 逃逸防线）；不存在则仅词法校验。
  const guardReal = async (p, what) => {
    const real = await fsp.realpath(p).catch(() => null)
    if (real) guard(real, what + '(realpath)')
  }

  return {
    root,
    /** DSH 语义：接受绝对/相对路径，返回规范化绝对路径；MCP 版相对路径按书库根解析。 */
    async resolve(input) {
      const s = String(input)
      const p = path.isAbsolute(s) ? path.resolve(s) : path.resolve(root, s)
      guard(p, 'resolve')
      await guardReal(p, 'resolve')
      return p
    },
    /** DSH 语义：不存在返回 null（非抛错）；存在返回至少含 size 的描述对象。 */
    async stat(p) {
      guard(p, 'stat')
      await guardReal(p, 'stat')
      try {
        const st = await fsp.stat(p)
        return { size: st.size, isDirectory: st.isDirectory(), mtimeMs: st.mtimeMs }
      } catch { return null }
    },
    async readText(p) {
      guard(p, 'readText')
      await guardReal(p, 'readText')
      return fsp.readFile(p, 'utf8')
    },
    /** 同目录 temp+rename 原子发布 + 自动建父目录（对齐 DSH dsh-fs-local writeText 后端语义）。 */
    async writeText(p, content) {
      guard(p, 'writeText')
      const dir = path.dirname(p)
      await guardReal(dir, 'writeText(dir)')
      await fsp.mkdir(dir, { recursive: true })
      const tmp = path.join(dir, '.tmp-' + process.pid + '-' + Math.random().toString(36).slice(2))
      await fsp.writeFile(tmp, content, 'utf8')
      try { await fsp.rename(tmp, p) } catch (e) { await fsp.rm(tmp, { force: true }).catch(() => {}); throw e }
    },
    /** DSH 语义：返回 {name, kind} 条目数组；目录不存在抛错（lib 侧已 try/catch 兜底）。 */
    async listDir(p) {
      guard(p, 'listDir')
      await guardReal(p, 'listDir')
      const entries = await fsp.readdir(p, { withFileTypes: true })
      return entries.map((e) => ({ name: e.name, kind: e.isDirectory() ? 'dir' : 'file' }))
    },
    /** 适配层路径本就是真实 OS 路径：直接返回——lib 的 os-append 臂（O_APPEND）照常工作。 */
    async processPath(p) {
      guard(p, 'processPath')
      await guardReal(p, 'processPath')
      return p
    },
  }
}
