/**
 * 插件更新指令：`#抖音更新` 与 `#抖音强制更新`。
 *
 * 位置：指令层，直接调 git 命令行而不经 lib —— 更新是插件生命周期外的一次性操作，
 * 与续火/登录那条链路没有共享状态。
 * 协作模块：lib/config.js（读 update.* 并在更新后 reload）、lib/util.js（PLUGIN_NAME 与日志）、
 * Yunzai 的 lib/common/common.js（makeForwardMsg 折叠更新日志）、
 * plugins/other/restart.js 的 Restart（重启进程加载新代码）。
 *
 * 实现照抄同仓库的 hl-picture-plugin/apps/update.js（同一套 git pull + 重启流程，
 * 没必要另起一套），在它之上补了三点本插件必需的差异：
 * - 备份范围扩大到整个 config/ 与 data/：data/secret.key 是 Cookie 的主密钥，
 *   丢一次就意味着全部已保存的 Cookie 永久解不开，代价远高于其它插件的配置文件
 * - 日志条数与是否自动重启读插件自己的配置（update.logLimit / update.autoRestart）
 * - 更新完先 config.reload()，即使用户选择不重启，新增的配置项也有默认值可用
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
      // 一条正则覆盖普通与强制两种：「强制」二字由 update() 自己从 e.msg 里判断，
      // 拆成两条 rule 需要保证强制那条排在前面，反而多一个易错点
      rule: [{ reg: "^#?(dy|抖音)(插件)?(强制)?更新$", fnc: "update", permission: "master" }],
    })
  }

  /**
   * 更新入口：前置检查 → 拉代码 → 按配置重启。
   *
   * 先查 git 与 .git 目录：压缩包安装的插件没有 .git，直接跑 pull 只会得到一句
   * 「not a git repository」，不如在这里说清要重新 clone。
   *
   * @param {object} e 消息事件
   * @returns {Promise<*>} 未通过前置检查时为提示回复，否则为 undefined（结果已逐条回复）
   */
  async update(e) {
    if (uping) return e.reply("已有更新在进行中，请勿重复操作")
    if (!(await this.checkGit(e))) return
    if (!fs.existsSync(path.join(pluginRoot, ".git")))
      return e.reply("插件目录不是 git 仓库，请用 git clone 重新安装后再使用更新指令")

    const isForce = e.msg.includes("强制")
    const updated = await this.runUpdate(e, isForce)
    // 本插件不参与热重载（有 index.js，loader 不注册 watch，见 index.js 头部），
    // 所以新代码必须靠重启才生效；延迟 2 秒是为了让上面那句回复先发出去
    if (updated && config.bool("update.autoRestart", true)) {
      await e.reply("2 秒后自动重启以加载新代码…")
      setTimeout(() => new Restart(e).restart(), 2000)
    } else if (updated) {
      await e.reply("已关闭自动重启，请手动重启 Yunzai 使新代码生效")
    }
  }

  /**
   * 执行 git 拉取，并把结果回给用户。
   *
   * @param {object} e 消息事件
   * @param {boolean} isForce true 时先 `reset --hard origin` 放弃本地改动再 pull
   * @returns {Promise<boolean>} 是否真的拉到了新代码（已是最新版或失败都返回 false，
   *   调用方据此决定要不要重启）
   */
  async runUpdate(e, isForce) {
    // 备份要在跑 git 之前：config/ 是用户设置，data/ 里有 Cookie 主密钥，
    // 二者的取回代价都远高于一次多余的内存拷贝
    const backup = backupUserData()

    // pull 固定 --no-rebase：仓库默认 pull.rebase 未设时 git 会打印一段提示并可能拒绝执行，
    // 显式指定合并策略后在任何 git 版本上行为一致
    let command = `git -C ${repoPath} pull --no-rebase`
    if (isForce) {
      command = `git -C ${repoPath} reset --hard origin && ${command}`
      await e.reply("正在执行强制更新（放弃本地改动），请稍等…")
    } else {
      await e.reply("正在执行更新，请稍等…")
    }

    // 先记下当前 commit：更新日志靠它作为终止标记，只列这次新拉下来的部分
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

    // 中英文两种输出都要认：git 会跟随系统语言，服务器与家用机的输出常不一致
    const time = this.getTime()
    if (/(Already up[ -]to[ -]date|已经是最新的)/.test(String(ret.stdout))) {
      await e.reply(`${PLUGIN_NAME} 已是最新版本\n最后更新时间：${time}`)
      return false
    }

    // 即使用户关了自动重启，也先让本进程读到新的默认配置树：新版本新增的配置项
    // 在旧内存里是 undefined，而 DEFAULT_CONFIG 已随代码一起更新
    config.reload()
    await e.reply(`${PLUGIN_NAME} 更新完成\n最后更新时间：${time}`)
    const logMsg = await this.getLog(e, oldCommitId)
    if (logMsg) await e.reply(logMsg)
    return true
  }

  /**
   * 更新日志：只列本次拉下来的 commit，转成合并转发免得刷屏。
   *
   * `%h||[%cd]  %s` 用 `||` 分隔而不是空格：commit 标题本身可能含空格，
   * 按空格切会把标题截断，而 `||` 不会出现在 hash 与日期里。
   *
   * @param {object} e 消息事件，makeForwardMsg 需要它取发送者信息
   * @param {string} oldCommitId 更新前的短 hash，遇到它即停止（它及更早的都是旧内容）
   * @returns {Promise<*|string>} 合并转发消息；读日志失败或没有可显示的 commit 时返回空串
   */
  async getLog(e, oldCommitId) {
    const limit = config.num("update.logLimit", 20, { min: 1, max: 100 })
    let raw = ""
    try {
      raw = execSync(
        `git -C ${repoPath} log -${limit} --oneline --pretty=format:"%h||[%cd]  %s" --date=format:"%F %T"`,
        { encoding: "utf-8" }
      )
    } catch (error) {
      // 日志读不到不影响更新本身已经成功，只记一行并返回空串
      log("warn", "读取更新日志失败：", toError(error).message)
      return ""
    }
    if (!raw) return ""

    const lines = []
    for (const item of raw.split("\n")) {
      const [hash, text] = item.split("||")
      if (hash === oldCommitId) break
      // 合并提交只是分支拓扑，对使用者没有信息量，跳过
      if (!text || text.includes("Merge branch")) continue
      lines.push(text)
    }
    if (!lines.length) return ""
    return common.makeForwardMsg(e, [lines.join("\n\n")], `${PLUGIN_NAME} 更新日志，共 ${lines.length} 条`)
  }

  /**
   * 当前 HEAD 的短 hash，作为更新日志的终止标记。
   * @returns {string} 取不到时返回空串（此时 getLog 会一直列到 logLimit 条）
   */
  getCommitId() {
    try {
      return lodash.trim(execSync(`git -C ${repoPath} rev-parse --short HEAD`, { encoding: "utf-8" }))
    } catch {
      return ""
    }
  }

  /**
   * 最后一次 commit 的时间，展示用。
   * 取 commit 时间而不是文件 mtime：后者会被 checkout 与备份恢复改写。
   * @returns {string} 形如 `09-02 18:30`；取不到时返回「获取时间失败」
   */
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

  /**
   * git 报错分类。原始输出对用户既看不懂也给不出下一步，因此按四类特征各配一句处置建议，
   * 都不匹配时才原样回显。
   *
   * 分类依据放在 errMsg 与 stdout 两处：git 把冲突提示写在 stdout，
   * 而超时与连接失败在 stderr（被 exec 收进 error）。
   *
   * @param {object} e 消息事件
   * @param {Error} err execAsync 返回的 error（含 stderr 内容）
   * @param {string} stdout git 的标准输出
   * @returns {Promise<*>} e.reply 的结果
   */
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

  /**
   * 环境里有没有 git。没有时 pull 会以一句系统级报错失败，不如提前说清要装什么。
   * @param {object} e 消息事件
   * @returns {Promise<boolean>} false 时已经回复过用户
   */
  async checkGit(e) {
    try {
      const ret = execSync("git --version", { encoding: "utf-8" })
      if (String(ret).includes("git version")) return true
    } catch {}
    await e.reply("未检测到 git，请先安装 git 再使用更新指令")
    return false
  }
}

/**
 * 取 git 报错里第一个被单引号括起的片段，通常是仓库地址或远端名。
 * @param {string} text
 * @returns {string} 没有单引号时返回「未知地址」
 */
function firstQuoted(text) {
  return (text.match(/'(.+?)'/) || [])[1] || "未知地址"
}

/**
 * 把 config/ 与 data/ 下的全部文件读进内存备份。
 *
 * 两个目录都在 .gitignore 里（`/config/`、`/data/`），因此普通 pull 不会碰它们。备份针对的
 * 是「远端开始跟踪同名路径」这一情形：那时 pull 会用远端版本覆盖本地文件，而
 * data/secret.key 是 Cookie 的主密钥，覆盖一次就意味着全部已保存的 Cookie 永久解不开。
 *
 * 单个文件读失败只记日志、不中断：一份不完整的备份仍然好过没有备份。
 *
 * @returns {Array<{file: string, content: Buffer}>} 绝对路径 + 原始字节
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

/**
 * 回写备份。只补「更新后已经不存在」的文件，存在的一律跳过。
 *
 * 不无条件覆盖：pull 之后磁盘上的那份可能比备份更新（例如更新期间续火写了账号文件），
 * 全量盖回去会把这些改动一起抹掉。代价是「文件仍在但内容被远端版本覆盖」这种情况
 * 恢复不了，只有被删掉的才补得回来。
 *
 * @param {Array<{file: string, content: Buffer}>} backup backupUserData 的返回值
 */
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

/**
 * 递归列出目录下所有文件的绝对路径（不含目录本身）。
 * @param {string} dir 起始目录，需已存在
 * @returns {string[]}
 */
function walk(dir) {
  const out = []
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const abs = path.join(dir, entry.name)
    if (entry.isDirectory()) out.push(...walk(abs))
    else if (entry.isFile()) out.push(abs)
  }
  return out
}

/**
 * exec 的 Promise 包装。
 *
 * 一律 resolve、从不 reject：git 用非零退出码表达「有冲突」「连不上」等正常分支，
 * 这些都要交给 gitErr 分类后给用户建议，而不是当成异常抛掉。
 * windowsHide 避免 Windows 上闪出控制台窗口。
 *
 * @param {string} cmd 完整命令行
 * @returns {Promise<{error: Error|null, stdout: string, stderr: string}>}
 */
function execAsync(cmd) {
  return new Promise(resolve => {
    exec(cmd, { windowsHide: true }, (error, stdout, stderr) => resolve({ error, stdout, stderr }))
  })
}
