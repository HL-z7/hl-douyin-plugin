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
import { debug } from "./debug.js"

/**
 * 登录链路，永远不拦，优先级高于下面两份黑名单。
 *
 * 扫码登录靠 `get_qrcode` 出图、`check_qrconnect` 出状态，前面还串着
 * `challenge`、`ticket_guard`、`login_guiding_strategy`、`ttwid/check`。
 * 这层白名单是给以后的人留的保险：黑名单里哪天多一条 `/passport/` 之类的规则，
 * 整条登录链就会静默挂掉，而现场只会表现为「二维码一直不出」，极难定位。
 */
const ALWAYS_ALLOW_PARTS = ["/passport/", "passport-fe", "qrcode", "qrconnect", "ttwid", "/sso/", "login.douyin.com"]

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
 * 只在真有东西要拦时才调 `setRequestInterception`——开着拦截本身会让每个请求多绕一趟
 * CDP，两样都不拦就白付这份开销。
 *
 * @param {import("puppeteer").Page} page
 * @param {object} [opts] 覆盖配置，登录页可单独放宽
 * @param {boolean} [opts.resources] 覆盖 spark.blockResources
 * @param {boolean} [opts.tracking] 覆盖 spark.blockTracking
 * @param {string[]} [opts.types] 直接指定要拦的 resourceType，给 opts.resources 之外的
 *   中间档用：登录页需要图片和字体撑起弹窗布局，但用不着推荐流的视频
 */
export async function attachInterception(page, opts = {}) {
  const blockTypes = opts.types
    ? new Set(opts.types)
    : (opts.resources ?? config.bool("spark.blockResources", true))
      ? BLOCKED_TYPES
      : new Set()
  const blockTracking = opts.tracking ?? config.bool("spark.blockTracking", true)
  if (!blockTypes.size && !blockTracking) return false

  await page.setRequestInterception(true)
  debug(
    "浏览器",
    `已挂请求拦截：资源=${blockTypes.size ? [...blockTypes].join("/") : "全放"} 埋点/推荐流=${blockTracking ? "拦" : "放"}`
  )
  page.on("request", req => {
    try {
      const url = req.url()
      // 登录链路先放行，再谈拦什么。顺序反了就等于把扫码登录押在黑名单永远不出错上
      if (ALWAYS_ALLOW_PARTS.some(part => url.includes(part))) return req.continue()
      if (blockTypes.has(req.resourceType())) return req.abort()
      if (blockTracking && BLOCKED_URL_PARTS.some(part => url.includes(part))) return req.abort()
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

/**
 * 抹掉 UA 里的 headless 标记。
 *
 * 无头 Chromium 的默认 UA 是 `...HeadlessChrome/151.0.0.0...`，抖音见到就把请求
 * 打到「验证码中间页」——页面只有 4KB，没有登录入口也没有聊天列表，续火与扫码
 * 全都会卡在「元素找不到」上。
 *
 * 这里不写死某个具体 UA 字符串：硬编码的版本号会随时间变旧，反而更可疑。
 * 直接取当前浏览器自报的 UA，只把 HeadlessChrome 换成 Chrome，其余（平台、
 * 版本号、WebKit 版本）保持与真实内核一致。
 */
async function realisticUA(browser) {
  try {
    const ua = await browser.userAgent()
    if (!ua) return ""
    return ua.replace(/HeadlessChrome/g, "Chrome")
  } catch {
    return ""
  }
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
/**
 * 省内存的启动参数。
 *
 * 抖音页面很吃内存：未登录首页是 1.6MB HTML + 几十张图 + 推荐流视频，一个 Chromium
 * 实例开着两三个这样的页面就能占到 600MB 以上。这一组参数按「拿掉我们用不到的东西」
 * 挑的，每条都对得上一块具体开销：
 *
 * - `--autoplay-policy` 是里面最值钱的一条。视频一旦起播，解码缓冲区几十上百 MB
 *   就出去了，而我们只需要 DOM 文本和按钮位置，一帧画面都不用看。资源拦截只拦得住
 *   `media` 类型的请求，拦不住已经在页面里的 `<video>` 自己去起播。
 * - 光栅化与 2D canvas：`--disable-gpu` 之后 Chromium 会退到软件光栅，那条路照样
 *   吃内存。截图走的是 CDP 的 `Page.captureScreenshot`，不需要它们。
 * - 扩展、同步、默认应用、指标上报：无头环境里一个都用不上，每项都省一个进程或一份
 *   后台任务。
 *
 * 不放进来的三条，记一下免得以后有人「顺手优化」：
 * - `--js-flags=--max-old-space-size=N`：给渲染进程的 JS 堆划上限，省内存最直接，但
 *   划小了抖音那套前端会把堆撑爆，渲染进程直接崩，表现就是「页面莫名白屏 / 登录失败」。
 *   而合适的上限只能靠在真实抖音页面上试出来，试不出来就不如不划。
 * - `--single-process` / `--disable-features=site-per-process`：能省下最多内存，但会
 *   让多个抖音账号的页面共用渲染进程。账号隔离是这个插件的地基（每账号一个
 *   BrowserContext），拿它换内存不划算。
 * - `--disable-images`：图片拦截已经按场景分开做了（续火拦、登录页不拦，因为二维码
 *   弹窗的可见性判定要真实布局）。整片关掉会让登录直接失效。
 */
const MEMORY_ARGS = [
  "--autoplay-policy=user-gesture-required",
  "--disable-software-rasterizer",
  "--disable-accelerated-2d-canvas",
  "--mute-audio",
  "--disable-extensions",
  "--disable-component-extensions-with-background-pages",
  "--disable-default-apps",
  "--disable-sync",
  "--metrics-recording-only",
  "--no-pings",
]

class BrowserManager {
  #browser = null
  #launching = null
  #ua = ""
  #idleTimer = null

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
        // 首启向导与「设为默认浏览器」弹窗会挡住页面，也会拖慢启动
        "--no-first-run",
        "--no-default-browser-check",
        ...MEMORY_ARGS,
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
      debug("浏览器", `启动参数 headless=${options.headless} args=${options.args.join(" ")}`)
      const browser = await puppeteer.launch(options)
      browser.on("disconnected", () => {
        if (this.#browser === browser) this.#browser = null
      })
      /*
       * 页面关完之后把整个浏览器也收掉。
       *
       * 以前浏览器一旦启动就常驻到 Yunzai 退出：一次扫码登录之后，那 200~400MB
       * 就再也不还了，而下一次续火可能是十几个小时之后。挂在 targetdestroyed 上
       * 而不是改各个调用点，是因为关页面的地方有五处（登录 cleanup、续火三处、
       * openPage 的失败回滚），漏一处这条路就是废的；而「最后一个页面没了」这个
       * 事实只有浏览器自己最清楚。
       */
      browser.on("targetdestroyed", () => this.#armIdleClose())
      this.#ua = await realisticUA(browser)
      debug("浏览器", `版本=${await browser.version().catch(() => "未知")} UA=${this.#ua || "(取不到，用浏览器默认)"}`)
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
   * 页面全关完之后延时收掉浏览器实例。
   *
   * 为什么要延时而不是立刻关：续火是「一个账号一个页面」串着跑的，上一个页面关掉到
   * 下一个页面建起来之间有几秒空档（randomSleep 制造的间隔）；立刻关掉就变成每个账号
   * 都重启一次浏览器，启动那两三秒比省下来的内存值钱。默认 60 秒足够跨过这段空档，
   * 又不至于让内存白占一整天。
   *
   * 判据是「还有没有真实页面」而不是「有没有 target」：浏览器启动时自带一个
   * about:blank，它永远在，按 target 数判会永远不为 0。
   */
  #armIdleClose() {
    clearTimeout(this.#idleTimer)
    const delay = config.num("spark.browserIdleClose", 60, { min: 0, max: 3600 }) * 1000
    if (!delay) return
    this.#idleTimer = setTimeout(async () => {
      const browser = this.#browser
      if (!isConnected(browser)) return
      let live = 0
      try {
        // about:blank 是启动自带的空页，不算「还在用」
        live = (await browser.pages()).filter(p => !p.isClosed() && p.url() && p.url() !== "about:blank").length
      } catch {
        return
      }
      if (live) return
      log("info", `浏览器已空闲 ${delay / 1000} 秒，关闭实例释放内存`)
      await this.close()
    }, delay)
    this.#idleTimer.unref?.()
  }

  /**
   * 开一个带 Cookie 的抖音页面。返回 { context, page }，调用方负责 close。
   *
   * @param {Array} cookies puppeteer cookie 数组，可为空（扫码登录时就是空的）
   * @param {object} [opts]
   * @param {boolean} [opts.intercept=true] 是否挂请求拦截
   * @param {boolean} [opts.blockResources] 覆盖 spark.blockResources
   * @param {boolean} [opts.blockTracking] 覆盖 spark.blockTracking
   * @param {string[]} [opts.blockTypes] 只拦这些 resourceType，优先于 blockResources
   */
  async openPage(cookies = [], opts = {}) {
    // 上一批页面刚关完、收尾定时器正在倒数时又来了新活，把它撤掉
    clearTimeout(this.#idleTimer)
    const context = await this.context()
    let page
    try {
      page = await context.newPage()
      // 必须在任何导航之前设 UA：默认的 HeadlessChrome 会被抖音打到验证码中间页
      if (this.#ua) await page.setUserAgent(this.#ua)
      // 低版本没有 context.setCookie，得先有 page 才能写，所以顺序是「建页 → 写 cookie」
      await setContextCookies(context, page, cookies)
      await page.setViewport({ width: 1280, height: 800 })
      // 抖音会用 navigator.webdriver 判定自动化，抹掉它能少触发一层验证
      await page.evaluateOnNewDocument(() => {
        Object.defineProperty(navigator, "webdriver", { get: () => undefined })
      })
      let attached = false
      if (opts.intercept !== false)
        attached = await attachInterception(page, {
          resources: opts.blockResources,
          tracking: opts.blockTracking,
          types: opts.blockTypes,
        })
      debug("浏览器", `新页面就绪：cookie=${cookies?.length || 0} 条 拦截=${attached ? "开" : "关"} viewport=1280x800`)
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

  /**
   * 关掉浏览器实例。
   *
   * @param {number} [hardKillAfter=0] 大于 0 时给 browser.close() 一个上限，超了直接
   *   SIGKILL 掉 Chromium 进程。只有进程收尾（lib/shutdown.js）才需要传：平时
   *   `#armIdleClose` 关不掉就下次再关，而收尾时关不掉就等于永久留下一个 Chromium。
   */
  async close(hardKillAfter = 0) {
    clearTimeout(this.#idleTimer)
    const browser = this.#browser
    this.#browser = null
    this.#ua = ""
    if (!browser) return
    try {
      if (hardKillAfter > 0) {
        const closed = await Promise.race([
          browser.close().then(() => true),
          new Promise(resolve => {
            const t = setTimeout(() => resolve(false), hardKillAfter)
            t.unref?.()
          }),
        ])
        if (!closed) {
          log("warn", `浏览器 ${hardKillAfter / 1000} 秒没关掉，强杀进程`)
          hardKill(browser)
        }
        return
      }
      await browser.close()
    } catch (error) {
      log("warn", "关闭浏览器失败：", error.message)
      // 关不掉又要收尾，只剩强杀这一条路；平时（hardKillAfter=0）不动它，
      // 下一次 #armIdleClose 会再试一遍
      if (hardKillAfter > 0) hardKill(browser)
    }
  }

  get running() {
    return isConnected(this.#browser)
  }

  /** 当前生效的 UA，只给调试日志用（真实 UA 不算敏感值，但也没必要进普通日志） */
  currentUA() {
    return this.#ua || "(未取到)"
  }
}

/**
 * 直接杀掉 Chromium 进程。只在收尾时 browser.close() 不肯返回的情况下用。
 *
 * 非 win32 杀的是进程组（负号 pid）而不是单个进程 —— puppeteer 启动 Chromium 时
 * `detached ??= process.platform !== 'win32'`，Chromium 是新进程组的组长，它下面还有
 * renderer / gpu / zygote 一串子进程。只杀组长的话那一串会被 init 收养并留在系统里，
 * 而这正是我们要修的现象本身。puppeteer 自己的 kill() 就是这么做的
 * （@puppeteer/browsers 的 launch.js:269-283）。
 */
function hardKill(browser) {
  try {
    const proc = browser.process?.()
    const pid = proc?.pid
    if (!pid) return
    if (process.platform === "win32") proc.kill("SIGKILL")
    else process.kill(-pid, "SIGKILL")
    log("info", `已强杀浏览器进程组 ${pid}`)
  } catch (error) {
    // ESRCH：进程其实已经没了，那正是想要的结果
    if (error?.code !== "ESRCH") log("warn", "强杀浏览器失败：", error.message)
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
