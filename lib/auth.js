import { config } from "./config.js"
import { audit } from "./audit.js"
import { log, formatTime } from "./util.js"
import { randomCode, randomToken, hashCode, safeEqual } from "./crypto.js"

/**
 * 鉴权全部放内存：验证码 5 分钟、会话 30 分钟，重启即全失效——
 * 对这种「主人临时开一次面板」的场景，重启清空是安全收益而不是缺陷，
 * 也省掉 redis key 过期与清理的心智负担。
 */
const codes = new Map() // codeHash -> ticket
const sessions = new Map() // token -> session
const rate = new Map() // ip -> { general:{n,reset}, auth:{n,reset} }
const failures = new Map() // ip -> 累计鉴权失败次数
const banned = new Set()

/** 定时清理过期项，避免长期运行后 Map 里堆满死数据 */
setInterval(() => {
  const now = Date.now()
  for (const [key, item] of codes) if (item.expireAt <= now) codes.delete(key)
  for (const [key, item] of sessions) if (item.expireAt <= now) sessions.delete(key)
  for (const [ip, item] of rate)
    if (item.general.reset <= now && item.auth.reset <= now) rate.delete(ip)
}, 60000).unref?.()

/**
 * 签发一次性验证码。
 * @param {object} opts
 *  - userId 触发指令的 QQ，验证码只发给他
 *  - botId 触发所在的机器人
 *  - allowedBots 该用户可进入的机器人列表（他是谁的主人就只能选谁）
 */
export function issueCode({ userId, botId, allowedBots }) {
  const ttl = Math.max(60, Number(config.get("web.codeTTL", 300)) || 300)
  const code = randomCode(6)
  const ticket = {
    id: randomToken(8),
    codeHash: hashCode(code),
    userId: String(userId),
    botId: String(botId),
    allowedBots: [...new Set((allowedBots || []).map(String))],
    createdAt: Date.now(),
    expireAt: Date.now() + ttl * 1000,
    attempts: 0,
    used: false,
  }

  // 同一用户重复发指令时作废旧码，避免多个有效码同时在外面飘
  for (const [key, item] of codes) if (item.userId === ticket.userId) codes.delete(key)

  codes.set(ticket.codeHash, ticket)
  audit.add("web.code.issue", { botId: ticket.botId, userId: ticket.userId, ttl })
  return { code, ttl, expireAt: ticket.expireAt, id: ticket.id }
}

/** 指令侧撤销：主人误发时可以立刻作废 */
export function revokeCodes(userId) {
  let n = 0
  for (const [key, item] of codes)
    if (item.userId === String(userId)) {
      codes.delete(key)
      n++
    }
  return n
}

/**
 * 校验验证码并建立会话。会话建立时还没选机器人，
 * 必须再调 selectBot 才能访问业务接口——这样验证码本身不携带任何机器人权限。
 */
export function verifyCode(code, ip) {
  const input = String(code || "").trim().toUpperCase()
  if (!input) throw authError("请输入验证码")

  // 遍历 + 定长比对而不是 Map.get：Map 命中与否的耗时差异可被用来判断前缀是否正确
  const inputHash = hashCode(input)
  let ticket = null
  for (const item of codes.values()) if (safeEqual(inputHash, item.codeHash)) ticket = item

  if (!ticket || ticket.used || ticket.expireAt <= Date.now()) {
    countFailure(ip)
    // 顺带给所有在世的票加一次失败计数，防止绕过单票 attempts 上限
    for (const item of codes.values()) item.attempts++
    pruneExhausted()
    throw authError("验证码无效或已过期")
  }

  const maxAttempts = Math.max(1, Number(config.get("web.maxCodeAttempts", 5)) || 5)
  if (ticket.attempts >= maxAttempts) {
    codes.delete(ticket.codeHash)
    countFailure(ip)
    throw authError("验证码尝试次数过多，已作废，请重新获取")
  }

  ticket.used = true
  codes.delete(ticket.codeHash)
  clearFailure(ip)

  const ttl = Math.max(60, Number(config.get("web.sessionTTL", 1800)) || 1800)
  const session = {
    token: randomToken(32),
    userId: ticket.userId,
    issuedBotId: ticket.botId,
    allowedBots: ticket.allowedBots,
    botId: "",
    ip: String(ip || ""),
    createdAt: Date.now(),
    expireAt: Date.now() + ttl * 1000,
  }
  sessions.set(session.token, session)
  audit.add("web.login", { botId: ticket.botId, userId: ticket.userId, ip: session.ip })
  log("info", `Web 面板登录成功：用户 ${ticket.userId}，IP ${session.ip}`)
  return { token: session.token, ttl, allowedBots: session.allowedBots }
}

/** 单票 attempts 用尽后立即删除，别留着当爆破靶子 */
function pruneExhausted() {
  const maxAttempts = Math.max(1, Number(config.get("web.maxCodeAttempts", 5)) || 5)
  for (const [key, item] of codes) if (item.attempts >= maxAttempts) codes.delete(key)
}

export function getSession(token) {
  const session = sessions.get(String(token || ""))
  if (!session) return null
  if (session.expireAt <= Date.now()) {
    sessions.delete(session.token)
    return null
  }
  return session
}

/** 每次请求顺延会话，避免操作到一半被踢 */
export function touchSession(session) {
  const ttl = Math.max(60, Number(config.get("web.sessionTTL", 1800)) || 1800)
  session.expireAt = Date.now() + ttl * 1000
}

/**
 * 选择要操作的机器人。只能选 allowedBots 里的——
 * 用户是 A 机器人的主人，就不能靠改请求参数去操作 B 机器人的抖音账号。
 */
export function selectBot(session, botId) {
  const id = String(botId || "").trim()
  if (!id) throw authError("请选择机器人")
  if (!session.allowedBots.includes(id)) {
    audit.add("web.bot.denied", { userId: session.userId, botId: id, ip: session.ip })
    throw authError("无权操作该机器人", 403)
  }
  session.botId = id
  audit.add("web.bot.select", { userId: session.userId, botId: id, ip: session.ip })
  return id
}

export function destroySession(token) {
  const session = sessions.get(String(token || ""))
  if (!session) return false
  sessions.delete(session.token)
  audit.add("web.logout", { botId: session.botId, userId: session.userId, ip: session.ip })
  return true
}

/** 某个用户的全部会话，指令侧「#抖音web下线」用 */
export function destroyUserSessions(userId) {
  let n = 0
  for (const [token, session] of sessions)
    if (session.userId === String(userId)) {
      sessions.delete(token)
      n++
    }
  return n
}

export function sessionList() {
  return [...sessions.values()].map(s => ({
    userId: s.userId,
    botId: s.botId,
    ip: s.ip,
    createdAt: formatTime(s.createdAt),
    expireAt: formatTime(s.expireAt),
  }))
}

/** 反代场景下取真实 IP；只信第一跳，后面的都可能被伪造 */
export function clientIp(req) {
  const forwarded = String(req.headers["x-forwarded-for"] || "").split(",")[0].trim()
  return forwarded || req.socket?.remoteAddress || "unknown"
}

export function isBanned(ip) {
  return banned.has(String(ip))
}

function countFailure(ip) {
  const key = String(ip || "unknown")
  const n = (failures.get(key) || 0) + 1
  failures.set(key, n)
  const limit = Math.max(1, Number(config.get("web.banAfter", 12)) || 12)
  if (n >= limit) {
    banned.add(key)
    audit.add("web.ban", { ip: key, failures: n })
    log("warn", `IP ${key} 鉴权失败 ${n} 次，已拉黑（重启恢复）`)
  }
}

function clearFailure(ip) {
  failures.delete(String(ip || "unknown"))
}

export function unbanAll() {
  const n = banned.size
  banned.clear()
  failures.clear()
  return n
}

/**
 * 简单滑窗限流：general 给业务接口，auth 给登录接口（配额小得多）。
 * @returns {boolean} true 表示放行
 */
export function checkRate(ip, kind = "general") {
  const key = String(ip || "unknown")
  const windowMs = Math.max(1, Number(config.get("web.rateWindow", 60)) || 60) * 1000
  const limit =
    kind === "auth"
      ? Math.max(1, Number(config.get("web.rateAuth", 8)) || 8)
      : Math.max(1, Number(config.get("web.rateGeneral", 300)) || 300)

  let entry = rate.get(key)
  if (!entry) {
    entry = { general: { n: 0, reset: 0 }, auth: { n: 0, reset: 0 } }
    rate.set(key, entry)
  }
  const bucket = entry[kind] || entry.general
  const now = Date.now()
  if (bucket.reset <= now) {
    bucket.n = 0
    bucket.reset = now + windowMs
  }
  bucket.n++
  return bucket.n <= limit
}

export function authError(message, status = 401) {
  const error = new Error(message)
  error.status = status
  return error
}

/** 面板状态里显示的安全概览 */
export function authStatus() {
  return {
    activeCodes: codes.size,
    activeSessions: sessions.size,
    bannedIps: banned.size,
    codeTTL: Number(config.get("web.codeTTL", 300)),
    sessionTTL: Number(config.get("web.sessionTTL", 1800)),
  }
}
