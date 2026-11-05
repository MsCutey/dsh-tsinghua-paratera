import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

/**
 * 从本机浏览器的 Local Storage 里捞出控制台 token。
 *
 * 背景：并行智算云走清华统一身份认证（SSO），插件没法也不该替用户登录；
 * 而控制台 token 只存在浏览器 localStorage 的 `PARA_TOKEN` 里，1 小时过期。
 *
 * 但 Chrome/Edge 的 localStorage 是 LevelDB，键值对以明文（或 snappy 压缩块）落盘：
 * 键形如 `_https://ai.paratera.com\0\1PARA_TOKEN`，值紧跟其后是一段 JWT。
 * 于是「用户平时在浏览器里用控制台」这件事，本身就等于在持续刷新 token——
 * 插件只要定时把这些文件读一遍，取最新的、未过期的那个即可。
 */

const ORIGIN_KEY = '_https://ai.paratera.com\u0000\u0001PARA_TOKEN'

const BROWSER_ROOTS = [
  ['Chrome', path.join(os.homedir(), 'AppData', 'Local', 'Google', 'Chrome', 'User Data')],
  ['Chrome Beta', path.join(os.homedir(), 'AppData', 'Local', 'Google', 'Chrome Beta', 'User Data')],
  ['Edge', path.join(os.homedir(), 'AppData', 'Local', 'Microsoft', 'Edge', 'User Data')],
  ['Brave', path.join(os.homedir(), 'AppData', 'Local', 'BraveSoftware', 'Brave-Browser', 'User Data')],
  ['Chromium', path.join(os.homedir(), 'AppData', 'Local', 'Chromium', 'User Data')],
]

const JWT_RE = /eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}/g

/** 文件 -> { size, mtime, token }：未变化的文件不再重复读取。 */
const FILE_CACHE = new Map()
const MAX_FILE_BYTES = 16 * 1024 * 1024

function decodePayload(jwt) {
  try {
    const part = jwt.split('.')[1]
    if (!part) return null
    const json = JSON.parse(Buffer.from(part, 'base64url').toString('utf8'))
    return json && typeof json === 'object' ? json : null
  } catch (err) {
    return null
  }
}

function listProfiles(root) {
  try {
    return fs
      .readdirSync(root, { withFileTypes: true })
      .filter((entry) => entry.isDirectory() && (entry.name === 'Default' || entry.name.startsWith('Profile ')))
      .map((entry) => path.join(root, entry.name, 'Local Storage', 'leveldb'))
      .filter((dir) => {
        try {
          return fs.statSync(dir).isDirectory()
        } catch (err) {
          return false
        }
      })
  } catch (err) {
    return []
  }
}

function recentFiles(dir, limit) {
  try {
    return fs
      .readdirSync(dir)
      .filter((name) => name.endsWith('.log') || name.endsWith('.ldb'))
      .map((name) => {
        const full = path.join(dir, name)
        let stat = null
        try {
          stat = fs.statSync(full)
        } catch (err) {
          return null
        }
        return { full, mtime: stat.mtimeMs, size: stat.size }
      })
      .filter(Boolean)
      .sort((a, b) => b.mtime - a.mtime)
      .slice(0, limit)
  } catch (err) {
    return []
  }
}

function pickNewest(found) {
  let best = null
  for (const candidate of found) {
    if (!best || candidate.iat > best.iat) best = candidate
  }
  return best
}

/**
 * 扫描所有浏览器 profile，返回最新的、仍在有效期内的控制台 token。
 * @param {{ now?: number, maxAgeMs?: number, maxFiles?: number }} [options]
 * @returns {{ token: string, iat: number, exp: number, browser: string, file: string } | null}
 */
export function harvestToken(options = {}) {
  const now = Number.isFinite(options.now) ? options.now : Date.now()
  // 平台对 exp 的校验并不严格（实测过期后仍可用），所以只按「太老」过滤，避免误杀
  const maxAgeMs = Number.isFinite(options.maxAgeMs) ? options.maxAgeMs : 7 * 24 * 3600 * 1000
  const maxFiles = Number.isFinite(options.maxFiles) ? options.maxFiles : 24
  const found = []

  for (const [browser, root] of BROWSER_ROOTS) {
    for (const dir of listProfiles(root)) {
      for (const file of recentFiles(dir, maxFiles)) {
        if (file.size > MAX_FILE_BYTES) continue
        const memo = FILE_CACHE.get(file.full)
        if (memo && memo.size === file.size && memo.mtime === file.mtime) {
          if (memo.token) found.push(memo.token)
          continue
        }
        let text = ''
        try {
          text = fs.readFileSync(file.full, { encoding: 'latin1' })
        } catch (err) {
          continue // 浏览器正占用该文件时跳过
        }
        const at = text.indexOf(ORIGIN_KEY)
        if (at === -1) {
          FILE_CACHE.set(file.full, { size: file.size, mtime: file.mtime, token: null })
          continue
        }
        const window = text.slice(at, at + 4096)
        const match = window.match(JWT_RE)
        if (!match) continue
        const payload = decodePayload(match[0])
        if (!payload || !Number.isFinite(payload.exp) || !Number.isFinite(payload.iat)) continue
        if (payload.exp * 1000 <= now - maxAgeMs) continue
        const entry = {
          token: match[0],
          iat: payload.iat,
          exp: payload.exp,
          browser,
          file: file.full,
        }
        FILE_CACHE.set(file.full, { size: file.size, mtime: file.mtime, token: entry })
        found.push(entry)
      }
    }
  }

  return pickNewest(found)
}

/** 解析一个 JWT 的 payload（给手工 token 兜底用）。 */
export function describeToken(token) {
  const payload = decodePayload(String(token || ''))
  if (!payload) return null
  return {
    sub: payload.sub,
    iat: Number.isFinite(payload.iat) ? payload.iat : null,
    exp: Number.isFinite(payload.exp) ? payload.exp : null,
  }
}
