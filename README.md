# hl-douyin-plugin

TRSS-Yunzai 抖音自动续火插件。定时给抖音好友发消息保住火花，跑完把结果推到群里，配套一个带临时验证码鉴权的 Web 面板做可视化管理。

移植自 `douyin-auto-spark`（Playwright / TypeScript），改写为 Yunzai 插件：浏览器自动化换成仓库里已有的 puppeteer，定时改成可热更新的 cron，账号按机器人隔离，Cookie 加密落盘。

## 特性

- **定时续火** — 6 位 cron（秒在最前），锅巴或指令改完立即生效，不用重启
- **跳过今日已续火** — 抖音火花一天只认一次，已成功的账号定时任务直接跳过，可开关
- **好友改名不断火** — 续火目标存 `主名 + 别名 + 备注`，主名搜不到自动试别名，命中后把新名提为主名
- **结果推送** — 跑完自动发群 / 私聊 / 两者，支持多群、跨机器人、详细/简要两种模式、仅失败时推送
- **Web 可视化面板** — 账号管理、给指定好友手动发信、拉取会话列表、扫码登录、改配置、看状态与审计
- **三种登录方式** — 扫码自动抓 Cookie、私聊粘贴、发 txt 文件（QQ 输入框会截断超长 Cookie）
- **多机器人隔离** — 账号按 botId 分文件存储，面板会话只能进入「你是主人」的那些机器人
- **锅巴配置** — 全部配置项都在锅巴面板里可视化编辑
- **文本出图** — 帮助 / 设置 / 状态渲染成图片，渲染失败自动降级成文字
- **访问频次控制** — 拦截图片/字体/埋点请求、缓存 Cookie 检查结论，减少对抖音的请求量
- **插件更新** — `#抖音更新` 拉取新代码并自动重启，更新前备份 `config/` 与 `data/`

## 安装

在 Yunzai 根目录执行：

- gitee

``` bash
git clone --depth 1 https://gitee.com/fox-glaze/hl-douyin-plugin ./plugins/hl-douyin-plugin
```

然后重启 Yunzai。

无需 `npm install`：依赖全部复用 Yunzai 自带的 puppeteer / express / node-schedule / yaml / lodash，插件自己不引入新包。

装好后 `#抖音更新` 就能拉取新代码并自动重启，不必再手动 `git pull`。

首次启动会自动生成：

- `config/config.yaml` — 只存你改过的项，默认值在代码里，插件升级后新字段自动补齐
- `data/secret.key` — AES-256-GCM 主密钥（0600），**丢了等于所有 Cookie 作废，备份时别漏**
- `data/accounts/<机器人QQ>.json` — 加密后的账号数据
- `data/audit.json` — 操作审计

整个 `data/` 已在 `.gitignore` 里。

## 指令

| 指令 | 权限 | 说明 |
| --- | --- | --- |
| `#抖音web` | 主人 | 群里回面板链接，验证码私信单发 |
| `#抖音web下线` | 主人 | 立刻作废自己的验证码与面板会话 |
| `#抖音登录 [账号名]` | 主人 | 扫码登录，二维码以图片发回，成功后自动存 Cookie |
| `#抖音手动登录 账号名 Cookie` | 主人 | 只能私聊；在群里发会尝试撤回并拒收 |
| `#抖音文件登录 账号名` | 主人 | 只能私聊；随后发一个装着 Cookie 的 txt |
| `#抖音检查cookie` | 主人 | 逐个打开抖音验证凭证是否还有效（结果按 TTL 缓存） |
| `#抖音续火` | 主人 | 立即为当前机器人的所有启用账号跑一次 |
| `#抖音续火 跳过` | 主人 | 同上，但今天已成功的账号跳过，用于补跑定时任务 |
| `#抖音加好友 账号名 昵称` | 主人 | 支持 `昵称(备注)` 与 `新名=旧名` 写法 |
| `#抖音删好友 账号名 昵称` | 主人 | 主名或别名都能删掉整条目标 |
| `#抖音备注 账号名 昵称 备注` | 主人 | 备注留空则清除 |
| `#抖音账号` | 主人 | 账号列表、绑定的好友、上次结果 |
| `#抖音删除账号 账号名` | 主人 | 连 Cookie 一起删 |
| `#抖音状态` | 所有人 | 状态面板，默认出图 |
| `#抖音设置` | 主人 | 查看当前配置与可改项，默认出图 |
| `#抖音帮助` | 所有人 | 指令一览，默认出图 |
| `#抖音更新` / `#抖音强制更新` | 主人 | git pull 拉新代码，按配置自动重启 |

`抖音` 均可替换为 `dy`，`#` 可省略。

`#抖音设置` 支持的直改项（复杂配置走面板或锅巴）：

```text
#抖音设置 定时 开/关
#抖音设置 cron 0 20 8 * * *      # 无效表达式会自动还原
#抖音设置 跳过 开/关              # 跳过今天已续过火的账号
#抖音设置 推送 开/关
#抖音设置 推送范围 群/私聊/两者
#抖音设置 推送模式 详细/简要
#抖音设置 渲染 开/关              # 关掉则帮助/设置/状态都发纯文字
#抖音设置 加群 [群号]             # 不填用当前群
#抖音设置 删群 [群号]
#抖音设置 加好友 [QQ号]           # 不填用自己
#抖音设置 删好友 [QQ号]
#抖音设置 解封IP                  # 清空被限流拉黑的 IP
#抖音设置 会话                    # 查看活跃的面板会话
```

## 续火好友与改名自愈

好友改名是断火最常见的原因，所以续火目标不是一个裸昵称，而是 `{ 主名, 别名[], 备注 }`：

- **主名** — 当前用于搜索的名称（抖音里的备注名优先于昵称）
- **别名** — 历史名 / 备用名，主名搜不到时按顺序试；命中别名会自动把它提为主名，下次直接用新名搜
- **备注** — 只用于展示（「表妹」「同事老王」），不参与搜索

三处都用同一套文本语法，指令、面板、锅巴写法一致：

```text
张三                    # 只有主名
张三(表妹)               # 带备注，全角括号与 ｜ 也认
张三三=张三              # 主名「张三三」，别名「张三」
张三三=张三=小三(表妹)    # 多别名 + 备注
```

旧版本的 `targetNames: ["张三"]` 在读盘时就地迁移成新结构，升级插件不需要任何手动操作。

## Cookie 传输方式

QQ 输入框会截断超长文本，而抖音的完整 Cookie 常常超过限制——贴进去就是残缺的。三条路径按可靠性排序：

1. **扫码** `#抖音登录` — 浏览器自动抓，最省事
2. **文件** `#抖音文件登录 账号名` + 发 txt — Cookie 很长时用这个。收到后解析完立刻删除临时文件（`security.deleteCookieFile`）
3. **粘贴** `#抖音手动登录 账号名 Cookie` — 短 Cookie 直接贴

后两条只能私聊。群里出现 Cookie 视为泄露：插件会尝试撤回并要求私聊重发。

## Web 面板

发 `#抖音web` 后：链接发在当前会话，**6 位验证码只私信发**，两者分离才有意义。

流程：输入验证码 → 选择要操作的机器人 → 进入控制台（账号与发信 / 抖音登录 / 定时与推送 / 状态与审计）。

「定时与推送」标签页与锅巴改的是同一份 `config/config.yaml`，保存后定时任务立刻重新注册。

安全设计：

- 仅主人可触发；验证码只对「你是主人」的那些机器人授权，选别的机器人返回 403 并记审计
- 验证码一次性、默认 5 分钟过期，服务端只存 sha256，比较走 `timingSafeEqual`
- 验证码通过只换到一个会话，**不等于拿到机器人权限**——必须再显式选机器人，且不能越过授权名单
- 会话 Cookie 为 HttpOnly + SameSite=Strict，Path 限定在挂载路径下
- 验证码提交有独立限流桶（默认 60 秒 8 次），失败累计触发永久拉黑（重启或 `#抖音设置 解封IP` 清空）
- 所有敏感操作写审计，面板里可查
- 私信发送失败时自动作废刚发的验证码

面板默认挂在 Yunzai 自身端口的 `/douyin`。反代到公网时把 `web.url` 填成对外地址。`web.port` 填非 0 会额外起一个独立服务（端口被占用只警告，不影响插件加载）。

## 消息模板

留空 = 随机发一言（自带离线数据，无需联网）。

占位符：`{{account}}` `{{friend}}` `{{yiyan}}` `{{from}}` `{{date}}` `{{time}}` `{{weekday}}`

```text
{{friend}} 早上好，今天是 {{date}} {{weekday}}
{{yiyan}}
```

写错的占位符在保存时就会被拒绝，不会原样发给好友。yaml 里不方便换行可以写字面 `\n`。日期时间固定按 Asia/Shanghai 计算，服务器在国外也不会差一天。

账号可以单独设模板，覆盖全局那份。

## 配置

`config/config.yaml`，也可在锅巴或面板里改。

| 键 | 默认 | 说明 |
| --- | --- | --- |
| `spark.enable` | `true` | 定时续火总开关 |
| `spark.cron` | `0 20 8 * * *` | 每天 08:20:00 |
| `spark.skipIfDone` | `true` | 定时任务跳过今天已成功的账号（手动续火不受限） |
| `spark.messageTemplate` | `""` | 全局模板，空则发一言 |
| `spark.yiyanIncludeSource` | `true` | 一言末尾附带 ——「出处」 |
| `spark.minGapMs` / `maxGapMs` | `2500` / `6000` | 好友之间的随机间隔，太快容易被风控 |
| `spark.searchRetry` | `3` | 搜不到好友的重试次数（全部候选名都搜不到才算丢） |
| `spark.accountTimeoutMs` | `300000` | 单账号超时兜底 |
| `spark.headless` | `true` | 关掉可看浏览器，调选择器时用 |
| `spark.browserPath` | `""` | 空则用 Yunzai 的 `chromium_path` |
| `spark.screenshotOnFail` | `true` | 失败时整页截图存 `data/screenshots` |
| `spark.blockResources` | `true` | 拦截图片/字体/媒体请求（样式表不拦，否则元素塌成 0×0） |
| `spark.blockTracking` | `true` | 额外拦掉 app_log、slardar、推荐流等接口 |
| `spark.cookieCheckTTL` | `30` | Cookie 检查结论缓存分钟数，0 = 不缓存 |
| `push.enable` | `true` | 跑完是否推送结果 |
| `push.target` | `both` | `group` 只推群 / `friend` 只私聊 / `both` 两边都推 |
| `push.mode` | `detail` | `detail` 逐条列出 / `summary` 只报数量 |
| `push.onlyOnFail` | `false` | 开启后一切正常时保持静默 |
| `push.groups` / `friends` | `[]` | `{botId, groupId}` / `{botId, userId}`，botId 留空 = 用执行续火的那台 |
| `web.enable` | `true` | 面板总开关 |
| `web.base` | `/douyin` | 挂载路径，改动需重启 |
| `web.port` | `0` | 0 = 复用 Yunzai 端口 |
| `web.url` | `""` | 对外地址，反代时填 |
| `web.codeTTL` / `sessionTTL` | `300` / `1800` | 验证码 / 会话有效期（秒） |
| `web.rateWindow` / `rateGeneral` / `rateAuth` | `60` / `300` / `8` | 限流窗口与两个桶的配额 |
| `web.banAfter` | `12` | 鉴权失败几次后拉黑 IP |
| `web.auditKeep` | `500` | 审计日志保留条数 |
| `security.allowManualCookie` | `true` | 关掉则只能扫码登录 |
| `security.maskCookie` | `true` | 接口返回里的 Cookie 打码 |
| `security.qrLoginTimeout` | `180` | 扫码等待上限（秒） |
| `security.deleteCookieFile` | `true` | 解析完立刻删掉收到的 Cookie txt |
| `render.image` | `true` | 帮助/设置/状态是否出图 |
| `render.scale` | `1` | 渲染倍率，1 = 620px 宽 |
| `update.autoRestart` | `true` | `#抖音更新` 成功后自动重启 |
| `update.logLimit` | `20` | 更新日志展示的 commit 上限 |

## 安全说明

- Cookie 以 AES-256-GCM 加密存储，密钥在 `data/secret.key`（不用配置里的口令，因为口令会显示在锅巴面板上，密钥文件不会）
- 接口与日志里的 Cookie 一律打码
- 账号名、好友名进文件名前过滤，`../` 和盘符冒号都会被清掉
- 账号数据按机器人分文件，跨机器人读、删、跑都会失败
- 验证码、会话、IP 封禁全在内存里，**重启即全部失效**——对「主人临时开一次面板」的场景，这是安全收益

## 常见问题

**搜不到好友** — 用抖音里显示的备注名（备注优先于昵称）。对方改名时给目标加个别名（`#抖音加好友 账号名 新名=旧名`），下次搜到哪个都算命中；真删好友才会报「搜索不到」。

**Cookie 频繁失效** — 抖音单账号多端登录会互相挤掉。`#抖音检查cookie` 能确认；失效的账号在面板和状态图上标红，重新扫码即可。检查结论默认缓存 30 分钟，想立刻重查把 `spark.cookieCheckTTL` 调成 0。

**Cookie 粘不全** — QQ 输入框会截断超长文本。改用 `#抖音文件登录 账号名` 发 txt。

**二维码一直不出** — 抖音登录弹窗结构偶尔变动。`spark.headless` 改成 `false` 看一眼实际页面，或退回文件/手动导入 Cookie。

**配了群却没推送** — 先看 `push.target`：选了「仅群」时好友列表不收，反之同理。`#抖音状态` 的「推送范围」一栏就是当前生效值。

**改了 cron 没生效** — 不需要重启。插件自己持有定时任务，锅巴/面板/指令保存后会立刻重新注册；`#抖音状态` 里的「下次执行」就是当前生效的时间。

**面板打不开** — 检查 `web.enable`；反代后确认 `web.url` 填的是对外地址；`#抖音设置 解封IP` 可以解掉误触发的封禁。

**出图失败** — 会自动降级成文字，不会吞掉回复。想固定发纯文字就 `#抖音设置 渲染 关`。

## 目录结构

```text
hl-douyin-plugin/
├── index.js                 导入入口：注册路由与定时任务，扫 apps/ 导出 apps
├── guoba.support.js         锅巴配置
├── apps/                    指令层，只做「解析参数 → 调 lib → 回消息」
│   ├── web.js               #抖音web / #抖音web下线
│   ├── login.js             扫码 / 手动 / 文件三种登录，账号列表与删除
│   ├── spark.js             手动续火，好友增删与备注
│   ├── panel.js             状态 / 设置 / 帮助，末尾导出 applyConfigChange
│   └── update.js            #抖音更新
├── lib/
│   ├── config.js            配置模型（默认值 + 深合并 + 点路径）
│   ├── crypto.js            AES-256-GCM、验证码、常量时间比较
│   ├── store.js             按机器人隔离的账号仓库，续火目标结构与迁移
│   ├── auth.js              验证码 / 会话 / 限流 / 封禁
│   ├── audit.js             操作审计
│   ├── bot.js               多机器人适配（取实例、主人判断、发消息）
│   ├── browser.js           独立的 puppeteer 实例与请求拦截
│   ├── spark.js             续火核心：搜好友、开会话、发消息、改名自愈
│   ├── login.js             扫码登录 + 手动导入 + Cookie 检查
│   ├── scheduler.js         可热改 cron 的定时任务
│   ├── push.js              结果推送与结果分类
│   ├── panel.js             状态/设置/帮助的数据组装与纯文字版
│   ├── render.js            art-template + puppeteer 出图，失败降级成文字
│   ├── template.js          消息模板与占位符
│   ├── yiyan.js             离线一言
│   ├── web.js               Express 路由
│   └── util.js              公共工具
├── web/                     面板前端（无框架，index.html + app.js）
├── resources/
│   ├── common/              共用布局与主题（layout/default.html + theme.css）
│   ├── status/status.html   状态图模板（art-template）
│   ├── settings/settings.html
│   ├── help/help.html
│   └── data/yiyan.json      一言数据
├── config/                  运行时生成
└── data/                    运行时生成，已 gitignore
```

图文两条路走同一份数据：`lib/panel.js` 的 `buildXxxData()` 给模板，`xxxText()` 给纯文字，`lib/render.js` 的 `replyRender` 统一处理「渲染关闭 / 渲染失败 / 图片发不出去」三种降级，指令层不各自判断。

## 实现取舍

**为什么不用 `plugin.task` 做定时** — loader 只在插件加载时读一次 `task.cron`，锅巴改完必须重启才生效。所以自己持有 `schedule.scheduleJob`，改配置后 `reschedule()` 立刻换表。

**为什么不复用渲染器的浏览器** — `renderers/puppeteer` 那个实例带自己的重启/超时策略，还会通过 redis 里的 wsEndpoint 跨进程共享。续火与扫码登录要持有分钟级的登录态页面，挂在它上面会被它的 restart 打断，也可能把抖音 Cookie 带进别的插件的截图上下文。这里只复用它的依赖（puppeteer 包）和 Chromium 路径配置，浏览器实例独立。

**为什么扫码登录没嵌入现成项目** — 备选项要么自带一整套浏览器栈（Playwright，本仓库没装），要么是 Rust/Java 独立进程，要么走逆向签名接口。而抖音扫码本身就是两个公开接口：`get_qrcode` 出图、`check_qrconnect` 出状态，在我们自己的 puppeteer 会话里拦这两个响应就能拿到二维码和结果，Cookie 直接落在同一个 browserContext 里，不需要第二套浏览器或新依赖。

**为什么多账号是串行跑** — 并行会同时开多个 Chromium，既吃内存又容易触发抖音风控。

**为什么 `index.js` 只做导入** — loader 的 `getPlugins()` 见到插件目录里有 `index.js` 就只导入它并跳过其余 .js（`lib/plugins/loader.js:56`），所以指令想拆文件必须由 index.js 自己扫 `apps/` 并导出 `apps` 对象（`importPlugin()` 会把 `app.apps` 摊平）。键名用 `文件名.导出名`，一个文件里放多个插件类也不会互相覆盖。

**为什么 `applyConfigChange` 写成箭头函数** — loader 只用 `if (!p?.prototype) return` 过滤非插件导出，普通 `function` 有 prototype，会被当成插件类 new 两次然后读 `rule.length` 报错。箭头函数没有 prototype，正好被过滤掉。

**为什么文件登录单开一条指令** — 复用 `#抖音手动登录` 的话，它的正则会把后续参数吞进 Cookie 位置。而 loader 的 context hook 优先于 rule 匹配（`loader.js:205`），`#抖音文件登录 账号名` 挂上下文后用户发的下一条消息（带 `e.file`）会直接进回调，语义更干净。

**为什么更新前要备份整个 `config/` 与 `data/`** — 参考实现只备份单个 yaml，但本插件 `data/secret.key` 一旦被 `git reset --hard` 冲掉，所有已保存的 Cookie 都永久解不开。恢复时只写回「pull 后不存在」的文件，不覆盖新代码带来的内容。

## License

MIT
