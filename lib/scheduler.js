/**
 * 定时调度：按 cron 跑全部机器人的续火，并把结果交给 push.js。
 *
 * 为什么不用 plugin 的 task 字段：
 * loader 只在插件加载时读一次 task.cron，锅巴改完 cron 必须重启才生效。
 * 这里自己持有 job，改配置后调 reschedule() 立刻换表，符合「配置可热改」的要求。
 */
import schedule from "node-schedule"
import { log, formatTime, toError } from "./util.js"
import { config } from "./config.js"
import { store } from "./store.js"
import { audit } from "./audit.js"
import { runBot } from "./spark.js"
import { pushReport, botsWithAccounts, classify } from "./push.js"

class Scheduler {
  #job = null
  #cron = ""
  #lastRun = null
  #busy = false

  /** 启动/重建定时任务，cron 或开关变化时调用即可 */
  reschedule() {
    const enable = config.bool("spark.enable", true)
    const cron = String(config.get("spark.cron", "0 20 8 * * *")).trim()

    if (this.#job && (this.#cron !== cron || !enable)) {
      this.#job.cancel()
      this.#job = null
      this.#cron = ""
    }
    if (!enable) {
      log("info", "定时续火已关闭")
      return null
    }
    if (this.#job) return this.#job

    try {
      this.#job = schedule.scheduleJob(cron, () => {
        // 定时任务走跳过判定：同一天重复发消息对火花没有额外收益，只是白担风控风险
        this.runAll("定时任务", { skipIfDone: config.bool("spark.skipIfDone", true) }).catch(error =>
          log("error", "定时续火异常：", toError(error).message)
        )
      })
      if (!this.#job) throw new Error("cron 表达式无效")
      this.#cron = cron
      log("info", `定时续火已注册：${cron}，下次 ${formatTime(this.#job.nextInvocation()?.getTime?.())}`)
    } catch (error) {
      log("error", `定时续火注册失败（cron: ${cron}）：`, toError(error).message)
      this.#job = null
    }
    return this.#job
  }

  cancel() {
    this.#job?.cancel()
    this.#job = null
    this.#cron = ""
  }

  /**
   * 跑所有配置了账号的 Bot，逐台串行，跑完各自推送。
   * 定时与手动共用，busy 标记防止两边叠在一起开一堆浏览器。
   *
   * @param {string} trigger 触发来源，只用于日志、审计与推送文本
   * @param {object} [opts]
   * @param {boolean} [opts.skipIfDone] 今天已成功的账号直接跳过。定时任务读
   *   `spark.skipIfDone`，手动续火默认 false（用户明确要发就发）
   * @param {boolean} [opts.force] 忽略 push.enable / onlyOnFail 强行推送
   */
  async runAll(trigger = "手动", { onProgress, skipIfDone = false, force = false } = {}) {
    if (this.#busy) throw new Error("已有续火任务在执行中")
    this.#busy = true
    const started = Date.now()
    const summary = { trigger, at: started, bots: [], total: 0, ok: 0, fail: 0, skipped: 0, renamed: 0 }

    try {
      const bots = botsWithAccounts()
      if (!bots.length) {
        log("info", `${trigger}续火：没有配置任何抖音账号，跳过`)
        return summary
      }

      for (const botId of bots) {
        const results = await runBot(botId, { onProgress, skipIfDone })
        const stat = classify(results)
        summary.bots.push({ botId, results })
        summary.total += results.length
        summary.ok += stat.ok.length
        summary.fail += stat.fail.length
        summary.skipped += stat.skipped.length
        summary.renamed += stat.renamed.length

        // 整台机器人的账号全被跳过时不推送，否则每天定时都会发一条「全部跳过」刷屏
        if (stat.skipped.length === results.length && results.length) {
          log("info", `${trigger}续火：机器人 ${botId} 今天已全部续过火，不推送`)
          continue
        }
        try {
          await pushReport(botId, results, { force })
        } catch (error) {
          log("warn", `推送失败：`, toError(error).message)
        }
      }
    } finally {
      this.#busy = false
      summary.durationMs = Date.now() - started
      this.#lastRun = summary
      audit.add("spark.batch", {
        trigger,
        total: summary.total,
        ok: summary.ok,
        fail: summary.fail,
        skipped: summary.skipped,
        durationMs: summary.durationMs,
      })
    }
    return summary
  }

  get busy() {
    return this.#busy
  }

  get lastRun() {
    return this.#lastRun
  }

  /** 状态面板用：cron、下次执行时间、是否在跑 */
  status() {
    const next = this.#job?.nextInvocation?.()
    return {
      enable: config.bool("spark.enable", true),
      cron: this.#cron || String(config.get("spark.cron", "")),
      registered: Boolean(this.#job),
      skipIfDone: config.bool("spark.skipIfDone", true),
      nextAt: next ? next.getTime() : 0,
      nextTime: next ? formatTime(next.getTime()) : "未注册",
      busy: this.#busy,
      lastRun: this.#lastRun
        ? {
            trigger: this.#lastRun.trigger,
            time: formatTime(this.#lastRun.at),
            total: this.#lastRun.total,
            ok: this.#lastRun.ok,
            fail: this.#lastRun.fail,
            skipped: this.#lastRun.skipped,
          }
        : null,
      accountBots: store.allBots().length,
    }
  }
}

export const scheduler = new Scheduler()
export default scheduler
