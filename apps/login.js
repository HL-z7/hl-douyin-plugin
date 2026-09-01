/**
 * 抖音账号登录与凭证维护指令。
 *
 * 三条登录路径，覆盖不同场景：
 * - 扫码：`#抖音登录`，浏览器自动抓 Cookie，最省事
 * - 粘贴：`#抖音手动登录 账号名 Cookie`，短 Cookie 直接贴
 * - 文件：`#抖音文件登录 账号名` + 发一个 txt，QQ 输入框对超长文本会截断，
 *         抖音的完整 Cookie 常常超过限制，贴进去就是残缺的——用文件传才可靠
 *
 * Cookie 等同于账号本体，所以群里一律拒收：出现了就尝试撤回并要求私聊重发。
 */
import fs from "node:fs"
import path from "node:path"
import common from "../../../lib/common/common.js"
import { config } from "../lib/config.js"
import { toError, ensureDir, dataDir, safeFileName, log } from "../lib/util.js"
import { store, parseCookieInput } from "../lib/store.js"
import { audit } from "../lib/audit.js"
import { isRunning } from "../lib/spark.js"
import { startQrLogin, manualLogin, checkAccount } from "../lib/login.js"
import { sendPrivate } from "../lib/bot.js"
import { revokeTicket } from "../lib/remote.js"

/** 下载来的 Cookie 文件落在这里，解析完立刻删掉（security.deleteCookieFile） */
const tmpDir = ensureDir(dataDir, "tmp")

export class DouyinLogin extends plugin {
  constructor() {
    super({
      name: "抖音续火-登录",
      dsc: "抖音扫码/手动/文件登录与凭证检查",
      event: "message",
      priority: 800,
      rule: [
        { reg: "^#?(dy|抖音)(文件|txt|TXT)登录", fnc: "fileLogin", permission: "master" },
        { reg: "^#?(dy|抖音)手动登录", fnc: "manualLogin", permission: "master" },
        { reg: "^#?(dy|抖音)(扫码)?登录", fnc: "qrLogin", permission: "master" },
        { reg: "^#?(dy|抖音)(检查|验证)(cookie|CK|ck)?$", fnc: "checkCookies", permission: "master" },
        { reg: "^#?(dy|抖音)账号(列表)?$", fnc: "listAccounts", permission: "master" },
        { reg: "^#?(dy|抖音)删除账号", fnc: "removeAccount", permission: "master" },
      ],
    })
  }

  /** 扫码登录：二维码用图片发回，状态变化再补一条 */
  async qrLogin(e) {
    const name = e.msg.replace(/^#?(dy|抖音)(扫码)?登录\s*/, "").trim()
    const waitSec = config.num("security.qrLoginTimeout", 180, { min: 30, max: 600 })
    await e.reply("正在启动浏览器获取抖音二维码，请稍候…")

    let replied = false
    try {
      await startQrLogin(e.self_id, {
        accountName: name,
        // 抖音弹验证时远程操作链接只私信发给发起人，不能发在群里
        userId: e.user_id,
        // 抖音的二维码约 60 秒换一张，换了就补发——QQ 里那张图不会自己更新，
        // 用户扫到作废的码会一直等不到结果
        onQrcode: async (base64, round) => {
          replied = true
          const buffer = Buffer.from(base64.split(",")[1] || "", "base64")
          const tip =
            round > 1
              ? "\n上一张二维码已过期，请扫这张新的"
              : `\n请用抖音 App 扫码并确认登录，完成后会自动保存 Cookie。\n本次登录最多等待 ${waitSec} 秒，超时后重新发送指令即可。`
          await e.reply([segment.image(buffer), tip])
        },
        onStatus: async (status, message) => {
          if (status === "success") await e.reply(`✅ ${message}，可发送「#抖音账号」查看`)
          else if (status === "scanned") await e.reply("📱 已收到扫码，请在手机上点「确认登录」")
          // 确认之后 Cookie 还要等页面跳一趟才落盘，这一句避免用户以为又卡住了
          else if (status === "confirmed") await e.reply("🔑 已确认登录，正在取凭证，请稍等几秒…")
          // verify 的正文由 onVerify 私信发，这里群里只留一句不含链接的提示
          else if (status === "verify") await e.reply(`⚠️ ${message}`)
          else if (["failed", "expired"].includes(status)) await e.reply(`❌ ${message}`)
        },
        onVerify: link => sendVerifyLink(e, link),
      })
    } catch (error) {
      return e.reply(`扫码登录启动失败：${toError(error).message}`)
    }

    // 出码要真开浏览器加载抖音首页，实测 20 秒上下，25 秒还没动静才提示一声
    setTimeout(() => {
      if (!replied)
        e.reply("二维码仍在获取中，若长时间无响应可改用「#抖音文件登录 账号名」").catch(() => {})
    }, 25000)
  }

  /** 手动登录：群里出现 Cookie 属于泄露，直接拒收并提示撤回 */
  async manualLogin(e) {
    const rest = e.msg.replace(/^#?(dy|抖音)手动登录\s*/, "").trim()
    if (e.isGroup) return rejectInGroup(e, rest, "#抖音手动登录 账号名 Cookie")

    if (!rest)
      return e.reply(
        [
          "手动登录格式：",
          "#抖音手动登录 账号名 Cookie",
          "",
          "Cookie 获取：浏览器登录抖音 → F12 → Console → 输入 document.cookie → 复制结果",
          "⚠️ QQ 输入框会截断超长文本，Cookie 很长时请改用「#抖音文件登录 账号名」发 txt 文件。",
        ].join("\n")
      )

    const idx = rest.search(/\s/)
    if (idx < 0) return e.reply("缺少 Cookie 内容，格式：#抖音手动登录 账号名 Cookie")

    return saveCookie(e, rest.slice(0, idx).trim(), rest.slice(idx + 1).trim(), "text")
  }

  /**
   * 文件登录：先记住账号名并挂上下文，再等用户把 txt 发过来。
   * loader 的 deal() 里 context hook 优先于 rule 匹配（lib/plugins/loader.js:205），
   * 所以挂上下文期间用户发的下一条消息会直接进 `receiveCookieFile`。
   */
  async fileLogin(e) {
    const name = e.msg.replace(/^#?(dy|抖音)(文件|txt|TXT)登录\s*/, "").trim()
    if (e.isGroup) return rejectInGroup(e, "", "#抖音文件登录 账号名")
    if (!name) return e.reply("格式：#抖音文件登录 账号名\n随后把存有 Cookie 的 txt 文件发过来")
    if (!config.bool("security.allowManualCookie", true))
      return e.reply("管理员已关闭手动 Cookie 导入")

    this.setContext("receiveCookieFile", false, 180, "等待 Cookie 文件超时，已取消本次导入")
    this.e.dyAccountName = name
    return e.reply(
      [
        `已记住账号名「${name}」，请在 3 分钟内发送 txt 文件。`,
        "",
        "文件做法：浏览器登录抖音 → F12 → Console → document.cookie → 复制结果",
        "粘贴进记事本另存为 .txt（编码选 UTF-8），然后把文件发给我。",
        "发送「取消」可中止。",
      ].join("\n")
    )
  }

  /** 上下文回调：这条消息要么带文件，要么是取消 */
  async receiveCookieFile() {
    const e = this.e
    const name = String(this.getContext("receiveCookieFile")?.dyAccountName || "").trim()

    if (/^(取消|cancel|退出)$/i.test(String(e.msg || "").trim())) {
      this.finish("receiveCookieFile")
      return e.reply("已取消文件登录")
    }
    // 没带文件就继续等，避免用户随便说句话就把上下文丢了
    if (!e.file) return e.reply("请直接发送 txt 文件，或发送「取消」中止")

    this.finish("receiveCookieFile")

    const filePath = path.join(tmpDir, `${safeFileName(name || e.user_id)}-${Date.now()}.txt`)
    try {
      const url = await resolveFileUrl(e)
      if (!url) return e.reply("文件链接获取失败，请改用「#抖音手动登录 账号名 Cookie」")
      if (!(await common.downFile(url, filePath))) return e.reply("文件下载失败，请重新发送")

      const text = fs.readFileSync(filePath, "utf8")
      if (!text.trim()) return e.reply("文件内容为空，请确认 Cookie 已保存进去")
      return await saveCookie(e, name, text, "file")
    } catch (error) {
      return e.reply(`读取文件失败：${toError(error).message}`)
    } finally {
      // Cookie 明文不该在磁盘上多留一秒
      if (config.bool("security.deleteCookieFile", true)) {
        try {
          fs.rmSync(filePath, { force: true })
        } catch (error) {
          log("warn", "临时 Cookie 文件删除失败：", error.message)
        }
      }
    }
  }

  /** 逐个检查凭证。结果按 spark.cookieCheckTTL 缓存，短时间重复检查不会再打抖音 */
  async checkCookies(e) {
    const accounts = store.list(e.self_id)
    if (!accounts.length) return e.reply("没有可检查的账号")
    await e.reply(`开始检查 ${accounts.length} 个账号的 Cookie，需要逐个打开抖音，请稍候…`)
    const lines = []
    for (const acc of accounts) {
      try {
        const r = await checkAccount(e.self_id, acc.id)
        lines.push(`${r.ok ? "✅" : "❌"} ${acc.name}：${r.message}`)
      } catch (error) {
        lines.push(`❌ ${acc.name}：${toError(error).message}`)
      }
    }
    return e.reply(lines.join("\n"))
  }

  async listAccounts(e) {
    const accounts = store.list(e.self_id)
    if (!accounts.length) return e.reply("当前机器人还没有抖音账号，发送「#抖音登录」开始")
    const lines = [`🎬 抖音账号（${e.self_id}）共 ${accounts.length} 个`]
    for (const acc of accounts) {
      const flag = !acc.hasCookie
        ? "缺 Cookie"
        : acc.cookieInvalid
          ? "凭证失效"
          : acc.enable === false
            ? "已停用"
            : "正常"
      lines.push("─────────")
      lines.push(`${acc.name}｜${flag}${isRunning(e.self_id, acc.id) ? "｜运行中" : ""}`)
      lines.push(`好友：${acc.targets?.length ? acc.targets.map(targetLine).join("、") : "未配置"}`)
      if (acc.lastRun)
        lines.push(
          `上次：${acc.lastRun.ok ? "成功" : "失败"} 发 ${acc.lastRun.sent?.length || 0} 条` +
            `${acc.lastRun.error ? `（${acc.lastRun.error.slice(0, 40)}）` : ""}`
        )
    }
    return e.reply(lines.join("\n"))
  }

  async removeAccount(e) {
    const name = e.msg.replace(/^#?(dy|抖音)删除账号\s*/, "").trim()
    if (!name) return e.reply("格式：#抖音删除账号 账号名")
    const acc = store.findByName(e.self_id, name)
    if (!acc) return e.reply(`未找到账号「${name}」`)
    store.remove(e.self_id, acc.id)
    audit.add("account.remove", { botId: e.self_id, userId: e.user_id, accountId: acc.id, account: acc.name })
    return e.reply(`已删除账号「${name}」及其 Cookie`)
  }
}

/** 好友的一行展示：主名 + 备注/别名，和状态面板保持一致的写法 */
function targetLine(target) {
  if (target?.note) return `${target.name}（${target.note}）`
  if (target?.alias?.length) return `${target.name} / ${target.alias.join(" / ")}`
  return target?.name || ""
}

/**
 * 把远程验证链接私信给发起人。
 *
 * 只私信，一个字都不进群：这条链接落在公网可达的地址上，谁点开谁就能操作那个
 * 正在登录的浏览器。所以它和 `#抖音web` 的验证码一样——发不出去就当场作废，
 * 留着只是多一个可被爆破的目标（同 apps/web.js 的 openWeb）。
 */
async function sendVerifyLink(e, link) {
  const minutes = Math.max(1, Math.round((link.ttl || 600) / 60))
  const msg = [
    "🔓 抖音要求补充验证，已为你开一个远程操作页面\n\n",
    `验证类型：${link.hint}\n`,
    `链接：${link.url}\n`,
    `有效期：${minutes} 分钟，仅本次登录可用\n\n`,
    "用法：点开链接就能看到那个浏览器的实时画面，直接在图上点、拖、打字，\n",
    "和你自己操作浏览器一样。验证过掉之后 Cookie 会自动保存，页面会提示成功。\n\n",
    "⚠️ 请勿转发。链接绑定你打开时的 IP，页面里也进不了管理面板。\n",
    "发送「#抖音web下线」可立即作废。",
  ].join("")

  try {
    await sendPrivate(e.self_id, e.user_id, msg)
    // 现场截图另发一条：跟链接挤在一条消息里，长文本容易把图挤到看不见。
    // 读成 buffer 而不是传 file:// 路径——各适配器对本地路径的支持不一致，buffer 都认
    if (link.shot) {
      try {
        await sendPrivate(e.self_id, e.user_id, [
          "验证界面现场：",
          segment.image(fs.readFileSync(link.shot)),
        ])
      } catch {}
    }
    // 群里那句提示由 onStatus 的 verify 分支发（它不含链接），这里不重复说一遍
  } catch (error) {
    revokeTicket(link.token)
    await e.reply(
      `❌ 私信发送验证链接失败（${toError(error).message}），已作废该链接。\n` +
        "请先加机器人好友或允许临时会话，也可以改用「#抖音文件登录 账号名」导入 Cookie。"
    )
  }
}

/** 群内一律拒收 Cookie：带内容的先尝试撤回，再提示私聊 */
async function rejectInGroup(e, rest, usage) {
  if (rest) {
    try {
      await e.recall?.()
    } catch {}
    return e.reply("⚠️ 请勿在群内发送 Cookie，已尝试撤回。请私聊机器人重新发送。", true)
  }
  return e.reply(`请私聊机器人使用该指令，格式：${usage}`, true)
}

/**
 * 文件下载直链。ICQQ 的群文件与好友文件取法不同，
 * 少数适配器直接把 http 链接放在 e.file.url 上，所以三条路都要试。
 */
async function resolveFileUrl(e) {
  const direct = e.file?.url
  if (direct && /^https?:\/\//.test(String(direct))) return String(direct)
  if (e.group?.getFileUrl) return await e.group.getFileUrl(e.file.fid)
  if (e.friend?.getFileUrl) return await e.friend.getFileUrl(e.file.fid)
  return ""
}

/** 解析 + 落盘的公共收尾，三条登录路径共用同一套报错文案 */
async function saveCookie(e, name, cookie, source) {
  if (!name) return e.reply("缺少账号名")
  try {
    // 先解析一遍，格式不对在写盘前就报出来
    parseCookieInput(cookie)
    const account = manualLogin(e.self_id, { name, cookie, source })
    return e.reply(
      `✅ 已保存账号「${account.name}」，Cookie 已加密落盘。\n` +
        "下一步：发送「#抖音web」在面板里配置续火好友，或用「#抖音加好友 账号名 昵称」。"
    )
  } catch (error) {
    return e.reply(`导入失败：${toError(error).message}`)
  }
}
