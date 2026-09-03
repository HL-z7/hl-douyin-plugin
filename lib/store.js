/**
 * 账号仓库：抖音账号与续火目标的持久化，按 botId 隔离。
 *
 * 落盘结构 `data/accounts/<botId>.json`（文件名经 util.safeFileName 处理）：
 * `{ botId, accounts: [{ id, name, enable, targets[], targetNames[], messageTemplate,
 * note, cookie, cookieUpdatedAt, cookieExpireAt, createdAt, updatedAt, lastRun,
 * lastSuccessAt?, cookieInvalid?, cookieCheck?, friendsCache? }] }`。
 *
 * 一台机器人一个文件：隔离由文件边界保证，不依赖代码里的 if 判断。所有读写都先按 botId
 * 定位文件，因此 A 机器人的面板会话读不到 B 的账号；同时避免全部账号挤在一个文件里被
 * 并发写坏。
 *
 * Cookie 在进入本模块时即以 AES-256-GCM 加密（lib/crypto.js，密钥 data/secret.key）。
 * 对外的 list/get 默认剥掉密文，只给 hasCookie 与 cookiePreview（maskSecret 打码）。
 *
 * 对外导出：
 * - `store` 与默认导出：AccountStore 单例，账号增删改查、运行记录与各类缓存
 * - 续火目标工具：normalizeTargets / targetCandidates / targetLabel / targetText
 * - Cookie 工具：parseCookieInput / assertLoginCookie
 *
 * 依赖 lib/util.js、lib/crypto.js、lib/chatdb.js。lib/spark.js、lib/chat.js、lib/login.js、
 * lib/web.js、guoba.support.js 与 apps/ 下的指令模块都 import 本模块，因此本模块不得反向
 * import 它们。
 *
 * 调用前提：`remove()` 只调用 chatdb.dropAccount() 清聊天记录，不关聊天会话——关会话需要
 * lib/chat.js，而 chat.js 已 import 本模块，反向引用会形成循环依赖。关会话由调用方负责，
 * lib/web.js 的 `DELETE /api/accounts/:id` 会先 chat.closeSession() 再进到这里。
 */
import fs from "node:fs"
import path from "node:path"
import { dataDir, ensureDir, log, safeFileName, toIdList, maskSecret } from "./util.js"
import { encrypt, decrypt, isEncrypted, randomToken } from "./crypto.js"
import * as chatdb from "./chatdb.js"

const accountsDir = ensureDir(dataDir, "accounts")

/** botId 对应的账号文件路径。botId 经 safeFileName 过滤，不能用于跳出 accountsDir */
function fileOf(botId) {
  return path.join(accountsDir, `${safeFileName(botId, "unknown")}.json`)
}

/**
 * 读整个账号文件，顺带对每个账号做旧结构迁移。
 * 文件不存在或 JSON 损坏一律返回空壳 `{ botId, accounts: [] }`——读盘失败不应让续火
 * 与面板整体不可用，损坏原因只记日志。
 */
function readRaw(botId) {
  const file = fileOf(botId)
  if (!fs.existsSync(file)) return { botId: String(botId), accounts: [] }
  try {
    const data = JSON.parse(fs.readFileSync(file, "utf8"))
    if (!Array.isArray(data.accounts)) data.accounts = []
    for (const acc of data.accounts) migrateAccount(acc)
    return data
  } catch (error) {
    log("error", `账号文件损坏 ${file}：`, error.message)
    return { botId: String(botId), accounts: [] }
  }
}

/** 原子写：先写 .tmp 再 rename，进程在写一半被杀时不会留下截断的账号文件。权限 0600 */
function writeRaw(botId, data) {
  const file = fileOf(botId)
  const tmp = `${file}.tmp`
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2), { encoding: "utf8", mode: 0o600 })
  fs.renameSync(tmp, file)
}

// ────────────────────────────── 续火目标 ──────────────────────────────

/**
 * 一个续火目标。
 *
 * 好友改名是断火最常见的原因，因此目标不是裸昵称字符串，而是 `{ name, alias[], note }`：
 * - `name`  当前用于搜索的主名称（抖音里的备注名优先于昵称）
 * - `alias` 历史名 / 备用名。搜索按 name → alias 依次尝试，任一命中即算成功；命中别名时
 *           由 promoteAlias 把它提为 name，下次直接用新名搜索
 * - `note`  展示用备注（如「表妹」），不参与搜索
 *
 * @typedef {{name: string, alias: string[], note: string}} SparkTarget
 */

/**
 * 把宽松输入归一化成 SparkTarget 数组。
 *
 * 接受的形式：
 * - `"A、B"` / `["A", "B"]`                       —— 纯名称，旧版配置的形态
 * - `[{ name, alias, note }]`                     —— 面板与锅巴提交的完整结构
 * - `"张三(表妹)"` / `"张三｜表妹"`                 —— 指令里附带备注
 * - `"张三=小三三"`                                 —— 等号后为别名，可写多个
 *
 * @param {string|Array<string|object>} input
 * @returns {SparkTarget[]} 无效项被跳过，同名项合并
 */
export function normalizeTargets(input) {
  const list = Array.isArray(input) ? input : toIdList(input)
  const out = []

  for (const item of list) {
    const target = typeof item === "object" && item ? fromObject(item) : parseTargetText(item)
    if (!target?.name) continue
    // 同名目标只保留一条，别名与备注合并，避免面板重复提交同一个好友
    const exist = out.find(t => t.name === target.name)
    if (exist) {
      exist.alias = dedupe([...exist.alias, ...target.alias].filter(a => a !== exist.name))
      exist.note = exist.note || target.note
    } else {
      out.push(target)
    }
  }
  return out
}

/** 对象形式的目标。兼容 friend / aliases / remark 这几个旧字段名，note 截断到 40 字 */
function fromObject(item) {
  const name = String(item.name ?? item.friend ?? "").trim()
  if (!name) return null
  return {
    name,
    alias: dedupe(toIdList(item.alias ?? item.aliases ?? []).filter(a => a && a !== name)),
    note: String(item.note ?? item.remark ?? "").trim().slice(0, 40),
  }
}

/**
 * 解析单条文本目标。
 * 语法：`主名称[=别名1=别名2][(备注)]`，备注也支持全角括号与竖线（｜/|）。
 */
function parseTargetText(text) {
  let raw = String(text ?? "").trim()
  if (!raw) return null

  let note = ""
  // 备注只认结尾处的 (xxx) / （xxx） / ｜xxx / |xxx，长度上限 40
  const bracket = raw.match(/[（(]([^（()）]{1,40})[)）]\s*$/)
  if (bracket) {
    note = bracket[1].trim()
    raw = raw.slice(0, bracket.index).trim()
  } else {
    const bar = raw.match(/[｜|]([^｜|]{1,40})$/)
    if (bar) {
      note = bar[1].trim()
      raw = raw.slice(0, bar.index).trim()
    }
  }

  // 剩余部分按 = 切分，第一段是主名称，其余为别名
  const parts = raw.split(/\s*=\s*/).map(s => s.trim()).filter(Boolean)
  const name = parts.shift() || ""
  if (!name) return null
  return { name, alias: dedupe(parts.filter(a => a !== name)), note }
}

/** 去空白、去空值、按首次出现顺序去重 */
function dedupe(list) {
  const out = []
  for (const item of list) {
    const value = String(item ?? "").trim()
    if (value && !out.includes(value)) out.push(value)
  }
  return out
}

/**
 * 目标的全部候选名，按搜索尝试顺序排列：主名称在前，别名在后。
 * @param {SparkTarget} target
 * @returns {string[]}
 */
export function targetCandidates(target) {
  return dedupe([target?.name, ...(target?.alias || [])])
}

/**
 * 展示用的一行文本：`张三（表妹）` 或 `张三 / 旧名`。
 * 用的是全角括号与斜杠，parseTargetText 解析不回来，编辑场景请用 targetText。
 * @param {SparkTarget} target
 * @returns {string} 无 name 时返回空串
 */
export function targetLabel(target) {
  if (!target?.name) return ""
  const parts = [target.name]
  if (target.note) parts.push(`（${target.note}）`)
  else if (target.alias?.length) parts.push(` / ${target.alias.join(" / ")}`)
  return parts.join("")
}

/**
 * 可编辑的一行文本：`主名=别名1=别名2(备注)`。
 *
 * 与 parseTargetText 严格互逆：锅巴与面板把目标渲染成文本给用户改，改完原样交回
 * normalizeTargets 即可解析回同一结构。targetLabel 的输出不具备这个性质，两者不可混用。
 *
 * @param {SparkTarget} target
 * @returns {string} 无 name 时返回空串
 */
export function targetText(target) {
  if (!target?.name) return ""
  const names = [target.name, ...(target.alias || [])].join("=")
  return target.note ? `${names}(${target.note})` : names
}

/**
 * 旧结构就地迁移：`targetNames: ["张三"]` → `targets: [{name:"张三",alias:[],note:""}]`。
 *
 * 迁移发生在每次 readRaw 读盘时，升级插件后无需手动操作。`targetNames` 字段保留并始终与
 * targets 的主名同步，旧版 Web 前端（web/app.js 在 targets 缺失时读 targetNames）仍可工作。
 */
function migrateAccount(acc) {
  if (!acc || typeof acc !== "object") return acc
  if (!Array.isArray(acc.targets)) acc.targets = normalizeTargets(acc.targetNames || [])
  else acc.targets = normalizeTargets(acc.targets)
  acc.targetNames = acc.targets.map(t => t.name)
  return acc
}

// ────────────────────────────── Cookie 解析 ──────────────────────────────

/**
 * 把宽松输入统一成 puppeteer cookie 数组。
 *
 * 支持三种粘贴形式：
 * 1. 浏览器 `document.cookie` 字符串 —— `a=1; b=2`
 * 2. EditThisCookie / Cookie-Editor 导出的 JSON 数组
 * 3. `{ cookies: [...] }` 包一层的对象
 *
 * @param {string|Array|object} input
 * @returns {Array<object>} 归一化后的 cookie 数组
 * @throws {Error} 输入为空、JSON 数组里没有带 name 的条目、或文本里解析不出任何键值对
 */
export function parseCookieInput(input) {
  const text = typeof input === "string" ? input.trim() : input
  if (!text) throw new Error("Cookie 内容为空")

  let value = text
  if (typeof text === "string" && (text.startsWith("[") || text.startsWith("{"))) {
    try {
      value = JSON.parse(text)
    } catch {
      // 不是合法 JSON 时退回按 document.cookie 字符串处理
      value = text
    }
  }

  if (value && typeof value === "object" && !Array.isArray(value) && Array.isArray(value.cookies))
    value = value.cookies

  if (Array.isArray(value)) {
    const out = []
    for (const item of value) {
      if (!item?.name) continue
      out.push(normalizeCookie(item))
    }
    if (!out.length) throw new Error("Cookie 数组中没有可用条目")
    return out
  }

  // 文本分支：按 ; 切分，只取第一个 = 之前为 name，域名与路径按抖音默认值补齐
  const out = []
  for (const pair of String(value).split(";")) {
    const idx = pair.indexOf("=")
    if (idx <= 0) continue
    const name = pair.slice(0, idx).trim()
    const val = pair.slice(idx + 1).trim()
    if (!name) continue
    out.push(normalizeCookie({ name, value: val, domain: ".douyin.com", path: "/" }))
  }
  if (!out.length) throw new Error("未能从文本中解析出 Cookie，请确认格式为 name=value; name2=value2")
  return out
}

/**
 * 单条 cookie 归一化。
 * 浏览器导出的 sameSite 是 no_restriction 这类内部值，须转成 puppeteer 接受的
 * None/Lax/Strict；过期时间兼容 expirationDate（扩展导出）与 expires，session cookie 记 -1。
 */
function normalizeCookie(cookie) {
  const sameSiteRaw = String(cookie.sameSite ?? "").toLowerCase()
  let sameSite = "Lax"
  if (sameSiteRaw === "no_restriction" || sameSiteRaw === "none") sameSite = "None"
  else if (sameSiteRaw === "strict") sameSite = "Strict"

  const expires = cookie.session
    ? -1
    : Number.isFinite(Number(cookie.expirationDate))
      ? Math.floor(Number(cookie.expirationDate))
      : Number.isFinite(Number(cookie.expires))
        ? Math.floor(Number(cookie.expires))
        : -1

  return {
    name: String(cookie.name),
    value: String(cookie.value ?? ""),
    domain: String(cookie.domain || ".douyin.com"),
    path: String(cookie.path || "/"),
    expires,
    httpOnly: cookie.httpOnly === true,
    // SameSite=None 的 cookie 浏览器强制要求 secure，否则 page.setCookie 会静默丢弃它
    secure: sameSite === "None" ? true : cookie.secure === true,
    sameSite,
  }
}

/**
 * 校验是否包含登录态字段，缺失即拒收，避免等到续火时才发现只粘了一半。
 * @param {Array<{name: string}>} cookies
 * @returns {true}
 * @throws {Error} sessionid / sessionid_ss / passport_csrf_token 三者全部缺失时抛出
 */
export function assertLoginCookie(cookies) {
  const names = new Set(cookies.map(c => c.name))
  if (!names.has("sessionid") && !names.has("sessionid_ss") && !names.has("passport_csrf_token"))
    throw new Error("Cookie 中缺少 sessionid 等登录字段，可能只复制了一部分")
  return true
}

/**
 * 登录态 cookie（sessionid / passport* / sid_*）中最早的过期时间，单位毫秒。
 * 落在账号的 cookieExpireAt 字段，供面板提示剩余可用时长；无有效期时返回 0。
 */
function cookieExpireAt(cookies) {
  const times = cookies
    .filter(c => /^sessionid|^passport|^sid_/.test(c.name))
    .map(c => Number(c.expires))
    .filter(t => Number.isFinite(t) && t > 0)
  if (!times.length) return 0
  return Math.min(...times) * 1000
}

// ────────────────────────────── 仓库 ──────────────────────────────

class AccountStore {
  /**
   * 列出某台机器人下的全部账号。
   * @param {string|number} botId
   * @param {object} [opts]
   * @param {boolean} [opts.withCookie] 是否带上 Cookie 密文；默认 false，面板与指令都走默认值
   * @returns {Array<object>} 已剥掉密文的账号列表，botId 无文件时为空数组
   */
  list(botId, { withCookie = false } = {}) {
    const data = readRaw(botId)
    return data.accounts.map(acc => this.#present(acc, withCookie))
  }

  /**
   * 按 id 取单个账号。跨 botId 取不到——查找只在该 botId 的文件内进行。
   * @returns {object|null} 不存在时返回 null
   */
  get(botId, accountId, { withCookie = false } = {}) {
    const data = readRaw(botId)
    const acc = data.accounts.find(a => a.id === accountId)
    return acc ? this.#present(acc, withCookie) : null
  }

  /**
   * 按名称精确查找。指令侧用户输入的是账号名而不是 id。
   * @returns {object|null} 名称为空或无匹配时返回 null
   */
  findByName(botId, name) {
    const key = String(name ?? "").trim()
    if (!key) return null
    const data = readRaw(botId)
    const acc = data.accounts.find(a => a.name === key)
    return acc ? this.#present(acc, false) : null
  }

  /**
   * 解密后的 cookie 数组，供 browser.js 注入页面。
   * @returns {Array<object>|null} 无 Cookie、解密失败或内容不是数组时返回 null（视为凭证失效）
   */
  cookies(botId, accountId) {
    const data = readRaw(botId)
    const acc = data.accounts.find(a => a.id === accountId)
    if (!acc?.cookie) return null
    try {
      const raw = isEncrypted(acc.cookie) ? decrypt(acc.cookie) : acc.cookie
      const parsed = JSON.parse(raw)
      return Array.isArray(parsed) ? parsed : null
    } catch (error) {
      log("error", `账号 ${acc.name} 的 Cookie 解密失败：`, error.message)
      return null
    }
  }

  /**
   * 新增或更新账号，锅巴、面板、扫码/手动登录共用。
   *
   * 定位规则：给了 `input.id` 按 id 找，否则按 name 找。同名视为更新而非新增，反复扫码
   * 登录同一个号不会堆出重复条目。只有出现在 input 里的字段被覆盖，未出现的保持原值。
   * `input.cookie` 接受原始粘贴文本或 cookie 数组，落盘前加密。
   *
   * @param {string|number} botId
   * @param {object} input 可含 id?、name、enable?、targets? 或 targetNames?、
   *   messageTemplate?、note?、cookie?
   * @returns {object} 剥掉密文的账号
   * @throws {Error} name 为空；或 cookie 解析失败 / 缺少登录字段（由 parseCookieInput 与
   *   assertLoginCookie 抛出）
   */
  upsert(botId, input) {
    const data = readRaw(botId)
    const name = String(input.name ?? "").trim()
    if (!name) throw new Error("账号名称不能为空")

    let acc = input.id ? data.accounts.find(a => a.id === input.id) : data.accounts.find(a => a.name === name)
    const now = Date.now()

    if (!acc) {
      acc = {
        id: randomToken(8),
        name,
        enable: true,
        targets: [],
        targetNames: [],
        messageTemplate: "",
        note: "",
        cookie: "",
        cookieUpdatedAt: 0,
        cookieExpireAt: 0,
        createdAt: now,
        lastRun: null,
      }
      data.accounts.push(acc)
    }

    acc.name = name
    if (input.enable !== undefined) acc.enable = input.enable !== false
    if (input.messageTemplate !== undefined) acc.messageTemplate = String(input.messageTemplate ?? "")
    if (input.note !== undefined) acc.note = String(input.note ?? "").slice(0, 60)

    // targets 优先；只给 targetNames 时按纯名称处理（兼容旧前端与手写 yaml）
    if (input.targets !== undefined) acc.targets = normalizeTargets(input.targets)
    else if (input.targetNames !== undefined) acc.targets = normalizeTargets(input.targetNames)
    acc.targetNames = acc.targets.map(t => t.name)

    if (input.cookie) {
      const cookies = Array.isArray(input.cookie) ? input.cookie.map(normalizeCookie) : parseCookieInput(input.cookie)
      assertLoginCookie(cookies)
      acc.cookie = encrypt(JSON.stringify(cookies))
      acc.cookieUpdatedAt = now
      acc.cookieExpireAt = cookieExpireAt(cookies)
      acc.cookieInvalid = false
      // 换了 Cookie，上次的检查结论作废
      acc.cookieCheck = null
      /*
       * 会话列表缓存一并作废：同一个账号名下换一份 Cookie，很可能换成了另一个抖音号
       * （反复扫码时常见），旧名单属于上一个号，留着会让用户点到错误的好友。
       * 同号重新登录的代价只是下次多等一轮真实拉取，低于展示错误名单的代价。
       */
      delete acc.friendsCache
    }

    acc.updatedAt = now
    writeRaw(botId, data)
    return this.#present(acc, false)
  }

  /**
   * 删除账号，并连带删除它在 chat.db 里的聊天记录。
   *
   * @returns {boolean} 该 botId 下没有这个 id 时返回 false，不写盘
   */
  remove(botId, accountId) {
    const data = readRaw(botId)
    const before = data.accounts.length
    data.accounts = data.accounts.filter(a => a.id !== accountId)
    if (data.accounts.length === before) return false
    writeRaw(botId, data)
    /*
     * chatdb.dropAccount 放在这里而不是三个调用点（apps/login.js、guoba.support.js、
     * lib/web.js）各写一遍：「账号删除后其聊天记录不应保留」是删除动作本身的数据生命周期
     * 约束，分散到调用点会在新增第四个入口时被漏掉，后果是 Cookie 已删而私聊内容仍留在
     * chat.db 里。
     *
     * 这里只清库，不关聊天会话：关会话需要 lib/chat.js，而 chat.js 已 import 本模块，
     * 反向引用会形成循环依赖。会话由调用方先关（见 lib/web.js 的删账号路由）。
     */
    chatdb.dropAccount(botId, accountId)
    return true
  }

  /**
   * 增删续火目标或改备注，指令与面板共用。
   *
   * @param {"add"|"remove"|"note"} action add=新增（同名则合并别名与备注）；
   *   remove=按主名或别名匹配后移除；note=按主名或别名定位后改备注（截断到 40 字）
   * @param {object} payload { name, alias?, note? }
   * @returns {object} 剥掉密文的账号
   * @throws {Error} 账号不存在、name 为空、好友名称无效、目标不在列表中、action 未知
   */
  editTarget(botId, accountId, action, payload) {
    const data = readRaw(botId)
    const acc = data.accounts.find(a => a.id === accountId)
    if (!acc) throw new Error("账号不存在")
    migrateAccount(acc)

    const name = String(payload?.name ?? "").trim()
    if (!name) throw new Error("请提供好友名称")

    if (action === "add") {
      const target = normalizeTargets([payload])[0]
      if (!target) throw new Error("好友名称无效")
      const exist = acc.targets.find(t => t.name === target.name)
      if (exist) {
        exist.alias = dedupe([...exist.alias, ...target.alias].filter(a => a !== exist.name))
        if (target.note) exist.note = target.note
      } else {
        acc.targets.push(target)
      }
    } else if (action === "remove") {
      // 主名与别名都算命中，用户记得哪个名字都能删掉
      const before = acc.targets.length
      acc.targets = acc.targets.filter(t => t.name !== name && !t.alias.includes(name))
      if (acc.targets.length === before) throw new Error(`「${name}」不在续火列表中`)
    } else if (action === "note") {
      const target = acc.targets.find(t => t.name === name || t.alias.includes(name))
      if (!target) throw new Error(`「${name}」不在续火列表中`)
      target.note = String(payload?.note ?? "").trim().slice(0, 40)
    } else {
      throw new Error(`未知操作：${action}`)
    }

    acc.targetNames = acc.targets.map(t => t.name)
    acc.updatedAt = Date.now()
    writeRaw(botId, data)
    return this.#present(acc, false)
  }

  /**
   * 好友改名后的自愈：把命中的别名提为主名称，原主名称降为别名。
   * 由 lib/spark.js 在「主名称搜不到、别名搜到了」时调用。
   *
   * @returns {boolean} 参数无效、两名相同、账号不存在或找不到 oldName 对应目标时返回 false
   */
  promoteAlias(botId, accountId, oldName, hitName) {
    if (!oldName || !hitName || oldName === hitName) return false
    const data = readRaw(botId)
    const acc = data.accounts.find(a => a.id === accountId)
    if (!acc) return false
    migrateAccount(acc)

    const target = acc.targets.find(t => t.name === oldName)
    if (!target) return false
    target.alias = dedupe([oldName, ...target.alias].filter(a => a !== hitName))
    target.name = hitName
    acc.targetNames = acc.targets.map(t => t.name)
    acc.updatedAt = Date.now()
    writeRaw(botId, data)
    log("mark", `账号「${acc.name}」的好友「${oldName}」已改名为「${hitName}」，续火目标自动更新`)
    return true
  }

  /**
   * 续火结束后回写结果。状态面板、推送与「今天是否已续火」的判定都读这里。
   * @returns {object|null} 写入的 lastRun；账号不存在时返回 null
   */
  recordRun(botId, accountId, result) {
    const data = readRaw(botId)
    const acc = data.accounts.find(a => a.id === accountId)
    if (!acc) return null
    acc.lastRun = {
      at: Date.now(),
      ok: result?.ok !== false,
      sent: result?.sent || [],
      missing: result?.missing || [],
      error: result?.error ? String(result.error) : "",
      durationMs: Number(result?.durationMs) || 0,
    }
    // lastSuccessAt 只在成功那次更新：spark.doneToday 读它，失败的一天下次定时仍要重试
    if (acc.lastRun.ok) acc.lastSuccessAt = acc.lastRun.at
    if (result?.cookieInvalid) acc.cookieInvalid = true
    writeRaw(botId, data)
    return acc.lastRun
  }

  /**
   * 标记凭证失效，面板与状态图据此红显提示重新登录。
   * @returns {boolean} 账号不存在时返回 false
   */
  markCookieInvalid(botId, accountId, invalid = true) {
    const data = readRaw(botId)
    const acc = data.accounts.find(a => a.id === accountId)
    if (!acc) return false
    acc.cookieInvalid = invalid === true
    writeRaw(botId, data)
    return true
  }

  /**
   * 记录一次 Cookie 有效性检查结果，同时同步 cookieInvalid。
   * 检查一次要真开浏览器访问抖音，缓存结论可避免面板连点几下发出多轮请求。
   *
   * @returns {object|null} 写入的 `{at, ok, message}`；账号不存在时返回 null
   */
  recordCookieCheck(botId, accountId, ok, message = "") {
    const data = readRaw(botId)
    const acc = data.accounts.find(a => a.id === accountId)
    if (!acc) return null
    acc.cookieCheck = { at: Date.now(), ok: ok === true, message: String(message || "") }
    acc.cookieInvalid = ok !== true
    writeRaw(botId, data)
    return acc.cookieCheck
  }

  /**
   * 未过期的检查结论。
   * @param {number} ttlMs 有效期，来自 `spark.cookieCheckTTL`（分钟）换算
   * @returns {object|null} ttlMs 非正数、无记录或已过期时返回 null
   */
  cachedCookieCheck(botId, accountId, ttlMs) {
    if (!(ttlMs > 0)) return null
    const acc = this.get(botId, accountId)
    const check = acc?.cookieCheck
    if (!check?.at) return null
    return Date.now() - check.at <= ttlMs ? check : null
  }

  /**
   * 记录一次会话（好友）列表拉取结果。
   *
   * 与 cookieCheck 共用「写 `{at, ...}` + 按 TTL 判过期」的形状，不另起一套缓存机制：两者
   * 诉求相同（真实操作代价高、结论在一段时间内可复用）。存在账号 json 里的另一个好处是
   * 好友名单跟随账号生命周期，账号删除时缓存自动消失，无需额外清理。
   *
   * @returns {object|null} 写入的 `{at, names}`；账号不存在时返回 null
   */
  recordFriends(botId, accountId, names) {
    const data = readRaw(botId)
    const acc = data.accounts.find(a => a.id === accountId)
    if (!acc) return null
    acc.friendsCache = { at: Date.now(), names: (names || []).map(String) }
    writeRaw(botId, data)
    return acc.friendsCache
  }

  /**
   * 未过期的会话列表缓存。
   * @param {number} ttlMs 有效期，来自 `spark.friendsCacheTTL`（分钟）换算
   * @returns {object|null} ttlMs 非正数、无记录、names 不是数组或已过期时返回 null
   */
  cachedFriends(botId, accountId, ttlMs) {
    if (!(ttlMs > 0)) return null
    // 这里直读 raw 而不是 this.get()：#present 会摘掉 friendsCache（那批昵称不该随每次
    // /api/accounts 下发给前端），走 get() 就读不到 names
    const data = readRaw(botId)
    const cache = data.accounts.find(a => a.id === accountId)?.friendsCache
    if (!cache?.at || !Array.isArray(cache.names)) return null
    return Date.now() - cache.at <= ttlMs ? cache : null
  }

  /**
   * 所有存在账号文件的机器人 ID（accountsDir 下的 .json 去掉后缀）。
   * 定时任务与状态面板靠它遍历。
   * @returns {string[]} 目录不存在时为空数组
   */
  allBots() {
    if (!fs.existsSync(accountsDir)) return []
    return fs
      .readdirSync(accountsDir)
      .filter(f => f.endsWith(".json"))
      .map(f => f.slice(0, -5))
  }

  /**
   * 对外展示的账号视图：剥掉密文，补上 hasCookie 与 cookiePreview（maskSecret 打码）。
   * withCookie 为 true 时才把密文放回 out.cookie。
   */
  #present(acc, withCookie) {
    const out = { ...migrateAccount(acc) }
    delete out.cookie
    /*
     * 会话列表缓存不外发，只给 friendsCached = {at, count}。
     *
     * names 最多 200 个好友昵称，而 /api/accounts 是面板每次刷新都调的接口：整份名单塞进
     * 每次响应既是无谓流量，也等于把用户的抖音好友列表反复推到公网。需要名单时走
     * /api/accounts/:id/friends 单独取。
     */
    delete out.friendsCache
    out.friendsCached = acc.friendsCache?.at
      ? { at: acc.friendsCache.at, count: acc.friendsCache.names?.length || 0 }
      : null
    out.hasCookie = Boolean(acc.cookie)
    out.cookiePreview = acc.cookie ? maskSecret(acc.cookie, 6, 4) : ""
    if (withCookie) out.cookie = acc.cookie
    return out
  }
}

export const store = new AccountStore()
export default store
