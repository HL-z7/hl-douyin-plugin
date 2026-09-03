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
 * 聊天界面照样能用，只是看不到本地历史（而不是整个功能不可用）。因此所有导出都要能在
 * db 为 null 时正常返回（空数组 / 0 / 无操作），不允许抛异常。
 *
 * 导出：ready / status（可用性），mergeConversations / listConversations / markSeen（会话），
 * appendMessages / recordSent / history / since（消息），dropAccount / close（清理）。
 * 全部是同步函数，见 open() 里不用 await import 的原因。
 *
 * 依赖：仅 node:path、node:module 与 lib/util.js 的路径常量，不读配置、不碰浏览器。
 *
 * 使用方：lib/chat.js（`import * as chatdb` 后转导出，页面读到的气泡都经 appendMessages
 * 落库）、lib/store.js 删账号时调 dropAccount、lib/panel.js 与 lib/web.js 取 status、
 * lib/shutdown.js 退出时调 close。
 *
 * 调用前提：botId / accId / peer 三元组共同定位一个会话，调用方必须保证传的是同一套标识
 * （peer 用抖音昵称，见 lib/chat.js 的 readItems）。
 */
import path from "node:path"
import { createRequire } from "node:module"
import { dataDir, ensureDir, log } from "./util.js"

const dbPath = path.join(ensureDir(dataDir), "chat.db")

/** DatabaseSync 实例；null 表示还没打开或打不开 */
let db = null
/** 打不开的原因，面板要显示出来，否则用户只会看到「历史怎么没了」 */
let broken = ""
/** 预编译语句缓存，键就是 SQL 原文；同一条 SQL 反复 prepare 是纯浪费 */
const stmts = new Map()

/**
 * 建表语句，每次 open() 都执行一遍（全部带 IF NOT EXISTS，幂等）。
 *
 * conversations 以 (bot_id, acc_id, peer) 为主键，让 mergeConversations 能用 ON CONFLICT
 * 做 upsert；messages 用自增 id 而不是复合键，因为前端翻页与增量拉取都按 id 比较大小
 * （history 的 beforeId、since 的 sinceId），单调 id 比时间戳可靠 —— 抖音只给「昨天」这类
 * 模糊时间，stamp 是文本、不可比较。idx_msg_peer 覆盖了这两种查询的 WHERE + ORDER BY。
 */
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
 * 打开数据库（懒加载）。只在第一次调用时真的做事，之后靠 db/broken 两个状态短路 ——
 * broken 一旦置上就不再重试，修好环境需要重启 Yunzai。
 *
 * 整个函数不抛异常：Node < 22.5 没有 node:sqlite、磁盘只读、data 目录被占，
 * 任何一种都只是让聊天界面失去历史，不该让 `#抖音` 的其它功能一起崩。
 *
 * @returns {object|null} DatabaseSync 实例，打不开时 null
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

/**
 * 取预编译语句。
 * @returns {object|null} 数据库打不开时返回 null，调用方一律「拿不到就当没历史」；
 *   注意 appendMessages 与 status 等处依赖了「open() 成功后 stmt 必不为 null」，
 *   因此它们对返回值没有再判空
 */
function stmt(sql) {
  if (!open()) return null
  let s = stmts.get(sql)
  if (!s) {
    s = db.prepare(sql)
    stmts.set(sql, s)
  }
  return s
}

/** 落盘层是否可用。面板据此决定显不显示「历史不可用」提示。首次调用会触发 open() */
export function ready() {
  return !!open()
}

/**
 * 给面板与日志看的状态。
 * @returns {{ok: boolean, path: string, reason: string, messages: number, conversations: number}}
 *   reason 是 open() 失败时的原因，ok 为 true 时是空串；两个计数在 ok 为 false 时是 0
 */
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
 * 把抖音页面上读到的会话列表并进本地。lib/chat.js 的 conversations() 每次刷新列表时调用。
 *
 * 「并」而不是「覆盖」：抖音的会话列表只显示最近若干条，往下滚才会加载更多。
 * 如果直接按远端结果重建表，用户三个月没联系的人就会从本地列表里消失——而用户
 * 明确要求「会话不过期」。所以远端有的更新预览与时间，远端没有的原样留着。
 *
 * preview 与 stamp 的 upsert 都带 `<> ''` 判断：页面偶尔读到空预览（气泡还没渲染完），
 * 空值覆盖会让列表上已有的预览凭空消失。
 *
 * @param {string} botId 机器人账号
 * @param {string} accId 抖音账号 id（store 里的 account.id）
 * @param {Array<{peer:string, preview?:string, stamp?:string}>} items 页面顺序（最近的在前）
 * @returns {number} 写入的会话条数；库不可用、items 为空或事务失败时返回 0
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

/**
 * 本地会话列表，最近的在前。
 *
 * @param {number} [limit=200] 上限；面板一次全量渲染，不做分页
 * @returns {Array<{peer,preview,stamp,unread,lastAt,seenAt}>} 库不可用时返回空数组。
 *   unread 是本地按「对方发来的消息」累计的（见 appendMessages），抖音页面上读不到数字
 */
export function listConversations(botId, accId, limit = 200) {
  const s = stmt(`
    SELECT peer, preview, stamp, unread, last_at AS lastAt, seen_at AS seenAt
    FROM conversations WHERE bot_id = ? AND acc_id = ?
    ORDER BY last_at DESC LIMIT ?
  `)
  return s ? s.all(botId, accId, limit) : []
}

/**
 * 进入会话时清零未读，lib/chat.js 的 openPeer() 调用一次。
 * 同时记下 seen_at：目前没有读者，留给将来的「新消息分割线」。
 * 会话不存在时 UPDATE 影响 0 行，不报错。
 */
export function markSeen(botId, accId, peer) {
  stmt(`
    UPDATE conversations SET unread = 0, seen_at = ?
    WHERE bot_id = ? AND acc_id = ? AND peer = ?
  `)?.run(Date.now(), botId, accId, peer)
}

/* ---------------------------------- 消息 ---------------------------------- */

/**
 * 一条消息的身份：`self + text`。抖音不给消息 id，也没有结构化时间，只能拿
 * 「谁说的 + 说了什么」当身份。
 *
 * stamp 刻意不进这个键，改由 sameMsg 单独处理 —— 它并非消息的稳定属性：
 * recordSent 落库时页面上那条气泡的时间文本还没渲染出来（stamp 为空串），下一轮从页面读回
 * 同一条时 stamp 已经是「12:05」。把它算进键里，两次读数就成了两条不同的消息，最长重叠算
 * 出 0，于是整屏历史每发一条消息就重复插一遍（实测：库里 6 条发一条后变 12 条）。
 *
 * 分隔符用 \x1f（ASCII 单元分隔符）而不是空格：昵称和正文里都可能有空格，
 * 用可打印字符当分隔符会让不同的二元组拼出同一个键。
 */
function key(m) {
  return [m.self ? 1 : 0, m.text].join("\x1f")
}

/**
 * 两条消息是否为同一条。
 *
 * self + text 必须相同；stamp 只在两边都非空时才要求一致 —— 空 stamp 当通配，因为它可能是
 * 「还没渲染出来」而不是「没有时间」。这样 recordSent 写下的空 stamp 记录能与页面读回的带
 * 时间版本对上。
 *
 * 代价是同一分钟内连发两条一模一样的话会被认成同一条。这个取舍与原实现一致：重复插入不可
 * 撤销，而漏掉的那条下次读屏还在页面上。
 */
function sameMsg(a, b) {
  if (key(a) !== key(b)) return false
  return !a.stamp || !b.stamp || a.stamp === b.stamp
}

/**
 * 把页面上读到的一屏气泡追加进库。整个聊天功能的去重逻辑都在这里。
 *
 * 每次轮询读到的都是同一批可见气泡（旧的在前、新的在后），不去重就会把整屏历史重复插进
 * 去。抖音又不给消息 id，所以做法是求「已存尾部」与「刚读到的这一屏」的最长重叠：已存尾部
 * 的某个后缀与本屏的某个前缀逐条 sameMsg 相等时，本屏余下的部分才是新消息。
 *
 * 逐条比较交给 sameMsg 而不是直接比 key，是因为 stamp 会在同一条消息的两次读数之间变化
 * （recordSent 时为空、页面渲染后有值）—— 详见 key 与 sameMsg 的说明。匹配上之后顺手把库
 * 里的空 stamp 回填成页面上那行时间。
 *
 * 这个判据对「同一分钟内连发两条一样的话」是保守的：它会认为第二条是重复而丢掉。宁可漏一条
 * 也不要每轮把历史翻倍，是刻意选的 —— 重复插入是不可逆的污染，漏掉的那条下次页面刷新还在。
 *
 * 空文本气泡（图片、表情、撤回占位）在这里被 filter 掉：文本是身份的一部分，
 * 一批空文本会互相视作重复，留着也无法区分。
 *
 * @param {string} botId
 * @param {string} accId
 * @param {string} peer 对方昵称
 * @param {Array<{self:boolean, text:string, stamp?:string}>} bubbles 页面顺序（旧→新），
 *   来自 lib/chat.js 的 readBubbles
 * @returns {number} 真正新增的条数；库不可用、全是重复或事务失败时返回 0
 */
export function appendMessages(botId, accId, peer, bubbles) {
  if (!open() || !Array.isArray(bubbles) || !bubbles.length) return 0

  const fresh = bubbles
    .map(b => ({ self: !!b.self, text: String(b?.text || "").trim(), stamp: String(b?.stamp || "") }))
    .filter(b => b.text)
  if (!fresh.length) return 0

  // 只取与本屏等量的已存尾部：重叠长度不可能超过本屏长度。DESC 查完再 reverse，
  // 让 tail 与 fresh 一样是「旧→新」，下面才能直接按下标比对。
  // 带上 id：匹配上之后要给库里那些空 stamp 的记录回填页面上读到的时间
  const tail = stmt(`
    SELECT id, self, text, stamp FROM messages
    WHERE bot_id = ? AND acc_id = ? AND peer = ?
    ORDER BY id DESC LIMIT ?
  `).all(botId, accId, peer, fresh.length).reverse()

  // 从最长可能的重叠开始递减尝试，第一个匹配即最长重叠；全不匹配则 overlap 为 0，
  // 即整屏都是新消息（首次进入会话就是这种情况）
  let overlap = 0
  for (let len = Math.min(tail.length, fresh.length); len > 0; len--) {
    let same = true
    for (let i = 0; i < len; i++) {
      if (!sameMsg(tail[tail.length - len + i], fresh[i])) { same = false; break }
    }
    if (same) { overlap = len; break }
  }

  /*
   * 回填时间：库里那条是 recordSent 写的（stamp 空），页面这次给出了真实时间。
   *
   * 不回填的后果是这条记录永远停在空 stamp，前端只能显示入库时刻而不是抖音上那行时间；
   * 更要紧的是下一轮它仍会与页面版本「靠通配匹配」，一旦中间又插入别的消息、重叠窗口滑动
   * 过去，就再也对不上了。
   */
  const fill = stmt(`UPDATE messages SET stamp = ? WHERE id = ?`)
  for (let i = 0; i < overlap; i++) {
    const old = tail[tail.length - overlap + i]
    const now = fresh[i]
    if (!old.stamp && now.stamp) fill?.run(now.stamp, old.id)
  }

  const add = fresh.slice(overlap)
  if (!add.length) return 0

  const ins = stmt(`
    INSERT INTO messages (bot_id, acc_id, peer, self, text, stamp, at)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `)
  // at 用 now + 下标：同一批消息读到的时间相同，加下标保证 at 与 id 同序，
  // 前端按 at 显示时不会出现同一毫秒的乱序
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

  // 会话表跟着动：预览取本批最后一条，未读只累计对方发来的（self 为 false）。
  // 这次的 upsert 直接覆盖 preview 与 last_at —— 这里的数据比页面列表更新
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
 * 记一条本端刚发出去的消息，让前端立刻看到，不必等下一轮轮询把它从页面读回来。
 *
 * 单独开一个入口而不是让调用方直接拼 appendMessages 的参数，是因为这条消息的来源不同：
 * lib/chat.js 的 send() 已经回读过输入框字数、确认过 Enter 发下去了，可信度高于页面解析。
 *
 * stamp 传空串：此刻页面上那条气泡的时间文本还没渲染出来，无从取得。注意这与下一轮
 * readBubbles 读回的 stamp（形如「12:05」）不同，两者的去重键（见 key）因此不相等，
 * 同一条自发消息可能被再插一次。
 *
 * @returns {number} 同 appendMessages，实际写入 0 或 1 条
 */
export function recordSent(botId, accId, peer, text) {
  return appendMessages(botId, accId, peer, [{ self: true, text, stamp: "" }])
}

/**
 * 拉历史消息，按 id 正序（旧→新）返回，前端可直接从上往下渲染。
 *
 * @param {object} [opts]
 * @param {number} [opts.limit=60] 单页条数；lib/chat.js 的 earlier 传 40，reload 传 20
 * @param {number} [opts.beforeId=0] 向上翻页锚点，传当前最上面那条的 id 取它之前的一页；
 *   0 表示取最新一页。两种情况用两条不同的 SQL，是为了让预编译语句缓存各自命中
 * @returns {Array<{id,self,text,stamp,at}>} 库不可用时返回空数组。self 已从 0/1 转回 boolean
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

/**
 * 增量拉取：比 sinceId 更新的消息，前端轮询用（lib/chat.js 的 poll）。
 * 单次上限 200 条，避免久未轮询后一次返回过大的响应。
 * @returns {Array<{id,self,text,stamp,at}>} 没有新消息或库不可用时返回空数组
 */
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
 * 删掉一个账号的全部聊天数据（消息 + 会话）。
 *
 * 由 lib/store.js 的 remove() 统一调用，账号从面板移除时连带执行：Cookie 都不留了，
 * 聊天记录留着既没用又是隐私负担。两张表在同一事务里删，避免只删一半。
 * 不关聊天会话 —— 那是 lib/chat.js 的职责，见 store.js 文件头的说明。
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

/**
 * 关库并清空语句缓存。只有退出与热重载需要调（lib/shutdown.js）。
 *
 * 关完把 db 置 null 而 broken 保持空串，因此下次调用任意导出会重新 open() —— 关库不等于
 * 禁用落盘。close() 是同步的，这也是 shutdown 的 exit 钩子能收它的原因。
 */
export function close() {
  if (!db) return
  try { db.close() } catch { /* 已经关了或进程正在退出，没什么可做的 */ }
  db = null
  stmts.clear()
}
