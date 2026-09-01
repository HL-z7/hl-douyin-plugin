/**
 * 三套图片面板的数据组装：状态、设置、帮助。
 *
 * 每个面板都成对提供 `buildXxxData()` 与 `xxxText()`：前者喂给 lib/render.js 渲图，
 * 后者是纯文字版。两者读同一份数据源，所以「关掉图片渲染」或「渲染失败降级」时
 * 用户看到的内容不会缺项，只是排版不同。
 *
 * 指令层只管调用，不自己拼文本——同一份内容在 index.js 与 web 面板重复拼是
 * 之前最容易漏改的地方。
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

/** 机器人的展示名：`昵称(QQ)`，取不到昵称就只给 QQ */
function botName(botId) {
  const bot = getBot(botId)
  return bot?.nickname ? `${bot.nickname}(${botId})` : String(botId)
}

// ────────────────────────────── 状态面板 ──────────────────────────────

/** 组装状态面板数据，图片与文字版共用 */
export function buildStatusData(botId) {
  const sched = scheduler.status()
  const spark = summarize(botId)
  const push = pushSummary()
  const auth = authStatus()

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
    { k: "消息模板", v: config.get("spark.messageTemplate", "") ? "自定义模板" : "随机一言" },
  ]

  const accounts = store.list(botId).map(acc => {
    const last = acc.lastRun
    return {
      name: acc.name,
      // 红=不可用（缺 ck / 失效），灰=手动停用，绿=正常
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

/** 状态面板的纯文字版 */
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

const ON_OFF = v => (v ? "开启" : "关闭")

/** 可用指令直接改的设置项，图片与文字版共用一份，避免两处说明不一致 */
const SETTING_COMMANDS = [
  { cmd: "#抖音设置 定时 开/关", txt: "总开关，关掉后定时任务注销" },
  { cmd: "#抖音设置 cron 0 20 8 * * *", txt: "6 位 cron，<b>秒在最前</b>" },
  { cmd: "#抖音设置 跳过 开/关", txt: "今天已成功续火就跳过定时任务" },
  { cmd: "#抖音设置 推送 开/关", txt: "续火结束后是否推送结果" },
  { cmd: "#抖音设置 推送范围 群/私聊/两者", txt: "结果发到群、私聊还是都发" },
  { cmd: "#抖音设置 推送模式 详细/简要", txt: "详细逐条列出发送内容" },
  { cmd: "#抖音设置 渲染 开/关", txt: "帮助/设置/状态是否出图" },
  { cmd: "#抖音设置 打码 开/关", txt: "群内回复面板链接是否<b>隐去主机</b>" },
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

export function buildSettingsData(botId) {
  const sched = scheduler.status()
  const push = pushSummary()
  const spark = summarize(botId)

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
      // 调试开着时在标题右边挑明：它会让日志量成倍增长，忘了关比开着更麻烦
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
    title: "抖音续火设置",
    subtitle: `${botName(botId)} · ${spark.total} 个账号 · ${formatTime()}`,
    badge: sched.enable ? "定时开启" : "定时关闭",
    badgeType: sched.enable ? "ok" : "neutral",
    sections,
    commands: SETTING_COMMANDS,
    tip: "更多配置（好友备注、消息模板、推送目标）请用 <span class=\"hl\">#抖音web</span> 面板或锅巴插件。",
  }
}

export function settingsText(botId) {
  const data = buildSettingsData(botId)
  const lines = ["⚙️ 抖音续火设置", `机器人：${botName(botId)}`]
  for (const sec of data.sections) {
    lines.push(`──── ${sec.name} ────`)
    for (const row of sec.rows) lines.push(`${row.k}：${row.v}`)
  }
  lines.push("──── 可用指令 ────")
  // 文字版里 <b> 标签要去掉，否则原样发给用户
  for (const it of data.commands) lines.push(`${it.cmd} — ${it.txt.replace(/<\/?b>/g, "")}`)
  lines.push("", "更多配置请用「#抖音web」或锅巴插件。")
  return lines.join("\n")
}

// ────────────────────────────── 帮助面板 ──────────────────────────────

/**
 * 指令清单。图片与文字版共用，新增指令只改这里一处。
 * `txt` 里允许 `<b>` 强调，文字版会自动剥掉标签。
 */
const HELP_GROUPS = [
  {
    name: "面板",
    right: "仅主人",
    items: [
      { cmd: "#抖音web", txt: "获取面板链接，验证码<b>私信</b>发送" },
      { cmd: "#抖音web下线", txt: "立即作废自己的验证码与会话" },
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
      { cmd: "#抖音更新", txt: "拉取插件最新代码（配置会保留）" },
      { cmd: "#抖音强制更新", txt: "丢弃本地改动后更新" },
    ],
  },
]

export function buildHelpData(botId) {
  return {
    saveId: "help",
    icon: "🔥",
    title: "抖音续火插件",
    subtitle: `v${version()} · 定时续火 · 可视化发信 · 多机器人隔离`,
    badge: `${HELP_GROUPS.reduce((n, g) => n + g.items.length, 0)} 条指令`,
    badgeType: "neutral",
    groups: HELP_GROUPS,
    tip:
      "好友改名是断火最常见的原因：把新昵称用 <span class=\"hl\">新名=旧名</span> 加进别名，" +
      "续火时主名搜不到会自动试别名，命中后把新名提为主名，下次直接用新名搜。",
  }
}

export function helpText() {
  const lines = ["🔥 抖音续火插件指令", ""]
  for (const g of HELP_GROUPS) {
    lines.push(`【${g.name}】`)
    for (const it of g.items) lines.push(`${it.cmd} — ${it.txt.replace(/<\/?b>/g, "")}`)
    lines.push("")
  }
  lines.push("好友改名后用「#抖音加好友 账号名 新名=旧名」把别名补上，续火会自动认新名。")
  return lines.join("\n")
}
