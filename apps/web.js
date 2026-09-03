/**
 * Web 面板入口指令：`#抖音web` 取面板地址与一次性验证码，`#抖音web下线` 作废全部凭据。
 *
 * 位置：指令层，只做「读配置 → 调 lib 签发/作废凭据 → 分私信与群两路回消息」。
 * 协作模块：面板本体与路由在 lib/web.js，验证码与面板会话在 lib/auth.js，
 * 远程验证链接（扫码登录遇到人工验证时用）在 lib/remote.js，登录会话在 lib/login.js，
 * 发送走 lib/bot.js，地址打码走 lib/util.js 的 maskUrl。
 *
 * 安全模型：群消息里只出现面板地址（默认再打码），验证码只走私信。两者分离后，
 * 群成员看到链接也进不去。验证码另绑定「发起人是哪些机器人的主人」，进面板后只能选
 * 这些机器人，改请求参数越权不了（校验在 lib/auth.js 的 selectBot）。
 */
import { config } from "../lib/config.js"
import { toError, maskUrl } from "../lib/util.js"
import { audit } from "../lib/audit.js"
import { issueCode, revokeCodes, destroyUserSessions } from "../lib/auth.js"
import { revokeUserTickets } from "../lib/remote.js"
import { cancelUserSessions } from "../lib/login.js"
import { mastersOf, sendPrivate, listBots } from "../lib/bot.js"

export class DouyinWeb extends plugin {
  constructor() {
    super({
      name: "抖音续火-面板",
      dsc: "获取 Web 面板地址与临时验证码",
      event: "message",
      priority: 800,
      rule: [
        { reg: "^#?(dy|抖音)(web|WEB|面板)$", fnc: "openWeb", permission: "master" },
        { reg: "^#?(dy|抖音)(web|WEB|面板)(下线|退出|关闭会话)$", fnc: "closeWeb", permission: "master" },
      ],
    })
  }

  /**
   * 签发一次性验证码并把面板地址交给用户：完整链接私信，群里只回一句打码后的确认。
   * @param {object} e 消息事件
   * @returns {Promise<*>} e.reply 的结果
   */
  async openWeb(e) {
    if (!config.bool("web.enable", true))
      return e.reply("Web 面板未启用，可在锅巴或 config/config.yaml 中打开 web.enable")

    // 只允许进入「他是主人」的机器人。这里算出的 allowedBots 存进验证码票据，
    // 之后 selectBot 只认这个名单，多 bot 部署下改请求参数越权不了
    const allowedBots = listBots()
      .map(b => b.uin)
      .filter(uin => mastersOf(uin).includes(String(e.user_id)))
    if (!allowedBots.length) return e.reply("未在任何机器人的主人列表中，无法打开面板")

    const { code, ttl } = issueCode({ userId: e.user_id, botId: e.self_id, allowedBots })
    const url = `${config.webOrigin()}${config.webBase()}/`

    /*
     * 一键进入链接：验证码放 URL 的 hash 而不是 query。
     *
     * 不用 `?ABCD`：query 会被交给服务端，Yunzai 的 serverHandle 把 req.query 整个写进
     * 日志（框架 lib/bot.js:146-152），而排查问题时 logs/command.*.log 常被直接贴出，
     * 等于把未过期的验证码公开。hash 不发送给服务端，因此不进 access log、不随 Referer
     * 外泄；前端读完立刻 history.replaceState 抹掉（web/app.js:186），地址栏与截图里
     * 也不留。
     *
     * 远程验证链接 `/verify#t=xxx` 用的是同一套（web/verify.html:122-123），QQ 能正常
     * 识别带 hash 的链接。
     */
    const link = `${url}#${code}`

    try {
      await sendPrivate(e.self_id, e.user_id, [
        "🔐 抖音续火面板\n",
        `一键进入：${link}\n`,
        `手动输入：地址 ${url} ，验证码 ${code}\n`,
        `有效期：${Math.floor(ttl / 60)} 分钟，仅可使用一次\n`,
        "⚠️ 请勿转发。若非本人操作，发送「#抖音web下线」立即作废。",
      ].join(""))
    } catch (error) {
      // 私信没送达就等于验证码没人知道，留着只是多一个可被爆破的目标，直接作废
      revokeCodes(e.user_id)
      return e.reply(
        `私信发送验证码失败（${toError(error).message}），已作废本次验证码。请先加机器人好友或允许临时会话。`
      )
    }

    audit.add("web.open", { botId: e.self_id, userId: e.user_id, group: e.group_id || "" })

    /*
     * 群里那条回复默认给主机与端口打码（web.maskLinkInGroup，默认 true）。
     *
     * 完整地址已经在上面的私信里，群里这句的作用只是确认「指令收到了」；而公网 IP 直连的
     * 部署一旦在群里贴出原样地址，等于把机器地址交给全部群成员去扫端口。打码规则见
     * lib/util.js 的 maskUrl：主机保留尾 3 字符，端口整段替换成同长度的 *，协议与路径原样。
     * 用域名 + HTTPS 的部署把开关关掉即可继续看到完整链接。
     */
    const masked = e.isGroup && config.bool("web.maskLinkInGroup", true)
    const reply = [`🔗 抖音续火面板：${masked ? maskUrl(url) : url}`, `一键进入链接已私信发送，${Math.floor(ttl / 60)} 分钟内有效`]
    if (e.isGroup) reply.push(masked ? "（完整地址与验证码均已私信发送）" : "（验证码不会出现在群里）")
    return e.reply(reply.join("\n"), true)
  }

  /**
   * 下线：把「发给这个人、现在还能用」的四类东西一次清干净。
   * 面板验证码、面板会话、远程验证链接票据、进行中的登录会话。
   * @param {object} e 消息事件
   * @returns {Promise<*>} e.reply 的结果，文案里带上各类实际清掉的数量
   */
  async closeWeb(e) {
    const codes = revokeCodes(e.user_id)
    const sessions = destroyUserSessions(e.user_id)
    // 远程验证链接也是「发给这个人的、还能用的入口」，一起清掉才算真的下线
    const tickets = revokeUserTickets(e.user_id)
    /*
     * 还在跑的登录会话也要一起终止。
     *
     * 只撕票据只是让链接打不开，浏览器页面还开着占内存，超时兜底也还挂着——于是人早已
     * 下线，十分钟后照旧收到一句「❌ 抖音要求的验证在 10 分 0 秒内没有完成」
     * （lib/login.js:393）。会话进 canceled 终态后 cleanup 会 clearTimeout 摘掉兜底，
     * 而超时与失败两条兜底路径都先检查 `["success","failed","canceled"].includes(status)`，
     * 因此不会再向外推送任何消息。
     */
    const logins = await cancelUserSessions(e.user_id)
    const parts = [`已作废 ${codes} 个验证码、${sessions} 个面板会话`]
    if (tickets) parts.push(`${tickets} 个验证链接`)
    if (logins) parts.push(`并终止 ${logins} 个进行中的登录会话（浏览器已关闭，不会再有超时提示）`)
    // 这条回复本身不含任何地址或验证码，因此指令在哪发就回哪，群里可见无妨
    return e.reply(parts.join("、"), true)
  }
}
