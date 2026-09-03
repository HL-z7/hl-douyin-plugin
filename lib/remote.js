/**
 * 抖音验证界面的一次性远程操作票据，以及把用户动作重放到页面上的换算层。
 *
 * 不复用 lib/auth.js 的面板会话：面板会话一建立即可选机器人、增删账号、改配置、看审计，
 * 是「管理整套插件」的权限；而本模块签发的链接只有一个用途 —— 让人在浏览器里把抖音那道
 * 身份验证点过去。两者权限相差一个数量级，且链接要落在公网可达的地址上，混用等于把管理
 * 面板的凭据放进一次性验证链接。因此票据、路由、页面全部独立：它不能读写任何配置，只能
 * 对某一个正在登录的页面做「取一帧 / 点 / 拖 / 滚 / 打字 / 按键」。
 *
 * token 走 URL 的 hash（`/douyin/verify#t=xxx`）而不是 query：hash 不发给服务端，因此不进
 * access log、不进 Referer；前端读取后立即用 replaceState 抹掉，也不留在地址栏。
 *
 * 导出：issueTicket / getTicket / countAct / revokeTicket / revokeBySession / closeBySession /
 * revokeUserTickets / ticketStatus（票据生命周期），snapshot / applyAct（页面操作）。
 *
 * 依赖：config、audit、util、crypto（randomToken）与 lib/interact.js —— 真正把事件送进页面
 * 的实现全在 interact.js，本模块只负责坐标换算、限额校验与审计。
 *
 * 调用前提：票据只存内存，进程重启即全失效；snapshot / applyAct 要求传入的 page 仍未关闭，
 * 已关闭时抛「页面已关闭，验证会话已结束」。路由层负责鉴权（getTicket）与失败计数。
 */
import { config } from "./config.js"
import { audit } from "./audit.js"
import { log, formatTime, sleep } from "./util.js"
import { randomToken } from "./crypto.js"
import { debug } from "./debug.js"
import { viewportSize, clickAt, typeText, pressKey } from "./interact.js"

/** token -> ticket。与 auth.js 的 sessions 一样只放内存，重启即全失效 */
const tickets = new Map()

/** 登录收尾后票据仍可读取结果的宽限期（毫秒），用途见 closeBySession */
const GRACE_AFTER_CLOSE_MS = 60000

// 过期票据的定期清理。unref 保证它不会阻止进程退出
setInterval(() => {
  const now = Date.now()
  for (const [token, item] of tickets) if (item.expireAt <= now) tickets.delete(token)
}, 30000).unref?.()

/**
 * 签发票据。
 *
 * TTL 取 security.verifyTimeout（夹取 120~3600 秒）：票据比登录会话存活更久没有意义 ——
 * 会话结束后页面即关闭，票据只会指向一个不存在的目标。
 * 同一登录会话重复进入验证态时先作废旧票，避免多个链接同时有效。
 *
 * @param {object} opts
 * @param {string|number} opts.sessionId 扫码会话 id，票据与它同生命周期
 * @param {string|number} [opts.botId] 发起人所在机器人，用于审计
 * @param {string|number} [opts.userId] 发起人 QQ，用于审计与越权判断
 * @returns {{token: string, ttl: number, expireAt: number}}
 */
export function issueTicket({ sessionId, botId, userId }) {
  const ttl = config.num("security.verifyTimeout", 600, { min: 120, max: 3600 })
  const token = randomToken(32)
  const ticket = {
    token,
    sessionId: String(sessionId),
    botId: String(botId || ""),
    userId: String(userId || ""),
    /** 首次访问时记下的 IP，之后要求一致（security.verifyBindIp） */
    ip: "",
    createdAt: Date.now(),
    expireAt: Date.now() + ttl * 1000,
    opened: false,
    /**
     * 登录会话结束后置 true。不立即删除票据是为了让仍开着的页面读到最终结果
     * （「Cookie 已保存」而非「链接失效」），详见 closeBySession。
     */
    closed: false,
    /** 累计操作次数，仅在会话结束时汇总进审计，不记录具体内容 */
    acts: 0,
  }
  revokeBySession(sessionId)
  tickets.set(token, ticket)
  audit.add("verify.issue", { botId: ticket.botId, userId: ticket.userId, sessionId: ticket.sessionId, ttl })
  return { token, ttl, expireAt: ticket.expireAt }
}

/**
 * 取票据并校验有效性，首次访问时记录 IP 与审计。
 *
 * IP 绑定默认开启：链接被转发到其它机器即失效。首次访问时记录，之后要求一致。
 * 手机在 4G 与 WiFi 之间切换会更换 IP，确实被拦住时关闭 security.verifyBindIp 即可。
 *
 * @param {string} token URL hash 里带来的 token
 * @param {string} ip 请求来源 IP，取不到时调用方传空，此处按 "unknown" 处理
 * @returns {object|null} 校验不通过一律返回 null（不存在 / 已过期 / IP 不符），
 *   由调用方统一回 401 并计一次鉴权失败
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

/**
 * 累加一次操作计数。操作内容（可能是短信验证码）不进此处，只记次数。
 * @param {object|null} ticket
 */
export function countAct(ticket) {
  if (ticket) ticket.acts++
}

/**
 * 按 token 作废单张票据。
 * @param {string} token
 * @returns {boolean} 该 token 是否存在
 */
export function revokeTicket(token) {
  return tickets.delete(String(token || ""))
}

/**
 * 登录会话结束时作废其名下的全部票据，并把操作次数汇总进审计。
 * 票据没有脱离会话单独存在的意义，因此直接删除而非标记。
 * @param {string|number} sessionId
 * @returns {number} 作废的票据数
 */
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
 * 登录结束（成功或失败）时标记票据已收尾，但保留一段宽限期不删除。
 *
 * 不立即删除的原因：页面仍在用户手上打开着，验证刚点完的那一刻若后端已撕票，前端下一次
 * 拉帧收到的是 401「链接失效」，而真实结果恰恰是「Cookie 已保存」。保留
 * GRACE_AFTER_CLOSE_MS（60 秒）让页面读到最终结论，再由定期清理器回收。
 * 这段窗口内票据只能读结果：取帧与操作都会因 page 已关闭而失败。
 *
 * @param {string|number} sessionId
 * @returns {number} 本次标记的票据数（已标记过的不重复计入）
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

/**
 * 作废某个用户名下的全部票据，`#抖音web下线` 会连带调用。
 * @param {string|number} userId
 * @returns {number} 作废的票据数
 */
export function revokeUserTickets(userId) {
  let n = 0
  for (const [token, item] of tickets)
    if (item.userId === String(userId)) {
      tickets.delete(token)
      n++
    }
  return n
}

/**
 * 当前在外有效的验证链接概况，供面板状态展示。
 * @returns {{active: number, items: Array<{sessionId: string, userId: string,
 *   opened: boolean, acts: number, expireAt: string}>}} 不含 token 本身
 */
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
 * 坐标一律以 0~1 的相对值传输，服务端再乘上真实视口尺寸。
 *
 * 不传像素的原因：前端展示的画面会被 CSS 缩放（手机屏幕远窄于 1280），两端对缩放比的理解
 * 一旦存在偏差，点击位置就会偏移，而在验证码输入框与「换一张」之间几十像素的偏移即导致
 * 完全不同的结果。归一化之后前端只需计算 `offsetX / 元素宽度`，服务端只需乘 viewport，
 * 中间少一个必须对齐的约定。
 *
 * 本节只负责「相对坐标 ↔ 视口像素」的换算。真正把事件送进页面的实现（真鼠标 approach/hold、
 * 到达探针、合成事件兜底、输入框聚焦与逐字符补写）在 lib/interact.js：续火点「发消息」与
 * 自动登录点「发送验证码」面对的是同一类静默失败，判据只应存在一份。
 */

/** 一次拖动最多重放的点数，防止超长轨迹占满事件循环 */
const MAX_DRAG_POINTS = 400

/** 一次输入的字数上限。短信验证码为 6 位，64 足够覆盖正常输入 */
const MAX_TEXT = 64

/** 允许按下的功能键白名单。只放通过验证确实需要的几个，不提供通用键盘 */
const ALLOWED_KEYS = new Set(["Enter", "Backspace", "Tab", "Escape", "ArrowLeft", "ArrowRight", "Delete"])

/**
 * 取一次动作所需的坐标基准。
 *
 * 优先使用最近一帧截图记下的尺寸 —— 用户点击的对象就是那张图，只有以它为基准才能对齐。
 * 若不存在（例如还未拉过帧就先发来动作），退回「图尺寸 == 视口尺寸」，这也是绝大多数
 * 情况下的实际状态。
 *
 * @param {import("puppeteer").Page} page
 * @returns {Promise<{shot: {width: number, height: number},
 *   vp: {width: number, height: number}, scroll: {x: number, y: number}}>}
 */
async function frameBasis(page) {
  const vp = await viewportSize(page)
  const scroll = vp.scroll || { x: 0, y: 0 }
  const last = lastFrame.get(page)
  return { shot: last?.shot || { width: vp.width, height: vp.height }, vp, scroll }
}

/**
 * 把 0~1 的相对坐标换算成鼠标事件需要的视口像素。
 *
 * 相对坐标的基准是前端看到的那张图，鼠标事件的基准是视口。两者一致时这就是一次乘法；
 * 不一致时（截图基准偏移，例如 puppeteer-core 19.0.0 及更早会把长页面截成整页）必须先
 * 落到图的像素上，再换算回视口 —— 整页图从文档原点开始，因此要减掉滚动量。
 *
 * @param {{shot: {width: number, height: number}, vp: {width: number, height: number},
 *   scroll: {x: number, y: number}}} basis frameBasis 的返回值
 * @param {number} x 相对横坐标（0~1）
 * @param {number} y 相对纵坐标（0~1）
 * @returns {{x: number, y: number, vp: object}} 已夹取到视口内的整数像素坐标
 */
function toPixel(basis, x, y) {
  const { shot, vp, scroll } = basis
  const clamp = (v, max) => Math.max(0, Math.min(max - 1, Math.round(v)))
  // 先落到图上的像素位置
  const ix = (Number(x) || 0) * shot.width
  const iy = (Number(y) || 0) * shot.height
  // 图大于视口即整页图，其原点是文档原点，需减去已滚过的距离
  const px = shot.width > vp.width ? ix - scroll.x : (ix / shot.width) * vp.width
  const py = shot.height > vp.height ? iy - scroll.y : (iy / shot.height) * vp.height
  return { x: clamp(px, vp.width), y: clamp(py, vp.height), vp }
}

/**
 * 从 JPEG 字节里读出真实宽高。
 *
 * 读取原因：前端归一化的分母是那张图，服务端还原的乘数是视口，两个数必须相等。它们由两端
 * 各自计算（前端量 img 的显示尺寸，服务端读 viewport），平时恰好相等因而不暴露问题；一旦
 * 截图基准偏移（图被截成整页高 1280x6000，而报出的尺寸仍是 1280x800）就整体错位，且两端
 * 日志各自都显示正常：坐标合法，CDP 在 1~3ms 内成功返回，画面无变化。
 *
 * 截图基准偏移的一个已知来源是 `captureBeyondViewport`（见 snapshot 的说明），该项已显式
 * 关闭；此处再测量一次是为覆盖所有导致图与视口不一致的原因（devicePixelRatio、后续
 * puppeteer 变更默认值、他人改动截图参数）。代价是每帧多解析一次 JPEG 头 —— 只扫描段长，
 * 不解码像素。
 *
 * @param {Buffer} buf JPEG 字节
 * @returns {{width: number, height: number}|null} 非 JPEG 或找不到 SOFn 段时返回 null
 */
function jpegSize(buf) {
  // JPEG 以 FFD8 开头，之后是一串 FFxx 段。宽高在 SOFn 段（C0~CF，排除 C4/C8/CC）中
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
    // SOI/EOI/RSTn 是无长度字段的独立标记，跳过 2 字节即可，不能按段长前进
    if (marker === 0xd8 || marker === 0xd9 || (marker >= 0xd0 && marker <= 0xd7)) {
      i += 2
      continue
    }
    i += 2 + buf.readUInt16BE(i + 2)
  }
  return null
}

/** 尺寸不一致的告警按页面只发一次：帧是每秒一张，重复告警无价值 */
const warnedSize = new WeakSet()

/* ---------- 坐标基准 ----------
 *
 * 前端归一化的分母是那张图，服务端还原的乘数必须是同一张图。这两个数曾由两端各自计算
 * （前端量 img 的显示尺寸，服务端读 page.viewport()），平时恰好相等因而不暴露问题，一旦
 * puppeteer 改变截图基准就整体偏移，而两端日志各自都显示正常。
 *
 * 因此把每次截图使用的基准记录下来，供 applyAct 使用。key 是 page，页面关闭后自动回收。
 */
const lastFrame = new WeakMap()

/**
 * 取一帧画面，并记录本帧的坐标基准供 applyAct 使用。
 *
 * 用 jpeg 而非 png：同一帧 png 约 300KB，jpeg 质量 60 约 40KB；前端每秒拉取一张，在公网
 * 反代下带宽差异明显，而这张图只需让人看清按钮位置，不要求无损。
 *
 * `captureBeyondViewport: false` 显式传入，不可删除：它保证截出的就是视口那一块。不传时的
 * 默认值各版本不同 —— 实测 puppeteer-core 19.11.1 / 21.11.0 / 23.10.1 / 24.34.0 的
 * screenshot 虽然都写着 `?? true`，但紧随其后有一条「既未传 fullPage 也未传 clip 就改回
 * false」的分支，因此默认行为是按视口截；只有 19.0.0 及更早没有该分支，`true` 原样交给
 * CDP，长页面（抖音登录页 6000px）会被截成整页高。此时图为 1280x6000 而报出的 width/height
 * 是视口的 1280x800，前端按图归一化、服务端乘视口还原，y 方向相差 7.5 倍 —— 点击全部落在
 * 遮罩上，而坐标合法、CDP 照常成功返回。各版本均接受该参数（本机 23.10.1 实测通过）。
 *
 * @param {import("puppeteer").Page} page
 * @returns {Promise<{image: string, width: number, height: number, title: string}>}
 *   image 为 data URL；width/height 是前端归一化必须使用的分母
 * @throws page 为空或已关闭时抛「页面已关闭，验证会话已结束」
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
   * 上报之前先测量这张图的真实尺寸。前端的归一化分母是图，服务端的乘数是视口，两者必须
   * 相等：相等则上报视口尺寸；不相等说明 puppeteer 使用了其它截图基准，此时上报图的真实
   * 尺寸才能让前端算对，同时记一条 warn 以免长期静默错位。
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
   * 记录本帧的坐标基准供 applyAct 使用。
   *
   * 同时存「图的尺寸」与「视口的尺寸」：前端发来的相对坐标以图为基准，而鼠标事件需要视口
   * 坐标，中间那步换算必须知道这两个数。正常情况下二者相等，换算即恒等式；不相等时
   * （截图基准偏移）也能算对。
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
 * 把前端发来的一个动作重放到页面上。
 *
 * 只支持人在浏览器里能做出的物理动作 —— click / dblclick / drag / type / key / scroll。
 * 不提供 evaluate 之类可执行任意脚本的入口：那等于在公网上开放远程代码执行，而通过一道
 * 身份验证并不需要该能力。
 *
 * @param {import("puppeteer").Page} page
 * @param {object} act 动作描述。`type` 必填；click/dblclick/scroll 用 `x`/`y`（0~1 相对
 *   坐标，scroll 另有 `dy`），drag 用 `points[]`（每项 {x, y, t}），type 用 `text`，
 *   key 用 `key`
 * @returns {Promise<{ok: true}>}
 * @throws page 已关闭、拖动轨迹少于 2 点、输入内容为空、按键不在 ALLOWED_KEYS 内、
 *   或 type 不被支持时抛出
 */
export async function applyAct(page, act) {
  if (!page || page.isClosed()) throw new Error("页面已关闭，验证会话已结束")
  const type = String(act?.type || "")
  const started = Date.now()

  /*
   * 坐标基准在动作开头取一次：同一次动作内所有坐标必须基于同一基准，拖动要换算数百个点，
   * 更不能逐点向页面查询。
   */
  const basis = await frameBasis(page)
  const vp = basis.vp

  /*
   * 每个动作记一行，用于区分「浏览器根本没发请求」「已发送但坐标偏移」「已点击但抖音弹窗
   * 无响应」三种情况 —— 它们在用户端表现完全相同（画面无变化）。
   * 动作内容不进日志：用户输入的可能是短信验证码，因此只记长度与动作类型。
   */
  const trace = (detail, extra = "") =>
    debug("远程验证", `动作 ${type}${detail ? ` ${detail}` : ""}${extra ? ` ${extra}` : ""} 耗时 ${Date.now() - started}ms`)

  if (type === "click" || type === "dblclick") {
    const { x, y } = toPixel(basis, act.x, act.y)

    // 靠近、hover、按住、到达探针、合成事件兜底、输入框聚焦这一整套在 lib/interact.js，
    // 与续火点「发消息」、自动登录点「发送验证码」走同一条链路
    const r = await clickAt(page, x, y, { vp, scope: "远程验证", dbl: type === "dblclick" })

    trace(
      `相对 ${Number(act.x).toFixed(3)},${Number(act.y).toFixed(3)}`,
      `→ 像素 ${x},${y} 视口 ${vp.width}x${vp.height}` +
        // 图与视口尺寸不同时把两个数都打出来，这是唯一能看出坐标基准偏移的位置
        (basis.shot.width !== vp.width || basis.shot.height !== vp.height
          ? ` ⚠ 画面 ${basis.shot.width}x${basis.shot.height} 滚动 ${basis.scroll.x},${basis.scroll.y}`
          : "")
    )
    if (!r.arrived) debug("远程验证", "  真鼠标事件没进 DOM，已走合成事件兜底")
    return { ok: true }
  }

  if (type === "drag") {
    // 轨迹由用户真实拖动产生，连时间间隔一并重放：滑块验证判定的正是这条曲线，
    // 代码生成的匀速直线基本无法通过
    const points = Array.isArray(act.points) ? act.points.slice(0, MAX_DRAG_POINTS) : []
    if (points.length < 2) throw new Error("拖动轨迹太短")
    const first = toPixel(basis, points[0].x, points[0].y)
    await page.mouse.move(first.x, first.y)
    await page.mouse.down()
    let prevT = Number(points[0].t) || 0
    for (const point of points.slice(1)) {
      const t = Number(point.t) || prevT
      // 单步间隔夹在 0~120ms：保留真实节奏，同时避免一条轨迹把请求拖到数分钟
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

    // 真键盘输入与「长度未变化才补合成输入」的判据在 lib/interact.js
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
    // 未给坐标时按视口中心滚动；滚动量夹在 ±1200，防止一次请求把页面滚过头
    const { x, y } = toPixel(basis, act.x ?? 0.5, act.y ?? 0.5)
    await page.mouse.move(x, y)
    await page.mouse.wheel({ deltaY: Math.max(-1200, Math.min(1200, Number(act.dy) || 0)) })
    trace(`在 ${x},${y}`, `dy=${Math.round(Number(act.dy) || 0)}`)
    return { ok: true }
  }

  throw new Error(`不支持的操作：${type}`)
}
