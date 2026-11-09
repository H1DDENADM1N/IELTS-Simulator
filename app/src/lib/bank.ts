// 离线题库：启动只读索引，题面在打开答题页时按需读取。
//
// data/units-index.json  1792 条单元摘要（真实 + 模考），约 0.65 MB
// data/papers-index.json 64 套模考卷的槽位 → 单元 id
// data/units/<id>.json   单篇完整内容，一篇约 20 KB
//
// 之前启动时全量 JSON.parse 30 MB 题库（解析后约 42 MB 常驻堆），现在启动只占不到 1 MB，
// 打开过的篇目走 8 条 LRU 缓存。
import type { Unit, UnitSummary, WritingTask, MockPaper, MockEntry } from './types'

export type BankBridge = {
  readJson: (name: string) => Promise<string>
  readUnit: (id: number) => Promise<string>
  mediaUrl: (name: string) => string
}

declare global {
  interface Window {
    ieltsSim?: BankBridge
  }
}

/** 最近打开过的单篇保留在这里，避免来回切题重复读盘 */
const CACHE_LIMIT = 8
const unitCache = new Map<number, Unit>()

let units: UnitSummary[] = []
let writingTasks: WritingTask[] = []
let papers: MockPaper[] = []
let mockEntries: MockEntry[] = []
let summaries = new Map<number, UnitSummary>()
let loaded = false

export async function loadBank(): Promise<void> {
  if (loaded) return
  const api = window.ieltsSim
  if (!api) throw new Error('缺少本地数据接口：请用便携版程序打开，不要在普通浏览器里直接打开 HTML。')
  const [rawUnits, rawPapers, rawWriting] = await Promise.all([
    api.readJson('units-index'),
    api.readJson('papers-index'),
    api.readJson('writing-tasks'),
  ])
  const raw = JSON.parse(rawUnits) as UnitSummary[]
  papers = JSON.parse(rawPapers) as MockPaper[]
  writingTasks = JSON.parse(rawWriting) as WritingTask[]
  // 索引里真实单元和模考单元混在一起：题库列表、首页统计只认真实单元，
  // 模考单元只在 /mock 页出现（和拆分前的行为一致）。
  units = raw.filter((u) => !u.mock)
  summaries = new Map(raw.map((u) => [u.id, u]))
  mockEntries = raw
    .filter((u) => u.mock)
    .map((u) => {
      const paper = papers.find((p) => p.id === u.mock!.paperId)
      return paper ? { paper, key: u.mock!.key, unit: u } : null
    })
    .filter((e): e is MockEntry => e != null)
  loaded = true
}

/** 读取单篇完整内容。打开过的篇目留在 LRU 缓存里，超出 8 篇淘汰最旧的一条。 */
export async function loadUnit(id: number): Promise<Unit> {
  const hit = unitCache.get(id)
  if (hit) {
    unitCache.delete(id)
    unitCache.set(id, hit)
    return hit
  }
  const api = window.ieltsSim
  if (!api?.readUnit) throw new Error('缺少本地数据接口：请用便携版程序打开，不要在普通浏览器里直接打开 HTML。')
  const text = await api.readUnit(id)
  const unit = JSON.parse(text) as Unit
  unitCache.set(id, unit)
  if (unitCache.size > CACHE_LIMIT) {
    const oldest = unitCache.keys().next().value
    if (oldest != null) unitCache.delete(oldest)
  }
  return unit
}

/** 单元摘要（标题、题号区间等），答题页加载过程中也能先显示标题 */
export const unitSummary = (id: number) => summaries.get(id)
export const getUnits = () => units
export const getWritingTasks = () => writingTasks
export const getMockPapers = () => papers
export const getMockEntries = () => mockEntries

/**
 * 一套模考卷里某一科的整卷单元，按 Part 1..4 / Passage 1..3 顺序。
 * 整卷模考（一次计时、一次交卷）用它把这几个单元串成一场考试。
 */
export const getPaperUnits = (paperId: number, module: 'listening' | 'reading'): UnitSummary[] =>
  mockEntries
    .filter((e) => e.paper.id === paperId && e.unit.module === module)
    .map((e) => e.unit)
    .sort((a, b) => (a.part ?? 0) - (b.part ?? 0) || (a.from ?? 0) - (b.from ?? 0))

export const findWritingTask = (id: number) => writingTasks.find((x) => x.id === id)

/** 把 /api/media/file/xxx.mp3 之类的引用换成本地文件 URL */
export const mediaFromRef = (ref?: { url?: string | null; filename?: string | null } | null): string => {
  const raw = ref?.url || ref?.filename
  if (!raw) return ''
  const name = decodeURIComponent(raw.split('/').pop() || '')
  return name && window.ieltsSim ? window.ieltsSim.mediaUrl(name) : ''
}

export const EXAM_LABEL: Record<string, string> = {
  ielts: '雅思',
  cet4: '英语四级',
  cet6: '英语六级',
}

export const MODULE_LABEL: Record<string, string> = {
  listening: '听力',
  reading: '阅读',
}

/** 题型代号 → 中文名 */
export const QUESTION_TYPE_LABEL: Record<string, string> = {
  tfng: '判断题',
  ynng: '观点判断题',
  single_choice: '单选题',
  multi_choice: '多选题',
  completion: '填空题',
  matching_information: '信息匹配',
  matching_features: '特征匹配',
  matching_headings: '标题匹配',
  matching_endings: '句尾匹配',
  labelling: '图表标注',
  short_answer: '简答题',
}

/** 列表筛选用短名（对齐线上站点的叫法） */
export const QUESTION_TYPE_SHORT: Record<string, string> = {
  tfng: '判断',
  ynng: '观点判断',
  single_choice: '单选',
  multi_choice: '多选',
  completion: '填空',
  matching_information: '信息匹配',
  matching_features: '特征匹配',
  matching_headings: '标题匹配',
  matching_endings: '句尾匹配',
  labelling: '地图题',
  short_answer: '简答',
}

export const typeLabel = (type?: string | null, short = true): string =>
  !type ? '' : (short ? QUESTION_TYPE_SHORT[type] : QUESTION_TYPE_LABEL[type]) || QUESTION_TYPE_LABEL[type] || type

/**
 * 把单元的 summary 统一成一行文本。
 * 题库 JSON 里它是题型分布数组（[{ type, count, range }]），直接渲染数组会让 React 抛错整页白屏，
 * 这里统一转成「判断题 4 · 填空题 4」这样的字符串。
 */
export function summaryText(summary?: Unit['summary'] | null): string {
  if (!summary) return ''
  if (typeof summary === 'string') return summary
  if (!Array.isArray(summary)) return ''
  const order: string[] = []
  const counts = new Map<string, number>()
  summary.forEach((item) => {
    if (typeof item === 'string') {
      if (!item) return
      if (!counts.has(item)) { order.push(item); counts.set(item, 0) }
      return
    }
    const type = item?.type ? String(item.type) : ''
    if (!type) return
    if (!counts.has(type)) order.push(type)
    const count = Number(item?.count)
    counts.set(type, (counts.get(type) || 0) + (Number.isFinite(count) && count > 0 ? count : 0))
  })
  return order
    .map((type) => {
      const label = QUESTION_TYPE_LABEL[type] || type
      const count = counts.get(type) || 0
      return count > 0 ? `${label} ${count}` : label
    })
    .join(' · ')
}

export type BankScope = 'group' | 'unit'
export type SortKey = 'path' | 'new' | 'title' | 'questions' | 'weak'
export type RowStatus = 'all' | 'undone' | 'done'

export const SORT_LABEL: Record<SortKey, string> = {
  path: '推荐顺序',
  new: '最新收录',
  title: '标题 A–Z',
  questions: '题量最多',
  weak: '薄弱优先',
}

export type BankRow = {
  key: string
  unitId: number
  groupIndex: number | null
  title: string
  exam: string
  module: 'listening' | 'reading'
  part: number | null
  paper: string | null
  types: string[]
  type: string | null
  from: number | null
  to: number | null
  questions: number
  groups: number
  hasAudio: boolean
  summary: string
  updatedAt: number
}

const collator = new Intl.Collator('en', { numeric: true, sensitivity: 'base' })
const examRank = (exam: string) => (exam === 'ielts' ? 0 : exam === 'cet4' ? 1 : exam === 'cet6' ? 2 : 9)
const moduleRank = (module: string) => (module === 'listening' ? 0 : 1)
const partRank = (part: number | null) => (typeof part === 'number' ? part : 99)
const titleKey = (s: string) => s.replace(/\s+/g, ' ').trim()
const updatedOf = (value?: string | null) => (value ? Date.parse(value) || 0 : 0)

export function rangeText(from: number | null, to: number | null): string {
  if (from == null) return ''
  if (to == null || to === from) return `第 ${from} 题`
  return `${from}–${to} 题`
}

/** 小节标签：听力 P4、阅读 R2 */
export function partText(row: { module: string; part: number | null }): string {
  if (row.part == null) return '—'
  return `${row.module === 'reading' ? 'R' : 'P'}${row.part}`
}

let groupRowsCache: BankRow[] | null = null
let unitRowsCache: BankRow[] | null = null

/** 全部题组行：一个单元按 group 拆开，和线上「按题型练」的粒度一致 */
export function allBankRows(scope: BankScope): BankRow[] {
  if (scope === 'group') {
    if (groupRowsCache) return groupRowsCache
    const rows: BankRow[] = []
    units.forEach((unit) => {
      const base = {
        unitId: unit.id,
        title: unit.title,
        exam: unit.exam,
        module: unit.module,
        part: (unit.part ?? null) as number | null,
        paper: unit.paper ?? null,
        hasAudio: unit.hasAudio,
        groups: unit.groups.length,
        updatedAt: updatedOf(unit.updatedAt),
      }
      unit.groups.forEach((group, index) => {
        rows.push({
          ...base,
          key: `${unit.id}:${index}`,
          groupIndex: index,
          types: [group.type],
          type: group.type,
          from: group.from,
          to: group.to,
          questions: group.count,
          summary: typeLabel(group.type),
        })
      })
    })
    groupRowsCache = rows
    return rows
  }
  if (unitRowsCache) return unitRowsCache
  unitRowsCache = units.map((unit) => {
    const types: string[] = []
    unit.groups.forEach((g) => {
      if (!types.includes(g.type)) types.push(g.type)
    })
    return {
      key: String(unit.id),
      unitId: unit.id,
      groupIndex: null,
      title: unit.title,
      exam: unit.exam,
      module: unit.module,
      part: (unit.part ?? null) as number | null,
      paper: unit.paper ?? null,
      types,
      type: null,
      from: unit.from,
      to: unit.to,
      questions: unit.questions,
      groups: unit.groups.length,
      hasAudio: unit.hasAudio,
      summary: summaryText(unit.groups.map((g) => ({ type: g.type, count: g.count }))),
      updatedAt: updatedOf(unit.updatedAt),
    }
  })
  return unitRowsCache
}

export type RowQuery = {
  exam?: string
  module?: string
  type?: string
  keyword?: string
  sort?: SortKey
  scope?: BankScope
  /** 已做题组/整篇的 key */
  doneKeys?: Set<string>
  /** 已练过的单元（整篇或任一题组） */
  doneUnits?: Set<number>
  /** key → 最近一次成绩，用于「薄弱优先」排序 */
  scores?: Map<string, { score: number; total: number }>
}

export function rowDone(row: BankRow, doneKeys?: Set<string>, doneUnits?: Set<number>): boolean {
  if (row.groupIndex == null) return Boolean(doneUnits?.has(row.unitId))
  return Boolean(doneKeys?.has(row.key))
}

export function queryRows(q: RowQuery): BankRow[] {
  const scope = q.scope || 'group'
  const kw = (q.keyword || '').trim().toLowerCase()
  const rows = allBankRows(scope).filter((row) => {
    if (q.exam && row.exam !== q.exam) return false
    if (q.module && row.module !== q.module) return false
    if (q.type && !row.types.includes(q.type)) return false
    if (kw) {
      const hay = `${row.title} ${row.paper || ''} ${row.summary} ${row.types.map((t) => typeLabel(t)).join(' ')}`.toLowerCase()
      if (!hay.includes(kw)) return false
    }
    return true
  })

  const sort = q.sort || 'path'
  const pathCmp = (a: BankRow, b: BankRow) =>
    examRank(a.exam) - examRank(b.exam) ||
    moduleRank(a.module) - moduleRank(b.module) ||
    partRank(a.part) - partRank(b.part) ||
    collator.compare(titleKey(a.title), titleKey(b.title)) ||
    (a.from ?? 0) - (b.from ?? 0) ||
    (a.groupIndex ?? 0) - (b.groupIndex ?? 0)

  const cmp: Record<SortKey, (a: BankRow, b: BankRow) => number> = {
    path: pathCmp,
    new: (a, b) => b.updatedAt - a.updatedAt || pathCmp(a, b),
    title: (a, b) => collator.compare(titleKey(a.title), titleKey(b.title)) || (a.from ?? 0) - (b.from ?? 0),
    questions: (a, b) => b.questions - a.questions || pathCmp(a, b),
    weak: (a, b) => {
      const sa = q.scores?.get(a.key)
      const sb = q.scores?.get(b.key)
      const ra = sa && sa.total ? sa.score / sa.total : null
      const rb = sb && sb.total ? sb.score / sb.total : null
      if (ra == null && rb == null) return pathCmp(a, b)
      if (ra == null) return 1
      if (rb == null) return -1
      return ra - rb || pathCmp(a, b)
    },
  }

  return rows.sort(cmp[sort])
}

export function typeCounts(rows: BankRow[]): { type: string; label: string; count: number }[] {
  const counts = new Map<string, number>()
  rows.forEach((row) => {
    row.types.forEach((t) => counts.set(t, (counts.get(t) || 0) + 1))
  })
  return [...counts.entries()]
    .map(([type, count]) => ({ type, label: typeLabel(type), count }))
    .sort((a, b) => b.count - a.count)
}

export function randomRow(rows: BankRow[]): BankRow | undefined {
  if (!rows.length) return undefined
  return rows[Math.floor(Math.random() * rows.length)]
}

/** 分页页码：1 … 4 5 6 … 28 */
export function pageNumbers(page: number, pages: number): (number | '…')[] {
  if (pages <= 7) return Array.from({ length: pages }, (_, i) => i + 1)
  const out: (number | '…')[] = [1]
  const start = Math.max(2, page - 1)
  const end = Math.min(pages - 1, page + 1)
  if (start > 2) out.push('…')
  for (let i = start; i <= end; i++) out.push(i)
  if (end < pages - 1) out.push('…')
  out.push(pages)
  return out
}

export type ListRow = BankRow

/** 兼容旧调用：整篇列表 */
export function listUnits(exam?: string, module?: string, keyword = ''): ListRow[] {
  return queryRows({ exam, module, keyword, scope: 'unit', sort: 'path' })
}

/** 原文按段落切块：每块带自己的译文，便于「译文」开关逐段展开 */
export type SourceBlock = {
  label?: string | null
  lines: { n: number; text: string }[]
  translation?: string | null
}

export function passageBlocks(u: Unit): SourceBlock[] {
  if (u.module === 'reading') {
    const blocks: SourceBlock[] = []
    ;(u.passage || []).forEach((p, pi) => {
      const sentences = p.sentences || []
      const lines = sentences.length
        ? sentences.map((s) => ({ n: s.n, text: s.text }))
        : p.text
          ? [{ n: pi, text: p.text }]
          : []
      if (lines.length) blocks.push({ label: p.label || null, lines, translation: p.translation || null })
    })
    return blocks
  }

  // 听力：按 transcript 的段落号 p 归组，没有段落号的提示行单独成段
  const blocks: SourceBlock[] = []
  const byParagraph = new Map<number, SourceBlock>()
  const translations = u.transcriptTranslations || []
  ;(u.transcript || []).forEach((line) => {
    const item = { n: line.n, text: line.text }
    if (typeof line.p !== 'number') {
      blocks.push({ lines: [item] })
      return
    }
    let block = byParagraph.get(line.p)
    if (!block) {
      block = { lines: [], translation: translations[line.p] || null }
      byParagraph.set(line.p, block)
      blocks.push(block)
    }
    block.lines.push(item)
  })
  return blocks
}

export const hasSource = (u: Unit) =>
  u.module === 'reading' ? Boolean((u.passage || []).length) : Boolean((u.transcript || []).length)

/** 这篇原文有没有译文：「译文」按钮据此决定是否可点 */
export const hasTranslation = (u: Unit) =>
  u.module === 'reading'
    ? (u.passage || []).some((p) => Boolean(p.translation))
    : (u.transcriptTranslations || []).length > 0
