/**
 * 抖音登录：扫码（抓 Cookie）与手动导入 Cookie。
 *
 * 为什么不引入用户列的那几个第三方项目：
 * 它们要么自带一整套浏览器栈（flyerhzm/douyin-mcp 用 Playwright，本仓库没装），
 * 要么是 Rust/Java 的独立进程，要么走逆向签名接口（cv-cat/DouYin_Spider）。
 * 而抖音扫码本身就是两个公开接口：get_qrcode 出图、check_qrconnect 出状态，
 * 在我们自己的 puppeteer 会话里拦这两个响应就能拿到二维码和登录结果，
 * Cookie 直接落在同一个 browserContext 里，不需要再引第二套浏览器或新依赖。
 */
import { log, toError, randInt, formatDuration } from "./util.js"
import { config } from "./config.js"
import { store } from "./store.js"
import { audit } from "./audit.js"
import browserManager, { closeQuietly } from "./browser.js"
import { randomToken } from "./crypto.js"

const LOGIN_URL = "https://www.douyin.com/"
const QRCODE_API = "login.douyin.com/passport/web/get_qrcode"
const CHECK_API = "login.douyin.com/passport/web/check_qrconnect"

/** 进行中的扫码会话：sessionId -> state */
const sessions = new Map()

/** 状态机：pending(出码中) -> waiting(等扫) -> scanned(已扫待确认) -> success / expired / failed / canceled */
export function getSession(sessionId) {
  const s = sessions.get(sessionId)
  if (!s) return null
  return {
    id: s.id,
    botId: s.botId,
    status: s.status,
    message: s.message,
    qrcode: s.qrcode,
    accountName: s.accountName,
    accountId: s.accountId || "",
    createdAt: s.createdAt,
    expireAt: s.expireAt,
  }
}

export function listSessions(botId = "") {
  return [...sessions.values()]
    .filter(s => !botId || s.botId === String(botId))
    .map(s => getSession(s.id))
}

export async function cancelSession(sessionId) {
  const s = sessions.get(sessionId)
  if (!s) return false
  s.status = "canceled"
  s.message = "已取消"
  await cleanup(s)
  return true
}

async function cleanup(s) {
  clearTimeout(s.timer)
  await closeQuietly(s.page)
  await closeQuietly(s.context)
  s.page = null
  s.context = null
  // 结果多留一会儿给前端/指令轮询取，之后再从表里删
  setTimeout(() => sessions.delete(s.id), 120000)
}

/**
 * 启动一次扫码登录。立即返回 { sessionId }，二维码通过 onQrcode 回调或轮询 getSession 取。
 * @param {string} botId 机器人 QQ，登录出的账号归它所有
 * @param {object} opts { accountName, onQrcode, onStatus }
 */
export async function startQrLogin(botId, { accountName = "", onQrcode, onStatus } = {}) {
  const timeoutSec = config.num("security.qrLoginTimeout", 180, { min: 60, max: 900 })
  const s = {
    id: randomToken(8),
    botId: String(botId),
    accountName: String(accountName || "").trim(),
    status: "pending",
    message: "正在获取二维码",
    qrcode: "",
    accountId: "",
    createdAt: Date.now(),
    expireAt: Date.now() + timeoutSec * 1000,
    context: null,
    page: null,
    timer: null,
    onStatus,
  }
  sessions.set(s.id, s)

  const setStatus = (status, message) => {
    s.status = status
    s.message = message
    log("info", `扫码登录 ${s.id}：${status} ${message}`)
    try {
      onStatus?.(status, message)
    } catch {}
  }

  s.timer = setTimeout(async () => {
    if (["success", "failed", "canceled"].includes(s.status)) return
    setStatus("expired", "二维码超时未扫描")
    await cleanup(s)
  }, timeoutSec * 1000)

  // 后台跑，不阻塞指令回复
  runQrLogin(s, setStatus, onQrcode).catch(async error => {
    const err = toError(error)
    if (!["success", "canceled", "expired"].includes(s.status)) setStatus("failed", err.message)
    await cleanup(s)
  })

  return s.id
}

async function runQrLogin(s, setStatus, onQrcode) {
  // 登录页只拦埋点、不拦图片字体：二维码弹窗的可见性判定依赖真实布局，
  // 缺图缺字体时元素容易塌成 0×0 被 waitForFunction 的 offsetParent 判死。
  const { context, page } = await browserManager.openPage([], { blockResources: false, blockTracking: true })
  s.context = context
  s.page = page

  let qrSent = false
  const emitQr = base64 => {
    if (qrSent || !base64) return
    qrSent = true
    s.qrcode = base64
    setStatus("waiting", "二维码已生成，请用抖音 App 扫码")
    try {
      onQrcode?.(base64)
    } catch {}
  }

  // 拦响应拿二维码与轮询状态：比截图更稳，也能读到 status 字段
  page.on("response", async response => {
    const url = response.url()
    try {
      if (url.includes(QRCODE_API)) {
        const data = (await response.json())?.data
        if (data?.qrcode) emitQr(`data:image/png;base64,${data.qrcode}`)
        else if (data?.error_code) setStatus("failed", data.description || `获取二维码失败(${data.error_code})`)
      } else if (url.includes(CHECK_API)) {
        const data = (await response.json())?.data
        if (!data) return
        if (data.status === "scanned" && s.status === "waiting")
          setStatus("scanned", "已扫码，请在手机上确认登录")
        else if (data.status === "confirmed" || data.redirect_url) handleSuccess(s, setStatus).catch(() => {})
        else if (data.status === "expired") setStatus("expired", "二维码已过期，请重新登录")
      }
    } catch {
      // 抖音偶尔返回非 JSON（风控页），忽略即可，等超时或 DOM 兜底
    }
  })

  await page.goto(LOGIN_URL, { waitUntil: "domcontentloaded", timeout: 30000 })

  const opened = await openLoginModal(page)
  if (!opened) throw new Error("未找到登录入口，抖音页面结构可能已变化")

  // 接口拦不到时用 DOM 里的二维码 img 兜底
  const domQr = await page
    .waitForFunction(
      () => {
        const img = [...document.querySelectorAll("img")].find(
          el => el.src?.startsWith("data:image/png;base64,") && el.clientWidth >= 100 && el.clientWidth <= 320
        )
        return img ? img.src : false
      },
      { timeout: 20000, polling: 500 }
    )
    .then(h => h.jsonValue())
    .catch(() => "")
  if (domQr) emitQr(domQr)
  if (!qrSent) throw new Error("未能获取二维码，请稍后重试或改用手动登录")

  // 轮询登录态：接口回调可能因风控丢失，这里以「是否已有 sessionid」为最终判据
  while (!["success", "failed", "expired", "canceled"].includes(s.status)) {
    await new Promise(r => setTimeout(r, 2000))
    if (Date.now() > s.expireAt) break
    if (!s.page || s.page.isClosed()) break
    const logged = await hasLoginCookie(s.context)
    if (logged) {
      await handleSuccess(s, setStatus)
      break
    }
  }
}

/**
 * 点开登录弹窗：抖音首页的登录入口是一个纯文本叶子节点（如 <p class="VQdYTqcZ">登录</p>），
 * 真正可点的是它的某个祖先，所以从叶子往上最多试 4 层。
 */
async function openLoginModal(page) {
  const clicked = await page
    .waitForFunction(
      () => {
        const leaf = [...document.querySelectorAll("p, span, div, button")].find(
          el => el.textContent?.trim() === "登录" && el.children.length === 0 && el.offsetParent !== null
        )
        if (!leaf) return false
        let node = leaf
        for (let i = 0; i < 5 && node; i++) {
          node.click()
          node = node.parentElement
        }
        return true
      },
      { timeout: 20000, polling: 500 }
    )
    .then(h => h.jsonValue())
    .catch(() => false)

  if (!clicked) return false
  await new Promise(r => setTimeout(r, 1500))
  return true
}

async function hasLoginCookie(context) {
  if (!context) return false
  try {
    const cookies = await context.cookies()
    return cookies.some(c => /^sessionid(_ss)?$/.test(c.name) && c.value && c.value.length > 10)
  } catch {
    return false
  }
}

async function handleSuccess(s, setStatus) {
  if (s.status === "success") return
  const cookies = await browserManager.exportCookies(s.context)
  if (!cookies.some(c => /^sessionid(_ss)?$/.test(c.name))) {
    setStatus("failed", "登录似乎完成，但未取到 sessionid，请重试")
    await cleanup(s)
    return
  }

  // 账号名：优先用户指定，否则读页面上的抖音昵称，最后兜底时间戳
  let name = s.accountName
  if (!name) name = await readNickname(s.page)
  if (!name) name = `抖音账号${randInt(1000, 9999)}`

  const account = store.upsert(s.botId, { name, cookie: cookies })
  s.accountId = account.id
  s.accountName = account.name
  setStatus("success", `登录成功：${account.name}`)
  audit.add("login.qrcode", { botId: s.botId, accountId: account.id, account: account.name })
  await cleanup(s)
}

async function readNickname(page) {
  if (!page || page.isClosed()) return ""
  try {
    await page.goto("https://www.douyin.com/user/self", { waitUntil: "domcontentloaded", timeout: 20000 })
    const name = await page
      .waitForFunction(
        () => {
          const el =
            document.querySelector('[data-e2e="user-info-nickname"]') ||
            document.querySelector('h1[class*="nickname"], span[class*="nickname"]')
          const text = el?.textContent?.trim()
          return text || false
        },
        { timeout: 8000, polling: 500 }
      )
      .then(h => h.jsonValue())
      .catch(() => "")
    return String(name || "").slice(0, 30)
  } catch {
    return ""
  }
}

/**
 * 手动导入 Cookie。解析与校验都在 store 里做，这里只负责审计与错误信息统一。
 * @param {string|Array} cookie 原始粘贴文本、txt 文件内容或 cookie 数组
 */
export function manualLogin(botId, { name, cookie, source = "text" }) {
  if (!config.bool("security.allowManualCookie", true))
    throw new Error("管理员已关闭手动 Cookie 导入")
  const accountName = String(name || "").trim()
  if (!accountName) throw new Error("请提供账号名称")
  const account = store.upsert(botId, { name: accountName, cookie })
  audit.add("login.manual", { botId, accountId: account.id, account: account.name, source })
  return account
}

/**
 * 校验现有账号 Cookie 是否还有效。
 *
 * 每次校验都要真开一个 Chromium 访问抖音，面板上连点几下就是好几轮真实请求——
 * 既慢又是白给的风控风险。所以结论按 `spark.cookieCheckTTL`（分钟）缓存，
 * TTL 内直接复用，返回值带 `cached: true` 让调用方能在界面上说明「用的是缓存」。
 *
 * @param {object} [opts]
 * @param {boolean} [opts.force] 忽略缓存强制真查，用户点「重新检查」时用
 */
export async function checkAccount(botId, accountId, { force = false } = {}) {
  const ttlMs = config.num("spark.cookieCheckTTL", 30, { min: 0 }) * 60000
  if (!force) {
    const cached = store.cachedCookieCheck(botId, accountId, ttlMs)
    if (cached)
      return {
        ok: cached.ok,
        cached: true,
        at: cached.at,
        message: `${cached.message || (cached.ok ? "Cookie 有效" : "Cookie 已失效")}（${formatDuration(
          Date.now() - cached.at
        )}前的检查结论）`,
      }
  }

  const cookies = store.cookies(botId, accountId)
  if (!cookies?.length) {
    store.markCookieInvalid(botId, accountId, true)
    return { ok: false, cached: false, at: Date.now(), message: "没有可用 Cookie" }
  }

  const { context, page } = await browserManager.openPage(cookies)
  try {
    await page.goto("https://www.douyin.com/chat", { waitUntil: "domcontentloaded", timeout: 30000 })
    const ok = await page
      .waitForSelector('input.semi-input[placeholder="搜索"]', { visible: true, timeout: 20000 })
      .then(() => true)
      .catch(() => false)
    const message = ok ? "Cookie 有效" : "Cookie 已失效，请重新登录"
    // recordCookieCheck 会同时写 cookieInvalid，不用再单独 markCookieInvalid
    const check = store.recordCookieCheck(botId, accountId, ok, message)
    return { ok, cached: false, at: check?.at || Date.now(), message }
  } finally {
    await closeQuietly(page)
    await closeQuietly(context)
  }
}
