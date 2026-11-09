import React, { useCallback, useEffect, useMemo, useState } from 'react'
import {
  EXAM_LABEL,
  MODULE_LABEL,
  SORT_LABEL,
  allBankRows,
  pageNumbers,
  partText,
  queryRows,
  randomRow,
  rowDone,
  typeCounts,
  typeLabel,
  type BankRow,
  type BankScope,
  type RowStatus,
  type SortKey,
} from '../lib/bank'
import { allAttempts, readState, typeAccuracy } from '../lib/store'

const PAGE_SIZE = 20

const shortRange = (row: BankRow) => {
  if (row.from == null) return ''
  if (row.to == null || row.to === row.from) return String(row.from)
  return `${row.from}–${row.to}`
}

export const Column: React.FC<{
  initialExam?: string
  initialModule?: string
  initialType?: string
  initialStatus?: string
  initialSort?: string
  initialScope?: string
  initialKeyword?: string
  initialPage?: number
  onOpen: (id: number, groupIndex?: number) => void
}> = ({
  initialExam = '',
  initialModule = '',
  initialType = '',
  initialStatus = 'all',
  initialSort = 'path',
  initialScope = 'group',
  initialKeyword = '',
  initialPage = 0,
  onOpen,
}) => {
  const [exam, setExam] = useState(initialExam)
  const [module, setModule] = useState(initialModule)
  const [scope, setScope] = useState<BankScope>(initialScope === 'unit' ? 'unit' : 'group')
  const [status, setStatus] = useState<RowStatus>(
    initialStatus === 'done' || initialStatus === 'undone' ? initialStatus : 'all',
  )
  const [type, setType] = useState(initialType)
  const [sort, setSort] = useState<SortKey>(
    (Object.keys(SORT_LABEL) as SortKey[]).includes(initialSort as SortKey) ? (initialSort as SortKey) : 'path',
  )
  const [keyword, setKeyword] = useState(initialKeyword)
  const [page, setPage] = useState(Math.max(0, initialPage))

  // 筛选状态写回地址栏：进答题页再返回、刷新页面都能回到原来的筛选和页码
  useEffect(() => {
    const query = new URLSearchParams()
    if (exam) query.set('exam', exam)
    if (module) query.set('module', module)
    if (scope !== 'group') query.set('scope', scope)
    if (type) query.set('type', type)
    if (status !== 'all') query.set('status', status)
    if (sort !== 'path') query.set('sort', sort)
    if (keyword) query.set('kw', keyword)
    if (page > 0) query.set('page', String(page + 1))
    const next = '#/bank' + (query.toString() ? '?' + query.toString() : '')
    if (window.location.hash === next) return
    try {
      window.history.replaceState(null, '', next)
    } catch {
      // file:// 下个别环境不允许改写地址栏，忽略即可，不影响筛选
    }
  }, [exam, module, scope, type, status, sort, keyword, page])

  const attempts = useMemo(() => allAttempts(), [])
  const attemptMap = useMemo(() => new Map(attempts.map((a) => [a.key || String(a.unitId), a])), [attempts])
  const doneKeys = useMemo(() => new Set(attemptMap.keys()), [attemptMap])
  const doneUnits = useMemo(() => new Set(attempts.map((a) => a.unitId)), [attempts])
  const scores = useMemo(
    () => new Map([...attemptMap.entries()].map(([k, a]) => [k, { score: a.score, total: a.total }])),
    [attemptMap],
  )
  const drafts = useMemo(() => {
    const items = Object.values(readState().practice)
    return new Map(items.filter((d) => Object.keys(d.answers || {}).length).map((d) => [d.key, d]))
  }, [])

  const typeSource = useMemo(
    () => queryRows({ exam, module, keyword, scope, doneKeys, doneUnits, scores }),
    [exam, module, keyword, scope, doneKeys, doneUnits, scores],
  )
  const types = useMemo(() => typeCounts(typeSource), [typeSource])

  const rows = useMemo(
    () => queryRows({ exam, module, type, keyword, sort, scope, doneKeys, doneUnits, scores }),
    [exam, module, type, keyword, sort, scope, doneKeys, doneUnits, scores],
  )
  const isDone = useCallback(
    (row: BankRow) =>
      rowDone(row, doneKeys, doneUnits) || (row.groupIndex != null && doneUnits.has(row.unitId)),
    [doneKeys, doneUnits],
  )
  const doneCount = rows.filter(isDone).length
  const visible = rows.filter((r) => {
    if (status === 'all') return true
    return isDone(r) === (status === 'done')
  })

  const pages = Math.max(1, Math.ceil(visible.length / PAGE_SIZE))
  const safePage = Math.min(page, pages - 1)
  const shown = visible.slice(safePage * PAGE_SIZE, (safePage + 1) * PAGE_SIZE)
  const allRows = useMemo(() => allBankRows(scope), [scope])
  const totalRows = allRows.length
  const totalDone = useMemo(() => allRows.filter(isDone).length, [allRows, isDone])

  const change = (fn: () => void) => {
    fn()
    setPage(0)
  }

  const resetFilters = () => {
    change(() => {
      setExam('')
      setModule('')
      setType('')
      setStatus('all')
      setKeyword('')
      setSort('path')
    })
  }

  const pickRandom = () => {
    const row = randomRow(visible.length ? visible : rows)
    if (row) onOpen(row.unitId, row.groupIndex ?? undefined)
  }

  const turn = (next: number) => {
    setPage(next)
    document.querySelector('.bank-main')?.scrollIntoView({ behavior: 'smooth', block: 'start' })
  }

  const latestDraft = useMemo(
    () =>
      [...drafts.values()]
        .filter((d) => Object.keys(d.answers).length)
        .sort((a, b) => b.at - a.at)[0],
    [drafts],
  )

  const accuracy = useMemo(() => typeAccuracy(), [])
  const accuracyRows = Object.entries(accuracy)
    .filter(([type]) => type !== '__total')
    .map(([type, v]) => ({ type, label: typeLabel(type), ...v }))
    .sort((a, b) => b.t - a.t)

  const hasFilter = Boolean(exam || module || type || keyword || status !== 'all' || sort !== 'path')
  const sectionOf = (row: BankRow) =>
    [
      exam ? '' : EXAM_LABEL[row.exam] || row.exam,
      module ? '' : MODULE_LABEL[row.module],
      `${row.module === 'reading' ? 'Passage' : 'Part'} ${row.part ?? '—'}`,
    ]
      .filter(Boolean)
      .join(' · ')

  const sections = useMemo(() => {
    if (sort !== 'path') return [{ key: 'all', label: '', rows: shown }]
    const out: { key: string; label: string; rows: BankRow[] }[] = []
    shown.forEach((row) => {
      const label = sectionOf(row)
      const last = out[out.length - 1]
      if (last && last.label === label) last.rows.push(row)
      else out.push({ key: `${label}-${row.key}`, label, rows: [row] })
    })
    return out
  }, [shown, sort, exam, module]) // eslint-disable-line react-hooks/exhaustive-deps

  const sectionTotal = useMemo(() => {
    const map = new Map<string, number>()
    visible.forEach((row) => map.set(sectionOf(row), (map.get(sectionOf(row)) || 0) + 1))
    return map
  }, [visible, exam, module]) // eslint-disable-line react-hooks/exhaustive-deps


  return (
    <div className="page bank">
      <div className="bank-head">
        <div>
          <h1 className="page-title">题库</h1>
          <p className="page-sub">
            共 {totalRows} {scope === 'group' ? '组题' : '篇'}，已练 {totalDone} {scope === 'group' ? '组' : '篇'}。
            按题组练一次 10 题上下，按整篇练会一次做完整套。
          </p>
        </div>
        <div className="bank-head-actions">
          <button className="ghost" onClick={resetFilters} disabled={!hasFilter}>重置筛选</button>
          <button className="primary" onClick={pickRandom}>随机一题</button>
        </div>
      </div>

      <div className="bank-layout">
        <aside className="bank-side">
          <div className="side-block">
            <div className="side-title">练法</div>
            <button
              className={'side-line' + (scope === 'group' ? ' on' : '')}
              onClick={() => change(() => setScope('group'))}
            >
              <span>按题组练</span>
              <i>10 题上下</i>
            </button>
            <button
              className={'side-line' + (scope === 'unit' ? ' on' : '')}
              onClick={() => change(() => { setScope('unit'); setType('') })}
            >
              <span>整篇练</span>
              <i>一套做完</i>
            </button>
          </div>

          <div className="side-block">
            <div className="side-title">状态</div>
            {([
              ['all', '全部', rows.length],
              ['undone', '未做', rows.length - doneCount],
              ['done', '已做', doneCount],
            ] as [RowStatus, string, number][]).map(([value, label, count]) => (
              <button
                key={value}
                className={'side-line' + (status === value ? ' on' : '')}
                onClick={() => change(() => setStatus(value))}
              >
                <span>{label}</span>
                <i>{count}</i>
              </button>
            ))}
          </div>

          <div className="side-block side-note">
            <div className="side-title">提示</div>
            <p>答题会自动保存草稿，换页或关掉程序都能接着做。</p>
          </div>
        </aside>

        <div className="bank-main">
          <div className="chip-rows">
            <div className="filter-row">
              <span className="filter-label">考试</span>
              {[['', '全部'], ['ielts', '雅思'], ['cet4', '四级'], ['cet6', '六级']].map(([v, label]) => (
                <button
                  key={v}
                  className={'chip' + (exam === v ? ' on' : '')}
                  onClick={() => change(() => { setExam(v); setModule('') })}
                >
                  {label}
                </button>
              ))}
            </div>
            <div className="filter-row">
              <span className="filter-label">科目</span>
              {[['', '全部'], ['listening', '听力'], ['reading', '阅读']].map(([v, label]) => (
                <button
                  key={v}
                  className={'chip' + (module === v ? ' on' : '')}
                  onClick={() => change(() => { setModule(v); setExam(exam || 'ielts') })}
                >
                  {label}
                </button>
              ))}
              <span className="filter-sep" />
              <span className="filter-label">题型</span>
              <button className={'chip' + (type === '' ? ' on' : '')} onClick={() => change(() => setType(''))}>
                全部
              </button>
              {types.map((t) => (
                <button
                  key={t.type}
                  className={'chip' + (type === t.type ? ' on' : '')}
                  onClick={() => change(() => setType(type === t.type ? '' : t.type))}
                >
                  {t.label}
                  <small>{t.count}</small>
                </button>
              ))}
            </div>
          </div>

          <div className="list-tools">
            <div className="search-wrap">
              <input
                className="search"
                placeholder={scope === 'group' ? '搜索标题、题型、试卷' : '搜索标题、试卷'}
                value={keyword}
                onChange={(e) => change(() => setKeyword(e.target.value))}
              />
              {keyword && <button className="search-clear" onClick={() => change(() => setKeyword(''))} aria-label="清空搜索">×</button>}
            </div>
            <label className="sort-wrap">
              <span>排序</span>
              <select value={sort} onChange={(e) => change(() => setSort(e.target.value as SortKey))}>
                {(Object.keys(SORT_LABEL) as SortKey[]).map((key) => (
                  <option key={key} value={key}>{SORT_LABEL[key]}</option>
                ))}
              </select>
            </label>
          </div>

          <div className="list-meta">
            <span>找到 <b>{visible.length}</b> {scope === 'group' ? '组' : '篇'}</span>
            <span className="list-meta-right">第 {safePage + 1} / {pages} 页</span>
          </div>

          <div className="row-list">
            {sections.map((section) => (
              <React.Fragment key={section.key}>
                {section.label && (
                  <div className="row-group">
                    <span>{section.label}</span>
                    <i>{sectionTotal.get(section.label) || section.rows.length} {scope === 'group' ? '组' : '篇'}</i>
                  </div>
                )}
                {section.rows.map((row) => {
              const attempt = attemptMap.get(row.key)
              const draft = drafts.get(row.key)
              const done = isDone(row)
              const draftAnswered = draft ? Object.keys(draft.answers).length : 0
              return (
                <button className="row" key={row.key} onClick={() => onOpen(row.unitId, row.groupIndex ?? undefined)}>
                  <span className="row-badge">
                    <b>{partText(row)}</b>
                    <i>{scope === 'group' ? shortRange(row) : `${row.groups} 组`}</i>
                  </span>
                  <span className="row-main">
                    <span className="row-title">
                      {row.title}
                      {scope === 'group' && row.type && <em> · {typeLabel(row.type)}</em>}
                    </span>
                    <span className="row-meta">
                      {scope === 'group' ? typeLabel(row.type) : row.summary}
                      {row.paper ? <i>{row.paper}</i> : null}
                      <i>{row.questions} 题</i>
                    </span>
                  </span>
                  <span className={'row-status' + (draft ? ' doing' : done ? ' done' : '')}>
                    {draft ? `进行中 ${draftAnswered}/${draft.total || row.questions}` : attempt ? `${attempt.score}/${attempt.total}` : done ? '已做' : '未做'}
                  </span>
                  <span className="row-cta">{draft ? '继续' : '开始练习'} <i>↗</i></span>
                </button>
              )
                })}
              </React.Fragment>
            ))}
            {!shown.length && (
              <div className="empty">
                <p>没有符合条件的题目。</p>
                {hasFilter && <button className="ghost" onClick={resetFilters}>清空筛选</button>}
              </div>
            )}
          </div>

          {pages > 1 && (
            <div className="pager">
              <button disabled={safePage === 0} onClick={() => turn(safePage - 1)}>← 上一页</button>
              {pageNumbers(safePage, pages).map((n, i) =>
                n === '…' ? (
                  <span className="pager-gap" key={`gap-${i}`}>…</span>
                ) : (
                  <button
                    key={n}
                    className={'pager-num' + (n === safePage + 1 ? ' on' : '')}
                    onClick={() => turn(n - 1)}
                  >
                    {n}
                  </button>
                ),
              )}
              <button disabled={safePage >= pages - 1} onClick={() => turn(safePage + 1)}>下一页 →</button>
            </div>
          )}
        </div>

        <aside className="bank-rail">
          <div className="rail-card accent">
            <div className="rail-eyebrow">继续上次</div>
            {latestDraft ? (
              <>
                <div className="rail-title">{latestDraft.title}</div>
                <div className="rail-meta">
                  {latestDraft.scope || `${Object.keys(latestDraft.answers).length} 题已答`} · 已答 {Object.keys(latestDraft.answers).length}/{latestDraft.total || '—'}
                </div>
                <button
                  className="rail-cta"
                  onClick={() => onOpen(latestDraft.unitId, latestDraft.groupIndex ?? undefined)}
                >
                  接着做 ↗
                </button>
              </>
            ) : (
              <>
                <div className="rail-title">还没开工</div>
                <div className="rail-meta">随机抽一组题，先从 10 题开始。</div>
                <button className="rail-cta" onClick={pickRandom}>抽一组 ↗</button>
              </>
            )}
          </div>

          <div className="rail-card">
            <div className="rail-eyebrow">我的正确率</div>
            {accuracyRows.length ? (
              <div className="type-stats">
                {accuracyRows.slice(0, 7).map((s) => {
                  const pct = s.t ? Math.round((s.c / s.t) * 100) : 0
                  return (
                    <div className="type-stat" key={s.type}>
                      <span className="type-name">{s.label}</span>
                      <span className="type-bar"><i style={{ width: `${pct}%` }} /></span>
                      <span className="type-pct">{pct}%</span>
                    </div>
                  )
                })}
              </div>
            ) : (
              <p className="rail-empty">做完一组题后，这里会按题型显示正确率。</p>
            )}
          </div>

          <div className="rail-card flat">
            <div className="rail-eyebrow">快捷键</div>
            <p className="rail-empty">
              和机考一致：<kbd>Tab</kbd> / <kbd>Shift</kbd> + <kbd>Tab</kbd> 在答题框之间移动，<kbd>←</kbd>{' '}
              <kbd>→</kbd> 在单选/复选里切换选项，<kbd>Ctrl</kbd> + <kbd>C</kbd> / <kbd>V</kbd> / <kbd>Z</kbd>{' '}
              复制粘贴撤销。题号跳转用底栏。
            </p>
          </div>
        </aside>
      </div>
    </div>
  )
}
