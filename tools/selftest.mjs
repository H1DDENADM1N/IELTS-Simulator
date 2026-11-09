// IELTS Simulator 自检总入口：静态数据 → 纯逻辑 → 真实窗口场景。
//
//   pnpm selftest                   完整自检（默认测便携版）
//   pnpm selftest -- --no-window    只跑静态 + 逻辑，不开窗口
//   pnpm selftest -- --source       测源码（runtime/electron/electron.exe + dist/）
//   pnpm selftest -- --only=答题    只统计名称/分组含「答题」的检查
//   pnpm selftest -- --json         以 JSON 输出结果
//
// 窗口自检用 .local/selftest-profile 作为独立 userData，不碰真实成绩、草稿与偏好；
// 便携版里的 electron/*.cjs 会在测试期间临时同步，结束后原样还原。
import { spawn } from 'node:child_process'
import { copyFileSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { pickSamples, runDataChecks } from './selftest-data.mjs'
import { runLogicChecks } from './selftest-logic.mjs'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const PORTABLE = path.join(ROOT, 'dist-portable', 'ielts-simulator')
const PROFILE = path.join(ROOT, '.local', 'selftest-profile')
const REPORT = path.join(ROOT, '.local', 'selftest-report.json')
const PAGE_SCRIPT = path.join(ROOT, 'tools', 'selftest-page.js')

const HELP = `IELTS Simulator 自检

用法：pnpm selftest -- [选项]

  --no-window      只跑静态数据 / 构建 / 纯逻辑层，不启动 Electron 窗口
  --source         用源码 dist/ + runtime/electron 启动（默认测便携版）
  --no-sync        不同步 electron/*.cjs 到便携版（用于验证成品是否为最新构建）
  --only=<关键字>   只统计分组或名称含关键字的检查（仍会执行完整流程）
  --timeout=<ms>   窗口自检整体超时，默认 240000
  --json           以 JSON 输出完整结果
  --help           显示本说明

结果同时写入 .local/selftest-report.json；有失败项时退出码为 1。`

const argv = process.argv.slice(2)
const has = (flag) => argv.includes(flag)
const valueOf = (flag, fallback) => {
  const hit = argv.find((a) => a.startsWith(`${flag}=`))
  return hit ? hit.slice(flag.length + 1) : fallback
}

if (has('--help')) {
  console.log(HELP)
  process.exit(0)
}

const noWindow = has('--no-window')
const jsonOut = has('--json')
const sourceMode = has('--source')
const noSync = has('--no-sync')
const only = valueOf('--only', '')
const timeout = Math.max(30000, Number(valueOf('--timeout', '240000')) || 240000)

let mode = sourceMode ? 'source' : 'portable'
const portableExe = path.join(PORTABLE, 'ielts-simulator.exe')
const sourceExe = path.join(ROOT, 'runtime', 'electron', 'electron.exe')
if (mode === 'portable' && !existsSync(portableExe)) {
  if (!noWindow && existsSync(sourceExe)) {
    mode = 'source'
    console.log('[selftest] 未找到便携版 exe，自动改用源码模式（--source）')
  } else if (!noWindow) {
    console.error('缺少便携版：请先运行 pnpm bundle；或安装 Electron 运行时后用 --source')
    process.exit(1)
  }
}

const dataDir = mode === 'portable' ? path.join(PORTABLE, 'data') : path.join(ROOT, 'data')
const ctx = {
  root: ROOT,
  dataDir,
  mode,
  exe: portableExe,
  distHtml: path.join(ROOT, 'dist', 'index.html'),
  packagedHtml: path.join(PORTABLE, 'resources', 'app', 'dist', 'index.html'),
  packagedData: path.join(PORTABLE, 'data'),
}

let config
try {
  config = pickSamples(ctx)
} catch (error) {
  console.error(`[selftest] 无法挑选自检样本：${error.message}`)
  process.exit(1)
}

const startedAt = new Date().toISOString()
const checks = []
const meta = { mode, startedAt, config }

// ── 第一、二层：静态数据 / 构建产物 / 纯逻辑 ───────────────────────
checks.push(...(await runDataChecks(ctx)))
checks.push(...(await runLogicChecks({ ...ctx, config })))

// ── 第三层：真实 Electron 窗口 ────────────────────────────────────
const expectedConsoleError = /Content Security Policy|ERR_CONNECTION_REFUSED|ERR_NAME_NOT_RESOLVED|ERR_BLOCKED_BY_CLIENT|Failed to load resource|net::ERR/i
const syncTargets = [
  ['electron/main.cjs', path.join(PORTABLE, 'resources', 'app', 'electron', 'main.cjs')],
  ['electron/preload.cjs', path.join(PORTABLE, 'resources', 'app', 'electron', 'preload.cjs')],
]
const backups = []

async function runWindow() {
  if (noWindow) {
    checks.push({ group: '窗口', name: '真实窗口场景', ok: true, skipped: true, detail: '--no-window', ms: 0 })
    return
  }
  const exe = mode === 'portable' ? portableExe : sourceExe
  if (!existsSync(exe)) throw new Error(`缺少 Electron 可执行文件：${exe}`)

  // 每次从干净的 profile 开始，避免上次的草稿 / 偏好影响断言
  rmSync(PROFILE, { recursive: true, force: true })
  mkdirSync(PROFILE, { recursive: true })
  const resultFile = path.join(PROFILE, 'selftest.json')

  // --no-sync 用来验证成品本身是否为最新构建：主进程过期时直接报错，别干等超时
  if (mode === 'portable' && noSync) {
    const stale = syncTargets
      .filter(([, target]) => existsSync(target))
      .filter(([rel, target]) => !readFileSync(path.join(ROOT, rel)).equals(readFileSync(target)))
      .map(([rel]) => rel)
    if (stale.length) {
      checks.push({
        group: '窗口', name: '真实窗口场景', ok: false, ms: 0,
        detail: `便携版里的 ${stale.join('、')} 不是最新构建，请重跑 pnpm bundle（或去掉 --no-sync 让自检临时同步）`,
      })
      return
    }
  }

  // 成品里的主进程可能是旧版：临时同步，测完还原，保持便携目录不被改动
  if (mode === 'portable' && !noSync) {
    for (const [rel, target] of syncTargets) {
      if (!existsSync(target)) continue
      const fresh = readFileSync(path.join(ROOT, rel))
      const current = readFileSync(target)
      if (!fresh.equals(current)) {
        backups.push({ target, content: current })
        copyFileSync(path.join(ROOT, rel), target)
        console.log(`[selftest] 已临时同步 ${rel} 到便携版（测试结束后还原）`)
      }
    }
  }

  const env = {
    ...process.env,
    IELTS_SIM_SELFTEST: '1',
    IELTS_SIM_SELFTEST_USERDATA: PROFILE,
    IELTS_SIM_SELFTEST_SCRIPT: PAGE_SCRIPT,
    IELTS_SIM_SELFTEST_RESULT: resultFile,
    IELTS_SIM_SELFTEST_CONFIG: JSON.stringify(config),
    IELTS_SIM_SELFTEST_TIMEOUT_MS: String(timeout),
  }
  // 宿主若继承这些变量，Electron 会退化成 Node / 连到开发服务器
  delete env.ELECTRON_RUN_AS_NODE
  delete env.NODE_OPTIONS
  delete env.IELTS_SIM_DEV_URL

  const child = spawn(exe, mode === 'source' ? ['.'] : [], {
    cwd: mode === 'source' ? ROOT : PORTABLE,
    env,
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  let stderr = ''
  child.stderr.on('data', (chunk) => { stderr = (stderr + chunk.toString()).slice(-8000) })
  child.stdout.on('data', (chunk) => { stderr = (stderr + chunk.toString()).slice(-8000) })

  let result = null
  const deadline = Date.now() + timeout + 20000
  while (Date.now() < deadline) {
    if (existsSync(resultFile)) {
      try {
        result = JSON.parse(readFileSync(resultFile, 'utf8'))
        break
      } catch { /* 主进程还在写 */ }
    }
    if (child.exitCode !== null) {
      await new Promise((r) => setTimeout(r, 400))
      if (existsSync(resultFile)) {
        try { result = JSON.parse(readFileSync(resultFile, 'utf8')) } catch { /* 结果不完整 */ }
      }
      break
    }
    await new Promise((r) => setTimeout(r, 300))
  }
  try { child.kill() } catch { /* 已退出 */ }

  if (!result) {
    checks.push({
      group: '窗口', name: '真实窗口场景', ok: false, ms: 0,
      detail: `未拿到自检结果（超时或窗口启动失败）${stderr ? `\nElectron 输出：${stderr.slice(-1200)}` : ''}`,
    })
    return
  }

  meta.window = {
    title: result.meta?.title,
    protocol: result.meta?.protocol,
    finalHash: result.meta?.finalHash,
    userAgent: result.meta?.userAgent,
    userData: result.userData,
    consoleErrors: result.consoleErrors || [],
    stderrTail: stderr.slice(-1200),
  }
  if (Array.isArray(result.checks)) checks.push(...result.checks)
  if (result.fatal) {
    checks.push({ group: '窗口', name: '场景脚本执行', ok: false, detail: result.fatal, ms: 0 })
  }
  if (!Array.isArray(result.checks) || !result.checks.length) {
    checks.push({ group: '窗口', name: '场景检查项', ok: false, detail: '没有产出任何检查项', ms: 0 })
  }
  const unexpected = (result.consoleErrors || []).filter((line) => !expectedConsoleError.test(line))
  checks.push({
    group: '窗口', name: '主进程 / 渲染进程控制台无意外错误', ok: unexpected.length === 0,
    detail: unexpected.length ? unexpected.slice(0, 5).join(' | ') : `预期内拦截提示 ${(result.consoleErrors || []).length} 条`,
    ms: 0,
  })
  checks.push({
    group: '窗口', name: '自检使用独立 profile', ok: result.userData === PROFILE,
    detail: result.userData || '主进程未回传 userData', ms: 0,
  })
}

try {
  await runWindow()
} catch (error) {
  checks.push({ group: '窗口', name: '真实窗口场景', ok: false, detail: String(error.stack || error), ms: 0 })
} finally {
  for (const { target, content } of backups) {
    try { writeFileSync(target, content) } catch (error) { console.error(`[selftest] 还原 ${target} 失败：${error.message}`) }
  }
}

// ── 汇总 ─────────────────────────────────────────────────────────
const visible = only ? checks.filter((c) => `${c.group}/${c.name}`.includes(only)) : checks
const failed = visible.filter((c) => !c.ok)
const skipped = visible.filter((c) => c.ok && c.skipped)
const passed = visible.filter((c) => c.ok && !c.skipped)
const summary = { total: visible.length, passed: passed.length, skipped: skipped.length, failed: failed.length }
const report = { ...meta, finishedAt: new Date().toISOString(), summary, checks: visible, allChecks: checks }
mkdirSync(path.dirname(REPORT), { recursive: true })
writeFileSync(REPORT, JSON.stringify(report, null, 2))

if (jsonOut) {
  console.log(JSON.stringify(report, null, 2))
} else {
  console.log('\n=== IELTS Simulator 自检 ===')
  console.log(`模式：${mode === 'portable' ? '便携版' : '源码'}${noWindow ? '（仅静态 / 逻辑层）' : ''}`)
  console.log(`样本：阅读 #${config.practiceUnitId}（${config.practiceTotal} 题）· 听力 #${config.audioUnitId} · 模考卷 #${config.paperId}`)
  console.log('')
  let group = ''
  for (const c of visible) {
    if (c.group !== group) { group = c.group; console.log(`  [${group}]`) }
    const tag = !c.ok ? 'FAIL' : c.skipped ? 'SKIP' : 'PASS'
    const line = `    ${tag}  ${c.name}${c.ms ? `  (${c.ms}ms)` : ''}`
    console.log(line)
    if (!c.ok || c.skipped) console.log(`          ${String(typeof c.detail === 'object' ? JSON.stringify(c.detail) : c.detail).slice(0, 600)}`)
  }
  console.log('')
  console.log(`共 ${summary.total} 项：通过 ${summary.passed} · 跳过 ${summary.skipped} · 失败 ${summary.failed}`)
  console.log(`详细报告：${path.relative(ROOT, REPORT)}`)
  if (failed.length) {
    console.log('\n自检未通过：')
    for (const c of failed) console.log(`  - ${c.group} / ${c.name}：${String(typeof c.detail === 'object' ? JSON.stringify(c.detail) : c.detail).slice(0, 400)}`)
  } else {
    console.log('\n自检通过')
  }
}

process.exit(failed.length ? 1 : 0)
