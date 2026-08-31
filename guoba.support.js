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
 * 锅巴配置支持（锅巴会自动扫描 plugins/<name>/guoba.support.js）
 *
 * 复用而非另起一套：读写都走 lib/config.js 的同一个 Config 单例，
 * 所以锅巴、Web 面板、#抖音设置 三处改的是同一份 config/config.yaml，
 * 保存后顺手 reschedule()，改完 cron 不用重启。
 *
 * 账号那一节是个例外：Cookie 与续火好友不在 config.yaml 里（在
 * data/accounts/<botId>.json，且 Cookie 是加密的），所以它不走上面那条
 * 扁平点路径的通道，而是像 pushGroups 一样单独映射到 lib/store.js。
 */

const PH = PLACEHOLDERS.map(p => `{{${p}}}`).join(" ")

/** 推送目标：yaml 里允许写字符串，锅巴表单统一成 { botId, xxxId } 结构 */
function targetsToForm(list, field) {
  return (list || [])
    .map(item =>
      typeof item === "object" && item
        ? { botId: String(item.botId ?? "").trim(), [field]: String(item[field] ?? item.id ?? "").trim() }
        : { botId: "", [field]: String(item ?? "").trim() }
    )
    .filter(item => item[field])
}

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
 * 上一次交给锅巴的账号 id 集合。
 *
 * 子表单里删掉一张卡片，前端只是把它从数组里去掉，保存时我们收到的是「少了一行」，
 * 光看提交内容分不清「用户删了它」和「它是保存期间新登录进来的」。所以记下发出去
 * 那一刻的快照：只有当时就在列表里、如今不在提交里的账号才算被删。
 * 快照之后扫码登录新增的账号不在集合里，不会被误删。
 */
let lastAccountIds = new Set()

/** Cookie 现状的一句话，只读展示。密文与明文都不出现在这里 */
function describeCookie(acc) {
  if (!acc.hasCookie) return "未配置，请在下方粘贴 Cookie"
  if (acc.cookieInvalid) return "已失效，请重新粘贴 Cookie 或扫码登录"
  const at = acc.cookieUpdatedAt ? `，更新于 ${formatTime(acc.cookieUpdatedAt)}` : ""
  return `已配置${at}`
}

/**
 * 把所有机器人下的账号摊平成锅巴子表单的行。
 *
 * Cookie 一律不回填（`cookie: ""`）：它等同于账号本体，锅巴面板是浏览器里的页面，
 * 回填就意味着密文会随接口发到前端。留空同时也是「不修改」的语义，
 * 用户只想改续火好友时不必重新粘一遍 Cookie。
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
 * 保存账号子表单。
 *
 * 分两趟：先把所有行校验完（账号名、归属机器人、Cookie 格式、模板占位符），
 * 再统一落盘。一趟边校验边写的话，第三行的 Cookie 格式错误会留下前两行已改、
 * 后面全没改的半截状态，而锅巴只会显示一句报错。
 *
 * @returns {string[]} 给用户看的结果摘要
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
      // 格式错误在这里就报出来，不要等写盘时才发现
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
    // 先写普通字段（含改名），再导 Cookie。顺序反过来的话，改名行会因为
    // manualLogin 按新名字找不到账号而多建一个
    const account = store.upsert(plan.botId, plan.input)
    if (plan.cookie) {
      // 走 manualLogin 而不是直接 store.upsert：allowManualCookie 开关与审计都在它里面
      manualLogin(plan.botId, { name: account.name, cookie: plan.cookie, source: "guoba" })
      summary.push(`${account.name} 的 Cookie 已更新`)
    }
  }

  // 打开面板时在列表里、这次提交没带回来的，就是被用户删掉的卡片
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
      ],

      /** 锅巴打开面板时读：直接给当前生效的配置（默认值已合并过） */
      getConfigData() {
        const data = config.reload()
        return {
          ...lodash.cloneDeep(data),
          pushGroups: targetsToForm(data.push?.groups, "groupId"),
          pushFriends: targetsToForm(data.push?.friends, "userId"),
          accounts: accountsToForm(),
        }
      },

      /** 锅巴点确定时写：扁平点路径重新嵌套，落盘后立刻换定时表 */
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

          // 推送范围写错会导致「配了目标却完全不推」，比报错更难查，所以拦在保存前
          if (entries["push.target"] !== undefined && !PUSH_TARGETS.includes(String(entries["push.target"])))
            return Result.error(`推送范围只能是 ${PUSH_TARGETS.join(" / ")}`)

          if (entries["spark.minGapMs"] !== undefined && entries["spark.maxGapMs"] !== undefined) {
            const min = Number(entries["spark.minGapMs"])
            const max = Number(entries["spark.maxGapMs"])
            if (min > max) return Result.error("好友间隔最小值不能大于最大值")
          }

          // 写错的 {{xxx}} 在这里拦住，不然会原样发给好友
          if (entries["spark.messageTemplate"])
            normalizeTemplate(entries["spark.messageTemplate"], "全局消息模板")

          // 账号先落盘：它有可能因为 Cookie 格式不对而整体失败，
          // 放在 config.setMany 之前，失败时配置也保持原样，用户重来一次就行。
          // 锅巴的 handleFormValues 会把空数组整个丢掉，所以「删光了所有账号」到这里
          // 是 data.accounts === undefined，必须当成空列表处理，否则最后一个账号删不掉
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
