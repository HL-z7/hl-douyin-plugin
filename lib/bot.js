/**
 * 多机器人适配层：取实例、列在线、判主人、发消息。
 *
 * Web 面板（lib/web.js）、推送（lib/push.js）、指令（apps/web.js）、锅巴
 * （guoba.support.js）都从这里拿 Bot，插件自身不直接摸 `global.Bot[uin]`。
 * 集中的收益是「谁的主人只能看谁的账号」这条隔离规则只有一处实现。
 *
 * 关于 `global.Bot`：它是 Yunzai 在构造器里 `return new Proxy(this.bots, { get })`
 * 出来的代理（框架 lib/bot.js:80-95，注意与本文件同名），只有 get 陷阱。读取时优先级是
 * `this[prop] ?? util[prop] ?? this.bots[prop]`，都取不到才按 uin 顺序重定向到某个
 * bot 实例上的同名属性。因此写操作会落在被代理的 `this.bots` 上而读仍走 `this[prop]`：
 * `Bot.restart = fn` 赋值成功，但调用时拿到的还是原来那个。要包装框架方法必须先取
 * `global.Bot.bot`（`bot = this` 字段，框架 lib/bot.js:17），见 lib/shutdown.js 的 hookRestart。
 */
import cfg from "../../../lib/config/config.js"
import { log } from "./util.js"

/**
 * 按 selfId 取 Bot 实例。
 *
 * 同时试字符串与数字键，是因为两侧的 key 类型不统一：HTTP 请求里的 selfId 是字符串，
 * OneBotv11 用 `data.self_id` 注册（数字），ICQQ-Plugin 用 `Number(token.shift())`
 * 注册（数字），stdin 适配器则用 `"stdin"`（字符串）。
 *
 * @param {string|number} selfId
 * @returns {object|null} 取不到（未登录、已下线、global.Bot 还没建好）时返回 null
 */
export function getBot(selfId) {
  if (!selfId) return null
  const B = global.Bot
  if (!B) return null
  return B[selfId] || B[Number(selfId)] || null
}

/**
 * 是否 ICQQ 协议的 bot。抖音验证的远程操作链接只私信发给发起人，
 * 而部分能力（好友列表、图片发送）在不同适配器上差异较大，需要区分。
 */
export function isICQQ(bot) {
  // adapter.id === "QQ" 也会命中 OneBotv11（该适配器 id="QQ"、name="OneBotv11"），
  // 所以以 adapter.name 为准（ICQQ-Plugin 设 name="ICQQ"），id 只做兜底并要求存在 sdk
  return bot?.adapter?.name === "ICQQ" || (bot?.adapter?.id === "QQ" && Boolean(bot?.sdk))
}

/**
 * 是否在线。
 *
 * 只有 ICQQ 暴露 `sdk.status`，11 = icqq 的 OnlineStatus.Online
 * （node_modules/icqq/lib/common.js:189）。其它适配器没有这个字段，一律按在线处理 ——
 * 它们能出现在 Bot.uin 里就说明连接已建立，下线时适配器会自己把 uin 摘掉。
 */
export function isOnline(bot) {
  if (!bot) return false
  if (bot.sdk?.status !== undefined) return bot.sdk.status === 11
  return true
}

/**
 * 当前已登录的全部 Bot，Web 面板的「选择机器人」列表就是它。
 *
 * 数据源是 `Bot.uin`（适配器上线时 push 进去，见 lib/events/connect.js:13）。
 * 注意它包含离线实例，online 字段才是状态；调用方要筛在线得自己过滤。
 *
 * @param {{icqqOnly?: boolean}} [opts] icqqOnly=true 只保留 ICQQ
 * @returns {Array<{uin: string, nickname: string, adapter: string, online: boolean,
 *   avatar: string}>}
 */
export function listBots({ icqqOnly = false } = {}) {
  const B = global.Bot
  // 拷贝一份：Bot.uin 被 Object.assign 改造过（自定义 toJSON / includes），
  // 直接遍历会受它的 now 缓存影响
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

/**
 * 没指定 bot 时的兜底：优先在线的 ICQQ，其次任意在线，最后列表里第一个。
 * 锅巴面板（guoba.support.js:139）在没有会话上下文时用它决定操作哪台。
 *
 * @returns {string} uin 字符串；一台都没有时返回空串
 */
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
 * 该 bot 的主人列表。cfg.master 由框架 lib/config/config.js:75-91 把 other.yaml 的
 * `bot_id:user_id` 解析成 { botId: [userId] }，loader 判定 e.isMaster 读的就是它
 * （框架 lib/plugins/loader.js:425），所以这里用同一份数据，Web 面板的权限判断才不会和
 * 指令权限对不上。
 *
 * 注意 other.yaml 里另有 masterQQ（全局主人），它不参与 e.isMaster 判定，这里也不读。
 *
 * @returns {string[]} 该 bot 没配主人时返回空数组
 */
export function mastersOf(selfId) {
  const list = cfg.master?.[String(selfId)]
  return Array.isArray(list) ? list.map(String) : []
}

/** 判断某个 QQ 是否为该 bot 的主人，与 e.isMaster 同源 */
export function isMasterOf(selfId, userId) {
  return mastersOf(selfId).includes(String(userId))
}

/**
 * 发私信。验证码、续火结果、抖音验证的远程链接都走它。
 *
 * userId 先试 Number()：ICQQ 的 pickFriend 要数字 QQ 号，而 HTTP/配置里传来的是字符串；
 * 非数字账号（stdin 适配器的 "stdin"）Number() 得 NaN，`||` 兜回原值。
 *
 * @param {string|number} selfId
 * @param {string|number} userId
 * @param {*} msg Yunzai 消息段或字符串
 * @throws {Error} `Bot ${selfId} 不在线` —— 实例取不到，此时不尝试通用发送
 */
export async function sendPrivate(selfId, userId, msg) {
  const bot = getBot(selfId)
  if (!bot) throw new Error(`Bot ${selfId} 不在线`)
  try {
    if (typeof bot.pickFriend === "function") return await bot.pickFriend(Number(userId) || userId).sendMsg(msg)
    return await bot.sendMsg(msg, userId)
  } catch (error) {
    // 好友列表没同步完时 pickFriend 会失败，退回框架的通用发送。
    // Bot.sendFriendMsg 内部会在 bot 未就绪时等 connect 事件（最长 300 秒，
    // 框架 lib/bot.js:541-565）
    log("warn", `私信 ${userId} 失败，尝试框架通用发送：`, error.message)
    return await global.Bot.sendFriendMsg(selfId, userId, msg)
  }
}

/**
 * 发群消息。续火结果推送用它，地址类内容需先过 maskUrl（见 web.maskLinkInGroup）。
 * 失败退路与 sendPrivate 同构，见上。
 *
 * @throws {Error} `Bot ${selfId} 不在线`
 */
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
