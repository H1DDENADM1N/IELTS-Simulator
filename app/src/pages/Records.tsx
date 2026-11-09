import React, { useMemo, useState } from 'react'
import { formatTime } from '../components'
import { allAttempts, clearAll } from '../lib/store'

export const Records: React.FC<{ onOpen: (id: number, groupIndex?: number, number?: number) => void }> = ({
  onOpen,
}) => {
  const [tick, setTick] = useState(0)
  const attempts = useMemo(() => allAttempts(), [tick])
  const wrong = useMemo(() => {
    const seen = new Set<string>()
    return attempts
      .flatMap((a) =>
        a.wrong.map((n) => ({
          unitId: a.unitId,
          groupIndex: a.groupIndex,
          title: a.title,
          scope: a.scope,
          number: n,
        })),
      )
      .filter((w) => {
        const key = `${w.unitId}:${w.groupIndex ?? ''}:${w.number}`
        if (seen.has(key)) return false
        seen.add(key)
        return true
      })
  }, [attempts])
  const avg = attempts.length
    ? Math.round(
        (attempts.reduce((s, a) => s + (a.total ? a.score / a.total : 0), 0) / attempts.length) * 100,
      )
    : 0
  const units = new Set(attempts.map((a) => a.unitId)).size

  return (
    <div className="page">
      <h1 className="page-title">做题记录</h1>
      <p className="page-sub">成绩、错题和草稿都保存在便携文件夹的 userdata 内，不写入系统用户目录。</p>

      <div className="stats">
        <div className="stat"><strong>{attempts.length}</strong><span>已练题组</span></div>
        <div className="stat"><strong>{units}</strong><span>练过篇目</span></div>
        <div className="stat"><strong>{avg}%</strong><span>平均正确率</span></div>
        <div className="stat"><strong>{wrong.length}</strong><span>错题条目</span></div>
        <button
          className="ghost danger"
          onClick={() => {
            if (confirm('确定清空全部本地记录与答题草稿？此操作不可恢复。')) {
              clearAll()
              setTick((t) => t + 1)
            }
          }}
        >
          清空记录
        </button>
      </div>

      <h2 className="section-title">成绩记录</h2>
      {!attempts.length && <div className="empty">还没有做题记录，去题库练一组吧。</div>}

      <div className="rec-list">
        {attempts.map((a) => {
          const pct = a.total ? Math.round((a.score / a.total) * 100) : 0
          return (
            <div className="rec-row" key={a.key || `${a.unitId}-${a.at}`}>
              <button className="rec-main" onClick={() => onOpen(a.unitId, a.groupIndex)}>
                <span className="rec-title">{a.title}</span>
                <span className="rec-meta">
                  {a.scope || (a.groupIndex == null ? '整篇' : `题组 ${a.groupIndex + 1}`)}
                  <i>{new Date(a.at).toLocaleString('zh-CN', { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' })}</i>
                  <i>用时 {formatTime(a.seconds)}</i>
                </span>
              </button>
              <span className="rec-score">
                <b>{a.score}</b>/{a.total}
                <i>{pct}%</i>
              </span>
              <span className="rec-wrong">
                {a.wrong.length ? (
                  a.wrong.slice(0, 8).map((n) => (
                    <button
                      key={n}
                      className="wrong-chip"
                      title={`跳到第 ${n} 题`}
                      onClick={() => onOpen(a.unitId, a.groupIndex, n)}
                    >
                      {n}
                    </button>
                  ))
                ) : (
                  <span className="rec-allok">全对</span>
                )}
                {a.wrong.length > 8 && <span className="rec-more">+{a.wrong.length - 8}</span>}
              </span>
            </div>
          )
        })}
      </div>

      {wrong.length > 0 && (
        <>
          <h2 className="section-title">错题速查</h2>
          <div className="wrong-list">
            {wrong.slice(0, 300).map((w, i) => (
              <button
                className="wrong-item"
                key={`${w.unitId}-${w.groupIndex}-${w.number}-${i}`}
                onClick={() => onOpen(w.unitId, w.groupIndex, w.number)}
              >
                第 {w.number} 题 · {w.title}
                {w.scope ? <i>{w.scope}</i> : null}
              </button>
            ))}
          </div>
        </>
      )}
    </div>
  )
}
