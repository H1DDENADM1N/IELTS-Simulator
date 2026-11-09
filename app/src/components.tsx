import React, { useContext, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { mediaFromRef, passageBlocks } from './lib/bank'
import { optionsFor, type Answers, type GradeItem } from './lib/grading'
import type { Group, Option, Question, Unit } from './lib/types'
import { mergeHighlights, type HighlightRange, type NoteRange } from './lib/exam'

/**
 * 关掉所有打开的下拉选项框。
 * Tab 换题、点题号跳题时调用：否则菜单会挂在新题上不消失。
 */
export const closeMenus = () => window.dispatchEvent(new Event('ex-close-menus'))

/**
 * 把键盘光标移到某一道题上。
 * - 填空 / 简答：直接聚焦输入框，光标放到末尾；
 * - 行内选词（词库）：原生 select；
 * - 选择题 / 匹配题：聚焦题块本身（tabIndex=-1），方向键在 radio 之间切换。
 */
export function focusQuestion(number: number): boolean {
  const node = document.querySelector<HTMLElement>(`[data-q="${number}"]`)
  if (!node) return false
  const field = node.matches('input, textarea')
    ? (node as HTMLInputElement | HTMLTextAreaElement)
    : node.querySelector<HTMLInputElement | HTMLTextAreaElement>('.ex-input')
  if (field && !field.disabled) {
    field.focus({ preventScroll: true })
    try {
      const end = field.value.length
      field.setSelectionRange(end, end)
    } catch {
      // type=number 等输入框不支持选区，忽略
    }
    return true
  }
  const host = node.matches('.ex-q, .ex-blank') ? node : (node.closest<HTMLElement>('.ex-q') ?? node)
  if (!host.hasAttribute('tabindex')) host.tabIndex = -1
  host.focus({ preventScroll: true })
  return true
}

export const formatTime = (seconds: number) => {
  if (!Number.isFinite(seconds) || seconds < 0) seconds = 0
  const m = Math.floor(seconds / 60)
  const s = Math.floor(seconds % 60)
  return `${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`
}

/** 听力原文里所有带时间戳的句子起点 */
const starts = (unit: Unit) =>
  (unit.transcript || [])
    .filter((l) => typeof l.start === 'number')
    .sort((a, b) => (a.start as number) - (b.start as number))
    .map((l) => l.start as number)

/** 上一句 / 下一句：按原文时间戳跳，没有时间戳时退化为 ±5 秒 */
export function jumpSentence(unit: Unit, audio: HTMLAudioElement | null, dir: -1 | 1) {
  if (!audio) return
  const marks = starts(unit)
  if (!marks.length) {
    audio.currentTime = Math.max(0, Math.min((audio.duration || 0) - 0.2, audio.currentTime + dir * 5))
    return
  }
  const t = audio.currentTime
  if (dir === 1) {
    const next = marks.find((m) => m > t + 0.35)
    audio.currentTime = next ?? Math.max(0, (audio.duration || t) - 0.2)
  } else {
    // 先回到本句开头，已经在句首时再退到上一句
    const current = [...marks].reverse().find((m) => m <= t + 0.35) ?? 0
    const prev = current <= t - 0.5 ? current : [...marks].reverse().find((m) => m < current - 0.05)
    audio.currentTime = Math.max(0, prev ?? current)
  }
}

const SpeakerIcon = () => (
  <svg viewBox="0 0 24 24" className="ex-ico" aria-hidden="true">
    <path d="M4 9.5h3.4L12 5.6v12.8L7.4 14.5H4z" fill="currentColor" />
    <path d="M15.4 8.6a5 5 0 0 1 0 6.8M17.9 6.2a8.4 8.4 0 0 1 0 11.6" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" />
  </svg>
)

export const ExamAudio: React.FC<{ unit: Unit; audioRef: React.RefObject<HTMLAudioElement | null> }> = ({
  unit,
  audioRef,
}) => {
  const src = mediaFromRef(unit.audio)
  const [playing, setPlaying] = useState(false)
  const [time, setTime] = useState(0)
  const [duration, setDuration] = useState(0)
  const [rate, setRate] = useState(1)
  const [volume, setVolume] = useState(1)
  const [failed, setFailed] = useState(false)

  useEffect(() => {
    const audio = audioRef.current
    if (!audio) return
    const sync = () => {
      setTime(audio.currentTime || 0)
      if (Number.isFinite(audio.duration) && audio.duration > 0) setDuration(audio.duration)
    }
    const onPlay = () => setPlaying(true)
    const onPause = () => setPlaying(false)
    const onEnd = () => setPlaying(false)
    const onError = () => setFailed(true)
    const onMeta = () => {
      setFailed(false)
      audio.playbackRate = rate
      audio.volume = volume
      sync()
    }
    audio.addEventListener('timeupdate', sync)
    audio.addEventListener('loadedmetadata', onMeta)
    audio.addEventListener('durationchange', onMeta)
    audio.addEventListener('play', onPlay)
    audio.addEventListener('pause', onPause)
    audio.addEventListener('ended', onEnd)
    audio.addEventListener('error', onError)
    sync()
    return () => {
      audio.removeEventListener('timeupdate', sync)
      audio.removeEventListener('loadedmetadata', onMeta)
      audio.removeEventListener('durationchange', onMeta)
      audio.removeEventListener('play', onPlay)
      audio.removeEventListener('pause', onPause)
      audio.removeEventListener('ended', onEnd)
      audio.removeEventListener('error', onError)
    }
  }, [audioRef, src]) // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    setPlaying(false)
    setTime(0)
    setDuration(0)
    setFailed(false)
  }, [src])

  if (!src) return null

  const toggle = () => {
    const audio = audioRef.current
    if (!audio) return
    if (audio.paused) void audio.play().catch(() => setFailed(true))
    else audio.pause()
  }

  const changeRate = (value: number) => {
    setRate(value)
    if (audioRef.current) audioRef.current.playbackRate = value
  }

  const changeVolume = (value: number) => {
    setVolume(value)
    if (audioRef.current) audioRef.current.volume = value
  }

  return (
    <div className="ex-audio">
      <audio ref={audioRef} src={src} preload="metadata" className="ex-audio-el" />
      <button type="button" className="ex-play" onClick={toggle} aria-label={playing ? 'Pause' : 'Play'}>
        <span className={playing ? 'ex-ico-pause' : 'ex-ico-play'} aria-hidden />
      </button>
      <div className="ex-audio-time">
        <b>{formatTime(time)}</b>
        <span>/ {formatTime(duration)}</span>
      </div>
      <input
        type="range"
        className="ex-range ex-audio-seek"
        min={0}
        max={Math.max(duration, 1)}
        step={0.1}
        value={Math.min(time, Math.max(duration, 1))}
        onChange={(e) => {
          const audio = audioRef.current
          if (!audio) return
          audio.currentTime = Number(e.target.value)
          setTime(Number(e.target.value))
        }}
        aria-label="Playback position"
      />
      <div className="ex-audio-story" role="group" aria-label="Jump by sentence">
        <button type="button" onClick={() => jumpSentence(unit, audioRef.current, -1)}>Previous sentence</button>
        <button type="button" onClick={() => jumpSentence(unit, audioRef.current, 1)}>Next sentence</button>
      </div>
      <div className="ex-rates" role="group" aria-label="Playback speed">
        {[0.75, 1, 1.25, 1.5].map((r) => (
          <button type="button" key={r} className={rate === r ? 'on' : ''} onClick={() => changeRate(r)}>
            {r}×
          </button>
        ))}
      </div>
      <label className="ex-vol" title="Volume">
        <SpeakerIcon />
        <input
          type="range"
          className="ex-range"
          min={0}
          max={1}
          step={0.05}
          value={volume}
          onChange={(e) => changeVolume(Number(e.target.value))}
          aria-label="Volume"
        />
      </label>
      {failed && <span className="ex-audio-fail">The audio file could not be played. Check that the file in data/ is complete.</span>}
    </div>
  )
}

/** 把一句话按「高亮 / 笔记」区间切成可点击片段；两种标记可以叠在同一段上 */
function renderMarked(
  text: string,
  ranges: { s: number; e: number }[] | undefined,
  notes: NoteRange[] | undefined,
  onNote: (note: NoteRange, x: number, y: number) => void,
): React.ReactNode {
  const clamp = (v: number) => Math.max(0, Math.min(text.length, v))
  const hl = (ranges || []).map((r) => ({ s: clamp(r.s), e: clamp(r.e) })).filter((r) => r.e > r.s)
  const nt = (notes || []).map((r) => ({ ...r, s: clamp(r.s), e: clamp(r.e) })).filter((r) => r.e > r.s)
  if (!hl.length && !nt.length) return text
  const points = new Set<number>([0, text.length])
  hl.forEach((r) => {
    points.add(r.s)
    points.add(r.e)
  })
  nt.forEach((r) => {
    points.add(r.s)
    points.add(r.e)
  })
  const cuts = [...points].sort((a, b) => a - b)
  const out: React.ReactNode[] = []
  for (let i = 0; i < cuts.length - 1; i++) {
    const s = cuts[i]
    const e = cuts[i + 1]
    if (e <= s) continue
    const part = text.slice(s, e)
    const marked = hl.some((r) => r.s <= s && r.e >= e)
    const note = nt.find((r) => r.s <= s && r.e >= e)
    let node: React.ReactNode = part
    if (note) {
      node = (
        <span
          className="ex-note-mark"
          key={`note-${s}`}
          title={note.text}
          onClick={(ev) => {
            ev.stopPropagation()
            const sel = window.getSelection()
            if (sel && !sel.isCollapsed) return
            onNote(note, ev.clientX, ev.clientY)
          }}
        >
          {part}
          {note.e === e && <i className="ex-note-dot" aria-hidden="true" />}
        </span>
      )
    }
    out.push(marked ? <mark className="ex-mark" key={`hl-${s}`}>{node}</mark> : node)
  }
  return out
}

type SelRange = HighlightRange
type MenuState = { ranges: SelRange[]; x: number; y: number }
type NoteDraft = {
  id: string
  ranges: { n: number; s: number; e: number }[]
  text: string
  x: number
  y: number
  isNew: boolean
}

type MenuItem = { label: string; onClick?: () => void; disabled?: boolean } | { sep: true }

/** 选中文字后的右键菜单：Highlight / Notes / Clear / Clear all，和机考一致 */
const ContextMenu: React.FC<{ x: number; y: number; items: MenuItem[]; onClose: () => void }> = ({
  x,
  y,
  items,
  onClose,
}) => {
  const ref = useRef<HTMLDivElement>(null)
  const [pos, setPos] = useState({ left: x, top: y })
  // 鼠标右键打开时不高亮任何一项，和系统右键菜单一致
  const [active, setActive] = useState(-1)

  useLayoutEffect(() => {
    const el = ref.current
    if (!el) return
    const rect = el.getBoundingClientRect()
    const pad = 8
    setPos({
      left: Math.max(pad, Math.min(x, window.innerWidth - rect.width - pad)),
      top: Math.max(pad, Math.min(y, window.innerHeight - rect.height - pad)),
    })
    el.focus({ preventScroll: true })
  }, [x, y])

  const enabled = items.map((it, i) => ('label' in it && !it.disabled ? i : -1)).filter((i) => i >= 0)
  const move = (dir: 1 | -1) => {
    if (!enabled.length) return
    const at = enabled.indexOf(active)
    if (at < 0) {
      setActive(dir === 1 ? enabled[0] : enabled[enabled.length - 1])
      return
    }
    setActive(enabled[(at + dir + enabled.length) % enabled.length])
  }
  const run = (index: number) => {
    const item = items[index]
    if (!item || 'sep' in item || item.disabled) return
    onClose()
    item.onClick?.()
  }

  return (
    <div
      className="ex-ctx"
      ref={ref}
      role="menu"
      tabIndex={-1}
      style={pos}
      onContextMenu={(e) => e.preventDefault()}
      onKeyDown={(e) => {
        e.stopPropagation()
        if (e.key === 'Escape') {
          e.preventDefault()
          onClose()
        } else if (e.key === 'ArrowDown') {
          e.preventDefault()
          move(1)
        } else if (e.key === 'ArrowUp') {
          e.preventDefault()
          move(-1)
        } else if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault()
          run(active)
        } else if (e.key === 'Tab') {
          e.preventDefault()
          onClose()
        }
      }}
    >
      {items.map((item, i) =>
        'sep' in item ? (
          <div className="ex-ctx-sep" key={`sep-${i}`} />
        ) : (
          <button
            key={item.label}
            type="button"
            role="menuitem"
            tabIndex={-1}
            disabled={item.disabled}
            className={i === active ? 'active' : ''}
            onMouseEnter={() => setActive(i)}
            onClick={() => run(i)}
          >
            {item.label}
          </button>
        ),
      )}
    </div>
  )
}

/** 写在原文上的笔记：小浮层，Enter 保存 / Shift+Enter 换行 / Esc 关掉 */
const NotePopover: React.FC<{
  x: number
  y: number
  text: string
  isNew: boolean
  onChange: (value: string) => void
  onSave: () => void
  onDelete: () => void
  onClose: () => void
}> = ({ x, y, text, isNew, onChange, onSave, onDelete, onClose }) => {
  const ref = useRef<HTMLDivElement>(null)
  const dragRef = useRef<{ dx: number; dy: number } | null>(null)
  const [pos, setPos] = useState({ left: x, top: y })

  useLayoutEffect(() => {
    const el = ref.current
    if (!el) return
    const rect = el.getBoundingClientRect()
    const pad = 8
    setPos({
      left: Math.max(pad, Math.min(x, window.innerWidth - rect.width - pad)),
      top: Math.max(pad, Math.min(y, window.innerHeight - rect.height - pad)),
    })
  }, [x, y])

  // 官方便签可以拖着走：按住顶部黄色把手拖动
  const onDragStart = (e: React.PointerEvent<HTMLDivElement>) => {
    const el = ref.current
    if (!el) return
    const rect = el.getBoundingClientRect()
    dragRef.current = { dx: e.clientX - rect.left, dy: e.clientY - rect.top }
    e.currentTarget.setPointerCapture(e.pointerId)
  }
  const onDragMove = (e: React.PointerEvent<HTMLDivElement>) => {
    const drag = dragRef.current
    if (!drag) return
    setPos({
      left: Math.max(4, Math.min(e.clientX - drag.dx, window.innerWidth - 48)),
      top: Math.max(4, Math.min(e.clientY - drag.dy, window.innerHeight - 32)),
    })
  }
  const onDragEnd = () => {
    dragRef.current = null
  }

  return (
    <div
      className="ex-note-pop"
      ref={ref}
      style={pos}
      onContextMenu={(e) => e.preventDefault()}
      onKeyDown={(e) => e.stopPropagation()}
    >
      <div
        className="ex-note-head"
        onPointerDown={onDragStart}
        onPointerMove={onDragMove}
        onPointerUp={onDragEnd}
        onPointerCancel={onDragEnd}
      >
        <span>{isNew ? 'Add note' : 'Note'}</span>
        <button
          type="button"
          className="ex-note-close"
          aria-label="Close"
          onPointerDown={(e) => e.stopPropagation()}
          onClick={onClose}
        >
          ×
        </button>
      </div>
      <textarea
        value={text}
        autoFocus
        spellCheck={false}
        placeholder="Add a note on this text…"
        onChange={(e) => onChange(e.target.value)}
        onKeyDown={(e) => {
          e.stopPropagation()
          if (e.key === 'Escape') {
            e.preventDefault()
            onClose()
          } else if (e.key === 'Enter' && !e.shiftKey) {
            e.preventDefault()
            onSave()
          }
        }}
      />
      <div className="ex-note-foot">
        <span className="ex-note-hint">Enter to save</span>
        <div className="ex-note-actions">
          {!isNew && (
            <button type="button" className="ex-note-del" onClick={onDelete}>
              Delete
            </button>
          )}
          <button type="button" onClick={onClose}>
            Cancel
          </button>
          <button type="button" className="ex-note-save" onClick={onSave} disabled={!text.trim()}>
            Save
          </button>
        </div>
      </div>
    </div>
  )
}

const newNoteId = () => `n${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`

/** 弹层挂在机考外壳里，才能继承四种卷面配色的 CSS 变量（挂 body 会变成透明底） */
const portalHost = () => document.querySelector<HTMLElement>('.exam-shell') ?? document.body

/** 把当前选区换算成「句子号 + 字符区间」 */
function selectionRanges(root: HTMLElement): HighlightRange[] {
  const sel = window.getSelection()
  if (!sel || sel.isCollapsed || !sel.rangeCount) return []
  const range = sel.getRangeAt(0)
  if (!root.contains(range.commonAncestorContainer)) return []
  const out: HighlightRange[] = []
  root.querySelectorAll<HTMLElement>('[data-sn]').forEach((span) => {
    const text = span.textContent || ''
    if (!text) return
    const whole = document.createRange()
    whole.selectNodeContents(span)
    // 与整句不相交就跳过：选区结束不晚于句首，或选区开始不早于句尾
    if (range.compareBoundaryPoints(Range.START_TO_END, whole) <= 0) return
    if (range.compareBoundaryPoints(Range.END_TO_START, whole) >= 0) return
    const inter = document.createRange()
    if (range.compareBoundaryPoints(Range.START_TO_START, whole) > 0) inter.setStart(range.startContainer, range.startOffset)
    else inter.setStart(whole.startContainer, whole.startOffset)
    if (range.compareBoundaryPoints(Range.END_TO_END, whole) < 0) inter.setEnd(range.endContainer, range.endOffset)
    else inter.setEnd(whole.endContainer, whole.endOffset)
    const pre = document.createRange()
    pre.selectNodeContents(span)
    pre.setEnd(inter.startContainer, inter.startOffset)
    const s = pre.toString().length
    const mid = document.createRange()
    mid.selectNodeContents(span)
    mid.setEnd(inter.endContainer, inter.endOffset)
    const e = mid.toString().length
    if (e > s) out.push({ n: Number(span.dataset.sn), s, e })
  })
  return out
}

/** 从现有高亮里挖掉一段选区 */
function subtractMarks(marks: HighlightRange[], removes: HighlightRange[]): HighlightRange[] {
  let result = marks.map((m) => ({ ...m }))
  removes.forEach((cut) => {
    const next: HighlightRange[] = []
    result.forEach((m) => {
      if (m.n !== cut.n || cut.e <= m.s || cut.s >= m.e) {
        next.push(m)
        return
      }
      if (cut.s > m.s) next.push({ n: m.n, s: m.s, e: Math.min(cut.s, m.e) })
      if (cut.e < m.e) next.push({ n: m.n, s: Math.max(cut.e, m.s), e: m.e })
    })
    result = next
  })
  return result.filter((m) => m.e > m.s)
}

/* ------------------------------------------------------------------
 * 题目区的高亮 / 笔记
 * 官方机考里题干、选项、说明、笔记式填空的正文都能划词高亮、写笔记
 * （右键 Highlight / Notes / Clear / Clear all），听力一样能划。
 * 做法：给每块可划词文本分配一个「合成行号」，复用原文那套 {n, s, e} 存储。
 * 真实行号从 1 起，合成行号从 1_000_000 起，互不相撞。
 * ------------------------------------------------------------------ */

export const SLOT_BASE = 1_000_000
const TEXT_BASE = 2_000_000

const promptSlot = (n: number) => SLOT_BASE + n * 10 + 1
const optionSlot = (n: number, i: number) => SLOT_BASE + n * 10 + 2 + i
const instructionsSlot = (first: number) => SLOT_BASE + first * 10
const contentSlot = (first: number, i: number) => TEXT_BASE + first * 100 + i

/** 笔记面板里给一条标注一个可读的位置：原文是 Line 12，题目区是 Question 12 */
export const slotLabel = (n: number) => {
  if (n >= TEXT_BASE) return 'Question text'
  if (n >= SLOT_BASE) {
    const q = Math.floor((n - SLOT_BASE) / 10)
    return q ? `Question ${q}` : 'Instructions'
  }
  return `Line ${n}`
}

type AnnoApi = {
  openNote: (note: NoteRange, x: number, y: number) => void
  rangesOf: (n: number) => { s: number; e: number }[] | undefined
  notesOf: (n: number) => NoteRange[] | undefined
}

const AnnoContext = React.createContext<AnnoApi | null>(null)

/** 可划词的文本块：外层 span 带 data-sn，里面是拆好的高亮 / 笔记切片 */
const AnnoText: React.FC<{ text: string; slot: number; className?: string }> = ({ text, slot, className }) => {
  const anno = useContext(AnnoContext)
  if (!anno) return <span className={className}>{text}</span>
  return (
    <span className={className} data-sn={slot}>
      {renderMarked(text, anno.rangesOf(slot), anno.notesOf(slot), anno.openNote)}
    </span>
  )
}

/**
 * 题目区的标注层：右键菜单 + 笔记便签。
 * 数据与原文共用同一份 marks / notes（都按 unit 存盘）。
 */
export const AnnotationArea: React.FC<{
  marks: HighlightRange[]
  onMarks: (next: HighlightRange[]) => void
  notes: NoteRange[]
  onNotes: (next: NoteRange[]) => void
  children: React.ReactNode
}> = ({ marks, onMarks, notes, onNotes, children }) => {
  const rootRef = useRef<HTMLDivElement>(null)
  const [menu, setMenu] = useState<MenuState | null>(null)
  const [draft, setDraft] = useState<NoteDraft | null>(null)

  const rangesByN = useMemo(() => {
    const map = new Map<number, { s: number; e: number }[]>()
    marks.forEach((m) => {
      const bucket = map.get(m.n) || []
      bucket.push({ s: m.s, e: m.e })
      map.set(m.n, bucket)
    })
    return map
  }, [marks])

  const notesByN = useMemo(() => {
    const map = new Map<number, NoteRange[]>()
    notes.forEach((n) => {
      const bucket = map.get(n.n) || []
      bucket.push(n)
      map.set(n.n, bucket)
    })
    return map
  }, [notes])

  // 点空白处关掉右键菜单和笔记框
  useEffect(() => {
    const onDown = (e: MouseEvent) => {
      const target = e.target as HTMLElement | null
      if (target?.closest('.ex-ctx') || target?.closest('.ex-note-pop')) return
      setMenu(null)
      setDraft(null)
    }
    document.addEventListener('mousedown', onDown)
    return () => document.removeEventListener('mousedown', onDown)
  }, [])

  // 题目滚动时菜单跟着消失（笔记框留着）
  useEffect(() => {
    const scroller = rootRef.current?.closest('.ex-scroll')
    const hide = () => setMenu(null)
    scroller?.addEventListener('scroll', hide, { passive: true })
    window.addEventListener('resize', hide)
    return () => {
      scroller?.removeEventListener('scroll', hide)
      window.removeEventListener('resize', hide)
    }
  }, [])

  const onContextMenu = (e: React.MouseEvent) => {
    e.preventDefault()
    const root = rootRef.current
    if (!root) return
    const ranges = selectionRanges(root)
    if (!ranges.length) {
      setMenu(null)
      return
    }
    setDraft(null)
    setMenu({ ranges, x: e.clientX, y: e.clientY })
  }

  const overlapOf = (ranges: SelRange[]) =>
    ranges.some((r) => marks.some((m) => m.n === r.n && m.s < r.e && m.e > r.s))
  const noteOverlap = (ranges: SelRange[]) =>
    notes.filter((n) => ranges.some((r) => r.n === n.n && n.s < r.e && n.e > r.s))

  const addHighlight = () => {
    if (!menu) return
    onMarks(mergeHighlights([...marks, ...menu.ranges]))
    window.getSelection()?.removeAllRanges()
    setMenu(null)
  }

  const startNote = () => {
    if (!menu) return
    const hit = noteOverlap(menu.ranges)[0]
    if (hit) {
      setDraft({
        id: hit.id,
        ranges: notes.filter((n) => n.id === hit.id).map(({ n, s, e }) => ({ n, s, e })),
        text: hit.text,
        x: menu.x,
        y: menu.y,
        isNew: false,
      })
    } else {
      setDraft({
        id: newNoteId(),
        ranges: menu.ranges.map(({ n, s, e }) => ({ n, s, e })),
        text: '',
        x: menu.x,
        y: menu.y,
        isNew: true,
      })
    }
    window.getSelection()?.removeAllRanges()
    setMenu(null)
  }

  const clearInSelection = () => {
    if (!menu) return
    onMarks(mergeHighlights(subtractMarks(marks, menu.ranges)))
    const hitIds = new Set(noteOverlap(menu.ranges).map((n) => n.id))
    if (hitIds.size) onNotes(notes.filter((n) => !hitIds.has(n.id)))
    window.getSelection()?.removeAllRanges()
    setMenu(null)
  }

  const clearAll = () => {
    onMarks([])
    onNotes([])
    setMenu(null)
  }

  const openNote = (note: NoteRange, x: number, y: number) => {
    setMenu(null)
    setDraft({
      id: note.id,
      ranges: notes.filter((n) => n.id === note.id).map(({ n, s, e }) => ({ n, s, e })),
      text: note.text,
      x,
      y,
      isNew: false,
    })
  }

  const saveNote = () => {
    if (!draft) return
    const text = draft.text.trim()
    if (!text) {
      onNotes(notes.filter((n) => n.id !== draft.id))
      setDraft(null)
      return
    }
    const next: NoteRange[] = notes.filter((n) => n.id !== draft.id)
    draft.ranges.forEach((r) => next.push({ id: draft.id, n: r.n, s: r.s, e: r.e, text }))
    onNotes(next)
    setDraft(null)
  }

  const deleteNote = () => {
    if (!draft) return
    onNotes(notes.filter((n) => n.id !== draft.id))
    setDraft(null)
  }

  const api = useMemo<AnnoApi>(
    () => ({
      openNote,
      rangesOf: (n) => rangesByN.get(n),
      notesOf: (n) => notesByN.get(n),
    }),
    // openNote 只依赖 notes / setDraft，两个都在下面的依赖里
    [rangesByN, notesByN, notes],
  )

  return (
    <div ref={rootRef} style={{ display: 'contents' }} onContextMenu={onContextMenu}>
      <AnnoContext.Provider value={api}>{children}</AnnoContext.Provider>

      {menu &&
        createPortal(
          <ContextMenu
            x={menu.x}
            y={menu.y}
            onClose={() => setMenu(null)}
            items={[
              { label: 'Highlight', onClick: addHighlight },
              { label: 'Notes', onClick: startNote },
              { sep: true },
              { label: 'Clear', disabled: !overlapOf(menu.ranges), onClick: clearInSelection },
              { label: 'Clear all', disabled: !marks.length && !notes.length, onClick: clearAll },
            ]}
          />,
          portalHost(),
        )}

      {draft &&
        createPortal(
          <NotePopover
            x={draft.x}
            y={draft.y}
            text={draft.text}
            isNew={draft.isNew}
            onChange={(text) => setDraft((prev) => (prev ? { ...prev, text } : prev))}
            onSave={saveNote}
            onDelete={deleteNote}
            onClose={() => setDraft(null)}
          />,
          portalHost(),
        )}
    </div>
  )
}

export const SourcePanel: React.FC<{
  unit: Unit
  /** 交卷后「在原文中定位」的句子号 */
  evidence: Set<number>
  onSeek?: (n: number) => void
  showTranslation?: boolean
  activeLine?: number | null
  marks: HighlightRange[]
  onMarks: (next: HighlightRange[]) => void
  notes: NoteRange[]
  onNotes: (next: NoteRange[]) => void
}> = ({ unit, evidence, onSeek, showTranslation, activeLine, marks, onMarks, notes, onNotes }) => {
  const blocks = passageBlocks(unit)
  const rootRef = useRef<HTMLDivElement>(null)
  const [menu, setMenu] = useState<MenuState | null>(null)
  const [draft, setDraft] = useState<NoteDraft | null>(null)
  const leftover = useMemo(() => {
    const used = new Set(blocks.map((b) => b.translation).filter(Boolean) as string[])
    return (unit.transcriptTranslations || []).filter((t) => !used.has(t))
  }, [blocks, unit])
  const byN = useMemo(() => {
    const map = new Map<number, { s: number; e: number }[]>()
    marks.forEach((m) => {
      const bucket = map.get(m.n) || []
      bucket.push({ s: m.s, e: m.e })
      map.set(m.n, bucket)
    })
    return map
  }, [marks])
  const notesByN = useMemo(() => {
    const map = new Map<number, NoteRange[]>()
    notes.forEach((n) => {
      const bucket = map.get(n.n) || []
      bucket.push(n)
      map.set(n.n, bucket)
    })
    return map
  }, [notes])

  // 点空白处关掉右键菜单和笔记框
  useEffect(() => {
    const onDown = (e: MouseEvent) => {
      const target = e.target as HTMLElement | null
      if (target?.closest('.ex-ctx') || target?.closest('.ex-note-pop')) return
      setMenu(null)
      setDraft(null)
    }
    document.addEventListener('mousedown', onDown)
    return () => document.removeEventListener('mousedown', onDown)
  }, [])

  // 原文滚动时菜单跟着消失（笔记框留着，别把正在写的内容抖掉）
  useEffect(() => {
    const scroller = rootRef.current?.closest('.ex-scroll')
    const hide = () => setMenu(null)
    scroller?.addEventListener('scroll', hide, { passive: true })
    window.addEventListener('resize', hide)
    return () => {
      scroller?.removeEventListener('scroll', hide)
      window.removeEventListener('resize', hide)
    }
  }, [])

  const isL = unit.module === 'listening'
  if (!blocks.length) return <div className="ex-empty">No passage is attached to this exercise.</div>

  /** 真实机考：选中文字后右键弹出 Highlight / Notes / Clear / Clear all */
  const onContextMenu = (e: React.MouseEvent) => {
    e.preventDefault()
    const root = rootRef.current
    if (!root) return
    const ranges = selectionRanges(root)
    if (!ranges.length) {
      setMenu(null)
      return
    }
    setDraft(null)
    setMenu({ ranges, x: e.clientX, y: e.clientY })
  }

  const overlapOf = (ranges: SelRange[]) =>
    ranges.some((r) => marks.some((m) => m.n === r.n && m.s < r.e && m.e > r.s))
  const noteOverlap = (ranges: SelRange[]) =>
    notes.filter((n) => ranges.some((r) => r.n === n.n && n.s < r.e && n.e > r.s))

  const addHighlight = () => {
    if (!menu) return
    onMarks(mergeHighlights([...marks, ...menu.ranges]))
    window.getSelection()?.removeAllRanges()
    setMenu(null)
  }

  const startNote = () => {
    if (!menu) return
    const hit = noteOverlap(menu.ranges)[0]
    if (hit) {
      const group = notes.filter((n) => n.id === hit.id)
      setDraft({
        id: hit.id,
        ranges: group.map(({ n, s, e }) => ({ n, s, e })),
        text: hit.text,
        x: menu.x,
        y: menu.y,
        isNew: false,
      })
    } else {
      setDraft({
        id: newNoteId(),
        ranges: menu.ranges.map(({ n, s, e }) => ({ n, s, e })),
        text: '',
        x: menu.x,
        y: menu.y,
        isNew: true,
      })
    }
    window.getSelection()?.removeAllRanges()
    setMenu(null)
  }

  const clearInSelection = () => {
    if (!menu) return
    onMarks(mergeHighlights(subtractMarks(marks, menu.ranges)))
    const hitIds = new Set(noteOverlap(menu.ranges).map((n) => n.id))
    if (hitIds.size) onNotes(notes.filter((n) => !hitIds.has(n.id)))
    window.getSelection()?.removeAllRanges()
    setMenu(null)
  }

  const clearAll = () => {
    onMarks([])
    onNotes([])
    setMenu(null)
  }

  const openNote = (note: NoteRange, x: number, y: number) => {
    const group = notes.filter((n) => n.id === note.id)
    setMenu(null)
    setDraft({
      id: note.id,
      ranges: group.map(({ n, s, e }) => ({ n, s, e })),
      text: note.text,
      x,
      y,
      isNew: false,
    })
  }

  const saveNote = () => {
    if (!draft) return
    const text = draft.text.trim()
    if (!text) {
      onNotes(notes.filter((n) => n.id !== draft.id))
      setDraft(null)
      return
    }
    const next: NoteRange[] = notes.filter((n) => n.id !== draft.id)
    draft.ranges.forEach((r) => next.push({ id: draft.id, n: r.n, s: r.s, e: r.e, text }))
    onNotes(next)
    setDraft(null)
  }

  const deleteNote = () => {
    if (!draft) return
    onNotes(notes.filter((n) => n.id !== draft.id))
    setDraft(null)
  }

  return (
    <div className="ex-source" ref={rootRef}>
      {!isL && (
        <header className="ex-passage-head">
          <div className="ex-passage-kicker">Reading Passage {unit.part ?? ''}</div>
          <h1 className="ex-passage-title">{unit.title}</h1>
        </header>
      )}
      <div className="ex-passage" onContextMenu={onContextMenu}>
        {blocks.map((block, i) => (
          <div className={'ex-para' + (i > 0 ? ' ex-para-next' : '')} key={`${block.lines[0]?.n}-${i}`}>
            {block.lines.map((line, li) => (
              <React.Fragment key={`${line.n}-${li}`}>
                {li === 0 && block.label && <b className="ex-para-label">{block.label}</b>}
                {li === 0 && block.label ? ' ' : null}
                <span
                  className={
                    'ex-sentence' +
                    (evidence.has(line.n) ? ' sentence-hit' : '') +
                    (activeLine === line.n ? ' sentence-live' : '')
                  }
                  data-sn={line.n}
                  onClick={() => {
                    const sel = window.getSelection()
                    if (sel && !sel.isCollapsed) return
                    onSeek?.(line.n)
                  }}
                >
                  {renderMarked(line.text, byN.get(line.n), notesByN.get(line.n), openNote)}
                </span>{' '}
              </React.Fragment>
            ))}
            {showTranslation && block.translation && <p className="ex-trans">{block.translation}</p>}
          </div>
        ))}
      </div>
      {showTranslation && leftover.length > 0 && (
        <div className="ex-trans-block">
          <div className="ex-trans-title">Translation</div>
          {leftover.map((t, i) => (
            <p key={i}>{t}</p>
          ))}
        </div>
      )}

      {menu &&
        createPortal(
          <ContextMenu
            x={menu.x}
            y={menu.y}
            onClose={() => setMenu(null)}
            items={[
              { label: 'Highlight', onClick: addHighlight },
              { label: 'Notes', onClick: startNote },
              { sep: true },
              { label: 'Clear', disabled: !overlapOf(menu.ranges), onClick: clearInSelection },
              { label: 'Clear all', disabled: !marks.length && !notes.length, onClick: clearAll },
            ]}
          />,
          portalHost(),
        )}

      {draft &&
        createPortal(
          <NotePopover
            x={draft.x}
            y={draft.y}
            text={draft.text}
            isNew={draft.isNew}
            onChange={(text) => setDraft((prev) => (prev ? { ...prev, text } : prev))}
            onSave={saveNote}
            onDelete={deleteNote}
            onClose={() => setDraft(null)}
          />,
          portalHost(),
        )}
    </div>
  )
}

/** 组内解析是否直接嵌在 content 的 {{n}} 占位符里 */
export const hasInlineBlanks = (group: Group) => /\{\{\d+\}\}/.test(group.content || '')

const answerText = (expected?: string) => (expected || '').split(/\r?\n/).map((s) => s.trim()).filter(Boolean).join(' / ')

const promptOf = (q: Question) => {
  const text = (q.prompt || '').trim()
  if (!text) return ''
  return text === String(q.number) ? '' : text
}

const Explain: React.FC<{
  item: GradeItem
  onLocate: (evidence?: string | null) => void
}> = ({ item, onLocate }) => (
  <div className="ex-explain">
    <div className="ex-explain-row">
      <span className="ex-tag">Correct answer</span>
      <span className="ex-answer">{answerText(item.expected)}</span>
      {item.evidence && (
        <button type="button" className="ex-link" onClick={() => onLocate(item.evidence)}>
          Locate in the passage
        </button>
      )}
    </div>
    {item.quote && <p className="ex-quote">Passage: {item.quote}</p>}
    {item.explanation && <p>{item.explanation}</p>}
    {item.tip && <p className="ex-tip">Common mistake: {item.tip}</p>}
  </div>
)

const countValue = (value?: string | string[]) =>
  Array.isArray(value) ? (value.length ? 1 : 0) : value && value.trim() ? 1 : 0

/** 官方机考填空框按答案长度定宽；未交卷时没有 expected，退回 7ch */
const blankWidth = (item?: GradeItem) => {
  const longest = (item?.expected || '')
    .split(/\r?\n/)
    .map((s) => s.trim())
    .filter(Boolean)
    .sort((a, b) => b.length - a.length)[0]
  return `${Math.max(7, Math.min(20, (longest?.length || 0) + 2))}ch`
}

const blankState = (item: GradeItem | undefined, submitted: boolean) =>
  submitted && item ? (item.correct >= item.max ? ' is-ok' : ' is-bad') : ''

/** 行内填空（group.content 里的 {{n}}）：原生 2px inset 方框 */
const TextBlank: React.FC<{
  number: number
  value: string
  submitted: boolean
  item?: GradeItem
  onChange: (v: string) => void
  onActive?: (n: number) => void
  showNo?: boolean
}> = ({ number, value, submitted, item, onChange, onActive, showNo = true }) => {
  const ok = item ? item.correct >= item.max : false
  const expected = answerText(item?.expected)
  return (
    <>
      <input
        className={'blank-input' + blankState(item, submitted)}
        id={`q-${number}`}
        data-q={number}
        type="text"
        value={value}
        disabled={submitted}
        placeholder={showNo ? String(number) : ''}
        style={item ? { width: blankWidth(item) } : undefined}
        autoComplete="off"
        spellCheck={false}
        aria-label={`Answer ${number}`}
        onChange={(e) => onChange(e.target.value)}
        onFocus={() => onActive?.(number)}
      />
      {submitted && !ok && expected && <span className="ex-blank-fix">{expected}</span>}
    </>
  )
}

/** 行内选词（标题库 / 段落库 / 词库）：原生 select */
const SelectBlank: React.FC<{
  number: number
  value?: string
  options: Option[]
  submitted: boolean
  item?: GradeItem
  onChange: (v: string) => void
  onActive?: (n: number) => void
  showNo?: boolean
}> = ({ number, value, options, submitted, item, onChange, onActive, showNo = true }) => {
  const ok = item ? item.correct >= item.max : false
  const expected = answerText(item?.expected)
  return (
    <>
      <select
        className="answer"
        id={`q-${number}`}
        data-q={number}
        tabIndex={0}
        value={typeof value === 'string' ? value : ''}
        disabled={submitted}
        aria-label={`Answer ${number}`}
        onChange={(e) => onChange(e.target.value)}
        onFocus={() => onActive?.(number)}
      >
        <option value="">{showNo ? String(number) : ''}</option>
        {options.map((o) => (
          <option key={o.key} value={o.key}>{`${o.key}  ${o.text}`}</option>
        ))}
      </select>
      {submitted && !ok && expected && <span className="ex-blank-fix">{expected}</span>}
    </>
  )
}

export const QuestionBlock: React.FC<{
  q: Question
  group: Group
  unit: Unit
  value?: string | string[]
  onChange: (v: string | string[]) => void
  item?: GradeItem
  submitted: boolean
  onLocate: (evidence?: string | null) => void
  onActive?: (n: number) => void
  active?: boolean
}> = ({ q, group, unit, value, onChange, item, submitted, onLocate, onActive, active }) => {
  const options = q.options?.length ? q.options : optionsFor(group, unit)
  const multi = group.type === 'multi_choice'
  // 官方机考：匹配题、带选项的填空题一律是 radio 列表（不是下拉），选项来自题组词库
  const showOptions = options.length > 0
  const showText = !showOptions
  // 信息匹配：官方只给段落字母，题干已写明 "Write the correct letter A-G"
  // 信息匹配 / 特征匹配：官方只给字母（段落字母、人名字母），横向排一排按钮
  const lettersOnly = group.type === 'matching_information' || group.type === 'matching_features'
  const selected = Array.isArray(value) ? value : value ? [value] : []
  const ok = item ? item.correct >= item.max : false
  const missed = submitted && !countValue(value)
  const prompt = promptOf(q)
  const answerKeys = (item?.expected || '')
    .split(/\r?\n/)
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean)
  const isAnswer = (key: string) => answerKeys.includes(key.trim().toLowerCase())
  const marked = submitted && !!item && item.max > 1 ? ` ${item.correct}/${item.max}` : ''

  const toggle = (key: string) => {
    if (!multi) {
      onChange(key)
      return
    }
    const next = selected.includes(key) ? selected.filter((x) => x !== key) : [...selected, key]
    onChange(next)
  }

  const mark = submitted ? (
    <span className={'q-mark ' + (ok ? 'mark-ok' : 'mark-bad')}>
      {ok ? '✓' : '✗'}
      {marked}
    </span>
  ) : null

  const textField = (
    <input
      className="answer blank-input ex-input"
      type="text"
      value={typeof value === 'string' ? value : ''}
      disabled={submitted}
      placeholder={String(q.number)}
      style={item ? { width: blankWidth(item) } : undefined}
      autoComplete="off"
      spellCheck={false}
      aria-label={`Answer ${q.number}`}
      onChange={(e) => onChange(e.target.value)}
    />
  )

  // 无选项也无 prompt：独立作答行（少见，多为题库里没有占位符的填空题）
  const bareRow = showText && !prompt

  return (
    <div
      className={'question' + (submitted ? (ok ? ' is-ok' : ' is-bad') : '') + (missed ? ' is-miss' : '')}
      id={`q-${q.number}`}
      data-q={q.number}
      tabIndex={-1}
      onFocus={() => onActive?.(q.number)}
    >
      <div className={'question-text' + (active ? ' highlight' : '')}>
        {bareRow ? (
          <div className="ex-text-row">{textField}</div>
        ) : (
          <>
            {!showText && <span className="q-number">{q.number}</span>}
            <span className="question-prompt">
              <AnnoText text={prompt} slot={promptSlot(q.number)} />
              {showText && prompt ? <>{' '}{textField}</> : null}
            </span>
          </>
        )}
        {mark}
      </div>

      {showOptions && (
        <ul className={lettersOnly ? 'answers letters' : 'answers'}>
          {options.map((o, oi) => {
            const on = selected.includes(o.key)
            const correct = submitted && isAnswer(o.key)
            const wrong = submitted && on && !isAnswer(o.key)
            return (
              <li key={o.key}>
                <label>
                  <input
                    className="answer"
                    type={multi ? 'checkbox' : 'radio'}
                    name={`answer-${q.number}`}
                    checked={on}
                    disabled={submitted}
                    onChange={() => toggle(o.key)}
                  />
                  <span className={'answer-text' + (correct ? ' is-correct' : '') + (wrong ? ' is-wrong' : '')}>
                    <AnnoText text={lettersOnly ? o.key : o.text} slot={optionSlot(q.number, oi)} />
                  </span>
                </label>
              </li>
            )
          })}
        </ul>
      )}

      {submitted && item && <Explain item={item} onLocate={onLocate} />}
    </div>
  )
}

const InlineReview: React.FC<{
  questions: Question[]
  items: Map<number, GradeItem>
  onLocate: (evidence?: string | null) => void
}> = ({ questions, items, onLocate }) => {
  const wrong = questions.filter((q) => {
    const item = items.get(q.number)
    return item ? item.correct < item.max : false
  })
  if (!wrong.length) return <div className="ex-inline-review is-ok">All answers correct — no review needed.</div>
  return (
    <div className="ex-inline-review">
      <div className="ex-inline-head">{`Review · ${wrong.length} incorrect`}</div>
      {wrong.map((q) => {
        const item = items.get(q.number)
        if (!item) return null
        return (
          <div className="ex-inline-item" key={q.number}>
            <div className="ex-explain-row">
              <span className="q-number">{q.number}</span>
              <span className="ex-tag">Correct answer</span>
              <span className="ex-answer">{answerText(item.expected)}</span>
              {item.evidence && (
                <button type="button" className="ex-link" onClick={() => onLocate(item.evidence)}>
                  Locate in the passage
                </button>
              )}
            </div>
            {item.quote && <p className="ex-quote">Passage: {item.quote}</p>}
            {item.explanation && <p>{item.explanation}</p>}
            {item.tip && <p className="ex-tip">Common mistake: {item.tip}</p>}
          </div>
        )
      })}
    </div>
  )
}

export const GroupBlock: React.FC<{
  group: Group
  unit: Unit
  answers: Answers
  setAnswer: (n: number, v: string | string[]) => void
  items: Map<number, GradeItem>
  submitted: boolean
  onLocate: (evidence?: string | null) => void
  onActive?: (n: number) => void
  active?: number | null
}> = ({ group, unit, answers, setAnswer, items, submitted, onLocate, onActive, active }) => {
  const anno = useContext(AnnoContext)
  const img = mediaFromRef(group.image)
  const inline = hasInlineBlanks(group)
  const inlined = new Set<number>()
  if (inline) {
    for (const m of (group.content || '').matchAll(/\{\{(\d+)\}\}/g)) inlined.add(Number(m[1]))
  }
  const rest = (group.questions || []).filter((q) => !inlined.has(q.number))
  const type = group.type
  const banked =
    !!group.options?.length &&
    (type === 'completion' || type.startsWith('matching_') || type === 'labelling') &&
    type !== 'matching_information'
  const bank = banked ? group.options || [] : []
  const bankTitle =
    type === 'matching_headings'
      ? 'List of Headings'
      : type === 'matching_features'
        ? 'List of Features'
        : type === 'matching_endings'
          ? 'List of Endings'
          : 'Options'

  const questions = group.questions || []
  const first = questions[0]
  const last = questions[questions.length - 1]
  const from = first?.number
  const to = last ? last.number + Math.max(last.span || 1, 1) - 1 : undefined
  const title = from == null || to == null ? '' : from === to ? `Question ${from}` : `Questions ${from} - ${to}`
  // 官方两列只用于听力单选；窄屏由 exam.css 的 992px 断点收成一列
  const twoCols = unit.module === 'listening' && type === 'single_choice' && rest.length > 1

  return (
    <section className="exercise" data-q-first={from}>
      {title && <p className="exercise-title">{title}</p>}
      {group.instructions && (
        <p className="instructions">
          <AnnoText text={group.instructions} slot={instructionsSlot(from ?? 0)} />
        </p>
      )}
      {bank.length > 0 && (
        <div className="answer-bank">
          <p className="answer-bank-title">{bankTitle}</p>
          <ul>
            {bank.map((o) => (
              <li key={o.key}>
                <b>{o.key}</b>
                <span>{o.text}</span>
              </li>
            ))}
          </ul>
        </div>
      )}
      {inline ? (
        <div className="inline-blanks ex-notes">
          {renderNotes(group.content || '', group, answers, setAnswer, submitted, items, onActive, anno)}
        </div>
      ) : (
        group.content && <div className="ex-group-content">{group.content}</div>
      )}
      {img && (
        <figure className="ex-figure">
          <img src={img} alt="Question illustration" />
        </figure>
      )}
      {rest.length > 0 && (
        <div className={'questions' + (twoCols ? ' cols-2' : '')}>
          {rest.map((q) => (
            <QuestionBlock
              key={q.number}
              q={q}
              group={group}
              unit={unit}
              value={answers[q.number]}
              onChange={(v) => setAnswer(q.number, v)}
              item={items.get(q.number)}
              submitted={submitted}
              onLocate={onLocate}
              onActive={onActive}
              active={active === q.number}
            />
          ))}
        </div>
      )}
      {submitted && inline && (
        <InlineReview
          questions={(group.questions || []).filter((q) => inlined.has(q.number))}
          items={items}
          onLocate={onLocate}
        />
      )}
    </section>
  )
}

function renderNotes(
  content: string,
  group: Group,
  answers: Answers,
  setAnswer: (n: number, v: string | string[]) => void,
  submitted: boolean,
  items: Map<number, GradeItem>,
  onActive?: (n: number) => void,
  anno?: AnnoApi | null,
): React.ReactNode[] {
  const known = new Set((group.questions || []).map((q) => q.number))
  const first = group.questions?.[0]?.number ?? 0
  const out: React.ReactNode[] = []
  let last = 0
  let seg = 0
  const bank = group.options?.length ? group.options : null

  /** 一大段正文（空档之间那截）：包成可划词的 span，交给 AnnoText 那套渲染 */
  const prose = (text: string) => {
    if (!text) return null
    const slot = contentSlot(first, seg++)
    if (!anno) return <React.Fragment key={`seg-${slot}`}>{text}</React.Fragment>
    return (
      <span key={`seg-${slot}`} data-sn={slot}>
        {renderMarked(text, anno.rangesOf(slot), anno.notesOf(slot), anno.openNote)}
      </span>
    )
  }

  for (const match of content.matchAll(/\{\{(\d+)\}\}/g)) {
    const index = match.index ?? 0
    if (index > last) out.push(prose(content.slice(last, index)))
    const number = Number(match[1])
    if (!known.has(number)) {
      out.push(match[0])
    } else {
      const value = answers[number]
      const text = typeof value === 'string' ? value : Array.isArray(value) ? value.join(', ') : ''
      // 题面本身已经把题号写在空前面（如「15 Playtime Tea ___」）时不再重复标号
      const before = content.slice(Math.max(0, index - 32), index)
      const showNo = !new RegExp(`(^|[^0-9])${number}([^0-9]|$)`).test(before)
      out.push(
        bank ? (
          <SelectBlank
            key={number}
            number={number}
            value={text}
            options={bank}
            submitted={submitted}
            item={items.get(number)}
            onChange={(v) => setAnswer(number, v)}
            onActive={onActive}
            showNo={showNo}
          />
        ) : (
          <TextBlank
            key={number}
            number={number}
            value={text}
            submitted={submitted}
            item={items.get(number)}
            onChange={(v) => setAnswer(number, v)}
            onActive={onActive}
            showNo={showNo}
          />
        ),
      )
    }
    last = index + match[0].length
  }
  if (last < content.length) out.push(prose(content.slice(last)))
  return out
}


export const ResultBar: React.FC<{ score: number; total: number; seconds: number; wrong: number }> = ({
  score,
  total,
  seconds,
  wrong,
}) => {
  const pct = total ? Math.round((score / total) * 100) : 0
  return (
    <div className="result-bar ex-result">
      <div className="ex-result-main">
        <b>{score}</b>
        <span>/ {total}</span>
        <em>{pct}%</em>
      </div>
      <div className="ex-result-meta">
        <span>{wrong} wrong</span>
        <span>Time used {formatTime(seconds)}</span>
      </div>
    </div>
  )
}
