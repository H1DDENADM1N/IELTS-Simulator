// 字号：只缩放文字，不动布局宽度——和雅思机考设置里 standard / large / extra large 的思路一致。
// 一切 font-size 都写成 calc(Npx * var(--text-scale))，这里只负责维护这一个系数。
const KEY = 'ielts-sim-text-scale'

export const TEXT_MIN = 0.8
export const TEXT_MAX = 1.5
export const TEXT_STEP = 0.1

const clamp = (value: number) => Math.min(TEXT_MAX, Math.max(TEXT_MIN, Math.round(value * 100) / 100))

const listeners = new Set<(value: number) => void>()

const read = (): number => {
  try {
    const raw = Number(localStorage.getItem(KEY))
    return Number.isFinite(raw) && raw > 0 ? clamp(raw) : 1
  } catch {
    return 1
  }
}

let current = read()

export const getTextScale = () => current

export function setTextScale(value: number) {
  current = clamp(value)
  document.documentElement.style.setProperty('--text-scale', String(current))
  try {
    localStorage.setItem(KEY, String(current))
  } catch {
    // 隐私模式等写不进去：本次会话仍然生效
  }
  listeners.forEach((fn) => fn(current))
  return current
}

/** dir = 1 放大，-1 缩小；已经到头时返回 false */
export function stepTextScale(dir: -1 | 1) {
  const next = clamp(current + dir * TEXT_STEP)
  if (next === current) return false
  setTextScale(next)
  return true
}

export const resetTextScale = () => setTextScale(1)

export function subscribeTextScale(fn: (value: number) => void) {
  listeners.add(fn)
  return () => {
    listeners.delete(fn)
  }
}

/** 启动时先落一次，避免首屏按 1 倍排版再跳一下 */
export const initTextScale = () => setTextScale(current)
