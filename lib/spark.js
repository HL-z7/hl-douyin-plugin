/**
 * 续火引擎：用无头浏览器在抖音网页版聊天页搜好友、发消息。
 *
 * 三个关键设计：
 * 1. **一个账号一次运行一个浏览器上下文**，跑完即销毁。长期挂着登录态页面会被抖音
 *    的心跳与推荐流持续打扰，也更容易在进程崩溃时留下半开的 Chromium。
 * 2. **多候选名搜索 + 自愈**。好友改昵称是断火最常见的原因，目标带别名列表
 *    （见 lib/store.js 的 SparkTarget），按主名称 → 别名依次搜，命中别名时把它
 *    提为主名称写回，下次直接用新名字搜。
 * 3. **同账号串行**。`running` Map 挡住定时任务与面板手动触发撞车，
 *    多账号之间也是串行——并行开多个 Chromium 家用机内存扛不住，风控也更敏感。
 */
import path from "node:path"
import {
  dataDir,
  ensureDir,
  log,
  sleep,
  oneLine,
  safeFileName,
  formatTime,
  toError,
  isSameShanghaiDay,
} from "./util.js"
import { config } from "./config.js"
import { store, targetCandidates, targetLabel } from "./store.js"
import { audit } from "./audit.js"
import browserManager, { closeQuietly, randomSleep } from "./browser.js"
import { renderMessage, normalizeTemplate } from "./template.js"
import { debug, debugOn, describeLine, snapshot } from "./debug.js"
import { clickAt, clickByText, clickHandle, typeText, pressKey, visibleBox } from "./interact.js"

const shotDir = () => ensureDir(dataDir, "screenshots")

const CHAT_URL = "https://www.douyin.com/chat"
const READY_TIMEOUT = 30000
const IDLE_TIMEOUT = 10000
const SEARCH_TIMEOUT = 5000
const SEARCH_RETRY_INTERVAL = 2000
const SEARCH_RESET_DELAY = 500
/**
 * 等旧搜索结果收起的上限。
 *
 * 不能用 SEARCH_TIMEOUT：抖音的搜索面板在输入框获得焦点时就会挂出「最近会话」，
 * 清空输入并不会让它消失，于是每次搜索都要在这里白等满 5 秒（现场每个候选名都慢
 * 5 秒，三轮重试就是 15 秒）。而残留项本身并不危险 —— 匹配是按名字挑的，上一个
 * 候选名的残留结果不会被当成这一个，所以这里等不到就直接往下走。
 */
const SEARCH_CLEAR_TIMEOUT = 1500

/**
 * 给候选项临时打的序号属性。
 *
 * 读文本和点元素得是同一个东西，而抖音的列表随时重渲染，靠「第 N 个」二次查询很容易
 * 错位。所以读的时候顺手把序号写进属性，回来按属性取 handle。
 */
const SLOT_ATTR = "data-dy-slot"

const SEL = {
  search: 'input.semi-input[placeholder="搜索"]',
  conversation: '[class*="conversation"], [class*="Conversation"]',
  searchItem: ".SearchPanelitembox",
}

/**
 * 消息输入框的分档选择器，从最严到最松依次试。
 *
 * 原来只认第一档，而它带着 `.messageEditorimChatEditorContainer` —— 这是抖音打包时
 * 生成的混淆 class，发一次版就可能变成别的串。现场报的
 * `Waiting for selector ... failed` 就是这么来的：会话已经打开、输入框也在，
 * 只是外层那个 class 不叫这个名字了，于是等满 10 秒、当次「发送 0 条」。
 *
 * 分档的意义在于**先严后松**：第一二档能命中时就用它们（确定是聊天编辑器），
 * 命中不了才退到「页面上任何一个可见的 contenteditable」。最后一档确实有点宽，
 * 但抖音聊天页除了消息输入框没有别的可编辑区域，而「宽一点」的代价（万一点错地方，
 * 消息发不出去）远小于「严一点」的代价（版本一变整个功能直接不可用）。
 * 命中的是哪一档会写进 debug 日志，抖音改版时一眼能看出来。
 */
const EDITORS = [
  '.messageEditorimChatEditorContainer [data-slate-editor="true"][contenteditable="true"]',
  '[data-slate-editor="true"][contenteditable="true"]',
  '[class*="ChatEditor"] [contenteditable="true"], [class*="chatEditor"] [contenteditable="true"]',
  '[contenteditable="true"]',
]

/** 等输入框出现的上限。会话是本地渲染的，慢也慢不到哪去，但首屏偶尔要拉历史消息 */
const EDITOR_TIMEOUT = 12000

/** 轮询输入框的间隔 */
const EDITOR_POLL = 400

/** 同一账号不允许并发跑，定时任务和面板手动触发撞车时后者直接被拒 */
const running = new Map()

export function isRunning(botId, accountId) {
  return running.has(`${botId}:${accountId}`)
}

export function runningList() {
  return [...running.keys()]
}

/**
 * 该账号今天是否已经成功续过火。
 *
 * 只认 `lastSuccessAt`（见 store.recordRun）：失败那次不算数，同一天下次定时还要重试。
 * 日期按 Asia/Shanghai 判定，服务器在国外时不会提前或推迟一天翻页。
 */
export function doneToday(account) {
  return isSameShanghaiDay(account?.lastSuccessAt)
}

/**
 * 跑一个账号的续火。
 *
 * @param {object} [opts]
 * @param {(msg: string) => void} [opts.onProgress] 进度回调，面板 SSE 与日志共用
 * @param {boolean} [opts.skipIfDone] 今天已成功就跳过。定时任务传 `spark.skipIfDone`，
 *   手动 `#抖音续火` 不传（用户明确要发就发），`#抖音续火 跳过` 才传 true
 * @returns {Promise<{ok:boolean, skipped:boolean, sent:Array, missing:Array, renamed:Array, error:string, durationMs:number, cookieInvalid:boolean}>}
 */
export async function runAccount(botId, accountId, { onProgress, skipIfDone = false } = {}) {
  const key = `${botId}:${accountId}`
  if (running.has(key)) throw new Error("该账号正在续火中，请稍后再试")

  const account = store.get(botId, accountId)
  if (!account) throw new Error("账号不存在")
  if (!account.targets?.length) throw new Error("该账号没有配置续火好友")

  // 跳过判定放在开浏览器之前：既省一次 Chromium 启动，也避免无谓地碰抖音
  if (skipIfDone && doneToday(account)) {
    return {
      ok: true,
      skipped: true,
      sent: [],
      missing: [],
      renamed: [],
      error: "",
      durationMs: 0,
      cookieInvalid: false,
    }
  }

  const cookies = store.cookies(botId, accountId)
  if (!cookies?.length) {
    store.markCookieInvalid(botId, accountId, true)
    throw new Error("该账号没有可用 Cookie，请重新登录")
  }

  running.set(key, Date.now())
  const started = Date.now()
  const result = {
    ok: false,
    skipped: false,
    sent: [],
    missing: [],
    renamed: [],
    error: "",
    durationMs: 0,
    cookieInvalid: false,
  }
  const timeoutMs = config.num("spark.accountTimeoutMs", 300000, { min: 30000 })

  try {
    await withTimeout(sparkOnce(botId, account, cookies, result, onProgress), timeoutMs, "账号执行超时")
    result.ok = !result.error && result.missing.length === 0
  } catch (error) {
    const err = toError(error)
    result.error = err.message
    result.ok = false
    if (/Cookie 可能已经失效|未登录/.test(err.message)) result.cookieInvalid = true
  } finally {
    running.delete(key)
    result.durationMs = Date.now() - started
    store.recordRun(botId, accountId, result)
    if (result.cookieInvalid) store.markCookieInvalid(botId, accountId, true)
    audit.add("spark.run", {
      botId,
      accountId,
      account: account.name,
      ok: result.ok,
      sent: result.sent.length,
      missing: result.missing.length,
      renamed: result.renamed.length,
      error: result.error,
    })
  }

  return result
}

/** 真正的浏览器流程，抽出来方便套超时 */
async function sparkOnce(botId, account, cookies, result, onProgress) {
  const { context, page } = await browserManager.openPage(cookies)
  const notify = msg => {
    log("info", `[${account.name}] ${msg}`)
    try {
      onProgress?.(msg)
    } catch {}
  }
  /** 只进日志、不进面板进度条的细节。开关关掉时零开销 */
  const trace = (...args) => debug(account.name, ...args)

  try {
    notify("打开抖音聊天页")
    const resp = await page.goto(CHAT_URL, { waitUntil: "domcontentloaded", timeout: READY_TIMEOUT })
    trace(`已打开 ${CHAT_URL}：HTTP ${resp?.status?.() ?? "?"}`)
    if (debugOn()) trace(`页面现状 ${await describeLine(page)}`)

    const searchReady = await page
      .waitForSelector(SEL.search, { visible: true, timeout: READY_TIMEOUT })
      .then(() => true)
      .catch(() => false)
    trace(`等搜索框（${SEL.search}）：${searchReady ? "已出现" : "未出现"}`)
    if (!searchReady) {
      if (debugOn()) trace(`搜索框没等到，页面现状 ${await describeLine(page)}`)
      await snapshot(page, `${account.name}-no-search`)
      throw new Error("聊天页搜索框未出现，Cookie 可能已经失效")
    }

    await waitForChatList(page, notify, trace)
    await snapshot(page, `${account.name}-chat-ready`)

    const template = normalizeTemplate(
      account.messageTemplate || config.get("spark.messageTemplate", ""),
      `账号 ${account.name} 的消息模板`
    )
    const includeSource = config.bool("spark.yiyanIncludeSource", true)
    const minGap = config.num("spark.minGapMs", 2500, { min: 0 })
    const maxGap = Math.max(minGap, config.num("spark.maxGapMs", 6000, { min: 0 }))
    trace(`模板=${template ? "自定义" : "一言"} 间隔=${minGap}~${maxGap}ms 目标 ${account.targets.length} 个`)

    for (const [index, target] of account.targets.entries()) {
      const label = targetLabel(target)
      notify(`搜索会话：${label}`)
      trace(`目标 ${index + 1}/${account.targets.length}：候选名 ${targetCandidates(target).join(" / ")}`)

      const hit = await searchConversation(page, targetCandidates(target), notify, trace)
      if (!hit) {
        await screenshot(page, `${account.name}-${target.name}-search`)
        await snapshot(page, `${account.name}-${target.name}-missing`)
        result.missing.push(label)
        notify(`未找到会话，跳过：${label}`)
        continue
      }

      // 命中的是别名 —— 好友改名了，把新名字提为主名称，下次直接用它搜
      if (hit.name !== target.name) {
        if (store.promoteAlias(botId, account.id, target.name, hit.name)) {
          result.renamed.push({ from: target.name, to: hit.name })
          notify(`好友已改名：${target.name} → ${hit.name}，续火目标已自动更新`)
        }
      }

      const message = renderMessage({ template, account: account.name, friend: hit.name, includeSource })
      await sendMessage(page, hit.handle, message, trace)

      result.sent.push({ friend: hit.name, note: target.note || "", message, at: Date.now() })
      notify(`已发送：${hit.name}`)

      if (index < account.targets.length - 1) await randomSleep(minGap, maxGap)
    }

    // 等最后一条消息真正落到服务端再关页面
    await new Promise(r => setTimeout(r, 3000))

    if (result.missing.length)
      result.error =
        `以下会话未找到，火花可能已中断：${result.missing.join("、")}。` +
        "好友改昵称是最常见原因，可以用 `#抖音备注` 把新昵称加进别名，或在抖音里给好友设备注名。"
  } catch (error) {
    if (debugOn()) trace(`失败：${toError(error).message}，页面现状 ${await describeLine(page)}`)
    await snapshot(page, `${account.name}-failed`)
    if (config.bool("spark.screenshotOnFail", true)) await screenshot(page, account.name)
    throw error
  } finally {
    await closeQuietly(page)
    await closeQuietly(context)
  }
}

/**
 * 等会话列表真渲染出来再搜。搜索框先于列表出现，此时抖音的搜索索引还没就绪，
 * 结果面板恒空，会把好友误判成「改名了」。
 */
async function waitForChatList(page, notify, trace = () => {}) {
  const ready = await page
    .waitForSelector(SEL.conversation, { visible: true, timeout: READY_TIMEOUT })
    .then(() => true)
    .catch(() => false)
  trace(`等会话列表（${SEL.conversation}）：${ready ? "已渲染" : "未出现"}`)
  if (!ready) notify("会话列表未在预期时间内出现，依赖搜索重试兜底")
  const idle = await page
    .waitForNetworkIdle({ idleTime: 800, timeout: IDLE_TIMEOUT })
    .then(() => true)
    .catch(() => false)
  trace(`等网络空闲：${idle ? "已空闲" : `${IDLE_TIMEOUT}ms 内未空闲，继续`}`)
}

/* ---------- 会话项文本的读取与匹配 ----------
 * 抖音的会话项/搜索结果项没有「昵称」这个独立可选中的元素：一条会话读出来是
 * `主号19:0310分钟内在线`——昵称、最后活跃时间、在线状态全挤在一起，有时昵称本身
 * 还会被搜索高亮拆成 `主` + `号` 两个 <span>。
 *
 * 所以匹配不能是「某个后代元素的 textContent 正好等于名字」（改之前就是这么写的，
 * 现场因此出现「搜「主号」未命中：结果 1 条」——搜出来了，比不上）。这里改成分档匹配，
 * 从最严到最松依次试，并把命中用的是哪一档记进日志，方便下次看清是哪种形变。
 */
const TIER_EXACT = 0
const TIER_STRIP = 1
const TIER_LEAF = 2
const TIER_ITEM = 3
const TIER_NOTE = ["完全相同", "去掉时间/在线状态后相同", "文本包含", "整条包含"]

/**
 * 会话项里跟昵称粘在一起的固定噪音：最后活跃时间与在线状态。
 * 只列抖音真会出现的形态，宁可漏一种（还有下面两档兜底）也不要拿宽正则去啃昵称本身。
 */
const NOISE_RE =
  /(刚刚|\d+\s*(分钟|小时|天)前?(内)?(在线)?|在线|\d{1,2}:\d{2}|昨天|前天|星期[一二三四五六日天]|\d{4}[-/]\d{1,2}[-/]\d{1,2}|\d{1,2}[-/]\d{1,2})/g

/**
 * 名字归一化。
 *
 * NFKC 把全角字符折成半角（抖音昵称里全角字母数字很常见，而用户在面板上打的是半角）；
 * 零宽字符是挂件昵称的常客，肉眼看不见但会让 `===` 直接失败。
 * 大小写与空白也一并抹平——这几样都不改变「是同一个人」这个判断。
 */
function normName(text) {
  return String(text ?? "")
    .normalize("NFKC")
    .replace(/[​-‏⁠﻿︎️]/g, "")
    .replace(/\s+/g, "")
    .toLowerCase()
}

/** 去掉时间与在线状态后的名字，用于第二档匹配 */
function stripNoise(text) {
  return normName(text).replace(NOISE_RE, "")
}

/**
 * 读出一批列表项的文本，同时给每项打上序号属性。
 *
 * 打属性是为了「读到的那一条」和「点下去的那一条」是同一个元素：抖音的列表随时重渲染，
 * 按下标二次 `page.$$` 很容易错位，点到别人身上就是发错人。
 *
 * 每项给两份文本：`leaves` 是叶子元素各自的文本（昵称大概率是其中一条），`all` 是整条
 * 拼起来的文本（昵称被高亮拆散时只有它还完整）。
 *
 * @returns {Promise<Array<{slot:number, leaves:string[], all:string}>>}
 */
async function readItems(page, selector) {
  return page
    .evaluate(
      ([sel, attr]) => {
        // 先把上一轮的序号清掉，否则重渲染后残留的属性会让我们按序号取到一个陈旧元素
        for (const el of document.querySelectorAll(`[${attr}]`)) el.removeAttribute(attr)

        /*
         * 先定位「一条会话」到底是哪个元素。
         *
         * `[class*="conversation"]` 是模糊匹配 class，一条会话从外层容器到里面的行、格子，
         * 每一层的 class 都带 conversation，于是同一个好友会被数成十几个节点（现场那句
         * 「读到 5 个昵称」就是这么来的：五个「昵称」其实是同一条会话的五个嵌套层级，
         * 于是面板上并排列出 `主号19:0310分钟内在线` / `主号19:03` / `主号` / `19:03` /
         * `10分钟内在线`）。而光取最外层也不行——最外层是整张列表，几个好友会被并成一条。
         *
         * 判据用「谁的兄弟最多」，纯结构、不认 class 名也不认任何中文文案：把所有命中节点
         * 按父节点归组，会话行是一批同父的兄弟，而各层容器每种只有一个，所以**成员最多的
         * 那一组就是会话行**。同层的标题行/副标题行虽然总数一样多，但它们分散在各自会话
         * 内部、每组只有一两个，不会被选上。
         *
         * 试过两条路都不行，记下来免得再走：
         * - 认时间戳（「每条会话必然带一个 19:03」）：会话只有一条时整张列表也只带一个时间，
         *   分不出容器和行；「互动消息」这类系统入口压根没有时间。
         * - 认 class 名相同：抖音会给当前选中的那一行挂上 active 之类的额外 class，
         *   按 class 串归组会把那一行单独分出去。
         */
        const groups = []
        for (const el of document.querySelectorAll(sel)) {
          const parent = el.parentElement
          if (!parent) continue
          let group = groups.find(g => g.parent === parent)
          if (!group) {
            let level = 0
            for (let p = parent.closest(sel); p; p = p.parentElement?.closest(sel)) level++
            group = { parent, level, items: [] }
            groups.push(group)
          }
          group.items.push(el)
        }
        let picked = null
        for (const group of groups)
          if (
            !picked ||
            group.items.length > picked.items.length ||
            // 一样多时取更靠外的那一层：会话行一定在它自己的内部结构之上
            (group.items.length === picked.items.length && group.level < picked.level)
          )
            picked = group

        const out = []
        for (const item of picked?.items || []) {
          const slot = out.length
          item.setAttribute(attr, String(slot))
          const leaves = []
          for (const el of item.querySelectorAll("*")) {
            if (el.children.length) continue
            const text = el.textContent?.trim() || ""
            if (text && text.length <= 40 && !leaves.includes(text)) leaves.push(text)
          }
          out.push({ slot, leaves, all: (item.textContent || "").replace(/\s+/g, " ").trim().slice(0, 120) })
        }
        return out
      },
      [selector, SLOT_ATTR]
    )
    .catch(() => [])
}

/**
 * 从一条会话项里取昵称，给面板的候选列表用。
 *
 * 判据是「DOM 顺序里第一条不是纯噪音的叶子文本」：抖音的会话项里昵称排在最前，
 * 后面才是时间、在线状态与最近一条消息的预览。
 *
 * 注意返回的是**原文**而不是归一化后的值：这个名字要显示在面板上、还要被当成搜索词
 * 打进抖音的搜索框，归一化过的（去空格、转小写）搜不出东西。
 */
function itemName(item) {
  for (const leaf of item.leaves || []) {
    // 整条都是时间或在线状态的，跳过
    if (!stripNoise(leaf)) continue
    return leaf
  }
  // 昵称直接挂在容器的文本节点上、没有独立叶子元素时，退到整条文本去噪
  const fallback = String(item.all || "").replace(NOISE_RE, "").trim()
  return fallback.slice(0, 40)
}

/**
 * 在一批列表项里挑出目标好友，分档从严到松。
 *
 * 松档（包含匹配）可能同时套住几个人：找「主号」而列表里还有「主号2」「主号小号」。
 * 那种情况一律返回 `ambiguous`，让调用方判未命中 —— 发错人比不发严重得多，
 * 而这时用户只要把名字写全（或加别名）就能自己解开。严档（完全相同 / 去噪后相同）
 * 不做这个检查：名字都一模一样了，多命中一条只能是抖音把同一会话渲染了两遍。
 *
 * @returns {{slot:number, tier:number, text:string, ambiguous?:string[]}|null}
 */
function pickMatch(items, name) {
  const want = normName(name)
  if (!want) return null
  const wantStripped = stripNoise(name)
  let best = null
  const hits = new Map()
  const take = (slot, tier, text) => {
    if (!hits.has(slot) || tier < hits.get(slot).tier) hits.set(slot, { slot, tier, text })
    if (!best || tier < best.tier) best = hits.get(slot)
  }

  for (const item of items) {
    for (const leaf of item.leaves) {
      const norm = normName(leaf)
      if (norm === want) take(item.slot, TIER_EXACT, leaf)
      else if (wantStripped && stripNoise(leaf) === wantStripped) take(item.slot, TIER_STRIP, leaf)
      // 「主号19:0310分钟内在线」这种粘成一串的，只能靠包含判
      else if (want.length >= 2 && norm.includes(want)) take(item.slot, TIER_LEAF, leaf)
    }
    // 昵称被搜索高亮拆成几个 span 时，只有整条文本还是连着的
    if (want.length >= 2 && normName(item.all).includes(want)) take(item.slot, TIER_ITEM, item.all)
  }
  if (!best) return null

  // 松档下的重名歧义：同一档里套住了不止一条，说明这个名字不足以定位到人
  if (best.tier >= TIER_LEAF) {
    const same = [...hits.values()].filter(h => h.tier === best.tier)
    if (same.length > 1) return { ...best, ambiguous: same.map(h => h.text) }
  }
  return best
}

/**
 * 按候选名依次搜索会话，任一命中即返回。
 *
 * 外层是重试轮次、内层是候选名：先用全部候选名各试一遍，都没中才等一会儿重试下一轮。
 * 反过来（每个名字自己重试满）会在好友确实改名时白等 `candidates.length × retry` 轮。
 *
 * @param {string[]} candidates 主名称在前、别名在后
 * @returns {Promise<{handle: import("puppeteer").ElementHandle, name: string}|null>}
 */
async function searchConversation(page, candidates, notify, trace = () => {}) {
  const names = (Array.isArray(candidates) ? candidates : [candidates]).filter(Boolean)
  if (!names.length) return null
  const retry = Math.max(1, config.num("spark.searchRetry", 3, { min: 1, max: 10 }))

  for (let attempt = 1; attempt <= retry; attempt++) {
    for (const name of names) {
      const handle = await searchOnce(page, name, trace)
      if (handle) {
        trace(`第 ${attempt} 轮用「${name}」命中`)
        return { handle, name }
      }
    }

    if (attempt < retry) {
      notify(`第 ${attempt} 次搜索未命中（已试 ${names.join("、")}），${SEARCH_RETRY_INTERVAL}ms 后重试`)
      await sleep(SEARCH_RETRY_INTERVAL)
    }
  }

  /*
   * 搜索全军覆没之后，直接在左侧会话列表里找。
   *
   * 这条路是现场逼出来的：搜「又在說我壞話」抖音返回 0 条，而那个会话就明明白白挂在
   * 左边列表里（面板的「拉取好友会话列表」按钮读到的就是它）。抖音的搜索索引对繁体、
   * emoji、刚改的备注名都不太可靠，而列表是当前登录态直接渲染出来的，反而更可信。
   *
   * 放在搜索之后而不是之前：列表只有前几十条（要滚动才加载更多），搜索才是覆盖全量好友
   * 的那条路。所以先搜，搜不到再翻列表。
   */
  return findInChatList(page, names, trace)
}

/** 在左侧会话列表里直接找，搜索走不通时的兜底 */
async function findInChatList(page, names, trace = () => {}) {
  // 搜索面板开着会盖住会话列表，先把搜索词清掉让列表回来
  await fillSearch(page, "").catch(() => "")
  await sleep(SEARCH_RESET_DELAY)

  const items = await readItems(page, SEL.conversation)
  if (!items.length) {
    trace("会话列表兜底：一条会话都读不到")
    return null
  }

  for (const name of names) {
    const best = pickMatch(items, name)
    if (!best) continue
    if (best.ambiguous) {
      trace(`会话列表兜底：「${name}」同时套住 ${best.ambiguous.length} 条（${best.ambiguous.map(t => `「${oneLine(t, 16)}」`).join("")}），不敢猜`)
      continue
    }
    const handle = await page.$(`[${SLOT_ATTR}="${best.slot}"]`)
    if (!handle) continue
    trace(`会话列表兜底：用「${name}」按${TIER_NOTE[best.tier]}命中「${oneLine(best.text, 32)}」`)
    return { handle, name }
  }

  trace(`会话列表兜底也没找到，列表里是 ${items.map(item => `「${oneLine(item.leaves[0] || item.all, 20)}」`).join("")}`)
  return null
}

/**
 * 单次搜索。每次都先清空输入框并等旧结果收起，
 * 否则会读到上一个候选名残留的列表项，导致发错人。
 */
async function searchOnce(page, name, trace = () => {}) {
  await fillSearch(page, "")
  const cleared = await page
    .waitForFunction(sel => !document.querySelector(sel), { timeout: SEARCH_CLEAR_TIMEOUT }, SEL.searchItem)
    .then(() => true)
    .catch(() => false)
  await sleep(SEARCH_RESET_DELAY)
  const typed = await fillSearch(page, name)
  // 搜索框里到底进去了什么，只有读回来才知道。「0 条结果」有两种完全不同的原因：
  // 抖音真搜不到，和字根本没落进框里（繁体、emoji 昵称遇上受控组件时出现过），
  // 而这两种在日志里长得一模一样
  if (typed !== name) trace(`⚠ 搜索框里是「${typed}」，与要搜的「${name}」不一致`)

  /*
   * 轮询而不是 waitForFunction：判定要在 Node 侧做。
   *
   * 以前的判据是「某个后代元素的 textContent 正好等于名字」，写在 waitForFunction 里，
   * 于是失败时只能得到一个 false，看不见页面上实际是什么。现场就卡在这：日志说
   * 「搜「主号」未命中：结果 1 条」—— 明明搜出来了，却不知道那一条长什么样，
   * 也就无从判断是名字带了后缀、被高亮标签拆开了，还是和时间粘在了一起。
   */
  const deadline = Date.now() + SEARCH_TIMEOUT
  let items = []
  let best = null
  while (true) {
    items = await readItems(page, SEL.searchItem)
    best = pickMatch(items, name)
    // 歧义不算命中，继续等：结果还在往里渲染时，晚一点可能出现严档的那一条
    if ((best && !best.ambiguous) || Date.now() >= deadline) break
    await sleep(300)
  }

  if (best?.ambiguous) {
    // 与会话列表兜底同一条规矩：松档套住不止一个人时宁可不发。发错人比不发严重得多
    trace(
      `搜「${name}」同时套住 ${best.ambiguous.length} 条（${best.ambiguous
        .map(t => `「${oneLine(t, 16)}」`)
        .join("")}），不敢猜`
    )
    return null
  }

  if (best) {
    const handle = await page.$(`${SEL.searchItem}[${SLOT_ATTR}="${best.slot}"]`)
    if (handle) {
      // 完全相同不用记，日志只留发生了形变的那几档 —— 那才是下次排查要看的
      if (best.tier > TIER_EXACT) trace(`搜「${name}」按${TIER_NOTE[best.tier]}命中：「${oneLine(best.text, 32)}」`)
      return handle
    }
    // 属性都在，还取不到 handle，只能是这一瞬间列表重渲染了。下一轮重试会再来一次
    trace(`搜「${name}」命中第 ${best.slot} 条，但取 handle 时列表已重渲染`)
    return null
  }

  // 结果条数与每条的名字一起报出来：「一条都没有」多半是搜索索引没就绪或字没进框，
  // 「有几条但名字对不上」才是好友改名或备注不一致 —— 这两种排查方向完全不同
  const seen = items.length
    ? `，页面上是 ${items.map(item => `「${oneLine(item.leaves[0] || item.all, 24)}」`).join("")}`
    : ""
  trace(`搜「${name}」未命中：结果 ${seen ? `${items.length} 条${seen}` : "0 条"}${cleared ? "" : "（上一轮结果未清空，可能有残留）"}`)
  return null
}

/** 清空并输入搜索词：受控组件用 page.type 之前必须真的清空，直接改 value 不触发 React */
async function fillSearch(page, value) {
  const input = await page.waitForSelector(SEL.search, { visible: true, timeout: READY_TIMEOUT })
  await input.click({ clickCount: 3 })
  await page.keyboard.press("Backspace")
  if (value) await input.type(value, { delay: 40 })
  return input.evaluate(el => el.value ?? "").catch(() => "")
}

/**
 * 点搜索结果里的「发消息 / 发私信」入口。
 *
 * 为什么不再用 `el.click()`（改之前就是那么写的）：`node.click()` 只派发一个 click 事件，
 * 而抖音这个按钮是 React 组件，响应挂在 pointerdown/mousedown 上的话它压根收不到 ——
 * 现场的表现正是「点了，右侧聊天区还是空占位」，然后等输入框等到超时。
 * 所以走 lib/interact.js 那条链路：真鼠标 approach + hover + 按住 70ms，
 * 事件没进 DOM 再补一轮合成事件。判据与远程验证共用一份。
 *
 * 三档依次退：按钮文本 → 整个结果项 → 结果项里第一个像头像/昵称的子元素。
 *
 * @returns {Promise<string>} 走的是哪一档，写进日志
 */
async function openChat(page, item, trace = () => {}) {
  // 按钮常常只在 hover 时才渲染出来，所以先把鼠标挪到结果项上
  const byText = await clickByText(page, /^(发消息|发私信)$/, { root: item, hover: true, scope: "进入会话" })
  if (byText.ok) return `点「${byText.text}」`
  trace(`没点到「发消息」按钮（${byText.reason}），改点整条结果项`)

  const byItem = await clickHandle(page, item, { scope: "进入会话" })
  if (byItem.ok) return "点整条结果项"

  // 结果项自己不可见（被折叠/在滚动容器外）时退到它的第一个可见子元素
  const child = await item.$(":scope > *")
  if (child) {
    const byChild = await clickHandle(page, child, { scope: "进入会话" })
    await child.dispose().catch(() => {})
    if (byChild.ok) return "点结果项的首个子元素"
  }
  throw new Error(`点不进会话：${byItem.reason}`)
}

/**
 * 等消息输入框出现，分档试 EDITORS。
 *
 * 不用 `page.waitForSelector` 逐档串行等：那样最坏情况是 4 档 × 12 秒。这里改成
 * 一轮里把四档都问一遍，问不到就等 400ms 再来一轮，总上限还是 12 秒。
 *
 * @returns {Promise<{handle: import("puppeteer").ElementHandle, tier: number, sel: string}>}
 */
async function waitForEditor(page, trace = () => {}) {
  const deadline = Date.now() + EDITOR_TIMEOUT
  let rounds = 0
  for (;;) {
    rounds++
    for (const [tier, sel] of EDITORS.entries()) {
      const handle = await page.$(sel).catch(() => null)
      if (!handle) continue
      // $ 只管有没有这个节点，可见性得自己判 —— 抖音会把上一个会话的编辑器留在 DOM 里
      const box = await visibleBox(handle)
      if (box) {
        if (tier > 0) trace(`输入框用的是第 ${tier + 1} 档选择器（${sel}），抖音可能改过 class`)
        return { handle, tier, sel, box }
      }
      await handle.dispose().catch(() => {})
    }
    if (Date.now() >= deadline) {
      const line = await describeLine(page, 120)
      throw new Error(`会话已打开但输入框没出现（试了 ${EDITORS.length} 档选择器 ${rounds} 轮）。页面现状 ${line}`)
    }
    await sleep(EDITOR_POLL)
  }
}

/**
 * 进会话 → 点输入框 → 发一条消息。
 *
 * 抽成公共函数是因为它有两个调用方（定时续火 sparkOnce、面板自定义发信 sendCustom），
 * 而这一段是整条链路上最容易被抖音改版打穿的地方 —— 改一处漏一处等于一半的功能还是坏的。
 */
async function sendMessage(page, item, message, trace = () => {}) {
  const how = await openChat(page, item, trace)
  trace(`已进入会话（${how}），等输入框`)

  const editor = await waitForEditor(page, trace)
  try {
    // 点输入框走同一条链路：光标进不去的话下面 sendCharacter 就打在空气里。
    // handle 一起递进去 —— 兜底的合成事件与聚焦都该打在这个编辑器上，而不是
    // 坐标底下那个（抖音把表情/发送按钮浮在输入框上，压住时两者不是一个东西）
    const clicked = await clickAt(page, editor.box.cx, editor.box.cy, {
      scope: "消息输入框",
      handle: editor.handle,
    })
    if (!clicked.arrived) trace("点输入框时真鼠标事件没进 DOM，已走合成事件兜底")
  } finally {
    await editor.handle.dispose().catch(() => {})
  }

  // puppeteer 没有 insertText，sendCharacter 能正确输入中文/emoji，
  // 且不会像 type() 那样把 \n 当回车提前发出去
  await page.keyboard.sendCharacter(message)

  /*
   * 发送前先确认字真的进去了。
   *
   * sendCharacter 走 CDP 的 `Input.insertText`，它只保证「文本发出去了」——焦点没在
   * 编辑器里时照样返回成功，紧接着那下 Enter 就在空会话里敲了个回车，结果是
   * 「日志说发了 N 条，抖音那边一条没有」。这是最坏的一种失败：它不报错。
   * 所以读一眼编辑器里现在有多少字，空的就补一轮合成输入（Slate 编辑器是
   * contenteditable，forceType 那条路认它）。
   */
  const len = await page.evaluate(sel => {
    const el = document.querySelector(sel)
    return el ? (el.innerText || el.textContent || "").trim().length : -1
  }, editor.sel)
  if (len === 0) {
    trace("输入框仍是空的，改用合成输入补写")
    await typeText(page, message, { scope: "消息输入框", delay: 0 })
  }

  await pressKey(page, "Enter", { scope: "消息输入框" })
}

async function screenshot(page, name) {
  if (!page || page.isClosed?.()) return ""
  try {
    const file = path.join(shotDir(), `fail-${safeFileName(name)}-${Date.now()}.png`)
    await page.screenshot({ path: file, fullPage: true })
    log("info", `已保存失败截图：${file}`)
    return file
  } catch (error) {
    log("warn", "保存失败截图失败：", error.message)
    return ""
  }
}

function withTimeout(promise, ms, message) {
  let timer
  return Promise.race([
    promise.finally(() => clearTimeout(timer)),
    new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error(message)), ms)
    }),
  ])
}

/**
 * 跑某个 Bot 下全部启用的账号，串行执行——并行会同时开多个 Chromium，
 * 家用机内存扛不住，也更容易被抖音风控。
 *
 * @param {object} [opts]
 * @param {boolean} [opts.skipIfDone] 逐个账号判定「今天是否已成功」，跳过的account
 *   在结果里带 `skipped: true`，推送时会单独归一类而不是混进成功数
 */
export async function runBot(botId, { onProgress, skipIfDone = false } = {}) {
  const accounts = store.list(botId).filter(a => a.enable !== false)
  const results = []
  for (const acc of accounts) {
    try {
      const result = await runAccount(botId, acc.id, { onProgress, skipIfDone })
      results.push({ accountId: acc.id, account: acc.name, ...result })
    } catch (error) {
      const err = toError(error)
      results.push({
        accountId: acc.id,
        account: acc.name,
        ok: false,
        skipped: false,
        sent: [],
        missing: [],
        renamed: [],
        error: err.message,
        durationMs: 0,
      })
    }
  }
  return results
}

/** 面板上的「发一条自定义消息」：不走模板，直接发指定文本给指定好友 */
export async function sendCustom(botId, accountId, friends, text) {
  const account = store.get(botId, accountId)
  if (!account) throw new Error("账号不存在")
  const targets = (Array.isArray(friends) ? friends : [friends]).map(String).filter(Boolean)
  if (!targets.length) throw new Error("请至少选择一个好友")
  const message = String(text ?? "").trim()
  if (!message) throw new Error("消息内容不能为空")

  const cookies = store.cookies(botId, accountId)
  if (!cookies?.length) throw new Error("该账号没有可用 Cookie，请重新登录")

  const key = `${botId}:${accountId}`
  if (running.has(key)) throw new Error("该账号正在执行任务，请稍后再试")
  running.set(key, Date.now())

  const result = { ok: false, sent: [], missing: [], error: "", detail: "" }
  const { context, page } = await browserManager.openPage(cookies)
  const notify = msg => log("info", `[${account.name}] ${msg}`)
  const trace = (...args) => debug(`${account.name} 自定义发信`, ...args)
  try {
    await page.goto(CHAT_URL, { waitUntil: "domcontentloaded", timeout: READY_TIMEOUT })
    const ready = await page
      .waitForSelector(SEL.search, { visible: true, timeout: READY_TIMEOUT })
      .then(() => true)
      .catch(() => false)
    trace(`等搜索框：${ready ? "已出现" : "未出现"}`)
    if (!ready) {
      await snapshot(page, `${account.name}-custom-no-search`)
      throw new Error("聊天页搜索框未出现，Cookie 可能已经失效")
    }
    await waitForChatList(page, notify, trace)

    for (const [index, friend] of targets.entries()) {
      // 面板勾选的是当前真实昵称，不需要走别名候选
      const hit = await searchConversation(page, [friend], notify, trace)
      if (!hit) {
        result.missing.push(friend)
        continue
      }
      try {
        await sendMessage(page, hit.handle, message, trace)
        result.sent.push({ friend, message, at: Date.now() })
      } catch (error) {
        // 一个好友发不出去不该把后面的都拖没：记下来继续
        const why = toError(error).message
        result.missing.push(friend)
        // 面板上只显示 error 那一行，所以把首个失败原因带上——否则用户只看到「未成功发送」
        if (!result.detail) result.detail = why
        notify(`发送失败，跳过：${friend}（${why}）`)
        await snapshot(page, `${account.name}-custom-${friend}-send-failed`)
      }
      if (index < targets.length - 1) await randomSleep(1200, 2500)
    }
    await new Promise(r => setTimeout(r, 2000))
    result.ok = result.missing.length === 0
    // 这里的 missing 既装「搜不到」也装「搜到了但没发出去」，所以措辞不能写死成「未找到会话」
    if (result.missing.length) result.error = `未成功发送：${result.missing.join("、")}${result.detail ? `（${result.detail}）` : ""}`
  } catch (error) {
    result.error = toError(error).message
    if (config.bool("spark.screenshotOnFail", true)) await screenshot(page, `${account.name}-custom`)
  } finally {
    running.delete(key)
    await closeQuietly(page)
    await closeQuietly(context)
    audit.add("spark.custom", {
      botId,
      accountId,
      account: account.name,
      friends: targets,
      ok: result.ok,
      error: result.error,
    })
  }
  return result
}

/**
 * 拉取该账号的会话列表（好友昵称），面板上给用户勾选，不用手打昵称。
 * 昵称里有 emoji 或空格时手打极易出错，这是「改名导致断火」之外最常见的失败原因。
 */
export async function listFriends(botId, accountId) {
  const cookies = store.cookies(botId, accountId)
  if (!cookies?.length) throw new Error("该账号没有可用 Cookie，请重新登录")

  const { context, page } = await browserManager.openPage(cookies)
  try {
    await page.goto(CHAT_URL, { waitUntil: "domcontentloaded", timeout: READY_TIMEOUT })
    const ready = await page
      .waitForSelector(SEL.search, { visible: true, timeout: READY_TIMEOUT })
      .then(() => true)
      .catch(() => false)
    if (!ready) throw new Error("聊天页搜索框未出现，Cookie 可能已经失效")
    await waitForChatList(page, () => {})

    /*
     * 复用搜索那边的 readItems + itemName，不再自己写一套 DOM 抓取。
     *
     * 原来这里是 `querySelectorAll(sel)` 之后取每项第一个短文本，两处都错：
     * `[class*="conversation"]` 是模糊匹配 class，一条会话的外层容器和它内部好几层子节点
     * 会同时命中，于是同一个好友被数成好几条 —— 现场「读到 5 个昵称」其实只有一个好友，
     * 面板上并排列出的 `主号19:0310分钟内在线` / `主号19:03` / `主号` / `19:03` /
     * `10分钟内在线` 就是同一条会话的五个嵌套层级。readItems 会先把命中节点按父节点归组、
     * 只保留「兄弟最多」的那一组（也就是会话行本身），itemName 再把时间与在线状态从粘连
     * 文本里剔掉。
     */
    const items = await readItems(page, SEL.conversation)
    const names = []
    for (const item of items) {
      const name = itemName(item)
      if (name && !names.includes(name)) names.push(name)
    }

    debug("拉取会话列表", `${items.length} 条会话，读出 ${names.length} 个昵称`)
    return names.slice(0, 200)
  } finally {
    await closeQuietly(page)
    await closeQuietly(context)
  }
}

/** 状态面板用的汇总：账号数、最近一次运行时间与结果 */
export function summarize(botId) {
  const accounts = store.list(botId)
  let lastAt = 0
  let okCount = 0
  let failCount = 0
  let sentCount = 0
  let doneTodayCount = 0
  for (const acc of accounts) {
    if (doneToday(acc)) doneTodayCount++
    if (!acc.lastRun) continue
    lastAt = Math.max(lastAt, acc.lastRun.at || 0)
    if (acc.lastRun.ok) okCount++
    else failCount++
    sentCount += acc.lastRun.sent?.length || 0
  }
  return {
    total: accounts.length,
    enabled: accounts.filter(a => a.enable !== false).length,
    invalid: accounts.filter(a => a.cookieInvalid).length,
    targets: accounts.reduce((n, a) => n + (a.targets?.length || 0), 0),
    doneToday: doneTodayCount,
    okCount,
    failCount,
    sentCount,
    lastAt,
    lastTime: lastAt ? formatTime(lastAt) : "从未运行",
  }
}
