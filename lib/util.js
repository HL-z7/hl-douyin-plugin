/**
 * 公共工具：路径常量、日志、时间与时长格式化、脱敏、文件名过滤、深合并、点路径读写、
 * 宽松多值输入归一。
 *
 * 这里只放「不依赖插件内其他模块」的纯函数，任何模块都可以安全导入它，
 * 不会出现循环依赖。凡是需要读配置的逻辑一律不放这里（那属于 config.js，
 * 而 config.js 反过来导入本文件的 deepMerge / getPath / setPath / toIdList / log）。
 *
 * 时区有两套口径，用错会让「今天是否已续火」偏一天：formatTime 走宿主机本地时区，
 * 只用于日志与面板展示；shanghaiDate / isSameShanghaiDay 固定 Asia/Shanghai，
 * 用于业务判定，与 lib/template.js 的 {{date}} 同一口径。
 */
import path from "node:path"
import fs from "node:fs"
import { fileURLToPath } from "node:url"

/** 本文件所在目录（lib/），仅用于推导 pluginRoot */
export const __dirname = path.dirname(fileURLToPath(import.meta.url))

/** 插件根目录（lib 的上一级） */
export const pluginRoot = path.join(__dirname, "..")

/** 运行时数据目录：加密后的 Cookie、主密钥、审计、失败截图。已 gitignore */
export const dataDir = path.join(pluginRoot, "data")

/** 静态资源目录：图片模板与离线一言数据。渲染层的相对路径基准，见 lib/render.js */
export const resourceDir = path.join(pluginRoot, "resources")

/** 插件目录名。apps/update.js 用它拼 `./plugins/<name>/` 作为 git 工作目录 */
export const PLUGIN_NAME = "hl-douyin-plugin"

/** 所有日志行的统一前缀，由下面的 log() 加在参数最前面 */
export const LOG_TAG = "[抖音续火]"

/**
 * 递归建目录并返回绝对路径。
 * 各模块在模块顶层直接调用它拿目录，省掉每次写盘前的 existsSync 判断。
 *
 * @param {...string} segments 会先 path.join 再创建
 * @returns {string} 创建好的绝对路径
 */
export function ensureDir(...segments) {
  const dir = path.join(...segments)
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true })
  return dir
}

/**
 * 统一带前缀的日志。
 *
 * logger 是 Yunzai 注入的全局量，取不到时退回 console.log —— 这条路只在插件被
 * 单独 import（测试、脚本）时走到，此时 fn.call(logger, …) 的 this 是 undefined，
 * 而 console.log 不依赖 this，仍能正常输出。
 *
 * @param {"trace"|"debug"|"info"|"mark"|"warn"|"error"} level Yunzai logger 的级别
 * @param {...*} args 追加在 LOG_TAG 之后的日志内容
 */
export function log(level, ...args) {
  const fn = logger?.[level] || console.log
  fn.call(logger, LOG_TAG, ...args)
}

/**
 * @param {number} ms 毫秒
 * @returns {Promise<void>}
 */
export function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms))
}

/** 随机整数，含两端。续火的好友间随机间隔（spark.minGapMs~maxGapMs）用它取值 */
export function randInt(min, max) {
  return Math.floor(Math.random() * (max - min + 1)) + min
}

/**
 * 文件名安全化。截图与账号文件名会带用户输入的账号名或好友昵称，
 * 直接拼进路径会被 `../` 或盘符冒号打穿，这里只保留中英文、数字与 `_-`。
 *
 * 字符类是 BMP 区间 `一-鿿`（U+4E00~U+9FFF），不含 emoji 与生僻字扩展区，
 * 纯 emoji 昵称会被清空并落到 fallback。
 *
 * @param {*} value 任意值，非字符串先 String() 转换
 * @param {string} [fallback="unnamed"] 清理后为空串时的替代名
 * @returns {string} 最长 60 字符
 * @example safeFileName("../../etc/passwd") // => "etc-passwd"
 * @example safeFileName("C:\\Windows")      // => "C-Windows"
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
 *
 * 星号段最多 12 个，所以长值打码后的长度不反映原文长度。
 * 长度不足 head+tail 时整串打星，一个原文字符都不露。
 *
 * @param {*} value 任意值，非字符串先 String() 转换
 * @param {number} [head=4] 保留的前缀字符数
 * @param {number} [tail=4] 保留的后缀字符数。传 0 无效，见 maskUrl 的说明
 * @returns {string} 空值返回空串
 */
export function maskSecret(value, head = 4, tail = 4) {
  const str = String(value ?? "")
  if (!str) return ""
  if (str.length <= head + tail) return "*".repeat(str.length)
  return `${str.slice(0, head)}${"*".repeat(Math.min(12, str.length - head - tail))}${str.slice(-tail)}`
}

/**
 * 给链接里的主机与端口打码，协议与路径保持原样。
 * 群消息里回复面板地址时使用，受配置 `web.maskLinkInGroup`（默认 true）控制；
 * 私信里发的始终是完整地址。
 *
 * 不整条走 maskSecret：那会把 `/douyin/` 这段也糊掉，收到的人认不出这是哪个功能，
 * 而需要保护的只是「连到哪台机器的哪个口」。公网 IP 直连的部署，群里贴一次地址
 * 等于把机器暴露给全部群成员，端口扫描与暴力破解都从拿到地址开始。
 *
 * 主机尾部留 3 个字符：本人能认出是哪台，其他人凑不出完整地址。
 *
 * 端口整段打掉，只保留位数。不保留端口原文的理由：
 * 一是主机尾 3 位加上端口，配合群内可见的其它信息（其他插件打印过的地址、IP 段）
 * 足以拼出可扫描的目标；二是 Yunzai 默认端口 2536 本身就是指纹，暴露即提示
 * 「这是台 Yunzai，可以试它的其它路由」。位数保留是给本人对照用。
 *
 * @param {*} value URL 字符串。非标准 URL（new URL 抛错）时整体按 maskSecret(str, 0, 3)
 *   处理，宁可糊过头也不漏原文
 * @returns {string} 空值返回空串，例如 `http://1.2.3.4:2536/douyin/` 打码后主机只余尾 3 位、
 *   端口只余 4 个星号，路径 `/douyin/` 原样保留
 */
export function maskUrl(value) {
  const str = String(value ?? "").trim()
  if (!str) return ""
  try {
    const u = new URL(str)
    // hostname 不含端口；IPv6 字面量自带方括号，一起打码不影响可读性
    const host = maskSecret(u.hostname, 0, 3)
    // 不走 maskSecret(port, 0, 0)：它内部 slice(-0) 等于 slice(0)，会把整个端口原样吐回来
    const port = u.port ? `:${"*".repeat(u.port.length)}` : ""
    return `${u.protocol}//${host}${port}${u.pathname}${u.search}${u.hash}`
  } catch {
    return maskSecret(str, 0, 3)
  }
}

/**
 * 宿主机本地时区的 `YYYY-MM-DD HH:mm:ss`，用于日志与面板展示。
 * 业务判定不要用它，见下面的 shanghaiDate。
 */
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

/**
 * 两个时间戳是否落在同一个上海日历日。
 * @param {number} a 待判定的时间戳；0 / undefined（从未续过火）一律返回 false
 * @param {number} [b=Date.now()] 参照时间戳
 */
export function isSameShanghaiDay(a, b = Date.now()) {
  if (!a) return false
  return shanghaiDate(a) === shanghaiDate(b)
}

/**
 * 毫秒时长转中文可读串，只保留两个最大量级（如 `1天3小时`、`5分20秒`）。
 * @param {number} ms 非有限值或负数返回 "未知"
 */
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
 * 深合并：默认配置为底，用户配置覆盖。config.js 的 DEFAULT_CONFIG 与 config.yaml 靠它拼合。
 *
 * 数组整体替换而不是逐项合并——推送群列表这类数组半合并出来的结果毫无意义。
 * 只跳过 `undefined`；`null` 视为有效值并覆盖默认值。
 *
 * @param {object|Array} base 不被修改，逐层浅拷贝
 * @param {object} override 顶层为空/undefined 时等价于拷贝 base
 * @returns {object|Array} 新对象
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

/**
 * 点路径读取，配合锅巴的扁平 field（如 "web.codeTTL"）。
 * 中间层为 null/undefined 时返回 undefined，不抛错。
 */
export function getPath(obj, keyPath) {
  let node = obj
  for (const key of String(keyPath).split(".")) {
    if (node == null) return undefined
    node = node[key]
  }
  return node
}

/**
 * 点路径写入，中间层缺失时补对象。
 * 中间层是数组或非对象（旧配置结构变过）时会被整体替换成空对象，否则后续写入会落在
 * 原始类型上而静默丢失。
 */
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
 * 群号、QQ 号、好友昵称的多值输入都走它，接受逗号/空格/换行/中文顿号/分号分隔。
 *
 * 传入数组时不再按分隔符切分，只做 trim 与去重 —— 数组来源是已结构化的数据
 * （前端表单、yaml 列表），元素内的逗号属于内容而非分隔符。
 *
 * @param {string|Array} value
 * @returns {string[]} 保持首次出现顺序，已去空与去重
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

/**
 * 文本压成一行并截断，用于把多行消息塞进推送/列表的一行里。
 * 只折叠换行（连同其两侧空白），行内的连续空格与制表符原样保留。
 *
 * @param {*} text
 * @param {number} [limit=60] 超出时截断并追加省略号，返回长度为 limit+1
 */
export function oneLine(text, limit = 60) {
  const str = String(text ?? "").replace(/\s*\n\s*/g, " ").trim()
  return str.length > limit ? `${str.slice(0, limit)}…` : str
}
