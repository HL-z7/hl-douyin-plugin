/**
 * 聊天界面的后端：为一个抖音账号维持一个常开的聊天页，读消息、发消息。
 *
 * 为什么要「常开」而不是像续火那样开完就关：
 * 续火是一次性任务（进去、发完、走），而聊天要能看到对方回了什么。每次轮询都重开一个
 * Chromium、登录、等会话渲染，一轮就是十几秒，而且每一轮都是一次新的登录会话——抖音
 * 那边会看到你每分钟登录一次，这比长期挂着一个会话可疑得多。
 *
 * 三条硬约束，都是从现有代码里推出来的：
 *
 * 1. **必须和续火抢同一把锁**（spark.js 的 acquire/release）。同一份 Cookie 同时活在
 *    两个 BrowserContext 里，抖音看到的是两个并发登录，掉线和触发验证都从这里开始。
 *    所以一个账号在某一刻只能有一个页面持有者：要么在续火，要么开着聊天。
 *
 * 2. **必须自己管超时关闭**。browser.js 的 #armIdleClose 判据是「还有没有非
 *    about:blank 的真实页面」，聊天页开着，那个 60 秒自动收浏览器的机制就永远不触发。
 *    也就是说没人关的话，这个 Chromium 会挂到 Yunzai 重启——所以这里有自己的空闲计时。
 *
 * 3. **读到的东西只有纯文本**。抖音不给消息 id，也没有结构化时间；而且 browser.js 默认
 *    拦掉 image/media/font，头像本来也加载不了。所以消息的身份只能是
 *    「谁说的 + 说了什么 + 页面上那个时间戳」，去重逻辑在 chatdb.appendMessages 里。
 */
import { log, toError } from "./util.js"
import { config } from "./config.js"
import { store } from "./store.js"
import { audit } from "./audit.js"
import browserManager, { closeQuietly } from "./browser.js"
import { debug } from "./debug.js"
import {
  CHAT_URL,
  READY_TIMEOUT,
  SEL,
  acquire,
  release,
  waitForChatList,
  readItems,
  itemName,
  itemPreview,
  searchConversation,
  openChat,
  typeAndSend,
} from "./spark.js"
import * as chatdb from "./chatdb.js"

/** 活着的聊天会话，key 是 `botId:accountId`。同一账号只可能有一个 */
const sessions = new Map()

/**
 * 消息气泡的分档选择器，与 spark.js 的 EDITORS 同一个套路：先严后松。
 *
 * 抖音的聊天记录区没有稳定的语义 class，只有打包生成的混淆串。所以这里第一档认
 * 「明显是消息列表的容器」，最后一档整页找——反正 pickBubbles 之后还有「兄弟最多的
 * 那一组」这层结构判据兜着，宽一点不会读出别的东西来。
 */
const BUBBLE_ROOTS = [
  '[class*="messageList"], [class*="MessageList"]',
  '[class*="chatContent"], [class*="ChatContent"]',
  '[class*="message"], [class*="Message"]',
]

/** 判断一条气泡是不是自己发的：抖音给自己那侧的容器挂 right/self/mine 一类的串 */
const SELF_HINT = /right|self|mine|owner|send(er)?$|isSelf/i

/** 一条气泡里要剔掉的纯噪音文本（时间分隔、状态提示） */
const BUBBLE_NOISE =
  /^(刚刚|\d+\s*(分钟|小时|天)前?(内)?(在线)?|在线|昨天|前天|星期[一二三四五六日天]|已读|未读|发送中|已送达|重新发送|\d{1,2}:\d{2}|\d{4}[-/]\d{1,2}[-/]\d{1,2}([\s\d:]+)?)$/

/**
 * 一个账号的聊天会话。
 *
 * 状态机很浅：opening → ready → closed，出错直接进 closed 并把原因留在 error 里。
 * 刻意不做自动重连——Cookie 失效、抖音弹验证这些都要人来处理，自动重试只会在后台
 * 反复登录（然后被风控），而用户在前端看到的还是「连不上」。
 */
class ChatSession {
  constructor(botId, accountId, account) {
    this.botId = botId
    this.accountId = accountId
    this.name = account.name
    this.status = "opening"
    this.error = ""
    /** 当前打开的会话对象（对方昵称）。空串表示还停在会话列表 */
    this.peer = ""
    this.context = null
    this.page = null
    this.at = Date.now()
    /** 最后一次被前端碰到的时间，空闲关闭按它算 */
    this.touchedAt = Date.now()
    this.idleTimer = null
    /**
     * 串行队列。前端可能同时发来「切会话」和「发消息」，而它们操作的是同一个页面：
     * 并发跑会让 openChat 点到一半时另一个动作把页面切走。所有页面操作排成一条链。
     */
    this.chain = Promise.resolve()
  }

  trace(...args) {
    debug(`${this.name} 聊天`, ...args)
  }

  /** 把一个页面操作排进队列。抛出的异常原样传给调用方，但不会打断后面的操作 */
  run(fn) {
    const next = this.chain.then(fn, fn)
    // 队列自身永远 resolve，否则一次失败会让后面所有操作都被 reject
    this.chain = next.then(
      () => {},
      () => {}
    )
    return next
  }

  touch() {
    this.touchedAt = Date.now()
    this.#armIdle()
  }

  /**
   * 没人用了就自己关掉。
   *
   * 这是 browser.js 那套自动收浏览器机制的补丁：聊天页开着的时候它永远不会触发
   * （判据是「还有没有真实页面」），于是 Chromium 会一直占着 200~400MB。用户关掉
   * 网页并不会通知服务端，所以只能按「多久没有人来轮询」判。
   */
  #armIdle() {
    clearTimeout(this.idleTimer)
    const ms = config.num("chat.idleCloseSec", 180, { min: 30, max: 3600 }) * 1000
    this.idleTimer = setTimeout(() => {
      log("info", `[${this.name}] 聊天会话空闲 ${ms / 1000} 秒，自动关闭`)
      this.close("空闲自动关闭")
    }, ms)
    this.idleTimer.unref?.()
  }

  async open() {
    const cookies = store.cookies(this.botId, this.accountId)
    if (!cookies?.length) throw new Error("该账号没有可用 Cookie，请重新登录")

    const { context, page } = await browserManager.openPage(cookies)
    this.context = context
    this.page = page
    try {
      await page.goto(CHAT_URL, { waitUntil: "domcontentloaded", timeout: READY_TIMEOUT })
      const ready = await page
        .waitForSelector(SEL.search, { visible: true, timeout: READY_TIMEOUT })
        .then(() => true)
        .catch(() => false)
      if (!ready) throw new Error("聊天页搜索框未出现，Cookie 可能已经失效")
      await waitForChatList(page, () => {}, (...a) => this.trace(...a))
      this.status = "ready"
      this.at = Date.now()
      this.#armIdle()
      log("info", `[${this.name}] 聊天会话已就绪`)
    } catch (error) {
      this.status = "closed"
      this.error = toError(error).message
      await this.#teardown()
      throw error
    }
  }

  /** 会话列表：先从页面上读，读到的并进库，然后按库里的顺序返回（本地的不会过期） */
  async conversations() {
    this.#assertLive()
    const items = await readItems(this.page, SEL.conversation)
    const seen = []
    for (const item of items) {
      const peer = itemName(item)
      if (!peer || seen.some(s => s.peer === peer)) continue
      seen.push({ peer, ...itemPreview(item, peer) })
    }
    this.trace(`会话列表读到 ${seen.length} 条`)
    chatdb.mergeConversations(this.botId, this.accountId, seen)
    return chatdb.listConversations(this.botId, this.accountId)
  }

  /**
   * 打开一个会话并把当前可见的气泡读进库。
   *
   * 已经在这个会话里就不再点一次：抖音的会话切换是本地渲染，重复点没有坏处但会白等
   * 一轮浮层探测，而聊天界面每 3 秒就要来一次。
   */
  async openPeer(peer) {
    this.#assertLive()
    if (this.peer !== peer) {
      const hit = await searchConversation(this.page, [peer], () => {}, (...a) => this.trace(...a))
      if (!hit) throw new Error(`找不到与「${peer}」的会话`)
      // 复用 spark 的 openChat：它比「点一下 handle」多两档退路（按钮文本 → 整条结果项
      // → 结果项首个子元素），还带进会话前的浮层探测。为此把它从 spark 里 export 了出来
      const how = await openChat(this.page, hit.handle, (...a) => this.trace(...a))
      this.trace(`已进入与「${peer}」的会话（${how}）`)
      this.peer = peer
      chatdb.markSeen(this.botId, this.accountId, peer)
    }
    await this.pull()
    return this.peer
  }

  /** 读当前会话里可见的气泡，追加进库，返回新增条数 */
  async pull() {
    this.#assertLive()
    if (!this.peer) return 0
    const bubbles = await readBubbles(this.page)
    const n = chatdb.appendMessages(this.botId, this.accountId, this.peer, bubbles)
    if (n) this.trace(`读到 ${bubbles.length} 条气泡，新增 ${n} 条`)
    return n
  }

  /** 在当前会话里发一条消息 */
  async send(text) {
    this.#assertLive()
    if (!this.peer) throw new Error("请先选择一个会话")
    const message = String(text ?? "").trim()
    if (!message) throw new Error("消息内容不能为空")
    await typeAndSend(this.page, message, (...a) => this.trace(...a))
    // 立刻入库：确认过字数、Enter 也敲下去了，前端不该等下一轮轮询才看到自己发的话。
    // 下一轮真从页面读到它时，appendMessages 的重叠去重会认出是同一条
    chatdb.recordSent(this.botId, this.accountId, this.peer, message)
    audit.add("chat.send", {
      botId: this.botId,
      accountId: this.accountId,
      account: this.name,
      peer: this.peer,
      length: message.length,
    })
    return true
  }

  #assertLive() {
    if (this.status !== "ready") throw new Error(this.error || "聊天会话已关闭")
    if (!this.page || this.page.isClosed()) {
      this.status = "closed"
      this.error = "聊天页面已被关闭"
      throw new Error(this.error)
    }
  }

  async #teardown() {
    clearTimeout(this.idleTimer)
    await closeQuietly(this.page)
    await closeQuietly(this.context)
    this.page = null
    this.context = null
  }

  async close(why = "") {
    if (this.status === "closed" && !this.page) return
    this.status = "closed"
    if (why && !this.error) this.error = why
    sessions.delete(`${this.botId}:${this.accountId}`)
    release(this.botId, this.accountId)
    await this.#teardown()
  }

  info() {
    return {
      botId: this.botId,
      accountId: this.accountId,
      account: this.name,
      status: this.status,
      error: this.error,
      peer: this.peer,
      at: this.at,
    }
  }
}

/**
 * 读当前会话里可见的消息气泡。
 *
 * 导出是为了能离线测：判据全在浏览器上下文里，喂一份仿抖音结构的 DOM 就能验，
 * 不用真登录一个抖音账号（真号测一次的成本是一次登录会话 + 十几秒，还改不了对方的话）。
 *
 * 判据全是结构性的，不认任何 class 名也不认中文文案（抖音改版时 class 一定会变，
 * 而结构——「一堆同父的兄弟节点，每个装一条消息」——不会）：
 *
 * 1. 按 BUBBLE_ROOTS 分档找消息区，找到第一个有内容的就停
 * 2. 在里面按父节点归组，取成员最多的那一组当「气泡行」（同 spark.readItems 的思路）
 * 3. 每条气泡的文本取整条 innerText，剔掉纯时间/状态的行
 * 4. self 靠往上爬找 right/self/mine 一类的 class；找不到就退到「气泡在容器里偏右」
 *
 * 第 4 条的坐标兜底是必要的：class 混淆之后 SELF_HINT 有可能全都命中不了，而
 * 「自己发的靠右」是这类 IM 界面二十年没变过的布局约定。
 */
export async function readBubbles(page) {
  return page
    .evaluate(
      ([roots, selfHint, noise]) => {
        const selfRe = new RegExp(selfHint)
        const noiseRe = new RegExp(noise)

        /** 在一个根节点里找「气泡行」：按父节点归组，成员最多的那一组 */
        const rowsIn = root => {
          const groups = []
          for (const el of root.children.length ? [...root.querySelectorAll("*")] : []) {
            // 只考虑有文字、且不是纯容器的节点
            const text = (el.innerText || "").trim()
            if (!text || text.length > 2000) continue
            const parent = el.parentElement
            if (!parent) continue
            let g = groups.find(x => x.parent === parent)
            if (!g) groups.push((g = { parent, items: [] }))
            g.items.push(el)
          }
          let picked = null
          for (const g of groups) if (!picked || g.items.length > picked.items.length) picked = g
          return picked?.items || []
        }

        let rows = []
        for (const sel of roots) {
          const root = document.querySelector(sel)
          if (!root) continue
          const found = rowsIn(root)
          if (found.length) {
            rows = found
            break
          }
        }
        if (!rows.length) return []

        // 容器中线，用于 self 的坐标兜底
        const box = rows[0].parentElement?.getBoundingClientRect()
        const mid = box ? box.left + box.width / 2 : 0

        const out = []
        for (const row of rows) {
          const raw = (row.innerText || "").trim()
          if (!raw) continue
          const lines = raw
            .split("\n")
            .map(s => s.trim())
            .filter(s => s && !noiseRe.test(s))
          const text = lines.join("\n").slice(0, 2000)
          if (!text) continue

          // 时间戳：这一行里被判成噪音、且长得像时间的那条
          const stamp =
            raw
              .split("\n")
              .map(s => s.trim())
              .find(s => noiseRe.test(s) && /\d/.test(s)) || ""

          let self = null
          for (let el = row; el && el !== document.body; el = el.parentElement) {
            const cls = `${el.className || ""} ${el.getAttribute?.("data-e2e") || ""}`
            if (selfRe.test(cls)) {
              self = true
              break
            }
          }
          if (self === null && mid) {
            const r = row.getBoundingClientRect()
            // 整条都在中线右边才算自己发的：靠左的和横跨整宽的（系统提示）都不算
            self = r.left > mid
          }
          out.push({ self: !!self, text, stamp })
        }
        return out
      },
      [BUBBLE_ROOTS, SELF_HINT.source, BUBBLE_NOISE.source]
    )
    .catch(() => [])
}

/* ================================ 对外接口 ================================ */

/**
 * 打开（或复用）一个账号的聊天会话。
 *
 * 抢锁在开浏览器之前：抢不到就直接告诉用户是谁占着，别白启动一个 Chromium。
 */
export async function openSession(botId, accountId) {
  const key = `${botId}:${accountId}`
  const exist = sessions.get(key)
  if (exist) {
    if (exist.status !== "closed") {
      exist.touch()
      return exist
    }
    sessions.delete(key)
  }

  const account = store.get(botId, accountId)
  if (!account) throw new Error("账号不存在")

  acquire(botId, accountId, "的聊天窗口正开着")
  const session = new ChatSession(botId, accountId, account)
  sessions.set(key, session)
  try {
    await session.open()
  } catch (error) {
    sessions.delete(key)
    release(botId, accountId)
    throw error
  }
  return session
}

/** 取一个已经开着的会话，没有就抛。前端所有后续操作都走它 */
export function getSession(botId, accountId) {
  const session = sessions.get(`${botId}:${accountId}`)
  if (!session || session.status === "closed")
    throw new Error("聊天会话未打开或已关闭，请重新进入")
  session.touch()
  return session
}

/** 关掉一个会话（用户点「退出聊天」，或账号被删） */
export async function closeSession(botId, accountId) {
  const session = sessions.get(`${botId}:${accountId}`)
  if (!session) return false
  await session.close("已手动关闭")
  return true
}

/** 关掉全部会话。热重载与 Yunzai 退出时调用，否则 Chromium 会留下来 */
export async function closeAll(why = "插件重载") {
  const list = [...sessions.values()]
  for (const session of list) await session.close(why)
  return list.length
}

/** 面板状态用：当前有哪些聊天会话开着 */
export function sessionList() {
  return [...sessions.values()].map(s => s.info())
}

/**
 * 会话列表的读取入口。会话没开时不自动开——开一个要十几秒还要抢锁，
 * 那是用户点「进入聊天」时该发生的事，不该由一次列表请求触发。
 */
export async function conversations(botId, accountId) {
  const session = getSession(botId, accountId)
  return session.run(() => session.conversations())
}

export async function openPeer(botId, accountId, peer) {
  const session = getSession(botId, accountId)
  await session.run(() => session.openPeer(peer))
  return {
    peer: session.peer,
    messages: chatdb.history(botId, accountId, peer),
  }
}

/**
 * 轮询：拉一遍页面上的新气泡，然后把 sinceId 之后的消息给前端。
 *
 * 顺序不能反：先读页面再查库，否则刚到的消息要等下一轮才出现，聊天界面的延迟就从
 * 「一个轮询周期」变成「两个」。
 */
export async function poll(botId, accountId, peer, sinceId = 0) {
  const session = getSession(botId, accountId)
  if (peer && session.peer !== peer) await session.run(() => session.openPeer(peer))
  else await session.run(() => session.pull())
  return {
    peer: session.peer,
    messages: chatdb.since(botId, accountId, session.peer, Number(sinceId) || 0),
    status: session.status,
  }
}

export async function send(botId, accountId, peer, text) {
  const session = getSession(botId, accountId)
  if (peer && session.peer !== peer) await session.run(() => session.openPeer(peer))
  await session.run(() => session.send(text))
  // 发完立刻回一遍最新的几条，前端不用再发一次轮询请求
  return { ok: true, messages: chatdb.history(botId, accountId, session.peer, { limit: 20 }) }
}

/** 翻历史：纯查库，不碰浏览器，所以不要求会话是开着的 */
export function earlier(botId, accountId, peer, beforeId) {
  return chatdb.history(botId, accountId, peer, { beforeId: Number(beforeId) || 0, limit: 40 })
}

export { chatdb }
