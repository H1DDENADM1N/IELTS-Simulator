import React, { useMemo, useState } from 'react'
import { EXAM_LABEL, getWritingTasks, mediaFromRef } from '../lib/bank'
import { getDraft, saveDraft } from '../lib/store'
import type { WritingTask } from '../lib/types'

const TYPE_LABEL: Record<string, string> = {
  task1: '雅思 Task 1 图表',
  task2: '雅思 Task 2 议论',
  cet_writing: '四 / 六级写作',
  cet_translation: '四 / 六级翻译',
}

export const Writing: React.FC = () => {
  const tasks = getWritingTasks()
  const [exam, setExam] = useState('')
  const [type, setType] = useState('')
  const [selected, setSelected] = useState<number | null>(null)
  const [draft, setDraft] = useState('')
  const [showSample, setShowSample] = useState(false)

  const list = useMemo(
    () => tasks.filter((t) => (!exam || t.exam === exam) && (!type || t.taskType === type)),
    [tasks, exam, type],
  )
  const task: WritingTask | undefined = selected ? tasks.find((t) => t.id === selected) : undefined
  const words = draft.trim() ? draft.trim().split(/\s+/).length : 0
  const image = task ? mediaFromRef(task.image) : ''

  const open = (id: number) => {
    setSelected(id)
    setDraft(getDraft(id))
    setShowSample(false)
    window.scrollTo({ top: 0 })
  }

  const update = (value: string) => {
    setDraft(value)
    if (selected) saveDraft(selected, value)
  }

  return (
    <div className="page">
      <h1 className="page-title">写作 / 翻译</h1>
      <p className="page-sub">共 {tasks.length} 道题。草稿自动保存在本机。</p>

      <div className="filters">
        <div className="filter-row">
          <span className="filter-label">考试</span>
          {[['', '全部'], ['ielts', '雅思'], ['cet4', '四级'], ['cet6', '六级']].map(([v, l]) => (
            <button key={v} className={'chip' + (exam === v ? ' on' : '')} onClick={() => setExam(v)}>{l}</button>
          ))}
        </div>
        <div className="filter-row">
          <span className="filter-label">类型</span>
          {[['', '全部'], ...Object.entries(TYPE_LABEL)].map(([v, l]) => (
            <button key={v} className={'chip' + (type === v ? ' on' : '')} onClick={() => setType(v)}>{l}</button>
          ))}
        </div>
      </div>

      {!task ? (
        <div className="cards">
          {list.slice(0, 200).map((t) => (
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
          {list.length > 200 && <div className="empty">仅显示前 200 道，可用筛选缩小范围。</div>}
          {!list.length && <div className="empty">没有符合条件的题目。</div>}
        </div>
      ) : (
        <div className="writing-detail">
          <button className="link-btn" onClick={() => setSelected(null)}>← 返回题目列表</button>
          <h2>{task.title || task.titleZh}</h2>
          <div className="unit-meta">
            <span className="badge">{EXAM_LABEL[task.exam] || task.exam}</span>
            <span className="badge subtle">{TYPE_LABEL[task.taskType] || task.taskType}</span>
            {task.paper && <span>{task.paper}</span>}
            {task.suggestedMinutes && <span>建议 {task.suggestedMinutes} 分钟</span>}
          </div>
          {task.prompt && <div className="prompt-box">{task.prompt}</div>}
          {image && <img className="group-img" src={image} alt="题目图表" />}

          <textarea
            className="writing-pad"
            value={draft}
            placeholder="在这里写作，草稿会自动保存到本机…"
            onChange={(e) => update(e.target.value)}
          />
          <div className="writing-foot">
            <span>{words} 词{task.minWords ? ` / 建议不少于 ${task.minWords} 词` : ''}</span>
            <button className="ghost" onClick={() => setShowSample((v) => !v)}>
              {showSample ? '收起' : '查看'}范文与解析
            </button>
            <button className="ghost" onClick={() => update('')}>清空草稿</button>
          </div>

          {showSample && (
            <div className="sample-box">
              {task.sampleAnswer && <><h3>范文 / 参考译文</h3><div className="prompt-box">{task.sampleAnswer}</div></>}
              {task.modelAnswerZh && <><h3>中文参考</h3><div className="prompt-box">{task.modelAnswerZh}</div></>}
              {task.analysis && <><h3>解析</h3><div className="prompt-box">{task.analysis}</div></>}
              {!task.sampleAnswer && !task.modelAnswerZh && !task.analysis && <div className="empty">这道题没有附带范文。</div>}
            </div>
          )}
        </div>
      )}
    </div>
  )
}
