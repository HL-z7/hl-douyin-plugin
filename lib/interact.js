/**
 * 页面交互层：真鼠标 / 真键盘操作，配命中探针与合成事件兜底。
 *
 * 这套判据原先位于 lib/remote.js，只服务远程验证页面。但「点击是否真的到达 DOM」不是远程
 * 验证独有的问题：续火要点搜索结果里的「发消息」，自动登录要点抖音的「接收短信验证码」，
 * 三者走同一条链路，且以同样的方式静默失败。因此抽到本模块共用，remote.js 只保留它自己的
 * 坐标基准（前端画面与视口之间的换算）。
 *
 * 不直接使用现成 click 的原因：
 * - `el.click()` 只派发一个 click 事件，组件把响应挂在 pointerdown/mousedown 上时收不到；
 * - `elementHandle.click()` 走 CDP 的 Input 域，同一 tick 内 move→down→up，既没有 hover
 *   停顿也没有按住时间，抖音那套 React 组件有时走不完一轮判定；
 * - 两者都会「静默成功」：CDP 只保证事件已派发，不保证有元素接收。
 * 因此这里每次点击都附一圈探针，事件没进 DOM 就补一轮合成事件。
 *
 * 导出：viewportSize / ensureFocus / describeHit / PANEL_HINTS / noteField / approach
 * （基础能力与诊断），clickAt / typeText / pressKey（坐标级动作），visibleBox / clickHandle /
 * clickByText（元素级封装）。
 *
 * 依赖：util（sleep）、debug（debug / debugOn）。除此之外只用 puppeteer 的 page API 与页面内
 * 的 DOM API，不读配置、不落盘。
 *
 * 调用前提：传入的 page 必须仍未关闭（关闭后各函数只返回退化值，不抛错）。探针挂在
 * `window.__dyClickProbe`、上次点中的输入框记在 `window.__dyField`，两者都是页面级全局，
 * 因此同一页面上的点击与输入不可并发。
 */
import { sleep } from "./util.js"
import { debug, debugOn } from "./debug.js"

/**
 * 读取页面此刻真实的视口尺寸与滚动位置。
 *
 * 不直接用 `page.viewport()`：它只是 puppeteer 缓存的一份 setViewport 入参，页面真实的排版
 * 视口可能已经不是它了（老版本截图会临时修改设备度量）。截图与坐标换算必须使用同一基准，
 * 因此两侧都从本函数取值。
 *
 * 用 innerWidth/innerHeight 而非 documentElement.clientWidth：后者不含滚动条，而截图的像素宽
 * 与鼠标事件的坐标系都含滚动条。
 *
 * @param {import("puppeteer").Page} page
 * @returns {Promise<{width: number, height: number, scroll: {x: number, y: number}}>}
 *   evaluate 失败（页面正在导航或已关闭）时退回 page.viewport() 的缓存值，
 *   缓存也没有时用 1280x800，此时 scroll 恒为 0,0
 */
export async function viewportSize(page) {
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

/* ---------- 焦点模拟 ----------
 *
 * 无头浏览器没有窗口管理器，页面的 `document.hasFocus()` 长期为 false。多数点击不受影响，
 * 但有两类会：焦点相关的组件（输入框拿不到 caret），以及把 hasFocus 当作反自动化特征的脚本。
 *
 * CDP 的 `Emulation.setFocusEmulationEnabled` 正对应该场景：让渲染进程无条件认为自己已聚焦。
 * 它属于 CDP 侧的域，与 puppeteer 版本无关，但老内核上未必存在，失败一律忽略 —— 它是加分项，
 * 不是必要条件。
 *
 * 每个页面只执行一次，key 是 page，页面关闭后自动回收。
 */
const focused = new WeakSet()

/**
 * 为页面开启焦点模拟，每个页面只生效一次。
 *
 * @param {import("puppeteer").Page} page
 * @param {string} [scope="页面交互"] debug 日志的定位串
 * @returns {Promise<void>} 不抛错：bringToFront 与 CDP 调用失败都只记 debug 日志
 */
export async function ensureFocus(page, scope = "页面交互") {
  if (focused.has(page)) return
  focused.add(page)
  try {
    // 多标签时 Input 事件仍会送到本 target，但 bringToFront 同时把可见性摆正
    await page.bringToFront()
  } catch {}
  try {
    const cdp = await page.target().createCDPSession()
    await cdp.send("Emulation.setFocusEmulationEnabled", { enabled: true })
    debug(scope, "已开启焦点模拟（无头浏览器默认 document.hasFocus() 为 false）")
    // 不 detach：该开关是会话级的，会话断开即失效，需让它跟随页面存活
  } catch (error) {
    debug(scope, `焦点模拟开不了（不影响点击）：${error.message}`)
  }
}

/* ---------- 命中探针 ----------
 *
 * 「点击已送达、耗时 2ms、坐标核对无误，抖音弹窗无变化」这一现象在本侧日志中无法继续排查：
 * CDP 的 Input.dispatchMouseEvent 由浏览器进程受理并立即 ack，只保证事件已派发，不保证有元素
 * 接收。本节回答一个问题：该像素之下，页面自己识别出的是什么元素？
 *
 * 抖音的身份验证弹窗是 login.douyin.com 的 second_verification_web 组件，可能落在跨源 iframe
 * 中。跨源时主框架的 elementFromPoint 只会识别到 IFRAME 本身（已实测），因此必须逐框架查询，
 * 并减去每个框架自身的偏移。
 *
 * 只在 debug.enable 打开时执行：它要遍历所有框架，每个框架一次 evaluate。
 */

/**
 * 计算一个框架的左上角在主框架视口中的位置。
 *
 * `frame.frameElement()` 并非所有版本都有（本机 pnpm store 内 puppeteer-core 19.x 的两份都没有，
 * 21.11.0 与 23.10.1 有），缺失时在父框架里遍历 iframe，用 contentFrame() 判断哪一个是它。
 * boundingBox() 在两条路径下都返回主框架坐标系的值，因此嵌套多深都无需累加。
 *
 * @param {import("puppeteer").Frame} frame
 * @returns {Promise<{x: number, y: number}|null>} 主框架返回 0,0；框架已消失
 *   （导航中 / 被移除）或取不到 boundingBox 时返回 null
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
 * 报告某个像素之下的元素，逐框架穷举。仅诊断用，调用方需自行判断 debugOn()。
 *
 * @param {import("puppeteer").Page} page
 * @param {number} x 主框架视口像素
 * @param {number} y 主框架视口像素
 * @returns {Promise<string>} 每个命中的框架一行，用缩进换行拼成一条日志；
 *   全部框架都没识别出元素时返回 "(所有框架都没认出元素)"
 */
export async function describeHit(page, x, y) {
  const lines = []
  for (const frame of page.frames()) {
    const off = await frameOffset(frame)
    // 取不到偏移说明框架已消失（导航中 / 被移除），跳过
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
          // 向上取三层祖先：真正吃掉点击的常常是弹窗外面那层透明遮罩，
          // 只报最内层元素无法看出它位于谁的内部
          const chain = []
          for (let node = el, i = 0; node && i < 4; node = node.parentElement, i++) chain.push(desc(node))
          return {
            chain: chain.join(" < "),
            text: (el.textContent || "").replace(/\s+/g, " ").trim().slice(0, 24),
            pe: style.pointerEvents,
            vis: `${style.visibility}/${style.opacity}`,
            // 命中元素上是否有挂事件处理器的常见迹象
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
      // 框架在 evaluate 期间导航掉了，不属于本次要查的对象
    }
  }
  return lines.length ? lines.join("\n              ") : "(所有框架都没认出元素)"
}

/* ---------- 点击到达探针 ----------
 *
 * 命中探针只能证明「该像素之下确实是那个按钮」，无法回答后面三个问题，而现场恰好卡在这里：
 * 落点元素报出的就是「接收短信验证码」那一行，点击后画面无变化 —— 连遮罩与左上角返回箭头也
 * 同样点不动，说明不是该按钮的问题，而是整页都不接收点击。
 *
 * 本层要区分的三种可能：
 *   1. 事件未进入 DOM（浏览器进程受理了但未派发到渲染进程）
 *   2. 已进入，但落到的 clientX/clientY 不是发出的那个点
 *      —— `Input.dispatchMouseEvent` 的坐标要经过 visual viewport 换算，页面存在缩放或偏移时，
 *      它与 `elementFromPoint` 使用的布局坐标不是同一套
 *   3. 坐标也对，组件不响应（例如只认它自己那套合成事件）
 *
 * 因此点击前在 window 的**捕获阶段**挂一圈监听 —— 捕获位于整条派发链最前端，任何
 * stopPropagation 都挡不住，第 1 问由此得到确定答案；把事件自带的 clientX/clientY 记下与发出
 * 的坐标比对，第 2 问也有答案。再开一个 MutationObserver 观察组件是否响应，回答第 3 问 ——
 * React 只要 setState 就一定会改动 DOM。
 *
 * 这一圈不受 debug 开关控制：`forceClick` 那条兜底要依据它的结论决定是否出手。
 * 开销是点击前后各一次 evaluate，相比一次点击本身可忽略。
 */
const CLICK_PROBE_EVENTS = ["pointerdown", "mousedown", "mouseup", "click"]

/** 点击后等多久再读探针。留给 React 一轮渲染，过短会把「已响应」误判为「未响应」 */
const CLICK_PROBE_WAIT_MS = 350

/**
 * 识别「验证组件外壳」用的 id/class 关键词。
 *
 * 两处需要同一份：本模块的 MutationObserver 只观察验证组件那一块（遮罩背后的抖音页面仍在
 * 播放视频、轮播，观察整页则 DOM 变化永远不为 0，「组件是否响应」这一问永远无解，兜底也永远
 * 不会出手），以及 login.js 的 readSmsState 只读面板内的文本（读整页会把推荐流的视频时长当成
 * 倒计时）。
 *
 * 两处必须同源：一处识别出面板、另一处退回整页，读数就会互相矛盾 —— 探针报「组件未变化」而
 * 状态机报「已发送」，排查时无从下手。因此本常量 export 出去，不在 login.js 里复制第二份。
 *
 * 识别 id/class 中的语义词而非具体 class 名：抖音的 class 是混淆的（`list-AKRdS7` 这类），
 * 每次发版都变，而 `uc-second-verify`、`dialog` 这类词由框架给出，稳定得多。
 */
export const PANEL_HINTS = ["verify", "verification", "captcha", "dialog", "modal"]

/**
 * 在页面上挂好点击到达探针，须在真鼠标动作之前调用。
 *
 * 探针存放于 `window.__dyClickProbe`，由 readClick 读回并拆除。
 *
 * @param {import("puppeteer").Page} page
 * @param {number} x 视口像素，用于在无 target 时定位面板外壳
 * @param {number} y 视口像素
 * @param {import("puppeteer").ElementHandle} [target] 本次要点的元素。传入后探针额外判定
 *   「目标元素是否收到事件」（probe.onTarget），未传时该字段为 null
 * @returns {Promise<void>} 不抛错：页面正在导航或已关闭时静默跳过
 */
async function watchClick(page, x, y, target) {
  try {
    await page.evaluate(
      (types, hints, px, py, goal) => {
        const probe = { events: [], mutations: 0, sample: "", onTarget: goal ? false : null }
        window.__dyClickProbe = probe
        // SVG 元素的 className 是对象而非字符串，一律走 getAttribute
        const name = el => {
          if (!el || !el.tagName) return "?"
          const cls = String(el.getAttribute?.("class") || "").trim().split(/\s+/)[0]
          return el.tagName.toLowerCase() + (el.id ? `#${el.id}` : "") + (cls ? `.${cls}` : "")
        }
        probe.off = types.map(type => {
          const fn = e => {
            // 记下事件自报的坐标：与发出的坐标不一致即说明坐标空间不匹配
            probe.events.push(`${type}@${Math.round(e.clientX)},${Math.round(e.clientY)}→${name(e.target)}`)
            /*
             * 事件到达 DOM 不等于到达目标元素。被同一块面板内其它层遮挡时，真鼠标点在遮挡层
             * 上，事件照样冒泡到 window —— 探针若只统计「有无事件」，这种「点错元素」会被读成
             * 「已点到」，兜底就不会出手。
             */
            if (goal && (e.target === goal || goal.contains(e.target) || e.target.contains(goal)))
              probe.onTarget = true
          }
          window.addEventListener(type, fn, true)
          return () => window.removeEventListener(type, fn, true)
        })

        // 从落点向上查找验证组件外壳，找不到则退回整页（此时读数偏噪，但仍优于没有）
        let root = document.documentElement
        const hit = goal || document.elementFromPoint(px, py)
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

        // 一次性的环境读数，用于判掉「页面无焦点」与「视口被缩放/偏移」
        const vv = window.visualViewport
        probe.env =
          `焦点=${document.hasFocus() ? "有" : "⚠ 无"} 可见性=${document.visibilityState}` +
          (vv
            ? ` 视觉视口=${Math.round(vv.width)}x${Math.round(vv.height)}` +
              ` 缩放=${vv.scale} 偏移=${Math.round(vv.offsetLeft)},${Math.round(vv.offsetTop)}`
            : "")
      },
      CLICK_PROBE_EVENTS,
      PANEL_HINTS,
      Math.round(x),
      Math.round(y),
      target || null
    )
  } catch {
    // 页面正在导航 / 已关闭。探针挂不上就跳过，诊断代码不能影响正常操作
  }
}

/**
 * 读回并拆除探针。
 *
 * @param {import("puppeteer").Page} page
 * @returns {Promise<{events: string[], mutations: number, onTarget: boolean|null, line: string}
 *   | null>} 探针不存在（未挂上）或 evaluate 失败时返回 null。onTarget 为 null 表示
 *   watchClick 未收到 target，无法判断落点是否正确；line 是拼好的单行日志
 */
async function readClick(page) {
  try {
    const r = await page.evaluate(() => {
      const p = window.__dyClickProbe
      if (!p) return null
      p.off?.forEach(f => f())
      p.mo?.disconnect()
      delete window.__dyClickProbe
      return {
        events: p.events,
        mutations: p.mutations,
        sample: p.sample,
        scope: p.scope,
        env: p.env,
        onTarget: p.onTarget,
      }
    })
    if (!r) return null
    return {
      events: r.events,
      mutations: r.mutations,
      onTarget: r.onTarget,
      line:
        `到达 DOM 的事件 ${r.events.length ? r.events.join(" ") : "⚠ 一个都没有"}` +
        (r.onTarget === null ? "" : r.onTarget ? " / 目标元素收到了" : " / ⚠ 目标元素没收到") +
        ` / ${r.scope} 内 DOM 变化 ${r.mutations} 处${r.sample ? `（首条 ${r.sample}）` : ""}` +
        `${r.env ? ` / ${r.env}` : ""}`,
    }
  } catch {
    return null
  }
}

/**
 * 兜底：真鼠标点击无响应时，在落点元素上补一轮合成事件。
 *
 * 保留该退路的原因：真鼠标事件从浏览器进程到渲染进程要经过一串坐标换算与命中测试，中间任何
 * 一环不匹配，本侧看到的都只是「静默成功」。而用户正在等待通过验证，不能因为该链路上某个环节
 * 不通就使整个功能不可用。
 *
 * 这不构成「执行任意脚本」的入口：作用对象要么是调用方持有的 ElementHandle，要么是刚点击的
 * 坐标之下的元素（由页面自身的 elementFromPoint 决定）。两种情况下调用方都无法传入选择器或
 * 代码。
 *
 * `target` 参数来自现场问题：抖音的「获取验证码」被同一块面板内的 `div.list-AKRdS7` 遮挡，
 * 坐标之下的元素并非它，于是本兜底把整轮合成事件补在了遮挡层上 —— 日志报「已补合成」，页面
 * 无变化。既然点击对象是元素而非坐标，就应直接派发到该元素，不再经 elementFromPoint 二次
 * 判定。
 *
 * 合成事件的 `isTrusted` 为 false。React 不检查该字段，其 onClick 照常触发；只认可信事件的
 * 组件本兜底无法覆盖，那种情况会在日志中留下痕迹。
 *
 * @param {import("puppeteer").Page} page
 * @param {number} x 视口像素，未传 target 时用于 elementFromPoint，并作为事件的 clientX
 * @param {number} y 视口像素
 * @param {import("puppeteer").ElementHandle} [target] 直接派发到这个元素上
 * @returns {Promise<string>} 供日志使用的一句结论。落点已无元素或 evaluate 抛错时返回
 *   对应的说明串，不抛出
 */
async function forceClick(page, x, y, target) {
  let handle = target
  let own = false
  try {
    if (!handle) {
      handle = await page.evaluateHandle(
        ([px, py]) => document.elementFromPoint(px, py),
        [Math.round(x), Math.round(y)]
      )
      own = true
    }
    return await handle.evaluate(
      (el, px, py) => {
        if (!el) return "落点已经没有元素了"
        const base = { bubbles: true, cancelable: true, composed: true, clientX: px, clientY: py, view: window }
        const pointer = { ...base, pointerId: 1, pointerType: "mouse", isPrimary: true, button: 0, buttons: 1 }
        el.dispatchEvent(new PointerEvent("pointerdown", pointer))
        el.dispatchEvent(new MouseEvent("mousedown", { ...base, button: 0, buttons: 1 }))
        el.dispatchEvent(new PointerEvent("pointerup", { ...pointer, buttons: 0 }))
        el.dispatchEvent(new MouseEvent("mouseup", { ...base, button: 0, buttons: 0 }))
        el.dispatchEvent(new MouseEvent("click", { ...base, button: 0, buttons: 0, detail: 1 }))
        const cls = String(el.getAttribute?.("class") || "").trim().split(/\s+/)[0]
        const tag = el.tagName?.toLowerCase() || "?"
        return `已在 ${tag}${el.id ? `#${el.id}` : ""}${cls ? `.${cls}` : ""} 上补发合成事件`
      },
      Math.round(x),
      Math.round(y)
    )
  } catch (error) {
    return `补发失败：${error.message}`
  } finally {
    if (own) await handle?.dispose?.().catch(() => {})
  }
}

/* ---------- 输入框：焦点与到达 ----------
 *
 * 点击兜底解决的只是「按钮被按到」，输入还差一步。
 *
 * `page.keyboard.type()` 走 `Input.dispatchKeyEvent`，与鼠标同一条通道 —— 鼠标事件到不了 DOM
 * 的现场，键盘事件同样到不了。更麻烦的是键盘事件没有坐标，只往「当前有焦点的元素」派发，因此
 * 输入之前必须先确认焦点确实落在输入框内。
 *
 * 现场日志中这两件事是叠加的：点击 `input#button-input` 时探针报「到达 DOM 的事件 ⚠ 一个都
 * 没有」—— 焦点未转移；紧接着 `动作 type 6 字` 却报成功，因为 CDP 确实派发了六个按键，只是
 * 没有接收者。因此本层做两件事：点击输入框时把焦点设入（noteField），以及输入后回读内容是否
 * 真的写进去了（watchKeys/readKeys）。
 */

/** 输入类元素：三种形态都要识别。抖音的验证码框是 input，但滑块提示区用过 contenteditable */
const FIELD_SELECTOR = "input,textarea,[contenteditable]"

/**
 * 点击落在输入框上时设入焦点，并把该元素记在页面上供 type 兜底取用。
 *
 * 不等真鼠标自行带入焦点的原因：焦点由浏览器在处理 mousedown 默认行为时给出，而现场那条链路
 * mousedown 未到达 DOM。`el.focus()` 是页面自身的 API，不经过输入事件通道，因此这条路可用 ——
 * 这也是它不放在 forceClick 兜底里、而是无条件执行的原因：点击输入框时置入光标本就是这次点击
 * 应有的结果。
 *
 * 记入的元素存放于 `window.__dyField`，供 forceType / forceKey 在焦点被抢走时回退使用。
 *
 * @param {import("puppeteer").Page} page
 * @param {number} x 视口像素，未传 target 时用于 elementFromPoint
 * @param {number} y 视口像素
 * @param {import("puppeteer").ElementHandle} [target] 本次点击的元素。有它时优先从它自身查找
 *   输入框（它被其它层遮挡时 elementFromPoint 识别到的是遮挡层，焦点会设入不相干的元素）
 * @returns {Promise<string>} 形如 `input#button-input 已聚焦` 的一句结论；落点不是输入框
 *   （绝大多数点击）或 evaluate 抛错时返回空串
 */
export async function noteField(page, x, y, target) {
  let handle = target
  let own = false
  try {
    if (!handle) {
      handle = await page.evaluateHandle(
        ([px, py]) => document.elementFromPoint(px, py),
        [Math.round(x), Math.round(y)]
      )
      own = true
    }
    return await handle.evaluate((hit, selector) => {
      // 落点可能是输入框内的图标或 placeholder 层，向上一层才是真正的输入元素；
      // 也可能是包含输入框的那一格（按文本查找时常得到这种），因此再向下查找一次
      const field = hit?.matches?.(selector)
        ? hit
        : hit?.closest?.(selector) || hit?.querySelector?.(selector)
      if (!field) return ""
      window.__dyField = field
      if (document.activeElement !== field) {
        try {
          // preventScroll：抖音这个弹窗是 position: fixed，聚焦引发页面滚动会改变坐标基准
          field.focus({ preventScroll: true })
        } catch {
          field.focus()
        }
      }
      const tag = field.tagName.toLowerCase() + (field.id ? `#${field.id}` : "")
      return `${tag}${document.activeElement === field ? " 已聚焦" : " ⚠ 聚焦没生效"}`
    }, FIELD_SELECTOR)
  } catch {
    return ""
  } finally {
    if (own) await handle?.dispose?.().catch(() => {})
  }
}

/**
 * 输入前记录基线：焦点在哪个元素上、它当前的内容长度。
 *
 * 判断「字符是否写入」不能看 CDP 的返回值（它只报「按键已派发」），只能看输入框的 value 前后
 * 是否变化。因此输入前后各读一次，中间那串按键是真的写入还是无接收者，比对即知。
 *
 * @param {import("puppeteer").Page} page
 * @returns {Promise<{name: string, length: number}|null>} name 是焦点元素的
 *   `tag#id`，无焦点元素时为 "(无)"；length 是内容字数，焦点元素不是输入类时为 -1。
 *   evaluate 失败返回 null
 */
async function watchKeys(page) {
  try {
    return await page.evaluate(selector => {
      const el = document.activeElement
      const field = el?.matches?.(selector) ? el : null
      return {
        // 无焦点元素时 activeElement 是 body，这本身就是「输入无接收者」的信号
        name: el ? el.tagName.toLowerCase() + (el.id ? `#${el.id}` : "") : "(无)",
        // 只记长度不记内容：其中可能是短信验证码
        length: field ? String(field.value ?? field.textContent ?? "").length : -1,
      }
    }, FIELD_SELECTOR)
  } catch {
    return null
  }
}

/**
 * 输入后再读一次内容长度，与 watchKeys 的读数比对。
 *
 * @param {import("puppeteer").Page} page
 * @returns {Promise<number>} 字数；焦点元素不是输入类或 evaluate 失败时为 -1
 */
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
 * 兜底：真键盘未写入内容时，直接改输入框的值并补一轮输入事件。
 *
 * 三处不能省的细节，缺一处 React 就不承认这次输入：
 *
 * 1. **用原型上的 value setter 写值**。React 把 input 的 value 属性劫持为自己的，直接
 *    `el.value = x` 只会写到 React 的副本，其内部记录（_valueTracker）不变，随后的 input
 *    事件会被判定为「值未变化」而丢弃。需用
 *    `Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value").set`
 *    绕过劫持，写到真正的 DOM 属性上。
 * 2. **用 InputEvent 而非 Event**。React 17+ 依据 `data` / `inputType` 区分输入种类，普通
 *    Event 在部分受控组件里取不到值。
 * 3. **一个字符一轮**，而非整串一次写入。抖音的验证码框每满一位就判定一次（满 6 位自动
 *    提交），整串写入时它只能看到最后一次变化，中间几步状态被跳过。
 *
 * 与 forceClick 相同，这不构成「执行任意脚本」的入口：作用对象是页面自身认定的 activeElement
 * （或上一次点击落入的输入框），调用方无法传入选择器或代码。
 *
 * @param {import("puppeteer").Page} page
 * @param {string} text 要写入的内容，逐字符派发
 * @returns {Promise<string>} 供日志使用的一句结论。找不到输入框或 evaluate 抛错时返回对应
 *   的说明串，不抛出
 */
async function forceType(page, text) {
  try {
    return await page.evaluate(
      ([str, selector]) => {
        // 优先用当前焦点；焦点被其它元素抢走时退回上次点中的输入框
        const active = document.activeElement
        const field = active?.matches?.(selector) ? active : window.__dyField
        if (!field || !field.isConnected) return "找不到输入框（先在画面上点一下输入框）"
        try {
          field.focus({ preventScroll: true })
        } catch {}

        const editable = field.isContentEditable
        // 取原型链上真正的 setter：input 与 textarea 各有一份，React 劫持的是实例属性
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
        // change 只在「值确定」时派发一次。部分组件只监听 change 不监听 input
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
 * 兜底：按键的合成事件。
 *
 * Enter / Escape / 方向键这类只需补发 KeyboardEvent；Backspace 与 Delete 要连值一起改，因为
 * 「删除一个字符」是浏览器处理按键默认行为时完成的，而合成事件没有默认行为。
 *
 * keyCode / which 一并带上：抖音的代码中存在按 keyCode 判断的老写法，只给 key 会漏。
 */
const KEY_CODES = { Enter: 13, Backspace: 8, Tab: 9, Escape: 27, ArrowLeft: 37, ArrowRight: 39, Delete: 46 }

/**
 * 在焦点元素上补发一个功能键的合成事件。
 *
 * @param {import("puppeteer").Page} page
 * @param {string} key 键名，需为 KEY_CODES 中的一项；不在表中时 keyCode 传 0，事件仍会派发
 * @returns {Promise<string>} 供日志使用的一句结论。evaluate 抛错时返回说明串，不抛出
 */
async function forceKey(page, key) {
  try {
    return await page.evaluate(
      ([name, code, selector]) => {
        const active = document.activeElement
        const field = active?.matches?.(selector) ? active : window.__dyField
        const target = field?.isConnected ? field : document.activeElement || document.body
        const init = { key: name, code: name, keyCode: code, which: code, bubbles: true, cancelable: true, composed: true }
        target.dispatchEvent(new KeyboardEvent("keydown", init))

        // 删除键需自行移除字符：合成事件没有默认行为，只派发按键不会改变值
        if ((name === "Backspace" || name === "Delete") && field?.isConnected) {
          const editable = field.isContentEditable
          const cur = String((editable ? field.textContent : field.value) ?? "")
          // 光标位置在合成事件中不可靠，一律按「删除末位字符」处理 —— 验证码框足够用
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
 * 分步移动鼠标到目标点。
 *
 * `page.mouse.move(x, y)` 一步到位只产生**一个** mousemove，而真人靠近按钮时是一串。有的组件
 * 把响应挂在 hover 之后才建立的状态上，有的反自动化检测直接检查这串移动是否存在。`steps` 是
 * puppeteer 自带参数（各版本都有），无需自行拆分。
 *
 * 起点取目标点左上方 24x18 像素处，并 clamp 在视口内 —— 按钮贴边时不能移到负坐标。
 *
 * @param {import("puppeteer").Page} page
 * @param {number} x 目标点视口像素
 * @param {number} y 目标点视口像素
 * @param {{width: number, height: number}} vp 视口尺寸，用于 clamp 起点
 * @returns {Promise<void>}
 */
export async function approach(page, x, y, vp) {
  const sx = Math.max(0, Math.min(vp.width - 1, x - 24))
  const sy = Math.max(0, Math.min(vp.height - 1, y - 18))
  await page.mouse.move(sx, sy)
  await page.mouse.move(x, y, { steps: 6 })
}

/** hover 建立到按下之间的停顿，留给组件一帧时间挂上处理器 */
const HOVER_MS = 90

/**
 * 按下与松开之间的停顿。
 *
 * puppeteer 的 `mouse.click` 默认 down→up 在同一 tick 内，间隔 0ms —— 真人点击是 50~120ms。
 * 有的组件在 mousedown 中建立状态、mouseup 时才判定，间隔 0 时该状态尚未建立完成；反自动化
 * 检测也会把这个间隔当作特征。
 */
const CLICK_HOLD_MS = 70

/* ---------- 对外的三个动作 ---------- */

/**
 * 在视口像素坐标上点击一次，附命中探针与合成事件兜底。
 *
 * @param {import("puppeteer").Page} page
 * @param {number} x 视口像素
 * @param {number} y 视口像素
 * @param {object} [opts]
 * @param {object} [opts.vp] 已知的视口尺寸，省一次 evaluate
 * @param {string} [opts.scope] debug 日志的定位串
 * @param {boolean} [opts.dbl] 双击
 * @param {boolean} [opts.focusField=true] 落点是输入框时设入焦点
 * @param {import("puppeteer").ElementHandle} [opts.handle] 本次点击的元素。有它时兜底的合成
 *   事件直接派发到它身上，不再经 elementFromPoint 判定 —— 坐标之下被其它层遮挡时，那次判定
 *   会取错元素（见 forceClick 的说明）
 * @returns {Promise<{arrived: boolean, mutations: number, forced: string, field: string,
 *   line: string}>} arrived 表示事件是否到达目标（传了 handle 时按目标元素判，否则按「有无
 *   事件进入 DOM」判）；mutations 是探针窗口内的 DOM 变化数，探针未挂上时为 -1；forced 为空
 *   串表示未走兜底；field 为空串表示落点不是输入框；line 是探针的单行日志
 */
export async function clickAt(page, x, y, opts = {}) {
  const scope = opts.scope || "页面交互"
  const vp = opts.vp || (await viewportSize(page))
  await ensureFocus(page, scope)

  /*
   * 点击拆成「靠近 → 停顿 → 按下 → 停顿 → 松开」，而不是 page.mouse.click 一次调用。
   *
   * mouse.click 内部是同一 tick 内 move→down→up：只有一个 mousemove，按下与松开间隔 0ms。
   * 抖音那些 React 组件把响应挂在 hover 之后才建立的状态上，而 0ms 的按下-松开在很多组件里
   * 走不完一轮判定，同时也是最典型的自动化特征。这里补上真人点击的三个特征：一串移动、hover
   * 停顿、按住 70ms。代价是每次点击多 160ms。
   */
  await approach(page, x, y, vp)
  await sleep(HOVER_MS)

  // 点击前先查明该像素之下是什么元素 —— 这是区分「点空」与「点中但组件不响应」的唯一手段，
  // 日志中那句 `耗时 2ms` 在两种情况下完全相同
  const hit = debugOn() ? await describeHit(page, x, y) : ""
  // 事件是否进入 DOM、是否到达目标元素、组件是否响应，这三问只有探针能回答，
  // 而下面的兜底要依据其结论决定是否出手，因此它不随 debug 开关走
  await watchClick(page, x, y, opts.handle)

  /*
   * 一次按下-松开。clickCount 必须一路带着：浏览器依据它区分单击与双击，第二次必须是 2，
   * 否则页面收到的是两次独立单击而不是一次 dblclick。
   */
  const press = async count => {
    await page.mouse.down({ clickCount: count })
    await sleep(CLICK_HOLD_MS)
    await page.mouse.up({ clickCount: count })
  }
  await press(1)
  if (opts.dbl) {
    // 两次之间的间隔要短于系统双击阈值（普遍 500ms），60ms 落在阈值内
    await sleep(60)
    await press(2)
  }
  if (hit) debug(scope, `  落点元素：${hit}`)

  // 等一轮渲染再读：过早读取会把「组件正在处理」误判为「组件未响应」
  await sleep(CLICK_PROBE_WAIT_MS)
  const probe = await readClick(page)
  if (probe) debug(scope, `  ${probe.line}`)

  /*
   * 真鼠标这一次未落到应落之处 —— 补一轮合成事件。
   *
   * 判据历经三版，每版修掉前一版的一个盲区：
   *
   * v1「DOM 是否变化」：抖音验证码框旁有「49s后重新发送」倒计时，它每秒修改 input 的属性，
   *    于是面板内永远有变化，兜底永远不出手。
   * v2「事件是否进入 DOM」：修掉了倒计时的干扰，但引入一个更隐蔽的问题 —— 事件进入 DOM 不等于
   *    进入目标元素。现场那次「获取验证码」被同一块面板内的选项列表整块遮挡，真鼠标点在遮挡层
   *    上，事件照样冒泡到 window，于是探针报「已到 DOM」、兜底不出手、页面无变化，三行日志全部
   *    显示成功。
   * v3（当前）：传入 handle 时直接判定「目标元素是否收到」。
   *
   * 目标元素确实收到时不再补发：那一次确实点在它身上，React 的 onClick 已触发，再补一轮属于
   * 重复。这对「获取验证码」尤其重要 —— 抖音对同一手机号有频率限制，而它的倒计时要等接口返回
   * 才启动，350ms 的探针窗口内 mutations 常常仍为 0，按 v2 的判据会多发一条短信。
   *
   * 未传 handle（远程验证那条路只有坐标）时无从判断落点是否正确，维持 v2 的判据。
   */
  const arrived = probe?.onTarget != null ? probe.onTarget : Boolean(probe && probe.events.length)
  let forced = ""
  if (probe && !arrived) {
    forced = await forceClick(page, x, y, opts.handle)
    debug(scope, `  真鼠标没点到目标，已补合成事件：${forced}`)
  } else if (probe && probe.onTarget == null && probe.mutations === 0) {
    forced = await forceClick(page, x, y)
    debug(scope, `  事件到了但组件没动，已补合成事件：${forced}`)
  }

  /*
   * 落点是输入框时设入焦点。
   *
   * 焦点由浏览器处理 mousedown 默认行为时给出，而这条链路 mousedown 到不了 DOM —— 于是
   * 「点击输入框」看起来成功了，光标却未进入，紧接着的输入没有接收者。这是现场「验证码输不
   * 进去」的直接成因。放在兜底之后执行：兜底那轮合成事件可能已带入焦点，此处只是确保结果
   * 一定成立。
   */
  const field = opts.focusField === false ? "" : await noteField(page, x, y, opts.handle)
  if (field) debug(scope, `  落点是输入框：${field}`)

  return {
    arrived,
    mutations: probe?.mutations ?? -1,
    forced,
    field,
    line: probe?.line || "(探针没挂上)",
  }
}

/**
 * 往当前焦点元素输入文本，真键盘写不进去则补合成输入。
 *
 * @param {import("puppeteer").Page} page
 * @param {string} text 要输入的内容，空串直接返回
 * @param {object} [opts]
 * @param {string} [opts.scope] debug 日志的定位串
 * @param {number} [opts.delay=60] 按键间隔（毫秒），传给 page.keyboard.type
 * @returns {Promise<{grew: boolean, forced: string, focus: string}>} grew 表示真键盘是否让
 *   内容长度发生变化；forced 为空串表示未走兜底；focus 是输入前的焦点元素名
 */
export async function typeText(page, text, opts = {}) {
  const scope = opts.scope || "页面交互"
  const str = String(text ?? "")
  if (!str) return { grew: false, forced: "", focus: "" }

  // 输入前记录焦点元素与已有字数，输入后再读一次 —— CDP 只报「按键已派发」，
  // 字符是否落入输入框只能靠这次前后比对判断
  const before = await watchKeys(page)
  // delay 使输入接近人工节奏，抖音的部分输入框会监听 keydown 频率
  await page.keyboard.type(str, { delay: opts.delay ?? 60 })
  const after = await readKeys(page)

  /*
   * 真键盘未让内容长度变化 —— 补一轮合成输入。
   *
   * 三种情况都会走到这里，而它们在用户眼中完全相同（输入框始终为空）：
   *   1. 焦点不在输入框上（点击输入框那一次未能置入光标）
   *   2. 焦点正确，但 `Input.dispatchKeyEvent` 与鼠标一样进不了 DOM
   *   3. 两者都正确，但组件拦截了输入
   * 判据用「长度是否变化」而非「等于预期长度」：验证码框满 6 位会自动提交并清空，此时长度可能
   * 回到 0，但内容确实写入过 —— 因此只在「完全未变」时补发。
   */
  const grew = Boolean(before && after >= 0 && after !== before.length)
  let forced = ""
  if (!grew) {
    forced = await forceType(page, str)
    debug(scope, `  真键盘没让内容变化（焦点=${before?.name || "?"}），已补合成输入：${forced}`)
  }
  return { grew, forced, focus: before?.name || "" }
}

/**
 * 按一个功能键，真键盘与合成事件各执行一遍。
 *
 * 不做「先试真键盘、失败再补」的原因：按键的效果无法判定 —— Enter 是提交（页面自行跳转，输入框
 * 内容不变）、Escape 是关闭弹窗、方向键只移动光标，都没有一个「前后比对即知成败」的读数。而这
 * 几个键重复一次的代价很低（Enter 最多多提交一次，抖音侧幂等），漏掉一次的代价是用户点击无
 * 响应、只能等待超时。删除键例外：重复会多删一个字符，因此按内容变化判定。
 *
 * @param {import("puppeteer").Page} page
 * @param {string} key 键名，取值由调用方（remote.js 的 ALLOWED_KEYS）约束
 * @param {object} [opts]
 * @param {string} [opts.scope] debug 日志的定位串
 * @returns {Promise<{forced: string}>} forced 为空串表示未补发合成按键（仅 Backspace /
 *   Delete 且真键盘已生效时出现）
 */
export async function pressKey(page, key, opts = {}) {
  const scope = opts.scope || "页面交互"
  const before = key === "Backspace" || key === "Delete" ? await watchKeys(page) : null
  await page.keyboard.press(key)
  let forced = ""
  if (before) {
    const after = await readKeys(page)
    if (after === before.length) forced = await forceKey(page, key)
  } else forced = await forceKey(page, key)
  if (forced) debug(scope, `  已补合成按键 ${key}：${forced}`)
  return { forced }
}

/* ---------- 元素级封装 ----------
 *
 * 上面三个动作都接收视口像素坐标（远程验证由前端递来的就是坐标）。而插件内部自动点击按钮时
 * 持有的是 ElementHandle 或一段文本，因此这里补一层：把元素换算为中心点坐标，再走同一条链路。
 * 不直接用 `elementHandle.click()` 的原因见文件头。
 */

/**
 * 读取元素当前在视口中的位置与尺寸，顺带将其滚入视口，并做一次命中测试。
 *
 * 不直接用 `handle.boundingBox()`：它对 `display:none` 返回 null，但对「位于滚动容器之外」的
 * 元素返回视口外坐标，点上去会落在别的元素上。因此自行读取 rect，并把「是否在视口内」一并
 * 判定。
 *
 * 仅有 rect 仍不够 —— 现场那次失败正在此处：「获取验证码」按钮 rect 正常、尺寸正常、样式可见，
 * 但其几何中心之下是同一块面板内的 `div.list-AKRdS7`（当前步骤的选项列表压在它上面）。于是真
 * 鼠标点到了遮挡层，探针报「事件一个都没到」，合成事件也补在了遮挡层上，日志三行全部显示
 * 成功，页面无变化。
 *
 * 因此追加一步 `elementFromPoint`：中心点被遮挡时，在 rect 内部再试八个点（四个 25%/75% 交点
 * 加四条边的内侧中点）。有一个命中即采用 —— 按钮被遮挡一半是常见版面，整块被遮挡才是真的点
 * 不到。全部命中失败则标出 `occluded`，让调用方知道「元素存在但无法点击」，而不是照中心点盲点
 * 一次。
 *
 * @param {import("puppeteer").ElementHandle} handle
 * @returns {Promise<{x: number, y: number, cx: number, cy: number, w: number, h: number,
 *   occluded: boolean, top: string} | null>} x/y 是 rect 左上角，cx/cy 是建议点击的坐标
 *   （命中成功时为命中的那个点，失败时为几何中心），top 是命中处最上层元素的
 *   `tag#id.class`。handle 为空、尺寸小于 1px、样式不可见、中心点在视口外或 evaluate 抛错
 *   时返回 null
 */
export async function visibleBox(handle) {
  if (!handle) return null
  try {
    return await handle.evaluate(el => {
      // block:center 而非默认的 start：贴视口上沿的元素常被顶栏遮住
      el.scrollIntoView?.({ block: "center", inline: "nearest" })
      const r = el.getBoundingClientRect()
      if (!r || r.width < 1 || r.height < 1) return null
      const st = getComputedStyle(el)
      if (st.visibility === "hidden" || st.display === "none" || Number(st.opacity) === 0) return null
      const cx = r.left + r.width / 2
      const cy = r.top + r.height / 2
      if (cx < 0 || cy < 0 || cx > innerWidth || cy > innerHeight) return null

      const name = node => {
        if (!node || !node.tagName) return "?"
        const cls = String(node.getAttribute?.("class") || "").trim().split(/\s+/)[0]
        return node.tagName.toLowerCase() + (node.id ? `#${node.id}` : "") + (cls ? `.${cls}` : "")
      }
      /*
       * 命中判定 —— 满足以下三种情况之一即算「点这里等于点它」：
       *   - 最上层就是它自己
       *   - 最上层是它的后代（按钮内的 <span>、图标层，点击照样冒泡到它）
       *   - 最上层是它的祖先（它自身 pointer-events: none，但整块可点，
       *     例如纯文字层套在一个 clickable 容器内）
       */
      const ok = top => Boolean(top && (top === el || el.contains(top) || top.contains(el)))
      // 边上的点向内缩 2px：正好压在边框上时，命中的常常是外层容器
      const inset = 2
      const pts = [
        [cx, cy],
        [r.left + r.width * 0.25, r.top + r.height * 0.25],
        [r.left + r.width * 0.75, r.top + r.height * 0.25],
        [r.left + r.width * 0.25, r.top + r.height * 0.75],
        [r.left + r.width * 0.75, r.top + r.height * 0.75],
        [cx, r.top + inset],
        [cx, r.bottom - inset],
        [r.left + inset, cy],
        [r.right - inset, cy],
      ]
      let top0 = ""
      for (const [px, py] of pts) {
        if (px < 0 || py < 0 || px > innerWidth || py > innerHeight) continue
        const top = document.elementFromPoint(px, py)
        if (!top0) top0 = name(top)
        if (ok(top))
          return { x: r.left, y: r.top, cx: px, cy: py, w: r.width, h: r.height, occluded: false, top: name(top) }
      }
      // 一个点都命中不了：坐标仍返回中心点（调用方可能只需要位置），但标明被遮挡
      return { x: r.left, y: r.top, cx, cy, w: r.width, h: r.height, occluded: true, top: top0 }
    })
  } catch {
    return null
  }
}

/**
 * 点击一个 ElementHandle，走 clickAt 那条链路。
 *
 * handle 一路传给 clickAt：兜底的合成事件要派发到**这个元素**身上，而不是坐标之下那个（被遮挡
 * 时两者不是同一个元素，详见 forceClick 与 visibleBox 的说明）。
 *
 * @param {import("puppeteer").Page} page
 * @param {import("puppeteer").ElementHandle} handle
 * @param {object} [opts] 透传给 clickAt（scope / vp / dbl / focusField）
 * @returns {Promise<{ok: boolean, reason: string, arrived?: boolean, mutations?: number,
 *   forced?: string, field?: string, line?: string, box?: object}>} visibleBox 返回 null
 *   （元素不可见或不在视口内）时 ok 为 false 且不含 clickAt 的字段；元素被遮挡时仍会点击，
 *   只记一条 debug 日志
 */
export async function clickHandle(page, handle, opts = {}) {
  const box = await visibleBox(handle)
  if (!box) return { ok: false, reason: "元素不可见或不在视口内" }
  if (box.occluded)
    debug(opts.scope || "页面交互", `  元素被 ${box.top} 压住，真鼠标点不到它，只能靠合成事件`)
  const r = await clickAt(page, box.cx, box.cy, { ...opts, handle })
  return { ok: true, reason: "", ...r, box }
}

/**
 * 按文本查找一个可见元素并点击它。
 *
 * 取「最内层的匹配」的原因：`querySelectorAll("*")` 中，一个按钮的每一层祖先的 textContent 都
 * 包含那段文字，取到外层就会点在整块面板的几何中心 —— 那里往往是别的元素。因此先收集全部匹配，
 * 再剔除「仍有后代也匹配」的那些。
 *
 * 仅剔除包装元素还不够。宽松正则（`/接收短信验证码|短信验证码登录/` 这类）会命中**同时包含两个
 * 选项的那一格**：它的 textContent 是两行拼接的（"接收短信验证码发送短信验证"），没有任何后代能
 * 整段匹配，于是它自身就是最内层，而它的几何中心正落在两行之间的空隙上 —— 点击落空。因此在
 * 「最内层」之后再向内收一次（narrow），并在若干候选中挑一个确实点得到的（命中测试）。
 *
 * @param {import("puppeteer").Page} page
 * @param {RegExp} re 匹配 trim 并压缩空白后的整段文本
 * @param {object} [opts] 其余字段透传给 clickHandle
 * @param {import("puppeteer").ElementHandle} [opts.root] 只在这个元素内部查找
 * @param {string} [opts.scope] debug 日志的定位串
 * @param {boolean} [opts.hover] 先把鼠标移到 root 上再查找（按钮 hover 才出现时用）
 * @param {object} [opts.vp] 已知的视口尺寸，仅 hover 分支用到
 * @returns {Promise<{ok: boolean, reason: string, text: string, arrived?: boolean,
 *   forced?: string, box?: object}>} text 是命中元素的前 24 个字符。没有匹配元素、
 *   或标记后取不到 handle（页面刚重渲染）时 ok 为 false
 */
export async function clickByText(page, re, opts = {}) {
  const scope = opts.scope || "页面交互"
  const attr = "data-dy-click"
  const root = opts.root || null

  // 按钮只在 hover 时出现的版面：先把鼠标移到容器上，再查找
  if (opts.hover && root) {
    const rootBox = await visibleBox(root)
    if (rootBox) {
      await approach(page, rootBox.cx, rootBox.cy, opts.vp || (await viewportSize(page)))
      await sleep(HOVER_MS)
    }
  }

  /*
   * 标记与取 handle 分两步，中间靠属性对应。
   *
   * 不在 evaluate 内直接返回元素：跨 evaluate 传 DOM 节点只能靠 JSHandle，而这段代码要在
   * 「主页面」与「某个结果项内部」两种范围下复用，走属性最简。范围通过参数传入（puppeteer 支持
   * 把 ElementHandle 作为 evaluate 入参，null 表示整页）。
   */
  const found = await page
    .evaluate(
      (source, flags, sel, scopeEl) => {
        const test = new RegExp(source, flags)
        const norm = el => (el.textContent || "").replace(/\s+/g, " ").trim()
        const base = scopeEl || document
        document.querySelectorAll(`[${sel}]`).forEach(el => el.removeAttribute(sel))
        const hits = [...base.querySelectorAll("*")].filter(el => test.test(norm(el)))
        // 只留最内层：有后代也匹配的说明它只是包装，点它会落在整块面板的几何中心
        const leaves = hits.filter(el => !hits.some(other => other !== el && el.contains(other)))

        /*
         * 再向内收一次：取正则真正匹配到的那截文本，在这一格内部找「自身文本包含这截」的最小
         * 元素。元素文本本就恰好是那截时原样返回（绝大多数按钮属于此类）。
         */
        const narrow = el => {
          const text = norm(el)
          const m = test.exec(text)
          if (!m || !m[0] || m[0] === text) return el
          const inner = [...el.querySelectorAll("*")].filter(node => norm(node).includes(m[0]))
          const innermost = inner.filter(node => !inner.some(other => other !== node && node.contains(other)))
          return innermost[0] || el
        }

        const sized = el => {
          const r = el.getBoundingClientRect()
          return r.width >= 1 && r.height >= 1
        }
        // 中心点之下是否是它自己（或它的后代/祖先）—— 被同一块面板内其它层遮挡时不是
        const reachable = el => {
          const r = el.getBoundingClientRect()
          const top = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2)
          return Boolean(top && (top === el || el.contains(top) || top.contains(el)))
        }
        const cands = leaves.map(narrow).filter(sized)
        // 优先挑点得到的那个；全部被遮挡时仍取第一个，交由 clickHandle 的九点命中测试
        // 与合成事件兜底处理
        const pick = cands.find(reachable) || cands[0]
        if (!pick) return { found: false, total: hits.length, text: "" }
        pick.setAttribute(sel, "1")
        return {
          found: true,
          total: hits.length,
          cands: cands.length,
          text: norm(pick).slice(0, 24),
        }
      },
      re.source,
      re.flags,
      attr,
      root
    )
    .catch(() => ({ found: false, total: 0, text: "" }))
  if (!found.found) return { ok: false, reason: `页面上没有匹配 ${re} 的可见元素`, text: "" }
  const handle = await page.$(`[${attr}="1"]`)
  if (!handle) return { ok: false, reason: "标记后取不到元素（页面刚重渲染）", text: found.text || "" }
  try {
    const r = await clickHandle(page, handle, opts)
    debug(
      scope,
      `点「${found.text}」（${found.cands} 个候选）：${r.ok ? `事件${r.arrived ? "已到 DOM" : "⚠ 未到 DOM"}${r.forced ? "，已补合成" : ""}` : r.reason}`
    )
    return { ...r, text: found.text || "" }
  } finally {
    await handle.evaluate((el, sel) => el.removeAttribute(sel), attr).catch(() => {})
    await handle.dispose().catch(() => {})
  }
}
