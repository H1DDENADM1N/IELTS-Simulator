// 答题记录：全部存 localStorage。Electron 主进程已把 userData 重定向到便携目录，
// 因此这些记录只会写进便携文件夹，不碰系统用户目录和注册表。
import type { Answers } from './grading'

const KEY = 'ielts-sim-store-v1'

/** 题型分项统计：c = 得分数，t = 总题数 */
export type TypeStat = Record<string, { c: number; t: number }>

export type Attempt = {
  /** 整篇 = "539"；题组 = "539:0"（兼容旧数据时按 unitId 推导） */
  key?: string
  unitId: number
  groupIndex?: number
  title: string
  /** 「Part 4 · 第 31–40 题 · 填空」这样的范围标签 */
  scope?: string
  score: number
  total: number
  at: number
  seconds: number
  answers: Answers
  wrong: number[]
  types?: TypeStat
}

/** 未交卷的作答草稿：换页、切题、关掉程序都不会丢 */
export type PracticeDraft = {
  key: string
  unitId: number
  groupIndex?: number
  title: string
  scope?: string
  answers: Answers
  seconds: number
  at: number
  total: number
  /** 机考模式里「标记本题」的题号 */
  marked?: number[]
}

type State = {
  /** 整篇成绩；键为整篇时是 unitId，题组时是 `${unitId}:${groupIndex}` */
  attempts: Record<string, Attempt>
  /** 写作草稿：taskId → 文本 */
  drafts: Record<string, string>
  /** 练习草稿：题目 key → 作答与计时 */
  practice: Record<string, PracticeDraft>
}

const empty = (): State => ({ attempts: {}, drafts: {}, practice: {} })

const attemptKey = (unitId: number, groupIndex?: number | null) =>
  groupIndex == null ? String(unitId) : `${unitId}:${groupIndex}`

export const practiceKey = attemptKey

export function readState(): State {
  try {
    const raw = localStorage.getItem(KEY)
    if (!raw) return empty()
    const parsed = JSON.parse(raw) as Partial<State>
    return {
      attempts: parsed.attempts || {},
      drafts: parsed.drafts || {},
      practice: parsed.practice || {},
    }
  } catch {
    return empty()
  }
}

function write(state: State) {
  localStorage.setItem(KEY, JSON.stringify(state))
}

export function saveAttempt(attempt: Attempt) {
  const state = readState()
  const key = attempt.key || attemptKey(attempt.unitId, attempt.groupIndex)
  state.attempts[key] = { ...attempt, key }
  write(state)
}

/** 整篇成绩（不含题组成绩） */
export function getAttempt(unitId: number): Attempt | undefined {
  return readState().attempts[attemptKey(unitId)]
}

export function getAttemptByKey(key: string): Attempt | undefined {
  return readState().attempts[key]
}

export function attemptsForUnit(unitId: number): Attempt[] {
  const state = readState()
  return Object.values(state.attempts).filter((a) => a.unitId === unitId)
}

export function saveDraft(id: number, text: string) {
  const state = readState()
  state.drafts[id] = text
  write(state)
}

export function getDraft(id: number): string {
  return readState().drafts[id] || ''
}

export function savePracticeDraft(draft: PracticeDraft) {
  const state = readState()
  state.practice[draft.key] = draft
  write(state)
}

export function getPracticeDraft(key: string): PracticeDraft | undefined {
  return readState().practice[key]
}

export function clearPracticeDraft(key: string) {
  const state = readState()
  if (!state.practice[key]) return
  delete state.practice[key]
  write(state)
}

/** 最近一次还有作答的草稿（用于首页「继续上次」） */
export function latestPracticeDraft(): PracticeDraft | undefined {
  const items = Object.values(readState().practice).filter((d) => Object.keys(d.answers || {}).length > 0)
  return items.sort((a, b) => b.at - a.at)[0]
}

export function allAttempts(): Attempt[] {
  return Object.values(readState().attempts)
    .map((a) => ({ ...a, key: a.key || attemptKey(a.unitId, a.groupIndex) }))
    .sort((a, b) => b.at - a.at)
}

/** 按题组汇总各题型正确率 */
export function typeAccuracy(): TypeStat & { __total: { c: number; t: number } } {
  const out: TypeStat & { __total: { c: number; t: number } } = { __total: { c: 0, t: 0 } }
  Object.values(readState().attempts).forEach((a) => {
    if (!a.types) return
    Object.entries(a.types).forEach(([type, v]) => {
      const cur = out[type] || { c: 0, t: 0 }
      cur.c += v.c
      cur.t += v.t
      out[type] = cur
    })
  })
  Object.values(out).forEach((v) => {
    if (v === out.__total) return
    out.__total.c += v.c
    out.__total.t += v.t
  })
  return out
}

export function clearAll() {
  localStorage.removeItem(KEY)
}
