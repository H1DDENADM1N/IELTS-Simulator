import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import {
  AnnotationArea,
  ExamAudio,
  GroupBlock,
  ResultBar,
  SourcePanel,
  closeMenus,
  focusQuestion,
  formatTime,
  slotLabel,
} from '../components'
import {
  EXAM_LABEL,
  getPaperUnits,
  hasSource,
  hasTranslation,
  loadUnit,
  rangeText,
  typeLabel,
  unitSummary,
} from '../lib/bank'
import {
  DEFAULT_LIMITS,
  clearHighlights,
  clearNotes,
  mergeHighlights,
  readExamPrefs,
  readHighlights,
  readNotes,
  saveExamPrefs,
  saveHighlights,
  saveNotes,
  type HighlightRange,
  type NoteRange,
  type TimerMode,
} from '../lib/exam'
import {
  FONT_LABEL,
  getFontFace,
  setFontFace,
  subscribeFontFace,
  type FontFace,
} from '../lib/fontface'
import { evidenceNumbers, grade, optionsFor, type Answers, type GradeItem, type GradeResult } from '../lib/grading'
import {
  clearPracticeDraft,
  getAttemptByKey,
  getPracticeDraft,
  practiceKey,
  saveAttempt,
  savePracticeDraft,
  type PracticeDraft,
  type TypeStat,
} from '../lib/store'
import {
  TEXT_MAX,
  TEXT_MIN,
  getTextScale,
  resetTextScale,
  setTextScale,
  stepTextScale,
  subscribeTextScale,
} from '../lib/textscale'
import type { Unit } from '../lib/types'

const countOf = (value?: string | string[]) =>
  Array.isArray(value) ? (value.length ? 1 : 0) : value && value.trim() ? 1 : 0

/** 答题页内的题型显示一律英文（站点题库仍是中文界面） */
const TYPE_LABEL_EN: Record<string, string> = {
  tfng: 'TRUE / FALSE / NOT GIVEN',
  ynng: 'YES / NO / NOT GIVEN',
  single_choice: 'Multiple choice',
  multi_choice: 'Multiple choice',
  completion: 'Note completion',
  sentence_completion: 'Sentence completion',
  summary_completion: 'Summary completion',
  table_completion: 'Table completion',
  flow_chart_completion: 'Flow-chart completion',
  matching_information: 'Matching information',
  matching_features: 'Matching features',
  matching_headings: 'Matching headings',
  matching_endings: 'Matching sentence endings',
  matching: 'Matching',
  labelling: 'Labelling a diagram',
  short_answer: 'Short answer',
  map: 'Map labelling',
}
const typeLabelEn = (type?: string | null) => (type ? TYPE_LABEL_EN[type] || typeLabel(type) : '')

/** 题目 / 原文 / 对照 */
type Pane = 'questions' | 'source' | 'both'
const isWide = () => typeof window !== 'undefined' && window.matchMedia('(min-width: 981px)').matches
/** 阅读宽屏默认左右对照；听力默认只看题目，原文按需打开 */
const defaultPane = (unit: Unit): Pane =>
  unit.module === 'reading' && hasSource(unit) && isWide() ? 'both' : 'questions'

type Modal = 'submit' | 'exit' | 'warn' | 'report' | 'help' | 'settings' | null

type PracticeProps = {
  id?: number
  /** 整卷模考：一套卷里同一科的几个单元串成一场（一次计时、一次交卷） */
  paper?: { paperId: number; module: 'listening' | 'reading' }
  groupIndex?: number | null
  focusNumber?: number | null
  onBack: () => void
}

/** 官方整卷时长：听力 30 分钟、阅读 60 分钟 */
const PAPER_LIMITS: Record<string, number> = { listening: 30 * 60, reading: 60 * 60 }

/** 题库按需读取：读完再挂载答题界面，界面里的状态初始化才有题可依 */
export const Practice: React.FC<PracticeProps> = ({
  id,
  paper,
  groupIndex = null,
  focusNumber = null,
  onBack,
}) => {
  const [units, setUnits] = useState<Unit[] | null>(null)
  const [error, setError] = useState('')
  const paperId = paper?.paperId ?? null
  const paperModule = paper?.module ?? null

  useEffect(() => {
    let alive = true
    setUnits(null)
    setError('')
    const ids = paperId != null && paperModule
      ? getPaperUnits(paperId, paperModule).map((u) => u.id)
      : id != null
        ? [id]
        : []
    if (!ids.length) {
      setError('这套卷没有可用于整卷模考的单元。')
      return
    }
    Promise.all(ids.map((n) => loadUnit(n))).then(
      (loaded) => {
        if (alive) setUnits(loaded)
      },
      (err) => {
        if (alive) setError(String((err as Error)?.message || err))
      },
    )
    return () => {
      alive = false
    }
  }, [id, paperId, paperModule])

  if (error) {
    return (
      <div className="page">
        <button className="link-btn" onClick={onBack}>← Back</button>
        <div className="empty">
          {paperId != null ? 'This paper could not be loaded. ' : `Unit ${id} could not be loaded. `}
          {error}
        </div>
      </div>
    )
  }
  if (!units) {
    return (
      <div className="page">
        <button className="link-btn" onClick={onBack}>← Back</button>
        <h1 className="page-title">
          {paperId != null ? `Mock paper ${paperId}` : unitSummary(id as number)?.title || `Unit ${id}`}
        </h1>
        <div className="empty">Loading…</div>
      </div>
    )
  }
  return (
    <PracticeView
      key={paperId != null ? `p${paperId}:${paperModule}` : `${id}:${groupIndex ?? 'all'}`}
      units={units}
      id={id}
      paper={paper}
      groupIndex={groupIndex}
      focusNumber={focusNumber}
      onBack={onBack}
    />
  )
}

const Overlay: React.FC<{ onClose: () => void; children: React.ReactNode }> = ({ onClose, children }) => (
  <div className="ex-overlay" role="presentation" onClick={onClose}>
    <div className="ex-dialog-wrap" onClick={(e) => e.stopPropagation()} role="dialog" aria-modal="true">
      {children}
    </div>
  </div>
)

const PracticeView: React.FC<PracticeProps & { units: Unit[] }> = ({
  units,
  paper,
  id,
  groupIndex = null,
  focusNumber = null,
  onBack,
}) => {
  const isPaper = units.length > 1
  const key = paper ? `paper:${paper.paperId}:${paper.module}` : practiceKey(id as number, groupIndex)
  const prefs0 = useMemo(() => readExamPrefs(), [])
  const draft0 = useMemo(() => getPracticeDraft(key), [key])

  /** 每个 Part 一片：单元 + 本次要显示的题组 + 题号 + 区间 */
  const parts = useMemo(
    () =>
      units.map((u) => {
        const gs =
          groupIndex == null || isPaper
            ? u.groups || []
            : [u.groups?.[groupIndex]].filter((g): g is Unit['groups'][number] => Boolean(g))
        const qs = gs.flatMap((g) => g.questions || [])
        const nums = qs.map((q) => q.number).sort((a, b) => a - b)
        const last = qs.reduce((a, b) => (!a || b.number > a.number ? b : a), undefined as (typeof qs)[number] | undefined)
        // 一道题可能占多个题号（span，比如 "27-28"），底栏按题号逐个显示，
        // 但答案只挂在这个题块的第一个题号上，所以每个题号要记住它归谁。
        const owner = new Map<number, number>()
        qs.forEach((q) => {
          const span = Math.max(q.span || 1, 1)
          for (let k = 0; k < span; k += 1) owner.set(q.number + k, q.number)
        })
        const to = last ? last.number + Math.max(last.span || 1, 1) - 1 : null
        const slots: { n: number; owner: number }[] = []
        if (nums.length && to != null) {
          for (let n = nums[0]; n <= to; n += 1) slots.push({ n, owner: owner.get(n) ?? n })
        }
        return {
          unit: u,
          groups: gs,
          numbers: nums,
          slots,
          from: nums.length ? nums[0] : null,
          to,
        }
      }),
    [units, groupIndex, isPaper],
  )

  const groups = useMemo(() => parts.flatMap((p) => p.groups), [parts])
  const numbers = useMemo(() => parts.flatMap((p) => p.numbers).sort((a, b) => a - b), [parts])
  const partOf = useMemo(() => {
    const map = new Map<number, number>()
    parts.forEach((p, i) => {
      p.slots.forEach((slot) => {
        map.set(slot.n, i)
        map.set(slot.owner, i)
      })
    })
    return map
  }, [parts])

  const [partIndex, setPartIndex] = useState(0)
  const cur = parts[Math.min(partIndex, Math.max(parts.length - 1, 0))] || parts[0]
  const unit = cur.unit
  // 底栏按题号槽位计数（多答案题占两个号），和官方 "x of 40" 一致
  const slots = useMemo(() => parts.flatMap((p) => p.slots), [parts])
  const entries = slots.length
  const totalMarks = useMemo(
    () => groups.reduce((sum, g) => sum + (g.questions || []).reduce((s, q) => s + Math.max(q.span || 1, 1), 0), 0),
    [groups],
  )
  const scopeRange = { from: cur.from, to: cur.to }
  const scopeLabel = useMemo(() => {
    const bits = [`Part ${unit.part ?? '—'}`, rangeText(scopeRange.from, scopeRange.to), typeLabelEn(cur.groups[0]?.type)]
    return bits.filter(Boolean).join(' · ')
  }, [unit, scopeRange.from, scopeRange.to, cur.groups])
  const source = hasSource(unit)
  const canTranslate = hasTranslation(unit)
  const previous = useMemo(() => getAttemptByKey(key), [key])

  const draftAnswers = draft0?.answers || {}
  const draftAnswered = Object.keys(draftAnswers).length > 0

  const [answers, setAnswers] = useState<Answers>(draftAnswers)
  const [submitted, setSubmitted] = useState(false)
  const [result, setResult] = useState<GradeResult | null>(null)
  const [seconds, setSeconds] = useState(draft0?.seconds || 0)
  const [started, setStarted] = useState(
    () => draftAnswered || prefs0.skipIntro || focusNumber != null,
  )
  const [pane, setPane] = useState<Pane>(() => defaultPane(parts[0].unit))
  const [split, setSplit] = useState(52)
  const [active, setActive] = useState<number | null>(() => {
    const firstOpen = numbers.find((n) => !countOf(draftAnswers[n]))
    return firstOpen ?? numbers[0] ?? null
  })
  const [marked, setMarked] = useState<Set<number>>(() => new Set(draft0?.marked || []))
  const [evidence, setEvidence] = useState<Set<number>>(new Set())
  const [showTranslation, setShowTranslation] = useState(false)
  const [modal, setModal] = useState<Modal>(null)
  const [timerMode, setTimerMode] = useState<TimerMode>(() => {
    const base = paper ? PAPER_LIMITS[unit.module] : prefs0.limits[unit.module] || DEFAULT_LIMITS[unit.module]
    return prefs0.timerMode === 'down' && (draft0?.seconds || 0) >= base - 30 ? 'up' : prefs0.timerMode
  })
  const [limit, setLimit] = useState(() =>
    paper
      ? PAPER_LIMITS[unit.module] || DEFAULT_LIMITS[unit.module]
      : prefs0.limits[unit.module] || DEFAULT_LIMITS[unit.module],
  )
  const [hideTimer, setHideTimer] = useState(prefs0.hideTimer)
  const [skipIntro, setSkipIntro] = useState(prefs0.skipIntro)
  const [marks, setMarks] = useState<HighlightRange[]>(() => readHighlights(parts[0].unit.id))
  const [notes, setNotes] = useState<NoteRange[]>(() => readNotes(parts[0].unit.id))
  const [showSeconds, setShowSeconds] = useState(prefs0.showSeconds)
  const [screenHidden, setScreenHidden] = useState(false)
  const [menuOpen, setMenuOpen] = useState(false)
  const [notesOpen, setNotesOpen] = useState(false)
  const [volOpen, setVolOpen] = useState(false)
  const [practiceMode, setPracticeMode] = useState(prefs0.practiceMode)
  const [audioPlaying, setAudioPlaying] = useState(false)
  const [restored, setRestored] = useState<PracticeDraft | null>(draftAnswered ? draft0 || null : null)
  const [toast, setToast] = useState('')
  const [timeUp, setTimeUp] = useState(false)
  const [runId, setRunId] = useState(0)
  const [activeLine, setActiveLine] = useState<number | null>(null)

  const qScrollRef = useRef<HTMLDivElement>(null)
  const sourceScrollRef = useRef<HTMLDivElement>(null)
  const audioRef = useRef<HTMLAudioElement>(null)
  const jumpLock = useRef(0)
  const autoRef = useRef(false)
  const warnRef = useRef(false)
  const toastTimer = useRef(0)
  const tickBase = useRef({ at: Date.now(), sec: seconds })
  const rafRef = useRef(0)
  const dragRef = useRef(false)

  const answersRef = useRef(answers)
  const secondsRef = useRef(seconds)
  const submittedRef = useRef(submitted)
  const markedRef = useRef(marked)
  const activeRef = useRef(active)
  const submitRef = useRef<(auto?: boolean) => void>(() => {})
  answersRef.current = answers
  secondsRef.current = seconds
  submittedRef.current = submitted
  markedRef.current = marked
  activeRef.current = active

  const scoped = useMemo(() => ({ ...unit, groups }), [unit, groups])
  const items = useMemo(() => {
    const map = new Map<number, GradeItem>()
    result?.items.forEach((item) => map.set(item.number, item))
    return map
  }, [result])
  const answeredEntries = slots.filter((s) => countOf(answers[s.owner])).length
  const remaining = entries - answeredEntries
  const wrongNumbers = result?.items.filter((i) => i.correct < i.max).map((i) => i.number) || []
  const pane3 = source ? pane : 'questions'
  const remainingSeconds = Math.max(0, limit - seconds)
  const showWarn = !submitted && timerMode === 'down' && remainingSeconds <= 300
  const brand = unit.exam === 'ielts' ? 'IELTS' : unit.exam === 'cet4' ? 'CET-4' : unit.exam === 'cet6' ? 'CET-6' : EXAM_LABEL[unit.exam] || 'EXAM'
  const sectionName = unit.module === 'reading' ? 'Reading' : 'Listening'
  const partName = unit.module === 'reading' ? `Reading Passage ${unit.part ?? ''}` : `Part ${unit.part ?? ''}`
  const rangeLabel = scopeRange.from == null ? '' : `Questions ${scopeRange.from}–${scopeRange.to}`
  const typeSummary = groups.map((g) => typeLabelEn(g.type)).filter(Boolean).join(' / ')

  const showToast = useCallback((message: string) => {
    setToast(message)
    window.clearTimeout(toastTimer.current)
    toastTimer.current = window.setTimeout(() => setToast(''), 3200)
  }, [])
  useEffect(() => () => window.clearTimeout(toastTimer.current), [])

  const saveNow = useCallback(() => {
    if (submittedRef.current) return
    const current = answersRef.current
    if (!Object.keys(current).length) return
    savePracticeDraft({
      key,
      unitId: parts[0].unit.id,
      groupIndex: groupIndex ?? undefined,
      title: unit.title,
      scope: scopeLabel,
      answers: current,
      seconds: secondsRef.current,
      at: Date.now(),
      total: totalMarks,
      marked: [...markedRef.current],
    })
  }, [key, id, groupIndex, unit.title, scopeLabel, totalMarks])

  // 答题草稿自动保存：改答案 400ms 后写一次，另外每 15 秒补一次计时
  useEffect(() => {
    const debounce = window.setTimeout(saveNow, 400)
    const timer = window.setInterval(saveNow, 15000)
    return () => {
      window.clearTimeout(debounce)
      window.clearInterval(timer)
    }
  }, [answers, marked, saveNow])

  // 卸载（返回题库 / 关窗口）前补存一次，避免刚敲完的字丢掉
  useEffect(() => () => saveNow(), [saveNow])
  useEffect(() => {
    const onUnload = () => saveNow()
    window.addEventListener('beforeunload', onUnload)
    return () => window.removeEventListener('beforeunload', onUnload)
  }, [saveNow])

  // 计时：以 Date.now 为基准，窗口被挂起再回来也不会漏算
  useEffect(() => {
    if (!started || submitted) return
    tickBase.current = { at: Date.now(), sec: secondsRef.current }
    const timer = window.setInterval(() => {
      const next = tickBase.current.sec + Math.floor((Date.now() - tickBase.current.at) / 1000)
      setSeconds(next)
    }, 500)
    return () => window.clearInterval(timer)
  }, [started, submitted, runId])

  const doSubmit = useCallback(
    (auto = false) => {
      if (submittedRef.current) return
      const graded = grade(scoped, answersRef.current)
      const types: TypeStat = {}
      groups.forEach((g) => {
        const type = g.type || 'completion'
        ;(g.questions || []).forEach((q) => {
          const item = graded.items.find((i) => i.number === q.number)
          const cur = types[type] || { c: 0, t: 0 }
          cur.t += item?.max ?? 1
          cur.c += item?.correct ?? 0
          types[type] = cur
        })
      })
      // 整卷模考记一条成绩；逐篇练习仍按单元记
      const record = parts[0].unit
      const recordTitle = isPaper
        ? `${record.paper || 'Mock paper'} · ${record.module === 'reading' ? 'Reading' : 'Listening'}`
        : unit.title
      const recordScope = isPaper
        ? `${record.module === 'reading' ? 'Reading' : 'Listening'} · ${parts.length} parts · ${
            numbers[0] ?? ''
          }-${numbers[numbers.length - 1] ?? ''}`
        : scopeLabel
      saveAttempt({
        key,
        unitId: unit.id,
        groupIndex: isPaper ? undefined : groupIndex ?? undefined,
        title: recordTitle,
        scope: recordScope,
        score: graded.score,
        total: graded.total,
        at: Date.now(),
        seconds: secondsRef.current,
        answers: answersRef.current,
        wrong: graded.items.filter((i) => i.correct < i.max).map((i) => i.number),
        types,
      })
      clearPracticeDraft(key)
      submittedRef.current = true
      autoRef.current = true
      setResult(graded)
      setSubmitted(true)
      setRestored(null)
      setTimeUp(auto)
      setModal('report')
      audioRef.current?.pause()
      setPane((prev) => (prev === 'source' ? 'questions' : prev))
      qScrollRef.current?.scrollTo({ top: 0 })
    },
    [scoped, groups, key, unit.id, unit.title, parts, isPaper, numbers, groupIndex, scopeLabel],
  )
  submitRef.current = doSubmit

  // 时间到自动交卷（官方：计时归零本节自动结束，不再弹 5 分钟提醒框，
  // 只剩顶部计时变色 + 10 分钟时闪 10 秒）
  useEffect(() => {
    if (!started || submitted || timerMode !== 'down') return
    if (remainingSeconds <= 0 && !autoRef.current) {
      autoRef.current = true
      submitRef.current(true)
    }
  }, [remainingSeconds, started, submitted, timerMode])

  // 顶栏 "Audio is playing" 跟随音频元素状态
  useEffect(() => {
    const audio = audioRef.current
    if (!audio) return
    const sync = () => setAudioPlaying(!audio.paused)
    sync()
    audio.addEventListener('play', sync)
    audio.addEventListener('pause', sync)
    audio.addEventListener('ended', sync)
    return () => {
      audio.removeEventListener('play', sync)
      audio.removeEventListener('pause', sync)
      audio.removeEventListener('ended', sync)
    }
  }, [started, unit.id])

  // 整卷听力：这一段录音放完，自动进入下一 Part 并接着播（真实机考一段接一段，中间不暂停）
  useEffect(() => {
    const audio = audioRef.current
    if (!audio || !isPaper || unit.module !== 'listening') return
    const onEnded = () => {
      if (submittedRef.current) return
      const next = parts[partIndex + 1]
      if (!next || !next.numbers.length) return
      jumpTo(next.numbers[0], false)
      window.setTimeout(() => {
        void audioRef.current?.play().catch(() => undefined)
      }, 260)
    }
    audio.addEventListener('ended', onEnded)
    return () => audio.removeEventListener('ended', onEnded)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isPaper, unit.module, unit.id, partIndex, parts])

  // 打开答题页后把光标放到当前题
  useEffect(() => {
    if (!started) return
    const timer = window.setTimeout(() => {
      const n = activeRef.current ?? numbers[0]
      if (n == null) return
      if (n !== numbers[0]) jumpTo(n, false)
      else {
        qScrollRef.current?.scrollTo({ top: 0 })
        focusQuestion(n)
      }
    }, 90)
    return () => window.clearTimeout(timer)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [started])

  // 从记录页点错题进来时，直接滚到那道题
  useEffect(() => {
    if (focusNumber == null) return
    const timer = window.setTimeout(() => jumpTo(focusNumber, false), 240)
    return () => window.clearTimeout(timer)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [focusNumber])

  // 题号多到需要横向滚动时，让当前题号始终留在视野里
  useEffect(() => {
    if (active == null) return
    const el = document.querySelector<HTMLElement>(`.ex-nums [data-n="${active}"]`)
    el?.scrollIntoView({ block: 'nearest', inline: 'center' })
  }, [active])

  // 听力播放时高亮当前句
  useEffect(() => {
    const audio = audioRef.current
    if (!audio || unit.module !== 'listening') return
    const timed = (unit.transcript || [])
      .filter((l) => typeof l.start === 'number')
      .sort((a, b) => (a.start as number) - (b.start as number))
    const onTime = () => {
      let current: number | null = null
      for (const line of timed) {
        if ((line.start as number) <= audio.currentTime + 0.2) current = line.n
      }
      setActiveLine((prev) => (prev === current ? prev : current))
    }
    audio.addEventListener('timeupdate', onTime)
    return () => audio.removeEventListener('timeupdate', onTime)
  }, [unit, started])

  const setAnswer = (n: number, v: string | string[]) => {
    if (submittedRef.current) return
    setAnswers((prev) => ({ ...prev, [n]: v }))
  }

  const currentNumber = (): number | null => {
    const el = document.activeElement as HTMLElement | null
    const holder = el && typeof el.closest === 'function' ? el.closest<HTMLElement>('[data-q]') : null
    const scroller = qScrollRef.current
    const bounds = scroller?.getBoundingClientRect()
    if (holder) {
      const rect = holder.getBoundingClientRect()
      const top = bounds?.top ?? 0
      const bottom = bounds?.bottom ?? window.innerHeight
      if (rect.bottom > top + 4 && rect.top < bottom - 4) return Number(holder.dataset.q)
    }
    if (Date.now() < jumpLock.current && active != null) return active
    if (!scroller) return active
    const nodes = [...scroller.querySelectorAll<HTMLElement>('[data-q]')]
    const mid = (bounds?.top ?? 0) + (bounds?.height ?? window.innerHeight) * 0.4
    let current: number | null = null
    for (const node of nodes) {
      if (!node.offsetParent) continue
      if (node.getBoundingClientRect().top <= mid) current = Number(node.dataset.q)
    }
    return current ?? active
  }

  const jumpTo = (n: number, smooth = true) => {
    setActive(n)
    setPane((prev) => (prev === 'source' ? 'questions' : prev))
    closeMenus()
    jumpLock.current = Date.now() + 900
    const target = partOf.get(n)
    const scroll = () => {
      const node = qScrollRef.current?.querySelector<HTMLElement>(`[data-q="${n}"]`)
      node?.scrollIntoView({ behavior: smooth ? 'smooth' : 'auto', block: 'center' })
      focusQuestion(n)
    }
    // 目标题在别的 Part：先切过去，等这一片渲染出来再滚
    if (target != null && target !== partIndex) {
      setPartIndex(target)
      window.setTimeout(scroll, 70)
      return
    }
    window.requestAnimationFrame(scroll)
  }

  /** Tab / Shift+Tab：按答题顺序在填空框、下拉框、选择题之间移动（真实机考的标准操作） */
  const focusStep = (dir: 1 | -1, from?: HTMLElement | null) => {
    const nodes = [...document.querySelectorAll<HTMLElement>('.ex-questions [data-q]')].filter((n) => n.offsetParent)
    if (!nodes.length) return
    let index = from ? nodes.indexOf(from) : -1
    if (index < 0) {
      const current = currentNumber()
      index = nodes.findIndex((n) => Number(n.dataset.q) === current)
    }
    const next = nodes[Math.min(nodes.length - 1, Math.max(0, index + dir))]
    if (!next) return
    const number = Number(next.dataset.q)
    setActive(number)
    jumpLock.current = Date.now() + 500
    next.scrollIntoView({ behavior: 'smooth', block: 'center' })
    focusQuestion(number)
  }

  const step = (dir: -1 | 1, from?: number | null) => {
    if (!numbers.length) return
    const base = from ?? currentNumber()
    const index = base == null ? -1 : numbers.indexOf(base)
    const next = index < 0 ? (dir === 1 ? 0 : numbers.length - 1) : Math.min(numbers.length - 1, Math.max(0, index + dir))
    jumpTo(numbers[next])
  }

  const firstUnanswered = () => {
    const base = currentNumber()
    const start = base == null ? -1 : numbers.indexOf(base)
    const ordered = [...numbers.slice(start + 1), ...numbers.slice(0, start + 1)]
    return ordered.find((n) => !countOf(answers[n])) ?? null
  }

  const optionsOf = (n: number | null) => {
    if (n == null) return []
    const group = groups.find((g) => (g.questions || []).some((q) => q.number === n))
    const question = group?.questions.find((q) => q.number === n)
    if (!group || !question) return []
    return question.options?.length ? question.options : optionsFor(group, unit)
  }

  const chooseOption = (index: number, n?: number | null) => {
    const target = n ?? currentNumber()
    if (submitted || target == null) return
    const option = optionsOf(target)[index]
    if (!option) return
    const group = groups.find((g) => (g.questions || []).some((q) => q.number === target))
    if (group?.type === 'multi_choice') {
      const current = answers[target]
      const picked = Array.isArray(current) ? current : current ? [current] : []
      setAnswer(target, picked.includes(option.key) ? picked.filter((k) => k !== option.key) : [...picked, option.key])
    } else {
      setAnswer(target, option.key)
    }
  }

  const toggleMark = (n?: number | null) => {
    const target = n ?? currentNumber()
    if (target == null || submitted) return
    setMarked((prev) => {
      const next = new Set(prev)
      if (next.has(target)) next.delete(target)
      else next.add(target)
      return next
    })
  }

  const onQScroll = () => {
    if (rafRef.current) return
    rafRef.current = window.requestAnimationFrame(() => {
      rafRef.current = 0
      if (Date.now() < jumpLock.current) return
      const scroller = qScrollRef.current
      if (!scroller) return
      const bounds = scroller.getBoundingClientRect()
      const mid = bounds.top + bounds.height * 0.4
      let current: number | null = null
      scroller.querySelectorAll<HTMLElement>('[data-q]').forEach((node) => {
        if (!node.offsetParent) return
        if (node.getBoundingClientRect().top <= mid) current = Number(node.dataset.q)
      })
      if (current != null) setActive((prev) => (prev === current ? prev : current))
    })
  }

  // 快捷键：只保留官方实考真正支持的键位，其余一律交还给浏览器原生行为。
  //   Tab / Shift+Tab —— 在答题控件之间移动（末尾圈回第一个，焦点不出答题区）
  //   方向键 —— 原生 radio / select 内部切换（不再用来换题）
  //   Ctrl+C / Ctrl+V / Ctrl+Z —— 原生复制、粘贴、撤销
  //   Esc —— 关闭菜单 / 弹窗 / Notes 面板
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        if (menuOpen) {
          e.preventDefault()
          setMenuOpen(false)
          return
        }
        if (volOpen) {
          e.preventDefault()
          setVolOpen(false)
          return
        }
        if (modal) {
          e.preventDefault()
          setModal(null)
          return
        }
        if (notesOpen) {
          e.preventDefault()
          setNotesOpen(false)
          return
        }
        closeMenus()
        const el = document.activeElement as HTMLElement | null
        if (el && typeof el.closest === 'function' && el.closest('.ex-questions')) el.blur()
        return
      }
      // Hide 期间不接管任何按键，避免在看不见卷面时误改答案
      if (screenHidden) return
      if (!started || modal || menuOpen) return
      if (e.key !== 'Tab' || e.ctrlKey || e.metaKey || e.altKey) return
      const nodes = [
        ...document.querySelectorAll<HTMLElement>(
          '.ex-questions input:not([type="hidden"]), .ex-questions select, .ex-questions textarea',
        ),
      ].filter((n) => n.offsetParent && !(n as HTMLInputElement).disabled)
      if (!nodes.length) return
      const el = document.activeElement as HTMLElement | null
      if (e.shiftKey && el === nodes[0]) {
        e.preventDefault()
        nodes[nodes.length - 1].focus()
      } else if (!e.shiftKey && el === nodes[nodes.length - 1]) {
        e.preventDefault()
        nodes[0].focus()
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  })

  const startExam = () => {
    setStarted(true)
    autoRef.current = false
    warnRef.current = false
    setRunId((v) => v + 1)
    // 官方：Listening 一开始就自动播放录音，播放器本身对考生不可见
    if (unit.module === 'listening') {
      window.setTimeout(() => {
        void audioRef.current?.play().catch(() => undefined)
      }, 120)
    }
  }

  const restart = () => {
    clearPracticeDraft(key)
    autoRef.current = false
    warnRef.current = false
    submittedRef.current = false
    setSubmitted(false)
    setResult(null)
    setAnswers({})
    setSeconds(0)
    setMarked(new Set())
    setEvidence(new Set())
    setRestored(null)
    setModal(null)
    setTimeUp(false)
    setPartIndex(0)
    setActive(numbers[0] ?? null)
    setPane(defaultPane(parts[0].unit))
    setScreenHidden(false)
    setRunId((v) => v + 1)
    if (unit.module === 'listening') {
      window.setTimeout(() => {
        void audioRef.current?.play().catch(() => undefined)
      }, 120)
    }
    qScrollRef.current?.scrollTo({ top: 0 })
    sourceScrollRef.current?.scrollTo({ top: 0 })
    window.setTimeout(() => {
      if (numbers[0] != null) focusQuestion(numbers[0])
    }, 60)
  }

  const changeTimerMode = (mode: TimerMode) => {
    setTimerMode(mode)
    saveExamPrefs({ timerMode: mode })
    if (mode === 'down' && secondsRef.current >= limit) {
      setSeconds(0)
      setRunId((v) => v + 1)
      showToast('The clock has been reset for this section.')
    }
  }

  const changeLimit = (value: number) => {
    setLimit(value)
    saveExamPrefs({ limits: { [unit.module]: value } })
    if (timerMode === 'down' && secondsRef.current >= value) {
      setSeconds(0)
      setRunId((v) => v + 1)
      showToast('The clock has been reset.')
    }
  }

  const changeSkipIntro = (value: boolean) => {
    setSkipIntro(value)
    saveExamPrefs({ skipIntro: value })
  }

  const changeHideTimer = (value: boolean) => {
    setHideTimer(value)
    saveExamPrefs({ hideTimer: value })
  }


  const changeSeconds = (value: boolean) => {
    setShowSeconds(value)
    saveExamPrefs({ showSeconds: value })
  }

  const toggleTranslation = () => {
    if (!canTranslate) {
      setShowTranslation(false)
      showToast('This text has no translation attached.')
      return
    }
    const next = !showTranslation
    setShowTranslation(next)
    if (next && source && pane3 === 'questions') setPane(isWide() ? 'both' : 'source')
  }

  const locate = (ev?: string | null) => {
    const nums = evidenceNumbers(ev)
    setEvidence(nums)
    if (source && pane3 === 'questions') setPane(isWide() ? 'both' : 'source')
    window.setTimeout(() => {
      const hit = sourceScrollRef.current?.querySelector<HTMLElement>('.sentence-hit')
      hit?.scrollIntoView({ behavior: 'smooth', block: 'center' })
    }, 90)
  }

  const seek = (n: number) => {
    const line = (unit?.transcript || []).find((l) => l.n === n)
    const audio = audioRef.current
    if (!audio || typeof line?.start !== 'number') return
    audio.currentTime = line.start
    void audio.play()
  }

  const askExit = () => {
    if (submitted || answeredEntries === 0) {
      onBack()
      return
    }
    setModal('exit')
  }

  const clearMarks = () => {
    setMarks([])
    setNotes([])
    clearHighlights(unit.id)
    clearNotes(unit.id)
    showToast('Highlights and notes cleared for this part.')
  }

  const updateMarks = (next: HighlightRange[]) => {
    const merged = mergeHighlights(next)
    setMarks(merged)
    saveHighlights(unit.id, merged)
  }

  const updateNotes = (next: NoteRange[]) => {
    setNotes(next)
    saveNotes(unit.id, next)
  }

  // 切到另一片（整卷模考）时，把这一片自己的高亮/笔记读回来
  useEffect(() => {
    setMarks(readHighlights(unit.id))
    setNotes(readNotes(unit.id))
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [unit.id])

  const onSplitDown = (e: React.PointerEvent<HTMLDivElement>) => {
    dragRef.current = true
    e.currentTarget.setPointerCapture(e.pointerId)
    document.body.classList.add('ex-resizing')
  }
  const onSplitMove = (e: React.PointerEvent<HTMLDivElement>) => {
    if (!dragRef.current) return
    const body = e.currentTarget.parentElement
    if (!body) return
    const rect = body.getBoundingClientRect()
    const pct = ((e.clientX - rect.left) / rect.width) * 100
    setSplit(Math.min(72, Math.max(30, pct)))
  }
  const onSplitUp = (e: React.PointerEvent<HTMLDivElement>) => {
    dragRef.current = false
    if (e.currentTarget.hasPointerCapture(e.pointerId)) e.currentTarget.releasePointerCapture(e.pointerId)
    document.body.classList.remove('ex-resizing')
  }

  if (!groups.length) {
    return (
      <div className="page">
        <button className="link-btn" onClick={onBack}>← Back</button>
        <div className="empty">This group (ID {id}) could not be found.</div>
      </div>
    )
  }

  const pct = result && result.total ? Math.round((result.score / result.total) * 100) : 0
  const remain = Math.max(0, limit - seconds)
  const downMode = timerMode === 'down'
  const minutesLeft = Math.ceil(remain / 60)
  const mm = Math.floor(remain / 60)
  const ss = remain % 60
  // 官方：粗显示「X minutes remaining」，悬停换成「MM : SS remaining」；
  // 最后一分钟只显示 0:SS；剩 5 分钟变红；10 分钟整点闪 10 秒。
  const coarseText = submitted
    ? 'Test finished'
    : downMode
      ? remain <= 60
        ? `0:${remain}`
        : `${minutesLeft} minute${minutesLeft === 1 ? '' : 's'} remaining`
      : `${Math.floor(seconds / 60)} minutes elapsed`
  const preciseText = submitted ? formatTime(seconds) : `${mm} : ${String(ss).padStart(2, '0')} remaining`
  const warn = !submitted && downMode && remain <= 300
  const flash = !submitted && downMode && remain <= 600 && remain >= 590
  const activeIndex = active == null ? -1 : numbers.indexOf(active)
  const activeMarked = active != null && marked.has(active)
  const partNo = unit.part ?? 1
  const partLabel = unit.module === 'reading' ? 'Reading' : 'Listening'
  const rubricText =
    unit.module === 'reading'
      ? `Read the text below and answer questions ${scopeRange.from} - ${scopeRange.to}.`
      : `Listen and answer questions ${scopeRange.from} - ${scopeRange.to}.`
  const noteItems: NoteRange[] = []
  const noteSeen = new Set<string>()
  notes.forEach((n) => {
    if (noteSeen.has(n.id)) return
    noteSeen.add(n.id)
    noteItems.push(n)
  })

  return (
    <div className="exam-shell" onContextMenu={(e) => e.preventDefault()}>
      <header className="top-bar">
        <div className="info">
          <a
            className="student-id"
            href="https://github.com/H1DDENADM1N/IELTS-Simulator"
            target="_blank"
            rel="noopener noreferrer"
            title="Open the IELTS Simulator project on GitHub"
          >
            IELTS Simulator
          </a>
          <span
            className={
              'timer' +
              (warn ? ' warning' : '') +
              (flash ? ' flash' : '') +
              (showSeconds ? ' show-seconds' : '') +
              (hideTimer ? ' is-hidden' : '')
            }
            title={hideTimer ? 'The clock is hidden (Settings)' : undefined}
          >
            <p className="not-precise">{coarseText}</p>
            <p className="precise">{preciseText}</p>
          </span>
        </div>

        {unit.module === 'listening' && started && !submitted && (
          <div className="audio-notice">
            <button
              type="button"
              className="ico-btn"
              style={{ padding: 0 }}
              onClick={() => {
                setVolOpen((v) => !v)
                setMenuOpen(false)
              }}
              title="Volume"
              aria-label="Volume"
            >
              <svg viewBox="0 0 24 24" className="ico" aria-hidden="true">
                <path d="M4 9.4h3.5L12 5.4v13.2L7.5 14.6H4z" fill="currentColor" />
                <path
                  d="M15.6 8.4a5.2 5.2 0 0 1 0 7.2M18.2 5.9a8.8 8.8 0 0 1 0 12.2"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="1.6"
                  strokeLinecap="round"
                />
              </svg>
            </button>
            <p>{audioPlaying ? 'Audio is playing' : 'Audio paused'}</p>
          </div>
        )}

        <div className="interface">
          <button
            type="button"
            className="btn end-button"
            onClick={() => (submitted ? restart() : setModal('submit'))}
          >
            {submitted ? 'Retake test' : 'Finish test'}
          </button>

          <button type="button" className="ico-btn" title="Network Connection" tabIndex={-1} aria-hidden="true">
            <svg viewBox="0 0 24 24" aria-hidden="true">
              <path d="M2.5 8.6a14 14 0 0 1 19 0" fill="none" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" />
              <path d="M5.8 12.2a9.2 9.2 0 0 1 12.4 0" fill="none" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" />
              <path d="M9 15.8a4.5 4.5 0 0 1 6 0" fill="none" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" />
              <circle cx="12" cy="19.2" r="1.5" fill="currentColor" />
            </svg>
          </button>
          <button type="button" className="ico-btn" title="Notifications" tabIndex={-1} aria-hidden="true">
            <svg viewBox="0 0 24 24" aria-hidden="true">
              <path
                d="M6.2 9.4a5.8 5.8 0 0 1 11.6 0v4.2l1.7 3.1H4.5l1.7-3.1z"
                fill="none"
                stroke="currentColor"
                strokeWidth="1.8"
                strokeLinejoin="round"
              />
              <path d="M10 19.4a2.2 2.2 0 0 0 4 0" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" />
            </svg>
          </button>
          <button
            type="button"
            className={'ico-btn' + (menuOpen ? ' on' : '')}
            title="Options"
            aria-label="Options"
            aria-expanded={menuOpen}
            onClick={() => {
              setMenuOpen((v) => !v)
              setVolOpen(false)
            }}
          >
            <svg viewBox="0 0 24 24" aria-hidden="true">
              <path d="M3.5 6.5h17M3.5 12h17M3.5 17.5h17" fill="none" stroke="currentColor" strokeWidth="2.1" strokeLinecap="round" />
            </svg>
          </button>
          <button
            type="button"
            className={'ico-btn' + (notesOpen ? ' on' : '')}
            title="Notes"
            aria-label="Notes"
            aria-expanded={notesOpen}
            onClick={() => setNotesOpen((v) => !v)}
          >
            <svg viewBox="0 0 24 24" aria-hidden="true">
              <path d="M4.5 4.5h11l4 4v11h-15z" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinejoin="round" />
              <path d="M8 9.5h6M8 13h8M8 16.5h5" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" />
            </svg>
          </button>

          {volOpen && (
            <div className="volume-pop">
              <span>Volume</span>
              <input
                type="range"
                min={0}
                max={100}
                defaultValue={Math.round((audioRef.current?.volume ?? 1) * 100)}
                aria-label="Volume"
                onChange={(e) => {
                  const audio = audioRef.current
                  if (audio) audio.volume = Math.max(0, Math.min(1, Number(e.target.value) / 100))
                }}
              />
              <button
                type="button"
                className="ex-link"
                onClick={() => {
                  const audio = audioRef.current
                  if (!audio) return
                  if (audio.paused) void audio.play().catch(() => undefined)
                  else audio.pause()
                }}
              >
                {audioPlaying ? 'Pause' : 'Play'}
              </button>
            </div>
          )}

          {menuOpen && (
            <div className="options-menu" role="menu">
              <button type="button" role="menuitem" onClick={() => { setMenuOpen(false); setModal('settings') }}>
                Settings
              </button>
              <button type="button" role="menuitem" onClick={() => { setMenuOpen(false); setScreenHidden(true) }}>
                Hide screen
              </button>
              <button type="button" role="menuitem" onClick={() => { setMenuOpen(false); setModal('help') }}>
                Help
              </button>
              <div className="sep" />
              <button
                type="button"
                role="menuitemcheckbox"
                aria-checked={practiceMode}
                onClick={() => {
                  const next = !practiceMode
                  setPracticeMode(next)
                  saveExamPrefs({ practiceMode: next })
                  if (!next) setShowTranslation(false)
                  showToast(next ? 'Practice mode on: translation, split view and audio controls are available.' : 'Practice mode off: exam conditions.')
                }}
              >
                Practice mode
                <span className="check">{practiceMode ? 'On' : 'Off'}</span>
              </button>
              <button type="button" role="menuitem" onClick={() => { setMenuOpen(false); clearMarks() }} disabled={!marks.length && !notes.length}>
                Clear highlights and notes
              </button>
              <div className="sep" />
              <button type="button" role="menuitem" onClick={() => { setMenuOpen(false); askExit() }}>
                Exit practice
              </button>
            </div>
          )}
        </div>
      </header>

      <div className="rubric">
        <h3>Part {partNo}</h3>
        <p>{rubricText}</p>
      </div>

      {practiceMode && started && (
        <div className="ex-tools">
          <div className="ex-tabs" role="tablist" aria-label="Questions and passage">
            <button type="button" className={pane3 === 'questions' ? 'on' : ''} onClick={() => setPane('questions')}>
              Questions
            </button>
            <button
              type="button"
              className={pane3 === 'both' ? 'on' : ''}
              onClick={() => setPane('both')}
              disabled={!source}
            >
              Split
            </button>
            <button
              type="button"
              className={pane3 === 'source' ? 'on' : ''}
              onClick={() => setPane('source')}
              disabled={!source}
            >
              Passage
            </button>
          </div>
          <span className="ex-scope">
            {rangeLabel} · {typeSummary}
          </span>
          <span className="ex-tools-spacer" />
          <button
            type="button"
            className={'ex-link' + (canTranslate ? (showTranslation ? ' on' : '') : ' is-muted')}
            onClick={toggleTranslation}
            title={canTranslate ? 'Show or hide the translation' : 'No translation for this text'}
          >
            Translation {canTranslate ? (showTranslation ? 'on' : 'off') : 'n/a'}
          </button>
          {submitted && wrongNumbers.length > 0 && (
            <button type="button" className="ex-link" onClick={() => jumpTo(wrongNumbers[0])}>
              First wrong answer
            </button>
          )}
        </div>
      )}

      {practiceMode && restored && !submitted && (
        <div className="ex-restore">
          <span>
            Restored your last answers: {Object.keys(restored.answers).length} answered · {formatTime(restored.seconds)} on the clock
          </span>
          <button type="button" className="ex-link" onClick={restart}>
            Start over
          </button>
        </div>
      )}

      {practiceMode && submitted && result && (
        <ResultBar score={result.score} total={result.total} seconds={seconds} wrong={Math.max(0, result.total - result.score)} />
      )}

      {started && (
        <div hidden={!practiceMode}>
          <ExamAudio unit={unit} audioRef={audioRef} />
        </div>
      )}

      <div className="shell-main">
        <div className={'stage pane-' + pane3} style={{ '--split': `${split}%` } as React.CSSProperties}>
          <section className="pane source-pane" hidden={pane3 === 'questions'}>
            <div className="scroll" ref={sourceScrollRef}>
              <SourcePanel
                unit={unit}
                evidence={evidence}
                onSeek={unit.module === 'listening' ? seek : undefined}
                showTranslation={showTranslation}
                activeLine={activeLine}
                marks={marks}
                onMarks={updateMarks}
                notes={notes}
                onNotes={updateNotes}
              />
            </div>
          </section>

          {pane3 === 'both' && (
            <div
              className="split"
              role="separator"
              aria-label="Drag to resize the passage and the questions"
              onPointerDown={onSplitDown}
              onPointerMove={onSplitMove}
              onPointerUp={onSplitUp}
              onDoubleClick={() => setSplit(52)}
            />
          )}

          <section className="pane ex-questions" hidden={pane3 === 'source'}>
            <div className="scroll" ref={qScrollRef} onScroll={onQScroll}>
              <AnnotationArea marks={marks} onMarks={updateMarks} notes={notes} onNotes={updateNotes}>
                {cur.groups.map((g, i) => (
                  <GroupBlock
                    key={`${key}-${cur.unit.id}-${i}`}
                    group={g}
                    unit={unit}
                    answers={answers}
                    setAnswer={setAnswer}
                    items={items}
                    submitted={submitted}
                    onLocate={locate}
                    onActive={setActive}
                    active={active}
                  />
                ))}
              </AnnotationArea>
            </div>
          </section>
        </div>

        {notesOpen && (
          <aside className="notes-panel">
            <div className="notes-title">
              <p>Notes</p>
              <button type="button" className="close-notes" onClick={() => setNotesOpen(false)} aria-label="Close notes">
                ×
              </button>
            </div>
            <div className="notes-list">
              {noteItems.length ? (
                noteItems.map((n) => (
                  <div className="note-item" key={n.id}>
                    <p className="note-title">{n.text}</p>
                    <p className="note-content">{slotLabel(n.n)}</p>
                  </div>
                ))
              ) : (
                <p className="notes-empty">
                  Select text in the passage or transcript, right-click and choose <b>Notes</b> to add a note here.
                </p>
              )}
            </div>
          </aside>
        )}
      </div>

      <footer className="question-navigation">
        <div className="question-nav">
          <button
            type="button"
            className={'review' + (activeMarked ? ' on' : '')}
            onClick={() => toggleMark()}
            disabled={submitted}
            aria-pressed={activeMarked}
            title="Mark this question to come back to it later"
          >
            <span className="flag" aria-hidden />
            Review
          </button>
          <div className="qparts">
            {parts.map((p, i) => {
              const label =
                p.unit.module === 'reading'
                  ? `Passage ${p.unit.part ?? i + 1}`
                  : `Part ${p.unit.part ?? i + 1}`
              const doneHere = p.slots.filter((s) => countOf(answers[s.owner])).length
              if (i !== partIndex) {
                return (
                  <button
                    key={`jump-${i}`}
                    type="button"
                    className="qpart qpart-jump"
                    onClick={() => jumpTo(p.slots[0]?.n ?? numbers[0])}
                    title={`Go to ${label}`}
                  >
                    <span className="part-label">{label}</span>
                    <span className="count">
                      {doneHere} of {p.slots.length}
                    </span>
                  </button>
                )
              }
              return (
                <React.Fragment key={`active-${i}`}>
                  <div className="qpart is-active">
                    <span className="part-label">{label}</span>
                  </div>
                  {p.slots.map((slot) => {
                    const done = countOf(answers[slot.owner]) > 0
                    return (
                      <div className={'qnav-item' + (done ? ' answered' : '')} key={slot.n}>
                        <button
                          type="button"
                          className={
                            (done ? 'answered ' : '') +
                            (active != null && slot.owner === active ? 'current ' : '') +
                            (marked.has(slot.owner) ? 'for-review' : '')
                          }
                          onClick={() => jumpTo(slot.owner)}
                          title={`Question ${slot.n}`}
                          aria-current={active != null && slot.owner === active ? 'true' : undefined}
                        >
                          {slot.n}
                        </button>
                      </div>
                    )
                  })}
                </React.Fragment>
              )
            })}
          </div>
        </div>
      </footer>

      {started && (
        <div className="arrows">
          <button
            type="button"
            className="nav-arrow"
            onClick={() => step(-1)}
            disabled={activeIndex <= 0}
            title="Previous question"
            aria-label="Previous question"
          >
            <svg viewBox="0 0 24 24" aria-hidden="true">
              <path d="M15 4 7 12l8 8" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round" />
            </svg>
          </button>
          <button
            type="button"
            className="nav-arrow"
            onClick={() => step(1)}
            disabled={activeIndex >= numbers.length - 1}
            title="Next question"
            aria-label="Next question"
          >
            <svg viewBox="0 0 24 24" aria-hidden="true">
              <path d="M9 4l8 8-8 8" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round" />
            </svg>
          </button>
        </div>
      )}

      {menuOpen && <div className="menu-backdrop" onClick={() => setMenuOpen(false)} />}
      {volOpen && <div className="menu-backdrop" onClick={() => setVolOpen(false)} />}

      {!started && (
        <div className="start-overlay">
          <div className="start-modal" role="dialog" aria-modal="true" aria-label="Start test">
            <p className="start-title">
              Press OK to start the {unit.module === 'listening' ? 'Listening' : 'Reading'} test
            </p>
            <button type="button" className="btn-ok" onClick={startExam} autoFocus>
              OK
            </button>
          </div>
        </div>
      )}

      {modal === 'submit' && (
        <Overlay onClose={() => setModal(null)}>
          <div className="ex-dialog">
            <div className="ex-dialog-head">{submitted ? 'Test finished' : 'Finish test?'}</div>
            <div className="ex-dialog-body">
              You have answered <b>{answeredEntries}</b> of <b>{entries}</b> questions.
              {remaining > 0 && (
                <>
                  {' '}
                  There {remaining === 1 ? 'is' : 'are'} <b>{remaining}</b> question{remaining === 1 ? '' : 's'} you
                  have not answered.
                </>
              )}
              {marked.size > 0 && <> You marked {marked.size} question{marked.size === 1 ? '' : 's'} for review.</>}
              <br />
              You cannot change your answers after you finish the test.
            </div>
            <div className="ex-dialog-foot">
              <button type="button" className="ex-btn ghost" onClick={() => setModal(null)} autoFocus>
                Continue test
              </button>
              <button
                type="button"
                className="ex-btn primary"
                onClick={() => {
                  setModal(null)
                  doSubmit(false)
                }}
              >
                Finish test
              </button>
            </div>
          </div>
        </Overlay>
      )}

      {modal === 'exit' && (
        <Overlay onClose={() => setModal(null)}>
          <div className="ex-dialog">
            <div className="ex-dialog-head">Exit practice?</div>
            <div className="ex-dialog-body">
              {answeredEntries > 0
                ? `Your ${answeredEntries} answer${answeredEntries === 1 ? '' : 's'} are saved on this computer. You can come back and continue later.`
                : 'Your answers are saved on this computer. You can come back and continue later.'}
            </div>
            <div className="ex-dialog-foot">
              <button type="button" className="ex-btn ghost" onClick={() => setModal(null)} autoFocus>
                Continue test
              </button>
              <button
                type="button"
                className="ex-btn primary"
                onClick={() => {
                  saveNow()
                  onBack()
                }}
              >
                Exit
              </button>
            </div>
          </div>
        </Overlay>
      )}

      {modal === 'report' && result && (
        <Overlay onClose={() => setModal(null)}>
          <div className="ex-dialog ex-report">
            <div className="ex-report-kicker">{timeUp ? 'Time is up' : 'Test finished'}</div>
            <h2 className="ex-report-title">
              {brand} · {isPaper ? `${sectionName} · ${parts.length} parts` : partName}
            </h2>
            <div className="ex-report-score">
              <b>{result.score}</b>
              <span>/ {result.total}</span>
              <em>{pct}%</em>
            </div>
            <div className="ex-report-stats">
              <div>
                <b>{Math.max(0, (result?.total ?? 0) - (result?.score ?? 0))}</b>
                <span>Wrong</span>
              </div>
              <div>
                <b>{answeredEntries}</b>
                <span>Answered</span>
              </div>
              <div>
                <b>{formatTime(seconds)}</b>
                <span>Time used</span>
              </div>
            </div>
            <div className="ex-dialog-foot">
              <button type="button" className="ex-btn ghost" onClick={restart}>
                Retake
              </button>
              <button type="button" className="ex-btn primary" onClick={() => setModal(null)} autoFocus>
                Review answers
              </button>
            </div>
          </div>
        </Overlay>
      )}

      {modal === 'help' && (
        <HelpDialog module={unit.module} groups={groups} active={active} onClose={() => setModal(null)} />
      )}

      {modal === 'settings' && (
        <SettingsDialog
          timerMode={timerMode}
          limit={limit}
          hideTimer={hideTimer}
          skipIntro={skipIntro}
          showSeconds={showSeconds}
          practiceMode={practiceMode}
          markCount={marks.length + notes.length}
          onTimerMode={changeTimerMode}
          onLimit={changeLimit}
          onHideTimer={changeHideTimer}
          onSkipIntro={changeSkipIntro}
          onSeconds={changeSeconds}
          onPracticeMode={(value) => {
            setPracticeMode(value)
            saveExamPrefs({ practiceMode: value })
          }}
          onClearMarks={clearMarks}
          onClose={() => setModal(null)}
        />
      )}

      {screenHidden && (
        <div className="ex-hidden">
          <div className="ex-hidden-box">
            <h2>Screen hidden</h2>
            <div className="ex-hidden-body">
              <p>Your answers have been stored.</p>
              <p>Please note that the clock is still running. The time has not been paused.</p>
              <p>If you wish to leave the room, please tell your invigilator.</p>
              <p>Click the button below to go back to your test.</p>
              <button type="button" className="ex-btn primary" onClick={() => setScreenHidden(false)} autoFocus>
                Resume test
              </button>
            </div>
          </div>
        </div>
      )}

      {toast && <div className="ex-toast">{toast}</div>}
    </div>
  )
}

/** Help 面板：对齐机考 Help 里的 Test help / Task help 两栏 */
const HelpDialog: React.FC<{
  module: 'reading' | 'listening'
  groups: Unit['groups']
  active: number | null
  onClose: () => void
}> = ({ module, groups, active, onClose }) => {
  const [tab, setTab] = useState<'test' | 'task'>('test')
  const current = groups.find((g) => (g.questions || []).some((q) => q.number === active)) || groups[0]
  return (
    <Overlay onClose={onClose}>
      <div className="ex-dialog ex-help">
        <div className="ex-help-head">
          <span className="ex-dialog-head">Help</span>
          <div className="ex-help-tabs" role="tablist">
            <button type="button" className={tab === 'test' ? 'on' : ''} onClick={() => setTab('test')}>
              Test help
            </button>
            <button type="button" className={tab === 'task' ? 'on' : ''} onClick={() => setTab('task')}>
              Task help
            </button>
          </div>
        </div>
        <div className="ex-dialog-body">
          {tab === 'test' ? (
            <>
              <div className="ex-legend-list">
                <div>
                  <i className="ex-chip ex-chip-current">7</i>The question you are answering
                </div>
                <div>
                  <i className="ex-chip ex-chip-done">7</i>Answered
                </div>
                <div>
                  <i className="ex-chip">7</i>Not answered yet
                </div>
                <div>
                  <i className="ex-chip ex-chip-mark">7</i>Marked for review
                </div>
              </div>
              <dl className="ex-keys">
                <div>
                  <dt>
                    <kbd>Tab</kbd> / <kbd>Shift</kbd>+<kbd>Tab</kbd>
                  </dt>
                  <dd>Move to the next / previous answer box</dd>
                </div>
                <div>
                  <dt>
                    <kbd>↑</kbd> <kbd>↓</kbd> <kbd>←</kbd> <kbd>→</kbd>
                  </dt>
                  <dd>Move between the options of a multiple-choice question</dd>
                </div>
                <div>
                  <dt>
                    <kbd>Ctrl</kbd>+<kbd>C</kbd> / <kbd>V</kbd> / <kbd>Z</kbd>
                  </dt>
                  <dd>Copy, paste and undo — inside the answer boxes only</dd>
                </div>
                <div>
                  <dt>
                    <kbd>Esc</kbd>
                  </dt>
                  <dd>Close a dialog, the options menu or the notes panel</dd>
                </div>
              </dl>
              <p className="ex-note">
                Select any text in the {module === 'reading' ? 'passage' : 'transcript'} and right-click to{' '}
                <b>Highlight</b> it or add a <b>Note</b>. <b>Clear</b> removes the highlighting under the cursor;{' '}
                <b>Clear all</b> removes every highlight and note in this part.
                <br />
                The <b>Options</b> menu (top right) holds <b>Settings</b> for text size and background colour,{' '}
                <b>Hide screen</b> to cover the test while the clock keeps running, and <b>Help</b>.
                <br />
                Your answers are saved automatically. When the clock reaches zero this part closes by itself.
              </p>
            </>
          ) : (
            <>
              <div className="ex-task-title">Instructions for this part</div>
              <div className="ex-task-body">
                {(current?.instructions || 'There are no extra instructions for this part.')
                  .split(/\r?\n/)
                  .filter(Boolean)
                  .map((line, i) => (
                    <p key={i}>{line}</p>
                  ))}
              </div>
            </>
          )}
        </div>
        <div className="ex-dialog-foot">
          <button type="button" className="ex-btn primary" onClick={onClose} autoFocus>
            Close
          </button>
        </div>
      </div>
    </Overlay>
  )
}

const SettingsDialog: React.FC<{
  timerMode: TimerMode
  limit: number
  hideTimer: boolean
  skipIntro: boolean
  showSeconds: boolean
  practiceMode: boolean
  markCount: number
  onTimerMode: (mode: TimerMode) => void
  onLimit: (seconds: number) => void
  onHideTimer: (value: boolean) => void
  onSkipIntro: (value: boolean) => void
  onSeconds: (value: boolean) => void
  onPracticeMode: (value: boolean) => void
  onClearMarks: () => void
  onClose: () => void
}> = ({
  timerMode,
  limit,
  hideTimer,
  skipIntro,
  showSeconds,
  practiceMode,
  markCount,
  onTimerMode,
  onLimit,
  onHideTimer,
  onSkipIntro,
  onSeconds,
  onPracticeMode,
  onClearMarks,
  onClose,
}) => {
  const [scale, setScale] = useState(getTextScale)
  const [face, setFace] = useState(getFontFace)
  useEffect(() => subscribeTextScale(setScale), [])
  useEffect(() => subscribeFontFace(setFace), [])
  const minutes = [10, 15, 20, 25, 30, 45, 60]
  const preset: 'std' | 'large' | 'xl' = scale >= 1.35 ? 'xl' : scale >= 1.15 ? 'large' : 'std'
  return (
    <Overlay onClose={onClose}>
      <div className="ex-dialog ex-settings">
        <div className="ex-dialog-head">Settings</div>
        <div className="ex-dialog-body">
          <div className="ex-set-group">Display</div>
          <div className="ex-set-row">
            <span className="ex-set-label">Text size</span>
            <div className="ex-seg">
              <button type="button" className={preset === 'std' ? 'on' : ''} onClick={() => setTextScale(1)}>
                Standard
              </button>
              <button type="button" className={preset === 'large' ? 'on' : ''} onClick={() => setTextScale(1.2)}>
                Large
              </button>
              <button type="button" className={preset === 'xl' ? 'on' : ''} onClick={() => setTextScale(1.4)}>
                Extra large
              </button>
            </div>
            <div className="ex-zoom">
              <button type="button" onClick={() => stepTextScale(-1)} disabled={scale <= TEXT_MIN}>
                A−
              </button>
              <button type="button" onClick={resetTextScale}>
                {Math.round(scale * 100)}%
              </button>
              <button type="button" onClick={() => stepTextScale(1)} disabled={scale >= TEXT_MAX}>
                A+
              </button>
            </div>
          </div>
          <div className="ex-preview">
            <div className="ex-preview-kicker">Preview</div>
            <p>
              The carbon that people breathe out comes mainly from the food we eat. Select an answer, or type into the
              box — <b>answers are saved automatically</b>.
            </p>
          </div>
          <div className="ex-set-row">
            <span className="ex-set-label">Font</span>
            <select value={face} title="Arial is closest to the real test" onChange={(e) => setFontFace(e.target.value as FontFace)}>
              {(Object.keys(FONT_LABEL) as FontFace[]).map((f) => (
                <option key={f} value={f}>
                  {FONT_LABEL[f]}
                </option>
              ))}
            </select>
            <span className="ex-set-hint">Arial is closest to the real test</span>
          </div>

          <div className="ex-set-group">Practice</div>
          <div className="ex-set-row">
            <span className="ex-set-label">Practice mode</span>
            <label className="ex-check">
              <input type="checkbox" checked={practiceMode} onChange={(e) => onPracticeMode(e.target.checked)} />
              Show translation, split view and audio controls
            </label>
          </div>
          <div className="ex-set-row">
            <span className="ex-set-label">Timer</span>
            <div className="ex-seg">
              <button type="button" className={timerMode === 'down' ? 'on' : ''} onClick={() => onTimerMode('down')}>
                Count down
              </button>
              <button type="button" className={timerMode === 'up' ? 'on' : ''} onClick={() => onTimerMode('up')}>
                Count up
              </button>
            </div>
            <span className="ex-set-hint">The real test counts down and closes the part at zero</span>
          </div>
          <div className="ex-set-row">
            <span className="ex-set-label">Time allowed</span>
            <select value={limit} onChange={(e) => onLimit(Number(e.target.value))}>
              {minutes.map((m) => (
                <option key={m} value={m * 60}>
                  {m} minutes
                </option>
              ))}
            </select>
          </div>
          <div className="ex-set-row">
            <span className="ex-set-label">Clock display</span>
            <div className="ex-seg">
              <button type="button" className={!showSeconds ? 'on' : ''} onClick={() => onSeconds(false)}>
                Minutes
              </button>
              <button type="button" className={showSeconds ? 'on' : ''} onClick={() => onSeconds(true)}>
                Minutes and seconds
              </button>
            </div>
          </div>
          <div className="ex-set-row">
            <span className="ex-set-label">Clock</span>
            <label className="ex-check">
              <input type="checkbox" checked={hideTimer} onChange={(e) => onHideTimer(e.target.checked)} />
              Hide the clock
            </label>
          </div>
          <div className="ex-set-row">
            <span className="ex-set-label">Start screen</span>
            <label className="ex-check">
              <input type="checkbox" checked={!skipIntro} onChange={(e) => onSkipIntro(!e.target.checked)} />
              Show before each test
            </label>
          </div>
          <div className="ex-set-row">
            <span className="ex-set-label">Highlights</span>
            <button type="button" className="ex-link" onClick={onClearMarks} disabled={!markCount}>
              Clear highlights and notes ({markCount})
            </button>
          </div>
        </div>
        <div className="ex-dialog-foot">
          <button type="button" className="ex-btn primary" onClick={onClose} autoFocus>
            Close
          </button>
        </div>
      </div>
    </Overlay>
  )
}
