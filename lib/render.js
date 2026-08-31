/**
 * 图片渲染：把插件的文本响应（帮助、设置、状态）渲染成图片。
 *
 * 复用 Yunzai 自带的渲染器（`lib/puppeteer/puppeteer.js` → renderers/puppeteer），
 * 不自己开浏览器：截图用的 Chromium 会被 redis 里的 wsEndpoint 跨进程共享、跑满 100 张
 * 自动重启，这些策略对短平快的截图正好合适，插件另起一个只是白占内存。
 * （lib/browser.js 里那个独立实例是给续火/扫码用的——它要持有分钟级登录态页面，
 *   两者的生命周期需求相反，所以必须分开，见该文件头部说明。）
 *
 * 统一在这里注入模板数据，模板侧只管排版：
 * - `_res_path`      资源目录的 file:// 绝对地址。渲染产物落在 temp/html/<name>/<saveId>.html，
 *                    相对路径的层级取决于 name 里有几个斜杠，改个模板名就会静默丢样式
 * - `defaultLayout`  公共布局的绝对路径，模板首行 `{{extend defaultLayout}}` 用
 * - `sys.scale`      渲染倍率，直接落在 <body> 上（art-template 的 `{{@}}` 不转义）
 */
import fs from "node:fs"
import path from "node:path"
import { pathToFileURL } from "node:url"
import { pluginRoot, resourceDir, log } from "./util.js"
import { config } from "./config.js"

/** 资源目录的 file:// 前缀，末尾带斜杠，供模板拼 `{{_res_path}}common/theme.css` */
const resPath = `${pathToFileURL(resourceDir).href}/`

const layoutPath = path.join(resourceDir, "common", "layout", "default.html")

let cachedVersion = ""

/** 插件版本号，页脚展示用。读一次就缓存，渲染路径上不该反复读盘 */
export function version() {
  if (cachedVersion) return cachedVersion
  try {
    cachedVersion = JSON.parse(fs.readFileSync(path.join(pluginRoot, "package.json"), "utf8")).version || "1.0.0"
  } catch {
    cachedVersion = "1.0.0"
  }
  return cachedVersion
}

/**
 * 渲染一个模板并返回 segment.image，失败返回 false 让调用方降级成文字。
 *
 * @param {string} tpl 模板名，对应 resources/<tpl>.html
 * @param {object} data 模板数据，`title`/`subtitle`/`badge` 等由布局消费
 * @returns {Promise<object|false>}
 */
export async function render(tpl, data = {}) {
  if (!config.bool("render.image", true)) return false

  const tplFile = path.join(resourceDir, `${tpl}.html`)
  if (!fs.existsSync(tplFile)) {
    log("warn", `渲染模板不存在：${tplFile}`)
    return false
  }

  // 倍率夹在 0.6–2 之间：低于 0.6 字已经看不清，高于 2 图片体积暴涨还容易触发发送失败
  const scale = config.num("render.scale", 1, { min: 0.6, max: 2 })

  try {
    const puppeteer = (await import("../../../lib/puppeteer/puppeteer.js")).default
    return await puppeteer.screenshot(`hl-douyin-plugin/${tpl}`, {
      // 模板与布局
      tplFile,
      defaultLayout: layoutPath,
      _res_path: resPath,
      // saveId 决定 temp/html 下的文件名。带上 tpl 名避免多套模板互相覆盖
      saveId: data.saveId || tpl.replace(/\//g, "-"),
      // 输出参数：png 保底不丢字（jpeg 在深底细字上糊得明显），quality 对 png 无效会被渲染器删掉
      imgType: "png",
      quality: 100,
      // 本地 file:// 页面没有外部请求，networkidle0 立即满足，不会白等
      pageGotoParams: { waitUntil: "networkidle0" },
      version: version(),
      sys: { scale: scale === 1 ? "" : `style="transform:scale(${scale});transform-origin:0 0;"` },
      ...data,
    })
  } catch (error) {
    log("warn", `渲染 ${tpl} 失败：`, error.stack || error.message)
    return false
  }
}

/**
 * 图片优先、文字兜底的统一回复。
 *
 * 所有「可渲染成图片」的指令都走它，好处是渲染开关、渲染失败降级、
 * 以及「图片发送失败再补文字」这三件事只在一个地方处理。
 *
 * @param {object} e 消息事件
 * @param {string} tpl 模板名
 * @param {object} data 模板数据
 * @param {string} text 纯文字版内容，渲染关闭或失败时发它
 */
export async function replyRender(e, tpl, data, text) {
  const img = await render(tpl, data)
  if (img) {
    try {
      return await e.reply(img)
    } catch (error) {
      // 图片渲染出来了但发不出去（多为账号被风控或图片过大），还是要把内容给到用户
      log("warn", "图片发送失败，降级为文字：", error.message)
    }
  }
  return e.reply(text)
}
