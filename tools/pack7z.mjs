#!/usr/bin/env node
/**
 * 把便携文件夹打成 7z，方便分发 / 拷贝到 U 盘。
 *
 *   pnpm pack7z                       默认快速压缩，排除本地记录 userdata
 *   pnpm pack7z --split=3500m        FAT32 U 盘用：分成 3.5GB 一卷
 *   pnpm pack7z --include-userdata   连本机答题记录一起打包
 *   pnpm pack7z --test               打包后做完整性校验
 *   pnpm pack7z --rebuild            先跑 build + bundle 再打包
 *   pnpm pack7z --level=0            纯存储（最快，媒体文件本来已压缩）
 *   pnpm pack7z --out=D:\x.7z        自定义输出路径
 *
 * 7z 可执行文件查找顺序：IELTS_SIM_7Z 环境变量 → 系统常见安装位置 → PATH。
 * 找不到时会给出安装提示，脚本本身不联网、不下载任何东西。
 */
import { spawn, spawnSync } from 'node:child_process'
import { existsSync, readFileSync, readdirSync, rmSync, statSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const DIST = path.join(ROOT, 'dist-portable')
const argv = process.argv.slice(2)

const flag = (name) => argv.includes(`--${name}`)
const option = (name, fallback) => {
  const hit = argv.find((x) => x.startsWith(`--${name}=`))
  return hit ? hit.slice(name.length + 3) : fallback
}

if (flag('help') || flag('h')) {
  console.log(
    readFileSync(fileURLToPath(import.meta.url), 'utf8')
      .split('*/')[0]
      .replace(/^#!.*\n/, '')
      .replace(/^\/\*\*\s*\n/, '')
      .trimEnd(),
  )
  process.exit(0)
}

function find7z() {
  const candidates = [
    process.env.IELTS_SIM_7Z,
    'C:\\Program Files\\7-Zip\\7z.exe',
    'C:\\Program Files (x86)\\7-Zip\\7z.exe',
    path.join(os.homedir(), 'scoop', 'apps', '7zip', 'current', '7z.exe'),
    'C:\\ProgramData\\chocolatey\\bin\\7z.exe',
    '/usr/bin/7z',
    '/usr/bin/7za',
    '/usr/local/bin/7z',
  ].filter(Boolean)
  for (const candidate of candidates) if (existsSync(candidate)) return candidate
  const lookup = spawnSync(process.platform === 'win32' ? 'where' : 'which', ['7z'], { encoding: 'utf8' })
  if (lookup.status === 0) {
    const first = lookup.stdout.split(/\r?\n/).find((line) => line.trim())
    if (first) return first.trim()
  }
  return null
}

const sevenZip = find7z()
if (!sevenZip) {
  console.error('找不到 7z.exe。任选一种方式后重试：')
  console.error('  winget install 7zip.7zip   /   scoop install 7zip   /   choco install 7zip')
  console.error('  或设置环境变量 IELTS_SIM_7Z 指向你的 7z.exe')
  process.exit(1)
}

const source = path.resolve(ROOT, option('source', path.join(DIST, 'ielts-simulator')))
if (!existsSync(source) || !statSync(source).isDirectory()) {
  console.error(`便携目录不存在：${source}\n先运行 pnpm bundle，或用 --source 指定别的目录。`)
  process.exit(1)
}

const version = JSON.parse(readFileSync(path.join(ROOT, 'package.json'), 'utf8')).version
const now = new Date()
const pad = (n) => String(n).padStart(2, '0')
const stamp = `${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}-${pad(now.getHours())}${pad(now.getMinutes())}`
const outFile = path.resolve(ROOT, option('out', path.join(DIST, `ielts-simulator-${version}-${stamp}.7z`)))
if (outFile === source || outFile.startsWith(source + path.sep)) {
  console.error('输出文件不能放在源目录内（7z 会把正在生成的压缩包也打进去）')
  process.exit(1)
}
const level = option('level', '1')
const split = option('split', '')
const includeUserData = flag('include-userdata')

if (!/^[0-9]$/.test(level)) {
  console.error('--level 只能是 0–9（0=存储，1=最快，9=极限）')
  process.exit(1)
}

if (flag('rebuild')) {
  for (const args of [['build'], ['bundle']]) {
    console.log(`[pack7z] pnpm ${args[0]} …`)
    const r = spawnSync('pnpm', args, { cwd: ROOT, stdio: 'inherit', shell: true })
    if (r.status !== 0) process.exit(r.status ?? 1)
  }
}

// 清掉同名的旧压缩包与分卷，避免 7z a 把旧内容留在包里
const outDir = path.dirname(outFile)
const outBase = path.basename(outFile)
const isPart = (name) => name === outBase || (name.startsWith(outBase + '.') && /^\d{3}$/.test(name.slice(outBase.length + 1)))
for (const name of readdirSync(outDir).filter(isPart)) {
  rmSync(path.join(outDir, name), { force: true })
}

const args = ['a', '-t7z', `-mx=${level}`, '-mmt=on', '-bso0', '-bsp0', '-y']
if (split) args.push(`-v${split}`)
// 只排除 userdata 里的内容，保留空目录，解压后结构更清楚。
// 7z 的通配符按归档内完整路径匹配，必须带前缀 * 才能命中任意层级
if (!includeUserData) args.push('-xr!*\\userdata\\*', '-xr!*/userdata/*')
args.push(outFile, path.basename(source))

console.log(`[pack7z] 7z: ${sevenZip}`)
console.log(`[pack7z] 源: ${source}`)
console.log(`[pack7z] 输出: ${outFile}`)
console.log(`[pack7z] 级别 mx=${level}${split ? `，分卷 ${split}` : ''}${includeUserData ? '，含 userdata' : '，排除 userdata 内容'}`)

const parts = () =>
  readdirSync(outDir)
    .filter(isPart)
    .map((name) => ({ name, path: path.join(outDir, name), size: statSync(path.join(outDir, name)).size }))
    .sort((a, b) => a.name.localeCompare(b.name))

const started = Date.now()
const child = spawn(sevenZip, args, { cwd: path.dirname(source), stdio: ['ignore', 'pipe', 'pipe'] })
let output = ''
child.stdout.on('data', (chunk) => { output += chunk.toString() })
child.stderr.on('data', (chunk) => { output += chunk.toString() })

const timer = setInterval(() => {
  const written = parts().reduce((sum, p) => sum + p.size, 0)
  if (written) console.log(`[pack7z] 已写入 ${(written / 1073741824).toFixed(2)} GB …`)
}, 5000)

const code = await new Promise((resolve) => {
  child.on('exit', (status) => resolve(status))
  child.on('error', (error) => { output += String(error); resolve(-1) })
})
clearInterval(timer)

if (code !== 0) {
  console.error(output.slice(-3000) || '7z 执行失败')
  process.exit(1)
}

const files = parts()
const total = files.reduce((sum, p) => sum + p.size, 0)
console.log(`[pack7z] 完成，耗时 ${((Date.now() - started) / 1000).toFixed(1)} 秒`)
for (const file of files) console.log(`  ${file.name}  ${(file.size / 1073741824).toFixed(2)} GB`)
console.log(`[pack7z] 合计 ${(total / 1073741824).toFixed(2)} GB（${files.length} 个文件）`)

// 列出归档内容，顺便确认 userdata 里的记录没有被打进去
const listing = spawnSync(sevenZip, ['l', files[0].path], { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 })
if (listing.status === 0) {
  const lines = listing.stdout.split(/\r?\n/)
  const entries = lines.filter((line) => /^\d{4}-\d{2}-\d{2}/.test(line.trim()))
  console.log(`[pack7z] 归档内 ${entries.length} 个条目`)
  if (!includeUserData && lines.some((line) => /userdata\\.+|userdata\/.+/.test(line))) {
    console.warn('[pack7z] 警告：归档里似乎仍含 userdata 内容，请检查排除规则')
  }
}

if (flag('test')) {
  console.log('[pack7z] 正在校验完整性 …')
  const check = spawnSync(sevenZip, ['t', files[0].path, '-bso0', '-bsp0'], { encoding: 'utf8' })
  if (check.status !== 0) {
    console.error((check.stdout || '') + (check.stderr || '').slice(-2000))
    process.exit(1)
  }
  console.log('[pack7z] 完整性校验通过')
}
