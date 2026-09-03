/**
 * 续火执行与好友（续火目标）管理指令。
 *
 * 位置：指令层，只做「解析参数 → 调 lib/spark.js 与 lib/store.js → 回消息」，
 * 浏览器操作、搜索重试与落盘都在 lib 内。
 * 协作模块：lib/spark.js（runBot 逐账号续火）、lib/store.js（账号与续火目标）、
 * lib/scheduler.js（只读 busy 判断有无任务在跑）、lib/push.js（结果分类与推送）、
 * lib/util.js（formatDuration / 错误归一）。
 *
 * 好友这块的重点是「改名不断火」：目标存的是 `{name, alias[], note}`（SparkTarget，
 * 定义见 lib/store.js:71-81），备注只用于展示，别名参与搜索。抖音昵称一改，主名搜不到时
 * 会自动试别名，命中后把新名提为主名（lib/store.js 的 promoteAlias），下次直接用新名搜。
 */
import { log, toError, formatDuration } from "../lib/util.js"
import { store, targetLabel, normalizeTargets } from "../lib/store.js"
import { scheduler } from "../lib/scheduler.js"
import { runBot } from "../lib/spark.js"
import { pushReport, classify } from "../lib/push.js"

export class DouyinSpark extends plugin {
  constructor() {
    super({
      name: "抖音续火-续火",
      dsc: "手动续火与续火好友管理",
      event: "message",
      priority: 800,
      rule: [
        { reg: "^#?(dy|抖音)(立即)?续火", fnc: "runNow", permission: "master" },
        { reg: "^#?(dy|抖音)加好友", fnc: "addFriend", permission: "master" },
        { reg: "^#?(dy|抖音)删好友", fnc: "removeFriend", permission: "master" },
        { reg: "^#?(dy|抖音)备注", fnc: "noteFriend", permission: "master" },
      ],
    })
  }

  /**
   * 手动续火：为当前机器人下所有启用的账号各跑一轮。
   *
   * 默认不跳过——用户主动敲指令就是想现在发一次；`#抖音续火 跳过` 才按「今天已成功过就
   * 不再发」的规则走，用于补跑漏掉的定时任务。定时任务读的是 `spark.skipIfDone`，与这里
   * 的判定互不影响。
   *
   * 先抢 scheduler.busy 而不是直接跑：并行续火会同时开多个 Chromium，家用机内存扛不住，
   * 也更容易被抖音风控（互斥锁在 lib/scheduler.js 的 #busy）。
   *
   * @param {object} e 消息事件
   * @returns {Promise<*>} e.reply 的结果
   */
  async runNow(e) {
    if (scheduler.busy) return e.reply("已有续火任务在执行中，请稍后")
    const skipIfDone = /跳过|skip/i.test(e.msg)
    const accounts = store.list(e.self_id).filter(a => a.enable !== false)
    if (!accounts.length) return e.reply("当前机器人没有启用的抖音账号")

    await e.reply(
      `开始为 ${accounts.length} 个账号续火${skipIfDone ? "（今天已续过的会跳过）" : ""}，完成后会推送结果…`
    )
    try {
      const results = await runBot(e.self_id, { skipIfDone })
      const stat = classify(results)
      const spent = results.reduce((n, r) => n + (r.durationMs || 0), 0)
      // 推送失败不影响这条指令的回复：结果下面还会原样回给发起人，只记一行日志
      await pushReport(e.self_id, results).catch(error => log("warn", "推送失败：", error.message))

      const lines = [
        `续火完成：成功 ${stat.ok.length}/${results.length}` +
          `${stat.skipped.length ? `（跳过 ${stat.skipped.length}）` : ""}，` +
          `共发送 ${stat.sentTotal} 条，用时 ${formatDuration(spent)}`,
      ]
      // 改名自愈单独列出：目标名已被 promoteAlias 改写，用户需要知道存的是哪个名字了
      for (const r of stat.renamed) lines.push(`🔄 好友改名已自动更新：${r.from} → ${r.to}`)
      for (const r of stat.fail) lines.push(`❌ ${r.account}：${(r.error || "").slice(0, 60)}`)
      return e.reply(lines.join("\n"))
    } catch (error) {
      return e.reply(`续火失败：${toError(error).message}`)
    }
  }

  /**
   * 加好友。名称部分交给 store 的文本语法解析，一条指令能同时给别名与备注：
   * - `#抖音加好友 小号 张三(表妹)`      → 备注「表妹」
   * - `#抖音加好友 小号 张三三=张三`      → 主名「张三三」，别名「张三」
   *
   * 语法定义在 lib/store.js 的 parseTargetText，备注还支持全角括号与 ｜/| 竖线。
   *
   * @param {object} e 消息事件
   * @returns {Promise<*>} e.reply 的结果
   */
  async addFriend(e) {
    const rest = e.msg.replace(/^#?(dy|抖音)加好友\s*/, "").trim()
    const [accountName, friendText] = splitFirst(rest)
    if (!accountName || !friendText)
      return e.reply(
        [
          "格式：#抖音加好友 账号名 好友昵称",
          "",
          "备注写法：#抖音加好友 小号 张三(表妹)",
          "别名写法：#抖音加好友 小号 新昵称=旧昵称（旧名搜不到时自动试新名，反之亦然）",
        ].join("\n")
      )

    return withAccount(e, accountName, acc => {
      const saved = store.editTarget(e.self_id, acc.id, "add", { name: friendText })
      // 解析一遍拿到主名，才能在回显里把「新名=旧名(备注)」还原成人看得懂的一行
      const wanted = normalizeTargets([friendText])[0]?.name || friendText
      const added = saved.targets.find(t => t.name === wanted)
      return e.reply(
        `✅ 已为账号「${acc.name}」添加续火好友：${targetLabel(added) || friendText}\n` +
          `当前共 ${saved.targets.length} 个好友`
      )
    })
  }

  /**
   * 删好友。主名与别名都算命中（判定在 lib/store.js 的 editTarget remove 分支），
   * 用户记得改名前后的哪个名字都能删掉。
   * @param {object} e 消息事件
   * @returns {Promise<*>} e.reply 的结果
   */
  async removeFriend(e) {
    const rest = e.msg.replace(/^#?(dy|抖音)删好友\s*/, "").trim()
    const [accountName, friendName] = splitFirst(rest)
    if (!accountName || !friendName) return e.reply("格式：#抖音删好友 账号名 好友昵称")

    return withAccount(e, accountName, acc => {
      const saved = store.editTarget(e.self_id, acc.id, "remove", { name: friendName })
      return e.reply(`已从账号「${acc.name}」移除好友「${friendName}」，当前剩 ${saved.targets.length} 个`)
    })
  }

  /**
   * 改备注。备注只用于展示（面板与账号列表），不参与抖音侧的好友搜索。
   *
   * 这里按空白切三段而不用 splitFirst：备注本身允许含空格，因此第三段之后全部并回备注，
   * 留空即视为清除（store 侧把 note 写成空串）。
   *
   * @param {object} e 消息事件
   * @returns {Promise<*>} e.reply 的结果
   */
  async noteFriend(e) {
    const rest = e.msg.replace(/^#?(dy|抖音)备注\s*/, "").trim()
    const parts = rest.split(/\s+/)
    const accountName = parts.shift() || ""
    const friendName = parts.shift() || ""
    const note = parts.join(" ").trim()
    if (!accountName || !friendName)
      return e.reply("格式：#抖音备注 账号名 好友昵称 备注内容（备注留空则清除）")

    return withAccount(e, accountName, acc => {
      store.editTarget(e.self_id, acc.id, "note", { name: friendName, note })
      return e.reply(note ? `已把「${friendName}」的备注改为「${note}」` : `已清除「${friendName}」的备注`)
    })
  }
}

/**
 * 按首个空白切成两段，第二段保留其中的空格（好友名带备注时可能含空格）。
 * @param {string} text
 * @returns {[string, string]} 没有空白时第二段为空串
 */
function splitFirst(text) {
  const idx = String(text ?? "").search(/\s/)
  if (idx < 0) return [String(text ?? "").trim(), ""]
  return [text.slice(0, idx).trim(), text.slice(idx + 1).trim()]
}

/**
 * 账号查找与错误回复的公共壳，三个好友指令共用。
 *
 * 查不到账号时把现有账号名一并列出：账号名是用户自己起的，报错里给出清单比只说
 * 「未找到」更容易让人发现是打错了字还是根本没登录过。
 *
 * @param {object} e 消息事件
 * @param {string} name 账号名，按 store.findByName 精确匹配
 * @param {(acc: object) => *} handler 找到账号后执行，抛错由这里统一转成回复
 * @returns {Promise<*>} e.reply 的结果
 */
async function withAccount(e, name, handler) {
  const acc = store.findByName(e.self_id, name)
  if (!acc) {
    const all = store.list(e.self_id).map(a => a.name)
    return e.reply(
      `未找到账号「${name}」${all.length ? `\n当前账号：${all.join("、")}` : "，先用「#抖音登录」添加"}`
    )
  }
  try {
    return await handler(acc)
  } catch (error) {
    return e.reply(`操作失败：${toError(error).message}`)
  }
}
