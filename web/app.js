/* 抖音续火控制台前端：无框架，单文件，够用即可 */
const BASE = "/" + (location.pathname.split("/").filter(Boolean)[0] || "douyin")
const $ = id => document.getElementById(id)
const state = { bots: [], botId: "", accounts: [], editing: "", qrSid: "", qrTimer: null, placeholders: [] }

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
  if (!res.ok) throw new Error(data.error || `请求失败(${res.status})`)
  return data
}

function show(view) {
  for (const id of ["viewLogin", "viewBots", "viewMain"]) $(id).classList.toggle("hide", id !== view)
}

function esc(text) {
  return String(text ?? "").replace(/[&<>"]/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]))
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
async function boot() {
  try {
    const st = await api("/auth/state")
    if (!st.authed) return show("viewLogin")
    state.bots = st.bots || []
    if (st.botId) {
      state.botId = st.botId
      await enterMain()
    } else {
      renderBots()
      show("viewBots")
    }
  } catch {
    show("viewLogin")
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
  $("curBot").textContent = bot ? `${bot.nickname}（${bot.uin}）` : state.botId
  show("viewMain")
  await Promise.all([loadAccounts(), loadConfig(), loadStatus()])
}

const logout = async () => {
  await api("/auth/logout", { method: "POST" }).catch(() => {})
  location.reload()
}
$("btnLogout").onclick = logout
$("btnLogout2").onclick = logout
$("btnSwitch").onclick = () => {
  renderBots()
  show("viewBots")
}

/* ---------- 标签页 ---------- */
for (const btn of document.querySelectorAll(".tabs button"))
  btn.onclick = () => {
    for (const b of document.querySelectorAll(".tabs button")) b.classList.toggle("on", b === btn)
    for (const name of ["accounts", "login", "config", "status"])
      $("tab" + name[0].toUpperCase() + name.slice(1)).classList.toggle("hide", name !== btn.dataset.tab)
    if (btn.dataset.tab === "status") loadStatus()
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
}

async function accAction(act, id, btn) {
  const acc = state.accounts.find(a => a.id === id)
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
    if (!confirm(`确认删除账号「${acc.name}」？其 Cookie 会一并删除。`)) return
    await api(`/accounts/${id}`, { method: "DELETE" }).catch(e => toast(e.message))
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

$("btnLoadFriends").onclick = async () => {
  const id = $("sendAcc").value
  if (!id) return toast("请选择账号")
  $("sendHint").textContent = "正在拉取会话列表…"
  try {
    const { friends } = await api(`/accounts/${id}/friends`)
    $("friendPick").innerHTML = friends.length
      ? friends.map(n => `<button class="sm ghost" data-n="${esc(n)}">${esc(n)}</button>`).join("")
      : '<span class="tip">没有拉到会话，可能需要先在抖音里打开过聊天</span>'
    for (const btn of $("friendPick").querySelectorAll("button"))
      btn.onclick = () => {
        const cur = $("sendFriends").value.trim()
        $("sendFriends").value = cur ? `${cur},${btn.dataset.n}` : btn.dataset.n
      }
    $("sendHint").textContent = `拉到 ${friends.length} 个会话，点击可加入收件人`
  } catch (error) {
    $("sendHint").textContent = error.message
  }
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
  }
  // 最小值大于最大值时 randInt 会返回负数，等于间隔失效，拦在提交前
  if (patch["spark.minGapMs"] > patch["spark.maxGapMs"]) return toast("好友间隔最小值不能大于最大值")
  if (!patch["spark.cron"]) return toast("cron 表达式不能为空")
  try {
    await api("/config", { method: "POST", body: { patch } })
    toast("配置已保存，定时任务已重新注册")
    loadStatus()
  } catch (error) {
    toast(error.message, 4000)
  }
}

/* ---------- 状态与审计 ---------- */
async function loadStatus() {
  try {
    const st = await api("/status")
    const sc = st.scheduler || {}
    const sp = st.spark || {}
    const pu = st.push || {}
    const au = st.auth || {}
    const cell = (k, v) => `<div class="card" style="padding:12px"><div class="tip">${k}</div>
      <div style="font-size:16px;margin-top:2px">${v}</div></div>`
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
