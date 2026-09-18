/**
 * 配置热重载：监听 config/config.yaml，改完自动让新配置生效，不必 `#重启`。
 *
 * 补的是哪条缝 —— 配置本来就有三条「立即生效」的路：锅巴保存（guoba.support.js 的
 * setConfigData）、Web 面板保存（lib/web.js 的 POST /api/config）、`#抖音设置`（apps/panel.js），
 * 三者都是 config.set/setMany 先改内存再落盘，所以打开 `debug.enable` 之类当场就生效。
 * 真正要重启的是第四条路：**直接用编辑器改 config/config.yaml**。配置文件只是「启动时读一次
 * 的输入」，进程里那份是导入期合并出来的副本，改了文件进程并不知道。本模块就是给这条路补上
 * 监听：文件一变就读盘、比对、应用。
 *
 * 为什么用 diff 而不是「一有事件就重载」：
 * 1. 我们自己每次 save() 都在写同一个文件，事件会立刻回来。比对前后配置树，无变化就什么都不做，
 *    于是不存在「写盘 → 重载 → 再写盘」的循环，也不会在日志里刷一行行噪音。
 * 2. 需要知道**改了哪几项**才能决定副作用：cron 变了要重排定时任务，聊天总开关被关掉要收掉
 *    已开的会话，而 web.base 这类只在加载期读一次的项要明确告诉用户「这个得重启」。
 *
 * 为什么监听目录而不是文件：`fs.watch` 盯具体文件时，编辑器「写临时文件 + rename 覆盖」这套
 * 保存方式会把被盯的 inode 换掉，监听从此哑掉（vscode、vim 的默认行为都可能命中）。盯目录则
 * rename、删除后重建、文件原本不存在这几种情况都能收到事件。
 *
 * 为什么 strict 读盘（config.reload({ strict: true })）：编辑器保存到一半时 yaml 是残缺的，
 * 若按普通 reload 的语义把它当默认配置用，定时任务会被注销、聊天会被关掉 —— 一次手滑的后果
 * 远大于「这次改动没生效」。所以读不出来就整个作废，等下一次事件重试，并在日志里说清原因。
 * 这里的「读不出来」有三类：文件不存在、YAML 语法错误、顶层没有任何已知配置段 ——
 * 第三类是因为残缺内容完全可能是合法 YAML（见 config.js 的 explainShape）。
 *
 * 导出：installConfigWatcher / stopConfigWatcher（生命周期）、reloadConfig（立即重载一次，
 * `#抖音重载` 与监听回调共用）、watchState（监听是否在跑 + 上次重载结果，供指令提示）。
 *
 * 依赖：config.js（读盘/比较）、scheduler.js（重排定时任务）、chat.js（关聊天开关时收会话）、
 * audit.js（留痕）、util.js。注意本模块不被 config.js 反向依赖，不构成循环。
 *
 * 调用前提：installConfigWatcher 要在插件导入期调用（index.js），此后一直挂着；
 * 退出由 lib/shutdown.js 调 stopConfigWatcher 摘掉。
 */
import fs from "node:fs"
import path from "node:path"
import { formatTime, getPath, log, oneLine, toError } from "./util.js"
import { config, configPath } from "./config.js"
import { scheduler } from "./scheduler.js"
import { audit } from "./audit.js"
import * as chat from "./chat.js"

/**
 * 事件去抖窗口。
 *
 * 一次保存往往触发多个事件（写入、属性变更、编辑器自己的临时文件改名），400ms 把这一串
 * 收成一次重载。取这个量级而不是更长：用户在面板上点完「开」就期望立刻看到日志变化。
 * 另外本进程 save() 之后紧跟的重载会因「无变化」而空转，去抖也让这段开销更少。
 */
const WATCH_DEBOUNCE_MS = 400

/**
 * 只在插件加载期读一次、改文件必须重启才生效的配置项。
 *
 * 路由是导入期挂到 `Bot.express` 上的（lib/web.js 的 setupWeb，晚于框架的兜底重定向就挂不上），
 * 独立服务监听的端口也是那时定的，因此这三项改文件不会当场生效。命中就在日志与指令回复里
 * 点名，免得用户以为改成功了却打不开面板。
 */
const RESTART_ONLY = ["web.enable", "web.base", "web.port"]

/** 日志里一次最多列几项改动，多出来的折成「等共 N 项」 */
const LOG_KEY_LIMIT = 8

/** fs.watch 的句柄；null 表示没在监听（平台不支持或已退出收尾） */
let watcher = null
/** 去抖计时器 */
let timer = null
/** 上次真正生效的重载：{at, time, why, keys}，供 `#抖音重载` 提示 */
let lastReload = null

/**
 * 把配置树压成「点路径 → 叶子值」的扁平表，供比对用。
 *
 * 数组整体当一个叶子（JSON 串比较）：推送群列表这类数组半合并出来的 diff 没有意义，
 * 「这一项变了」才是判断副作用的粒度（见 util.deepMerge 的同一条约定）。
 * 空对象不产出任何条目 —— 双方都没有叶子时它等同不存在。
 *
 * @param {*} node 任意节点
 * @param {string} [prefix=""] 当前点路径
 * @param {Record<string, *>} [out={}]
 * @returns {Record<string, *>} 叶子值可能是原始值或数组（数组已串化）
 */
function flatten(node, prefix = "", out = {}) {
  if (Array.isArray(node)) {
    out[prefix] = JSON.stringify(node)
    return out
  }
  if (node && typeof node === "object") {
    for (const [key, value] of Object.entries(node)) flatten(value, prefix ? `${prefix}.${key}` : key, out)
    return out
  }
  if (prefix) out[prefix] = node
  return out
}

/**
 * 两次配置树之间发生变化的点路径。
 * @param {object} before
 * @param {object} after
 * @returns {string[]} 已排序，便于日志与测试比对
 */
function diffKeys(before, after) {
  const a = flatten(before)
  const b = flatten(after)
  const keys = []
  for (const key of new Set([...Object.keys(a), ...Object.keys(b)]))
    if (JSON.stringify(a[key]) !== JSON.stringify(b[key])) keys.push(key)
  return keys.sort()
}

/**
 * 叶子值的一行展示。字符串带引号，避免 `false` 与 `"false"` 看起来一样。
 * @param {*} value
 * @returns {string} 超过 40 字截断
 */
function brief(value) {
  return oneLine(JSON.stringify(value) ?? String(value), 40)
}

/**
 * 把改动列表折成一行日志用的文本。
 * @param {string[]} keys
 * @param {object} before 旧配置树
 * @param {object} after 新配置树
 * @returns {string} 形如 `debug.enable false → true；spark.cron "…" → "…"`
 */
function describeChanges(keys, before, after) {
  const shown = keys
    .slice(0, LOG_KEY_LIMIT)
    .map(key => `${key} ${brief(getPath(before, key))} → ${brief(getPath(after, key))}`)
  const rest = keys.length - shown.length
  return shown.join("；") + (rest > 0 ? `；等共 ${keys.length} 项` : "")
}

/**
 * 改动带来的、需要在配置之外做的动作。
 *
 * 只做「不做就会让用户看到自相矛盾状态」的那几件：
 * - `spark.*` → 重排定时任务。cron / 开关改了必须换表；其余 spark 项每次都读实时值，
 *   一起重排只是顺手（reschedule 幂等，表达式没变时复用原 job，不会把下次执行时间推后）。
 * - `chat.enable` 关掉 → 收掉已开的聊天会话。那些页面还挂着 Chromium 与账号锁，而用户改这个
 *   开关的意图就是「现在别用抖音登录态」；`#抖音设置 聊天 关` 走 apps/panel.js 时做的是同一件事。
 *   收会话是异步的，这里不 await：重载本身要同步返回给监听回调与指令。
 * - 其余项（push / render / security / debug / update / chat 的其它字段）都是每次用时现读，
 *   不需要任何动作。
 *
 * @param {string[]} keys 变化的点路径
 * @returns {string[]} 改了但不生效、需要重启的项
 */
function applySideEffects(keys) {
  if (keys.some(key => key.startsWith("spark."))) scheduler.reschedule()

  if (keys.includes("chat.enable") && config.get("chat.enable", true) === false) {
    chat
      .closeAll("配置已改为关闭私信聊天")
      .then(count => {
        if (count) log("info", `私信聊天已关闭，顺带收掉 ${count} 个开着的会话`)
      })
      .catch(error => log("warn", "关闭聊天会话失败：", toError(error).message))
  }

  return RESTART_ONLY.filter(key => keys.includes(key))
}

/**
 * 重新读盘并让改动生效。监听回调与 `#抖音重载` 共用这一条路径。
 *
 * 无变化时什么都不做（不写审计、不重排、不记 info），这是本进程自己 save() 触发的那些事件的
 * 常规归宿。有变化时：重排定时任务 → 执行副作用 → 记审计 → 记一行 info（含每项的前后值）。
 *
 * @param {string} [why="配置文件变更"] 触发来源，进日志与审计
 * @returns {{ok: boolean, changed: string[], restart: string[], reason?: string, at?: number}}
 *   ok=false 只在配置文件读不出来时出现（strict 语义，见文件头），此时 changed 为空、
 *   reason 是给用户看的一句话
 */
export function reloadConfig(why = "配置文件变更") {
  const before = config.data
  const after = config.reload({ strict: true })
  if (!after)
    return {
      ok: false,
      changed: [],
      restart: [],
      reason:
        "config.yaml 读取失败（文件不存在、YAML 语法错误、或顶层没有任何已知配置段），" +
        "已保留当前配置。具体原因见 Yunzai 日志，修正后保存一次即可",
    }

  const changed = diffKeys(before, after)
  if (!changed.length) {
    log("debug", `${why}：配置与内存中一致，无需重载`)
    return { ok: true, changed: [], restart: [] }
  }

  const restart = applySideEffects(changed)
  const at = Date.now()
  lastReload = { at, why, keys: changed }
  audit.add("config.reload", { why, keys: changed, restart })
  log(
    "info",
    `配置已热重载（${why}）：${describeChanges(changed, before, after)}` +
      `${restart.length ? `；${restart.join("、")} 需 #重启 才生效` : ""}`
  )
  return { ok: true, changed, restart, at }
}

/**
 * 起文件监听。幂等，重复调用直接返回。
 *
 * `persistent: false`：监听不该成为「进程还活着」的理由，Yunzai 自己的服务句柄才是。
 * 事件里的 filename 在部分平台是 null（也有平台给 Buffer），为 null 时按「可能相关」处理 ——
 * 重载本身很便宜，漏掉一次真改动却要用户重启才发现。
 *
 * 起不来（平台不支持、权限不足、目录被删）只记 warn 并返回 false：这时 `#抖音重载` 仍然可用，
 * 是给「Docker 里挂载的目录收不到 inotify」这类环境留的退路，不能因为监听失败影响插件加载。
 *
 * @returns {boolean} 是否成功挂上
 */
export function installConfigWatcher() {
  if (watcher) return true
  const dir = path.dirname(configPath)
  try {
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true })
    watcher = fs.watch(dir, { persistent: false }, (event, filename) => {
      // 目录里只有 config.yaml 一个文件，但对不上名的事件一律忽略：不同平台/编辑器
      // 落下的临时文件（config.yaml.tmp、.config.yaml.swp）不该触发重载
      if (filename && path.basename(String(filename)) !== path.basename(configPath)) return
      if (timer) clearTimeout(timer)
      // unref：去抖窗口正好卡在进程退出时也不该拖住退出
      timer = setTimeout(() => {
        timer = null
        reloadConfig("config.yaml 被外部修改")
      }, WATCH_DEBOUNCE_MS)
      timer.unref?.()
    })
    watcher.on("error", error => log("warn", "config.yaml 监听出错（可改用 #抖音重载）：", toError(error).message))
  } catch (error) {
    watcher = null
    log("warn", "config.yaml 监听未能启用（手改文件后用 #抖音重载）：", toError(error).message)
    return false
  }
  log("info", "配置热重载已启用：改 config/config.yaml 会自动生效，也可用 #抖音重载 立即重载")
  return true
}

/**
 * 摘掉监听。退出收尾时调用（lib/shutdown.js）。
 * 进程结束本来也会释放句柄，这里显式关掉是为了让收尾期间不再有重载插进来。
 */
export function stopConfigWatcher() {
  if (timer) {
    clearTimeout(timer)
    timer = null
  }
  try {
    watcher?.close()
  } catch {}
  watcher = null
}

/**
 * 监听状态 + 上次重载结果，仅供 `#抖音重载` 拼回复。
 * @returns {{watching: boolean, at: number, time: string, why: string, keys: string[]}}
 */
export function watchState() {
  return {
    watching: Boolean(watcher),
    at: lastReload?.at || 0,
    time: lastReload ? formatTime(lastReload.at) : "",
    why: lastReload?.why || "",
    keys: lastReload?.keys || [],
  }
}

export default { installConfigWatcher, stopConfigWatcher, reloadConfig, watchState }
