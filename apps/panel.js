/**
 * 状态、设置、帮助三条「看信息」指令。
 *
 * 内容一律由 lib/panel.js 组装，这里只负责「出图还是出字」：
 * replyRender 会在渲染关闭、渲染失败、图片发不出去这三种情况下自动降级成文字，
 * 所以指令层不需要各自判断一遍。
 */
import { config } from "../lib/config.js"
import { toError } from "../lib/util.js"
import { scheduler } from "../lib/scheduler.js"
import { unbanAll, sessionList } from "../lib/auth.js"
import { ticketStatus } from "../lib/remote.js"
import { replyRender } from "../lib/render.js"
import { closeAll as closeAllChats } from "../lib/chat.js"
import {
  buildStatusData,
  statusText,
  buildSettingsData,
  settingsText,
  buildHelpData,
  helpText,
} from "../lib/panel.js"

export class DouyinPanel extends plugin {
  constructor() {
    super({
      name: "抖音续火-面板信息",
      dsc: "状态、设置与帮助",
      event: "message",
      priority: 800,
      rule: [
        { reg: "^#?(dy|抖音)状态$", fnc: "showStatus" },
        { reg: "^#?(dy|抖音)设置", fnc: "settings", permission: "master" },
        { reg: "^#?(dy|抖音)(帮助|菜单)$", fnc: "help" },
      ],
    })
  }

  async showStatus(e) {
    return replyRender(e, "status/status", buildStatusData(e.self_id), statusText(e.self_id))
  }

  async help(e) {
    return replyRender(e, "help/help", buildHelpData(e.self_id), helpText())
  }

  /** 常改的几项支持指令直改，复杂配置（模板、好友备注、多目标）交给面板/锅巴 */
  async settings(e) {
    const rest = e.msg.replace(/^#?(dy|抖音)设置\s*/, "").trim()
    if (!rest)
      return replyRender(e, "settings/settings", buildSettingsData(e.self_id), settingsText(e.self_id))

    const [key, ...args] = rest.split(/\s+/)
    const value = args.join(" ").trim()
    const on = /^(开|开启|启用|on|true|1)$/i.test(value)
    const off = /^(关|关闭|停用|off|false|0)$/i.test(value)

    try {
      switch (key) {
        case "定时":
        case "续火": {
          if (!on && !off) return e.reply("格式：#抖音设置 定时 开/关")
          config.set("spark.enable", on)
          scheduler.reschedule()
          return e.reply(`定时续火已${on ? "开启" : "关闭"}${on ? `，下次 ${scheduler.status().nextTime}` : ""}`)
        }
        case "cron":
        case "定时时间": {
          if (!value) return e.reply("格式：#抖音设置 cron 0 20 8 * * *（6 位，秒在最前）")
          const old = config.get("spark.cron")
          config.set("spark.cron", value)
          const job = scheduler.reschedule()
          // 注册失败说明表达式非法，还原旧值，否则定时任务会静默消失
          if (!job && config.bool("spark.enable", true)) {
            config.set("spark.cron", old)
            scheduler.reschedule()
            return e.reply(`cron 表达式无效，已还原为 ${old}`)
          }
          return e.reply(`cron 已更新为 ${value}，下次执行 ${scheduler.status().nextTime}`)
        }
        case "跳过":
        case "跳过已续火": {
          if (!on && !off) return e.reply("格式：#抖音设置 跳过 开/关")
          config.set("spark.skipIfDone", on)
          return e.reply(
            on
              ? "已开启：定时任务遇到今天已成功续过火的账号会跳过"
              : "已关闭：定时任务每次都会重新发一遍（同一天重复发对火花没有额外收益）"
          )
        }
        case "推送": {
          if (!on && !off) return e.reply("格式：#抖音设置 推送 开/关")
          config.set("push.enable", on)
          return e.reply(`结果推送已${on ? "开启" : "关闭"}`)
        }
        case "推送范围": {
          const target = /^(群|群聊|group)$/i.test(value)
            ? "group"
            : /^(私聊|好友|私信|friend)$/i.test(value)
              ? "friend"
              : /^(两者|都|both|全部)$/i.test(value)
                ? "both"
                : ""
          if (!target) return e.reply("格式：#抖音设置 推送范围 群/私聊/两者")
          config.set("push.target", target)
          return e.reply(
            `推送范围已设为${{ group: "仅群", friend: "仅私聊", both: "群 + 私聊" }[target]}`
          )
        }
        case "推送模式": {
          const mode = /详细|detail/i.test(value) ? "detail" : /简要|summary/i.test(value) ? "summary" : ""
          if (!mode) return e.reply("格式：#抖音设置 推送模式 详细/简要")
          config.set("push.mode", mode)
          return e.reply(`推送模式已设为${mode === "detail" ? "详细（逐条列出发送内容）" : "简要（只报数量）"}`)
        }
        case "渲染":
        case "出图": {
          if (!on && !off) return e.reply("格式：#抖音设置 渲染 开/关")
          config.set("render.image", on)
          return e.reply(`文本渲染成图已${on ? "开启" : "关闭"}${on ? "" : "，之后帮助/设置/状态都发纯文字"}`)
        }
        case "打码":
        case "链接打码": {
          if (!on && !off) return e.reply("格式：#抖音设置 打码 开/关")
          config.set("web.maskLinkInGroup", on)
          return e.reply(
            on
              ? "已开启：群里回复面板地址时只显示打码后的主机（完整地址仍私信发送）。" +
                "用公网 IP 直连的建议保持开启，群里贴一次原样地址等于把机器交给全部群成员扫端口"
              : "已关闭：群里会直接显示完整面板地址。请确认你用的是域名而不是公网 IP"
          )
        }
        case "自动短信":
        case "短信验证": {
          if (!on && !off) return e.reply("格式：#抖音设置 自动短信 开/关")
          config.set("security.autoSms", on)
          return e.reply(
            on
              ? "已开启：抖音要求短信验证时，插件自己点「接收短信验证码 → 发送验证码」，" +
                "再私信跟你要那几位数字，填回页面后自动登录。注意它会真往你绑定的手机发短信。" +
                "只想用一次的话不必开这个，直接发「#抖音自动登录」"
              : "已关闭：「#抖音登录」遇到短信验证会走远程操作页面。「#抖音自动登录」不受这个开关影响，仍然自动接管"
          )
        }
        case "调试":
        case "调试日志": {
          if (!on && !off) return e.reply("格式：#抖音设置 调试 开/关")
          config.set("debug.enable", on)
          return e.reply(
            on
              ? "调试日志已开启：扫码登录与续火的每一步都会在 Yunzai 日志里记一行（带 [调试] 前缀），" +
                "Cookie 的值不会进日志。查完记得关掉，它会让日志量成倍增长"
              : "调试日志已关闭"
          )
        }
        case "快照":
        case "现场快照": {
          if (!on && !off) return e.reply("格式：#抖音设置 快照 开/关")
          config.set("debug.snapshot", on)
          // 快照本身受调试总开关约束（见 lib/debug.js 的 snapshotOn），只开这个不会有文件产出
          if (on && !config.bool("debug.enable", false))
            return e.reply("现场快照已开启，但「调试日志」还是关的，快照不会产出。请再发一次「#抖音设置 调试 开」")
          return e.reply(
            on
              ? "现场快照已开启：关键步骤会把整页截图、页面纯文本与完整 HTML 存到 data/debug/，" +
                "单页 HTML 常有一兆多，按「快照保留文件数」滚动清理"
              : "现场快照已关闭"
          )
        }
        case "加群": {
          const groupId = value || String(e.group_id || "")
          if (!groupId) return e.reply("请在群内使用，或指定群号：#抖音设置 加群 群号")
          const groups = config.get("push.groups", []) || []
          if (groups.some(g => String(g.groupId) === groupId && String(g.botId || "") === String(e.self_id)))
            return e.reply("该群已在推送列表中")
          groups.push({ botId: String(e.self_id), groupId })
          config.set("push.groups", groups)
          return e.reply(`已添加推送群 ${groupId}（由 ${e.self_id} 发送），当前共 ${groups.length} 个`)
        }
        case "删群": {
          const groupId = value || String(e.group_id || "")
          if (!groupId) return e.reply("格式：#抖音设置 删群 群号")
          const groups = (config.get("push.groups", []) || []).filter(g => String(g.groupId) !== groupId)
          config.set("push.groups", groups)
          return e.reply(`已移除推送群 ${groupId}，当前剩 ${groups.length} 个`)
        }
        case "加好友":
        case "加私聊": {
          const userId = value || String(e.user_id || "")
          if (!userId) return e.reply("格式：#抖音设置 加好友 QQ号（不填则用自己）")
          const friends = config.get("push.friends", []) || []
          if (friends.some(f => String(f.userId) === userId && String(f.botId || "") === String(e.self_id)))
            return e.reply("该好友已在推送列表中")
          friends.push({ botId: String(e.self_id), userId })
          config.set("push.friends", friends)
          return e.reply(
            `已添加推送好友 ${userId}（由 ${e.self_id} 发送），当前共 ${friends.length} 个` +
              `${config.pushToFriend() ? "" : "\n注意：当前推送范围是「仅群」，私聊不会收到，可用「#抖音设置 推送范围 两者」"}`
          )
        }
        case "删好友":
        case "删私聊": {
          const userId = value || String(e.user_id || "")
          if (!userId) return e.reply("格式：#抖音设置 删好友 QQ号")
          const friends = (config.get("push.friends", []) || []).filter(f => String(f.userId) !== userId)
          config.set("push.friends", friends)
          return e.reply(`已移除推送好友 ${userId}，当前剩 ${friends.length} 个`)
        }
        case "聊天":
        case "私信聊天": {
          if (!on && !off) return e.reply("格式：#抖音设置 聊天 开/关")
          config.set("chat.enable", on)
          if (off) {
            // 关掉开关不会自动收掉已经开着的会话，那些页面还挂着 Chromium 和账号锁；
            // 而用户关它的意图就是「现在别用抖音登录态」，所以立刻全部收掉
            const closed = await closeAllChats("聊天功能已关闭")
            return e.reply(
              `私信聊天已关闭${closed ? `，并收掉了 ${closed} 个开着的聊天会话` : ""}。` +
                "面板里的聊天入口会消失，已存的聊天记录不删"
            )
          }
          return e.reply(
            "私信聊天已开启：在面板里点一个账号即可进入它的抖音私信。" +
              "注意它会把一个抖音登录态挂上几分钟（默认空闲 3 分钟自动收），风险比续火高"
          )
        }
        case "解封IP":
        case "解封ip":
          return e.reply(`已解封 ${unbanAll()} 个 IP`)
        case "会话": {
          const list = sessionList()
          // 验证链接和面板会话一样是「现在还能用的入口」，一起列出来才看得全
          const tickets = ticketStatus()
          if (!list.length && !tickets.active) return e.reply("当前没有活跃的面板会话与验证链接")
          const lines = []
          if (list.length)
            lines.push(
              "活跃面板会话：",
              ...list.map(s => `· ${s.userId} → ${s.botId || "未选机器人"}｜${s.ip}｜到 ${s.expireAt}`)
            )
          if (tickets.active)
            lines.push(
              `远程验证链接（${tickets.active} 个）：`,
              ...tickets.items.map(
                t => `· ${t.userId}｜${t.opened ? `已打开，操作 ${t.acts} 次` : "尚未打开"}｜到 ${t.expireAt}`
              )
            )
          return e.reply(lines.join("\n"))
        }
        default:
          return e.reply(`未知设置项「${key}」，发送「#抖音设置」查看可用项`)
      }
    } catch (error) {
      return e.reply(`设置失败：${toError(error).message}`)
    }
  }
}

/**
 * 供外部（锅巴保存、手改 yaml 后）调用，让配置与 cron 立刻生效。
 *
 * 必须写成箭头函数：loader 只用 `if (!p?.prototype) return` 过滤导出（loader.js:131），
 * 普通 function 有 prototype，会被当成插件类 new 两次并读 `rule.length` 而报错。
 */
export const applyConfigChange = () => {
  config.reload()
  scheduler.reschedule()
}
