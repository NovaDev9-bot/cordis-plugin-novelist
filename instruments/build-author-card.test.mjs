/**
 * build-author-card.test.mjs —— 冻结锚卡模式（E1，2026-09-26）与老用法的回归
 *
 * 书无关原则：全部夹具＝系统临时目录里的**合成锚段＋合成节拍＋合成锚书**，跑完即删，
 * 不碰任何真实书工程（书库根目录，路径不入公开仓）与仓库内 craft/。
 *
 * 覆盖（对应总纲 E1 验收：模拟锚段建卡→卡带版本与两栏内容→派工包含卡全文机制在案）：
 *   ① 冻结锚卡模式（--anchor + --beats + --version，附 --book）：卡头带版本号与
 *      「改锚必须 Owner 再来一次」纪律行；锚段一节＝两栏核心（原文锚段逐字 × 结构节拍记录）；
 *      六节骨架仍在；JSON 带 anchor_card 元数据。
 *   ② 冻结锚卡不附 --book：范例槽如实留空（缺料≠违规），审校侧口径报"没测"。
 *   ③ 老用法（--book only）回归：无版本行、无改锚纪律行、锚段自动摘取、3–5 条范例。
 *   ④ Goodhart 自证伸进新输入：节拍里塞"对话占比 40%"必须 exit 1（两栏不是数字后门）。
 *   ⑤ 空锚段文件／非法 --version → exit 2（"没测成"与"测出违规"分开）。
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, readFileSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

const TOOL = fileURLToPath(new URL('./build-author-card.mjs', import.meta.url))

/** 合成锚段（模拟锚段：≈130 汉字，带一处年份数字——原文里的数字不是风格断言，必须放行） */
const ANCHOR_TEXT = [
  '腊月的风从广播站的破窗里灌进来，把墙上那张表扬稿吹得哗啦啦响。',
  '陈满仓把扩音器的旋钮拧到底，喇叭里先是一阵刺耳的电流声，然后才是他那句压得低低的开场白。',
  '1977 年的头一场雪还没有化透，全村人都竖着耳朵在等这条广播：今晚的工分，要重新算。',
].join('\n')

/** 合成结构节拍记录（四分界①合法形状：何事何时发生；允许结构数字，不许表层统计） */
const BEATS_TEXT = [
  '开场 300 字内进主题：广播站改频的冲突立起来。',
  '每 500 字一个小钩，章末留「声音又变了」卡点。',
].join('\n')

/** 合成锚书：四类段落各两段（每段约 90–110 汉字），保证四类范例候选都测得到 */
const CH1 = [
  '队长把烟锅在鞋底上磕了磕，说「今晚的会一个都不许缺」，说完就背着贵走出了饲养场的大门。',
  '「广播稿我改了三遍」秀兰把纸拍在桌上，纸角还带着她手心里的汗，「你再念错一个字，明天的工分咱们俩一起扣」。',
  '他一步跨过水沟，随手抓住低垂的柳枝荡了过去，落地时膝盖一弯卸掉了冲力，回身就把追上来的人推了个趔趄。',
  '两个人在晒谷场上绕着圈跑，一个追一个躲，脚步声惊起了草垛里的一窝麻雀，扑棱棱全飞向了村口的老槐树。',
  '她心里明白这话是说给自己听的，可她不敢回头，只觉得后颈一阵阵发冷，连手里的针线都拿不稳了。',
  '夜里他翻来覆去睡不着，想起白天那句「重新算」，越琢磨越觉得不对味，一股说不清的慌从脚底升了上来。',
  '广播站是三间土坯房，墙上糊着旧报纸，桌上摆着一台漆皮剥落的扩音器，窗台上那盆仙人掌已经枯了半年。',
  '村道两旁的白杨落尽了叶子，水渠冻出一层薄冰，远处饲养场的烟囱斜斜地吐着一缕灰白的烟。',
].join('\n\n')
const CH2 = [
  '秀兰把稿子又抄了一遍，字写得比头一遍还大，「这回你总该念不错了吧」，她把纸卷成筒塞进他上衣口袋。',
  '「念不错」满仓把纸筒掏出来又看了一眼，喉结动了动，「就是这句『重新算』，我念着心里发虚」。',
  '他抬手把门闩拨开，侧身让过门框上挂的辣椒串，三步并作两步蹿上土坡，反手就把跟来的黄狗捞进了怀里。',
  '坡下的雪地上留出一串脚印，深的浅的间隔着，一直排到广播站的台阶前，又被夜里新落的一层雪盖去了一半。',
].join('\n\n')

function writeBook(root) {
  const book = join(root, 'book')
  mkdirSync(join(book, 'manuscript'), { recursive: true })
  writeFileSync(join(book, 'manuscript', 'chapter_1.md'), CH1 + '\n', 'utf8')
  writeFileSync(join(book, 'manuscript', 'chapter_2.md'), CH2 + '\n', 'utf8')
  return book
}

function fixture(t, tag) {
  const root = mkdtempSync(join(tmpdir(), 'nf-bac-' + tag + '-'))
  t.after(() => rmSync(root, { recursive: true, force: true }))
  const anchor = join(root, 'anchor.txt')
  const beats = join(root, 'beats.txt')
  writeFileSync(anchor, ANCHOR_TEXT + '\n', 'utf8')
  writeFileSync(beats, BEATS_TEXT + '\n', 'utf8')
  return { root, anchor, beats, book: writeBook(root) }
}

function run(args) {
  const r = spawnSync(process.execPath, [TOOL, ...args], { encoding: 'utf8' })
  return { code: r.status, out: r.stdout || '', err: r.stderr || '' }
}

test('冻结锚卡模式：卡带版本号＋改锚纪律行＋两栏核心（原文锚段逐字 × 结构节拍记录）', (t) => {
  const fx = fixture(t, 'full')
  const cardPath = join(fx.root, 'card.md')
  const jsonPath = join(fx.root, 'card.json')
  const r = run(['--anchor', fx.anchor, '--beats', fx.beats, '--version', '3', '--date', '2026-09-26',
    '--book', fx.book, '--source', '《合成锚书》· 合成作者', '--out', cardPath, '--json', jsonPath])
  assert.equal(r.code, 0, '应生成成功（exit 0），stderr：\n' + r.err)
  const card = readFileSync(cardPath, 'utf8')
  // 卡头：版本号、冻结日、改锚纪律、每章喂当前版本
  assert.match(card, /冻结锚卡 v3\*\*（冻结日 2026-09-26）/, '卡头应带版本号与冻结日')
  assert.match(card, /改锚必须 Owner 再来一次/, '卡头应带改锚纪律行')
  assert.match(card, /每章派工喂当前版本锚卡/, '卡头应带每章派工喂当前版本锚卡')
  // 两栏核心：表头 + 原文锚段逐字（换行 → <br> 后逐行仍在）+ 节拍记录逐行在
  assert.match(card, /\| 原文锚段（Owner 认可版，逐字冻结） \| 结构节拍记录（何事何时发生） \|/, '两栏核心表头应在')
  for (const line of ANCHOR_TEXT.split('\n')) assert.ok(card.includes(line.trim()), '原文锚段应逐字冻结：' + line.slice(0, 18))
  for (const line of BEATS_TEXT.split('\n')) assert.ok(card.includes(line.trim()), '结构节拍记录应在两栏里：' + line.slice(0, 18))
  assert.doesNotMatch(card, /对话占比|句长中位/, '两栏与卡体不得出现表层统计')
  // 六节骨架仍在
  for (const h of ['## 一、语域指南', '## 二、锚段', '## 三、同场景范例', '## 四、这个作者不会做的事', '## 五、AI 腔黑名单', '## 六、数字去哪了']) {
    assert.ok(card.includes(h), '六节骨架应完整：' + h)
  }
  assert.match(card, /### 对话密集/, '附锚书时范例候选应产出')
  // JSON 侧带锚卡元数据（审计可复算）
  const meta = JSON.parse(readFileSync(jsonPath, 'utf8'))
  assert.equal(meta.generated_from.anchor_card.version, 3)
  assert.equal(meta.generated_from.anchor_card.frozen_on, '2026-09-26')
  assert.equal(meta.generated_from.anchor_card.mode, 'frozen-anchor-card')
  assert.ok(existsSync(cardPath))
})

test('冻结锚卡不附 --book：范例槽如实留空，审校侧口径报"没测"', (t) => {
  const fx = fixture(t, 'nobook')
  const cardPath = join(fx.root, 'card.md')
  const r = run(['--anchor', fx.anchor, '--beats', fx.beats, '--version', '1', '--out', cardPath])
  assert.equal(r.code, 0, '不带 --book 也应生成成功（范例槽留空不算违规），stderr：\n' + r.err)
  const card = readFileSync(cardPath, 'utf8')
  assert.match(card, /冻结锚卡 v1/, '卡头应带版本号')
  assert.match(card, /同场景范例槽\*\*如实留空\*\*/, '范例槽应注明留空')
  assert.doesNotMatch(card, /### /, '不该凭空长出范例候选（无源之水）')
  assert.match(r.err, /未附锚书/, 'stderr 应报"未附锚书"（没测≠测到没有）')
})

test('老用法回归（--book only）：无版本行、无改锚纪律行，锚段自动摘取，范例 3–5 条', (t) => {
  const fx = fixture(t, 'legacy')
  const cardPath = join(fx.root, 'card.md')
  const r = run(['--book', fx.book, '--out', cardPath])
  assert.equal(r.code, 0, 'stderr：\n' + r.err)
  const card = readFileSync(cardPath, 'utf8')
  assert.doesNotMatch(card, /冻结锚卡 v/, '老用法不得冒出版本行')
  assert.doesNotMatch(card, /改锚必须 Owner 再来一次/, '老用法不得冒出改锚纪律行')
  assert.doesNotMatch(card, /每章派工喂当前版本锚卡/, '老用法不得冒出喂卡行')
  assert.match(card, /本卡由 build-author-card 生成，范例来自你自己的锚书/, '生成声明保持原样')
  assert.match(card, /锚段取自第 1 章开头/, '锚段仍由工具自动摘取')
  const n = (card.match(/### /g) || []).length
  assert.ok(n >= 3 && n <= 5, '范例应 3–5 条，实得 ' + n)
})

test('Goodhart 自证伸进新输入：节拍里塞表层统计必须 exit 1（两栏不是数字后门）', (t) => {
  const fx = fixture(t, 'goodhart')
  const badBeats = join(fx.root, 'bad-beats.txt')
  writeFileSync(badBeats, '对话占比 40%以上，短句要多。\n', 'utf8')
  const r = run(['--anchor', fx.anchor, '--beats', badBeats, '--version', '1', '--out', join(fx.root, 'card.md')])
  assert.equal(r.code, 1, '带表层统计的节拍必须被自证拦下，实得 exit ' + r.code + '，stderr：\n' + r.err)
  assert.match(r.err, /自证失败/, '报错应点名自证失败')
})

test('空锚段文件 → exit 2；非法 --version → exit 2（"没测成"与"测出违规"分开）', (t) => {
  const fx = fixture(t, 'bad')
  const empty = join(fx.root, 'empty.txt')
  writeFileSync(empty, '\n', 'utf8')
  const rEmpty = run(['--anchor', empty, '--out', join(fx.root, 'c1.md')])
  assert.equal(rEmpty.code, 2, '空锚段文件＝没测成，实得 ' + rEmpty.code)
  assert.match(rEmpty.err, /空文件冻不成锚卡/)
  const rVer = run(['--anchor', fx.anchor, '--version', '0', '--out', join(fx.root, 'c2.md')])
  assert.equal(rVer.code, 2, '--version 0 非法，实得 ' + rVer.code)
  assert.match(rVer.err, /≥1 的整数/)
  const rVer2 = run(['--anchor', fx.anchor, '--version', 'abc', '--out', join(fx.root, 'c3.md')])
  assert.equal(rVer2.code, 2, '--version abc 非法，实得 ' + rVer2.code)
})
