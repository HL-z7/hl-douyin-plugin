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
import path from "node:path"
import { log, toError, randInt, formatDuration, sleep, dataDir, ensureDir, safeFileName } from "./util.js"
import { config } from "./config.js"
import { store } from "./store.js"
import { audit } from "./audit.js"
import browserManager, { closeQuietly, getContextCookies } from "./browser.js"
import { randomToken } from "./crypto.js"

const LOGIN_URL = "https://www.douyin.com/"
const QRCODE_API = "login.douyin.com/passport/web/get_qrcode"
const CHECK_API = "login.douyin.com/passport/web/check_qrconnect"

/**
 * 手机点了「确认登录」之后，最多再等这么久让 sessionid 落进 cookie jar。
 *
 * 抖音的 confirmed 只是把 redirect_url 交给页面，真正写 Cookie 是页面随后那次跳转，
 * 实测 1~3 秒。给到 25 秒是留给慢网络和 sso 多跳一次的余量；超过这个数还没有
 * sessionid，基本就是被追加了一道验证（短信 / 滑块），继续等只会等到会话超时。
 */
const CONFIRM_GRACE_MS = 25000

/**
 * check_qrconnect 的 status 里我们认识的那些。
 *
 * 只用来判断「要不要把这个值记进日志」。上一版的坑正是出在这儿：抖音返回了一个
 * 既不是 confirmed 也不是 scanned/expired 的值，三个 else if 全落空，状态一直停在
 * scanned，最后被超时兜底报成「没等到确认结果」——而日志里一个字都没留，只能靠猜。
 * 现在遇到没见过的值会 warn 一条带原值，下次同样的卡死能直接定位。
 */
const KNOWN_STATUS = new Set(["new", "scanned", "expired", "confirmed", "logged_in", "canceled"])

/** 明确需要人在浏览器里操作才能过的 status */
const VERIFY_STATUS = new Set(["2fa", "verify", "risk", "need_verify", "sms_verify"])

/** 现场截图落这里，与续火失败截图同一个目录 */
const shotDir = () => ensureDir(dataDir, "screenshots")

/** 扫码之后的几个状态。这几个状态下页面不会再换二维码，也就不用再去 DOM 里捞图 */
const POST_SCAN = ["scanned", "confirmed", "verify"]

/** 进行中的扫码会话：sessionId -> state */
const sessions = new Map()

/**
 * 状态机：pending(出码中) -> waiting(等扫) -> scanned(已扫待确认) -> confirmed(已确认待写凭证)
 *          -> success / expired / failed / canceled
 *
 * 注意 expired 有两种含义，只有后者是终态：
 * - 单张二维码过期（抖音每 60 秒换一张）—— 页面自己会刷新出新码，状态回到 waiting，不结束会话
 * - 整个会话超时（security.qrLoginTimeout 到点）—— 真正结束
 *
 * confirmed 是独立的一档，不能省：手机点确认时抖音只是把 redirect_url 交给页面，
 * sessionid 要等页面跳完那一趟才写进 cookie jar。把 confirmed 直接当成功去读 Cookie
 * 会读到空的（这正是「确认了却没反应，最后说超时」的成因之一）。
 */
export function getSession(sessionId) {
  const s = sessions.get(sessionId)
  if (!s) return null
  return {
    id: s.id,
    botId: s.botId,
    status: s.status,
    message: s.message,
    qrcode: s.qrcode,
    qrRound: s.qrRound,
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
    /** 已经发出过几张二维码。抖音每分钟换一张，刷新后这个数 +1 */
    qrRound: 0,
    /** 手机点确认的时刻。凭证不是立刻就有的，靠它算宽限期 */
    confirmedAt: 0,
    /** 认出验证界面的时刻 */
    verifyAt: 0,
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
    // 超时文案按用户实际走到哪一步分开，「超时未扫码」对已经扫过的人是误导
    const waited = formatDuration(timeoutSec * 1000)
    let message = `${waited} 内未完成扫码，本次登录已结束`
    if (s.status === "verify")
      message = `抖音要求补充验证（身份验证 / 短信验证码 / 滑块等），网页端已挡在验证页，${waited} 内未通过。请改用「#抖音文件登录 账号名」导入 Cookie，或把 spark.headless 改成 false 自己过一次验证`
    else if (s.status === "confirmed")
      message = `已在手机上确认，但 ${waited} 内没能取到登录凭证——多半是抖音追加了身份验证。请改用「#抖音文件登录 账号名」导入 Cookie`
    else if (s.status === "scanned")
      message = `已扫码但 ${waited} 内没等到确认结果，请重新登录`
    // 卡住的现场留一张图，比只看一句超时有用得多
    const shot = await diagnose(s)
    setStatus("expired", shot ? `${message}\n现场截图：${shot}` : message)
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
  /*
   * 登录页一律不挂请求拦截，跟续火那边刻意不同。
   *
   * 不拦图片字体是老理由：二维码弹窗的可见性判定依赖真实布局，缺图缺字体时元素
   * 容易塌成 0×0，被 waitForFunction 的 offsetParent 判死。
   *
   * 埋点也不拦。实测抓过一遍登录页的请求，被 BLOCKED_URL_PARTS 命中的只有
   * slardar / mcs.zijieapi / mon.zijieapi / monitor_browser / webcast 这几类纯上报，
   * passport 链路（challenge → get_qrcode → check_qrconnect）一个都不在里面——
   * 也就是说拦截并不是登录卡死的原因。但登录一辈子只跑几次，省这几十个请求毫无收益，
   * 而这份清单以后只要多加一条命中 passport 的规则，整条登录链就会静默挂掉。
   * 收益为零、风险为整条链路，所以这里直接关掉。
   */
  const { context, page } = await browserManager.openPage([], { intercept: false })
  s.context = context
  s.page = page

  /**
   * 把二维码交给调用方。
   *
   * 抖音的二维码每 60 秒左右就会过期，页面自己会请求一张新的（实测 79s、142s 各刷新一次）。
   * QQ 里那张图不会自己变，所以每换一张都要重新发一次，否则用户扫的是早就作废的码
   * ——手机上提示扫码成功，插件这边 check_qrconnect 却始终是 new，看起来就是「毫无反应」。
   */
  let lastQr = ""
  const emitQr = base64 => {
    if (!base64 || base64 === lastQr) return
    lastQr = base64
    s.qrcode = base64
    s.qrRound += 1
    setStatus("waiting", s.qrRound > 1 ? "二维码已刷新，请重新扫码" : "二维码已生成，请用抖音 App 扫码")
    try {
      onQrcode?.(base64, s.qrRound)
    } catch {}
  }

  const seenStatus = new Set()

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
        const raw = String(data.status ?? "")
        // 每种 status 只记一次，够留证但不刷日志
        if (raw && !seenStatus.has(raw)) {
          seenStatus.add(raw)
          if (!KNOWN_STATUS.has(raw))
            log("warn", `扫码登录 ${s.id}：check_qrconnect 返回未见过的 status「${raw}」${data.description ? `（${data.description}）` : ""}`)
        }

        // 手机点了确认 —— 但此刻 Cookie 还没落盘。抖音只是把 redirect_url 交给页面，
        // sessionid 要等页面跳完那一趟才写进 cookie jar，直接去读会读到空的。
        // 所以这里只切状态并记时刻，交给主循环在 CONFIRM_GRACE_MS 内轮询 Cookie。
        if (raw === "confirmed" || raw === "logged_in" || data.redirect_url) {
          if (s.status !== "confirmed" && s.status !== "success") {
            s.confirmedAt = Date.now()
            setStatus("confirmed", "已确认登录，正在获取凭证…")
          }
        } else if (VERIFY_STATUS.has(raw)) {
          markVerify(s, setStatus, data.description || "短信验证码 / 滑块")
        } else if (raw === "scanned" && !POST_SCAN.includes(s.status)) {
          setStatus("scanned", "已扫码，请在手机上确认登录")
        } else if (raw === "expired" && !POST_SCAN.includes(s.status)) {
          // 只是这一张码过期，页面马上会拉新的。会话不结束，等 emitQr 把新码发出去
          setStatus("waiting", "二维码已过期，正在获取新的…")
        }
      }
    } catch {
      // 抖音偶尔返回非 JSON（风控页），忽略即可，等超时或 DOM 兜底
    }
  })

  await page.goto(LOGIN_URL, { waitUntil: "domcontentloaded", timeout: 30000 })

  // 未登录访问首页时，抖音自己会弹出扫码登录面板，不需要去点「登录」按钮。
  // 面板出不来才退回主动点击（老版本页面 / 弹窗被 A/B 实验关掉的情况）。
  if (!(await waitLoginPanel(page, 12000))) {
    await openLoginModal(page)
    if (!(await waitLoginPanel(page, 15000)))
      throw new Error("未出现登录面板，抖音可能触发了风控，请稍后重试或改用手动登录")
  }

  /** 页面上当前那张二维码图。接口拦不到时靠它兜底，也靠它发现二维码被刷新了 */
  const findQr = () =>
    page
      .evaluate(() => {
        const img = [...document.querySelectorAll("img")].find(
          el => el.src?.startsWith("data:image/png;base64,") && el.clientWidth >= 100 && el.clientWidth <= 320
        )
        return img ? img.src : ""
      })
      .catch(() => "")

  // 首张二维码：面板弹出后还要异步请求，实测从 DOM 就绪到出码约 20 秒，上限给 45 秒，
  // 但不越过会话自身的过期时间，否则页面已被 cleanup 关掉还在这儿干等。
  const qrDeadline = Math.min(Date.now() + 45000, s.expireAt)
  while (!s.qrRound && Date.now() < qrDeadline) {
    if (isDone(s) || !s.page || s.page.isClosed()) break
    emitQr(await findQr())
    if (s.qrRound) break
    await sleep(500)
  }
  if (!s.qrRound) throw new Error("未能获取二维码，请稍后重试或改用手动登录")

  /*
   * 主循环，跑到会话超时或拿到 Cookie 为止，每 2 秒干四件事：
   *
   * 1. 查 sessionid —— 最终判据。check_qrconnect 的回调可能被风控页吞掉，
   *    但只要登录真的成功了，Cookie 一定会落进这个 browserContext。
   * 2. 已确认但迟迟没 Cookie 的，过了 CONFIRM_GRACE_MS 就不再干等 —— 那通常是
   *    抖音在扫码后追加了一道验证（短信验证码 / 滑块），网页端卡在验证页上，
   *    再等下去只会等到会话超时。这里直接判失败并说清楚下一步怎么做。
   * 3. 盯页面上有没有出现验证界面，出现了立刻告诉用户，而不是让他对着「已收到扫码」干等。
   * 4. 盯二维码有没有换，换了就把新码补发给用户。
   */
  while (!isDone(s)) {
    await sleep(2000)
    if (Date.now() > s.expireAt) break
    if (!s.page || s.page.isClosed()) break

    if (await hasLoginCookie(s.context)) {
      await handleSuccess(s, setStatus)
      break
    }

    // 扫码后抖音可能弹短信验证 / 滑块，页面上有明确文字，能认出来就不要让用户瞎等
    if (POST_SCAN.includes(s.status) && s.status !== "verify") {
      const hint = await detectVerify(s.page)
      if (hint) {
        markVerify(s, setStatus, hint)
        continue
      }
    }

    // 已确认却拿不到凭证，超过宽限期就收尾，别把 3 分钟全耗在这儿
    if (s.status === "confirmed" && s.confirmedAt && Date.now() - s.confirmedAt > CONFIRM_GRACE_MS) {
      const shot = await diagnose(s)
      const title = await s.page.title().catch(() => "")
      log("warn", `扫码登录 ${s.id}：已确认但 ${formatDuration(CONFIRM_GRACE_MS)} 内没拿到 sessionid，页面标题「${title}」`)
      setStatus(
        "failed",
        "已在手机上确认，但网页端始终没拿到登录凭证。常见原因是抖音追加了身份验证（短信验证码 / 滑块），" +
          "网页端无法代你完成。请改用「#抖音文件登录 账号名」导入 Cookie，" +
          "或把 spark.headless 改成 false 让浏览器显形、自己过一次验证。" +
          (shot ? `\n现场截图：${shot}` : "")
      )
      await cleanup(s)
      break
    }

    // 已扫码待确认时页面不会换码，此时刷 DOM 只是白费一次 evaluate
    if (!POST_SCAN.includes(s.status)) emitQr(await findQr())
  }
}

/**
 * 标成「需要人工验证」。
 *
 * 接口 status 和页面文字两条路都可能先发现它，所以抽出来共用，避免重复切状态。
 * 这一档不算失败——验证过了 Cookie 照样会落进 cookie jar，主循环还在查，
 * 只是先把话说清楚，别让用户对着「已收到扫码」干等到超时。
 */
function markVerify(s, setStatus, hint) {
  if (s.status === "verify" || s.status === "success") return
  s.verifyAt = Date.now()
  setStatus(
    "verify",
    `抖音要求补充验证（${hint}）。无头浏览器里没人能替你点，插件代不了，两条路选一条：\n` +
      "① 「#抖音文件登录 账号名」——在你自己的浏览器里登录，验证一次就过，把 document.cookie 存成 txt 发过来（推荐）\n" +
      "② 把 spark.headless 改成 false 再扫一次，浏览器窗口会显形，你自己在里面过这道验证"
  )
}

/**
 * 认一下页面上有没有在要额外验证。
 *
 * 抖音在异地登录、账号有风险标记时会在扫码确认后再插一道：短信验证码、滑块、
 * 或者「点击验证」。这些都得在那个浏览器里由人操作，插件代不了，但至少要认出来
 * 并如实告诉用户——否则界面上停在「已收到扫码」，看起来像插件死了。
 *
 * 规则里第一条是实测撞上的那一版：diagnose() 留下的截图里是一个「身份验证」弹窗，
 * 副标题「为保障账号安全，请先完成身份验证，以确保为本人操作」，二维码已被它整块盖掉。
 *
 * 两道前提，缺一不可，都是为了不误报：
 *
 * 1. **二维码必须已经从页面上消失**。抖音的登录面板自带「验证码登录 / 密码登录」
 *    两个 tab，面板上就明摆着「获取验证码」四个字——实测按纯文本匹配，二维码正常
 *    显示的页面也会被判成「要短信验证」。真的弹验证时二维码会被替换掉，所以
 *    「码不在了」是比任何文案都可靠的前置信号。
 * 2. **文案要用只可能出现在验证环节的说法**，像「获取验证码」这种同时属于登录 tab
 *    的词一律不用。判据放在文本而不是 class 名：抖音的 class 是混淆出来的，
 *    每次发版都变，这几句提示文案却多年没动。
 */
async function detectVerify(page) {
  if (!page || page.isClosed()) return ""
  return page
    .evaluate(() => {
      // 二维码还在，就还在等扫码这一步，不可能是验证界面
      const qrVisible = [...document.querySelectorAll("img")].some(
        el => el.src?.startsWith("data:image/png;base64,") && el.clientWidth >= 100 && el.clientWidth <= 320
      )
      if (qrVisible) return ""

      const text = document.body?.innerText || ""
      const rules = [
        // 实测拿到的那一版长这样：标题「身份验证」，副标题「为保障账号安全，请先完成身份验证，
        // 以确保为本人操作」，下面两个选项「接收短信验证码」「发送短信验证」。三句主文案都收进来，
        // 抖音以后砍掉选项那一行也还能认出。放在短信规则之前，是为了让提示语说「身份验证」
        // ——它比「短信验证码」更贴合用户在屏幕上看到的东西
        [/身份验证|以确保为本人操作/, "身份验证"],
        [/验证码已发送|已发送验证码|请输入(短信|收到的|\d+位)?验证码|短信验证/, "短信验证码"],
        [/拖动滑块|按住左边滑块|向右滑动|完成拼图|依次点击/, "滑块验证"],
        [/请完成验证|人机验证|验证中间页|安全验证/, "安全验证"],
        [/绑定手机号|请先绑定手机/, "绑定手机号"],
      ]
      for (const [re, label] of rules) if (re.test(text)) return label
      return ""
    })
    .catch(() => "")
}

/**
 * 卡住时留一张现场截图。
 *
 * 扫码登录的失败几乎都发生在无头浏览器里，用户只看到一句「超时」。
 * 一张整页截图能立刻分清是验证页、风控页还是二维码根本没渲染出来。
 * 复用续火那套 data/screenshots 目录，不新开位置。
 */
async function diagnose(s) {
  if (!s.page || s.page.isClosed?.()) return ""
  if (!config.bool("spark.screenshotOnFail", true)) return ""
  try {
    const file = path.join(shotDir(), `qrlogin-${safeFileName(s.accountName || s.id)}-${Date.now()}.png`)
    await s.page.screenshot({ path: file, fullPage: true })
    return file
  } catch (error) {
    log("warn", "保存扫码登录截图失败：", error.message)
    return ""
  }
}

/** 会话是否已经走到终态。单张二维码过期不算，那时状态会被放回 waiting */
function isDone(s) {
  return ["success", "failed", "canceled"].includes(s.status)
}

/**
 * 等登录面板出现。
 *
 * 判据有两条，命中任一即可：二维码 img 已经渲染出来，或者页面上出现了
 * 「扫码登录 / 验证码登录 / 密码登录」这组标签页文字。后者比前者早十几秒，
 * 用它可以在面板已经弹出、二维码还在路上时就不必再去点「登录」。
 */
async function waitLoginPanel(page, timeout) {
  return page
    .waitForFunction(
      () => {
        const img = [...document.querySelectorAll("img")].some(
          el => el.src?.startsWith("data:image/png;base64,") && el.clientWidth >= 100 && el.clientWidth <= 320
        )
        if (img) return true
        return /扫码登录|验证码登录|密码登录/.test(document.body?.innerText || "")
      },
      { timeout, polling: 500 }
    )
    .then(() => true)
    .catch(() => false)
}

/**
 * 主动点开登录弹窗，只在抖音没有自动弹面板时才用得上。
 *
 * 首页的登录入口是一个纯文本叶子节点（如 <p class="VQdYTqcZ">登录</p>），
 * 真正可点的是它的某个祖先，所以从叶子往上连点几层。文本判定放宽到「包含
 * 『登录』且不超过 6 个字」，避免抖音把按钮文案改成「登录抖音」就失配。
 */
async function openLoginModal(page) {
  return page
    .waitForFunction(
      () => {
        const leaf = [...document.querySelectorAll("p, span, div, button, a")].find(el => {
          const text = el.textContent?.trim() || ""
          return (
            text.length <= 6 &&
            text.includes("登录") &&
            !text.includes("未登录") &&
            el.children.length === 0 &&
            el.offsetParent !== null
          )
        })
        if (!leaf) return false
        let node = leaf
        for (let i = 0; i < 5 && node; i++) {
          node.click()
          node = node.parentElement
        }
        return true
      },
      { timeout: 15000, polling: 500 }
    )
    .then(h => h.jsonValue())
    .catch(() => false)
}

async function hasLoginCookie(context) {
  if (!context) return false
  try {
    const cookies = await getContextCookies(context)
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
