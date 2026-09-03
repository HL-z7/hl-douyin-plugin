/**
 * 操作审计：谁在什么时候做了什么，落 data/audit.json。
 *
 * 记录点分布在 lib/auth.js（发码、登录、选机器人、拉黑）、lib/login.js（扫码/手动登录）、
 * lib/remote.js（验证链接的签发与打开）、lib/web.js 与 apps/*（账号增删、配置改动、
 * 手动发信、聊天开启）、lib/spark.js 与 lib/scheduler.js（续火单次与批次）。
 *
 * 隐私口径：聊天类只记「谁给谁发了几个字」（lib/chat.js:284 传的是 length，不是内容），
 * 账号类不记 Cookie，配置类只记改了哪些 key 不记值。这条口径由调用方保证，本模块不做过滤。
 *
 * 面板通过 `GET <base>/api/audit` 读取（路由见 lib/web.js:440，limit 夹取在 1~200），
 * 前端渲染成表格见 web/app.js 的 loadStatus（拉 `/audit?limit=60` 填 #auditBody）。
 */
import fs from "node:fs"
import path from "node:path"
import { dataDir, ensureDir, formatTime } from "./util.js"
import { config } from "./config.js"

const auditPath = path.join(ensureDir(dataDir), "audit.json")

/**
 * 审计只保留最近 N 条（config.web.auditKeep，默认 500），够定位「谁在什么时候进了面板、
 * 导出了什么」，又不会无限膨胀。写盘用整体覆盖，条数上限内开销可以忽略。
 *
 * 全部记录常驻内存（#items），进程重启后从 audit.json 重新读入。
 */
class Audit {
  #items

  constructor() {
    this.#items = this.#load()
  }

  /**
   * 读盘。文件不存在、JSON 损坏、或内容不是数组时都退回空数组 ——
   * 审计文件读不出来不该让整个插件加载失败，代价只是丢历史记录。
   */
  #load() {
    if (!fs.existsSync(auditPath)) return []
    try {
      const data = JSON.parse(fs.readFileSync(auditPath, "utf8"))
      return Array.isArray(data) ? data : []
    } catch {
      return []
    }
  }

  /**
   * 追加一条并立刻落盘。
   *
   * @param {string} action 动作标识，如 web.login / account.upsert / spark.run
   * @param {object} detail 附加信息，调用方负责不要把 Cookie 原文塞进来。
   *   带 botId 的记录才能被 list({ botId }) 筛到；spark.batch、web.ban 这类
   *   跨机器人/无机器人上下文的记录不带它，只在不筛选时可见
   * @returns {object} 落盘的完整记录（含 at / time / action）
   */
  add(action, detail = {}) {
    const item = {
      at: Date.now(),
      time: formatTime(),
      action: String(action),
      ...detail,
    }
    this.#items.push(item)
    const keep = Number(config.get("web.auditKeep", 500)) || 500
    if (this.#items.length > keep) this.#items = this.#items.slice(-keep)
    try {
      fs.writeFileSync(auditPath, JSON.stringify(this.#items), { encoding: "utf8", mode: 0o600 })
    } catch {
      // 审计写盘失败不能影响主流程
    }
    return item
  }

  /**
   * 倒序返回最近记录，可按 bot 过滤，面板只看自己那台。
   *
   * @param {{botId?: string|number, limit?: number}} [opts] botId 为空则不筛；
   *   筛选发生在截断之前，所以 limit 是该 bot 的条数
   * @returns {object[]} 最新的在最前
   */
  list({ botId = "", limit = 50 } = {}) {
    let items = this.#items
    if (botId) items = items.filter(i => String(i.botId ?? "") === String(botId))
    return items.slice(-limit).reverse()
  }

  /**
   * 清空审计。给了 botId 只删该 bot 的记录（不带 botId 的记录会被保留），否则全清。
   * 写盘失败静默忽略，与 add 一致。
   */
  clear(botId = "") {
    if (botId) this.#items = this.#items.filter(i => String(i.botId ?? "") !== String(botId))
    else this.#items = []
    try {
      fs.writeFileSync(auditPath, JSON.stringify(this.#items), { encoding: "utf8", mode: 0o600 })
    } catch {}
  }
}

/** 全插件共用一个实例：多份实例会各自持有内存副本并互相覆盖同一个文件 */
export const audit = new Audit()
export default audit
