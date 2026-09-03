/**
 * 插件入口：只做「导入期初始化」与「把 apps/ 下的指令类交给 loader」两件事。
 *
 * 为什么是这个结构：
 * - TRSS-Yunzai 的 loader（框架 lib/plugins/loader.js:58-62）发现插件目录里有 index.js，
 *   就只导入 index.js 并 `continue`，不再扫描其他 .js。所以指令类必须由这里汇总导出。
 * - loader 紧接着（同文件 130 行）执行 `const app = module.apps ? { ...module.apps } : module`，
 *   把导出的 `apps` 摊平当成插件集合。这就是 `index.js + apps/` 模式的约定。
 * - 代价是本插件不参与热重载：loader 只在逐个扫描 .js 的那条分支里调 `this.watch()`
 *   （同文件 73 行），走 index.js 分支时一个 chokidar 监听都不注册。改 lib/*.js 或
 *   apps/*.js 之后必须 `#重启`；改配置不用，锅巴保存会调 apps/panel.js 的
 *   applyConfigChange()（config.reload() + scheduler.reschedule()）当场生效。
 * - Express 路由与定时任务必须在导入期就绪：框架在插件加载完成后才给 Bot.express
 *   追加兜底重定向（框架 lib/bot.js:283，在 PluginsLoader.load() 之后），晚于那一刻挂的
 *   路由会被吃掉；定时任务自己持有 job，锅巴改完 cron 调 scheduler.reschedule()
 *   就能免重启生效。
 * - 退出收尾同理要在导入期挂：它包的是 Bot.restart，而 `#重启` 随时可能来
 *   （见 lib/shutdown.js —— 服务器上重启走 execve，不收就会留下 Chromium）。
 *
 * 顶层 await 会算进 loader 的插件加载超时（cfg.bot.plugin_load_timeout，默认 60 秒）。
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

// allSettled 而不是 all：一个指令文件语法错误不该让整个插件加载失败，
// 下面的循环会把失败的那个单独报出来，其余照常注册
const loaded = await Promise.allSettled(files.map(file => import(`./apps/${file}`)))

const apps = {}
for (let i = 0; i < files.length; i++) {
  const name = files[i].replace(/\.js$/, "")
  if (loaded[i].status !== "fulfilled") {
    log("error", `载入指令模块失败：${name}`, loaded[i].reason)
    continue
  }
  // 键名 `文件名.导出名`：一个文件可以导出多个插件类，带上文件名前缀保证不撞车。
  // 非类导出（常量、工具函数）由 loader 的 `if (!p?.prototype) return`
  // （框架 lib/plugins/loader.js:151）过滤，这里不必判断 —— 但箭头函数才没有 prototype，
  // 普通 function 会被当成插件类而 new 失败，见 apps/panel.js:262-265 的说明
  for (const [key, value] of Object.entries(loaded[i].value)) apps[`${name}.${key}`] = value
}

export { apps }
