/**
 * 插件更新指令。
 *
 * 实现照抄同仓库的 hl-picture-plugin/apps/update.js（同一套 git pull + 重启流程，
 * 没必要另起一套），在它之上补了三点本插件必需的差异：
 * - 备份范围扩大到整个 config/ 与 data/：Cookie 密钥（data/secret.key）一旦被
 *   `reset --hard` 冲掉，所有已保存的 Cookie 都会永久解不开
 * - 日志条数与是否自动重启读插件自己的配置（update.logLimit / update.autoRestart）
 * - 更新完先 reload 配置，即使用户选择不重启，新增的配置项也有默认值可用
 */
import { createRequire } from "node:module"
import fs from "node:fs"
import path from "node:path"
import lodash from "lodash"
import common from "../../../lib/common/common.js"
import { Restart } from "../../other/restart.js"
import { config } from "../lib/config.js"
import { pluginRoot, PLUGIN_NAME, log, toError } from "../lib/util.js"

const require = createRequire(import.meta.url)
const { exec, execSync } = require("child_process")

/** 模块级而非实例级：loader 每次消息都会 new 一个插件实例，实例字段拦不住并发 */
let uping = false

/** git 命令统一用 `-C <路径>`，避免 cd 在不同 shell 下的差异 */
const repoPath = `./plugins/${PLUGIN_NAME}/`

export class DouyinUpdate extends plugin {
  constructor() {
    super({
      name: "抖音续火-更新",
      dsc: "拉取插件最新代码",
      event: "message",
      priority: 800,
      rule: [{ reg: "^#?(dy|抖音)(插件)?(强制)?更新$", fnc: "update", permission: "master" }],
    })
  }

  async update(e) {
    if (uping) return e.reply("已有更新在进行中，请勿重复操作")
    if (!(await this.checkGit(e))) return
    if (!fs.existsSync(path.join(pluginRoot, ".git")))
      return e.reply("插件目录不是 git 仓库，请用 git clone 重新安装后再使用更新指令")

    const isForce = e.msg.includes("强制")
    const updated = await this.runUpdate(e, isForce)
    if (updated && config.bool("update.autoRestart", true)) {
      await e.reply("2 秒后自动重启以加载新代码…")
      setTimeout(() => new Restart(e).restart(), 2000)
    } else if (updated) {
      await e.reply("已关闭自动重启，请手动重启 Yunzai 使新代码生效")
    }
  }

  async runUpdate(e, isForce) {
    // 用户数据必须活过 reset --hard：config 是用户设置，data 里有 Cookie 密钥
    const backup = backupUserData()

    let command = `git -C ${repoPath} pull --no-rebase`
    if (isForce) {
      command = `git -C ${repoPath} reset --hard origin && ${command}`
      await e.reply("正在执行强制更新（放弃本地改动），请稍等…")
    } else {
      await e.reply("正在执行更新，请稍等…")
    }

    const oldCommitId = this.getCommitId()
    uping = true
    const ret = await execAsync(command)
    restoreUserData(backup)
    uping = false

    if (ret.error) {
      log("warn", "插件更新失败：", ret.error.message)
      await this.gitErr(e, ret.error, ret.stdout)
      return false
    }

    const time = this.getTime()
    if (/(Already up[ -]to[ -]date|已经是最新的)/.test(String(ret.stdout))) {
      await e.reply(`${PLUGIN_NAME} 已是最新版本\n最后更新时间：${time}`)
      return false
    }

    config.reload()
    await e.reply(`${PLUGIN_NAME} 更新完成\n最后更新时间：${time}`)
    const logMsg = await this.getLog(e, oldCommitId)
    if (logMsg) await e.reply(logMsg)
    return true
  }

  /** 更新日志：只列本次拉下来的 commit，转成合并转发免得刷屏 */
  async getLog(e, oldCommitId) {
    const limit = config.num("update.logLimit", 20, { min: 1, max: 100 })
    let raw = ""
    try {
      raw = execSync(
        `git -C ${repoPath} log -${limit} --oneline --pretty=format:"%h||[%cd]  %s" --date=format:"%F %T"`,
        { encoding: "utf-8" }
      )
    } catch (error) {
      log("warn", "读取更新日志失败：", toError(error).message)
      return ""
    }
    if (!raw) return ""

    const lines = []
    for (const item of raw.split("\n")) {
      const [hash, text] = item.split("||")
      if (hash === oldCommitId) break
      if (!text || text.includes("Merge branch")) continue
      lines.push(text)
    }
    if (!lines.length) return ""
    return common.makeForwardMsg(e, [lines.join("\n\n")], `${PLUGIN_NAME} 更新日志，共 ${lines.length} 条`)
  }

  getCommitId() {
    try {
      return lodash.trim(execSync(`git -C ${repoPath} rev-parse --short HEAD`, { encoding: "utf-8" }))
    } catch {
      return ""
    }
  }

  getTime() {
    try {
      return lodash.trim(
        execSync(`git -C ${repoPath} log -1 --oneline --pretty=format:"%cd" --date=format:"%m-%d %H:%M"`, {
          encoding: "utf-8",
        })
      )
    } catch {
      return "获取时间失败"
    }
  }

  /** git 报错分类，直接把原始输出丢给用户看不懂，也不知道下一步该干什么 */
  async gitErr(e, err, stdout) {
    const errMsg = String(err)
    const out = String(stdout || "")

    if (errMsg.includes("Timed out"))
      return e.reply(`更新失败\n连接超时：${firstQuoted(errMsg)}\n可稍后重试，或给 git 配置代理`)
    if (/Failed to connect|unable to access/.test(errMsg))
      return e.reply(`更新失败\n连接失败：${firstQuoted(errMsg)}\n请检查网络或仓库地址`)
    if (errMsg.includes("be overwritten by merge"))
      return e.reply(`更新失败，本地改动与远端冲突：\n${errMsg}\n可执行「#抖音强制更新」放弃本地改动`)
    if (out.includes("CONFLICT"))
      return e.reply(`更新失败，存在冲突：\n${errMsg}\n${out}\n可执行「#抖音强制更新」放弃本地改动`)
    return e.reply([errMsg, out].filter(Boolean).join("\n"))
  }

  async checkGit(e) {
    try {
      const ret = execSync("git --version", { encoding: "utf-8" })
      if (String(ret).includes("git version")) return true
    } catch {}
    await e.reply("未检测到 git，请先安装 git 再使用更新指令")
    return false
  }
}

function firstQuoted(text) {
  return (text.match(/'(.+?)'/) || [])[1] || "未知地址"
}

/**
 * 备份 config/ 与 data/ 下的用户文件到内存。
 * 两个目录都在 .gitignore 里，正常 pull 不会碰它们；但 `reset --hard` 会，
 * 而 data/secret.key 丢失等于所有已保存的 Cookie 永久作废，代价太大。
 */
function backupUserData() {
  const backup = []
  for (const dir of ["config", "data"]) {
    const abs = path.join(pluginRoot, dir)
    if (!fs.existsSync(abs)) continue
    for (const file of walk(abs)) {
      try {
        backup.push({ file, content: fs.readFileSync(file) })
      } catch (error) {
        log("warn", `备份 ${file} 失败：`, error.message)
      }
    }
  }
  return backup
}

function restoreUserData(backup) {
  for (const { file, content } of backup) {
    try {
      if (fs.existsSync(file)) continue
      fs.mkdirSync(path.dirname(file), { recursive: true })
      fs.writeFileSync(file, content)
      log("mark", `已恢复被更新覆盖的文件：${file}`)
    } catch (error) {
      log("warn", `恢复 ${file} 失败：`, error.message)
    }
  }
}

function walk(dir) {
  const out = []
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const abs = path.join(dir, entry.name)
    if (entry.isDirectory()) out.push(...walk(abs))
    else if (entry.isFile()) out.push(abs)
  }
  return out
}

function execAsync(cmd) {
  return new Promise(resolve => {
    exec(cmd, { windowsHide: true }, (error, stdout, stderr) => resolve({ error, stdout, stderr }))
  })
}
