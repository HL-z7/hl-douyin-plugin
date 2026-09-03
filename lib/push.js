/**
 * 结果推送：把一次续火的结果渲染成文本，发到配置的群与私聊。
 *
 * 两层开关，缺一不推：
 * - `push.enable`  总开关，默认 true
 * - `push.target`  推群 / 推私聊 / 两者都推（group | friend | both，默认 both）
 * 另有 `push.onlyOnFail`（默认 false）在全部成功时不推，`push.mode`（detail | summary）
 * 决定文本详尽程度。手动触发时可用 force 忽略前两项，见 pushReport。
 *
 * 目标列表里的 `botId` 允许留空，表示「用跑续火的那台机器人发」。发送者的解析顺序见
 * resolveSender。
 *
 * 导出：classify（结果分类，调用方也用它取计数）、renderReport（渲染文本）、
 * pushReport（渲染并发送）、pushTargetLabel / pushSummary（面板展示）、
 * botsWithAccounts（筛出有账号的机器人）。
 *
 * 依赖：config.js 读开关与目标列表（pushTargets 负责把锅巴与手写 yaml 两种形态归一），
 * bot.js 发消息与查在线，store.js 供 botsWithAccounts 统计。
 *
 * 使用方：lib/scheduler.js（定时批量续火后推送）、apps/spark.js（手动 `#抖音续火`）、
 * lib/web.js（面板触发，force: true）、lib/panel.js（只取 pushSummary 展示）。
 *
 * 调用前提：results 是 lib/spark.js runAccount / runBot 的返回结构，每项含
 * ok / skipped / sent / missing / renamed / error / durationMs 字段。
 */
import { config } from "./config.js"
import { store } from "./store.js"
import { log, formatTime, formatDuration, oneLine } from "./util.js"
import { listBots, pickDefaultBot, sendGroup, sendPrivate, getBot, isOnline } from "./bot.js"

/**
 * 一次续火结果的分类计数。
 *
 * `skipped`（今天已续过火，按配置跳过）单独算一类：它既不是成功也不是失败，
 * 混进成功数会让人误以为今天又发了一轮消息。ok / fail 都只在非 skipped 的项里分。
 *
 * @param {Array} results lib/spark.js 的每账号结果；非数组时按空数组处理
 * @returns {{all: Array, skipped: Array, ok: Array, fail: Array, sentTotal: number,
 *   renamed: Array<{from: string, to: string}>}} sentTotal 含 skipped 项（其 sent 为空），
 *   renamed 是各账号 renamed 的扁平合并
 */
export function classify(results) {
  const list = Array.isArray(results) ? results : []
  const skipped = list.filter(r => r.skipped)
  const rest = list.filter(r => !r.skipped)
  return {
    all: list,
    skipped,
    ok: rest.filter(r => r.ok),
    fail: rest.filter(r => !r.ok),
    sentTotal: list.reduce((n, r) => n + (r.sent?.length || 0), 0),
    renamed: list.flatMap(r => r.renamed || []),
  }
}

/**
 * 把一次续火结果渲染成推送文本。
 *
 * detail 模式逐条列出发了什么（用户要求「把续火内容推送到群里」），summary 模式只列失败与
 * 跳过的账号，适合好友多、怕刷屏的场景。两种模式的头部计数相同。
 *
 * @param {string} botId 跑这轮续火的机器人，用于取昵称；离线或查不到时只显示号码
 * @param {Array} results 同 classify
 * @param {object} [opts]
 * @param {"detail"|"summary"} [opts.mode] 不传则读 `push.mode`（默认 detail）
 * @returns {string} 多行文本，行间以 \n 连接
 */
export function renderReport(botId, results, { mode } = {}) {
  const style = mode || config.get("push.mode", "detail")
  const { skipped, ok, fail, sentTotal, renamed } = classify(results)
  const bot = getBot(botId)
  const botName = bot?.nickname ? `${bot.nickname}(${botId})` : String(botId)

  const counts = [`成功 ${ok.length}`, `失败 ${fail.length}`]
  // 没有跳过的账号时不显示这一项，避免每天都出现一个恒为 0 的计数
  if (skipped.length) counts.push(`跳过 ${skipped.length}`)

  const lines = [
    "🔥 抖音续火结果",
    `机器人：${botName}`,
    `时间：${formatTime()}`,
    `账号：${results.length} 个，${counts.join("，")}`,
    `消息：共发送 ${sentTotal} 条`,
  ]

  // 好友改名后按别名命中并已就地更新，提示一次让用户知道本地名称变了（store.promoteAlias）
  if (renamed.length)
    lines.push(`改名自愈：${renamed.map(r => `${r.from} → ${r.to}`).join("，")}`)

  if (style === "detail") {
    for (const r of results) {
      lines.push("────────────")
      if (r.skipped) {
        lines.push(`⏭ ${r.account}：今天已续过火，按配置跳过`)
        continue
      }
      lines.push(`${r.ok ? "✅" : "❌"} ${r.account}${r.durationMs ? `（${formatDuration(r.durationMs)}）` : ""}`)
      // oneLine 把消息里的换行压成一行：模板可能是多行的，展开会把推送撑得很长
      for (const item of r.sent || [])
        lines.push(`  → ${item.friend}${item.note ? `（${item.note}）` : ""}：${oneLine(item.message)}`)
      if (r.missing?.length) lines.push(`  ⚠ 未找到会话：${r.missing.join("、")}`)
      if (r.error) lines.push(`  错误：${oneLine(r.error, 120)}`)
    }
  } else {
    // summary 只列需要处理的账号：成功的看头部计数即可
    for (const r of fail) lines.push(`❌ ${r.account}：${oneLine(r.error || "失败", 80)}`)
    for (const r of skipped) lines.push(`⏭ ${r.account}：今天已续过火`)
  }

  return lines.join("\n")
}

/**
 * 渲染并推送续火结果。
 *
 * 不抛异常：单个目标发送失败记入 errors 继续下一个，全部发完再写一条 warn 日志。推送失败
 * 不该让触发它的续火流程被判为失败。
 *
 * @param {string} botId 跑续火的机器人，作为「目标 botId 留空」时的默认发送者
 * @param {Array} results 同 classify；空数组直接返回不推
 * @param {object} [opts]
 * @param {boolean} [opts.force] 忽略 push.enable 与 push.onlyOnFail，手动 `#抖音续火`
 *   与面板触发用（lib/web.js:336）。仍然受 push.target 与目标列表约束
 * @returns {Promise<{sent: number, skipped?: string, errors?: string[]}>} skipped 是没推的
 *   原因（供面板原样展示），有它时 sent 为 0
 */
export async function pushReport(botId, results, { force = false } = {}) {
  if (!results?.length) return { sent: 0, skipped: "没有结果" }
  if (!force && !config.bool("push.enable", true)) return { sent: 0, skipped: "推送未启用" }

  const { fail } = classify(results)
  if (!force && config.bool("push.onlyOnFail", false) && !fail.length)
    return { sent: 0, skipped: "全部成功，按配置不推送" }

  const text = renderReport(botId, results)
  // 目标列表配好了但 push.target 只选了一边时，另一边不取，列表本身不用改
  const groups = config.pushToGroup() ? config.pushTargets("groups") : []
  const friends = config.pushToFriend() ? config.pushTargets("friends") : []
  if (!groups.length && !friends.length)
    return { sent: 0, skipped: `未配置推送目标（当前推送范围：${config.pushTarget()}）` }

  let sent = 0
  const errors = []

  // 群与私聊只差发送函数与文案，合成一张表走同一段逻辑
  for (const [kind, targets, send] of [
    ["群", groups, sendGroup],
    ["好友", friends, sendPrivate],
  ]) {
    for (const target of targets) {
      const from = resolveSender(target.botId, botId)
      if (!from) {
        errors.push(`${kind} ${target.id}：没有可用机器人`)
        continue
      }
      try {
        await send(from, target.id, text)
        sent++
      } catch (error) {
        errors.push(`${kind} ${target.id}：${error.message}`)
      }
    }
  }

  if (errors.length) log("warn", "部分推送失败：", errors.join("；"))
  return { sent, errors }
}

/**
 * 解析用哪台机器人发。
 *
 * 顺序是「目标里指定的 botId（须在线）→ 跑续火的那台（须在线）→ 任意在线机器人 →
 * pickDefaultBot()」。前两级都要求在线，是因为对离线 bot 调 sendGroup 只会抛错。
 *
 * @param {string} preferred 推送目标里配的 botId，允许为空
 * @param {string} fallback 跑这轮续火的机器人
 * @returns {string} 机器人账号；一个都没有时返回空串，调用方据此记「没有可用机器人」
 */
function resolveSender(preferred, fallback) {
  for (const candidate of [preferred, fallback]) {
    const id = String(candidate || "").trim()
    if (!id) continue
    const bot = getBot(id)
    if (bot && isOnline(bot)) return id
  }
  return listBots().find(b => b.online)?.uin || pickDefaultBot() || ""
}

/**
 * 推送范围的中文说明，状态面板与锅巴设置页共用。
 * @returns {string} 非法 push.target 值也会落到「群 + 私聊」，与 config.pushTarget 的兜底一致
 */
export function pushTargetLabel() {
  return { group: "仅群", friend: "仅私聊", both: "群 + 私聊" }[config.pushTarget()] || "群 + 私聊"
}

/**
 * 推送配置概览，给 /api/status 与 lib/panel.js 用。
 * 含归一化后的完整目标列表（groups / friends），面板要显示具体群号与账号。
 */
export function pushSummary() {
  const groups = config.pushTargets("groups")
  const friends = config.pushTargets("friends")
  return {
    enable: config.bool("push.enable", true),
    mode: config.get("push.mode", "detail"),
    onlyOnFail: config.bool("push.onlyOnFail", false),
    target: config.pushTarget(),
    targetLabel: pushTargetLabel(),
    toGroup: config.pushToGroup(),
    toFriend: config.pushToFriend(),
    groupCount: groups.length,
    friendCount: friends.length,
    groups,
    friends,
  }
}

/**
 * 名下有可用抖音账号的机器人列表，定时调度与面板都靠它筛掉空跑的 bot。
 * 判据是「至少一个账号 enable 不为 false」—— 账号默认没有 enable 字段即视为启用。
 * @returns {string[]} 机器人账号数组
 */
export function botsWithAccounts() {
  return store.allBots().filter(botId => store.list(botId).some(a => a.enable !== false))
}
