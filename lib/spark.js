/**
 * 续火引擎：用无头浏览器在抖音网页版聊天页搜好友、发消息。
 *
 * 对外导出分三组：
 * - 任务入口：runAccount / runBot / sendCustom / listFriends / summarize / doneToday，
 *   由 apps/spark.js、lib/scheduler.js、lib/web.js 调用
 * - 账号锁：isRunning / runningList / runningWhy / acquire / release
 * - 页面操作原语：CHAT_URL / READY_TIMEOUT / SEL / waitForChatList / dismissOverlay /
 *   readItems / itemName / itemPreview / searchConversation / openChat / sendMessage /
 *   typeAndSend，由 lib/chat.js（聊天界面）复用
 *
 * 依赖 lib/browser.js（BrowserContext 与页面）、lib/store.js（账号与续火目标）、
 * lib/interact.js（点击与输入）、lib/template.js（消息模板）、lib/debug.js（日志与快照）。
 * 调用前提：账号在 store 里存有可用 Cookie，且该账号此刻没有被别的任务持有（见 acquire）。
 *
 * 三个关键设计：
 * 1. 一个账号一次运行一个 BrowserContext，跑完即销毁。长期挂着登录态页面会被抖音的
 *    心跳与推荐流持续打扰，进程崩溃时也更容易留下半开的 Chromium。
 * 2. 多候选名搜索 + 自愈。好友改昵称是断火最常见的原因，目标带别名列表（见 lib/store.js
 *    的 SparkTarget），按主名称 → 别名依次搜；命中别名时把它提为主名称写回，下次直接
 *    用新名字搜。
 * 3. 同账号串行。`running` Map 挡住定时任务与面板手动触发撞车；多账号之间也串行，
 *    并行开多个 Chromium 内存占用高，风控也更敏感。
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

/*
 * 以下常量与函数导出给 lib/chat.js（聊天界面）复用。
 *
 * 聊天界面不自己抓一遍 DOM：抖音的 class 名每次发版都可能变，选择器分档、浮层处理、
 * 「兄弟最多的一组才是会话行」这些判据都是现场调试得出的结论。分散到两个文件后，
 * 抖音改版时容易只修一处、漏另一处。
 */
export const CHAT_URL = "https://www.douyin.com/chat"
export const READY_TIMEOUT = 30000
const IDLE_TIMEOUT = 10000
const SEARCH_TIMEOUT = 5000
const SEARCH_RETRY_INTERVAL = 2000
const SEARCH_RESET_DELAY = 500
/**
 * 等旧搜索结果收起的上限。
 *
 * 不能用 SEARCH_TIMEOUT：抖音的搜索面板在输入框获得焦点时就会挂出「最近会话」，
 * 清空输入并不会让它消失，于是每次搜索都会在这里耗满 5 秒（每个候选名多 5 秒，
 * 三轮重试合计 15 秒）。而残留项本身无害——匹配按名字挑选，上一个候选名的残留结果
 * 不会被当成当前候选，所以等不到就直接往下走。
 */
const SEARCH_CLEAR_TIMEOUT = 1500

/**
 * 给候选项临时打的序号属性。
 *
 * 读文本和点元素必须是同一个节点，而抖音的列表随时重渲染，靠「第 N 个」二次查询容易
 * 错位。因此读取时把序号写进属性，之后按属性取 handle。
 */
const SLOT_ATTR = "data-dy-slot"

/**
 * 聊天页的三个基础选择器，lib/chat.js 一并复用。
 *
 * - search：左上角搜索框，同时充当「页面已就绪」与「哪一层是抖音自己的界面」的锚点
 *   （见 findOverlay）
 * - conversation：会话相关节点，模糊匹配 class，一条会话会命中十几层，需 readItems
 *   再做结构归组
 * - searchItem：搜索结果面板里的结果项，class 语义明确，可直接当一条用
 */
export const SEL = {
  search: 'input.semi-input[placeholder="搜索"]',
  conversation: '[class*="conversation"], [class*="Conversation"]',
  searchItem: ".SearchPanelitembox",
}

/**
 * 消息输入框的分档选择器，从最严到最松依次试。
 *
 * 曾只认第一档，而它带着 `.messageEditorimChatEditorContainer`——抖音打包生成的混淆
 * class，发一次版就可能变成别的串。现场报错 `Waiting for selector ... failed` 即由此
 * 而来：会话已打开、输入框也在，只是外层 class 换名，于是等满 10 秒、当次「发送 0 条」。
 *
 * 分档的意义在于先严后松：前两档能命中时就用（确定是聊天编辑器），命中不了才退到
 * 「页面上任何一个可见的 contenteditable」。最后一档偏宽，但抖音聊天页除消息输入框
 * 没有别的可编辑区域；误判的代价（点错位置、消息发不出去）小于过严的代价（版本一变
 * 整个功能不可用）。命中的档位会写进 debug 日志，抖音改版时可直接定位。
 */
const EDITORS = [
  '.messageEditorimChatEditorContainer [data-slate-editor="true"][contenteditable="true"]',
  '[data-slate-editor="true"][contenteditable="true"]',
  '[class*="ChatEditor"] [contenteditable="true"], [class*="chatEditor"] [contenteditable="true"]',
  '[contenteditable="true"]',
]

/** 等输入框出现的上限。会话由本地渲染，通常很快，但首屏偶尔要拉历史消息 */
const EDITOR_TIMEOUT = 12000

/** 轮询输入框的间隔 */
const EDITOR_POLL = 400

/**
 * 全屏浮层的标记属性。
 *
 * 抖音会在聊天页挂弹窗，现场遇到的是「是否保存登录信息？」——
 * `div.trust-login-dialog-mask`，pointer-events=auto，从 0,0 起盖住整页。
 * 它不报错也不挡渲染，只把点击全部吃掉，因此表现为最难定位的一种失败：会话搜得到
 * （搜索走 elementHandle.type()，DOM focus 绕过浮层），点「发消息」的日志也写着
 * 「事件已到 DOM」（到的是浮层），随后等输入框耗满 4 档 31 轮超时——
 * 即「会话能看见，但消息发不出去」。
 */
const OVERLAY_ATTR = "data-dy-overlay"

/** 最多连清几层。抖音偶尔叠两个弹窗，但清不掉时不能在此死循环 */
const OVERLAY_ROUNDS = 3

/** 点完等浮层收起的时间，覆盖抖音的淡出动画时长 */
const OVERLAY_SETTLE = 400

/**
 * 关浮层的按钮文本，从先到后试。
 *
 * 只点不产生副作用的那个：「保存」「确定」「同意」「允许」都会改账号状态或权限，
 * 插件未被授权代用户做这类决定；且每次续火都是全新上下文，不作答下次仍会再问。
 */
const OVERLAY_DISMISS = [
  /^(暂不保存|不保存|暂不|取消|以后再说|下次再说|不用了|不再提醒|不再提示)$/,
  /^(知道了|我知道了|跳过|关闭)$/,
  // 按钮文本带了未预料的后缀时（如「不保存密码」）用这一档。范围限定在弹窗内部，
  // clickByText 又会往里收到「文本含这几个字的最小元素」，落点仍是按钮本身
  /暂不|不保存|不再提醒|不再提示|以后再说|下次再说/,
]

/**
 * 放开范围、在整页里找的那一档，用词比 OVERLAY_DISMISS 严格得多。
 *
 * 遮罩和按钮有时是兄弟节点，此时按钮不在弹窗根节点内，只能整页找。而 clickByText
 * 兜底的合成事件直接打在元素上、绕过遮罩，一旦在整页里匹配偏了就会真的点到东西。
 * 因此这一档只留「除这类弹窗几乎不会出现」的字眼，不含「取消」「关闭」这类通用词。
 */
const OVERLAY_HARD_DISMISS = [/^(暂不保存|不保存|以后再说|下次再说|不再提醒|不再提示)$/]

/** 关闭图标没有文本，只能按 class/aria 找。范围限定在浮层内部，避免点到页面上别的元素 */
const OVERLAY_CLOSE_SEL = '[class*="close"], [class*="Close"], [aria-label*="关闭"], [aria-label*="close"]'

/**
 * 疑似验证/风控面板的浮层一律不动。
 *
 * 点掉它等于把「需要人工验证」变成「无故发不出去」：验证本有 lib/remote.js 那条人工
 * 接管路径，而这里按下「取消」就把它关了，用户只剩一句「发不出去」。宁可本次明确失败。
 *
 * 分成 id/class 与正文两把尺子，因为两边的误判代价不同：
 *   - id/class 是框架给的语义词，稳定且几乎不会误撞（现场那个验证面板的 id 是
 *     `uc-second-verify`，落在 /verif/ 上），判据可以放宽。
 *   - 正文只留验证面板独有的整词。「风险」「安全」这类词在「是否保存登录信息」那类
 *     弹窗的正文里也常出现（「请勿在公共设备上保存，存在被盗风险」），放宽会把本该
 *     点掉的浮层放过去——那正是这次修复的 bug。
 */
const OVERLAY_KEEP_NAME_RE = /verif|captcha|risk|secur/i
const OVERLAY_KEEP_TEXT_RE = /身份验证|安全验证|验证码|本人操作|人机|滑[动块]/

/**
 * 账号锁表，key 是 `${botId}:${accountId}`。同一账号不允许并发，定时任务与面板手动
 * 触发撞车时后者直接被拒。
 *
 * 值是 `{at, why}` 而不是单个时间戳：加入聊天界面后，一个账号被占用的原因可能是
 * 「正在续火」也可能是「聊天窗开着」，两者的下一步不同（前者稍等即可，后者需提示用户
 * 先关闭聊天）。错误信息必须带上占用方，否则用户只看到「该账号正在执行任务」而无从下手。
 */
const running = new Map()

/** 该账号当前是否被占用（续火中或聊天窗开着） */
export function isRunning(botId, accountId) {
  return running.has(`${botId}:${accountId}`)
}

/** 当前被占用的全部 `${botId}:${accountId}`，面板状态用 */
export function runningList() {
  return [...running.keys()]
}

/** 占用原因。未被占用时返回空串 */
export function runningWhy(botId, accountId) {
  return running.get(`${botId}:${accountId}`)?.why || ""
}

/**
 * 抢账号锁。抢不到就抛错，错误信息里带上当前占用者。
 *
 * 导出给 lib/chat.js：聊天界面要长期持有一个抖音页面，而同一份 Cookie 同时活在两个
 * BrowserContext 里，抖音会看到两个并发登录会话——那是掉线和触发验证的常见起因。
 * 所以聊天会话必须和续火抢同一把锁，成为该账号在这一刻唯一的页面持有者。
 *
 * @param {string} why 占用原因，会直接拼进拒绝其他调用方的错误文案
 * @returns {string} 锁 key，形如 `${botId}:${accountId}`
 * @throws {Error} 该账号已被占用时抛出，消息含当前占用原因
 */
export function acquire(botId, accountId, why) {
  const key = `${botId}:${accountId}`
  const held = running.get(key)
  if (held) throw new Error(`该账号${held.why}，请稍后再试`)
  running.set(key, { at: Date.now(), why })
  return key
}

/** 释放账号锁。未持有时是空操作 */
export function release(botId, accountId) {
  running.delete(`${botId}:${accountId}`)
}

/**
 * 该账号今天是否已经成功续过火。
 *
 * 只认 `lastSuccessAt`（见 store.recordRun）：失败那次不算，同一天下次定时仍会重试。
 * 日期按 Asia/Shanghai 判定，服务器在国外时不会提前或推迟一天翻页。
 *
 * @param {{lastSuccessAt?: number}} account store.get / store.list 返回的账号对象
 * @returns {boolean}
 */
export function doneToday(account) {
  return isSameShanghaiDay(account?.lastSuccessAt)
}

/**
 * 跑一个账号的续火。全流程只在 finally 里写一次 store.recordRun 与审计，因此正常
 * 结束、抛错、超时三条路的落账行为一致。
 *
 * @param {string|number} botId 机器人 QQ
 * @param {string} accountId 账号 id（store 内部 id，不是抖音昵称）
 * @param {object} [opts]
 * @param {(msg: string) => void} [opts.onProgress] 进度回调，面板 SSE 与日志共用
 * @param {boolean} [opts.skipIfDone] 今天已成功就跳过。定时任务传 `spark.skipIfDone`，
 *   手动 `#抖音续火` 不传（用户明确要发就发），`#抖音续火 跳过` 才传 true
 * @returns {Promise<{ok: boolean, skipped: boolean, sent: Array, missing: Array, renamed: Array,
 *   error: string, durationMs: number, cookieInvalid: boolean}>} skipped=true 时其余字段为空值；
 *   renamed 是按别名命中、主名称已就地更新（store.promoteAlias）的好友列表，仅供提示用
 * @throws {Error} 该账号正在被占用、账号不存在、未配置续火好友、没有可用 Cookie
 */
export async function runAccount(botId, accountId, { onProgress, skipIfDone = false } = {}) {
  const key = `${botId}:${accountId}`
  const held = running.get(key)
  if (held) throw new Error(`该账号${held.why}，请稍后再试`)

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

  running.set(key, { at: Date.now(), why: "正在续火中" })
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
    // missing 非空也算失败：会话找不到意味着火花可能已中断，需要在推送里提示用户处理
    result.ok = !result.error && result.missing.length === 0
  } catch (error) {
    const err = toError(error)
    result.error = err.message
    result.ok = false
    // 按错误文案回判 Cookie 失效，面板据此把账号标红、提示重新登录
    if (/Cookie 可能已经失效|未登录/.test(err.message)) result.cookieInvalid = true
  } finally {
    // 落账放在 finally：正常结束、抛错、超时三条路都要解锁、记录并写审计
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

/**
 * 单个账号的浏览器流程：开页面 → 等聊天页就绪 → 逐个目标搜索并发送 → 收尾关页面。
 *
 * 从 runAccount 里拆出来是为了整段套一层超时（见 withTimeout）：超时后 runAccount 的
 * finally 仍会解锁并落账，而这里的 finally 负责关页面与 context。
 *
 * @param {object} result runAccount 的结果对象，直接就地累加 sent / missing / renamed
 */
async function sparkOnce(botId, account, cookies, result, onProgress) {
  const { context, page } = await browserManager.openPage(cookies)
  const notify = msg => {
    log("info", `[${account.name}] ${msg}`)
    try {
      onProgress?.(msg)
    } catch {}
  }
  /** 只进日志、不进面板进度条的细节。debug 开关关闭时零开销 */
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

      // 命中的是别名：好友已改名，把新名字提为主名称，下次直接用它搜
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
 * 等会话列表渲染出来再搜，并在这里做第一次浮层探测。
 *
 * 搜索框先于列表出现，此时抖音的搜索索引尚未就绪，结果面板恒空，会把好友误判成
 * 「改名了」。列表等不到也不抛错：仍有搜索重试与列表兜底两条路。
 *
 * @param {(msg: string) => void} [notify] 面向用户的进度提示
 * @param {(...args: any[]) => void} [trace] debug 日志
 */
export async function waitForChatList(page, notify = () => {}, trace = () => {}) {
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

  // 浮层探测放在这里：listFriends / sparkOnce / sendCustom 三条路都要先过这一关，
  // 且必须赶在第一次搜索之前——fillSearch 的三连击也是真鼠标，同样会被浮层吃掉
  await dismissOverlay(page, trace)
}

/**
 * 探一遍盖住页面的浮层，能点掉就点掉。
 *
 * 判据是「这几个探测点底下坐着谁」而不是遍历全页找 mask：真能吃掉点击的只有命中测试
 * 里最上面那一层，一次 `elementFromPoint` 即可判定，也不会因为抖音换 class 名而漏判。
 *
 * findOverlay 会从落点往上爬到与搜索框祖先链岔开的最外层节点，把整棵子树当 root 去找
 * 关闭按钮：现场那个浮层是 `div.trust-login-dialog-mask < div#trust-logout-dialog <
 * body`，遮罩和「暂不保存」是兄弟节点，只拿遮罩当 root 找不到按钮。
 *
 * 循环是为了处理抖音偶尔叠两层的情况（关掉「保存登录信息」后面还压着一个引导），
 * 但最多 OVERLAY_ROUNDS 轮：关不掉时要带着告警继续往下走，不能在此空转。
 *
 * @param {object} [opts]
 * @param {boolean} [opts.esc] 是否允许按 Escape 兜底。搜索结果面板开着时必须传 false：
 *   Escape 会把面板一起收掉，调用方手里的结果项 handle 随之失效
 * @returns {Promise<number>} 关掉了几层
 */
export async function dismissOverlay(page, trace = () => {}, opts = {}) {
  let closed = 0
  for (let round = 1; round <= OVERLAY_ROUNDS; round++) {
    const hit = await findOverlay(page)
    if (!hit) {
      if (round === 1) trace("浮层探测：没有盖住页面的浮层")
      break
    }
    trace(`浮层探测第 ${round} 轮：${hit.at} 点到 ${hit.hit}，所属层 ${hit.name} 盖住 ${hit.cover}% 视口，文本「${oneLine(hit.text, 40)}」`)
    if (OVERLAY_KEEP_NAME_RE.test(hit.name) || OVERLAY_KEEP_TEXT_RE.test(hit.text)) {
      log("warn", `页面上盖着 ${hit.name}「${oneLine(hit.text, 40)}」，像验证面板，不去动它`)
      break
    }
    const root = await page.$(`[${OVERLAY_ATTR}="1"]`)
    if (!root) {
      trace(`浮层探测：标到了 ${hit.name}，取 handle 时页面已重渲染`)
      break
    }
    let how = ""
    try {
      how = await closeOverlay(page, root, trace, opts)
    } finally {
      await root.dispose().catch(() => {})
    }
    if (!how) {
      /*
       * 关不掉时报出浮层的整段文本（120 字，而非日志里的 40 字摘要）。
       *
       * 下一步必然失败，而那条失败信息是「输入框没出现」，与真正的原因隔着十几行日志。
       * 这段文本包含按钮文字，可直接看出词表漏了哪个词，补一条正则即可。
       */
      log("warn", `页面上盖着 ${hit.name}，点不掉，点击都会落在它身上。浮层文本：${oneLine(hit.text, 120)}`)
      await snapshot(page, `overlay-stuck-${safeFileName(hit.name, "overlay")}`)
      break
    }
    closed++
    log("info", `已关掉盖住页面的浮层 ${hit.name}「${oneLine(hit.text, 24)}」（${how}）`)
  }
  return closed
}

/**
 * 找出正盖着聊天页的那一层，并给它打上 OVERLAY_ATTR 标记供后续取 handle。
 *
 * 判据不是「谁的 class 里有 mask」——抖音的混淆 class 发一次版就换。这里判定的是
 * 点下去会打到谁：在搜索框中心与视口几个位置上各做一次 `elementFromPoint`
 * （它天然跳过 `pointer-events:none` 的层，因此能被它返回就说明这层真会吃掉点击）。
 *
 * 拿到落点后往上爬，爬到「再往上一层就把搜索框也装进去」为止，即与搜索框祖先链岔开的
 * 最外层节点，它就是这个弹窗的根。现场那个浮层是
 * `div.trust-login-dialog-mask < div#trust-logout-dialog < body`，于是爬出
 * `div#trust-logout-dialog`：遮罩和「暂不保存」是兄弟节点，只拿遮罩当 root 找不到按钮，
 * 需要两者的共同父节点。这种爬法同时覆盖了弹窗挂在抖音页面根节点内部的情形
 * （此时爬出的是页面根节点里的弹窗子树，而不是整个页面）。
 *
 * 认定为浮层还要满足两条，少一条都会误伤：
 *   1. 该子树内没有搜索结果项——结果面板也是 body 下的独立一层（Semi 的 portal），
 *      而它正是待点击的目标，关掉等于自断退路。
 *   2. 落点到根之间存在一个 `position:fixed` 且接收点击的块，铺满至少六成视口——
 *      遮罩必然如此，否则挡不住全页点击；而下拉菜单、气泡提示只占一小块，抖音自己的
 *      聊天区虽然也占大半屏，却不是 fixed。
 *
 * @returns {Promise<{name: string, text: string, hit: string, at: string, cover: number} | null>}
 *   name 是浮层根节点的 `tag#id.class` 描述，hit 是探测点实际命中的元素，at 是探测点
 *   坐标，cover 是遮罩占视口的百分比；没有浮层时返回 null
 */
async function findOverlay(page) {
  return page
    .evaluate(
      (searchSel, itemSel, attr) => {
        document.querySelectorAll(`[${attr}]`).forEach(el => el.removeAttribute(attr))
        const anchor = document.querySelector(searchSel)
        // 搜索框是「抖音自己界面」的锚点。没有它就无从判断哪层是弹窗、哪层是页面
        if (!anchor) return null

        const name = node => {
          if (!node || !node.tagName) return "?"
          const cls = String(node.getAttribute?.("class") || "").trim().split(/\s+/)[0]
          return node.tagName.toLowerCase() + (node.id ? `#${node.id}` : "") + (cls ? `.${cls}` : "")
        }
        /** 从落点往上爬到与搜索框岔开的那个节点，即这个弹窗的根 */
        const layerOf = el => {
          let node = el
          while (node.parentElement && !node.parentElement.contains(anchor)) node = node.parentElement
          return node.parentElement ? node : null
        }

        const box = anchor.getBoundingClientRect()
        const viewport = Math.max(1, innerWidth * innerHeight)
        /*
         * 落点到这一层之间，「铺满视口的固定定位块」最大占了几成视口。
         *
         * 两个限定都是必需的：
         *
         * `position: fixed`——只看面积会把抖音自己的界面认成遮罩：探测点落在聊天区时，
         * 聊天区本身就占七成视口，而它与侧栏里的搜索框是兄弟子树，前面那些判据都拦不住。
         * 而「盖住整页、随滚动保持不动的遮罩」实现上只能是 fixed。absolute 也能做到，
         * 但普通版面里 absolute 铺满一大片很常见，放进来等于把误判重新引入——
         * 漏判的代价只是回到既有行为（等输入框超时），误判则会去点抖音正常界面上的元素。
         *
         * 不能只量 layer 自身：弹窗的外层容器常是 0×0 的静态节点，真正铺满的是里面那个
         * fixed 遮罩（现场是 `div#trust-logout-dialog` 套 `div.trust-login-dialog-mask`）。
         * 因此从落点往上逐级取最大值。
         */
        const coverage = (from, stop) => {
          let best = 0
          for (let node = from; node; node = node === stop ? null : node.parentElement) {
            const st = getComputedStyle(node)
            // pointer-events:none 的层挡不住任何点击，不该让它把占比撑起来。
            // 组件库的 portal 容器即典型的「铺满整屏 + pointer-events:none」
            if (st.position !== "fixed" || st.pointerEvents === "none") continue
            const r = node.getBoundingClientRect?.()
            if (r) best = Math.max(best, (r.width * r.height) / viewport)
          }
          return best
        }
        // 搜索框中心排第一：三条调用路径都要先操作它。后面几个点覆盖「弹窗只压住半边」
        const pts = [
          [box.left + box.width / 2, box.top + box.height / 2],
          [innerWidth / 2, innerHeight / 2],
          [innerWidth * 0.75, innerHeight / 2],
          [innerWidth / 2, innerHeight * 0.25],
          [innerWidth / 2, innerHeight * 0.75],
        ]
        for (const [px, py] of pts) {
          if (px < 0 || py < 0 || px > innerWidth || py > innerHeight) continue
          const top = document.elementFromPoint(px, py)
          if (!top || top === document.body || top === document.documentElement) continue
          // 落点在搜索框那条祖先链上：此处露出的是抖音自己的界面，不是浮层
          if (top.contains(anchor) || anchor.contains(top)) continue
          const layer = layerOf(top)
          if (!layer) continue
          // 子树里有搜索结果项：这是 Semi portal 的结果面板，正是要点的目标，不能关
          if (layer.matches(itemSel) || layer.querySelector(itemSel)) continue
          const cover = coverage(top, layer)
          if (cover < 0.6) continue
          layer.setAttribute(attr, "1")
          return {
            name: name(layer),
            text: (layer.innerText || layer.textContent || "").replace(/\s+/g, " ").trim().slice(0, 200),
            hit: name(top),
            at: `${Math.round(px)},${Math.round(py)}`,
            cover: Math.round(cover * 100),
          }
        }
        return null
      },
      SEL.search,
      SEL.searchItem,
      OVERLAY_ATTR
    )
    .catch(() => null)
}

/**
 * 试着关掉一个浮层，四档依次退，每档点完都回头确认它确实消失了。
 *
 * 「点完确认」这一步不能省：这类弹窗的按钮常带自己的动画层，clickByText 返回 ok
 * 只说明事件送到了，不代表弹窗已收起。少了确认就会把「点了但没关」当成成功，
 * 重新回到「会话能看见、消息发不出去」那种不报错的失败。
 *
 * @param {import("puppeteer").ElementHandle} root findOverlay 标记出的浮层根节点
 * @param {object} [opts]
 * @param {boolean} [opts.esc] false 时跳过 Escape 那一档，见 dismissOverlay
 * @returns {Promise<string>} 生效的档位描述；空串表示四档都没关掉
 */
async function closeOverlay(page, root, trace = () => {}, opts = {}) {
  // ① 弹窗内部的「暂不保存」这类按钮。绝大多数情况在这一档结束
  for (const re of OVERLAY_DISMISS) {
    const r = await clickByText(page, re, { root, scope: "关浮层" })
    if (!r.ok) continue
    if (await overlayGone(page)) return `点「${r.text}」`
    trace(`关浮层：点了「${r.text}」但浮层还在，继续试`)
  }

  // ② 右上角的关闭图标。它没有文本，只能按 class/aria 找，范围限定在弹窗内部
  const icons = await root.$$(OVERLAY_CLOSE_SEL).catch(() => [])
  for (const icon of icons.slice(0, 3)) {
    const r = await clickHandle(page, icon, { scope: "关浮层" })
    await icon.dispose().catch(() => {})
    if (!r.ok) continue
    if (await overlayGone(page)) return "点关闭图标"
    trace("关浮层：点了关闭图标但浮层还在，继续试")
  }
  for (const icon of icons.slice(3)) await icon.dispose().catch(() => {})

  // ③ Escape。点不到按钮的弹窗有时认这个键，且它不会误伤页面上别的元素。
  //    但它会连搜索结果面板一起收掉，所以进会话前那次（调用方持有结果项 handle）跳过这档
  if (opts.esc === false) trace("关浮层：搜索结果面板开着，跳过 Escape 这档")
  else {
    await pressKey(page, "Escape", { scope: "关浮层" })
    if (await overlayGone(page)) return "按 Escape"
  }

  // ④ 放开范围在整页找。遮罩与按钮是兄弟节点、按钮不在弹窗根内时只剩这条路，
  //    所以词表比 ① 严格得多（见 OVERLAY_HARD_DISMISS）
  for (const re of OVERLAY_HARD_DISMISS) {
    const r = await clickByText(page, re, { scope: "关浮层" })
    if (!r.ok) continue
    if (await overlayGone(page)) return `整页找到并点「${r.text}」`
    trace(`关浮层：整页点了「${r.text}」但浮层还在`)
  }
  return ""
}

/**
 * 判断 findOverlay 标记的那层浮层是否还挡路。
 *
 * 判据只有一条：那几个探测点上，点击是否还会落进这棵子树。
 *
 * 不量它自身的 rect 与样式（第一版如此实现，被点击探针发现）：浮层的根节点常是静态
 * div，里面挂着两个 `position:fixed` 的子节点（现场是 `div#trust-logout-dialog` 套
 * 遮罩 + 对话框），静态父节点撑不起 fixed 子节点的高度，于是它的 `height` 恒为 0——
 * 按尺寸判定会每轮都读成「已关掉」，连报三次成功而弹窗未动。而 `elementFromPoint`
 * 天然跳过 display:none / visibility:hidden / 已卸载的节点，一次调用即可回答
 * 「是否还挡路」。
 *
 * @returns {Promise<boolean>} true 表示已不挡路；evaluate 失败时返回 false（按仍在处理）
 */
async function overlayGone(page) {
  await sleep(OVERLAY_SETTLE)
  return page
    .evaluate(
      (attr, searchSel) => {
        const el = document.querySelector(`[${attr}="1"]`)
        if (!el || !el.isConnected) return true
        const box = document.querySelector(searchSel)?.getBoundingClientRect()
        const pts = [
          box && [box.left + box.width / 2, box.top + box.height / 2],
          [innerWidth / 2, innerHeight / 2],
          [innerWidth / 2, innerHeight * 0.25],
          [innerWidth / 2, innerHeight * 0.75],
        ].filter(Boolean)
        for (const [px, py] of pts) {
          if (px < 0 || py < 0 || px > innerWidth || py > innerHeight) continue
          const top = document.elementFromPoint(px, py)
          // 顶层是它自己或它的后代：这一点上的点击仍被它接收
          if (top && (top === el || el.contains(top))) return false
        }
        return true
      },
      OVERLAY_ATTR,
      SEL.search
    )
    .catch(() => false)
}

/* ---------- 会话项文本的读取与匹配 ----------
 * 抖音的会话项/搜索结果项没有「昵称」这个独立可选中的元素：一条会话读出来是
 * `主号19:0310分钟内在线`，昵称、最后活跃时间、在线状态挤在一起；有时昵称本身还会被
 * 搜索高亮拆成 `主` + `号` 两个 <span>。
 *
 * 因此匹配不能是「某个后代元素的 textContent 正好等于名字」（早期实现如此，现场因此
 * 出现「搜「主号」未命中：结果 1 条」——搜到了但比不上）。改为分档匹配，从最严到最松
 * 依次试，并把命中的档位记进日志，便于判断是哪种形变。
 */
const TIER_EXACT = 0
const TIER_STRIP = 1
const TIER_LEAF = 2
const TIER_ITEM = 3
const TIER_NOTE = ["完全相同", "去掉时间/在线状态后相同", "文本包含", "整条包含"]

/**
 * 会话项里与昵称粘在一起的固定噪音：最后活跃时间与在线状态。
 * 只列抖音实际出现过的形态，宁可漏一种（还有 TIER_LEAF / TIER_ITEM 两档兜底），
 * 也不要用宽正则去啃昵称本身。
 */
const NOISE_RE =
  /(刚刚|\d+\s*(分钟|小时|天)前?(内)?(在线)?|在线|\d{1,2}:\d{2}|昨天|前天|星期[一二三四五六日天]|\d{4}[-/]\d{1,2}[-/]\d{1,2}|\d{1,2}[-/]\d{1,2})/g

/**
 * 名字归一化，用于比较而非展示。
 *
 * NFKC 把全角字符折成半角（抖音昵称里全角字母数字常见，而用户在面板上输入的是半角）；
 * 零宽字符在挂件昵称里常见，肉眼看不见但会让 `===` 失败。大小写与空白一并抹平——
 * 这几项都不改变「是同一个人」这个判断。
 */
function normName(text) {
  return String(text ?? "")
    .normalize("NFKC")
    .replace(/[​-‏⁠﻿︎️]/g, "")
    .replace(/\s+/g, "")
    .toLowerCase()
}

/** 归一化并去掉时间与在线状态后的名字，用于 TIER_STRIP 档匹配 */
function stripNoise(text) {
  return normName(text).replace(NOISE_RE, "")
}

/**
 * 读出一批列表项的文本，同时给每项打上 SLOT_ATTR 序号属性。
 *
 * 打属性是为了让「读到的那一条」和「点下去的那一条」是同一个元素：抖音的列表随时
 * 重渲染，按下标二次 `page.$$` 容易错位，点到相邻项即为发错人。
 *
 * 每项给两份文本：`leaves` 是各叶子元素自己的文本（昵称通常是其中一条），
 * `all` 是整条拼起来的文本（昵称被搜索高亮拆散时只有它还完整）。
 *
 * @param {string} selector 会话项或搜索结果项的选择器，即 SEL.conversation / SEL.searchItem
 * @returns {Promise<Array<{slot: number, leaves: string[], all: string}>>} evaluate 失败时返回空数组
 */
export async function readItems(page, selector) {
  return page
    .evaluate(
      ([sel, attr]) => {
        // 先清掉上一轮的序号，否则重渲染后的残留属性会让按序号取到陈旧元素
        for (const el of document.querySelectorAll(`[${attr}]`)) el.removeAttribute(attr)

        /*
         * 定位「一条会话」对应的元素。
         *
         * `[class*="conversation"]` 是模糊匹配，一条会话从外层容器到行、到格子，每层
         * class 都带 conversation，同一个好友会被数成十几个节点（现场的「读到 5 个昵称」
         * 即由此而来：五个「昵称」是同一条会话的五个嵌套层级，面板上并排列出
         * `主号19:0310分钟内在线` / `主号19:03` / `主号` / `19:03` / `10分钟内在线`）。
         * 取最外层同样不行——最外层是整张列表，多个好友会被并成一条。
         *
         * 判据用纯结构、不认 class 名也不认中文文案：按父节点给命中节点归组，会话行是
         * 一批同父兄弟，而各层容器每种只有一个，因此成员最多的那组即会话行。同层的
         * 标题行/副标题行总数虽然相同，但分散在各自会话内部、每组只有一两个，不会被选上。
         *
         * 已排除的两条路径：
         * - 认时间戳（「每条会话必带一个 19:03」）：只有一条会话时整张列表也只带一个时间，
         *   分不出容器与行；「互动消息」这类系统入口没有时间戳
         * - 认 class 串相同：抖音会给当前选中行挂上 active 之类的额外 class，按 class 串
         *   归组会把该行单独分出去
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
 * 从一条会话项里取昵称，供面板的候选列表使用。
 *
 * 判据是「DOM 顺序里第一条不是纯噪音的叶子文本」：抖音的会话项中昵称排在最前，
 * 其后才是时间、在线状态与最近一条消息的预览。
 *
 * 返回的是原文而非归一化结果：这个名字要显示在面板上，还要作为搜索词打进抖音的
 * 搜索框，归一化过的值（去空格、转小写）搜不到结果。
 *
 * @param {{leaves?: string[], all?: string}} item readItems 返回的一项
 * @returns {string} 昵称，最长 40 字符
 */
export function itemName(item) {
  for (const leaf of item.leaves || []) {
    // 整条都是时间或在线状态的叶子，跳过
    if (!stripNoise(leaf)) continue
    return leaf
  }
  // 昵称直接挂在容器的文本节点上、没有独立叶子元素时，退到整条文本去噪
  const fallback = String(item.all || "").replace(NOISE_RE, "").trim()
  return fallback.slice(0, 40)
}

/**
 * 从一条会话项里拆出「消息预览」与「时间戳」，供聊天界面的会话列表使用。
 *
 * 与 itemName 同放在此处而非由 lib/chat.js 自行实现，是为了共用同一份 NOISE_RE。
 * 抖音把昵称、时间、在线状态、最近一条消息的预览全挤在同一条会话项内，没有独立的
 * 预览元素可认，因此只能用排除法：去掉昵称与纯噪音后，剩下最长的一条即预览
 * （预览是一句话，时间和在线状态都是短串）。
 *
 * @param {{leaves?: string[]}} item readItems 返回的一项
 * @param {string} name itemName(item) 的结果，要从预览候选里排掉
 * @returns {{preview: string, stamp: string}} 均可能为空串
 */
export function itemPreview(item, name) {
  const leaves = item.leaves || []
  const preview =
    leaves
      .filter(t => t !== name && stripNoise(t))
      .sort((a, b) => b.length - a.length)[0] || ""
  // 时间戳取第一条「整条都是噪音、且带数字」的叶子；「10分钟内在线」同样是纯噪音，
  // 但不能当时间用，故额外要求不含「在线」
  const stamp = leaves.find(t => !stripNoise(t) && /\d/.test(t) && !t.includes("在线")) || ""
  return { preview, stamp }
}

/**
 * 在一批列表项里挑出目标好友，分档从严到松。
 *
 * 松档（包含匹配）可能同时命中多人：找「主号」而列表里还有「主号2」「主号小号」。
 * 该情形一律返回 `ambiguous`，由调用方判为未命中——发错人的代价高于不发，而用户
 * 只需把名字写全（或加别名）即可解开。严档（完全相同 / 去噪后相同）不做此检查：
 * 名字完全一致时多命中一条只可能是抖音把同一会话渲染了两遍。
 *
 * @param {Array<{slot:number, leaves:string[], all:string}>} items readItems 的结果
 * @param {string} name 目标名字，可以是主名称或别名
 * @returns {{slot:number, tier:number, text:string, ambiguous?:string[]}|null}
 *   tier 为命中档位（TIER_EXACT..TIER_ITEM）；ambiguous 存在时表示命中多条、应判未命中
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
 * 外层是重试轮次、内层是候选名：先用全部候选名各试一遍，都未命中才等待后进入下一轮。
 * 反过来（每个名字各自重试满）会在好友确实改名时多耗 `candidates.length × retry` 轮。
 *
 * 三轮搜索都未命中时不直接失败，改走 findInChatList 在左侧会话列表里兜底。
 *
 * @param {string[]|string} candidates 主名称在前、别名在后
 * @param {(text: string) => void} [notify] 每轮未命中时的进度回调，用于面板提示
 * @param {(...args: unknown[]) => void} [trace] 调试日志出口
 * @returns {Promise<{handle: import("puppeteer").ElementHandle, name: string}|null>}
 *   handle 是搜索结果项（或会话项）本身，交给 openChat 点击；name 是实际命中的那个候选名
 */
export async function searchConversation(page, candidates, notify = () => {}, trace = () => {}) {
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
   * 搜索全部未命中后，直接在左侧会话列表里查找。
   *
   * 这条路径来自现场：搜「又在說我壞話」抖音返回 0 条，而该会话就挂在左侧列表里
   * （面板的「拉取好友会话列表」按钮读到的即是它）。抖音的搜索索引对繁体、emoji、
   * 刚改的备注名不可靠，而列表是当前登录态直接渲染的结果，可信度更高。
   *
   * 置于搜索之后而非之前：列表只有前几十条（要滚动才加载更多），搜索才覆盖全量好友。
   */
  return findInChatList(page, names, trace)
}

/**
 * 在左侧会话列表里直接查找，搜索走不通时的兜底。
 *
 * @param {string[]} names 候选名，与 searchConversation 同一份
 * @returns {Promise<{handle: import("puppeteer").ElementHandle, name: string}|null>}
 */
async function findInChatList(page, names, trace = () => {}) {
  // 搜索面板开着会盖住会话列表，先清掉搜索词让列表回到可见状态
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
 * 单次搜索：清空输入框 → 打入名字 → 轮询结果项直到命中或超时。
 *
 * 每次都先清空并等旧结果收起，否则会读到上一个候选名残留的列表项，导致发错人。
 *
 * @param {string} name 单个候选名
 * @returns {Promise<import("puppeteer").ElementHandle|null>} 命中的搜索结果项；
 *   未命中、命中歧义、或取 handle 时列表已重渲染均返回 null
 */
async function searchOnce(page, name, trace = () => {}) {
  await fillSearch(page, "")
  const cleared = await page
    .waitForFunction(sel => !document.querySelector(sel), { timeout: SEARCH_CLEAR_TIMEOUT }, SEL.searchItem)
    .then(() => true)
    .catch(() => false)
  await sleep(SEARCH_RESET_DELAY)
  const typed = await fillSearch(page, name)
  // 读回搜索框内容以区分两种「0 条结果」：抖音确实搜不到，与字未落进框内（繁体、
  // emoji 昵称遇上受控组件时出现过）。这两种在日志里表现相同，但排查方向不同
  if (typed !== name) trace(`⚠ 搜索框里是「${typed}」，与要搜的「${name}」不一致`)

  /*
   * 轮询而非 waitForFunction：判定要在 Node 侧做。
   *
   * 早期判据是「某个后代元素的 textContent 正好等于名字」，写在 waitForFunction 里，
   * 失败时只能得到一个 false，看不到页面上实际渲染了什么。现场表现为日志只有
   * 「搜「主号」未命中：结果 1 条」——搜到了但无法判断是名字带了后缀、被高亮标签拆开，
   * 还是与时间粘在了一起。
   */
  const deadline = Date.now() + SEARCH_TIMEOUT
  let items = []
  let best = null
  while (true) {
    items = await readItems(page, SEL.searchItem)
    best = pickMatch(items, name)
    // 歧义不算命中，继续等：结果仍在渲染时，稍后可能出现严档的那一条
    if ((best && !best.ambiguous) || Date.now() >= deadline) break
    await sleep(300)
  }

  if (best?.ambiguous) {
    // 与会话列表兜底同一规则：松档命中多人时不发，发错人的代价高于不发
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
      // 只记发生了形变的档位；TIER_EXACT 无排查价值
      if (best.tier > TIER_EXACT) trace(`搜「${name}」按${TIER_NOTE[best.tier]}命中：「${oneLine(best.text, 32)}」`)
      return handle
    }
    // 属性已打上却取不到 handle，说明这一瞬间列表重渲染了；由外层的下一轮重试覆盖
    trace(`搜「${name}」命中第 ${best.slot} 条，但取 handle 时列表已重渲染`)
    return null
  }

  // 结果条数与每条的名字一并输出：「一条都没有」多为搜索索引未就绪或字未进框，
  // 「有几条但名字对不上」才是好友改名或备注不一致，两者排查方向不同
  const seen = items.length
    ? `，页面上是 ${items.map(item => `「${oneLine(item.leaves[0] || item.all, 24)}」`).join("")}`
    : ""
  trace(`搜「${name}」未命中：结果 ${seen ? `${items.length} 条${seen}` : "0 条"}${cleared ? "" : "（上一轮结果未清空，可能有残留）"}`)
  return null
}

/**
 * 清空并输入搜索词。
 *
 * 三连击选中全部再退格，而不是直接改 `el.value`：搜索框是受控组件，直接赋值不触发
 * React 的 onChange，抖音那边的搜索状态不会更新。
 *
 * @param {string} value 要输入的搜索词，空串表示只清空
 * @returns {Promise<string>} 输入后从框里读回的实际内容，读取失败返回空串
 */
async function fillSearch(page, value) {
  const input = await page.waitForSelector(SEL.search, { visible: true, timeout: READY_TIMEOUT })
  await input.click({ clickCount: 3 })
  await page.keyboard.press("Backspace")
  if (value) await input.type(value, { delay: 40 })
  return input.evaluate(el => el.value ?? "").catch(() => "")
}

/**
 * 点搜索结果里的「发消息 / 发私信」入口，进入会话。
 *
 * 不使用 `el.click()`（早期实现如此）：`node.click()` 只派发一个 click 事件，而抖音这个
 * 按钮是 React 组件，响应挂在 pointerdown/mousedown 上时收不到该事件。现场表现为
 * 「点了，右侧聊天区仍是空占位」，随后 waitForEditor 等到超时。因此改走 lib/interact.js：
 * 真鼠标 approach + hover + 按住 70ms，事件未进 DOM 再补一轮合成事件。判据与远程验证共用。
 *
 * 三档依次退：按钮文本 → 整个结果项 → 结果项的首个子元素。
 *
 * @param {import("puppeteer").ElementHandle} item 搜索结果项或会话项
 * @returns {Promise<string>} 实际生效的档位描述，写进日志
 * @throws {Error} 三档全部点击失败时抛出，消息里带 clickHandle 给出的原因
 */
export async function openChat(page, item, trace = () => {}) {
  /*
   * 进会话之前再探一次浮层。
   *
   * 不能只靠 waitForChatList 那一轮：「是否保存登录信息」在页面就绪之后数秒才弹出，
   * 而本步骤在多目标续火中会被反复走到（每个好友一次），中途弹出的浮层只能在这里拦住。
   * 现场案例：日志写着「点「发消息」：事件已到 DOM」，实际到达的是
   * `div.trust-login-dialog-mask`，随后 waitForEditor 等满 4 档 31 轮。
   * 无浮层时本步骤只是一次 evaluate，多目标下开销可忽略。
   *
   * esc: false —— 此时搜索结果面板正开着，调用方持有的 item 即面板中的一项，
   * 按 Escape 会收掉面板并使 handle 失效。
   */
  await dismissOverlay(page, trace, { esc: false })

  // 按钮常常只在 hover 时才渲染，所以先把鼠标移到结果项上
  const byText = await clickByText(page, /^(发消息|发私信)$/, { root: item, hover: true, scope: "进入会话" })
  if (byText.ok) return `点「${byText.text}」`
  trace(`没点到「发消息」按钮（${byText.reason}），改点整条结果项`)

  const byItem = await clickHandle(page, item, { scope: "进入会话" })
  if (byItem.ok) return "点整条结果项"

  // 结果项自身不可见（被折叠 / 在滚动容器外）时退到它的首个可见子元素
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
 * 不用 `page.waitForSelector` 逐档串行等：那样最坏是 4 档 × 12 秒。改为一轮内把四档
 * 各问一遍，均未命中则等 EDITOR_POLL 再来一轮，总上限仍是 EDITOR_TIMEOUT。
 *
 * @returns {Promise<{handle: import("puppeteer").ElementHandle, tier: number, sel: string,
 *   box: {cx: number, cy: number}}>} tier 为命中的档位下标，sel 为该档选择器，
 *   box 是 visibleBox 的结果，typeAndSend 用它的中心点去点击
 * @throws {Error} 超时时抛出，消息里带档数、轮数与 describeLine 的页面现状
 */
async function waitForEditor(page, trace = () => {}) {
  const deadline = Date.now() + EDITOR_TIMEOUT
  let rounds = 0
  for (;;) {
    rounds++
    for (const [tier, sel] of EDITORS.entries()) {
      const handle = await page.$(sel).catch(() => null)
      if (!handle) continue
      // $ 只判断节点是否存在，可见性需自行判定：抖音会把上一个会话的编辑器留在 DOM 里
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
 * 独立成函数是因为有两个调用方（定时续火 sparkOnce、面板自定义发信 sendCustom），
 * 而这一段是整条链路上最易被抖音改版打穿的位置，分散实现会导致改一处漏一处。
 *
 * @param {import("puppeteer").ElementHandle} item searchConversation 返回的 handle
 * @param {string} message 消息正文
 * @throws {Error} openChat 点不进会话、或 typeAndSend 里输入框未出现 / 消息未发出时抛出
 */
export async function sendMessage(page, item, message, trace = () => {}) {
  const how = await openChat(page, item, trace)
  trace(`已进入会话（${how}），等输入框`)
  await typeAndSend(page, message, trace)
}

/**
 * 会话已打开的前提下，把一条消息打进输入框并发出。
 *
 * 从 sendMessage 中拆出，因为聊天界面（lib/chat.js）的会话是常开的：用户在网页上点了
 * 好友之后抖音那边的会话一直停留，再走一遍 openChat 等于把已打开的会话重新点一次——
 * 多一次点击、多一次浮层探测，且可能因搜索面板已收起而点不到目标。
 *
 * @param {string} message 消息正文
 * @throws {Error} 输入框未出现、字数校验不过、或发送后输入框未清空时抛出
 */
export async function typeAndSend(page, message, trace = () => {}) {
  const editor = await waitForEditor(page, trace)
  try {
    // 点输入框走同一条链路：光标未进入时下面的 sendCharacter 会打在空处。
    // 一并递入 handle —— 兜底的合成事件与聚焦应作用于这个编辑器，而非坐标下的元素
    // （抖音把表情/发送按钮浮在输入框上，遮挡时两者不是同一个节点）
    const clicked = await clickAt(page, editor.box.cx, editor.box.cy, {
      scope: "消息输入框",
      handle: editor.handle,
    })
    if (!clicked.arrived) trace("点输入框时真鼠标事件没进 DOM，已走合成事件兜底")
  } finally {
    await editor.handle.dispose().catch(() => {})
  }

  // puppeteer 没有 insertText，sendCharacter 能正确输入中文与 emoji，
  // 且不会像 type() 那样把 \n 当回车提前发出去
  await page.keyboard.sendCharacter(message)

  /*
   * 发送前确认文本已进入编辑器。
   *
   * sendCharacter 走 CDP 的 `Input.insertText`，只保证文本已派发——焦点不在编辑器里时
   * 同样返回成功，紧接着的 Enter 就在空会话里敲了个回车，结果是「日志说发了 N 条，
   * 抖音那边一条没有」。这类失败不报错，因此必须显式读回编辑器内的字数；为空时交给
   * typeText 走完整的三级退化（真键盘 → insertText → 合成输入），Slate 编辑器是
   * contenteditable，末一级的 forceType 认它。
   */
  const len = await page.evaluate(sel => {
    const el = document.querySelector(sel)
    return el ? (el.innerText || el.textContent || "").trim().length : -1
  }, editor.sel)
  if (len === 0) {
    trace("输入框仍是空的，改走 typeText 的三级退化补写")
    await typeText(page, message, { scope: "消息输入框", delay: 0 })
  }

  await pressKey(page, "Enter", { scope: "消息输入框" })
}

/**
 * 失败现场截图，落在 data/screenshots 下（与 debug.js 的快照目录分开）。
 * 截图本身失败只记 warn，不向上抛：它是排查用的附加信息，不该把任务再失败一次。
 *
 * @returns {Promise<string>} 文件绝对路径，未截到返回空串
 */
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

/**
 * 给一个 Promise 加超时。用于 runAccount 的整体上限：链路上每一步都有自己的超时，
 * 但步骤数不定（多目标 × 多档退路），只有在最外层再兜一道才能保证任务必然结束。
 *
 * @param {number} ms 超时毫秒数
 * @param {string} message 超时时抛出的错误消息
 * @returns {Promise<any>} 原 Promise 的结果；超时则以 message 拒绝
 */
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
 * 单个账号抛错不会中断整批：捕获后补一条 ok:false 的结果继续下一个。
 *
 * @param {object} [opts]
 * @param {(text: string) => void} [opts.onProgress] 透传给 runAccount 的进度回调
 * @param {boolean} [opts.skipIfDone] 逐个账号判定「今天是否已成功」，跳过的 account
 *   在结果里带 `skipped: true`，推送时会单独归一类而不是混进成功数
 * @returns {Promise<Array<object>>} 每个账号一条，含 accountId / account 与 runAccount 的字段
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

/**
 * 面板上的「发一条自定义消息」：不走模板，直接发指定文本给指定好友。
 *
 * 与 runAccount 的差别：不读续火目标、不写「今天已成功」、不做别名候选与自愈改名，
 * 因此单独实现而非给 runAccount 加参数。
 *
 * @param {string[]|string} friends 面板勾选的好友昵称，逐个串行发送
 * @param {string} text 消息正文，去空白后不能为空
 * @returns {Promise<{ok: boolean, sent: Array<{friend, message, at}>, missing: string[],
 *   error: string, detail: string}>} missing 同时包含「搜不到」与「搜到但发送失败」两种；
 *   detail 是首个失败原因
 * @throws {Error} 账号不存在、未选好友、正文为空、无可用 Cookie、账号被别的任务占用时抛出
 */
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
  const held = running.get(key)
  if (held) throw new Error(`该账号${held.why}，请稍后再试`)
  running.set(key, { at: Date.now(), why: "正在发送消息" })

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
        // 单个好友发送失败不应中断后续目标：记入 missing 后继续
        const why = toError(error).message
        result.missing.push(friend)
        // 面板只显示 error 那一行，因此带上首个失败原因，否则用户只看到「未成功发送」
        if (!result.detail) result.detail = why
        notify(`发送失败，跳过：${friend}（${why}）`)
        await snapshot(page, `${account.name}-custom-${friend}-send-failed`)
      }
      if (index < targets.length - 1) await randomSleep(1200, 2500)
    }
    await new Promise(r => setTimeout(r, 2000))
    result.ok = result.missing.length === 0
    // missing 同时包含「搜不到」与「搜到但未发出」，故措辞不能写成「未找到会话」
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
 *
 * 结果按 `spark.friendsCacheTTL` 缓存在账号文件里（复用 cookieCheck 那套
 * 「写 {at,...} + 按 TTL 判过期」的形状，见 lib/store.js）。真拉一次要开浏览器、进
 * 聊天页、等会话渲染完，好友多的号十几秒，而名单几天都不会变；不缓存的话面板每次
 * 打开发信卡片都要等一轮，还每次都对抖音发一遍请求。
 *
 * @param {object} [opts]
 * @param {boolean} [opts.refresh] 忽略缓存强制真拉（面板上的「重新拉取」）
 * @returns {Promise<{names: string[], cached: boolean, at: number}>}
 */
export async function listFriends(botId, accountId, { refresh = false } = {}) {
  const ttlMs = config.num("spark.friendsCacheTTL", 240, { min: 0 }) * 60000
  if (!refresh) {
    const cache = store.cachedFriends(botId, accountId, ttlMs)
    if (cache) {
      debug("拉取会话列表", `命中缓存：${cache.names.length} 个昵称，拉取于 ${formatTime(cache.at)}`)
      return { names: cache.names, cached: true, at: cache.at }
    }
  }

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
     * 复用搜索那边的 readItems + itemName，不另写一套 DOM 抓取。
     *
     * 早期实现是 `querySelectorAll(sel)` 之后取每项的首个短文本，两处都不成立：
     * `[class*="conversation"]` 是模糊匹配 class，一条会话的外层容器与其内部多层子节点
     * 会同时命中，同一个好友被数成多条——现场「读到 5 个昵称」实际只有一个好友，
     * 面板上并排列出的 `主号19:0310分钟内在线` / `主号19:03` / `主号` / `19:03` /
     * `10分钟内在线` 是同一条会话的五个嵌套层级。readItems 会先按父节点归组、只保留
     * 「兄弟最多」的那一组（即会话行本身），itemName 再把时间与在线状态从粘连文本里剔掉。
     */
    const items = await readItems(page, SEL.conversation)
    const names = []
    for (const item of items) {
      const name = itemName(item)
      if (name && !names.includes(name)) names.push(name)
    }

    debug("拉取会话列表", `${items.length} 条会话，读出 ${names.length} 个昵称`)
    const out = names.slice(0, 200)
    // 空结果不写缓存：拉到 0 个多为页面未渲染完或 Cookie 半失效，缓存会把一次偶发失败
    // 固化成数小时的「这个号没有好友」
    if (out.length) store.recordFriends(botId, accountId, out)
    return { names: out, cached: false, at: Date.now() }
  } finally {
    await closeQuietly(page)
    await closeQuietly(context)
  }
}

/**
 * 状态面板用的汇总：账号数、最近一次运行时间与结果。
 *
 * 纯读 store，不碰浏览器，可随时调用。
 *
 * @returns {{total:number, enabled:number, invalid:number, targets:number, doneToday:number,
 *   okCount:number, failCount:number, sentCount:number, lastAt:number, lastTime:string}}
 *   okCount / failCount / sentCount 统计的是各账号「最近一次运行」，不是历史累计
 */
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
