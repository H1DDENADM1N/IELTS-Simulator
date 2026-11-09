// 自检三层（静态数据 / 纯逻辑 / 真窗口）共用的迷你断言框架。
// 每项检查产出 { group, name, ok, detail, skipped, ms }，由运行器统一汇总。
export function createSuite(group) {
  const checks = []

  const check = async (name, fn) => {
    const started = Date.now()
    try {
      const detail = await fn()
      if (detail && typeof detail === 'object' && detail.skip) {
        checks.push({ group, name, ok: true, skipped: true, detail: detail.reason, ms: Date.now() - started })
      } else {
        checks.push({ group, name, ok: true, detail, ms: Date.now() - started })
      }
    } catch (error) {
      checks.push({ group, name, ok: false, detail: String(error?.message || error), ms: Date.now() - started })
    }
  }

  const skip = (name, reason) => checks.push({ group, name, ok: true, skipped: true, detail: reason, ms: 0 })
  return { checks, check, skip }
}

export function assert(condition, message) {
  if (!condition) throw new Error(message)
}

export function assertEqual(actual, expected, label = '值') {
  if (actual !== expected) throw new Error(`${label}：期望 ${JSON.stringify(expected)}，实际 ${JSON.stringify(actual)}`)
  return actual
}

export function assertDeep(actual, expected, label = '值') {
  const a = JSON.stringify(actual)
  const b = JSON.stringify(expected)
  if (a !== b) throw new Error(`${label}：期望 ${b}，实际 ${a}`)
  return actual
}
