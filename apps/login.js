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
    await e.reply("正在启动浏览器获取抖音二维码，请稍候…")

    let replied = false
    try {
      await startQrLogin(e.self_id, {
        accountName: name,
        onQrcode: async base64 => {
          replied = true
          const buffer = Buffer.from(base64.split(",")[1] || "", "base64")
          await e.reply([segment.image(buffer), "\n请用抖音 App 扫码并确认登录，完成后会自动保存 Cookie"])
        },
        onStatus: async (status, message) => {
          if (status === "success") await e.reply(`✅ ${message}，可发送「#抖音账号」查看`)
          else if (["failed", "expired"].includes(status)) await e.reply(`❌ ${message}`)
        },
      })
    } catch (error) {
      return e.reply(`扫码登录启动失败：${toError(error).message}`)
    }

    // 15 秒还没出码就提示一声，别让用户干等
    setTimeout(() => {
      if (!replied)
        e.reply("二维码仍在获取中，若长时间无响应可改用「#抖音文件登录 账号名」").catch(() => {})
    }, 15000)
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
