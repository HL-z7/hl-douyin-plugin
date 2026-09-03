/**
 * 加解密与随机凭据：AES-256-GCM 的 encrypt/decrypt、一次性验证码与 token 生成、
 * 常量时间比较、验证码哈希。
 *
 * 三处使用它：
 * - lib/store.js：账号 Cookie 落盘前 encrypt，读取时按 isEncrypted 判断后 decrypt
 * - lib/auth.js：Web 面板的 6 位验证码（randomCode + hashCode + safeEqual）与会话 token
 * - lib/remote.js：抖音弹验证时远程操作链接的 token（randomToken）
 *
 * 只依赖 node:crypto 与 util.js 的路径常量，不读配置 —— 密钥不走配置系统，见 loadKey。
 */
import crypto from "node:crypto"
import fs from "node:fs"
import path from "node:path"
import { dataDir, ensureDir, log } from "./util.js"

const keyPath = path.join(dataDir, "secret.key")
const ALGO = "aes-256-gcm"

/** 进程内缓存的 32 字节主密钥，避免每次加解密都读盘 */
let cachedKey = null

/**
 * 取主密钥：data/secret.key（已 gitignore），首次运行自动生成 32 字节随机值并以 base64 存放。
 *
 * 不用配置文件里的口令派生：口令会被锅巴面板显示出来，而密钥文件不会。
 *
 * 长度不是 32 字节时视为文件损坏，直接重新生成 —— 此时旧密文再也解不开，
 * 所以只警告不静默处理，让用户知道要重新登录。
 *
 * 落盘既传 mode 又显式 chmod：writeFileSync 的 mode 只在新建文件时生效且受 umask 影响，
 * 覆盖已存在的文件不会改权限。chmod 在 Windows 上基本无效，因此包 try/catch。
 */
function loadKey() {
  if (cachedKey) return cachedKey
  ensureDir(dataDir)
  if (fs.existsSync(keyPath)) {
    const raw = fs.readFileSync(keyPath, "utf8").trim()
    const buf = Buffer.from(raw, "base64")
    if (buf.length === 32) {
      cachedKey = buf
      return cachedKey
    }
    log("warn", "secret.key 长度异常，已重新生成（原有加密数据将无法解密）")
  }
  cachedKey = crypto.randomBytes(32)
  fs.writeFileSync(keyPath, cachedKey.toString("base64"), { encoding: "utf8", mode: 0o600 })
  try {
    fs.chmodSync(keyPath, 0o600)
  } catch {}
  log("info", "已生成新的加密密钥 data/secret.key，请勿提交或外传")
  return cachedKey
}

/**
 * 加密任意字符串。
 *
 * 输出 `v1.<iv>.<tag>.<cipher>`，后三段均为 base64。用 `.` 作分隔符是安全的：
 * base64 字母表只含 A-Za-z0-9+/=，不会产生 `.`。版本前缀留着是为了将来换算法时
 * 能识别旧数据。
 *
 * @param {*} plain 非字符串先 String() 转换，null/undefined 视为空串
 * @returns {string} 每次调用 iv 都重新随机，同一明文两次加密结果不同
 */
export function encrypt(plain) {
  const iv = crypto.randomBytes(12)
  const cipher = crypto.createCipheriv(ALGO, loadKey(), iv)
  const enc = Buffer.concat([cipher.update(String(plain ?? ""), "utf8"), cipher.final()])
  // getAuthTag 必须在 final() 之后取，否则 GCM 标签还没生成
  return ["v1", iv.toString("base64"), cipher.getAuthTag().toString("base64"), enc.toString("base64")].join(".")
}

/**
 * 解密。
 *
 * @param {string} payload encrypt 的输出
 * @returns {string} utf8 明文
 * @throws {Error} 段数或版本前缀不对时抛 "加密数据格式不正确"；密钥换过、密文或
 *   authTag 被改动时由 decipher.final() 抛 GCM 校验失败。两种都由调用方降级成
 *   「凭证失效」，见 lib/store.js 的 cookies()
 */
export function decrypt(payload) {
  const parts = String(payload ?? "").split(".")
  if (parts.length !== 4 || parts[0] !== "v1") throw new Error("加密数据格式不正确")
  const [, iv, tag, data] = parts
  const decipher = crypto.createDecipheriv(ALGO, loadKey(), Buffer.from(iv, "base64"))
  decipher.setAuthTag(Buffer.from(tag, "base64"))
  return Buffer.concat([decipher.update(Buffer.from(data, "base64")), decipher.final()]).toString("utf8")
}

/**
 * 只判断外形是否像本模块的密文，不校验能否解开。
 * 用于区分「已加密」与「历史遗留的明文 Cookie」，见 lib/store.js:375。
 */
export function isEncrypted(value) {
  return typeof value === "string" && value.startsWith("v1.") && value.split(".").length === 4
}

/**
 * 一次性验证码：只用大写字母数字，去掉易混的 0O1IL，方便手输。
 *
 * 字母表 31 个字符，`bytes[i] % 31` 存在轻微模偏：256 = 8×31 + 8，前 8 个字符
 * （A-H）的出现概率是 9/256，其余是 8/256。
 */
export function randomCode(length = 6) {
  const alphabet = "ABCDEFGHJKMNPQRSTUVWXYZ23456789"
  const bytes = crypto.randomBytes(length)
  let out = ""
  for (let i = 0; i < length; i++) out += alphabet[bytes[i] % alphabet.length]
  return out
}

/**
 * 会话 token / 一次性 id，统一走 CSPRNG。
 * @param {number} [bytes=32] 随机字节数，返回的十六进制串长度是它的两倍
 */
export function randomToken(bytes = 32) {
  return crypto.randomBytes(bytes).toString("hex")
}

/**
 * 定长常量时间比较，避免计时侧信道。
 *
 * timingSafeEqual 要求两段等长，长度不同直接返回 false —— 这一步本身会泄漏长度差异，
 * 所以调用方比较的是等长的 sha256 十六进制串而不是验证码原文，见 lib/auth.js:130-133。
 */
export function safeEqual(a, b) {
  const bufA = Buffer.from(String(a ?? ""), "utf8")
  const bufB = Buffer.from(String(b ?? ""), "utf8")
  if (bufA.length !== bufB.length) return false
  return crypto.timingSafeEqual(bufA, bufB)
}

/**
 * 验证码不存明文，存 sha256，日志与内存 dump 都拿不到原码。
 * 同时也是 lib/auth.js 里验证码 Map 的键，长度固定 64，正好满足 safeEqual 的等长前提。
 */
export function hashCode(code) {
  return crypto.createHash("sha256").update(String(code ?? ""), "utf8").digest("hex")
}
