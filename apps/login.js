/**
 * 抖音账号登录与凭证维护指令。
 *
 * 位置：指令层，只做「解析参数 → 调 lib/login.js 与 lib/store.js → 回消息」，
 * 浏览器操作、Cookie 解析与加密落盘都在 lib 内。
 * 协作模块：lib/login.js（扫码/短信/凭证检查）、lib/store.js（账号与 Cookie 落盘）、
 * lib/bot.js（私信发送）、lib/remote.js（远程验证票据）、lib/spark.js（账号占用状态）、
 * lib/audit.js（审计）。
 *
 * 四条登录路径，覆盖不同场景：
 * - 扫码：`#抖音登录`，浏览器抓 Cookie 后自动落盘
 * - 自动：`#抖音自动登录`，扫码之外再接管短信验证——抖音弹「身份验证」时插件自己点
 *         「接收短信验证码 → 发送验证码」，只向发起人索取验证码数字。异地登录、账号有
 *         风控标记的号常卡在这一步，这条路不需要打开任何链接
 * - 粘贴：`#抖音手动登录 账号名 Cookie`，适合短 Cookie
 * - 文件：`#抖音文件登录 账号名` + 发一个 txt。QQ 输入框会截断超长文本，而抖音完整
 *         Cookie 常超出该限制，粘贴进去即残缺，因此长 Cookie 必须用文件传
 *
 * Cookie 等同于账号本体，因此群内一律拒收：出现即尝试撤回并要求私聊重发。
 */
import fs from "node:fs"
import path from "node:path"
import common from "../../../lib/common/common.js"
import { config } from "../lib/config.js"
import { toError, ensureDir, dataDir, safeFileName, log } from "../lib/util.js"
import { store, parseCookieInput } from "../lib/store.js"
import { audit } from "../lib/audit.js"
import { isRunning } from "../lib/spark.js"
import { startQrLogin, manualLogin, checkAccount, submitSmsCode } from "../lib/login.js"
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
        // 文件登录单开一条指令而不复用 `#抖音手动登录`：后者的正则会把后续参数当成
        // Cookie 位置的内容吞掉。这里只收账号名，txt 由随后挂的上下文接收
        { reg: "^#?(dy|抖音)(文件|txt|TXT)登录", fnc: "fileLogin", permission: "master" },
        { reg: "^#?(dy|抖音)手动登录", fnc: "manualLogin", permission: "master" },
        // 必须排在扫码登录前面：`^#?(dy|抖音)(扫码)?登录` 不是全字匹配，
        // 「抖音自动登录」里的「登录」会被它先吃掉
        { reg: "^#?(dy|抖音)自动登录", fnc: "autoLogin", permission: "master" },
        { reg: "^#?(dy|抖音)(扫码)?登录", fnc: "qrLogin", permission: "master" },
        { reg: "^#?(dy|抖音)(检查|验证)(cookie|CK|ck)?$", fnc: "checkCookies", permission: "master" },
        { reg: "^#?(dy|抖音)账号(列表)?$", fnc: "listAccounts", permission: "master" },
        { reg: "^#?(dy|抖音)删除账号", fnc: "removeAccount", permission: "master" },
      ],
    })
  }

  /**
   * 扫码登录：二维码用图片发回，状态变化再补一条文本。
   * @param {object} e 消息事件
   * @returns {Promise<*>} startLogin 的结果
   */
  qrLogin(e) {
    return this.startLogin(e, e.msg.replace(/^#?(dy|抖音)(扫码)?登录\s*/, "").trim())
  }

  /**
   * 自动登录 = 扫码登录 + 插件接管短信验证。
   *
   * 与 `#抖音登录` 只差一个 autoSms 标志，因此走同一个 startLogin，不另写一套流程。
   * 传 true 表示显式打开，不读 security.autoSms。
   * 它会真的向用户绑定的手机发一条短信（仅在抖音主动要求验证时才发）。
   *
   * @param {object} e 消息事件
   * @returns {Promise<*>} startLogin 的结果
   */
  autoLogin(e) {
    return this.startLogin(e, e.msg.replace(/^#?(dy|抖音)自动登录\s*/, "").trim(), true)
  }

  /**
   * 扫码登录的公共主体，两条扫码指令共用。
   *
   * @param {object} e 消息事件
   * @param {string} name 账号名，留空则登录成功后读抖音昵称
   * @param {boolean} [autoSms] 是否接管短信验证。undefined 时跟随 security.autoSms
   * @returns {Promise<*>} 启动失败时为报错回复，否则为 undefined
   */
  async startLogin(e, name, autoSms) {
    const waitSec = config.num("security.qrLoginTimeout", 180, { min: 30, max: 600 })
    await e.reply("正在启动浏览器获取抖音二维码，请稍候…")

    let replied = false
    try {
      await startQrLogin(e.self_id, {
        accountName: name,
        // 抖音弹验证时远程操作链接只私信发给发起人，不能进群
        userId: e.user_id,
        autoSms,
        // 抖音二维码约 60 秒换一张，换了就补发一张图：QQ 里已发出的图片不会自己更新，
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
          // 确认之后 Cookie 还要等页面跳转一趟才落盘，这一句用于说明中间的空档
          else if (status === "confirmed") await e.reply("🔑 已确认登录，正在取凭证，请稍等几秒…")
          // verify 的正文由 onVerify 私信发，这里在当前会话只留一句不含链接的提示
          else if (status === "verify") await e.reply(`⚠️ ${message}`)
          // sms 的正文由 onSmsRequest 发（它还要挂上下文），此处不重复
          else if (["failed", "expired"].includes(status)) await e.reply(`❌ ${message}`)
        },
        // 箭头函数：setContext/finish 是 plugin 实例方法，而这个回调由 lib/login.js
        // 内部触发，必须闭包住这里的 this
        onSmsRequest: info => this.askSmsCode(e, info),
        onVerify: link => sendVerifyLink(e, link),
      })
    } catch (error) {
      return e.reply(`扫码登录启动失败：${toError(error).message}`)
    }

    // 出码要真开浏览器加载抖音首页，慢机器上实测超过 45 秒（passport 的 JS 与首页推荐流
    // 抢主线程），因此这条提示只说明仍在进行，不代表已经失败
    setTimeout(() => {
      if (!replied)
        e.reply("二维码仍在获取中（慢机器上出码可能要一分钟），若最终报错可改用「#抖音文件登录 账号名」").catch(() => {})
    }, 25000)
  }

  /**
   * 短信已下发，挂上下文等用户把验证码发回来。
   *
   * 上下文一律按私聊键（setContext 第二参 isGroup=false → conKey 用 user_id，
   * 框架 lib/plugins/plugin.js:72-73），因此用户在群里回、私聊回都能对上同一个会话；
   * 而 loader 的 context hook 在 rule 匹配之前执行（框架 lib/plugins/loader.js:236-250），
   * 那条纯数字消息不会被别的插件抢走。
   *
   * 提示优先私信：验证码用完即废，但没必要让整个群看见「某人正在登录哪个号」。
   * 私信发不出去（未加好友、临时会话被拒）就退回当前会话，优于让用户干等超时。
   *
   * @param {object} e 消息事件
   * @param {object} info lib/login.js 的 onSmsRequest 载荷
   * @param {string} info.sessionId 登录会话 id，提交验证码时要带回
   * @param {string} [info.phone] 抖音页面上显示的打码手机号
   * @param {number} [info.ttl] 会话剩余秒数，来自 security.verifyTimeout
   */
  async askSmsCode(e, { sessionId, phone, ttl }) {
    // 上下文超时比会话期限早 10 秒收尾：先由这里回一句「已超时」，避免用户刚看到
    // 「超时已取消」又收到会话那边的 expired 提示，像是出了两次错
    const wait = Math.max(60, Number(ttl || 600) - 10)
    this.setContext("receiveSmsCode", false, wait, "等待验证码超时，本次自动登录已取消")
    this.e.dySessionId = sessionId

    const msg = [
      "📨 抖音要求短信验证，我已经替你点了「发送验证码」",
      `验证码已发到${phone ? ` ${phone}` : "你绑定的手机"}，请把收到的验证码发给我（直接发数字即可），我填进页面提交。`,
      `${Math.max(1, Math.round(wait / 60))} 分钟内有效，发送「取消」可中止。`,
    ].join("\n")

    try {
      await sendPrivate(e.self_id, e.user_id, msg)
      if (e.isGroup) await e.reply("⚠️ 抖音要求短信验证，验证码怎么发已私信告诉你了", true)
    } catch {
      await e.reply(msg, true)
    }
  }

  /**
   * 上下文回调：这条消息要么是验证码，要么是取消。
   * sessionId 从 setContext 存下的事件对象上取回（getContext 返回的就是当时那个 e）。
   * @returns {Promise<*>} e.reply 的结果
   */
  async receiveSmsCode() {
    const e = this.e
    const text = String(e.msg || "").trim()
    const sessionId = String(this.getContext("receiveSmsCode")?.dySessionId || "")

    if (/^(取消|cancel|退出)$/i.test(text)) {
      this.finish("receiveSmsCode")
      // 不主动取消登录会话，留给它自己的超时兜底收尾：在这里强行取消会连带关掉浏览器页面，
      // 而用户可能只是想换个方式过验证（比如自己打开远程验证页面）
      return e.reply("已取消填写验证码，本次登录会在超时后自动结束")
    }
    // 不像验证码的消息就继续等：随便说句话不该丢掉上下文；但也不能默默吞掉，
    // 回一句提示用户才知道机器人仍在等
    if (!/^\D{0,6}\d{4,8}\D{0,6}$/.test(text)) return e.reply("请把短信里的验证码发给我（4~8 位数字），或发送「取消」中止")

    const r = await submitSmsCode(sessionId, text)
    // 还能重试就留着上下文，用户可直接再发一次；否则收尾
    if (!r.retry) this.finish("receiveSmsCode")
    return e.reply(`${r.ok ? "✅" : "❌"} ${r.message}`)
  }

  /**
   * 手动登录：`#抖音手动登录 账号名 Cookie`。
   * 群内出现 Cookie 属于凭证泄露，直接拒收并提示撤回。
   * @param {object} e 消息事件
   * @returns {Promise<*>} e.reply 的结果
   */
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
   *
   * loader 的 deal() 里 context hook 在 rule 匹配之前执行
   * （框架 lib/plugins/loader.js:236-250），因此挂上下文期间用户发的下一条消息（带 e.file）
   * 会直接进 `receiveCookieFile`，不需要为文件消息另配 rule。
   *
   * @param {object} e 消息事件
   * @returns {Promise<*>} e.reply 的结果
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

  /**
   * 上下文回调：这条消息要么带文件，要么是取消。
   * 账号名从 setContext 存下的事件对象上取回。
   * @returns {Promise<*>} e.reply 的结果
   */
  async receiveCookieFile() {
    const e = this.e
    const name = String(this.getContext("receiveCookieFile")?.dyAccountName || "").trim()

    if (/^(取消|cancel|退出)$/i.test(String(e.msg || "").trim())) {
      this.finish("receiveCookieFile")
      return e.reply("已取消文件登录")
    }
    // 没带文件就继续等，避免用户随便说句话就丢掉上下文
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
      // Cookie 明文不在磁盘上多留：下载→解析完即删（security.deleteCookieFile，默认 true）。
      // 放在 finally 里，解析抛错的那条路也会清掉
      if (config.bool("security.deleteCookieFile", true)) {
        try {
          fs.rmSync(filePath, { force: true })
        } catch (error) {
          log("warn", "临时 Cookie 文件删除失败：", error.message)
        }
      }
    }
  }

  /**
   * 逐个检查账号凭证是否仍然有效。
   * 每个账号都要真开浏览器访问抖音，因此串行执行；结论按 spark.cookieCheckTTL
   * （默认 30 分钟）缓存在 store 里，缓存期内重复检查不会再请求抖音。
   * @param {object} e 消息事件
   * @returns {Promise<*>} 汇总结果的回复
   */
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

  /**
   * 账号列表：名称、可用状态、续火好友与上次结果。
   * 状态优先级：缺 Cookie > 凭证失效 > 已停用 > 正常；「运行中」另取自 lib/spark.js
   * 的账号锁（续火或聊天窗占用同一把锁）。
   * @param {object} e 消息事件
   * @returns {Promise<*>} e.reply 的结果
   */
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

  /**
   * 按账号名删除账号及其 Cookie。store.remove 会连带清掉该账号的聊天记录。
   * @param {object} e 消息事件
   * @returns {Promise<*>} e.reply 的结果
   */
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

/**
 * 好友的一行展示：主名 + 备注/别名，与状态面板（lib/panel.js）保持同一写法。
 * @param {{name?: string, note?: string, alias?: string[]}} target 续火目标
 * @returns {string} 无 name 时返回空串
 */
function targetLine(target) {
  if (target?.note) return `${target.name}（${target.note}）`
  if (target?.alias?.length) return `${target.name} / ${target.alias.join(" / ")}`
  return target?.name || ""
}

/**
 * 把远程验证链接私信给发起人。
 *
 * 只私信，一个字都不进群：这条链接落在公网可达的地址上，谁点开谁就能操作那个正在登录的
 * 浏览器。因此它与 `#抖音web` 的验证码同一处置原则——发不出去就当场作废，留着只是多一个
 * 可被爆破的目标（同 apps/web.js 的 openWeb）。
 *
 * @param {object} e 消息事件
 * @param {object} link lib/login.js 的 onVerify 载荷
 * @param {string} link.url 远程操作页面地址，token 在 hash 里
 * @param {string} link.token 票据 token，私信失败时用它撕票
 * @param {number} [link.ttl] 有效期秒数，来自 security.verifyTimeout
 * @param {string} link.hint 验证类型描述，写进提示让用户先知道要过哪一道
 * @param {string} [link.shot] 现场截图的本地路径，可能为空串
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
    // 现场截图另发一条：与链接挤在同一条消息里时，长文本容易把图挤到看不见。
    // 读成 buffer 而不是传 file:// 路径——各适配器对本地路径的支持不一致，buffer 都认
    if (link.shot) {
      try {
        await sendPrivate(e.self_id, e.user_id, [
          "验证界面现场：",
          segment.image(fs.readFileSync(link.shot)),
        ])
      } catch {}
    }
    // 群里那句提示由 startLogin 的 onStatus verify 分支发（不含链接），此处不重复
  } catch (error) {
    revokeTicket(link.token)
    await e.reply(
      `❌ 私信发送验证链接失败（${toError(error).message}），已作废该链接。\n` +
        "请先加机器人好友或允许临时会话，也可以改用「#抖音文件登录 账号名」导入 Cookie。"
    )
  }
}

/**
 * 群内一律拒收 Cookie：带内容的先尝试撤回，再提示私聊。
 * @param {object} e 消息事件
 * @param {string} rest 指令后的剩余文本，非空即认为已经把 Cookie 发进群了
 * @param {string} usage 正确用法，回复里原样给出
 * @returns {Promise<*>} e.reply 的结果
 */
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
 * 取文件下载直链。
 * ICQQ 的群文件与好友文件取法不同，少数适配器直接把 http 链接放在 e.file.url 上，
 * 因此三条路依次尝试。
 * @param {object} e 带 file 的消息事件
 * @returns {Promise<string>} 直链；三条路都不通时返回空串
 */
async function resolveFileUrl(e) {
  const direct = e.file?.url
  if (direct && /^https?:\/\//.test(String(direct))) return String(direct)
  if (e.group?.getFileUrl) return await e.group.getFileUrl(e.file.fid)
  if (e.friend?.getFileUrl) return await e.friend.getFileUrl(e.file.fid)
  return ""
}

/**
 * 解析 + 落盘的公共收尾，手动登录与文件登录共用同一套报错文案。
 * @param {object} e 消息事件
 * @param {string} name 账号名
 * @param {string} cookie 原始 Cookie 文本
 * @param {"text"|"file"} source 来源，只写进审计日志
 * @returns {Promise<*>} e.reply 的结果
 */
async function saveCookie(e, name, cookie, source) {
  if (!name) return e.reply("缺少账号名")
  try {
    // 先解析一遍：格式不对要在写盘前就报出来，不能让残缺 Cookie 落进账号文件
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
