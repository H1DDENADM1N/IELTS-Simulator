// 字体：雅思卷面（衬线）/ Arial（官方试题标准）/ 系统默认。
// 只改 <html data-font> 这一个开关，具体字体栈写在 styles.css 里。
export type FontFace = 'exam' | 'arial' | 'system'

// v2：默认字体从「卷面衬线」改成 Arial（官方机考字体）。
// 换 key 是为了让新默认真的生效——否则 v1 存下来的 'exam' 会一直盖住新默认。
const KEY = 'ielts-sim-font-face-v2'
const VALID: FontFace[] = ['exam', 'arial', 'system']

export const FONT_LABEL: Record<FontFace, string> = {
  exam: '卷面衬线',
  arial: 'Arial',
  system: '系统',
}

const listeners = new Set<(face: FontFace) => void>()

const read = (): FontFace => {
  try {
    const raw = localStorage.getItem(KEY) as FontFace | null
    // 默认 Arial：官方机考的卷面字体就是 Arial，题册式衬线要自己切
    return raw && VALID.includes(raw) ? raw : 'arial'
  } catch {
    return 'arial'
  }
}

let current = read()

export const getFontFace = () => current

export function setFontFace(face: FontFace) {
  current = VALID.includes(face) ? face : 'arial'
  document.documentElement.dataset.font = current
  try {
    localStorage.setItem(KEY, current)
  } catch {
    // 写不进去就只在本次会话生效
  }
  listeners.forEach((fn) => fn(current))
  return current
}

export function subscribeFontFace(fn: (face: FontFace) => void) {
  listeners.add(fn)
  return () => {
    listeners.delete(fn)
  }
}

/** 启动时先落一次，首屏就是用户选的那套字 */
export const initFontFace = () => setFontFace(current)
