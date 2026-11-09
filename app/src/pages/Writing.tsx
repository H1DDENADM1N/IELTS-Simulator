import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import {
  AnnotationArea,
  AnnotatedText,
  closeMenus,
  formatTime,
  slotLabel,
} from '../components'
import {
  EXAM_LABEL,
  getWritingTasks,
  mediaFromRef,
  pageNumbers,
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
import { getDraft, saveDraft } from '../lib/store'
import {
  TEXT_MAX,
  TEXT_MIN,
  getTextScale,
  resetTextScale,
  setTextScale,
  stepTextScale,
  subscribeTextScale,
} from '../lib/textscale'
import type { WritingTask } from '../lib/types'

const PAGE_SIZE = 20

const TYPE_LABEL: Record<string, string> = {
  task1: 'IELTS Writing Task 1',
  task2: 'IELTS Writing Task 2',
  cet_writing: 'CET Writing',
  cet_translation: 'CET Translation',
}

/** 官方写作机考：Part 1 = 小作文 / 写作，Part 2 = 大作文 / 翻译 */
const PART_ORDER: Record<string, number> = { task1: 0, cet_writing: 0, task2: 1, cet_translation: 1 }

/** 题干标注的合成行号，与阅读原文的真实行号、题目区的合成行号都不相撞 */
const WR_SLOT = 3_000_000
/** 高亮 / 笔记按题存盘，用负数 id 与听力阅读单元隔开 */
const annoId = (taskId: number) => -taskId - 1

const wordCount = (text: string) => (text.match(/\S+/g) || []).length

const rubricOf = (task: WritingTask) => {
  const minutes =
    task.suggestedMinutes || (task.taskType === 'task1' ? 20 : task.taskType === 'task2' ? 40 : 30)
  if (task.taskType === 'cet_translation') {
    return `For this part, you are allowed ${minutes} minutes to translate a passage from Chinese into English.`
  }
  if (task.minWords) {
    return `You should spend about ${minutes} minutes on this task. Write at least ${task.minWords} words.`
  }
  return `You should spend about ${minutes} minutes on this task.`
}

/**
 * 一场写作考试里的两个 Part：
 *  - 四六级：同一套试卷（exam + paper）天然带一篇写作 + 一篇翻译，各 30 分钟；
 *  - 雅思：题库里 Task 1 / Task 2 没有卷号，按固定序号配成一场 60 分钟的完整写作；
 *  - 关掉配对就只练当前这一道。
 */
const buildParts = (taskId: number, pair: boolean): WritingTask[] => {
  const tasks = getWritingTasks()
  const task = tasks.find((t) => t.id === taskId)
  if (!task) return []
  if (!pair) return [task]
  if (task.paper) {
    const siblings = tasks.filter((t) => t.exam === task.exam && t.paper === task.paper)
    if (siblings.length > 1) {
      return siblings
        .sort((a, b) => (PART_ORDER[a.taskType] ?? 9) - (PART_ORDER[b.taskType] ?? 9) || a.id - b.id)
        .slice(0, 2)
    }
  }
  if (task.taskType === 'task1' || task.taskType === 'task2') {
    const ones = tasks.filter((t) => t.taskType === 'task1' && t.exam === task.exam).sort((a, b) => a.id - b.id)
    const twos = tasks.filter((t) => t.taskType === 'task2' && t.exam === task.exam).sort((a, b) => a.id - b.id)
    if (ones.length && twos.length) {
      const companion =
        task.taskType === 'task1'
          ? twos[Math.max(0, ones.findIndex((t) => t.id === task.id)) % twos.length]
          : ones[Math.max(0, twos.findIndex((t) => t.id === task.id)) % ones.length]
      if (companion) return task.taskType === 'task1' ? [task, companion] : [companion, task]
    }
  }
  return [task]
}

type WritingProps = {
  /** 带 id 时进入全屏机考答题页；不带时是站点里的题目列表 */
  id?: number
  initialExam?: string
  initialType?: string
  initialKeyword?: string
  initialPage?: number
  onBack?: () => void
}

/* ==========================================================================
 * 列表：保持站点原有浏览方式，点卡片进入机考答题页
 * ========================================================================== */
export const Writing: React.FC<WritingProps> = (props) => {
  if (props.id != null) {
    if (!getWritingTasks().some((t) => t.id === props.id)) {
      return (
        <div className="page">
          <button className="link-btn" onClick={() => goList({})}>← Back</button>
          <div className="empty">This writing task could not be found.</div>
        </div>
      )
    }
    return (
      <WritingExam
        key={props.id}
        taskId={props.id}
        onBack={props.onBack || (() => goList({}))}
      />
    )
  }
  return (
    <WritingList
      initialExam={props.initialExam}
      initialType={props.initialType}
      initialKeyword={props.initialKeyword}
      initialPage={props.initialPage}
    />
  )
}

const WritingList: React.FC<Omit<WritingProps, 'id' | 'onBack'>> = ({
  initialExam = '',
  initialType = '',
  initialKeyword = '',
  initialPage = 0,
}) => {
  const tasks = getWritingTasks()
  const [exam, setExam] = useState(initialExam)
  const [type, setType] = useState(initialType)
  const [keyword, setKeyword] = useState(initialKeyword)
  const [page, setPage] = useState(initialPage)

  const change = (fn: () => void) => {
    fn()
    setPage(0)
  }

  const list = useMemo(() => {
    const kw = keyword.trim().toLowerCase()
    return tasks.filter(
      (t) =>
        (!exam || t.exam === exam) &&
        (!type || t.taskType === type) &&
        (!kw || `${t.title || ''} ${t.titleZh || ''} ${t.paper || ''}`.toLowerCase().includes(kw)),
    )
  }, [tasks, exam, type, keyword])
  const pages = Math.max(1, Math.ceil(list.length / PAGE_SIZE))
  const safePage = Math.min(page, pages - 1)
  const shown = list.slice(safePage * PAGE_SIZE, (safePage + 1) * PAGE_SIZE)

  const open = (taskId: number) => {
    const q = new URLSearchParams()
    if (exam) q.set('ex', exam)
    if (type) q.set('ty', type)
    if (keyword) q.set('kw', keyword)
    if (safePage > 0) q.set('p', String(safePage + 1))
    q.set('id', String(taskId))
    window.location.hash = '#/writing?' + q.toString()
    window.scrollTo({ top: 0 })
  }

  return (
    <div className="page">
      <h1 className="page-title">写作 / 翻译</h1>
      <p className="page-sub">共 {tasks.length} 道题。草稿自动保存在本机，点题目进入机考答题界面。</p>

      <div className="filters">
        <div className="filter-row">
          <span className="filter-label">考试</span>
          {[['', '全部'], ['ielts', '雅思'], ['cet4', '四级'], ['cet6', '六级']].map(([v, l]) => (
            <button key={v} className={'chip' + (exam === v ? ' on' : '')} onClick={() => change(() => setExam(v))}>{l}</button>
          ))}
        </div>
        <div className="filter-row">
          <span className="filter-label">类型</span>
          {[['', '全部'], ...Object.entries(TYPE_LABEL)].map(([v, l]) => (
            <button key={v} className={'chip' + (type === v ? ' on' : '')} onClick={() => change(() => setType(v))}>{l}</button>
          ))}
        </div>
        <div className="filter-row">
          <span className="filter-label">搜索</span>
          <div className="search-wrap">
            <input
              className="search"
              placeholder="搜索标题、试卷"
              value={keyword}
              onChange={(e) => change(() => setKeyword(e.target.value))}
            />
            {keyword && <button className="search-clear" onClick={() => change(() => setKeyword(''))} aria-label="清空搜索">×</button>}
          </div>
        </div>
      </div>

      <div className="cards">
        {shown.map((t) => (
          <button className="card" key={t.id} onClick={() => open(t.id)}>
            <div className="card-top">
              <span className="badge">{EXAM_LABEL[t.exam] || t.exam}</span>
              <span className="badge subtle">{TYPE_LABEL[t.taskType] || t.taskType}</span>
              {getDraft(t.id) && <span className="badge done">有草稿</span>}
            </div>
            <div className="card-title">{t.title || t.titleZh || `题目 ${t.id}`}</div>
            <div className="card-meta">{t.paper && <span>{t.paper}</span>}{t.minWords && <span>不少于 {t.minWords} 词</span>}</div>
          </button>
        ))}
        {!list.length && <div className="empty">没有符合条件的题目。</div>}
      </div>
      {pages > 1 && (
        <div className="pager">
          <button disabled={safePage === 0} onClick={() => setPage(safePage - 1)}>← 上一页</button>
          {pageNumbers(safePage, pages).map((n, i) =>
            n === '…' ? (
              <span className="pager-gap" key={`gap-${i}`}>…</span>
            ) : (
              <button
                key={n}
                className={'pager-num' + (n === safePage + 1 ? ' on' : '')}
                onClick={() => setPage(n - 1)}
              >
                {n}
              </button>
            ),
          )}
          <button disabled={safePage >= pages - 1} onClick={() => setPage(safePage + 1)}>下一页 →</button>
        </div>
      )}
    </div>
  )
}

const goList = (q: Record<string, string>) => {
  const params = new URLSearchParams(q)
  const rest = params.toString()
  window.location.hash = '#/writing' + (rest ? '?' + rest : '')
}

/* ==========================================================================
 * 机考答题页：按 GEL / BC familiarisation test 的 Writing test 版式
 *   粉红顶栏 + 倒计时 / Part 说明框 / 左题目右输入 + Word count
 *   / 底栏 Part 1 · Part 2 / 右下 60×60 箭头 / Notes · Settings · Help
 * ========================================================================== */
type Modal = 'submit' | 'exit' | 'report' | 'sample' | 'help' | 'settings' | null
type Pane = 'both' | 'prompt' | 'answer'

const Overlay: React.FC<{ onClose: () => void; children: React.ReactNode }> = ({ onClose, children }) => (
  <div className="ex-overlay" role="presentation" onClick={onClose}>
    <div className="ex-dialog-wrap" onClick={(e) => e.stopPropagation()} role="dialog" aria-modal="true">
      {children}
    </div>
  </div>
)

const WritingExam: React.FC<{ taskId: number; onBack: () => void }> = ({ taskId, onBack }) => {
  const prefs0 = useMemo(() => readExamPrefs(), [])
  const [pairTasks, setPairTasks] = useState(prefs0.pairTasks)
  const [parts, setParts] = useState<WritingTask[]>(() => buildParts(taskId, prefs0.pairTasks))
  const [partIndex, setPartIndex] = useState(() =>
    Math.max(0, buildParts(taskId, prefs0.pairTasks).findIndex((t) => t.id === taskId)),
  )
  const [drafts, setDrafts] = useState<Record<number, string>>(() => {
    const out: Record<number, string> = {}
    buildParts(taskId, prefs0.pairTasks).forEach((t) => {
      out[t.id] = getDraft(t.id)
    })
    return out
  })

  // buildParts 一定包含当前这道题，parts 不会为空
  const cur = parts[Math.min(partIndex, Math.max(parts.length - 1, 0))] || parts[0]

  const text = drafts[cur.id] || ''
  const words = wordCount(text)
  const image = mediaFromRef(cur.image)
  const paragraphs = useMemo(
    () => (cur.prompt || '').split(/\n\s*\n/).map((p) => p.trim()).filter(Boolean),
    [cur.prompt],
  )
  const hasSample = Boolean(cur.sampleAnswer || cur.modelAnswerZh || cur.analysis)

  const [pane, setPane] = useState<Pane>('both')
  const [split, setSplit] = useState(50)
  const [seconds, setSeconds] = useState(0)
  const [started, setStarted] = useState(prefs0.skipIntro)
  const [submitted, setSubmitted] = useState(false)
  const [timeUp, setTimeUp] = useState(false)
  const [timerMode, setTimerMode] = useState<TimerMode>(prefs0.timerMode)
  const [limit, setLimit] = useState(prefs0.limits.writing || DEFAULT_LIMITS.writing)
  const [hideTimer, setHideTimer] = useState(prefs0.hideTimer)
  const [skipIntro, setSkipIntro] = useState(prefs0.skipIntro)
  const [showSeconds, setShowSeconds] = useState(prefs0.showSeconds)
  const [practiceMode, setPracticeMode] = useState(prefs0.practiceMode)
  const [marks, setMarks] = useState<HighlightRange[]>(() => readHighlights(annoId(taskId)))
  const [notes, setNotes] = useState<NoteRange[]>(() => readNotes(annoId(taskId)))
  const [menuOpen, setMenuOpen] = useState(false)
  const [notesOpen, setNotesOpen] = useState(false)
  const [screenHidden, setScreenHidden] = useState(false)
  const [modal, setModal] = useState<Modal>(null)
  const [toast, setToast] = useState('')
  const [runId, setRunId] = useState(0)

  const draftsRef = useRef(drafts)
  const secondsRef = useRef(seconds)
  const submittedRef = useRef(submitted)
  const tickBase = useRef({ at: Date.now(), sec: 0 })
  const toastTimer = useRef(0)
  const dragRef = useRef(false)
  const promptScrollRef = useRef<HTMLDivElement>(null)
  const answerRef = useRef<HTMLTextAreaElement>(null)
  draftsRef.current = drafts
  secondsRef.current = seconds
  submittedRef.current = submitted

  const showToast = useCallback((message: string) => {
    setToast(message)
    window.clearTimeout(toastTimer.current)
    toastTimer.current = window.setTimeout(() => setToast(''), 3200)
  }, [])
  useEffect(() => () => window.clearTimeout(toastTimer.current), [])

  const saveAll = useCallback(() => {
    Object.entries(draftsRef.current).forEach(([key, value]) => saveDraft(Number(key), value))
  }, [])

  // 草稿自动保存：改字 400ms 后写盘，离开页面 / 关窗口前补一次
  useEffect(() => {
    const timer = window.setTimeout(saveAll, 400)
    return () => window.clearTimeout(timer)
  }, [drafts, saveAll])
  useEffect(() => () => saveAll(), [saveAll])
  useEffect(() => {
    const onUnload = () => saveAll()
    window.addEventListener('beforeunload', onUnload)
    return () => window.removeEventListener('beforeunload', onUnload)
  }, [saveAll])

  // 计时以 Date.now 为准，窗口挂起再回来也不漏算
  useEffect(() => {
    if (!started || submitted) return
    tickBase.current = { at: Date.now(), sec: secondsRef.current }
    const timer = window.setInterval(() => {
      setSeconds(tickBase.current.sec + Math.floor((Date.now() - tickBase.current.at) / 1000))
    }, 500)
    return () => window.clearInterval(timer)
  }, [started, submitted, runId])

  const finish = useCallback(
    (auto = false) => {
      if (submittedRef.current) return
      submittedRef.current = true
      saveAll()
      setSubmitted(true)
      setTimeUp(auto)
      setMenuOpen(false)
      setModal('report')
    },
    [saveAll],
  )

  const remaining = Math.max(0, limit - seconds)
  useEffect(() => {
    if (!started || submitted || timerMode !== 'down') return
    if (remaining <= 0) finish(true)
  }, [remaining, started, submitted, timerMode, finish])

  // 换 Part 时把这一题的高亮 / 笔记读回来，并让题干回到顶部
  useEffect(() => {
    setMarks(readHighlights(annoId(cur.id)))
    setNotes(readNotes(annoId(cur.id)))
    promptScrollRef.current?.scrollTo({ top: 0 })
    if (started && !submitted) window.setTimeout(() => answerRef.current?.focus(), 60)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [cur.id])

  // Esc 关菜单 / 弹窗 / Notes 面板，其余按键全部交还浏览器
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return
      if (menuOpen) {
        e.preventDefault()
        setMenuOpen(false)
      } else if (modal) {
        e.preventDefault()
        setModal(null)
      } else if (notesOpen) {
        e.preventDefault()
        setNotesOpen(false)
      } else {
        closeMenus()
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [menuOpen, modal, notesOpen])

  const updateText = (value: string) => {
    if (submittedRef.current) return
    setDrafts((prev) => ({ ...prev, [cur.id]: value }))
  }

  const clearDraft = () => {
    if (submittedRef.current) return
    setDrafts((prev) => ({ ...prev, [cur.id]: '' }))
    saveDraft(cur.id, '')
    showToast('Draft cleared.')
    answerRef.current?.focus()
  }

  const updateMarks = (next: HighlightRange[]) => {
    const merged = mergeHighlights(next)
    setMarks(merged)
    saveHighlights(annoId(cur.id), merged)
  }
  const updateNotes = (next: NoteRange[]) => {
    setNotes(next)
    saveNotes(annoId(cur.id), next)
  }
  const clearMarks = () => {
    setMarks([])
    setNotes([])
    clearHighlights(annoId(cur.id))
    clearNotes(annoId(cur.id))
    showToast('Highlights and notes cleared for this task.')
  }

  const gotoPart = (index: number) => {
    setPartIndex(Math.min(parts.length - 1, Math.max(0, index)))
    closeMenus()
  }

  const changePair = (value: boolean) => {
    const next = buildParts(taskId, value)
    setPairTasks(value)
    setParts(next)
    setDrafts((prev) => {
      const merged = { ...prev }
      next.forEach((t) => {
        if (!(t.id in merged)) merged[t.id] = getDraft(t.id)
      })
      return merged
    })
    setPartIndex(Math.max(0, next.findIndex((t) => t.id === taskId)))
    saveExamPrefs({ pairTasks: value })
    showToast(value ? 'Task 1 + Task 2 paired as one 60-minute test.' : 'Single-task practice.')
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
    saveExamPrefs({ limits: { writing: value } })
    if (timerMode === 'down' && secondsRef.current >= value) {
      setSeconds(0)
      setRunId((v) => v + 1)
      showToast('The clock has been reset.')
    }
  }
  const changeHideTimer = (value: boolean) => {
    setHideTimer(value)
    saveExamPrefs({ hideTimer: value })
  }
  const changeSkipIntro = (value: boolean) => {
    setSkipIntro(value)
    saveExamPrefs({ skipIntro: value })
  }
  const changeSeconds = (value: boolean) => {
    setShowSeconds(value)
    saveExamPrefs({ showSeconds: value })
  }
  const changePracticeMode = (value: boolean) => {
    setPracticeMode(value)
    saveExamPrefs({ practiceMode: value })
    showToast(value ? 'Practice mode on: model answer and view controls are available.' : 'Practice mode off: exam conditions.')
  }

  const startExam = () => {
    setStarted(true)
    setRunId((v) => v + 1)
    window.setTimeout(() => answerRef.current?.focus(), 80)
  }

  const restart = () => {
    submittedRef.current = false
    setSubmitted(false)
    setSeconds(0)
    setTimeUp(false)
    setModal(null)
    setScreenHidden(false)
    setRunId((v) => v + 1)
    window.setTimeout(() => answerRef.current?.focus(), 80)
  }

  const askExit = () => {
    if (submitted || !parts.some((p) => (drafts[p.id] || '').trim())) {
      saveAll()
      onBack()
      return
    }
    setModal('exit')
  }

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
    // 官方 resizer：可拖满 0–100%，按住 Shift 吸附到 20px 网格
    let px = e.clientX - rect.left
    if (e.shiftKey) px = Math.ceil(px / 20) * 20
    setSplit(Math.min(100, Math.max(0, (px / rect.width) * 100)))
  }
  const onSplitUp = (e: React.PointerEvent<HTMLDivElement>) => {
    dragRef.current = false
    if (e.currentTarget.hasPointerCapture(e.pointerId)) e.currentTarget.releasePointerCapture(e.pointerId)
    document.body.classList.remove('ex-resizing')
  }

  const downMode = timerMode === 'down'
  const minutesLeft = Math.ceil(remaining / 60)
  const mm = Math.floor(remaining / 60)
  const ss = remaining % 60
  const coarseText = submitted
    ? 'Test finished'
    : downMode
      ? remaining <= 60
        ? `0:${remaining}`
        : `${minutesLeft} minute${minutesLeft === 1 ? '' : 's'} remaining`
      : `${Math.floor(seconds / 60)} minutes elapsed`
  const preciseText = submitted ? formatTime(seconds) : `${mm} : ${String(ss).padStart(2, '0')} remaining`
  const warn = !submitted && downMode && remaining <= 300
  const flash = !submitted && downMode && remaining <= 600 && remaining >= 590

  const answeredCount = parts.filter((p) => (drafts[p.id] || '').trim()).length
  const noteItems: NoteRange[] = []
  const noteSeen = new Set<string>()
  notes.forEach((n) => {
    if (noteSeen.has(n.id)) return
    noteSeen.add(n.id)
    noteItems.push(n)
  })
  const minWords = cur.minWords || 0
  const wordOk = !minWords || words >= minWords

  return (
    <div className="exam-shell wr-shell" onContextMenu={(e) => e.preventDefault()}>
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
            onClick={() => setMenuOpen((v) => !v)}
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
                onClick={() => { changePracticeMode(!practiceMode); setMenuOpen(false) }}
              >
                Practice mode
                <span className="check">{practiceMode ? 'On' : 'Off'}</span>
              </button>
              <button
                type="button"
                role="menuitemcheckbox"
                aria-checked={pairTasks}
                onClick={() => { changePair(!pairTasks); setMenuOpen(false) }}
              >
                Pair Task 1 + Task 2
                <span className="check">{pairTasks ? 'On' : 'Off'}</span>
              </button>
              <button
                type="button"
                role="menuitem"
                disabled={!practiceMode || !hasSample}
                onClick={() => { setMenuOpen(false); setModal('sample') }}
              >
                Model answer &amp; analysis
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

      <div className="rubric wr-rubric">
        <h3>Part {partIndex + 1}</h3>
        <p>{rubricOf(cur)}</p>
      </div>

      {practiceMode && started && (
        <div className="ex-tools">
          <div className="ex-tabs" role="tablist" aria-label="Task and answer">
            <button type="button" className={pane === 'prompt' ? 'on' : ''} onClick={() => setPane('prompt')}>Task</button>
            <button type="button" className={pane === 'both' ? 'on' : ''} onClick={() => setPane('both')}>Split</button>
            <button type="button" className={pane === 'answer' ? 'on' : ''} onClick={() => setPane('answer')}>Answer</button>
          </div>
          <span className="ex-scope">
            {TYPE_LABEL[cur.taskType] || cur.taskType} · {cur.paper || EXAM_LABEL[cur.exam] || cur.exam}
          </span>
          <span className="ex-tools-spacer" />
          <button type="button" className="ex-link" disabled={!hasSample} onClick={() => setModal('sample')}>
            Model answer
          </button>
          <button type="button" className="ex-link" disabled={submitted} onClick={clearDraft}>
            Clear draft
          </button>
        </div>
      )}

      <div className="shell-main">
        <div
          className={'stage ' + (pane === 'both' ? 'pane-both' : '')}
          style={{ '--split': `${split}%` } as React.CSSProperties}
        >
          <section className="pane wr-prompt-pane" hidden={pane === 'answer'}>
            <div className="scroll" ref={promptScrollRef}>
              <AnnotationArea marks={marks} onMarks={updateMarks} notes={notes} onNotes={updateNotes}>
                <div className="wr-prompt">
                  {paragraphs.map((p, i) => {
                    const lead = cur.taskType === 'task1' && i < 2
                    return (
                      <p className={'wr-prompt-line' + (lead ? ' wr-prompt-lead' : '')} key={i}>
                        <AnnotatedText text={p} slot={WR_SLOT + i} />
                      </p>
                    )
                  })}
                  {cur.taskType === 'task2' && paragraphs.length > 2 && (
                    <div className="wr-topic-box">
                      {paragraphs.slice(1, -1).map((p, i) => (
                        <p key={`topic-${i}`}><strong>{p}</strong></p>
                      ))}
                    </div>
                  )}
                  {image && <img className="wr-figure" src={image} alt={cur.title || 'Writing task figure'} />}
                </div>
              </AnnotationArea>
            </div>
          </section>

          {pane === 'both' && (
            <div
              className="split"
              role="separator"
              aria-label="Drag to resize the task and the answer"
              onPointerDown={onSplitDown}
              onPointerMove={onSplitMove}
              onPointerUp={onSplitUp}
              onDoubleClick={() => setSplit(50)}
            />
          )}

          <section className="pane wr-answer-pane" hidden={pane === 'prompt'}>
            <div className="wr-answer-wrap">
              <textarea
                key={cur.id}
                ref={answerRef}
                className="answer wr-answer"
                data-task-id={cur.id}
                value={text}
                onChange={(e) => updateText(e.target.value)}
                readOnly={submitted}
                placeholder="Write your answer here…"
                aria-label={`Your answer for Part ${partIndex + 1}`}
                autoComplete="off"
                autoCorrect="off"
                autoCapitalize="off"
                spellCheck={false}
              />
              <p className="word-count">
                Word count: {words}
                {practiceMode && minWords > 0 && (
                  <span className={'wr-min' + (wordOk ? ' ok' : '')}>
                    {' '}· Minimum {minWords} words
                  </span>
                )}
              </p>
            </div>
          </section>
        </div>

        {notesOpen && (
          <aside className="notes-panel">
            <div className="notes-title">
              <p>Notes</p>
              <button type="button" className="close-notes" onClick={() => setNotesOpen(false)} aria-label="Close notes">×</button>
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
                  Select text in the task, right-click and choose <b>Notes</b> to add a note here.
                </p>
              )}
            </div>
          </aside>
        )}
      </div>

      <footer className="question-navigation wr-navigation">
        <div className="question-nav">
          <div className="qparts">
            {parts.map((p, i) => {
              const label = `Part ${i + 1}`
              const done = Boolean((drafts[p.id] || '').trim())
              return (
                <div className="wr-part-group" key={`group-${p.id}`}>
                  {i !== partIndex ? (
                    <button
                      type="button"
                      className="qpart qpart-jump"
                      onClick={() => gotoPart(i)}
                      title={`Go to ${label} · ${p.title || TYPE_LABEL[p.taskType] || p.taskType}`}
                    >
                      <span className="part-label">{label}</span>
                      <span className="count">{done ? 1 : 0} of 1</span>
                    </button>
                  ) : (
                    <>
                      <div className="qpart is-active">
                        <span className="part-label">{label}</span>
                      </div>
                      <div className={'qnav-item' + (done ? ' answered' : '')}>
                        <button
                          type="button"
                          className={(done ? 'answered ' : '') + 'current'}
                          onClick={() => answerRef.current?.focus()}
                          title={p.title || TYPE_LABEL[p.taskType] || p.taskType}
                          aria-current="true"
                        >
                          {i + 1}
                        </button>
                      </div>
                    </>
                  )}
                </div>
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
            onClick={() => gotoPart(partIndex - 1)}
            disabled={partIndex <= 0}
            title="Previous part"
            aria-label="Previous part"
          >
            <svg viewBox="0 0 24 24" aria-hidden="true">
              <path d="M15 4 7 12l8 8" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round" />
            </svg>
          </button>
          <button
            type="button"
            className="nav-arrow"
            onClick={() => gotoPart(partIndex + 1)}
            disabled={partIndex >= parts.length - 1}
            title="Next part"
            aria-label="Next part"
          >
            <svg viewBox="0 0 24 24" aria-hidden="true">
              <path d="M9 4l8 8-8 8" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round" />
            </svg>
          </button>
        </div>
      )}

      {menuOpen && <div className="menu-backdrop" onClick={() => setMenuOpen(false)} />}

      {!started && (
        <div className="start-overlay">
          <div className="start-modal" role="dialog" aria-modal="true" aria-label="Start test">
            <p className="start-title">Press OK to start the Writing test</p>
            <button type="button" className="btn-ok" onClick={startExam} autoFocus>OK</button>
          </div>
        </div>
      )}

      {modal === 'submit' && (
        <Overlay onClose={() => setModal(null)}>
          <div className="ex-dialog">
            <div className="ex-dialog-head">Finish test?</div>
            <div className="ex-dialog-body">
              {parts.map((p, i) => (
                <div key={p.id}>
                  Part {i + 1}: <b>{wordCount(drafts[p.id] || '')}</b> words
                  {p.minWords ? ` (at least ${p.minWords} words)` : ''}
                </div>
              ))}
              <br />
              Your answers are saved on this computer. You cannot change them after you finish the test.
            </div>
            <div className="ex-dialog-foot">
              <button type="button" className="ex-btn ghost" onClick={() => setModal(null)} autoFocus>Continue test</button>
              <button type="button" className="ex-btn primary" onClick={() => { setModal(null); finish(false) }}>Finish test</button>
            </div>
          </div>
        </Overlay>
      )}

      {modal === 'exit' && (
        <Overlay onClose={() => setModal(null)}>
          <div className="ex-dialog">
            <div className="ex-dialog-head">Exit practice?</div>
            <div className="ex-dialog-body">
              Your drafts are saved on this computer. You can come back and continue later.
            </div>
            <div className="ex-dialog-foot">
              <button type="button" className="ex-btn ghost" onClick={() => setModal(null)} autoFocus>Continue test</button>
              <button type="button" className="ex-btn primary" onClick={() => { saveAll(); onBack() }}>Exit</button>
            </div>
          </div>
        </Overlay>
      )}

      {modal === 'report' && (
        <Overlay onClose={() => setModal(null)}>
          <div className="ex-dialog ex-report">
            <div className="ex-report-kicker">{timeUp ? 'Time is up' : 'Test finished'}</div>
            <h2 className="ex-report-title">Writing test · {parts.length} part{parts.length === 1 ? '' : 's'}</h2>
            <div className="ex-report-stats">
              {parts.map((p, i) => (
                <div key={p.id}>
                  <b>{wordCount(drafts[p.id] || '')}</b>
                  <span>Part {i + 1} words</span>
                </div>
              ))}
              <div>
                <b>{formatTime(seconds)}</b>
                <span>Time used</span>
              </div>
            </div>
            <div className="ex-dialog-foot">
              <button type="button" className="ex-btn ghost" onClick={restart}>Continue writing</button>
              <button type="button" className="ex-btn ghost" onClick={() => { saveAll(); onBack() }}>Exit practice</button>
              <button type="button" className="ex-btn primary" onClick={() => setModal(null)} autoFocus>Review answers</button>
            </div>
          </div>
        </Overlay>
      )}

      {modal === 'sample' && (
        <Overlay onClose={() => setModal(null)}>
          <div className="ex-dialog wr-sample-dialog">
            <div className="ex-dialog-head">Model answer &amp; analysis</div>
            <div className="ex-dialog-body">
              <div className="wr-sample-task">Part {partIndex + 1} · {cur.title || TYPE_LABEL[cur.taskType] || cur.taskType}</div>
              {cur.sampleAnswer && <><h3>范文 / 参考译文</h3><div className="wr-sample-text">{cur.sampleAnswer}</div></>}
              {cur.modelAnswerZh && <><h3>中文参考</h3><div className="wr-sample-text">{cur.modelAnswerZh}</div></>}
              {cur.analysis && <><h3>解析</h3><div className="wr-sample-text">{cur.analysis}</div></>}
              {!hasSample && <p>This task has no model answer attached.</p>}
            </div>
            <div className="ex-dialog-foot">
              <button type="button" className="ex-btn primary" onClick={() => setModal(null)} autoFocus>Close</button>
            </div>
          </div>
        </Overlay>
      )}

      {modal === 'help' && (
        <WritingHelp task={cur} onClose={() => setModal(null)} />
      )}

      {modal === 'settings' && (
        <WritingSettings
          timerMode={timerMode}
          limit={limit}
          hideTimer={hideTimer}
          skipIntro={skipIntro}
          showSeconds={showSeconds}
          practiceMode={practiceMode}
          pairTasks={pairTasks}
          markCount={marks.length + notes.length}
          onTimerMode={changeTimerMode}
          onLimit={changeLimit}
          onHideTimer={changeHideTimer}
          onSkipIntro={changeSkipIntro}
          onSeconds={changeSeconds}
          onPracticeMode={changePracticeMode}
          onPairTasks={changePair}
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
              <button type="button" className="ex-btn primary" onClick={() => setScreenHidden(false)} autoFocus>Resume test</button>
            </div>
          </div>
        </div>
      )}

      {toast && <div className="ex-toast">{toast}</div>}
    </div>
  )
}

/* --------------------------------------------------------------------------
 * Help：Test help / Task help，沿用答题页的 Help 版式
 * ------------------------------------------------------------------------ */
const WritingHelp: React.FC<{ task: WritingTask; onClose: () => void }> = ({ task, onClose }) => {
  const [tab, setTab] = useState<'test' | 'task'>('test')
  return (
    <Overlay onClose={onClose}>
      <div className="ex-dialog ex-help">
        <div className="ex-help-head">
          <span className="ex-dialog-head">Help</span>
          <div className="ex-help-tabs" role="tablist">
            <button type="button" className={tab === 'test' ? 'on' : ''} onClick={() => setTab('test')}>Test help</button>
            <button type="button" className={tab === 'task' ? 'on' : ''} onClick={() => setTab('task')}>Task help</button>
          </div>
        </div>
        <div className="ex-dialog-body">
          {tab === 'test' ? (
            <>
              <div className="ex-legend-list">
                <div><i className="ex-chip ex-chip-current">1</i>The part you are answering</div>
                <div><i className="ex-chip ex-chip-done">1</i>Draft started</div>
                <div><i className="ex-chip">1</i>Not started yet</div>
                <div><i className="ex-chip">↔</i>Drag the divider to resize</div>
              </div>
              <dl className="ex-keys">
                <div><dt><kbd>Ctrl</kbd>+<kbd>C</kbd> / <kbd>V</kbd> / <kbd>Z</kbd></dt><dd>Copy, paste and undo inside the answer box</dd></div>
                <div><dt><kbd>Esc</kbd></dt><dd>Close a dialog, the options menu or the notes panel</dd></div>
              </dl>
              <p className="ex-note">
                The task stays on the left while you type on the right. <b>Word count</b> updates as you type; the
                whole Writing section has one clock, so you decide how to split it between the parts. Click a part in
                the bottom bar (or use the arrows) to switch at any time — both drafts are saved automatically.
                <br />
                Select text in the task and right-click to <b>Highlight</b> it or add a <b>Note</b>. The{' '}
                <b>Options</b> menu holds <b>Settings</b>, <b>Hide screen</b>, <b>Practice mode</b> and the{' '}
                <b>Model answer</b>. When the clock reaches zero the test closes by itself.
              </p>
            </>
          ) : (
            <>
              <div className="ex-task-title">Instructions for this part</div>
              <div className="ex-task-body"><p>{rubricOf(task)}</p></div>
              <div className="ex-task-title">About this task</div>
              <div className="ex-task-body">
                <p>{TYPE_LABEL[task.taskType] || task.taskType}{task.paper ? ` · ${task.paper}` : ''}</p>
                <p>{task.title || task.titleZh || ''}</p>
                {task.minWords ? <p>Write at least {task.minWords} words.</p> : null}
                {task.suggestedMinutes ? <p>Suggested time: about {task.suggestedMinutes} minutes.</p> : null}
              </div>
            </>
          )}
        </div>
        <div className="ex-dialog-foot">
          <button type="button" className="ex-btn primary" onClick={onClose} autoFocus>Close</button>
        </div>
      </div>
    </Overlay>
  )
}

/* --------------------------------------------------------------------------
 * Settings：与听力 / 阅读机考同一套控件，另加写作专属的配对开关
 * ------------------------------------------------------------------------ */
const WritingSettings: React.FC<{
  timerMode: TimerMode
  limit: number
  hideTimer: boolean
  skipIntro: boolean
  showSeconds: boolean
  practiceMode: boolean
  pairTasks: boolean
  markCount: number
  onTimerMode: (mode: TimerMode) => void
  onLimit: (seconds: number) => void
  onHideTimer: (value: boolean) => void
  onSkipIntro: (value: boolean) => void
  onSeconds: (value: boolean) => void
  onPracticeMode: (value: boolean) => void
  onPairTasks: (value: boolean) => void
  onClearMarks: () => void
  onClose: () => void
}> = ({
  timerMode, limit, hideTimer, skipIntro, showSeconds, practiceMode, pairTasks, markCount,
  onTimerMode, onLimit, onHideTimer, onSkipIntro, onSeconds, onPracticeMode, onPairTasks, onClearMarks, onClose,
}) => {
  const [scale, setScale] = useState(getTextScale)
  const [face, setFace] = useState(getFontFace)
  useEffect(() => subscribeTextScale(setScale), [])
  useEffect(() => subscribeFontFace(setFace), [])
  const minutes = [10, 20, 30, 40, 60, 90]
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
              <button type="button" className={preset === 'std' ? 'on' : ''} onClick={() => setTextScale(1)}>Standard</button>
              <button type="button" className={preset === 'large' ? 'on' : ''} onClick={() => setTextScale(1.2)}>Large</button>
              <button type="button" className={preset === 'xl' ? 'on' : ''} onClick={() => setTextScale(1.4)}>Extra large</button>
            </div>
            <div className="ex-zoom">
              <button type="button" onClick={() => stepTextScale(-1)} disabled={scale <= TEXT_MIN}>A−</button>
              <button type="button" onClick={resetTextScale}>{Math.round(scale * 100)}%</button>
              <button type="button" onClick={() => stepTextScale(1)} disabled={scale >= TEXT_MAX}>A+</button>
            </div>
          </div>
          <div className="ex-preview">
            <div className="ex-preview-kicker">Preview</div>
            <p>The task stays visible on the left. Type your answer on the right — <b>drafts are saved automatically</b>.</p>
          </div>
          <div className="ex-set-row">
            <span className="ex-set-label">Font</span>
            <select value={face} title="Arial is closest to the real test" onChange={(e) => setFontFace(e.target.value as FontFace)}>
              {(Object.keys(FONT_LABEL) as FontFace[]).map((f) => <option key={f} value={f}>{FONT_LABEL[f]}</option>)}
            </select>
            <span className="ex-set-hint">Arial is closest to the real test</span>
          </div>

          <div className="ex-set-group">Writing test</div>
          <div className="ex-set-row">
            <span className="ex-set-label">Parts</span>
            <label className="ex-check">
              <input type="checkbox" checked={pairTasks} onChange={(e) => onPairTasks(e.target.checked)} />
              Pair Task 1 + Task 2 (CET: writing + translation)
            </label>
          </div>
          <div className="ex-set-row">
            <span className="ex-set-label">Practice mode</span>
            <label className="ex-check">
              <input type="checkbox" checked={practiceMode} onChange={(e) => onPracticeMode(e.target.checked)} />
              Show model answer and view controls
            </label>
          </div>

          <div className="ex-set-group">Clock</div>
          <div className="ex-set-row">
            <span className="ex-set-label">Timer</span>
            <div className="ex-seg">
              <button type="button" className={timerMode === 'down' ? 'on' : ''} onClick={() => onTimerMode('down')}>Count down</button>
              <button type="button" className={timerMode === 'up' ? 'on' : ''} onClick={() => onTimerMode('up')}>Count up</button>
            </div>
            <span className="ex-set-hint">The real test counts down and closes at zero</span>
          </div>
          <div className="ex-set-row">
            <span className="ex-set-label">Time allowed</span>
            <select value={limit} onChange={(e) => onLimit(Number(e.target.value))}>
              {(minutes.includes(Math.round(limit / 60)) ? minutes : [...minutes, Math.round(limit / 60)].sort((a, b) => a - b)).map((m) => (
                <option key={m} value={m * 60}>{m} minutes</option>
              ))}
            </select>
          </div>
          <div className="ex-set-row">
            <span className="ex-set-label">Clock display</span>
            <div className="ex-seg">
              <button type="button" className={!showSeconds ? 'on' : ''} onClick={() => onSeconds(false)}>Minutes</button>
              <button type="button" className={showSeconds ? 'on' : ''} onClick={() => onSeconds(true)}>Minutes and seconds</button>
            </div>
          </div>
          <div className="ex-set-row">
            <span className="ex-set-label">Clock</span>
            <label className="ex-check"><input type="checkbox" checked={hideTimer} onChange={(e) => onHideTimer(e.target.checked)} />Hide the clock</label>
          </div>
          <div className="ex-set-row">
            <span className="ex-set-label">Start screen</span>
            <label className="ex-check"><input type="checkbox" checked={!skipIntro} onChange={(e) => onSkipIntro(!e.target.checked)} />Show before each test</label>
          </div>
          <div className="ex-set-row">
            <span className="ex-set-label">Highlights</span>
            <button type="button" className="ex-link" onClick={onClearMarks} disabled={!markCount}>
              Clear highlights and notes ({markCount})
            </button>
          </div>
        </div>
        <div className="ex-dialog-foot">
          <button type="button" className="ex-btn primary" onClick={onClose} autoFocus>Close</button>
        </div>
      </div>
    </Overlay>
  )
}
