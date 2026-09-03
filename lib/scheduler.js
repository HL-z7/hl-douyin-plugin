/**
 * 定时调度：按 cron 跑全部机器人的续火，结果交给 lib/push.js 推送。
 *
 * 不使用 Yunzai plugin 的 task 字段：loader 只在插件加载时读一次 task.cron，锅巴改完 cron
 * 必须重启 Yunzai 才生效。这里自己持有 node-schedule 的 job，改配置后调 reschedule() 立刻
 * 换表，满足「配置可热改」。
 *
 * cron 是 node-schedule 的 6 段格式，秒在最前（`spark.cron` 默认 `0 20 8 * * *`，即每天
 * 08:20:00）。表达式非法时 scheduleJob 返回 null，本模块只记 error 日志并把 #job 置空 ——
 * 「还原成旧值」的兜底在调用方（apps/panel.js:72-79），本模块自己不回滚配置。
 *
 * 导出：单例 scheduler（同时是 default）。方法 reschedule / cancel / runAll / status，
 * 取值器 busy / lastRun。之所以是单例：整个插件只应有一个定时任务与一把 #busy 互斥锁，
 * 多实例会让两轮续火同时开浏览器。
 *
 * 依赖：node-schedule 注册任务，spark.js 的 runBot 执行续火，push.js 的 botsWithAccounts /
 * classify / pushReport 处理结果，config.js 读开关，audit.js 记批次，store.js 供状态计数。
 *
 * 使用方：index.js 加载时调一次 reschedule()；apps/panel.js 与 guoba.support.js 改配置后
 * 重新 reschedule()；apps/spark.js 与 lib/web.js 调 runAll 手动触发；lib/panel.js 与
 * /api/status 取 status()；lib/shutdown.js 退出时 cancel()。
 *
 * 调用前提：runAll 并发不安全，由 #busy 拒绝第二个调用方（抛错而非排队），调用前可先看
 * busy。热重载不会重建本模块（插件有 index.js，不参与热重载），所以 cancel 必须被显式调到，
 * 否则旧 job 会与新 job 并存。
 */
import schedule from "node-schedule"
import { log, formatTime, toError } from "./util.js"
import { config } from "./config.js"
import { store } from "./store.js"
import { audit } from "./audit.js"
import { runBot } from "./spark.js"
import { pushReport, botsWithAccounts, classify } from "./push.js"

class Scheduler {
  /** node-schedule 的 Job；null 表示当前没有已注册的任务（关闭或注册失败） */
  #job = null
  /** 已注册任务用的 cron，与配置比对以判断要不要重建；未注册时是空串 */
  #cron = ""
  /** 最近一次 runAll 的 summary，供面板展示，进程重启即丢 */
  #lastRun = null
  /** 互斥标记：一轮续火期间拒绝第二轮，避免同时开多个 Chromium */
  #busy = false

  /**
   * 启动或重建定时任务，开关与 cron 变化后调用即可（幂等）。
   *
   * cron 没变且任务还在时直接复用，不会重建 —— 重建会重新计算下次执行时间，
   * 频繁保存配置可能让任务被一直推后。
   *
   * @returns {object|null} node-schedule 的 Job；spark.enable 为 false、或 cron 非法时返回
   *   null。调用方据此判断表达式是否有效（apps/panel.js、guoba.support.js 都这么用）
   */
  reschedule() {
    const enable = config.bool("spark.enable", true)
    const cron = String(config.get("spark.cron", "0 20 8 * * *")).trim()

    // 只有「换了表达式」或「被关掉」才注销旧任务
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
        // 定时任务走跳过判定：同一天重复发消息对火花没有额外收益，只增加风控暴露
        this.runAll("定时任务", { skipIfDone: config.bool("spark.skipIfDone", true) }).catch(error =>
          log("error", "定时续火异常：", toError(error).message)
        )
      })
      // scheduleJob 对非法表达式返回 null 而不抛错，这里转成异常走同一条处理路径
      if (!this.#job) throw new Error("cron 表达式无效")
      this.#cron = cron
      log("info", `定时续火已注册：${cron}，下次 ${formatTime(this.#job.nextInvocation()?.getTime?.())}`)
    } catch (error) {
      log("error", `定时续火注册失败（cron: ${cron}）：`, toError(error).message)
      this.#job = null
    }
    return this.#job
  }

  /**
   * 注销定时任务。进程退出（lib/shutdown.js）与关闭开关时调用。
   * 不影响正在执行的那一轮 runAll：node-schedule 的 cancel 只取消后续触发。
   */
  cancel() {
    this.#job?.cancel()
    this.#job = null
    this.#cron = ""
  }

  /**
   * 跑所有配置了账号的机器人，逐台串行，每台跑完各自推送。
   *
   * 串行是刻意的：并行会同时开多个 Chromium（见 spark.runBot 的同类说明）。
   * 单台机器人的推送失败只记 warn，不影响后面的机器人。
   *
   * @param {string} [trigger="手动"] 触发来源，进日志、审计（spark.batch）与推送文本
   * @param {object} [opts]
   * @param {(text: string) => void} [opts.onProgress] 进度回调，透传给 runBot → runAccount，
   *   面板用它做实时进度
   * @param {boolean} [opts.skipIfDone] 今天已成功的账号直接跳过。定时任务读
   *   `spark.skipIfDone`（默认 true），手动续火默认 false（用户明确要发就发）
   * @param {boolean} [opts.force] 透传给 pushReport，忽略 push.enable / push.onlyOnFail
   * @returns {Promise<object>} summary：trigger / at / bots（每台的原始 results）/ total /
   *   ok / fail / skipped / renamed / durationMs
   * @throws {Error} 已有任务在执行中时抛「已有续火任务在执行中」，不排队
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
      // 放 finally：runBot 抛错时也要解锁并留下这一轮的痕迹，否则 #busy 卡住后
      // 所有后续续火都会被拒，只能重启
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

  /** 是否有一轮 runAll 正在跑。调用方据此提前给出「请稍后」而不是等它抛错 */
  get busy() {
    return this.#busy
  }

  /** 最近一次 runAll 的完整 summary（含每台机器人的原始 results），未跑过时为 null */
  get lastRun() {
    return this.#lastRun
  }

  /**
   * 状态快照，供 /api/status、lib/panel.js 与 `#抖音状态` 使用。
   *
   * cron 优先报已注册的 #cron，未注册时退回配置里的原值 —— 表达式非法时用户要能在面板上
   * 看到自己填错的那个值。lastRun 只输出计数，不带每台机器人的原始 results（那份太大）。
   *
   * @returns {{enable, cron, registered, skipIfDone, nextAt, nextTime, busy, lastRun,
   *   accountBots}} registered 为 false 且 enable 为 true 即表示 cron 非法；
   *   nextAt 为 0 表示未注册，nextTime 此时是「未注册」
   */
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

/** 全局唯一实例。两种导入写法等价，仓库里两种都有在用 */
export const scheduler = new Scheduler()
export default scheduler
