/**
 * batch-report.mjs —— 生产批日报生成器（总蓝图 R9 · 2026-09-13 第一批）
 * 用法：node batch-report.mjs <book_dir> [--write]
 *
 * 从账本自动抽取每生产批日报：章状态分布/本批新章/伏笔收支与逾期/长线清单/
 * 判据账摘要/事件带尾窗/待裁事项。零 LLM、纯账本事实，Owner 一眼可扫（目标 ≤5 分钟）。
 * 日报落 book_dir/editorial/reports/日报-YYYY-MM-DD.md（--write 时），否则打印 stdout。
 */
import { readFileSync, existsSync, writeFileSync, mkdirSync, readdirSync } from 'node:fs'
import path from 'node:path'

const dir = process.argv[2]
if (!dir) { console.error('用法：node batch-report.mjs <book_dir> [--write]'); process.exit(1) }
const doWrite = process.argv.includes('--write')
const B = (f) => path.join(dir, f)
const load = (f, d) => { try { return JSON.parse(readFileSync(B(f), 'utf8')) } catch { return d } }
const lines = (f) => { try { return readFileSync(B(f), 'utf8').trim().split('\n').filter(Boolean).map(l => { try { return JSON.parse(l) } catch { return null } }).filter(Boolean) } catch { return [] } }
const han = (t) => (String(t).match(/[\u4e00-\u9fff]/g) || []).length

const status = load('status.json', {})
const project = load('project.json', {})
const fsh = load('foreshadows.json', { foreshadows: [] })
const tape = lines('editorial/events-tape.jsonl')
const events = lines('events.jsonl')
const scores = lines('editorial/scores.jsonl')
const cur = project.current_ch || 0

// 章状态分布 + 字数（读 manuscript 逐章数太重，只数到 current）
const dist = {}
for (const k of Object.keys(status)) dist[status[k]] = (dist[status[k]] || 0) + 1
// 本批新章 = 事件账今日 chapter_commit 的去重章
const today = new Date().toISOString().slice(0, 10)
const commits = events.filter(e => e.op === 'chapter_commit' && String(e.at || '').slice(0, 10) === today)
const newChs = [...new Set(commits.map(e => e.ch))].sort((a, b) => a - b)
const open = fsh.foreshadows.filter(f => f.status !== 'closed')
const overdue = open.filter(f => f.due_ch != null && f.due_ch < cur)
const longline = open.filter(f => f.due_ch != null && f.due_ch > cur + 30) // R6 长线清单（跨卷伏笔常驻）
const threads = tape.filter(e => e.kind === 'open_thread' && !tape.some(x => x.closes_thread === e.id))
const scoreToday = scores.filter(s => String(s.ts || '').slice(0, 10) === today)
const dims = {}
for (const s of scoreToday) { dims[s.dim] = dims[s.dim] || []; dims[s.dim].push(s.score) }

const L = []
L.push(`# 生产批日报 · ${today}`)
L.push('')
L.push(`**当前章：ch${cur} ｜ 章状态分布：${Object.entries(dist).map(([k, v]) => `${k}×${v}`).join('、') || '无'}**`)
L.push('')
L.push('## 本批新章（今日 commit）')
L.push(newChs.length ? newChs.map(c => { const h = commits.filter(e => e.ch === c).pop()?.han; return `- ch${c}：${h ?? '?'} 汉字（${status[c] || '草稿'}）` }).join('\n') : '- 今日无新章')
L.push('')
L.push(`## 伏笔收支`)
L.push(`- 总埋 ${fsh.foreshadows.length} / 已收 ${fsh.foreshadows.length - open.length} / 未收 ${open.length}`)
L.push(`- **逾期未收（${overdue.length}）**：${overdue.map(f => `${f.id}「${f.name}」due${f.due_ch}`).join('、') || '无 ✓'}`)
L.push(`- **长线清单（due > ch${cur + 30}，${longline.length} 条·R6 常驻）**：${longline.map(f => `${f.id}(due${f.due_ch})`).join('、') || '无'}`)
L.push('')
L.push(`## 未闭欠线（事件带）`)
L.push(threads.length ? threads.map(t => `- ${t.id}「${t.what}」预期 ch${t.closes} 收`).join('\n') : '- 无 ✓')
L.push('')
// 拍点兑现栏（主编改进方向3）：呈本批各章细纲拍点+钩子+判据账意见，Owner 扫日报即核执行漂移
L.push(`## 拍点兑现（细纲 vs 正文，Owner 目检栏）`)
if (newChs.length) {
  const outline = load('outline.json', { volumes: [] })
  for (const c of newChs) {
    let e = null
    for (const vol of outline.volumes || []) { const x = (vol.chapters || []).find(k => k.chapter_no === c); if (x) { e = x; break } }
    const scoresCh = scoreToday.filter(s => s.ch === c)
    const hookS = scoresCh.filter(s => s.dim === '钩子').map(s => s.score)
    L.push(`- ch${c} 拍点：「${(e?.goal || e?.title || '?').slice(0, 40)}」钩子：「${(e?.hook || '?').slice(0, 30)}」｜判据账：钩子${hookS.length ? hookS.join('/') : '无'}（守门口径）`)
  }
  L.push('- ⚠ 本栏只呈事实，拍点是否兑现=Owner 目检（正文执行漂移机检不可判）')
} else L.push('- 今日无新章')
L.push('')
L.push(`## 判据账（今日，守门口径·R8：不作为"写得好"的证据）`)
L.push(scoreToday.length ? Object.entries(dims).map(([d, v]) => `- ${d}：n=${v.length} 均${(v.reduce((a, b) => a + b, 0) / v.length).toFixed(1)}`).join('\n') : '- 今日无判词')
L.push('')
// 成本行：账本可见的调用面计数（估算口径——写手=每章 1 交付+批审采样另计）。
// 「批量产出」这一半使命此前从无数据，日报顺手把可免费得到的那部分记下来。
const blindDir = B('editorial/blind-samples')
let blindCount = 0
try { for (const d of readdirSync(blindDir)) { try { blindCount += readdirSync(path.join(blindDir, d)).filter(f => f.endsWith('.json') && !f.startsWith('_')).length } catch { /* 非目录跳过 */ } } } catch { /* 尚无批审目录 */ }
L.push(`## 成本行（账本可见调用面）`)
L.push(`- 今日：章交付 ${commits.length} 次 / 判词 ${scoreToday.length} 条 / 盲采样累计 ${blindCount} 份（批审协议阶梯 2→6，近全票才加采）`)
L.push(`- ⚠ 跨零点批次会被"今日"口径切分（wall-clock 启发式，跨天批以 events 全量为准）`)
L.push('')
L.push(`## 待 Owner 事项`)
const deadIds = new Set(tape.filter(e => e.supersedes).map(e => e.supersedes)) // v7.4 撤销语义：已作废裁决不再入待办
const pending = tape.filter(e => e.kind === 'decision' && !deadIds.has(e.id) && /待|呈|Owner/.test(e.what || '') && String(e.ts || '').slice(0, 10) === today)
L.push(pending.length ? pending.map(e => `- ${e.id} ${e.what}`).join('\n') : '- 本日报无自动识别的待裁项（走向呈报/细纲三行以主编实际呈报为准）')
L.push('')
L.push(`> 生成：batch-report.mjs（账本事实，零判断）· ${new Date().toLocaleString('zh-CN')}`)

const out = L.join('\n')
if (doWrite) { const rp = B('editorial/reports'); mkdirSync(rp, { recursive: true }); const f = path.join(rp, `日报-${today}.md`); writeFileSync(f, out, 'utf8'); console.log('已落盘: ' + f) } else console.log(out)
