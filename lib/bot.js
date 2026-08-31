import cfg from "../../../lib/config/config.js"
import { log } from "./util.js"

/**
 * 多 bot 适配集中在这里：Web 面板、推送、指令都从这拿 Bot 实例，
 * 避免各处重复写 Bot[uin] || Bot[Number(uin)] 这类兼容代码
 * （HTTP 传过来的 selfId 是字符串，而 ICQQ 的 key 可能是数字）。
 */
export function getBot(selfId) {
  if (!selfId) return null
  const B = global.Bot
  if (!B) return null
  return B[selfId] || B[Number(selfId)] || null
}

export function isICQQ(bot) {
  // adapter.id === "QQ" 也会命中 OneBotv11，所以以 adapter.name 为准，id 只做兜底
  return bot?.adapter?.name === "ICQQ" || (bot?.adapter?.id === "QQ" && Boolean(bot?.sdk))
}

export function isOnline(bot) {
  if (!bot) return false
  if (bot.sdk?.status !== undefined) return bot.sdk.status === 11
  return true
}

/** 当前在线的全部 Bot，Web 面板的「选择机器人」列表就是它 */
export function listBots({ icqqOnly = false } = {}) {
  const B = global.Bot
  const uins = Array.isArray(B?.uin) ? [...B.uin] : []
  const out = []
  for (const uin of uins) {
    const bot = getBot(uin)
    if (!bot) continue
    if (icqqOnly && !isICQQ(bot)) continue
    out.push({
      uin: String(uin),
      nickname: bot.nickname || bot.info?.nickname || String(uin),
      adapter: bot.adapter?.name || bot.adapter?.id || "未知",
      online: isOnline(bot),
      avatar: bot.avatar || "",
    })
  }
  return out
}

/** 没指定 bot 时的兜底：优先在线的 ICQQ，其次任意在线 */
export function pickDefaultBot() {
  const bots = listBots()
  return (
    bots.find(b => b.online && isICQQ(getBot(b.uin)))?.uin ||
    bots.find(b => b.online)?.uin ||
    bots[0]?.uin ||
    ""
  )
}

/**
 * 该 bot 的主人列表。cfg.master 由 lib/config/config.js 把 other.yaml 的
 * `bot_id:user_id` 解析成 { botId: [userId] }，loader 判定 e.isMaster 读的就是它，
 * 所以这里用同一份数据，Web 面板的权限判断才不会和指令权限对不上。
 */
export function mastersOf(selfId) {
  const list = cfg.master?.[String(selfId)]
  return Array.isArray(list) ? list.map(String) : []
}

/** 判断某个 QQ 是否为该 bot 的主人，与 e.isMaster 同源 */
export function isMasterOf(selfId, userId) {
  return mastersOf(selfId).includes(String(userId))
}

export async function sendPrivate(selfId, userId, msg) {
  const bot = getBot(selfId)
  if (!bot) throw new Error(`Bot ${selfId} 不在线`)
  try {
    if (typeof bot.pickFriend === "function") return await bot.pickFriend(Number(userId) || userId).sendMsg(msg)
    return await bot.sendMsg(msg, userId)
  } catch (error) {
    // 好友列表没同步完时 pickFriend 会失败，退回框架的通用发送
    log("warn", `私信 ${userId} 失败，尝试框架通用发送：`, error.message)
    return await global.Bot.sendFriendMsg(selfId, userId, msg)
  }
}

export async function sendGroup(selfId, groupId, msg) {
  const bot = getBot(selfId)
  if (!bot) throw new Error(`Bot ${selfId} 不在线`)
  try {
    if (typeof bot.pickGroup === "function") return await bot.pickGroup(Number(groupId) || groupId).sendMsg(msg)
    return await bot.sendMsg(msg, undefined, groupId)
  } catch (error) {
    log("warn", `群 ${groupId} 发送失败，尝试框架通用发送：`, error.message)
    return await global.Bot.sendGroupMsg(selfId, groupId, msg)
  }
}
