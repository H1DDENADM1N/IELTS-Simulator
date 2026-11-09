import React, { useEffect, useState } from 'react'
import { Column } from './pages/Column'
import { Mock } from './pages/Mock'
import { Practice } from './pages/Practice'
import { Records } from './pages/Records'
import { Writing } from './pages/Writing'
import { getMockEntries, getMockPapers, getUnits, getWritingTasks } from './lib/bank'
import { allAttempts, latestPracticeDraft } from './lib/store'
import { TEXT_MAX, TEXT_MIN, getTextScale, resetTextScale, stepTextScale, subscribeTextScale } from './lib/textscale'
import { FONT_LABEL, getFontFace, setFontFace, subscribeFontFace, type FontFace } from './lib/fontface'

const go = (path: string) => {
  window.location.hash = path
  window.scrollTo({ top: 0 })
}

const openPath = (unitId: number, groupIndex?: number, number?: number) =>
  `/u/${unitId}${groupIndex == null ? '' : `/g/${groupIndex}`}${number == null ? '' : `?q=${number}`}`

/**
 * 全局字号：Ctrl + / Ctrl - / Ctrl 0，以及 Ctrl + 滚轮。
 * 只订阅 textscale 里那个系数，不触发整页重排。
 */
const useTextScaleShortcuts = () => {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (!(e.ctrlKey || e.metaKey) || e.altKey) return
      if (e.key === '=' || e.key === '+' || e.key === 'Add') {
        e.preventDefault()
        stepTextScale(1)
      } else if (e.key === '-' || e.key === '_' || e.key === 'Subtract') {
        e.preventDefault()
        stepTextScale(-1)
      } else if (e.key === '0') {
        e.preventDefault()
        resetTextScale()
      }
    }
    const onWheel = (e: WheelEvent) => {
      if (!e.ctrlKey) return
      // 压住默认滚动，滚轮只用来改字号
      e.preventDefault()
      stepTextScale(e.deltaY < 0 ? 1 : -1)
    }
    window.addEventListener('keydown', onKey)
    window.addEventListener('wheel', onWheel, { passive: false })
    return () => {
      window.removeEventListener('keydown', onKey)
      window.removeEventListener('wheel', onWheel)
    }
  }, [])
}

/** 字体：卷面衬线 / Arial / 系统，浏览器化下拉，改了立刻生效并记住 */
const FontFaceControl: React.FC = () => {
  const [face, setFace] = useState(getFontFace)
  useEffect(() => subscribeFontFace(setFace), [])
  return (
    <label className="font-pick" title="切换界面与原文的字体">
      <span>字体</span>
      <select value={face} onChange={(e) => setFontFace(e.target.value as FontFace)} aria-label="字体">
        {(Object.keys(FONT_LABEL) as FontFace[]).map((key) => (
          <option key={key} value={key}>
            {FONT_LABEL[key]}
          </option>
        ))}
      </select>
    </label>
  )
}

/** 顶栏右侧的字号控件：A− 100% A+，点百分比回到默认；改字号时边框亮一下当反馈 */
const FontSizeControl: React.FC = () => {
  const [scale, setScale] = useState(getTextScale)
  const [bump, setBump] = useState(false)
  useEffect(
    () =>
      subscribeTextScale((value) => {
        setScale(value)
        setBump(true)
      }),
    [],
  )
  useEffect(() => {
    if (!bump) return
    const timer = window.setTimeout(() => setBump(false), 480)
    return () => window.clearTimeout(timer)
  }, [bump, scale])
  return (
    <div className={'font-ctl' + (bump ? ' bump' : '')} role="group" aria-label="正文字号">
      <button type="button" onClick={() => stepTextScale(-1)} disabled={scale <= TEXT_MIN} title="缩小字号（Ctrl + -）">
        A−
      </button>
      <button type="button" className="font-ctl-val" onClick={resetTextScale} title="恢复默认字号（Ctrl + 0）">
        {Math.round(scale * 100)}%
      </button>
      <button type="button" onClick={() => stepTextScale(1)} disabled={scale >= TEXT_MAX} title="放大字号（Ctrl + +）">
        A+
      </button>
    </div>
  )
}

const Home: React.FC<{ navigate: (p: string) => void }> = ({ navigate }) => {
  const units = getUnits()
  const attempts = allAttempts()
  const doneUnits = new Set(attempts.map((a) => a.unitId)).size
  const withAudio = units.filter((u) => u.hasAudio).length
  const draft = latestPracticeDraft()
  const last = draft
    ? { unitId: draft.unitId, groupIndex: draft.groupIndex, title: draft.title, scope: draft.scope, at: draft.at, label: `${Object.keys(draft.answers).length} 题已答` }
    : attempts[0]
      ? { unitId: attempts[0].unitId, groupIndex: attempts[0].groupIndex, title: attempts[0].title, scope: attempts[0].scope, at: attempts[0].at, label: `${attempts[0].score}/${attempts[0].total} 分` }
      : null

  const entries = [
    { title: '雅思听力', desc: 'Part 1–4，带音频与原文', path: '/bank?exam=ielts&module=listening' },
    { title: '雅思阅读', desc: 'Passage 1–3，含原文定位', path: '/bank?exam=ielts&module=reading' },
    { title: '四级真题', desc: '听力、阅读、写作、翻译', path: '/bank?exam=cet4' },
    { title: '六级真题', desc: '听力、阅读、写作、翻译', path: '/bank?exam=cet6' },
  ]
  return (
    <div className="page home">
      <div className="hero">
        <h1>
          <a
            className="hero-link"
            href="https://github.com/H1DDENADM1N/IELTS-Simulator"
            target="_blank"
            rel="noopener noreferrer"
            title="Open the IELTS Simulator project on GitHub"
          >
            IELTS Simulator
          </a>
        </h1>
        <p>雅思 / 四六级真题练习。全部题目、音频和记录都在本机，打开即用，不联网。</p>
      </div>

      {last && (
        <button className="continue-bar" onClick={() => navigate(openPath(last.unitId, last.groupIndex))}>
          <span className="continue-tag">继续上次</span>
          <span className="continue-main">
            <b>{last.title}</b>
            <i>{last.scope || last.label}</i>
          </span>
          <span className="continue-go">接着{draft ? '做' : '看'} ↗</span>
        </button>
      )}

      <div className="stats">
        <div className="stat"><strong>{units.length}</strong><span>练习篇目</span></div>
        <div className="stat"><strong>{getWritingTasks().length}</strong><span>写作 / 翻译题</span></div>
        <div className="stat"><strong>{getMockPapers().length}</strong><span>模考卷</span></div>
        <div className="stat"><strong>{withAudio}</strong><span>带音频</span></div>
        <div className="stat"><strong>{attempts.length}</strong><span>已练题组</span></div>
        <div className="stat"><strong>{doneUnits}</strong><span>练过的篇目</span></div>
      </div>
      <div className="tiles">
        {entries.map((e) => (
          <button className="tile" key={e.title} onClick={() => navigate(e.path)}>
            <strong>{e.title}</strong>
            <span>{e.desc}</span>
          </button>
        ))}
      </div>
      <div className="tiles small">
        <button className="tile" onClick={() => navigate('/writing')}><strong>写作 / 翻译</strong><span>草稿自动保存</span></button>
        <button className="tile" onClick={() => navigate('/mock')}><strong>全真模考</strong><span>{getMockEntries().length} 个模考单元</span></button>
        <button className="tile" onClick={() => navigate('/records')}><strong>做题记录</strong><span>成绩与错题</span></button>
        <button className="tile" onClick={() => navigate('/bank')}><strong>全部题库</strong><span>按题组 / 整篇练</span></button>
      </div>
    </div>
  )
}

const Help: React.FC = () => (
  <div className="page help">
    <h1 className="page-title">使用说明</h1>
    <div className="help-block">
      <h2>数据与位置</h2>
      <p>题库 JSON 和全部音频、图片放在便携文件夹的 <code>data/</code> 目录；成绩、错题、草稿放在 <code>userdata/</code>。整个文件夹可以直接复制到别的电脑或 U 盘，双击 <code>ielts-simulator.exe</code> 即可使用。</p>
    </div>
    <div className="help-block">
      <h2>离线保证</h2>
      <p>程序不请求任何网络地址，不写注册表，不往系统用户目录写文件。主进程把 Electron 的 userData、cache、logs 全部重定向到便携目录，并设置了禁止外部连接的 CSP。</p>
    </div>
    <div className="help-block">
      <h2>答题</h2>
      <p>题库可以按题组练（一次 10 题上下），也可以按整篇练。作答会自动存草稿，中途离开不会丢；交卷后可以看正确答案、解析，并一键在原文中定位。填空题直接嵌在题面里填，和真实卷面一致。</p>
    </div>
    <div className="help-block">
      <h2>机考界面</h2>
      <p><b>写作 / 翻译</b>同样进入机考界面：左边题目（Task 1 的图表就在这里）、右边输入区，中间分隔线可拖动；输入框下方实时显示 <b>Word count</b>，底栏 <b>Part 1 / Part 2</b> 可以随时切换，两篇草稿分别自动保存。IELTS 的 Task 1 + Task 2、四六级的写作 + 翻译会自动配成一场 60 分钟的考试；不想要配对可以在 Options 里关掉。范文与解析放在 Options 的 <b>Model answer</b>（练习模式）。</p>
      <p>顶栏是官方那条粉红条：左上考生号，下面一行倒计时（鼠标悬停显示到秒）。最后 10 分钟整点会闪 10 秒，最后 5 分钟转成红色常亮，最后一分钟只显示 <b>0:SS</b>。右上角是 <b>Finish test</b> 和四个图标：网络、通知、<b>Options 菜单</b>（Settings / Hide screen / Help 都在里面）、<b>Notes 面板</b>。Settings 里能调字号；Hide screen 会把整屏挡住但计时继续，点 <b>Resume test</b> 回来。底栏左侧 <b>Review</b> 给题目标记，标记过的题号会从方块变成圆圈；已答的题号带下划线和绿色顶边，当前题是蓝框。右侧两个 60×60 的黑/灰箭头就是 Previous / Next。原文里先选中文字再 <b>右键</b>，会弹出机考同款的 <b>Highlight / Notes / Clear / Clear all</b> 菜单；写过笔记的文字带虚下划线，点一下可以修改或删除，高亮和笔记都存在本机。</p>
    </div>
    <div className="help-block">
      <h2>字体与字号</h2>
      <p>字体可在顶栏「字体」里切换：<b>卷面衬线</b>（Cambria + 宋体，雅思试卷、剑桥真题册的观感，默认）、<b>Arial</b>（官方试题标准 11pt 的字体）、<b>系统</b>（Windows 默认 Segoe UI）。中文在 Arial / 系统两档会回落到微软雅黑，只有卷面衬线档会跟着变成宋体，所以想看字体变化请切到「卷面衬线」。</p>
      <p>字号可在 80%–150% 之间调，只放大文字、不改变版式；字体和字号都会记住，下次打开还是这套。</p>
    </div>
    <div className="help-block">
      <h2>快捷键</h2>
      <p><b>Ctrl +</b> / <b>Ctrl −</b> / <b>Ctrl 0</b> 调整或复位正文字号，<b>Ctrl + 滚轮</b> 也能缩放；机考答题页的 Settings 里另有 Standard / Large / Extra large 三档。</p>
      <p>答题时 <b>Tab</b> / <b>Shift + Tab</b> 在答题框之间移动，<b>Esc</b> 关闭菜单、弹窗或 Notes 面板；原文与写作题干里选中文字后 <b>右键</b> 可以 Highlight / Notes / Clear。写作与翻译页用底栏的 <b>Part 1 / Part 2</b> 或右下角箭头切换题目。</p>
    </div>
    <div className="help-block">
      <h2>数据来源与致谢</h2>
      <p>题库、听力音频与题目配图来源于「我不是考神」（<code>wbsks.com</code>），仅在本机构建时固化，用于离线练习；感谢原项目作者与贡献者的整理与开源（AGPL-3.0）。IELTS Simulator 是独立的离线练习程序，与原项目无关联，也不是官方考试系统。</p>
    </div>
  </div>
)

// 渲染兜底：任何页面抛错时只替换内容区，避免 React 卸载整棵树导致整页空白
class ErrorBoundary extends React.Component<{ children: React.ReactNode }, { error: Error | null }> {
  state: { error: Error | null } = { error: null }

  static getDerivedStateFromError(error: Error) {
    return { error }
  }

  render() {
    if (this.state.error) {
      return (
        <div className="page">
          <h1 className="page-title">页面出错了</h1>
          <p className="page-sub">{String(this.state.error.message || this.state.error)}</p>
          <div className="empty">
            <button
              className="ghost"
              onClick={() => {
                window.location.hash = '#/'
                this.setState({ error: null })
              }}
            >
              返回首页
            </button>
          </div>
        </div>
      )
    }
    return this.props.children
  }
}

export const App: React.FC = () => {
  const [hash, setHash] = useState(window.location.hash || '#/')
  useEffect(() => {
    const onChange = () => setHash(window.location.hash || '#/')
    window.addEventListener('hashchange', onChange)
    return () => window.removeEventListener('hashchange', onChange)
  }, [])
  useTextScaleShortcuts()
  const navigate = (p: string) => go(p.startsWith('#') ? p : '#' + p)

  const path = hash.replace(/^#/, '') || '/'
  const [pathname, query = ''] = path.split('?')
  const params = new URLSearchParams(query)
  const openUnit = (id: number, groupIndex?: number, number?: number) => navigate(openPath(id, groupIndex, number))
  const back = () => {
    if (window.history.length > 1) window.history.back()
    else navigate('/bank')
  }

  const unitMatch = /^\/u\/(\d+)(?:\/g\/(\d+))?$/.exec(pathname)
  const paperMatch = /^\/p\/(\d+)\/(listening|reading)$/.exec(pathname)
  // /writing?id=… 是写作 / 翻译的机考答题页；不带 id 时才是站点里的题目列表
  const writingId = pathname === '/writing' ? Number(params.get('id')) || null : null
  // 答题页进入机考模式：隐藏站点顶栏和页脚，把整屏交给考试界面
  const examMode = Boolean(unitMatch || paperMatch || writingId != null)
  const backToWritingList = () => {
    const q = new URLSearchParams(query)
    q.delete('id')
    const rest = q.toString()
    navigate('/writing' + (rest ? '?' + rest : ''))
  }
  let content: React.ReactNode
  if (paperMatch) {
    content = (
      <Practice
        key={`p${paperMatch[1]}:${paperMatch[2]}`}
        paper={{ paperId: Number(paperMatch[1]), module: paperMatch[2] as 'listening' | 'reading' }}
        onBack={back}
      />
    )
  } else if (unitMatch) {
    content = (
      <Practice
        key={`${unitMatch[1]}:${unitMatch[2] ?? 'all'}`}
        id={Number(unitMatch[1])}
        groupIndex={unitMatch[2] ? Number(unitMatch[2]) : null}
        focusNumber={Number(params.get('q')) || null}
        onBack={back}
      />
    )
  } else if (pathname === '/bank') {
    content = (
      <Column
        key="bank"
        initialExam={params.get('exam') || ''}
        initialModule={params.get('module') || ''}
        initialType={params.get('type') || ''}
        initialStatus={params.get('status') || 'all'}
        initialSort={params.get('sort') || 'path'}
        initialScope={params.get('scope') || 'group'}
        initialKeyword={params.get('kw') || ''}
        initialPage={Math.max(0, (Number(params.get('page')) || 1) - 1)}
        onOpen={openUnit}
      />
    )
  } else if (pathname === '/writing') {
    content = (
      <Writing
        key={writingId != null ? `writing-exam-${writingId}` : 'writing-list'}
        id={writingId ?? undefined}
        initialExam={params.get('ex') || ''}
        initialType={params.get('ty') || ''}
        initialKeyword={params.get('kw') || ''}
        initialPage={Math.max(0, (Number(params.get('p')) || 1) - 1)}
        onBack={backToWritingList}
      />
    )
  } else if (pathname === '/mock') {
    content = (
      <Mock
        onOpen={openUnit}
        onOpenPaper={(paperId, module) => navigate(`/p/${paperId}/${module}`)}
      />
    )
  } else if (pathname === '/records') {
    content = <Records onOpen={openUnit} />
  } else if (pathname === '/help') {
    content = <Help />
  } else {
    content = <Home navigate={navigate} />
  }

  const nav: [string, string][] = [
    ['/', '首页'],
    ['/bank', '题库'],
    ['/writing', '写作'],
    ['/mock', '模考'],
    ['/records', '记录'],
    ['/help', '说明'],
  ]

  return (
    <div className={'app' + (examMode ? ' app-exam' : '')}>
      {!examMode && (
        <header className="topbar">
          <a
            className="brand"
            href="https://github.com/H1DDENADM1N/IELTS-Simulator"
            target="_blank"
            rel="noopener noreferrer"
            title="Open the IELTS Simulator project on GitHub"
          >
            IELTS Simulator
          </a>
          <nav>
            {nav.map(([p, label]) => (
              <button
                key={p}
                className={pathname === p ? 'on' : ''}
                onClick={() => navigate(p)}
              >
                {label}
              </button>
            ))}
          </nav>
          <div className="topbar-tools">
            <FontFaceControl />
            <FontSizeControl />
          </div>
        </header>
      )}
      <main>
        <ErrorBoundary key={path}>{content}</ErrorBoundary>
      </main>
      {!examMode && <footer className="footer">纯本地运行 · 无账号 · 无联网 · 数据都在便携文件夹内</footer>}
    </div>
  )
}
