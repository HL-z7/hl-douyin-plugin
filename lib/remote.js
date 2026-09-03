/**
 * 抖音验证界面的一次性远程操作票据。
 *
 * 为什么不复用 lib/auth.js 那套面板会话：
 * 面板会话一建立就能选机器人、增删账号、改配置、看审计——那是「管理整套插件」的权限。
 * 而这里要发出去的东西只有一个用途：让人在浏览器里把抖音那道身份验证点过去。
 * 两者权限差了一个数量级，链接又要落在公网可达的地址上，混用等于把管理面板的钥匙
 * 顺手塞进一次性验证链接里。所以票据、路由、页面全部另开一套：它什么都管不了，
 * 只能对某一个正在登录的页面做「看一帧 / 点 / 拖 / 打字」这几件事。
 *
 * token 走 URL 的 hash（`/douyin/verify#t=xxx`）而不是 query：hash 不会发给服务端，
 * 因此不进 access log、不进 Referer；前端读完立刻用 replaceState 抹掉，也不留在地址栏。
 */
import { config } from "./config.js"
import { audit } from "./audit.js"
import { log, formatTime, sleep } from "./util.js"
import { randomToken } from "./crypto.js"
import { debug } from "./debug.js"
import { viewportSize, clickAt, typeText, pressKey } from "./interact.js"

/** token -> ticket。和 auth.js 的 sessions 一样只放内存，重启即全失效 */
const tickets = new Map()

/** 登录收尾后票据还能再读多久结果，只为让开着的页面看到「Cookie 已保存」 */
const GRACE_AFTER_CLOSE_MS = 60000

setInterval(() => {
  const now = Date.now()
  for (const [token, item] of tickets) if (item.expireAt <= now) tickets.delete(token)
}, 30000).unref?.()

/**
 * 签发票据。TTL 跟着 security.verifyTimeout 走——票据比登录会话活得久没有意义，
 * 会话一结束页面就关了，票据只会对着一个已经不存在的目标。
 *
 * @param {object} opts sessionId=扫码会话 id，botId/userId=发起人，用于审计与越权判断
 */
export function issueTicket({ sessionId, botId, userId }) {
  const ttl = config.num("security.verifyTimeout", 600, { min: 120, max: 3600 })
  const token = randomToken(32)
  const ticket = {
    token,
    sessionId: String(sessionId),
    botId: String(botId || ""),
    userId: String(userId || ""),
    /** 首次访问时记下来的 IP，之后必须一致（security.verifyBindIp） */
    ip: "",
    createdAt: Date.now(),
    expireAt: Date.now() + ttl * 1000,
    opened: false,
    /**
     * 登录会话结束后置 true。不立刻删票是为了让还开着的页面能读到最终结果
     * （「Cookie 已保存」而不是干巴巴一句「链接失效」），详见 revokeBySession。
     */
    closed: false,
    /** 累计操作次数，只用于会话结束时汇总进审计，不记具体内容 */
    acts: 0,
  }
  // 同一个登录会话重复进验证态时作废旧票，避免多个链接同时有效
  revokeBySession(sessionId)
  tickets.set(token, ticket)
  audit.add("verify.issue", { botId: ticket.botId, userId: ticket.userId, sessionId: ticket.sessionId, ttl })
  return { token, ttl, expireAt: ticket.expireAt }
}

/**
 * 取票据并校验。
 *
 * IP 绑定默认开着：链接万一被转发，换一台机器就用不了。首次访问时记录，之后要求一致。
 * 手机在 4G 与 WiFi 之间切换会换 IP，真被这个挡住时把 security.verifyBindIp 关掉即可。
 *
 * @returns {object|null} 校验不过一律返回 null，由调用方统一回 401 并计一次失败
 */
export function getTicket(token, ip) {
  const ticket = tickets.get(String(token || ""))
  if (!ticket) return null
  if (ticket.expireAt <= Date.now()) {
    tickets.delete(ticket.token)
    return null
  }

  const now = String(ip || "unknown")
  if (config.bool("security.verifyBindIp", true)) {
    if (!ticket.ip) ticket.ip = now
    else if (ticket.ip !== now) {
      audit.add("verify.ip.denied", { sessionId: ticket.sessionId, userId: ticket.userId, ip: now })
      log("warn", `远程验证票据被换 IP 使用：签发时 ${ticket.ip}，本次 ${now}，已拒绝`)
      return null
    }
  } else if (!ticket.ip) ticket.ip = now

  if (!ticket.opened) {
    ticket.opened = true
    audit.add("verify.open", { botId: ticket.botId, userId: ticket.userId, sessionId: ticket.sessionId, ip: now })
    log("info", `远程验证页面已被打开：会话 ${ticket.sessionId}，IP ${now}`)
  }
  return ticket
}

/** 记一次操作。内容（可能是短信验证码）绝不落进这里，只记次数 */
export function countAct(ticket) {
  if (ticket) ticket.acts++
}

export function revokeTicket(token) {
  return tickets.delete(String(token || ""))
}

/** 登录会话结束时调用：票据没有单独存在的意义，一并作废并把操作次数汇总进审计 */
export function revokeBySession(sessionId) {
  const id = String(sessionId)
  let n = 0
  for (const [token, item] of tickets)
    if (item.sessionId === id) {
      if (item.opened)
        audit.add("verify.close", { botId: item.botId, userId: item.userId, sessionId: id, acts: item.acts })
      tickets.delete(token)
      n++
    }
  return n
}

/**
 * 登录结束（成功或失败）时调用：标记票据已收尾，但留一小段窗口不删。
 *
 * 为什么不直接删：页面就在人手上开着，验证刚点完那一秒后端就把票撕了的话，
 * 前端下一次拉帧收到的是 401「链接失效」——而真实结果恰恰是「Cookie 已存好了」。
 * 留 GRACE_AFTER_CLOSE_MS 让页面把最终结论读到手，再由清理器收走。
 * 这段窗口里票据只能读结果：取帧和操作都会因为 page 已关闭而直接失败。
 */
export function closeBySession(sessionId) {
  const id = String(sessionId)
  let n = 0
  for (const [, item] of tickets)
    if (item.sessionId === id && !item.closed) {
      item.closed = true
      item.expireAt = Math.min(item.expireAt, Date.now() + GRACE_AFTER_CLOSE_MS)
      if (item.opened)
        audit.add("verify.close", { botId: item.botId, userId: item.userId, sessionId: id, acts: item.acts })
      n++
    }
  return n
}

/** 某个用户的全部票据，「#抖音web下线」顺手一起清 */
export function revokeUserTickets(userId) {
  let n = 0
  for (const [token, item] of tickets)
    if (item.userId === String(userId)) {
      tickets.delete(token)
      n++
    }
  return n
}

/** 面板状态里显示：现在有几个验证链接在外面飘 */
export function ticketStatus() {
  return {
    active: tickets.size,
    items: [...tickets.values()].map(t => ({
      sessionId: t.sessionId,
      userId: t.userId,
      opened: t.opened,
      acts: t.acts,
      expireAt: formatTime(t.expireAt),
    })),
  }
}

/* ==================== 页面操作 ====================
 *
 * 坐标一律用 0~1 的相对值传输，服务端再乘上真实视口尺寸。
 *
 * 为什么不传像素：前端那张图会被 CSS 缩放（手机屏幕比 1280 窄得多），一旦两边对
 * 缩放比的理解差一点，点击就会偏——而偏一点点在验证码输入框和「换一张」之间就是
 * 天壤之别。归一化之后前端只需要 `offsetX / 元素宽度`，服务端只需要乘 viewport，
 * 中间少一个必须对齐的约定。
 *
 * 这一节现在只负责「相对坐标 ↔ 视口像素」这层换算。真正把事件送进页面的那套
 * （真鼠标 approach/hold、到达探针、合成事件兜底、输入框聚焦与逐字符补写）搬到了
 * lib/interact.js：续火点「发消息」、自动登录点「发送验证码」遇到的是同一类静默失败，
 * 判据只应该有一份。
 */

/** 一次拖动最多重放多少个点，防止构造一个百万点的轨迹把事件循环占死 */
const MAX_DRAG_POINTS = 400

/** 一次输入最多多少字。短信验证码 6 位，留到 64 足够，再多就不是正常输入 */
const MAX_TEXT = 64

/** 允许按的功能键。只放通过验证真正需要的那几个，不做通用键盘 */
const ALLOWED_KEYS = new Set(["Enter", "Backspace", "Tab", "Escape", "ArrowLeft", "ArrowRight", "Delete"])

/**
 * 一次动作要用的坐标基准。
 *
 * 优先用最近一帧截图记下来的那份 —— 用户点的就是那张图，只有拿它当基准才对得上。
 * 没有（比如帧还没拉过就先发了动作）就退回「图 == 视口」，这也是绝大多数情况下的真相。
 */
async function frameBasis(page) {
  const vp = await viewportSize(page)
  const scroll = vp.scroll || { x: 0, y: 0 }
  const last = lastFrame.get(page)
  return { shot: last?.shot || { width: vp.width, height: vp.height }, vp, scroll }
}

/**
 * 把 0~1 的相对坐标换成鼠标事件要的视口像素。
 *
 * 相对坐标的基准是**前端看到的那张图**，鼠标事件的基准是**视口**。两者一致时
 * 这就是一次乘法；不一致时（截图基准跑偏，比如 puppeteer-core 19.0.0 及更早会把长页面
 * 截成整页）必须先落到图的像素上，再换算回视口 —— 整页图是从文档原点开始的，所以
 * 减掉滚动量。
 *
 * @param {{shot: {width: number, height: number}, vp: {width: number, height: number}, scroll: {x: number, y: number}}} basis
 */
function toPixel(basis, x, y) {
  const { shot, vp, scroll } = basis
  const clamp = (v, max) => Math.max(0, Math.min(max - 1, Math.round(v)))
  // 图上的像素位置
  const ix = (Number(x) || 0) * shot.width
  const iy = (Number(y) || 0) * shot.height
  // 图比视口大 = 那是整页图，图的原点是文档原点，要减掉已滚过的距离
  const px = shot.width > vp.width ? ix - scroll.x : (ix / shot.width) * vp.width
  const py = shot.height > vp.height ? iy - scroll.y : (iy / shot.height) * vp.height
  return { x: clamp(px, vp.width), y: clamp(py, vp.height), vp }
}

/**
 * 从 JPEG 字节里读出真实宽高。
 *
 * 为什么要读：前端归一化的分母是**那张图**，服务端还原的乘数是**视口**，两个数必须
 * 相等。它们各算各的（前端量 img 的显示尺寸，服务端读 viewport），平时恰好相等所以
 * 看不出问题，一旦截图基准跑偏（图被截成整页高 1280x6000 而报出去的还是 1280x800）
 * 就整体错位 —— 而两边的日志各自都是「正常」的：坐标合法，CDP 照常 1~3ms 成功返回，
 * 画面纹丝不动。这个插件被这类现象咬过一次，查了三轮。
 *
 * 截图基准跑偏的一个已知来源是 `captureBeyondViewport`（见 snapshot 的注释），但
 * 那条已经显式关掉了；这里量一遍是为了兜住**所有**让图与视口不一致的原因
 * （devicePixelRatio、以后 puppeteer 又改默认值、别人改了截图参数）。
 * 代价是每帧多解一次 JPEG 头（只扫段长，不解码像素，可忽略）。
 *
 * @returns {{width: number, height: number} | null} 解不出来就返回 null
 */
function jpegSize(buf) {
  // JPEG = FFD8 开头，之后是一串 FFxx 段。宽高在 SOFn 段（C0~CF，排除 C4/C8/CC）里
  if (buf.length < 4 || buf[0] !== 0xff || buf[1] !== 0xd8) return null
  let i = 2
  while (i + 9 < buf.length) {
    if (buf[i] !== 0xff) {
      i++
      continue
    }
    const marker = buf[i + 1]
    if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc)
      return { height: buf.readUInt16BE(i + 5), width: buf.readUInt16BE(i + 7) }
    if (marker === 0xd8 || marker === 0xd9 || (marker >= 0xd0 && marker <= 0xd7)) {
      i += 2
      continue
    }
    i += 2 + buf.readUInt16BE(i + 2)
  }
  return null
}

/** 尺寸不对只喊一次：帧是每秒一张，喊满屏没有意义 */
const warnedSize = new WeakSet()

/* ---------- 坐标基准 ----------
 *
 * 前端归一化的分母是**那张图**，服务端还原的乘数必须是**同一张图**。
 * 这两个数以前各算各的（前端量 img 的显示尺寸，服务端读 page.viewport()），
 * 平时恰好相等所以看不出问题，一旦 puppeteer 换了截图基准就整体偏移，
 * 而两边的日志各自都是「正常」的。
 *
 * 所以把每次截图用的基准记下来，让 applyAct 用同一份。key 是 page，
 * 页面关掉自然回收。
 */
const lastFrame = new WeakMap()

/**
 * 取一帧画面。
 *
 * 用 jpeg 而不是 png：同一帧 png 约 300KB、jpeg 质量 60 约 40KB，前端每秒拉一张，
 * 差出来的带宽在公网反代下很明显，而这张图只是给人看清按钮在哪，不需要无损。
 *
 * `captureBeyondViewport: false` 显式传着，**不要删**：它保证截出来的就是视口那一块。
 * 不传时的默认值各版本不一样 —— 实测 puppeteer-core 19.11.1 / 21.11.0 / 23.10.1 /
 * 24.34.0 的 screenshot 虽然都写着 `?? true`，但紧接着有一条「既没传 fullPage 也没传
 * clip 就改回 false」的分支，所以默认行为是按视口截；只有 19.0.0 及更早没有那条分支，
 * `true` 原样交给 CDP，长页面（抖音登录页 6000px）会被截成整页高。那时图是 1280x6000
 * 而我们报出去的 width/height 是视口的 1280x800，前端按图归一化、服务端乘视口还原，
 * y 方向直接差 7.5 倍 —— 点击全落在遮罩上，而坐标「合法」、CDP 照常成功返回。
 * 各版本都接受这个参数（本机 23.10.1 实测通过），所以一律显式传。
 */
export async function snapshot(page) {
  if (!page || page.isClosed()) throw new Error("页面已关闭，验证会话已结束")
  const vp = await viewportSize(page)
  const b64 = await page.screenshot({
    type: "jpeg",
    quality: 60,
    encoding: "base64",
    captureBeyondViewport: false,
  })

  /*
   * 报出去之前先量一下这张图到底多大。前端的归一化分母是图，服务端的乘数是视口，
   * 两者必须相等 —— 相等就报视口尺寸，不相等说明 puppeteer 又用了别的截图基准，
   * 这时报图的真实尺寸才能让前端算对，同时喊一声，别再让它无声地错下去。
   */
  const real = jpegSize(Buffer.from(b64, "base64"))
  let width = vp.width
  let height = vp.height
  if (real && (real.width !== vp.width || real.height !== vp.height)) {
    width = real.width
    height = real.height
    if (!warnedSize.has(page)) {
      warnedSize.add(page)
      log("warn", `远程验证画面尺寸与视口不一致：图 ${real.width}x${real.height}，视口 ${vp.width}x${vp.height}。已按图的尺寸校正坐标`)
    }
  }

  /*
   * 把这一帧的基准存下来给 applyAct 用。
   *
   * 存的是「图的尺寸」和「视口的尺寸」两份：前端发来的相对坐标是按图算的，
   * 而鼠标事件要的是视口坐标，中间那一步换算必须知道这两个数各是多少。
   * 正常情况下它们相等，换算就是恒等式；不相等时（截图基准跑偏）也能算对。
   */
  lastFrame.set(page, { shot: { width, height }, vp })

  return {
    image: `data:image/jpeg;base64,${b64}`,
    width,
    height,
    title: await page.title().catch(() => ""),
  }
}

/**
 * 重放一个操作。
 *
 * 这里刻意只支持「人在浏览器里能做的物理动作」——点、拖、滚、打字、按键。
 * 不提供 evaluate 之类能执行任意脚本的入口：那等于把远程代码执行开在公网上，
 * 而通过一道验证根本不需要它。
 *
 * @param {import("puppeteer").Page} page
 * @param {object} act { type, x, y, points[], text, key, dy }
 */
export async function applyAct(page, act) {
  if (!page || page.isClosed()) throw new Error("页面已关闭，验证会话已结束")
  const type = String(act?.type || "")
  const started = Date.now()

  /*
   * 坐标基准只在动作开头取一次：一次动作里所有坐标都得站在同一个基准上，
   * 拖动那种要换算几百个点的更是不能每点都去问一遍页面。
   */
  const basis = await frameBasis(page)
  const vp = basis.vp

  /*
   * 每个动作记一行，方便把「浏览器压根没发请求」「发了但坐标偏了」「点下去了但抖音
   * 那个弹窗没反应」三种情况分开——它们在用户眼里长得一模一样（画面纹丝不动）。
   * 内容永不进日志：用户输进去的可能是短信验证码，所以只记长度与动作类型。
   */
  const trace = (detail, extra = "") =>
    debug("远程验证", `动作 ${type}${detail ? ` ${detail}` : ""}${extra ? ` ${extra}` : ""} 耗时 ${Date.now() - started}ms`)

  if (type === "click" || type === "dblclick") {
    const { x, y } = toPixel(basis, act.x, act.y)

    // 靠近、hover、按住、探针、合成事件兜底、输入框聚焦这一整套在 lib/interact.js 里，
    // 和续火点「发消息」、自动登录点「发送验证码」走的是同一条链路
    const r = await clickAt(page, x, y, { vp, scope: "远程验证", dbl: type === "dblclick" })

    trace(
      `相对 ${Number(act.x).toFixed(3)},${Number(act.y).toFixed(3)}`,
      `→ 像素 ${x},${y} 视口 ${vp.width}x${vp.height}` +
        // 图和视口不是一个尺寸时把两个数都打出来，这是唯一能看出坐标基准跑偏的地方
        (basis.shot.width !== vp.width || basis.shot.height !== vp.height
          ? ` ⚠ 画面 ${basis.shot.width}x${basis.shot.height} 滚动 ${basis.scroll.x},${basis.scroll.y}`
          : "")
    )
    if (!r.arrived) debug("远程验证", "  真鼠标事件没进 DOM，已走合成事件兜底")
    return { ok: true }
  }

  if (type === "drag") {
    // 轨迹是用户真手拖出来的，连时间间隔一起重放——滑块验证判的就是这条曲线，
    // 用代码生成的匀速直线基本过不去，而原样重放的是真实人手轨迹
    const points = Array.isArray(act.points) ? act.points.slice(0, MAX_DRAG_POINTS) : []
    if (points.length < 2) throw new Error("拖动轨迹太短")
    const first = toPixel(basis, points[0].x, points[0].y)
    await page.mouse.move(first.x, first.y)
    await page.mouse.down()
    let prevT = Number(points[0].t) || 0
    for (const point of points.slice(1)) {
      const t = Number(point.t) || prevT
      // 单步间隔夹在 0~120ms：既保住真实节奏，也不让一条轨迹把请求拖到几分钟
      const gap = Math.max(0, Math.min(120, t - prevT))
      prevT = t
      if (gap) await sleep(gap)
      const { x, y } = toPixel(basis, point.x, point.y)
      await page.mouse.move(x, y)
    }
    await page.mouse.up()
    const last = toPixel(basis, points.at(-1).x, points.at(-1).y)
    trace(`${points.length} 点`, `${first.x},${first.y} → ${last.x},${last.y}`)
    return { ok: true }
  }

  if (type === "type") {
    const text = String(act.text ?? "").slice(0, MAX_TEXT)
    if (!text) throw new Error("没有要输入的内容")

    // 真键盘 + 「长度一点没变才补合成输入」的判据在 lib/interact.js
    const r = await typeText(page, text, { scope: "远程验证" })
    trace(`${text.length} 字`, r.focus ? `焦点=${r.focus}` : "")
    return { ok: true }
  }

  if (type === "key") {
    const key = String(act.key || "")
    if (!ALLOWED_KEYS.has(key)) throw new Error(`不支持的按键：${key}`)
    const r = await pressKey(page, key, { scope: "远程验证" })
    trace(key, r.forced ? `（已补合成按键：${r.forced}）` : "")
    return { ok: true }
  }

  if (type === "scroll") {
    const { x, y } = toPixel(basis, act.x ?? 0.5, act.y ?? 0.5)
    await page.mouse.move(x, y)
    await page.mouse.wheel({ deltaY: Math.max(-1200, Math.min(1200, Number(act.dy) || 0)) })
    trace(`在 ${x},${y}`, `dy=${Math.round(Number(act.dy) || 0)}`)
    return { ok: true }
  }

  throw new Error(`不支持的操作：${type}`)
}
