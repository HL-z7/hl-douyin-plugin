/**
 * 离线一言：从 resources/data/yiyan.json 随机取一条，不联网。
 *
 * 唯一使用者是 lib/template.js：用户没配 `spark.messageTemplate` 时整条消息就是一言，
 * 配了模板则填充 {{yiyan}} / {{from}} 两个占位符（见 templateNeedsYiyan）。
 *
 * 不走 hitokoto 之类的在线接口：续火本身已经要开浏览器访问抖音，再引一个外部依赖
 * 就多一个失败点与一次出网请求，而随机句子对新鲜度没有要求。
 *
 * 数据集是 hitokoto 的导出格式（当前 1459 条，约 558KB），本模块只用 hitokoto、
 * from、from_who 三个字段，其余字段（id/uuid/type/creator/…）原样忽略。
 */
import fs from "node:fs"
import path from "node:path"
import { pluginRoot, log } from "./util.js"

const yiyanPath = path.join(pluginRoot, "resources", "data", "yiyan.json")

/** 数据集读不到时的兜底，保证续火不会因为缺资源整体失败 */
const FALLBACK = [
  { hitokoto: "今天也是值得记录的一天。", from: "抖音续火" },
  { hitokoto: "愿你所求皆如愿，所行化坦途。", from: "抖音续火" },
  { hitokoto: "慢慢来，一切都来得及。", from: "抖音续火" },
]

/** 整个数组常驻内存，避免每次续火都重新解析 558KB JSON */
let cache = null

/**
 * 首次调用时同步读盘并解析，之后直接返回缓存。
 *
 * 文件损坏、不是数组、或数组为空时都退回 FALLBACK 并缓存下来 —— 后续调用不再重试，
 * 所以修好数据文件需要重启（本插件有 index.js，不参与热重载，见 index.js 的说明）。
 */
function load() {
  if (cache) return cache
  try {
    const data = JSON.parse(fs.readFileSync(yiyanPath, "utf8"))
    cache = Array.isArray(data) && data.length ? data : FALLBACK
  } catch (error) {
    log("warn", "一言数据加载失败，使用内置兜底：", error.message)
    cache = FALLBACK
  }
  return cache
}

/**
 * 随机取一条。
 *
 * from 缺失时退到 from_who：hitokoto 数据里「出自作品」记在 from，「谁说的」记在
 * from_who，部分条目只有后者。两者都没有时返回空串，由调用方决定是否显示出处
 * （配置 `spark.yiyanIncludeSource`）。
 *
 * @returns {{hitokoto: string, from: string}} 两个字段都已 trim，不会是 undefined
 */
export function pickYiyan() {
  const list = load()
  const item = list[Math.floor(Math.random() * list.length)]
  return {
    hitokoto: String(item?.hitokoto ?? "").trim(),
    from: String(item?.from ?? item?.from_who ?? "").trim(),
  }
}

/**
 * 数据集条数，用于在面板/帮助里显示「内置多少条一言」。
 * 返回 3 说明走了 FALLBACK，即数据文件没读到。
 */
export function yiyanCount() {
  return load().length
}
