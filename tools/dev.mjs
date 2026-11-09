// 开发调试：Vite 热更新 + Electron 窗口（数据接口仍由本地 preload 提供）
import { spawn } from 'node:child_process'
import { existsSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const exe = path.join(ROOT, 'runtime', 'electron', 'electron.exe')
const url = 'http://127.0.0.1:5173'

if (!existsSync(exe)) {
  console.error('缺少 Electron 运行时：请先运行 pnpm pack（会下载一次运行时）')
  process.exit(1)
}

const vite = spawn('pnpm', ['dev', '--host', '127.0.0.1', '--port', '5173', '--strictPort'], {
  cwd: ROOT,
  stdio: 'inherit',
  shell: true,
})

async function waitServer() {
  for (let i = 0; i < 100; i++) {
    try {
      const res = await fetch(url)
      if (res.ok) return true
    } catch {
      // 服务还没起来
    }
    await new Promise((r) => setTimeout(r, 300))
  }
  return false
}

if (!(await waitServer())) {
  console.error('Vite 开发服务器启动超时')
  vite.kill()
  process.exit(1)
}

const devEnv = { ...process.env, IELTS_SIM_DEV_URL: url }
delete devEnv.ELECTRON_RUN_AS_NODE
delete devEnv.NODE_OPTIONS

const electron = spawn(exe, ['.'], { cwd: ROOT, stdio: 'inherit', env: devEnv })

const stop = () => {
  try { electron.kill() } catch { /* 已退出 */ }
  try { vite.kill() } catch { /* 已退出 */ }
}
process.on('SIGINT', () => { stop(); process.exit(0) })
electron.on('exit', (code) => { stop(); process.exit(code ?? 0) })
