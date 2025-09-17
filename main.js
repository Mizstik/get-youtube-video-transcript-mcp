import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js"
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import { z } from "zod"
import { exec } from "child_process"

import path from "path"
import { fileURLToPath } from 'url'
const __dirname = path.dirname(fileURLToPath(import.meta.url))

import fs from "fs/promises"

const server = new McpServer({
  name: "Get Youtube Video Title and Subtitle",
  version: "1.0.0"
})



server.registerTool(
  "get-youtube-video-transcript",
  {
    title: "Get Youtube Video Transcript",
    description: "Get transcript from a youtube video",
    inputSchema: {
      video_id: z.string(),
      lang: z.string()
    }
  },
  async ({video_id, lang}) => ({
    content: [{
      type: "text",
      text: await fetch_subtitle (video_id, lang)
    }]
  })
)

async function fetch_subtitle (video_id, lang) {
  // clean any existing lrc so it doesn't read the wrong one later
  const files_pre = await fs.readdir(__dirname)
  const lrcFile_pre = files_pre.find(file => file.endsWith('.lrc'))
  if (lrcFile_pre) await fs.unlink(`${__dirname}\\${lrcFile_pre}`)
  
  return new Promise((resolve, reject) => {
    const command = `${__dirname}\\yt-dlp  --skip-download --write-subs --write-auto-subs --convert-subs lrc -o "${__dirname}\\${video_id}.lrc" "${video_id}"`
    exec(command, (error, stdout, stderr) => {
      if (error) {
        reject(error)
      } else {
        resolve(stdout.trim())
      }
    })
  }).then(async () => {
    const files = await fs.readdir(__dirname)
    const lrcFile = files.find(file => file.endsWith('.lrc'))
    let subtitleContent = await fs.readFile(`${__dirname}\\${lrcFile}`, 'utf-8')
    subtitleContent.replace(/\\h/g, '').replace(/\n/g, ' ')
    await fs.unlink(`${__dirname}\\${lrcFile}`)
    return subtitleContent
  })
}




server.registerTool(
  "get-youtube-video-title",
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
  return new Promise((resolve, reject) => {
    const command = `${__dirname}\\yt-dlp --get-title "${video_id}"`
    exec(command, (error, stdout, stderr) => {
      if (error) {
        reject(error)
      } else {
        resolve(stdout.trim())
      }
    })
  })
}



const transport = new StdioServerTransport()
server.connect(transport)





