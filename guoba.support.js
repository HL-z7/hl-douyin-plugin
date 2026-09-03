import lodash from "lodash"
import { config, DEFAULT_CONFIG, PUSH_TARGETS } from "./lib/config.js"
import { scheduler } from "./lib/scheduler.js"
import { PLACEHOLDERS, normalizeTemplate } from "./lib/template.js"
import { store, normalizeTargets, targetText, parseCookieInput, assertLoginCookie } from "./lib/store.js"
import { manualLogin } from "./lib/login.js"
import { pickDefaultBot } from "./lib/bot.js"
import { audit } from "./lib/audit.js"
import { log, toError, formatTime } from "./lib/util.js"

/**
 * 锅巴配置支持：把插件配置暴露给锅巴（Guoba-Plugin）面板。
 *
 * 锅巴自动扫描 plugins/<name>/guoba.support.js 并调用本文件导出的 supportGuoba()，
 * 用其中的 configInfo.schemas 生成表单，打开面板时调 getConfigData()，点确定时调
 * setConfigData(data, { Result })。
 *
 * 表单字段分两条通道落盘：
 * 1. 扁平点路径 —— schemas 里的 field 直接写成 `spark.cron` 这类点路径，读写都走
 *    lib/config.js 的同一个 Config 单例。锅巴、Web 面板、#抖音设置 三处改的是同一份
 *    config/config.yaml，任一处保存后另两处立即读到新值。保存后调 scheduler.reschedule()，
 *    改 cron 无需重启。
 * 2. 单独映射 —— pushGroups / pushFriends / accounts 三个 field 不是配置路径：前两个由
 *    targetsToForm / formToTargets 在表单结构与 push.groups / push.friends 之间转换；
 *    账号数据在 data/accounts/<botId>.json（且 Cookie 加密），由 accountsToForm /
 *    saveAccounts 映射到 lib/store.js。
 *
 * 对外导出：`supportGuoba()`，锅巴约定的唯一入口。
 *
 * 依赖 lib/config.js、lib/scheduler.js、lib/template.js、lib/store.js、lib/login.js、
 * lib/bot.js、lib/audit.js、lib/util.js 与 lodash。
 */

/** 可用占位符提示串，形如 `{{friend}} {{date}} ...`，拼进多处 bottomHelpMessage */
const PH = PLACEHOLDERS.map(p => `{{${p}}}`).join(" ")

/**
 * push.groups / push.friends → 锅巴子表单行。
 * 手写 yaml 时允许直接写群号字符串，而 GSubForm 只认对象，故统一成 { botId, [field] }。
 *
 * @param {Array} list 配置里的原始列表，元素可为对象或纯 id 字符串
 * @param {"groupId"|"userId"} field 目标 id 在表单里的字段名
 * @returns {Array<object>} id 为空的行被过滤掉
 */
function targetsToForm(list, field) {
  return (list || [])
    .map(item =>
      typeof item === "object" && item
        ? { botId: String(item.botId ?? "").trim(), [field]: String(item[field] ?? item.id ?? "").trim() }
        : { botId: "", [field]: String(item ?? "").trim() }
    )
    .filter(item => item[field])
}

/**
 * 锅巴子表单行 → push.groups / push.friends。
 * @param {Array} list 表单提交的行
 * @param {"groupId"|"userId"} field
 * @returns {Array<object>} id 为空的行被过滤掉
 */
function formToTargets(list, field) {
  return (list || [])
    .map(item => ({
      botId: String(item?.botId ?? "").trim(),
      [field]: String(item?.[field] ?? "").trim(),
    }))
    .filter(item => item[field])
}

// ────────────────────────────── 账号子表单 ──────────────────────────────

/**
 * 上一次交给锅巴的账号 id 集合，元素形如 `${botId}:${accountId}`。
 *
 * 子表单删掉一张卡片时，前端只是把它从数组里移除，提交内容里表现为「少了一行」，
 * 无法区分「用户删除了它」与「它是本次打开面板之后新登录进来的」。因此在
 * accountsToForm() 发出数据的那一刻记录快照：只有当时就在列表里、而本次提交没带回来的
 * 账号才判定为删除。快照之后新增的账号不在集合里，不会被误删。
 */
let lastAccountIds = new Set()

/**
 * Cookie 现状的一句话描述，只读展示。密文与明文都不出现在返回值里。
 * @param {object} acc store.list() 给出的账号视图（含 hasCookie / cookieInvalid）
 * @returns {string}
 */
function describeCookie(acc) {
  if (!acc.hasCookie) return "未配置，请在下方粘贴 Cookie"
  if (acc.cookieInvalid) return "已失效，请重新粘贴 Cookie 或扫码登录"
  const at = acc.cookieUpdatedAt ? `，更新于 ${formatTime(acc.cookieUpdatedAt)}` : ""
  return `已配置${at}`
}

/**
 * 把所有机器人下的账号摊平成锅巴子表单的行，同时刷新 lastAccountIds 快照。
 *
 * Cookie 一律不回填（`cookie: ""`）：它等同于账号本体，而锅巴面板是浏览器里的页面，
 * 回填意味着密文随接口发到前端。留空同时也是「不修改」的语义，用户只改续火好友时
 * 不必重新粘贴 Cookie。
 *
 * @returns {Array<object>} 每行含 botId / id / name / enable / cookieState / cookie /
 *   targets（targetText 顿号连接）/ messageTemplate / note
 */
function accountsToForm() {
  const rows = []
  const ids = new Set()
  for (const botId of store.allBots())
    for (const acc of store.list(botId)) {
      ids.add(`${botId}:${acc.id}`)
      rows.push({
        botId: String(botId),
        id: acc.id,
        name: acc.name,
        enable: acc.enable !== false,
        cookieState: describeCookie(acc),
        cookie: "",
        targets: (acc.targets || []).map(targetText).join("、"),
        messageTemplate: acc.messageTemplate || "",
        note: acc.note || "",
      })
    }
  lastAccountIds = ids
  return rows
}

/**
 * 保存账号子表单：校验全部行 → 逐行落盘 → 按快照差集删除被移除的账号。
 *
 * 分两趟执行。第一趟只校验并生成 plans（账号名、归属机器人、Cookie 格式、模板占位符），
 * 第二趟才写盘。若边校验边写，第三行的 Cookie 格式错误会留下「前两行已改、其余未改」的
 * 半截状态，而锅巴只会展示一句报错，用户无从判断哪些改动生效了。
 *
 * @param {Array<object>} rows 锅巴提交的账号行；调用方需把 undefined 归一成 []
 * @returns {string[]} 给用户看的结果摘要（Cookie 更新与账号删除各一条）
 * @throws {Error} 账号名为空、同一机器人下重名、无归属机器人、手动导入 Cookie 开关关闭、
 *   Cookie 格式非法、消息模板占位符非法
 */
function saveAccounts(rows) {
  const fallbackBot = pickDefaultBot()
  const plans = []
  const seen = new Set()
  const kept = new Set()
  const allowCookie = config.bool("security.allowManualCookie", true)

  for (const row of rows || []) {
    const name = String(row?.name ?? "").trim()
    if (!name) throw new Error("账号名称不能为空")

    const botId = String(row?.botId ?? "").trim() || fallbackBot
    if (!botId)
      throw new Error(`账号「${name}」没有归属机器人：当前没有在线的机器人，请在「机器人QQ号」里手动填写`)

    // 同一台机器人下账号名唯一（store.upsert 把同名视为更新，重名行会互相覆盖）
    const key = `${botId}:${name}`
    if (seen.has(key)) throw new Error(`机器人 ${botId} 下有两行都叫「${name}」，请改名或删掉一行`)
    seen.add(key)

    // id 只在该机器人下确实存在时才认：改了「机器人QQ号」的行等于搬到新机器人下新建
    const id = String(row?.id ?? "").trim()
    const existing = id && store.get(botId, id) ? id : ""
    if (existing) kept.add(`${botId}:${existing}`)

    const cookie = String(row?.cookie ?? "").trim()
    if (cookie) {
      if (!allowCookie)
        throw new Error("「允许手动导入 Cookie」当前是关闭的，请先打开该开关并保存，再回来粘贴 Cookie")
      // 格式校验提前到写盘之前，避免落盘阶段才发现非法 Cookie 而留下半截状态
      assertLoginCookie(parseCookieInput(cookie))
    }

    plans.push({
      botId,
      cookie,
      input: {
        id: existing || undefined,
        name,
        enable: row?.enable !== false,
        targets: normalizeTargets(row?.targets),
        messageTemplate: normalizeTemplate(row?.messageTemplate, `账号「${name}」的消息模板`),
        note: String(row?.note ?? ""),
      },
    })
  }

  const summary = []
  for (const plan of plans) {
    // 先写普通字段（含改名）再导 Cookie：顺序颠倒时，改名行会因 manualLogin 按新名字
    // 找不到账号而额外新建一个（store.upsert 无 id 时按 name 定位）
    const account = store.upsert(plan.botId, plan.input)
    if (plan.cookie) {
      // 走 manualLogin 而非直接 store.upsert：allowManualCookie 开关判定与审计记录都在其中
      manualLogin(plan.botId, { name: account.name, cookie: plan.cookie, source: "guoba" })
      summary.push(`${account.name} 的 Cookie 已更新`)
    }
  }

  // 快照差集：打开面板时在列表里、本次提交没带回来的行，即用户删除的卡片
  for (const key of lastAccountIds) {
    if (kept.has(key)) continue
    const [botId, accountId] = key.split(":")
    const acc = store.get(botId, accountId)
    if (!acc) continue
    store.remove(botId, accountId)
    audit.add("account.remove", { botId, accountId, account: acc.name, source: "guoba" })
    summary.push(`已删除 ${acc.name} 及其 Cookie`)
  }
  lastAccountIds = kept

  return summary
}

/**
 * 锅巴约定的入口，返回插件信息与配置表单定义。
 *
 * configInfo.schemas 里的 field 即落盘位置：`spark.*`、`push.*`、`web.*`、`chat.*`、
 * `security.*`、`render.*`、`update.*`、`debug.*` 为 config/config.yaml 的点路径；
 * `accounts`、`pushGroups`、`pushFriends` 三个不是配置路径，由 setConfigData 单独映射。
 *
 * @returns {{pluginInfo: object, configInfo: object}}
 */
export function supportGuoba() {
  return {
    pluginInfo: {
      name: "hl-douyin-plugin",
      title: "抖音续火",
      description: "抖音自动续火：定时续火、结果推群、Web 可视化发信、扫码/手动登录，多机器人隔离",
      author: "huli",
      isV3: true,
      isV2: false,
      showInMenu: "auto",
      icon: "mdi:fire",
      iconColor: "#fe2c55",
    },

    configInfo: {
      schemas: [
        // 账号：不落 config.yaml，由 accountsToForm / saveAccounts 映射到 data/accounts/<botId>.json
        { component: "Divider", label: "抖音账号与 Cookie" },
        {
          field: "accounts",
          label: "抖音账号",
          bottomHelpMessage:
            "点进去可增删账号、粘贴 Cookie、配续火好友。多账号就多加几行，定时续火会逐个跑（串行，避免同时开多个浏览器触发风控）。删掉卡片并保存即删除该账号与它的 Cookie。Cookie 加密存在 data/accounts/<机器人QQ>.json，这里永远不回填，留空表示不修改",
          component: "GSubForm",
          componentProps: {
            multiple: true,
            modalProps: { title: "抖音账号" },
            schemas: [
              {
                field: "name",
                label: "账号名称",
                bottomHelpMessage: "自己起的名字，用于指令与推送里指代这个账号。同一机器人下不能重名",
                component: "Input",
                required: true,
              },
              {
                field: "botId",
                label: "机器人QQ号",
                bottomHelpMessage:
                  "这个抖音账号归哪台机器人管。留空 = 当前在线的第一台。改了这里等于把账号搬到另一台机器人下",
                component: "Input",
              },
              {
                field: "id",
                label: "账号ID",
                bottomHelpMessage:
                  "只读，保存时自动生成。改账号名时靠它认出改的是哪一个，清空会当成新账号",
                component: "Input",
                componentProps: { disabled: true },
              },
              {
                field: "cookieState",
                label: "Cookie 现状",
                bottomHelpMessage: "只读。想换 Cookie 请填下面那一栏",
                component: "Input",
                componentProps: { disabled: true },
              },
              {
                field: "cookie",
                label: "粘贴 Cookie",
                bottomHelpMessage:
                  "浏览器登录抖音 → F12 → Console → document.cookie → 复制结果。也吃 EditThisCookie 导出的 JSON。留空 = 不修改。必须含 sessionid，否则保存时会被拒绝",
                component: "InputTextArea",
                componentProps: { rows: 3, placeholder: "sessionid=xxx; sessionid_ss=xxx; ..." },
              },
              {
                field: "targets",
                label: "续火好友",
                bottomHelpMessage:
                  "顿号分隔多个。每个可写 主名=别名1=别名2(备注)，好友改名后用别名也能搜到，命中别名会自动把它提为主名",
                component: "InputTextArea",
                componentProps: { rows: 2, placeholder: "张三=小三三(表妹)、李四" },
              },
              {
                field: "messageTemplate",
                label: "该账号的消息模板",
                bottomHelpMessage: `留空则用全局模板。可用占位符：${PH}`,
                component: "InputTextArea",
                componentProps: { rows: 2 },
              },
              {
                field: "enable",
                label: "启用",
                bottomHelpMessage: "关掉后定时续火跳过这个账号，账号与 Cookie 都保留",
                component: "Switch",
              },
              {
                field: "note",
                label: "备注",
                bottomHelpMessage: "只给自己看，不参与任何逻辑",
                component: "Input",
              },
            ],
          },
        },

        // 以下各节的 field 均为 config.yaml 的点路径，落盘位置见 lib/config.js 的 DEFAULT_CONFIG
        { component: "Divider", label: "定时续火" },
        {
          field: "spark.enable",
          label: "启用定时续火",
          bottomHelpMessage: "关闭后定时任务立即注销，#抖音续火 手动执行也会被拒绝",
          component: "Switch",
        },
        {
          field: "spark.cron",
          label: "定时表达式",
          bottomHelpMessage: "6 位 cron，秒在最前。默认 0 20 8 * * * 表示每天 08:20:00。保存后立即生效，无需重启",
          component: "EasyCron",
          componentProps: { placeholder: "0 20 8 * * *" },
        },
        {
          field: "spark.skipIfDone",
          label: "跳过今日已续火的账号",
          bottomHelpMessage:
            "定时任务遇到今天已成功续过火的账号直接跳过（按上海时区算日期）。抖音火花一天只认一次，重复发纯属多余的风控风险。手动 #抖音续火 不受此项限制，#抖音续火 跳过 才走这套判定",
          component: "Switch",
        },
        {
          field: "spark.messageTemplate",
          label: "全局消息模板",
          bottomHelpMessage: `留空则随机发一言。可用占位符：${PH}。账号可单独设置模板覆盖此项`,
          component: "InputTextArea",
          componentProps: { rows: 3, placeholder: "{{friend}} 早上好，今天是 {{date}} {{weekday}}\n{{yiyan}}" },
        },
        {
          field: "spark.yiyanIncludeSource",
          label: "一言带出处",
          bottomHelpMessage: '开启后消息末尾附带 ——「出处」',
          component: "Switch",
        },
        {
          field: "spark.minGapMs",
          label: "好友间隔最小值(ms)",
          bottomHelpMessage: "相邻两个好友之间的随机等待下限，太快容易触发抖音风控",
          component: "InputNumber",
          componentProps: { min: 0, max: 120000 },
        },
        {
          field: "spark.maxGapMs",
          label: "好友间隔最大值(ms)",
          component: "InputNumber",
          componentProps: { min: 0, max: 120000 },
        },
        {
          field: "spark.searchRetry",
          label: "好友搜索重试次数",
          bottomHelpMessage: "搜不到才判定为「好友改名或已删除」",
          component: "InputNumber",
          componentProps: { min: 1, max: 10 },
        },
        {
          field: "spark.accountTimeoutMs",
          label: "单账号超时(ms)",
          bottomHelpMessage: "浏览器卡死时的兜底放弃时间，默认 300000（5 分钟）",
          component: "InputNumber",
          componentProps: { min: 30000, max: 1800000 },
        },
        {
          field: "spark.headless",
          label: "无头模式",
          bottomHelpMessage: "关闭后会弹出浏览器窗口，只在本机调试选择器时用",
          component: "Switch",
        },
        {
          field: "spark.browserPath",
          label: "自定义浏览器路径",
          bottomHelpMessage: "留空则用 Yunzai 的 chromium_path 或 puppeteer 自带 Chromium",
          component: "Input",
          componentProps: { placeholder: "C:/Program Files/Google/Chrome/Application/chrome.exe" },
        },
        {
          field: "spark.screenshotOnFail",
          label: "失败时截图",
          bottomHelpMessage: "截图存在 data/screenshots，排查选择器失效时有用（不会自动清理）",
          component: "Switch",
        },
        {
          field: "spark.blockResources",
          label: "拦截图片/字体/媒体请求",
          bottomHelpMessage:
            "一次聊天页加载会发出几百个资源请求，绝大部分是视频封面和字体。拦掉后单次续火对抖音的请求量下降一个量级，页面也快得多。样式表不拦——缺样式会让元素塌成 0×0 被判定为不可见",
          component: "Switch",
        },
        {
          field: "spark.blockTracking",
          label: "拦截埋点与推荐流接口",
          bottomHelpMessage: "额外拦掉 app_log、slardar、推荐流等与续火无关的接口，减少行为特征暴露",
          component: "Switch",
        },
        {
          field: "spark.cookieCheckTTL",
          label: "Cookie 检查结果缓存(分钟)",
          bottomHelpMessage:
            "检查一次要真开浏览器访问抖音。这段时间内重复检查直接复用上次结论，避免面板连点几下就发出好几轮请求。0 = 不缓存",
          component: "InputNumber",
          componentProps: { min: 0, max: 1440 },
        },

        {
          field: "spark.browserIdleClose",
          label: "浏览器空闲多久关闭(秒)",
          bottomHelpMessage:
            "页面全关完之后延时收掉浏览器实例，释放那 200~400MB 内存。给 60 秒是为了跨过续火在两个账号之间的间隔（页面刚关但马上要再开），不至于每个账号都重启一次浏览器。0 = 一直留着",
          component: "InputNumber",
          componentProps: { min: 0, max: 3600 },
        },

        // push.*；其中 pushGroups / pushFriends 是表单专用字段，落盘为 push.groups / push.friends
        { component: "Divider", label: "结果推送" },
        {
          field: "push.enable",
          label: "启用推送",
          bottomHelpMessage: "定时续火跑完后把结果发到下面配置的群/好友",
          component: "Switch",
        },
        {
          field: "push.mode",
          label: "推送内容",
          component: "Select",
          componentProps: {
            options: [
              { label: "详细（逐条列出发给谁、发了什么）", value: "detail" },
              { label: "简要（只报成功失败数）", value: "summary" },
            ],
          },
        },
        {
          field: "push.onlyOnFail",
          label: "仅失败时推送",
          bottomHelpMessage: "开启后一切正常的日子保持静默，只有续火失败才发消息",
          component: "Switch",
        },
        {
          field: "push.target",
          label: "推送范围",
          bottomHelpMessage:
            "选「仅群」时下面的好友列表不会收到，反之同理。列表配好了但范围选错是最常见的「怎么没推送」原因",
          component: "Select",
          componentProps: {
            options: [
              { label: "群 + 私聊（都推）", value: "both" },
              { label: "仅群", value: "group" },
              { label: "仅私聊", value: "friend" },
            ],
          },
        },
        {
          field: "pushGroups",
          label: "推送群",
          bottomHelpMessage: "可配多个群，也可跨机器人。机器人QQ留空 = 用执行续火的那个机器人发",
          component: "GSubForm",
          componentProps: {
            multiple: true,
            schemas: [
              { field: "botId", label: "机器人QQ号（可留空）", component: "Input" },
              { field: "groupId", label: "群号", component: "Input", required: true },
            ],
          },
        },
        {
          field: "pushFriends",
          label: "推送好友（私聊）",
          bottomHelpMessage: "私聊接收结果，通常填主人QQ",
          component: "GSubForm",
          componentProps: {
            multiple: true,
            schemas: [
              { field: "botId", label: "机器人QQ号（可留空）", component: "Input" },
              { field: "userId", label: "QQ号", component: "Input", required: true },
            ],
          },
        },

        { component: "Divider", label: "Web 面板" },
        {
          field: "web.enable",
          label: "启用 Web 面板",
          bottomHelpMessage: "关闭后 #抖音web 直接提示未启用（已注册的路由需重启才移除）",
          component: "Switch",
        },
        {
          field: "web.base",
          label: "挂载路径",
          bottomHelpMessage: "只支持一段，如 /douyin。修改后需重启 Yunzai 才会换路由",
          component: "Input",
          componentProps: { placeholder: "/douyin" },
        },
        {
          field: "web.port",
          label: "独立端口",
          bottomHelpMessage: "0 = 复用 Yunzai 自身端口（推荐）。填端口号则额外起一个服务，改动需重启",
          component: "InputNumber",
          componentProps: { min: 0, max: 65535 },
        },
        {
          field: "web.url",
          label: "对外访问地址",
          bottomHelpMessage: "含协议与端口、不含挂载路径。留空自动用 Yunzai 的 url 配置。反代到公网时填这里",
          component: "Input",
          componentProps: { placeholder: "https://example.com" },
        },
        {
          field: "web.codeTTL",
          label: "验证码有效期(秒)",
          bottomHelpMessage: "#抖音web 私信发出的临时验证码存活时间，越短越安全，默认 300",
          component: "InputNumber",
          componentProps: { min: 30, max: 3600 },
        },
        {
          field: "web.sessionTTL",
          label: "会话有效期(秒)",
          bottomHelpMessage: "验证成功后面板保持登录的时间，默认 1800",
          component: "InputNumber",
          componentProps: { min: 60, max: 86400 },
        },
        {
          field: "web.maxCodeAttempts",
          label: "验证码可错次数",
          component: "InputNumber",
          componentProps: { min: 1, max: 20 },
        },
        {
          field: "web.rateWindow",
          label: "限流窗口(秒)",
          component: "InputNumber",
          componentProps: { min: 5, max: 3600 },
        },
        {
          field: "web.rateGeneral",
          label: "窗口内普通请求配额",
          component: "InputNumber",
          componentProps: { min: 10, max: 100000 },
        },
        {
          field: "web.rateAuth",
          label: "窗口内验证码提交配额",
          bottomHelpMessage: "单独一个桶，防止爆破验证码。默认 8",
          component: "InputNumber",
          componentProps: { min: 1, max: 100 },
        },
        {
          field: "web.banAfter",
          label: "拉黑阈值",
          bottomHelpMessage: "同一 IP 鉴权失败累计到此值后永久拉黑（重启或 #抖音设置 解封IP 清空）",
          component: "InputNumber",
          componentProps: { min: 1, max: 1000 },
        },
        {
          field: "web.auditKeep",
          label: "审计日志保留条数",
          component: "InputNumber",
          componentProps: { min: 50, max: 10000 },
        },
        {
          field: "web.maskLinkInGroup",
          label: "群内回复链接打码",
          bottomHelpMessage:
            "开启后群里那条回复只显示 http://***.45:2536/douyin/ 这样的打码地址（完整地址私信已发）。" +
            "公网 IP 直连的强烈建议保持开启：群里贴一次原样地址等于把机器交给全部群成员扫端口。用域名 + HTTPS 的可以关掉",
          component: "Switch",
        },

        { component: "Divider", label: "聊天界面" },
        {
          field: "chat.enable",
          label: "启用聊天界面",
          bottomHelpMessage:
            "面板上点账号即可进入该号的私信会话、看历史、发消息。" +
            "关掉后入口消失、接口一律拒绝。注意它会为该账号挂着一个浏览器页面（比一天一次的续火暴露面更大）",
          component: "Switch",
        },
        {
          field: "chat.idleCloseSec",
          label: "无人时自动关闭(秒)",
          bottomHelpMessage:
            "多久没人拉新消息就收掉聊天页并释放账号锁，默认 180。" +
            "用户关掉网页不会通知服务端，只能靠这个兜底，否则那 200~400MB 内存要占到重启",
          component: "InputNumber",
          componentProps: { min: 30, max: 3600 },
        },
        {
          field: "chat.pollMs",
          label: "拉新消息间隔(毫秒)",
          bottomHelpMessage: "默认 3000。只是本地读一遍页面，不向抖音发请求，所以可以比续火激进",
          component: "InputNumber",
          componentProps: { min: 1000, max: 30000 },
        },
        {
          field: "chat.historyLimit",
          label: "进会话时给几条历史",
          bottomHelpMessage: "默认 60。往上翻页每次再给 40 条",
          component: "InputNumber",
          componentProps: { min: 10, max: 500 },
        },
        {
          field: "chat.maxLength",
          label: "单条消息字数上限",
          bottomHelpMessage: "默认 500。抖音自己的限制更宽，这里只是挡住误粘一整篇文章",
          component: "InputNumber",
          componentProps: { min: 1, max: 5000 },
        },

        { component: "Divider", label: "安全" },
        {
          field: "security.allowManualCookie",
          label: "允许手动导入 Cookie",
          bottomHelpMessage: "关闭后只能扫码登录，#抖音手动登录 与面板的粘贴框都会被拒绝",
          component: "Switch",
        },
        {
          field: "security.maskCookie",
          label: "接口返回打码 Cookie",
          bottomHelpMessage: "建议保持开启。Cookie 始终以 AES-256-GCM 加密落盘，密钥在 data/secret.key",
          component: "Switch",
        },
        {
          field: "security.qrLoginTimeout",
          label: "扫码等待上限(秒)",
          component: "InputNumber",
          componentProps: { min: 30, max: 600 },
        },
        {
          field: "security.deleteCookieFile",
          label: "收到 Cookie 文件后立即删除",
          bottomHelpMessage:
            "#抖音文件登录 收到的 txt 会先下载到 data/tmp 再解析。Cookie 明文不该留在磁盘上，建议保持开启",
          component: "Switch",
        },
        {
          field: "security.remoteVerify",
          label: "抖音要验证时开远程操作页面",
          bottomHelpMessage:
            "扫码后抖音有时会追加身份验证（短信/滑块），无头浏览器里没人能点。开启后会私信给发起人一个临时链接，" +
            "在里面看着那台浏览器的画面直接点/拖/打字把验证过掉。链接只能操作这一次登录，进不了本面板。关闭则退回「报失败 + 给替代方案」",
          component: "Switch",
        },
        {
          field: "security.autoSms",
          label: "自己接管短信验证",
          bottomHelpMessage:
            "抖音要求短信验证时，由插件自己在页面上点「接收短信验证码 → 发送验证码」，再私信跟你要那几位数字，收到后自动填回提交，不用点开任何链接。" +
            "默认关：它会真往你绑定的手机发一条短信。只想临时用一次的话直接发「#抖音自动登录」（那条指令不看这个开关）；这里打开则「#抖音登录」也一并走这条路。" +
            "只对短信验证有效，滑块/拼图仍走上面的远程操作页面",
          component: "Switch",
        },
        {
          field: "security.verifyTimeout",
          label: "验证等待上限(秒)",
          bottomHelpMessage: "进入验证态后整体延到这个时长。人要收短信、点链接、在页面上操作，别调太短",
          component: "InputNumber",
          componentProps: { min: 120, max: 3600 },
        },
        {
          field: "security.verifyBindIp",
          label: "验证链接绑定 IP",
          bottomHelpMessage:
            "链接被转发到别的机器就失效，建议保持开启。手机在 4G 与 WiFi 之间切换会换 IP，真被它挡住时再关",
          component: "Switch",
        },

        { component: "Divider", label: "图片渲染" },
        {
          field: "render.image",
          label: "文本渲染成图片",
          bottomHelpMessage: "关闭后 #抖音帮助 / #抖音设置 / #抖音状态 都发纯文字。渲染失败也会自动降级成文字",
          component: "Switch",
        },
        {
          field: "render.scale",
          label: "渲染倍率",
          bottomHelpMessage: "1 = 620px 宽。屏幕小可以调到 1.2 让字更大；超过 2 图片体积暴涨且容易发送失败",
          component: "InputNumber",
          componentProps: { min: 0.6, max: 2, step: 0.1 },
        },

        { component: "Divider", label: "插件更新" },
        {
          field: "update.autoRestart",
          label: "更新后自动重启",
          bottomHelpMessage: "关闭则需手动重启 Yunzai 新代码才生效",
          component: "Switch",
        },
        {
          field: "update.logLimit",
          label: "更新日志条数",
          bottomHelpMessage: "#抖音更新 后以合并转发展示的 commit 上限",
          component: "InputNumber",
          componentProps: { min: 1, max: 100 },
        },

        { component: "Divider", label: "排查（默认全关）" },
        {
          field: "debug.enable",
          label: "调试日志",
          bottomHelpMessage:
            "打开后扫码登录与续火的每一步都在 Yunzai 日志里记一行（带 [调试] 前缀）：页面打开结果、等的元素出没出现、" +
            "拦到的接口与状态码、每轮验证探测的结论、状态流转。登录/续火卡住时先开它再跑一次就知道停在哪一步了。" +
            "Cookie 的值不会进日志。平时关掉——它会让日志量成倍增长",
          component: "Switch",
        },
        {
          field: "debug.snapshot",
          label: "现场快照（截图 + 页面原文）",
          bottomHelpMessage:
            "需要先打开上面的「调试日志」。关键步骤把整页截图、页面纯文本、完整 HTML 存到 data/debug/，" +
            "抖音改版导致选择器失效时唯一有用的东西。单页 HTML 常有一兆多，按下面的上限滚动清理",
          component: "Switch",
        },
        {
          field: "debug.keep",
          label: "快照保留文件数",
          bottomHelpMessage: "data/debug/ 里最多留多少个文件，超出按时间删最旧的。0 = 不清理（会一直涨）",
          component: "InputNumber",
          componentProps: { min: 0, max: 5000 },
        },
      ],

      /**
       * 锅巴打开面板时读取。
       * config.reload() 重新读盘以反映其它入口（Web 面板 / #抖音设置 / 手改文件）的改动，
       * 返回的是与默认值合并后的完整配置树，再补上三个表单专用字段。
       */
      getConfigData() {
        const data = config.reload()
        return {
          ...lodash.cloneDeep(data),
          pushGroups: targetsToForm(data.push?.groups, "groupId"),
          pushFriends: targetsToForm(data.push?.friends, "userId"),
          accounts: accountsToForm(),
        }
      },

      /**
       * 锅巴点确定时写入：扁平点路径重新嵌套 → 校验 → 账号落盘 → 配置落盘 → 重排定时表。
       *
       * 只接受 DEFAULT_CONFIG 里声明过的 `<section>.<key>`，未声明的键即使出现在提交里也不
       * 写入，避免表单结构变化时把陌生字段带进 config.yaml。
       *
       * @param {object} data 锅巴提交的扁平表单值
       * @param {{Result: object}} ctx 锅巴注入的结果构造器
       * @returns {object} Result.ok / Result.error
       */
      setConfigData(data, { Result }) {
        try {
          const patch = {}
          for (const [keyPath, value] of Object.entries(data || {})) {
            if (["pushGroups", "pushFriends", "accounts"].includes(keyPath)) continue
            lodash.set(patch, keyPath, value)
          }

          const entries = {}
          for (const section of Object.keys(DEFAULT_CONFIG))
            for (const key of Object.keys(DEFAULT_CONFIG[section])) {
              const value = lodash.get(patch, `${section}.${key}`)
              if (value !== undefined) entries[`${section}.${key}`] = value
            }

          // 两个子表单单独映射回 push.groups / push.friends
          if ("pushGroups" in data) entries["push.groups"] = formToTargets(data.pushGroups, "groupId")
          if ("pushFriends" in data) entries["push.friends"] = formToTargets(data.pushFriends, "userId")

          const cron = entries["spark.cron"]
          if (cron !== undefined && !String(cron).trim()) return Result.error("定时表达式不能为空")

          // 推送范围非法会表现为「配了目标却完全不推送」，比直接报错更难定位，故拦在保存前
          if (entries["push.target"] !== undefined && !PUSH_TARGETS.includes(String(entries["push.target"])))
            return Result.error(`推送范围只能是 ${PUSH_TARGETS.join(" / ")}`)

          if (entries["spark.minGapMs"] !== undefined && entries["spark.maxGapMs"] !== undefined) {
            const min = Number(entries["spark.minGapMs"])
            const max = Number(entries["spark.maxGapMs"])
            if (min > max) return Result.error("好友间隔最小值不能大于最大值")
          }

          // 非法 {{xxx}} 在此拦下，否则会原样发送给好友（normalizeTemplate 校验失败即抛）
          if (entries["spark.messageTemplate"])
            normalizeTemplate(entries["spark.messageTemplate"], "全局消息模板")

          // 账号先落盘：它可能因 Cookie 格式非法而整体抛出，放在 config.setMany 之前，
          // 失败时配置保持原样，用户修正后重试即可。
          // 锅巴 handleFormValues 会丢弃空数组字段，删光全部卡片时收到 undefined 而非 []，
          // 因此按 data.accounts || [] 处理；改用 "accounts" in data 判断会导致最后一个账号无法删除
          const accountNotes = saveAccounts(data?.accounts || [])

          config.setMany(entries)

          const job = scheduler.reschedule()
          if (config.get("spark.enable", true) !== false && !job)
            return Result.ok({}, `已保存，但 cron「${config.get("spark.cron")}」无效，定时任务未注册`)

          const status = scheduler.status()
          const tail = accountNotes.length ? `；${accountNotes.join("；")}` : ""
          return Result.ok(
            {},
            (status.registered ? `保存成功，下次续火 ${status.nextTime}` : "保存成功") + tail
          )
        } catch (error) {
          log("error", "锅巴保存配置失败：", toError(error).message)
          return Result.error(toError(error).message)
        }
      },
    },
  }
}
