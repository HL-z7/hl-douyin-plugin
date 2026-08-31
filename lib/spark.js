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

const shotDir = () => ensureDir(dataDir, "screenshots")

const CHAT_URL = "https://www.douyin.com/chat"
const READY_TIMEOUT = 30000
const IDLE_TIMEOUT = 10000
const SEARCH_TIMEOUT = 5000
const SEARCH_RETRY_INTERVAL = 2000
const SEARCH_RESET_DELAY = 500

const SEL = {
  search: 'input.semi-input[placeholder="搜索"]',
  conversation: '[class*="conversation"], [class*="Conversation"]',
  searchItem: ".SearchPanelitembox",
  editor: '.messageEditorimChatEditorContainer [data-slate-editor="true"][contenteditable="true"]',
}

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

  try {
    notify("打开抖音聊天页")
    await page.goto(CHAT_URL, { waitUntil: "domcontentloaded", timeout: READY_TIMEOUT })

    const searchReady = await page
      .waitForSelector(SEL.search, { visible: true, timeout: READY_TIMEOUT })
      .then(() => true)
      .catch(() => false)
    if (!searchReady) throw new Error("聊天页搜索框未出现，Cookie 可能已经失效")

    await waitForChatList(page, notify)

    const template = normalizeTemplate(
      account.messageTemplate || config.get("spark.messageTemplate", ""),
      `账号 ${account.name} 的消息模板`
    )
    const includeSource = config.bool("spark.yiyanIncludeSource", true)
    const minGap = config.num("spark.minGapMs", 2500, { min: 0 })
    const maxGap = Math.max(minGap, config.num("spark.maxGapMs", 6000, { min: 0 }))

    for (const [index, target] of account.targets.entries()) {
      const label = targetLabel(target)
      notify(`搜索会话：${label}`)

      const hit = await searchConversation(page, targetCandidates(target), notify)
      if (!hit) {
        await screenshot(page, `${account.name}-${target.name}-search`)
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

      await openChat(page, hit.handle)
      const editor = await page.waitForSelector(SEL.editor, { visible: true, timeout: 10000 })
      await editor.click()

      const message = renderMessage({ template, account: account.name, friend: hit.name, includeSource })
      // puppeteer 没有 insertText，sendCharacter 能正确输入中文/emoji，
      // 且不会像 type() 那样把 \n 当回车提前发出去
      await page.keyboard.sendCharacter(message)
      await page.keyboard.press("Enter")

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
async function waitForChatList(page, notify) {
  const ready = await page
    .waitForSelector(SEL.conversation, { visible: true, timeout: READY_TIMEOUT })
    .then(() => true)
    .catch(() => false)
  if (!ready) notify("会话列表未在预期时间内出现，依赖搜索重试兜底")
  await page.waitForNetworkIdle({ idleTime: 800, timeout: IDLE_TIMEOUT }).catch(() => {})
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
async function searchConversation(page, candidates, notify) {
  const names = (Array.isArray(candidates) ? candidates : [candidates]).filter(Boolean)
  if (!names.length) return null
  const retry = Math.max(1, config.num("spark.searchRetry", 3, { min: 1, max: 10 }))

  for (let attempt = 1; attempt <= retry; attempt++) {
    for (const name of names) {
      const handle = await searchOnce(page, name)
      if (handle) return { handle, name }
    }

    if (attempt < retry) {
      notify(`第 ${attempt} 次搜索未命中（已试 ${names.join("、")}），${SEARCH_RETRY_INTERVAL}ms 后重试`)
      await new Promise(r => setTimeout(r, SEARCH_RETRY_INTERVAL))
    }
  }
  return null
}

/**
 * 单次搜索。每次都先清空输入框并等旧结果收起，
 * 否则会读到上一个候选名残留的列表项，导致发错人。
 */
async function searchOnce(page, name) {
  await fillSearch(page, "")
  await page
    .waitForFunction(sel => !document.querySelector(sel), { timeout: SEARCH_TIMEOUT }, SEL.searchItem)
    .catch(() => {})
  await new Promise(r => setTimeout(r, SEARCH_RESET_DELAY))
  await fillSearch(page, name)

  const index = await page
    .waitForFunction(
      (sel, key) => {
        const items = [...document.querySelectorAll(sel)]
        const idx = items.findIndex(item =>
          [...item.querySelectorAll("*")].some(el => el.textContent?.trim() === key)
        )
        return idx >= 0 ? idx : false
      },
      { timeout: SEARCH_TIMEOUT, polling: 300 },
      SEL.searchItem,
      name
    )
    .then(handle => handle.jsonValue())
    .catch(() => false)

  if (index === false || index === null) return null
  const items = await page.$$(SEL.searchItem)
  return items[index] || null
}

/** 清空并输入搜索词：受控组件用 page.type 之前必须真的清空，直接改 value 不触发 React */
async function fillSearch(page, value) {
  const input = await page.waitForSelector(SEL.search, { visible: true, timeout: READY_TIMEOUT })
  await input.click({ clickCount: 3 })
  await page.keyboard.press("Backspace")
  if (value) await input.type(value, { delay: 40 })
}

/** 点搜索结果里的「发消息 / 发私信」入口 */
async function openChat(page, item) {
  const clicked = await item.evaluate(el => {
    const target = [...el.querySelectorAll("*")].find(node => /^(发消息|发私信)$/.test(node.textContent?.trim() || ""))
    if (!target) return false
    target.click()
    return true
  })
  if (!clicked) {
    // 有些版面没有独立按钮，点整个结果项也能进会话
    await item.click()
  }
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

  const result = { ok: false, sent: [], missing: [], error: "" }
  const { context, page } = await browserManager.openPage(cookies)
  const notify = msg => log("info", `[${account.name}] ${msg}`)
  try {
    await page.goto(CHAT_URL, { waitUntil: "domcontentloaded", timeout: READY_TIMEOUT })
    const ready = await page
      .waitForSelector(SEL.search, { visible: true, timeout: READY_TIMEOUT })
      .then(() => true)
      .catch(() => false)
    if (!ready) throw new Error("聊天页搜索框未出现，Cookie 可能已经失效")
    await waitForChatList(page, notify)

    for (const [index, friend] of targets.entries()) {
      // 面板勾选的是当前真实昵称，不需要走别名候选
      const hit = await searchConversation(page, [friend], notify)
      if (!hit) {
        result.missing.push(friend)
        continue
      }
      await openChat(page, hit.handle)
      const editor = await page.waitForSelector(SEL.editor, { visible: true, timeout: 10000 })
      await editor.click()
      await page.keyboard.sendCharacter(message)
      await page.keyboard.press("Enter")
      result.sent.push({ friend, message, at: Date.now() })
      if (index < targets.length - 1) await randomSleep(1200, 2500)
    }
    await new Promise(r => setTimeout(r, 2000))
    result.ok = result.missing.length === 0
    if (result.missing.length) result.error = `未找到会话：${result.missing.join("、")}`
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

    const names = await page.evaluate(sel => {
      const out = []
      for (const item of document.querySelectorAll(sel)) {
        // 会话项里第一个非空短文本基本就是昵称，长文本是最近消息预览
        const texts = [...item.querySelectorAll("span, p, div")]
          .map(el => el.textContent?.trim() || "")
          .filter(t => t && t.length <= 30)
        if (texts[0] && !out.includes(texts[0])) out.push(texts[0])
      }
      return out
    }, SEL.conversation)

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
