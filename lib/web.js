import path from "node:path"
import express from "express"
import { pluginRoot, log, toError, maskSecret } from "./util.js"
import { config } from "./config.js"
import { store, parseCookieInput } from "./store.js"
import { audit } from "./audit.js"
import { scheduler } from "./scheduler.js"
import { runAccount, sendCustom, listFriends, summarize, isRunning, runningList } from "./spark.js"
import { startQrLogin, getSession as getQrSession, cancelSession, manualLogin, checkAccount } from "./login.js"
import { pushReport, pushSummary } from "./push.js"
import { listBots } from "./bot.js"
import { normalizeTemplate, PLACEHOLDERS } from "./template.js"
import {
  verifyCode,
  getSession,
  touchSession,
  selectBot,
  destroySession,
  clientIp,
  isBanned,
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
    if (req.path.startsWith("/auth/")) return next()
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

  app.delete(`${base}/api/accounts/:id`, requireBot, (req, res) => {
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

  app.get(`${base}/api/accounts/:id/friends`, requireBot, async (req, res) => {
    try {
      const friends = await listFriends(req.botId, req.params.id)
      res.json({ friends })
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
      const sessionId = await startQrLogin(req.botId, { accountName: req.body?.name })
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
    })
  })

  app.get(`${base}/api/audit`, requireAuth, (req, res) => {
    const limit = Math.min(200, Math.max(1, Number(req.query.limit) || 50))
    res.json({ items: audit.list({ botId: req.dySession.botId, limit }) })
  })

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
