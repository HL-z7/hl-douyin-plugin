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
import { debug, debugOn } from "./debug.js"

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

/**
 * 页面此刻真实的视口尺寸。
 *
 * 不直接用 `page.viewport()`：那只是 puppeteer 自己缓存的一份 setViewport 入参，
 * 页面真实的排版视口可能已经不是它了（老版本截图会临时改设备度量）。截图和坐标
 * 换算必须站在同一个基准上，所以两边都从这里取。
 *
 * 用 innerWidth/innerHeight 而不是 documentElement.clientWidth：后者不含滚动条，
 * 而截图的像素宽和鼠标事件的坐标系都是含滚动条的那一套。
 */
async function viewportSize(page) {
  const cached = page.viewport() || { width: 1280, height: 800 }
  try {
    const real = await page.evaluate(() => ({
      width: innerWidth,
      height: innerHeight,
      sx: Math.round(scrollX),
      sy: Math.round(scrollY),
    }))
    if (real.width > 0 && real.height > 0)
      return { width: real.width, height: real.height, scroll: { x: real.sx, y: real.sy } }
  } catch {
    // 页面正在导航 / 已关闭，退回缓存值
  }
  return { ...cached, scroll: { x: 0, y: 0 } }
}

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
 * 这就是一次乘法；不一致时（截图基准跑偏，比如老版 puppeteer 把长页面截成整页）
 * 必须先落到图的像素上，再换算回视口 —— 整页图是从文档原点开始的，所以减掉滚动量。
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
 * 为什么要读：这个插件被这条 bug 咬过一次，而它咬得毫无声响 ——
 * 老版 puppeteer（v22 以前）的 screenshot 默认 `captureBeyondViewport: true`，
 * 长页面会截成整页高（抖音登录页实测 1280x6000），而 snapshot 报给前端的
 * width/height 是视口的 1280x800。前端拿图的显示尺寸当归一化分母、服务端拿
 * 视口当乘数，y 方向差了 7.5 倍，点击全落在遮罩上 —— 而日志里坐标看着完全合法，
 * CDP 也照常 1~3ms 成功返回。查了三轮才找到。
 *
 * 所以宁可每帧多解一次 JPEG 头（只扫段长，不解码像素，代价可忽略），
 * 让「图和视口不是一个尺寸」这件事一旦再发生就直接喊出来。
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

/* ---------- 命中探针 ----------
 *
 * 「点击已送达、耗时 2ms、坐标核对无误，抖音那个弹窗纹丝不动」这个现象，光看
 * 我们这边的日志是查不下去的：CDP 的 Input.dispatchMouseEvent 由浏览器进程受理并
 * 立刻 ack，它只保证「事件发出去了」，不保证「有元素收下了」。所以下面这段专门
 * 回答一个问题：那个像素底下，页面自己认出来的是什么东西？
 *
 * 抖音的身份验证弹窗是 login.douyin.com 里的 second_verification_web 组件，很可能
 * 落在跨源 iframe 里。跨源时主框架的 elementFromPoint 只会认到 IFRAME 本身
 * （已实测），所以必须逐个框架问一遍，并把每个框架自身的偏移减掉。
 *
 * 只在 debug.enable 打开时跑：它要遍历所有框架、每个框架一次 evaluate。
 */

/**
 * 一个框架的左上角在主框架视口里的位置。主框架就是 0,0。
 *
 * `frame.frameElement()` 是 v14 才有的（服务器上实测 v13.7.0 没有），老版本要自己
 * 在父框架里遍历 iframe，用 contentFrame() 认出哪一个是它。boundingBox() 两边都
 * 返回主框架坐标系的值，所以嵌套多深都不用累加。
 */
async function frameOffset(frame) {
  const parent = frame.parentFrame()
  if (!parent) return { x: 0, y: 0 }
  try {
    let handle = typeof frame.frameElement === "function" ? await frame.frameElement() : null
    if (!handle)
      for (const el of await parent.$$("iframe,frame")) {
        if ((await el.contentFrame()) === frame) {
          handle = el
          break
        }
      }
    const box = await handle?.boundingBox()
    return box ? { x: box.x, y: box.y } : null
  } catch {
    return null
  }
}

/**
 * 报告某个像素底下的元素，逐框架穷举。
 *
 * @returns {Promise<string>} 每个命中的框架一行，拼成一条日志
 */
async function describeHit(page, x, y) {
  const lines = []
  for (const frame of page.frames()) {
    const off = await frameOffset(frame)
    // 拿不到偏移说明这个框架已经没了（导航中 / 被移除），跳过就好
    if (!off) continue
    try {
      const hit = await frame.evaluate(
        ([px, py]) => {
          if (px < 0 || py < 0 || px > innerWidth || py > innerHeight) return { out: true }
          const el = document.elementFromPoint(px, py)
          if (!el) return { empty: true }
          const desc = node => {
            const tag = node.tagName?.toLowerCase() || "?"
            const id = node.id ? `#${node.id}` : ""
            const cls = String(node.className || "").trim().split(/\s+/).filter(Boolean).slice(0, 2).map(c => `.${c}`).join("")
            return tag + id + cls
          }
          const style = getComputedStyle(el)
          // 往上数三层：真正吃掉点击的常常是弹窗外面那个透明遮罩，
          // 只报最内层元素看不出「它在谁里面」
          const chain = []
          for (let node = el, i = 0; node && i < 4; node = node.parentElement, i++) chain.push(desc(node))
          return {
            chain: chain.join(" < "),
            text: (el.textContent || "").replace(/\s+/g, " ").trim().slice(0, 24),
            pe: style.pointerEvents,
            vis: `${style.visibility}/${style.opacity}`,
            // 命中元素身上有没有挂事件处理器的常见迹象
            clickable: Boolean(el.closest("a,button,[role=button],[onclick],input,textarea,label")),
          }
        },
        [Math.round(x - off.x), Math.round(y - off.y)]
      )
      if (hit.out || hit.empty) continue
      const where = frame.parentFrame() ? `子框架 ${frame.url().slice(0, 60)}` : "主框架"
      lines.push(
        `${where} 偏移 ${Math.round(off.x)},${Math.round(off.y)} → ${hit.chain}` +
          ` 文本=${JSON.stringify(hit.text)} pointer-events=${hit.pe} 可见=${hit.vis}` +
          ` 可点=${hit.clickable ? "是" : "否"}`
      )
    } catch {
      // 框架在 evaluate 中途导航掉了，不是我们要查的东西
    }
  }
  return lines.length ? lines.join("\n              ") : "(所有框架都没认出元素)"
}

/* ---------- 点击到达探针 ----------
 *
 * 命中探针只能证明「那个像素底下确实是那个按钮」，它证明不了后面三件事，而现场
 * 恰恰卡在那里：落点元素报出来就是「接收短信验证码」那一行，点下去画面照旧 ——
 * 连遮罩和左上角返回箭头也一样点不动，说明不是那个按钮挑食，是整页都不吃点击。
 *
 * 这一层要分开的三种可能：
 *   1. 事件压根没进 DOM（浏览器进程收了但没派发到渲染进程）
 *   2. 进了，但落到的 clientX/clientY 不是我们发的那个点
 *      —— `Input.dispatchMouseEvent` 的坐标要经过 visual viewport 换算，一旦
 *      页面有缩放或偏移，它和 `elementFromPoint` 用的布局坐标就不是一套
 *   3. 坐标也对，组件就是不理（比如只认它自己那套合成事件）
 *
 * 所以点击前在 window 的**捕获阶段**挂一圈监听 —— 捕获是整条派发链的最前面，
 * 任何 stopPropagation 都挡不住它，所以第 1 问能得到确定答案；把事件对象自己带的
 * clientX/clientY 记下来和我们发的那个点一比，第 2 问也就有了答案。
 * 再开一个 MutationObserver 看组件理没理，回答第 3 问 —— React 只要 setState
 * 就一定会动 DOM。
 *
 * 这一圈不受 debug 开关控制：`forceClick` 那条兜底要靠它的结论决定该不该出手。
 * 开销是点击前后各一次 evaluate，相比一次点击本身可以忽略。
 */
const CLICK_PROBE_EVENTS = ["pointerdown", "mousedown", "mouseup", "click"]

/** 点完等多久再读探针。给 React 一轮渲染，太短会把「理了」误判成「没理」 */
const CLICK_PROBE_WAIT_MS = 350

/**
 * MutationObserver 只盯验证组件那一块，不盯整页。
 *
 * 遮罩后面那张抖音页还在放视频、转轮播，整页盯着的话 DOM 变化永远不为 0，
 * 「组件理没理」这一问就永远问不出来，兜底也永远不会出手。
 */
const PANEL_HINTS = ["verify", "verification", "captcha", "dialog", "modal"]

async function watchClick(page, x, y) {
  try {
    await page.evaluate(
      ([types, hints, px, py]) => {
        const probe = { events: [], mutations: 0, sample: "" }
        window.__dyClickProbe = probe
        // SVG 元素的 className 是对象不是字符串，一律走 getAttribute
        const name = el => {
          if (!el || !el.tagName) return "?"
          const cls = String(el.getAttribute?.("class") || "").trim().split(/\s+/)[0]
          return el.tagName.toLowerCase() + (el.id ? `#${el.id}` : "") + (cls ? `.${cls}` : "")
        }
        probe.off = types.map(type => {
          const fn = e => {
            // 把事件自己报的坐标记下来：和我们发的那个点不一致就是坐标空间对不上
            probe.events.push(`${type}@${Math.round(e.clientX)},${Math.round(e.clientY)}→${name(e.target)}`)
          }
          window.addEventListener(type, fn, true)
          return () => window.removeEventListener(type, fn, true)
        })

        // 从落点往上找验证组件的外壳，找不到就退回整页（那时读数会偏吵，但总比没有好）
        let root = document.documentElement
        const hit = document.elementFromPoint(px, py)
        for (let node = hit; node && node !== document.body; node = node.parentElement) {
          const key = `${node.id || ""} ${node.getAttribute?.("class") || ""}`.toLowerCase()
          if (hints.some(h => key.includes(h))) root = node
        }
        probe.scope = name(root)
        probe.mo = new MutationObserver(list => {
          probe.mutations += list.length
          if (!probe.sample && list[0]) probe.sample = `${list[0].type} 于 ${name(list[0].target)}`
        })
        probe.mo.observe(root, { childList: true, subtree: true, attributes: true, characterData: true })

        // 一次性的环境读数，用来判掉「页面没焦点」和「视口被缩放/偏移过」
        const vv = window.visualViewport
        probe.env =
          `焦点=${document.hasFocus() ? "有" : "⚠ 无"} 可见性=${document.visibilityState}` +
          (vv
            ? ` 视觉视口=${Math.round(vv.width)}x${Math.round(vv.height)}` +
              ` 缩放=${vv.scale} 偏移=${Math.round(vv.offsetLeft)},${Math.round(vv.offsetTop)}`
            : "")
      },
      [CLICK_PROBE_EVENTS, PANEL_HINTS, Math.round(x), Math.round(y)]
    )
  } catch {
    // 页面正在导航 / 已关闭，探针挂不上就算了，不能因为诊断代码影响正常操作
  }
}

/**
 * 读回并拆掉探针。
 *
 * @returns {Promise<{events: string[], mutations: number, line: string} | null>}
 */
async function readClick(page) {
  try {
    const r = await page.evaluate(() => {
      const p = window.__dyClickProbe
      if (!p) return null
      p.off?.forEach(f => f())
      p.mo?.disconnect()
      delete window.__dyClickProbe
      return { events: p.events, mutations: p.mutations, sample: p.sample, scope: p.scope, env: p.env }
    })
    if (!r) return null
    return {
      events: r.events,
      mutations: r.mutations,
      line:
        `到达 DOM 的事件 ${r.events.length ? r.events.join(" ") : "⚠ 一个都没有"}` +
        ` / ${r.scope} 内 DOM 变化 ${r.mutations} 处${r.sample ? `（首条 ${r.sample}）` : ""}` +
        `${r.env ? ` / ${r.env}` : ""}`,
    }
  } catch {
    return null
  }
}

/**
 * 兜底：真鼠标点了没动静时，在落点元素上补一轮合成事件。
 *
 * 为什么留这条退路：真鼠标事件从浏览器进程走到渲染进程要经过一串坐标换算与
 * 命中测试，中间任何一环对不上，我们这边看到的都只是「静默成功」。而人在等着
 * 把验证过掉，不能因为这条链路上某个环节今天不通就整个功能不可用。
 *
 * 这不是「执行任意脚本」那个口子：作用对象是**我们刚点的那个坐标底下的元素**，
 * 由页面自己的 elementFromPoint 决定，调用方递不进来选择器也递不进来代码。
 *
 * 合成事件的 `isTrusted` 是 false。React 不看这个字段，所以它那套 onClick 照样触发；
 * 真的只认可信事件的组件这条兜底也帮不上，那种情况日志里会留下痕迹。
 */
async function forceClick(page, x, y) {
  try {
    return await page.evaluate(
      ([px, py]) => {
        const el = document.elementFromPoint(px, py)
        if (!el) return "落点已经没有元素了"
        const base = { bubbles: true, cancelable: true, composed: true, clientX: px, clientY: py, view: window }
        const pointer = { ...base, pointerId: 1, pointerType: "mouse", isPrimary: true, button: 0, buttons: 1 }
        el.dispatchEvent(new PointerEvent("pointerdown", pointer))
        el.dispatchEvent(new MouseEvent("mousedown", { ...base, button: 0, buttons: 1 }))
        el.dispatchEvent(new PointerEvent("pointerup", { ...pointer, buttons: 0 }))
        el.dispatchEvent(new MouseEvent("mouseup", { ...base, button: 0, buttons: 0 }))
        el.dispatchEvent(new MouseEvent("click", { ...base, button: 0, buttons: 0, detail: 1 }))
        const tag = el.tagName?.toLowerCase() || "?"
        return `已在 ${tag}${el.id ? `#${el.id}` : ""} 上补发合成事件`
      },
      [Math.round(x), Math.round(y)]
    )
  } catch (error) {
    return `补发失败：${error.message}`
  }
}

/* ---------- 输入框：焦点与到达 ----------
 *
 * 点击那条兜底救回来的只是「按钮被按到了」，打字还差一步。
 *
 * `page.keyboard.type()` 走的是 `Input.dispatchKeyEvent`，和鼠标同一条通道——鼠标
 * 事件到不了 DOM 的现场，键盘事件同样到不了。更麻烦的是键盘事件没有坐标，它只往
 * 「当前有焦点的那个元素」上送，所以打字之前还得先确认焦点真的落进了输入框。
 *
 * 现场日志里这两件事是叠在一起的：点 `input#button-input` 那一下探针报「到达 DOM 的
 * 事件 ⚠ 一个都没有」——焦点压根没换过去；紧接着 `动作 type 6 字` 却报成功，因为 CDP
 * 确实把六个按键发出去了，只是没有收件人。所以这一层要做两件事：点到输入框时把焦点
 * 按进去（noteField），以及打完字回头看一眼内容有没有真的进去（watchKeys/readKeys）。
 */

/** 输入类元素：三种形态都要认，抖音的验证码框是 input，但滑块提示区用过 contenteditable */
const FIELD_SELECTOR = "input,textarea,[contenteditable]"

/**
 * 点击落在输入框上时，把焦点按进去，并把这个元素记在页面上供 type 兜底取用。
 *
 * 为什么不等真鼠标自己把焦点带过去：焦点是浏览器在处理 mousedown 默认行为时给的，
 * 而现场那条链路 mousedown 压根没到 DOM。`el.focus()` 是页面自己的 API，不经过
 * 输入事件通道，所以这条路是通的——这也是为什么它不放在 forceClick 的兜底里，
 * 而是无条件做：点输入框时把光标放进去，本来就是这次点击应有的结果。
 *
 * @returns {Promise<string>} 落点不是输入框时返回空串（绝大多数点击都走这条）
 */
async function noteField(page, x, y) {
  try {
    return await page.evaluate(
      ([px, py, selector]) => {
        const hit = document.elementFromPoint(px, py)
        // 落点可能是输入框里的图标或 placeholder 层，往上找一层才是真的输入元素
        const field = hit?.matches?.(selector) ? hit : hit?.closest?.(selector)
        if (!field) return ""
        window.__dyField = field
        if (document.activeElement !== field) {
          try {
            // preventScroll：抖音这个弹窗是 fixed 的，聚焦时让页面滚起来会让坐标基准跟着变
            field.focus({ preventScroll: true })
          } catch {
            field.focus()
          }
        }
        const tag = field.tagName.toLowerCase() + (field.id ? `#${field.id}` : "")
        return `${tag}${document.activeElement === field ? " 已聚焦" : " ⚠ 聚焦没生效"}`
      },
      [Math.round(x), Math.round(y), FIELD_SELECTOR]
    )
  } catch {
    return ""
  }
}

/**
 * 打字前记一笔：焦点在谁身上、它现在的内容是什么。
 *
 * 判「字有没有进去」不能看 CDP 的返回值（它只报「按键发出去了」），只能看那个
 * 输入框的 value 前后有没有变。所以打字前后各读一次，中间那一串按键是真进去了
 * 还是打进了空气，一比就知道。
 */
async function watchKeys(page) {
  try {
    return await page.evaluate(selector => {
      const el = document.activeElement
      const field = el?.matches?.(selector) ? el : null
      return {
        // 没有焦点元素时 activeElement 是 body，这本身就是「打字没有收件人」的信号
        name: el ? el.tagName.toLowerCase() + (el.id ? `#${el.id}` : "") : "(无)",
        // 只记长度，不记内容——这里面装的可能就是短信验证码
        length: field ? String(field.value ?? field.textContent ?? "").length : -1,
      }
    }, FIELD_SELECTOR)
  } catch {
    return null
  }
}

/** 打完字再读一次长度，和 watchKeys 的读数对比 */
async function readKeys(page) {
  try {
    return await page.evaluate(selector => {
      const el = document.activeElement
      const field = el?.matches?.(selector) ? el : null
      return field ? String(field.value ?? field.textContent ?? "").length : -1
    }, FIELD_SELECTOR)
  } catch {
    return -1
  }
}

/**
 * 兜底：真键盘没把字打进去时，直接改输入框的值并补一轮输入事件。
 *
 * 三处不能省的细节，少一处 React 就不认这次输入：
 *
 * 1. **用原型上的 value setter 写值**。React 把 input 的 value 属性劫持成自己的，
 *    直接 `el.value = x` 只会改到 React 那个副本，它的内部记录（_valueTracker）不变，
 *    于是随后的 input 事件被判定为「值没变」而丢弃。要用
 *    `Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value").set`
 *    绕过劫持写到真正的 DOM 属性上。
 * 2. **InputEvent 而不是 Event**。React 17+ 靠 `data` / `inputType` 区分输入种类，
 *    普通 Event 在部分受控组件里拿不到值。
 * 3. **一个字符一轮**，而不是整串一次塞进去。抖音这个验证码框每满一位就自己判一次
 *    （满 6 位自动提交），整串塞进去它只会看到最后一次变化，中间那几步状态跳空。
 *
 * 与 forceClick 一样，这不是「执行任意脚本」的口子：作用对象是页面自己认定的
 * activeElement（或上一次点击落在的那个输入框），调用方递不进来选择器也递不进来代码。
 */
async function forceType(page, text) {
  try {
    return await page.evaluate(
      ([str, selector]) => {
        // 优先用当前焦点；焦点被别的元素抢走时退回上次点中的输入框
        const active = document.activeElement
        const field = active?.matches?.(selector) ? active : window.__dyField
        if (!field || !field.isConnected) return "找不到输入框（先在画面上点一下输入框）"
        try {
          field.focus({ preventScroll: true })
        } catch {}

        const editable = field.isContentEditable
        // 拿原型链上真正的 setter：input 和 textarea 各有一份，React 劫持的是实例属性
        const proto = field instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype
        const setter = Object.getOwnPropertyDescriptor(proto, "value")?.set

        for (const ch of str) {
          const key = { key: ch, bubbles: true, cancelable: true, composed: true }
          field.dispatchEvent(new KeyboardEvent("keydown", key))
          field.dispatchEvent(
            new InputEvent("beforeinput", { bubbles: true, cancelable: true, composed: true, inputType: "insertText", data: ch })
          )
          if (editable) field.textContent = String(field.textContent ?? "") + ch
          else if (setter) setter.call(field, String(field.value ?? "") + ch)
          else field.value = String(field.value ?? "") + ch
          field.dispatchEvent(
            new InputEvent("input", { bubbles: true, composed: true, inputType: "insertText", data: ch })
          )
          field.dispatchEvent(new KeyboardEvent("keyup", key))
        }
        // change 只在「值定下来」时发一次。有的组件只监听 change 不监听 input
        field.dispatchEvent(new Event("change", { bubbles: true }))
        const tag = field.tagName.toLowerCase() + (field.id ? `#${field.id}` : "")
        return `已往 ${tag} 补写 ${str.length} 字`
      },
      [String(text), FIELD_SELECTOR]
    )
  } catch (error) {
    return `补写失败：${error.message}`
  }
}

/**
 * 兜底：按键。
 *
 * Enter / Escape / 方向键这类只需要把 KeyboardEvent 补出去；Backspace 和 Delete 要连
 * 值一起改，因为「删掉一个字符」是浏览器在处理按键默认行为时做的，合成事件没有默认行为。
 *
 * keyCode / which 一起带上：抖音那套代码有按 keyCode 判断的老写法，只给 key 会漏。
 */
const KEY_CODES = { Enter: 13, Backspace: 8, Tab: 9, Escape: 27, ArrowLeft: 37, ArrowRight: 39, Delete: 46 }

async function forceKey(page, key) {
  try {
    return await page.evaluate(
      ([name, code, selector]) => {
        const active = document.activeElement
        const field = active?.matches?.(selector) ? active : window.__dyField
        const target = field?.isConnected ? field : document.activeElement || document.body
        const init = { key: name, code: name, keyCode: code, which: code, bubbles: true, cancelable: true, composed: true }
        target.dispatchEvent(new KeyboardEvent("keydown", init))

        // 删除键要自己把字符去掉：合成事件没有默认行为，光发按键值不会变
        if ((name === "Backspace" || name === "Delete") && field?.isConnected) {
          const editable = field.isContentEditable
          const cur = String((editable ? field.textContent : field.value) ?? "")
          // 光标位置在合成事件里不可靠，一律按「删最后一个字符」处理——验证码框够用
          const next = name === "Backspace" ? cur.slice(0, -1) : cur.slice(1)
          if (next !== cur) {
            const proto =
              field instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype
            const setter = Object.getOwnPropertyDescriptor(proto, "value")?.set
            if (editable) field.textContent = next
            else if (setter) setter.call(field, next)
            else field.value = next
            field.dispatchEvent(
              new InputEvent("input", {
                bubbles: true,
                composed: true,
                inputType: name === "Backspace" ? "deleteContentBackward" : "deleteContentForward",
              })
            )
          }
        }
        target.dispatchEvent(new KeyboardEvent("keyup", init))
        const tag = target.tagName?.toLowerCase() || "?"
        return `已在 ${tag}${target.id ? `#${target.id}` : ""} 上补发 ${name}`
      },
      [String(key), KEY_CODES[key] || 0, FIELD_SELECTOR]
    )
  } catch (error) {
    return `补发失败：${error.message}`
  }
}

/**
 * 挪到目标点，分步走。
 *
 * `page.mouse.move(x, y)` 一步到位只产生**一个** mousemove，而真人靠近按钮时是一串。
 * 有的组件把响应挂在 hover 之后才建立的状态上，有的反自动化检测直接看这串移动存不存在。
 * `steps` 是 puppeteer 自带的参数（v13 就有），不用自己拆。
 *
 * 起点取目标点左上方一点，clamp 在视口内 —— 按钮贴边时不能挪到负坐标去。
 */
async function approach(page, x, y, vp) {
  const sx = Math.max(0, Math.min(vp.width - 1, x - 24))
  const sy = Math.max(0, Math.min(vp.height - 1, y - 18))
  await page.mouse.move(sx, sy)
  await page.mouse.move(x, y, { steps: 6 })
}

/** hover 建立到按下之间停多久，给组件一帧时间把处理器挂上 */
const HOVER_MS = 90

/**
 * 按下与松开之间停多久。
 *
 * puppeteer 的 `mouse.click` 默认 down→up 在同一 tick 里，间隔 0ms —— 真人点击
 * 是 50~120ms。有的组件在 mousedown 里起一个状态、mouseup 时才判定，间隔 0 时
 * 那个状态还没建立完；反自动化检测也会拿这个间隔当特征。
 */
const CLICK_HOLD_MS = 70

/* ---------- 让页面「以为自己在前台」 ----------
 *
 * 无头浏览器里没有窗口管理器，页面的 `document.hasFocus()` 常年是 false。
 * 大多数点击不受影响，但有两类会：焦点相关的组件（输入框拿不到 caret）、
 * 以及把 hasFocus 当反自动化特征来看的脚本。
 *
 * CDP 的 `Emulation.setFocusEmulationEnabled` 就是给这个场景准备的：让渲染进程
 * 无条件认为自己是聚焦的。这个域从很早就有（v13 也在），但为了不给老版本添堵，
 * 失败一律咽掉 —— 它是加分项，不是必要条件。
 *
 * 每个页面只做一次，key 是 page，页面关掉自然回收。
 */
const focused = new WeakSet()

async function ensureFocus(page) {
  if (focused.has(page)) return
  focused.add(page)
  try {
    // 多标签时 Input 事件仍会送到本 target，但 bringToFront 顺手把可见性也摆正
    await page.bringToFront()
  } catch {}
  try {
    const cdp = await page.target().createCDPSession()
    await cdp.send("Emulation.setFocusEmulationEnabled", { enabled: true })
    debug("远程验证", "已开启焦点模拟（无头浏览器默认 document.hasFocus() 为 false）")
    // 不 detach：这个开关是会话级的，会话一断就失效，得让它跟着页面活着
  } catch (error) {
    debug("远程验证", `焦点模拟开不了（不影响点击）：${error.message}`)
  }
}

/**
 * 取一帧画面。
 *
 * 用 jpeg 而不是 png：同一帧 png 约 300KB、jpeg 质量 60 约 40KB，前端每秒拉一张，
 * 差出来的带宽在公网反代下很明显，而这张图只是给人看清按钮在哪，不需要无损。
 *
 * `captureBeyondViewport: false` 是这里最关键的一个参数，**不能删**：
 * puppeteer v22 以前它默认是 true，于是长页面（抖音登录页 6000px）会被截成整页高，
 * 图是 1280x6000 而我们报出去的 width/height 是视口的 1280x800。前端按图的显示
 * 尺寸归一化、服务端乘视口还原，y 方向直接差 7.5 倍 —— 点击全落在遮罩上，
 * 而日志里坐标合法、CDP 也照常成功返回，看不出任何异常。
 * 新版默认已是 false，显式传也不报错（v23 实测通过），所以两边都传。
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

  // 无头浏览器里页面常年「没有焦点」，第一次动作时把焦点模拟打开（每页一次）
  await ensureFocus(page)

  /*
   * 每个动作记一行，方便把「浏览器压根没发请求」「发了但坐标偏了」「点下去了但抖音
   * 那个弹窗没反应」三种情况分开——它们在用户眼里长得一模一样（画面纹丝不动）。
   * 内容永不进日志：用户输进去的可能是短信验证码，所以只记长度与动作类型。
   */
  const trace = (detail, extra = "") =>
    debug("远程验证", `动作 ${type}${detail ? ` ${detail}` : ""}${extra ? ` ${extra}` : ""} 耗时 ${Date.now() - started}ms`)

  if (type === "click" || type === "dblclick") {
    const { x, y } = toPixel(basis, act.x, act.y)

    /*
     * 点击拆成「靠近 → 停 → 按下 → 停 → 松开」，而不是 page.mouse.click 一把梭。
     *
     * mouse.click 内部是同一 tick 里 move→down→up：只有一个 mousemove、按下与松开
     * 间隔 0ms。抖音这个验证组件（React）把响应挂在 hover 之后才建立的状态上，
     * 而 0ms 的按下-松开在很多组件里根本走不完一轮判定，同时也是最典型的
     * 自动化特征。这里补上真人点击的三个特征：一串移动、hover 停顿、按住 70ms。
     * 代价是每次点击多 160ms，人察觉不到。
     */
    await approach(page, x, y, vp)
    await sleep(HOVER_MS)

    // 点之前先问一句「这个像素底下是什么」——这是区分「点空了」和「点对了但组件不理」
    // 的唯一手段，日志里那句 `耗时 2ms` 两种情况长得一模一样
    const hit = debugOn() ? await describeHit(page, x, y) : ""
    // 事件到没到 DOM、坐标对不对、组件理没理，这三问只有探针能答，而下面那条
    // 兜底要靠它的结论决定该不该出手，所以它不跟着 debug 开关走
    await watchClick(page, x, y)

    /*
     * 一次按下-松开。clickCount 要一路带着：浏览器靠它区分单击和双击，
     * 第二次必须是 2，否则页面收到的是两次独立单击而不是一次 dblclick。
     */
    const press = async count => {
      await page.mouse.down({ clickCount: count })
      await sleep(CLICK_HOLD_MS)
      await page.mouse.up({ clickCount: count })
    }
    await press(1)
    if (type === "dblclick") {
      // 两次之间的间隔要短于系统双击阈值（普遍 500ms），60ms 稳稳落在里面
      await sleep(60)
      await press(2)
    }

    trace(
      `相对 ${Number(act.x).toFixed(3)},${Number(act.y).toFixed(3)}`,
      `→ 像素 ${x},${y} 视口 ${vp.width}x${vp.height}` +
        // 图和视口不是一个尺寸时把两个数都打出来，这是唯一能看出坐标基准跑偏的地方
        (basis.shot.width !== vp.width || basis.shot.height !== vp.height
          ? ` ⚠ 画面 ${basis.shot.width}x${basis.shot.height} 滚动 ${basis.scroll.x},${basis.scroll.y}`
          : "")
    )
    if (hit) debug("远程验证", `  落点元素：${hit}`)

    // 等一轮渲染再读：读太早会把「组件正在处理」误判成「组件没理」
    await sleep(CLICK_PROBE_WAIT_MS)
    const probe = await readClick(page)
    if (probe) debug("远程验证", `  ${probe.line}`)

    /*
     * 真鼠标点完了，组件那一块 DOM 一点没动 —— 这时候补一轮合成事件。
     *
     * 判据不能只看「DOM 有没有动」：抖音那个验证码框旁边挂着「49s后重新发送」的倒计时，
     * 它每秒改一次 input 的属性，于是面板里永远有变化，兜底永远不出手 —— 现场就是这么
     * 卡住的（探针报「DOM 变化 4 处（首条 attributes 于 input#button-input）」，而实际上
     * 那四处全是倒计时，我们的点击一个都没到）。
     *
     * 所以真正的判据是「事件有没有进 DOM」：没进就必须补，无论 DOM 在不在动。事件进了
     * 但组件不理时，才退回看 DOM —— 那种情况补一轮也无害，反正组件本来就没反应。
     */
    const arrived = probe && probe.events.length > 0
    if (probe && (!arrived || probe.mutations === 0)) {
      const forced = await forceClick(page, x, y)
      debug("远程验证", `  ${arrived ? "事件到了但组件没动" : "真鼠标没进 DOM"}，已补合成事件：${forced}`)
    }

    /*
     * 点在输入框上时，把焦点按进去。
     *
     * 焦点是浏览器处理 mousedown 默认行为时给的，而这条链路 mousedown 到不了 DOM——
     * 于是「点一下输入框」这个动作看起来成功了，光标却没进去，紧接着的打字就打在了
     * 空气里。这是现场「验证码输不进去」的直接成因。放在兜底之后做：兜底那一轮合成
     * 事件有可能已经把焦点带过去了，这里只是确保结果一定成立。
     */
    const field = await noteField(page, x, y)
    if (field) debug("远程验证", `  落点是输入框：${field}`)
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

    // 打字前记一笔焦点在谁身上、里面已经有几个字，打完再读一次——CDP 只会报
    // 「按键发出去了」，字有没有落进输入框只能靠这个前后对比看出来
    const before = await watchKeys(page)

    // delay 让它像人在敲，抖音的输入框有的会监听 keydown 频率
    await page.keyboard.type(text, { delay: 60 })

    const after = await readKeys(page)
    trace(`${text.length} 字`, before ? `焦点=${before.name}` : "")

    /*
     * 真键盘没让内容变长 —— 补一轮合成输入。
     *
     * 三种情况都会走到这里，而它们在用户眼里长得一模一样（输入框始终是空的）：
     *   1. 焦点压根不在输入框上（点输入框那一下没能把光标放进去）
     *   2. 焦点对，但 `Input.dispatchKeyEvent` 和鼠标一样进不了 DOM
     *   3. 都对，但组件把输入拦了
     * 判据用「长度有没有变」而不是「等于预期长度」：验证码框满 6 位会自动提交并清空，
     * 那时长度可能回到 0，但内容确实进去过了——所以只在「一点没变」时才补。
     */
    const grew = before && after >= 0 && after !== before.length
    if (!grew) {
      const forced = await forceType(page, text)
      debug("远程验证", `  真键盘没让内容变化（焦点=${before?.name || "?"}），已补合成输入：${forced}`)
    }
    return { ok: true }
  }

  if (type === "key") {
    const key = String(act.key || "")
    if (!ALLOWED_KEYS.has(key)) throw new Error(`不支持的按键：${key}`)

    /*
     * 按键一律真键盘 + 合成各来一遍，不做「先试真的、不行再补」的判断。
     *
     * 因为按键的效果判不出来：Enter 是提交（页面自己会跳，输入框内容不变）、Escape 是
     * 关弹窗、方向键只挪光标——都没有一个「前后对比一下就知道成没成」的读数。而这几个键
     * 重复一次的代价很低（Enter 最多多提交一次，抖音那边幂等），漏掉一次的代价是用户
     * 点了没反应、只能干等超时。删除键例外：它会真的少删一个字，所以按内容变化判。
     */
    const before = key === "Backspace" || key === "Delete" ? await watchKeys(page) : null
    await page.keyboard.press(key)

    let forced = ""
    if (before) {
      const after = await readKeys(page)
      if (after === before.length) forced = await forceKey(page, key)
    } else forced = await forceKey(page, key)

    trace(key, forced ? `（已补合成按键：${forced}）` : "")
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
