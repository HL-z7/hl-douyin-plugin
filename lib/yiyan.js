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

let cache = null

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

export function pickYiyan() {
  const list = load()
  const item = list[Math.floor(Math.random() * list.length)]
  return {
    hitokoto: String(item?.hitokoto ?? "").trim(),
    from: String(item?.from ?? item?.from_who ?? "").trim(),
  }
}

export function yiyanCount() {
  return load().length
}
