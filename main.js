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
const __dirname = path.dirname(fileURLToPath(import.meta.url))
const ytDlpPath = path.join(__dirname, os.platform() === 'win32' ? 'yt-dlp.exe' : 'yt-dlp')

import fs from "fs/promises"
import http from "http"

const YOUTUBE_VIDEO_ID_REGEX = /^[a-zA-Z0-9_-]{11}$/
const VALID_SORT_OPTIONS = ['top', 'newest']
const VALID_LANG_CODES = /^[a-zA-Z]{2,3}(-[a-zA-Z]{2,3})?$/

// Stdio chunking constants
const CACHE_DIR = path.join(__dirname, '.cache')
const CACHE_TTL_MS = 10 * 60 * 1000  // 10 minutes
const MAX_CHUNK_SIZE = 25 * 1024     // 25 KB raw text

async function ensureCacheDir() {
  try {
    await fs.mkdir(CACHE_DIR, { recursive: true })
  } catch (_) { /* ignore */ }
}

function getCachePath(video_id, lang) {
  // Sanitize lang for filename
  const safeLang = lang.replace(/[^a-zA-Z0-9_-]/g, '_')
  return path.join(CACHE_DIR, `${video_id}_${safeLang}.json`)
}

async function readCache(cachePath) {
  try {
    const data = await fs.readFile(cachePath, 'utf-8')
    const parsed = JSON.parse(data)
    if (Date.now() - parsed.timestamp > CACHE_TTL_MS) {
      await fs.unlink(cachePath)
      return null
    }
    return parsed
  } catch (_) {
    return null
  }
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
        if (Date.now() - stat.mtimeMs > CACHE_TTL_MS) {
          await fs.unlink(fp)
        }
      } catch (_) { /* skip */ }
    }
  } catch (_) { /* skip */ }
}

function splitIntoChunks(text, title) {
  const prefix = (n, total) => `--- Part ${n}/${total} (video: ${title}) ---\n`
  const chunks = []
  let remaining = text

  // Estimate total chunks
  const estimatedTotal = Math.max(1, Math.ceil(text.length / MAX_CHUNK_SIZE))

  let i = 1
  while (remaining.length > 0) {
    const p = prefix(i, estimatedTotal)
    const available = MAX_CHUNK_SIZE - Buffer.byteLength(p)
    if (remaining.length <= available) {
      chunks.push(p + remaining)
      remaining = ''
    } else {
      // Find a good split point within budget
      let cut = available
      // Try to split at a space to avoid cutting mid-word
      while (cut > 0 && remaining[cut] !== ' ' && remaining[cut] !== '\n') {
        cut--
      }
      if (cut === 0) cut = available // force split if no space found
      chunks.push(p + remaining.slice(0, cut))
      remaining = remaining.slice(cut).trimStart()
    }
    i++
  }

  // If we estimated wrong, fix the prefixes
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

const server = new McpServer({
  name: "Get Youtube Video Title and Subtitle",
  version: "1.3.0"
})

server.registerTool(
  "get-youtube-video-transcript-and-title",
  {
    title: "Get Youtube Video Transcript and Title",
    description: "Get transcript and title from a youtube video. In stdio mode, responses longer than 25 KB are split into chunks. If the response starts with '--- Part 1/', call this tool again with chunk=2, chunk=3, etc. to get the remaining parts.",
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
    if (fullText.length <= MAX_CHUNK_SIZE) {
      return { content: [{ type: "text", text: fullText }] }
    }
    const chunks = splitIntoChunks(fullText, video_id)
    if (chunk > chunks.length) {
      return { content: [{ type: "text", text: `Chunk ${chunk} out of range (1–${chunks.length} available).` }] }
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
  if (fullText.length <= MAX_CHUNK_SIZE) {
    return { content: [{ type: "text", text: fullText }] }
  }

  // Split and return requested chunk
  const chunks = splitIntoChunks(fullText, video_id)
  if (chunk > chunks.length) {
    return { content: [{ type: "text", text: `Chunk ${chunk} out of range (1–${chunks.length} available).` }] }
  }
  return { content: [{ type: "text", text: chunks[chunk - 1] }] }
}

async function fetch_subtitle(video_id, lang="en") {
  const outputDir = __dirname
  const safeOutputPath = path.join(outputDir, '%(id)s.%(ext)s')

  const args = [
    '--skip-download',
    '--write-subs',
    '--write-auto-subs',
    '--sub-langs', lang,
    '--convert-subs', 'lrc',
    '-o', safeOutputPath,
    video_id
  ]

  try {
    await execFileAsync(ytDlpPath, args, { maxBuffer: 10 * 1024 * 1024 })
  } catch (err) {
    if (err.stderr) {
      console.error('yt-dlp stderr:', err.stderr)
    }
    return "Error fetching subtitle: " + (err.message || 'Unknown error occurred')
  }

  const files = await fs.readdir(outputDir)
  const lrcFile = files.find(file => file.endsWith('.lrc'))
  if (!lrcFile) return "No transcript available."

  try {
    const videoTitle = await fetch_title(video_id)
    let subtitleContent = await fs.readFile(path.join(outputDir, lrcFile), 'utf-8')
    subtitleContent = subtitleContent.replace(/\\h/g, '').replace(/>> /g, '')
    let lines = subtitleContent.split('\n')

    let seen = new Set()
    let final = []
    final.push("title: " + videoTitle + "\n\n")

    lines.forEach((line) => {
      let text = line.split("]", 2)[1]
      if (!seen.has(text)) {
        seen.add(text)
        final.push(line)
      }
    })

    await fs.unlink(path.join(outputDir, lrcFile))
    return final.join(' ')
  } catch (err) {
    return "Error reading subtitle: " + (err.message || 'Unknown error occurred')
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

async function fetch_comments(video_id, sortby="top", max_comments=50) {
  const args = [
    '--skip-download',
    '--write-comments',
    '--dump-json',
    '--extractor-args', `youtube:comment_sort=${sortby};max_comments=${max_comments}`,
    video_id
  ]

  try {
    const { stdout } = await execFileAsync(ytDlpPath, args, { maxBuffer: 10 * 1024 * 1024 })
    const trimmed = stdout.trim()
    if (!trimmed) {
      return "No comments available."
    }

    let jsondump
    try {
      jsondump = JSON.parse(trimmed)
    } catch (parseErr) {
      return "Error parsing comments JSON: Invalid response from yt-dlp"
    }

    const commentBlock = jsondump.comments
    if (!commentBlock || !Array.isArray(commentBlock)) {
      return "No comments available."
    }

    let commentParsed = ""
    commentBlock.forEach(function (item) {
      commentParsed += (item.author || 'Unknown') + "\n" + (item.text || '') + "\n" + (item.like_count || 0) + " likes\n"
    })

    return commentParsed
  } catch (err) {
    if (err.stderr) {
      console.error('yt-dlp stderr:', err.stderr)
    }
    return "Error fetching comments: " + (err.message || 'Unknown error occurred')
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
  const args = ['--get-title', video_id]

  try {
    const { stdout } = await execFileAsync(ytDlpPath, args, { maxBuffer: 10 * 1024 * 1024 })
    return stdout.trim()
  } catch (err) {
    if (err.stderr) {
      console.error('yt-dlp stderr:', err.stderr)
    }
    return "Error fetching title: " + (err.message || 'Unknown error occurred')
  }
}

server.registerTool(
  "update-yt-dlp",
  {
    title: "Update yt-dlp",
    description: "Update the underlying yt-dlp executable.",
    inputSchema: {
    }
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
    inputSchema: {
    }
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

async function serve_stdio() {
  // Clean expired cache entries on startup
  await cleanCache()
  const transport = new StdioServerTransport()
  server.connect(transport)
}

function serve_http(port=12001) {
  const transport = new StreamableHTTPServerTransport({
    sessionIdGenerator: undefined,
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
          const paramStr = Object.entries(params).map(([k, v]) => `${k}: ${typeof v === 'object' ? JSON.stringify(v) : JSON.stringify(v)}`).join(', ')
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
    console.log('MCP server listening on port '+port)
  })
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

// Argument parsing
const args = process.argv.slice(2)
const mode = args.includes('--http') ? 'http' : 'stdio'
const portMatch = args.find(arg => arg.startsWith('--port='))
const port = portMatch ? parseInt(portMatch.split('=')[1], 10) : 12001

if (mode === 'http') {
  serve_http(port)
} else {
  serve_stdio()
}
