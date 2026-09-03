/**
 * 消息模板：校验占位符、渲染最终要发给好友的文本。
 *
 * 分两个阶段，刻意分开：
 * - **保存时**校验（normalizeTemplate）。写错的 `{{xxx}}` 必须在写进配置那一刻就被拒绝，
 *   否则错误只会在几小时后的定时续火里暴露，而表现是好友收到一句带 `{{fried}}` 的原文。
 *   四处保存入口都调它：guoba.support.js:179/798（锅巴的账号级与全局模板）、
 *   lib/web.js:228/402（面板的账号级与全局模板）。lib/spark.js:368 在读出模板时再归一
 *   一次，兜住直接手改 yaml 绕过面板的那条路。
 * - **发送时**渲染（renderMessage）。唯一调用点是 lib/spark.js:399，每个好友一次。
 *
 * 日期时间固定按 Asia/Shanghai 计算，与宿主机时区无关，见 shanghaiParts。
 *
 * 导出：PLACEHOLDERS（可用占位符名，guoba.support.js:35 与 lib/web.js:394 用它生成提示，
 * 避免两处各写一份名单）、normalizeTemplate、templateNeedsYiyan、renderMessage。
 *
 * 依赖仅 yiyan.js 与 Intl，不读配置也不落盘 —— `spark.yiyanIncludeSource` 由调用方读出后
 * 以 includeSource 传入，这样本模块保持纯函数，便于在任意上下文复用。
 */
import { pickYiyan } from "./yiyan.js"

/** 模板里认得的占位符名（不含花括号）。面板/锅巴的提示文案由它拼出 */
export const PLACEHOLDERS = ["account", "friend", "yiyan", "from", "date", "time", "weekday"]

/**
 * 占位符语法：`{{ name }}`，花括号内允许空格，名字只允许英文字母。
 * 限定 `[a-zA-Z]+` 是为了让校验能报错 —— 若放宽到 `\w+`，写成 `{{friend_name}}` 会匹配上
 * 却查不到值，渲染成空串而不是抛错。
 */
const PLACEHOLDER_PATTERN = /\{\{\s*([a-zA-Z]+)\s*\}\}/g

/**
 * 校验并标准化模板。
 *
 * 两件事：拦下未识别的占位符，并把字面 `\n` 转成真换行 —— yaml 单行标量里写不了换行，
 * 而模板既能从 yaml 手改也能从面板文本框来，统一在这里归一。
 *
 * @param {*} template 模板原文，null/undefined 与纯空白都视为「没配模板」
 * @param {string} [sourceName="消息模板"] 出错信息里的来源名，用于区分是全局模板还是
 *   某个账号的模板（调用方传「账号「张三」的消息模板」这类字样）
 * @returns {string} 空串表示没配模板，调用方据此改发一言
 * @throws {Error} 含未识别占位符时抛出，消息里列出错的那几个并附上全部可用项。
 *   调用方（锅巴保存、面板保存）直接把这条消息回给用户，不再包装
 */
export function normalizeTemplate(template, sourceName = "消息模板") {
  const text = String(template ?? "")
  if (!text.trim()) return ""

  const unknown = [
    ...new Set(
      [...text.matchAll(PLACEHOLDER_PATTERN)].map(m => m[1]).filter(name => !PLACEHOLDERS.includes(name))
    ),
  ]
  if (unknown.length)
    throw new Error(
      `${sourceName} 存在未识别的占位符：${unknown.map(n => `{{${n}}}`).join("、")}。` +
        `可用：${PLACEHOLDERS.map(n => `{{${n}}}`).join(" ")}`
    )

  return text.replace(/\\n/g, "\n")
}

/**
 * 这个模板是否需要取一言。
 *
 * 没配模板时整条消息就是一言，故返回 true；配了模板则只有用到 {{yiyan}} 或 {{from}}
 * 才需要。renderMessage 用它跳过不必要的 pickYiyan（首次调用要解析并常驻 1459 条数据，
 * 约 558KB，见 lib/yiyan.js 的 load）。
 *
 * @param {string} template 已经过 normalizeTemplate 的模板
 * @returns {boolean}
 */
export function templateNeedsYiyan(template) {
  return !template || /\{\{\s*(yiyan|from)\s*\}\}/.test(template)
}

/**
 * 取 Asia/Shanghai 的日期字段。
 *
 * 走 Intl.DateTimeFormat 指定 timeZone，而不是 Date 的 getFullYear/getHours 那一套：
 * 后者按宿主机本地时区算，服务器在国外时 {{date}} 会差一天、{{time}} 差几小时，
 * 而「早上好」这类模板正是按北京时间写的。
 *
 * 也不自己加 8 小时偏移：那需要先确定当前时区偏移量，等于重新实现一遍时区库。
 *
 * @returns {{date: string, time: string, weekday: string}} date 为 YYYY-MM-DD，
 *   time 为 HH:mm（24 小时制），weekday 为「星期三」这类中文写法
 */
function shanghaiParts() {
  const now = new Date()
  const fmt = new Intl.DateTimeFormat("zh-CN", {
    timeZone: "Asia/Shanghai",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
    weekday: "long",
  })
  const parts = {}
  for (const { type, value } of fmt.formatToParts(now)) parts[type] = value
  return {
    date: `${parts.year}-${parts.month}-${parts.day}`,
    time: `${parts.hour}:${parts.minute}`,
    weekday: parts.weekday || "",
  }
}

/**
 * 渲染最终要发送的文本。每个好友调用一次，因此同一批续火里 {{yiyan}} 各不相同。
 *
 * @param {object} [ctx]
 * @param {string} [ctx.template=""] 已过 normalizeTemplate 的模板，空串表示发纯一言
 * @param {string} [ctx.account=""] 账号名，填 {{account}}
 * @param {string} [ctx.friend=""] 好友显示名，填 {{friend}}
 * @param {boolean} [ctx.includeSource=true] 纯一言模式下是否附出处，对应配置
 *   `spark.yiyanIncludeSource`。配了模板时该参数不生效 —— 出处由 {{from}} 自行摆放
 * @returns {string} 未在 PLACEHOLDERS 里的名字不会走到这里（保存时已拦），
 *   万一取不到值则填空串而不是留下原文
 */
export function renderMessage({ template = "", account = "", friend = "", includeSource = true } = {}) {
  const needYiyan = templateNeedsYiyan(template)
  const yiyan = needYiyan ? pickYiyan() : { hitokoto: "", from: "" }

  // 没配模板就沿用源项目 douyin-auto-spark 的默认格式：一言 + 可选出处
  if (!template)
    return includeSource && yiyan.from ? `${yiyan.hitokoto}\n——「${yiyan.from}」` : yiyan.hitokoto

  const { date, time, weekday } = shanghaiParts()
  const values = {
    account: String(account ?? ""),
    friend: String(friend ?? ""),
    yiyan: yiyan.hitokoto,
    from: yiyan.from,
    date,
    time,
    weekday,
  }
  return template.replace(PLACEHOLDER_PATTERN, (_m, name) => values[name] ?? "")
}
