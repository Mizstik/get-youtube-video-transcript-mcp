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
  version: "1.1.0"
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
      text: await fetch_subtitle (video_id, lang)
    }]
  })
)

async function fetch_subtitle (video_id, lang) {
  // clean any existing lrc so it doesn't read the wrong one later
  const files_pre = await fs.readdir(__dirname)
  for (const file of files_pre) {
    if (file.endsWith('.lrc')) {
      await fs.unlink(`${__dirname}\\${file}`)
    }
  }
  
  return new Promise((resolve, reject) => {
    const command = `${__dirname}\\yt-dlp --skip-download --write-subs --write-auto-subs --sub-langs ${lang} --convert-subs lrc -o "${__dirname}\\%(title)s" "${video_id}"`
    exec(command, (error, stdout, stderr) => {
      if (error) {
        reject(error)
      } else {
        resolve(stdout)
      }
    })
  }).then(async () => {
    const files = await fs.readdir(__dirname)
    const lrcFile = files.find(file => file.endsWith('.lrc'))
    if (!lrcFile) return "No transcript available."

    let subtitleContent = await fs.readFile(`${__dirname}\\${lrcFile}`, 'utf-8')
    subtitleContent = subtitleContent.replace(/\\h/g, '').replace(/>> /g,'')
    let lines = subtitleContent.split('\n')

    let seen = new Set()
    let final = []
    final.push("title: "+lrcFile.slice(0,-7)+"\n\n")

    lines.forEach((line, index) => {
      let text = line.split("]", 2)[1]
      if (!seen.has(text)) {
        seen.add(text)
        final.push(text)
      }
    })

    fs.unlink(`${__dirname}\\${lrcFile}`)
    return final.join(' ')
  })
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





