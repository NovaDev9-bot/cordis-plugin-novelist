/**
 * batch-aggregate.mjs —— R2 批处理器聚合引擎（零 LLM；总蓝图 R2 施工 2026-09-16）
 * 用法：node batch-aggregate.mjs <chapter_file> <samples_dir> [--k=2] [--write <out_dir>]（在本脚本所在目录内执行）
 *          [--gate <anchors.jsonl>]   迁移回归门：与串行审已知 P0 集合一致率 ≥0.8（锚点 ≥10 才判）
 * 详见仓库 README 与批审协议；输入=N 份 {sampler, opinions:[{evidence, issue, p0, kind}]}，
 * 引擎=引文规范化定位（伪引文拒收）→段落坐标聚类→k 票投票升级→单报盲存（审计件）→近全票加采建议。
 */
import { readFileSync, writeFileSync, mkdirSync, readdirSync } from 'node:fs'
import path from 'node:path'

const argv = process.argv.slice(2)
const chapterFile = argv[0]
const samplesDir = argv[1]
if (!chapterFile || !samplesDir) { console.error('用法：node batch-aggregate.mjs <chapter_file> <samples_dir> [--k=2] [--write <out_dir>]'); process.exit(1) }
const k = Number((argv.find((a) => a.startsWith('--k=')) || '--k=2').slice(4))
const writeIdx = argv.indexOf('--write')
const outDir = writeIdx >= 0 ? argv[writeIdx + 1] : null

const STRIP_RE = /[\s，。、；：？！""''（）《》【】…—\-·~\u3000,.:;?!"'()<>[\]]/g
const norm = (s) => String(s).replace(STRIP_RE, '')
const chapter = readFileSync(chapterFile, 'utf8')
const chapterNorm = norm(chapter)
const paras = chapter.split(/\n+/)
const paraOffsets = []
let acc = 0
for (const p of paras) { paraOffsets.push([acc, acc + norm(p).length]); acc += norm(p).length }
const paraOf = (idx) => { for (let i = 0; i < paraOffsets.length; i++) { if (idx >= paraOffsets[i][0] && idx < paraOffsets[i][1]) return i } return paraOffsets.length - 1 }

const files = readdirSync(samplesDir).filter((f) => f.endsWith('.json') && !f.startsWith('_'))
const samples = files.map((f) => JSON.parse(readFileSync(path.join(samplesDir, f), 'utf8')))
const rejected = []
const rejected_short = []
const hits = []
for (const s of samples) {
  for (const o of (s.opinions || [])) {
    const ev = norm(o.evidence || '')
    if (ev.length < 4) { rejected_short.push({ sampler: s.sampler, evidence: String(o.evidence).slice(0, 30) }); continue }
    const at = chapterNorm.indexOf(ev)
    if (at < 0) { rejected.push({ sampler: s.sampler, reason: '伪引文拒收（未命中正文）', evidence: String(o.evidence).slice(0, 30) }); continue }
    hits.push({ sampler: s.sampler, para: paraOf(at), kind: String(o.kind || '?'), evidence: String(o.evidence).slice(0, 60), issue: String(o.issue || ''), p0: !!o.p0 })
  }
}
const clusters = new Map()
for (const h of hits) {
  const key = h.para + '#' + h.kind
  if (!clusters.has(key)) clusters.set(key, [])
  clusters.get(key).push(h)
}
const escalated = []
const single = []
const p0_review = []
for (const [key, members] of clusters) {
  const voters = [...new Set(members.map((m) => m.sampler))]
  const rec = { para: key.split('#')[0], kind: key.split('#')[1], votes: voters.length, total: members.length, p0: members.some((m) => m.p0), representative: members[0], samplers: voters }
  if (voters.length >= k) escalated.push(rec)
  else if (rec.p0) p0_review.push(rec) // p0 严重单报：证据不因票少隐没，入待复核（不自动确诊——单票同坐标≠语义共识）
  else single.push(rec)
}
escalated.sort((a, b) => b.votes - a.votes || (b.p0 ? 1 : 0) - (a.p0 ? 1 : 0))

console.log(`# 批审聚合（${samples.length} 采样员 / ${hits.length} 有效意见 / ${rejected.length} 伪引文拒收 / ${rejected_short.length} 过短跳过 / k=${k}）`)
console.log(`分歧点 ${escalated.length} 条（≥k 独立采样同坐标）：`)
for (const e of escalated.slice(0, 10)) {
  console.log(`  [${e.p0 ? 'P0' : e.kind}] 第${Number(e.para) + 1}段 ×${e.votes}票（${e.samplers.join('/')}）｜${e.representative.evidence}…｜${e.representative.issue}`)
}
if (escalated.length === 0) console.log('  （无——本批无分歧升级）')
if (p0_review.length) {
  console.log(`待复核 ${p0_review.length} 条（p0 严重单报，未达 k 票——单票证据保留待人工复核，不自动确诊）：`)
  for (const e of p0_review.slice(0, 10)) {
    console.log(`  [P0·待复核] 第${Number(e.para) + 1}段 1票（${e.samplers.join('/')}）｜${e.representative.evidence}…｜${e.representative.issue}`)
  }
}
console.log(`单报 ${single.length} 条已盲存（不展示，防聚合点污染；审计见 _aggregate.json）`)

if (outDir) {
  mkdirSync(outDir, { recursive: true })
  const out = { ts: new Date().toISOString(), chapter: chapterFile, samples: samples.length, k, rejected, rejected_short, escalated, p0_review, single_blind: single }
  const p = path.join(outDir, '_aggregate-' + Date.now() + '.json')
  writeFileSync(p, JSON.stringify(out, null, 2))
  console.log('盲存+审计件：' + p)
}
const near = escalated.filter((e) => e.votes === samples.length - 1)
if (near.length) console.log(`建议：${near.length} 簇近全票（${samples.length - 1}/${samples.length}），可加采 1-2 份再聚合`)

// ── R2 迁移回归门（依据：批审协议 §口径 "一致率 0.8 = 迁移回归门"）─────────────
// 规则："与串行审已知 P0 集合一致率 ≥0.8（**锚点 ≥10 条裁决记录后才生效**，冷启动期此口径不判）"。
// 这条 2026-09-16 就写进协议了，而**代码里一直没有这道门**——总台账因此把 R2 的验收
// 挂在"需裁决锚点积累"上。但那是两件事：
//   · **门本身对不对**（冷启动判不判、一致率算得对吗）→ 用**合成锚点当场就能验收**；
//   · **真判官达不达标** → 只能等真实锚点积累。
// 现在落成可执行的门：`--gate <anchors.jsonl>`，每行 {para, kind, verdict:"p0"|"ok"}。
{
  const gi = argv.indexOf('--gate')
  if (gi >= 0) {
    const af = argv[gi + 1]
    if (!af) { console.error('用法：--gate <anchors.jsonl>（每行 {para, kind, verdict:"p0"|"ok"}）'); process.exit(2) }
    const MIN_ANCHORS = 10      // 冷启动门槛，写死在代码里＝这条纪律不靠人记
    const PASS_RATE = 0.8
    const anchors = readFileSync(af, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l))
    // 口径按协议原话：比的是 **P0 集合**（"与串行审已知 P0 集合一致率"）。
    // 所以"非 P0 的锚点"只要求在 P0 集合里**不出现**——它被升级成非 P0 分歧不算不一致。
    const aggP0 = new Set(escalated.filter((e) => e.p0).map((e) => e.para + '#' + e.kind))
    const mismatch = []
    let hit = 0
    for (const a of anchors) {
      const key = String(a.para) + '#' + a.kind
      const inAggP0 = aggP0.has(key)
      const agree = a.verdict === 'p0' ? inAggP0 : !inAggP0
      if (agree) hit++
      else mismatch.push({ key, want: a.verdict, agg: inAggP0 ? 'p0' : '不在P0集合' })
    }
    const rate = anchors.length ? hit / anchors.length : null
    const gate = {
      anchors: anchors.length, min_anchors: MIN_ANCHORS, pass_rate: PASS_RATE,
      hit, rate: rate === null ? null : Math.round(rate * 1000) / 1000, mismatch,
    }
    if (anchors.length < MIN_ANCHORS) {
      // 冷启动：**明确报"不判"**，不报 0.8 也不报 PASS——"没判"不是"通过"
      gate.verdict = `不判（冷启动：锚点 ${anchors.length}/${MIN_ANCHORS} 条，口径未生效）`
      console.log(`\n${gate.verdict}`)
    } else if (rate >= PASS_RATE) {
      gate.verdict = `PASS（一致率 ${(rate * 100).toFixed(1)}% ≥ ${PASS_RATE * 100}%，锚点 ${anchors.length}）`
      console.log(`\n迁移回归门：${gate.verdict}`)
    } else {
      gate.verdict = `FAIL（一致率 ${(rate * 100).toFixed(1)}% < ${PASS_RATE * 100}%，锚点 ${anchors.length}）`
      console.log(`\n迁移回归门：${gate.verdict}`)
      for (const m of mismatch.slice(0, 10)) console.log(`  ✗ ${m.key}｜串行审=${m.want}｜本聚合=${m.agg}`)
    }
    if (outDir || true) {
      const dst = outDir || path.dirname(path.resolve(chapterFile))
      mkdirSync(dst, { recursive: true })
      writeFileSync(path.join(dst, '_gate-' + Date.now() + '.json'), JSON.stringify(gate, null, 2))
      console.log('门记录：_gate-*.json（判也留、不判也留）')
    }
    // 冷启动**不算失败**（协议明写"此口径不判"），但也不许被读成通过——退出码 0，输出写明"不判"
    if (gate.verdict.startsWith('FAIL')) process.exit(1)
  }
}
