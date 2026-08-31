import fs from "node:fs"
import path from "node:path"
import { dataDir, ensureDir, formatTime } from "./util.js"
import { config } from "./config.js"

const auditPath = path.join(ensureDir(dataDir), "audit.json")

/**
 * 审计只保留最近 N 条（config.web.auditKeep），够定位「谁在什么时候进了面板、导出了什么」，
 * 又不会无限膨胀。写盘用整体覆盖，条数上限内开销可以忽略。
 */
class Audit {
  #items

  constructor() {
    this.#items = this.#load()
  }

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
   * @param {string} action 动作标识，如 web.login / account.upsert / spark.run
   * @param {object} detail 附加信息，调用方负责不要把 Cookie 原文塞进来
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

  /** 倒序返回最近记录，可按 bot 过滤，面板只看自己那台 */
  list({ botId = "", limit = 50 } = {}) {
    let items = this.#items
    if (botId) items = items.filter(i => String(i.botId ?? "") === String(botId))
    return items.slice(-limit).reverse()
  }

  clear(botId = "") {
    if (botId) this.#items = this.#items.filter(i => String(i.botId ?? "") !== String(botId))
    else this.#items = []
    try {
      fs.writeFileSync(auditPath, JSON.stringify(this.#items), { encoding: "utf8", mode: 0o600 })
    } catch {}
  }
}

export const audit = new Audit()
export default audit
