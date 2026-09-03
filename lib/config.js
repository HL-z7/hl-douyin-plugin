/**
 * 配置模型：默认值 + 深合并 + 点路径存取。
 *
 * 三条设计约定：
 * 1. 默认值全部写在代码里（DEFAULT_CONFIG）。构造时读 config/config.yaml 并执行
 *    `deepMerge(DEFAULT_CONFIG, 用户配置)`，所以配置文件允许只写改过的字段，缺的部分
 *    由默认值补齐；插件升级新增字段时老配置文件不需要手动补，仓库里也不必提交带群号
 *    的示例配置。注意 save() 落盘的是合并后的完整配置树，一旦经 set/setMany 保存过，
 *    文件里就会带上全部字段。
 * 2. 对外只暴露一个 Config 单例（具名导出 `config`，同时作为 default）。锅巴、Web 面板、
 *    `#抖音设置` 三处写的都是它，任一处保存后另两处立即读到新值，不存在多份缓存不一致。
 * 3. 读写统一走点路径（`config.get("web.codeTTL")`），与锅巴的扁平 field 命名对齐。
 *
 * 导出：`DEFAULT_CONFIG`（默认值树，锅巴 schema 与 README 均以它为准）、`PUSH_TARGETS`
 * （push.target 的合法取值）、`config` 单例。
 *
 * 依赖：只依赖 `lib/util.js` 的纯函数（deepMerge / getPath / setPath / toIdList / log）
 * 与 yaml 包，不导入插件内其它模块 —— 几乎所有模块都要读配置，反向依赖会形成循环。
 *
 * 调用前提：模块加载时就会建好 config 目录并读盘，导入即可用，无需显式初始化。
 * set/setMany/save 走同步 fs.writeFileSync，写盘失败时 save() 会抛。
 */
import fs from "node:fs"
import path from "node:path"
import YAML from "yaml"
import { pluginRoot, ensureDir, deepMerge, getPath, setPath, log, toIdList } from "./util.js"

const configDir = ensureDir(pluginRoot, "config")
const configPath = path.join(configDir, "config.yaml")

/** push.target 的合法取值：group=只推群 | friend=只推私聊 | both=两者都推 */
export const PUSH_TARGETS = ["group", "friend", "both"]

export const DEFAULT_CONFIG = {
  spark: {
    /**
     * 定时续火总开关。
     * 只被 lib/scheduler.js 的 reschedule() 读取：关掉时注销 node-schedule 任务。
     * 手动 `#抖音续火` 与面板的单账号续火不检查此项。
     */
    enable: true,
    /** 6 位 cron，秒在最前，node-schedule 语法 */
    cron: "0 20 8 * * *",
    /**
     * 定时任务遇到今天已成功续火的账号时跳过。
     * 关掉后同一天会重复发送：抖音火花一天只计一次，重复发送没有额外收益，只增加风控风险。
     * 手动 `#抖音续火` 不读此项（用户主动触发即执行），`#抖音续火 跳过` 才按此规则判定。
     */
    skipIfDone: true,
    /** 无头运行。调试选择器时可临时关掉以显示浏览器窗口 */
    headless: true,
    /** Chromium 可执行文件路径。留空则用 Yunzai 的 chromium_path，再退到 puppeteer 自带版本 */
    browserPath: "",
    /** 消息模板，留空则发一言。占位符见 lib/template.js 的 PLACEHOLDERS */
    messageTemplate: "",
    /** 发一言时是否带出处 */
    yiyanIncludeSource: true,
    /** 相邻好友之间的随机间隔（毫秒）。间隔过短容易触发抖音风控 */
    minGapMs: 2500,
    maxGapMs: 6000,
    /** 单个好友的搜索重试次数，全部候选名都搜不到才判定为「丢了」 */
    searchRetry: 3,
    /** 单账号整体超时（毫秒），浏览器卡死时兜底放弃 */
    accountTimeoutMs: 300000,
    /** 失败时把整页截图存到 data/screenshots，用于排查选择器失效 */
    screenshotOnFail: true,
    /**
     * 拦截图片/字体/媒体等与续火无关的请求。
     * 一次聊天页加载会发出几百个资源请求，其中绝大部分是视频封面与字体；
     * 拦掉后单次续火对抖音发出的请求量下降一个量级，页面加载也更快。
     */
    blockResources: true,
    /** 在资源拦截之外，额外拦掉推荐流/埋点这类明确用不到的接口 */
    blockTracking: true,
    /**
     * Cookie 有效性检查结果的缓存时长（分钟）。
     * 检查一次要真开一个浏览器访问抖音，频繁检查既慢又额外承担风控风险；
     * 缓存期内重复检查直接复用上次结论。0 = 不缓存。
     */
    cookieCheckTTL: 30,
    /**
     * 会话（好友）列表的缓存时长（分钟）。
     *
     * 拉一次列表要开浏览器、进聊天页、等会话渲染完成，好友多的账号需要十几秒；而好友
     * 名单几天都不会变化。默认缓存 4 小时，面板打开发信卡片时直接读缓存，
     * 只有点「重新拉取」才真去抖音请求。0 = 不缓存，每次都真拉。
     */
    friendsCacheTTL: 240,
    /**
     * 全部页面关闭后多久收掉浏览器实例（秒）。0 = 一直保留。
     *
     * 一个开着抖音页面的 Chromium 占 200~400MB，而续火一天只跑一次、扫码登录更少；
     * 不收掉的话这份内存会保留到 Yunzai 重启。取 60 秒是为了跨过续火在两个账号之间的
     * 间隔（此时页面已关但马上要再开），避免每个账号都重启一次浏览器。
     */
    browserIdleClose: 60,
  },

  push: {
    /** 续火跑完是否推送结果 */
    enable: true,
    /** detail=逐条列出发送内容 | summary=只报成功失败数（见 lib/push.js 的 renderReport） */
    mode: "detail",
    /** 仅在有失败时才推送，其余情况静默 */
    onlyOnFail: false,
    /**
     * 推送范围，取值见 PUSH_TARGETS。
     * 与下面两个列表配合：列表配好了但这里选了 group，好友列表就不会收到。
     */
    target: "both",
    /**
     * 推送目标群。元素形如 { botId: "12345", groupId: "67890" }，
     * botId 留空表示用执行续火的那台机器人发送。归一化见 Config.pushTargets。
     */
    groups: [],
    /** 推送目标好友（私聊），结构同上，字段名为 userId */
    friends: [],
    /** 是否附带失败截图。当前无代码读取此项（预留字段） */
    withScreenshot: false,
  },

  web: {
    /** Web 面板总开关。关掉后 #抖音web 直接提示未启用 */
    enable: true,
    /** 挂载路径，需以 / 开头且只有一段。归一化见 Config.webBase */
    base: "/douyin",
    /** 0 = 复用 Yunzai 自身端口；填端口号则额外起一个独立服务 */
    port: 0,
    /** 对外访问地址（含协议与端口，不含 base），留空则自动用 Yunzai 的 url 配置 */
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
     * 部分部署是公网 IP 直连（`http://1.2.3.4:2536`），群里贴一次地址等于把机器地址
     * 暴露给全部群成员，端口扫描与暴力破解都从拿到地址开始。而地址对本人是已知的，
     * 群里那条回复的作用只是确认「指令收到了」，不需要携带完整主机。
     *
     * 打码只影响群消息：私信里发的始终是完整地址。用域名 + HTTPS 的部署可关掉此项。
     */
    maskLinkInGroup: true,
  },

  chat: {
    /**
     * 私信聊天总开关。关掉后面板不显示「进入聊天」入口，`/api/chat/:id/open` 返回 403
     * （其余 chat 接口不挂这道判定，因为没有 open 就没有会话可操作）。
     * `#抖音设置 聊天 关` 还会顺带调 chat.closeAll 收掉已开的会话。
     *
     * 单独设开关是因为它与插件其余部分的风险画像不同：续火一天开一次浏览器，
     * 而聊天会把一个抖音登录会话挂上几分钟到几小时。
     */
    enable: true,
    /**
     * 无人轮询多久后自动关掉聊天页（秒），实际读取见 lib/chat.js 的 #armIdle
     * （夹取范围 30~3600）。
     *
     * 这是 spark.browserIdleClose 那套机制的补充：lib/browser.js 收浏览器的判据是
     * 「还有没有非 about:blank 的真实页面」，聊天页常开时该机制永不触发，Chromium 会
     * 一直占着 200~400MB 直到 Yunzai 重启。而用户关闭网页不会通知服务端，只能按
     * 「多久没有请求碰过这个会话」判定。
     *
     * 默认 180 秒 = 前端 3 秒轮询漏掉 60 次。取这么宽是因为重开一次要十几秒，
     * 用户切出去看一条视频再回来不应被强制重连。
     */
    idleCloseSec: 180,
    /**
     * 前端拉取新消息的间隔（毫秒）。
     *
     * 每一轮都是一次 page.evaluate 读整屏气泡，页面无变化时也照样执行；但这只消耗
     * 本地 CPU，不向抖音发任何请求，因此可以比续火的各项操作激进得多。
     * 3 秒是「交互像 IM」与「不把 Node 跑满」之间的折中。
     */
    pollMs: 3000,
    /**
     * 进会话时一次给前端多少条历史。
     * 注意：当前只有面板与锅巴在展示/写入此项，lib/chat.js 走的是 chatdb.history 的
     * 默认 limit=60，向上翻页固定每次 40 条，两处都没有读这个配置。
     */
    historyLimit: 60,
    /** 单条消息的字数上限（`/api/chat/:id/send` 校验）。抖音自身限制更宽，此项只挡误粘长文 */
    maxLength: 500,
  },

  security: {
    /** 接口与日志里的 Cookie 一律打码。当前实际打码逻辑固定生效，无代码读取此项 */
    maskCookie: true,
    /** 是否允许手动导入 Cookie（指令与面板粘贴框） */
    allowManualCookie: true,
    /** 二维码登录的等待上限（秒） */
    qrLoginTimeout: 180,
    /** 收到 Cookie 文件后是否立刻删除本地临时文件 */
    deleteCookieFile: true,
    /**
     * 抖音在扫码后追加人工验证时，是否开一个远程操作页面把这道验证交回给人处理。
     * 关掉则回退到：提示「需要人工验证」并给出文件登录 / 显形浏览器两个替代方案。
     */
    remoteVerify: true,
    /**
     * 抖音要求短信验证时，是否由插件自己在页面上点「接收短信验证码 → 发送验证码」，
     * 再向发起人索取验证码数字（拿到后自动填回页面提交）。
     *
     * 默认关：它会真的向用户绑定的手机发送一条短信，而 `#抖音登录` 的用户未必预期
     * 这件事。需要时用 `#抖音自动登录`，该指令显式打开此行为、不读此开关。
     * 此项打开后 `#抖音登录` 也一并走自动短信。
     *
     * 只对短信验证有效。滑块、拼图、绑定手机号等仍回退到远程验证页面。
     */
    autoSms: false,
    /**
     * 进入验证态后的等待上限（秒）。用户要收短信、点开链接、在页面上操作，
     * 因此比 qrLoginTimeout 宽得多；进入验证态时会把会话期限整体推到这个值。
     * 同时作为 lib/remote.js 签发票据的 TTL（夹取范围 120~3600）。
     */
    verifyTimeout: 600,
    /**
     * 远程验证票据是否绑定首次访问的 IP。开启时链接被转发到别的机器即失效；
     * 手机在 4G 与 WiFi 之间切换会更换 IP，确实被拦住时关掉即可。
     */
    verifyBindIp: true,
  },

  render: {
    /** 帮助、设置、状态等文本响应是否渲染成图片 */
    image: true,
    /**
     * 用户侧渲染倍率，1 = 按设计稿清晰度出图。屏幕小可调到 1.2 让字更大。
     * 实际缩放 = lib/render.js 的 BASE_SCALE(1.4) × 此值，夹取范围 0.6~2；
     * 版面本身固定 900px 宽（resources/common/theme.css 的 .page）。
     */
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
   * 跑在服务器上无法直接观察。因此提供两级：日志级（每一步记一行）与现场级
   * （截图 + 页面原文落盘）。默认关闭的原因是前者让日志量成倍增长、后者按 MB 写磁盘。
   */
  debug: {
    /** 调试日志：扫码登录与续火的每一步、拦到的接口、每轮探测结果都记一行 */
    enable: false,
    /** 关键步骤把整页截图与页面文本/HTML 存到 data/debug，调整选择器时使用 */
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

  /**
   * 读盘并与默认值深合并。
   * yaml 解析失败时退回纯默认配置：配置文件写坏不应让插件无法加载。
   * @returns {object} 合并后的完整配置树
   */
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

  /**
   * 重新读盘。外部（锅巴 / 手动改文件）改动后调用，使进程内立即生效。
   * @returns {object} 新的配置树
   */
  reload() {
    this.#data = this.#load()
    return this.#data
  }

  get data() {
    return this.#data
  }

  /**
   * 点路径读取。
   * @param {string} keyPath 形如 `"web.codeTTL"`
   * @param {*} [fallback] 路径不存在（值为 undefined）时返回它
   * @returns {*}
   */
  get(keyPath, fallback) {
    const value = getPath(this.#data, keyPath)
    return value === undefined ? fallback : value
  }

  /**
   * 布尔项统一读法：只有显式 false 才算关，其它真值一律算开，缺失按 fallback。
   * @param {string} keyPath
   * @param {boolean} [fallback=true]
   * @returns {boolean}
   */
  bool(keyPath, fallback = true) {
    const value = getPath(this.#data, keyPath)
    if (value === undefined) return fallback
    return value !== false
  }

  /**
   * 数值项统一读法：非数值（NaN / Infinity / 非法字符串）退回 fallback，
   * 合法值再夹取到 [min, max] 内。注意 fallback 本身不参与夹取 —— 传的默认值
   * 若在区间之外会原样返回。
   * @param {string} keyPath
   * @param {number} [fallback=0]
   * @param {{min?: number, max?: number}} [bounds]
   * @returns {number}
   */
  num(keyPath, fallback = 0, { min = -Infinity, max = Infinity } = {}) {
    const value = Number(getPath(this.#data, keyPath))
    if (!Number.isFinite(value)) return fallback
    return Math.min(max, Math.max(min, value))
  }

  /**
   * 点路径写入，默认立刻落盘。锅巴、Web 面板与指令共用。
   * @param {string} keyPath 中间层缺失时由 setPath 补出对象
   * @param {*} value
   * @param {{save?: boolean}} [opts] save=false 时只改内存，需自行调 save()
   * @returns {*} 原样返回 value
   * @throws 落盘失败时由 save() 抛出
   */
  set(keyPath, value, { save = true } = {}) {
    setPath(this.#data, keyPath, value)
    if (save) this.save()
    return value
  }

  /**
   * 批量写入后只落盘一次，避免连续 set 反复写盘。
   * @param {Record<string, *>} entries 键为点路径
   * @returns {object} 写入后的配置树
   * @throws 落盘失败时由 save() 抛出
   */
  setMany(entries) {
    for (const [keyPath, value] of Object.entries(entries || {}))
      setPath(this.#data, keyPath, value)
    this.save()
    return this.#data
  }

  /**
   * 把当前配置树整体写回 config/config.yaml（同步写）。
   * @throws 写盘失败时先记日志再原样抛出，让调用方能把失败反馈给用户
   */
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
   *
   * 输入形态有两种：锅巴的 GSubForm 给出 `{ botId, groupId }` 对象数组，手写 yaml 时
   * 也允许直接写群号字符串（甚至 `"1,2 3"` 这类多值串，由 toIdList 拆开）。
   * 统一成 `[{ botId, id }]`，对象项按 `botId:id` 去重，字符串项按 id 去重。
   *
   * @param {"groups"|"friends"} kind 决定读 push.groups 还是 push.friends，
   *   以及对象里取 groupId 还是 userId（两者都缺时退到 item.id）
   * @returns {Array<{botId: string, id: string}>}
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

  /**
   * 推送范围。非法值一律按 both 处理，避免配错导致完全不推送。
   * @returns {"group"|"friend"|"both"}
   */
  pushTarget() {
    const value = String(this.get("push.target", "both")).trim()
    return PUSH_TARGETS.includes(value) ? value : "both"
  }

  /** 是否推群，供 lib/push.js 直接判断 */
  pushToGroup() {
    return this.pushTarget() !== "friend"
  }

  /** 是否推私聊，供 lib/push.js 直接判断 */
  pushToFriend() {
    return this.pushTarget() !== "group"
  }

  /**
   * Web 面板对外地址（末尾不带 /）。
   *
   * 优先用 web.url；否则以 Yunzai 的 `global.Bot.url` 为基准：配了独立端口 web.port
   * 时替换掉其中的端口号，未配则原样使用（`global.Bot` 不存在时退到 localhost:2536）。
   * @returns {string}
   */
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

  /**
   * 挂载路径归一化：保证以 / 开头、无尾斜杠、只有一段（多段输入只取第一段）。
   * 空值或全是斜杠时退回 `/douyin`。
   * @returns {string}
   */
  webBase() {
    const raw = String(this.get("web.base", "/douyin")).trim() || "/douyin"
    const seg = raw.replace(/^\/+|\/+$/g, "").split("/")[0] || "douyin"
    return `/${seg}`
  }
}

export const config = new Config()
export default config
