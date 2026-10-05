const { app, BrowserWindow, shell } = require('electron')
const path = require('path')
const fs = require('fs')
const http = require('http')

const ROOT = path.join(__dirname, '..')

// Film Lab is a fully client-side editor: it spawns Web Workers, streams WASM
// (MediaPipe portrait masks, FFmpeg encoding) with fetch() and registers its own
// service worker. Chromium blocks all three for a page opened with file://, so
// desktop builds are served by a tiny static server started inside this process
// - loopback only (127.0.0.1), a random free port, no external tooling and no
// dev server involved. Set FILM_LAB_FILE_PROTOCOL=1 (or pass --file-protocol) to
// load index.html straight off disk with loadFile() instead; the editor opens,
// but blur/mask/portrait and video encoding are unavailable in that mode.
const LOAD_FROM_DISK = process.argv.includes('--file-protocol') || process.env.FILM_LAB_FILE_PROTOCOL === '1'

const MIME_TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.map': 'application/json; charset=utf-8',
  '.txt': 'text/plain; charset=utf-8',
  '.md': 'text/markdown; charset=utf-8',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.gif': 'image/gif',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
  '.wasm': 'application/wasm',
  '.data': 'application/octet-stream',
  '.tflite': 'application/octet-stream',
  '.task': 'application/octet-stream',
  '.onnx': 'application/octet-stream',
  '.binarypb': 'application/octet-stream',
  '.mp3': 'audio/mpeg',
  '.mp4': 'video/mp4',
  '.webm': 'video/webm',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2'
}

let staticServer = null

function serveAppFile(request, response) {
  if (request.method !== 'GET' && request.method !== 'HEAD') {
    response.writeHead(405, { 'Content-Type': 'text/plain; charset=utf-8' }).end('Method not allowed')
    return
  }

  let pathname = '/'
  try {
    pathname = decodeURIComponent(new URL(request.url, 'http://127.0.0.1').pathname)
  } catch (_) {
    response.writeHead(400, { 'Content-Type': 'text/plain; charset=utf-8' }).end('Bad request')
    return
  }

  const relative = pathname === '/' ? 'index.html' : pathname.replace(/^\/+/, '')
  const filePath = path.resolve(ROOT, relative)

  // Never serve anything outside the packaged app directory.
  if (filePath !== ROOT && !filePath.startsWith(ROOT + path.sep)) {
    response.writeHead(403, { 'Content-Type': 'text/plain; charset=utf-8' }).end('Forbidden')
    return
  }

  fs.readFile(filePath, (error, data) => {
    if (error || !data) {
      response.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' }).end('Not found')
      return
    }
    response.writeHead(200, {
      'Content-Type': MIME_TYPES[path.extname(filePath).toLowerCase()] || 'application/octet-stream',
      'Content-Length': data.length,
      'Cache-Control': 'no-cache'
    })
    if (request.method === 'HEAD') response.end()
    else response.end(data)
  })
}

function startAppServer() {
  return new Promise((resolve, reject) => {
    const server = http.createServer(serveAppFile)
    server.once('error', reject)
    server.listen(0, '127.0.0.1', () => {
      staticServer = server
      resolve(server.address().port)
    })
  })
}

function openExternal(url) {
  if (/^(https?|mailto):/i.test(url)) shell.openExternal(url)
}

async function createWindow() {
  const win = new BrowserWindow({
    width: 1280,
    height: 800,
    minWidth: 900,
    minHeight: 600,
    backgroundColor: '#0a0a0a',
    titleBarStyle: process.platform === 'darwin' ? 'hiddenInset' : 'default',
    webPreferences: {
      nodeIntegration: false,
      contextIsolation: true,
      webSecurity: true
    },
    icon: path.join(__dirname, '../icons/icon-512.png')
  })

  // Load the local index.html directly (no external server needed)
  let appOrigin = 'file://'
  if (LOAD_FROM_DISK) {
    win.loadFile('index.html')
  } else {
    try {
      const port = await startAppServer()
      appOrigin = `http://127.0.0.1:${port}`
      win.loadURL(`${appOrigin}/index.html`)
    } catch (error) {
      console.warn('Film Lab could not start its local asset server, falling back to file://', error)
      win.loadFile('index.html')
    }
  }

  // Open external links in browser not in the app
  win.webContents.setWindowOpenHandler(({ url }) => {
    openExternal(url)
    return { action: 'deny' }
  })

  // Keep the window on the local app: anything else goes to the default browser.
  win.webContents.on('will-navigate', (event, url) => {
    if (url.startsWith(appOrigin)) return
    event.preventDefault()
    openExternal(url)
  })
}

app.whenReady().then(createWindow)
app.on('window-all-closed', () => { if (process.platform !== 'darwin') app.quit() })
app.on('activate', () => { if (BrowserWindow.getAllWindows().length === 0) createWindow() })
app.on('before-quit', () => { if (staticServer) staticServer.close() })
