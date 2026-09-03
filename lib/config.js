/**
 * 配置模型。
 *
 * 设计要点：
 * 1. 默认值全部写在代码里（DEFAULT_CONFIG），config/config.yaml 只保存用户改过的部分。
 *    插件升级新增字段时老配置不用手动补，也不必把带群号的示例配置提交进仓库。
 * 2. 对外只暴露一个 Config 单例。锅巴、Web 面板、`#抖音设置` 三处改的都是它，
 *    所以任意一处保存后另两处立刻看到最新值，不存在各自缓存不一致的问题。
 * 3. 读写统一走点路径（`config.get("web.codeTTL")`），与锅巴的扁平 field 命名对齐。
 */
import fs from "node:fs"
import path from "node:path"
import YAML from "yaml"
import { pluginRoot, ensureDir, deepMerge, getPath, setPath, log, toIdList } from "./util.js"

const configDir = ensureDir(pluginRoot, "config")
const configPath = path.join(configDir, "config.yaml")

/** push.target 的取值：推群 / 推私聊 / 两者都推 */
export const PUSH_TARGETS = ["group", "friend", "both"]

export const DEFAULT_CONFIG = {
  spark: {
    /** 总开关，关掉后定时任务注销，手动续火也会被拒绝 */
    enable: true,
    /** 6 位 cron，秒在最前，node-schedule 语法 */
    cron: "0 20 8 * * *",
    /**
     * 今天已经成功续过火就跳过定时任务。
     * 关掉它会在同一天重复发消息（抖音火花一天只认一次，重复发纯属多余风险）。
     * 手动 `#抖音续火` 不受此项限制，`#抖音续火 跳过` 才走这套判定。
     */
    skipIfDone: true,
    /** 无头运行；调试选择器时可临时关掉看浏览器窗口 */
    headless: true,
    /** 留空则用 Yunzai 的 chromium_path，再退到 puppeteer 自带 Chromium */
    browserPath: "",
    /** 消息模板，留空则发一言。占位符见 lib/template.js 的 PLACEHOLDERS */
    messageTemplate: "",
    /** 发一言时是否带出处 */
    yiyanIncludeSource: true,
    /** 相邻好友之间的随机间隔（毫秒），太快容易被抖音风控 */
    minGapMs: 2500,
    maxGapMs: 6000,
    /** 单个好友的搜索重试次数，全部候选名都搜不到才判定为「丢了」 */
    searchRetry: 3,
    /** 单账号整体超时（毫秒），浏览器卡死时兜底放弃 */
    accountTimeoutMs: 300000,
    /** 失败时把整页截图存到 data/screenshots，排查选择器失效用 */
    screenshotOnFail: true,
    /**
     * 拦截图片/字体/媒体等与续火无关的请求。
     * 一次聊天页加载会发出几百个资源请求，其中绝大部分是视频封面和字体；
     * 拦掉之后单次续火对抖音发出的请求量下降一个量级，页面也快得多。
     */
    blockResources: true,
    /** 除资源之外，额外拦掉推荐流/埋点这类明确用不到的接口 */
    blockTracking: true,
    /**
     * Cookie 有效性检查结果的缓存时长（分钟）。
     * 检查一次要真开一个浏览器访问抖音，频繁点「检查」既慢又是白给的风控风险，
     * 这段时间内重复检查直接复用上次结论。0 = 不缓存。
     */
    cookieCheckTTL: 30,
    /**
     * 会话（好友）列表的缓存时长（分钟）。
     *
     * 拉一次列表要开浏览器、进聊天页、等会话渲染完，好友多的号要等十几秒；而好友
     * 名单几天都不会变一次。所以默认缓存 4 小时，面板上打开发信卡片直接读缓存，
     * 只有点「重新拉取」才真去抖音要一遍。0 = 不缓存，每次都真拉。
     */
    friendsCacheTTL: 240,
    /**
     * 全部页面关闭后多久收掉浏览器实例（秒）。0 = 一直留着。
     *
     * 一个开着抖音页面的 Chromium 占 200~400MB，而续火一天只跑一次、扫码登录更少。
     * 不收掉的话那份内存会一直留到 Yunzai 重启。给 60 秒是为了跨过续火在两个账号
     * 之间的间隔（那时页面已经关了但马上还要再开），不至于每个账号都重启一次浏览器。
     */
    browserIdleClose: 60,
  },

  push: {
    /** 续火跑完是否推送结果 */
    enable: true,
    /** detail=逐条列出发了什么 | summary=只报成功失败数 */
    mode: "detail",
    /** 仅在有失败时才推送，日常静默 */
    onlyOnFail: false,
    /**
     * 推送到哪里：group=只推群 | friend=只私聊 | both=两边都推。
     * 与下面两个列表配合使用——列表配好了但这里选了 group，好友列表就不会收到。
     */
    target: "both",
    /**
     * 推送目标群。元素形如 { botId: "12345", groupId: "67890" }，
     * botId 留空表示用执行续火的那台机器人发。
     */
    groups: [],
    /** 推送目标好友（私聊），结构同上，字段为 userId */
    friends: [],
    /** 是否附带失败截图 */
    withScreenshot: false,
  },

  web: {
    /** Web 面板总开关；关掉后 #抖音web 直接提示未启用 */
    enable: true,
    /** 挂载路径，需以 / 开头且只有一段 */
    base: "/douyin",
    /** 0 = 复用 Yunzai 自身端口；填端口号则额外起一个独立服务 */
    port: 0,
    /** 对外访问地址（含协议端口，不含 base），留空自动用 Yunzai 的 url 配置 */
    url: "",
    /** 临时验证码有效期（秒） */
    codeTTL: 300,
    /** 登录后会话有效期（秒） */
    sessionTTL: 1800,
    /** 同一验证码允许输错的次数 */
    maxCodeAttempts: 5,
    /** 每个 IP 的限流窗口（秒）与两个桶的配额 */
    rateWindow: 60,
    rateGeneral: 300,
    rateAuth: 8,
    /** 同一 IP 鉴权失败累计到此值后永久拉黑（重启清空） */
    banAfter: 12,
    /** 审计日志保留条数 */
    auditKeep: 500,
    /**
     * 群里回复面板地址时是否给主机名打码（默认开）。
     *
     * 很多人是用公网 IP 直连的（`http://1.2.3.4:2536`），群里贴一次地址就等于把机器
     * 暴露给全部群成员 —— 端口扫描和暴力破解都从拿到这个地址开始。而地址本人早就知道，
     * 群里那条回复真正的作用只是「指令收到了」，不需要带完整主机。
     *
     * 打码只影响群消息：私信里发的始终是完整地址（那本来就是给他一个人的）。
     * 用域名 + HTTPS 的人可以关掉这个开关继续用完整链接。
     */
    maskLinkInGroup: true,
  },

  chat: {
    /**
     * 聊天界面总开关。关掉后面板上不出现「进入聊天」，接口一律 403。
     *
     * 单独给它一个开关是因为它和插件其余部分的风险画像不一样：续火一天开一次浏览器，
     * 而聊天会把一个抖音登录会话挂上几分钟到几小时。不想承担这个的人应该能整块关掉。
     */
    enable: true,
    /**
     * 没人来轮询多久之后自动关掉聊天页（秒）。
     *
     * 这是 spark.browserIdleClose 那套机制的补丁：browser.js 收浏览器的判据是「还有没有
     * 非 about:blank 的真实页面」，聊天页开着它永远不触发，Chromium 会一直占着
     * 200~400MB 直到 Yunzai 重启。而用户关掉网页并不会通知服务端，只能按「多久没人碰」判。
     *
     * 默认 180 秒 = 前端 3 秒轮询漏掉 60 次。给这么宽是因为重开一次要十几秒，
     * 用户切出去看条视频再回来不该被强制重连。
     */
    idleCloseSec: 180,
    /**
     * 前端拉新消息的间隔（毫秒）。
     *
     * 每一轮都是一次 page.evaluate 读整屏气泡，页面上没变化时它也要跑一遍——但这只是
     * 本地 CPU，不向抖音发任何请求，所以可以比续火那些操作激进得多。3 秒是「像 IM」
     * 和「别把 Node 跑满」之间的折中。
     */
    pollMs: 3000,
    /** 进会话时一次给前端多少条历史；往上翻页每次再给 40 条（见 chatdb.history） */
    historyLimit: 60,
    /** 单条消息的字数上限。抖音自己的限制更宽，这里只是挡住误粘一整篇文章 */
    maxLength: 500,
  },

  security: {
    /** 接口与日志里的 Cookie 一律打码 */
    maskCookie: true,
    /** 是否允许手动导入 Cookie（指令与面板粘贴框） */
    allowManualCookie: true,
    /** 二维码登录的等待上限（秒） */
    qrLoginTimeout: 180,
    /** 收到 Cookie 文件后是否立刻删除本地临时文件 */
    deleteCookieFile: true,
    /**
     * 抖音在扫码后追加人工验证时，是否开一个远程操作页面把这道验证交回给人。
     * 关掉则退回老路：报一句「需要人工验证」并给出文件登录 / 显形浏览器两个替代方案。
     */
    remoteVerify: true,
    /**
     * 抖音要求短信验证时，是否由插件自己在页面上点「接收短信验证码 → 发送验证码」，
     * 然后只跟发起人要那几位数字（拿到后自动填回页面提交）。
     *
     * 默认关：它会真的往用户绑定的手机上发一条短信，而 `#抖音登录` 的用户未必预期
     * 这件事。需要它的时候用 `#抖音自动登录`，那条指令会显式打开，不看这个开关。
     * 这里打开则连 `#抖音登录` 也一并走自动短信。
     *
     * 只对短信验证有效。滑块、拼图、绑定手机号这些插件代不了，仍然落回远程验证页面。
     */
    autoSms: false,
    /**
     * 进入验证态后的等待上限（秒）。人要收短信、点开链接、在页面上操作，
     * 所以比 qrLoginTimeout 宽得多——进验证态时会把会话期限整体推到这个值。
     */
    verifyTimeout: 600,
    /**
     * 远程验证票据是否绑定首次访问的 IP。开着的话链接被转发到别的机器就失效；
     * 手机在 4G 与 WiFi 之间切换会换 IP，真被它挡住时关掉即可。
     */
    verifyBindIp: true,
  },

  render: {
    /** 帮助、设置、状态等文本响应是否渲染成图片 */
    image: true,
    /** 渲染倍率，1 = 620px 宽；屏幕小可以调到 1.2 让字更大 */
    scale: 1,
  },

  update: {
    /** 更新完成后自动重启 Yunzai */
    autoRestart: true,
    /** 更新日志最多显示多少条 commit */
    logLimit: 20,
  },

  /**
   * 排查用，默认全关。
   *
   * 抖音页面出问题时唯一可靠的信息来源是「那一刻页面上到底是什么」，而无头浏览器
   * 跑在服务器上没人看得见。所以这里提供两级：日志级（每一步记一行）与现场级
   * （截图 + 页面原文落盘）。默认关掉是因为前者让日志量成倍增长、后者按兆写磁盘。
   */
  debug: {
    /** 调试日志：扫码登录与续火的每一步、拦到的接口、每轮探测结果都记一行 */
    enable: false,
    /** 关键步骤把整页截图与页面文本/HTML 存到 data/debug，改选择器时用 */
    snapshot: false,
    /** data/debug 里最多保留多少个文件，超出按时间删最旧的。0 = 不清理 */
    keep: 200,
  },
}


class Config {
  #data

  constructor() {
    this.#data = this.#load()
  }

  /** 读盘并与默认值深合并。yaml 坏了也要能启动，所以退回纯默认配置 */
  #load() {
    let user = {}
    if (fs.existsSync(configPath)) {
      try {
        user = YAML.parse(fs.readFileSync(configPath, "utf8")) || {}
      } catch (error) {
        log("error", "config.yaml 解析失败，本次使用默认配置：", error.message)
        user = {}
      }
    }
    return deepMerge(DEFAULT_CONFIG, user)
  }

  /** 外部（锅巴 / 手改文件）改动后调用，让进程内立即生效 */
  reload() {
    this.#data = this.#load()
    return this.#data
  }

  get data() {
    return this.#data
  }

  /** 点路径读取：`config.get("web.codeTTL", 300)` */
  get(keyPath, fallback) {
    const value = getPath(this.#data, keyPath)
    return value === undefined ? fallback : value
  }

  /** 布尔项统一读法：只有显式 false 才算关，缺失按默认值处理 */
  bool(keyPath, fallback = true) {
    const value = getPath(this.#data, keyPath)
    if (value === undefined) return fallback
    return value !== false
  }

  /** 数值项统一读法，非法值退回默认，并可夹在 [min, max] 内 */
  num(keyPath, fallback = 0, { min = -Infinity, max = Infinity } = {}) {
    const value = Number(getPath(this.#data, keyPath))
    if (!Number.isFinite(value)) return fallback
    return Math.min(max, Math.max(min, value))
  }

  /** 点路径写入并立刻落盘；锅巴、Web 面板与指令共用 */
  set(keyPath, value, { save = true } = {}) {
    setPath(this.#data, keyPath, value)
    if (save) this.save()
    return value
  }

  /** 批量写入，避免连续 set 反复写盘 */
  setMany(entries) {
    for (const [keyPath, value] of Object.entries(entries || {}))
      setPath(this.#data, keyPath, value)
    this.save()
    return this.#data
  }

  save() {
    try {
      fs.writeFileSync(configPath, YAML.stringify(this.#data), "utf8")
    } catch (error) {
      log("error", "配置保存失败：", error.message)
      throw error
    }
  }

  /**
   * 推送目标归一化。
   * 锅巴的 GSubForm 给出 `{ botId, groupId }` 对象数组，手写 yaml 时也允许直接写群号字符串，
   * 这里统一成 `[{ botId, id }]`，并按 botId:id 去重。
   *
   * @param {"groups"|"friends"} kind
   */
  pushTargets(kind = "groups") {
    const field = kind === "friends" ? "userId" : "groupId"
    const list = this.get(`push.${kind}`, []) || []
    const out = []
    for (const item of list) {
      if (item == null) continue
      if (typeof item === "object") {
        for (const id of toIdList(item[field] ?? item.id)) {
          const key = `${item.botId ?? ""}:${id}`
          if (!out.some(o => `${o.botId}:${o.id}` === key)) out.push({ botId: String(item.botId ?? "").trim(), id })
        }
      } else {
        for (const id of toIdList(item))
          if (!out.some(o => o.id === id && !o.botId)) out.push({ botId: "", id })
      }
    }
    return out
  }

  /** 推送目标模式，非法值一律按 both 处理，避免配错导致完全不推 */
  pushTarget() {
    const value = String(this.get("push.target", "both")).trim()
    return PUSH_TARGETS.includes(value) ? value : "both"
  }

  /** 是否推群 / 是否推私聊，供 push.js 直接判断 */
  pushToGroup() {
    return this.pushTarget() !== "friend"
  }

  pushToFriend() {
    return this.pushTarget() !== "group"
  }

  /** Web 面板对外地址，末尾不带 / */
  webOrigin() {
    const custom = String(this.get("web.url", "")).trim()
    if (custom) return custom.replace(/\/+$/, "")
    const port = Number(this.get("web.port", 0))
    if (port > 0) {
      const host = String(global.Bot?.url || "http://localhost").replace(/:\d+$/, "").replace(/\/+$/, "")
      return `${host}:${port}`
    }
    return String(global.Bot?.url || "http://localhost:2536").replace(/\/+$/, "")
  }

  /** 挂载路径归一化：保证以 / 开头、无尾斜杠、只有一段 */
  webBase() {
    const raw = String(this.get("web.base", "/douyin")).trim() || "/douyin"
    const seg = raw.replace(/^\/+|\/+$/g, "").split("/")[0] || "douyin"
    return `/${seg}`
  }
}

export const config = new Config()
export default config
