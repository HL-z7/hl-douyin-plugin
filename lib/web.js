/**
 * Web 面板服务端：把插件能力暴露成 HTTP 接口，并托管 web/ 下的前端页面。
 *
 * 路由全部挂在 `config.webBase()`（默认 `/douyin`）之下，按注册顺序分五段：
 * 1. 全局闸门 `app.use(base, ...)` —— IP 黑名单、双桶限流、四个安全响应头
 * 2. 免登录鉴权接口 —— `POST /api/auth/verify`、`POST /api/auth/logout`、
 *    `GET /api/auth/state`
 * 3. `app.use(`${base}/api`, ...)` —— 除 `/auth/` 与 `/verify/` 之外一律 requireAuth；
 *    需要已选机器人的接口再叠一层 requireBot（把 botId 交给 handler）
 * 4. 业务接口 —— 账号 CRUD 与 `:id/{check,friends,spark,send}`、`/api/spark/all`、
 *    `/api/push/test`、`/api/login/{qrcode,qrcode/:sid,manual}`、`/api/config`、
 *    `/api/status`、`/api/audit`，以及 registerChatRoutes 的 `/api/chat/:id/*`
 *    与 registerVerifyRoutes 的 `/api/verify/*` + `${base}/verify` 页面
 * 5. 页面 —— express.static(web/) 与 SPA 兜底（非 /api/ 且无扩展名时回 index.html）
 *
 * 三套彼此独立的鉴权：面板会话（lib/auth.js 的 Cookie/Bearer token，见 readToken）、
 * 远程验证票据（lib/remote.js，只从 `X-Verify-Token` 请求头取）、以及聊天开关
 * requireChat。票据与面板会话不互通，故 `/api/verify/*` 从第 3 段中豁免。
 *
 * 错误码约定：401 未登录 / 票据无效，403 已封禁或越权访问他人机器人的会话，
 * 404 会话不存在，409 会话已不在（前端应重连），429 触发限流，400 本次操作失败
 * （参数或用户可自行处理的冲突），500 服务端故障。
 *
 * 对外不吐磁盘路径：`/api/status` 里聊天库状态走 chatDbBrief() 过滤，日志与接口中的
 * Cookie 一律 maskSecret 打码。
 *
 * 对外导出：`setupWeb()`。依赖 express 与 lib/ 下的 config、store、auth、audit、
 * scheduler、spark、login、push、bot、template、remote、debug、chat、util。
 *
 * 调用前提：必须在模块导入期调用 setupWeb()（见其说明），且 `global.Bot.express` 已就绪。
 */
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

/** 前端静态资源目录，index.html 与 verify.html 都在这里 */
const webDir = path.join(pluginRoot, "web")
/** 会话 token 的 Cookie 名，Path 限定在 base 下，HttpOnly + SameSite=Strict */
const COOKIE_NAME = "hl_douyin_session"

/**
 * 挂载 Web 面板。
 *
 * 必须在模块导入期调用：Yunzai 的 lib/bot.js 在 PluginsLoader.load() 之后给
 * Bot.express 追加了兜底重定向（`this.express.use(req => req.res.redirect(...))`），
 * 晚于那一刻注册的路由会被它拦截，表现为面板地址跳回 Yunzai 首页。
 *
 * @returns {{enabled: boolean, base?: string}} web.enable 关闭或 Bot.express 不可用时
 *   返回 `{ enabled: false }`，不注册任何路由
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

  // 面板存在二维码与状态轮询，请求量远高于普通接口；把 base 推进 app.quiet 后，
  // Yunzai 的 serverHandle 会把这些请求的 HTTP 日志从 mark 降为 debug
  if (Array.isArray(app.quiet) && !app.quiet.includes(base)) app.quiet.push(base)

  registerRoutes(app, base)
  maybeStandalone(app, base)

  log("info", `Web 面板地址：${config.webOrigin()}${base}/`)
  return { enabled: true, base }
}

/**
 * 注册全部路由，顺序即优先级（见文件头的五段划分）。
 * @param {object} app Bot.express 实例
 * @param {string} base 挂载前缀，已由 config.webBase() 归一化为 `/xxx`
 */
function registerRoutes(app, base) {
  const json = express.json({ limit: "2mb" })

  /*
   * 全局闸门：所有 base 下的请求都先过这里。
   *
   * 限流分两个桶：路径以 /api/auth 开头的走 auth 桶（配额 web.rateAuth，默认 8），
   * 其余走 general 桶（web.rateGeneral，默认 300），窗口均为 web.rateWindow 秒。
   * 单独给验证码提交一个小桶是为了在不影响正常轮询的前提下阻止爆破。
   * 鉴权失败累计到 web.banAfter 次后由 lib/auth.js 拉黑该 IP，此处只做 403 拦截。
   *
   * 四个响应头：no-store 避免代理缓存住带账号数据的响应；DENY 禁止被嵌套进 iframe；
   * nosniff 阻止 MIME 猜测；no-referrer 避免面板地址（含 base）随跳转外泄。
   */
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

  // ---------- 鉴权接口（免登录，走 auth 限流桶） ----------

  /** 提交 #抖音web 私信给出的验证码换会话 token；失败沿用 verifyCode 给的 status（默认 401） */
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

  /** 主动登出：销毁服务端会话并清空 Cookie。token 不存在时同样回 ok */
  app.post(`${base}/api/auth/logout`, (req, res) => {
    destroySession(readToken(req, base))
    res.setHeader("Set-Cookie", `${COOKIE_NAME}=; Path=${base}; HttpOnly; SameSite=Strict; Max-Age=0`)
    res.json({ ok: true })
  })

  /**
   * 当前登录态。前端启动时调它决定显示面板还是验证码框。
   * userId 经 maskSecret(3, 2) 打码后再下发：页面只需要确认「登录的是谁」。
   */
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

  // ---------- 登录闸门 ----------

  /** 会话校验层：命中即 touchSession 续期，并把会话挂到 req.dySession。失败回 401 */
  const requireAuth = (req, res, next) => {
    const session = getSession(readToken(req, base))
    if (!session) return res.status(401).json({ error: "未登录或会话已过期" })
    touchSession(session)
    req.dySession = session
    next()
  }

  /**
   * 机器人选定层：叠在 requireAuth 之后，把 req.dySession.botId 提到 req.botId，
   * 使 handler 不必各自判空。未选机器人时回 400 而非 401——已登录，只是缺前置操作。
   */
  const requireBot = (req, res, next) => {
    if (!req.dySession?.botId) return res.status(400).json({ error: "请先选择机器人" })
    req.botId = req.dySession.botId
    next()
  }

  app.use(`${base}/api`, (req, res, next) => {
    // /auth/ 自身不能要求已登录；/verify/ 走远程验证票据（registerVerifyRoutes 的
    // requireTicket），与面板会话是两套独立权限，不能被这层拦下
    if (req.path.startsWith("/auth/") || req.path.startsWith("/verify/")) return next()
    requireAuth(req, res, next)
  })

  /** 切换当前操作的机器人，只允许选 session.allowedBots 内的（校验在 auth.selectBot） */
  app.post(`${base}/api/bot/select`, json, (req, res) => {
    try {
      const botId = selectBot(req.dySession, req.body?.botId)
      res.json({ ok: true, botId })
    } catch (error) {
      res.status(error.status || 400).json({ error: error.message })
    }
  })

  // ---------- 账号管理 ----------

  /** 当前机器人下的账号列表（已由 store.#present 剥掉 Cookie 密文），附带 running 标记 */
  app.get(`${base}/api/accounts`, requireBot, (req, res) => {
    const accounts = store.list(req.botId).map(acc => ({
      ...acc,
      running: isRunning(req.botId, acc.id),
    }))
    res.json({ accounts })
  })

  /** 新增或更新账号。模板占位符先校验，非法输入统一回 400（不是服务端故障） */
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

  /**
   * 删除账号。聊天记录由 store.remove 连带清掉（chatdb.dropAccount）。
   *
   * 关会话必须在这里显式做：store.js 不能 import lib/chat.js（chat.js 已 import
   * store.js，会形成循环依赖）。若不先关，账号删除后仍挂着一个 Chromium 页面和一把
   * 账号锁，而锁的 key 是 `botId:accountId`，账号已不存在便再无人 release。
   * 关闭失败被吞掉：会话本就可能已过期关闭，不应阻塞删除。
   */
  app.delete(`${base}/api/accounts/:id`, requireBot, async (req, res) => {
    await chat.closeSession(req.botId, req.params.id).catch(() => {})
    const ok = store.remove(req.botId, req.params.id)
    if (ok) audit.add("account.remove", { botId: req.botId, userId: req.dySession.userId, accountId: req.params.id })
    res.json({ ok })
  })

  /** 检查 Cookie 是否仍然有效。真开浏览器访问抖音，结论按 spark.cookieCheckTTL 缓存 */
  app.post(`${base}/api/accounts/:id/check`, requireBot, async (req, res) => {
    try {
      const result = await checkAccount(req.botId, req.params.id)
      res.json(result)
    } catch (error) {
      res.status(500).json({ error: toError(error).message })
    }
  })

  /**
   * 会话（好友）列表。默认读 store 缓存（`spark.friendsCacheTTL`，默认 240 分钟），
   * `?refresh=1` 或 `?refresh=true` 才真开浏览器拉取。
   *
   * 响应带 `cached` 与 `at`，使前端能标注「此名单拉取于 X 时，可点重新拉取更新」；
   * 缺少该信息时用户看到过时名单会误判为接口异常。
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

  /** 立即对单个账号续火。失败回 400：多为账号锁冲突或凭证失效，用户可自行处理 */
  app.post(`${base}/api/accounts/:id/spark`, requireBot, async (req, res) => {
    try {
      const result = await runAccount(req.botId, req.params.id)
      res.json(result)
    } catch (error) {
      res.status(400).json({ error: toError(error).message })
    }
  })

  /** 自定义发信：给指定好友发一段自己写的内容。审计只记收件人与结果，不记正文 */
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

  /** 对全部启用账号跑一遍续火（串行，由 scheduler 排队）。触发来源记为 `面板(userId)` */
  app.post(`${base}/api/spark/all`, requireBot, async (req, res) => {
    try {
      const summary = await scheduler.runAll(`面板(${req.dySession.userId})`)
      res.json(summary)
    } catch (error) {
      res.status(400).json({ error: toError(error).message })
    }
  })

  /**
   * 推送连通性测试：拿已有的 lastRun 记录重发一遍。
   * force=true 绕过 push.enable 与 push.onlyOnFail，否则测试可能什么都不发出而无法判断配置。
   * 没有任何续火记录时回 400（无可推送内容，不是故障）。
   */
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

  /** 发起扫码登录，返回 sessionId 供前端轮询取二维码与状态 */
  app.post(`${base}/api/login/qrcode`, json, requireBot, async (req, res) => {
    try {
      // userId 必须传入：抖音追加人工验证时，远程操作链接只私信发给发起人
      const sessionId = await startQrLogin(req.botId, {
        accountName: req.body?.name,
        userId: req.dySession.userId,
      })
      res.json({ ok: true, sessionId })
    } catch (error) {
      res.status(500).json({ error: toError(error).message })
    }
  })

  /** 轮询扫码会话状态（二维码图、扫码进度、成败）。404 = 会话不存在或已结束 */
  app.get(`${base}/api/login/qrcode/:sid`, requireBot, (req, res) => {
    const session = getQrSession(req.params.sid)
    if (!session) return res.status(404).json({ error: "登录会话不存在或已结束" })
    // 跨机器人访问一律 403：sessionId 是全局的，不校验会让 A 的面板看到 B 的登录会话
    if (session.botId !== req.botId) return res.status(403).json({ error: "无权访问该登录会话" })
    res.json(session)
  })

  /** 取消扫码会话。会话已不存在时按成功处理（幂等），跨机器人操作回 403 */
  app.delete(`${base}/api/login/qrcode/:sid`, requireBot, async (req, res) => {
    const session = getQrSession(req.params.sid)
    if (session && session.botId !== req.botId) return res.status(403).json({ error: "无权操作该登录会话" })
    res.json({ ok: await cancelSession(req.params.sid) })
  })

  /** 手动粘贴 Cookie 登录。security.allowManualCookie 的开关判定在 manualLogin 内部 */
  app.post(`${base}/api/login/manual`, json, requireBot, (req, res) => {
    try {
      // 先解析一次，把格式错误暴露在写盘之前
      parseCookieInput(req.body?.cookie)
      const account = manualLogin(req.botId, { name: req.body?.name, cookie: req.body?.cookie })
      res.json({ ok: true, account })
    } catch (error) {
      res.status(400).json({ error: toError(error).message })
    }
  })

  // ---------- 配置 ----------

  /**
   * 读取当前配置树与可用占位符。只要 requireAuth，不要求已选机器人。
   * config.data 里不含账号与 Cookie（那些在 data/accounts/<botId>.json）。
   */
  app.get(`${base}/api/config`, requireAuth, (req, res) => {
    res.json({ config: config.data, placeholders: PLACEHOLDERS })
  })

  /** 按点路径批量改配置（body.patch）。校验模板占位符后落盘，并立即重排定时任务 */
  app.post(`${base}/api/config`, json, requireAuth, (req, res) => {
    try {
      const patch = req.body?.patch
      if (!patch || typeof patch !== "object") throw new Error("参数不正确")
      if (patch["spark.messageTemplate"]) normalizeTemplate(patch["spark.messageTemplate"], "消息模板")
      config.setMany(patch)
      // cron 或 spark.enable 可能已变，立刻换表，避免与配置不一致
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

  /**
   * 面板首页的聚合状态：定时任务、推送配置摘要、鉴权统计、可选机器人、续火概览、
   * 正在运行的账号，以及聊天会话与聊天库状态。
   *
   * 聊天部分外发是必要的：一个聊天会话对应一个常驻 Chromium 页面，用户需要看到它开着
   * 并能主动关闭。聊天库状态经 chatDbBrief() 过滤掉磁盘路径后才下发。
   */
  app.get(`${base}/api/status`, requireAuth, (req, res) => {
    const botId = req.dySession.botId
    res.json({
      scheduler: scheduler.status(),
      push: pushSummary(),
      auth: authStatus(),
      bots: listBots().filter(b => req.dySession.allowedBots.includes(b.uin)),
      spark: botId ? summarize(botId) : null,
      running: runningList(),
      chat: { sessions: chat.sessionList(), db: chatDbBrief() },
    })
  })

  /** 审计日志，只给当前机器人的。limit 夹取到 1~200，防止一次拉走全部记录 */
  app.get(`${base}/api/audit`, requireAuth, (req, res) => {
    const limit = Math.min(200, Math.max(1, Number(req.query.limit) || 50))
    res.json({ items: audit.list({ botId: req.dySession.botId, limit }) })
  })

  // ---------- 聊天 ----------
  registerChatRoutes(app, base, json, requireBot)

  // ---------- 远程验证（独立票据鉴权，与面板会话无关） ----------
  registerVerifyRoutes(app, base, json)

  // ---------- 页面 ----------

  // 静态资源同样 no-store：index.html 与 app.js 更新后不应被浏览器缓存住旧版本
  app.use(
    base,
    express.static(webDir, {
      setHeaders(res) {
        res.set("Cache-Control", "no-store")
      },
    })
  )

  /*
   * SPA 兜底：非 /api/ 且无扩展名（或 .html）的路径一律回 index.html，交给前端路由。
   * 未登录时前端自行弹验证码框，因此这里不做鉴权。
   * 有扩展名的请求交给 next()，让 404 保持为 404，不至于把缺失的 js/css 回成 HTML。
   */
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
 * 一组接口对应一个常开的抖音聊天页（见 lib/chat.js）。与面板其余接口的根本差别是
 * 它有状态：`open` 之后服务端挂着一个 Chromium，直到 `close` 或空闲超时
 * （chat.idleCloseSec，默认 180 秒）才收掉。由此有两条约定：
 *
 * - 除 `open` 之外的接口都不自动开会话。开一次要十几秒且需与续火争抢账号锁，只能由
 *   用户点「进入聊天」触发；若由轮询触发，用户刷新一次页面就会额外开出一个浏览器。
 * - 错误码分两类：409 = 会话已不在（前端应退回账号列表并提示重连），400/500 = 本次操作
 *   失败而会话仍在（前端只提示）。两者合并会使前端无法判断是否需要重连。
 *
 * 权限与账号管理一致：requireAuth（`${base}/api` 中间件）+ requireBot。能读账号 Cookie
 * 的人本就能用该号发消息，聊天不引入新的权限面。
 *
 * @param {object} app Bot.express 实例
 * @param {string} base 挂载前缀
 * @param {Function} json express.json 中间件
 * @param {Function} requireBot 机器人选定中间件
 */
function registerChatRoutes(app, base, json, requireBot) {
  /** 聊天总开关（chat.enable）。关闭时连 open 都拒绝，前端据 403 隐藏入口 */
  const requireChat = (req, res, next) => {
    if (config.get("chat.enable", true) === false)
      return res.status(403).json({ error: "聊天功能未启用" })
    next()
  }

  /**
   * 把 lib/chat.js 抛出的异常翻成 HTTP 状态码。
   *
   * 「会话未打开或已关闭」是唯一需要前端改变行为（重连）的错误，单独给 409。其余一律
   * 400，包括抢不到账号锁（「该账号正在续火中」）——那是用户可自行解决的冲突，回 500
   * 会被理解为插件故障。
   *
   * @param {object} res
   * @param {Error|string} error
   */
  const fail = (res, error) => {
    const message = toError(error).message
    const gone = /会话未打开|已关闭/.test(message)
    res.status(gone ? 409 : 400).json({ error: message })
  }

  /** 进入聊天：抢账号锁 + 开页面，并回一份会话列表与轮询间隔。前端点「聊天」时调一次 */
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

  /** 关闭聊天：收页面 + 释放账号锁。会话本就不存在时回 ok:false（幂等，不报错） */
  app.post(`${base}/api/chat/:id/close`, requireBot, async (req, res) => {
    res.json({ ok: await chat.closeSession(req.botId, req.params.id) })
  })

  /**
   * 会话列表。`?refresh=1` 才真去页面上读一遍，否则直接给 chat.db 里的。
   *
   * 与 `/api/accounts/:id/friends` 同一套缓存思路，但默认值相反：好友名单几天不变故默认
   * 读缓存；会话列表的排序与预览每来一条消息就变，因此前端在打开聊天时带 refresh=1，
   * 之后仅在用户下拉时再带。
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

  /** 切换聊天对象：在页面上点开该会话，并回一屏历史。peer 为空回 400 */
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
   * 轮询新消息。前端每 chat.pollMs（默认 3000 毫秒）一次，带上已知的最大消息 id。
   *
   * 采用 GET + sinceId 而非长轮询或 SSE：抖音侧没有可等待的事件，服务端本身也是靠读页面
   * 才知道有新消息，长轮询只是把「每 3 秒读一次页面」挪到另一处，却额外引入连接超时、
   * 反向代理缓冲，以及 Yunzai 那个 express 兜底重定向的处理。
   */
  app.get(`${base}/api/chat/:id/poll`, requireBot, async (req, res) => {
    try {
      const result = await chat.poll(req.botId, req.params.id, String(req.query.peer || ""), req.query.since)
      res.json({ ok: true, ...result })
    } catch (error) {
      fail(res, error)
    }
  })

  /** 发送消息。字数上限取 chat.maxLength（默认 500，夹取 1~5000），超限回 400 */
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

  /**
   * 向上翻历史（`?before=` 之前的消息）。纯查 chat.db，会话未打开也可用——
   * 聊天记录存在本地，不依赖抖音在线，因此这条路由不挂 requireChat、也不经过 fail()。
   */
  app.get(`${base}/api/chat/:id/earlier`, requireBot, (req, res) => {
    const peer = String(req.query.peer || "").trim()
    if (!peer) return res.status(400).json({ error: "请指定聊天对象" })
    res.json({ messages: chat.earlier(req.botId, req.params.id, peer, req.query.before) })
  })
}

/* ==================== 远程验证 ====================
 *
 * 抖音在扫码后追加身份验证时，插件把那个页面的交互通道转发给人：截图推送到浏览器，
 * 点击 / 拖动 / 输入回传后重放为 page.mouse / page.keyboard 调用（见 lib/remote.js）。
 *
 * 这组路由不挂在 requireAuth 之后，也不共用 `${base}/api` 那层中间件（该中间件显式豁免
 * `/verify/`）。面板会话可以选机器人、增删账号、改配置、看审计，而票据只能对某一个正在
 * 登录的页面做「看一帧 / 点 / 拖 / 打字」。链接需落在公网可达地址上，两者混用等于把管理
 * 面板的权限装进一次性验证链接，因此路由前缀、鉴权与前端页面全部独立。
 *
 * @param {object} app Bot.express 实例
 * @param {string} base 挂载前缀
 * @param {Function} json express.json 中间件
 */
function registerVerifyRoutes(app, base, json) {
  /**
   * 票据鉴权。token 只从 `X-Verify-Token` 请求头取，绝不从 query 取——query 会进
   * access log，而这个字符串即该链接的全部权限。
   * 校验不通过时计入 countFailure：公网上的链接，猜 token 与猜面板验证码同样应被拉黑。
   */
  const requireTicket = (req, res, next) => {
    const ip = clientIp(req)
    const token = String(req.headers["x-verify-token"] || "")
    const ticket = token ? getTicket(token, ip) : null
    if (!ticket) {
      countFailure(ip)
      debug("远程验证", `${req.method} ${req.path} 票据不通过（token ${token ? "有但无效" : "缺失"}），IP ${ip}`)
      return res.status(401).json({ error: "验证链接无效或已过期" })
    }
    req.dyTicket = ticket
    next()
  }

  /**
   * 取票据对应的活页面。
   * @returns {object|null} 会话已结束或页面已关闭时返回 null，由各接口按自身语义处理
   */
  const liveOf = ticket => {
    const session = getLiveSession(ticket.sessionId)
    return session?.page && !session.page.isClosed() ? session : null
  }

  /**
   * 拉一帧截图。前端每秒一次，同时用它读会话状态——成功与失败都体现在 status 字段里，
   * 页面无需再请求其它接口。
   *
   * 一律回 200：页面已关闭不是错误（登录成功之后必然走到这里），此时只回状态与空 image；
   * 截图本身失败时也回 200 并附 error 字段，避免前端把偶发截图失败当成链接失效。
   */
  app.get(`${base}/api/verify/frame`, requireTicket, async (req, res) => {
    const session = getLiveSession(req.dyTicket.sessionId)
    const state = session
      ? { status: session.status, message: session.message, accountName: session.accountName }
      : { status: "closed", message: "登录会话已结束" }
    if (!session?.page || session.page.isClosed()) return res.json({ ok: true, ...state, image: "" })
    try {
      const frame = await snapshot(session.page)
      res.json({ ok: true, ...state, ...frame, expireAt: req.dyTicket.expireAt })
    } catch (error) {
      res.json({ ok: true, ...state, image: "", error: toError(error).message })
    }
  })

  /**
   * 重放一个操作。所有动作共用这一条路由，类型放在 body 里：五个动作各开一条路由会把
   * 鉴权与错误处理重复五遍，而它们的差异全部集中在 lib/remote.js 的 applyAct 中。
   *
   * 409 = 会话已结束（无需再操作），400 = 本次动作失败（会话仍在）。
   */
  app.post(`${base}/api/verify/act`, json, requireTicket, async (req, res) => {
    const session = liveOf(req.dyTicket)
    if (!session) {
      debug("远程验证", `收到动作但会话已结束：${req.dyTicket.sessionId}，回 409`)
      return res.status(409).json({ error: "登录会话已结束，无需再操作" })
    }
    try {
      const result = await applyAct(session.page, req.body)
      // 只累计次数，不记录内容：用户输入的可能是短信验证码
      countAct(req.dyTicket)
      res.json(result)
    } catch (error) {
      // 400 的原因需单独记录：「不支持的操作」说明前端发来了别的类型，
      // 「页面已关闭」说明页面在 liveOf 通过之后才关闭，两者的后续处理完全不同
      debug("远程验证", `动作失败：${toError(error).message}`)
      res.status(400).json({ error: toError(error).message })
    }
  })

  /**
   * 验证页面本体。必须注册在 express.static 与 SPA 兜底之前，否则兜底会把 /verify
   * 这个无扩展名路径当作前端路由，回主面板的 index.html。
   *
   * 此处不校验 token：token 位于 URL 的 hash 中，浏览器不会把它发到服务端（这正是用
   * hash 而非 query 的原因——不进 access log、不随 Referer 外泄）。页面本身只是空壳，
   * 没有有效票据时第一次拉帧即 401，不会显示任何内容。
   *
   * 带尾斜杠的 `/verify/` 以 301 重定向到无尾斜杠形式：verify.html 里
   * `<link href="style.css">` 是相对路径，在 `/verify/` 下会解析成 `/verify/style.css`，
   * 结果是页面能出但样式全丢。判据写在处理函数内而非另注册一条 `/verify/` 路由，是因为
   * 非严格路由（Express 默认 strict routing 关闭）下那条路由同样会匹配 `/verify`，
   * 两条互相重定向即构成死循环。hash 不参与重定向也不会丢失——它从未发给服务端，
   * 由浏览器自行带到新地址上。
   */
  app.get(`${base}/verify`, (req, res, next) => {
    if (req.path.endsWith("/")) return res.redirect(301, `${base}/verify`)
    res.sendFile(path.join(webDir, "verify.html"), err => {
      if (err) next()
    })
  })
}

/**
 * 聊天库状态，去掉磁盘路径后再下发。
 *
 * `chat.chatdb.status()` 返回值含 `path`（`data/chat.db` 的绝对路径），那是给日志与锅巴
 * 用的；面板是网页，路径进了前端等同于把服务器目录结构写进 HTML。前端只需要知道
 * 「历史能否落库」与失败原因。
 *
 * @returns {{ok: boolean, reason: string, messages: number, conversations: number}}
 */
function chatDbBrief() {
  const { ok, reason, messages, conversations } = chat.chatdb.status()
  return { ok, reason, messages, conversations }
}

/**
 * 取会话 token：优先 Cookie（COOKIE_NAME，Path 限定在 base 下），其次 `Authorization:
 * Bearer <token>`。手动解析 Cookie 头是为了不引入 cookie-parser 依赖。
 *
 * @param {object} req
 * @param {string} base 仅用于说明 Cookie 的作用域，解析本身不使用
 * @returns {string} 两处都没有时返回空串
 */
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

/**
 * 可选的独立端口（web.port）：用同一个 express 实例再起一个 http 服务。
 * 端口被占用（EADDRINUSE）只记 warn，不抛出——面板是附加能力，不应阻断插件加载。
 *
 * @param {object} app Bot.express 实例
 * @param {string} base 挂载前缀，仅用于日志中打印完整地址
 * @returns {Promise<void>} web.port 为 0 时直接返回，不做任何事
 */
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
