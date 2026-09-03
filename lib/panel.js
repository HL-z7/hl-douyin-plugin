/**
 * 三套图片面板（状态、设置、帮助）的数据组装。
 *
 * 每个面板成对提供两个导出：`buildXxxData()` 返回给 lib/render.js 渲图用的数据对象，
 * `xxxText()` 返回纯文字版。两者读同一份数据源（文字版直接调 build 函数再展平），
 * 因此关掉 render.image 或渲染失败降级时，用户看到的内容不会缺项，只是排版不同。
 *
 * 导出：buildStatusData / statusText、buildSettingsData / settingsText、
 * buildHelpData / helpText。对应模板在 resources/{status,settings,help}/*.html。
 *
 * 依赖：数据全部来自其它模块的状态查询接口 —— scheduler.status()、spark.summarize()、
 * push.pushSummary()、auth.authStatus()、store.list()、chat.sessionList() 与
 * chat.chatdb.status()，本模块只做展示层拼装，不改任何状态。
 *
 * 调用前提：指令层（apps/panel.js）只负责调用，不自行拼文本 —— 同一份内容在 index.js
 * 与 Web 面板重复拼装时容易漏改。图片与文字版共用的常量（SETTING_COMMANDS、
 * HELP_FEATS、HELP_RULES、HELP_GROUPS）也集中在本文件，新增条目只改一处。
 */
import { formatTime, oneLine } from "./util.js"
import { config } from "./config.js"
import { store, targetLabel } from "./store.js"
import { scheduler } from "./scheduler.js"
import { summarize, isRunning } from "./spark.js"
import { pushSummary } from "./push.js"
import { authStatus } from "./auth.js"
import { getBot } from "./bot.js"
import { version } from "./render.js"
import { sessionList as chatSessions, chatdb } from "./chat.js"

/**
 * 机器人的展示名：`昵称(QQ)`，取不到昵称时只返回 QQ。
 * @param {string|number} botId
 * @returns {string}
 */
function botName(botId) {
  const bot = getBot(botId)
  return bot?.nickname ? `${bot.nickname}(${botId})` : String(botId)
}

/**
 * 聊天功能摘要，状态面板与设置面板共用。
 *
 * 只报「开着几个会话 / 库里存了多少条」，不报数据库文件路径：这两个面板会被发到群里，
 * 路径等于公开服务器目录结构（lib/web.js 的 chatDbBrief 出于同一判据剥掉 path 字段）。
 *
 * @param {string|number} botId 只统计该机器人名下的会话
 * @returns {{on: boolean, count: number, detail: string, text: string}}
 *   on=功能是否开启，count=该机器人开着的会话数，detail=明细，text=一行摘要
 */
function chatBrief(botId) {
  if (config.get("chat.enable", true) === false)
    return { on: false, count: 0, detail: "功能已关闭", text: "已关闭" }
  const mine = chatSessions().filter(s => String(s.botId) === String(botId))
  const db = chatdb.status()
  // 有会话开着时报会话本身，否则退到库里的存量；库不可用时报原因，避免用户只看到「无记录」
  const detail = mine.length
    ? mine.map(s => (s.peer ? `${s.account}→${s.peer}` : `${s.account}（未选会话）`)).join("、")
    : db.ok
      ? `已存 ${db.messages} 条消息 / ${db.conversations} 个会话`
      : db.reason
        ? `存储不可用：${db.reason}`
        : "无记录"
  const head = mine.length ? `${mine.length} 个会话开着` : "空闲"
  return { on: true, count: mine.length, detail, text: `${head} · ${detail}` }
}


// ────────────────────────────── 状态面板 ──────────────────────────────

/**
 * 组装状态面板数据，图片版与文字版共用。
 *
 * 汇总四路状态：定时任务（scheduler.status）、续火统计（summarize）、推送配置
 * （pushSummary）、Web 会话数（authStatus），再逐账号列出可用性与上次结果。
 *
 * @param {string|number} botId 机器人 QQ，账号列表与续火统计都按它过滤
 * @returns {object} 交给 resources/status/status.html 的数据对象；
 *   `infoRows` 为键值行，`accounts` 为账号行（state: on/idle/空串 → 绿/灰/红）
 */
export function buildStatusData(botId) {
  const sched = scheduler.status()
  const spark = summarize(botId)
  const push = pushSummary()
  const auth = authStatus()
  const chat = chatBrief(botId)

  const infoRows = [
    { k: "cron 表达式", v: sched.cron || "未设置", mono: true },
    { k: "下次执行", v: sched.nextTime },
    { k: "当前状态", v: sched.busy ? "续火进行中" : "空闲" },
    { k: "今日已续火", v: sched.skipIfDone ? `跳过（已完成 ${spark.doneToday} 个账号）` : "不跳过，每次都发" },
    { k: "上次续火", v: spark.lastTime, dim: !spark.lastAt },
    {
      k: "上次结果",
      v: sched.lastRun
        ? `${sched.lastRun.trigger} · 成功 ${sched.lastRun.ok} / 失败 ${sched.lastRun.fail}` +
          `${sched.lastRun.skipped ? ` / 跳过 ${sched.lastRun.skipped}` : ""}`
        : "无记录",
      dim: !sched.lastRun,
    },
    {
      k: "结果推送",
      v: push.enable
        ? `${push.targetLabel} · ${push.groupCount} 群 / ${push.friendCount} 好友` +
          `（${push.mode === "detail" ? "详细" : "简要"}${push.onlyOnFail ? "，仅失败推送" : ""}）`
        : "已关闭",
      dim: !push.enable,
    },
    {
      k: "Web 面板",
      v: config.bool("web.enable", true) ? `已启用 · 有效会话 ${auth.activeSessions}` : "已关闭",
      dim: !config.bool("web.enable", true),
    },
    { k: "私信聊天", v: chat.text, dim: !chat.on },
    { k: "消息模板", v: config.get("spark.messageTemplate", "") ? "自定义模板" : "随机一言" },
  ]

  const accounts = store.list(botId).map(acc => {
    const last = acc.lastRun
    return {
      name: acc.name,
      // 状态点三态：红（空串）=不可用，缺 Cookie 或凭证失效；灰=手动停用；绿=正常
      state: acc.cookieInvalid || !acc.hasCookie ? "" : acc.enable === false ? "idle" : "on",
      friends: acc.targets?.length ? acc.targets.map(targetLabel).join("、") : "未配置好友",
      result: !acc.hasCookie
        ? "缺 Cookie"
        : acc.cookieInvalid
          ? "凭证失效"
          : isRunning(botId, acc.id)
            ? "运行中"
            : last
              ? `${last.ok ? "✅" : "❌"} ${last.sent?.length || 0} 条`
              : "未运行",
    }
  })

  return {
    saveId: `status-${botId}`,
    icon: "🔥",
    kicker: "HL DOUYIN PLUGIN",
    title: "抖音续火状态",
    subtitle: `${botName(botId)} · ${formatTime()}`,
    badge: sched.enable ? (sched.registered ? "定时运行中" : "cron 无效") : "定时已关闭",
    badgeType: sched.enable ? (sched.registered ? "ok" : "err") : "neutral",
    sched,
    spark,
    accounts,
    infoRows,
  }
}

/**
 * 状态面板的纯文字版。直接展平 buildStatusData 的结果，保证与图片版内容一致。
 * @param {string|number} botId
 * @returns {string} 多行文本
 */
export function statusText(botId) {
  const data = buildStatusData(botId)
  const lines = [
    "🔥 抖音续火状态",
    `机器人：${botName(botId)}`,
    `时间：${formatTime()}`,
    `账号：${data.spark.total} 个（启用 ${data.spark.enabled}，失效 ${data.spark.invalid}，` +
      `好友 ${data.spark.targets} 个，今日已续 ${data.spark.doneToday}）`,
  ]
  for (const row of data.infoRows) lines.push(`${row.k}：${row.v}`)
  if (data.accounts.length) {
    lines.push("────────")
    for (const acc of data.accounts) lines.push(`· ${acc.name}：${acc.result}｜${acc.friends}`)
  }
  return lines.join("\n")
}

// ────────────────────────────── 设置面板 ──────────────────────────────

/** 布尔值的统一显示文案 */
const ON_OFF = v => (v ? "开启" : "关闭")

/**
 * 可用 `#抖音设置` 直接修改的配置项清单。
 * 图片版与文字版共用一份，避免两处说明不一致；`txt` 里允许 `<b>` 强调，文字版会剥掉标签。
 */
const SETTING_COMMANDS = [
  { cmd: "#抖音设置 定时 开/关", txt: "总开关，关掉后定时任务注销" },
  { cmd: "#抖音设置 cron 0 20 8 * * *", txt: "6 位 cron，<b>秒在最前</b>" },
  { cmd: "#抖音设置 跳过 开/关", txt: "今天已成功续火就跳过定时任务" },
  { cmd: "#抖音设置 推送 开/关", txt: "续火结束后是否推送结果" },
  { cmd: "#抖音设置 推送范围 群/私聊/两者", txt: "结果发到群、私聊还是都发" },
  { cmd: "#抖音设置 推送模式 详细/简要", txt: "详细逐条列出发送内容" },
  { cmd: "#抖音设置 渲染 开/关", txt: "帮助/设置/状态是否出图" },
  { cmd: "#抖音设置 打码 开/关", txt: "群内回复面板链接是否<b>隐去主机</b>" },
  { cmd: "#抖音设置 聊天 开/关", txt: "面板里的<b>私信聊天</b>功能总开关" },
  { cmd: "#抖音设置 自动短信 开/关", txt: "让 #抖音登录 也自动过短信验证" },
  { cmd: "#抖音设置 调试 开/关", txt: "每一步都记日志，卡住时用" },
  { cmd: "#抖音设置 快照 开/关", txt: "调试态下额外存截图与页面原文" },
  { cmd: "#抖音设置 加群 [群号]", txt: "不填群号则用当前群" },
  { cmd: "#抖音设置 删群 [群号]", txt: "从推送列表移除" },
  { cmd: "#抖音设置 加好友 [QQ]", txt: "不填则用自己" },
  { cmd: "#抖音设置 删好友 [QQ]", txt: "从私聊推送列表移除" },
  { cmd: "#抖音设置 解封IP", txt: "清空 Web 面板的 IP 黑名单" },
  { cmd: "#抖音设置 会话", txt: "查看活跃的面板会话" },
]

/**
 * 组装设置面板数据，图片版与文字版共用。
 *
 * 六段分组（定时续火 / 结果推送 / 访问频次与安全 / 私信聊天 / 渲染与更新 / 排查）直接读
 * config，各行的 fallback 与 lib/config.js 的 DEFAULT_CONFIG 保持一致，改默认值需同步两处。
 *
 * @param {string|number} botId
 * @returns {object} 交给 resources/settings/settings.html 的数据对象；
 *   `sections` 为分段键值行，`commands` 为 SETTING_COMMANDS
 */
export function buildSettingsData(botId) {
  const sched = scheduler.status()
  const push = pushSummary()
  const spark = summarize(botId)
  const chat = chatBrief(botId)

  const sections = [
    {
      name: "定时续火",
      right: sched.registered ? `下次 ${sched.nextTime}` : "未注册",
      rows: [
        { k: "总开关", v: ON_OFF(sched.enable), dim: !sched.enable },
        { k: "cron 表达式", v: sched.cron || "未设置", mono: true },
        { k: "跳过已续火", v: ON_OFF(sched.skipIfDone) },
        { k: "无头模式", v: ON_OFF(config.bool("spark.headless", true)) },
        {
          k: "好友间隔",
          v: `${config.num("spark.minGapMs", 2500)} ~ ${config.num("spark.maxGapMs", 6000)} ms`,
        },
        { k: "搜索重试", v: `${config.num("spark.searchRetry", 3)} 次` },
        { k: "消息模板", v: oneLine(config.get("spark.messageTemplate", ""), 46) || "随机一言" },
      ],
    },
    {
      name: "结果推送",
      right: push.enable ? push.targetLabel : "已关闭",
      rows: [
        { k: "总开关", v: ON_OFF(push.enable), dim: !push.enable },
        { k: "推送范围", v: push.targetLabel },
        { k: "推送模式", v: push.mode === "detail" ? "详细（逐条列出）" : "简要（只报数量）" },
        { k: "仅失败推送", v: ON_OFF(push.onlyOnFail) },
        { k: "目标群", v: push.groups.length ? push.groups.map(g => g.id).join("、") : "未配置", dim: !push.groups.length },
        {
          k: "目标好友",
          v: push.friends.length ? push.friends.map(f => f.id).join("、") : "未配置",
          dim: !push.friends.length,
        },
      ],
    },
    {
      name: "访问频次与安全",
      right: "降低风控风险",
      rows: [
        { k: "拦截图片字体", v: ON_OFF(config.bool("spark.blockResources", true)) },
        { k: "拦截埋点推荐流", v: ON_OFF(config.bool("spark.blockTracking", true)) },
        { k: "Cookie 检查缓存", v: `${config.num("spark.cookieCheckTTL", 30)} 分钟` },
        { k: "手动导入 Cookie", v: ON_OFF(config.bool("security.allowManualCookie", true)) },
        { k: "自动接管短信验证", v: ON_OFF(config.bool("security.autoSms", false)) },
        { k: "Web 面板", v: ON_OFF(config.bool("web.enable", true)) },
        { k: "验证码有效期", v: `${config.num("web.codeTTL", 300)} 秒` },
        { k: "群内链接打码", v: ON_OFF(config.bool("web.maskLinkInGroup", true)) },
      ],
    },
    {
      name: "私信聊天",
      right: chat.on ? (chat.count ? `${chat.count} 个会话开着` : "空闲") : "已关闭",
      rows: [
        { k: "总开关", v: ON_OFF(chat.on), dim: !chat.on },
        // 两列布局下这一格宽约 250px，长会话名会折成两行，因此截到 24 字
        { k: "当前会话", v: oneLine(chat.detail, 24), dim: !chat.on },
        { k: "空闲自动关闭", v: `${config.num("chat.idleCloseSec", 180)} 秒` },
        { k: "前端轮询间隔", v: `${config.num("chat.pollMs", 3000)} ms` },
        { k: "历史加载条数", v: `${config.num("chat.historyLimit", 60)} 条` },
        { k: "单条最长", v: `${config.num("chat.maxLength", 500)} 字` },
      ],
    },
    {
      name: "渲染与更新",
      rows: [
        { k: "文本渲染成图", v: ON_OFF(config.bool("render.image", true)) },
        { k: "渲染倍率", v: String(config.num("render.scale", 1)) },
        { k: "更新后重启", v: ON_OFF(config.bool("update.autoRestart", true)) },
        { k: "更新日志条数", v: String(config.num("update.logLimit", 20)) },
      ],
    },
    {
      name: "排查",
      // 调试开着时在标题右侧标明：它会让日志量成倍增长，容易忘记关闭
      right: config.bool("debug.enable", false) ? "调试中" : "默认全关",
      rows: [
        { k: "调试日志", v: ON_OFF(config.bool("debug.enable", false)), dim: !config.bool("debug.enable", false) },
        { k: "现场快照", v: ON_OFF(config.bool("debug.snapshot", false)), dim: !config.bool("debug.snapshot", false) },
        { k: "快照保留", v: config.num("debug.keep", 200) ? `${config.num("debug.keep", 200)} 个文件` : "不清理" },
        { k: "失败截图", v: ON_OFF(config.bool("spark.screenshotOnFail", true)) },
      ],
    },
  ]

  return {
    saveId: `settings-${botId}`,
    icon: "⚙️",
    kicker: "HL DOUYIN PLUGIN",
    title: "抖音续火设置",
    subtitle: `${botName(botId)} · ${spark.total} 个账号 · ${formatTime()}`,
    badge: sched.enable ? "定时开启" : "定时关闭",
    badgeType: sched.enable ? "ok" : "neutral",
    sections,
    commands: SETTING_COMMANDS,
    tip: "更多配置（好友备注、消息模板、推送目标）请用 <span class=\"hl\">#抖音web</span> 面板或锅巴插件。",
  }
}

/**
 * 设置面板的纯文字版。展平 buildSettingsData 的分段与指令清单。
 * @param {string|number} botId
 * @returns {string} 多行文本
 */
export function settingsText(botId) {
  const data = buildSettingsData(botId)
  const lines = ["⚙️ 抖音续火设置", `机器人：${botName(botId)}`]
  for (const sec of data.sections) {
    lines.push(`──── ${sec.name} ────`)
    for (const row of sec.rows) lines.push(`${row.k}：${row.v}`)
  }
  lines.push("──── 可用指令 ────")
  // 文字版必须剥掉 <b>：它只对模板有意义，直接发给用户会原样显示成标签
  for (const it of data.commands) lines.push(`${it.cmd} — ${it.txt.replace(/<\/?b>/g, "")}`)
  lines.push("", "更多配置请用「#抖音web」或锅巴插件。")
  return lines.join("\n")
}

// ────────────────────────────── 帮助面板 ──────────────────────────────

/**
 * 顶部能力概览的四格内容。
 *
 * 帮助图的主体是二十余条指令，直接列出时读者需自行从指令名归纳插件的能力范围；
 * 这四格先给出功能维度，后面的指令分组再落到具体用法。
 * 排序按使用频度：续火是主功能，聊天是面板内的独立功能，后两项针对登录时的人工验证。
 */
const HELP_FEATS = [
  { tag: "核心", name: "定时续火", desc: "6 位 cron，改完立即生效" },
  { tag: "面板内", name: "私信聊天", desc: "点账号进私信，记录存本机不过期" },
  { tag: "免链接", name: "自动过短信", desc: "把收到的验证码发回来就行" },
  { tag: "私信链接", name: "远程过验证", desc: "滑块拼图交回你手上点" },
]

/**
 * 对全部指令都成立的三条约定，渲染成帮助图底部的并排信息带。
 *
 * 单独成带而不并入某个指令分组：写进任一分组都会被读成该分组的特例；并入底部提示条
 * 会把那段文字撑到接近一屏。每格内容需控制在一行内 —— 三格并排时单格宽约 250px，
 * 折行会使整条信息带高度翻倍。
 */
const HELP_RULES = [
  { k: "权限", v: "<b>仅主人</b>，状态与帮助人人可用" },
  { k: "场合", v: "链接<b>只私信回</b>，群里自动打码" },
  { k: "配置", v: "锅巴可视化，或 <b>#抖音设置</b>" },
]

/**
 * 指令清单，图片版与文字版共用，新增指令只改此处。
 * `txt` 里允许 `<b>` 强调，文字版会自动剥掉标签。
 */
const HELP_GROUPS = [
  {
    name: "面板",
    right: "仅主人",
    items: [
      { cmd: "#抖音web", txt: "<b>私信</b>发一条点开即进的面板链接" },
      { cmd: "#抖音web下线", txt: "立即作废自己的验证码与会话" },
      { cmd: "（面板内）点账号 → 聊天", txt: "进入该账号的抖音<b>私信</b>：会话列表、历史消息、直接回信" },
    ],
  },
  {
    name: "登录",
    right: "私聊使用",
    items: [
      { cmd: "#抖音登录 [账号名]", txt: "扫码登录，自动抓取 Cookie" },
      { cmd: "#抖音自动登录 [账号名]", txt: "扫码 + <b>自动过短信验证</b>，只需把验证码发回来" },
      { cmd: "#抖音手动登录 账号名 Cookie", txt: "直接粘贴 Cookie" },
      { cmd: "#抖音文件登录 账号名", txt: "然后发一个 <b>txt 文件</b>，适合超长 Cookie" },
      { cmd: "#抖音检查cookie", txt: "验证凭证是否还有效（结果会缓存）" },
    ],
  },
  {
    name: "续火",
    items: [
      { cmd: "#抖音续火", txt: "立即为当前机器人执行一次" },
      { cmd: "#抖音续火 跳过", txt: "今天已成功续过的账号不再重复发" },
      { cmd: "#抖音账号", txt: "查看账号、好友与上次结果" },
      { cmd: "#抖音删除账号 账号名", txt: "连同 Cookie 一起删除" },
    ],
  },
  {
    name: "好友备注",
    right: "改名不丢目标",
    items: [
      { cmd: "#抖音加好友 账号名 昵称(备注)", txt: "备注只用于展示，不参与搜索" },
      { cmd: "#抖音加好友 账号名 新名=旧名", txt: "等号后是<b>别名</b>，搜不到主名时自动试" },
      { cmd: "#抖音删好友 账号名 昵称", txt: "从续火列表移除" },
      { cmd: "#抖音备注 账号名 昵称 备注", txt: "只改备注" },
    ],
  },
  {
    name: "状态与设置",
    items: [
      { cmd: "#抖音状态", txt: "图片状态面板" },
      { cmd: "#抖音设置", txt: "查看全部配置与可改项" },
      { cmd: "#抖音设置 聊天 开/关", txt: "面板私信聊天的<b>总开关</b>" },
      { cmd: "#抖音更新", txt: "拉取插件最新代码（配置会保留）" },
      { cmd: "#抖音强制更新", txt: "丢弃本地改动后更新" },
    ],
  },
]

/**
 * 组装帮助面板数据，图片版与文字版共用同一批常量。
 *
 * @param {string|number} [botId] 形参保留以与另两个 build 函数签名一致，函数体不使用它
 *   （帮助内容与机器人无关）
 * @returns {object} 交给 resources/help/help.html 的数据对象
 */
export function buildHelpData(botId) {
  // 只统计以 # 开头的真实指令：「（面板内）点账号 → 聊天」是操作路径，不计入右上角的条数
  const count = HELP_GROUPS.reduce((n, g) => n + g.items.filter(it => it.cmd.startsWith("#")).length, 0)
  return {
    saveId: "help",
    icon: "🔥",
    kicker: "HL DOUYIN PLUGIN",
    title: "抖音续火插件",
    subtitle: `v${version()} · 定时续火 · 私信聊天 · 多机器人隔离`,
    badge: `${count} 条指令`,
    badgeType: "neutral",
    feats: HELP_FEATS,
    rules: HELP_RULES,
    groups: HELP_GROUPS,
    tip:
      "好友改名是断火最常见的原因：把新昵称用 <span class=\"hl\">新名=旧名</span> 加进别名，" +
      "续火时主名搜不到会自动试别名，命中后把新名提为主名，下次直接用新名搜。<br>" +
      "改过插件代码要 <span class=\"hl\">#重启</span> 才生效；重启与关机之前插件会先关掉浏览器、" +
      "聊天页与数据库，不留孤儿 Chromium。",
  }
}

/**
 * 帮助面板的纯文字版。不接收 botId —— 帮助内容与机器人无关。
 * @returns {string} 多行文本
 */
export function helpText() {
  const lines = ["🔥 抖音续火插件指令", ""]
  // 图片版顶部的四格能力概览，文字版压成一行一条，顺序与 HELP_FEATS 一致
  for (const f of HELP_FEATS) lines.push(`· ${f.name}（${f.tag}）：${f.desc}`)
  lines.push("")
  for (const g of HELP_GROUPS) {
    lines.push(`【${g.name}】`)
    for (const it of g.items) lines.push(`${it.cmd} — ${it.txt.replace(/<\/?b>/g, "")}`)
    lines.push("")
  }
  for (const r of HELP_RULES) lines.push(`${r.k}：${r.v.replace(/<\/?b>/g, "")}`)
  lines.push("")
  lines.push("好友改名后用「#抖音加好友 账号名 新名=旧名」把别名补上，续火会自动认新名。")
  lines.push("改过插件代码要 #重启 才生效；重启与关机之前插件会先关掉浏览器、聊天页与数据库。")
  return lines.join("\n")
}
