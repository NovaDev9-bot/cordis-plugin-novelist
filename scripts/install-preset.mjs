#!/usr/bin/env node
/**
 * 编辑部 starter 预设的装机脚本（2026-10-13 新增，随 DSH 0.2.0 的预设机制变更）。
 *
 * 为什么需要它：0.1.5 时代预设货架是**目录扫描**——把 `preset.yml` + `agent.cordis.yml`
 * 拷进 `~/.dsh/.agent-presets/<id>/` 就出现在模式选择器里。0.2.0-rc.2 起换成**声明式**：
 * `@deepseek-ai/dsh-agent-preset-registry` **不扫描目录、不接受预设路径**，预设只能是
 * profile 补丁层里的一行 `@deepseek-ai/dsh-agent-preset` 声明，且该声明由 **bundle** 携带
 * （bundle 的 package.json 用 `dsh.bundle.patch` 指向自己的补丁文件，再由 profile 选中）。
 *
 * 所以这里把 preset-starter/ 的两份真源渲染成一个**本机 bundle**（落 DSH_HOME，不进仓），
 * 剩下的装载交给 DSH 官方入口：
 *   agent 侧：plugin_manager 工具 install_bundle → target = 本脚本打印的 bundle 目录
 *   CLI 侧 ：本脚本 --install（内部执行 dsh plugin --profile <p> add <bundle 目录>）
 *
 * 真源唯一：`preset-starter/agent.cordis.yml`（条目清单）与 `preset-starter/preset.yml`
 * （展示名/说明/排序）。改预设改这两份，然后重跑本脚本——bundle 是派生件，别手改。
 *
 * 用法：
 *   node scripts/install-preset.mjs                 # 渲染到 $DSH_HOME（不装 profile；打印装机命令）
 *   node scripts/install-preset.mjs --install       # 渲染后调 `dsh plugin --profile web add` 装机
 *   node scripts/install-preset.mjs --check         # 只读比对：一致 0 / 漂移 2 / 未安装 3
 *   node scripts/install-preset.mjs --dry-run       # 只看渲染结果不写盘
 *   node scripts/install-preset.mjs --preset-id my-editorial --profile myprofile
 */
import { readFileSync, writeFileSync, mkdirSync, existsSync, rmSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { spawnSync } from 'node:child_process'

// bundle 包名（= profile 的 dsh.profile.bundles 里出现的名字；本地私有，不发 npm）
const BUNDLE_PKG_NAME = 'cordis-plugin-novelist-preset'
const BUNDLE_VERSION = '1.0.0'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const SRC_AGENT = join(root, 'preset-starter', 'agent.cordis.yml')
const SRC_PRESET_YML = join(root, 'preset-starter', 'preset.yml')

const args = process.argv.slice(2)
const dryRun = args.includes('--dry-run')
const doInstall = args.includes('--install')
const idIdx = args.indexOf('--preset-id')
const presetId = idIdx >= 0 ? args[idIdx + 1] : 'editorial-starter'
const profileIdx = args.indexOf('--profile')
const profileName = profileIdx >= 0 ? args[profileIdx + 1] : 'web'

const dshHome = process.env.DSH_HOME || join(process.env.USERPROFILE || process.env.HOME || '', '.dsh')
const destDir = join(dshHome, '.agent-presets', presetId)
const bundleDir = join(destDir, 'bundle')
const destPatch = join(bundleDir, 'cordis.patch.yml')
const destPkg = join(bundleDir, 'package.json')
const profileManifest = join(dshHome, 'profiles', profileName, 'package.json')

// ── 读真源（并当场挡住"形状变了却静默拼出坏 YAML"这类事故）────────────────────
const agentYml = readFileSync(SRC_AGENT, 'utf8')
if (agentYml.includes('\t')) {
  console.error('[fail] preset-starter/agent.cordis.yml 含制表符——YAML 缩进会坏（改用空格）')
  process.exit(1)
}
if (!/^\s*- id: persona\s*$/m.test(agentYml)) {
  console.error('[fail] preset-starter/agent.cordis.yml 里找不到 `- id: persona`——文件形状变了？')
  process.exit(1)
}
if (!/name: 'cordis-plugin-novelist'/.test(agentYml)) {
  console.error("[fail] preset-starter/agent.cordis.yml 里找不到工具行 `name: 'cordis-plugin-novelist'`"
    + '——它必须按 npm 包名引用（本预设的前提是先装插件）')
  process.exit(1)
}

/** preset.yml 只认「行首 key: value」单行形状；改成块标量就当场报错，不静默拼坏。
 *  块标量指示符（| 与 >）本身不是空值，只查"空"会把它当字面值写进声明——显式挡掉。 */
function readPresetMeta() {
  const meta = {}
  const raw = readFileSync(SRC_PRESET_YML, 'utf8')
  if (raw.includes('\t')) {
    console.error('[fail] preset-starter/preset.yml 含制表符——YAML 缩进会坏（改用空格）')
    process.exit(1)
  }
  const lines = raw.split('\n')
  for (const [i, line] of lines.entries()) {
    if (line.trim() === '' || line.trimStart().startsWith('#')) continue
    const m = line.match(/^([A-Za-z][A-Za-z0-9]*):[ ]?(.*)$/)
    if (!m || m[2].trim() === '' || /^[|>]/.test(m[2].trim())) {
      console.error('[fail] preset.yml:' + (i + 1) + ' 不是「key: 单行值」形状（空值/块标量也算）：' + JSON.stringify(line)
        + '——本脚本只认这一种；改了形状就来改这里')
      process.exit(1)
    }
    meta[m[1]] = m[2]
  }
  for (const key of ['name', 'description', 'order']) {
    if (meta[key] === undefined) {
      console.error('[fail] preset.yml 缺 ' + key + '（声明行需要它）')
      process.exit(1)
    }
  }
  return meta
}
const meta = readPresetMeta()

/** 组合清单整块缩进到 config.plugins 之下（空行保持空，不留尾随空格）。 */
const indent = (text, pad) => text.split('\n').map((l) => (l.length ? pad + l : '')).join('\n')

const patchDoc = [
  '# 由 scripts/install-preset.mjs 生成（勿手改；改预设请改 preset-starter/ 的两份真源后重装）。',
  '# 语义：往 profile 补丁层 insert 一行 @deepseek-ai/dsh-agent-preset 声明（DSH 0.2.0 起预设的唯一载体）。',
  '- insert:',
  '    - id: preset-' + presetId,
  "      name: '@deepseek-ai/dsh-agent-preset'",
  '      config:',
  '        id: ' + presetId,
  '        name: >-',
  '          ' + meta.name,
  '        description: >-',
  '          ' + meta.description,
  '        order: ' + meta.order,
  '        plugins:',
  indent(agentYml.replace(/\s+$/, ''), '          '),
].join('\n') + '\n'

const pkgDoc = JSON.stringify({
  name: BUNDLE_PKG_NAME,
  version: BUNDLE_VERSION,
  private: true,
  type: 'module',
  description: 'cordis-plugin-novelist 编辑部 starter 预设（由 scripts/install-preset.mjs 生成）',
  dsh: { bundle: { patch: './cordis.patch.yml' } },
}, null, 2) + '\n'

/** 首个差异的下标（两侧长度不同时也说得准；have 是 want 前缀时不再误报 -1）。 */
function firstDiffAt(have, want) {
  const a = [...have]
  const b = [...want]
  for (let i = 0; i < Math.max(a.length, b.length); i++) if (a[i] !== b[i]) return i
  return -1
}

/** 装机 profile 的 dsh.profile.bundles 里有本 bundle，**且依赖指向本装机位的 bundle 目录**。
 *  只查名单会漏掉一种真状态：名单里有名字、而 dependencies 的 link 指着另一个（旧的）bundle 目录
 *  ——那时 DSH 读到的不是我们这份，门禁却绿。返回 null＝正常，否则一句人话的偏差描述。 */
function profileBundleProblem() {
  if (!existsSync(profileManifest)) return profileName + ' 的 package.json 不存在：' + profileManifest
  let manifest
  try { manifest = JSON.parse(readFileSync(profileManifest, 'utf8')) } catch (e) { return profileName + ' 的 package.json 解析失败：' + String(e && e.message) }
  const bundles = (manifest.dsh && manifest.dsh.profile && manifest.dsh.profile.bundles) || []
  if (!bundles.includes(BUNDLE_PKG_NAME)) return profileName + ' 的 dsh.profile.bundles 里没有 ' + BUNDLE_PKG_NAME + '（bundle 文件在装机位，但模式选择器读不到）'
  const dep = (manifest.dependencies || {})[BUNDLE_PKG_NAME]
  if (typeof dep !== 'string') return BUNDLE_PKG_NAME + ' 不在 ' + profileName + ' 的 dependencies 里（名单里有、依赖没有⇒装载对象不明）'
  // 归一：scheme 大小写不敏感、反斜杠转正斜杠、去尾斜杠（归一越松＝假红越少；判绿方向不受影响）
  const norm = (s) => s.replace(/\\/g, '/').replace(/^(link|file):/i, '').replace(/\/+$/, '').toLowerCase()
  const want = norm(bundleDir)
  const got = norm(dep)
  if (got !== want) return BUNDLE_PKG_NAME + ' 的依赖指向 ' + dep + '，不是本装机位的 ' + bundleDir.replace(/\\/g, '/') + '（名单里有名字、读的却是另一份——必须重装）'
  return null
}

/** 用 DSH 自己的补丁解析器验一遍生成件（脚本不认识 YAML，只比"渲染件 vs 装机件"时两侧同错必绿）。
 *  只读：`--dump-config` 组合补丁后打印即退出，不挂载插件、不写任何东西。
 *  判定口径：**只有诊断点名我们这份文件**（parse 失败）才算红——抓得住真坏 YAML，
 *  也不会因为别人机器上没有 dsh 或 profile 有别的毛病而假红。 */
function smokeCompose(patchPath) {
  // profile 不存在时不冒烟：`dsh --profile X` 会**顺手从模板建一个** X（实测 2026-10-13），
  // 那就是在"只读"的 --check 里写盘了。宁可跳过并说明。
  if (!existsSync(join(dshHome, 'profiles', profileName))) {
    return { ok: false, skipped: true, detail: 'profile ' + profileName + ' 不存在（不冒烟：dsh 会顺手建一个）' }
  }
  const cmd = 'dsh --profile ' + profileName + ' --patch "' + patchPath.replace(/\\/g, '/') + '" --dump-config'
  const r = spawnSync(cmd, { encoding: 'utf8', shell: true, maxBuffer: 64 * 1024 * 1024 })
  if (r.error) return { ok: false, skipped: true, detail: String(r.error.message || r.error) }
  const out = String(r.stdout || '') + String(r.stderr || '')
  if (r.status === 0) return { ok: true, detail: '' }
  const ours = /failed to parse/.test(out) && out.includes(patchPath.split(/[\\/]/).pop())
  const lines = out.split('\n').map((l) => l.trim()).filter(Boolean)
  const key = lines.find((l) => /failed to parse|Error:|error:/.test(l)) || ''
  return { ok: !ours, skipped: !ours, detail: [key, ...lines.slice(-3)].filter(Boolean).join(' | ').slice(0, 600) }
}

// ── --check：只读比对（CI 不跑；给本机与"装完没生效"的排查用）─────────────────
if (args.includes('--check')) {
  if (!existsSync(destDir)) {
    console.error('[check] 未安装：' + destDir + '——先跑 node scripts/install-preset.mjs')
    process.exit(3)
  }
  const diffs = []
  for (const [dest, want, label] of [[destPatch, patchDoc, 'bundle/cordis.patch.yml'], [destPkg, pkgDoc, 'bundle/package.json']]) {
    if (!existsSync(dest)) { diffs.push('缺 ' + label + '：' + dest); continue }
    const have = readFileSync(dest, 'utf8')
    if (have !== want) {
      const at = firstDiffAt(have, want)
      const where = at === -1
        ? '长度不同（装机件 ' + [...have].length + ' 字符 / 生成件 ' + [...want].length + ' 字符）'
        : '首个差异在 ' + at + ' 字符附近'
      diffs.push('漂移 ' + label + '：' + dest + '（' + where + '）')
    }
  }
  const bundleProblem = profileBundleProblem()
  if (bundleProblem) diffs.push('未装进 profile：' + bundleProblem)
  if (existsSync(destPatch)) {
    const smoke = smokeCompose(destPatch)
    if (smoke.skipped) console.log('[warn] 组合冒烟未判定（' + smoke.detail + '）——只比了文件')
    else if (!smoke.ok) diffs.push('生成件过不了 DSH 自己的补丁解析器（真源 YAML 就是坏的）：\n      ' + smoke.detail)
    else console.log('[ok] 生成件过了 DSH 自己的补丁解析器（--dump-config exit 0）')
  }
  if (diffs.length) {
    console.error('[check] 装机位与真源不一致：')
    for (const d of diffs) console.error('  ' + d)
    console.error('处置：node scripts/install-preset.mjs --install')
    process.exit(2)
  }
  console.log('[check] 装机位与真源一致，且已选入 profile ' + profileName)
  process.exit(0)
}

console.log('[info] DSH_HOME   = ' + dshHome)
console.log('[info] 装机目录     = ' + destDir)
console.log('[info] 装机 profile = ' + profileName + '（bundle 名 ' + BUNDLE_PKG_NAME + '）')

if (dryRun) {
  console.log('[dry-run] 不写入。bundle/cordis.patch.yml 将生成 ' + Buffer.byteLength(patchDoc, 'utf8') + ' 字节')
  process.exit(0)
}

mkdirSync(bundleDir, { recursive: true })
// 先拿 DSH 自己的解析器验一遍再落盘：真源 YAML 坏掉时宁可这一步就报停，
// 也不要让"渲染件与装机件逐字一致"这种绿把它盖过去。
const smokePath = join(bundleDir, '.smoke-cordis.patch.yml')
writeFileSync(smokePath, patchDoc, 'utf8')
const smoke = smokeCompose(smokePath)
rmSync(smokePath)
if (smoke.skipped) {
  console.log('[warn] 组合冒烟未判定（' + smoke.detail + '）——继续，但只比文件')
} else if (!smoke.ok) {
  console.error('[fail] 生成件过不了 DSH 自己的补丁解析器——**真源 YAML 坏了**，先修 preset-starter/{agent.cordis.yml,preset.yml}：')
  console.error('  ' + smoke.detail)
  process.exit(5)
} else {
  console.log('[ok] 组合冒烟：DSH 补丁解析器认可（--dump-config exit 0）')
}

writeFileSync(destPatch, patchDoc, 'utf8')
writeFileSync(destPkg, pkgDoc, 'utf8')
console.log('[ok] 预设 bundle：' + destPatch.replace(/\\/g, '/'))

const bundleProblem = profileBundleProblem()
if (!bundleProblem) {
  console.log('[ok] bundle 已在 profile ' + profileName + ' 的 dsh.profile.bundles 里且依赖指向本装机位'
    + '（内容变更由 HMR 热重载；替换后行为未变就重启 dsh web）')
} else if (doInstall) {
  console.log('[info] ' + bundleProblem + '——按 --install 走一遍重装（会覆盖依赖指向）')
  const cmd = 'dsh plugin --profile ' + profileName + ' add "' + bundleDir.replace(/\\/g, '/') + '"'
  console.log('[run] ' + cmd)
  const r = spawnSync(cmd, { stdio: 'inherit', shell: true, cwd: root })
  if (r.status !== 0) {
    console.error('[fail] 装机失败（exit ' + r.status + '）——文件已渲染在装机位，修好后重跑 --install')
    process.exit(4)
  }
  console.log('[ok] bundle 已装机：刷新/重启 dsh web 后，模式选择器可选「' + meta.name + '」')
} else {
  console.log('[next] bundle 未装进 profile。装机两选一（一次即可）：')
  console.log('   agent 侧：plugin_manager install_bundle → target = ' + bundleDir.replace(/\\/g, '/'))
  console.log('   CLI 侧 ：node scripts/install-preset.mjs --install')
  console.log('   前提：插件已装（dsh plugin --profile ' + profileName + ' add cordis-plugin-novelist）')
}

// 0.1.5 老机制的残留（曾把预设放这里）：留着会让人以为"拷进去就生效"
for (const f of [join(destDir, 'agent.cordis.yml'), join(destDir, 'preset.yml')]) {
  if (existsSync(f)) {
    rmSync(f)
    console.log('[ok] 已清 0.1.5 老机制文件（0.2.0 起无人读）：' + f.replace(/\\/g, '/'))
  }
}
