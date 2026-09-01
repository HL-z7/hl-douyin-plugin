/**
 * 调试日志与现场快照。
 *
 * 为什么单开一个模块：日志出口复用 util.js 的 `log()`，但「要不要记」得读配置，
 * 而 config.js 自己 import util.js —— 把开关判定写进 util.js 就成环了。
 * config.js 是配置模型，也不该管截图落盘。所以这一层单独放，只依赖那两个。
 *
 * 两级开关，都在锅巴里可开关（`debug.enable` / `debug.snapshot`）：
 *
 * - `debug(scope, ...)` —— 日志级。关掉时第一行就 return，连参数里的模板字符串
 *   都可以用惰性写法（传函数）避免拼接。
 * - `snapshot(page, name)` —— 现场级。整页截图 + 页面纯文本 + HTML 落到
 *   `data/debug/`，按 `debug.keep` 滚动清理。改选择器时唯一有用的东西。
 *
 * `describePage()` 不受开关控制：它只读 url / title / 一小段文本，是失败报错时
 * 附在消息里的最低限度证据 —— 用户不开 debug 也该拿到这三样。
 */
import fs from "node:fs"
import path from "node:path"
import { dataDir, ensureDir, log, safeFileName, toError } from "./util.js"
import config from "./config.js"

/** 快照落盘目录，与失败截图（data/screenshots）分开，方便整个目录一起删 */
export function debugDir() {
  return ensureDir(dataDir, "debug")
}

export function debugOn() {
  return config.bool("debug.enable", false)
}

export function snapshotOn() {
  return debugOn() && config.bool("debug.snapshot", false)
}

/**
 * 调试日志。开关关闭时直接返回，不做任何格式化。
 *
 * 参数里允许放函数，只有开关打开时才会被调用 —— 需要 `await page.title()`
 * 这类有代价的取值时，在调用点先算好再传显然更贵，所以给个惰性口子。
 *
 * @param {string} scope 出现在行首的定位串，如 `扫码登录 ab12`
 */
export function debug(scope, ...args) {
  if (!debugOn()) return
  const parts = args.map(item => {
    if (typeof item !== "function") return item
    try {
      return item()
    } catch (error) {
      return `<取值失败:${toError(error).message}>`
    }
  })
  log("info", `[调试]${scope ? ` ${scope}` : ""}`, ...parts)
}

/**
 * 页面现状的最小描述：url、title、可见文本片段。
 *
 * 不受 debug 开关控制。抖音把页面换成验证码中间页 / 风控页时，这三样足够分辨
 * 「等的东西没出现」和「压根不是那个页面」，而代价只有一次 evaluate。
 *
 * @returns {Promise<{url: string, title: string, text: string, html: number}>}
 */
export async function describePage(page, textLimit = 200) {
  const out = { url: "", title: "", text: "", html: 0 }
  if (!page || page.isClosed?.()) return out
  try {
    out.url = page.url()
  } catch {}
  try {
    out.title = await page.title()
  } catch {}
  try {
    const info = await page.evaluate(() => ({
      text: (document.body?.innerText || "").replace(/\s+/g, " ").trim(),
      html: document.documentElement?.outerHTML?.length || 0,
      imgs: document.querySelectorAll("img").length,
    }))
    out.text = info.text.slice(0, textLimit)
    out.html = info.html
    out.imgs = info.imgs
  } catch {}
  return out
}

/** 压成一行的页面描述，直接拼进日志或错误消息 */
export async function describeLine(page, textLimit = 160) {
  const info = await describePage(page, textLimit)
  return `title=${JSON.stringify(info.title)} url=${info.url} html=${info.html}字节 img=${info.imgs ?? "?"} 文本=${JSON.stringify(info.text)}`
}

/**
 * 现场快照：截图 + 纯文本 + HTML 三个文件，同一前缀便于对照。
 *
 * 只在 `debug.snapshot` 打开时落盘。HTML 单页能有一兆多，默认关掉的原因就在这。
 *
 * @param {import("puppeteer").Page} page
 * @param {string} name 文件名中段，会过 safeFileName
 * @returns {Promise<string>} 文件名前缀，空串表示没存
 */
export async function snapshot(page, name) {
  if (!snapshotOn()) return ""
  if (!page || page.isClosed?.()) return ""
  const dir = debugDir()
  const stamp = `${Date.now()}-${safeFileName(name, "step")}`
  const prefix = path.join(dir, stamp)
  try {
    await page.screenshot({ path: `${prefix}.png`, fullPage: true })
  } catch (error) {
    log("warn", `调试截图失败（${name}）：`, toError(error).message)
  }
  try {
    const { text, html } = await page.evaluate(() => ({
      text: document.body?.innerText || "",
      html: document.documentElement?.outerHTML || "",
    }))
    fs.writeFileSync(`${prefix}.txt`, `${page.url()}\n\n${text}`, "utf8")
    fs.writeFileSync(`${prefix}.html`, html, "utf8")
  } catch (error) {
    log("warn", `调试页面落盘失败（${name}）：`, toError(error).message)
  }
  log("info", `[调试] 现场快照已存：${stamp}.{png,txt,html}`)
  pruneDebugDir()
  return prefix
}

/** 按 `debug.keep` 删最旧的文件，0 表示不清理 */
export function pruneDebugDir() {
  const keep = config.num("debug.keep", 200, { min: 0, max: 100000 })
  if (!keep) return
  try {
    const dir = debugDir()
    const files = fs
      .readdirSync(dir)
      .map(name => {
        const file = path.join(dir, name)
        try {
          return { file, mtime: fs.statSync(file).mtimeMs }
        } catch {
          return null
        }
      })
      .filter(Boolean)
    if (files.length <= keep) return
    files.sort((a, b) => a.mtime - b.mtime)
    for (const item of files.slice(0, files.length - keep)) {
      try {
        fs.unlinkSync(item.file)
      } catch {}
    }
  } catch {}
}

export default debug
