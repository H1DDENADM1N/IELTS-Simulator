// 第二层：把 app/src/lib 下的纯逻辑模块临时转译成 CommonJS，在 Node 里逐项断言。
// 用本地 typescript 依赖，不新增测试框架；浏览器 API 用最小替身，跑完只留在 .local/。
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import path from 'node:path'
import ts from 'typescript'
import { assert, assertDeep, assertEqual, createSuite } from './selftest-common.mjs'

const require = createRequire(import.meta.url)

/** 最小浏览器替身：localStorage / documentElement / 只读取本地文件的 bridge */
function installGlobals(dataDir) {
  const mem = new Map()
  globalThis.localStorage = {
    getItem: (k) => (mem.has(String(k)) ? mem.get(String(k)) : null),
    setItem: (k, v) => mem.set(String(k), String(v)),
    removeItem: (k) => mem.delete(String(k)),
    clear: () => mem.clear(),
    key: (i) => [...mem.keys()][i] ?? null,
    get length() { return mem.size },
  }
  const style = {
    setProperty(k, v) { this[k] = v },
    getPropertyValue(k) { return this[k] || '' },
  }
  globalThis.document = { documentElement: { style, dataset: {} } }
  globalThis.window = {
    ieltsSim: {
      readJson: async (name) => readFileSync(path.join(dataDir, `${name}.json`), 'utf8'),
      readUnit: async (id) => readFileSync(path.join(dataDir, 'units', `${id}.json`), 'utf8'),
      mediaUrl: (name) => `file:///data/media/${name}`,
    },
  }
  return mem
}

/** 转译 lib/*.ts → .local/selftest-logic/*.js（CommonJS），返回模块加载函数 */
function compileLibs(root) {
  const srcDir = path.join(root, 'app', 'src', 'lib')
  const outDir = path.join(root, '.local', 'selftest-logic')
  mkdirSync(outDir, { recursive: true })
  writeFileSync(path.join(outDir, 'package.json'), '{"type":"commonjs"}\n')
  for (const file of readdirSync(srcDir).filter((f) => f.endsWith('.ts'))) {
    const source = readFileSync(path.join(srcDir, file), 'utf8')
    const result = ts.transpileModule(source, {
      fileName: file,
      compilerOptions: {
        module: ts.ModuleKind.CommonJS,
        target: ts.ScriptTarget.ES2022,
        esModuleInterop: true,
      },
    })
    writeFileSync(path.join(outDir, file.replace(/\.ts$/, '.js')), result.outputText)
  }
  for (const filename of Object.keys(require.cache)) {
    if (filename.startsWith(outDir)) delete require.cache[filename]
  }
  return (name) => require(path.join(outDir, `${name}.js`))
}

export async function runLogicChecks(ctx) {
  const suite = createSuite('逻辑')
  const { root, dataDir, config } = ctx
  installGlobals(dataDir)
  let load
  try {
    load = compileLibs(root)
  } catch (error) {
    suite.checks.push({ group: '逻辑', name: `转译 app/src/lib 失败：${error.message}`, ok: false, detail: String(error.stack || error), ms: 0 })
    return suite.checks
  }

  const scoring = load('scoring')
  const dictation = load('dictation')
  const grading = load('grading')
  const bank = load('bank')
  const exam = load('exam')
  const store = load('store')
  const textscale = load('textscale')
  const fontface = load('fontface')

  await suite.check('判分：规范化、答案行、可选词、数字词', () => {
    assertEqual(scoring.normalize('  HELLO.  '), 'hello', 'normalize')
    assertDeep(scoring.answerLines('A\n\n B \n'), ['A', 'B'], 'answerLines')
    assertDeep(scoring.expandOptional('(the) river bank'), ['river bank', 'the river bank'], 'expandOptional')
    assertEqual(scoring.numberToWords(21), 'twenty-one', '21')
    assertEqual(scoring.numberToWords(105), 'one hundred and five', '105')
    assertEqual(scoring.countWords('a big red apple'), 4, 'countWords')
    assertEqual(scoring.countWords('4 apples', true), 1, 'countWords(numberAllowed)')
    return 'ok'
  })

  await suite.check('判分：等价答案放宽规则', () => {
    const ok = (r, a, type = 'completion', extra = {}) => assert(scoring.isCorrect(r, a, { type, ...extra }), `应判对：${r} / ${a}`)
    ok('12', 'twelve')
    ok('fifteen', '15')
    ok('twenty-one', '21')
    ok('50%', '50 percent')
    ok('cost-effective', 'cost effective')
    ok('colour', 'color')
    ok('river bank', '(the) river bank')
    ok('true', 'TRUE', 'tfng')
    assert(!scoring.isCorrect('FALSE', 'TRUE', { type: 'tfng' }), '错误选项不应判对')
    assert(!scoring.isCorrect('', 'A', { type: 'tfng' }), '空答案不应判对')
    return 'ok'
  })

  await suite.check('判分：字数上限与多选计分', () => {
    assert(!scoring.isCorrect('a very long answer', 'short', { type: 'completion', maxWords: 2 }), '超字数不应判对')
    assertEqual(scoring.scoreMulti(['A', 'C', 'X'], 'A\nB\nC'), 2, 'scoreMulti')
    assertEqual(scoring.scoreMulti(['A', 'A'], 'A\nB'), 1, 'scoreMulti 去重')
    assertEqual(scoring.scoreMulti([], 'A\nB'), 0, 'scoreMulti 空答案')
    return 'ok'
  })

  await suite.check('听写：缩写、数字、英美拼写规范化', () => {
    assertDeep(dictation.canon("I can't go").map((t) => t.t), ['i', 'can', 'not', 'go'], 'canon 缩写')
    assertDeep(dictation.canon('twenty one apples').map((t) => t.t), ['21', 'apples'], 'canon 数字词')
    assertEqual(dictation.spell('colour'), 'color', 'spell colour')
    assertEqual(dictation.spell('centre'), 'center', 'spell centre')
    assert(dictation.checkWord('colour', 'color'), 'checkWord 英美拼写')
    assert(!dictation.checkWord('colour', 'red'), 'checkWord 不同词')
    return 'ok'
  })

  await suite.check('听写：LCS 对齐与挖空', () => {
    const same = dictation.compare('the quick brown fox', 'the quick brown fox')
    assert(same.ok && same.extra.length === 0, '完全一致应全部 ok')
    const diff = dictation.compare('the quick brown fox', 'the quick red fox')
    assert(!diff.ok, '有错词时 ok 应为 false')
    assert(diff.words.some((w) => w.status === 'wrong' || w.status === 'missing'), '错词应被标出')
    assert(dictation.compare('I have 20 apples', 'I have twenty apples').ok, '数字写法应等价')
    const text = 'The amazing telescope observes distant galaxies'
    const blanks = dictation.pickBlanks(text, ['galaxies'])
    assert(blanks.length > 0 && blanks.length <= 3, '每句最多挖 3 个空')
    assert(blanks.includes(text.split(/\s+/).indexOf('galaxies')), '答案词应优先被挖空')
    return { blanks }
  })

  await suite.check('题型与交卷判分：grade / evidenceNumbers', () => {
    assertDeep(grading.FIXED_OPTIONS.tfng.map((o) => o.key), ['TRUE', 'FALSE', 'NOT GIVEN'], '判断题固定选项')
    assertDeep(grading.optionsFor({ type: 'tfng' }, {}).map((o) => o.key), ['TRUE', 'FALSE', 'NOT GIVEN'], 'optionsFor')
    assert(grading.usesTextInput({ type: 'completion' }, {}), '填空题应使用文本框')
    assert(!grading.usesTextInput({ type: 'matching_information' }, { passage: [] }), '信息匹配不应退化成文本框')
    assertDeep([...grading.evidenceNumbers('9, 12-14')], [9, 12, 13, 14], 'evidenceNumbers')
    const unit = {
      id: 1, module: 'reading', exam: 'ielts', title: 'fake',
      groups: [
        { type: 'tfng', questions: [{ number: 1, answers: 'TRUE' }] },
        { type: 'completion', questions: [{ number: 2, answers: '(the) river bank' }] },
        { type: 'multi_choice', questions: [{ number: 3, answers: 'A\nB', span: 2 }] },
      ],
    }
    const result = grading.grade(unit, { 1: 'true', 2: 'river bank', 3: ['A', 'C'] })
    assertEqual(result.score, 3, '得分')
    assertEqual(result.total, 4, '总分（多选按 span）')
    assertDeep(result.items.map((i) => i.max), [1, 1, 2], '各题满分')
    return { score: result.score, total: result.total }
  })

  await suite.check('题库辅助：摘要、区间、分页、原文块', async () => {
    assertEqual(bank.summaryText([{ type: 'tfng', count: 4 }, { type: 'completion', count: 4 }]), '判断题 4 · 填空题 4', 'summaryText')
    assertEqual(bank.rangeText(1, 4), '1–4 题', 'rangeText 区间')
    assertEqual(bank.rangeText(5, 5), '第 5 题', 'rangeText 单题')
    assertEqual(bank.partText({ module: 'reading', part: 2 }), 'R2', 'partText')
    assertDeep(bank.pageNumbers(0, 3), [1, 2, 3], 'pageNumbers 少页')
    assert(bank.pageNumbers(10, 28).includes('…'), 'pageNumbers 省略号')
    const unit = await bank.loadUnit(config.practiceUnitId)
    assert(bank.hasSource(unit), '阅读篇应有原文')
    assertEqual(bank.passageBlocks(unit).length, (unit.passage || []).length, 'passageBlocks 段落数')
    assertEqual(typeof bank.hasTranslation(unit), 'boolean', 'hasTranslation')
    return { blocks: (unit.passage || []).length }
  })

  await suite.check('题库按需加载、筛选与整卷槽位', async () => {
    await bank.loadBank()
    assertEqual(bank.getUnits().length, config.realUnits, '真实单元数')
    assertEqual(bank.getWritingTasks().length, config.writingCount, '写作题数')
    assertEqual(bank.getMockPapers().length, config.papersCount, '模考卷数')
    assertEqual(bank.getMockEntries().length, config.mockUnits, '模考单元数')
    assertEqual(bank.getPaperUnits(config.paperId, 'listening').length, config.paperListeningParts, '整卷听力 Part 数')
    assertEqual(bank.getPaperUnits(config.paperId, 'reading').length, config.paperReadingParts, '整卷阅读 Passage 数')
    const parts = bank.getPaperUnits(config.paperId, 'listening')
    assert(parts.every((p, i) => i === 0 || (p.part ?? 0) >= (parts[i - 1].part ?? 0)), '整卷按 Part 排序')
    const ielts = bank.queryRows({ exam: 'ielts', scope: 'group' })
    assert(ielts.length > 0 && ielts.every((r) => r.exam === 'ielts'), '按考试筛选')
    assertEqual(bank.queryRows({ keyword: config.keyword, scope: 'group' }).length, config.practiceGroups, '按标题搜索的题组数')
    const byQuestions = bank.queryRows({ scope: 'group', sort: 'questions' })
    assert(byQuestions.length > 1 && byQuestions[0].questions >= byQuestions[1].questions, '按题量排序')
    assert(bank.typeCounts(ielts).length > 0, '题型分布')
    assert(bank.randomRow(ielts), '随机一题')
    assert(bank.mediaFromRef({ url: '/api/media/file/a%20b.mp3' }).endsWith('a b.mp3'), 'mediaFromRef 解码文件名')
    return { units: bank.getUnits().length, ieltsRows: ielts.length }
  })

  await suite.check('机考偏好：默认值、持久化与旧配色回落', () => {
    const prefs = exam.readExamPrefs()
    assertEqual(prefs.timerMode, 'down', '默认倒计时')
    assertEqual(prefs.colorScheme, 'light', '默认亮色卷面')
    assertEqual(prefs.practiceMode, false, '默认关闭练习模式')
    assertEqual(prefs.limits.reading, 20 * 60, '阅读默认时长')
    const next = exam.saveExamPrefs({ practiceMode: true, limits: { reading: 900 }, showSeconds: true })
    assertEqual(next.limits.reading, 900, '偏好合并')
    assertEqual(exam.readExamPrefs().practiceMode, true, '偏好持久化')
    // 旧版本存过 cream/dark/yellow，一律回落到亮色
    localStorage.setItem('ielts-sim-exam-prefs-v1', JSON.stringify({ colorScheme: 'dark' }))
    assertEqual(exam.readExamPrefs().colorScheme, 'light', '旧配色回落')
    return 'ok'
  })

  await suite.check('高亮与笔记：区间合并、脏数据过滤', () => {
    assertDeep(
      exam.mergeHighlights([{ n: 2, s: 0, e: 3 }, { n: 2, s: 3, e: 6 }, { n: 1, s: 1, e: 2 }, { n: 3, s: 5, e: 5 }]),
      [{ n: 1, s: 1, e: 2 }, { n: 2, s: 0, e: 6 }],
      'mergeHighlights',
    )
    exam.saveHighlights(42, [{ n: 1, s: 0, e: 4 }, { n: 1, s: 3, e: 8 }])
    assertDeep(exam.readHighlights(42), [{ n: 1, s: 0, e: 8 }], '高亮读写')
    exam.clearHighlights(42)
    assertDeep(exam.readHighlights(42), [], '清空高亮')
    localStorage.setItem('ielts-sim-notes-v1', JSON.stringify({
      42: [
        { n: 1, s: 0, e: 5, text: 'note' },       // 老数据没有 id
        { n: 2, s: 5, e: 2, text: 'bad range' }, // 越界区间
        { n: 3, s: 0, e: 3, text: '   ' },       // 空笔记
      ],
    }))
    const notes = exam.readNotes(42)
    assertEqual(notes.length, 1, '脏笔记过滤')
    assert(typeof notes[0].id === 'string' && notes[0].id, '老数据补齐 id')
    exam.saveNotes(42, notes)
    assertEqual(exam.readNotes(42)[0].text, 'note', '笔记读写')
    return 'ok'
  })

  await suite.check('本地记录：成绩、草稿、正确率与清空', () => {
    const attempt = {
      key: '900001', unitId: 900001, title: 'Self test', score: 2, total: 4,
      at: Date.now(), seconds: 42, answers: { 1: 'A' }, wrong: [3, 4],
      types: { tfng: { c: 1, t: 2 }, completion: { c: 1, t: 2 } },
    }
    store.saveAttempt(attempt)
    assertEqual(store.getAttemptByKey('900001').score, 2, '按 key 读成绩')
    assertEqual(store.allAttempts().length, 1, '成绩列表')
    assertEqual(store.attemptsForUnit(900001).length, 1, '按单元读成绩')
    const acc = store.typeAccuracy()
    assertEqual(acc.__total.t, 4, '题型统计总题数')
    assertEqual(acc.tfng.c, 1, '题型统计得分')
    store.saveDraft(900001, 'draft text')
    assertEqual(store.getDraft(900001), 'draft text', '写作草稿')
    store.savePracticeDraft({
      key: '900002', unitId: 900002, title: 'Draft', answers: { 1: 'A' },
      seconds: 10, at: Date.now(), total: 3, marked: [1],
    })
    assertEqual(store.getPracticeDraft('900002').marked[0], 1, '练习草稿')
    assertEqual(store.latestPracticeDraft().key, '900002', '最近草稿')
    store.saveAttempt({ ...attempt, key: '900003', unitId: 900002, at: Date.now() + 10, answers: {} })
    store.clearPracticeDraft('900002')
    assertEqual(store.getPracticeDraft('900002'), undefined, '交卷后清草稿')
    store.clearAll()
    assertEqual(store.allAttempts().length, 0, '清空记录')
    assertEqual(store.getDraft(900001), '', '清空草稿')
    return 'ok'
  })

  await suite.check('字号与字体：步进、上下限、持久化、回落', () => {
    assertEqual(textscale.getTextScale(), 1, '默认字号')
    assertEqual(textscale.stepTextScale(1), true, '放大成功')
    assertEqual(textscale.getTextScale(), 1.1, '步进 0.1')
    assertEqual(textscale.stepTextScale(-1), true, '缩小成功')
    for (let i = 0; i < 10; i++) textscale.stepTextScale(1)
    assertEqual(textscale.getTextScale(), textscale.TEXT_MAX, '上限')
    assertEqual(textscale.stepTextScale(1), false, '到顶后不再变化')
    textscale.resetTextScale()
    assertEqual(textscale.getTextScale(), 1, '恢复默认')
    assertEqual(localStorage.getItem('ielts-sim-text-scale'), '1', '字号持久化')
    assertEqual(document.documentElement.style.getPropertyValue('--text-scale'), '1', 'CSS 变量')
    assertEqual(fontface.getFontFace(), 'arial', '默认字体 Arial')
    assertEqual(fontface.setFontFace('system'), 'system', '切换字体')
    assertEqual(document.documentElement.dataset.font, 'system', 'html data-font')
    assertEqual(fontface.setFontFace('not-a-font'), 'arial', '非法字体回落')
    return 'ok'
  })

  return suite.checks
}
