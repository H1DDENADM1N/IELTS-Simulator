// 把整包题库拆成「索引 + 单篇」，供前端按需加载。
//
// 输入（保持不动，作为可重跑的源）：
//   data/units.json        1344 个单元，30 MB
//   data/mock-papers.json  64 套卷，每套内嵌 7 个完整单元，8.3 MB
// 输出：
//   data/units-index.json   全部单元（真实 + 模考）的摘要，约 0.6 MB
//   data/papers-index.json  模考卷元数据 + 单元 id 列表，几十 KB
//   data/units/<id>.json    单篇完整内容，共 1792 个文件
//
// 模考单元在卷子里存的是子集（例如只有 4 组 7 题），且 audio / group.image 只有数字 media ID，
// 因此不能引用原单元，要按合成 id 单独落盘，并把这两个引用按同 id 的真实单元补齐。
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const DATA = path.join(ROOT, 'data')
const OUT = path.join(DATA, 'units')
const MOCK_KEYS = ['l1', 'l2', 'l3', 'l4', 'r1', 'r2', 'r3']
const MOCK_BASE = 100000

const log = (...parts) => console.log('[split]', ...parts)

const readJson = (file) => JSON.parse(fs.readFileSync(path.join(DATA, file), 'utf8'))
const sizeMb = (n) => (n / 1048576).toFixed(2) + ' MB'
const spanOf = (q) => Math.max(q.span || 1, 1)

/** 题组题量：把 span（占多个题号的多选题）算进去 */
const groupCount = (group) => (group.questions || []).reduce((sum, q) => sum + spanOf(q), 0)

/** 题组题号区间：结束题号要加上最后一道题的 span */
const groupRange = (group) => {
  const numbers = (group.questions || []).map((q) => q.number)
  if (!numbers.length) return { from: null, to: null }
  const from = Math.min(...numbers)
  const last = (group.questions || []).filter((q) => q.number === Math.max(...numbers))[0]
  return { from, to: Math.max(...numbers) + spanOf(last) - 1 }
}

const pickRange = (ranges) => {
  const valid = ranges.filter((r) => r.from != null)
  if (!valid.length) return { from: null, to: null }
  return { from: Math.min(...valid.map((r) => r.from)), to: Math.max(...valid.map((r) => r.to)) }
}

/** 索引条目：列表页、筛选、排序、模考页只用这些字段，一份就够 */
function summarize(unit, extra = {}) {
  const groups = (unit.groups || []).map((group) => {
    const { from, to } = groupRange(group)
    return { id: group.id, type: group.type || 'completion', from, to, count: groupCount(group) }
  })
  const overall = pickRange(groups)
  return {
    id: unit.id,
    title: unit.title,
    exam: unit.exam,
    module: unit.module,
    part: unit.part ?? null,
    paper: unit.paper ?? null,
    updatedAt: unit.updatedAt ?? null,
    hasAudio: Boolean(unit.audio && (unit.audio.url || unit.audio.filename)),
    groups,
    questions: groups.reduce((sum, g) => sum + g.count, 0),
    from: overall.from,
    to: overall.to,
    ...extra,
  }
}

function main() {
  const units = readJson('units.json')
  const papers = readJson('mock-papers.json')

  // 合成 id 不能撞上真实 id，否则按需加载会读到错误的文件
  const realIds = new Set(units.map((u) => u.id))
  const maxReal = Math.max(...units.map((u) => u.id))
  if (maxReal >= MOCK_BASE) throw new Error(`真实单元 id 已达到 ${maxReal}，与模考号段 ${MOCK_BASE} 冲突`)

  fs.rmSync(OUT, { recursive: true, force: true })
  fs.mkdirSync(OUT, { recursive: true })

  const index = []
  let bytes = 0
  let mockFiles = 0

  for (const unit of units) {
    index.push(summarize(unit))
    const text = JSON.stringify(unit)
    fs.writeFileSync(path.join(OUT, `${unit.id}.json`), text)
    bytes += Buffer.byteLength(text)
  }
  log(`真实单元 ${units.length} 篇，${sizeMb(bytes)}`)

  // 卷子内嵌的单元是真实单元的子集，按合成 id 单独落盘
  const slimPapers = []
  const byId = new Map(units.map((u) => [u.id, u]))
  for (const paper of papers) {
    const map = {}
    MOCK_KEYS.forEach((key, i) => {
      const raw = paper[key]
      if (!raw || typeof raw !== 'object') return
      const original = byId.get(raw.id)
      // 卷子里的 audio 与题组配图都只有数字 media ID，按同 id 的真实单元补齐本地引用。
      // 题组按 group.id 对齐：卷子是真实单元的子集，题组 id 保持一致。
      const originalGroups = new Map((original?.groups || []).map((g) => [g.id, g]))
      const groups = (raw.groups || []).map((g) => {
        if (g.image && typeof g.image === 'object') return g
        const image = originalGroups.get(g.id)?.image || null
        return image ? { ...g, image } : g
      })
      const unit = {
        ...raw,
        id: MOCK_BASE + paper.id * 10 + i,
        exam: raw.exam || 'ielts',
        paper: paper.title || `模考 ${paper.no ?? paper.id}`,
        audio: typeof raw.audio === 'object' ? raw.audio : original?.audio || null,
        groups,
        title: raw.title || paper.title || '模考单元',
      }
      const text = JSON.stringify(unit)
      fs.writeFileSync(path.join(OUT, `${unit.id}.json`), text)
      bytes += Buffer.byteLength(text)
      mockFiles++
      index.push(summarize(unit, { mock: { paperId: paper.id, key } }))
      map[key] = unit.id
    })
    slimPapers.push({
      id: paper.id,
      no: paper.no ?? null,
      title: paper.title ?? null,
      updatedAt: paper.updatedAt ?? null,
      units: map,
    })
  }
  log(`模考单元 ${mockFiles} 篇，累计 ${sizeMb(bytes)}`)

  const indexText = JSON.stringify(index)
  const papersText = JSON.stringify(slimPapers)
  fs.writeFileSync(path.join(DATA, 'units-index.json'), indexText)
  fs.writeFileSync(path.join(DATA, 'papers-index.json'), papersText)
  log(`索引 ${index.length} 条：units-index.json ${sizeMb(Buffer.byteLength(indexText))}，papers-index.json ${sizeMb(Buffer.byteLength(papersText))}`)

  verify(units, index, slimPapers)
  log(`完成。data/units/ 共 ${fs.readdirSync(OUT).length} 个文件`)
  log(`原先 units.json + mock-papers.json = ${sizeMb(
    fs.statSync(path.join(DATA, 'units.json')).size + fs.statSync(path.join(DATA, 'mock-papers.json')).size,
  )} 全量进内存 → 现在启动只读 ${sizeMb(Buffer.byteLength(indexText) + Buffer.byteLength(papersText))}`)
}

/** 拆分后的文件必须能还原出和原始数据一致的题量、题号区间、题型 */
function verify(units, index, papers) {
  const byId = new Map(index.map((e) => [e.id, e]))
  let checked = 0
  for (const unit of units) {
    const entry = byId.get(unit.id)
    if (!entry) throw new Error(`索引缺少单元 ${unit.id}`)
    const expected = (unit.groups || []).reduce((sum, g) => sum + groupCount(g), 0)
    if (entry.questions !== expected) throw new Error(`单元 ${unit.id} 题量不一致：${entry.questions} != ${expected}`)
    if (entry.groups.length !== (unit.groups || []).length) throw new Error(`单元 ${unit.id} 题组数不一致`)
    checked++
  }
  const files = fs.readdirSync(OUT)
  if (files.length !== index.length) throw new Error(`单篇文件数 ${files.length} 与索引条数 ${index.length} 不一致`)
  for (const entry of index) {
    const one = JSON.parse(fs.readFileSync(path.join(OUT, `${entry.id}.json`), 'utf8'))
    if (one.id !== entry.id) throw new Error(`文件 ${entry.id}.json 的 id 不匹配`)
    const expected = (one.groups || []).reduce((sum, g) => sum + groupCount(g), 0)
    if (expected !== entry.questions) throw new Error(`文件 ${entry.id}.json 题量与索引不一致`)
    for (const g of one.groups || []) {
      if (g.image != null && typeof g.image !== 'object') {
        throw new Error(`文件 ${entry.id}.json 的题组 ${g.id} 配图仍是 media ID：补齐逻辑未生效`)
      }
    }
  }
  const mockCount = index.filter((e) => e.mock).length
  const paperSlots = papers.reduce((sum, p) => sum + Object.keys(p.units).length, 0)
  if (mockCount !== paperSlots) throw new Error(`模考单元数不一致：${mockCount} != ${paperSlots}`)
  log(`校验通过：${checked} 个真实单元 + ${mockCount} 个模考单元，题量与区间全部一致`)
}

main()
