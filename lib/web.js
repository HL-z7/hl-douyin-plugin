import path from "node:path"
import express from "express"
import { pluginRoot, log, toError, maskSecret } from "./util.js"
import { config } from "./config.js"
import { store, parseCookieInput } from "./store.js"
import { audit } from "./audit.js"
import { scheduler } from "./scheduler.js"
import { runAccount, sendCustom, listFriends, summarize, isRunning, runningList } from "./spark.js"
import { startQrLogin, getSession as getQrSession, getLiveSession, cancelSession, manualLogin, checkAccount } from "./login.js"
import { pushReport, pushSummary } from "./push.js"
import { listBots } from "./bot.js"
import { normalizeTemplate, PLACEHOLDERS } from "./template.js"
import { getTicket, countAct, snapshot, applyAct } from "./remote.js"
import { debug } from "./debug.js"
import * as chat from "./chat.js"
import {
  verifyCode,
  getSession,
  touchSession,
  selectBot,
  destroySession,
  clientIp,
  isBanned,
  countFailure,
  checkRate,
  authStatus,
} from "./auth.js"

const webDir = path.join(pluginRoot, "web")
const COOKIE_NAME = "hl_douyin_session"

/**
 * 路由必须在模块导入期注册：框架在 PluginsLoader.load() 之后会给 Bot.express
 * 追加兜底重定向，晚于那一刻挂的路由会被吃掉。
 */
export function setupWeb() {
  if (config.get("web.enable", true) === false) {
    log("info", "Web 面板未启用")
    return { enabled: false }
  }

  const app = global.Bot?.express
  if (!app) {
    log("warn", "Bot.express 不可用，Web 面板未挂载")
    return { enabled: false }
  }

  const base = config.webBase()

  // 面板请求量大（轮询二维码/状态），默认静默它的 HTTP 日志
  if (Array.isArray(app.quiet) && !app.quiet.includes(base)) app.quiet.push(base)

  registerRoutes(app, base)
  maybeStandalone(app, base)

  log("info", `Web 面板地址：${config.webOrigin()}${base}/`)
  return { enabled: true, base }
}

function registerRoutes(app, base) {
  const json = express.json({ limit: "2mb" })

  // ---------- 全局闸门：黑名单 + 限流 ----------
  app.use(base, (req, res, next) => {
    const ip = clientIp(req)
    if (isBanned(ip)) return res.status(403).json({ error: "该 IP 已被封禁" })
    const kind = req.path.startsWith("/api/auth") ? "auth" : "general"
    if (!checkRate(ip, kind)) return res.status(429).json({ error: "请求过于频繁，请稍后再试" })
    res.set("Cache-Control", "no-store")
    res.set("X-Frame-Options", "DENY")
    res.set("X-Content-Type-Options", "nosniff")
    res.set("Referrer-Policy", "no-referrer")
    next()
  })

  // ---------- 鉴权接口（无需登录） ----------
  app.post(`${base}/api/auth/verify`, json, (req, res) => {
    const ip = clientIp(req)
    try {
      const { token, ttl, allowedBots } = verifyCode(req.body?.code, ip)
      res.setHeader(
        "Set-Cookie",
        `${COOKIE_NAME}=${token}; Path=${base}; HttpOnly; SameSite=Strict; Max-Age=${ttl}`
      )
      res.json({
        ok: true,
        ttl,
        bots: listBots().filter(b => allowedBots.includes(b.uin)),
      })
    } catch (error) {
      res.status(error.status || 401).json({ error: error.message })
    }
  })

  app.post(`${base}/api/auth/logout`, (req, res) => {
    destroySession(readToken(req, base))
    res.setHeader("Set-Cookie", `${COOKIE_NAME}=; Path=${base}; HttpOnly; SameSite=Strict; Max-Age=0`)
    res.json({ ok: true })
  })

  app.get(`${base}/api/auth/state`, (req, res) => {
    const session = getSession(readToken(req, base))
    if (!session) return res.json({ authed: false })
    touchSession(session)
    res.json({
      authed: true,
      userId: maskSecret(session.userId, 3, 2),
      botId: session.botId,
      bots: listBots().filter(b => session.allowedBots.includes(b.uin)),
    })
  })

  // ---------- 之后的 API 全部需要登录 ----------
  const requireAuth = (req, res, next) => {
    const session = getSession(readToken(req, base))
    if (!session) return res.status(401).json({ error: "未登录或会话已过期" })
    touchSession(session)
    req.dySession = session
    next()
  }

  /** 需要已选定机器人的接口再加这一层，顺手把 botId 交给 handler */
  const requireBot = (req, res, next) => {
    if (!req.dySession?.botId) return res.status(400).json({ error: "请先选择机器人" })
    req.botId = req.dySession.botId
    next()
  }

  app.use(`${base}/api`, (req, res, next) => {
    // 鉴权接口自己不能要求已登录；远程验证走票据（registerVerifyRoutes 里的
    // requireTicket），和面板会话是两套权限，不能被这层拦下来
    if (req.path.startsWith("/auth/") || req.path.startsWith("/verify/")) return next()
    requireAuth(req, res, next)
  })

  app.post(`${base}/api/bot/select`, json, (req, res) => {
    try {
      const botId = selectBot(req.dySession, req.body?.botId)
      res.json({ ok: true, botId })
    } catch (error) {
      res.status(error.status || 400).json({ error: error.message })
    }
  })

  // ---------- 账号管理 ----------
  app.get(`${base}/api/accounts`, requireBot, (req, res) => {
    const accounts = store.list(req.botId).map(acc => ({
      ...acc,
      running: isRunning(req.botId, acc.id),
    }))
    res.json({ accounts })
  })

  app.post(`${base}/api/accounts`, json, requireBot, (req, res) => {
    try {
      const body = req.body || {}
      if (body.messageTemplate) normalizeTemplate(body.messageTemplate, "消息模板")
      const account = store.upsert(req.botId, body)
      audit.add("account.upsert", {
        botId: req.botId,
        userId: req.dySession.userId,
        accountId: account.id,
        account: account.name,
        cookieUpdated: Boolean(body.cookie),
      })
      res.json({ ok: true, account })
    } catch (error) {
      res.status(400).json({ error: toError(error).message })
    }
  })

  app.delete(`${base}/api/accounts/:id`, requireBot, async (req, res) => {
    // 先关聊天会话：账号删了它还挂着一个 Chromium 和一把账号锁，
    // 而锁的 key 是 botId:accountId，账号没了就再没人来 release 它
    await chat.closeSession(req.botId, req.params.id).catch(() => {})
    const ok = store.remove(req.botId, req.params.id)
    if (ok) audit.add("account.remove", { botId: req.botId, userId: req.dySession.userId, accountId: req.params.id })
    res.json({ ok })
  })

  app.post(`${base}/api/accounts/:id/check`, requireBot, async (req, res) => {
    try {
      const result = await checkAccount(req.botId, req.params.id)
      res.json(result)
    } catch (error) {
      res.status(500).json({ error: toError(error).message })
    }
  })

  /**
   * 会话列表。默认吃 store 里的缓存（`spark.friendsCacheTTL`），`?refresh=1` 才真开浏览器。
   * 回 `cached`/`at` 让前端能显示「这是 X 点拉的，点重新拉取更新」，
   * 否则用户看到旧名单会以为接口坏了。
   */
  app.get(`${base}/api/accounts/:id/friends`, requireBot, async (req, res) => {
    try {
      const refresh = req.query.refresh === "1" || req.query.refresh === "true"
      const result = await listFriends(req.botId, req.params.id, { refresh })
      res.json({ friends: result.names, cached: result.cached, at: result.at })
    } catch (error) {
      res.status(500).json({ error: toError(error).message })
    }
  })

  // ---------- 续火 / 发信 ----------
  app.post(`${base}/api/accounts/:id/spark`, requireBot, async (req, res) => {
    try {
      const result = await runAccount(req.botId, req.params.id)
      res.json(result)
    } catch (error) {
      res.status(400).json({ error: toError(error).message })
    }
  })

  app.post(`${base}/api/accounts/:id/send`, json, requireBot, async (req, res) => {
    try {
      const result = await sendCustom(req.botId, req.params.id, req.body?.friends, req.body?.text)
      audit.add("web.send", {
        botId: req.botId,
        userId: req.dySession.userId,
        accountId: req.params.id,
        friends: result.sent.map(s => s.friend),
        ok: result.ok,
      })
      res.json(result)
    } catch (error) {
      res.status(400).json({ error: toError(error).message })
    }
  })

  app.post(`${base}/api/spark/all`, requireBot, async (req, res) => {
    try {
      const summary = await scheduler.runAll(`面板(${req.dySession.userId})`)
      res.json(summary)
    } catch (error) {
      res.status(400).json({ error: toError(error).message })
    }
  })

  app.post(`${base}/api/push/test`, requireBot, async (req, res) => {
    try {
      const accounts = store.list(req.botId)
      const results = accounts
        .filter(a => a.lastRun)
        .map(a => ({ account: a.name, ...a.lastRun }))
      if (!results.length) return res.status(400).json({ error: "还没有任何续火记录可推送" })
      const result = await pushReport(req.botId, results, { force: true })
      res.json({ ok: true, ...result })
    } catch (error) {
      res.status(500).json({ error: toError(error).message })
    }
  })

  // ---------- 抖音登录 ----------
  app.post(`${base}/api/login/qrcode`, json, requireBot, async (req, res) => {
    try {
      // userId 要传：抖音弹验证时远程操作链接只私信发给发起人
      const sessionId = await startQrLogin(req.botId, {
        accountName: req.body?.name,
        userId: req.dySession.userId,
      })
      res.json({ ok: true, sessionId })
    } catch (error) {
      res.status(500).json({ error: toError(error).message })
    }
  })

  app.get(`${base}/api/login/qrcode/:sid`, requireBot, (req, res) => {
    const session = getQrSession(req.params.sid)
    if (!session) return res.status(404).json({ error: "登录会话不存在或已结束" })
    // 只能查自己机器人的登录会话
    if (session.botId !== req.botId) return res.status(403).json({ error: "无权访问该登录会话" })
    res.json(session)
  })

  app.delete(`${base}/api/login/qrcode/:sid`, requireBot, async (req, res) => {
    const session = getQrSession(req.params.sid)
    if (session && session.botId !== req.botId) return res.status(403).json({ error: "无权操作该登录会话" })
    res.json({ ok: await cancelSession(req.params.sid) })
  })

  app.post(`${base}/api/login/manual`, json, requireBot, (req, res) => {
    try {
      // 先解析一次，格式错误在写盘前就报出来
      parseCookieInput(req.body?.cookie)
      const account = manualLogin(req.botId, { name: req.body?.name, cookie: req.body?.cookie })
      res.json({ ok: true, account })
    } catch (error) {
      res.status(400).json({ error: toError(error).message })
    }
  })

  // ---------- 配置 ----------
  app.get(`${base}/api/config`, requireAuth, (req, res) => {
    res.json({ config: config.data, placeholders: PLACEHOLDERS })
  })

  app.post(`${base}/api/config`, json, requireAuth, (req, res) => {
    try {
      const patch = req.body?.patch
      if (!patch || typeof patch !== "object") throw new Error("参数不正确")
      if (patch["spark.messageTemplate"]) normalizeTemplate(patch["spark.messageTemplate"], "消息模板")
      config.setMany(patch)
      // cron 或开关可能变了，立刻换表
      scheduler.reschedule()
      audit.add("config.update", {
        userId: req.dySession.userId,
        botId: req.dySession.botId,
        keys: Object.keys(patch),
      })
      res.json({ ok: true, config: config.data })
    } catch (error) {
      res.status(400).json({ error: toError(error).message })
    }
  })

  // ---------- 状态 / 审计 ----------
  app.get(`${base}/api/status`, requireAuth, (req, res) => {
    const botId = req.dySession.botId
    res.json({
      scheduler: scheduler.status(),
      push: pushSummary(),
      auth: authStatus(),
      bots: listBots().filter(b => req.dySession.allowedBots.includes(b.uin)),
      spark: botId ? summarize(botId) : null,
      running: runningList(),
      // 聊天会话会挂着一个 Chromium，用户得能看到它开着、并且知道该去关
      chat: { sessions: chat.sessionList(), db: chatDbBrief() },
    })
  })

  app.get(`${base}/api/audit`, requireAuth, (req, res) => {
    const limit = Math.min(200, Math.max(1, Number(req.query.limit) || 50))
    res.json({ items: audit.list({ botId: req.dySession.botId, limit }) })
  })

  // ---------- 聊天 ----------
  registerChatRoutes(app, base, json, requireBot)

  // ---------- 远程验证（独立鉴权，与面板会话无关） ----------
  registerVerifyRoutes(app, base, json)

  // ---------- 页面 ----------
  app.use(
    base,
    express.static(webDir, {
      setHeaders(res) {
        res.set("Cache-Control", "no-store")
      },
    })
  )

  // SPA 兜底：非静态资源一律给 index.html，未登录时前端自己弹验证码框
  app.use(base, (req, res, next) => {
    if (req.path.startsWith("/api/")) return next()
    const ext = path.extname(req.path).toLowerCase()
    if (ext && ext !== ".html") return next()
    res.sendFile(path.join(webDir, "index.html"), err => {
      if (err) next()
    })
  })
}

/* ====================== 聊天 ======================
 *
 * 一组接口对应一个「常开的抖音聊天页」（见 lib/chat.js）。和面板其它接口最大的不同是
 * **它有状态**：`open` 之后服务端挂着一个 Chromium，`close` 或空闲超时才收掉。所以：
 *
 * - 除 `open` 之外的接口都不自动开会话。开一个要十几秒还要跟续火抢账号锁，那必须是
 *   用户点「进入聊天」时发生的事，不该由一次轮询触发（用户 F5 一下就会白开一个浏览器）。
 * - 错误码分两类：409 = 会话不在了（前端该退回账号列表并提示重连），400/500 = 这次操作
 *   本身失败（前端只提示，会话还在）。混在一起的话前端没法决定要不要重连。
 *
 * 全部走 requireAuth（`${base}/api` 那层中间件）+ requireBot，与账号管理同一套权限：
 * 能读账号 Cookie 的人本来就能用那个号发消息，聊天不引入新的权限面。
 */
function registerChatRoutes(app, base, json, requireBot) {
  /** 聊天总开关。关掉时连 open 都不给，前端据此隐藏入口 */
  const requireChat = (req, res, next) => {
    if (config.get("chat.enable", true) === false)
      return res.status(403).json({ error: "聊天功能未启用" })
    next()
  }

  /**
   * 把 lib/chat.js 抛的异常翻成 HTTP。
   *
   * 「会话未打开或已关闭」是唯一需要前端改变行为的错误（要重连），单独给 409。
   * 其余一律 400——包括抢不到账号锁（「该账号正在续火中」）：那是用户能自己解决的，
   * 不是服务端故障，回 500 会让人以为插件坏了。
   */
  const fail = (res, error) => {
    const message = toError(error).message
    const gone = /会话未打开|已关闭/.test(message)
    res.status(gone ? 409 : 400).json({ error: message })
  }

  /** 进入聊天：抢锁 + 开页面。前端点账号卡片上的「聊天」时调一次 */
  app.post(`${base}/api/chat/:id/open`, requireChat, requireBot, async (req, res) => {
    try {
      const session = await chat.openSession(req.botId, req.params.id)
      audit.add("chat.open", {
        botId: req.botId,
        userId: req.dySession.userId,
        accountId: req.params.id,
        account: session.name,
      })
      res.json({
        ok: true,
        session: session.info(),
        conversations: chat.chatdb.listConversations(req.botId, req.params.id),
        db: chat.chatdb.status().ok,
        pollMs: config.num("chat.pollMs", 3000, { min: 1000, max: 30000 }),
      })
    } catch (error) {
      fail(res, error)
    }
  })

  app.post(`${base}/api/chat/:id/close`, requireBot, async (req, res) => {
    res.json({ ok: await chat.closeSession(req.botId, req.params.id) })
  })

  /**
   * 会话列表。`?refresh=1` 才真去页面上读一遍，否则直接给库里的。
   *
   * 与 friends 接口同一个套路，但这里的默认值是反过来的：friends 缓存 4 小时是因为
   * 好友名单几天不变，而会话列表的排序和预览每来一条消息就变，所以前端在打开聊天时
   * 会带 refresh=1，之后只在用户下拉时再带。
   */
  app.get(`${base}/api/chat/:id/conversations`, requireBot, async (req, res) => {
    try {
      const refresh = req.query.refresh === "1" || req.query.refresh === "true"
      const list = refresh
        ? await chat.conversations(req.botId, req.params.id)
        : chat.chatdb.listConversations(req.botId, req.params.id)
      res.json({ conversations: list })
    } catch (error) {
      fail(res, error)
    }
  })

  /** 点进一个好友：切页面上的会话 + 回一屏历史 */
  app.post(`${base}/api/chat/:id/peer`, json, requireBot, async (req, res) => {
    try {
      const peer = String(req.body?.peer || "").trim()
      if (!peer) return res.status(400).json({ error: "请指定聊天对象" })
      res.json({ ok: true, ...(await chat.openPeer(req.botId, req.params.id, peer)) })
    } catch (error) {
      fail(res, error)
    }
  })

  /**
   * 轮询新消息。前端每 chat.pollMs 一次，带上已知的最大 id。
   *
   * 用 GET + sinceId 而不是长轮询/SSE：抖音那边没有事件可等，服务端自己也是靠
   * 读页面才知道有新消息，长轮询只是把「每 3 秒读一次页面」换个地方写，
   * 却要额外处理连接超时、代理缓冲、Yunzai 那个 express 的兜底重定向。
   */
  app.get(`${base}/api/chat/:id/poll`, requireBot, async (req, res) => {
    try {
      const result = await chat.poll(req.botId, req.params.id, String(req.query.peer || ""), req.query.since)
      res.json({ ok: true, ...result })
    } catch (error) {
      fail(res, error)
    }
  })

  app.post(`${base}/api/chat/:id/send`, json, requireBot, async (req, res) => {
    try {
      const text = String(req.body?.text ?? "")
      const max = config.num("chat.maxLength", 500, { min: 1, max: 5000 })
      if (text.length > max) return res.status(400).json({ error: `消息太长（上限 ${max} 字）` })
      const peer = String(req.body?.peer || "").trim()
      res.json(await chat.send(req.botId, req.params.id, peer, text))
    } catch (error) {
      fail(res, error)
    }
  })

  /** 往上翻历史。纯查库，会话没开也能翻——聊天记录是本地的，不需要抖音在线 */
  app.get(`${base}/api/chat/:id/earlier`, requireBot, (req, res) => {
    const peer = String(req.query.peer || "").trim()
    if (!peer) return res.status(400).json({ error: "请指定聊天对象" })
    res.json({ messages: chat.earlier(req.botId, req.params.id, peer, req.query.before) })
  })
}

/* ==================== 远程验证 ====================
 *
 * 抖音在扫码后弹身份验证时，插件把那个页面的交互通道转发给人：截图推给浏览器，
 * 点击/拖动/输入回传成 page.mouse / page.keyboard 调用。
 *
 * 这一套刻意不挂在 requireAuth 后面，也不共用 `${base}/api` 那个中间件：
 * 面板会话能选机器人、增删账号、改配置、看审计，而这里的票据只能对某一个正在
 * 登录的页面做「看一帧 / 点 / 拖 / 打字」。链接要落在公网可达的地址上，两者混用
 * 等于把管理面板的钥匙塞进一次性验证链接。所以路由前缀、鉴权、前端页面全部另开。
 */
function registerVerifyRoutes(app, base, json) {
  /**
   * 票据鉴权。token 只从请求头取，绝不从 query 取——query 会进 access log，
   * 而这一个字符串就是这条链接的全部权限。前端把它放在 X-Verify-Token 里。
   */
  const requireTicket = (req, res, next) => {
    const ip = clientIp(req)
    const token = String(req.headers["x-verify-token"] || "")
    const ticket = token ? getTicket(token, ip) : null
    if (!ticket) {
      // 公网上的链接，猜 token 与猜面板验证码同样该被计数拉黑
      countFailure(ip)
      debug("远程验证", `${req.method} ${req.path} 票据不通过（token ${token ? "有但无效" : "缺失"}），IP ${ip}`)
      return res.status(401).json({ error: "验证链接无效或已过期" })
    }
    req.dyTicket = ticket
    next()
  }

  /** 拿票据对应的活页面。会话已经结束时返回 null，由各接口按自己的语义处理 */
  const liveOf = ticket => {
    const session = getLiveSession(ticket.sessionId)
    return session?.page && !session.page.isClosed() ? session : null
  }

  /**
   * 拉一帧。前端每秒一次，也靠它读会话状态——成功/失败都在 status 里，
   * 页面不需要再问任何别的接口。
   */
  app.get(`${base}/api/verify/frame`, requireTicket, async (req, res) => {
    const session = getLiveSession(req.dyTicket.sessionId)
    const state = session
      ? { status: session.status, message: session.message, accountName: session.accountName }
      : { status: "closed", message: "登录会话已结束" }
    // 页面关了就只回状态：这一步不是错误，成功之后必然走到这里
    if (!session?.page || session.page.isClosed()) return res.json({ ok: true, ...state, image: "" })
    try {
      const frame = await snapshot(session.page)
      res.json({ ok: true, ...state, ...frame, expireAt: req.dyTicket.expireAt })
    } catch (error) {
      res.json({ ok: true, ...state, image: "", error: toError(error).message })
    }
  })

  /**
   * 重放一个操作。所有动作走同一条路由，类型在 body 里——五个动作各开一条路由
   * 只会让鉴权和错误处理抄五遍，而它们的差别全在 lib/remote.js 的 applyAct 里。
   */
  app.post(`${base}/api/verify/act`, json, requireTicket, async (req, res) => {
    const session = liveOf(req.dyTicket)
    if (!session) {
      debug("远程验证", `收到动作但会话已结束：${req.dyTicket.sessionId}，回 409`)
      return res.status(409).json({ error: "登录会话已结束，无需再操作" })
    }
    try {
      const result = await applyAct(session.page, req.body)
      // 只记次数，不记内容——用户输进去的可能是短信验证码
      countAct(req.dyTicket)
      res.json(result)
    } catch (error) {
      // 400 的原因值得单独记一行：「不支持的操作」意味着前端发了别的东西，
      // 「页面已关闭」意味着 liveOf 通过之后页面才关，两者的下一步完全不同
      debug("远程验证", `动作失败：${toError(error).message}`)
      res.status(400).json({ error: toError(error).message })
    }
  })

  /**
   * 验证页面。必须挂在 express.static 与 SPA 兜底之前：兜底会把 /verify
   * 这个没有扩展名的路径当成前端路由，回主面板的 index.html。
   *
   * 这里不校验 token：token 在 URL 的 hash 里，压根不会发到服务端（这正是用 hash
   * 而不是 query 的原因——不进 access log、不随 Referer 外泄）。页面本身只是一个
   * 空壳，拿不到有效票据的话第一次拉帧就 401，什么也显示不出来。
   *
   * 带尾斜杠的 `/verify/` 先重定向掉。verify.html 里 `<link href="style.css">` 是相对
   * 路径，在 `/verify/` 下会解析成 `/verify/style.css` —— 页面出得来、样式全丢。判据
   * 写在处理函数里而不是另注册一条 `/verify/` 路由：非严格路由下那条同样会匹配
   * `/verify`，两条互相重定向就是死循环。hash 不参与重定向也不会丢，它压根没发给
   * 服务端，浏览器自己会带到新地址上。
   */
  app.get(`${base}/verify`, (req, res, next) => {
    if (req.path.endsWith("/")) return res.redirect(301, `${base}/verify`)
    res.sendFile(path.join(webDir, "verify.html"), err => {
      if (err) next()
    })
  })
}

/**
 * 聊天库的状态，去掉磁盘路径。
 *
 * `chatdb.status()` 带着 `data/chat.db` 的绝对路径，那是给日志和锅巴看的；面板是
 * 网页，路径进了前端就等于把服务器的目录结构写在 HTML 里。前端只需要知道
 * 「历史能不能存」和「坏了的原因」。
 */
function chatDbBrief() {
  const { ok, reason, messages, conversations } = chat.chatdb.status()
  return { ok, reason, messages, conversations }
}

/** 从 Cookie 或 Authorization 头取会话 token */
function readToken(req, base) {
  const raw = String(req.headers.cookie || "")
  for (const part of raw.split(";")) {
    const idx = part.indexOf("=")
    if (idx <= 0) continue
    if (part.slice(0, idx).trim() === COOKIE_NAME) return part.slice(idx + 1).trim()
  }
  const auth = String(req.headers.authorization || "")
  if (auth.startsWith("Bearer ")) return auth.slice(7).trim()
  return ""
}

/** 可选的独立端口，端口被占用只警告不影响插件加载 */
async function maybeStandalone(app, base) {
  const port = Number(config.get("web.port", 0))
  if (!port) return
  try {
    const http = await import("node:http")
    const server = http.createServer(app)
    server.listen(port, () => log("info", `独立服务器已启动 → http://localhost:${port}${base}/`))
    server.on("error", error => {
      if (error.code === "EADDRINUSE") log("warn", `端口 ${port} 被占用，跳过独立服务器`)
      else log("error", "独立服务器错误：", error.message)
    })
  } catch (error) {
    log("error", "启动独立服务器失败：", toError(error).message)
  }
}
