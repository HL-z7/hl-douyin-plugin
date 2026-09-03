/**
 * 聊天记录落盘层：会话列表与消息，用 Node 内置的 `node:sqlite`。
 *
 * 为什么不塞进 lib/store.js 那份账号 json：那边是「整文件 JSON.parse → 改 → 整文件
 * 覆写」的模型（见 store.js 的 readRaw/writeRaw），追加一条消息要把该机器人名下所有
 * 账号连 Cookie 密文一起重新 stringify 落盘一次。已有的 friendsCache（200 个昵称）
 * 已经是那套结构的天花板，聊天记录比它大两三个数量级。而且 store 没有任何互斥，
 * 聊天天然并发（用户在点、前端在轮询、页面在收新消息），read-modify-write 丢更新
 * 是必然而不是偶然。
 *
 * 为什么是 node:sqlite 而不是 better-sqlite3 / sqlite3 / level：
 * - `better-sqlite3` 虽然在 Yunzai 的 node_modules 里（传递依赖），但 require 直接失败
 *   （bindings.js 找不到 file-uri-to-path），不能依赖
 * - 根 package.json 声明的 `sqlite3` 在运行容器里 require 不到
 * - `Bot.getMap()`（LevelDB）打开时会把整表 for-await 读进内存，聊天历史不适合
 * - `node:sqlite` 是内置模块，零新依赖，容器里实测 WAL 可开、5000 行事务写入 10ms
 *
 * 代价是它要 Node ≥ 22.5。取不到时本模块整体降级为「不落盘」：ready() 返回 false，
 * 聊天界面照样能用，只是看不到本地历史（而不是整个功能不可用）。
 */
import path from "node:path"
import { createRequire } from "node:module"
import { dataDir, ensureDir, log } from "./util.js"

const dbPath = path.join(ensureDir(dataDir), "chat.db")

/** DatabaseSync 实例；null 表示还没打开或打不开 */
let db = null
/** 打不开的原因，面板上要能看到，不然用户只会觉得「历史怎么没了」 */
let broken = ""
/** 预编译语句缓存：同一条 SQL 反复 prepare 是纯浪费 */
const stmts = new Map()

const SCHEMA = `
CREATE TABLE IF NOT EXISTS conversations (
  bot_id   TEXT NOT NULL,
  acc_id   TEXT NOT NULL,
  peer     TEXT NOT NULL,
  preview  TEXT NOT NULL DEFAULT '',
  stamp    TEXT NOT NULL DEFAULT '',
  unread   INTEGER NOT NULL DEFAULT 0,
  last_at  INTEGER NOT NULL DEFAULT 0,
  seen_at  INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (bot_id, acc_id, peer)
);
CREATE TABLE IF NOT EXISTS messages (
  id     INTEGER PRIMARY KEY AUTOINCREMENT,
  bot_id TEXT NOT NULL,
  acc_id TEXT NOT NULL,
  peer   TEXT NOT NULL,
  self   INTEGER NOT NULL,
  text   TEXT NOT NULL,
  stamp  TEXT NOT NULL DEFAULT '',
  at     INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_msg_peer ON messages (bot_id, acc_id, peer, id);
`

/**
 * 打开数据库。只在第一次调用时真的做事，之后靠 db/broken 两个状态短路。
 *
 * 整个函数不抛异常：Node < 22.5 没有 node:sqlite、磁盘只读、data 目录被占，
 * 任何一种都只是让聊天界面失去历史，不该让 `#抖音` 的其它功能一起崩。
 */
function open() {
  if (db || broken) return db
  try {
    // 用 createRequire 而不是顶层 import "node:sqlite"：顶层 import 一个不存在的内置
    // 模块会让整个文件加载失败，那就不是「降级」而是把插件一起带走了。也不用
    // await import，因为本模块所有导出都是同步的，不想为了打开数据库把 API 全变 async。
    const { DatabaseSync } = createRequire(import.meta.url)("node:sqlite")
    if (!DatabaseSync) throw new Error("node:sqlite 无 DatabaseSync")
    db = new DatabaseSync(dbPath)
    // WAL：读不阻塞写。前端在轮询（读）而页面在收新消息（写），默认的 rollback
    // journal 会让两边互相等锁。容器 v26.8.1 实测返回 wal。
    db.exec("PRAGMA journal_mode = WAL")
    // 聊天记录丢最后几条无所谓，但每条消息 fsync 一次会把发消息的延迟拖到几十毫秒。
    db.exec("PRAGMA synchronous = NORMAL")
    db.exec(SCHEMA)
    log("debug", `[chatdb] 已打开 ${dbPath}`)
  } catch (err) {
    db = null
    broken = err?.message || String(err)
    log("warn", `[chatdb] 聊天记录不落盘：${broken}`)
  }
  return db
}

/** 取预编译语句；数据库打不开时返回 null，调用方一律「拿不到就当没历史」 */
function stmt(sql) {
  if (!open()) return null
  let s = stmts.get(sql)
  if (!s) {
    s = db.prepare(sql)
    stmts.set(sql, s)
  }
  return s
}

/** 落盘层是否可用。面板要据此决定显不显示「历史不可用」的提示 */
export function ready() {
  return !!open()
}

/** 给面板/日志看的状态：可用与否、库在哪、坏了的原因、当前存了多少条 */
export function status() {
  const ok = ready()
  let messages = 0
  let conversations = 0
  if (ok) {
    try {
      messages = stmt("SELECT COUNT(*) AS n FROM messages").get().n
      conversations = stmt("SELECT COUNT(*) AS n FROM conversations").get().n
    } catch { /* 统计失败不值得让状态接口报错 */ }
  }
  return { ok, path: dbPath, reason: broken, messages, conversations }
}

/* ---------------------------------- 会话 ---------------------------------- */

/**
 * 把抖音页面上读到的会话列表并进本地。
 *
 * 「并」而不是「覆盖」：抖音的会话列表只显示最近若干条，往下滚才会加载更多。
 * 如果直接按远端结果重建表，用户三个月没联系的人就会从本地列表里消失——而用户
 * 明确要求「会话不过期」。所以远端有的更新预览与时间，远端没有的原样留着。
 *
 * @param {string} botId
 * @param {string} accId
 * @param {Array<{peer:string, preview?:string, stamp?:string}>} items 页面顺序
 */
export function mergeConversations(botId, accId, items) {
  if (!open() || !Array.isArray(items) || !items.length) return 0
  const up = stmt(`
    INSERT INTO conversations (bot_id, acc_id, peer, preview, stamp, last_at)
    VALUES (?, ?, ?, ?, ?, ?)
    ON CONFLICT (bot_id, acc_id, peer) DO UPDATE SET
      preview = CASE WHEN excluded.preview <> '' THEN excluded.preview ELSE preview END,
      stamp   = CASE WHEN excluded.stamp   <> '' THEN excluded.stamp   ELSE stamp   END,
      last_at = MAX(last_at, excluded.last_at)
  `)
  const now = Date.now()
  let n = 0
  db.exec("BEGIN")
  try {
    for (const [i, it] of items.entries()) {
      const peer = String(it?.peer || "").trim()
      if (!peer) continue
      // 页面顺序就是「最近」顺序，但抖音只给「昨天」「3天前」这种模糊时间戳，
      // 换不出真实毫秒。用 now 减序号让排序稳定且与页面一致，同时不会把
      // 旧会话的 last_at 抬到未来（MAX 只增不减，见上面的 ON CONFLICT）。
      up.run(botId, accId, peer, String(it?.preview || ""), String(it?.stamp || ""), now - i)
      n++
    }
    db.exec("COMMIT")
  } catch (err) {
    db.exec("ROLLBACK")
    log("warn", `[chatdb] 合并会话列表失败：${err?.message || err}`)
    return 0
  }
  return n
}

/** 会话列表，最近的在前。unread 是本地累计的，抖音那边读不到数字 */
export function listConversations(botId, accId, limit = 200) {
  const s = stmt(`
    SELECT peer, preview, stamp, unread, last_at AS lastAt, seen_at AS seenAt
    FROM conversations WHERE bot_id = ? AND acc_id = ?
    ORDER BY last_at DESC LIMIT ?
  `)
  return s ? s.all(botId, accId, limit) : []
}

/** 进入会话时清未读。seen_at 留着，将来要做「新消息分割线」就靠它 */
export function markSeen(botId, accId, peer) {
  stmt(`
    UPDATE conversations SET unread = 0, seen_at = ?
    WHERE bot_id = ? AND acc_id = ? AND peer = ?
  `)?.run(Date.now(), botId, accId, peer)
}

/* ---------------------------------- 消息 ---------------------------------- */

/**
 * 一条消息的去重键。抖音不给消息 id，只能拿「谁说的 + 说了什么 + 页面时间戳」当身份。
 * 分隔符用 \x1f（单元分隔符）而不是空格：昵称和正文里都可能有空格，
 * 用可打印字符当分隔符会让不同的三元组撞成同一个键。
 */
function key(m) {
  return [m.self ? 1 : 0, m.text, m.stamp || ""].join("\x1f")
}

/**
 * 把页面上读到的一屏气泡追加进库，返回真正新增的条数。
 *
 * 难点全在去重：每次轮询读到的都是同一批可见气泡（旧的在前、新的在后），
 * 不去重就会把整屏历史重复插进去。抖音又不给消息 id，所以做法是把「已存的尾部」
 * 和「刚读到的这一屏」求最长重叠后缀 —— 已存尾部的某个后缀等于本屏的某个前缀时，
 * 本屏剩下的部分才是新消息。
 *
 * 这个判据对「连发两条一样的话」是保守的：它会认为第二条是重复而丢掉。反过来
 * （宁可漏一条也不要每 3 秒把历史翻倍）是刻意选的，因为重复插入是不可逆的污染，
 * 漏掉的那条下次页面刷新还在。
 *
 * @param {Array<{self:boolean, text:string, stamp?:string}>} bubbles 页面顺序（旧→新）
 */
export function appendMessages(botId, accId, peer, bubbles) {
  if (!open() || !Array.isArray(bubbles) || !bubbles.length) return 0

  const fresh = bubbles
    .map(b => ({ self: !!b.self, text: String(b?.text || "").trim(), stamp: String(b?.stamp || "") }))
    .filter(b => b.text)
  if (!fresh.length) return 0

  // 取和本屏同量的已存尾部就够：重叠不可能超过本屏长度
  const tail = stmt(`
    SELECT self, text, stamp FROM messages
    WHERE bot_id = ? AND acc_id = ? AND peer = ?
    ORDER BY id DESC LIMIT ?
  `).all(botId, accId, peer, fresh.length).reverse()

  const tailKeys = tail.map(key)
  const freshKeys = fresh.map(key)

  // 从「整个本屏都是旧的」开始往下试，第一个对得上的重叠长度就是最长的
  let overlap = 0
  for (let len = Math.min(tailKeys.length, freshKeys.length); len > 0; len--) {
    let same = true
    for (let i = 0; i < len; i++) {
      if (tailKeys[tailKeys.length - len + i] !== freshKeys[i]) { same = false; break }
    }
    if (same) { overlap = len; break }
  }

  const add = fresh.slice(overlap)
  if (!add.length) return 0

  const ins = stmt(`
    INSERT INTO messages (bot_id, acc_id, peer, self, text, stamp, at)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `)
  const now = Date.now()
  db.exec("BEGIN")
  try {
    for (const [i, m] of add.entries())
      ins.run(botId, accId, peer, m.self ? 1 : 0, m.text, m.stamp, now + i)
    db.exec("COMMIT")
  } catch (err) {
    db.exec("ROLLBACK")
    log("warn", `[chatdb] 写入消息失败：${err?.message || err}`)
    return 0
  }

  // 会话表跟着动：预览取最后一条，对方发来的才累未读
  const last = add[add.length - 1]
  const incoming = add.filter(m => !m.self).length
  stmt(`
    INSERT INTO conversations (bot_id, acc_id, peer, preview, stamp, unread, last_at)
    VALUES (?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT (bot_id, acc_id, peer) DO UPDATE SET
      preview = excluded.preview,
      stamp   = CASE WHEN excluded.stamp <> '' THEN excluded.stamp ELSE stamp END,
      unread  = unread + excluded.unread,
      last_at = excluded.last_at
  `).run(botId, accId, peer, last.text, last.stamp, incoming, Date.now())

  return add.length
}

/**
 * 记一条我们自己发出去的消息。
 *
 * 单独开一个入口而不是复用 appendMessages，是因为这条消息的可信度不一样：
 * sendMessage 回读过字数、确认过 Enter 发下去了，此时立刻入库，前端就能马上
 * 看到自己发的话，不用等下一轮轮询把它从页面上读回来。而下一轮真读到它时，
 * appendMessages 的重叠去重会认出这是同一条（self+text 一致，stamp 都为空）。
 */
export function recordSent(botId, accId, peer, text) {
  return appendMessages(botId, accId, peer, [{ self: true, text, stamp: "" }])
}

/**
 * 拉历史。默认给最近 60 条，返回时按时间正序（旧→新），前端直接从上往下渲染。
 *
 * `beforeId` 用于向上翻页：传当前最上面那条的 id，拿它之前的一页。
 */
export function history(botId, accId, peer, { limit = 60, beforeId = 0 } = {}) {
  const sql = beforeId
    ? `SELECT id, self, text, stamp, at FROM messages
       WHERE bot_id = ? AND acc_id = ? AND peer = ? AND id < ?
       ORDER BY id DESC LIMIT ?`
    : `SELECT id, self, text, stamp, at FROM messages
       WHERE bot_id = ? AND acc_id = ? AND peer = ?
       ORDER BY id DESC LIMIT ?`
  const s = stmt(sql)
  if (!s) return []
  const rows = beforeId
    ? s.all(botId, accId, peer, beforeId, limit)
    : s.all(botId, accId, peer, limit)
  return rows.reverse().map(r => ({ id: r.id, self: !!r.self, text: r.text, stamp: r.stamp, at: r.at }))
}

/** 比 sinceId 更新的消息。前端轮询用这个，没有新消息时返回空数组 */
export function since(botId, accId, peer, sinceId) {
  const s = stmt(`
    SELECT id, self, text, stamp, at FROM messages
    WHERE bot_id = ? AND acc_id = ? AND peer = ? AND id > ?
    ORDER BY id ASC LIMIT 200
  `)
  if (!s) return []
  return s.all(botId, accId, peer, sinceId)
    .map(r => ({ id: r.id, self: !!r.self, text: r.text, stamp: r.stamp, at: r.at }))
}

/**
 * 删掉一个账号的全部聊天数据。账号从面板里移除时调用——Cookie 都不留了，
 * 聊天记录留着既没用又是隐私负担。
 */
export function dropAccount(botId, accId) {
  if (!open()) return
  db.exec("BEGIN")
  try {
    stmt("DELETE FROM messages WHERE bot_id = ? AND acc_id = ?").run(botId, accId)
    stmt("DELETE FROM conversations WHERE bot_id = ? AND acc_id = ?").run(botId, accId)
    db.exec("COMMIT")
  } catch (err) {
    db.exec("ROLLBACK")
    log("warn", `[chatdb] 清理账号聊天数据失败：${err?.message || err}`)
  }
}

/** 关库。只有热重载/退出时需要，平时不用管 */
export function close() {
  if (!db) return
  try { db.close() } catch { /* 已经关了或进程正在退出，没什么可做的 */ }
  db = null
  stmts.clear()
}
