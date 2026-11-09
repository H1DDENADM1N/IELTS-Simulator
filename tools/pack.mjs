// 组装便携文件夹：Electron 运行时 + 单文件前端 + 题库资源 + 本地记录目录。
// 构建期需要联网下载一次 Electron；成品运行时完全离线。
import { cpSync, existsSync, mkdirSync, readdirSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const LOCAL = path.join(ROOT, '.local')
const RUNTIME = path.join(ROOT, 'runtime', 'electron')
const OUT = path.join(ROOT, 'dist-portable', 'ielts-simulator')
const ELECTRON_VERSION = '40.0.0'
const ZIP_NAME = `electron-v${ELECTRON_VERSION}-win32-x64.zip`
const ZIP_URL = `https://npmmirror.com/mirrors/electron/${ELECTRON_VERSION}/${ZIP_NAME}`

const log = (...parts) => console.log('[pack]', ...parts)

async function ensureElectron() {
  if (existsSync(path.join(RUNTIME, 'electron.exe'))) {
    log('Electron 运行时已就绪')
    return
  }
  mkdirSync(RUNTIME, { recursive: true })
  mkdirSync(LOCAL, { recursive: true })
  const zip = path.join(LOCAL, ZIP_NAME)
  if (!existsSync(zip) || statSync(zip).size < 1024 * 1024) {
    log(`下载 Electron ${ELECTRON_VERSION}（约 110 MB，仅首次）…`)
    const res = await fetch(ZIP_URL)
    if (!res.ok) throw new Error(`下载失败 HTTP ${res.status}：${ZIP_URL}`)
    writeFileSync(zip, Buffer.from(await res.arrayBuffer()))
  }
  rmSync(RUNTIME, { recursive: true, force: true })
  mkdirSync(RUNTIME, { recursive: true })
  log('解压 Electron 运行时…')
  // Windows 自带 bsdtar 能直接解 zip，比 Expand-Archive 快得多
  const systemTar = path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'tar.exe')
  let ok = false
  if (existsSync(systemTar)) {
    ok = spawnSync(systemTar, ['-xf', zip, '-C', RUNTIME], { stdio: 'inherit' }).status === 0
  }
  if (!ok) {
    const ps = `Expand-Archive -LiteralPath '${zip.replace(/'/g, "''")}' -DestinationPath '${RUNTIME.replace(/'/g, "''")}' -Force`
    ok = spawnSync('powershell', ['-NoProfile', '-NonInteractive', '-Command', ps], { stdio: 'inherit' }).status === 0
  }
  if (!ok || !existsSync(path.join(RUNTIME, 'electron.exe'))) throw new Error('解压 Electron 失败')
}

// 同步遍历目录计算体积，不引入额外依赖
function scan(dir) {
  let total = 0
  for (const item of readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, item.name)
    total += item.isDirectory() ? scan(full) : statSync(full).size
  }
  return total
}

async function main() {
  const distHtml = path.join(ROOT, 'dist', 'index.html')
  if (!existsSync(distHtml)) throw new Error('缺少 dist/index.html：请先运行 pnpm build')
  const dataDir = path.join(ROOT, 'data')
  if (!existsSync(path.join(dataDir, 'units-index.json'))) throw new Error('缺少 data/units-index.json：请先运行 pnpm split')

  await ensureElectron()

  // 重新组装会清空整个便携目录，先把已有答题记录（userdata/）备份出来
  const userdata = path.join(OUT, 'userdata')
  let userdataBackup = ''
  if (existsSync(userdata)) {
    userdataBackup = path.join(LOCAL, `userdata-backup-${new Date().toISOString().replace(/[:.]/g, '-')}`)
    mkdirSync(LOCAL, { recursive: true })
    cpSync(userdata, userdataBackup, { recursive: true })
    log(`已备份现有答题记录：${userdataBackup}`)
  }

  log('清理并创建便携目录…')
  rmSync(OUT, { recursive: true, force: true })
  mkdirSync(OUT, { recursive: true })
  cpSync(RUNTIME, OUT, { recursive: true })
  renameSync(path.join(OUT, 'electron.exe'), path.join(OUT, 'ielts-simulator.exe'))

  const appDir = path.join(OUT, 'resources', 'app')
  mkdirSync(path.join(appDir, 'electron'), { recursive: true })
  mkdirSync(path.join(appDir, 'dist'), { recursive: true })
  writeFileSync(
    path.join(appDir, 'package.json'),
    JSON.stringify({ name: 'ielts-simulator', version: '1.0.0', private: true, main: 'electron/main.cjs' }, null, 2),
  )
  for (const file of ['main.cjs', 'preload.cjs']) {
    cpSync(path.join(ROOT, 'electron', file), path.join(appDir, 'electron', file))
  }
  cpSync(distHtml, path.join(appDir, 'dist', 'index.html'))

  // 窗口图标（BrowserWindow 的 icon 选项）；exe 自己的图标在下面改写资源
  const ico = path.join(ROOT, 'build', 'icon.ico')
  if (!existsSync(ico)) throw new Error('缺少 build/icon.ico：请先运行 node tools/icon.mjs')
  mkdirSync(path.join(appDir, 'build'), { recursive: true })
  cpSync(ico, path.join(appDir, 'build', 'icon.ico'))

  // 换掉 exe 里的 Electron 默认图标资源，资源管理器 / 任务栏 / Alt+Tab 才会显示本项目图标
  const exe = path.join(OUT, 'ielts-simulator.exe')
  if (process.platform === 'win32') {
    log('写入 exe 图标资源…')
    const result = spawnSync(
      'powershell',
      [
        '-NoProfile',
        '-ExecutionPolicy',
        'Bypass',
        '-File',
        path.join(ROOT, 'tools', 'set-exe-icon.ps1'),
        '-Exe',
        exe,
        '-Ico',
        ico,
      ],
      { stdio: 'inherit' },
    )
    if (result.status !== 0) throw new Error('写入 exe 图标失败（powershell 退出码 ' + result.status + '）')
  } else {
    log('非 Windows 目标，跳过 exe 图标资源写入')
  }

  // units.json / mock-papers.json 是拆分前的源文件，只用于重跑 pnpm split，不进成品
  const SOURCE_ONLY = new Set(['units.json', 'mock-papers.json'])
  // WordPress 媒体库导出的 sizes 缩略图变体（-300x…、-500x500、-1200x630 等）只存在于
  // 元数据里，前端 mediaFromRef 只读原图的 url / filename，成品不需要带这 746 张图。
  // 自检会保证没有任何引用指向变体，避免这里误删真正会加载的文件。
  const THUMB_VARIANT = /-\d+x\d+\.(png|jpe?g)$/i
  log('复制题库资源（约 4.1 GB，需要一点时间）…')
  cpSync(dataDir, path.join(OUT, 'data'), {
    recursive: true,
    filter: (src) => {
      const base = path.basename(src)
      if (SOURCE_ONLY.has(base)) return false
      if (THUMB_VARIANT.test(base) && path.basename(path.dirname(src)) === 'media') return false
      return true
    },
  })
  mkdirSync(path.join(OUT, 'userdata'), { recursive: true })
  if (userdataBackup) {
    try {
      cpSync(userdataBackup, path.join(OUT, 'userdata'), { recursive: true })
      log('已把答题记录放回便携目录')
    } catch (error) {
      log(`答题记录放回失败（备份仍在 ${userdataBackup}）：${error.message}`)
    }
  }

  writeFileSync(
    path.join(OUT, '使用说明.txt'),
    [
      'IELTS Simulator · 离线便携版',
      '',
      '双击 ielts-simulator.exe 即可使用，无需安装、不写注册表、不联网。',
      '',
      '目录说明：',
      '  data/       题库 JSON、听力音频、题目配图',
      '  userdata/   成绩、错题、写作草稿（程序自动生成，备份时一起带走）',
      '  resources/  程序本体',
      '',
      '整个文件夹可以直接复制到 U 盘或另一台 Windows 电脑。',
      '删除 userdata/ 即可清空所有本地记录。',
      '',
      '数据来源与致谢：',
      '  题库、音频与配图来源于「我不是考神」（wbsks.com），仅在本机固化用于离线练习。',
      '  感谢原项目作者与贡献者的整理与开源（AGPL-3.0）。',
      '  本项目为独立的离线练习程序，与原项目无关联，也不是官方考试系统。',
    ].join('\r\n'),
    'utf8',
  )

  const size = scan(OUT)
  log(`完成：${OUT}`)
  log(`总体积 ${(size / 1073741824).toFixed(2)} GB`)
  log(`前端单文件 ${(statSync(distHtml).size / 1024).toFixed(0)} KB`)
}

main().catch((error) => {
  console.error('[pack] 失败：', error.message)
  process.exit(1)
})
