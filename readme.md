# get-youtube-video-transcript-mcp

This is an MCP server which grabs transcripts/subtitles as well as the title from YouTube videos using yt-dlp.

# Installation

git clone https://github.com/Mizstik/get-youtube-video-transcript-mcp.git
cd get-youtube-video-transcript-mcp
npm install

Then grab the yt-dlp executable from https://github.com/yt-dlp/yt-dlp/releases and place it in the cloned directory (where main.js is).

Then add the following to the MCP config of your LLM frontend:

    "get-youtube-video-transcript-mcp": {
      "command": "node",
      "args": [
        "C:\\path\\to\\get-youtube-video-transcript-mcp\\main.js"
      ]
    }

Afterward, any model trained on tool-calling can make use of the tool.

![screenshot](https://github.com/Mizstik/mizstik.github.io/blob/master/get-youtube-title-screenshot.png?raw=true)

![screenshot](https://github.com/Mizstik/mizstik.github.io/blob/master/get-youtube-transcript-screenshot.png?raw=true)
