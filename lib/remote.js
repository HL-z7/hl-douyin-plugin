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
import { log, formatTime } from "./util.js"
import { randomToken } from "./crypto.js"

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
 */

/** 一次拖动最多重放多少个点，防止构造一个百万点的轨迹把事件循环占死 */
const MAX_DRAG_POINTS = 400

/** 一次输入最多多少字。短信验证码 6 位，留到 64 足够，再多就不是正常输入 */
const MAX_TEXT = 64

/** 允许按的功能键。只放通过验证真正需要的那几个，不做通用键盘 */
const ALLOWED_KEYS = new Set(["Enter", "Backspace", "Tab", "Escape", "ArrowLeft", "ArrowRight", "Delete"])

/** 把 0~1 的相对坐标换成页面里的真实像素，越界一律夹回视口内 */
function toPixel(page, x, y) {
  const vp = page.viewport() || { width: 1280, height: 800 }
  const clamp = (v, max) => Math.max(0, Math.min(max - 1, Math.round((Number(v) || 0) * max)))
  return { x: clamp(x, vp.width), y: clamp(y, vp.height), vp }
}

/**
 * 取一帧画面。
 *
 * 用 jpeg 而不是 png：同一帧 png 约 300KB、jpeg 质量 60 约 40KB，前端每秒拉一张，
 * 差出来的带宽在公网反代下很明显，而这张图只是给人看清按钮在哪，不需要无损。
 */
export async function snapshot(page) {
  if (!page || page.isClosed()) throw new Error("页面已关闭，验证会话已结束")
  const vp = page.viewport() || { width: 1280, height: 800 }
  const image = await page.screenshot({ type: "jpeg", quality: 60, encoding: "base64" })
  return {
    image: `data:image/jpeg;base64,${image}`,
    width: vp.width,
    height: vp.height,
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

  if (type === "click" || type === "dblclick") {
    const { x, y } = toPixel(page, act.x, act.y)
    await page.mouse.click(x, y, { clickCount: type === "dblclick" ? 2 : 1 })
    return { ok: true }
  }

  if (type === "drag") {
    // 轨迹是用户真手拖出来的，连时间间隔一起重放——滑块验证判的就是这条曲线，
    // 用代码生成的匀速直线基本过不去，而原样重放的是真实人手轨迹
    const points = Array.isArray(act.points) ? act.points.slice(0, MAX_DRAG_POINTS) : []
    if (points.length < 2) throw new Error("拖动轨迹太短")
    const first = toPixel(page, points[0].x, points[0].y)
    await page.mouse.move(first.x, first.y)
    await page.mouse.down()
    let prevT = Number(points[0].t) || 0
    for (const point of points.slice(1)) {
      const t = Number(point.t) || prevT
      // 单步间隔夹在 0~120ms：既保住真实节奏，也不让一条轨迹把请求拖到几分钟
      const gap = Math.max(0, Math.min(120, t - prevT))
      prevT = t
      if (gap) await new Promise(r => setTimeout(r, gap))
      const { x, y } = toPixel(page, point.x, point.y)
      await page.mouse.move(x, y)
    }
    await page.mouse.up()
    return { ok: true }
  }

  if (type === "type") {
    const text = String(act.text ?? "").slice(0, MAX_TEXT)
    if (!text) throw new Error("没有要输入的内容")
    // delay 让它像人在敲，抖音的输入框有的会监听 keydown 频率
    await page.keyboard.type(text, { delay: 60 })
    return { ok: true }
  }

  if (type === "key") {
    const key = String(act.key || "")
    if (!ALLOWED_KEYS.has(key)) throw new Error(`不支持的按键：${key}`)
    await page.keyboard.press(key)
    return { ok: true }
  }

  if (type === "scroll") {
    const { x, y } = toPixel(page, act.x ?? 0.5, act.y ?? 0.5)
    await page.mouse.move(x, y)
    await page.mouse.wheel({ deltaY: Math.max(-1200, Math.min(1200, Number(act.dy) || 0)) })
    return { ok: true }
  }

  throw new Error(`不支持的操作：${type}`)
}
