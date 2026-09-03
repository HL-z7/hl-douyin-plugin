/**
 * 抖音续火控制台前端。无框架、单文件、无构建步骤，用 `$("id")` 直接操作 DOM。
 *
 * 三个视图（index.html 的三个顶层 section，由 show() 互斥切换）：
 *   viewLogin —— 输入验证码；viewBots —— 选机器人；viewMain —— 主面板。
 * viewMain 内是五个标签页，由 TABS 与 `.tabs button[data-tab]` 驱动，每个标签页对应一个
 * `#tabXxx` 容器：
 *   accounts 账号与发信 / chat 私信聊天 / login 抖音登录 / config 定时与推送 / status 状态与审计。
 *
 * 接口约定（lib/web.js 的 fail() 与各路由）：api() 会把 HTTP 状态码挂在 error.status 上，
 * 其中 409 表示服务端那个聊天会话已经不在，前端必须停轮询并退回账号列表（chatGone 统一处理）；
 * 400 与 500 表示本次操作失败但会话仍在，只提示不重连。401 未登录、403 已封禁或越权、
 * 404 会话不存在、429 触发限流。
 *
 * 唯一带服务端状态的功能是私信聊天：open 之后服务器上挂着一个 Chromium，因此 state.chat 既是
 * 界面状态也是「服务端会话现状」的本地副本，切账号、切机器人、退登录、关闭聊天开关时都要显式
 * 收尾。详见「私信聊天」一节的说明。
 *
 * 没有前端路由：全靠 class="hide" 切换，地址栏始终是 BASE 本身。刷新即回到未登录/选机器人态，
 * 这也是刷新后不自动重连聊天会话的原因。
 */
/** 挂载路径，取自当前 URL 的第一段，对应配置项 `web.base`（默认 /douyin） */
const BASE = "/" + (location.pathname.split("/").filter(Boolean)[0] || "douyin")
const $ = id => document.getElementById(id)
const state = {
  bots: [], botId: "", accounts: [], editing: "", qrSid: "", qrTimer: null, placeholders: [],
  /**
   * 聊天是唯一有服务端状态的功能：open 之后服务器挂着一个 Chromium。
   * 因此这些字段不只是界面状态，还是「服务端那个会话现在是什么样」的本地副本。
   */
  chat: {
    accId: "", accName: "", peer: "",
    pollMs: 3000, timer: null,
    /** 已知的最大消息 id，轮询用它作 since 参数 */
    lastId: 0,
    peers: [], msgs: [],
    /** 正在翻历史时不要被轮询的重渲染打断 */
    loadingEarlier: false,
    /** 已翻到库底。不置此标志时，用户停在顶部的每次微小滚动都会再查一遍空结果 */
    noMore: false,
    /** 服务端 sqlite 是否可用（open 接口的 db 字段）。false 时本次消息不落盘 */
    db: true,
    /** 这两项由 loadConfig 从 /api/config 填入：总开关关闭时整个标签页只显示一句说明 */
    enable: true, idleSec: 180,
  },
}

/**
 * 右下角提示条。同一个 DOM 复用，后一次调用会重置前一次的隐藏定时器。
 * @param {string} msg
 * @param {number} [ms=2200] 显示时长
 */
function toast(msg, ms = 2200) {
  const el = $("toast")
  el.textContent = msg
  el.classList.remove("hide")
  clearTimeout(toast.t)
  toast.t = setTimeout(() => el.classList.add("hide"), ms)
}

/**
 * 统一的接口调用。路径相对 `${BASE}/api`。
 *
 * @param {string} path 形如 `/accounts` 或 `/chat/xxx/poll?...`
 * @param {{method?: string, body?: object}} [opts] body 存在时自动转 JSON 并带上
 *   Content-Type；鉴权靠 same-origin 的 Cookie，不手工带 token
 * @returns {Promise<object>} 已解析的 JSON；响应体不是 JSON 时返回空对象
 * @throws {Error & {status: number}} 非 2xx 时抛出，message 取服务端的 error 字段，
 *   status 是 HTTP 状态码 —— 调用方靠它区分 409（会话已关闭，需退回账号列表）
 *   与 400/500（本次操作失败，会话仍在）
 */
async function api(path, { method = "GET", body } = {}) {
  const res = await fetch(BASE + "/api" + path, {
    method,
    headers: body ? { "Content-Type": "application/json" } : undefined,
    body: body ? JSON.stringify(body) : undefined,
    credentials: "same-origin",
  })
  let data = {}
  try {
    data = await res.json()
  } catch {}
  if (!res.ok) {
    const error = new Error(data.error || `请求失败(${res.status})`)
    // 状态码要留给调用方：聊天接口用 409 表示「服务端那个会话没了，应退回账号列表」，
    // 400 只是本次操作失败（会话仍在）。只看 message 无法区分是否需要重连
    error.status = res.status
    throw error
  }
  return data
}

/** 三个顶层视图互斥切换 @param {"viewLogin"|"viewBots"|"viewMain"} view */
function show(view) {
  for (const id of ["viewLogin", "viewBots", "viewMain"]) $(id).classList.toggle("hide", id !== view)
}

/** HTML 转义。所有拼进 innerHTML 的用户数据（账号名、昵称、消息文本）都必须过这里 */
function esc(text) {
  return String(text ?? "").replace(/[&<>"]/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]))
}

/** 昵称首字作头像。emoji 昵称要按码点取，用 [0] 会截出半个代理对显示为乱码方框 */
function initial(name) {
  return [...String(name || "?")][0] || "?"
}

/**
 * 时间戳格式化为「今天 14:05」/「昨天 22:31」/「9-1 08:12」。
 * 面向「几点拉取的」这类几小时内的时间，绝对日期只在跨天时出现。
 * @param {number|string} ts 毫秒时间戳，0 或非数值返回「未知时间」
 * @returns {string}
 */
function clockText(ts) {
  const t = Number(ts)
  if (!t) return "未知时间"
  const d = new Date(t)
  const p = n => String(n).padStart(2, "0")
  const hm = `${p(d.getHours())}:${p(d.getMinutes())}`
  const day = new Date()
  const same = (a, b) => a.toDateString() === b.toDateString()
  if (same(d, day)) return `今天 ${hm}`
  day.setDate(day.getDate() - 1)
  if (same(d, day)) return `昨天 ${hm}`
  return `${d.getMonth() + 1}-${d.getDate()} ${hm}`
}

/* ---------- 续火目标 ----------
 * 后端存的是 { name, alias[], note }（lib/store.js），旧字段 targetNames 只有主名。
 * 这里保留两套转换：展示用 targetLabel，编辑用 targetLine（可被后端 normalizeTargets 原样解析
 * 回同一结构）。两者不可混用 —— targetLabel 的输出用全角括号与斜杠，解析不回来。
 */

/**
 * 取账号的续火目标，兼容只有 targetNames 的旧数据。
 * @param {object} acc
 * @returns {Array<{name: string, alias: string[], note: string}>}
 */
function targets(acc) {
  if (Array.isArray(acc?.targets) && acc.targets.length) return acc.targets
  return (acc?.targetNames || []).map(name => ({ name, alias: [], note: "" }))
}

/**
 * 展示用文本，与 lib/store.js:179 的 targetLabel 同一套写法：
 * `张三（表妹）` 或 `张三 / 旧名`。仅用于展示，不可回填编辑框。
 * @param {{name: string, alias?: string[], note?: string}} target
 * @returns {string} 无主名时返回空串
 */
function targetLabel(target) {
  if (!target?.name) return ""
  if (target.note) return `${target.name}（${target.note}）`
  if (target.alias?.length) return `${target.name} / ${target.alias.join(" / ")}`
  return target.name
}

/**
 * 编辑框里的一行：`主名=别名1=别名2(备注)`。与 lib/store.js:196 的 targetText 同一套语法，
 * 因此原样提交回 normalizeTargets 可解析成同一结构。
 * @param {{name: string, alias?: string[], note?: string}} target
 * @returns {string} 无主名时返回空串
 */
function targetLine(target) {
  if (!target?.name) return ""
  const names = [target.name, ...(target.alias || [])].join("=")
  return target.note ? `${names}(${target.note})` : names
}

/* ---------- 鉴权 ----------
 * 流程：boot 先问 /api/auth/state。已登录且已选机器人则直接进主面板；已登录未选机器人则显示
 * 机器人列表；未登录回登录视图（带 hash 验证码时自动提交一次）。
 */

/**
 * 从 URL 的 hash 中取一键进入的验证码，取完立刻抹掉。
 *
 * 用 hash 而非 query 的原因：hash 不发给服务端，因此不进 access log、不随 Referer 外泄
 * （Yunzai 的 serverHandle 会把 req.query 整个写进日志，而日志经常被直接贴出用于排查）。
 * 读取后 replaceState 是为了让地址栏、书签、截图里都不留这 6 位码。
 * 与远程验证页面（/verify#t=xxx）同一套做法。
 *
 * @returns {string} 大写后的验证码；hash 不存在或格式不符时返回空串
 */
function takeHashCode() {
  const raw = decodeURIComponent(location.hash.slice(1)).trim().toUpperCase()
  if (location.hash) history.replaceState(null, "", location.pathname + location.search)
  // 验证码字符集见 lib/crypto.js 的 randomCode：排除了易混的 0O1IL
  return /^[A-Z0-9]{4,8}$/.test(raw) ? raw : ""
}

/** 启动入口，文件末尾调用一次。任何异常都退回登录视图 */
async function boot() {
  const hashCode = takeHashCode()
  /** 未登录时的落点：带了码就直接提交，用户点链接的预期是「点一下就进去」而非再按一次按钮 */
  const toLogin = () => {
    show("viewLogin")
    if (!hashCode) return
    $("code").value = hashCode
    $("btnVerify").click()
  }

  try {
    const st = await api("/auth/state")
    if (!st.authed) return toLogin()
    state.bots = st.bots || []
    if (st.botId) {
      state.botId = st.botId
      await enterMain()
    } else {
      renderBots()
      show("viewBots")
    }
  } catch {
    toLogin()
  }
}

$("btnVerify").onclick = async () => {
  const code = $("code").value.trim().toUpperCase()
  $("loginErr").textContent = ""
  if (code.length < 4) return ($("loginErr").textContent = "请输入完整验证码")
  $("btnVerify").disabled = true
  try {
    const res = await api("/auth/verify", { method: "POST", body: { code } })
    state.bots = res.bots || []
    renderBots()
    show("viewBots")
  } catch (error) {
    $("loginErr").textContent = error.message
  } finally {
    $("btnVerify").disabled = false
  }
}
$("code").addEventListener("keydown", e => {
  if (e.key === "Enter") $("btnVerify").click()
})

/** 画机器人列表（viewBots）。每张卡片点一下即 selectBot */
function renderBots() {
  const box = $("botList")
  if (!state.bots.length) {
    box.innerHTML = '<p class="tip">没有可操作的机器人</p>'
    return
  }
  box.innerHTML = state.bots
    .map(
      b => `<div class="bot" data-uin="${esc(b.uin)}">
      <span class="dot ${b.online ? "on" : ""}"></span>
      <div><div class="n">${esc(b.nickname)}</div>
      <div class="tip">${esc(b.uin)} · ${esc(b.adapter)} · ${b.online ? "在线" : "离线"}</div></div></div>`
    )
    .join("")
  for (const el of box.querySelectorAll(".bot"))
    el.onclick = () => selectBot(el.dataset.uin)
}

/** 选定机器人。后端把 botId 记进会话，之后所有接口都按它隔离数据 */
async function selectBot(botId) {
  $("botErr").textContent = ""
  try {
    await api("/bot/select", { method: "POST", body: { botId } })
    state.botId = botId
    await enterMain()
  } catch (error) {
    $("botErr").textContent = error.message
  }
}

/** 进入主面板，并一次性拉齐三份数据（账号、配置、状态） */
async function enterMain() {
  const bot = state.bots.find(b => b.uin === state.botId)
  $("curBot").textContent = bot ? `${bot.nickname}（${bot.uin}）· ${bot.online ? "在线" : "离线"}` : state.botId
  show("viewMain")
  await Promise.all([loadAccounts(), loadConfig(), loadStatus()])
}

const logout = async () => {
  // 先收掉聊天会话：退登录后前端不再轮询，服务端那个 Chromium 只能等空闲超时
  await leaveChat({ silent: true })
  await api("/auth/logout", { method: "POST" }).catch(() => {})
  location.reload()
}
$("btnLogout").onclick = logout
$("btnLogout2").onclick = logout
$("btnSwitch").onclick = async () => {
  // 聊天会话绑在 botId:accountId 上，换机器人后当前这个界面已不属于新机器人
  await leaveChat({ silent: true })
  renderBots()
  show("viewBots")
}

/* ---------- 标签页 ----------
 * 与 index.html 的 `.tabs button[data-tab]` 一一对应，容器 id 是 `tab` + 首字母大写。
 * 只有 status 与 chat 在切入时要刷新：前者的数据会过期，后者的账号卡片依赖 state.accounts
 * 与聊天开关。
 */
const TABS = ["accounts", "chat", "login", "config", "status"]
for (const btn of document.querySelectorAll(".tabs button"))
  btn.onclick = () => {
    for (const b of document.querySelectorAll(".tabs button")) b.classList.toggle("on", b === btn)
    for (const name of TABS)
      $("tab" + name[0].toUpperCase() + name.slice(1)).classList.toggle("hide", name !== btn.dataset.tab)
    if (btn.dataset.tab === "status") loadStatus()
    if (btn.dataset.tab === "chat") renderChatPick()
  }

/* ---------- 账号 ----------
 * 「账号与发信」标签页（#tabAccounts）：账号表格 #accBody、编辑卡片 #editCard、
 * 手动发信区 #sendAcc/#sendFriends/#sendText。
 */

/** 拉账号列表并重画表格、发信下拉框与聊天标签页的账号卡片 */
async function loadAccounts() {
  try {
    const { accounts } = await api("/accounts")
    state.accounts = accounts || []
  } catch (error) {
    toast(error.message)
    return
  }
  const rows = state.accounts.map(acc => {
    const last = acc.lastRun
    const tag = acc.cookieInvalid
      ? '<span class="tag err">凭证失效</span>'
      : acc.hasCookie
        ? '<span class="tag ok">已登录</span>'
        : '<span class="tag warn">缺 Cookie</span>'
    const result = last
      ? `${last.ok ? "✅" : "❌"} 发 ${last.sent?.length || 0} 条${last.missing?.length ? `，缺 ${last.missing.length}` : ""}`
      : "从未运行"
    return `<tr>
      <td>${esc(acc.name)}${acc.enable === false ? ' <span class="tag">停用</span>' : ""}${acc.running ? ' <span class="tag warn">运行中</span>' : ""}</td>
      <td>${tag}</td>
      <td class="tip">${esc(targets(acc).map(targetLabel).join("、") || "未配置")}</td>
      <td class="tip">${esc(result)}</td>
      <td class="row">
        <button class="sm ghost" data-act="chat" data-id="${acc.id}">聊天</button>
        <button class="sm ghost" data-act="edit" data-id="${acc.id}">编辑</button>
        <button class="sm ghost" data-act="spark" data-id="${acc.id}">续火</button>
        <button class="sm ghost" data-act="check" data-id="${acc.id}">验 Cookie</button>
        <button class="sm danger" data-act="del" data-id="${acc.id}">删除</button>
      </td></tr>`
  })
  $("accBody").innerHTML = rows.join("") || '<tr><td colspan="5" class="tip">还没有账号，先去「抖音登录」添加</td></tr>'
  $("accSum").textContent = `共 ${state.accounts.length} 个，启用 ${state.accounts.filter(a => a.enable !== false).length} 个`
  $("sendAcc").innerHTML = state.accounts
    .map(a => `<option value="${a.id}">${esc(a.name)}</option>`)
    .join("")

  for (const btn of $("accBody").querySelectorAll("button"))
    btn.onclick = () => accAction(btn.dataset.act, btn.dataset.id, btn)

  // 聊天标签页里的账号卡片读同一份 state.accounts
  renderChatPick()
}

/**
 * 表格里五个按钮的统一入口。
 *
 * @param {"chat"|"edit"|"del"|"spark"|"check"} act
 * @param {string} id 账号 id
 * @param {HTMLButtonElement} btn 用于置灰与恢复文字；chat/edit/del 三支提前返回，不改按钮
 */
async function accAction(act, id, btn) {
  const acc = state.accounts.find(a => a.id === id)
  if (act === "chat") return enterChat(id)
  if (act === "edit") {
    state.editing = id
    $("editTitle").textContent = `编辑账号：${acc.name}`
    $("fName").value = acc.name
    $("fEnable").value = acc.enable === false ? "0" : "1"
    $("fTargets").value = targets(acc).map(targetLine).join("\n")
    $("fTpl").value = acc.messageTemplate || ""
    $("editCard").scrollIntoView({ behavior: "smooth" })
    return
  }
  if (act === "del") {
    if (!confirm(`确认删除账号「${acc.name}」？其 Cookie 与本地聊天记录会一并删除。`)) return
    await api(`/accounts/${id}`, { method: "DELETE" }).catch(e => toast(e.message))
    // 删除的正是当前开着的聊天账号时，后端已先关会话（lib/web.js:252）再删数据，前端跟着退出
    if (state.chat.accId === id) resetChat()
    return loadAccounts()
  }
  btn.disabled = true
  const old = btn.textContent
  btn.textContent = "执行中…"
  try {
    if (act === "spark") {
      const r = await api(`/accounts/${id}/spark`, { method: "POST" })
      toast(r.ok ? `续火完成，发送 ${r.sent.length} 条` : `续火失败：${r.error || "未知"}`, 4000)
    } else if (act === "check") {
      const r = await api(`/accounts/${id}/check`, { method: "POST" })
      toast(r.message)
    }
  } catch (error) {
    toast(error.message, 4000)
  } finally {
    btn.disabled = false
    btn.textContent = old
    loadAccounts()
  }
}

$("btnSaveAcc").onclick = async () => {
  const body = {
    // 留空即新增：后端按 id 是否存在决定 upsert 还是 create
    id: state.editing || undefined,
    name: $("fName").value.trim(),
    enable: $("fEnable").value === "1",
    // 按行传数组而不是整块文本：后端 normalizeTargets 对数组逐项解析，
    // 备注里的空格与逗号不会被 toIdList 当作分隔符切开
    targets: $("fTargets").value.split("\n").map(s => s.trim()).filter(Boolean),
    messageTemplate: $("fTpl").value,
  }
  if (!body.name) return toast("请填写账号名称")
  try {
    await api("/accounts", { method: "POST", body })
    toast("已保存")
    resetAccForm()
    loadAccounts()
  } catch (error) {
    toast(error.message, 4000)
  }
}

/** 清空编辑卡片并退出编辑态（state.editing 置空后保存即为新增） */
function resetAccForm() {
  state.editing = ""
  $("editTitle").textContent = "新增 / 编辑账号"
  for (const id of ["fName", "fTargets", "fTpl"]) $(id).value = ""
  $("fEnable").value = "1"
}
$("btnResetAcc").onclick = resetAccForm

$("btnRunAll").onclick = async () => {
  if (!confirm("将立即为所有机器人的所有启用账号执行续火，并按配置推送结果，确认？")) return
  const btn = $("btnRunAll")
  btn.disabled = true
  btn.textContent = "执行中，请稍候…"
  try {
    const r = await api("/spark/all", { method: "POST" })
    toast(`完成：账号 ${r.total}，成功 ${r.ok}，失败 ${r.fail}`, 5000)
  } catch (error) {
    toast(error.message, 4000)
  } finally {
    btn.disabled = false
    btn.textContent = "立即续火（全部机器人）"
    loadAccounts()
    loadStatus()
  }
}

$("btnPushTest").onclick = async () => {
  try {
    const r = await api("/push/test", { method: "POST" })
    toast(`已推送到 ${r.sent} 个目标${r.errors?.length ? `，${r.errors.length} 个失败` : ""}`, 4000)
  } catch (error) {
    toast(error.message, 4000)
  }
}

/* ---------- 发信 ----------
 * 一次性给指定好友发消息，与续火共用同一把账号锁，因此执行期间要有明确的进度文字。
 */
$("btnSend").onclick = async () => {
  const id = $("sendAcc").value
  // 收件人支持空格、逗号、顿号、分号、换行混排，便于从别处直接粘贴
  const friends = $("sendFriends").value
    .split(/[\s,，、;；\n]+/)
    .map(s => s.trim())
    .filter(Boolean)
  const text = $("sendText").value
  if (!id) return toast("请选择账号")
  if (!friends.length) return toast("请填写好友")
  if (!text.trim()) return toast("请填写消息内容")
  const btn = $("btnSend")
  btn.disabled = true
  $("sendHint").textContent = "正在打开抖音发送…"
  try {
    const r = await api(`/accounts/${id}/send`, { method: "POST", body: { friends, text } })
    $("sendHint").textContent = r.ok
      ? `已发送 ${r.sent.length} 条`
      : `发送 ${r.sent.length} 条，失败：${r.error || ""}`
  } catch (error) {
    $("sendHint").textContent = error.message
  } finally {
    btn.disabled = false
  }
}

/**
 * 拉会话（好友）列表填充 #friendPick。后端默认吃缓存（`spark.friendsCacheTTL`），
 * 只有 refresh 才真开浏览器读页面。
 *
 * 命中缓存时必须把「这是几点拉取的」显示出来 —— 用户看到旧名单会以为接口坏了。
 *
 * @param {boolean} refresh true 时带 `?refresh=1` 绕过缓存，并置灰「重新拉取」按钮
 */
async function loadFriends(refresh) {
  const id = $("sendAcc").value
  if (!id) return toast("请选择账号")
  const btn = refresh ? $("btnReloadFriends") : $("btnLoadFriends")
  btn.disabled = true
  $("sendHint").textContent = refresh ? "正在重新打开抖音拉取…" : "正在拉取会话列表…"
  try {
    const { friends, cached, at } = await api(`/accounts/${id}/friends${refresh ? "?refresh=1" : ""}`)
    $("friendPick").innerHTML = friends.length
      ? friends.map(n => `<button class="sm ghost" data-n="${esc(n)}">${esc(n)}</button>`).join("")
      : '<span class="tip">没有拉到会话，可能需要先在抖音里打开过聊天</span>'
    for (const b of $("friendPick").querySelectorAll("button"))
      b.onclick = () => {
        const cur = $("sendFriends").value.trim()
        $("sendFriends").value = cur ? `${cur},${b.dataset.n}` : b.dataset.n
      }
    // 拉取过一次才显示「重新拉取」：无名单时该按钮没有意义
    $("btnReloadFriends").classList.toggle("hide", !friends.length)
    $("sendHint").textContent = cached
      ? `${friends.length} 个会话（${clockText(at)} 的缓存），点击可加入收件人；名单不对就点「重新拉取」`
      : `拉到 ${friends.length} 个会话，点击可加入收件人`
  } catch (error) {
    $("sendHint").textContent = error.message
  } finally {
    btn.disabled = false
  }
}

$("btnLoadFriends").onclick = () => loadFriends(false)
$("btnReloadFriends").onclick = () => loadFriends(true)

// 换账号后原来那份名单属于上一个号，留着只会让人点到错误的收件人
$("sendAcc").onchange = () => {
  $("friendPick").innerHTML = ""
  $("btnReloadFriends").classList.add("hide")
  $("sendHint").textContent = ""
}

/* ---------- 抖音登录 ----------
 * 「抖音登录」标签页（#tabLogin）：上半是扫码（#qrImg / #qrHint），下半是手动粘贴 Cookie
 * （#mName / #mCookie）。扫码是唯一需要轮询的登录方式，会话 id 存在 state.qrSid。
 */
$("btnQr").onclick = async () => {
  $("qrHint").textContent = "正在启动浏览器获取二维码…"
  $("qrImg").classList.add("hide")
  try {
    const { sessionId } = await api("/login/qrcode", { method: "POST", body: { name: $("qrName").value.trim() } })
    state.qrSid = sessionId
    pollQr()
  } catch (error) {
    $("qrHint").textContent = error.message
  }
}

/**
 * 每 2 秒查一次扫码会话状态（lib/login.js 的 getSession 快照）。
 *
 * 这里用 setInterval 而非 setTimeout 自续（与聊天轮询相反）：该接口只读内存里的会话快照，
 * 不碰浏览器，不会因为慢而叠请求。
 *
 * 终态四种：success / failed / expired / canceled，命中即停表并清 state.qrSid。
 * 二维码换图靠比较 `$("qrImg").src`，因此单张二维码过期时后端只需推新图，前端自动更新。
 */
function pollQr() {
  clearInterval(state.qrTimer)
  state.qrTimer = setInterval(async () => {
    if (!state.qrSid) return clearInterval(state.qrTimer)
    try {
      const s = await api(`/login/qrcode/${state.qrSid}`)
      if (s.qrcode && $("qrImg").src !== s.qrcode) {
        $("qrImg").src = s.qrcode
        $("qrImg").classList.remove("hide")
      }
      $("qrHint").textContent = s.message || s.status
      // expired 只由「整个会话超时」产生，是终态。单张二维码过期不会走到这里 ——
      // 后端把状态放回 waiting 并推新图，上面的 src 比较会自动换图，轮询要继续
      if (["success", "failed", "expired", "canceled"].includes(s.status)) {
        clearInterval(state.qrTimer)
        state.qrSid = ""
        if (s.status === "success") {
          $("qrImg").classList.add("hide")
          toast(s.message, 4000)
          loadAccounts()
        }
      }
    } catch (error) {
      clearInterval(state.qrTimer)
      state.qrSid = ""
      $("qrHint").textContent = error.message
    }
  }, 2000)
}

$("btnQrCancel").onclick = async () => {
  if (!state.qrSid) return
  await api(`/login/qrcode/${state.qrSid}`, { method: "DELETE" }).catch(() => {})
  clearInterval(state.qrTimer)
  state.qrSid = ""
  $("qrImg").classList.add("hide")
  $("qrHint").textContent = "已取消"
}

$("btnManual").onclick = async () => {
  const name = $("mName").value.trim()
  const cookie = $("mCookie").value.trim()
  if (!name) return ($("mHint").textContent = "请填写账号名称")
  if (!cookie) return ($("mHint").textContent = "请粘贴 Cookie")
  try {
    await api("/login/manual", { method: "POST", body: { name, cookie } })
    $("mHint").textContent = "导入成功，Cookie 已加密保存"
    $("mCookie").value = ""
    loadAccounts()
  } catch (error) {
    $("mHint").textContent = error.message
  }
}

/* ====================== 私信聊天 ======================
 *
 * 对应 lib/web.js 的 7 条 `/api/chat/:id/*` 接口（open / close / conversations / peer / poll /
 * send / earlier）。与面板其它部分最大的区别是**它有服务端状态**：open 之后服务端挂着一个
 * Chromium，close 或空闲超时（`chat.idleCloseSec`，默认 180 秒）才收。由此推出三条做法：
 *
 * 1. 只有 enterChat（用户点「聊天」）才调 open。刷新页面不自动重连 —— 每次 F5 都新开一个
 *    浏览器、还要抢账号锁十几秒，代价过大。刷新后回到账号列表是正确行为。
 * 2. 任何接口回 409 都按「服务端会话已不在」处理：停轮询、退回账号列表、说明原因。这是后端
 *    fail() 唯一会给 409 的情形（message 匹配 /会话未打开|已关闭/），其它错误只提示。
 * 3. 轮询用 setTimeout 自续而不是 setInterval：一次轮询要真读页面，慢时可达几秒，setInterval
 *    会把请求叠在一起，而它们都在等同一把 ChatSession.chain 串行锁。
 *
 * DOM 归属（#tabChat 内三块互斥）：#chatOff 总开关关闭时的说明、#chatPick 账号选择、
 * #chatRoom 聊天室（左 #chatPeers 会话列表 / 右 #chatFlow 气泡流 / 下 #chatText 输入框）。
 */

/** 一条消息的时间：优先用抖音页面上的时间戳（对方那条的真实时间），没有才退到入库时间 */
function msgStamp(m) {
  return m.stamp || clockText(m.at)
}

/**
 * 一条消息的 DOM。
 * @param {{self: boolean, text: string, stamp?: string, at?: number}} m
 * @param {string} accName 自己这一侧的显示名
 * @param {string} peer 对方昵称
 * @returns {string} HTML 串；self 决定靠哪一边，样式见 style.css 的 .msg / .msg.me
 */
function msgHtml(m, accName, peer) {
  const who = m.self ? accName : peer
  return `<div class="msg${m.self ? " me" : ""}">
    <div class="av">${esc(initial(who))}</div>
    <div><div class="bubble">${esc(m.text)}</div>
    <div class="msg-stamp">${esc(msgStamp(m))}</div></div>
  </div>`
}

/**
 * 画账号选择态：哪些账号能进聊天。
 *
 * 同时负责 #chatOff / #chatPick / #chatRoom 三块的互斥显隐，因此切标签页、账号列表变化、
 * 配置回来、进出会话之后都要调它一次。缺 Cookie 或凭证失效的账号直接禁用，点了也只会失败。
 */
function renderChatPick() {
  const off = state.chat.enable === false
  $("chatOff").classList.toggle("hide", !off)
  $("chatPick").classList.toggle("hide", off || !!state.chat.accId)
  $("chatRoom").classList.toggle("hide", off || !state.chat.accId)
  if (off || state.chat.accId) return

  const usable = state.accounts.filter(a => a.hasCookie && !a.cookieInvalid)
  $("chatAccList").innerHTML =
    state.accounts
      .map(a => {
        const ok = a.hasCookie && !a.cookieInvalid
        // 「正在续火」不禁用：那是短暂状态，等它跑完就能进，点得过早时后端会给明确的错误
        const why = !a.hasCookie ? "缺 Cookie" : a.cookieInvalid ? "凭证失效" : a.running ? "正在续火，稍后再试" : "点击进入私信"
        return `<div class="bot${ok ? "" : " off"}" data-id="${esc(a.id)}">
          <div class="av">${esc(initial(a.name))}</div>
          <div style="min-width:0">
            <div class="n">${esc(a.name)}</div>
            <div class="tip">${esc(why)}</div>
          </div></div>`
      })
      .join("") || '<p class="tip">还没有账号，先去「抖音登录」添加</p>'

  for (const el of $("chatAccList").querySelectorAll(".bot:not(.off)"))
    el.onclick = () => enterChat(el.dataset.id)
  $("chatDbSum").textContent = usable.length ? `${usable.length} 个账号可用` : ""
  $("chatIdleTip").textContent = `${Math.round((state.chat.idleSec || 180) / 60)} 分钟`
}

/**
 * 进入某账号的私信。这一步会在服务器上开浏览器，耗时十几秒属正常，因此要有明确的进度文字。
 *
 * 同时切到聊天标签页（用户可能是从账号表格的「聊天」按钮进来的），并在 open 成功后立刻
 * refreshPeers 一次 —— open 返回的会话列表来自本地库，不含最新预览与新会话。
 *
 * @param {string} accId 账号 id。已有别的账号开着时先 leaveChat，一个前端只维持一个会话
 */
async function enterChat(accId) {
  const acc = state.accounts.find(a => a.id === accId)
  if (!acc) return
  if (state.chat.accId && state.chat.accId !== accId) await leaveChat({ silent: true })

  // 切到聊天标签页，让用户看见进度，而不是以为按钮没反应
  for (const b of document.querySelectorAll(".tabs button")) b.classList.toggle("on", b.dataset.tab === "chat")
  for (const name of TABS) $("tab" + name[0].toUpperCase() + name.slice(1)).classList.toggle("hide", name !== "chat")

  $("chatPickErr").textContent = `正在为「${acc.name}」打开抖音聊天页，首次要十几秒…`
  try {
    const r = await api(`/chat/${accId}/open`, { method: "POST" })
    state.chat.accId = accId
    state.chat.accName = r.session?.account || acc.name
    state.chat.pollMs = r.pollMs || 3000
    state.chat.peers = r.conversations || []
    state.chat.db = r.db !== false
    state.chat.peer = ""
    state.chat.msgs = []
    state.chat.lastId = 0
    $("chatPickErr").textContent = ""
    renderChatPick()
    renderChatHead()
    renderPeers()
    renderFlow()
    // open 返回的是库里那份（不读页面）。真去页面读一遍才有最新预览与新会话
    refreshPeers({ silent: true })
  } catch (error) {
    $("chatPickErr").textContent = error.message
  }
}

/**
 * 退出聊天：先请求服务端收掉浏览器，再清本地状态。
 * @param {{silent?: boolean}} [opts] silent 时不弹 toast，用于切账号 / 换机器人 / 退登录
 */
async function leaveChat({ silent = false } = {}) {
  const accId = state.chat.accId
  if (!accId) return
  stopPoll()
  await api(`/chat/${accId}/close`, { method: "POST" }).catch(() => {})
  resetChat()
  if (!silent) toast("已退出聊天，服务器上的抖音页面已关闭")
}

/**
 * 只清本地状态，不请求服务端。用于「服务端会话已不在」（409）与账号被删除的情形 ——
 * 那两种情况下服务端已经收过了，再发 close 只会拿到另一个 409。
 */
function resetChat() {
  stopPoll()
  Object.assign(state.chat, {
    accId: "", accName: "", peer: "", peers: [], msgs: [], lastId: 0, loadingEarlier: false,
  })
  renderChatPick()
}

/**
 * 统一处理 409。
 * @param {Error & {status?: number}} error
 * @returns {boolean} true 表示已按会话失效处理完毕（已 resetChat 并写好提示），调用方应直接
 *   返回；false 表示不是 409，调用方自行提示 —— 那些错误不需要重连
 */
function chatGone(error) {
  if (error?.status !== 409) return false
  const name = state.chat.accName
  resetChat()
  $("chatPickErr").textContent = `「${name}」的聊天会话已结束（${error.message}），可以再点一次进入`
  return true
}

$("btnChatQuit").onclick = () => leaveChat()

/* ---------- 会话列表 ---------- */

/** 画左侧会话列表 #chatPeers（头像、昵称、预览、时间、未读角标），并绑定点击进入 */
function renderPeers() {
  const { peers, peer } = state.chat
  $("chatPeers").innerHTML =
    peers
      .map(
        p => `<div class="peer${p.peer === peer ? " on" : ""}" data-peer="${esc(p.peer)}">
        <div class="av">${esc(initial(p.peer))}</div>
        <div class="peer-text">
          <div class="peer-name">${esc(p.peer)}</div>
          <div class="peer-prev">${esc(p.preview || "还没有消息")}</div>
        </div>
        <div class="peer-meta">${esc(p.stamp || "")}
          ${p.unread ? `<div class="peer-unread">${p.unread > 99 ? "99+" : p.unread}</div>` : ""}
        </div></div>`
      )
      .join("") || '<p class="tip" style="padding:14px">没有会话。点上面「刷新会话」去抖音读一遍</p>'
  for (const el of $("chatPeers").querySelectorAll(".peer"))
    el.onclick = () => openPeer(el.dataset.peer)
  $("chatPeerSum").textContent = peers.length ? `${peers.length} 个` : ""
}

/**
 * 去抖音页面重读一遍会话列表（`?refresh=1`）。不带 refresh 的请求只返回库里那份。
 *
 * 读页面要抢会话串行锁，因此期间禁用 #btnChatRefresh，避免连点排队。
 *
 * @param {{silent?: boolean}} [opts] silent 时不弹 toast，用于 enterChat 后的首次自动刷新
 */
async function refreshPeers({ silent = false } = {}) {
  if (!state.chat.accId) return
  const btn = $("btnChatRefresh")
  btn.disabled = true
  try {
    const { conversations } = await api(`/chat/${state.chat.accId}/conversations?refresh=1`)
    state.chat.peers = conversations || []
    // 正在看的会话不应有未读。后端的 markSeen 只在 openPeer 时执行过一次，之后进来的
    // 消息照样计数，刷新会把那个数字带回来，故在此再抹一次本地角标
    markRead(state.chat.peer)
    renderPeers()
    if (!silent) toast(`会话列表已更新，共 ${state.chat.peers.length} 个`)
  } catch (error) {
    if (!chatGone(error) && !silent) toast(error.message, 4000)
  } finally {
    btn.disabled = false
  }
}
$("btnChatRefresh").onclick = () => refreshPeers()

/* ---------- 消息区 ---------- */

/**
 * 画聊天室顶栏（账号名、连接指示灯、当前对话人、轮询间隔）与底部说明。
 * 底部那句话取决于 state.chat.db —— 服务端 sqlite 不可用时必须明确告知本次消息不落盘，
 * 否则用户会以为记录已保存（sqlite 走 node:sqlite，需要 Node ≥ 22.5）。
 */
function renderChatHead() {
  const { accName, peer, db } = state.chat
  $("chatAccName").textContent = accName
  $("chatDot").className = `dot${state.chat.accId ? " on" : ""}`
  $("chatState").textContent = state.chat.accId ? "会话开着" : "未连接"
  $("chatState").className = `tag${state.chat.accId ? " ok" : ""}`
  $("chatWho").textContent = peer || "未选会话"
  $("chatHeadTip").textContent = peer ? `每 ${Math.round(state.chat.pollMs / 1000)} 秒收一次新消息` : ""
  $("chatFoot").textContent = db
    ? "聊天记录存在本机 sqlite 里，不过期。往上滚可以翻更早的。"
    : "本机 sqlite 不可用，这次的消息不会存下来（需要 Node ≥ 22.5）。"
}

/**
 * 重画消息流 #chatFlow。
 *
 * 默认贴底，但用户自己往上翻时不动 —— 正在读旧消息却被拽回底部是明显的干扰。判据取
 * 「距底 120px 以内算贴底」，容纳滚动惯性与气泡高度差；该判定必须在重写 innerHTML
 * 之前采样，之后 scrollTop 已被浏览器重置。
 *
 * @param {{keepScroll?: boolean}} [opts] keepScroll 供 loadEarlier 使用：新内容加在顶部，
 *   按新增高度补偿 scrollTop，视觉上停在原处
 */
function renderFlow({ keepScroll = false } = {}) {
  const box = $("chatFlow")
  const { msgs, accName, peer } = state.chat
  const atBottom = box.scrollHeight - box.scrollTop - box.clientHeight < 120
  const prevHeight = box.scrollHeight

  if (!peer) {
    box.innerHTML = `<div class="chat-empty"><div style="font-size:30px">💬</div>
      <div>从左边挑一个会话开始</div></div>`
    return
  }
  box.innerHTML = msgs.length
    ? msgs.map(m => msgHtml(m, accName, peer)).join("")
    : `<div class="chat-empty"><div>还没有消息，直接在下面发一条</div></div>`

  if (keepScroll) {
    // 往上翻历史：新内容加在顶部，把 scrollTop 按新增高度往下推，视觉上停在原处
    box.scrollTop = box.scrollHeight - prevHeight
  } else if (atBottom) {
    box.scrollTop = box.scrollHeight
  }
}

/**
 * 切到某个会话：服务端在页面上点开该对话，并返回一屏历史。
 *
 * 切之前先 stopPoll —— 旧会话的 poll 正带着上一个 peer 参数在路上，回来后会把别人的消息
 * 并进当前 msgs。切完再 startPoll。
 *
 * @param {string} peer 对方昵称。与当前 peer 相同时直接返回，避免重复占用会话锁
 */
async function openPeer(peer) {
  if (!state.chat.accId || state.chat.peer === peer) return
  stopPoll()
  $("chatWho").textContent = `${peer}（正在打开…）`
  try {
    const r = await api(`/chat/${state.chat.accId}/peer`, { method: "POST", body: { peer } })
    state.chat.peer = r.peer || peer
    state.chat.msgs = r.messages || []
    state.chat.lastId = lastIdOf(state.chat.msgs)
    state.chat.noMore = false
    // 进了会话即抹掉这一条的未读角标，后端 markSeen 已同步清掉库里的计数
    markRead(state.chat.peer)
    $("chatText").disabled = false
    $("btnChatSend").disabled = false
    renderChatHead()
    renderPeers()
    renderFlow()
    startPoll()
    // 一屏没装满就主动补一页：容器滚不动时 scroll 事件永远不会触发，翻历史的入口就失效了
    if ($("chatFlow").scrollHeight <= $("chatFlow").clientHeight + 8) loadEarlier()
  } catch (error) {
    if (chatGone(error)) return
    toast(error.message, 4000)
    renderChatHead()
  }
}

/** 抹掉某个会话的未读角标。只改本地那份，库里的计数由后端 markSeen 负责 */
function markRead(peer) {
  const hit = state.chat.peers.find(p => p.peer === peer)
  if (hit) hit.unread = 0
}

/** 取消息列表里最大的 id，即下一次 poll 的 `since`。空列表返回 0（后端按「从头取」处理） */
function lastIdOf(list) {
  return list.reduce((max, m) => (m.id > max ? m.id : max), 0)
}

/**
 * 把新消息并进 state.chat.msgs。
 *
 * 按 id 去重是必需的：发消息接口的返回值里已含刚发出的那条，紧接着的一轮 poll（since 尚未
 * 更新完）会再带回同一条，不去重就出现重复气泡。合并后按 id 升序排，因为 earlier 与 poll
 * 分别从两端追加。
 *
 * @param {Array<{id: number, text: string, self: boolean}>} list
 * @returns {number} 实际新增的条数；0 表示全是已知消息，调用方可跳过重绘
 */
function mergeMsgs(list) {
  if (!list?.length) return 0
  const known = new Set(state.chat.msgs.map(m => m.id))
  const add = list.filter(m => m.id && !known.has(m.id))
  if (!add.length) return 0
  state.chat.msgs = [...state.chat.msgs, ...add].sort((a, b) => a.id - b.id)
  state.chat.lastId = lastIdOf(state.chat.msgs)
  return add.length
}

/* ---------- 轮询 ---------- */

/** 停掉收消息的定时器。切会话、退出、409、账号被删都要先调它 */
function stopPoll() {
  clearTimeout(state.chat.timer)
  state.chat.timer = null
}

/**
 * 开始收新消息：一轮结束再排下一轮（setTimeout 自续），不用 setInterval。
 *
 * 服务端每次 poll 都要真去读一遍页面（几百毫秒到几秒）。setInterval 在慢的时候会把请求
 * 叠起来，而它们都在等 ChatSession.chain 那把串行锁 —— 队列越排越长，用户看到的延迟反而
 * 更大。自续则保证「上一轮回来之后」才发下一轮，队列深度恒为 1。
 *
 * document.hidden 时跳过本轮但继续排下一轮：读页面是有代价的动作，标签页在后台就不值得做，
 * 而定时器要留着，否则切回来时没有任何机制重新启动。
 *
 * 单次请求失败不停轮询（读页面偶尔超时是常态），只把错误写进 #chatHeadTip；只有 409 才
 * 通过 chatGone 终止 —— 那说明服务端会话已经不在了，再轮询也只会拿到同一个 409。
 */
function startPoll() {
  stopPoll()
  const tick = async () => {
    if (!state.chat.accId || !state.chat.peer) return
    if (document.hidden) return (state.chat.timer = setTimeout(tick, state.chat.pollMs))
    try {
      const r = await api(
        `/chat/${state.chat.accId}/poll?peer=${encodeURIComponent(state.chat.peer)}&since=${state.chat.lastId}`
      )
      if (mergeMsgs(r.messages)) {
        renderFlow()
        // 同步左侧列表的预览与时间，否则它会一直停在几十条消息之前
        const hit = state.chat.peers.find(p => p.peer === state.chat.peer)
        const last = state.chat.msgs[state.chat.msgs.length - 1]
        if (hit && last) {
          hit.preview = last.text
          hit.stamp = last.stamp || hit.stamp
          renderPeers()
        }
      }
    } catch (error) {
      if (chatGone(error)) return
      // 单次失败不停轮询：读页面偶尔超时是常态，停了就得用户手动点回来
      $("chatHeadTip").textContent = `收消息失败：${error.message}`
    }
    state.chat.timer = setTimeout(tick, state.chat.pollMs)
  }
  state.chat.timer = setTimeout(tick, state.chat.pollMs)
}

/* ---------- 发送 ---------- */

/**
 * 发一条私信。
 *
 * 发送期间禁用输入框与按钮：这条请求要在页面上真打字再点发送，耗时以秒计，重复提交会发出
 * 两条相同消息。返回值里已含刚发出的那条（后端 send 回最新 20 条），因此直接 mergeMsgs，
 * 不必等下一轮 poll —— 去重靠 id，与 poll 的重叠部分会被丢掉。
 *
 * 只有 409 走 chatGone 退回账号列表；400 / 500 表示这一次发送失败但会话还在，仅弹 toast，
 * 输入框内容也保持不变（清空 value 放在成功分支内），用户可以直接重试。
 */
async function sendChat() {
  const text = $("chatText").value
  if (!text.trim()) return
  if (!state.chat.peer) return toast("请先选择一个会话")
  const btn = $("btnChatSend")
  btn.disabled = true
  $("chatText").disabled = true
  try {
    const r = await api(`/chat/${state.chat.accId}/send`, {
      method: "POST",
      body: { peer: state.chat.peer, text },
    })
    $("chatText").value = ""
    autoGrow()
    mergeMsgs(r.messages)
    renderFlow()
  } catch (error) {
    if (chatGone(error)) return
    toast(error.message, 4000)
  } finally {
    btn.disabled = false
    $("chatText").disabled = false
    $("chatText").focus()
  }
}
$("btnChatSend").onclick = sendChat

/**
 * Enter 发送、Shift+Enter 换行，与 QQ/微信一致。
 * `e.isComposing` 必须判：中文输入法选词时按 Enter 是确认候选词，不能当成发送，
 * 否则每次上屏都会连带发出一条半成品消息。
 */
$("chatText").addEventListener("keydown", e => {
  if (e.key === "Enter" && !e.shiftKey && !e.isComposing) {
    e.preventDefault()
    sendChat()
  }
})

/**
 * 输入框随内容长高。120px 是与 style.css:404 的 `max-height: 120px` 对齐的同一个数：
 * 高度由 JS 逐次写在 style 上，若这里写得比 CSS 大，超出部分会被 CSS 截掉且不出现滚动条。
 * 到顶之后由 textarea 自身滚动。
 */
function autoGrow() {
  const el = $("chatText")
  el.style.height = "auto"
  el.style.height = Math.min(el.scrollHeight, 120) + "px"
}
$("chatText").addEventListener("input", autoGrow)

/**
 * 往上翻一页历史（`/earlier`，每页 40 条）。纯查库，不触碰浏览器，所以会话关掉也能翻。
 *
 * 两个触发点：滚到距顶 40px 内（正常情形），以及 openPeer 后一屏没装满时的自动补页 ——
 * 消息撑不满 620px 的 .chat-flow 容器（style.css:297）时容器根本滚不动，scroll 事件永远
 * 不触发，只靠滚动的话用户永远翻不出更早的消息。
 *
 * loadingEarlier 与 noMore 两个闸门都在本函数里自守：滚动事件密集触发，没有闸门时一次惯性
 * 滚动会发出十几个相同请求。
 */
async function loadEarlier() {
  const { accId, peer, msgs, loadingEarlier, noMore } = state.chat
  if (loadingEarlier || noMore || !accId || !peer || !msgs.length) return
  state.chat.loadingEarlier = true
  try {
    const r = await api(
      `/chat/${accId}/earlier?peer=${encodeURIComponent(peer)}&before=${msgs[0].id}`
    )
    // 按 id 去重再拼：翻历史与轮询都会往 state.chat.msgs 里塞东西，中间那几百毫秒足够
    // 让同一条消息从两个方向同时进来。此处不复用 mergeMsgs 是因为要往头部插并保留滚动位置
    const known = new Set(state.chat.msgs.map(m => m.id))
    const add = (r.messages || []).filter(m => !known.has(m.id))
    if (add.length) {
      state.chat.msgs = [...add, ...state.chat.msgs].sort((a, b) => a.id - b.id)
      renderFlow({ keepScroll: true })
    } else {
      // 到库底。不记住这件事，用户停在顶部时每一次惯性滚动都会再查一遍空结果
      state.chat.noMore = true
      $("chatHeadTip").textContent = "已经是最早的消息"
    }
  } catch (error) {
    if (!chatGone(error)) toast(error.message)
  } finally {
    state.chat.loadingEarlier = false
  }
}

$("chatFlow").addEventListener("scroll", () => {
  if ($("chatFlow").scrollTop <= 40) loadEarlier()
})

/* ---------- 配置 ----------
 *
 * 对应 #tabConfig，读写 `GET/POST /api/config`。POST 是整体 patch（后端 config.setMany），
 * 因此每次保存都要把界面上所有字段一起提交，不能只发改动过的那几个。
 */

/**
 * 把推送目标数组转成每行一条的文本，供 textarea 编辑。
 * @param {Array<object|string>} list 目标数组，元素形如 {botId, groupId} / {botId, userId}
 * @param {"groupId"|"userId"} field 该组目标的 id 字段名
 * @returns {string} 每行 `botId:id`，botId 为空时只有 id
 */
function targetsToText(list, field) {
  return (list || [])
    .map(item =>
      typeof item === "object" ? `${item.botId ? item.botId + ":" : ""}${item[field] ?? item.id ?? ""}` : String(item)
    )
    .filter(Boolean)
    .join("\n")
}

/**
 * targetsToText 的逆运算。
 *
 * 用 lastIndexOf(":") 而不是 split(":")：群号本身不含冒号，但 botId 可能是带冒号的实现
 * （某些适配器的 uin 形如 `qq:12345`），从右边找唯一的分隔点才不会切错。
 *
 * @param {string} text textarea 内容，每行一条
 * @param {"groupId"|"userId"} field 要写入的 id 字段名
 * @returns {Array<object>} 目标数组；id 为空的行被丢弃
 */
function textToTargets(text, field) {
  return String(text || "")
    .split("\n")
    .map(line => line.trim())
    .filter(Boolean)
    .map(line => {
      const idx = line.lastIndexOf(":")
      if (idx > 0) return { botId: line.slice(0, idx).trim(), [field]: line.slice(idx + 1).trim() }
      return { botId: "", [field]: line }
    })
    .filter(item => item[field])
}

/**
 * 拉配置并铺满整个 #tabConfig 表单，同时把 placeholders（模板可用变量）显示到 #phList。
 *
 * 每一项都写成 `x === false ? "0" : "1"` 而非 `x ? "1" : "0"`：布尔项在配置里缺省时应取
 * 后端默认值（多为 true），前者对 undefined 给 "1"，后者会误显示为「关闭」。
 *
 * 引导阶段与「保存后」都会调用；由于聊天标签页的入口与提示文字取决于这份配置，末尾要把
 * chat.enable / chat.idleCloseSec 同步进 state.chat 并重画一次账号选择态。
 */
async function loadConfig() {
  try {
    const { config: cfg, placeholders } = await api("/config")
    state.placeholders = placeholders || []
    $("phList").textContent = state.placeholders.map(p => `{{${p}}}`).join(" ")
    const s = cfg.spark || {}
    const p = cfg.push || {}
    const r = cfg.render || {}
    const u = cfg.update || {}
    const ch = cfg.chat || {}
    $("cEnable").value = s.enable === false ? "0" : "1"
    $("cCron").value = s.cron || ""
    $("cSkip").value = s.skipIfDone === false ? "0" : "1"
    $("cHeadless").value = s.headless === false ? "0" : "1"
    $("cMinGap").value = s.minGapMs ?? 2500
    $("cMaxGap").value = s.maxGapMs ?? 6000
    $("cSource").value = s.yiyanIncludeSource === false ? "0" : "1"
    $("cTpl").value = s.messageTemplate || ""
    $("cBlockRes").value = s.blockResources === false ? "0" : "1"
    $("cBlockTrack").value = s.blockTracking === false ? "0" : "1"
    $("cCkTTL").value = s.cookieCheckTTL ?? 30
    $("pEnable").value = p.enable === false ? "0" : "1"
    $("pTarget").value = ["both", "group", "friend"].includes(p.target) ? p.target : "both"
    $("pMode").value = p.mode || "detail"
    $("pOnlyFail").value = p.onlyOnFail === true ? "1" : "0"
    $("pGroups").value = targetsToText(p.groups, "groupId")
    $("pFriends").value = targetsToText(p.friends, "userId")
    $("rImage").value = r.image === false ? "0" : "1"
    $("rScale").value = r.scale ?? 1
    $("uRestart").value = u.autoRestart === false ? "0" : "1"
    $("uLogLimit").value = u.logLimit ?? 20
    $("chEnable").value = ch.enable === false ? "0" : "1"
    $("chIdle").value = ch.idleCloseSec ?? 180
    $("chPoll").value = ch.pollMs ?? 3000
    $("chHistory").value = ch.historyLimit ?? 60
    $("chMax").value = ch.maxLength ?? 500
    // 聊天标签页的入口与提示文字都取决于配置，因此配置回来后要重画一次账号选择态
    state.chat.enable = ch.enable !== false
    state.chat.idleSec = ch.idleCloseSec ?? 180
    if (!state.chat.accId) renderChatPick()
  } catch (error) {
    toast(error.message)
  }
}

/**
 * 保存配置。
 *
 * patch 用扁平的点号键（`spark.cron` 这种），对应后端 config.setMany；一次提交界面上的全部
 * 字段，不做「只发改动项」的对比 —— 表单本身就是配置的完整视图，逐项对比只会引入不一致。
 *
 * 提交前只做两条本地校验（间隔大小关系、cron 非空）：其余取值范围由后端夹取，重复实现一遍
 * 会出现两处判据。
 */
$("btnSaveCfg").onclick = async () => {
  const patch = {
    "spark.enable": $("cEnable").value === "1",
    "spark.cron": $("cCron").value.trim(),
    "spark.skipIfDone": $("cSkip").value === "1",
    "spark.headless": $("cHeadless").value === "1",
    "spark.minGapMs": Number($("cMinGap").value) || 0,
    "spark.maxGapMs": Number($("cMaxGap").value) || 0,
    "spark.yiyanIncludeSource": $("cSource").value === "1",
    "spark.messageTemplate": $("cTpl").value,
    "spark.blockResources": $("cBlockRes").value === "1",
    "spark.blockTracking": $("cBlockTrack").value === "1",
    "spark.cookieCheckTTL": Number($("cCkTTL").value) || 0,
    "push.enable": $("pEnable").value === "1",
    "push.target": $("pTarget").value,
    "push.mode": $("pMode").value,
    "push.onlyOnFail": $("pOnlyFail").value === "1",
    "push.groups": textToTargets($("pGroups").value, "groupId"),
    "push.friends": textToTargets($("pFriends").value, "userId"),
    "render.image": $("rImage").value === "1",
    "render.scale": Number($("rScale").value) || 1,
    "update.autoRestart": $("uRestart").value === "1",
    "update.logLimit": Number($("uLogLimit").value) || 20,
    "chat.enable": $("chEnable").value === "1",
    "chat.idleCloseSec": Number($("chIdle").value) || 180,
    "chat.pollMs": Number($("chPoll").value) || 3000,
    "chat.historyLimit": Number($("chHistory").value) || 60,
    "chat.maxLength": Number($("chMax").value) || 500,
  }
  /*
   * 间隔的大小关系拦在提交前。后端不会因此报错 —— randomSleep（lib/browser.js:528-532）与
   * lib/spark.js:374 都会把上界抬到 `Math.max(minGap, maxGap)`，于是填反的区间被静默改写成
   * 「恒等于最小值」，界面上却仍显示用户填的那两个数。拦在这里是为了不让配置与实际行为分叉。
   */
  if (patch["spark.minGapMs"] > patch["spark.maxGapMs"]) return toast("好友间隔最小值不能大于最大值")
  if (!patch["spark.cron"]) return toast("cron 表达式不能为空")
  /*
   * 关闭聊天总开关前先确认。注意与 `#抖音设置 聊天 关` 的差别：那条命令会额外调
   * chat.closeAll（apps/panel.js:216）立即收掉服务端会话，而 `POST /api/config` 只写配置，
   * 本处也只做 resetChat（清本地状态），服务端那个 Chromium 要等 chat.idleCloseSec 空闲超时
   * 才收。因此这句确认问的是「本页正在进行的会话会从界面上消失」。
   */
  if (!patch["chat.enable"] && state.chat.accId && !confirm("关闭聊天功能会结束当前正在进行的私信会话，确认？"))
    return
  try {
    await api("/config", { method: "POST", body: { patch } })
    toast("配置已保存，定时任务已重新注册")
    // 轮询周期、空闲时长、总开关都在这一份 patch 里，逐项同步进 state.chat 后按新值重启轮询
    state.chat.enable = patch["chat.enable"]
    state.chat.idleSec = patch["chat.idleCloseSec"]
    state.chat.pollMs = patch["chat.pollMs"]
    if (!patch["chat.enable"]) resetChat()
    else if (state.chat.peer) startPoll()
    loadStatus()
  } catch (error) {
    toast(error.message, 4000)
  }
}

/* ---------- 状态与审计 ----------
 *
 * 对应 #tabStatus，读 `GET /api/status` 与 `GET /api/audit`。全部只读，因此本节没有会话状态，
 * 也不处理 409。切到该标签页、保存配置后、点 #btnRefresh 都会重新拉一次。
 */

/**
 * 「私信会话」那一格的文字。
 *
 * `/api/status` 回的是全部机器人的会话（chat.sessionList()），此处按 botId 过滤只报当前
 * 机器人的 —— 面板整体按 botId 隔离，列出别人的会话名会让人误以为是自己的号在被使用。
 *
 * @param {{sessions?: Array<{botId: string|number, account: string, peer?: string}>}} chat
 *   /api/status 响应里的 chat 段
 * @returns {string} HTML 串，将直接写入 innerHTML，故账号名与昵称都经 esc
 */
function chatSessionText(chat) {
  if (state.chat.enable === false) return '<span class="tag">功能已关闭</span>'
  const mine = (chat.sessions || []).filter(s => String(s.botId) === String(state.botId))
  if (!mine.length) return "空闲"
  return mine
    .map(s => `${esc(s.account)}${s.peer ? ` → ${esc(s.peer)}` : "（未选会话）"}`)
    .join("、")
}

/**
 * 「聊天记录」那一格。
 * db.ok 为 false 时必须把 reason 一起显示：它决定历史到底存不存得下来（node:sqlite 需要
 * Node ≥ 22.5），只写「不可用」会让人无从判断该升级还是该改配置。
 *
 * @param {{ok: boolean, reason?: string, messages?: number, conversations?: number}} [db]
 * @returns {string} HTML 串
 */
function chatDbText(db) {
  if (!db) return '<span class="tag">未知</span>'
  if (!db.ok) return `<span class="tag err">不可用</span><span class="tip"> ${esc(db.reason || "")}</span>`
  return `${db.messages} 条消息 / ${db.conversations} 个会话<span class="tip">（不过期）</span>`
}

/**
 * 铺状态格子 #statGrid 与审计表格 #auditBody。
 * 两个接口串行请求：状态格子先出来即可，审计表在下面，晚一点无妨；任一失败都只弹 toast，
 * 保留上一次的内容而不清空 —— 状态页刷新失败时空白比旧数据更难判断。
 */
async function loadStatus() {
  try {
    const st = await api("/status")
    const sc = st.scheduler || {}
    const sp = st.spark || {}
    const pu = st.push || {}
    const au = st.auth || {}
    const chat = st.chat || {}
    // .cell 与图片模板 .stat 共用同一套渐变（style.css:206-207），只是改为左对齐
    const cell = (k, v) => `<div class="cell"><div class="k">${k}</div><div class="v">${v}</div></div>`
    $("statGrid").innerHTML = [
      cell("定时状态", sc.enable ? (sc.registered ? '<span class="tag ok">已注册</span>' : '<span class="tag err">注册失败</span>') : '<span class="tag">已关闭</span>'),
      cell("cron", `<span class="mono">${esc(sc.cron || "-")}</span>`),
      cell("下次执行", esc(sc.nextTime || "-")),
      cell("当前状态", sc.busy ? '<span class="tag warn">续火进行中</span>' : "空闲"),
      cell("本机器人账号", `${sp.enabled ?? 0} / ${sp.total ?? 0} 启用${sp.invalid ? `，${sp.invalid} 个凭证失效` : ""}`),
      cell("续火好友", `${sp.targets ?? 0} 个`),
      cell("今日已续火", sc.skipIfDone
        ? `${sp.doneToday ?? 0} 个账号<span class="tip">（定时任务会跳过）</span>`
        : `${sp.doneToday ?? 0} 个账号<span class="tip">（不跳过，每次都发）</span>`),
      cell("上次续火", esc(sp.lastTime || "从未运行")),
      cell("上次批量结果", sc.lastRun
        ? `${esc(sc.lastRun.trigger)} · 成功 ${sc.lastRun.ok} / 失败 ${sc.lastRun.fail}${sc.lastRun.skipped ? ` / 跳过 ${sc.lastRun.skipped}` : ""}`
        : '<span class="tag">无记录</span>'),
      cell("推送范围", pu.enable ? esc(pu.targetLabel || "-") : '<span class="tag">已关闭</span>'),
      cell("推送目标", pu.enable
        ? `${pu.groupCount} 群 / ${pu.friendCount} 好友（${pu.mode === "detail" ? "详细" : "简要"}${pu.onlyOnFail ? "，仅失败推送" : ""}）`
        : '<span class="tag">已关闭</span>'),
      cell("会话与安全", `有效会话 ${au.activeSessions}，待用验证码 ${au.activeCodes}，封禁 IP ${au.bannedIps}`),
      // 私信会话背后挂着一个 Chromium，必须让用户在这里看见它开着，并知道从哪里关掉
      cell("私信会话", chatSessionText(chat)),
      cell("聊天记录", chatDbText(chat.db)),
    ].join("")

    const { items } = await api("/audit?limit=60")
    $("auditBody").innerHTML =
      items
        .map(i => {
          // 审计条目的字段随 action 而变，无法固定列。除时间与动作外的键值全部拼成一串
          // 塞进第三列，键名原样保留 —— 排查时要能和 lib/audit.js 的调用处对上
          const detail = Object.entries(i)
            .filter(([k]) => !["at", "time", "action"].includes(k))
            .map(([k, v]) => `${k}=${typeof v === "object" ? JSON.stringify(v) : v}`)
            .join("  ")
          return `<tr><td class="mono">${esc(i.time)}</td><td>${esc(i.action)}</td>
            <td class="tip mono">${esc(detail)}</td></tr>`
        })
        .join("") || '<tr><td colspan="3" class="tip">暂无记录</td></tr>'
  } catch (error) {
    toast(error.message)
  }
}
$("btnRefresh").onclick = loadStatus

boot()
