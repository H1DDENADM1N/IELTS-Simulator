// 图标构建：build/icon.svg → build/icon-1024.png + 多尺寸 build/icon.ico
//
// 做法：用本机 Chrome 无头模式把 SVG 渲染成 1024 透明 PNG（Electron 的 nativeImage
// 只能缩放位图，渲染不了矢量；项目里也没有 sharp），再用纯 Node 解码 PNG、按面积
// 加权缩放到各个尺寸，最后打包成 32 位 BMP 条目的 ICO。
//
// 用法：
//   node tools/icon.mjs            缺少产物时生成
//   node tools/icon.mjs --force    强制重新渲染
//
// 产物已入库，正常打包不需要装 Chrome；只有改图标时才需要。
import { existsSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
import { inflateSync } from 'node:zlib'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const SVG = path.join(ROOT, 'build', 'icon.svg')
const PNG = path.join(ROOT, 'build', 'icon-1024.png')
const ICO = path.join(ROOT, 'build', 'icon.ico')
const CACHE = path.join(ROOT, '.local', 'icon-cache')

// Windows 资源管理器 / 任务栏实际会用到的小尺寸都在这里
const SIZES = [16, 20, 24, 32, 40, 48, 64, 96, 128, 256]
const MASTER = 1024

const log = (...parts) => console.log('[icon]', ...parts)

function findChrome() {
  const candidates = [
    process.env.IELTS_SIM_CHROME,
    'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
    'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
    'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe',
    'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
    '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
    '/usr/bin/google-chrome',
    '/usr/bin/chromium',
    '/usr/bin/chromium-browser',
  ]
  return candidates.filter(Boolean).find((file) => existsSync(file)) || ''
}

function renderMaster() {
  const chrome = findChrome()
  if (!chrome) {
    throw new Error('找不到 Chrome / Edge：请设置环境变量 IELTS_SIM_CHROME 指向浏览器可执行文件')
  }
  mkdirSync(CACHE, { recursive: true })
  const profile = path.join(CACHE, `chrome-${process.pid}`)
  const svg = readFileSync(SVG, 'utf8')
    .replace(/<\?xml[\s\S]*?\?>/g, '')
    .replace(/<!--[\s\S]*?-->/g, '')
    .replace(/\swidth="100%"/, '')
    .replace(/\sheight="100%"/, '')
  // 直接打开 .svg 时 Chrome 会把小窗口撑到最小宽度并裁切；包一层 HTML 才稳
  const html = `<!doctype html><html><head><meta charset="utf-8"><style>
html,body{margin:0;padding:0;width:100%;height:100%;background:transparent;overflow:hidden}
svg{display:block;width:100vw;height:100vh}
</style></head><body>${svg}</body></html>`
  const page = path.join(CACHE, 'icon.html')
  writeFileSync(page, html, 'utf8')
  const out = path.join(CACHE, `icon-${MASTER}.png`)
  rmSync(out, { force: true })

  log(`渲染 ${MASTER}px 母版：${path.basename(chrome)}`)
  const result = spawnSync(
    chrome,
    [
      '--headless=new',
      '--disable-gpu',
      '--hide-scrollbars',
      '--no-first-run',
      '--no-default-browser-check',
      '--force-device-scale-factor=1',
      '--default-background-color=00000000',
      '--virtual-time-budget=3000',
      `--user-data-dir=${profile}`,
      `--window-size=${MASTER},${MASTER}`,
      `--screenshot=${out}`,
      'file:///' + page.replace(/\\/g, '/'),
    ],
    { timeout: 120000, encoding: 'utf8' },
  )
  rmSync(profile, { recursive: true, force: true })
  if (!existsSync(out)) {
    throw new Error(`渲染失败（退出码 ${result.status}）：${result.stderr || ''}`.trim())
  }
  writeFileSync(PNG, readFileSync(out))
  log(`母版 PNG ${(statSync(PNG).size / 1024).toFixed(0)} KB`)
}

// ---------- PNG 解码（只覆盖 Chrome 产出的 8 位 RGB/RGBA 非隔行 PNG） ----------

function decodePng(buffer) {
  if (buffer.readUInt32BE(0) !== 0x89504e47) throw new Error('不是 PNG')
  let offset = 8
  let header = null
  const idat = []
  while (offset < buffer.length) {
    const length = buffer.readUInt32BE(offset)
    const type = buffer.toString('ascii', offset + 4, offset + 8)
    const data = buffer.subarray(offset + 8, offset + 8 + length)
    offset += 12 + length
    if (type === 'IHDR') {
      header = {
        width: data.readUInt32BE(0),
        height: data.readUInt32BE(4),
        depth: data[8],
        colorType: data[9],
        interlace: data[12],
      }
    } else if (type === 'IDAT') {
      idat.push(data)
    } else if (type === 'IEND') {
      break
    }
  }
  if (!header) throw new Error('PNG 缺少 IHDR')
  const { width, height, depth, colorType, interlace } = header
  if (depth !== 8 || interlace !== 0 || ![2, 6].includes(colorType)) {
    throw new Error(`不支持的 PNG（depth=${depth} colorType=${colorType} interlace=${interlace}）`)
  }
  const channels = colorType === 6 ? 4 : 3
  const stride = width * channels
  const raw = inflateSync(Buffer.concat(idat))
  const pixels = Buffer.alloc(width * height * 4)
  const line = Buffer.alloc(stride)
  const prev = Buffer.alloc(stride)
  let position = 0
  for (let y = 0; y < height; y++) {
    const filter = raw[position++]
    raw.copy(line, 0, position, position + stride)
    position += stride
    for (let i = 0; i < stride; i++) {
      const left = i >= channels ? line[i - channels] : 0
      const up = prev[i]
      const upLeft = i >= channels ? prev[i - channels] : 0
      let value = line[i]
      if (filter === 1) value += left
      else if (filter === 2) value += up
      else if (filter === 3) value += (left + up) >> 1
      else if (filter === 4) {
        const p = left + up - upLeft
        const pa = Math.abs(p - left)
        const pb = Math.abs(p - up)
        const pc = Math.abs(p - upLeft)
        value += pa <= pb && pa <= pc ? left : pb <= pc ? up : upLeft
      } else if (filter !== 0) throw new Error(`未知 PNG 行过滤类型 ${filter}`)
      line[i] = value & 0xff
    }
    for (let x = 0; x < width; x++) {
      const src = x * channels
      const dst = (y * width + x) * 4
      pixels[dst] = line[src]
      pixels[dst + 1] = line[src + 1]
      pixels[dst + 2] = line[src + 2]
      pixels[dst + 3] = channels === 4 ? line[src + 3] : 255
    }
    line.copy(prev)
  }
  return { width, height, pixels }
}

// ---------- 面积加权缩放（在预乘 alpha 空间做，避免边缘发灰） ----------

function downsample({ width, height, pixels }, size) {
  const out = Buffer.alloc(size * size * 4)
  const ratio = width / size
  const accumulate = new Float64Array(4)
  for (let y = 0; y < size; y++) {
    const y0 = y * ratio
    const y1 = (y + 1) * ratio
    const syStart = Math.floor(y0)
    const syEnd = Math.min(height, Math.ceil(y1))
    for (let x = 0; x < size; x++) {
      const x0 = x * ratio
      const x1 = (x + 1) * ratio
      const sxStart = Math.floor(x0)
      const sxEnd = Math.min(width, Math.ceil(x1))
      accumulate.fill(0)
      let total = 0
      for (let sy = syStart; sy < syEnd; sy++) {
        const wy = Math.min(y1, sy + 1) - Math.max(y0, sy)
        if (wy <= 0) continue
        for (let sx = sxStart; sx < sxEnd; sx++) {
          const wx = Math.min(x1, sx + 1) - Math.max(x0, sx)
          if (wx <= 0) continue
          const weight = wx * wy
          const index = (sy * width + sx) * 4
          const alpha = pixels[index + 3] * weight
          accumulate[0] += pixels[index] * alpha
          accumulate[1] += pixels[index + 1] * alpha
          accumulate[2] += pixels[index + 2] * alpha
          accumulate[3] += alpha
          total += weight
        }
      }
      const dst = (y * size + x) * 4
      const alphaSum = accumulate[3]
      if (alphaSum > 0) {
        out[dst] = Math.round(accumulate[0] / alphaSum)
        out[dst + 1] = Math.round(accumulate[1] / alphaSum)
        out[dst + 2] = Math.round(accumulate[2] / alphaSum)
      }
      out[dst + 3] = Math.round(alphaSum / total)
    }
  }
  return out
}

// ---------- ICO 打包（32 位 BMP 条目，兼容性最好） ----------

function icoEntry(size, pixels) {
  const maskRow = Math.ceil(size / 32) * 4
  const header = Buffer.alloc(40)
  header.writeUInt32LE(40, 0)
  header.writeInt32LE(size, 4)
  header.writeInt32LE(size * 2, 8) // XOR 位图 + AND 掩码，高度记两份
  header.writeUInt16LE(1, 12)
  header.writeUInt16LE(32, 14)
  header.writeUInt32LE(size * size * 4 + maskRow * size, 20)

  const xor = Buffer.alloc(size * size * 4)
  for (let y = 0; y < size; y++) {
    // BMP 自下而上，通道顺序 BGRA
    const srcRow = (size - 1 - y) * size * 4
    for (let x = 0; x < size; x++) {
      const src = srcRow + x * 4
      const dst = (y * size + x) * 4
      xor[dst] = pixels[src + 2]
      xor[dst + 1] = pixels[src + 1]
      xor[dst + 2] = pixels[src]
      xor[dst + 3] = pixels[src + 3]
    }
  }
  const mask = Buffer.alloc(maskRow * size) // 全 0 = 不挖空，透明交给 alpha 通道
  return Buffer.concat([header, xor, mask])
}

function buildIco(master) {
  const images = SIZES.map((size) => ({ size, data: icoEntry(size, downsample(master, size)) }))
  const dir = Buffer.alloc(6 + images.length * 16)
  dir.writeUInt16LE(0, 0)
  dir.writeUInt16LE(1, 2)
  dir.writeUInt16LE(images.length, 4)
  let offset = dir.length
  images.forEach((image, index) => {
    const at = 6 + index * 16
    dir[at] = image.size >= 256 ? 0 : image.size
    dir[at + 1] = image.size >= 256 ? 0 : image.size
    dir[at + 2] = 0
    dir[at + 3] = 0
    dir.writeUInt16LE(1, at + 4)
    dir.writeUInt16LE(32, at + 6)
    dir.writeUInt32LE(image.data.length, at + 8)
    dir.writeUInt32LE(offset, at + 12)
    offset += image.data.length
  })
  return Buffer.concat([dir, ...images.map((image) => image.data)])
}

// ---------- 产物校验：不通过就别写进仓库 ----------

function verify(master, ico) {
  const { width, height, pixels } = master
  if (width !== MASTER || height !== MASTER) throw new Error(`母版尺寸异常：${width}x${height}`)
  const alphaAt = (x, y) => pixels[(y * width + x) * 4 + 3]
  if (alphaAt(0, 0) !== 0 || alphaAt(MASTER - 1, 0) !== 0) throw new Error('圆角应为透明')
  if (alphaAt(MASTER / 2, MASTER / 2) !== 255) throw new Error('中心应不透明')
  let opaque = 0
  for (let i = 3; i < pixels.length; i += 4) if (pixels[i] > 200) opaque++
  const coverage = opaque / (MASTER * MASTER)
  if (coverage < 0.6) throw new Error(`不透明面积过小（${(coverage * 100).toFixed(1)}%），图标可能没渲染出来`)

  if (ico.readUInt16LE(0) !== 0 || ico.readUInt16LE(2) !== 1) throw new Error('ICO 头非法')
  const count = ico.readUInt16LE(4)
  if (count !== SIZES.length) throw new Error(`ICO 条目数 ${count} != ${SIZES.length}`)
  const sizes = []
  for (let i = 0; i < count; i++) {
    const at = 6 + i * 16
    const size = ico[at] || 256
    const length = ico.readUInt32LE(at + 8)
    const offset = ico.readUInt32LE(at + 12)
    if (offset + length > ico.length) throw new Error(`${size}px 条目越界`)
    if (ico.readUInt32LE(offset) !== 40) throw new Error(`${size}px 条目不是 32 位 BMP`)
    sizes.push(size)
  }
  return { coverage, sizes }
}

function main() {
  if (!existsSync(SVG)) throw new Error('缺少 build/icon.svg')
  const force = process.argv.includes('--force')
  if (force || !existsSync(PNG)) renderMaster()
  else log('复用已有 build/icon-1024.png（--force 可重新渲染）')

  const master = decodePng(readFileSync(PNG))
  const ico = buildIco(master)
  const { coverage, sizes } = verify(master, ico)
  writeFileSync(ICO, ico)
  log(`ICO ${(ico.length / 1024).toFixed(0)} KB，含 ${sizes.join('/')} px`)
  log(`透明底覆盖 ${(coverage * 100).toFixed(1)}%，校验通过 → build/icon.ico`)
}

main()
