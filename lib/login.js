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
import { issueTicket, closeBySession } from "./remote.js"
import { clickByText, clickHandle, typeText, pressKey } from "./interact.js"
import { debug, debugOn, describeLine, snapshot } from "./debug.js"

const LOGIN_URL = "https://www.douyin.com/"

/*
 * 只匹配接口名，不带主机名也不带路径前缀。
 *
 * 原来写的是 `login.douyin.com/passport/web/get_qrcode` / `...check_qrconnect`。这次的现场
 * 说明那个前缀至少已经不总是成立了：用户扫码并确认之后页面上明明弹出了「身份验证」，
 * 插件却一路停在 waiting、最后报「3 分 0 秒内未完成扫码」——正是 check_qrconnect 一条
 * 都没拦到的样子（二维码还能靠 findQr 从 DOM 里捞，所以扫码这一步看不出异常）。
 *
 * 抖音这套接口在 login / sso 子域和 /passport/web 前缀之间搬过家，接口名本身多年没变。
 * 所以判据只留接口名，并在下面把所有拦到的候选 URL 记一条日志，下次好对。
 */
const QRCODE_API = "get_qrcode"
const CHECK_API = "check_qrconnect"

/**
 * 手机点了「确认登录」之后，最多再等这么久让 sessionid 落进 cookie jar。
 *
 * 抖音的 confirmed 只是把 redirect_url 交给页面，真正写 Cookie 是页面随后那次跳转，
 * 实测 1~3 秒。给到 25 秒是留给慢网络和 sso 多跳一次的余量；超过这个数还没有
 * sessionid，基本就是被追加了一道验证（短信 / 滑块），继续等只会等到会话超时。
 */
const CONFIRM_GRACE_MS = 25000

/**
 * 等第一张二维码最多等这么久。
 *
 * 原来是 45 秒，实测被这条现场打穿：登录面板 13:53:13 就出来了，但 passport 那条链
 * （ttwid/check → login_guiding_strategy → get_client_cert → challenge → get_qrcode）
 * 一路走到 challenge 用了 46 秒，插件在 45 秒判死，等于在二维码到手前一两秒自己把页面关了。
 *
 * 慢的原因不在抖音而在这个页面：未登录访问首页会落到 /jingxuan，HTML 1.6MB、60 张图、
 * 推荐流视频还在后台加载，而登录页刻意不挂请求拦截（见 runQrLogin 的注释），
 * 渲染进程主线程被塞满，passport 的 JS 只能排队——同一段时间里我们自己的
 * findQr() 一次 evaluate 也要 5 秒，正常是毫秒级。
 *
 * 所以这里给足 90 秒，并在真正拿到码时重新计时（见 emitQr）：出码慢不该吃掉用户的扫码时间。
 */
const QR_WAIT_MS = 90000

/**
 * check_qrconnect 的 status 里我们认识的那些。
 *
 * 只用来判断「要不要把这个值记进日志」。上一版的坑正是出在这儿：抖音返回了一个
 * 既不是 confirmed 也不是 scanned/expired 的值，三个 else if 全落空，状态一直停在
 * scanned，最后被超时兜底报成「没等到确认结果」——而日志里一个字都没留，只能靠猜。
 * 现在遇到没见过的值会 warn 一条带原值，下次同样的卡死能直接定位。
 */
const KNOWN_STATUS = new Set(["new", "scanned", "scanning", "expired", "confirmed", "logged_in", "canceled"])

/** 明确需要人在浏览器里操作才能过的 status */
const VERIFY_STATUS = new Set(["2fa", "verify", "risk", "need_verify", "sms_verify"])

/** 现场截图落这里，与续火失败截图同一个目录 */
const shotDir = () => ensureDir(dataDir, "screenshots")

/**
 * 扫码之后的几个状态。这几个状态下页面不会再换二维码，也就不用再去 DOM 里捞图。
 *
 * `sms` 也在里面：自动短信那条路已经把页面切到验证界面了，此时 emitQr 若还去捞图，
 * 捞到的是残留在 DOM 里的旧二维码，会把状态一路打回 waiting。
 */
const POST_SCAN = ["scanned", "confirmed", "verify", "sms"]

/** 进行中的扫码会话：sessionId -> state */
const sessions = new Map()

/**
 * 状态机：pending(出码中) -> waiting(等扫) -> scanned(已扫待确认) -> confirmed(已确认待写凭证)
 *          -> success / expired / failed / canceled
 *
 * 中途还可能岔进两档「要人配合」的状态，它们都不算失败，凭证照旧会落进 cookie jar：
 * - verify —— 抖音要人在浏览器里操作（滑块、没见过的验证），已把远程操作链接私信出去
 * - sms —— 自动短信模式下插件已经替你点完「发送验证码」，正在等你把验证码发回来
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

/**
 * 拿到会话内部对象（含 page）。只给 lib/web.js 的远程验证路由用。
 *
 * 与 getSession 分开是刻意的：getSession 返回的是可以安全 JSON 化发给前端的快照，
 * 而这个返回活的 puppeteer Page —— 谁拿到它就能操作那个浏览器，绝不能进任何响应体。
 * 所以名字写长、注释写死，避免以后有人顺手拿它去填接口返回。
 */
export function getLiveSession(sessionId) {
  return sessions.get(String(sessionId)) || null
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

/**
 * 取消某个用户名下所有还在进行的登录会话，「#抖音web下线」用。
 *
 * 为什么必须有这个：下线以前只清票据（链接打不开了），但那个登录会话还活着 ——
 * 浏览器页面还开着占内存，超时兜底也还挂着，于是十分钟后照旧弹一句
 * 「❌ 抖音要求的验证在 10 分 0 秒内没有完成」。而用户早就主动下线了，那条提示既
 * 没用又让人以为下线没成功。
 *
 * 走 canceled 这条终态是关键：`cleanup` 会 clearTimeout 把超时兜底摘掉，而
 * 超时兜底和失败兜底都会先看状态（`["success","failed","canceled"].includes`），
 * 所以即使有一路已经在半途，也不会再往外推任何消息。
 *
 * @returns {Promise<number>} 真的被取消掉的会话数，调用方拿它拼回复
 */
export async function cancelUserSessions(userId) {
  const id = String(userId)
  const live = [...sessions.values()].filter(s => s.userId === id && !isDone(s) && s.status !== "expired")
  for (const s of live) {
    log("info", `扫码登录 ${s.id}：发起人主动下线，会话已终止`)
    await cancelSession(s.id)
  }
  return live.length
}

async function cleanup(s) {
  clearTimeout(s.timer)
  // 页面一关，远程验证票据就没有操作目标了。但不立刻撕票：人可能正盯着那个页面，
  // 留一小段窗口让它把「Cookie 已保存」读到手，详见 lib/remote.js 的 closeBySession
  closeBySession(s.id)
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
 * @param {object} opts
 *  - accountName 账号名，留空则登录成功后读抖音昵称
 *  - userId 发起人 QQ。抖音弹验证时远程操作链接只私信发给他，也用于审计
 *  - autoSms 抖音弹「身份验证」时自己去点「接收短信验证码 → 发送验证码」，
 *    把验证码要到发起人手上（`#抖音自动登录` 传 true；`#抖音登录` 跟 security.autoSms）
 *  - onQrcode(base64, round) 出码 / 换码
 *  - onStatus(status, message) 状态变化
 *  - onSmsRequest({ sessionId, hint, phone, ttl }) 短信已经下发，去跟发起人要验证码。
 *    拿到之后调 submitSmsCode(sessionId, code) 填回页面
 *  - onVerify({ url, token, ttl, hint, shot }) 抖音要求人工验证，把远程操作链接交给
 *    调用方去私信。链接落在公网可达地址上，绝不能进群——发不出去就用 token 撕票
 */
export async function startQrLogin(
  botId,
  { accountName = "", userId = "", autoSms, onQrcode, onStatus, onSmsRequest, onVerify } = {}
) {
  const timeoutSec = config.num("security.qrLoginTimeout", 180, { min: 60, max: 900 })
  const s = {
    id: randomToken(8),
    botId: String(botId),
    userId: String(userId || ""),
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
    /** 是否自己接管短信验证。指令没显式指定时跟配置 */
    autoSms: autoSms === undefined ? config.bool("security.autoSms", false) : !!autoSms,
    /** 已经跟用户要过验证码，避免重复要 */
    smsAsked: false,
    /** markVerify 是否已经在跑（它现在要 await 页面操作，不能被重复进入） */
    verifying: false,
    accountId: "",
    createdAt: Date.now(),
    expireAt: Date.now() + timeoutSec * 1000,
    context: null,
    page: null,
    timer: null,
    onStatus,
    onSmsRequest,
    onVerify,
  }
  sessions.set(s.id, s)

  const tag = `扫码登录 ${s.id}`
  debug(tag, `会话开始：botId=${s.botId} 账号名=${s.accountName || "(登录后读昵称)"} 超时=${timeoutSec}s 自动短信=${s.autoSms ? "开" : "关"} 远程验证=${config.bool("security.remoteVerify", true) ? "开" : "关"} 无头=${config.bool("spark.headless", true) ? "开" : "关"}`)

  const setStatus = (status, message) => {
    const from = s.status
    s.status = status
    s.message = message
    log("info", `扫码登录 ${s.id}：${status} ${message}`)
    debug(tag, `状态 ${from} -> ${status}`)
    try {
      onStatus?.(status, message)
    } catch {}
  }
  // submitSmsCode 是从指令层直接调进来的（用户把验证码发回来那一刻），
  // 它要能走 handleSuccess，所以把 setStatus 挂在会话上
  s.setStatus = setStatus

  armTimer(s, setStatus, timeoutSec * 1000)

  // 后台跑，不阻塞指令回复
  runQrLogin(s, setStatus, onQrcode).catch(async error => {
    const err = toError(error)
    /*
     * 抛错这条路以前不留任何现场：既没有截图也没有页面信息，用户只拿到一句
     * 「未出现登录面板，抖音可能触发了风控」，而这句话既可能是真风控、也可能是
     * 抖音改了面板结构、也可能是页面压根就是验证码中间页。所以失败一律先看一眼
     * 页面，把 title/url/文本片段写进日志，并把截图路径附到用户看到的消息里。
     */
    debug(tag, `失败：${err.message}`)
    if (s.page && !s.page.isClosed?.()) {
      log("warn", `扫码登录 ${s.id}：失败现场 ${await describeLine(s.page)}`)
      await snapshot(s.page, `login-fail-${s.id}`)
    }
    const shot = await diagnose(s)
    if (!["success", "canceled", "expired"].includes(s.status))
      setStatus("failed", shot ? `${err.message}\n现场截图：${shot}` : err.message)
    await cleanup(s)
  })

  return s.id
}

/**
 * 装（或重装）会话超时兜底。
 *
 * 抽成函数是因为进 verify 状态时要把期限整体往后推：扫码本身给 3 分钟够了，
 * 但人要收短信、点开链接、在远程页面上操作，3 分钟远远不够。重装而不是另起一个
 * 定时器，是为了保证任何时刻只有一个兜底在跑，不会两个先后都触发一次。
 */
function armTimer(s, setStatus, ms) {
  clearTimeout(s.timer)
  s.expireAt = Date.now() + ms
  debug(`扫码登录 ${s.id}`, `超时兜底已装：${formatDuration(ms)} 后到点`)
  s.timer = setTimeout(async () => {
    if (["success", "failed", "canceled"].includes(s.status)) return
    debug(`扫码登录 ${s.id}`, `超时兜底触发，当前状态=${s.status}`)

    /*
     * 判死之前再看一眼页面。
     *
     * 这是最后一道网：主循环每 2 秒认一次验证界面，但认不出来的形态（抖音改版、
     * 没见过的验证）会一路走到这里被报成「超时未完成扫码」——而人明明扫了、屏幕上
     * 明明卡着一个弹窗。既然结论都是「要人去点」，那就把页面交给人，而不是判死。
     * 只做一次：markVerify 会把状态切成 verify，下一轮超时不会再进这个分支。
     */
    if (
      !["verify", "sms"].includes(s.status) &&
      (config.bool("security.remoteVerify", true) || s.autoSms) &&
      s.page &&
      !s.page.isClosed()
    ) {
      // 最后一搏，弱规则也开：都要判死了，宁可多发一条链接让人自己看一眼
      const hint =
        (await detectVerify(s.page, { weak: true })) ||
        (["scanned", "confirmed"].includes(s.status) ? "未能识别的验证页，请打开链接自行查看" : "")
      if (hint) {
        log("warn", `扫码登录 ${s.id}：超时兜底时发现页面仍需人工验证（${hint}），改为把验证交给人`)
        return markVerify(s, setStatus, hint)
      }
    }

    // 超时文案按用户实际走到哪一步分开，「超时未扫码」对已经扫过的人是误导
    const waited = formatDuration(ms)
    let message = `${waited} 内未完成扫码，本次登录已结束`
    if (s.status === "sms")
      message = `${waited} 内没收到你发回来的验证码，本次登录已结束。重新发送「#抖音自动登录」可再试一次`
    else if (s.status === "verify")
      message = `抖音要求的验证在 ${waited} 内没有完成，本次登录已结束。重新发送「#抖音登录」可再试一次，也可以改用「#抖音文件登录 账号名」导入 Cookie`
    else if (s.status === "confirmed")
      message = `已在手机上确认，但 ${waited} 内没能取到登录凭证——多半是抖音追加了身份验证。请改用「#抖音文件登录 账号名」导入 Cookie`
    else if (s.status === "scanned")
      message = `已扫码但 ${waited} 内没等到确认结果，请重新登录`
    // 卡住的现场留一张图，比只看一句超时有用得多
    if (s.page && !s.page.isClosed?.())
      log("warn", `扫码登录 ${s.id}：判死时的页面现状 ${await describeLine(s.page)}`)
    await snapshot(s.page, `07-expired-${s.id}`)
    const shot = await diagnose(s)
    setStatus("expired", shot ? `${message}\n现场截图：${shot}` : message)
    await cleanup(s)
  }, ms)
  s.timer.unref?.()
}

async function runQrLogin(s, setStatus, onQrcode) {
  const tag = `扫码登录 ${s.id}`
  /*
   * 登录页不拦图片字体，但**要拦推荐流与埋点**。
   *
   * 不拦图片字体是老理由：二维码弹窗的可见性判定依赖真实布局，缺图缺字体时元素
   * 容易塌成 0×0，被 waitForFunction 的 offsetParent 判死。
   *
   * 拦推荐流是这次的现场逼出来的。之前这里是 `intercept: false` 全关，理由写的是
   * 「命中的都是纯上报，passport 链一个都不在里面，省这几十个请求收益为零」——
   * 收益不为零，是负的：未登录访问首页会被抖音带到 /jingxuan，HTML 1.6MB、60 张图、
   * 推荐流视频还在后台解码，渲染进程主线程被塞满。实测那一轮 passport 链
   * （ttwid/check → login_guiding_strategy → get_client_cert → challenge → get_qrcode）
   * 排队排了 46 秒才走到 challenge，而我们自己的 findQr() 一次 evaluate 也要 5 秒
   * （正常毫秒级）——二维码不是没来，是被我们提前 1 秒判死了。
   *
   * 那份 BLOCKED_URL_PARTS 里三条 feed 接口正是 /jingxuan 的数据源，拦掉它页面就没有
   * 视频卡片可渲染，登录弹窗自己的布局一点不受影响。至于「以后清单里多一条命中 passport
   * 的规则就会静默挂掉整条登录链」这个担心，改成在 attachInterception 里写死 passport
   * 白名单来兜（见 lib/browser.js），比整片关掉拦截更准。
   */
  const { context, page } = await browserManager.openPage([], {
    // 只拦视频流：图片和字体要留着撑登录弹窗的布局（可见性判定看真实尺寸）
    blockTypes: ["media"],
    blockTracking: true,
  })
  s.context = context
  s.page = page
  debug(tag, "页面已建（只拦推荐流与埋点，不拦图片字体），UA=", () => browserManager.currentUA())

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
    // 已经扫过码 / 进了验证态就不要再往回切。抖音在后台仍会按 60 秒的节奏刷新二维码，
    // 而这个回调是接口拦截触发的，不受主循环那句 POST_SCAN 判断保护：真让它把状态
    // 打回 waiting，下一轮就会再签一张票据、把已经私信出去的那条验证链接作废
    if (POST_SCAN.includes(s.status)) return
    const first = !s.qrRound
    lastQr = base64
    s.qrcode = base64
    s.qrRound += 1
    setStatus("waiting", s.qrRound > 1 ? "二维码已刷新，请重新扫码" : "二维码已生成，请用抖音 App 扫码")
    /*
     * 拿到第一张码时把超时重新计时。
     *
     * qrLoginTimeout 是「给人扫码的时间」，可出码本身在慢机器上要花掉几十秒——
     * 那段等待原来是从同一个 3 分钟里扣的，现场里出码用了 46 秒，用户实际只剩 2 分出头。
     * 从码到手那一刻重新起算，配置里写的 180 秒才是用户真正拿到的 180 秒。
     */
    if (first) armTimer(s, setStatus, config.num("security.qrLoginTimeout", 180, { min: 60, max: 900 }) * 1000)
    try {
      onQrcode?.(base64, s.qrRound)
    } catch {}
  }

  const seenStatus = new Set()
  /**
   * 只为留证：登录链路上每个接口路径记一条日志（每种一次）。
   *
   * 这次的卡死就是因为判据里写死了主机名和 /passport/web 前缀，抖音一搬家就全落空，
   * 而日志里一个字都没有，只能靠猜。留下这一行，下次哪怕接口名也改了，
   * 也能直接对着日志看抖音实际请求了什么，而不是再猜一轮。
   */
  const seenApi = new Set()

  // 拦响应拿二维码与轮询状态：比截图更稳，也能读到 status 字段
  page.on("response", async response => {
    const url = response.url()
    try {
      /*
       * `data:` 开头的响应直接跳过留证这一段。
       *
       * 那个正则是不区分大小写的，而二维码本身就是一条 data URI —— base64 里随便一段
       * `sSO`、`Login` 都能命中，于是日志里被塞进整张图的 base64（现场里连着刷了两条
       * 上千字符的行）。二维码不是接口，也没有留证价值。
       *
       * 静态资源（passport-fe 下的 js / 图片 / lottie json）也不进普通日志：它们能命中
       * `passport` 只是因为 CDN 路径里带这个词，对定位「哪个接口没回话」毫无帮助，
       * 却能把那几行真正的接口记录挤没。调试态下仍然全记。
       */
      if (!url.startsWith("data:") && /passport|sso|qrcode|qrconnect|login/i.test(url)) {
        const key = url.split("?")[0]
        const isAsset = /\.(js|css|png|jpe?g|webp|avif|svg|woff2?|json)$/i.test(key)
        if (!isAsset && !seenApi.has(key)) {
          seenApi.add(key)
          log("info", `扫码登录 ${s.id}：登录接口 ${key}`)
        }
        // 调试态下每一次都记，含状态码——「拦到了但返回 4xx」和「一次都没拦到」是两回事
        debug(tag, `接口 ${response.status()} ${key}`)
      }
      if (url.includes(QRCODE_API)) {
        const data = (await response.json())?.data
        debug(tag, `get_qrcode 返回：qrcode=${data?.qrcode ? "有" : "无"} error_code=${data?.error_code ?? "-"} ${data?.description || ""}`)
        if (data?.qrcode) emitQr(`data:image/png;base64,${data.qrcode}`)
        else if (data?.error_code) setStatus("failed", data.description || `获取二维码失败(${data.error_code})`)
      } else if (url.includes(CHECK_API)) {
        const data = (await response.json())?.data
        if (!data) return
        const raw = String(data.status ?? "")
        debug(tag, `check_qrconnect status=${raw || "(空)"}${data.redirect_url ? " 带 redirect_url" : ""}${data.description ? ` ${data.description}` : ""}`)
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
          // 这是 response 回调，没人接返回的 promise，抛出来会变成 unhandledRejection
          markVerify(s, setStatus, data.description || "短信验证码 / 滑块").catch(error =>
            log("warn", `扫码登录 ${s.id}：处理验证态失败 ${toError(error).message}`)
          )
        } else if ((raw === "scanned" || raw === "scanning") && !POST_SCAN.includes(s.status)) {
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

  const resp = await page.goto(LOGIN_URL, { waitUntil: "domcontentloaded", timeout: 30000 })
  debug(tag, `已打开 ${LOGIN_URL}：HTTP ${resp?.status?.() ?? "?"}`)
  // describePage 要跑一次 evaluate，不能塞进 debug 的惰性参数里（那个口子只接同步取值）
  if (debugOn()) debug(tag, `页面现状 ${await describeLine(page)}`)
  await snapshot(page, `01-loaded-${s.id}`)

  /*
   * 先等中间页过掉再谈登录面板。
   *
   * `domcontentloaded` 回来时抖音给的常常还不是首页，而是一个 2.5KB 的
   * 「Please wait...」壳子（现场里 title 空、img 0、正文就这三个词），它自己会再跳一次到
   * /jingxuan。直接开始等面板等于把这十几秒记在面板头上，第一轮 12 秒必然白等，
   * 然后走去点「登录」——现场就是这么走的。
   */
  const settled = await page
    .waitForFunction(
      () => {
        const text = (document.body?.innerText || "").trim()
        return text.length > 40 && !/^please wait/i.test(text)
      },
      { timeout: 20000, polling: 500 }
    )
    .then(() => true)
    .catch(() => false)
  debug(tag, `等中间页过掉：${settled ? "已进真实页面" : "20s 内没等到，继续往下走"}`)
  if (debugOn() && settled) debug(tag, `中间页之后 ${await describeLine(page)}`)

  /*
   * 未登录访问首页时，抖音自己会弹出扫码登录面板，不需要去点「登录」按钮。
   * 面板出不来才退回主动点击（老版本页面 / 弹窗被 A/B 实验关掉的情况）。
   *
   * 这条路径以前抛的是一句「未出现登录面板，抖音可能触发了风控」——而它至少对应
   * 四种完全不同的现场：真被风控挡住、页面是验证码中间页、抖音改了面板文案、
   * 或者页面根本没加载完。所以失败时把页面现状（title/url/html 大小/文本片段）
   * 一起塞进错误消息：用户把那句话贴过来就够定位，不必再开一轮 debug 复现。
   */
  let panelBy = await waitLoginPanel(page, 12000)
  debug(tag, `等登录面板（第 1 次，12s）：${panelBy || "未出现"}`)
  if (!panelBy) {
    log("warn", `扫码登录 ${s.id}：首页没自动弹登录面板，改为主动点击。${await describeLine(page)}`)
    await snapshot(page, `02-no-panel-${s.id}`)
    const clicked = await openLoginModal(page)
    debug(tag, `主动点「登录」：${clicked ? "已点到" : "没找到可点的入口"}`)
    panelBy = await waitLoginPanel(page, 15000)
    debug(tag, `等登录面板（第 2 次，15s）：${panelBy || "未出现"}`)
    if (!panelBy) {
      const info = await describeLine(page)
      log("warn", `扫码登录 ${s.id}：仍未出现登录面板。${info}`)
      await snapshot(page, `03-panel-failed-${s.id}`)
      throw new Error(
        `未出现登录面板（${clicked ? "点过登录入口" : "连登录入口都没找到"}）。页面现状：${info}\n` +
          "常见原因：抖音把页面换成了验证码中间页 / 风控页，或改了面板文案。" +
          "打开「调试日志」再试一次可以看到每一步做了什么，也可以直接改用「#抖音文件登录 账号名」导入 Cookie"
      )
    }
  }
  debug(tag, `登录面板已出现（判据：${panelBy}）`)
  await snapshot(page, `04-panel-${s.id}`)

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

  /*
   * 首张二维码。上限 QR_WAIT_MS，但不越过会话自身的过期时间，否则页面已被 cleanup
   * 关掉还在这儿干等。
   *
   * 每轮都记一次耗时而不是只记「有没有」：现场里一次 evaluate 花了 5 秒（正常毫秒级），
   * 那正是「页面在忙、passport 的 JS 在排队」的直接证据，比再猜一轮风控有用。
   */
  const qrDeadline = Math.min(Date.now() + QR_WAIT_MS, s.expireAt)
  let qrProbes = 0
  let slowProbe = 0
  while (!s.qrRound && Date.now() < qrDeadline) {
    if (isDone(s) || !s.page || s.page.isClosed()) break
    const probeAt = Date.now()
    const found = await findQr()
    const cost = Date.now() - probeAt
    slowProbe = Math.max(slowProbe, cost)
    qrProbes += 1
    // 每 5 秒（10 轮）记一条，出码要等二十来秒，每轮都记就成刷屏了
    if (qrProbes % 10 === 1 || cost > 1000)
      debug(tag, `第 ${qrProbes} 轮找二维码：${found ? "DOM 里有" : "还没有"}（本轮探测耗时 ${cost}ms${cost > 1000 ? "，页面很忙" : ""}）`)
    emitQr(found)
    if (s.qrRound) break
    await sleep(500)
  }
  if (!s.qrRound) {
    if (debugOn()) debug(tag, `${qrProbes} 轮都没找到二维码，页面现状 ${await describeLine(page)}`)
    await snapshot(page, `05-no-qr-${s.id}`)
    throw new Error(
      `${formatDuration(QR_WAIT_MS)}内没等到二维码（探了 ${qrProbes} 轮，最慢一轮 ${slowProbe}ms）。` +
        (slowProbe > 1000
          ? "单轮探测超过 1 秒说明浏览器主线程被页面占满了，多半是机器性能或带宽不够，重试一次通常就能出码；"
          : "") +
        "也可以改用「#抖音文件登录 账号名」导入 Cookie"
    )
  }
  debug(tag, `二维码已就绪（第 ${qrProbes} 轮探到，第 ${s.qrRound} 张，最慢一轮探测 ${slowProbe}ms）`)

  /** 上一轮认出的验证类型。要连续两轮认出同一种才当真，理由见循环里的注释 */
  let lastVerifyHint = ""
  /** 主循环跑了第几轮，只用于日志定位（每轮 2 秒，所以轮数也是粗略的秒表） */
  let round = 0

  /*
   * 主循环，跑到会话超时或拿到 Cookie 为止，每 2 秒干四件事：
   *
   * 1. 查 sessionid —— 最终判据。check_qrconnect 的回调可能被风控页吞掉，验证也可能是
   *    人在远程页面上点完的，插件都不会收到通知；但只要登录真的成功了，Cookie 一定会
   *    落进这个 browserContext。所以成功路径只有这一条，不用为远程验证另写一套。
   * 2. 盯页面上有没有出现验证界面，出现了就开一条远程操作通道把它交给人（markVerify）。
   *    这一步**不等 check_qrconnect 说话**：这次的现场就是那个接口一条都没拦到、状态从头
   *    到尾停在 waiting，而页面上验证弹窗早就弹出来了。把它挂在「已扫码之后」等于把整条
   *    远程验证的路押在那个接口能被拦到上面。页面是最终事实，直接看页面。
   * 3. 已确认但迟迟没 Cookie 的，过了 CONFIRM_GRACE_MS 也按「有没认出来的验证」处理，
   *    同样交给人看——比含糊地报一句超时有用得多。
   * 4. 盯二维码有没有换，换了就把新码补发给用户。
   */
  while (!isDone(s)) {
    await sleep(2000)
    round += 1
    /*
     * 超时判定归 armTimer 那个定时器，不归这里。它到点后会先看一眼页面，认出验证就改成
     * 发链接并把期限整体延后；这个循环必须让它先跑完，否则两边同时到点、循环先 break，
     * 延期之后就没人再查 Cookie 了——人在远程页面上把验证过掉也不会被发现。
     *
     * 留 30 秒余量纯粹是保险（定时器被谁清掉了之类），正常收尾靠 cleanup 关页面来断循环。
     */
    if (Date.now() > s.expireAt + 30000) {
      debug(tag, `第 ${round} 轮：已过会话期限 30 秒仍未收尾，主循环退出`)
      break
    }
    if (!s.page || s.page.isClosed()) {
      debug(tag, `第 ${round} 轮：页面已关闭，主循环退出`)
      break
    }

    if (await hasLoginCookie(s.context)) {
      debug(tag, `第 ${round} 轮：cookie jar 里出现 sessionid`)
      await handleSuccess(s, setStatus)
      break
    }

    /*
     * 认验证界面。判据只有页面本身，与 check_qrconnect 有没有回话无关。
     *
     * 弱规则只在已经扫过码之后才开：出码前那二十来秒登录面板已经渲染好、二维码还没
     * 出来，正好同时满足「页面上有『请输入验证码』」和「没有二维码」这两条，一开就误报。
     *
     * 另外要连续两轮认出同一种才算数：整页 innerText 里混着首页推荐流的视频标题，
     * 理论上有极小概率撞上某条规则；而验证弹窗一旦弹出就会一直在，撑得过第二轮，
     * 偶然撞词撑不过。代价只是最多晚 2 秒发链接。
     */
    if (!["verify", "sms"].includes(s.status)) {
      const hint = await detectVerify(s.page, { weak: POST_SCAN.includes(s.status) })
      // 每 10 轮（20 秒）报一次「还在等、当前状态是什么」，卡住时至少知道循环没死
      if (hint || round % 10 === 1)
        debug(tag, `第 ${round} 轮：状态=${s.status} 验证探测=${hint || "无"}${hint && hint === lastVerifyHint ? "（连续两轮，判定成立）" : ""}`)
      if (hint && hint === lastVerifyHint) {
        // 必须 await：自动短信那条路要在页面上点两下按钮，不等它跑完，下一轮
        // 循环又会读到同一个验证界面（此时 verifying 锁虽然挡住了重入，但白转一圈）
        await markVerify(s, setStatus, hint)
        continue
      }
      lastVerifyHint = hint
    }

    // 已确认却拿不到凭证，超过宽限期就别再干等。
    // 但也不直接判死：走到这一步几乎一定是抖音插了什么要人操作的东西，只是 detectVerify
    // 的文案规则没认出来（抖音改版、或者换了一种没见过的验证）。这种情况下正确的做法
    // 和认出来时完全一样——把页面交给人去看去点，而不是让用户对着一句「失败」干瞪眼。
    // 只有两条出路都被关掉时才回到「报失败 + 给替代方案」的老路。
    if (s.status === "confirmed" && s.confirmedAt && Date.now() - s.confirmedAt > CONFIRM_GRACE_MS) {
      log("warn", `扫码登录 ${s.id}：已确认但 ${formatDuration(CONFIRM_GRACE_MS)} 内没拿到 sessionid。${await describeLine(s.page)}`)
      await snapshot(s.page, `06-no-cookie-${s.id}`)
      if (config.bool("security.remoteVerify", true) || s.autoSms) {
        await markVerify(s, setStatus, "未能识别的验证页，请打开链接自行查看")
        continue
      }
      const shot = await diagnose(s)
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
 * 标成「需要人工验证」，并把这道验证想办法交出去。
 *
 * 接口 status 和页面文字两条路都可能先发现它，所以抽出来共用，避免重复切状态。
 * 这一档不算失败——验证过了 Cookie 照样会落进 cookie jar，主循环还在查，
 * 拿到就走 handleSuccess，成功路径一行都不用另写。
 *
 * 两条出路，优先走前者：
 *
 * - **自动接管短信**（s.autoSms，`#抖音自动登录`）：插件自己在页面上点
 *   「接收短信验证码」→「发送验证码」，然后只跟用户要那 6 位数字。用户不用点开
 *   任何链接，也就不存在把公网地址发出去这件事。只在抖音给的是短信验证时可行。
 * - **远程操作页面**（security.remoteVerify）：签一张一次性票据私信给发起人，
 *   人在浏览器里自己把验证过掉。滑块、拼图、没见过的验证都只能走这条。
 *
 * 三件事必须一起做，少一件这条路就是废的：
 *
 * 1. **把会话期限整体往后推**（security.verifyTimeout，默认 10 分钟）。扫码给 3 分钟够了，
 *    但人要等短信、点开链接、在页面上操作，3 分钟必然不够——上一版就是提示发出去了，
 *    人还在收短信，会话已经被超时兜底掐掉。
 * 2. **签一张一次性票据**，把链接交给调用方（指令层 / 面板）去私信。票据只能操作
 *    这一个页面，管不了插件的任何别的东西，详见 lib/remote.js。
 * 3. **把现场截图一起给出去**，用户点开链接之前就知道自己要过的是哪一道验证。
 */
async function markVerify(s, setStatus, hint) {
  if (["verify", "sms", "success"].includes(s.status)) return
  // 自动短信那条路要 await 好几次页面操作，期间主循环还在跑，不挡一下会被重复进入
  if (s.verifying) return
  s.verifying = true
  s.verifyAt = Date.now()
  debug(`扫码登录 ${s.id}`, `判定需要人工验证：${hint}`)

  const ttl = config.num("security.verifyTimeout", 600, { min: 120, max: 3600 })
  // 先延期再发通知：通知里要写「x 分钟内完成」，得和真实期限是同一个数
  armTimer(s, setStatus, ttl * 1000)

  try {
    // 自己能把短信发出去就不必再开远程页面。失败（不是短信验证 / 按钮点不到）
    // 会返回 false，落回下面的老路
    if (s.autoSms && (await tryAutoSms(s, setStatus, hint, ttl))) return
  } catch (error) {
    log("warn", `扫码登录 ${s.id}：自动接管短信验证失败（${toError(error).message}），改走远程验证页面`)
  } finally {
    s.verifying = false
  }

  let link = null
  if (config.bool("security.remoteVerify", true)) {
    try {
      const { token } = issueTicket({ sessionId: s.id, botId: s.botId, userId: s.userId })
      // token 放 hash：不进服务端 access log，也不会随 Referer 外泄
      // token 也一起交出去，调用方私信发不出去时要拿它把票撕掉
      link = { url: `${config.webOrigin()}${config.webBase()}/verify#t=${token}`, token, ttl }
    } catch (error) {
      log("warn", `签发远程验证链接失败：${toError(error).message}`)
    }
  }

  setStatus(
    "verify",
    link
      ? `抖音要求补充验证（${hint}）。已给你开了一个远程操作页面，${formatDuration(ttl * 1000)}内在里面把验证过掉，` +
          "Cookie 会自动保存。链接和用法私信发你了。"
      : `抖音要求补充验证（${hint}）。无头浏览器里没人能替你点，两条路选一条：\n` +
          "① 「#抖音文件登录 账号名」——在你自己的浏览器里登录，验证一次就过，把 document.cookie 存成 txt 发过来\n" +
          "② 把 spark.headless 改成 false 再扫一次，浏览器窗口会显形，你自己在里面过这道验证"
  )

  if (!link) return
  snapshot(s.page, `08-verify-${s.id}`).catch(() => {})
  // 截图给用户看清要过的是哪一道验证；失败也不影响链接本身可用
  diagnose(s)
    .then(shot => {
      try {
        s.onVerify?.({ ...link, hint, shot })
      } catch {}
    })
    .catch(() => {
      try {
        s.onVerify?.({ ...link, hint, shot: "" })
      } catch {}
    })
}

/* ---------- 自动接管短信验证（#抖音自动登录） ----------
 *
 * 远程验证页面那条路要把一个公网地址私信出去，用户还得在手机浏览器上点。而抖音在
 * 扫码后追加的验证里，最常见的那一种（「身份验证 → 接收短信验证码」）其实完全不需要
 * 人来点：按钮位置固定、文案多年没动、点完只是让抖音给绑定手机发一条短信。真正只有
 * 用户能提供的东西是那 6 位数字本身。
 *
 * 所以这条路把「点」全部交给插件，只跟用户要那串数字：
 *   markVerify → tryAutoSms（点两个按钮、确认短信下发、通知发起人）
 *   → 用户把验证码发回来 → submitSmsCode（填进页面、提交）
 *   → 主循环照旧靠 cookie jar 判成功（成功路径一行都没另写）
 *
 * 任何一步不成立就返回 false，落回远程验证页面 —— 滑块、拼图、要求绑定手机号，
 * 以及抖音改版后按钮找不到的情况，都只能由人来过。
 */

/**
 * 读一眼页面现在处在短信验证的哪一步。
 *
 * 判据全放文本：抖音的 class 是混淆出来的，每次发版都变。倒计时（`58s 后重新发送`）
 * 是「短信真的发出去了」最可靠的一条 —— 它只在服务端受理之后才出现。
 *
 * @returns {Promise<{text: string, entry: boolean, sendBtn: boolean, sent: boolean, fields: number, phone: string} | null>}
 */
async function readSmsState(page) {
  if (!page || page.isClosed()) return null
  return page
    .evaluate(() => {
      const text = (document.body?.innerText || "").replace(/\s+/g, " ").trim()
      // 可见、可编辑、且尺寸不至于是个隐藏占位的输入框
      const fields = [...document.querySelectorAll("input")].filter(el => {
        if (el.offsetParent === null || el.disabled || el.readOnly) return false
        if (["hidden", "checkbox", "radio", "submit", "button"].includes(el.type)) return false
        const r = el.getBoundingClientRect()
        return r.width >= 20 && r.height >= 10
      }).length
      // 抖音把手机号打成 `138****8888` 或 `1**   ****  88` 这类形态，两种都收
      const phone = (text.match(/\d{2,3}\*{2,}\d{2,4}/) || [])[0] || ""
      // 「短信真的发出去了」的判据。倒计时那条一定要带「后」：光是 `\d+s` 会被首页
      // 推荐流里的视频时长（"15s"）撞上，而这条判错的后果是跳过「发送验证码」不点，
      // 用户手上压根没有短信却被要求提供验证码。与 tryAutoSms 里那句 waitForFunction 同一套
      const sent = /验证码已发送|已发送验证码|重新发送|重新获取|\d+\s?s\s?后/.test(text)
      return {
        text: text.slice(0, 300),
        entry: /接收短信验证码|短信验证码登录|接收验证码|验证码登录/.test(text),
        sendBtn: /发送验证码|获取验证码|发送短信验证码/.test(text),
        sent,
        fields,
        phone,
      }
    })
    .catch(() => null)
}

/**
 * 自己把短信验证码发出去，然后只跟发起人要那串数字。
 *
 * 三步都必须留下痕迹（debug + snapshot）：这条路整个跑在无头浏览器里，出问题时
 * 用户能看到的只有一句「改走远程验证页面」，没有现场就只能靠猜。
 *
 * @param {number} ttl 会话延期后的剩余秒数，写进给用户的提示里（和真实期限同一个数）
 * @returns {Promise<boolean>} true=短信已下发、已跟用户要码；false=这条路走不通，落回远程验证
 */
async function tryAutoSms(s, setStatus, hint, ttl) {
  const tag = `扫码登录 ${s.id}`
  const page = s.page
  if (!page || page.isClosed()) return false
  // 已经跟用户要过码了就别再点一遍「发送验证码」——抖音那边有频率限制，
  // 多点一次可能把这个手机号锁一段时间
  if (s.smsAsked) return true

  // 这几种插件代不了，直接让给远程页面，省一次无用的页面操作
  if (/滑块|拼图|绑定手机号/.test(hint)) {
    debug(tag, `自动短信：「${hint}」不是短信验证，交给远程验证页面`)
    return false
  }

  let state = await readSmsState(page)
  if (!state) return false
  debug(
    tag,
    `自动短信：入口=${state.entry} 发送按钮=${state.sendBtn} 已发送=${state.sent} 输入框=${state.fields} 手机号=${state.phone || "未显示"}`
  )
  if (!state.entry && !state.sendBtn && !state.sent) {
    debug(tag, `自动短信：页面上没有短信验证的任何迹象，交给远程验证页面。页面文本：${state.text.slice(0, 100)}`)
    return false
  }
  await snapshot(page, `09-sms-0-enter-${s.id}`)

  // ① 「接收短信验证码」是那个弹窗上的一个选项，点它之后才会出现「发送验证码」
  if (state.entry && !state.sent && !state.sendBtn) {
    // 先按整句匹配（最精确），失配再放宽 —— 抖音那个选项有时带一行小字说明，
    // 整段 textContent 就不止这几个字了
    let r = await clickByText(page, /^(接收短信验证码|短信验证码登录|接收验证码)$/, { scope: "自动短信" })
    if (!r.ok) r = await clickByText(page, /接收短信验证码|短信验证码登录/, { scope: "自动短信" })
    if (!r.ok) {
      log("warn", `${tag}：自动短信点不到「接收短信验证码」（${r.reason}），改走远程验证页面`)
      await snapshot(page, `09-sms-x-noentry-${s.id}`)
      return false
    }
    await sleep(1200)
    state = (await readSmsState(page)) || state
  }

  // ② 点「发送验证码」。已经在倒计时说明上一轮点过了，不重复点
  if (!state.sent) {
    const send = await clickByText(page, /^(发送验证码|获取验证码|发送短信验证码|发送)$/, { scope: "自动短信" })
    if (!send.ok) {
      log("warn", `${tag}：自动短信点不到「发送验证码」（${send.reason}）。${await describeLine(page)}`)
      await snapshot(page, `09-sms-x-nosend-${s.id}`)
      return false
    }
  }

  /*
   * ③ 确认短信真的受理了，再去跟用户要码。
   *
   * 少了这一步最坏的情况是：按钮点空了（点在了旁边的容器上），插件却已经私信
   * 「请把验证码发给我」——用户手上压根没有短信，只能干等到超时，还以为是自己没收到。
   * 倒计时/「验证码已发送」这类字样只在服务端受理之后才出现，是这一步唯一可靠的读数。
   */
  const appeared = await page
    .waitForFunction(
      () => /验证码已发送|已发送验证码|重新发送|重新获取|\d+\s?s\s?后/.test(document.body?.innerText || ""),
      { timeout: 8000, polling: 500 }
    )
    .then(() => true)
    .catch(() => false)
  state = (await readSmsState(page)) || state
  if (!appeared && !state.sent) {
    log("warn", `${tag}：点完发送后页面没有任何「已发送」迹象，改走远程验证页面。${await describeLine(page)}`)
    await snapshot(page, `09-sms-x-nosign-${s.id}`)
    return false
  }
  await snapshot(page, `09-sms-1-sent-${s.id}`)

  s.smsAsked = true
  s.smsPhone = state.phone
  setStatus(
    "sms",
    `抖音要求短信验证（${hint}）。验证码已经发到${state.phone ? ` ${state.phone}` : "你绑定的手机"}，` +
      `请在 ${formatDuration(ttl * 1000)} 内把收到的验证码发给我，我替你填进去。`
  )
  try {
    s.onSmsRequest?.({ sessionId: s.id, hint, phone: state.phone, ttl })
  } catch (error) {
    log("warn", `${tag}：通知发起人提供验证码失败：${toError(error).message}`)
  }
  return true
}

/**
 * 把验证码输入框拿到焦点。
 *
 * 不用 clickByText：那套是按文本找元素，而输入框本身没有文本。这里自己按特征挑
 * （placeholder 里有「验证码」、maxlength 是 4~8、type 是 tel/number），再走
 * clickHandle 那条链路——点击的兜底逻辑（真鼠标进不了 DOM 就补合成事件）在那里，
 * 不能绕开自己写一个 `handle.click()`。
 *
 * 一个特征都对不上时只在「整页就这一个可编辑输入框」的情况下才点它：宁可放弃，
 * 也不要把验证码打进搜索框里。
 */
async function focusCodeField(page) {
  const attr = "data-dy-code"
  const found = await page
    .evaluate(sel => {
      document.querySelectorAll(`[${sel}]`).forEach(el => el.removeAttribute(sel))
      const list = [...document.querySelectorAll("input")].filter(el => {
        if (el.offsetParent === null || el.disabled || el.readOnly) return false
        if (["hidden", "checkbox", "radio", "submit", "button"].includes(el.type)) return false
        const r = el.getBoundingClientRect()
        return r.width >= 20 && r.height >= 10
      })
      const score = el => {
        const label = `${el.placeholder || ""} ${el.getAttribute("aria-label") || ""} ${el.name || ""} ${el.id || ""}`
        const max = Number(el.getAttribute("maxlength") || 0)
        let n = 0
        if (/验证码|code|captcha|verify/i.test(label)) n += 3
        if (max >= 4 && max <= 8) n += 2
        if (el.type === "tel" || el.type === "number") n += 1
        return n
      }
      const ranked = list.map(el => ({ el, n: score(el) })).sort((a, b) => b.n - a.n)
      const pick = ranked[0]?.n > 0 ? ranked[0].el : list.length === 1 ? list[0] : null
      if (!pick) return ""
      pick.setAttribute(sel, "1")
      return `${pick.placeholder || pick.name || pick.type || "input"}${
        pick.getAttribute("maxlength") ? `(maxlength=${pick.getAttribute("maxlength")})` : ""
      }`
    }, attr)
    .catch(() => "")
  if (!found) return ""
  const handle = await page.$(`[${attr}="1"]`)
  if (!handle) return ""
  try {
    const r = await clickHandle(page, handle, { scope: "自动短信" })
    return r.ok ? found : ""
  } finally {
    await handle.evaluate((el, sel) => el.removeAttribute(sel), attr).catch(() => {})
    await handle.dispose().catch(() => {})
  }
}

/**
 * 用户把验证码发回来了，填进页面并提交。指令层（`#抖音自动登录` 的上下文回调）直接调。
 *
 * 成功判据仍然只有 cookie jar 那一条（主循环每 2 秒查一次），这里只是额外自己多等
 * 十来秒，好让用户那条消息能直接带上结果 —— 否则得先回一句「已提交」，成功提示再
 * 由 onStatus 另发一条，看起来像出了两次错。
 *
 * 填错不结束会话：状态留在 sms，调用方据此让用户再发一次。
 *
 * @returns {Promise<{ok: boolean, message: string, retry?: boolean}>} retry=true 表示还能再收一次验证码
 */
export async function submitSmsCode(sessionId, code) {
  const s = getLiveSession(sessionId)
  if (!s) return { ok: false, message: "这次登录会话已经结束了，重新发送「#抖音自动登录」再试一次" }
  if (isDone(s)) return { ok: false, message: `本次登录已结束（${s.message || s.status}），请重新发起` }
  if (s.status !== "sms") return { ok: false, message: "当前没有在等验证码，无需发送" }
  const page = s.page
  if (!page || page.isClosed())
    return { ok: false, message: "登录页面已经关闭了，重新发送「#抖音自动登录」再试一次" }

  // 用户常连着中文一起发（「验证码是 123456」），只取数字
  const digits = String(code ?? "").replace(/\D/g, "")
  if (digits.length < 4 || digits.length > 8)
    return { ok: false, message: "没看懂这串验证码，把短信里的那几位数字直接发给我就行", retry: true }

  const tag = `扫码登录 ${s.id}`
  debug(tag, `收到验证码（${digits.length} 位，值不入日志），开始回填`)

  const field = await focusCodeField(page)
  if (!field) {
    log("warn", `${tag}：找不到验证码输入框。${await describeLine(page)}`)
    await snapshot(page, `09-sms-x-nofield-${s.id}`)
    return { ok: false, message: "页面上找不到验证码输入框，请改用「#抖音文件登录 账号名」导入 Cookie" }
  }
  debug(tag, `验证码输入框：${field}`)

  const typed = await typeText(page, digits, { scope: "自动短信" })
  debug(tag, `填入验证码：真键盘${typed.grew ? "生效" : "无效"}${typed.forced ? `，已补合成（${typed.forced}）` : ""}`)

  /*
   * 满位自动提交是抖音的常规行为，但不能指望它：改版、或者输入框是分格式的六个小框时
   * 就不会自动走。所以 Enter 和「登录」按钮各来一次。多提交一次抖音那边是幂等的，
   * 漏提交一次的代价是用户以为发了码却毫无反应，只能干等超时。
   */
  await sleep(800)
  await pressKey(page, "Enter", { scope: "自动短信" })
  const btn = await clickByText(page, /^(登录|确定|提交|验证|下一步)$/, { scope: "自动短信" })
  debug(tag, `提交：Enter 已按${btn.ok ? `，并点了「${btn.text}」` : `（没有可点的提交按钮：${btn.reason}）`}`)
  await snapshot(page, `09-sms-2-submit-${s.id}`)

  // 抖音那边校验 + 跳转写 Cookie 一般三五秒，这里最多等 12 秒
  for (let i = 0; i < 8; i++) {
    await sleep(1500)
    if (isDone(s)) break
    if (await hasLoginCookie(s.context)) {
      debug(tag, `验证码提交后拿到 sessionid`)
      await handleSuccess(s, s.setStatus)
      return { ok: true, message: s.status === "success" ? `登录成功：${s.accountName}` : s.message }
    }
  }
  if (s.status === "success") return { ok: true, message: `登录成功：${s.accountName}` }
  if (isDone(s)) return { ok: false, message: s.message || "本次登录已结束" }

  // 没拿到凭证：先看页面有没有明说错在哪，没有就只能报「还没通过」并让他再发一次
  const state = await readSmsState(page)
  const wrong = /验证码(错误|不正确|有误|已失效|已过期)|请重新(输入|获取|发送)/.exec(state?.text || "")
  await snapshot(page, `09-sms-3-after-${s.id}`)
  if (wrong) {
    log("warn", `${tag}：验证码被抖音拒绝（${wrong[0]}）`)
    return { ok: false, message: `抖音说「${wrong[0]}」，把新的验证码再发给我一次（也可以在页面倒计时结束后重新发起登录）`, retry: true }
  }
  log("warn", `${tag}：验证码已提交但还没拿到凭证。${await describeLine(page)}`)
  return {
    ok: false,
    message: "验证码已填进去了，但还没拿到登录凭证。再等十几秒，成功会自动通知你；也可以把验证码再发一次",
    retry: true,
  }
}

/**
 * 认一下页面上有没有在要额外验证。
 *
 * 抖音在异地登录、账号有风险标记时会在扫码确认后再插一道：短信验证码、滑块、
 * 或者「点击验证」。这些都得在那个浏览器里由人操作，插件代不了，但至少要认出来
 * 并把远程操作链接发出去——否则界面上停在「等扫码」，看起来像插件死了。
 *
 * 判据放在文本而不是 class 名：抖音的 class 是混淆出来的，每次发版都变，
 * 这几句提示文案却多年没动。
 *
 * 规则分两档：
 *
 * - **STRONG** —— 只可能出现在验证环节的整句，任何时候命中都算，不看二维码在不在。
 * - **WEAK** —— 像「请输入验证码」这种同时属于登录面板「验证码登录」tab 的说法，单看
 *   文案分不清是验证环节还是登录 tab。它要两道前提：调用方显式开 `weak`（只在已经扫过码
 *   之后，见主循环），且二维码已经从页面上消失。少一道就会误报——出码前那二十来秒
 *   登录面板已经渲染好、二维码还没出来，正好同时满足「有『请输入验证码』」和「没有码」。
 *
 * 调用方还要求连续两轮认出同一种才当真（见主循环），所以这里不必自己防抖。
 *
 * @param {object} [opts]
 * @param {boolean} [opts.weak] 是否启用 WEAK 档。只在已经扫过码、或超时兜底最后一搏时开
 */
async function detectVerify(page, { weak = false } = {}) {
  if (!page || page.isClosed()) return ""
  // page.evaluate 没有 timeout 参数，而这个函数现在也被超时兜底调用——那条路径上
  // 卡住就没人再收尾了，页面会一直开着。所以自己夹一个上限，超时按「没认出来」算
  const probe = page
    .evaluate(allowWeak => {
      const text = document.body?.innerText || ""

      /*
       * 第一档：只可能出现在验证环节的说法，命中即判定，不看二维码还在不在。
       *
       * 为什么不看二维码：上一版把「码已消失」当成所有规则的共同前提，而那个弹窗是
       * 盖在登录面板上的——二维码的 img 很可能还留在 DOM 里、clientWidth 也还是原值，
       * 于是明明弹窗就在屏幕正中间，插件却一口咬定「还在等扫码」。
       *
       * 用的都是长句而不是「身份验证」这四个字：这个函数现在从登录第一秒就开始跑，
       * innerText 里混着首页推荐流的视频标题，四个字的短词撞上的概率不能忽略，
       * 而「以确保为本人操作」这种整句只会来自抖音自己的验证弹窗。
       */
      const STRONG = [
        [/以确保为本人操作|请先完成身份验证|完成身份验证以/, "身份验证"],
        [/拖动滑块|按住左边滑块|向右滑动完成验证|完成下方拼图|依次点击下方/, "滑块验证"],
        [/验证码已发送|已发送验证码|人机验证|验证中间页/, "安全验证"],
        [/请先绑定手机号|需要绑定手机号/, "绑定手机号"],
      ]
      for (const [re, label] of STRONG) if (re.test(text)) return label

      // 实测那个弹窗：标题「身份验证」+ 两个选项「接收短信验证码」「发送短信验证」。
      // 标题四个字单独不算，和选项一起出现就足够特征化了
      if (/身份验证/.test(text) && /(接收|发送)短信验证/.test(text)) return "身份验证"

      /*
       * 第二档：这些说法登录面板自己也有（「验证码登录」那个 tab 上就写着「请输入验证码」）。
       * 所以要调用方明确说「现在可以看弱规则了」，并且二维码确实已经从页面上消失。
       * 这一档是兜底，专门留给以后抖音换成一种没见过的文案。
       */
      if (!allowWeak) return ""

      const qrVisible = [...document.querySelectorAll("img")].some(
        el =>
          el.src?.startsWith("data:image/png;base64,") &&
          el.clientWidth >= 100 &&
          el.clientWidth <= 320 &&
          el.offsetParent !== null
      )
      if (qrVisible) return ""

      const WEAK = [
        [/请输入(短信|收到的|\d+位)?验证码|短信验证/, "短信验证码"],
        [/请完成验证|安全验证/, "安全验证"],
      ]
      for (const [re, label] of WEAK) if (re.test(text)) return label
      return ""
    }, weak)
    .catch(() => "")
  return Promise.race([probe, sleep(5000).then(() => "")])
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
 *
 * 返回命中的是哪一条（`"二维码已渲染"` / `"面板文字"`），没等到返回空串。
 * 以前返回 true/false，于是「面板出来了但二维码迟迟不出」和「面板压根没出」
 * 在日志里长得一模一样——而这两种要查的地方完全不同。
 *
 * @returns {Promise<string>} 命中判据的名字，空串表示超时未出现
 */
async function waitLoginPanel(page, timeout) {
  return page
    .waitForFunction(
      () => {
        const img = [...document.querySelectorAll("img")].some(
          el => el.src?.startsWith("data:image/png;base64,") && el.clientWidth >= 100 && el.clientWidth <= 320
        )
        if (img) return "二维码已渲染"
        if (/扫码登录|验证码登录|密码登录/.test(document.body?.innerText || "")) return "面板文字"
        return false
      },
      { timeout, polling: 500 }
    )
    .then(h => h.jsonValue())
    .catch(() => "")
}

/**
 * 主动点开登录弹窗，只在抖音没有自动弹面板时才用得上。
 *
 * 首页的登录入口是一个纯文本叶子节点（如 <p class="VQdYTqcZ">登录</p>），
 * 真正可点的是它的某个祖先，所以从叶子往上连点几层。文本判定放宽到「包含
 * 『登录』且不超过 6 个字」，避免抖音把按钮文案改成「登录抖音」就失配。
 *
 * 返回点到的那个叶子的文本（如 `"登录"`），没找到返回空串——「找到入口点了但面板
 * 还是没弹」和「连入口都找不到」得能分开，前者要查点击目标选错了没，后者要查文案。
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
        const label = leaf.textContent?.trim() || "登录"
        let node = leaf
        for (let i = 0; i < 5 && node; i++) {
          node.click()
          node = node.parentElement
        }
        return label
      },
      { timeout: 15000, polling: 500 }
    )
    .then(h => h.jsonValue())
    .catch(() => "")
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
  // 只报名字与条数，Cookie 的值一个字符都不进日志
  debug(`扫码登录 ${s.id}`, `导出 douyin.com 域下 ${cookies.length} 条 Cookie：${cookies.map(c => c.name).join(",")}`)
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
    if (!ok && debugOn()) {
      debug("Cookie 检查", `搜索框没出现，页面现状 ${await describeLine(page)}`)
      await snapshot(page, `cookie-check-${accountId}`)
    }
    const message = ok ? "Cookie 有效" : "Cookie 已失效，请重新登录"
    // recordCookieCheck 会同时写 cookieInvalid，不用再单独 markCookieInvalid
    const check = store.recordCookieCheck(botId, accountId, ok, message)
    return { ok, cached: false, at: check?.at || Date.now(), message }
  } finally {
    await closeQuietly(page)
    await closeQuietly(context)
  }
}
