/**
 * 浏览器管理：独立的 Chromium 实例、带 Cookie 的页面、请求节流。
 *
 * 为什么不直接复用 Yunzai 的渲染器浏览器：
 * renderers/puppeteer 那个实例是给模板截图用的，带自己的重启/超时策略，
 * 还会被 redis 里的 wsEndpoint 跨进程共享。续火与扫码登录要持有分钟级的登录态页面，
 * 挂在它上面会被它的 restart 打断，也可能把抖音 Cookie 带进别的插件的截图上下文。
 * 所以这里只复用它的依赖（puppeteer 包）和 Chromium 路径配置，浏览器实例独立。
 */
import puppeteer from "puppeteer"
import cfg from "../../../lib/config/config.js"
import { config } from "./config.js"
import { log, sleep } from "./util.js"

/**
 * 与续火无关、可以直接掐掉的资源类型。
 *
 * 一次聊天页加载会发出几百个请求，大头是视频封面、头像和字体。续火只依赖
 * DOM 里的文本与可见性，把这些拦掉后对抖音发出的请求量降一个量级，页面也快得多。
 *
 * 注意不拦 `stylesheet`：puppeteer 的 `visible: true` 判定依赖元素的实际尺寸，
 * 没有样式表时大量元素塌成 0×0，会被误判为「不可见」而白等超时。
 */
const BLOCKED_TYPES = new Set(["image", "media", "font"])

/**
 * 明确用不到的接口，按 URL 子串匹配。
 * 推荐流与埋点上报是抖音请求量最大的两块，续火和扫码都不看它们的结果。
 */
const BLOCKED_URL_PARTS = [
  "/aweme/v1/web/tab/feed",
  "/aweme/v1/web/module/feed",
  "/aweme/v1/web/follow/feed",
  "/service/2/app_log",
  "/service/2/device_register",
  "/monitor_browser/collect",
  "/slardar/",
  "log.snssdk.com",
  "mcs.zijieapi.com",
  "mon.zijieapi.com",
  "/webcast/",
]

/**
 * 给页面挂上请求拦截。
 *
 * 只在 `spark.blockResources` / `spark.blockTracking` 打开时生效，两个都关就不调用
 * `setRequestInterception`——开着拦截本身会让每个请求多绕一趟 CDP，没必要白付这份开销。
 *
 * @param {import("puppeteer").Page} page
 * @param {{resources?: boolean, tracking?: boolean}} [opts] 覆盖配置，登录页可单独放宽
 */
export async function attachInterception(page, opts = {}) {
  const blockResources = opts.resources ?? config.bool("spark.blockResources", true)
  const blockTracking = opts.tracking ?? config.bool("spark.blockTracking", true)
  if (!blockResources && !blockTracking) return false

  await page.setRequestInterception(true)
  page.on("request", req => {
    try {
      if (blockResources && BLOCKED_TYPES.has(req.resourceType())) return req.abort()
      if (blockTracking) {
        const url = req.url()
        if (BLOCKED_URL_PARTS.some(part => url.includes(part))) return req.abort()
      }
      return req.continue()
    } catch {
      // 请求可能已被别的监听器处理或页面已关闭，重复 abort/continue 会抛，这里咽掉
    }
  })
  return true
}

/* ---------- puppeteer 版本兼容层 ----------
 * Yunzai 根 package.json 里 puppeteer 写的是 "*"，实际装到哪个大版本取决于用户机器，
 * 而这几个 API 在 v22 / v23 各改过一次名字或位置：
 *   - browser.createBrowserContext        v22 起；v22 前叫 createIncognitoBrowserContext
 *   - BrowserContext.cookies / setCookie  v23 起；v23 前只有 Page 级 cookie API
 *   - browser.connected                   v22 起的属性；v22 前是 isConnected() 方法
 * 锁死任一版本都会在别人机器上炸（实测 v21 报 createBrowserContext is not a function），
 * 所以一律先探测再调用，不新增依赖也不要求用户升级 puppeteer。
 */

/**
 * puppeteer 自带 Chromium 的路径。
 * 老版本没有顶层 executablePath()，而且没下载浏览器时它会直接抛；
 * 取不到就返回空串，交给 puppeteer.launch 自己去找。
 */
function builtinChromium() {
  try {
    return typeof puppeteer.executablePath === "function" ? puppeteer.executablePath() : ""
  } catch {
    return ""
  }
}

/** 浏览器是否还活着 */
function isConnected(browser) {
  if (!browser) return false
  if (typeof browser.connected === "boolean") return browser.connected
  if (typeof browser.isConnected === "function") return browser.isConnected()
  return true
}

/** 新建互相隔离的浏览器上下文 */
async function newContext(browser) {
  if (typeof browser.createBrowserContext === "function") return browser.createBrowserContext()
  if (typeof browser.createIncognitoBrowserContext === "function") return browser.createIncognitoBrowserContext()
  // 退到 defaultBrowserContext 会让多个抖音账号共用一个 cookie jar，宁可报错
  throw new Error("puppeteer 版本过低：没有 createBrowserContext / createIncognitoBrowserContext")
}

/**
 * 往上下文里写 Cookie。
 * v23 以前没有 context.setCookie，退到 page.setCookie —— 同一 context 内的页面共享
 * cookie jar，写在哪个页面上都一样，只要 cookie 自带 domain 就不需要先导航。
 */
export async function setContextCookies(context, page, cookies) {
  if (!cookies?.length) return
  if (typeof context.setCookie === "function") return context.setCookie(...cookies)
  const target = page || (await context.pages())[0] || (await context.newPage())
  await target.setCookie(...cookies)
}

/**
 * 读出上下文里的全部 Cookie。
 *
 * v23 以前只有 page.cookies()，而它默认只返回当前 URL 域下的那些；扫码登录会在
 * douyin.com 与 sso.douyin.com 之间跳，漏掉子域就等于丢 sessionid。所以低版本走 CDP 的
 * Network.getAllCookies，一次拿到整个 context 的 cookie jar。
 */
export async function getContextCookies(context) {
  if (!context) return []
  if (typeof context.cookies === "function") return (await context.cookies()) || []

  const page = (await context.pages())[0]
  if (!page) return []
  const client =
    typeof page.createCDPSession === "function"
      ? await page.createCDPSession()
      : await page.target().createCDPSession()
  try {
    const { cookies } = await client.send("Network.getAllCookies")
    return cookies || []
  } finally {
    await client.detach().catch(() => {})
  }
}
class BrowserManager {
  #browser = null
  #launching = null

  #launchOptions() {
    const custom = String(config.get("spark.browserPath", "")).trim()
    const chromium = custom || cfg?.bot?.chromium_path || builtinChromium()
    const options = {
      headless: config.get("spark.headless", true) !== false,
      args: [
        "--disable-gpu",
        "--disable-setuid-sandbox",
        "--no-sandbox",
        "--no-zygote",
        "--disable-dev-shm-usage",
        "--disable-blink-features=AutomationControlled",
      ],
    }
    if (chromium) options.executablePath = chromium
    return options
  }

  /** 并发调用只会真正启动一次 */
  async browser() {
    if (isConnected(this.#browser)) return this.#browser
    if (this.#launching) return this.#launching

    this.#launching = (async () => {
      const options = this.#launchOptions()
      log("info", `启动浏览器：${options.executablePath || "puppeteer 内置"}`)
      const browser = await puppeteer.launch(options)
      browser.on("disconnected", () => {
        if (this.#browser === browser) this.#browser = null
      })
      this.#browser = browser
      return browser
    })()

    try {
      return await this.#launching
    } finally {
      this.#launching = null
    }
  }

  /**
   * 每个抖音账号一个独立上下文，Cookie 互不污染。
   * 具体调 createBrowserContext 还是老的 createIncognitoBrowserContext 由兼容层决定。
   */
  async context() {
    const browser = await this.browser()
    return newContext(browser)
  }

  /**
   * 开一个带 Cookie 的抖音页面。返回 { context, page }，调用方负责 close。
   *
   * @param {Array} cookies puppeteer cookie 数组，可为空（扫码登录时就是空的）
   * @param {object} [opts]
   * @param {boolean} [opts.intercept=true] 是否挂请求拦截
   * @param {boolean} [opts.blockResources] 覆盖 spark.blockResources
   * @param {boolean} [opts.blockTracking] 覆盖 spark.blockTracking
   */
  async openPage(cookies = [], opts = {}) {
    const context = await this.context()
    let page
    try {
      page = await context.newPage()
      // 低版本没有 context.setCookie，得先有 page 才能写，所以顺序是「建页 → 写 cookie」
      await setContextCookies(context, page, cookies)
      await page.setViewport({ width: 1280, height: 800 })
      // 抖音会用 navigator.webdriver 判定自动化，抹掉它能少触发一层验证
      await page.evaluateOnNewDocument(() => {
        Object.defineProperty(navigator, "webdriver", { get: () => undefined })
      })
      if (opts.intercept !== false)
        await attachInterception(page, { resources: opts.blockResources, tracking: opts.blockTracking })
      return { context, page }
    } catch (error) {
      await closeQuietly(page)
      await closeQuietly(context)
      throw error
    }
  }

  /** 导出上下文里的抖音 Cookie，扫码登录成功后就靠它落盘 */
  async exportCookies(context) {
    const cookies = await getContextCookies(context)
    return cookies.filter(c => String(c.domain || "").includes("douyin.com"))
  }

  async close() {
    const browser = this.#browser
    this.#browser = null
    if (!browser) return
    try {
      await browser.close()
    } catch (error) {
      log("warn", "关闭浏览器失败：", error.message)
    }
  }

  get running() {
    return isConnected(this.#browser)
  }
}

/** page / context 关闭失败不该盖掉真正的业务异常 */
export async function closeQuietly(target) {
  if (!target) return
  try {
    if (typeof target.isClosed === "function" && target.isClosed()) return
    await target.close()
  } catch {}
}

/** 给 sleep 一个带随机抖动的版本，续火相邻好友之间用它 */
export async function randomSleep(min, max) {
  const lo = Math.max(0, Number(min) || 0)
  const hi = Math.max(lo, Number(max) || lo)
  await sleep(lo + Math.floor(Math.random() * (hi - lo + 1)))
}

export const browserManager = new BrowserManager()
export default browserManager
