// 便携版主进程：所有状态都写在程序自己的文件夹里，不碰系统用户目录 / 注册表。
const { app, BrowserWindow, ipcMain, nativeTheme, session, shell } = require('electron')
const fs = require('node:fs')
const path = require('node:path')
const { pathToFileURL } = require('node:url')

const DEV_URL = process.env.IELTS_SIM_DEV_URL || ''
// 自检用独立 profile：不碰真实成绩、错题和草稿，也让每次运行从干净状态开始
const SELFTEST = Boolean(process.env.IELTS_SIM_SELFTEST)
const ROOT = app.isPackaged
  ? path.resolve(__dirname, '..', '..', '..')
  : path.resolve(__dirname, '..')
const DATA = path.join(ROOT, 'data')
const USERDATA = SELFTEST && process.env.IELTS_SIM_SELFTEST_USERDATA
  ? path.resolve(process.env.IELTS_SIM_SELFTEST_USERDATA)
  : path.join(ROOT, 'userdata')
// 开发时是仓库里的 build/icon.ico，打包后是 resources/app/build/icon.ico；exe 自身的图标由 tools/set-exe-icon.ps1 写入
const ICON = path.join(__dirname, '..', 'build', 'icon.ico')

// 必须在 app ready 之前设置，否则 WebView / Chromium 会在 %APPDATA% 建目录
for (const [name, dir] of [
  ['userData', USERDATA],
  ['cache', path.join(USERDATA, 'cache')],
  ['logs', path.join(USERDATA, 'logs')],
  ['crashDumps', path.join(USERDATA, 'crash')],
]) {
  fs.mkdirSync(dir, { recursive: true })
  app.setPath(name, dir)
}

const safeName = (value) => path.basename(String(value || '')).replace(/[\\/]/g, '')

ipcMain.on('ielts-sim:media-url', (event, name) => {
  const file = path.join(DATA, 'media', safeName(name))
  event.returnValue = pathToFileURL(file).href
})

ipcMain.handle('ielts-sim:read-json', async (_event, name) => {
  const file = path.join(DATA, `${String(name).replace(/[^a-z0-9-]/gi, '')}.json`)
  return fs.promises.readFile(file, 'utf8')
})

// 单篇题库：只接受整数编号，路径由主进程拼，渲染进程传不进任何路径片段
ipcMain.handle('ielts-sim:read-unit', async (_event, id) => {
  const value = Number(id)
  if (!Number.isInteger(value) || value < 0 || value > 99999999) throw new Error('非法的单元编号')
  return fs.promises.readFile(path.join(DATA, 'units', `${value}.json`), 'utf8')
})

function createWindow() {
  // 站点与卷面都只有亮色一套：把系统原生窗口框、滚动条、表单控件也锁在亮色，
  // 否则系统是深色主题时，标题栏会黑一条，和页面亮色对不上。
  nativeTheme.themeSource = 'light'

  const win = new BrowserWindow({
    width: 1320,
    height: 900,
    minWidth: 900,
    minHeight: 600,
    title: 'IELTS Simulator',
    icon: fs.existsSync(ICON) ? ICON : undefined,
    backgroundColor: '#f6f7f9',
    autoHideMenuBar: true,
    webPreferences: {
      preload: path.join(__dirname, 'preload.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
      webSecurity: true,
    },
  })

  // 硬阻断：除本地文件、开发者工具和开发服务器外，一律不允许发起请求
  session.defaultSession.webRequest.onBeforeRequest((details, callback) => {
    const url = details.url
    const local = /^(file|data|blob|devtools|chrome-extension):/i.test(url)
    const dev = DEV_URL && url.startsWith(DEV_URL)
    callback({ cancel: !(local || dev) })
  })

  if (DEV_URL) win.loadURL(DEV_URL)
  else win.loadFile(path.join(__dirname, '..', 'dist', 'index.html'))

  // 顶栏的站外链接（GitHub 主页）不在程序内打开：交给系统默认浏览器，
  // 窗口本身保持离线状态，也不会被上面的请求拦截拦成一片空白。
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:\/\//i.test(url)) shell.openExternal(url)
    return { action: 'deny' }
  })

  // 自动化自检：场景脚本在 tools/selftest-page.js，主进程只负责注入执行、超时兜底和回收结果。
  // 结果写进独立 profile，不污染便携目录里的真实成绩与草稿。
  if (SELFTEST) {
    const scriptPath = process.env.IELTS_SIM_SELFTEST_SCRIPT
    const resultPath = process.env.IELTS_SIM_SELFTEST_RESULT || path.join(USERDATA, 'selftest.json')
    const config = JSON.parse(process.env.IELTS_SIM_SELFTEST_CONFIG || '{}')
    const consoleErrors = []
    let finished = false
    let guard

    const finish = (result) => {
      if (finished) return
      finished = true
      if (guard) clearTimeout(guard)
      try {
        fs.mkdirSync(path.dirname(resultPath), { recursive: true })
        fs.writeFileSync(resultPath, JSON.stringify({ ...result, consoleErrors, userData: USERDATA }, null, 2))
      } catch (error) {
        console.error('[selftest] 写入结果失败：', error)
      }
      app.quit()
    }

    // 页面脚本自己有逐项超时；这里再兜一层，避免窗口起不来时干等
    const hardMs = Number(process.env.IELTS_SIM_SELFTEST_TIMEOUT_MS) || 240000
    guard = setTimeout(() => finish({ fatal: `自检整体超时（${hardMs}ms）`, checks: [] }), hardMs + 15000)

    win.webContents.on('console-message', (_event, level, message, line, sourceId) => {
      const isError = typeof level === 'number' ? level >= 3 : /error/i.test(String(level))
      if (isError) consoleErrors.push(`${message} (${sourceId}:${line})`)
    })
    win.webContents.on('preload-error', (_event, file, error) => {
      consoleErrors.push(`preload ${file}: ${error?.message || error}`)
    })

    win.webContents.once('did-finish-load', () => {
      setTimeout(async () => {
        let result
        try {
          // 场景文件是一个 async (config) => {...} 表达式，注入后立即执行
          const source = fs.readFileSync(scriptPath, 'utf8')
          result = await win.webContents.executeJavaScript(`(${source})(${JSON.stringify(config)})`, true)
        } catch (error) {
          result = { fatal: String(error?.stack || error), checks: [] }
        }
        finish(result)
      }, 1000)
    })
  }
}

app.whenReady().then(() => {
  createWindow()
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow()
  })
})

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit()
})
