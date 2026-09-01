/**
 * Web 面板入口指令。
 *
 * 安全模型：群里只出现「面板地址」，验证码永远走私信；两者分离之后，
 * 群成员看到链接也进不去。验证码本身还绑定了「发起人是哪些机器人的主人」，
 * 进面板后只能选这些机器人，改参数越权不了（校验在 lib/auth.js 的 selectBot）。
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

  async openWeb(e) {
    if (!config.bool("web.enable", true))
      return e.reply("Web 面板未启用，可在锅巴或 config/config.yaml 中打开 web.enable")

    // 只允许进入「他是主人」的机器人，多 bot 下不能靠改参数越权
    const allowedBots = listBots()
      .map(b => b.uin)
      .filter(uin => mastersOf(uin).includes(String(e.user_id)))
    if (!allowedBots.length) return e.reply("未在任何机器人的主人列表中，无法打开面板")

    const { code, ttl } = issueCode({ userId: e.user_id, botId: e.self_id, allowedBots })
    const url = `${config.webOrigin()}${config.webBase()}/`

    try {
      await sendPrivate(e.self_id, e.user_id, [
        "🔐 抖音续火面板临时验证码\n",
        `验证码：${code}\n`,
        `有效期：${Math.floor(ttl / 60)} 分钟，仅可使用一次\n`,
        `地址：${url}\n`,
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
     * 群里那条回复默认给主机名打码（web.maskLinkInGroup）。
     *
     * 完整地址已经在上面的私信里了，群里这句真正的作用只是「指令收到了」；
     * 而用公网 IP 直连的人一旦在群里贴出原样地址，等于把机器交给全部群成员去扫端口。
     * 用域名 + HTTPS 的人把开关关掉就能继续看到完整链接。
     */
    const masked = e.isGroup && config.bool("web.maskLinkInGroup", true)
    const reply = [`🔗 抖音续火面板：${masked ? maskUrl(url) : url}`, `验证码已私信发送，${Math.floor(ttl / 60)} 分钟内有效`]
    if (e.isGroup) reply.push(masked ? "（完整地址与验证码均已私信发送）" : "（验证码不会出现在群里）")
    return e.reply(reply.join("\n"), true)
  }

  async closeWeb(e) {
    const codes = revokeCodes(e.user_id)
    const sessions = destroyUserSessions(e.user_id)
    // 远程验证链接也是「发给这个人的、还能用的东西」，一起清掉才算真的下线
    const tickets = revokeUserTickets(e.user_id)
    /*
     * 还在跑的登录会话也要一起终止。
     *
     * 光撕票据只是让链接打不开，那个浏览器页面还开着占内存，超时兜底也还挂着——
     * 于是人早就下线了，十分钟后照旧收到一句「❌ 抖音要求的验证在 10 分 0 秒内没有
     * 完成」。会话走 canceled 终态之后 cleanup 会摘掉定时器，那条提示不会再发。
     */
    const logins = await cancelUserSessions(e.user_id)
    const parts = [`已作废 ${codes} 个验证码、${sessions} 个面板会话`]
    if (tickets) parts.push(`${tickets} 个验证链接`)
    if (logins) parts.push(`并终止 ${logins} 个进行中的登录会话（浏览器已关闭，不会再有超时提示）`)
    // 这句就是「下线提示」本身：指令在哪发的就回哪，群里发的群里可见
    return e.reply(parts.join("、"), true)
  }
}
