import { pickYiyan } from "./yiyan.js"

export const PLACEHOLDERS = ["account", "friend", "yiyan", "from", "date", "time", "weekday"]
const PLACEHOLDER_PATTERN = /\{\{\s*([a-zA-Z]+)\s*\}\}/g

/**
 * 校验并标准化模板：写错的 {{xxx}} 要在保存时就拦住，
 * 否则会把占位符原样发给好友。yaml 里不好写多行，允许字面 \n 表示换行。
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

export function templateNeedsYiyan(template) {
  return !template || /\{\{\s*(yiyan|from)\s*\}\}/.test(template)
}

/**
 * 上海时区的日期字段。宿主机时区不一定是 +08:00，
 * 直接用 Date 的本地方法会让 {{date}} 在国外服务器上差一天。
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
 * 渲染最终要发送的文本。
 * @param {object} ctx { template, account, friend, includeSource }
 */
export function renderMessage({ template = "", account = "", friend = "", includeSource = true } = {}) {
  const needYiyan = templateNeedsYiyan(template)
  const yiyan = needYiyan ? pickYiyan() : { hitokoto: "", from: "" }

  // 没配模板就沿用源项目的默认格式：一言 + 可选出处
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
