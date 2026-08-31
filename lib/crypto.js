import crypto from "node:crypto"
import fs from "node:fs"
import path from "node:path"
import { dataDir, ensureDir, log } from "./util.js"

const keyPath = path.join(dataDir, "secret.key")
const ALGO = "aes-256-gcm"

let cachedKey = null

/**
 * 主密钥落在 data/secret.key（已 gitignore），首次运行自动生成。
 * 不用配置文件里的口令派生：口令会被锅巴面板显示出来，而密钥文件不会。
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

/** 加密任意字符串，输出 v1.<iv>.<tag>.<cipher>，全部 base64 */
export function encrypt(plain) {
  const iv = crypto.randomBytes(12)
  const cipher = crypto.createCipheriv(ALGO, loadKey(), iv)
  const enc = Buffer.concat([cipher.update(String(plain ?? ""), "utf8"), cipher.final()])
  return ["v1", iv.toString("base64"), cipher.getAuthTag().toString("base64"), enc.toString("base64")].join(".")
}

/** 解密；密钥换过或内容被改动时抛错，由调用方降级成「凭证失效」 */
export function decrypt(payload) {
  const parts = String(payload ?? "").split(".")
  if (parts.length !== 4 || parts[0] !== "v1") throw new Error("加密数据格式不正确")
  const [, iv, tag, data] = parts
  const decipher = crypto.createDecipheriv(ALGO, loadKey(), Buffer.from(iv, "base64"))
  decipher.setAuthTag(Buffer.from(tag, "base64"))
  return Buffer.concat([decipher.update(Buffer.from(data, "base64")), decipher.final()]).toString("utf8")
}

export function isEncrypted(value) {
  return typeof value === "string" && value.startsWith("v1.") && value.split(".").length === 4
}

/** 一次性验证码：只用大写字母数字，去掉易混的 0O1IL，方便手输 */
export function randomCode(length = 6) {
  const alphabet = "ABCDEFGHJKMNPQRSTUVWXYZ23456789"
  const bytes = crypto.randomBytes(length)
  let out = ""
  for (let i = 0; i < length; i++) out += alphabet[bytes[i] % alphabet.length]
  return out
}

/** 会话 token / 一次性 id，统一走 CSPRNG */
export function randomToken(bytes = 32) {
  return crypto.randomBytes(bytes).toString("hex")
}

/** 验证码与 token 比较一律定长比对，避免计时侧信道 */
export function safeEqual(a, b) {
  const bufA = Buffer.from(String(a ?? ""), "utf8")
  const bufB = Buffer.from(String(b ?? ""), "utf8")
  if (bufA.length !== bufB.length) return false
  return crypto.timingSafeEqual(bufA, bufB)
}

/** 验证码不存明文，存 sha256，日志与内存 dump 都拿不到原码 */
export function hashCode(code) {
  return crypto.createHash("sha256").update(String(code ?? ""), "utf8").digest("hex")
}
