// platform-export.mjs 单元测试（OSS 布局：仪器在 ../instruments/；TDD 红→绿）
//
// 期望值纪律：正文汉字数用手工数好的字面量（HAN_CH / HAN_TOTAL），**不用被测代码的计数函数算期望值**；
// 期望输出用 literal 拼出（expected()），与被测实现互为独立版本。
import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, readdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

const SCRIPT = fileURLToPath(new URL('../instruments/platform-export.mjs', import.meta.url))

// 夹具：三章，故意混入 CRLF / 行尾空白 / 连续空行 / 首行无标题 / 标题行与 outline 重复
const CRLF = '\r\n'
const CH1 = ['第一章 启程', '', '　　夜风很冷。   ', '他扣紧了斗篷。', '', '', '「走。」他说。'].join(CRLF) + CRLF
const CH2 = ['他想起那封信。', '信上只有两个字。', '', ''].join(CRLF)
const CH3 = ['', '第三章', '', '门外有人。', ''].join('\n')

// 手工计数（只用 /[\u4e00-\u9fff]/ 的直觉逐字点过）：
//   ch1：第一章启程=5 ＋ 夜风很冷=4 ＋ 他扣紧了斗篷=6 ＋ 走他说=3 → 18
//   ch2：他想起那封信=6 ＋ 信上只有两个字=7 → 13
//   ch3：第三章=3 ＋ 门外有人=4 → 7
const HAN_CH = [18, 13, 7]
const HAN_TOTAL = 38

function makeBook(project = { title: '测试书', genre: 'xuanyi', logline: '一句话', current_ch: 3 }) {
  const dir = mkdtempSync(path.join(tmpdir(), 'pe-'))
  mkdirSync(path.join(dir, 'manuscript'), { recursive: true })
  writeFileSync(path.join(dir, 'project.json'), JSON.stringify(project), 'utf8')
  writeFileSync(path.join(dir, 'outline.json'), JSON.stringify({
    volumes: [{ volume: 1, chapters: [
      { chapter_no: 1, title: '开篇' },
      { chapter_no: 2, title: '旧信' },
      { chapter_no: 3, title: '第三章' }, // 标题字段自带章号前缀 → 必须去重，防「第3章 第三章」
    ] }],
  }), 'utf8')
  writeFileSync(path.join(dir, 'manuscript', 'chapter_001.md'), CH1, 'utf8')
  writeFileSync(path.join(dir, 'manuscript', 'chapter_002.md'), CH2, 'utf8')
  writeFileSync(path.join(dir, 'manuscript', 'chapter_003.md'), CH3, 'utf8')
  return dir
}

function run(bookDir, extra = []) {
  const r = spawnSync(process.execPath, [SCRIPT, '--book', bookDir, ...extra], { encoding: 'utf8' })
  return { code: r.status, stdout: r.stdout || '', stderr: r.stderr || '' }
}

/** 期望导出件（literal 手工拼）——标题编号写法是平台表里的软惯例，测试把它钉住防漂移。 */
function expected(platform) {
  const n = platform === 'qidian' ? ['一', '二', '三'] : ['1', '2', '3']
  return [
    `第${n[0]}章 启程`, '',
    '　　夜风很冷。', '',
    '他扣紧了斗篷。', '',
    '「走。」他说。', '',
    `第${n[1]}章 旧信`, '',
    '他想起那封信。', '',
    '信上只有两个字。', '',
    `第${n[2]}章`, '',
    '门外有人。', '',
  ].join('\n')
}

test('番茄(tomato)：章标题规范化 + 段间空行 + 去行尾空白 + CRLF→LF，正文逐字不变', () => {
  const dir = makeBook()
  const { code, stdout, stderr } = run(dir, ['--platform=tomato'])
  assert.equal(code, 0, `退出码应为 0\nstdout:${stdout}\nstderr:${stderr}`)
  const outPath = path.join(dir, 'export', '测试书.tomato.txt')
  assert.ok(existsSync(outPath), '缺省应输出到 book_dir/export/<书名>.<平台>.txt')
  const out = readFileSync(outPath, 'utf8')
  assert.equal(out, expected('tomato'), '整份导出件应逐字等于手工期望值')
  assert.ok(out.startsWith('第1章 启程\n\n'), '首行标题规范化 + 标题后空行')
  assert.ok(!out.includes('\r'), 'CRLF 必须转 LF')
  for (const l of out.split('\n')) assert.equal(l, l.replace(/[ \t\u3000]+$/, ''), '不允许行尾空白：' + JSON.stringify(l))
  assert.ok(!/\n\n\n/.test(out), '连续空行应并成 1 个')
  // 正文逐字不被改动（除空白规范化）：剔除标题行与全部空白后，与源代码字面量逐字相等
  const bodyOnly = out.split('\n').filter((l) => !/^第[0-9零一二三四五六七八九十]+章/.test(l)).join('\n')
  const srcBody = ['　　夜风很冷。', '他扣紧了斗篷。', '「走。」他说。', '他想起那封信。', '信上只有两个字。', '门外有人。'].join('')
  assert.equal(bodyOnly.replace(/\s/g, ''), srcBody.replace(/\s/g, ''), '正文非空白字符必须逐字不变')
})

test('起点(qidian)：章标题用中文数字（软惯例·未核实·表内可调）；中文别名「起点」可识别', () => {
  const dir = makeBook()
  const { code, stderr } = run(dir, ['--platform', '起点']) // 顺带覆盖空格分隔写法
  assert.equal(code, 0, stderr)
  const out = readFileSync(path.join(dir, 'export', '测试书.qidian.txt'), 'utf8')
  assert.equal(out, expected('qidian'))
  assert.ok(out.startsWith('第一章 启程'), '起点口径=中文数字标题')
})

test('统计：章数 / 正文汉字数（手工字面量）/ 目标字节数 / 逐章明细', () => {
  const dir = makeBook()
  const json = path.join(dir, 'report.json')
  const { code, stderr } = run(dir, ['--platform=tomato', '--json', json])
  assert.equal(code, 0, stderr)
  const rep = JSON.parse(readFileSync(json, 'utf8'))
  assert.equal(rep.chapters, 3, '章数')
  assert.equal(rep.han, HAN_TOTAL, `正文汉字总数应等于手工计数 ${HAN_TOTAL}`)
  assert.deepEqual(rep.chapters_detail.map((c) => c.han), HAN_CH, '逐章汉字数应等于手工计数')
  assert.equal(rep.bytes, Buffer.byteLength(expected('tomato'), 'utf8'), '字节数应等于手工期望文本的 UTF-8 字节数')
  assert.equal(rep.dry_run, false)
  assert.ok(rep.out.endsWith('测试书.tomato.txt'), '报告里给出目标文件路径')
})

test('--dry-run：打印计划与统计，但不写任何文件（连输出目录都不建）', () => {
  const dir = makeBook()
  const before = readdirSync(dir).sort()
  const { code, stdout, stderr } = run(dir, ['--platform=tomato', '--dry-run'])
  assert.equal(code, 0, stderr)
  assert.match(stdout, /dry-run/)
  assert.ok(!existsSync(path.join(dir, 'export')), 'dry-run 不得创建 export/ 目录或导出件')
  assert.deepEqual(readdirSync(dir).sort(), before, 'dry-run 不得在书目录留下任何新文件')
  assert.match(stdout, new RegExp(String(HAN_TOTAL)), 'dry-run 应打印统计（含手工计数 ' + HAN_TOTAL + '）')
})

test('未知 platform：可读错误 + 退出码 2，且不写文件', () => {
  const dir = makeBook()
  const { code, stderr } = run(dir, ['--platform=tomato小说'])
  assert.equal(code, 2, '参数错误退出码应为 2')
  assert.match(stderr, /未知|不支持/)
  assert.match(stderr, /tomato/)
  assert.match(stderr, /qidian/)
  assert.match(stderr, /番茄/)
  assert.match(stderr, /起点/)
  assert.ok(!existsSync(path.join(dir, 'export')), '报错路径不得留下输出')
})

test('--out 覆盖输出路径；--header 加书籍信息块（书名缺失则不加）', () => {
  const dir = makeBook()
  const custom = path.join(dir, 'custom', 'book.txt')
  const json = path.join(dir, 'r1.json')
  const { code, stderr } = run(dir, ['--platform=tomato', '--out', custom, '--header', '--json', json])
  assert.equal(code, 0, stderr)
  const out = readFileSync(custom, 'utf8')
  assert.ok(out.startsWith('《测试书》\n\n第1章 启程\n'), '信息块在文件头，书名取自 project.json')
  assert.equal(JSON.parse(readFileSync(json, 'utf8')).header, true)

  // 无书名：不生成信息块，也不报错
  const d2 = makeBook({ genre: 'xuanyi', current_ch: 3 })
  const out2 = path.join(d2, 'no-title.txt')
  const j2 = path.join(d2, 'r2.json')
  const r2 = run(d2, ['--platform=tomato', '--header', '--out', out2, '--json', j2])
  assert.equal(r2.code, 0, r2.stderr)
  assert.ok(!readFileSync(out2, 'utf8').startsWith('《'), 'project.json 无 title 时不得加信息块')
  assert.equal(JSON.parse(readFileSync(j2, 'utf8')).header, false)
})

// ── B9 规则出处与上传前检查（2026-09-22）──────────────────────────────────────
// 病根：旧版文件头写的是一张"坊间软惯例"表，**没有出处**——把"听说"和"规范"混在一处，
// 谁也没法判哪条能照抄、哪条必须实测。这组测试钉两件事：规则必须带出处或显式标未证实；
// 官方明写的驳回原因（空章/乱码/乱序/字数门槛）要真的会报。
function bookWith(chapters, project = { title: '测试书', genre: 'x', logline: '一句话' }) {
  const dir = mkdtempSync(path.join(tmpdir(), 'pe2-'))
  mkdirSync(path.join(dir, 'manuscript'), { recursive: true })
  writeFileSync(path.join(dir, 'project.json'), JSON.stringify(project), 'utf8')
  for (const [name, text] of Object.entries(chapters)) writeFileSync(path.join(dir, 'manuscript', name), text, 'utf8')
  return dir
}
const para = (n) => '这是一段正文。'.repeat(20) + '（' + n + '）'   // 每段 120+ 汉字
const longText = (paras) => Array.from({ length: paras }, (_, i) => para(i)).join('\n\n')

test('B9① 规则表自检：每条规则二选一——有官方出处（带 URL 与原文）或显式标"未证实"', () => {
  const dir = makeBook()
  const jp = path.join(dir, 'rep.json')
  const r = run(dir, ['--platform=tomato', '--dry-run', '--json', jp])
  assert.equal(r.code, 0, r.stderr)
  const spec = JSON.parse(readFileSync(jp, 'utf8')).rule_spec
  const entries = Object.entries(spec)
  assert.ok(entries.length >= 8, '规则表条目太少（规则被删了？）：' + entries.length)
  for (const [k, v] of entries) {
    assert.ok(v.source || v.unverified,
      '规则「' + k + '」既没有出处也没有"未证实"标记——这正是上一版"把听说当规范"的病')
    if (v.source) {
      assert.match(v.source.url, /^https:\/\//, k + ' 的出处必须带可点的官方 URL')
      assert.ok(v.source.quote && v.source.quote.length > 6, k + ' 的出处必须带原文摘句（没有原文＝没法复核）')
    }
  }
})

test('B9② 篇幅与空章：低于平台下限、以及 0 汉字的空章都要被点名（带规则名）', () => {
  const dir = bookWith({
    'chapter_001.md': longText(10),                 // 正常章
    'chapter_002.md': '第2章 短\n\n就一句话。',        // 远低于 1000
    'chapter_003.md': '第3章 空\n\n',                // 0 汉字＝空章
  })
  const jp = path.join(dir, 'rep.json')
  const r = run(dir, ['--platform=tomato', '--dry-run', '--json', jp])
  assert.equal(r.code, 0, r.stderr)
  const hits = JSON.parse(readFileSync(jp, 'utf8')).rule_hits
  assert.ok(hits.some((h) => h.rule === 'chapter_min_han' && h.ch === 2), '低于 1000 汉字要报：' + JSON.stringify(hits))
  assert.ok(hits.some((h) => h.rule === 'reject_reasons' && h.ch === 3 && h.msg.includes('空章')), '空章要报：' + JSON.stringify(hits))
  assert.equal(hits.some((h) => h.ch === 1), false, '正常章不该被报：' + JSON.stringify(hits.filter((h) => h.ch === 1)))
})

test('B9③ 乱码与章号断档：U+FFFD 与跳号都命中（官方驳回原因里的"乱码／章节乱序"）', () => {
  const dir = bookWith({
    'chapter_001.md': longText(10),
    'chapter_003.md': longText(10) + '\n\n这行有替换字符\uFFFD。',
  })
  const jp = path.join(dir, 'rep.json')
  const r = run(dir, ['--platform=tomato', '--dry-run', '--json', jp])
  assert.equal(r.code, 0, r.stderr)
  const hits = JSON.parse(readFileSync(jp, 'utf8')).rule_hits
  assert.ok(hits.some((h) => h.ch === 3 && h.msg.includes('U+FFFD')), '替换字符要报：' + JSON.stringify(hits))
  assert.ok(hits.some((h) => h.msg.includes('章号不连续')), '章号断档要报：' + JSON.stringify(hits))
})

test('B9④ --checklist：两栏分明（有依据带 URL 与原文／未证实带查证说明与实测方法）', () => {
  const dir = makeBook()
  const lp = path.join(dir, 'checklist.md')
  const r = run(dir, ['--platform=tomato', '--checklist', lp, '--dry-run'])
  assert.equal(r.code, 0, r.stderr)
  const md = readFileSync(lp, 'utf8')
  assert.ok(md.includes('## 一、有官方依据'), '缺"有官方依据"栏')
  assert.ok(md.includes('## 二、无公开规范'), '缺"无公开规范"栏')
  assert.ok(/\[[^\]]+\]\(https:\/\//.test(md), '有依据的条目必须带可点的 URL')
  assert.ok(md.includes('章节字数至少1000字'), '官方原文摘句必须进清单')
  assert.ok(md.includes('实测'), '未证实项必须明确要求实测')
  assert.ok(md.includes('没回填就永远是未证实'), '必须写清"回填"这道收口（否则未证实永远挂着）')
  assert.ok(!readdirSync(dir).includes('export'), '--dry-run 不该建 export 目录')
})

test('B9⑤ 书名字符集（番茄）：含官方不允许的字符要点名', () => {
  const dir = bookWith({ 'chapter_001.md': longText(10) }, { title: '《测试》·卷一', genre: 'x', logline: '一句话' })
  const jp = path.join(dir, 'rep.json')
  const r = run(dir, ['--platform=tomato', '--dry-run', '--json', jp])
  assert.equal(r.code, 0, r.stderr)
  const hits = JSON.parse(readFileSync(jp, 'utf8')).rule_hits
  assert.ok(hits.some((h) => h.rule === 'title_charset'), '书名里的《》·不在番茄允许字符集内，要报：' + JSON.stringify(hits))
})
