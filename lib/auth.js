/**
 * Web 面板的鉴权：一次性验证码、会话、按 IP 的滑窗限流与封禁。
 *
 * 状态全部只在内存，不落盘、不进 redis。面板的定位是「主人临时开一次」，进程重启即全部
 * 失效：既没有残留凭据需要清理，也省掉 key 过期逻辑。代价是多进程部署时各进程互不共享
 * 验证码与会话，本插件按单进程 Yunzai 使用。
 *
 * 两条权限边界：
 *
 * 1. 验证码不携带机器人权限。verifyCode 建出的会话 botId 是空串，必须再调 selectBot 才能
 *    访问业务接口，且可选范围锁死在签发时记下的 allowedBots（发起人是哪些机器人的主人）。
 * 2. 验证码只以 sha256 形式存在（lib/crypto.js 的 hashCode），比对走 safeEqual 定长常量
 *    时间比较，日志与内存 dump 里都没有原码。
 *
 * 导出：issueCode / revokeCodes / verifyCode（验证码），getSession / touchSession /
 * selectBot / destroySession / destroyUserSessions / sessionList（会话），clientIp /
 * isBanned / countFailure / unbanAll / checkRate（IP 限流与封禁），authError / authStatus。
 *
 * 依赖：config.js 读全部阈值，crypto.js 生成与比对凭据，audit.js 记录鉴权事件。
 *
 * 使用方：lib/web.js 在路由层把这些函数串成 全局闸门 → /api/auth/verify → requireAuth →
 * requireBot；apps/web.js 签发与撤销验证码；apps/panel.js 查会话、解封 IP；
 * lib/panel.js 取 authStatus 拼面板概览。
 *
 * 调用前提：涉及 IP 的函数收的都是 clientIp(req) 的返回值，不是 req 本身；本模块抛出的错
 * 一律由 authError 构造，带 status 字段，路由层直接用 error.status 回响应码。
 */
import { config } from "./config.js"
import { audit } from "./audit.js"
import { log, formatTime } from "./util.js"
import { randomCode, randomToken, hashCode, safeEqual } from "./crypto.js"

/**
 * 四张表 + 一个封禁集合，键的选取各有原因：
 * - codes 以 codeHash 为键而非明文，verifyCode 也不用 Map.get 查（见那里的说明）
 * - rate 每个 IP 存两个独立桶，登录接口的小配额不会被业务轮询挤掉
 * - failures 与 banned 分开：前者是计数器，后者是终态，unbanAll 一次清两个
 */
const codes = new Map() // codeHash -> ticket
const sessions = new Map() // token -> session
const rate = new Map() // ip -> { general:{n,reset}, auth:{n,reset} }
const failures = new Map() // ip -> 累计鉴权失败次数
const banned = new Set()

/**
 * 每 60 秒清一遍过期项，避免长期运行后 Map 里堆满死数据。
 *
 * unref 让这个定时器不阻止进程退出（Yunzai 重启走 process.execve，见 lib/shutdown.js）；
 * 加 `?.` 是因为浏览器/部分运行时的 setInterval 返回数字而不是 Timeout 对象。
 * rate 要求两个桶都过期才删，否则会把另一个桶的计数一起抹掉。
 */
setInterval(() => {
  const now = Date.now()
  for (const [key, item] of codes) if (item.expireAt <= now) codes.delete(key)
  for (const [key, item] of sessions) if (item.expireAt <= now) sessions.delete(key)
  for (const [ip, item] of rate)
    if (item.general.reset <= now && item.auth.reset <= now) rate.delete(ip)
}, 60000).unref?.()

/**
 * 签发一次性验证码。调用方负责把 code 私信给 userId，不要出现在群消息里。
 *
 * @param {object} opts
 * @param {string|number} opts.userId 触发指令的 QQ，验证码只对他有效
 * @param {string|number} opts.botId 触发所在的机器人，仅用于审计与提示
 * @param {string[]} opts.allowedBots 该用户可进入的机器人列表（他是谁的主人就只能选谁），
 *   会去重并转成字符串，之后由 selectBot 逐次校验
 * @returns {{code: string, ttl: number, expireAt: number, id: string}} code 是明文，
 *   仅此一次可读；内存里只留 sha256
 */
export function issueCode({ userId, botId, allowedBots }) {
  // web.codeTTL 默认 300 秒；下限 60 秒，防止配成 0/负数后验证码一签发就过期
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

  // 同一用户重复发指令时作废旧码，同一时刻每人只有一个有效码，缩小可爆破面
  for (const [key, item] of codes) if (item.userId === ticket.userId) codes.delete(key)

  codes.set(ticket.codeHash, ticket)
  audit.add("web.code.issue", { botId: ticket.botId, userId: ticket.userId, ttl })
  return { code, ttl, expireAt: ticket.expireAt, id: ticket.id }
}

/**
 * 作废某用户名下全部未使用的验证码。
 *
 * 两处调用：私信发送失败时（没人知道的码留着只是爆破靶子，apps/web.js:67）、
 * 用户发「#抖音web下线」时（apps/web.js:89）。
 *
 * @returns {number} 实际删掉的验证码个数
 */
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
 * 校验验证码并建立会话。
 *
 * 新会话的 botId 是空串，还要再调 selectBot 才能访问业务接口 —— 验证码本身不携带任何
 * 机器人权限，可选范围来自签发时的 allowedBots。
 *
 * @param {string} code 用户输入的验证码，内部会 trim + 转大写（randomCode 只产大写字母数字）
 * @param {string} ip clientIp(req) 的结果，用于失败计数与写入会话
 * @returns {{token: string, ttl: number, allowedBots: string[]}} token 需由调用方放进
 *   HttpOnly Cookie，见 lib/web.js:138-141
 * @throws {Error} 带 status 的 authError：空输入、码无效或过期、单票尝试次数用尽（均 401）
 */
export function verifyCode(code, ip) {
  const input = String(code || "").trim().toUpperCase()
  if (!input) throw authError("请输入验证码")

  // 全表遍历 + 定长比对而不是 codes.get(inputHash)：Map 命中与否的耗时差异可被用来判断
  // 猜测是否正确。inputHash 与 codeHash 都是 64 位十六进制串，满足 safeEqual 的等长前提
  const inputHash = hashCode(input)
  let ticket = null
  for (const item of codes.values()) if (safeEqual(inputHash, item.codeHash)) ticket = item

  if (!ticket || ticket.used || ticket.expireAt <= Date.now()) {
    countFailure(ip)
    // 给所有在世的票加一次失败计数：否则攻击者可以在多张票之间轮换，
    // 让每张票的 attempts 都不到上限，从而绕过单票限制
    for (const item of codes.values()) item.attempts++
    pruneExhausted()
    throw authError("验证码无效或已过期")
  }

  // web.maxCodeAttempts 默认 5：命中的票也可能已被上面的连带计数打满，此时直接作废
  const maxAttempts = Math.max(1, Number(config.get("web.maxCodeAttempts", 5)) || 5)
  if (ticket.attempts >= maxAttempts) {
    codes.delete(ticket.codeHash)
    countFailure(ip)
    throw authError("验证码尝试次数过多，已作废，请重新获取")
  }

  // 一次性：置 used 之外还直接删表，避免同一个码换出第二个会话
  ticket.used = true
  codes.delete(ticket.codeHash)
  // 登录成功即清零该 IP 的失败计数，正常人手输错几次不会累积到封禁线
  clearFailure(ip)

  // web.sessionTTL 默认 1800 秒，同样兜底 60 秒下限；ttl 会原样作为 Cookie 的 Max-Age
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

/** attempts 达到 web.maxCodeAttempts 的票立即删除，不留着继续被猜 */
function pruneExhausted() {
  const maxAttempts = Math.max(1, Number(config.get("web.maxCodeAttempts", 5)) || 5)
  for (const [key, item] of codes) if (item.attempts >= maxAttempts) codes.delete(key)
}

/**
 * 按 token 取会话，顺带做过期回收。
 * @returns {object|null} 不存在或已过期都返回 null，调用方一律按未登录处理
 */
export function getSession(token) {
  const session = sessions.get(String(token || ""))
  if (!session) return null
  if (session.expireAt <= Date.now()) {
    sessions.delete(session.token)
    return null
  }
  return session
}

/**
 * 滑动续期：每个通过鉴权的请求都把过期时间推到「现在 + web.sessionTTL」，
 * 避免用户操作到一半会话到点被踢。lib/web.js 的 requireAuth 在校验成功后立即调用。
 */
export function touchSession(session) {
  const ttl = Math.max(60, Number(config.get("web.sessionTTL", 1800)) || 1800)
  session.expireAt = Date.now() + ttl * 1000
}

/**
 * 选定本会话要操作的机器人，写入 session.botId。
 *
 * 只能选签发时记下的 allowedBots：用户是 A 机器人的主人，改请求参数也操作不到 B 机器人的
 * 抖音账号。越权尝试记 web.bot.denied 审计事件，便于事后发现有人在试。
 *
 * @param {object} session getSession 返回的会话对象，会被就地修改
 * @param {string} botId 目标机器人账号
 * @returns {string} 归一化后的 botId
 * @throws {Error} 未传 botId 抛 401；不在 allowedBots 内抛 403
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

/**
 * 主动登出（/api/auth/logout）。
 * @returns {boolean} token 不存在时返回 false，路由层仍回 ok —— 客户端无从得知服务端有没有
 *   这个会话，回不同结果只会泄漏信息
 */
export function destroySession(token) {
  const session = sessions.get(String(token || ""))
  if (!session) return false
  sessions.delete(session.token)
  audit.add("web.logout", { botId: session.botId, userId: session.userId, ip: session.ip })
  return true
}

/**
 * 踢掉某用户的全部会话，「#抖音web下线」用（apps/web.js:90）。
 * 不记审计事件：调用方 apps/web.js 会统一记一条下线事件。
 * @returns {number} 被踢掉的会话数
 */
export function destroyUserSessions(userId) {
  let n = 0
  for (const [token, session] of sessions)
    if (session.userId === String(userId)) {
      sessions.delete(token)
      n++
    }
  return n
}

/**
 * 当前全部在线会话，供 apps/panel.js 的「#抖音web会话」与面板展示。
 * 只输出可安全外发的字段，token 一律不出现在返回值里。
 * @returns {Array<{userId,botId,ip,createdAt,expireAt}>} 两个时间已由 formatTime 转成字符串
 */
export function sessionList() {
  return [...sessions.values()].map(s => ({
    userId: s.userId,
    botId: s.botId,
    ip: s.ip,
    createdAt: formatTime(s.createdAt),
    expireAt: formatTime(s.expireAt),
  }))
}

/**
 * 取客户端 IP，限流与封禁的键都来自这里。
 *
 * 反代场景下 req.socket.remoteAddress 是代理自己的地址，因此优先取 x-forwarded-for 的第一
 * 跳（最靠近客户端的那个），后面的跳数都可能被中间层追加或伪造。都取不到时用 "unknown"，
 * 让所有匿名来源共享一个桶，而不是绕过限流。
 */
export function clientIp(req) {
  const forwarded = String(req.headers["x-forwarded-for"] || "").split(",")[0].trim()
  return forwarded || req.socket?.remoteAddress || "unknown"
}

/** 该 IP 是否已被封禁。lib/web.js 的全局闸门用它做 403 拦截 */
export function isBanned(ip) {
  return banned.has(String(ip))
}

/**
 * 记一次鉴权失败，累计到 web.banAfter（默认 12）次即拉黑该 IP。
 *
 * 封禁只在内存，重启即恢复；同时导出给 lib/web.js:643 的远程验证路由用 —— 那条链接在公网
 * 上，猜 ticket token 与猜面板验证码同样该被计数。
 */
export function countFailure(ip) {
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

/** 鉴权成功后清零该 IP 的失败计数；已进 banned 的不会因此解封，解封只能靠 unbanAll */
function clearFailure(ip) {
  failures.delete(String(ip || "unknown"))
}

/**
 * 解除全部封禁，「#抖音解封IP」用（apps/panel.js:229）。
 * 同时清空 failures，否则刚解封的 IP 再失败一次就会立刻被重新拉黑。
 * @returns {number} 解封前的封禁 IP 数
 */
export function unbanAll() {
  const n = banned.size
  banned.clear()
  failures.clear()
  return n
}

/**
 * 固定窗口限流，每个 IP 两个独立桶。
 *
 * 不使用令牌桶或精确滑窗：那需要保存每次请求的时间戳，而面板只需拦住爆破，窗口边界处
 * 最多放过两倍配额是可以接受的。窗口到点后整桶归零（bucket.reset <= now 时重置）。
 *
 * @param {string} ip clientIp(req) 的结果
 * @param {"general"|"auth"} [kind="general"] auth 桶给 /api/auth 前缀的请求，配额
 *   web.rateAuth 默认 8；general 桶给其余接口，web.rateGeneral 默认 300。
 *   两者共用窗口长度 web.rateWindow，默认 60 秒。传入未知值会退回 general 桶
 * @returns {boolean} true 放行，false 表示已超配额（路由层回 429）
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
  // 未知 kind 落回 general，避免拼错桶名时因 undefined 直接抛错放空整层限流
  const bucket = entry[kind] || entry.general
  const now = Date.now()
  if (bucket.reset <= now) {
    bucket.n = 0
    bucket.reset = now + windowMs
  }
  bucket.n++
  return bucket.n <= limit
}

/**
 * 构造带 HTTP 状态码的错误。路由层统一用 `error.status || 401` 回响应码，
 * 因此本模块所有对外抛出都必须经由它，否则会被当成 500 未捕获错误。
 *
 * @param {string} message 直接展示给用户，不要放入 token、IP 等敏感信息
 * @param {number} [status=401] 401 未鉴权，403 已登录但越权
 */
export function authError(message, status = 401) {
  const error = new Error(message)
  error.status = status
  return error
}

/**
 * 安全概览，供 /api/status 与 lib/panel.js 的面板汇总展示。
 * 只回计数与配置值，不含 token、IP 明细（IP 明细在 sessionList）。
 */
export function authStatus() {
  return {
    activeCodes: codes.size,
    activeSessions: sessions.size,
    bannedIps: banned.size,
    codeTTL: Number(config.get("web.codeTTL", 300)),
    sessionTTL: Number(config.get("web.sessionTTL", 1800)),
  }
}
