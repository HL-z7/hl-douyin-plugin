/**
 * 公共工具：路径常量、日志、时间格式化、深合并、点路径读写。
 *
 * 这里只放「不依赖插件内其他模块」的纯函数，任何模块都可以安全导入它，
 * 不会出现循环依赖。凡是需要读配置的逻辑一律不放这里（那属于 config.js）。
 */
import path from "node:path"
import fs from "node:fs"
import { fileURLToPath } from "node:url"

export const __dirname = path.dirname(fileURLToPath(import.meta.url))

/** 插件根目录（lib 的上一级） */
export const pluginRoot = path.join(__dirname, "..")

/** 运行时数据目录：加密后的 Cookie、主密钥、审计、失败截图。已 gitignore */
export const dataDir = path.join(pluginRoot, "data")

/** 静态资源目录：图片模板与离线一言数据 */
export const resourceDir = path.join(pluginRoot, "resources")

export const PLUGIN_NAME = "hl-douyin-plugin"
export const LOG_TAG = "[抖音续火]"

/**
 * 递归建目录并返回绝对路径。
 * 各模块在模块顶层直接调用它拿目录，省掉每次写盘前的 existsSync 判断。
 */
export function ensureDir(...segments) {
  const dir = path.join(...segments)
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true })
  return dir
}

/**
 * 统一带前缀的日志。
 * @param {"trace"|"debug"|"info"|"mark"|"warn"|"error"} level Yunzai logger 的级别
 */
export function log(level, ...args) {
  const fn = logger?.[level] || console.log
  fn.call(logger, LOG_TAG, ...args)
}

export function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms))
}

/** 随机整数，含两端 */
export function randInt(min, max) {
  return Math.floor(Math.random() * (max - min + 1)) + min
}

/**
 * 文件名安全化。截图与账号文件名会带用户输入的账号名或好友昵称，
 * 直接拼进路径会被 `../` 或盘符冒号打穿，这里只保留中英文、数字与 `_-`。
 *
 * @example safeFileName("../../etc/passwd") // => "etc-passwd"
 */
export function safeFileName(value, fallback = "unnamed") {
  const cleaned = String(value ?? "")
    .replace(/[^a-zA-Z0-9一-鿿_-]+/g, "-")
    .replace(/^-+|-+$/g, "")
  return cleaned.slice(0, 60) || fallback
}

/** 把 catch 到的任意值统一成 Error，避免 error.message 读到 undefined */
export function toError(error) {
  return error instanceof Error ? error : new Error(String(error))
}

/**
 * 打码后再进入接口响应或日志。Cookie 密文、QQ 号都走它，
 * 保证「面板上能看出是哪一条」但拿不到完整值。
 */
export function maskSecret(value, head = 4, tail = 4) {
  const str = String(value ?? "")
  if (!str) return ""
  if (str.length <= head + tail) return "*".repeat(str.length)
  return `${str.slice(0, head)}${"*".repeat(Math.min(12, str.length - head - tail))}${str.slice(-tail)}`
}

/** 宿主机本地时区的 `YYYY-MM-DD HH:mm:ss`，用于日志与面板展示 */
export function formatTime(ts = Date.now()) {
  const d = new Date(ts)
  const p = n => String(n).padStart(2, "0")
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`
}

/**
 * Asia/Shanghai 的日历日期 `YYYY-MM-DD`。
 *
 * 「今天是否已经续过火」必须按固定时区判定：服务器在国外时用本地日期会提前或推迟一天翻页，
 * 导致同一天跑两次或整天不跑。这里与消息模板的 {{date}} 用同一个时区口径。
 */
export function shanghaiDate(ts = Date.now()) {
  const fmt = new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Shanghai",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  })
  // en-CA 的短日期格式本身就是 YYYY-MM-DD，不用再拼装
  return fmt.format(new Date(ts))
}

/** 两个时间戳是否落在同一个上海日历日 */
export function isSameShanghaiDay(a, b = Date.now()) {
  if (!a) return false
  return shanghaiDate(a) === shanghaiDate(b)
}

export function formatDuration(ms) {
  if (!Number.isFinite(ms) || ms < 0) return "未知"
  const sec = Math.floor(ms / 1000)
  const d = Math.floor(sec / 86400)
  const h = Math.floor((sec % 86400) / 3600)
  const m = Math.floor((sec % 3600) / 60)
  if (d) return `${d}天${h}小时`
  if (h) return `${h}小时${m}分`
  if (m) return `${m}分${sec % 60}秒`
  return `${sec}秒`
}

/**
 * 深合并：默认配置为底，用户配置覆盖。
 * 数组整体替换而不是逐项合并——推送群列表这类数组半合并出来的结果毫无意义。
 */
export function deepMerge(base, override) {
  const out = Array.isArray(base) ? [...base] : { ...base }
  for (const [key, value] of Object.entries(override || {})) {
    if (value === undefined) continue
    if (
      value && typeof value === "object" && !Array.isArray(value) &&
      out[key] && typeof out[key] === "object" && !Array.isArray(out[key])
    ) {
      out[key] = deepMerge(out[key], value)
    } else {
      out[key] = value
    }
  }
  return out
}

/** 点路径读取，配合锅巴的扁平 field（如 "web.codeTTL"） */
export function getPath(obj, keyPath) {
  let node = obj
  for (const key of String(keyPath).split(".")) {
    if (node == null) return undefined
    node = node[key]
  }
  return node
}

/** 点路径写入，中间层缺失时补对象 */
export function setPath(obj, keyPath, value) {
  const keys = String(keyPath).split(".")
  let node = obj
  for (let i = 0; i < keys.length - 1; i++) {
    if (!node[keys[i]] || typeof node[keys[i]] !== "object" || Array.isArray(node[keys[i]]))
      node[keys[i]] = {}
    node = node[keys[i]]
  }
  node[keys[keys.length - 1]] = value
  return obj
}

/**
 * 把 `"1,2 3\n4"` 这类宽松输入统一成去重后的字符串数组。
 * 群号、QQ 号、好友昵称的多值输入都走它，接受逗号/空格/换行/中文顿号分隔。
 */
export function toIdList(value) {
  const raw = Array.isArray(value) ? value : String(value ?? "").split(/[\s,，、;；\n]+/)
  const out = []
  for (const item of raw) {
    const id = String(item ?? "").trim()
    if (id && !out.includes(id)) out.push(id)
  }
  return out
}

/** 文本压成一行并截断，用于把多行消息塞进推送/列表的一行里 */
export function oneLine(text, limit = 60) {
  const str = String(text ?? "").replace(/\s*\n\s*/g, " ").trim()
  return str.length > limit ? `${str.slice(0, limit)}…` : str
}
