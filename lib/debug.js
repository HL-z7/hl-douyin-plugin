/**
 * 调试日志与现场快照。
 *
 * 为什么单开一个模块：日志出口复用 util.js 的 `log()`，但「要不要记」得读配置，
 * 而 config.js 自己 import util.js —— 把开关判定写进 util.js 就成环了。
 * config.js 是配置模型，也不该管截图落盘。所以这一层单独放，只依赖那两个。
 *
 * 两级开关，都在锅巴里可开关（`debug.enable` / `debug.snapshot`，默认都是 false）：
 *
 * - `debug(scope, ...)` —— 日志级。关掉时第一行就 return，连参数里的模板字符串
 *   都可以用惰性写法（传函数）避免拼接。
 * - `snapshot(page, name)` —— 现场级。整页截图 + 页面纯文本 + HTML 落到
 *   `data/debug/`，按 `debug.keep`（默认 200 个文件）滚动清理。改选择器时的主要依据。
 *
 * snapshot 受两级开关的「与」约束：只开 snapshot 不开 enable 不会产出文件，
 * 见 snapshotOn 与 apps/panel.js:156-169 的 `#抖音设置 快照 开` 提示。
 *
 * `describePage()` 不受开关控制：它只读 url / title / 一小段文本，是失败报错时
 * 附在消息里的最低限度证据 —— 用户不开 debug 也该拿到这三样。
 *
 * 使用者：lib/login.js（扫码与短信登录的每一步）、lib/spark.js（续火流程）、
 * lib/interact.js（远程操作的点击探针）。
 */
import fs from "node:fs"
import path from "node:path"
import { dataDir, ensureDir, log, safeFileName, toError } from "./util.js"
import config from "./config.js"

/**
 * 快照落盘目录 data/debug，与失败截图（data/screenshots，见 lib/login.js:93、
 * lib/spark.js:45 的 shotDir）分开，方便整个目录一起删而不误删失败现场。
 */
export function debugDir() {
  return ensureDir(dataDir, "debug")
}

/** 调试日志总开关 `debug.enable` */
export function debugOn() {
  return config.bool("debug.enable", false)
}

/** 现场快照开关：必须两级同时打开，只开 `debug.snapshot` 不产出任何文件 */
export function snapshotOn() {
  return debugOn() && config.bool("debug.snapshot", false)
}

/**
 * 调试日志。开关关闭时直接返回，不做任何格式化。
 *
 * 参数里允许放函数，只有开关打开时才会被调用 —— 需要 `await page.title()`
 * 这类有代价的取值时，在调用点先算好再传显然更贵，所以给个惰性口子。
 * 只接同步取值：函数返回 Promise 时这里不会 await，日志里只会打出 Promise 对象，
 * 异步现场要在调用点先 `if (debugOn())` 再 await（见 lib/login.js:559-560）。
 * 惰性函数自己抛错不会中断调用方，会被替换成 `<取值失败:…>` 占位。
 *
 * @param {string} scope 出现在行首的定位串，如 `扫码登录 ab12`
 * @param {...*} args 日志内容，函数会被调用取值
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
 * 页面现状的最小描述：url、title、可见文本片段、HTML 字节数、img 数量。
 *
 * 不受 debug 开关控制。抖音把页面换成验证码中间页 / 风控页时，这几样足够分辨
 * 「等的东西没出现」和「当前根本不是那个页面」，而代价只有一次 evaluate。
 *
 * 每一步单独 try/catch 且不上报失败：页面正在导航时 url()/title()/evaluate 都可能抛，
 * 而这个函数本身是报错路径上的取证手段，它自己抛错会盖掉真正的错误。
 *
 * @param {import("puppeteer").Page} page 空值或已关闭时返回各字段的零值
 * @param {number} [textLimit=200] 文本截断长度
 * @returns {Promise<{url: string, title: string, text: string, html: number, imgs?: number}>}
 *   html 是 outerHTML 的字符数；imgs 只在 evaluate 成功时存在
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

/**
 * 压成一行的页面描述，直接拼进日志或错误消息。
 * title 与文本走 JSON.stringify 加引号：页面文本里的换行与引号不转义会把日志行搅乱。
 *
 * @param {import("puppeteer").Page} page
 * @param {number} [textLimit=160] 比 describePage 的默认值短，因为要拼进单行
 */
export async function describeLine(page, textLimit = 160) {
  const info = await describePage(page, textLimit)
  return `title=${JSON.stringify(info.title)} url=${info.url} html=${info.html}字节 img=${info.imgs ?? "?"} 文本=${JSON.stringify(info.text)}`
}

/**
 * 现场快照：截图 + 纯文本 + HTML 三个文件，同一前缀便于对照。
 *
 * 只在两级开关都打开时落盘。HTML 单页能有一兆多，默认关掉的原因就在这。
 * 文件名 `<时间戳>-<name>`，调用方用 `01-loaded`、`09-sms-2-submit` 这类带序号的
 * name（见 lib/login.js），排序后就是完整的步骤序列。
 *
 * 截图与文本各自 try/catch，一个失败不影响另一个；两者都失败时依然会打印
 * 「现场快照已存」并返回前缀 —— 该行只表示流程走完，不代表三个文件都在。
 *
 * @param {import("puppeteer").Page} page
 * @param {string} name 文件名中段，会过 safeFileName（空/纯 emoji 时落为 "step"）
 * @returns {Promise<string>} 三个文件的公共路径前缀（含目录），空串表示开关关闭或页面已关
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
    // txt 第一行放 url：三个文件只有 png 能看出是哪个页面，纯文本需要自带出处
    fs.writeFileSync(`${prefix}.txt`, `${page.url()}\n\n${text}`, "utf8")
    fs.writeFileSync(`${prefix}.html`, html, "utf8")
  } catch (error) {
    log("warn", `调试页面落盘失败（${name}）：`, toError(error).message)
  }
  log("info", `[调试] 现场快照已存：${stamp}.{png,txt,html}`)
  pruneDebugDir()
  return prefix
}

/**
 * 按 `debug.keep` 删最旧的文件，0 表示不清理。
 *
 * 计数单位是文件不是快照，而一次 snapshot 产出 3 个文件，所以默认 200 约等于
 * 66 组现场。取 mtime 排序而不是解析文件名里的时间戳：目录里可能有手工放进去的文件。
 *
 * 整个函数包在 try 里且不上报：清理失败不影响调试本身，只是磁盘多占一点。
 */
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
          // 读取期间被别的进程删掉，跳过
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
