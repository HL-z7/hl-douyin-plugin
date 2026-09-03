/**
 * 页面交互层：真鼠标 / 真键盘 + 合成事件兜底。
 *
 * 这套判据原来长在 lib/remote.js 里（只给远程验证页面用），但「点下去到底有没有到 DOM」
 * 不是远程验证独有的问题：续火要点搜索结果里的「发消息」，自动登录要点抖音的
 * 「接收短信验证码」，走的是同一条链路、会以同样的方式静默失败。所以抽到这里共用，
 * remote.js 只留它自己的坐标基准（前端那张图与视口之间的换算）。
 *
 * 为什么不用现成的 click 了事：
 * - `el.click()` 只派发一个 click 事件，组件把响应挂在 pointerdown/mousedown 上时收不到；
 * - `elementHandle.click()` 走 CDP 的 Input 域，同一 tick 内 move→down→up，既没有 hover
 *   停顿也没有按住时间，抖音那套 React 组件有时走不完一轮判定；
 * - 最要紧的是两者都会「静默成功」：CDP 只保证事件发出去了，不保证有元素收下。
 * 所以这里每次点击都带一圈探针，事件没进 DOM 就补一轮合成事件。
 */
import { sleep } from "./util.js"
import { debug, debugOn } from "./debug.js"

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

/* ---------- 让页面「以为自己在前台」 ----------
 *
 * 无头浏览器里没有窗口管理器，页面的 `document.hasFocus()` 常年是 false。
 * 大多数点击不受影响，但有两类会：焦点相关的组件（输入框拿不到 caret）、
 * 以及把 hasFocus 当反自动化特征来看的脚本。
 *
 * CDP 的 `Emulation.setFocusEmulationEnabled` 就是给这个场景准备的：让渲染进程
 * 无条件认为自己是聚焦的。它是 CDP 侧的域、与 puppeteer 版本无关，但老内核上未必有，
 * 失败一律咽掉 —— 它是加分项，不是必要条件。
 *
 * 每个页面只做一次，key 是 page，页面关掉自然回收。
 */
const focused = new WeakSet()

export async function ensureFocus(page, scope = "页面交互") {
  if (focused.has(page)) return
  focused.add(page)
  try {
    // 多标签时 Input 事件仍会送到本 target，但 bringToFront 顺手把可见性也摆正
    await page.bringToFront()
  } catch {}
  try {
    const cdp = await page.target().createCDPSession()
    await cdp.send("Emulation.setFocusEmulationEnabled", { enabled: true })
    debug(scope, "已开启焦点模拟（无头浏览器默认 document.hasFocus() 为 false）")
    // 不 detach：这个开关是会话级的，会话一断就失效，得让它跟着页面活着
  } catch (error) {
    debug(scope, `焦点模拟开不了（不影响点击）：${error.message}`)
  }
}

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
 * `frame.frameElement()` 不是所有版本都有（本机 pnpm store 里 puppeteer-core 19.x 两份都
 * 没有，21.11.0 与 23.10.1 有），老版本要自己在父框架里遍历 iframe，用 contentFrame()
 * 认出哪一个是它。boundingBox() 两边都返回主框架坐标系的值，所以嵌套多深都不用累加。
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
export async function describeHit(page, x, y) {
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
 * 认「验证组件外壳」用的 id/class 关键词。
 *
 * 两个地方要用同一份：这里的 MutationObserver 只盯验证组件那一块（遮罩后面那张
 * 抖音页还在放视频、转轮播，整页盯着的话 DOM 变化永远不为 0，「组件理没理」这一问
 * 就永远问不出来，兜底也永远不会出手），以及 login.js 的 readSmsState 只读面板内的
 * 文本（读整页会把推荐流的视频时长当成倒计时）。
 *
 * 两处必须同源：一处认出了面板、另一处退回整页，读数就会互相打脸 —— 探针说
 * 「组件没动」而状态机说「已发送」，排查时无从下手。所以这里 export 出去，
 * 不在 login.js 里抄第二份。
 *
 * 认的是 id/class 里的语义词而不是具体 class 名：抖音的 class 是混淆的（`list-AKRdS7`
 * 这种），每次发版都变，而 `uc-second-verify`、`dialog` 这类词是框架给的，稳得多。
 */
export const PANEL_HINTS = ["verify", "verification", "captcha", "dialog", "modal"]

async function watchClick(page, x, y, target) {
  try {
    await page.evaluate(
      (types, hints, px, py, goal) => {
        const probe = { events: [], mutations: 0, sample: "", onTarget: goal ? false : null }
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
            /*
             * 事件到了 DOM 不等于到了我们要点的那个元素。被同一块面板里别的层压住时，
             * 真鼠标点在遮挡层上，它照样冒泡到 window —— 探针只数「有没有事件」的话，
             * 这种「点错了东西」会被读成「点到了」，兜底也就不出手了。
             */
            if (goal && (e.target === goal || goal.contains(e.target) || e.target.contains(goal)))
              probe.onTarget = true
          }
          window.addEventListener(type, fn, true)
          return () => window.removeEventListener(type, fn, true)
        })

        // 从落点往上找验证组件的外壳，找不到就退回整页（那时读数会偏吵，但总比没有好）
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

        // 一次性的环境读数，用来判掉「页面没焦点」和「视口被缩放/偏移过」
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
    // 页面正在导航 / 已关闭，探针挂不上就算了，不能因为诊断代码影响正常操作
  }
}

/**
 * 读回并拆掉探针。
 *
 * @returns {Promise<{events: string[], mutations: number, onTarget: boolean|null, line: string} | null>}
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
 * 兜底：真鼠标点了没动静时，在落点元素上补一轮合成事件。
 *
 * 为什么留这条退路：真鼠标事件从浏览器进程走到渲染进程要经过一串坐标换算与
 * 命中测试，中间任何一环对不上，我们这边看到的都只是「静默成功」。而人在等着
 * 把验证过掉，不能因为这条链路上某个环节今天不通就整个功能不可用。
 *
 * 这不是「执行任意脚本」那个口子：作用对象要么是调用方手里那个 ElementHandle，
 * 要么是我们刚点的那个坐标底下的元素（由页面自己的 elementFromPoint 决定）。
 * 两种情况下调用方都递不进来选择器，也递不进来代码。
 *
 * `target` 这个参数是现场逼出来的：抖音那个「获取验证码」被同一块面板里的
 * `div.list-AKRdS7` 压住，坐标底下的元素压根不是它，于是这条兜底把一整轮合成事件
 * 补在了遮挡层上 —— 日志报「已补合成」，页面纹丝不动。既然点的是元素而不是坐标，
 * 就该直接打在那个元素身上，别再绕 elementFromPoint 一次。
 *
 * 合成事件的 `isTrusted` 是 false。React 不看这个字段，所以它那套 onClick 照样触发；
 * 真的只认可信事件的组件这条兜底也帮不上，那种情况日志里会留下痕迹。
 *
 * @param {import("puppeteer").ElementHandle} [target] 直接派发到这个元素上
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
 *
 * @param {import("puppeteer").ElementHandle} [target] 这次点的是哪个元素。有它时优先
 *   从它自己身上找输入框（它被别的层压住时 elementFromPoint 认到的是遮挡层，
 *   焦点就会按进一个不相干的元素里）
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
      // 落点可能是输入框里的图标或 placeholder 层，往上找一层才是真的输入元素；
      // 也可能是包着输入框的那一格（按文本找到的常常是这种），所以再往下找一次
      const field = hit?.matches?.(selector)
        ? hit
        : hit?.closest?.(selector) || hit?.querySelector?.(selector)
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
    }, FIELD_SELECTOR)
  } catch {
    return ""
  } finally {
    if (own) await handle?.dispose?.().catch(() => {})
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
 * `steps` 是 puppeteer 自带的参数（各版本都有），不用自己拆。
 *
 * 起点取目标点左上方一点，clamp 在视口内 —— 按钮贴边时不能挪到负坐标去。
 */
export async function approach(page, x, y, vp) {
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

/* ---------- 对外的三个动作 ---------- */

/**
 * 在视口像素坐标上点一下（带探针与合成事件兜底）。
 *
 * @param {import("puppeteer").Page} page
 * @param {number} x 视口像素
 * @param {number} y 视口像素
 * @param {object} [opts]
 * @param {object} [opts.vp] 已知的视口尺寸，省一次 evaluate
 * @param {string} [opts.scope] debug 日志的定位串
 * @param {boolean} [opts.dbl] 双击
 * @param {boolean} [opts.focusField=true] 落点是输入框时把焦点按进去
 * @param {import("puppeteer").ElementHandle} [opts.handle] 这次点的是哪个元素。
 *   有它时兜底的合成事件直接打在它身上，不再靠 elementFromPoint 认一遍 —— 坐标底下
 *   被别的层压住时，那一认就认错了（见 forceClick 的注释）
 * @returns {Promise<{arrived: boolean, mutations: number, forced: string, field: string, line: string}>}
 */
export async function clickAt(page, x, y, opts = {}) {
  const scope = opts.scope || "页面交互"
  const vp = opts.vp || (await viewportSize(page))
  await ensureFocus(page, scope)

  /*
   * 点击拆成「靠近 → 停 → 按下 → 停 → 松开」，而不是 page.mouse.click 一把梭。
   *
   * mouse.click 内部是同一 tick 里 move→down→up：只有一个 mousemove、按下与松开
   * 间隔 0ms。抖音那些 React 组件把响应挂在 hover 之后才建立的状态上，而 0ms 的
   * 按下-松开在很多组件里根本走不完一轮判定，同时也是最典型的自动化特征。
   * 这里补上真人点击的三个特征：一串移动、hover 停顿、按住 70ms。
   * 代价是每次点击多 160ms，人察觉不到。
   */
  await approach(page, x, y, vp)
  await sleep(HOVER_MS)

  // 点之前先问一句「这个像素底下是什么」——这是区分「点空了」和「点对了但组件不理」
  // 的唯一手段，日志里那句 `耗时 2ms` 两种情况长得一模一样
  const hit = debugOn() ? await describeHit(page, x, y) : ""
  // 事件到没到 DOM、有没有到目标元素身上、组件理没理，这三问只有探针能答，
  // 而下面那条兜底要靠它的结论决定该不该出手，所以它不跟着 debug 开关走
  await watchClick(page, x, y, opts.handle)

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
  if (opts.dbl) {
    // 两次之间的间隔要短于系统双击阈值（普遍 500ms），60ms 稳稳落在里面
    await sleep(60)
    await press(2)
  }
  if (hit) debug(scope, `  落点元素：${hit}`)

  // 等一轮渲染再读：读太早会把「组件正在处理」误判成「组件没理」
  await sleep(CLICK_PROBE_WAIT_MS)
  const probe = await readClick(page)
  if (probe) debug(scope, `  ${probe.line}`)

  /*
   * 真鼠标这一下没落到该落的地方 —— 补一轮合成事件。
   *
   * 判据的演化值得留一笔，三版各修掉前一版的一个盲区：
   *
   * v1「DOM 有没有动」：抖音验证码框旁边挂着「49s后重新发送」的倒计时，它每秒改一次
   *    input 的属性，于是面板里永远有变化，兜底永远不出手。
   * v2「事件有没有进 DOM」：修掉了倒计时那个坑，但换来一个更隐蔽的 —— 事件进了 DOM
   *    不等于进了我们要点的元素。现场那次「获取验证码」被同一块面板里的选项列表整块
   *    压住，真鼠标点在遮挡层上，它照样冒泡到 window，于是探针报「已到 DOM」、兜底
   *    不出手、页面纹丝不动，三行日志全是成功。
   * v3（现在）：递了 handle 就直接问「目标元素收到了没有」。
   *
   * 目标元素确实收到了就不再补：那一下是真的点在了它身上，React 的 onClick 已经触发，
   * 再补一轮只是重复。这对「获取验证码」尤其要紧 —— 抖音对同一手机号有频率限制，
   * 而它的倒计时要等接口回来才起，350ms 的探针窗口里 mutations 常常还是 0，
   * 按 v2 的判据就会白发第二条短信。
   *
   * 没递 handle（远程验证那条路只有坐标）时无从判断落点对不对，维持 v2 的判据。
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
   * 点在输入框上时，把焦点按进去。
   *
   * 焦点是浏览器处理 mousedown 默认行为时给的，而这条链路 mousedown 到不了 DOM——
   * 于是「点一下输入框」这个动作看起来成功了，光标却没进去，紧接着的打字就打在了
   * 空气里。这是现场「验证码输不进去」的直接成因。放在兜底之后做：兜底那一轮合成
   * 事件有可能已经把焦点带过去了，这里只是确保结果一定成立。
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
 * 往当前焦点里打字，真键盘打不进去就补合成输入。
 *
 * @returns {Promise<{grew: boolean, forced: string, focus: string}>}
 */
export async function typeText(page, text, opts = {}) {
  const scope = opts.scope || "页面交互"
  const str = String(text ?? "")
  if (!str) return { grew: false, forced: "", focus: "" }

  // 打字前记一笔焦点在谁身上、里面已经有几个字，打完再读一次——CDP 只会报
  // 「按键发出去了」，字有没有落进输入框只能靠这个前后对比看出来
  const before = await watchKeys(page)
  // delay 让它像人在敲，抖音的输入框有的会监听 keydown 频率
  await page.keyboard.type(str, { delay: opts.delay ?? 60 })
  const after = await readKeys(page)

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
  const grew = Boolean(before && after >= 0 && after !== before.length)
  let forced = ""
  if (!grew) {
    forced = await forceType(page, str)
    debug(scope, `  真键盘没让内容变化（焦点=${before?.name || "?"}），已补合成输入：${forced}`)
  }
  return { grew, forced, focus: before?.name || "" }
}

/**
 * 按一个功能键，真键盘 + 合成各来一遍。
 *
 * 为什么不做「先试真的、不行再补」：按键的效果判不出来 —— Enter 是提交（页面自己会跳，
 * 输入框内容不变）、Escape 是关弹窗、方向键只挪光标，都没有一个「前后对比就知道成没成」
 * 的读数。而这几个键重复一次的代价很低（Enter 最多多提交一次，抖音那边幂等），
 * 漏掉一次的代价是用户点了没反应、只能干等超时。删除键例外：它会真的少删一个字，
 * 所以按内容变化判。
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
 * 上面三个动作都吃视口像素坐标（远程验证那边前端递过来的就是坐标）。而插件内部
 * 自动点按钮时手里拿的是 ElementHandle 或一段文本，所以这里补一层：把元素换算成
 * 中心点坐标，再走同一条链路。不直接用 `elementHandle.click()` 的原因见文件头。
 */

/**
 * 元素当前在视口里的位置与尺寸，顺手把它滚进视口，并做一次命中测试。
 *
 * 不用 `handle.boundingBox()` 了事：它对 `display:none` 返回 null，但对「在滚动容器
 * 外面」的元素返回的是视口外坐标，点上去会落在别的元素身上。所以自己读一遍 rect，
 * 并把「在不在视口内」一起判掉。
 *
 * 光有 rect 还不够 —— 现场那次失败就栽在这里：「获取验证码」这个按钮 rect 正常、
 * 尺寸正常、样式也可见，但它的几何中心底下坐着同一块面板里的 `div.list-AKRdS7`
 * （当前那一步的选项列表压在它上面）。于是真鼠标点到了遮挡层，探针报「事件一个
 * 都没到」，合成事件也补在了遮挡层身上，日志三行全是「成功」，页面纹丝不动。
 *
 * 所以这里追加一步 `elementFromPoint`：中心点被压住时，在 rect 内部再试八个点
 * （四个 25%/75% 交点 + 四条边的内侧中点）。有一个能命中就用它——按钮被压住半边
 * 是常见版面，整块都被压住才是真的点不到。全都命中不了就把 `occluded` 标出来，
 * 让调用方知道「这个元素在，但没法点」，而不是照着中心点盲点一下。
 *
 * @returns {Promise<{x, y, cx, cy, w, h, occluded: boolean, top: string} | null>}
 */
export async function visibleBox(handle) {
  if (!handle) return null
  try {
    return await handle.evaluate(el => {
      // block:center 而不是默认的 start：贴着视口上沿的元素常被顶栏盖住
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
       * 命中算「点这里等于点它」的三种情况：
       *   - 顶上就是它自己
       *   - 顶上是它的后代（按钮里的 <span>、图标层，点了照样冒泡到它）
       *   - 顶上是它的祖先（它自己 pointer-events:none，但整块是可点的，
       *     比如纯文字层套在一个 clickable 容器里）
       */
      const ok = top => Boolean(top && (top === el || el.contains(top) || top.contains(el)))
      // 边上的点往内缩 2px：正好压在边框上时命中的常常是外面那个容器
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
      // 一个点都命中不了：坐标仍回中心点（调用方可能只是要个位置），但标明被压住
      return { x: r.left, y: r.top, cx, cy, w: r.width, h: r.height, occluded: true, top: top0 }
    })
  } catch {
    return null
  }
}

/**
 * 点一个 ElementHandle（走 clickAt 那条链路）。
 *
 * handle 一路带给 clickAt：兜底的合成事件要打在**这个元素**身上，而不是坐标底下
 * 那个（被压住时两者不是同一个东西，详见 forceClick 与 visibleBox 的注释）。
 *
 * @returns {Promise<{ok: boolean, reason: string, arrived?: boolean, forced?: string}>}
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
 * 按文本找一个可见元素并点它。
 *
 * 为什么要「取最内层的那个匹配」：`querySelectorAll("*")` 里，一个按钮的每一层祖先
 * 的 textContent 都包含那段文字，取到外层就会点在整块面板的几何中心 —— 那里往往是
 * 别的东西。所以先收集全部匹配，再把「还有后代也匹配」的那些去掉。
 *
 * 光去掉包装还不够。宽松正则（`/接收短信验证码|短信验证码登录/` 这种）会命中
 * **同时装着两个选项的那一格**：它的 textContent 是两行拼起来的
 * （"接收短信验证码发送短信验证"），没有任何后代能整段匹配，于是它自己就是最内层，
 * 而它的几何中心正好落在两行之间的空隙里 —— 点了个空。所以在「最内层」之后再往里
 * 收一次（narrow），并在几个候选之间挑一个真的点得到的（命中测试）。
 *
 * @param {RegExp} re 匹配 trim 并压掉空白后的整段文本
 * @param {object} [opts]
 * @param {import("puppeteer").ElementHandle} [opts.root] 只在这个元素内部找
 * @param {string} [opts.scope] debug 定位串
 * @param {boolean} [opts.hover] 先把鼠标移到 root 上再找（按钮 hover 才出现时用）
 * @returns {Promise<{ok: boolean, reason: string, text: string}>}
 */
export async function clickByText(page, re, opts = {}) {
  const scope = opts.scope || "页面交互"
  const attr = "data-dy-click"
  const root = opts.root || null

  // 按钮只在 hover 时出现的版面：先把鼠标放到容器上，再去找
  if (opts.hover && root) {
    const rootBox = await visibleBox(root)
    if (rootBox) {
      await approach(page, rootBox.cx, rootBox.cy, opts.vp || (await viewportSize(page)))
      await sleep(HOVER_MS)
    }
  }

  /*
   * 标记与取 handle 分两步走，中间靠属性对上。
   *
   * 不在 evaluate 里直接返回元素：跨 evaluate 传 DOM 节点只能靠 JSHandle，而这段
   * 要在「主页面」和「某个结果项内部」两种范围下复用，走属性最省事。范围通过参数
   * 递进去（puppeteer 支持把 ElementHandle 当 evaluate 入参，null 表示整页）。
   */
  const found = await page
    .evaluate(
      (source, flags, sel, scopeEl) => {
        const test = new RegExp(source, flags)
        const norm = el => (el.textContent || "").replace(/\s+/g, " ").trim()
        const base = scopeEl || document
        document.querySelectorAll(`[${sel}]`).forEach(el => el.removeAttribute(sel))
        const hits = [...base.querySelectorAll("*")].filter(el => test.test(norm(el)))
        // 只留最内层：有后代也匹配的说明它只是个包装，点它会落在整块面板的几何中心
        const leaves = hits.filter(el => !hits.some(other => other !== el && el.contains(other)))

        /*
         * 再往里收一次：拿正则真正匹配到的那截文本，在这一格内部找「自己的文本里含
         * 这截」的最小元素。元素文本本来就正好是那截时原样返回（绝大多数按钮都是）。
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
        // 中心点底下是不是它自己（或它的后代/祖先）——被同一块面板里别的层压住时不是
        const reachable = el => {
          const r = el.getBoundingClientRect()
          const top = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2)
          return Boolean(top && (top === el || el.contains(top) || top.contains(el)))
        }
        const cands = leaves.map(narrow).filter(sized)
        // 挑得到的就挑点得到的那个；全都被压住时仍取第一个，交给 clickHandle 的
        // 九点命中测试和合成事件兜底去处理
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
