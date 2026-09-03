/* 抖音续火控制台前端：无框架，单文件，够用即可 */
const BASE = "/" + (location.pathname.split("/").filter(Boolean)[0] || "douyin")
const $ = id => document.getElementById(id)
const state = {
  bots: [], botId: "", accounts: [], editing: "", qrSid: "", qrTimer: null, placeholders: [],
  /**
   * 聊天是唯一有服务端状态的功能：open 之后服务器挂着一个 Chromium。
   * 所以这些字段不只是界面状态，还是「服务端那个会话现在是什么样」的本地副本。
   */
  chat: {
    accId: "", accName: "", peer: "",
    pollMs: 3000, timer: null,
    /** 已知的最大消息 id，轮询用它当 since */
    lastId: 0,
    peers: [], msgs: [],
    /** 正在翻历史时不要被轮询的重渲染打断 */
    loadingEarlier: false,
    /** 翻到库底了。不置这个标志的话，用户停在顶部时每次微小滚动都会再查一遍空结果 */
    noMore: false,
    db: true,
    /** 这两项由 loadConfig 从 /api/config 填：总开关关着时整个标签页只显示一句说明 */
    enable: true, idleSec: 180,
  },
}

function toast(msg, ms = 2200) {
  const el = $("toast")
  el.textContent = msg
  el.classList.remove("hide")
  clearTimeout(toast.t)
  toast.t = setTimeout(() => el.classList.add("hide"), ms)
}

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
    // 状态码要留给调用方：聊天接口用 409 表示「服务端那个会话没了，该退回账号列表」，
    // 400 只是这次操作失败（会话还在）。只看 message 的话前端没法区分要不要重连
    error.status = res.status
    throw error
  }
  return data
}

function show(view) {
  for (const id of ["viewLogin", "viewBots", "viewMain"]) $(id).classList.toggle("hide", id !== view)
}

function esc(text) {
  return String(text ?? "").replace(/[&<>"]/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]))
}

/** 昵称首字当头像。emoji 昵称要按码点取，用 [0] 会截出半个代理对变成乱码方框 */
function initial(name) {
  return [...String(name || "?")][0] || "?"
}

/**
 * 时间戳 → 「今天 14:05」/「昨天 22:31」/「9-1 08:12」。
 * 缓存最长几小时，配「几点拉的」这种用途；绝对日期只在跨天时才出现。
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
 * 这里保留两套转换：展示用 targetLabel，编辑用 targetLine（可被 normalizeTargets 原样解析回来）。
 */
function targets(acc) {
  if (Array.isArray(acc?.targets) && acc.targets.length) return acc.targets
  return (acc?.targetNames || []).map(name => ({ name, alias: [], note: "" }))
}

/** 与 lib/store.js 的 targetLabel 同一套写法：`张三（表妹）` 或 `张三 / 旧名` */
function targetLabel(target) {
  if (!target?.name) return ""
  if (target.note) return `${target.name}（${target.note}）`
  if (target.alias?.length) return `${target.name} / ${target.alias.join(" / ")}`
  return target.name
}

/** 编辑框里的一行：`主名=别名1=别名2(备注)`，与后端 parseTargetText 的语法一致 */
function targetLine(target) {
  if (!target?.name) return ""
  const names = [target.name, ...(target.alias || [])].join("=")
  return target.note ? `${names}(${target.note})` : names
}

/* ---------- 鉴权 ---------- */

/**
 * 从 URL 的 hash 里取一键进入的验证码，取完立刻抹掉。
 *
 * 为什么是 hash 而不是 query：hash 不发给服务端，因此不进 access log、不随 Referer
 * 外泄（Yunzai 的 serverHandle 会把 req.query 整个打进日志，而日志经常被直接贴出来
 * 排查问题）。读完 replaceState 是为了让地址栏、书签、截图里都不留这 6 位码。
 * 与远程验证页面（/verify#t=xxx）同一套做法。
 */
function takeHashCode() {
  const raw = decodeURIComponent(location.hash.slice(1)).trim().toUpperCase()
  if (location.hash) history.replaceState(null, "", location.pathname + location.search)
  // 验证码字符集见 lib/crypto.js 的 randomCode：去掉了易混的 0O1IL
  return /^[A-Z0-9]{4,8}$/.test(raw) ? raw : ""
}

async function boot() {
  const hashCode = takeHashCode()
  /** 未登录时的落点：带了码就直接验，用户点链接的预期是「点一下就进去」而不是再按一次按钮 */
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

async function enterMain() {
  const bot = state.bots.find(b => b.uin === state.botId)
  $("curBot").textContent = bot ? `${bot.nickname}（${bot.uin}）· ${bot.online ? "在线" : "离线"}` : state.botId
  show("viewMain")
  await Promise.all([loadAccounts(), loadConfig(), loadStatus()])
}

const logout = async () => {
  // 先收掉聊天会话：退登录后前端再也不会来轮询，服务端那个 Chromium 只能等空闲超时
  await leaveChat({ silent: true })
  await api("/auth/logout", { method: "POST" }).catch(() => {})
  location.reload()
}
$("btnLogout").onclick = logout
$("btnLogout2").onclick = logout
$("btnSwitch").onclick = async () => {
  // 聊天会话是绑在 botId:accountId 上的，换机器人后当前这个界面就不属于新机器人了
  await leaveChat({ silent: true })
  renderBots()
  show("viewBots")
}

/* ---------- 标签页 ---------- */
const TABS = ["accounts", "chat", "login", "config", "status"]
for (const btn of document.querySelectorAll(".tabs button"))
  btn.onclick = () => {
    for (const b of document.querySelectorAll(".tabs button")) b.classList.toggle("on", b === btn)
    for (const name of TABS)
      $("tab" + name[0].toUpperCase() + name.slice(1)).classList.toggle("hide", name !== btn.dataset.tab)
    if (btn.dataset.tab === "status") loadStatus()
    if (btn.dataset.tab === "chat") renderChatPick()
  }
/* ---------- 账号 ---------- */
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

  // 聊天那个标签页里的账号卡片读同一份 state.accounts
  renderChatPick()
}

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
    // 删掉的正是当前开着的聊天账号时，后端已经把会话收了，前端得跟着退出去
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
    id: state.editing || undefined,
    name: $("fName").value.trim(),
    enable: $("fEnable").value === "1",
    // 按行传数组而不是整块文本：后端 normalizeTargets 对数组逐项解析，
    // 备注里的空格与逗号不会被 toIdList 当分隔符切开
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

/* ---------- 发信 ---------- */
$("btnSend").onclick = async () => {
  const id = $("sendAcc").value
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
 * 拉会话列表。后端默认吃缓存（`spark.friendsCacheTTL`），`refresh` 才真开浏览器。
 * 命中缓存时要把「这是几点拉的」说出来——用户看到旧名单会以为接口坏了。
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
    // 拉过一次才显示「重新拉取」：没名单时那个按钮没有意义
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

// 换账号后原来那份名单属于上一个号，留着只会让人往错的收件人上点
$("sendAcc").onchange = () => {
  $("friendPick").innerHTML = ""
  $("btnReloadFriends").classList.add("hide")
  $("sendHint").textContent = ""
}
/* ---------- 抖音登录 ---------- */
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
      // expired 只由「整个会话超时」产生，是终态。单张二维码过期不会走到这里——
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
 * 对应 lib/web.js 的 7 条 /api/chat/:id/* 接口。和面板其它部分最大的不同是**它有状态**：
 * open 之后服务端挂着一个 Chromium，close 或空闲超时才收。由此推出三条做法：
 *
 * 1. 只有 enterChat（用户点「聊天」）才调 open。刷新页面不自动重连——F5 一下白开一个
 *    浏览器、还要抢账号锁十几秒，代价太大。刷新后回到账号列表是对的。
 * 2. 任何接口回 409 都当「服务端会话没了」处理：停轮询、退回账号列表、说明原因。
 *    这是 fail() 在后端唯一会给 409 的情形（/会话未打开|已关闭/），其它错误只提示。
 * 3. 轮询用 setTimeout 自己续而不是 setInterval：一次轮询要读页面，慢起来能到几秒，
 *    setInterval 会把请求叠在一起，每一个都在等同一把 chain 锁。
 */

/** 聊天页面上的时间：优先用抖音那个页面时间戳（对方那条的真实时间），没有才退到入库时间 */
function msgStamp(m) {
  return m.stamp || clockText(m.at)
}

/** 一条消息的 DOM。self 决定靠哪边，样式在 style.css 的 .msg / .msg.me */
function msgHtml(m, accName, peer) {
  const who = m.self ? accName : peer
  return `<div class="msg${m.self ? " me" : ""}">
    <div class="av">${esc(initial(who))}</div>
    <div><div class="bubble">${esc(m.text)}</div>
    <div class="msg-stamp">${esc(msgStamp(m))}</div></div>
  </div>`
}

/** 账号选择态：哪些账号能进聊天。缺 Cookie / 凭证失效的直接禁掉，点了也只会失败 */
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
        // 「正在续火」不禁用：那是转瞬的状态，等它跑完就能进，真点早了后端会给明确的错
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

/** 进入某账号的私信。这一步会在服务器上开浏览器，慢是正常的，所以要有明确的进度文字 */
async function enterChat(accId) {
  const acc = state.accounts.find(a => a.id === accId)
  if (!acc) return
  if (state.chat.accId && state.chat.accId !== accId) await leaveChat({ silent: true })

  // 切到聊天标签页，让用户看见进度而不是以为按钮没反应
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
    // 会话列表用的是库里那份（open 不读页面）。真去页面读一遍才有最新预览与新会话
    refreshPeers({ silent: true })
  } catch (error) {
    $("chatPickErr").textContent = error.message
  }
}

/** 退出聊天：告诉服务端收掉浏览器，再清本地状态 */
async function leaveChat({ silent = false } = {}) {
  const accId = state.chat.accId
  if (!accId) return
  stopPoll()
  await api(`/chat/${accId}/close`, { method: "POST" }).catch(() => {})
  resetChat()
  if (!silent) toast("已退出聊天，服务器上的抖音页面已关闭")
}

/** 只清本地状态，不碰服务端。用在「服务端已经没了」（409）与账号被删的情形 */
function resetChat() {
  stopPoll()
  Object.assign(state.chat, {
    accId: "", accName: "", peer: "", peers: [], msgs: [], lastId: 0, loadingEarlier: false,
  })
  renderChatPick()
}

/**
 * 把 409 统一处理掉。返回 true 表示「已经当会话失效处理了，调用方别再管」。
 * 其它错误交回调用方——它们不需要重连，只要提示。
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

/** 去抖音页面重读一遍会话列表（`?refresh=1`）。不带 refresh 只会拿到库里那份 */
async function refreshPeers({ silent = false } = {}) {
  if (!state.chat.accId) return
  const btn = $("btnChatRefresh")
  btn.disabled = true
  try {
    const { conversations } = await api(`/chat/${state.chat.accId}/conversations?refresh=1`)
    state.chat.peers = conversations || []
    // 正在看的那个会话不该有未读。后端的 markSeen 只在 openPeer 时跑过一次，
    // 之后进来的消息照样计数，刷新会把那个数字带回来
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
 * 重画消息区。默认贴底，除非用户自己往上翻了——正在读旧消息时被拽回底部最恼人。
 * 判据是「距底 120px 内」，容一点滚动惯性和气泡高度差。
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
    // 往上翻历史时：新内容加在顶部，把滚动位置按新增高度往下推，视觉上停在原处
    box.scrollTop = box.scrollHeight - prevHeight
  } else if (atBottom) {
    box.scrollTop = box.scrollHeight
  }
}

/** 点一个会话：服务端切页面 + 回一屏历史 */
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
    // 进了会话就把这一条的未读抹掉——后端 markSeen 已经清了库里的
    markRead(state.chat.peer)
    $("chatText").disabled = false
    $("btnChatSend").disabled = false
    renderChatHead()
    renderPeers()
    renderFlow()
    startPoll()
    // 一屏没装满就先补一页：容器滚不动的话 scroll 事件永远不会来
    if ($("chatFlow").scrollHeight <= $("chatFlow").clientHeight + 8) loadEarlier()
  } catch (error) {
    if (chatGone(error)) return
    toast(error.message, 4000)
    renderChatHead()
  }
}

/** 抹掉某个会话的未读角标（只改本地那份，库里的由后端 markSeen 负责） */
function markRead(peer) {
  const hit = state.chat.peers.find(p => p.peer === peer)
  if (hit) hit.unread = 0
}

function lastIdOf(list) {
  return list.reduce((max, m) => (m.id > max ? m.id : max), 0)
}

/** 把新消息并进 state.msgs。按 id 去重——发消息的返回值和下一轮轮询会有重叠 */
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

function stopPoll() {
  clearTimeout(state.chat.timer)
  state.chat.timer = null
}

/**
 * 一轮一轮地自己续，而不是 setInterval。
 *
 * 服务端每次 poll 都要真去读一遍页面（几百毫秒到几秒），setInterval 会在慢的时候
 * 把请求叠起来，而它们都在等 ChatSession.chain 那把串行锁——队列越排越长，
 * 用户看到的延迟反而更大。页面切到后台时也不轮询：读页面是有代价的动作。
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
        // 预览跟着动，否则左边列表停在几十条消息之前
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
      // 单次失败不停轮询：读页面偶尔超时是常态，停了就要用户手动点回来
      $("chatHeadTip").textContent = `收消息失败：${error.message}`
    }
    state.chat.timer = setTimeout(tick, state.chat.pollMs)
  }
  state.chat.timer = setTimeout(tick, state.chat.pollMs)
}

/* ---------- 发送 ---------- */

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

/** Enter 发送、Shift+Enter 换行，与 QQ/微信一致 */
$("chatText").addEventListener("keydown", e => {
  if (e.key === "Enter" && !e.shiftKey && !e.isComposing) {
    e.preventDefault()
    sendChat()
  }
})

/** 输入框随内容长高，上限交给 css 的 max-height（超过就自己滚） */
function autoGrow() {
  const el = $("chatText")
  el.style.height = "auto"
  el.style.height = Math.min(el.scrollHeight, 120) + "px"
}
$("chatText").addEventListener("input", autoGrow)

/**
 * 往上翻一页历史。纯查库，不碰浏览器，所以会话关了也能翻。
 *
 * 两个触发点：滚到顶（正常情形），以及一屏没装满时的自动补一页——
 * 把 chat.historyLimit 调到 10 之类的小值时，消息撑不满 620px 的容器，
 * 根本滚不动，光靠 scroll 事件的话用户永远翻不出更早的消息。
 */
async function loadEarlier() {
  const { accId, peer, msgs, loadingEarlier, noMore } = state.chat
  if (loadingEarlier || noMore || !accId || !peer || !msgs.length) return
  state.chat.loadingEarlier = true
  try {
    const r = await api(
      `/chat/${accId}/earlier?peer=${encodeURIComponent(peer)}&before=${msgs[0].id}`
    )
    // 按 id 去重再拼：翻历史和轮询都会往 state.msgs 里塞东西，中间那几百毫秒
    // 足够让一条消息从两个方向同时进来
    const known = new Set(state.chat.msgs.map(m => m.id))
    const add = (r.messages || []).filter(m => !known.has(m.id))
    if (add.length) {
      state.chat.msgs = [...add, ...state.chat.msgs].sort((a, b) => a.id - b.id)
      renderFlow({ keepScroll: true })
    } else {
      // 到库底了。不记住这件事的话，用户停在顶部时每一次惯性滚动都会再查一遍空结果
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

/* ---------- 配置 ---------- */
function targetsToText(list, field) {
  return (list || [])
    .map(item =>
      typeof item === "object" ? `${item.botId ? item.botId + ":" : ""}${item[field] ?? item.id ?? ""}` : String(item)
    )
    .filter(Boolean)
    .join("\n")
}
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
    // 聊天标签页的入口与提示文字都跟着配置走，所以配置回来后要重画一次
    state.chat.enable = ch.enable !== false
    state.chat.idleSec = ch.idleCloseSec ?? 180
    if (!state.chat.accId) renderChatPick()
  } catch (error) {
    toast(error.message)
  }
}

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
  // 最小值大于最大值时 randInt 会返回负数，等于间隔失效，拦在提交前
  if (patch["spark.minGapMs"] > patch["spark.maxGapMs"]) return toast("好友间隔最小值不能大于最大值")
  if (!patch["spark.cron"]) return toast("cron 表达式不能为空")
  // 关掉聊天总开关会连带收掉服务端已开的会话（apps/panel.js 的 closeAllChats 同一条判据），
  // 说清楚再问一次——正在聊的人不该被一次「保存配置」踢掉
  if (!patch["chat.enable"] && state.chat.accId && !confirm("关闭聊天功能会结束当前正在进行的私信会话，确认？"))
    return
  try {
    await api("/config", { method: "POST", body: { patch } })
    toast("配置已保存，定时任务已重新注册")
    // 聊天配置可能变了：轮询周期、空闲时长、总开关都在这一份里
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

/* ---------- 状态与审计 ---------- */

/**
 * 状态页那一格「私信会话」的文字。
 *
 * `/api/status` 回的是全部机器人的会话（chat.sessionList()），这里只报当前机器人的——
 * 面板整体是按 botId 隔离的，把别的机器人的会话名列出来会让人以为是自己的号在被用。
 */
function chatSessionText(chat) {
  if (state.chat.enable === false) return '<span class="tag">功能已关闭</span>'
  const mine = (chat.sessions || []).filter(s => String(s.botId) === String(state.botId))
  if (!mine.length) return "空闲"
  return mine
    .map(s => `${esc(s.account)}${s.peer ? ` → ${esc(s.peer)}` : "（未选会话）"}`)
    .join("、")
}

/** 「聊天记录」那一格。db.ok 为 false 时把原因带上——它决定历史到底存不存得下来 */
function chatDbText(db) {
  if (!db) return '<span class="tag">未知</span>'
  if (!db.ok) return `<span class="tag err">不可用</span><span class="tip"> ${esc(db.reason || "")}</span>`
  return `${db.messages} 条消息 / ${db.conversations} 个会话<span class="tip">（不过期）</span>`
}

async function loadStatus() {
  try {
    const st = await api("/status")
    const sc = st.scheduler || {}
    const sp = st.spark || {}
    const pu = st.push || {}
    const au = st.auth || {}
    const chat = st.chat || {}
    // .cell 的渐变与图片模板的 .stat 同一套，见 style.css
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
      // 聊天会话挂着一个 Chromium，用户得能在这里看见它开着、并且知道该去哪关
      cell("私信会话", chatSessionText(chat)),
      cell("聊天记录", chatDbText(chat.db)),
    ].join("")

    const { items } = await api("/audit?limit=60")
    $("auditBody").innerHTML =
      items
        .map(i => {
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
