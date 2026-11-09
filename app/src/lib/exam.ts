// 机考模式的本机偏好与原文高亮。
// 只写 localStorage，Electron 已把 userData 重定向到便携目录的 userdata/。

export type TimerMode = 'down' | 'up'
export type ColorScheme = 'light'

export const SCHEME_LABEL: Record<ColorScheme, { name: string; short: string }> = {
  light: { name: 'White', short: 'White' },
}

export type ExamPrefs = {
  /** 倒计时（真实考试）/ 正计时 */
  timerMode: TimerMode
  /** 每节默认时长，单位秒 */
  limits: { reading: number; listening: number; writing: number }
  /** 顶部「Time remaining」是否隐藏 */
  hideTimer: boolean
  /** 打开答题页时是否跳过说明页 */
  skipIntro: boolean
  /** 卷面配色（对应机考 Settings 的 background colour） */
  colorScheme: ColorScheme
  /** 时间是否精确到秒；默认只显示分钟，和真实机考一致 */
  showSeconds: boolean
  /** 练习模式：显示译文 / 对照 / 工具条等真实机考没有的辅助功能 */
  practiceMode: boolean
  /** 写作：把 Task 1 + Task 2（或四六级写作 + 翻译）配成一场 60 分钟的考试 */
  pairTasks: boolean
}

export type HighlightRange = { n: number; s: number; e: number }

/**
 * 原文笔记：机考里选中文字右键 Notes 写的那条备注。
 * 一条笔记可能跨多句，所以拆成多个区间共用同一个 id，改 / 删都按 id 整组处理。
 */
export type NoteRange = { id: string; n: number; s: number; e: number; text: string }

const PREFS_KEY = 'ielts-sim-exam-prefs-v1'
const HL_KEY = 'ielts-sim-highlights-v1'
const NOTE_KEY = 'ielts-sim-notes-v1'

export const DEFAULT_LIMITS = { reading: 20 * 60, listening: 10 * 60, writing: 60 * 60 }

const fallback = (): ExamPrefs => ({
  timerMode: 'down',
  limits: { ...DEFAULT_LIMITS },
  hideTimer: false,
  skipIntro: false,
  colorScheme: 'light',
  showSeconds: false,
  practiceMode: false,
  pairTasks: true,
})

const readJson = <T,>(key: string, fb: T): T => {
  try {
    const raw = localStorage.getItem(key)
    return raw ? (JSON.parse(raw) as T) : fb
  } catch {
    return fb
  }
}

const writeJson = (key: string, value: unknown) => {
  try {
    localStorage.setItem(key, JSON.stringify(value))
  } catch {
    // 隐私模式等写不进去：本次会话仍然生效
  }
}

export function readExamPrefs(): ExamPrefs {
  const base = fallback()
  const raw = readJson<Partial<ExamPrefs>>(PREFS_KEY, {})
  const limits: Partial<ExamPrefs['limits']> = raw.limits || {}
  return {
    timerMode: raw.timerMode === 'up' ? 'up' : 'down',
    limits: {
      reading: Number(limits.reading) > 0 ? Number(limits.reading) : base.limits.reading,
      listening: Number(limits.listening) > 0 ? Number(limits.listening) : base.limits.listening,
      writing: Number(limits.writing) > 0 ? Number(limits.writing) : base.limits.writing,
    },
    hideTimer: Boolean(raw.hideTimer),
    skipIntro: Boolean(raw.skipIntro),
    // 旧版本存过 cream/dark/yellow，一律回落到官方亮色卷面
    colorScheme: 'light',
    showSeconds: Boolean(raw.showSeconds),
    practiceMode: Boolean(raw.practiceMode),
    // 只在新版本明确写过 false 时关闭；老偏好里没有这个字段就保持默认开启
    pairTasks: raw.pairTasks !== false,
  }
}

export function saveExamPrefs(patch: {
  timerMode?: TimerMode
  limits?: Partial<ExamPrefs['limits']>
  hideTimer?: boolean
  skipIntro?: boolean
  colorScheme?: ColorScheme
  showSeconds?: boolean
  practiceMode?: boolean
  pairTasks?: boolean
}) {
  const current = readExamPrefs()
  const next: ExamPrefs = {
    ...current,
    ...patch,
    limits: { ...current.limits, ...(patch.limits || {}) },
  }
  writeJson(PREFS_KEY, next)
  return next
}

/** 同一句里的高亮区间：排序、合并重叠与相接的片段 */
export function mergeHighlights(list: HighlightRange[]): HighlightRange[] {
  const byN = new Map<number, { s: number; e: number }[]>()
  list.forEach((item) => {
    if (!Number.isFinite(item.n) || !Number.isFinite(item.s) || !Number.isFinite(item.e)) return
    const s = Math.max(0, Math.floor(item.s))
    const e = Math.max(0, Math.floor(item.e))
    if (e <= s) return
    const bucket = byN.get(item.n) || []
    bucket.push({ s, e })
    byN.set(item.n, bucket)
  })
  const out: HighlightRange[] = []
  ;[...byN.entries()]
    .sort((a, b) => a[0] - b[0])
    .forEach(([n, ranges]) => {
      ranges.sort((a, b) => a.s - b.s || a.e - b.e)
      let cur = { ...ranges[0] }
      for (let i = 1; i < ranges.length; i++) {
        const r = ranges[i]
        if (r.s <= cur.e) cur.e = Math.max(cur.e, r.e)
        else {
          out.push({ n, ...cur })
          cur = { ...r }
        }
      }
      out.push({ n, ...cur })
    })
  return out
}

export function readHighlights(unitId: number): HighlightRange[] {
  const all = readJson<Record<string, HighlightRange[]>>(HL_KEY, {})
  const list = all[String(unitId)]
  return Array.isArray(list) ? mergeHighlights(list) : []
}

export function saveHighlights(unitId: number, list: HighlightRange[]) {
  const all = readJson<Record<string, HighlightRange[]>>(HL_KEY, {})
  if (list.length) all[String(unitId)] = mergeHighlights(list)
  else delete all[String(unitId)]
  writeJson(HL_KEY, all)
}

export const clearHighlights = (unitId: number) => saveHighlights(unitId, [])

const noteId = () => `n${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`

/** 笔记存储：老数据没有 id 时补一个，越界 / 空区间直接丢掉 */
export function readNotes(unitId: number): NoteRange[] {
  const all = readJson<Record<string, NoteRange[]>>(NOTE_KEY, {})
  const list = all[String(unitId)]
  if (!Array.isArray(list)) return []
  return list
    .filter((item) => item && Number.isFinite(item.n) && Number.isFinite(item.s) && Number.isFinite(item.e))
    .map((item) => ({
      id: typeof item.id === 'string' && item.id ? item.id : noteId(),
      n: Math.floor(item.n),
      s: Math.max(0, Math.floor(item.s)),
      e: Math.max(0, Math.floor(item.e)),
      text: String(item.text || ''),
    }))
    .filter((item) => item.e > item.s && item.text.trim())
    .sort((a, b) => a.n - b.n || a.s - b.s)
}

export function saveNotes(unitId: number, list: NoteRange[]) {
  const all = readJson<Record<string, NoteRange[]>>(NOTE_KEY, {})
  const clean = list
    .map((item) => ({ ...item, s: Math.max(0, Math.floor(item.s)), e: Math.max(0, Math.floor(item.e)) }))
    .filter((item) => item.e > item.s && item.text.trim())
  if (clean.length) all[String(unitId)] = clean
  else delete all[String(unitId)]
  writeJson(NOTE_KEY, all)
}

export const clearNotes = (unitId: number) => saveNotes(unitId, [])
