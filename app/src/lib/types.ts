// 题库数据结构（与构建期抓取的 JSON 对应）
export type Option = { key: string; text: string }

export type Question = {
  number: number
  span?: number
  prompt?: string | null
  options?: Option[] | null
  answers: string
  explanation?: string | null
  tip?: string | null
  quote?: string | null
  evidence?: string | null
}

export type Group = {
  id?: string
  type: string
  instructions?: string | null
  content?: string | null
  image?: { url?: string | null; filename?: string } | null
  options?: Option[] | null
  questions: Question[]
  maxWords?: number | null
  numberAllowed?: boolean | null
}

export type Sentence = { n: number; text: string }
export type Paragraph = {
  label?: string | null
  sentences?: Sentence[] | null
  translation?: string | null
  text?: string | null
}
export type TranscriptLine = {
  n: number
  text: string
  speaker?: string | null
  start?: number | null
  end?: number | null
  p?: number | null
  announce?: boolean | null
}

export type MediaRef = { url?: string | null; filename?: string | null } | null

/** 单元摘要：题库 JSON 里是题型分布数组，旧数据里也可能是纯文本 */
export type SummaryItem = { type?: string | null; count?: number | null; range?: string | null }

export type Unit = {
  id: number
  module: 'listening' | 'reading'
  part?: number | null
  exam: string
  paper?: string | null
  title: string
  audio?: MediaRef
  transcript?: TranscriptLine[] | null
  transcriptTranslations?: string[] | null
  passage?: Paragraph[] | null
  groups: Group[]
  summary?: string | SummaryItem[] | null
  sourceTag?: string | null
  updatedAt?: string
  paraphrases?: { items?: Record<string, { q: string; s: string }[]> } | null
}

export type WritingTask = {
  id: number
  taskType: string
  exam: string
  paper?: string | null
  title?: string | null
  titleZh?: string | null
  prompt?: string | null
  image?: MediaRef
  minWords?: number | null
  maxWords?: number | null
  suggestedMinutes?: number | null
  sampleAnswer?: string | null
  modelAnswerZh?: string | null
  analysis?: string | null
  category?: string | null
  updatedAt?: string
}

export type MockPaper = {
  id: number
  no?: number | null
  title?: string | null
  updatedAt?: string | null
  /** 槽位 → 合成单元 id（l1..r3）；单元内容在 data/units/<id>.json */
  units: Record<string, number>
}

/** 题组摘要：只够列表页与模考页展示题号区间，不含任何题面 */
export type GroupSummary = {
  id?: string
  type: string
  from: number | null
  to: number | null
  /** 题量，多选题按 span 计入 */
  count: number
}

/**
 * 单元摘要：启动时一次性载入（1792 条约 0.65 MB），
 * 题面、原文、选项在打开答题页时再按 id 读取。
 */
export type UnitSummary = {
  id: number
  title: string
  exam: string
  module: 'listening' | 'reading'
  part?: number | null
  paper?: string | null
  updatedAt?: string | null
  hasAudio: boolean
  groups: GroupSummary[]
  questions: number
  from: number | null
  to: number | null
  /** 模考单元：来自哪套卷的哪个槽位 */
  mock?: { paperId: number; key: string }
}

export type MockEntry = { paper: MockPaper; key: string; unit: UnitSummary }
