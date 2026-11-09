import React, { useMemo, useState } from 'react'
import { getMockEntries, getMockPapers, MODULE_LABEL, rangeText } from '../lib/bank'
import { allAttempts } from '../lib/store'

export const Mock: React.FC<{
  onOpen: (id: number, groupIndex?: number) => void
  onOpenPaper?: (paperId: number, module: 'listening' | 'reading') => void
}> = ({ onOpen, onOpenPaper }) => {
  const papers = getMockPapers()
  const entries = getMockEntries()
  const [opened, setOpened] = useState<number | null>(null)
  const attempts = useMemo(() => allAttempts(), [])
  const byUnit = useMemo(() => {
    const map = new Map<number, (typeof attempts)[number]>()
    attempts.forEach((a) => {
      const prev = map.get(a.unitId)
      if (!prev || (a.groupIndex == null && prev.groupIndex != null)) map.set(a.unitId, a)
    })
    return map
  }, [attempts])

  return (
    <div className="page">
      <h1 className="page-title">全真模考</h1>
      <p className="page-sub">
        共 {papers.length} 套卷，每套含听力 4 个 Part 与阅读 3 篇。整卷模考＝一次计时、一次交卷，和实考一样可以在底部 Part 之间跳转。
      </p>
      <div className="cards">
        {papers.map((p) => {
          const own = entries.filter((e) => e.paper.id === p.id)
          const done = own.filter((e) => byUnit.has(e.unit.id)).length
          const hasListening = own.some((e) => e.unit.module === 'listening')
          const hasReading = own.some((e) => e.unit.module === 'reading')
          return (
            <div className="card card-static" key={p.id}>
              <div className="card-top">
                <span className="badge">模考 {p.no ?? p.id}</span>
                <span className="badge subtle">{own.length} 个单元</span>
                {done > 0 && <span className="badge done">已练 {done}/{own.length}</span>}
              </div>
              <div className="card-title">{p.title || `模考 ${p.no ?? p.id}`}</div>
              {onOpenPaper && (
                <div className="mock-paper-actions">
                  {hasListening && (
                    <button className="ghost" onClick={() => onOpenPaper(p.id, 'listening')}>
                      听力整卷 · 30 分钟
                    </button>
                  )}
                  {hasReading && (
                    <button className="ghost" onClick={() => onOpenPaper(p.id, 'reading')}>
                      阅读整卷 · 60 分钟
                    </button>
                  )}
                </div>
              )}
              <button className="link-btn" onClick={() => setOpened(opened === p.id ? null : p.id)}>
                {opened === p.id ? '收起' : '或者逐篇练'}
              </button>
              {opened === p.id && (
                <div className="mock-units">
                  {own.map((e) => {
                    const a = byUnit.get(e.unit.id)
                    const label = rangeText(e.unit.from, e.unit.to)
                    return (
                      <button
                        className="mock-unit"
                        key={e.key}
                        onClick={() => onOpen(e.unit.id, a?.groupIndex)}
                      >
                        <span>{e.key.toUpperCase()} · {MODULE_LABEL[e.unit.module]}</span>
                        <span className="mock-unit-title">{e.unit.title}</span>
                        {label && <span className="mock-unit-range">{label}</span>}
                        {a && <span className="badge done">{a.score}/{a.total}</span>}
                      </button>
                    )
                  })}
                  {!own.length && <div className="empty">这套卷没有附带单元数据。</div>}
                </div>
              )}
            </div>
          )
        })}
      </div>
    </div>
  )
}
