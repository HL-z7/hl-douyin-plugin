/**
 * 结果推送：把一次续火的结果发到配置的群和/或私聊。
 *
 * 两层开关，缺一不推：
 * - `push.enable`  总开关
 * - `push.target`  推群 / 推私聊 / 两者都推（group | friend | both）
 *
 * 目标列表里的 `botId` 允许留空，表示「用跑续火的那台机器人发」。多 bot 场景下
 * 指定了 botId 但它离线时不会默默换一台发（那等于把 A 的续火结果从 B 的号发出去），
 * 只有两级都不可用才退到任意在线机器人，见 resolveSender。
 */
import { config } from "./config.js"
import { store } from "./store.js"
import { log, formatTime, formatDuration, oneLine } from "./util.js"
import { listBots, pickDefaultBot, sendGroup, sendPrivate, getBot, isOnline } from "./bot.js"

/**
 * 一次续火结果的分类计数。
 * `skipped`（今天已续过火，按配置跳过）单独算一类：它既不是成功也不是失败，
 * 混进成功数会让人误以为今天又发了一轮消息。
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
 * detail 模式逐条列出发了什么（用户要求「把续火内容推送到群里」），
 * summary 模式只报数量，适合好友多、怕刷屏的场景。
 */
export function renderReport(botId, results, { mode } = {}) {
  const style = mode || config.get("push.mode", "detail")
  const { skipped, ok, fail, sentTotal, renamed } = classify(results)
  const bot = getBot(botId)
  const botName = bot?.nickname ? `${bot.nickname}(${botId})` : String(botId)

  const counts = [`成功 ${ok.length}`, `失败 ${fail.length}`]
  if (skipped.length) counts.push(`跳过 ${skipped.length}`)

  const lines = [
    "🔥 抖音续火结果",
    `机器人：${botName}`,
    `时间：${formatTime()}`,
    `账号：${results.length} 个，${counts.join("，")}`,
    `消息：共发送 ${sentTotal} 条`,
  ]

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
      for (const item of r.sent || [])
        lines.push(`  → ${item.friend}${item.note ? `（${item.note}）` : ""}：${oneLine(item.message)}`)
      if (r.missing?.length) lines.push(`  ⚠ 未找到会话：${r.missing.join("、")}`)
      if (r.error) lines.push(`  错误：${oneLine(r.error, 120)}`)
    }
  } else {
    for (const r of fail) lines.push(`❌ ${r.account}：${oneLine(r.error || "失败", 80)}`)
    for (const r of skipped) lines.push(`⏭ ${r.account}：今天已续过火`)
  }

  return lines.join("\n")
}

/**
 * 推送续火结果到配置的群与好友。
 *
 * @param {string} botId 跑续火的机器人，作为「目标 botId 留空」时的默认发送者
 * @param {object} [opts]
 * @param {boolean} [opts.force] 忽略 push.enable 与 onlyOnFail，手动 `#抖音续火` 用
 */
export async function pushReport(botId, results, { force = false } = {}) {
  if (!results?.length) return { sent: 0, skipped: "没有结果" }
  if (!force && !config.bool("push.enable", true)) return { sent: 0, skipped: "推送未启用" }

  const { fail } = classify(results)
  if (!force && config.bool("push.onlyOnFail", false) && !fail.length)
    return { sent: 0, skipped: "全部成功，按配置不推送" }

  const text = renderReport(botId, results)
  // 列表配好了但 push.target 只选了一边时，另一边不发
  const groups = config.pushToGroup() ? config.pushTargets("groups") : []
  const friends = config.pushToFriend() ? config.pushTargets("friends") : []
  if (!groups.length && !friends.length)
    return { sent: 0, skipped: `未配置推送目标（当前推送范围：${config.pushTarget()}）` }

  let sent = 0
  const errors = []

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
 * 目标里指定了 botId 就用它（要求在线），否则用跑续火的那台，
 * 再不行才退到任意在线机器人——多 bot 场景下不能默默换人发。
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

/** 推送范围的中文说明，状态面板与设置面板共用 */
export function pushTargetLabel() {
  return { group: "仅群", friend: "仅私聊", both: "群 + 私聊" }[config.pushTarget()] || "群 + 私聊"
}

/** 给状态面板/锅巴看的推送目标概览 */
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

/** 账号数为 0 的 bot 不用跑，调度器与面板都靠它筛 */
export function botsWithAccounts() {
  return store.allBots().filter(botId => store.list(botId).some(a => a.enable !== false))
}
