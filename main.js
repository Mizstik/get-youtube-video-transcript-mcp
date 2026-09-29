import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js"
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js'
import { z } from "zod"
import { execFile } from "child_process"
import { promisify } from "util"
const execFileAsync = promisify(execFile)

import path from "path"
import { fileURLToPath } from 'url'
import os from "os"
import crypto from "crypto"
import fs from "fs/promises"
import http from "http"

// ── Configuration (defaults, overridable via CLI) ────────────────────────────
const config = {
  name: "Get Youtube Video Title and Subtitle",
  version: "1.4.0",
  defaultPort: 12001,
  chunkSizeBytes: 15000,      // max bytes per stdio chunk (~15 KB)
  cacheTtlMs: 10 * 60 * 1000, // 10 minutes
}

// ── Runtime constants (derived from CLI args) ────────────────────────────────
const __dirname = path.dirname(fileURLToPath(import.meta.url))
const ytDlpPath = path.join(__dirname, os.platform() === 'win32' ? 'yt-dlp.exe' : 'yt-dlp')

const YOUTUBE_VIDEO_ID_REGEX = /^[a-zA-Z0-9_-]{11}$/
const VALID_SORT_OPTIONS = ['top', 'newest']
const VALID_LANG_CODES = /^[a-zA-Z]{2,3}(-[a-zA-Z]{2,3})?$/

// ── CLI argument parsing ─────────────────────────────────────────────────────
const args = process.argv.slice(2)
const mode = args.includes('--http') ? 'http' : 'stdio'
const portMatch = args.find(arg => arg.startsWith('--port='))
const port = portMatch ? parseInt(portMatch.split('=')[1], 10) : config.defaultPort

// Extract --chunk-size=N (bytes). Accepts plain number or suffix (KB/MB).
let cliChunkSize = null
const chunkSizeMatch = args.find(arg => arg.startsWith('--chunk-size='))
if (chunkSizeMatch) {
  const raw = chunkSizeMatch.split('=')[1].trim().toUpperCase()
  const multiplier = raw.endsWith('KB') ? 1024 : raw.endsWith('MB') ? 1024 * 1024 : 1
  cliChunkSize = parseInt(raw.replace(/KB|MB$/, ''), 10) * multiplier
}
const CHUNK_SIZE = cliChunkSize ?? config.chunkSizeBytes

// Extract cookies-from-browser option for yt-dlp
let ytdlpCookiesFromBrowser = null
const cookiesMatch = args.find(arg => arg.startsWith('--cookies-from-browser='))
if (cookiesMatch) {
  ytdlpCookiesFromBrowser = cookiesMatch.split('=')[1]
} else if (args.includes('--cookies-from-browser')) {
  const idx = args.indexOf('--cookies-from-browser')
  if (idx + 1 < args.length) {
    ytdlpCookiesFromBrowser = args[idx + 1]
  }
}

// ── Cache helpers ────────────────────────────────────────────────────────────
const CACHE_DIR = path.join(__dirname, '.cache')

async function ensureCacheDir() {
  try { await fs.mkdir(CACHE_DIR, { recursive: true }) } catch (_) { /* ignore */ }
}

function getCachePath(video_id, lang) {
  const safeLang = lang.replace(/[^a-zA-Z0-9_-]/g, '_')
  return path.join(CACHE_DIR, `${video_id}_${safeLang}.json`)
}

async function readCache(cachePath) {
  try {
    const data = await fs.readFile(cachePath, 'utf-8')
    const parsed = JSON.parse(data)
    if (Date.now() - parsed.timestamp > config.cacheTtlMs) {
      await fs.unlink(cachePath)
      return null
    }
    return parsed
  } catch (_) { return null }
}

async function writeCache(cachePath, text) {
  await fs.writeFile(cachePath, JSON.stringify({ text, timestamp: Date.now() }))
}

async function cleanCache() {
  await ensureCacheDir()
  try {
    const files = await fs.readdir(CACHE_DIR)
    for (const file of files) {
      const fp = path.join(CACHE_DIR, file)
      try {
        const stat = await fs.stat(fp)
        if (Date.now() - stat.mtimeMs > config.cacheTtlMs) {
          await fs.unlink(fp)
        }
      } catch (_) { /* skip */ }
    }
  } catch (_) { /* skip */ }
}

// ── Temp directory per yt-dlp call (avoids race conditions & dir pollution) ──
async function createTempDir(video_id) {
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'yt-transcript-'))
  return {
    dir: tmp,
    cleanup: async () => { try { await fs.rm(tmp, { recursive: true, force: true }) } catch (_) {} },
  }
}

// ── Chunking helpers ─────────────────────────────────────────────────────────
function splitIntoChunks(text, title) {
  const prefix = (n, total) => `--- Part ${n}/${total} (video: ${title}) ---\n`
  const chunks = []
  let remaining = text

  const estimatedTotal = Math.max(1, Math.ceil(text.length / CHUNK_SIZE))

  let i = 1
  while (remaining.length > 0) {
    const p = prefix(i, estimatedTotal)
    const available = CHUNK_SIZE - Buffer.byteLength(p)
    if (remaining.length <= available) {
      chunks.push(p + remaining)
      remaining = ''
    } else {
      let cut = available
      while (cut > 0 && remaining[cut] !== ' ' && remaining[cut] !== '\n') {
        cut--
      }
      if (cut === 0) cut = available
      chunks.push(p + remaining.slice(0, cut))
      remaining = remaining.slice(cut).trimStart()
    }
    i++
  }

  // Fix prefixes if estimate was wrong
  if (estimatedTotal !== chunks.length) {
    for (let c = 0; c < chunks.length; c++) {
      const oldPrefix = `--- Part ${c + 1}/${estimatedTotal}`
      const newPrefix = `--- Part ${c + 1}/${chunks.length}`
      chunks[c] = chunks[c].replace(oldPrefix, newPrefix)
    }
  }

  return chunks
}

function formatBytes(bytes) {
  if (bytes === 0) return '0 B'
  const k = 1024
  const sizes = ['B', 'KB', 'MB', 'GB']
  const i = Math.floor(Math.log(bytes) / Math.log(k))
  return parseFloat((bytes / Math.pow(k, i)).toFixed(1)) + ' ' + sizes[i]
}

// ── LRC parser that preserves timestamps and newlines ────────────────────────
function parseLrcToTimestampedText(lrcContent) {
  const lines = lrcContent.split('\n')
  const result = []
  const seenText = new Set()

  for (const line of lines) {
    const trimmed = line.trim()
    if (!trimmed) continue

    // Extract timestamp from [MM:SS.xx] or similar, then the text
    const tsMatch = trimmed.match(/^\[(\d+):(\d+)\.?\d*\](.*)/)
    if (tsMatch) {
      const minutes = parseInt(tsMatch[1], 10)
      const seconds = parseInt(tsMatch[2], 10)
      const textPart = tsMatch[3].trim()

      // Format timestamp as [M:SS] or [MM:SS]
      const displayMin = minutes < 10 ? String(minutes) : String(minutes).padStart(2, '0')
      const displaySec = seconds < 10 ? `0${seconds}` : String(seconds)
      const tsStr = `[${displayMin}:${displaySec}]`

      // Deduplicate by text content only (auto-captions often repeat with tiny timing diffs)
      if (!seenText.has(textPart)) {
        seenText.add(textPart)
        result.push(`${tsStr} ${textPart}`)
      }
    } else if (!trimmed.startsWith('title:')) {
      // Lines without timestamp (e.g. title line or stray content) — keep as-is
      result.push(trimmed)
    }
  }

  return result.join('\n')
}

// ── MCP server ───────────────────────────────────────────────────────────────
const server = new McpServer({
  name: config.name,
  version: config.version,
})

server.registerTool(
  "get-youtube-video-transcript-and-title",
  {
    title: "Get Youtube Video Transcript and Title",
    description: `Get transcript with timestamps and title from a youtube video. In stdio mode, responses longer than ${Math.round(CHUNK_SIZE / 1024)} KB are split into chunks. If the response starts with '--- Part 1/', call this tool again with chunk=2, chunk=3, etc. to get the remaining parts.`,
    inputSchema: {
      video_id: z.string().regex(YOUTUBE_VIDEO_ID_REGEX, "Invalid YouTube video ID format"),
      lang: z.string().regex(VALID_LANG_CODES, "Invalid language code format"),
      chunk: z.number().int().min(1).optional().default(1)
    }
  },
  async ({video_id, lang, chunk}) => {
    if (mode === 'stdio') {
      return await handle_chunked_subtitle(video_id, lang, chunk)
    }
    return {
      content: [{
        type: "text",
        text: await fetch_subtitle(video_id, lang)
      }]
    }
  }
)

async function handle_chunked_subtitle(video_id, lang, chunk) {
  await ensureCacheDir()
  const cachePath = getCachePath(video_id, lang)

  // Try cache first
  let cached = await readCache(cachePath)
  if (cached) {
    const fullText = cached.text
    if (fullText.length <= CHUNK_SIZE) {
      return { content: [{ type: "text", text: fullText }] }
    }
    const chunks = splitIntoChunks(fullText, video_id)
    if (chunk > chunks.length) {
      return { content: [{ type: "text", text: `Chunk ${chunk} out of range (1-${chunks.length} available).` }] }
    }
    return { content: [{ type: "text", text: chunks[chunk - 1] }] }
  }

  // Not cached — fetch full transcript
  const fullText = await fetch_subtitle(video_id, lang)

  // Don't cache errors
  if (fullText.startsWith("Error") || fullText === "No transcript available.") {
    return { content: [{ type: "text", text: fullText }] }
  }

  // Store in cache
  await writeCache(cachePath, fullText)

  // If short enough, return as-is
  if (fullText.length <= CHUNK_SIZE) {
    return { content: [{ type: "text", text: fullText }] }
  }

  // Split and return requested chunk
  const chunks = splitIntoChunks(fullText, video_id)
  if (chunk > chunks.length) {
    return { content: [{ type: "text", text: `Chunk ${chunk} out of range (1-${chunks.length} available).` }] }
  }
  return { content: [{ type: "text", text: chunks[chunk - 1] }] }
}

async function fetch_subtitle(video_id, lang = "en") {
  const tempDir = await createTempDir(video_id)

  try {
    const safeOutputPath = path.join(tempDir.dir, '%(id)s.%(ext)s')

    const ytdlpArgs = [
      '--skip-download',
      '--write-subs',
      '--write-auto-subs',
      '--sub-langs', lang,
      '--convert-subs', 'lrc',
      '-o', safeOutputPath,
    ]
    if (ytdlpCookiesFromBrowser) {
      ytdlpArgs.push('--cookies-from-browser', ytdlpCookiesFromBrowser)
    }
    ytdlpArgs.push('--', video_id)

    try {
      await execFileAsync(ytDlpPath, ytdlpArgs, { maxBuffer: 10 * 1024 * 1024 })
    } catch (err) {
      // Suppress stderr by default — yt-dlp emits warnings that aren't actionable
      return "Error fetching subtitle: " + (err.message || 'Unknown error occurred')
    }

    const files = await fs.readdir(tempDir.dir)
    const lrcFile = files.find(file => file.endsWith('.lrc'))
    if (!lrcFile) return "No transcript available."

    try {
      const videoTitle = await fetch_title(video_id)
      let subtitleContent = await fs.readFile(path.join(tempDir.dir, lrcFile), 'utf-8')

      // Preserve timestamps and newlines instead of flattening to a single line
      const timestampedText = parseLrcToTimestampedText(subtitleContent)
      return `title: ${videoTitle}\n\n${timestampedText}`
    } catch (err) {
      return "Error reading subtitle: " + (err.message || 'Unknown error occurred')
    }
  } finally {
    await tempDir.cleanup()
  }
}

server.registerTool(
  "get-youtube-video-comments",
  {
    title: "Get Youtube Video Comments",
    description: "Get comments from a youtube video",
    inputSchema: {
      video_id: z.string().regex(YOUTUBE_VIDEO_ID_REGEX, "Invalid YouTube video ID format"),
      sortby: z.enum(VALID_SORT_OPTIONS, "sortby must be 'top' or 'newest'"),
      max_comments: z.number().int().min(1).max(1000, "max_comments must not exceed 1000")
    }
  },
  async ({video_id, sortby, max_comments}) => ({
    content: [{
      type: "text",
      text: await fetch_comments(video_id, sortby, max_comments)
    }]
  })
)

async function fetch_comments(video_id, sortby = "top", max_comments = 30) {
  const tempDir = await createTempDir(video_id)

  try {
    const ytdlpArgs = [
      '--skip-download',
      '--write-comments',
      '--print', 'comments',
      '--extractor-args', `youtube:comment_sort=${sortby};max_comments=${max_comments}`,
    ]
    if (ytdlpCookiesFromBrowser) {
      ytdlpArgs.push('--cookies-from-browser', ytdlpCookiesFromBrowser)
    }
    ytdlpArgs.push('--', video_id)

    try {
      const { stdout } = await execFileAsync(ytDlpPath, ytdlpArgs, { maxBuffer: 10 * 1024 * 1024 })
      const trimmed = stdout.trim()
      return trimmed || "No comments available."
    } catch (err) {
      // Suppress stderr by default
      return "Error fetching comments: " + (err.message || 'Unknown error occurred')
    }
  } finally {
    await tempDir.cleanup()
  }
}

server.registerTool(
  "get-youtube-video-title-only",
  {
    title: "Get Youtube Video Title",
    description: "Get the title of a youtube video",
    inputSchema: {
      video_id: z.string().regex(YOUTUBE_VIDEO_ID_REGEX, "Invalid YouTube video ID format")
    }
  },
  async ({video_id}) => ({
    content: [{
      type: "text",
      text: await fetch_title(video_id)
    }]
  })
)

async function fetch_title(video_id) {
  const ytdlpArgs = ['--get-title']
  if (ytdlpCookiesFromBrowser) {
    ytdlpArgs.push('--cookies-from-browser', ytdlpCookiesFromBrowser)
  }
  ytdlpArgs.push('--', video_id)

  try {
    const { stdout } = await execFileAsync(ytDlpPath, ytdlpArgs, { maxBuffer: 10 * 1024 * 1024 })
    return stdout.trim()
  } catch (err) {
    // Suppress stderr by default
    return "Error fetching title: " + (err.message || 'Unknown error occurred')
  }
}

server.registerTool(
  "update-yt-dlp",
  {
    title: "Update yt-dlp",
    description: "Update the underlying yt-dlp executable.",
  },
  async () => ({
    content: [{
      type: "text",
      text: await update_ytdlp()
    }]
  })
)

async function update_ytdlp() {
  const args = ['--update']

  try {
    const { stdout } = await execFileAsync(ytDlpPath, args, { maxBuffer: 10 * 1024 * 1024 })
    return stdout.trim()
  } catch (err) {
    return "Update failed: " + (err.message || 'Unknown error occurred')
  }
}

server.registerTool(
  "initialize-yt-dlp",
  {
    title: "Initialize yt-dlp",
    description: "Download the yt-dlp executable during first use.",
  },
  async () => ({
    content: [{
      type: "text",
      text: await initialize_ytdlp()
    }]
  })
)

async function initialize_ytdlp() {
  const filename = os.platform() === 'win32' ? 'yt-dlp.exe' : 'yt-dlp'
  const url = `https://github.com/yt-dlp/yt-dlp/releases/latest/download/${filename}`
  const response = await fetch(url)

  if (!response.ok) {
    throw new Error(`Failed to download yt-dlp: ${response.status} ${response.statusText}`)
  }

  const buffer = Buffer.from(await response.arrayBuffer())
  await fs.writeFile(ytDlpPath, buffer)

  if (os.platform() !== 'win32') {
    await fs.chmod(ytDlpPath, 0o755)
  }

  return `Downloaded ${filename} to ${ytDlpPath}`
}

// ── Stdio transport ──────────────────────────────────────────────────────────
async function serve_stdio() {
  await cleanCache()
  const transport = new StdioServerTransport()
  server.connect(transport)
}

// ── HTTP transport ───────────────────────────────────────────────────────────
let activeHttpServer = null

function serve_http(port) {
  const transport = new StreamableHTTPServerTransport({
    sessionIdGenerator: () => crypto.randomUUID(),
    enableJsonResponse: true,
  })

  const httpServer = http.createServer(async (req, res) => {
    const timestamp = new Date().toISOString()
    if (req.url === '/mcp' || req.url === '/mcp/') {
      let parsedBody
      if (['POST', 'PUT'].includes(req.method)) {
        parsedBody = await parseBody(req)
      }
      if (parsedBody) {
        const { method, params } = parsedBody
        if (params && Object.keys(params).length > 0) {
          const paramStr = Object.entries(params).map(([k, v]) => `${k}: ${typeof v === 'object' ? JSON.stringify(v) : String(v)}`).join(', ')
          console.log(`${timestamp} ${method} {${paramStr}}`)
        } else {
          console.log(`${timestamp} ${method} (no params)`)
        }
      } else {
        console.log(`${timestamp} ${req.method} ${req.url}`)
      }
      const originalEnd = res.end.bind(res)
      res.end = function (chunk, ...args) {
        if (chunk) {
          const size = Buffer.isBuffer(chunk) ? chunk.byteLength : Buffer.byteLength(chunk)
          console.log(`Response size: ${formatBytes(size)}`)
        }
        return originalEnd(chunk, ...args)
      }
      await transport.handleRequest(req, res, parsedBody)
    } else {
      console.log(`${timestamp} ${req.method} ${req.url}`)
      res.writeHead(404, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({ error: 'Not found' }))
    }
  })

  server.connect(transport)

  httpServer.listen(port, () => {
    console.log('MCP server listening on port ' + port)
  })

  activeHttpServer = httpServer
}

function parseBody(req) {
  return new Promise((resolve, reject) => {
    let data = ''
    req.on('data', chunk => { data += chunk })
    req.on('end', () => {
      try {
        resolve(data ? JSON.parse(data) : undefined)
      } catch (e) {
        reject(e)
      }
    })
    req.on('error', reject)
  })
}

// ── Graceful shutdown ────────────────────────────────────────────────────────
function gracefulShutdown() {
  console.log('\nShutting down...')
  if (activeHttpServer) {
    activeHttpServer.close(() => {
      console.log('HTTP server closed.')
      process.exit(0)
    })
    // Force close after 5 seconds
    setTimeout(() => process.exit(0), 5000)
  } else {
    process.exit(0)
  }
}

process.on('SIGINT', gracefulShutdown)
process.on('SIGTERM', gracefulShutdown)

// ── Start server ─────────────────────────────────────────────────────────────
if (mode === 'http') {
  serve_http(port)
} else {
  serve_stdio()
}
