/**
 * 浏览器管理：独立的 Chromium 实例、按账号隔离的上下文、带 Cookie 的页面与请求拦截。
 *
 * 不复用 Yunzai 渲染器（renderers/puppeteer）的浏览器实例，只复用它的依赖（puppeteer 包）
 * 与 Chromium 路径配置。原因：那个实例服务于模板截图，带自己的重启与超时策略，并且会通过
 * redis 里的 wsEndpoint 跨进程共享。续火与扫码登录要持有分钟级的登录态页面，挂在它上面会
 * 被它的 restart 打断，也可能把抖音 Cookie 带进其它插件的截图上下文。
 * （lib/render.js 的判断相反：短平快的截图适合复用渲染器，见该文件头部说明。）
 *
 * 导出：browserManager 单例（同时作为 default）、attachInterception、setContextCookies、
 * getContextCookies、closeQuietly、randomSleep。
 *
 * 依赖：puppeteer、Yunzai 的 lib/config/config.js（取 bot.chromium_path），以及本插件的
 * config / util / debug。不导入 spark、login、chat 等业务模块 —— 它们都反向依赖本模块。
 *
 * 调用前提：browserManager.browser() 幂等且并发安全（并发调用只真正启动一次）；openPage()
 * 返回的 { context, page } 由调用方负责关闭；全部真实页面关闭后本模块按
 * spark.browserIdleClose 延时收掉整个实例。
 */
import puppeteer from "puppeteer"
import cfg from "../../../lib/config/config.js"
import { config } from "./config.js"
import { log, sleep } from "./util.js"
import { debug } from "./debug.js"

/**
 * 登录链路的白名单，一律放行，且在下面两份黑名单之前判定。
 *
 * 扫码登录依赖 `get_qrcode` 取二维码、`check_qrconnect` 取扫码状态，其前后还串着
 * `challenge`、`ticket_guard`、`login_guiding_strategy`、`ttwid/check`。
 * 这层白名单是防御性的：黑名单后续若新增 `/passport/` 一类规则，整条登录链会静默失败，
 * 而现场表现只是「二维码一直不出」，定位成本很高。
 */
const ALWAYS_ALLOW_PARTS = ["/passport/", "passport-fe", "qrcode", "qrconnect", "ttwid", "/sso/", "login.douyin.com"]

/**
 * 与续火无关、可直接拦掉的资源类型。
 *
 * 一次聊天页加载会发出几百个请求，其中大部分是视频封面、头像与字体。续火只依赖 DOM 里的
 * 文本与元素可见性，拦掉这些之后对抖音发出的请求量下降一个量级，页面加载也更快。
 *
 * 不拦 `stylesheet`：puppeteer 的 `visible: true` 判定依赖元素的实际尺寸，缺少样式表时
 * 大量元素会塌成 0×0 被判为不可见，等待因此超时。
 */
const BLOCKED_TYPES = new Set(["image", "media", "font"])

/**
 * 明确用不到的接口，按 URL 子串匹配，仅在 spark.blockTracking 打开时生效。
 * 推荐流与埋点上报是抖音请求量最大的两块，续火与扫码都不读取它们的结果。
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
 * 只在确有规则要拦时才调 `setRequestInterception`：开启拦截会让每个请求多绕一趟 CDP，
 * 两类都不拦时这份开销没有收益。
 *
 * @param {import("puppeteer").Page} page
 * @param {object} [opts] 覆盖配置，登录页可单独放宽
 * @param {boolean} [opts.resources] 覆盖 spark.blockResources
 * @param {boolean} [opts.tracking] 覆盖 spark.blockTracking
 * @param {string[]} [opts.types] 直接指定要拦的 resourceType，用于 opts.resources 之外的
 *   中间档：登录页需要图片与字体撑起弹窗布局，但不需要推荐流的视频
 * @returns {Promise<boolean>} 是否真的挂上了拦截（两类都不拦时返回 false）
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
      // 白名单必须先于黑名单判定：顺序颠倒等于把扫码登录押在「黑名单永不误伤」上
      if (ALWAYS_ALLOW_PARTS.some(part => url.includes(part))) return req.continue()
      if (blockTypes.has(req.resourceType())) return req.abort()
      if (blockTracking && BLOCKED_URL_PARTS.some(part => url.includes(part))) return req.abort()
      return req.continue()
    } catch {
      // 请求可能已被其它监听器处理，或页面已关闭，重复 abort/continue 会抛，此处忽略
    }
  })
  return true
}

/* ---------- puppeteer 版本兼容层 ----------
 * Yunzai 根 package.json 里 puppeteer 写的是 "*"，实际安装的大版本取决于用户机器，
 * 而以下 API 在 v22 / v23 各改过一次名字或位置：
 *   - browser.createBrowserContext        v22 起；v22 之前叫 createIncognitoBrowserContext
 *   - BrowserContext.cookies / setCookie  v23 起；v23 之前只有 Page 级 cookie API
 *   - browser.connected                   v22 起的属性；v22 之前是 isConnected() 方法
 * 锁定任一版本都会在其它机器上失败（实测 v21 报 createBrowserContext is not a function），
 * 因此一律先探测再调用，既不新增依赖也不要求用户升级 puppeteer。
 */

/**
 * puppeteer 自带 Chromium 的路径。
 * 老版本没有顶层 executablePath()，且未下载浏览器时该方法会直接抛异常；
 * 取不到则返回空串，交给 puppeteer.launch 自行查找。
 * @returns {string}
 */
function builtinChromium() {
  try {
    return typeof puppeteer.executablePath === "function" ? puppeteer.executablePath() : ""
  } catch {
    return ""
  }
}

/**
 * 浏览器连接是否仍然有效。v22 起是 connected 属性，之前是 isConnected() 方法。
 * @param {import("puppeteer").Browser|null} browser
 * @returns {boolean} 两个 API 都不存在时保守返回 true
 */
function isConnected(browser) {
  if (!browser) return false
  if (typeof browser.connected === "boolean") return browser.connected
  if (typeof browser.isConnected === "function") return browser.isConnected()
  return true
}

/**
 * 去掉 UA 里的 headless 标记。
 *
 * 无头 Chromium 的默认 UA 形如 `...HeadlessChrome/151.0.0.0...`，抖音识别后会把请求导向
 * 验证码中间页 —— 该页面只有 4KB，既无登录入口也无聊天列表，续火与扫码都会停在
 * 「元素找不到」上。
 *
 * 不硬编码具体 UA 字符串：写死的版本号会随时间过期，反而更容易被识别。改为取当前浏览器
 * 自报的 UA，仅把 HeadlessChrome 替换为 Chrome，其余字段（平台、版本号、WebKit 版本）
 * 与真实内核保持一致。
 *
 * @param {import("puppeteer").Browser} browser
 * @returns {Promise<string>} 取不到时返回空串，由调用方决定是否沿用浏览器默认 UA
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

/**
 * 新建互相隔离的浏览器上下文。
 * @param {import("puppeteer").Browser} browser
 * @returns {Promise<import("puppeteer").BrowserContext>}
 * @throws 两个 API 都不存在（puppeteer 版本过低）时抛出
 */
async function newContext(browser) {
  if (typeof browser.createBrowserContext === "function") return browser.createBrowserContext()
  if (typeof browser.createIncognitoBrowserContext === "function") return browser.createIncognitoBrowserContext()
  // 不退回 defaultBrowserContext：那会让多个抖音账号共用一个 cookie jar，宁可直接报错
  throw new Error("puppeteer 版本过低：没有 createBrowserContext / createIncognitoBrowserContext")
}

/**
 * 往上下文里写入 Cookie。
 *
 * v23 之前没有 context.setCookie，退到 page.setCookie —— 同一 context 内的页面共享
 * cookie jar，写在哪个页面上等价；只要 cookie 自带 domain，就不需要先导航。
 *
 * @param {import("puppeteer").BrowserContext} context
 * @param {import("puppeteer").Page|null} page 低版本路径要用的页面，为空时从 context 取或新建
 * @param {Array} cookies puppeteer cookie 数组，空数组或 undefined 时直接返回
 * @returns {Promise<void>}
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
 * v23 之前只有 page.cookies()，而它默认只返回当前 URL 所在域的 cookie；扫码登录会在
 * douyin.com 与 sso.douyin.com 之间跳转，漏掉子域即等于丢掉 sessionid。因此低版本改走
 * CDP 的 `Network.getAllCookies`，一次取回整个 context 的 cookie jar。
 *
 * @param {import("puppeteer").BrowserContext} context
 * @returns {Promise<Array>} context 为空或没有页面可建 CDP 会话时返回空数组
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
 * 抖音页面内存占用较高：未登录首页是 1.6MB HTML 加数十张图与推荐流视频，一个 Chromium
 * 实例开着两三个这类页面即可占用 600MB 以上。以下参数按「关掉本插件用不到的能力」筛选，
 * 每条对应一块具体开销：
 *
 * - `--autoplay-policy` 收益最大。视频一旦起播，解码缓冲区就是几十到上百 MB，而本插件
 *   只需要 DOM 文本与按钮位置，不需要任何画面。请求拦截只能拦住 `media` 类型的请求，
 *   拦不住页面里已有的 `<video>` 自行起播。
 * - 光栅化与 2D canvas：`--disable-gpu` 之后 Chromium 会退到软件光栅，该路径同样占内存。
 *   截图走 CDP 的 `Page.captureScreenshot`，不依赖它们。
 * - 扩展、同步、默认应用、指标上报：无头环境下均不使用，每项各省一个进程或一份后台任务。
 *
 * 以下三条经评估后不采用，记录原因以免被当作遗漏补上：
 * - `--js-flags=--max-old-space-size=N`：为渲染进程的 JS 堆设上限，省内存最直接，但上限
 *   偏小时抖音前端会把堆用满导致渲染进程崩溃，现象是页面白屏或登录失败；而合适的上限只能
 *   在真实抖音页面上实测得出。
 * - `--single-process` / `--disable-features=site-per-process`：省内存最多，但会让多个抖音
 *   账号的页面共用渲染进程。账号隔离（每账号一个 BrowserContext）是本插件的基础约束。
 * - `--disable-images`：图片拦截已按场景分开处理（续火拦、登录页不拦，因为二维码弹窗的
 *   可见性判定需要真实布局）。全局关闭会使登录失效。
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

  /**
   * 拼出 puppeteer.launch 的参数。
   * Chromium 路径优先级：spark.browserPath → Yunzai 的 bot.chromium_path → puppeteer 内置。
   * @returns {{headless: boolean, args: string[], executablePath?: string}}
   */
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
        // 首启向导与「设为默认浏览器」弹窗会遮挡页面，也会拖慢启动
        "--no-first-run",
        "--no-default-browser-check",
        ...MEMORY_ARGS,
      ],
    }
    if (chromium) options.executablePath = chromium
    return options
  }

  /**
   * 取浏览器实例，没有则启动。
   *
   * 用 #launching 这个 promise 做并发闸门：多个账号同时开页面时只会真正启动一次，
   * 其余调用等同一个 promise。
   *
   * @returns {Promise<import("puppeteer").Browser>}
   * @throws puppeteer.launch 失败时原样抛出（Chromium 路径错误、缺依赖库等）
   */
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
       * 页面全部关闭后连浏览器实例一起收掉。
       *
       * 早期实现里浏览器一旦启动就常驻到 Yunzai 退出：一次扫码登录之后那 200~400MB 不再
       * 释放，而下一次续火可能在十几个小时之后。挂在 targetdestroyed 而不是改各个调用点，
       * 是因为关页面的位置分散在登录 cleanup、续火与 openPage 的失败回滚等多处，遗漏任一
       * 处这条回收路径就失效；而「最后一个页面已消失」这个事实只有浏览器自身掌握。
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
   * 新建一个浏览器上下文，每个抖音账号一个，Cookie 互不污染。
   * 具体调 createBrowserContext 还是旧的 createIncognitoBrowserContext 由兼容层决定。
   * @returns {Promise<import("puppeteer").BrowserContext>}
   */
  async context() {
    const browser = await this.browser()
    return newContext(browser)
  }

  /**
   * 页面全部关闭后延时收掉浏览器实例，由 targetdestroyed 事件触发。
   *
   * 延时而非立即关闭：续火按「一个账号一个页面」串行执行，上一个页面关闭到下一个页面建立
   * 之间有几秒空档（randomSleep 制造的间隔）；立即关闭会导致每个账号都重启一次浏览器，
   * 启动耗时的代价高于这段时间省下的内存。默认 60 秒足以跨过该空档，也不会让内存长期空占。
   *
   * 判据是「是否还有真实页面」而不是「是否还有 target」：浏览器启动时自带一个 about:blank，
   * 它始终存在，按 target 数判定永远不为 0。
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
        // about:blank 是启动自带的空页，不计入「仍在使用」
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
   * 开一个带 Cookie 的抖音页面。
   *
   * @param {Array} [cookies=[]] puppeteer cookie 数组，可为空（扫码登录时就是空的）
   * @param {object} [opts]
   * @param {boolean} [opts.intercept=true] 是否挂请求拦截
   * @param {boolean} [opts.blockResources] 覆盖 spark.blockResources
   * @param {boolean} [opts.blockTracking] 覆盖 spark.blockTracking
   * @param {string[]} [opts.blockTypes] 只拦这些 resourceType，优先于 blockResources
   * @returns {Promise<{context: import("puppeteer").BrowserContext,
   *   page: import("puppeteer").Page}>} 调用方负责关闭两者（closeQuietly）
   * @throws 建页失败时先回滚已建出的 page/context，再原样抛出
   */
  async openPage(cookies = [], opts = {}) {
    // 上一批页面刚关完、回收定时器正在倒数时又来了新任务，撤掉该定时器
    clearTimeout(this.#idleTimer)
    const context = await this.context()
    let page
    try {
      page = await context.newPage()
      // UA 必须在任何导航之前设置：默认的 HeadlessChrome 会被抖音导向验证码中间页
      if (this.#ua) await page.setUserAgent(this.#ua)
      // 低版本没有 context.setCookie，需先有 page 才能写，故顺序固定为「建页 → 写 cookie」
      await setContextCookies(context, page, cookies)
      await page.setViewport({ width: 1280, height: 800 })
      // 抖音会读 navigator.webdriver 判定自动化，抹掉可少触发一层验证
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

  /**
   * 导出上下文里的抖音 Cookie，扫码登录成功后由它落盘。
   * 只保留 domain 含 douyin.com 的项，滤掉验证过程中带进来的第三方 cookie。
   * @param {import("puppeteer").BrowserContext} context
   * @returns {Promise<Array>}
   */
  async exportCookies(context) {
    const cookies = await getContextCookies(context)
    return cookies.filter(c => String(c.domain || "").includes("douyin.com"))
  }

  /**
   * 关掉浏览器实例。无论成功与否都先清空内部引用，因此可重复调用。
   *
   * @param {number} [hardKillAfter=0] 大于 0 时给 browser.close() 设一个毫秒上限，超时后
   *   直接 SIGKILL 掉 Chromium 进程。只有进程收尾（lib/shutdown.js）需要传：平时
   *   `#armIdleClose` 关不掉可以等下一次，而收尾时关不掉即等于永久留下一个 Chromium。
   * @returns {Promise<void>} 关闭失败只记日志，不向调用方抛
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
      // 关不掉又必须收尾时只剩强杀；平时（hardKillAfter=0）不处理，
      // 交给下一次 #armIdleClose 重试
      if (hardKillAfter > 0) hardKill(browser)
    }
  }

  /** 浏览器实例当前是否在运行 */
  get running() {
    return isConnected(this.#browser)
  }

  /** 当前生效的 UA，仅用于调试日志（真实 UA 不算敏感值，但没必要进普通日志） */
  currentUA() {
    return this.#ua || "(未取到)"
  }
}

/**
 * 直接杀掉 Chromium 进程。仅在收尾时 browser.close() 不返回的情况下使用。
 *
 * 非 win32 平台杀的是进程组（负号 pid）而不是单个进程 —— puppeteer 启动 Chromium 时
 * `detached ??= process.platform !== 'win32'`，Chromium 是新进程组的组长，其下还有
 * renderer / gpu / zygote 等子进程。只杀组长会让这些子进程被 init 收养并留在系统中，
 * 而这正是本函数要避免的现象。puppeteer 自身的 kill() 采用同样做法
 * （@puppeteer/browsers 的 launch.js:269-283）。
 *
 * @param {import("puppeteer").Browser} browser
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
    // ESRCH 表示进程已经不存在，即为期望结果
    if (error?.code !== "ESRCH") log("warn", "强杀浏览器失败：", error.message)
  }
}

/**
 * 关闭 page 或 context 并吞掉异常：关闭失败不应覆盖真正的业务异常。
 * @param {{isClosed?: Function, close: Function}|null} target
 * @returns {Promise<void>}
 */
export async function closeQuietly(target) {
  if (!target) return
  try {
    if (typeof target.isClosed === "function" && target.isClosed()) return
    await target.close()
  } catch {}
}

/**
 * 带随机抖动的 sleep，续火在相邻好友之间用它拉开间隔以降低风控风险。
 * @param {number} min 下界（毫秒），非法值按 0
 * @param {number} max 上界（毫秒），小于下界时取下界
 * @returns {Promise<void>}
 */
export async function randomSleep(min, max) {
  const lo = Math.max(0, Number(min) || 0)
  const hi = Math.max(lo, Number(max) || lo)
  await sleep(lo + Math.floor(Math.random() * (hi - lo + 1)))
}

export const browserManager = new BrowserManager()
export default browserManager
