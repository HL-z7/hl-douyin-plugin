/**
 * 插件入口：只做「导入期初始化」与「把 apps/ 下的指令类交给 loader」两件事。
 *
 * 为什么是这个结构：
 * - TRSS-Yunzai 的 loader（lib/plugins/loader.js:56）发现插件目录里有 index.js，
 *   就只导入 index.js 并 `continue`，不再扫描其他 .js。所以指令类必须由这里汇总导出。
 * - loader 紧接着（同文件 112 行）执行 `if (app.apps) app = { ...app.apps }`，
 *   把导出的 `apps` 摊平当成插件集合。这就是 `index.js + apps/` 模式的约定。
 * - Express 路由与定时任务必须在导入期就绪：框架在插件加载完成后才给 Bot.express
 *   追加兜底重定向，晚于那一刻挂的路由会被吃掉；定时任务自己持有 job，
 *   锅巴改完 cron 调 scheduler.reschedule() 就能免重启生效。
 * - 退出收尾同理要在导入期挂：它包的是 Bot.restart，而 `#重启` 随时可能来
 *   （见 lib/shutdown.js —— 服务器上重启走 execve，不收就会留下 Chromium）。
 */
import fs from "node:fs"
import path from "node:path"
import { pluginRoot, log } from "./lib/util.js"
import { scheduler } from "./lib/scheduler.js"
import { setupWeb } from "./lib/web.js"
import { installShutdownHooks } from "./lib/shutdown.js"

setupWeb()
scheduler.reschedule()
installShutdownHooks()

const appsDir = path.join(pluginRoot, "apps")
const files = fs.existsSync(appsDir) ? fs.readdirSync(appsDir).filter(f => f.endsWith(".js")) : []

const loaded = await Promise.allSettled(files.map(file => import(`./apps/${file}`)))

const apps = {}
for (let i = 0; i < files.length; i++) {
  const name = files[i].replace(/\.js$/, "")
  if (loaded[i].status !== "fulfilled") {
    log("error", `载入指令模块失败：${name}`, loaded[i].reason)
    continue
  }
  // 一个文件可以导出多个插件类，键名带上文件名前缀保证不撞车。
  // 非类导出（常量、工具函数）由 loader 的 `if (!p?.prototype) return` 过滤，这里不必判断。
  for (const [key, value] of Object.entries(loaded[i].value)) apps[`${name}.${key}`] = value
}

export { apps }
