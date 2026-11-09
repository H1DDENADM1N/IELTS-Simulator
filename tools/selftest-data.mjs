// 第一层：不开窗口，直接检查题库数据、拆分产物、构建产物与离线安全设置。
import { createHash } from 'node:crypto'
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs'
import path from 'node:path'
import { assert, assertEqual, createSuite } from './selftest-common.mjs'

const readJson = (file) => JSON.parse(readFileSync(file, 'utf8'))
const spanOf = (q) => Math.max(q?.span || 1, 1)
const groupCount = (g) => (g.questions || []).reduce((sum, q) => sum + spanOf(q), 0)
const mediaName = (ref) => {
  const raw = ref?.url || ref?.filename
  if (!raw) return ''
  return decodeURIComponent(String(raw).split('/').pop() || '')
}
const sha256 = (file) => createHash('sha256').update(readFileSync(file)).digest('hex')

export async function runDataChecks(ctx) {
  const data = createSuite('数据')
  const build = createSuite('构建')
  const { root, dataDir, mode, exe, distHtml, packagedHtml, packagedData } = ctx

  const unitsFile = path.join(dataDir, 'units-index.json')
  const papersFile = path.join(dataDir, 'papers-index.json')
  const writingFile = path.join(dataDir, 'writing-tasks.json')

  let unitsIndex = []
  let papersIndex = []
  let writingTasks = []
  let parseError = null
  try {
    unitsIndex = readJson(unitsFile)
    papersIndex = readJson(papersFile)
    writingTasks = readJson(writingFile)
    assert(Array.isArray(unitsIndex) && Array.isArray(papersIndex) && Array.isArray(writingTasks), '索引顶层必须是数组')
  } catch (error) {
    parseError = error
  }

  await data.check('三个索引文件可解析', () => {
    if (parseError) throw parseError
    assert(unitsIndex.length > 0 && papersIndex.length > 0 && writingTasks.length > 0, '索引为空')
    return { units: unitsIndex.length, papers: papersIndex.length, writing: writingTasks.length }
  })

  await data.check('单元摘要字段与 id 唯一', () => {
    assert(unitsIndex.length, '索引未加载')
    const seen = new Set()
    for (const u of unitsIndex) {
      assert(Number.isInteger(u.id) && u.id > 0, `非法 id：${u.id}`)
      assert(!seen.has(u.id), `重复 id：${u.id}`)
      seen.add(u.id)
      assert(typeof u.title === 'string' && u.title.trim(), `单元 ${u.id} 缺标题`)
      assert(['listening', 'reading'].includes(u.module), `单元 ${u.id} 科目非法`)
      assert(Array.isArray(u.groups) && u.groups.length > 0, `单元 ${u.id} 没有题组`)
      assert(Number.isFinite(u.questions) && u.questions > 0, `单元 ${u.id} 题量非法`)
      assertEqual(typeof u.hasAudio, 'boolean', `单元 ${u.id} hasAudio`)
      if (u.mock) {
        assert(Number.isInteger(u.mock.paperId) && typeof u.mock.key === 'string', `模考单元 ${u.id} 槽位信息缺失`)
      }
    }
    return { total: unitsIndex.length, real: unitsIndex.filter((u) => !u.mock).length, mock: unitsIndex.filter((u) => u.mock).length }
  })

  // 单篇文件同时把媒体引用收集起来，供后面的文件齐全检查使用
  const mediaRefs = new Set()
  await data.check('单篇题库文件与索引逐条一致', () => {
    assert(unitsIndex.length, '索引未加载')
    const unitsDir = path.join(dataDir, 'units')
    let checked = 0
    for (const entry of unitsIndex) {
      const file = path.join(unitsDir, `${entry.id}.json`)
      assert(existsSync(file), `缺少单篇文件 ${entry.id}.json`)
      const unit = readJson(file)
      assertEqual(unit.id, entry.id, `单元 ${entry.id} 的 id`)
      assertEqual((unit.groups || []).length, entry.groups.length, `单元 ${entry.id} 题组数`)
      const total = (unit.groups || []).reduce((sum, g) => sum + groupCount(g), 0)
      assertEqual(total, entry.questions, `单元 ${entry.id} 题量`)
      assertEqual(Boolean(mediaName(unit.audio)), entry.hasAudio, `单元 ${entry.id} 音频标记`)
      const name = mediaName(unit.audio)
      if (name) mediaRefs.add(name)
      for (const g of unit.groups || []) {
        assert(
          g.image == null || (typeof g.image === 'object' && Boolean(g.image.url || g.image.filename)),
          `单元 ${entry.id} 的题组 ${g.id} 配图仍是 media ID 或缺少本地文件名`,
        )
        const img = mediaName(g.image)
        if (img) mediaRefs.add(img)
      }
      checked++
    }
    assertEqual(readdirSync(unitsDir).filter((f) => f.endsWith('.json')).length, unitsIndex.length, 'units/ 目录文件数')
    return { checked, mediaRefs: mediaRefs.size }
  })

  await data.check('模考卷槽位与模考单元对应', () => {
    assert(unitsIndex.length && papersIndex.length, '索引未加载')
    const byId = new Map(unitsIndex.map((u) => [u.id, u]))
    let slots = 0
    for (const paper of papersIndex) {
      assert(Number.isInteger(paper.id), '模考卷 id 非法')
      assert(paper.units && typeof paper.units === 'object', `模考卷 ${paper.id} 缺槽位表`)
      for (const [key, id] of Object.entries(paper.units)) {
        const unit = byId.get(id)
        assert(unit?.mock, `槽位 ${paper.id}/${key} 指向的 ${id} 不是模考单元`)
        assertEqual(unit.mock.paperId, paper.id, `槽位 ${paper.id}/${key} 卷号`)
        assertEqual(unit.mock.key, key, `槽位 ${paper.id}/${key} 键名`)
        assertEqual(unit.module, key.startsWith('l') ? 'listening' : 'reading', `槽位 ${paper.id}/${key} 科目`)
        slots++
      }
    }
    assertEqual(slots, unitsIndex.filter((u) => u.mock).length, '模考槽位总数')
    return { papers: papersIndex.length, slots }
  })

  await data.check('音频与题目配图文件齐全', () => {
    const dir = path.join(dataDir, 'media')
    assert(existsSync(dir), '缺少 data/media/')
    for (const t of writingTasks) {
      const img = mediaName(t.image)
      if (img) mediaRefs.add(img)
    }
    const missing = [...mediaRefs].filter((name) => !existsSync(path.join(dir, name)))
    assertEqual(missing.length, 0, `缺失媒体文件（${missing.slice(0, 5).join(', ')}）`)
    return { refs: mediaRefs.size, missing: 0 }
  })

  // 反向检查：目录里的文件是否都被引用。抓取媒体库时连带下载的 sizes 缩略图变体
  // 只存在于元数据里，允许留着；但原图 / 音频出现孤儿，就说明数据或打包漏了文件。
  // 顺便保证前端不会引用变体，否则打包跳过变体会让成品缺图。
  await data.check('媒体目录无孤立原图 / 音频', () => {
    const dir = path.join(dataDir, 'media')
    assert(existsSync(dir), '缺少 data/media/')
    const names = readdirSync(dir).filter((f) => /\.(mp3|png|jpe?g)$/i.test(f))
    const isVariant = (n) => /-\d+x\d+\.(png|jpe?g)$/i.test(n)
    const badRefs = [...mediaRefs].filter(isVariant)
    assertEqual(badRefs.length, 0, `前端引用了缩略图变体（${badRefs.slice(0, 3).join(', ')}）：成品精简会漏文件`)
    const orphans = names.filter((n) => !mediaRefs.has(n))
    const unexpected = orphans.filter((n) => !isVariant(n))
    assertEqual(unexpected.length, 0, `存在未被引用的原图 / 音频（${unexpected.slice(0, 3).join(', ')}）`)
    const bytes = orphans.reduce((sum, n) => sum + statSync(path.join(dir, n)).size, 0)
    return {
      files: names.length,
      referenced: mediaRefs.size,
      thumbnailVariants: orphans.length,
      variantMB: +(bytes / 1048576).toFixed(1),
    }
  })

  await data.check('写作 / 翻译题字段可用', () => {
    assert(writingTasks.length, '写作题为空')
    const ids = new Set()
    for (const t of writingTasks) {
      assert(Number.isInteger(t.id) && !ids.has(t.id), `写作题 id 非法或重复：${t.id}`)
      ids.add(t.id)
      assert(typeof t.taskType === 'string' && t.taskType, `写作题 ${t.id} 缺 taskType`)
      assert(['ielts', 'cet4', 'cet6'].includes(t.exam), `写作题 ${t.id} 考试类型非法`)
    }
    return { count: writingTasks.length }
  })

  await build.check('单文件前端与离线 CSP', () => {
    assert(existsSync(distHtml), '缺少 dist/index.html：请先运行 pnpm build')
    const html = readFileSync(distHtml, 'utf8')
    assert(statSync(distHtml).size > 100 * 1024, 'dist/index.html 体积异常（单文件构建失败？）')
    const csp = /<meta http-equiv="Content-Security-Policy" content="([^"]+)"/i.exec(html)?.[1] || ''
    for (const directive of ["default-src 'none'", "connect-src 'none'", "script-src 'unsafe-inline'", 'media-src file: data: blob:', "base-uri 'none'"]) {
      assert(csp.includes(directive), `CSP 缺少 ${directive}`)
    }
    assert(!/<script[^>]+src=["']https?:/i.test(html), 'HTML 里存在外链脚本')
    assert(!/<link[^>]+href=["']https?:/i.test(html), 'HTML 里存在外链样式')
    return { bytes: statSync(distHtml).size, csp }
  })

  await build.check('主进程离线阻断与渲染进程隔离', () => {
    const main = readFileSync(path.join(root, 'electron', 'main.cjs'), 'utf8')
    const preload = readFileSync(path.join(root, 'electron', 'preload.cjs'), 'utf8')
    for (const needle of [
      'contextIsolation: true',
      'nodeIntegration: false',
      'webSecurity: true',
      'onBeforeRequest',
      'setWindowOpenHandler',
      'callback({ cancel: !(local || dev) })',
      "app.setPath(name, dir)",
      "'ielts-sim:read-unit'",
      'Number.isInteger(value)',
      'IELTS_SIM_SELFTEST_SCRIPT',
    ]) {
      assert(main.includes(needle), `main.cjs 缺少 ${needle}`)
    }
    assert(preload.includes('contextBridge.exposeInMainWorld'), 'preload 未使用 contextBridge')
    for (const api of ['readJson', 'readUnit', 'mediaUrl']) assert(preload.includes(api), `preload 缺少 ${api}`)
    assert(!/require\(['"](?:node:)?(?:https?|net|fs)['"]\)/.test(preload), 'preload 不应引入文件系统或网络模块')
    const vite = readFileSync(path.join(root, 'vite.config.ts'), 'utf8')
    assert(vite.includes('viteSingleFile()') && vite.includes("apply: 'build'"), 'Vite 配置缺少单文件 / CSP 构建插件')
    return 'ok'
  })

  if (mode === 'portable') {
    await build.check('便携版目录与成品前端一致', () => {
      assert(existsSync(exe), '缺少便携版 exe：请先运行 pnpm bundle')
      assert(existsSync(packagedHtml), '成品缺少 dist/index.html')
      assert(existsSync(path.join(packagedData, 'units-index.json')), '成品缺少题库索引')
      assert(existsSync(path.join(packagedData, 'writing-tasks.json')), '成品缺少写作题')
      assert(!existsSync(path.join(packagedData, 'units.json')), '拆分源 units.json 不应进成品')
      assert(!existsSync(path.join(packagedData, 'mock-papers.json')), '拆分源 mock-papers.json 不应进成品')
      assertEqual(sha256(distHtml), sha256(packagedHtml), '成品前端与 dist/index.html 不一致（请重跑 pnpm build && pnpm bundle）')
      return { exe: path.basename(exe) }
    })
  } else {
    build.skip('便携版目录与成品前端一致', '源码模式（--source）不检查打包产物')
  }

  return [...data.checks, ...build.checks]
}

/** 从索引里挑出确定性的自检样本，并算好答题页要核对的题量 */
export function pickSamples(ctx) {
  const { dataDir } = ctx
  const index = readJson(path.join(dataDir, 'units-index.json'))
  const papers = readJson(path.join(dataDir, 'papers-index.json'))
  const writing = readJson(path.join(dataDir, 'writing-tasks.json'))
  const real = index.filter((u) => !u.mock)
  const readUnit = (id) => readJson(path.join(dataDir, 'units', `${id}.json`))
  const mediaExists = (name) => Boolean(name) && existsSync(path.join(dataDir, 'media', name))

  // 阅读篇：既有选项题又有行内填空，题量适中，且带原文（Split 视图可用）
  const practice = real
    .filter((s) => s.module === 'reading' && s.questions >= 8 && s.questions <= 15)
    .map((s) => ({ s, u: readUnit(s.id) }))
    .find(({ s, u }) =>
      (u.passage || []).length > 0 &&
      s.groups.some((g) => g.type === 'completion') &&
      s.groups.some((g) => ['single_choice', 'tfng', 'matching_information'].includes(g.type)) &&
      (u.groups || []).some((g) => /\{\{\d+\}\}/.test(g.content || '')),
    )
  assert(practice, '题库里找不到合适的阅读自检样本')

  // 听力篇：有音频且文件确实存在，题量小
  const audio = real
    .filter((s) => s.hasAudio && s.module === 'listening' && s.questions <= 12)
    .map((s) => ({ s, u: readUnit(s.id) }))
    .find(({ u }) => mediaExists(mediaName(u.audio)))
  assert(audio, '题库里找不到合适的听力自检样本')

  const paper = papers.find((p) => {
    const own = index.filter((x) => x.mock && x.mock.paperId === p.id)
    return own.some((x) => x.module === 'listening') && own.some((x) => x.module === 'reading')
  })
  assert(paper, '题库里找不到可用于整卷模考的卷子')

  const questions = (practice.u.groups || []).flatMap((g) => g.questions || [])
  const first = Math.min(...questions.map((q) => q.number))
  const lastQ = questions.reduce((a, b) => (!a || b.number > a.number ? b : a), null)
  const last = lastQ.number + spanOf(lastQ) - 1
  const total = (practice.u.groups || []).reduce(
    (sum, g) => sum + (g.questions || []).reduce((n, q) => n + (g.type === 'multi_choice' ? spanOf(q) : 1), 0),
    0,
  )

  return {
    realUnits: real.length,
    mockUnits: index.length - real.length,
    writingCount: writing.length,
    papersCount: papers.length,
    audioCount: real.filter((u) => u.hasAudio).length,
    practiceUnitId: practice.s.id,
    practiceTitle: practice.s.title,
    practiceTotal: total,
    practiceSlots: last - first + 1,
    practiceQuestions: questions.length,
    practiceGroups: practice.u.groups.length,
    keyword: practice.s.title,
    audioUnitId: audio.s.id,
    audioFirstQuestion: (audio.u.groups?.[0]?.questions?.[0]?.number) || 1,
    audioFilename: mediaName(audio.u.audio),
    paperId: paper.id,
    paperListeningParts: index.filter((x) => x.mock && x.mock.paperId === paper.id && x.module === 'listening').length,
    paperReadingParts: index.filter((x) => x.mock && x.mock.paperId === paper.id && x.module === 'reading').length,
    writingTaskId: writing[0]?.id,
  }
}
