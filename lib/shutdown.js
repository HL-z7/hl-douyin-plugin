/**
 * 进程收尾：Yunzai 退出/重启之前，把浏览器、聊天会话、数据库收干净。
 *
 * 这不是顺手做的整洁工作，是修一个已经在服务器上漏了快一年的东西。现场是容器内
 * `ps` + `/proc/<pid>/cmdline` 实测出来的，不是推测：
 *   - 两个 Chromium 挂在 Yunzai 主进程下。按 --user-data-dir 能分出归属：一个是渲染器的
 *     （temp/puppeteer/<ulid>），一个是本插件的（puppeteer 默认临时 profile）
 *   - ~/.cache/puppeteer_dev_chrome_profile-* 攒到 31 个，最老的一个是 2025-10-09
 * 也就是说每次重启都多留一个 Chromium（200~400MB）和一个垃圾 profile 目录。
 *
 * 漏的是哪条路 —— 读 @puppeteer/browsers 的 launch.js 与 process.execve 的实现得出：
 *
 *   puppeteer 自己已经在 process.on('exit') 和 SIGINT/SIGTERM/SIGHUP 上挂了 kill()，
 *   非 win32 走 `process.kill(-pid, 'SIGKILL')` 连整个进程组一起杀（launch.js:160-169、
 *   223-236、269-283）。所以「正常退出」加三个信号这四条路上，Chromium 本来就会被收，
 *   插件不需要也不该重复做这件事。
 *
 *   真正漏掉的只有 lib/bot.js:676 的 process.execve。服务器用 `node app start` 起，
 *   start_type 是 external，Bot.restart() 第一件事就是 execve 原地换进程镜像 —— 它在
 *   内核层替换镜像，不走 process.reallyExit，exit 钩子一个都不跑（execve 的 JS 实现只做
 *   参数校验 → 诊断通道 publish → _execve，没有任何 emit('exit')）。于是 puppeteer 的
 *   #onDriverProcessExit 不触发、进程组不被 kill，而换完镜像的新 Node 压根不认识这些
 *   子进程，它们就永久留下了。pid 还是原来那个，从外面看「重启成功了」。
 *
 * 所以主路径是包一层 Bot.restart，在 execve 发生之前把清理 await 完；
 * process.on("exit") 只作兜底，而且只能跑同步代码（closeAll 是 async），
 * 那一层的实际价值是 chatdb.close()。
 *
 * 「热重载」这条路不用管：本插件有 index.js，loader.js:58 只 push 并 continue，不注册
 * chokidar 监听；而 loader.load(isRefresh) 的 isRefresh 全仓无人传（唯一调用点
 * lib/bot.js:279 不带参数）。要覆盖的只有进程退出与 #重启。
 *
 * 为什么单独一个文件而不是塞进 index.js 或某个现成模块：清理要同时碰 scheduler /
 * login / chat / browser / chatdb 五个模块，放进其中任何一个都会绕出循环引用
 * （chat.js 已经引 browser.js，browser.js 不能反过来引 chat.js）；而 index.js 是 40 行的
 * 入口，本职是「导出 apps」，再挂五个 import 会盖掉它自己在说的事。
 */
import { log, toError } from "./util.js"
import { scheduler } from "./scheduler.js"
import browserManager from "./browser.js"
import * as chat from "./chat.js"
import * as chatdb from "./chatdb.js"
import { cancelAll as cancelAllLogins } from "./login.js"

/**
 * 关页面这几步一共只等这么久。
 *
 * 有上限是因为用户正盯着 `#重启`：一个卡住的 page.close() 会把重启变成「机器人没反应」。
 * 超了就不等，直接往下走去关浏览器 —— 反正 browser.close() 会把这些页面一起带走。
 */
const PAGE_BUDGET_MS = 4000

/**
 * 关浏览器单独留的时间，不与上面共享预算。
 *
 * 这一步才是真正杀掉 Chromium 的那一步，不能被前面几步吃掉时间。6 秒的下限来自
 * puppeteer 自己：BrowserLauncher.closeBrowser 先试 CDP 优雅关闭，5 秒没关掉才转成
 * SIGKILL 杀进程组，给少了就总是走到我们自己的强杀分支。
 */
const BROWSER_BUDGET_MS = 6000

/** 已经收过尾了。exit 兜底与 restart 包装可能都会触发，只做一次 */
let finished = false

/** 计时器版的 false：unref 掉，免得它自己反过来拖住进程退出 */
function deadline(ms) {
  return new Promise(resolve => {
    const timer = setTimeout(() => resolve(false), ms)
    timer.unref?.()
  })
}

/** 跑一步清理，失败或超时都只记一行日志 —— 收尾途中的异常不该挡住后面的步骤 */
async function step(name, budget, fn) {
  try {
    const ok = await Promise.race([Promise.resolve().then(fn).then(() => true), deadline(budget)])
    if (!ok) log("warn", `收尾：${name} 超过 ${budget / 1000} 秒未完成，不再等它`)
  } catch (error) {
    log("warn", `收尾：${name} 失败：`, toError(error).message)
  }
}

/**
 * 收尾。幂等，重复调用直接返回。
 *
 * 顺序是有讲究的：
 * 1. 先摘定时任务，否则收到一半又起一轮续火，刚关掉的浏览器立刻被重新拉起来
 * 2. 扫码会话与聊天会话各占一个 page + context，两边互不相干所以并行关
 * 3. 关浏览器 —— 这一步之后 Chromium 进程才真的没了
 * 4. 最后关库。放在最后是因为聊天会话关闭时还会往库里写最后几条（recordSent / markSeen）
 */
export async function shutdown(why = "进程即将退出") {
  if (finished) return
  finished = true
  log("info", `收尾开始（${why}）`)
  const at = Date.now()

  scheduler.cancel()

  await step("关闭登录与聊天会话", PAGE_BUDGET_MS, () =>
    Promise.all([
      cancelAllLogins(`${why}，本次登录已中止`),
      chat.closeAll(why),
    ])
  )
  await step("关闭浏览器", BROWSER_BUDGET_MS, () => browserManager.close(BROWSER_BUDGET_MS))
  await step("关闭聊天数据库", 1000, () => chatdb.close())

  log("info", `收尾完成，用时 ${Date.now() - at}ms`)
}

/**
 * 挂钩子。index.js 在导入期调一次，重复调用无害（两层都自带幂等）。
 *
 * 两层，各自补对方的盲区：
 *
 * 1. 包 Bot.restart —— 主路径，唯一能覆盖 execve 的地方。必须在 execve 之前把清理
 *    await 完，之后就没有「之后」了：进程镜像已经被换掉，同一个 pid 上跑的是全新的
 *    Node，我们的代码连同 Chromium 的 handle 一起消失。
 *
 * 2. process.on("exit") —— 兜底。这一层只能跑同步代码（exit 钩子里 await 不会被等），
 *    所以它收的是 chatdb.close() 这类同步资源；Chromium 在这条路上由 puppeteer 自己
 *    挂的 kill() 负责，我们不重复插手。#关机（Bot.exit → process.exit(255)）走的就是这条。
 */
export function installShutdownHooks() {
  hookRestart()
  hookExit()
}

/**
 * 给 Bot.restart 包一层。
 *
 * 为什么要先取 `Bot.bot` 再改：lib/bot.js:80-95 的构造器 `return new Proxy(this.bots, …)`，
 * 外面拿到的 `global.Bot` 是那个代理，而它只有 get 陷阱 —— 写操作直接落在被代理的
 * `this.bots` 上（Bot[uin] 就是这么存的），读却仍旧优先走 `this[prop]`，于是
 * `Bot.restart = fn` 赋值成功、调用时拿到的还是原来那个。实测确认过。
 *
 * 真身在 `bot = this` 这个字段上（lib/bot.js:17），改它才生效。取不到就不包 ——
 * 宁可不收尾，也不能在插件加载期把 Yunzai 搞崩。
 */
function hookRestart() {
  const raw = global.Bot?.bot
  if (typeof raw?.restart !== "function") {
    log("warn", "取不到 Bot.restart，重启时将不做浏览器收尾")
    return
  }
  // 幂等：#重载 之类的重复导入不该套成两层
  if (raw.restart.__hlDouyinWrapped) return

  const original = raw.restart.bind(raw)
  const wrapped = async function (...args) {
    // restart 一旦进 execve 就再也回不来，所以清理必须在这儿等完
    await shutdown("机器人正在重启").catch(() => {})
    return original(...args)
  }
  wrapped.__hlDouyinWrapped = true
  raw.restart = wrapped
  log("debug", "已挂重启收尾钩子")
}

/**
 * exit 兜底。
 *
 * 只做同步的事：Node 在 exit 钩子里不会等任何 Promise，写 async 只会让人误以为
 * 收尾做完了。chatdb.close() 本身是同步的（node:sqlite 的 DatabaseSync），正好合适。
 * 参照 plugins/Guoba-Plugin/utils/adapter/common.js:57 的先例，那里也是在 exit 上收
 * 自己的资源。
 */
function hookExit() {
  if (hookExit.done) return
  hookExit.done = true
  process.on("exit", () => {
    scheduler.cancel()
    try {
      chatdb.close()
    } catch {}
  })
}
