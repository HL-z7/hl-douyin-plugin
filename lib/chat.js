/**
 * 私信聊天的后端：为一个抖音账号维持一个常开的聊天页，读取与发送消息。
 *
 * 页面常开而不像续火那样用完即关：续火是一次性任务（进入、发送、退出），而聊天需要看到
 * 对方的回复。若每次轮询都重开 Chromium、加载登录态、等会话渲染，一轮耗时十几秒，且每轮
 * 都是一次新的登录会话 —— 从抖音侧观察是「每分钟登录一次」，风控风险高于长期保持一个会话。
 *
 * 三条约束：
 *
 * 1. 与续火争用同一把账号锁（lib/spark.js 的 acquire / release）。同一份 Cookie 同时活在
 *    两个 BrowserContext 中，在抖音侧表现为两个并发登录，掉线与触发验证均由此开始。
 *    因此一个账号在同一时刻只能有一个页面持有者：要么在续火，要么开着聊天。
 *    抢锁必须在启动浏览器之前完成，见 openSession。
 *
 * 2. 空闲关闭必须由本模块自行管理。lib/browser.js 的 #armIdleClose 判据是「是否还有非
 *    about:blank 的真实页面」，聊天页常开时该机制永不触发，Chromium 会一直占用
 *    200~400MB 直到 Yunzai 重启。用户关闭网页不会通知服务端，只能按
 *    「多久没有请求碰过这个会话」判定，即 chat.idleCloseSec。
 *
 * 3. 从页面只能读到纯文本。抖音不提供消息 id，也没有结构化时间；且 lib/browser.js 默认拦掉
 *    image/media/font，头像本身也不会加载。因此消息的身份只能是「谁说的 + 说了什么 +
 *    页面上的时间戳」，去重实现在 lib/chatdb.js 的 appendMessages。
 *
 * 导出：openSession / getSession / closeSession / closeAll / sessionList（会话生命周期），
 * conversations / openPeer / poll / send / earlier（前端接口），readBubbles（气泡解析，
 * 导出以便离线测试），以及转导出的 chatdb。
 *
 * 依赖：从 lib/spark.js 复用页面操作原语（CHAT_URL / READY_TIMEOUT / SEL / acquire /
 * release / waitForChatList / readItems / itemName / itemPreview / searchConversation /
 * openChat / typeAndSend），落盘走 lib/chatdb.js，浏览器走 lib/browser.js。
 *
 * 调用前提：除 earlier 外的前端接口都要求会话已由 openSession 打开；会话不会自动重开。
 * 进程退出与热重载必须调 closeAll，否则会留下 Chromium 进程（见 lib/shutdown.js）。
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

/** 活着的聊天会话，key 为 `botId:accountId`。受账号锁约束，同一账号只会有一个 */
const sessions = new Map()

/**
 * 消息气泡的分档选择器，与 spark.js 的 EDITORS 同一套路：先严后松。
 *
 * 抖音的聊天记录区没有稳定的语义 class，只有打包生成的混淆串。因此第一档认
 * 「明显是消息列表的容器」，最后一档退到整页匹配 —— 选中根节点之后还有 rowsIn 的
 * 「兄弟最多的那一组」这层结构判据，放宽选择器不会把非消息节点读进来。
 */
const BUBBLE_ROOTS = [
  '[class*="messageList"], [class*="MessageList"]',
  '[class*="chatContent"], [class*="ChatContent"]',
  '[class*="message"], [class*="Message"]',
]

/** 判定气泡是否为自己发出：抖音在自己那一侧的容器上挂 right/self/mine 一类的串 */
const SELF_HINT = /right|self|mine|owner|send(er)?$|isSelf/i

/** 一条气泡内需要剔除的纯噪音文本（时间分隔、状态提示），同时用于提取时间戳 */
const BUBBLE_NOISE =
  /^(刚刚|\d+\s*(分钟|小时|天)前?(内)?(在线)?|在线|昨天|前天|星期[一二三四五六日天]|已读|未读|发送中|已送达|重新发送|\d{1,2}:\d{2}|\d{4}[-/]\d{1,2}[-/]\d{1,2}([\s\d:]+)?)$/

/**
 * 一个账号的聊天会话。
 *
 * 状态机只有三态：opening → ready → closed。任何一步出错直接进 closed，原因留在 error 里，
 * 由前端展示。
 *
 * 刻意不做自动重连：会话断开的实际原因是 Cookie 失效或抖音要求人工验证，两者都需要人介入；
 * 自动重试只会在后台反复发起登录（进而触发风控），而前端看到的仍是「连不上」。
 *
 * @param {string|number} botId
 * @param {string|number} accountId
 * @param {{name: string}} account store.get 返回的账号记录，此处只用到 name
 */
class ChatSession {
  constructor(botId, accountId, account) {
    this.botId = botId
    this.accountId = accountId
    this.name = account.name
    this.status = "opening"
    this.error = ""
    /** 当前打开的会话对象（对方昵称）。空串表示仍停在会话列表 */
    this.peer = ""
    this.context = null
    this.page = null
    this.at = Date.now()
    /** 最后一次被前端请求碰到的时间，空闲关闭以它为基准 */
    this.touchedAt = Date.now()
    this.idleTimer = null
    /**
     * 串行队列。前端可能同时发来「切会话」与「发消息」，而两者操作同一个页面：并发执行会
     * 导致 openChat 点击过程中被另一个动作切走页面。因此所有页面操作排成一条链。
     */
    this.chain = Promise.resolve()
  }

  trace(...args) {
    debug(`${this.name} 聊天`, ...args)
  }

  /**
   * 把一个页面操作排进串行队列。
   * @param {() => Promise<*>} fn 页面操作，无论前一个操作成功或失败都会执行
   * @returns {Promise<*>} fn 的结果；fn 抛出的异常原样传给调用方，但不影响后续操作
   */
  run(fn) {
    const next = this.chain.then(fn, fn)
    // 队列自身永远 resolve，否则一次失败会让后面所有操作都被 reject
    this.chain = next.then(
      () => {},
      () => {}
    )
    return next
  }

  /** 记一次前端访问并重置空闲计时。所有前端接口在取到会话时都会调用 */
  touch() {
    this.touchedAt = Date.now()
    this.#armIdle()
  }

  /**
   * 无人访问后自行关闭会话。
   *
   * 这是 lib/browser.js 自动回收浏览器机制（#armIdleClose）的补充：该机制的判据是
   * 「是否还有非 about:blank 的真实页面」，聊天页常开时永不触发，Chromium 会持续占用
   * 200~400MB。用户关闭网页不会通知服务端，因此只能按「多久没有请求碰过这个会话」判定。
   *
   * 时长取 chat.idleCloseSec（夹取 30~3600 秒），默认 180 秒 —— 相当于前端 3 秒轮询
   * 连续漏掉 60 次。取这一宽度是因为重开一次会话需十几秒，用户短暂切走不应被强制重连。
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

  /**
   * 开页面、加载登录态、等聊天列表渲染完成，随后置为 ready。
   *
   * 账号锁由调用方（openSession）在启动浏览器之前抢到，此处不再判定。
   * 任何一步失败都先关掉已建出的 page/context 再抛，不留下持有登录态的页面。
   *
   * @returns {Promise<void>}
   * @throws 账号无 Cookie、搜索框未出现（Cookie 失效）、或 goto/等待超时时抛出
   */
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

  /**
   * 会话（好友）列表：先从页面读取，并进库，再按库中顺序返回。
   *
   * 返回库里的而不是页面上的：抖音的会话列表只保留近期联系人，而库中的记录不会过期，
   * 因此前端能看到历史上出现过的全部会话。
   *
   * @returns {Promise<Array>} chatdb.listConversations 的结果
   * @throws 会话已关闭或页面已失效时抛出（#assertLive）
   */
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
   * 切到指定会话，并把当前可见的气泡读进库。
   *
   * 已处于该会话时不重复点击：抖音的会话切换是本地渲染，重复点击本身无害，但会多等一轮
   * 浮层探测，而前端每 3 秒就会调一次轮询。
   *
   * @param {string} peer 对方昵称，需与会话列表中的显示名一致
   * @returns {Promise<string>} 当前会话的 peer
   * @throws 搜索不到该会话时抛「找不到与「peer」的会话」
   */
  async openPeer(peer) {
    this.#assertLive()
    if (this.peer !== peer) {
      const hit = await searchConversation(this.page, [peer], () => {}, (...a) => this.trace(...a))
      if (!hit) throw new Error(`找不到与「${peer}」的会话`)
      // 复用 spark 的 openChat：它比直接点击 handle 多两档退路（按钮文本 → 整条结果项
      // → 结果项首个子元素），并带进入会话前的浮层探测。为此在 spark.js 中将其导出
      const how = await openChat(this.page, hit.handle, (...a) => this.trace(...a))
      this.trace(`已进入与「${peer}」的会话（${how}）`)
      this.peer = peer
      chatdb.markSeen(this.botId, this.accountId, peer)
    }
    await this.pull()
    return this.peer
  }

  /**
   * 读取当前会话可见的气泡并追加进库。
   *
   * 每一轮读到的都是整屏气泡，与上一轮大量重叠，因此去重由 chatdb.appendMessages 承担：
   * 消息没有 id，只能按「self + text + stamp」组成的键找最长重叠后缀。该判据对「连发两条
   * 内容相同的消息」偏保守 —— 会被认成同一条而只存一条。这是有意的取舍：重复插入无法撤销，
   * 而漏掉的那条在下一轮读屏时仍然在页面上。
   *
   * @returns {Promise<number>} 新增条数；未选会话时返回 0
   */
  async pull() {
    this.#assertLive()
    if (!this.peer) return 0
    const bubbles = await readBubbles(this.page)
    const n = chatdb.appendMessages(this.botId, this.accountId, this.peer, bubbles)
    if (n) this.trace(`读到 ${bubbles.length} 条气泡，新增 ${n} 条`)
    return n
  }

  /**
   * 在当前会话里发送一条消息。
   * @param {string} text 消息内容，两端空白会被去掉
   * @returns {Promise<true>}
   * @throws 未选会话、内容为空，或 typeAndSend 未能确认发送时抛出
   */
  async send(text) {
    this.#assertLive()
    if (!this.peer) throw new Error("请先选择一个会话")
    const message = String(text ?? "").trim()
    if (!message) throw new Error("消息内容不能为空")
    await typeAndSend(this.page, message, (...a) => this.trace(...a))
    // 立即入库：字数已确认、Enter 已发出，前端不应等到下一轮轮询才看到自己发出的消息。
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

  /**
   * 校验会话仍可用。页面被外部关闭（浏览器崩溃、Chromium 被杀）时状态还停在 ready，
   * 因此除状态之外还要检查 page 本身，并顺带把状态修正为 closed。
   * @throws 状态非 ready，或页面已关闭时抛出
   */
  #assertLive() {
    if (this.status !== "ready") throw new Error(this.error || "聊天会话已关闭")
    if (!this.page || this.page.isClosed()) {
      this.status = "closed"
      this.error = "聊天页面已被关闭"
      throw new Error(this.error)
    }
  }

  /** 收掉计时器与页面。关闭失败不抛（closeQuietly），可重复调用 */
  async #teardown() {
    clearTimeout(this.idleTimer)
    await closeQuietly(this.page)
    await closeQuietly(this.context)
    this.page = null
    this.context = null
  }

  /**
   * 关闭会话：摘出 sessions、释放账号锁、关页面。
   *
   * 释放账号锁必须在这里完成，否则该账号之后既不能续火也不能重开聊天。
   *
   * @param {string} [why] 关闭原因，仅在 error 尚为空时写入，供前端展示
   * @returns {Promise<void>} 已关闭且页面已收掉时直接返回，可重复调用
   */
  async close(why = "") {
    if (this.status === "closed" && !this.page) return
    this.status = "closed"
    if (why && !this.error) this.error = why
    sessions.delete(`${this.botId}:${this.accountId}`)
    release(this.botId, this.accountId)
    await this.#teardown()
  }

  /** 面板与 sessionList 展示用的会话概况，不含 page/context 等运行时对象 */
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
 * 读取当前会话中可见的消息气泡。
 *
 * 导出以便离线测试：判据全部位于浏览器上下文内，喂一份仿抖音结构的 DOM 即可验证，无需真实
 * 登录（真号验证一次的代价是一次登录会话加十几秒，且无法构造对方的消息内容）。
 *
 * 判据全为结构性的，不依赖 class 名也不依赖中文文案 —— 抖音改版时打包生成的 class 一定会变，
 * 而「一组同父的兄弟节点，每个装一条消息」这一结构不会：
 *
 * 1. 按 BUBBLE_ROOTS 分档定位消息区，取第一个能读出内容的根节点
 * 2. 在根节点内按父节点归组，取成员最多的一组作为「气泡行」（同 spark.readItems 的思路）
 * 3. 每条气泡取整条 innerText，剔除纯时间/状态的行
 * 4. self 先向上查找 right/self/mine 一类的 class，命中不了则退到「气泡在容器内偏右」
 *
 * 第 4 条的坐标兜底是必需的：class 混淆后 SELF_HINT 可能全部命中不了，而「自己发出的消息
 * 靠右」是这类 IM 界面长期稳定的布局约定。
 *
 * @param {import("puppeteer").Page} page
 * @returns {Promise<Array<{self: boolean, text: string, stamp: string}>>}
 *   按页面上的先后顺序返回；evaluate 失败（页面正在导航或已关闭）时返回空数组，不抛
 */
export async function readBubbles(page) {
  return page
    .evaluate(
      ([roots, selfHint, noise]) => {
        const selfRe = new RegExp(selfHint)
        const noiseRe = new RegExp(noise)

        /** 在一个根节点内定位「气泡行」：按父节点归组，返回成员最多的那一组 */
        const rowsIn = root => {
          const groups = []
          for (const el of root.children.length ? [...root.querySelectorAll("*")] : []) {
            // 只取有文本的节点；超过 2000 字的一定是包着整个列表的容器，不是单条气泡
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

          // 时间戳：本条内被判为噪音、且含数字的那一行。抖音不提供结构化时间，
          // 它与 self、text 一起构成消息的身份（去重键，见 chatdb.js 的 key）
          const stamp =
            raw
              .split("\n")
              .map(s => s.trim())
              .find(s => noiseRe.test(s) && /\d/.test(s)) || ""

          // self 判定第一档：从气泡自身向上直到 body，找 right/self/mine 一类的标记。
          // className 之外一并看 data-e2e：class 被混淆时它有时仍保留语义
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
            // 整条都在中线右侧才算自己发出：靠左的与横跨整宽的（系统提示）都不算
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
 * 抢账号锁在启动浏览器之前完成：抢不到时直接告知占用方，避免先花十几秒启动一个 Chromium
 * 再失败。open() 失败时把会话摘出 sessions 并立即释放锁，否则该账号将永久无法续火或聊天。
 *
 * @param {string|number} botId
 * @param {string|number} accountId
 * @returns {Promise<ChatSession>} 已存在且未关闭时原样返回（并刷新空闲计时）
 * @throws 账号不存在、账号锁被占（acquire 抛出），或 open() 失败时抛出
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

/**
 * 取一个已打开的会话，前端所有后续操作都经由它。取到即视为一次访问，顺带刷新空闲计时。
 * @param {string|number} botId
 * @param {string|number} accountId
 * @returns {ChatSession}
 * @throws 会话不存在或已关闭时抛「聊天会话未打开或已关闭，请重新进入」
 */
export function getSession(botId, accountId) {
  const session = sessions.get(`${botId}:${accountId}`)
  if (!session || session.status === "closed")
    throw new Error("聊天会话未打开或已关闭，请重新进入")
  session.touch()
  return session
}

/**
 * 关闭一个会话。用户点「退出聊天」或账号被删除时调用。
 * @param {string|number} botId
 * @param {string|number} accountId
 * @returns {Promise<boolean>} 该会话是否存在
 */
export async function closeSession(botId, accountId) {
  const session = sessions.get(`${botId}:${accountId}`)
  if (!session) return false
  await session.close("已手动关闭")
  return true
}

/**
 * 关闭全部会话。热重载与 Yunzai 退出时必须调用，否则会留下持有登录态的 Chromium
 * （调用点见 lib/shutdown.js）。
 * @param {string} [why="插件重载"] 关闭原因
 * @returns {Promise<number>} 关闭的会话数
 */
export async function closeAll(why = "插件重载") {
  const list = [...sessions.values()]
  for (const session of list) await session.close(why)
  return list.length
}

/**
 * 当前打开着的会话概况，供面板状态展示（lib/panel.js 的 chatBrief）。
 * @returns {Array<object>} 各会话的 info()，不含 page/context
 */
export function sessionList() {
  return [...sessions.values()].map(s => s.info())
}

/**
 * 会话列表的读取入口。
 *
 * 会话未打开时不自动打开：开一次需十几秒并要抢账号锁，那属于用户点「进入聊天」时的动作，
 * 不应由一次列表请求触发。
 *
 * @param {string|number} botId
 * @param {string|number} accountId
 * @returns {Promise<Array>} 会话列表
 * @throws 会话未打开时由 getSession 抛出
 */
export async function conversations(botId, accountId) {
  const session = getSession(botId, accountId)
  return session.run(() => session.conversations())
}

/**
 * 进入指定会话，并一次性返回该会话的历史消息。
 * @param {string|number} botId
 * @param {string|number} accountId
 * @param {string} peer 对方昵称
 * @returns {Promise<{peer: string, messages: Array}>} messages 为 chatdb.history 的默认页
 * @throws 会话未打开，或搜索不到该 peer 时抛出
 */
export async function openPeer(botId, accountId, peer) {
  const session = getSession(botId, accountId)
  await session.run(() => session.openPeer(peer))
  return {
    peer: session.peer,
    messages: chatdb.history(botId, accountId, peer),
  }
}

/**
 * 轮询：先读一遍页面上的新气泡，再把 sinceId 之后的消息返回给前端。
 *
 * 顺序不可颠倒。先读页面再查库，否则刚到达的消息要等下一轮才会出现，前端可见延迟从
 * 「一个轮询周期」变成「两个」。
 *
 * peer 与当前会话不一致时顺带切会话，因此前端切换会话可以只发一次 poll。
 *
 * @param {string|number} botId
 * @param {string|number} accountId
 * @param {string} [peer] 期望所处的会话；留空表示沿用当前会话
 * @param {number|string} [sinceId=0] 前端已有的最大消息 id，只返回它之后的
 * @returns {Promise<{peer: string, messages: Array, status: string}>}
 * @throws 会话未打开或已关闭时抛出
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

/**
 * 发送一条消息。peer 与当前会话不一致时先切会话，两个动作各自排进串行队列。
 * @param {string|number} botId
 * @param {string|number} accountId
 * @param {string} [peer] 目标会话；留空表示发到当前会话
 * @param {string} text 消息内容
 * @returns {Promise<{ok: true, messages: Array}>} messages 为最新 20 条
 * @throws 会话未打开、未选会话、内容为空，或发送未被确认时抛出
 */
export async function send(botId, accountId, peer, text) {
  const session = getSession(botId, accountId)
  if (peer && session.peer !== peer) await session.run(() => session.openPeer(peer))
  await session.run(() => session.send(text))
  // 发送后直接回一批最新消息，前端不必再发一次轮询请求
  return { ok: true, messages: chatdb.history(botId, accountId, session.peer, { limit: 20 }) }
}

/**
 * 向上翻历史。纯查库，不触碰浏览器，因此不要求会话处于打开状态 —— 用户看完退出后仍可翻阅。
 * @param {string|number} botId
 * @param {string|number} accountId
 * @param {string} peer 对方昵称
 * @param {number|string} beforeId 取该 id 之前的消息；0 表示从最新一条往前
 * @returns {Array} 每页固定 40 条（未读取 chat.historyLimit，见该配置项说明）
 */
export function earlier(botId, accountId, peer, beforeId) {
  return chatdb.history(botId, accountId, peer, { beforeId: Number(beforeId) || 0, limit: 40 })
}

// 转导出，使调用方（lib/web.js、lib/panel.js）不必再单独 import chatdb
export { chatdb }
