/**
 * 账号仓库：抖音账号与续火目标的持久化。
 *
 * 存储布局 `data/accounts/<botId>.json`，一台机器人一个文件。多 bot 场景下
 * A 机器人的面板会话根本读不到 B 的文件，隔离由文件边界保证而不是靠代码里的
 * if 判断；同时避免所有账号挤在一个文件里被并发写坏。
 *
 * Cookie 在进入本模块时就被 AES-256-GCM 加密（见 lib/crypto.js），
 * 对外的 `list/get` 默认剥掉密文，只给 `hasCookie` 与打码预览。
 */
import fs from "node:fs"
import path from "node:path"
import { dataDir, ensureDir, log, safeFileName, toIdList, maskSecret } from "./util.js"
import { encrypt, decrypt, isEncrypted, randomToken } from "./crypto.js"

const accountsDir = ensureDir(dataDir, "accounts")

function fileOf(botId) {
  return path.join(accountsDir, `${safeFileName(botId, "unknown")}.json`)
}

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

/** 原子写：先写 .tmp 再 rename，避免进程被杀在写一半时留下坏文件 */
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
 * 好友改名是断火最常见的原因，所以目标不再是一个裸昵称字符串，而是
 * `{ name, alias[], note }`：
 * - `name`  当前用于搜索的主名称（抖音里的备注名优先于昵称）
 * - `alias` 历史名 / 备用名。搜索时按 name → alias 依次尝试，任一命中即算成功；
 *           命中的是别名时会自动把它提到 name，下次直接用新名字搜，等于自愈。
 * - `note`  给人看的备注（"表妹"、"同事老王"），只用于展示，不参与搜索。
 *
 * @typedef {{name: string, alias: string[], note: string}} SparkTarget
 */

/**
 * 把宽松输入归一化成 SparkTarget 数组。
 *
 * 接受的形式：
 * - `"A、B"` / `["A", "B"]`                       —— 纯名称，旧配置就是这样
 * - `[{ name, alias, note }]`                     —— 面板/锅巴的完整结构
 * - `"张三(表妹)"` / `"张三｜表妹"`                 —— 指令里顺手写的备注
 * - `"张三=小三三"`                                 —— 等号后面是别名，可多个
 */
export function normalizeTargets(input) {
  const list = Array.isArray(input) ? input : toIdList(input)
  const out = []

  for (const item of list) {
    const target = typeof item === "object" && item ? fromObject(item) : parseTargetText(item)
    if (!target?.name) continue
    // 同名目标只保留一个，别名与备注合并，防止面板重复添加
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
 * 语法：`主名称[=别名1=别名2][(备注)]`，备注也支持全角括号与竖线。
 */
function parseTargetText(text) {
  let raw = String(text ?? "").trim()
  if (!raw) return null

  let note = ""
  // 备注：末尾的 (xxx) / （xxx） / ｜xxx / |xxx
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

  const parts = raw.split(/\s*=\s*/).map(s => s.trim()).filter(Boolean)
  const name = parts.shift() || ""
  if (!name) return null
  return { name, alias: dedupe(parts.filter(a => a !== name)), note }
}

function dedupe(list) {
  const out = []
  for (const item of list) {
    const value = String(item ?? "").trim()
    if (value && !out.includes(value)) out.push(value)
  }
  return out
}

/** 目标的全部候选名，按尝试顺序：主名称在前，别名在后 */
export function targetCandidates(target) {
  return dedupe([target?.name, ...(target?.alias || [])])
}

/** 展示用的一行文本：`张三（表妹）` 或 `张三 / 旧名` */
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
 * 与 `parseTargetText` 严格互逆——锅巴/面板把目标渲染成文本给用户改，改完原样
 * 交回 `normalizeTargets` 就能解析回来。`targetLabel` 用的全角括号和斜杠是给人看的，
 * 解析不回去，所以两个函数不能混用。
 */
export function targetText(target) {
  if (!target?.name) return ""
  const names = [target.name, ...(target.alias || [])].join("=")
  return target.note ? `${names}(${target.note})` : names
}

/**
 * 旧数据迁移：`targetNames: ["张三"]` → `targets: [{name:"张三",alias:[],note:""}]`。
 * 迁移在每次读盘时就地完成，用户升级插件后无需任何手动操作；
 * `targetNames` 字段保留并与 targets 同步，Web 面板旧版本前端也不会崩。
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
 * 支持三种粘贴形式，用户从哪抄的都能吃下：
 * 1. 浏览器 `document.cookie` 字符串 —— `a=1; b=2`
 * 2. EditThisCookie / Cookie-Editor 导出的 JSON 数组
 * 3. `{ cookies: [...] }` 包一层的对象
 */
export function parseCookieInput(input) {
  const text = typeof input === "string" ? input.trim() : input
  if (!text) throw new Error("Cookie 内容为空")

  let value = text
  if (typeof text === "string" && (text.startsWith("[") || text.startsWith("{"))) {
    try {
      value = JSON.parse(text)
    } catch {
      // 不是合法 JSON 就退回按 document.cookie 字符串处理
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

/** 浏览器导出的 sameSite 是 no_restriction 这类内部值，要转成 puppeteer 认的枚举 */
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
    // SameSite=None 的 cookie 浏览器强制要求 secure，否则 setCookie 会静默丢弃
    secure: sameSite === "None" ? true : cookie.secure === true,
    sameSite,
  }
}

/** 关键登录态字段缺失就直接拒收，省得等到跑续火时才发现只粘了一半 */
export function assertLoginCookie(cookies) {
  const names = new Set(cookies.map(c => c.name))
  if (!names.has("sessionid") && !names.has("sessionid_ss") && !names.has("passport_csrf_token"))
    throw new Error("Cookie 中缺少 sessionid 等登录字段，可能只复制了一部分")
  return true
}

/** 登录态 cookie 里最早的过期时间，用于在面板上提示「还能用多久」 */
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
   * 列出某台机器人下的账号。
   * @param {boolean} [opts.withCookie] 是否带上 Cookie 密文，仅续火引擎内部使用
   */
  list(botId, { withCookie = false } = {}) {
    const data = readRaw(botId)
    return data.accounts.map(acc => this.#present(acc, withCookie))
  }

  get(botId, accountId, { withCookie = false } = {}) {
    const data = readRaw(botId)
    const acc = data.accounts.find(a => a.id === accountId)
    return acc ? this.#present(acc, withCookie) : null
  }

  /** 按名称查找，指令里用户输入的是账号名而不是 id */
  findByName(botId, name) {
    const key = String(name ?? "").trim()
    if (!key) return null
    const data = readRaw(botId)
    const acc = data.accounts.find(a => a.name === key)
    return acc ? this.#present(acc, false) : null
  }

  /** 解密后的 cookie 数组；解密失败视为凭证失效，返回 null */
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
   * 新增或更新账号。
   *
   * 同名视为更新而非新增——扫码登录反复扫同一个号时不会堆出一串重复条目。
   * `input.cookie` 接受原始粘贴文本或 cookie 数组，落盘前加密。
   *
   * @param {object} input { id?, name, enable?, targets?|targetNames?, messageTemplate?, note?, cookie? }
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
      // 换了 Cookie，上次检查结论作废
      acc.cookieCheck = null
      /*
       * 会话列表缓存一并作废：同一个账号名下换一份 Cookie，很可能换的是另一个抖音号
       * （反复扫码时尤其常见），那份名单就是上一个号的好友，留着只会让人往错的名字上点。
       * 同号重新登录的代价只是下次多等一轮真拉，比列错名单便宜。
       */
      delete acc.friendsCache
    }

    acc.updatedAt = now
    writeRaw(botId, data)
    return this.#present(acc, false)
  }

  remove(botId, accountId) {
    const data = readRaw(botId)
    const before = data.accounts.length
    data.accounts = data.accounts.filter(a => a.id !== accountId)
    if (data.accounts.length === before) return false
    writeRaw(botId, data)
    return true
  }

  /**
   * 给某个账号增删续火目标，指令与面板共用。
   * @param {"add"|"remove"|"note"} action
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
   * 由续火引擎在「主名称搜不到、别名搜到了」时调用。
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

  /** 续火结束后回写结果，状态面板、推送与「今天是否已续火」都读这里 */
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
    // 只有真正成功那次才更新，用于跳过判定：失败的一天下次定时还要重试
    if (acc.lastRun.ok) acc.lastSuccessAt = acc.lastRun.at
    if (result?.cookieInvalid) acc.cookieInvalid = true
    writeRaw(botId, data)
    return acc.lastRun
  }

  /** 标记凭证失效，面板与状态图上红显提示重新登录 */
  markCookieInvalid(botId, accountId, invalid = true) {
    const data = readRaw(botId)
    const acc = data.accounts.find(a => a.id === accountId)
    if (!acc) return false
    acc.cookieInvalid = invalid === true
    writeRaw(botId, data)
    return true
  }

  /**
   * 记录一次 Cookie 有效性检查结果。
   * 检查要真开浏览器访问抖音，缓存结论可以避免面板上连点几下就发出好几轮请求。
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

  /** 缓存未过期的检查结论，过期或没有则返回 null */
  cachedCookieCheck(botId, accountId, ttlMs) {
    if (!(ttlMs > 0)) return null
    const acc = this.get(botId, accountId)
    const check = acc?.cookieCheck
    if (!check?.at) return null
    return Date.now() - check.at <= ttlMs ? check : null
  }

  /**
   * 记录一次会话列表拉取结果。
   *
   * 与 cookieCheck 用同一套「写 {at, ...} + 按 TTL 判过期」的形状，不另起一套缓存机制：
   * 两者的诉求完全一样（一次真操作很贵、结论在一段时间内可复用），而账号 json 本来就
   * 是这份数据的家 —— 好友名单跟着账号走，账号删了缓存自然一起没了，不需要额外清理。
   */
  recordFriends(botId, accountId, names) {
    const data = readRaw(botId)
    const acc = data.accounts.find(a => a.id === accountId)
    if (!acc) return null
    acc.friendsCache = { at: Date.now(), names: (names || []).map(String) }
    writeRaw(botId, data)
    return acc.friendsCache
  }

  /** 缓存未过期的会话列表，过期或没有则返回 null */
  cachedFriends(botId, accountId, ttlMs) {
    if (!(ttlMs > 0)) return null
    // 这里读 raw 而不是 this.get()：#present 会把 friendsCache 摘掉（那 200 个昵称
    // 不该跟着每次 /api/accounts 一起发给前端），摘掉之后就读不到 names 了
    const data = readRaw(botId)
    const cache = data.accounts.find(a => a.id === accountId)?.friendsCache
    if (!cache?.at || !Array.isArray(cache.names)) return null
    return Date.now() - cache.at <= ttlMs ? cache : null
  }

  /** 所有有账号文件的机器人 ID，定时任务与状态面板靠它遍历 */
  allBots() {
    if (!fs.existsSync(accountsDir)) return []
    return fs
      .readdirSync(accountsDir)
      .filter(f => f.endsWith(".json"))
      .map(f => f.slice(0, -5))
  }

  /** 对外展示时去掉密文，只给「是否已配置 + 打码预览」 */
  #present(acc, withCookie) {
    const out = { ...migrateAccount(acc) }
    delete out.cookie
    /*
     * 会话列表缓存不外发，只给「几条 + 什么时候拉的」。
     *
     * 那是最多 200 个好友昵称，而 /api/accounts 是面板每次刷新都调的接口 —— 把整份名单
     * 塞进每次响应既是白流量，也等于把用户的抖音好友列表反复推到公网上。真要用名单时
     * 走 /api/accounts/:id/friends 单独取。
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
