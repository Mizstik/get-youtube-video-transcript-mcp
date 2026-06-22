import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js"
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js'
import { z } from "zod"
import { exec } from "child_process"
import { promisify } from "util"
const execAsync = promisify(exec)

import path from "path"
import { fileURLToPath } from 'url'
import os from "os"
const __dirname = path.dirname(fileURLToPath(import.meta.url))
const ytDlpPath = path.join(__dirname, os.platform() === 'win32' ? 'yt-dlp.exe' : 'yt-dlp')

import fs from "fs/promises"
import http from "http"

const server = new McpServer({
  name: "Get Youtube Video Title and Subtitle",
  version: "1.2.0"
})



server.registerTool(
  "get-youtube-video-transcript-and-title",
  {
    title: "Get Youtube Video Transcript and Title",
    description: "Get transcript and title from a youtube video",
    inputSchema: {
      video_id: z.string(),
      lang: z.string()
    }
  },
  async ({video_id, lang}) => ({
    content: [{
      type: "text",
      text: await fetch_subtitle(video_id, lang)
    }]
  })
)

async function fetch_subtitle(video_id, lang="en") {
  const files_pre = await fs.readdir(__dirname)
  for (const file of files_pre) {
    if (file.endsWith('.lrc')) {
      await fs.unlink(path.join(__dirname, file))
    }
  }

  const command = `"${ytDlpPath}" --skip-download --write-subs --write-auto-subs --sub-langs ${lang} --convert-subs lrc -o "${path.join(__dirname, '%(title)s')}" "${video_id}"`
  await execAsync(command)

  const files = await fs.readdir(__dirname)
  const lrcFile = files.find(file => file.endsWith('.lrc'))
  if (!lrcFile) return "No transcript available."

  let subtitleContent = await fs.readFile(path.join(__dirname, lrcFile), 'utf-8')
  subtitleContent = subtitleContent.replace(/\\h/g, '').replace(/>> /g, '')
  let lines = subtitleContent.split('\n')

  let seen = new Set()
  let final = []
  final.push("title: " + lrcFile.slice(0, -7) + "\n\n")

  lines.forEach((line, index) => {
    let text = line.split("]", 2)[1]
    if (!seen.has(text)) {
      seen.add(text)
      final.push(line)
    }
  })

  await fs.unlink(path.join(__dirname, lrcFile))
  return final.join(' ')
}




server.registerTool(
  "get-youtube-video-comments",
  {
    title: "Get Youtube Video Comments",
    description: "Get comments from a youtube video",
    inputSchema: {
      video_id: z.string(),
      sortby: z.string(),
      max_comments: z.number()
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
  const command = `"${ytDlpPath}" --skip-download --write-comments --dump-json --extractor-args "youtube:comment_sort=${sortby};max_comments=${max_comments}" "${video_id}"`
  const { stdout } = await execAsync(command, { maxBuffer: 10 * 1024 * 1024 }) // 10 MB
  let jsondump = JSON.parse(stdout.trim())
  let commentBlock = jsondump.comments
  let commentParsed = ""

  commentBlock.forEach(function (item) {
    commentParsed += item.author + "\n" + item.text + "\n" + item.like_count + " likes\n"
  })

  return commentParsed
}



server.registerTool(
  "get-youtube-video-title-only",
  {
    title: "Get Youtube Video Title",
    description: "Get the title of a youtube video",
    inputSchema: {
      video_id: z.string()
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
  const command = `"${ytDlpPath}" --get-title "${video_id}"`
  const { stdout } = await execAsync(command)
  return stdout.trim()
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
  const command = `"${ytDlpPath}" --update`
  const { stdout } = await execAsync(command)
  return stdout.trim()
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






const transport = new StdioServerTransport()
server.connect(transport)





