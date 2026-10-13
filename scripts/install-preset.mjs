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

/** preset.yml 只认「行首 key: value」单行形状；改成块标量就当场报错，不静默拼坏。 */
function readPresetMeta() {
  const meta = {}
  const lines = readFileSync(SRC_PRESET_YML, 'utf8').split('\n')
  for (const [i, line] of lines.entries()) {
    if (line.trim() === '' || line.trimStart().startsWith('#')) continue
    const m = line.match(/^([A-Za-z][A-Za-z0-9]*):[ ]?(.*)$/)
    if (!m || m[2].trim() === '') {
      console.error('[fail] preset.yml:' + (i + 1) + ' 不是「key: 单行值」形状：' + JSON.stringify(line)
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

function profileHasBundle() {
  if (!existsSync(profileManifest)) return false
  try {
    const manifest = JSON.parse(readFileSync(profileManifest, 'utf8'))
    return ((manifest.dsh && manifest.dsh.profile && manifest.dsh.profile.bundles) || []).includes(BUNDLE_PKG_NAME)
  } catch { return false }
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
    if (readFileSync(dest, 'utf8') !== want) diffs.push('漂移 ' + label + '：' + dest)
  }
  if (!profileHasBundle()) diffs.push('未装进 profile ' + profileName + '（bundle 文件在装机位，但模式选择器读不到）')
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
writeFileSync(destPatch, patchDoc, 'utf8')
writeFileSync(destPkg, pkgDoc, 'utf8')
console.log('[ok] 预设 bundle：' + destPatch.replace(/\\/g, '/'))

if (profileHasBundle()) {
  console.log('[ok] bundle 已在 profile ' + profileName + ' 的 dsh.profile.bundles 里（内容变更由 HMR 热重载；'
    + '替换后行为未变就重启 dsh web）')
} else if (doInstall) {
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
