# get-youtube-video-transcript-mcp

This is an MCP server which grabs transcripts/subtitles as well as the title from YouTube videos using yt-dlp.

This version has merged both the stdio and http-streamable transports into one codebase, selectable by command-line.

# Installation
```
git clone https://github.com/Mizstik/get-youtube-video-transcript-mcp.git
cd get-youtube-video-transcript-mcp
npm install
```

You also need ffmpeg on the same system where this MCP will run:
```
winget install ffmpeg
```
ffmpeg is required in order to convert subtitles into LRC format for compaction. The MCP will not function without it.

On linux, the yt-dlp executable requires python 3.10 or newer.
```
sudo apt install python3.10
```

## Command-line options

| Option | Default | Description |
|--------|---------|-------------|
| `--http` | (stdio) | Enable HTTP streamable transport mode |
| `--port=N` | `12001` | Port to listen on (only in HTTP mode) |
| `--chunk-size=N` | `15360` (~15 KB) | Max bytes per stdio chunk. Accepts suffixes: `KB`, `MB` (e.g. `--chunk-size=25KB`) |

Example with custom chunk size:
```
node main.js --chunk-size=25KB
```

## stdio transport
Some desktop frontends, like LM Studio, prefer MCPs with stdio transport. To add this MCP to the frontend, add the following to the MCP config file. (In LMS, this is "Edit mcp.json" in the Integration sidebar, in the Install button.)

    "get-youtube-video-transcript-mcp": {
      "command": "node",
      "args": [
        "C:\\path\\to\\get-youtube-video-transcript-mcp\\main.js"
      ]
    }

When main.js is executed with no command line arguments, it will operate in stdio mode. The LLM frontend will execute this for you automatically when needed and there is no resident process or server running.

### Chunking
In many frontends (including LM Studio and Hermes), if the response from MCP in stdio mode is too large, the frontend will arbitrarily cut off and put "truncated" at the end. This tends to happen at around 30 KB (or about 20-30 minutes of video depending on how fast the host speaks). To circumvent this, the MCP will chunk subtitles at the configured size (default ~15 KB, adjustable via `--chunk-size`). The agent will need to call the MCP again to obtain the rest. To do this, you may need to provide instructions to the agent either in the prompt, the context, or the skill. For example:

```
If the transcript starts with "Part 1/3" or similar, it means there are more transcript to fetch., in which case call the tool again with chunk: 2, or chunk: 3 or more as needed to fetch the rest of the subtitles until all parts are obtained.
```
As far as I know, this truncation does not happen when agents call the MCP in HTTP streamable mode (at least not with OpenWebUI and Hermes) and the agent can obtain the entire transcript in one call no matter how large it is.

## streamable http
Some frontends, particularly server-based ones such as OpenWebUI, prefer MCPs with streamable http transport.

First, start the MCP http server with the --http argument. Port can be omitted which will default to 12001.
```
node main.js --http --port=12001

MCP server listening on port 12001
```
This will start the server and it's intended to be kept running indefinitely, in order to listen and respond to frontend requests. Do not close the terminal or command line box where this is running.

On the frontend, add the integration with a URL to the machine where the MCP is running, making sure to add the http:// prefix and append the port and the /mcp path. Example:
```
http://192.168.8.120:12001/mcp
```

Example in OpenWebUI:
![screenshot](https://github.com/Mizstik/mizstik.github.io/blob/master/OWUI_Screenshot_20260623_082822.png?raw=true)

### Note for OpenWebUI
You will need to add this in the *Admin Panel*. Adding the mcp in user options will fail silently, as of OWUI 0.9.

Be sure to change the "Type" at the top from OpenAPI to MCP Streamable HTTP. Change the auth to None.

# Initialize yt-dlp
You need to first download yt-dlp before the MCP can fetch subtitles. You can order the LLM to do this for you by having it call the "initialize-yt-dlp" tool from this mcp.

Simply saying "initialize yt-dlp" in the chat interface will often be enough, if the model was trained in tool calling. Models as small as Gemma-4-E4B are capable of doing so.

![screenshot](https://github.com/Mizstik/mizstik.github.io/blob/master/initialize-yt-dlp-Screenshot_20260623_085212.png?raw=true)

Afterward, the MCP will be able to fetch subtitles from youtube videos.

If this fails, you can manually download the yt-dlp executable from https://github.com/yt-dlp/yt-dlp/releases and place it in the mcp's cloned directory (where main.js is).

After you're done initializing, you can disable this tool by unticking the box next to "initialize-yt-dlp" in the tool list to declutter the context.

# Updating yt-dlp
yt-dlp needs to be updated usually around every 3-6 months to keep up with youtube's countermeasures. The MCP includes a tool that allows you to order an update via LLM, using the "update-yt-dlp" tool.

![screenshot](https://github.com/Mizstik/mizstik.github.io/blob/master/update-yt-dlp-Screenshot_20260623_084506.png?raw=true)

When you do not need to update, you can also disable the tool in your frontend to avoid cluttering the context.

# Example Screenshots

![screenshot](https://github.com/Mizstik/mizstik.github.io/blob/master/get-youtube-title-screenshot.png?raw=true)

![screenshot](https://github.com/Mizstik/mizstik.github.io/blob/master/get-youtube-transcript-screenshot.png?raw=true)

Note that the mcp is also capable of downloading user comments below the video:

![screenshot](https://github.com/Mizstik/mizstik.github.io/blob/master/comments_Screenshot_20260623_090550.jpg?raw=true)
