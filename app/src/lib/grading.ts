// 交卷判分：复用原项目的等价答案规则（大小写、标点、数字、英美拼写、括号可选项）
import { isCorrect, scoreMulti } from './scoring'
import type { Group, Unit } from './types'

export type Answers = Record<number, string | string[]>

export const FIXED_OPTIONS: Record<string, { key: string; text: string }[]> = {
  tfng: ['TRUE', 'FALSE', 'NOT GIVEN'].map((k) => ({ key: k, text: k })),
  ynng: ['YES', 'NO', 'NOT GIVEN'].map((k) => ({ key: k, text: k })),
}

export function optionsFor(group: Group, unit: Unit) {
  if (group.options?.length) return group.options
  if (FIXED_OPTIONS[group.type]) return FIXED_OPTIONS[group.type]
  if (group.type === 'matching_information') {
    return (unit.passage || [])
      .filter((p) => p.label)
      .map((p) => ({ key: p.label as string, text: `Paragraph ${p.label}` }))
  }
  return []
}

export function usesTextInput(group: Group, unit: Unit) {
  return optionsFor(group, unit).length === 0 && group.type !== 'matching_information'
}

export type GradeItem = {
  number: number
  correct: number
  max: number
  expected: string
  explanation?: string | null
  tip?: string | null
  evidence?: string | null
  quote?: string | null
}

export type GradeResult = { score: number; total: number; items: GradeItem[] }

export function grade(unit: Unit, answers: Answers): GradeResult {
  const items: GradeItem[] = []
  for (const group of unit.groups || []) {
    for (const q of group.questions || []) {
      const value = answers[q.number]
      const expected = q.answers || ''
      let correct = 0
      let max = 1
      if (group.type === 'multi_choice') {
        max = Math.max(q.span || 2, 1)
        const picked = Array.isArray(value) ? value : value ? [value] : []
        correct = Math.min(scoreMulti(picked, expected), max)
      } else if (typeof value === 'string' && value) {
        correct = isCorrect(value, expected, {
          type: group.type as never,
          maxWords: group.maxWords,
          numberAllowed: group.numberAllowed,
        })
          ? 1
          : 0
      }
      items.push({
        number: q.number,
        correct,
        max,
        expected,
        explanation: q.explanation,
        tip: q.tip,
        evidence: q.evidence,
        quote: q.quote,
      })
    }
  }
  return {
    score: items.reduce((a, b) => a + b.correct, 0),
    total: items.reduce((a, b) => a + b.max, 0),
    items,
  }
}

/** "9" / "0-2" / "29-32" → 句子编号集合 */
export function evidenceNumbers(evidence?: string | null): Set<number> {
  const out = new Set<number>()
  if (!evidence) return out
  for (const part of evidence.split(/[，,\s]+/)) {
    const m = /^(\d+)(?:\s*-\s*(\d+))?$/.exec(part.trim())
    if (!m) continue
    const from = Number(m[1])
    const to = m[2] ? Number(m[2]) : from
    for (let n = from; n <= Math.min(to, from + 80); n++) out.add(n)
  }
  return out
}
