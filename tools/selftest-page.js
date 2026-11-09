// 第三层：在真实 Electron 窗口里跑的场景脚本。
// 这个文件不是 ESM —— 它是一个 async (config) => {...} 表达式，由 electron/main.cjs
// 读成字符串后注入页面执行。DOM / 交互一律按当前程序的类名与流程编写。
async (config) => {
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
  const assert = (condition, message) => { if (!condition) throw new Error(message) }
  const assertEqual = (actual, expected, label) => {
    if (actual !== expected) throw new Error(`${label}：期望 ${JSON.stringify(expected)}，实际 ${JSON.stringify(actual)}`)
  }
  const checks = []
  const check = async (group, name, fn) => {
    const started = Date.now()
    try {
      const detail = await fn()
      if (detail && typeof detail === 'object' && detail.skip) {
        checks.push({ group, name, ok: true, skipped: true, detail: detail.reason, ms: Date.now() - started })
      } else {
        checks.push({ group, name, ok: true, detail, ms: Date.now() - started })
      }
    } catch (error) {
      checks.push({ group, name, ok: false, detail: String(error?.message || error), ms: Date.now() - started })
    }
  }

  const pageErrors = []
  window.addEventListener('error', (e) => pageErrors.push(String(e.message || e)))
  window.addEventListener('unhandledrejection', (e) => pageErrors.push(String(e.reason || e)))

  const $ = (sel) => document.querySelector(sel)
  const $$ = (sel) => [...document.querySelectorAll(sel)]
  const byText = (sel, text) => $$(sel).find((el) => (el.textContent || '').includes(text))
  const click = (el, label) => {
    assert(el, `找不到元素：${label}`)
    el.click()
    return el
  }
  const waitFor = async (pred, label, timeout = 10000) => {
    const started = Date.now()
    for (;;) {
      let hit = null
      try { hit = typeof pred === 'function' ? pred() : $(pred) } catch { /* 还没渲染 */ }
      if (hit) return hit
      if (Date.now() - started > timeout) throw new Error(`等待超时：${label}`)
      await sleep(100)
    }
  }
  const go = async (hash, ready, label, timeout = 12000) => {
    window.location.hash = hash
    await waitFor(
      () => window.location.hash === hash && (typeof ready === 'function' ? ready() : $(ready)),
      label || hash,
      timeout,
    )
    await sleep(220)
  }
  // React 受控组件要用原生 setter 改 value，再派发 input/change
  const setValue = (el, value) => {
    const proto = el.tagName === 'TEXTAREA'
      ? HTMLTextAreaElement.prototype
      : el.tagName === 'SELECT'
        ? HTMLSelectElement.prototype
        : HTMLInputElement.prototype
    Object.getOwnPropertyDescriptor(proto, 'value').set.call(el, value)
    el.dispatchEvent(new Event('input', { bubbles: true }))
    el.dispatchEvent(new Event('change', { bubbles: true }))
  }
  const readStore = () => {
    try { return JSON.parse(localStorage.getItem('ielts-sim-store-v1') || '{}') } catch { return {} }
  }
  const storeKey = String(config.practiceUnitId)

  try {
    // ── 启动与离线 ────────────────────────────────────────────────
    await check('启动', '题库加载与首页统计', async () => {
      await waitFor(() => $('.stats'), '首页统计', 20000)
      assert(!$('.boot-error'), `启动失败：${$('.boot-error')?.innerText || ''}`)
      const stats = $$('.stats .stat strong').map((el) => Number(el.textContent.trim()))
      assertEqual(stats[0], config.realUnits, '练习篇目')
      assertEqual(stats[1], config.writingCount, '写作题')
      assertEqual(stats[2], config.papersCount, '模考卷')
      assertEqual(stats[3], config.audioCount, '带音频')
      assert($$('.tiles .tile').length === 8, '首页入口磁贴应有 8 个')
      return { stats: stats.slice(0, 4) }
    })

    await check('启动', '顶栏导航与字体 / 字号控件', () => {
      const labels = $$('.topbar nav button').map((el) => el.textContent.trim())
      assertEqual(labels.join(','), '首页,题库,写作,模考,记录,说明', '导航项')
      assertEqual($$('.font-pick select option').length, 3, '字体选项')
      assertEqual($('.font-ctl-val')?.textContent.trim(), '100%', '默认字号')
      assert($('.footer')?.textContent.includes('无联网'), '页脚离线说明')
      return { labels }
    })

    await check('启动', '离线 CSP 与单文件页面', () => {
      const csp = $('meta[http-equiv="Content-Security-Policy"]')?.getAttribute('content') || ''
      assert(csp.includes("connect-src 'none'") && csp.includes("default-src 'none'"), 'CSP 缺离线指令')
      assertEqual(location.protocol, 'file:', '页面协议')
      assertEqual($$('script[src]').length, 0, '外链脚本')
      const remote = performance.getEntriesByType('resource').filter((r) => /^https?:/i.test(r.name))
      assertEqual(remote.length, 0, '外部资源请求')
      return { csp: csp.slice(0, 90) }
    })

    await check('启动', '所有对外请求被拦截', async () => {
      const outcomes = []
      for (const url of ['http://127.0.0.1:9/blocked', 'https://example.com/selftest']) {
        const outcome = await Promise.race([
          fetch(url).then(() => 'ALLOWED', () => 'BLOCKED'),
          sleep(2500).then(() => 'TIMEOUT'),
        ])
        outcomes.push(`${url} -> ${outcome}`)
      }
      assert(outcomes.every((o) => o.endsWith('BLOCKED')), `出现放行/超时：${outcomes.join(' | ')}`)
      return outcomes
    })

    await check('启动', 'localStorage 可读写', () => {
      localStorage.setItem('__selftest', '1')
      assertEqual(localStorage.getItem('__selftest'), '1', '写入')
      localStorage.removeItem('__selftest')
      assertEqual(localStorage.getItem('__selftest'), null, '删除')
      return 'ok'
    })

    await check('启动', 'preload 只读接口与路径校验', async () => {
      const api = window.ieltsSim
      assert(api && ['readJson', 'readUnit', 'mediaUrl'].every((k) => typeof api[k] === 'function'), 'bridge 不完整')
      const [rawUnits, rawPapers, rawWriting] = await Promise.all([
        api.readJson('units-index'), api.readJson('papers-index'), api.readJson('writing-tasks'),
      ])
      assertEqual(JSON.parse(rawUnits).length, config.realUnits + config.mockUnits, '索引条数')
      assertEqual(JSON.parse(rawPapers).length, config.papersCount, '模考卷数')
      assertEqual(JSON.parse(rawWriting).length, config.writingCount, '写作题数')
      const unit = JSON.parse(await api.readUnit(config.practiceUnitId))
      assertEqual(unit.id, config.practiceUnitId, '单篇 id')
      assertEqual(unit.groups.length, config.practiceGroups, '单篇题组数')
      let badId = ''
      try { await api.readUnit(-1) } catch (error) { badId = String(error.message || error) }
      assert(badId.includes('非法'), `非整数编号未被拒绝：${badId}`)
      // 路径片段被主进程剥掉：../units-index 与 units-index 必须读到同一个文件
      const sanitized = JSON.parse(await api.readJson('../units-index'))
      assertEqual(sanitized.length, config.realUnits + config.mockUnits, '路径穿越应被剥离成普通文件名')
      let escaped = false
      try { await api.readJson('../../etc/passwd') } catch { escaped = true }
      assert(escaped, 'readJson 不应读到 data/ 之外的文件')
      return { unit: config.practiceUnitId, groups: unit.groups.length }
    })

    await check('启动', '媒体 URL 指向本地 data/media', () => {
      const url = decodeURIComponent(window.ieltsSim.mediaUrl(config.audioFilename))
      assert(url.startsWith('file:') && url.includes(config.audioFilename), `媒体 URL 异常：${url}`)
      return url.slice(-70)
    })

    // ── 首页控件 ──────────────────────────────────────────────────
    await check('控件', '字号按钮、快捷键与持久化', async () => {
      const buttons = $$('.font-ctl button')
      assertEqual(buttons.length, 3, '字号按钮数')
      click(buttons[2], 'A+')
      await waitFor(() => $('.font-ctl-val')?.textContent.trim() === '110%', '放大到 110%')
      assertEqual(localStorage.getItem('ielts-sim-text-scale'), '1.1', '字号持久化')
      window.dispatchEvent(new KeyboardEvent('keydown', { key: '=', ctrlKey: true, bubbles: true }))
      await waitFor(() => $('.font-ctl-val')?.textContent.trim() === '120%', 'Ctrl + 放大')
      assertEqual(getComputedStyle(document.documentElement).getPropertyValue('--text-scale').trim(), '1.2', 'CSS 变量')
      click($('.font-ctl-val'), '恢复默认字号')
      await waitFor(() => $('.font-ctl-val')?.textContent.trim() === '100%', '恢复 100%')
      return 'ok'
    })

    await check('控件', '字体切换写入 html 与 localStorage', async () => {
      const select = $('.font-pick select')
      setValue(select, 'exam')
      await waitFor(() => document.documentElement.dataset.font === 'exam', '切到卷面衬线')
      assertEqual(localStorage.getItem('ielts-sim-font-face-v2'), 'exam', '字体持久化')
      setValue(select, 'arial')
      await waitFor(() => document.documentElement.dataset.font === 'arial', '切回 Arial')
      return 'ok'
    })

    // ── 题库页 ────────────────────────────────────────────────────
    await check('题库', '列表、分页与三栏布局', async () => {
      await go('#/bank', '.row', '题库列表')
      const rows = $$('.row').length
      assert(rows > 0 && rows <= 20, `首屏行数异常：${rows}`)
      assert($('.pager'), '缺分页控件')
      assert($('.bank-side') && $('.bank-main') && $('.bank-rail'), '缺三栏布局')
      return { rows }
    })

    await check('题库', '考试筛选写回地址栏', async () => {
      click(byText('.bank .filter-row .chip', '雅思'), '雅思筛选')
      await waitFor(() => location.hash.includes('exam=ielts'), '筛选写入 hash')
      assert(byText('.bank .filter-row .chip', '雅思')?.classList.contains('on'), '筛选高亮')
      return location.hash
    })

    await check('题库', '标题搜索与清空', async () => {
      setValue($('.search'), config.keyword)
      await waitFor(() => location.hash.includes('kw='), '搜索写入 hash')
      await sleep(300)
      const found = Number($('.list-meta b')?.textContent.trim())
      assert(found > 0 && found <= 20, `搜索结果异常：${found}`)
      assertEqual($$('.row').length, found, '搜索结果行数')
      click($('.search-clear'), '清空搜索')
      await waitFor(() => $('.search').value === '', '搜索框清空')
      return { keyword: config.keyword, found }
    })

    await check('题库', '题组 / 整篇切换与重置筛选', async () => {
      click(byText('.bank-side .side-line', '整篇练'), '整篇练')
      await waitFor(() => location.hash.includes('scope=unit'), '整篇写回 hash')
      assert(byText('.bank-side .side-line', '整篇练')?.classList.contains('on'), '整篇高亮')
      click($('.bank-head-actions .ghost'), '重置筛选')
      await waitFor(() => !location.hash.includes('kw=') && !location.hash.includes('exam='), '筛选清空')
      assertEqual($('.search').value, '', '搜索框')
      click(byText('.bank-side .side-line', '按题组练'), '按题组练')
      await waitFor(() => !location.hash.includes('scope=unit'), '切回题组')
      return location.hash
    })

    await check('题库', '列表行可进入答题页', async () => {
      click($('.row'), '首条题目')
      await waitFor(() => $('.exam-shell'), '答题页挂载', 15000)
      assert(location.hash.startsWith('#/u/'), `路由异常：${location.hash}`)
      return location.hash
    })

    // ── 写作页 ────────────────────────────────────────────────────
    await check('写作', '题目列表与筛选', async () => {
      await go('#/writing', '.cards .card', '写作页')
      assert($('.page-sub')?.textContent.includes(String(config.writingCount)), '写作题总数')
      assert($$('.cards .card').length > 0, '题目卡片')
      assert($$('.filters .chip').length >= 8, '筛选按钮')
      return { cards: $$('.cards .card').length }
    })

    // 写作 / 翻译题点开后进入全屏机考界面（#/writing?id=…），不再是站内详情页
    const enterWritingExam = async () => {
      await go('#/writing', '.cards .card', '写作页')
      click($('.cards .card'), '第一道写作题')
      await waitFor(
        () => window.location.hash.includes('id=') && $('.exam-shell.wr-shell'),
        '写作机考界面',
        12000,
      )
      const ok = $('.start-overlay .btn-ok')
      if (ok) click(ok, 'OK')
      await waitFor(() => $('.wr-answer') && !$('.start-overlay'), '写作输入框')
      await sleep(120)
      return window.location.hash
    }

    const draftText = 'Self test draft'
    await check('写作', '机考界面结构（顶栏 / 分栏 / 底栏）', async () => {
      const hash = await enterWritingExam()
      assert(hash.includes('id='), `路由异常：${hash}`)
      assert($('.app.app-exam'), '站点外壳应切到机考模式')
      assert(!$('header.topbar') && !$('.footer'), '站点顶栏与页脚应隐藏')
      assert(byText('.top-bar .btn.end-button', 'Finish test'), 'Finish test 按钮')
      assert($('.wr-rubric h3')?.textContent.includes('Part'), 'Part 说明框')
      assert($('.wr-prompt-pane') && $('.wr-answer-pane'), '左题目 / 右输入分栏')
      assert($('.stage .split'), '可拖分隔条')
      assert($('.word-count'), 'Word count')
      assertEqual($$('.arrows .nav-arrow').length, 2, '上一题 / 下一题箭头')
      assert($$('.wr-part-group').length >= 1, '底栏 Part 分组')
      return hash
    })

    await check('写作', '草稿自动保存到本机与实时字数', async () => {
      const id = $('.wr-answer').dataset.taskId
      setValue($('.wr-answer'), draftText)
      await waitFor(() => $('.word-count')?.textContent.includes('Word count: 3'), '词数统计')
      await waitFor(() => readStore().drafts?.[id] === draftText, '草稿写入 localStorage', 6000)
      return { words: 3, id }
    })

    await check('写作', '离开再回来草稿仍在', async () => {
      await go('#/', '.stats', '回到首页')
      await enterWritingExam()
      assertEqual($('.wr-answer').value, draftText, '恢复的草稿')
      return 'ok'
    })

    await check('写作', 'Part 切换后两篇草稿互不干扰', async () => {
      const jump = $('.wr-part-group .qpart-jump')
      assert(jump, '应存在另一个 Part')
      const firstId = $('.wr-answer').dataset.taskId
      click(jump, '切到另一个 Part')
      await waitFor(() => $('.wr-answer')?.dataset.taskId !== firstId, '切到另一道题')
      const otherId = $('.wr-answer').dataset.taskId
      assertEqual($('.wr-answer').value, '', '另一 Part 应为空草稿')
      setValue($('.wr-answer'), 'Second part draft')
      await waitFor(() => readStore().drafts?.[otherId] === 'Second part draft', '第二篇草稿落盘', 6000)
      click($('.wr-part-group .qpart-jump'), '切回原 Part')
      await waitFor(() => $('.wr-answer')?.dataset.taskId === firstId, '切回原题')
      assertEqual($('.wr-answer').value, draftText, '原草稿未丢')
      return { firstId, otherId }
    })

    await check('写作', '范文面板与清空草稿', async () => {
      if (!$('.ex-tools')) {
        click($('[aria-label="Options"]'), 'Options')
        await waitFor(() => $('.options-menu'), 'Options 菜单')
        const pm = byText('.options-menu button', 'Practice mode')
        if (pm && pm.textContent.includes('Off')) click(pm, '打开练习模式')
        await waitFor(() => $('.ex-tools'), '练习工具条')
      }
      click(byText('.ex-tools .ex-link', 'Model answer'), '范文按钮')
      await waitFor(() => $('.wr-sample-dialog'), '范文面板')
      click(byText('.wr-sample-dialog .ex-dialog-foot .ex-btn', 'Close'), '关闭范文')
      await waitFor(() => !$('.wr-sample-dialog'), '范文关闭')
      const id = $('.wr-answer').dataset.taskId
      click(byText('.ex-tools .ex-link', 'Clear draft'), '清空草稿')
      await waitFor(() => $('.wr-answer').value === '', '输入框清空')
      await waitFor(() => !readStore().drafts?.[id], '草稿未从 localStorage 清除', 6000)
      return 'ok'
    })

    await check('写作', '交卷锁定答案并退出练习', async () => {
      click(byText('.top-bar .btn.end-button', 'Finish test'), 'Finish test')
      await waitFor(() => $('.ex-dialog'), '交卷确认')
      click(byText('.ex-dialog-foot .ex-btn.primary', 'Finish test'), '确认交卷')
      await waitFor(() => $('.ex-report'), '结束面板')
      click(byText('.ex-report .ex-btn.primary', 'Review answers'), '回看答案')
      await waitFor(() => $('.wr-answer')?.readOnly, '交卷后输入区锁定')
      click($('[aria-label="Options"]'), 'Options')
      await waitFor(() => $('.options-menu'), 'Options 菜单')
      click(byText('.options-menu button', 'Exit practice'), '退出练习')
      await waitFor(() => $('.ex-dialog') || $('.cards .card'), '退出确认或列表')
      const exitBtn = byText('.ex-dialog-foot .ex-btn', 'Exit')
      if (exitBtn) click(exitBtn, '确认退出')
      await waitFor(() => $('.cards .card'), '回到题目列表')
      return 'ok'
    })

    // ── 模考页 ────────────────────────────────────────────────────
    await check('模考', '卷子列表与整卷入口', async () => {
      await go('#/mock', '.card-static', '模考页')
      assertEqual($$('.card-static').length, config.papersCount, '模考卷数')
      assert(byText('.mock-paper-actions .ghost', '听力整卷'), '缺听力整卷入口')
      assert(byText('.mock-paper-actions .ghost', '阅读整卷'), '缺阅读整卷入口')
      return { papers: config.papersCount }
    })

    await check('模考', '逐篇展开单元', async () => {
      click(byText('.card-static .link-btn', '或者逐篇练'), '逐篇练')
      await waitFor(() => $('.mock-unit'), '模考单元列表')
      assert($$('.mock-unit').length >= 7, '一套卷应有 7 个单元')
      return { units: $$('.mock-unit').length }
    })

    await check('模考', '听力整卷按 Part 串联', async () => {
      click(byText('.card-static .mock-paper-actions .ghost', '听力整卷'), '听力整卷')
      const hash = `#/p/${config.paperId}/listening`
      await waitFor(
        () => location.hash === hash && $$('.qparts .qpart').length === config.paperListeningParts,
        '听力整卷 4 个 Part',
        18000,
      )
      assert($('.end-button')?.textContent.includes('Finish test'), '缺结束按钮')
      assert($('.rubric')?.textContent.includes('Part'), '缺机考说明条')
      return { parts: config.paperListeningParts }
    })

    // 回归：整卷听力点底栏切 Part，只换题目，不能换 <audio> 的 src（换 src 会 pause + 归零）
    await check('音频', '整卷切 Part 不打断录音', async () => {
      const hash = `#/p/${config.paperId}/listening`
      await go(hash, '.qparts .qpart', '听力整卷', 18000)
      const ok = $('.start-overlay .btn-ok')
      if (ok) click(ok, 'OK')
      const player = await waitFor(() => $('audio.ex-audio-el'), '整卷录音元素', 12000)
      await new Promise((resolve) => {
        if (player.readyState >= 1 && Number.isFinite(player.duration) && player.duration > 3) return resolve()
        let done = false
        const finish = () => { if (done) return; done = true; clearTimeout(timer); resolve() }
        const timer = setTimeout(finish, 9000)
        player.addEventListener('loadedmetadata', finish, { once: true })
        player.addEventListener('error', finish, { once: true })
      })
      const src0 = player.getAttribute('src') || ''
      assert(src0.includes('.mp3'), `整卷录音地址异常：${src0}`)
      if (Number.isFinite(player.duration) && player.duration > 3) player.currentTime = 2
      // 没有用户手势时自动播放可能被策略拦下，这里不强依赖真的出声，只保证状态不被切 Part 破坏
      try { await player.play() } catch { /* 自动播放策略 */ }
      const before = { src: player.getAttribute('src'), paused: player.paused, time: player.currentTime }
      const jump = $$('.qparts .qpart-jump').find((el) => (el.textContent || '').includes('Part 3'))
        || $$('.qparts .qpart-jump')[1]
      click(jump, '底栏 Part 3')
      await waitFor(() => ($('.qparts .qpart.is-active')?.textContent || '').includes('Part 3'), '切到 Part 3', 8000)
      await sleep(400)
      assertEqual(player.getAttribute('src'), before.src, '切 Part 后录音地址')
      assertEqual(player.paused, before.paused, '切 Part 后播放状态')
      assert(player.currentTime >= before.time - 0.6,
        `切 Part 后播放进度被重置：${before.time} -> ${player.currentTime}`)
      return { srcUnchanged: true, paused: player.paused, time: Math.round(player.currentTime * 10) / 10 }
    })

    // 回归：一段录音放完后音频链自己前进；考生已经在预览别的 Part 时不把画面硬拉回来
    await check('音频', '整卷上一段放完自动接下一段', async () => {
      const player = await waitFor(() => $('audio.ex-audio-el'), '整卷录音元素', 8000)
      const src1 = player.getAttribute('src')
      const shown = ($('.qparts .qpart.is-active')?.textContent || '').trim()
      player.dispatchEvent(new Event('ended'))
      const next = await waitFor(() => {
        const el = $('audio.ex-audio-el')
        return el && el.getAttribute('src') !== src1 ? el : null
      }, '换到下一段录音', 8000)
      await sleep(900)
      assert(!next.paused, `下一段没有接着播：paused=${next.paused}`)
      assertEqual(($('.qparts .qpart.is-active')?.textContent || '').trim(), shown,
        '预览别的 Part 时画面不应被拉走')
      return { advanced: true, paused: next.paused, shown }
    })

    await check('模考', '阅读整卷按 Passage 串联', async () => {
      const hash = `#/p/${config.paperId}/reading`
      window.location.hash = hash
      await waitFor(
        () => location.hash === hash && $$('.qparts .qpart').length === config.paperReadingParts,
        '阅读整卷 3 个 Passage',
        18000,
      )
      return { parts: config.paperReadingParts }
    })

    // ── 记录页（空） / 说明页 ────────────────────────────────────
    await check('记录', '独立 profile 初始无成绩', async () => {
      await go('#/records', '.rec-list', '记录页')
      assert($$('.empty').some((el) => el.textContent.includes('还没有做题记录')), '应有空状态')
      assertEqual($$('.rec-row').length, 0, '成绩记录行数')
      assertEqual(Number($('.stats .stat strong')?.textContent.trim()), 0, '已练题组')
      return 'ok'
    })

    await check('说明', '使用说明各章节', async () => {
      await go('#/help', '.help-block', '说明页')
      assertEqual($$('.help-block').length, 7, '说明章节数')
      assert(document.body.innerText.includes('离线保证') && document.body.innerText.includes('快捷键'), '关键章节')
      return 'ok'
    })

    // ── 答题页（机考全流程） ─────────────────────────────────────
    await check('答题', '说明页进入机考开始界面', async () => {
      await go(`#/u/${config.practiceUnitId}`, '.exam-shell', '答题页', 18000)
      await waitFor(() => $('.start-overlay .btn-ok'), '开始按钮')
      assert($('.rubric')?.textContent.includes('Part'), '缺 Part 说明')
      assert($('.timer')?.textContent.includes('remaining'), '缺倒计时')
      assert($('.question-navigation'), '缺底栏题号')
      assert($$('.ex-questions [data-q]').length > 0, '题目未渲染')
      return { unit: config.practiceUnitId, title: config.practiceTitle }
    })

    await check('答题', '点 OK 开始、题号槽位齐全', async () => {
      click($('.start-overlay .btn-ok'), 'OK')
      await waitFor(() => !$('.start-overlay'), '开始遮罩消失')
      assertEqual($('.end-button')?.textContent.trim(), 'Finish test', '结束按钮')
      assertEqual($$('.arrows .nav-arrow').length, 2, '前后题箭头')
      assertEqual($$('.qnav-item button').length, config.practiceSlots, '题号槽位数')
      return { slots: config.practiceSlots }
    })

    await check('答题', '逐题作答并自动保存草稿', async () => {
      const fillField = (el) => {
        if (el.type === 'radio' || el.type === 'checkbox') { el.click(); return true }
        if (el.tagName === 'SELECT') {
          const option = [...el.options].find((o) => o.value)
          if (!option) return false
          setValue(el, option.value)
          return true
        }
        setValue(el, 'selftest')
        return true
      }
      let filled = 0
      for (const holder of $$('.ex-questions [data-q]')) {
        if (holder.matches('input, select, textarea')) {
          if (fillField(holder)) filled++
        } else {
          const controls = [...holder.querySelectorAll('input, select, textarea')].filter((el) => !el.disabled)
          for (const control of controls) {
            if (fillField(control)) { filled++; break }
          }
        }
      }
      assertEqual(filled, config.practiceQuestions, '作答题数')
      await waitFor(
        () => $$('.qnav-item button.answered').length >= config.practiceTotal,
        '题号标记为已答',
        6000,
      )
      await waitFor(() => {
        const draft = readStore().practice?.[storeKey]
        return draft && Object.keys(draft.answers || {}).length === config.practiceTotal && draft.total === config.practiceTotal
      }, '作答草稿落盘', 6000)
      return { filled }
    })

    await check('答题', 'Review 标记写入草稿', async () => {
      click($('.question-navigation .review'), 'Review 按钮')
      await waitFor(() => $('.review')?.getAttribute('aria-pressed') === 'true', '标记生效')
      assert($$('.qnav-item button.for-review').length > 0, '题号应变成待复查')
      await waitFor(() => readStore().practice?.[storeKey]?.marked?.length > 0, '标记落盘', 6000)
      return { marked: readStore().practice?.[storeKey]?.marked?.length }
    })

    await check('答题', 'Options 菜单与 Settings 面板', async () => {
      click($('[aria-label="Options"]'), 'Options')
      await waitFor(() => $('.options-menu'), 'Options 菜单')
      const text = $('.options-menu').textContent
      for (const item of ['Settings', 'Hide screen', 'Help', 'Practice mode', 'Exit practice']) {
        assert(text.includes(item), `菜单缺 ${item}`)
      }
      click(byText('.options-menu [role="menuitem"]', 'Settings'), 'Settings')
      await waitFor(() => $('.ex-settings'), 'Settings 面板')
      assert($$('.ex-settings .ex-set-row').length >= 8, '设置项数量')
      click(byText('.ex-settings .ex-seg button', 'Large'), 'Large 字号')
      await waitFor(() => document.documentElement.style.getPropertyValue('--text-scale') === '1.2', '字号 1.2')
      click(byText('.ex-settings .ex-seg button', 'Standard'), 'Standard 字号')
      await waitFor(() => document.documentElement.style.getPropertyValue('--text-scale') === '1', '字号 1')
      const row = $$('.ex-settings .ex-set-row').find((r) => r.textContent.includes('Practice mode'))
      const checkbox = row?.querySelector('input[type="checkbox"]')
      assert(checkbox, '缺练习模式开关')
      if (!checkbox.checked) checkbox.click()
      await waitFor(() => {
        try { return JSON.parse(localStorage.getItem('ielts-sim-exam-prefs-v1') || '{}').practiceMode === true }
        catch { return false }
      }, '练习模式持久化')
      click($('.ex-settings .ex-dialog-foot .ex-btn.primary'), '关闭 Settings')
      await waitFor(() => !$('.ex-settings'), 'Settings 关闭')
      await waitFor(() => $('.ex-tools'), '练习工具条出现')
      return 'ok'
    })

    await check('答题', '题目 / 分栏 / 原文切换', async () => {
      assertEqual($$('.ex-tabs button').length, 3, '视图切换按钮')
      const split = byText('.ex-tabs button', 'Split')
      assert(split && !split.disabled, 'Split 应可用')
      click(split, 'Split')
      await waitFor(() => $('.stage.pane-both'), '分栏视图')
      assert($('.source-pane .ex-source'), '原文面板')
      click(byText('.ex-tabs button', 'Passage'), 'Passage')
      await waitFor(() => $('.stage.pane-source'), '原文视图')
      click(byText('.ex-tabs button', 'Questions'), 'Questions')
      await waitFor(() => $('.stage.pane-questions'), '题目视图')
      return 'ok'
    })

    await check('答题', 'Notes 面板与 Hide screen', async () => {
      click($('[aria-label="Notes"]'), 'Notes')
      await waitFor(() => $('.notes-panel'), 'Notes 面板')
      assert($('.notes-empty'), '空笔记提示')
      click($('.close-notes'), '关闭 Notes')
      await waitFor(() => !$('.notes-panel'), 'Notes 关闭')
      click($('[aria-label="Options"]'), 'Options')
      await waitFor(() => $('.options-menu'), 'Options 菜单')
      click(byText('.options-menu [role="menuitem"]', 'Hide screen'), 'Hide screen')
      await waitFor(() => $('.ex-hidden'), '遮屏')
      assert($('.ex-hidden').textContent.includes('clock is still running'), '计时继续提示')
      click(byText('.ex-hidden .ex-btn', 'Resume test'), 'Resume test')
      await waitFor(() => !$('.ex-hidden'), '恢复卷面')
      return 'ok'
    })

    await check('答题', '底栏题号跳转与倒计时', async () => {
      const buttons = $$('.qnav-item button')
      const lastButton = buttons[buttons.length - 1]
      const number = Number(lastButton.textContent.trim())
      click(lastButton, `第 ${number} 题`)
      await waitFor(() => $('.qnav-item button.current')?.textContent.trim() === String(number), '当前题高亮')
      assert($('.nav-arrow[aria-label="Next question"]').disabled, '最后一题应禁用下一题')
      assert($('.timer .not-precise')?.textContent.includes('remaining'), '倒计时文案')
      return { current: number }
    })

    await check('答题', 'Finish test 确认与成绩报告', async () => {
      click($('.end-button'), 'Finish test')
      await waitFor(() => $('.ex-dialog')?.textContent.includes('Finish test?'), '交卷确认弹窗')
      assert($('.ex-dialog-body')?.textContent.includes('You have answered'), '已答题数提示')
      click($('.ex-dialog-foot .ex-btn.primary'), '确认交卷')
      await waitFor(() => $('.ex-report'), '成绩报告', 10000)
      const score = Number($('.ex-report-score b')?.textContent.trim())
      assert(Number.isFinite(score) && score >= 0 && score <= config.practiceTotal, `分数异常：${score}`)
      assert($('.ex-report-score span')?.textContent.includes(String(config.practiceTotal)), '总分应与题量一致')
      assert($('.ex-report-stats')?.textContent.includes('Answered'), '统计区')
      return { score, total: config.practiceTotal }
    })

    await check('答题', '答案解析、成绩落盘与重考', async () => {
      click(byText('.ex-report .ex-dialog-foot .ex-btn.primary', 'Review answers'), 'Review answers')
      await waitFor(() => !$('.ex-report'), '报告关闭')
      assert($('.result-bar'), '练习模式成绩条')
      assert($('.ex-explain') || $('.ex-inline-review'), '答案与解析')
      assertEqual($('.end-button')?.textContent.trim(), 'Retake test', '结束按钮')
      await waitFor(() => {
        const attempt = readStore().attempts?.[storeKey]
        return attempt && attempt.total === config.practiceTotal && Array.isArray(attempt.wrong) && attempt.types
      }, '成绩写入 localStorage', 6000)
      assert(!readStore().practice?.[storeKey], '交卷后应清除作答草稿')
      click($('.end-button'), 'Retake test')
      await waitFor(
        () => !$('.result-bar') && $$('.qnav-item button.answered').length === 0,
        '重考清空作答',
        8000,
      )
      assertEqual($('.end-button')?.textContent.trim(), 'Finish test', '重考后按钮')
      return 'ok'
    })

    // ── 音频 ─────────────────────────────────────────────────────
    await check('音频', '听单元音频加载与控件', async () => {
      const hash = `#/u/${config.audioUnitId}?q=${config.audioFirstQuestion}`
      await go(hash, 'audio.ex-audio-el', '听单元音频', 18000)
      const player = $('audio.ex-audio-el')
      const src = decodeURIComponent(player.getAttribute('src') || '')
      assert(src.startsWith('file:') && src.includes(config.audioFilename), `音频地址异常：${src}`)
      await new Promise((resolve) => {
        if (player.readyState >= 1 && Number.isFinite(player.duration) && player.duration > 0) return resolve()
        let done = false
        const finish = () => { if (done) return; done = true; clearTimeout(timer); resolve() }
        const timer = setTimeout(finish, 9000)
        player.addEventListener('loadedmetadata', finish, { once: true })
        player.addEventListener('error', finish, { once: true })
        player.load()
      })
      assert(Number.isFinite(player.duration) && player.duration > 0, `音频时长无效：${player.duration}`)
      assert(!player.error, `音频解码错误：${player.error?.code}`)
      assert(player.paused, '自检不应自动播放录音')
      assert($('.ex-audio-time')?.textContent.includes(':'), '播放器时长显示')
      assertEqual($$('.ex-rates button').length, 4, '倍速按钮')
      return { duration: Math.round(player.duration), file: config.audioFilename }
    })

    // ── 记录页（交卷后） ─────────────────────────────────────────
    await check('记录', '交卷后成绩与错题可见', async () => {
      await go('#/records', '.rec-list', '记录页')
      await waitFor(() => $('.rec-row'), '成绩记录行', 8000)
      assert($$('.rec-row').length >= 1, '应有成绩记录')
      assert(Number($('.stats .stat strong')?.textContent.trim()) >= 1, '已练题组统计')
      assert($('.rec-score')?.textContent.includes(String(config.practiceTotal)), '记录总分')
      assert($('.wrong-chip') || $('.rec-allok'), '错题 / 全对标记')
      return { rows: $$('.rec-row').length }
    })

    await check('记录', '错题 chip 跳回对应题号', async () => {
      const chip = $('.wrong-chip')
      if (!chip) return { skip: true, reason: '本次作答恰好全对，没有错题可跳' }
      const number = chip.textContent.trim()
      click(chip, `错题 ${number}`)
      await waitFor(() => location.hash.includes('?q=') && $('.exam-shell'), '跳回答题页', 15000)
      assert(location.hash.includes(`#/u/${config.practiceUnitId}`), `跳错单元：${location.hash}`)
      return location.hash
    })

    // ── 全局 ─────────────────────────────────────────────────────
    await check('全局', '运行期无未捕获异常', () => {
      assertEqual(pageErrors.length, 0, `页面异常：${pageErrors.join(' | ')}`)
      assert(!$('.boot-error'), '启动失败页')
      assert(!document.body.innerText.includes('页面出错了'), 'ErrorBoundary 兜底页')
      return { errors: 0 }
    })
  } catch (error) {
    checks.push({ group: '场景', name: '脚本未捕获异常', ok: false, detail: String(error?.stack || error), ms: 0 })
  }

  return {
    checks,
    meta: {
      title: document.title,
      protocol: location.protocol,
      finalHash: location.hash,
      userAgent: navigator.userAgent,
      pageErrors,
    },
  }
}
