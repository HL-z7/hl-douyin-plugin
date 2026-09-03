/**
 * 抖音登录：扫码取 Cookie，以及手动导入 Cookie。
 *
 * 对外导出分四组：
 * - 扫码流程：startQrLogin（发起）/ submitSmsCode（回填短信验证码），
 *   由 apps/login.js 与 lib/web.js 调用
 * - 会话查询：getSession（可 JSON 化的快照）/ getLiveSession（含活 Page，仅限
 *   lib/web.js 的远程验证路由）/ listSessions
 * - 会话终止：cancelSession / cancelUserSessions（`#抖音web下线`）/ cancelAll
 *   （lib/shutdown.js 在进程退出与热重载时调用）
 * - 其他入口：manualLogin（`#抖音文件登录`、锅巴导入）/ checkAccount（Cookie 有效性校验）
 *
 * 依赖 lib/browser.js（BrowserContext 与 Cookie 导出）、lib/store.js（落账号）、
 * lib/remote.js（远程验证票据）、lib/interact.js（点击与输入）、lib/debug.js（日志与快照）、
 * lib/config.js（超时与开关）。调用前提：仅需 puppeteer 可用，不要求已有 Cookie。
 *
 * 不引入第三方登录项目的原因：它们要么自带一整套浏览器栈（flyerhzm/douyin-mcp 用
 * Playwright，本仓库未安装），要么是 Rust/Java 独立进程，要么走逆向签名接口
 * （cv-cat/DouYin_Spider）。而抖音扫码本身只是两个公开接口——get_qrcode 出图、
 * check_qrconnect 出状态，在自己的 puppeteer 会话里拦这两个响应即可拿到二维码与登录结果，
 * Cookie 直接落在同一个 browserContext 内，无需第二套浏览器或新依赖。
 *
 * 全流程的成功判据只有一条：cookie jar 里出现 sessionid（见 hasLoginCookie）。
 * 接口状态、页面文案都只用于给出提示与决定下一步动作，不作为成功依据——远程验证是
 * 人在另一个浏览器里点完的，插件收不到任何通知，只有 Cookie 一定会落进来。
 */
import path from "node:path"
import { log, toError, randInt, formatDuration, sleep, dataDir, ensureDir, safeFileName } from "./util.js"
import { config } from "./config.js"
import { store } from "./store.js"
import { audit } from "./audit.js"
import browserManager, { closeQuietly, getContextCookies } from "./browser.js"
import { randomToken } from "./crypto.js"
import { issueTicket, closeBySession } from "./remote.js"
import { clickByText, clickHandle, typeText, pressKey, PANEL_HINTS } from "./interact.js"
import { debug, debugOn, describeLine, snapshot } from "./debug.js"

const LOGIN_URL = "https://www.douyin.com/"

/*
 * 只匹配接口名，不带主机名也不带路径前缀。
 *
 * 早期判据是 `login.douyin.com/passport/web/get_qrcode` / `...check_qrconnect`。现场证明
 * 该前缀已不总是成立：用户扫码并确认后页面上弹出了「身份验证」，插件却一路停在 waiting、
 * 最后报「3 分 0 秒内未完成扫码」——即 check_qrconnect 一条都没拦到的表现（二维码可由
 * findQr 从 DOM 兜底取到，因此扫码这一步看不出异常）。
 *
 * 抖音这套接口在 login / sso 子域与 /passport/web 前缀之间迁移过，接口名本身多年未变。
 * 因此判据只留接口名，并在 runQrLogin 里把所有拦到的候选 URL 记一条日志备查。
 */
const QRCODE_API = "get_qrcode"
const CHECK_API = "check_qrconnect"

/**
 * 手机点了「确认登录」之后，最多再等这么久让 sessionid 落进 cookie jar。
 *
 * 抖音的 confirmed 只是把 redirect_url 交给页面，真正写 Cookie 是页面随后那次跳转，
 * 实测 1~3 秒。给到 25 秒是留给慢网络与 sso 多跳一次的余量；超过这个数仍无 sessionid，
 * 基本是被追加了一道验证（短信 / 滑块），继续等只会等到会话超时。
 */
const CONFIRM_GRACE_MS = 25000

/**
 * 等第一张二维码最多等这么久。
 *
 * 原为 45 秒，被这条现场打穿：登录面板 13:53:13 已出现，但 passport 那条链
 * （ttwid/check → login_guiding_strategy → get_client_cert → challenge → get_qrcode）
 * 走到 challenge 用了 46 秒，插件在 45 秒判死，即在二维码到手前一两秒自行关闭了页面。
 *
 * 慢的原因不在抖音而在这个页面：未登录访问首页会落到 /jingxuan，HTML 1.6MB、60 张图、
 * 推荐流视频仍在后台加载，而登录页刻意不挂请求拦截（见 runQrLogin 的注释），
 * 渲染进程主线程被占满，passport 的 JS 只能排队——同期插件自身的 findQr() 一次
 * evaluate 也要 5 秒，正常为毫秒级。
 *
 * 因此给足 90 秒，并在真正拿到码时重新计时（见 emitQr）：出码慢不应吃掉用户的扫码时间。
 */
const QR_WAIT_MS = 90000

/**
 * check_qrconnect 的 status 里已知的取值。
 *
 * 仅用于判断「要不要把这个值记进日志」。上一版的故障即出在此处：抖音返回了一个既不是
 * confirmed 也不是 scanned/expired 的值，三个 else if 全落空，状态一直停在 scanned，
 * 最后被超时兜底报成「没等到确认结果」，而日志中没有任何记录。现在遇到未知值会 warn
 * 一条并带上原值，同类卡死可直接定位。
 */
const KNOWN_STATUS = new Set(["new", "scanned", "scanning", "expired", "confirmed", "logged_in", "canceled"])

/** 明确需要人在浏览器里操作才能通过的 status */
const VERIFY_STATUS = new Set(["2fa", "verify", "risk", "need_verify", "sms_verify"])

/** 现场截图落盘目录，与续火失败截图共用 data/screenshots */
const shotDir = () => ensureDir(dataDir, "screenshots")

/**
 * 扫码之后的几个状态。这些状态下页面不会再换二维码，也就无需再去 DOM 里捞图。
 *
 * `sms` 也在其中：自动短信那条路已把页面切到验证界面，此时 emitQr 若继续捞图，
 * 取到的是残留在 DOM 里的旧二维码，会把状态一路打回 waiting。
 */
const POST_SCAN = ["scanned", "confirmed", "verify", "sms"]

/** 进行中的扫码会话：sessionId -> state（内部对象，含 page / context / 回调） */
const sessions = new Map()

/**
 * 取会话的对外快照。
 *
 * 状态机：pending(出码中) -> waiting(等扫) -> scanned(已扫待确认) -> confirmed(已确认待写凭证)
 *          -> success / expired / failed / canceled
 *
 * 中途还可能岔进两档「需人配合」的状态，它们都不算失败，凭证照旧会落进 cookie jar：
 * - verify —— 抖音要求人在浏览器里操作（滑块、未见过的验证），已把远程操作链接私信发出
 * - sms —— 自动短信模式下插件已代点「发送验证码」，正在等用户把验证码发回
 *
 * expired 有两种含义，只有后者是终态：
 * - 单张二维码过期（抖音每 60 秒换一张）——页面自行刷新出新码，状态回到 waiting，会话不结束
 * - 整个会话超时（security.qrLoginTimeout 到点）——真正结束
 *
 * confirmed 是独立一档，不能省：手机点确认时抖音只是把 redirect_url 交给页面，sessionid
 * 要等页面跳完那一趟才写进 cookie jar。把 confirmed 直接当成功去读 Cookie 会读到空值
 * （即「确认了却没反应，最后说超时」的成因之一）。
 *
 * @param {string} sessionId startQrLogin 返回的会话 id
 * @returns {object|null} 可安全 JSON 化的快照（不含 page/context），会话不存在返回 null
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
 * 取会话的内部对象（含活的 page）。仅供 lib/web.js 的远程验证路由使用。
 *
 * 与 getSession 分开是刻意的：getSession 返回可安全 JSON 化、发给前端的快照，
 * 而本函数返回活的 puppeteer Page——持有它即可操作那个浏览器，绝不能进任何响应体。
 * 名字取长、注释写明约束，是为防止后来者把它当成 getSession 用去填接口返回值。
 *
 * @returns {object|null} 会话内部对象，不存在返回 null
 */
export function getLiveSession(sessionId) {
  return sessions.get(String(sessionId)) || null
}

/**
 * 列出会话快照，面板的登录状态区用。
 *
 * @param {string} [botId] 传入时只列该 Bot 名下的会话，空串表示全部
 * @returns {object[]} getSession 形状的快照数组
 */
export function listSessions(botId = "") {
  return [...sessions.values()]
    .filter(s => !botId || s.botId === String(botId))
    .map(s => getSession(s.id))
}

/**
 * 终止一个登录会话。
 *
 * @param {string} why 会成为会话的最终文案，前端与指令轮询都读它，
 *   因此「用户点了取消」与「进程要退出了」必须能区分
 * @returns {Promise<boolean>} false 表示这个 sessionId 不存在
 */
export async function cancelSession(sessionId, why = "已取消") {
  const s = sessions.get(sessionId)
  if (!s) return false
  s.status = "canceled"
  s.message = why
  await cleanup(s)
  return true
}

/**
 * 取消某个用户名下所有进行中的登录会话，`#抖音web下线` 使用。
 *
 * 存在理由：下线原先只清票据（链接打不开），登录会话仍存活——浏览器页面继续占内存，
 * 超时兜底也仍挂着，于是十分钟后照旧弹一句「❌ 抖音要求的验证在 10 分 0 秒内没有完成」。
 * 用户早已主动下线，这条提示既无用又让人误以为下线失败。
 *
 * 走 canceled 终态是关键：`cleanup` 会 clearTimeout 摘掉超时兜底，而超时兜底与失败兜底
 * 都先检查状态（`["success","failed","canceled"].includes`），因此即使某一路已在半途，
 * 也不会再向外推送任何消息。
 *
 * @param {string} userId 发起人 QQ
 * @returns {Promise<number>} 实际被取消的会话数，调用方用它拼回复
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

/**
 * 终止所有进行中的扫码会话，进程退出 / 重启前由 lib/shutdown.js 调用。
 *
 * 与 cancelUserSessions 的差别只在「是否筛发起人」，但必须单独存在：退出时没有
 * 「当前用户」这个概念，而进行中的会话每一个都占着一个 page 和一个 context
 * （见 cleanup），不回收就会跟着 Chromium 一起留在系统里。
 *
 * 走 canceled 终态而非直接删表：cleanup 会 clearTimeout 摘掉超时兜底，而超时与失败两处
 * 兜底都先检查状态，因此半途的那一路不会在退出过程中再向外推消息。
 *
 * @returns {Promise<number>} 实际被取消的会话数
 */
export async function cancelAll(why = "机器人正在重启，本次登录已中止") {
  const live = [...sessions.values()].filter(s => !isDone(s) && s.status !== "expired")
  for (const s of live) await cancelSession(s.id, why)
  return live.length
}

/**
 * 收尾一个会话：摘定时器、撕票、关页面与 context。
 *
 * 不在这里立刻从 sessions 表里删：前端与指令层还要再轮询几次才能把最终状态读到手。
 */
async function cleanup(s) {
  clearTimeout(s.timer)
  // 页面一关，远程验证票据就没有操作目标了。但不立刻撕票：人可能正盯着那个页面，
  // 留一小段窗口让它把「Cookie 已保存」读到手，详见 lib/remote.js 的 closeBySession
  closeBySession(s.id)
  await closeQuietly(s.page)
  await closeQuietly(s.context)
  s.page = null
  s.context = null
  // 结果多留 120 秒给前端 / 指令轮询取，之后再从表里删
  setTimeout(() => sessions.delete(s.id), 120000)
}

/**
 * 启动一次扫码登录。立即返回 sessionId，二维码通过 onQrcode 回调或轮询 getSession 取。
 *
 * 本函数只负责建会话、装超时兜底并把 runQrLogin 丢到后台跑，不等待登录结果——指令层
 * 需要马上回一句「二维码马上就到」。所有结果都通过回调或会话状态对外暴露。
 *
 * @param {string} botId 机器人 QQ，登录出的账号归它所有
 * @param {object} [opts]
 * @param {string} [opts.accountName] 账号名，留空则登录成功后读抖音昵称
 * @param {string} [opts.userId] 发起人 QQ。抖音弹验证时远程操作链接只私信发给他，也用于审计
 * @param {boolean} [opts.autoSms] 抖音弹「身份验证」时自行点「接收短信验证码 → 发送验证码」，
 *   把验证码要到发起人手上。`#抖音自动登录` 传 true；`#抖音登录` 不传，跟随 security.autoSms
 * @param {(base64: string, round: number) => void} [opts.onQrcode] 出码 / 换码时调用
 * @param {(status: string, message: string) => void} [opts.onStatus] 状态变化时调用
 * @param {(info: {sessionId: string, hint: string, phone: string, ttl: number}) => void}
 *   [opts.onSmsRequest] 短信已下发，去跟发起人要验证码；拿到后调 submitSmsCode(sessionId, code)
 * @param {(info: {url: string, token: string, ttl: number, hint: string, shot: string}) => void}
 *   [opts.onVerify] 抖音要求人工验证，把远程操作链接交给调用方去私信。链接落在公网可达
 *   地址上，绝不能进群；发不出去时用 token 撕票
 * @returns {Promise<string>} sessionId
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
    /** 已发出过几张二维码。抖音每分钟换一张，刷新后此数 +1 */
    qrRound: 0,
    /** 手机点确认的时刻。凭证不是立刻就有，靠它算 CONFIRM_GRACE_MS 宽限期 */
    confirmedAt: 0,
    /** 认出验证界面的时刻 */
    verifyAt: 0,
    /** 是否自行接管短信验证。指令未显式指定时跟随配置 */
    autoSms: autoSms === undefined ? config.bool("security.autoSms", false) : !!autoSms,
    /** 已跟用户要过验证码，避免重复要（也避免重复点「发送验证码」触发抖音频率限制） */
    smsAsked: false,
    /** 提交过几次验证码。第二次仍拿不到凭证就升级到远程页面，见 submitSmsCode 末尾 */
    smsSubmits: 0,
    /** markVerify 是否正在执行。它要 await 页面操作，不能被主循环重复进入 */
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
  // submitSmsCode 由指令层直接调进来（用户把验证码发回的那一刻），它要能走 handleSuccess，
  // 因此把 setStatus 挂在会话对象上
  s.setStatus = setStatus

  armTimer(s, setStatus, timeoutSec * 1000)

  // 后台跑，不阻塞指令回复
  runQrLogin(s, setStatus, onQrcode).catch(async error => {
    const err = toError(error)
    /*
     * 失败路径必须留现场。早期这里既无截图也无页面信息，用户只拿到一句「未出现登录面板，
     * 抖音可能触发了风控」，而这句话可能对应真风控、抖音改了面板结构、或页面本身是验证码
     * 中间页。因此失败时一律先读一次页面，把 title/url/文本片段写进日志，并把截图路径
     * 附到用户可见的消息里。
     */
    debug(tag, `失败：${err.message}`)
    if (s.page && !s.page.isClosed?.()) {
      log("warn", `扫码登录 ${s.id}：失败现场 ${await describeLine(s.page)}`)
      await snapshot(s.page, `login-fail-${s.id}`)
    }
    const shot = await diagnose(s)
    // 已经是终态（含 expired）时不再覆盖状态：那几条路径各自已给出更准确的文案
    if (!["success", "canceled", "expired"].includes(s.status))
      setStatus("failed", shot ? `${err.message}\n现场截图：${shot}` : err.message)
    await cleanup(s)
  })

  return s.id
}

/**
 * 装（或重装）会话超时兜底。
 *
 * 独立成函数是因为进 verify 状态时要把期限整体往后推：扫码本身 3 分钟足够，但人要收短信、
 * 点开链接、在远程页面上操作，3 分钟远不够。重装而非另起一个定时器，是为保证任何时刻
 * 只有一个兜底在跑，不会两个先后各触发一次。
 *
 * @param {number} ms 从现在起多久到点，同时写入 s.expireAt
 */
function armTimer(s, setStatus, ms) {
  clearTimeout(s.timer)
  s.expireAt = Date.now() + ms
  debug(`扫码登录 ${s.id}`, `超时兜底已装：${formatDuration(ms)} 后到点`)
  s.timer = setTimeout(async () => {
    if (["success", "failed", "canceled"].includes(s.status)) return
    debug(`扫码登录 ${s.id}`, `超时兜底触发，当前状态=${s.status}`)

    /*
     * 判死之前再读一次页面。
     *
     * 这是最后一道兜底：主循环每 2 秒认一次验证界面，但认不出来的形态（抖音改版、未见过的
     * 验证）会一路走到这里被报成「超时未完成扫码」，而用户实际已扫码、屏幕上正卡着一个弹窗。
     * 既然结论都是「要人去点」，就把页面交给人而不是判死。只做一次：markVerify 会把状态切成
     * verify，下一轮超时不会再进这个分支。
     */
    if (
      !["verify", "sms"].includes(s.status) &&
      (config.bool("security.remoteVerify", true) || s.autoSms) &&
      s.page &&
      !s.page.isClosed()
    ) {
      // 最后一搏，弱规则一并开启：既然本来就要判死，宁可多发一条链接让人自行查看
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
    // 卡住的现场留一张图，信息量远高于一句超时
    if (s.page && !s.page.isClosed?.())
      log("warn", `扫码登录 ${s.id}：判死时的页面现状 ${await describeLine(s.page)}`)
    await snapshot(s.page, `07-expired-${s.id}`)
    const shot = await diagnose(s)
    setStatus("expired", shot ? `${message}\n现场截图：${shot}` : message)
    await cleanup(s)
  }, ms)
  s.timer.unref?.()
}

/**
 * 扫码登录的主流程，由 startQrLogin 丢到后台执行。
 *
 * 步骤：建页面（带响应拦截）→ 打开首页 → 等中间页过掉 → 等/点出登录面板 → 等首张二维码
 * → 进主循环（查 Cookie、认验证界面、处理确认超期、补发换码）。
 *
 * 抛出的异常由 startQrLogin 的 catch 统一处理（记现场、置 failed、cleanup）。
 */
async function runQrLogin(s, setStatus, onQrcode) {
  const tag = `扫码登录 ${s.id}`
  /*
   * 登录页不拦图片字体，但要拦推荐流与埋点。
   *
   * 不拦图片字体：二维码弹窗的可见性判定依赖真实布局，缺图缺字体时元素容易塌成 0×0，
   * 被 waitForFunction 的 offsetParent 判死。
   *
   * 拦推荐流是现场结论。此处曾是 `intercept: false` 全关，理由为「命中项均为上报接口，
   * passport 链一个都不在其中」。该判断有误：未登录访问首页会被抖音带到 /jingxuan，
   * HTML 1.6MB、60 张图、推荐流视频仍在后台解码，渲染进程主线程被占满。实测那一轮
   * passport 链（ttwid/check → login_guiding_strategy → get_client_cert → challenge →
   * get_qrcode）排队 46 秒才走到 challenge，而插件自身的 findQr() 一次 evaluate 也要 5 秒
   * （正常毫秒级）——二维码不是没来，是被提前 1 秒判死了。
   *
   * BLOCKED_URL_PARTS 里三条 feed 接口正是 /jingxuan 的数据源，拦掉后页面没有视频卡片可
   * 渲染，登录弹窗自身布局不受影响。「以后清单里多一条命中 passport 的规则就会静默打断
   * 整条登录链」这一风险，改由 attachInterception 里写死的 passport 白名单兜住
   * （见 lib/browser.js），比整片关闭拦截更精确。
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
   * 抖音的二维码约每 60 秒过期，页面自行请求新的（实测 79s、142s 各刷新一次）。
   * QQ 里那张图不会自动更新，因此每换一张都要重新发送，否则用户扫的是已作废的码——
   * 手机上提示扫码成功，插件这边 check_qrconnect 却始终是 new，表现为「毫无反应」。
   *
   * @param {string} base64 完整的 data URI；空串或与上一张相同则忽略
   */
  let lastQr = ""
  const emitQr = base64 => {
    if (!base64 || base64 === lastQr) return
    // 已扫码 / 已进验证态时不要把状态往回切。抖音后台仍会按 60 秒节奏刷新二维码，而本回调
    // 由接口拦截触发，不受主循环那句 POST_SCAN 判断保护：一旦把状态打回 waiting，下一轮
    // 就会再签一张票据，把已私信出去的那条验证链接作废
    if (POST_SCAN.includes(s.status)) return
    const first = !s.qrRound
    lastQr = base64
    s.qrcode = base64
    s.qrRound += 1
    setStatus("waiting", s.qrRound > 1 ? "二维码已刷新，请重新扫码" : "二维码已生成，请用抖音 App 扫码")
    /*
     * 拿到第一张码时把超时重新计时。
     *
     * qrLoginTimeout 是「给人扫码的时间」，而出码本身在慢机器上要花掉几十秒——那段等待
     * 原先是从同一个 3 分钟里扣的，现场里出码用了 46 秒，用户实际只剩 2 分出头。
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
   * 此前的卡死正是因为判据里写死了主机名与 /passport/web 前缀，抖音一迁移就全部落空，
   * 而日志中没有任何记录。有了这一行，即使接口名也改了，也能直接对着日志看抖音实际请求了
   * 什么，无需再复现一轮。
   */
  const seenApi = new Set()

  // 拦响应拿二维码与轮询状态：比截图更稳，也能读到 status 字段
  page.on("response", async response => {
    const url = response.url()
    try {
      /*
       * `data:` 开头的响应直接跳过留证这一段。
       *
       * 下面那个正则不区分大小写，而二维码本身就是一条 data URI——base64 里任意一段
       * `sSO`、`Login` 都能命中，导致日志被塞进整张图的 base64（现场连着刷了两条上千字符
       * 的行）。二维码不是接口，也没有留证价值。
       *
       * 静态资源（passport-fe 下的 js / 图片 / lottie json）同样不进普通日志：它们命中
       * `passport` 只因 CDN 路径里带这个词，对定位「哪个接口没回话」无帮助，却会把真正的
       * 接口记录挤没。调试态下仍然全记。
       */
      if (!url.startsWith("data:") && /passport|sso|qrcode|qrconnect|login/i.test(url)) {
        const key = url.split("?")[0]
        const isAsset = /\.(js|css|png|jpe?g|webp|avif|svg|woff2?|json)$/i.test(key)
        if (!isAsset && !seenApi.has(key)) {
          seenApi.add(key)
          log("info", `扫码登录 ${s.id}：登录接口 ${key}`)
        }
        // 调试态下每次都记，含状态码——「拦到了但返回 4xx」与「一次都没拦到」是两回事
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

        // 手机点了确认——但此刻 Cookie 还未落盘。抖音只是把 redirect_url 交给页面，
        // sessionid 要等页面跳完那一趟才写进 cookie jar，直接去读会读到空值。
        // 因此这里只切状态并记下时刻，交给主循环在 CONFIRM_GRACE_MS 内轮询 Cookie
        if (raw === "confirmed" || raw === "logged_in" || data.redirect_url) {
          if (s.status !== "confirmed" && s.status !== "success") {
            s.confirmedAt = Date.now()
            setStatus("confirmed", "已确认登录，正在获取凭证…")
          }
        } else if (VERIFY_STATUS.has(raw)) {
          // 这是 response 回调，无人接收返回的 promise，抛出会变成 unhandledRejection
          markVerify(s, setStatus, data.description || "短信验证码 / 滑块").catch(error =>
            log("warn", `扫码登录 ${s.id}：处理验证态失败 ${toError(error).message}`)
          )
        } else if ((raw === "scanned" || raw === "scanning") && !POST_SCAN.includes(s.status)) {
          setStatus("scanned", "已扫码，请在手机上确认登录")
        } else if (raw === "expired" && !POST_SCAN.includes(s.status)) {
          // 仅这一张码过期，页面随即会拉新的。会话不结束，等 emitQr 把新码发出去
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
   * `domcontentloaded` 返回时抖音给的常常还不是首页，而是一个 2.5KB 的「Please wait...」
   * 壳子（现场 title 空、img 0、正文只有这三个词），它自己会再跳一次到 /jingxuan。
   * 直接开始等登录面板会把这十几秒算在面板头上，第一轮 12 秒必然耗尽，随后误走去点「登录」。
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
   * 未登录访问首页时抖音会自行弹出扫码登录面板，无需点「登录」按钮；面板出不来才退回
   * 主动点击（老版本页面 / 弹窗被 A/B 实验关掉的情况）。
   *
   * 这条路径早期抛的是一句「未出现登录面板，抖音可能触发了风控」，而它至少对应四种不同的
   * 现场：真被风控挡住、页面是验证码中间页、抖音改了面板文案、页面尚未加载完。因此失败时
   * 把页面现状（title / url / html 大小 / 文本片段）一并写进错误消息：用户把那句话贴过来
   * 即可定位，不必再开一轮 debug 复现。
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
   * 等首张二维码。上限 QR_WAIT_MS，但不越过会话自身的过期时间，否则页面已被 cleanup 关掉
   * 还在这里干等。
   *
   * 每轮都记耗时而非只记「有没有」：现场一次 evaluate 花了 5 秒（正常毫秒级），那是
   * 「页面在忙、passport 的 JS 在排队」的直接证据。
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
    // 每 5 秒（10 轮）记一条，出码要等二十来秒，每轮都记会刷屏
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

  /** 上一轮认出的验证类型。要连续两轮认出同一种才当真，理由见循环内注释 */
  let lastVerifyHint = ""
  /** 主循环的轮次，仅用于日志定位（每轮 2 秒，故轮数也是粗略的秒表） */
  let round = 0

  /*
   * 主循环，跑到会话终态或拿到 Cookie 为止，每 2 秒做四件事：
   *
   * 1. 查 sessionid —— 最终判据。check_qrconnect 的回调可能被风控页吞掉，验证也可能是人在
   *    远程页面上点完的，插件都收不到通知；但只要登录真的成功，Cookie 一定会落进这个
   *    browserContext。因此成功路径只有这一条，无需为远程验证另写一套。
   * 2. 盯页面上是否出现验证界面，出现则开一条远程操作通道交给人（markVerify）。
   *    这一步不等 check_qrconnect 说话：现场即为那个接口一条都没拦到、状态从头到尾停在
   *    waiting，而页面上验证弹窗早已弹出。把它挂在「已扫码之后」等于把整条远程验证路径
   *    押在那个接口能被拦到上。页面是最终事实，直接看页面。
   * 3. 已确认但迟迟无 Cookie 的，超过 CONFIRM_GRACE_MS 也按「有未识别的验证」处理，
   *    同样交给人看，优于含糊地报一句超时。
   * 4. 盯二维码是否更换，换了就把新码补发给用户。
   */
  while (!isDone(s)) {
    await sleep(2000)
    round += 1
    /*
     * 超时判定归 armTimer 那个定时器，不归这里。它到点后会先读一次页面，认出验证就改为发
     * 链接并把期限整体延后；本循环必须让它先跑完，否则两边同时到点、循环先 break，延期
     * 之后就没人再查 Cookie 了——人在远程页面上把验证过掉也不会被发现。
     *
     * 留 30 秒余量是保险（例如定时器被清掉），正常收尾靠 cleanup 关页面来断循环。
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
     * 认验证界面。判据只有页面本身，与 check_qrconnect 是否回话无关。
     *
     * 弱规则只在已扫过码之后才开：出码前那二十来秒登录面板已渲染好、二维码尚未出现，
     * 正好同时满足「页面上有『请输入验证码』」与「没有二维码」两条，一开就误报。
     *
     * 另要求连续两轮认出同一种才算数：整页 innerText 里混着首页推荐流的视频标题，理论上
     * 有极小概率撞上某条规则；而验证弹窗一旦弹出就会持续存在，撑得过第二轮，偶然撞词撑不过。
     * 代价只是最多晚 2 秒发链接。
     */
    if (!["verify", "sms"].includes(s.status)) {
      const hint = await detectVerify(s.page, { weak: POST_SCAN.includes(s.status) })
      // 每 10 轮（20 秒）报一次「还在等、当前状态是什么」，卡住时至少能确认循环没死
      if (hint || round % 10 === 1)
        debug(tag, `第 ${round} 轮：状态=${s.status} 验证探测=${hint || "无"}${hint && hint === lastVerifyHint ? "（连续两轮，判定成立）" : ""}`)
      if (hint && hint === lastVerifyHint) {
        // 必须 await：自动短信那条路要在页面上点两下按钮，不等它跑完，下一轮循环又会读到
        // 同一个验证界面（此时 verifying 锁虽挡住了重入，但会白转一圈）
        await markVerify(s, setStatus, hint)
        continue
      }
      lastVerifyHint = hint
    }

    // 已确认却拿不到凭证，超过宽限期不再干等。
    // 但也不直接判死：走到这一步几乎一定是抖音插了需要人操作的东西，只是 detectVerify 的
    // 文案规则没认出来（抖音改版、或换了一种未见过的验证）。此时正确做法与认出来时相同——
    // 把页面交给人去看去点。只有两条出路都被关掉时才回到「报失败 + 给替代方案」。
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
 * 标记「需要人工验证」，并把这道验证交出去。
 *
 * 接口 status 与页面文字两条路都可能先发现它，因此抽出共用，避免重复切状态。这一档不算
 * 失败——验证通过后 Cookie 照样会落进 cookie jar，主循环仍在查，拿到即走 handleSuccess，
 * 成功路径无需另写。
 *
 * 两条出路，优先前者：
 *
 * - 自动接管短信（s.autoSms，`#抖音自动登录`）：插件自行在页面上点「接收短信验证码」→
 *   「发送验证码」，然后只跟用户要那 6 位数字。用户无需点开任何链接，也就不存在把公网地址
 *   发出去这件事。仅在抖音给的是短信验证时可行。
 * - 远程操作页面（security.remoteVerify）：签一张一次性票据私信给发起人，人在浏览器里自行
 *   完成验证。滑块、拼图、未见过的验证只能走这条。
 *
 * 三件事必须一起做，少一件这条路即失效：
 *
 * 1. 把会话期限整体往后推（security.verifyTimeout，默认 600 秒）。扫码给 3 分钟够用，但人要
 *    等短信、点开链接、在页面上操作，3 分钟必然不够——上一版即提示已发出、人还在收短信，
 *    会话已被超时兜底掐掉。
 * 2. 签一张一次性票据，把链接交给调用方（指令层 / 面板）去私信。票据只能操作这一个页面，
 *    管不了插件的其他任何东西，详见 lib/remote.js。
 * 3. 把现场截图一并给出，用户点开链接前就知道要过的是哪一道验证。
 *
 * @param {string} hint 验证类型描述，来自 check_qrconnect 的 description 或 detectVerify
 *   的判定结果，会写进给用户的提示，并被 tryAutoSms 用来排除滑块 / 拼图 / 绑定手机号
 * @param {object} [opts]
 * @param {boolean} [opts.escalate] 从「已在等验证码」升级过来的（自动短信这条路走不通了）。
 *   置位时跳过状态守卫与 tryAutoSms，直接开远程页面 —— 不跳过状态守卫的话 s.status 已是
 *   `sms`，函数一进门就 return；不跳过 tryAutoSms 则会绕回刚刚失败的那条路
 * @returns {Promise<boolean>} 是否真的开出了远程页面（链接已交给调用方去私信）。
 *   已在验证中、被并发锁挡下、自动短信接管成功、或票据签不出来时为 false
 */
async function markVerify(s, setStatus, hint, { escalate = false } = {}) {
  if (!escalate && ["verify", "sms", "success"].includes(s.status)) return false
  if (escalate && ["verify", "success"].includes(s.status)) return false
  // 自动短信那条路要 await 多次页面操作，期间主循环仍在跑，不加锁会被重复进入
  if (s.verifying) return false
  s.verifying = true
  s.verifyAt = Date.now()
  debug(`扫码登录 ${s.id}`, `判定需要人工验证：${hint}`)

  const ttl = config.num("security.verifyTimeout", 600, { min: 120, max: 3600 })
  // 先延期再发通知：通知里要写「x 分钟内完成」，得和真实期限是同一个数
  armTimer(s, setStatus, ttl * 1000)

  try {
    // 能自行把短信发出去就不必再开远程页面。失败（不是短信验证 / 按钮点不到）返回 false，
    // 落回下面的远程验证路径
    if (!escalate && s.autoSms && (await tryAutoSms(s, setStatus, hint, ttl))) return false
  } catch (error) {
    log("warn", `扫码登录 ${s.id}：自动接管短信验证失败（${toError(error).message}），改走远程验证页面`)
  } finally {
    s.verifying = false
  }

  let link = null
  if (config.bool("security.remoteVerify", true)) {
    try {
      const { token } = issueTicket({ sessionId: s.id, botId: s.botId, userId: s.userId })
      // token 放 hash：不进服务端 access log，也不会随 Referer 外泄。
      // token 一并交出，调用方私信发不出去时要拿它撕票
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

  if (!link) return false
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
  return true
}

/* ---------- 自动接管短信验证（#抖音自动登录） ----------
 *
 * 远程验证页面那条路要把一个公网地址私信出去，用户还得在手机浏览器上操作。而抖音在扫码后
 * 追加的验证里最常见的那一种（「身份验证 → 接收短信验证码」）并不需要人来点：按钮位置固定、
 * 文案多年未动、点完只是让抖音给绑定手机发一条短信。真正只有用户能提供的是那 6 位数字。
 *
 * 因此这条路把「点」全部交给插件，只跟用户要那串数字：
 *   markVerify → tryAutoSms（点两个按钮、确认短信下发、通知发起人）
 *   → 用户把验证码发回 → submitSmsCode（填进页面、提交）
 *   → 主循环照旧靠 cookie jar 判成功（成功路径未另写一行）
 *
 * 任何一步不成立即返回 false，落回远程验证页面——滑块、拼图、要求绑定手机号，以及抖音改版
 * 后按钮找不到的情况，都只能由人来过。
 */

/**
 * 读取页面当前处在短信验证的哪一步。
 *
 * 判据全放文本：抖音的 class 是混淆生成的，每次发版都变。倒计时（`58s 后重新发送`）是
 * 「短信真的发出去了」最可靠的一条，它只在服务端受理之后才出现。
 *
 * 文本只从验证面板内取，不读整页 body。那个面板浮在抖音首页之上（现场是
 * `div#uc-second-verify`），而 `document.body.innerText` 会把底下推荐流的一切也带上：
 * 几十个视频标题、作者名、时长。已踩到的两个后果：
 *   - 判 `sent` 的 `\d+s后` 会被视频时长撞上，于是跳过「发送验证码」不点，用户手上没有短信
 *     却被要求提供验证码；
 *   - 报错时截的那段文本全是首页内容，弹窗上写了什么完全看不到（现场 `describeLine` 报的是
 *     `/jingxuan` 的文本）。
 * 面板认不出来时才退回整页，此时读数偏吵，但优于读不到。
 *
 * @returns {Promise<{text: string, scope: string, entry: boolean, sendBtn: boolean,
 *   sent: boolean, fields: number, phone: string} | null>} text 截断到 300 字符；
 *   scope 是面板的定位串（如 `div#uc-second-verify`）或「整页(没认出验证面板)」；
 *   entry=第一屏的「接收短信验证码」选项在场；sendBtn=第二屏的发送按钮在场；
 *   sent=短信已受理；fields=面板内可编辑输入框数量；phone=打码手机号。
 *   页面已关闭或 evaluate 失败返回 null
 */
async function readSmsState(page) {
  if (!page || page.isClosed()) return null
  return page
    .evaluate(hints => {
      /*
       * 找验证面板：从「写着验证相关字样的最内层元素」往上找带 verify/captcha/dialog 一类
       * 标识的外壳。不直接 querySelector 那些 class——抖音的 class 是混淆的，而 id/class 里的
       * `uc-second-verify`、`dialog` 这类语义词由框架给出，稳定得多。
       */
      const label = el => {
        if (!el?.tagName) return ""
        const cls = String(el.getAttribute?.("class") || "").trim().split(/\s+/)[0]
        return el.tagName.toLowerCase() + (el.id ? `#${el.id}` : "") + (cls ? `.${cls}` : "")
      }
      const panel = (() => {
        const marks = [...document.querySelectorAll("*")].filter(el =>
          /接收短信验证码|发送验证码|获取验证码|身份验证/.test((el.textContent || "").replace(/\s+/g, " "))
        )
        // 取最内层那个：只有它的祖先链上才有面板外壳
        const leaf = marks.filter(el => !marks.some(o => o !== el && el.contains(o))).pop()
        /*
         * 往上爬，取最外层那个命中的祖先，而不是最里层的。
         *
         * 此处原为「命中即 return」，现场因此失败一次：抖音把 `uc_verification_component_*`
         * 这类 class 挂在面板内每个小组件上，而 hints 里有 `verification`——于是「写着
         * 『接收短信验证码』的那个 typography div」自身就命中，panel 即为它，读出的文本只有
         * 那五个字。后果是第二屏已写着「短信已发送至 190******31 / 45s后重新发送」，状态机却
         * 一路读到 sent=false，无谓地改走远程验证页面，而用户手机上早已收到短信。
         * interact.js 的 watchClick 取的也是最外层（它报的 scope 是 `div#uc-second-verify`，
         * 那才是整个面板），两处保持一致。
         *
         * 唯一要防的是爬太外把底下的推荐流也圈进来，故带一个文本长度上限：这个弹窗满打满算
         * 百来字，而首页推荐流的 innerText 是几十 KB 起。
         */
        let found = null
        for (let node = leaf; node && node !== document.body; node = node.parentElement) {
          const key = `${node.id || ""} ${node.getAttribute?.("class") || ""}`.toLowerCase()
          if (!hints.some(h => key.includes(h))) continue
          if ((node.innerText || "").length > 1500) break
          found = node
        }
        return found
      })()
      const scopeEl = panel || document.body
      const text = (scopeEl.innerText || scopeEl.textContent || "").replace(/\s+/g, " ").trim()
      // 可见、可编辑、且尺寸不至于是个隐藏占位的输入框
      const fields = [...scopeEl.querySelectorAll("input")].filter(el => {
        if (el.offsetParent === null || el.disabled || el.readOnly) return false
        if (["hidden", "checkbox", "radio", "submit", "button"].includes(el.type)) return false
        const r = el.getBoundingClientRect()
        return r.width >= 20 && r.height >= 10
      }).length
      // 抖音把手机号打成 `138****8888` 或 `1**   ****  88` 这类形态，两种都收
      const phone = (text.match(/\d{2,3}\*{2,}\d{2,4}/) || [])[0] || ""
      // 「短信真的发出去了」的判据。倒计时那条必须带「后」：仅 `\d+s` 会被首页推荐流里的
      // 视频时长（"15s"）撞上，而判错的后果是跳过「发送验证码」不点，用户手上没有短信却被
      // 要求提供验证码。全插件只有这一处判 sent，waitSmsSent 也复用它
      const sent = /验证码已发送|已发送验证码|重新发送|重新获取|\d+\s?s\s?后/.test(text)
      return {
        text: text.slice(0, 300),
        scope: panel ? label(panel) : "整页(没认出验证面板)",
        entry: /接收短信验证码|短信验证码登录|接收验证码|验证码登录/.test(text),
        sendBtn: /发送验证码|获取验证码|发送短信验证码/.test(text),
        sent,
        fields,
        phone,
      }
    }, PANEL_HINTS)
    .catch(() => null)
}

/**
 * 轮询等「短信真的发出去了」。
 *
 * 判据复用 readSmsState 的 `sent`，不在这里另写一条正则——上一版是两处各写一份正则、又各自
 * 读整页 `document.body.innerText`，同一个页面能读出两个结论：首页推荐流里一个 "15s" 就能让
 * 这里判「已发送」而状态机判「没发送」。现在两者同源，且都只读验证面板内的文本。
 *
 * @param {number} [timeout=8000] 总等待毫秒；抖音这一步是「点完 → 服务端受理 → 倒计时起」，
 *   慢时要三四秒
 * @returns {Promise<object|null>} 已发送时返回那一刻的 state；超时或页面被关闭返回 null
 */
async function waitSmsSent(page, timeout = 8000) {
  const deadline = Date.now() + timeout
  let last = null
  while (Date.now() < deadline) {
    last = await readSmsState(page)
    if (last?.sent) return last
    if (page.isClosed()) return null
    await sleep(500)
  }
  return null
}

/**
 * 由插件代点「发送验证码」，只向发起人索取那串数字。
 *
 * 三步流程（入口 → 发送 → 确认已发送）每一步都落 debug + snapshot：整条链路跑在无头浏览器
 * 里，用户可见的只有一句「改走远程验证页面」，缺现场无法定位失败点。
 *
 * @param {object} s 会话对象，用到 page / smsAsked / smsPhone / onSmsRequest
 * @param {(status: string, message: string) => void} setStatus 状态回调，成功时置为 `sms`
 * @param {string} hint 验证类型提示（detectVerify 的返回值），滑块/拼图/绑定手机号直接放弃
 * @param {number} ttl 会话延期后的剩余秒数，写进给用户的提示里（与真实期限同一个数）
 * @returns {Promise<boolean>} true=短信已下发且已向用户索取验证码；false=这条路不通，落回远程验证
 */
async function tryAutoSms(s, setStatus, hint, ttl) {
  const tag = `扫码登录 ${s.id}`
  const page = s.page
  if (!page || page.isClosed()) return false
  // 已向用户索取过验证码就不再点一次「发送验证码」：抖音对该接口有频率限制，
  // 重复点可能导致该手机号被临时锁定
  if (s.smsAsked) return true

  // 滑块、拼图、绑定手机号插件无法代办，直接让给远程验证页面，省掉一次无用的页面操作
  if (/滑块|拼图|绑定手机号/.test(hint)) {
    debug(tag, `自动短信：「${hint}」不是短信验证，交给远程验证页面`)
    return false
  }

  let state = await readSmsState(page)
  if (!state) return false
  debug(
    tag,
    `自动短信：范围=${state.scope} 入口=${state.entry} 发送按钮=${state.sendBtn} 已发送=${state.sent}` +
      ` 输入框=${state.fields} 手机号=${state.phone || "未显示"}`
  )
  if (!state.entry && !state.sendBtn && !state.sent) {
    debug(tag, `自动短信：页面上没有短信验证的任何迹象，交给远程验证页面。面板(${state.scope})：${state.text.slice(0, 100)}`)
    return false
  }
  await snapshot(page, `09-sms-0-enter-${s.id}`)

  /*
   * ① 点「接收短信验证码」。它是弹窗第一屏上的一个选项，点它之后才切到第二屏
   *    （手机号 + 「获取验证码」+ 验证码输入框）。
   *
   * 判据只看 entry，不看 sendBtn。原因：抖音那个面板把两屏的 DOM 同时渲染出来，第二屏压在
   * 第一屏底下，`document.body.innerText` 里于是同时有「接收短信验证码」和「获取验证码」。
   * 上一版的条件是 `entry && !sent && !sendBtn`，sendBtn 为 true 时会跳过本步骤直接去点第二屏
   * 那个被压住的「获取验证码」——真鼠标点在压在上面的选项列表上（探针报「事件一个都没有」），
   * 抖音未收到「使用短信验证」这一选择，8 秒后等不到「已发送」。
   *
   * 点不动时不立即放弃：sendBtn 已在页面上说明可能本来就停在第二屏，继续往下走一步优于
   * 直接退回远程验证页面。
   */
  if (state.entry && !state.sent) {
    // 先按整句精确匹配，失配再放宽：该选项有时带一行小字说明，整段 textContent 不止这几个字
    let r = await clickByText(page, /^(接收短信验证码|短信验证码登录|接收验证码)$/, { scope: "自动短信" })
    if (!r.ok) r = await clickByText(page, /接收短信验证码|短信验证码登录/, { scope: "自动短信" })
    if (!r.ok && !state.sendBtn) {
      log("warn", `${tag}：自动短信点不到「接收短信验证码」（${r.reason}），改走远程验证页面`)
      await snapshot(page, `09-sms-x-noentry-${s.id}`)
      return false
    }
    if (!r.ok) debug(tag, `自动短信：点不到入口（${r.reason}），但页面上已有发送按钮，接着往下试`)
    else {
      /*
       * 等第一屏真的退场，再去点第二屏的按钮。
       *
       * 固定 sleep 在这里不成立：两屏叠着渲染时「获取验证码」从一开始就在 DOM 里，睡够了也
       * 判不出切没切。真正的判据是「它现在是不是最上面那个」——elementFromPoint 命中它
       * （或它的后代）才说明第一屏那层列表已让开。
       */
      const switched = await page
        .waitForFunction(
          () => {
            const btn = [...document.querySelectorAll("*")]
              .filter(el => /^(发送验证码|获取验证码|发送短信验证码|发送)$/.test((el.textContent || "").replace(/\s+/g, " ").trim()))
              .pop()
            if (!btn) return false
            const r = btn.getBoundingClientRect()
            if (r.width < 1 || r.height < 1) return false
            const top = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2)
            return Boolean(top && (top === btn || btn.contains(top) || top.contains(btn)))
          },
          { timeout: 5000, polling: 300 }
        )
        .then(() => true)
        .catch(() => false)
      debug(tag, `自动短信：入口点完，${switched ? "发送按钮已到最上层" : "⚠ 发送按钮仍被压住，只能靠合成事件"}`)
    }
    state = (await readSmsState(page)) || state
  }

  // ② 点「发送验证码」。已在倒计时说明上一轮点过了，不重复点
  if (!state.sent) {
    const send = await clickByText(page, /^(发送验证码|获取验证码|发送短信验证码|发送)$/, { scope: "自动短信" })
    if (!send.ok) {
      // 报的是面板内文本而非 describeLine 的整页文本：需要看的是弹窗上写了什么，而整页文本会被
      // 底下推荐流的视频标题灌满（现场报出的是 /jingxuan 的内容，无参考价值）
      log("warn", `${tag}：自动短信点不到「发送验证码」（${send.reason}）。面板(${state.scope})：${state.text}`)
      await snapshot(page, `09-sms-x-nosend-${s.id}`)
      return false
    }
  }

  /*
   * ③ 确认短信真的受理了，再向用户索取验证码。
   *
   * 少这一步的后果：按钮点空（点在旁边的容器上）而插件已私信「请把验证码发给我」，用户手上
   * 没有短信却只能干等到超时。倒计时/「验证码已发送」这类字样只在服务端受理之后才出现，
   * 是这一步唯一可靠的读数。
   */
  const sentState = await waitSmsSent(page)
  state = sentState || (await readSmsState(page)) || state
  if (!state.sent) {
    log("warn", `${tag}：点完发送后页面没有任何「已发送」迹象，改走远程验证页面。面板(${state.scope})：${state.text}`)
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
 * 让验证码输入框拿到焦点。
 *
 * 不复用 clickByText：那套按文本找元素，而输入框本身没有文本。这里按特征打分挑选
 * （placeholder 含「验证码」+3、maxlength 在 4~8 之间 +2、type 为 tel/number +1），再走
 * clickHandle 那条链路——点击的兜底逻辑（真鼠标事件进不了 DOM 时补合成事件）在那里，
 * 不能绕开它自己写 `handle.click()`。
 *
 * 一个特征都不命中时，只在「整页仅有一个可编辑输入框」的情况下才点它：宁可放弃，
 * 也不能把验证码打进搜索框。
 *
 * @returns {Promise<string>} 命中的输入框描述（如 `请输入验证码(maxlength=6)`），
 *   用于日志；空串表示没找到或点击失败
 */
async function focusCodeField(page) {
  // evaluate 里选中的节点没法直接带回 Node 侧，所以打一个临时属性当标记，回来再按属性取 handle。
  // 开头先清一遍残留标记：上一轮如果在 dispose 前抛异常，属性会留在页面上
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
 * 用户把验证码发回来了，填进页面并提交。由指令层（`#抖音自动登录` 的上下文回调）直接调用。
 *
 * 成功判据仍然只有 cookie jar 那一条（主循环每 2 秒查一次），这里额外自己多等十来秒，是为了让
 * 回给用户的那条消息能直接带上结果——否则要先回一句「已提交」、成功提示再由 onStatus 另发一条，
 * 看起来像出了两次错。
 *
 * 填错不结束会话：状态留在 sms，调用方据此让用户再发一次。
 *
 * 两处会主动放弃这条路、改开远程操作页面（`markVerify` 的 escalate 分支）：验证码一个字都写
 * 不进输入框，以及连提交两次都换不来凭证。两者的共同点是「再让用户发一次也只会得到同样结果」，
 * 而短信几分钟后就失效 —— 与其反复要码，不如把那个浏览器交给人，用同一条短信自己填完。
 *
 * @param {string} sessionId startQrLogin 返回的会话 id
 * @param {string} code 用户发来的原文，允许夹带中文（如「验证码是 123456」），内部只取数字
 * @returns {Promise<{ok: boolean, message: string, retry?: boolean}>} retry=true 表示还能再收一次
 *   验证码（指令层据此决定是否留着上下文）；升级到远程页面时不带 retry，那条路上已无需再要码。
 *   验证码的值不写入任何日志
 */
export async function submitSmsCode(sessionId, code) {
  const s = getLiveSession(sessionId)
  if (!s) return { ok: false, message: "这次登录会话已经结束了，重新发送「#抖音自动登录」再试一次" }
  if (isDone(s)) return { ok: false, message: `本次登录已结束（${s.message || s.status}），请重新发起` }
  if (s.status !== "sms") return { ok: false, message: "当前没有在等验证码，无需发送" }
  const page = s.page
  if (!page || page.isClosed())
    return { ok: false, message: "登录页面已经关闭了，重新发送「#抖音自动登录」再试一次" }

  // 用户常连着中文一起发（「验证码是 123456」），只取其中的数字
  const digits = String(code ?? "").replace(/\D/g, "")
  if (digits.length < 4 || digits.length > 8)
    return { ok: false, message: "没看懂这串验证码，把短信里的那几位数字直接发给我就行", retry: true }

  const tag = `扫码登录 ${s.id}`
  debug(tag, `收到验证码（${digits.length} 位，值不入日志），开始回填`)

  const field = await focusCodeField(page)
  if (!field) {
    const now = await readSmsState(page)
    log("warn", `${tag}：找不到验证码输入框。面板(${now?.scope || "读不到"})：${now?.text || ""}`)
    await snapshot(page, `09-sms-x-nofield-${s.id}`)
    return { ok: false, message: "页面上找不到验证码输入框，请改用「#抖音文件登录 账号名」导入 Cookie" }
  }
  debug(tag, `验证码输入框：${field}`)

  const typed = await typeText(page, digits, { scope: "自动短信" })
  debug(tag, `填入验证码：真键盘${typed.grew ? "生效" : `无效，${typed.forced}`}${typed.ok ? "" : "（⚠ 一个字也没写进去）"}`)

  /*
   * 三条输入通道都没把字写进去 —— 不提交，直接把页面交给人。
   *
   * 提交一个空输入框只会得到「验证码错误」，而真正的问题是这个页面不接收本侧的输入。上一版
   * 在这里照样往下走，于是用户收到「已填进去了，但还没拿到凭证，可以把验证码再发一次」——
   * 再发一次会走同一条已证明不通的路，短信却在 5 分钟后失效。现场那次用户连发两遍，两遍
   * 都是这个结果。
   *
   * 但「回读为空」有另一种成因，必须先排掉：验证码框满 6 位时抖音可能自行提交并清空输入框，
   * 那时回读同样是 0 —— 直接判死会在真的成功之后给用户开一个没用的远程页面。因此先等一下
   * 查 cookie，再看面板是否已离开「等输入验证码」那一屏，两条都不成立才算写不进去。
   *
   * escalate 让 markVerify 跳过状态守卫与 tryAutoSms：此刻 s.status 已是 `sms`，
   * 而自动短信这条路正是刚刚失败的那条。
   */
  if (!typed.ok) {
    await sleep(1500)
    if (await hasLoginCookie(s.context)) {
      debug(tag, `输入框回读为空，但 cookie 已到手 —— 满位自动提交那一种`)
      await handleSuccess(s, s.setStatus)
      return { ok: true, message: s.status === "success" ? `登录成功：${s.accountName}` : s.message }
    }
    const now = await readSmsState(page)
    // fields 归零或面板整个不见了，说明这一屏已经过去 —— 内容确实提交过，往下走正常等待流程
    const submitted = !now || now.fields === 0
    if (!submitted) {
      log("warn", `${tag}：验证码写不进输入框（${typed.forced || "三条通道都没生效"}），改走远程验证页面`)
      await snapshot(page, `09-sms-x-notype-${s.id}`)
      const opened = await markVerify(s, s.setStatus, "短信验证码（输入框写不进去）", { escalate: true })
      return {
        ok: false,
        message: opened
          ? "这个页面不接收我的输入（验证码一个字也没写进去），已给你开一个远程操作页面，链接私信发你了：在里面自己填这串验证码就行，短信还没失效。"
          : "这个页面不接收我的输入（验证码一个字也没写进去），而远程操作页面也开不出来。请改用「#抖音文件登录 账号名」导入 Cookie。",
      }
    }
    debug(tag, `输入框回读为空，但面板已离开输入那一屏，按已提交继续等`)
  }

  /*
   * 满位自动提交是抖音的常规行为，但不能依赖：改版后、或输入框是分格式的六个小框时就不会自动走。
   * 所以 Enter 和「登录」按钮各来一次。重复提交在抖音那边是幂等的，而漏提交一次的代价是
   * 用户以为发了码却毫无反应，只能干等超时。
   */
  await sleep(800)
  await pressKey(page, "Enter", { scope: "自动短信" })
  const btn = await clickByText(page, /^(登录|确定|提交|验证|下一步)$/, { scope: "自动短信" })
  debug(tag, `提交：Enter 已按${btn.ok ? `，并点了「${btn.text}」` : `（没有可点的提交按钮：${btn.reason}）`}`)
  await snapshot(page, `09-sms-2-submit-${s.id}`)

  // 抖音那边校验 + 跳转写 Cookie 一般三五秒，这里 8 轮 × 1.5 秒最多等 12 秒
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

  // 没拿到凭证：先看页面有没有明说错在哪；没有就只能报「还没通过」并允许重发一次
  const state = await readSmsState(page)
  const wrong = /验证码(错误|不正确|有误|已失效|已过期)|请重新(输入|获取|发送)/.exec(state?.text || "")
  await snapshot(page, `09-sms-3-after-${s.id}`)
  if (wrong) {
    log("warn", `${tag}：验证码被抖音拒绝（${wrong[0]}）`)
    return { ok: false, message: `抖音说「${wrong[0]}」，把新的验证码再发给我一次（也可以在页面倒计时结束后重新发起登录）`, retry: true }
  }

  /*
   * 页面既不说错、又不给凭证。第一次按「再等等」处理是合理的（抖音偶尔慢），但第二次仍是
   * 这个结果就说明这条路走不通了 —— 现场那次用户连发两遍验证码，收到的是两条一模一样的
   * 「再发一次」，而短信在几分钟后失效，等于把人耗死在这里。
   *
   * 所以第二次直接升级到远程页面：那边由人自己填，用的还是同一条短信。
   */
  s.smsSubmits += 1
  log(
    "warn",
    `${tag}：验证码已提交但还没拿到凭证（第 ${s.smsSubmits} 次）。面板(${state?.scope || "读不到"})：${state?.text || ""}`
  )
  if (s.smsSubmits >= 2) {
    const opened = await markVerify(s, s.setStatus, "短信验证码（填了两次都没通过）", { escalate: true })
    if (opened)
      return {
        ok: false,
        message: "填了两次都没换来登录凭证，已给你开一个远程操作页面，链接私信发你了：在里面自己填这串验证码，短信还没失效。",
      }
  }
  return {
    ok: false,
    message: "验证码已填进去了，但还没拿到登录凭证。再等十几秒，成功会自动通知你；也可以把验证码再发一次",
    retry: true,
  }
}

/**
 * 识别页面上是否正在要求额外验证。
 *
 * 抖音在异地登录、账号带风险标记时会在扫码确认后再插一道：短信验证码、滑块，或者「点击验证」。
 * 这些都需要在那个浏览器里由人操作，插件代不了，但必须认出来并把远程操作链接发出去——否则界面
 * 停在「等扫码」，表现与插件卡死一致。
 *
 * 判据放在文本而不是 class 名：抖音的 class 是混淆生成的、每次发版都变，这几句提示文案多年未动。
 *
 * 规则分两档：
 *
 * - **STRONG** —— 只可能出现在验证环节的整句，任何时候命中都算，不看二维码在不在。
 * - **WEAK** —— 如「请输入验证码」，同时也属于登录面板「验证码登录」tab 的说法，单看文案分不清是
 *   验证环节还是登录 tab。它要两道前提：调用方显式开 `weak`（只在已扫过码之后，见主循环），
 *   且二维码已从页面上消失。少一道即误报——出码前那二十来秒登录面板已渲染好、二维码还没出来，
 *   正好同时满足「有『请输入验证码』」和「没有码」。
 *
 * 调用方还要求连续两轮认出同一种才当真（见主循环），所以这里不自己防抖。
 *
 * @param {object} [opts]
 * @param {boolean} [opts.weak] 是否启用 WEAK 档。只在已经扫过码、或超时兜底最后一搏时开
 * @returns {Promise<string>} 验证类型标签（`身份验证` / `滑块验证` / `安全验证` / `绑定手机号` /
 *   `短信验证码`），空串表示未识别到；内部 5 秒仍未返回时也按空串算
 */
async function detectVerify(page, { weak = false } = {}) {
  if (!page || page.isClosed()) return ""
  // page.evaluate 没有 timeout 参数，而这个函数也被超时兜底路径调用——那条路径上卡住就没人再收尾，
  // 页面会一直开着。所以自己夹一个 5 秒上限，超时按「没认出来」算
  const probe = page
    .evaluate(allowWeak => {
      const text = document.body?.innerText || ""

      /*
       * 第一档：只可能出现在验证环节的说法，命中即判定，不看二维码还在不在。
       *
       * 为什么不看二维码：上一版把「码已消失」当成所有规则的共同前提，而那个弹窗是盖在登录面板
       * 上的——二维码的 img 很可能还留在 DOM 里、clientWidth 也还是原值，于是弹窗已在屏幕正
       * 中间，插件却判定「还在等扫码」。
       *
       * 用的都是长句而不是「身份验证」四个字：这个函数从登录第一秒就开始跑，innerText 里混着
       * 首页推荐流的视频标题，四字短词的误撞概率不可忽略，而「以确保为本人操作」这类整句只会
       * 来自抖音自己的验证弹窗。
       */
      const STRONG = [
        [/以确保为本人操作|请先完成身份验证|完成身份验证以/, "身份验证"],
        [/拖动滑块|按住左边滑块|向右滑动完成验证|完成下方拼图|依次点击下方/, "滑块验证"],
        [/验证码已发送|已发送验证码|人机验证|验证中间页/, "安全验证"],
        [/请先绑定手机号|需要绑定手机号/, "绑定手机号"],
      ]
      for (const [re, label] of STRONG) if (re.test(text)) return label

      // 实测那个弹窗：标题「身份验证」+ 两个选项「接收短信验证码」「发送短信验证」。
      // 标题四个字单独不算，与选项同时出现即足够特征化
      if (/身份验证/.test(text) && /(接收|发送)短信验证/.test(text)) return "身份验证"

      /*
       * 第二档：这些说法登录面板自己也有（「验证码登录」那个 tab 上就写着「请输入验证码」）。
       * 所以要调用方明确开启弱规则，并且二维码确实已从页面上消失。这一档是兜底，
       * 留给抖音换成一种没见过的文案时。
       */
      if (!allowWeak) return ""

      // 二维码判据与 waitLoginPanel 保持一致：data:image/png;base64 且 clientWidth 在 100~320 之间。
      // 这里多一条 offsetParent !== null，因为弹窗盖上来时 img 可能还在 DOM 里但已不可见
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
 * 扫码登录的失败几乎都发生在无头浏览器里，用户只看到一句「超时」。一张整页截图能分清是验证页、
 * 风控页还是二维码根本没渲染出来。复用续火那套 data/screenshots 目录，不新开位置；
 * 受 `spark.screenshotOnFail`（默认开）控制。
 *
 * @returns {Promise<string>} 截图文件的绝对路径；开关关闭、页面已关或截图失败时返回空串
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

/**
 * 会话是否已走到 success / failed / canceled。
 *
 * 注意 `expired` 不在其中：单张二维码过期时状态会被放回 waiting，会话继续；而会话整体超时
 * （armTimer 判死）同样置为 expired，那一种确实已经结束，本函数却仍返回 false。因此
 * cancelUserSessions / cancelAll 会在 `!isDone(s)` 之外另加一条 `s.status !== "expired"`。
 */
function isDone(s) {
  return ["success", "failed", "canceled"].includes(s.status)
}

/**
 * 等登录面板出现。
 *
 * 判据两条，命中任一即可：二维码 img 已渲染出来（`data:image/png;base64,` 且 clientWidth
 * 在 100~320 之间），或页面上出现「扫码登录 / 验证码登录 / 密码登录」这组标签页文字。后者比前者
 * 早十几秒，据此可在面板已弹出、二维码还在路上时就不再去点「登录」。
 *
 * 返回值刻意是命中判据的名字而非 true/false：以前返回布尔时，「面板出来了但二维码迟迟不出」和
 * 「面板完全没出现」在日志里完全一样，而这两种要查的地方不同。
 *
 * @param {number} timeout waitForFunction 的超时毫秒，轮询间隔固定 500ms
 * @returns {Promise<string>} `"二维码已渲染"` / `"面板文字"`，空串表示超时未出现
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
 * 主动点开登录弹窗，只在抖音没有自动弹面板时用得上。
 *
 * 首页的登录入口是一个纯文本叶子节点（如 `<p class="VQdYTqcZ">登录</p>`），真正可点的是它的某个
 * 祖先，所以从叶子往上连点 5 层。文本判定放宽到「包含『登录』且不超过 6 个字」，避免抖音把按钮
 * 文案改成「登录抖音」就失配；同时排除「未登录」，那是用户区的状态文字。
 *
 * @returns {Promise<string>} 点到的那个叶子的文本（如 `"登录"`），空串表示 15 秒内没找到入口。
 *   返回文本而非布尔，是为了区分「找到入口点了但面板还是没弹」（查点击目标）和
 *   「连入口都找不到」（查文案）
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

/**
 * 登录成功的唯一判据：cookie jar 里有非空的 `sessionid` 或 `sessionid_ss`。
 *
 * 全流程都以它为准，不看页面上有没有跳走、也不看 check_qrconnect 回的 status——那两样都可能在
 * 凭证还没写进 jar 时就先变了。长度下限 10 是为了排除抖音先塞一个空占位再改写的中间态。
 *
 * @param {import("puppeteer").BrowserContext} context 该会话独立的浏览器上下文
 * @returns {Promise<boolean>} 读 Cookie 抛异常时按 false 算，交给下一轮轮询重试
 */
async function hasLoginCookie(context) {
  if (!context) return false
  try {
    const cookies = await getContextCookies(context)
    return cookies.some(c => /^sessionid(_ss)?$/.test(c.name) && c.value && c.value.length > 10)
  } catch {
    return false
  }
}

/**
 * 收尾：导出 Cookie、落库、置成功、审计、关页面。
 *
 * 幂等（已是 success 直接返回）：主循环的 cookie 轮询和 submitSmsCode 里的等待可能同时命中，
 * 重复执行会往 store 里写第二个账号。
 */
async function handleSuccess(s, setStatus) {
  if (s.status === "success") return
  const cookies = await browserManager.exportCookies(s.context)
  // 只报名字与条数，Cookie 的值一个字符都不进日志
  debug(`扫码登录 ${s.id}`, `导出 douyin.com 域下 ${cookies.length} 条 Cookie：${cookies.map(c => c.name).join(",")}`)
  // 再查一次 sessionid：hasLoginCookie 读的是 jar，exportCookies 只取 douyin.com 域下的那部分，
  // 两者不一定同集合，缺了就不能当成功入库
  if (!cookies.some(c => /^sessionid(_ss)?$/.test(c.name))) {
    setStatus("failed", "登录似乎完成，但未取到 sessionid，请重试")
    await cleanup(s)
    return
  }

  // 账号名三级取值：用户指定 → 页面上的抖音昵称 → `抖音账号` + 四位随机数，保证 store 里一定有名字
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

/**
 * 读当前登录账号的抖音昵称，用作没指定名字时的账号名。
 *
 * 走 `/user/self`：这是唯一不需要知道 uid 就能拿到自己昵称的页面。选择器分两档，先认
 * `[data-e2e="user-info-nickname"]`（抖音自己的埋点属性，比 class 稳），失配再退到
 * `h1[class*="nickname"], span[class*="nickname"]`。
 *
 * 任何一步失败都返回空串而不抛：昵称只是个显示名，取不到就让 handleSuccess 用随机名兜底，
 * 不该让整次登录失败。
 *
 * @returns {Promise<string>} 昵称，截断到 30 字符；读不到返回空串
 */
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
 * 手动导入 Cookie。解析与校验都在 store.upsert 里做，这里只负责开关判定、审计与错误信息统一。
 *
 * @param {string|number} botId 机器人 id，账号按 bot 分账
 * @param {object} opts
 * @param {string} opts.name 账号名，必填（手动导入时没有页面可读昵称）
 * @param {string|Array} opts.cookie 原始粘贴文本、txt 文件内容或 cookie 数组，格式识别在 store 里
 * @param {string} [opts.source="text"] 来源标记，只进审计日志（如 `text` / `file`）
 * @returns {object} store 里的账号对象
 * @throws {Error} `security.allowManualCookie` 关闭、或没给账号名时抛出
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
 * 校验现有账号的 Cookie 是否还有效。
 *
 * 每次校验都要真开一个 Chromium 访问抖音，面板上连点几下就是好几轮真实请求——既慢，又是无谓的
 * 风控暴露。所以结论按 `spark.cookieCheckTTL`（分钟，默认 30）缓存，TTL 内直接复用，返回值带
 * `cached: true` 让调用方能在界面上说明「用的是缓存」。
 *
 * 判据是聊天页的搜索框能否出现（选择器与 spark.js 的 `SEL.search` 一致）：没登录时抖音会把
 * /chat 顶掉，搜索框不会渲染。20 秒等不到即判失效。
 *
 * @param {string|number} botId 机器人 id
 * @param {string} accountId store 里的账号 id
 * @param {object} [opts]
 * @param {boolean} [opts.force] 忽略缓存强制真查，用户点「重新检查」时用
 * @returns {Promise<{ok: boolean, cached: boolean, at: number, message: string}>} at 是结论产生的
 *   时间戳；结论会写回 store（含 cookieInvalid 标记）
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
