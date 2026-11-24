const { app, BrowserWindow, Menu, dialog, ipcMain, utilityProcess } = require('electron')
const { readFile, writeFile } = require('node:fs/promises')
const path = require('node:path')

let mainWindow
let settingsWindow
let demoProcess
let demoOrigin
let activeOrigin
let connecting = false
let configFile

function serverOrigin(value) {
  const url = new URL(value.trim())
  const loopback = ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname)
  if ((url.protocol !== 'https:' && !(url.protocol === 'http:' && loopback))
    || url.pathname !== '/' || url.username || url.password || url.search || url.hash) {
    throw new Error('Use o endereço HTTPS do servidor, sem caminho. HTTP é aceito para testes em localhost.')
  }
  return url.origin
}

async function savedOrigin() {
  try {
    const config = JSON.parse(await readFile(configFile, 'utf8'))
    return config.origin ? serverOrigin(config.origin) : ''
  } catch (error) {
    if (error.code === 'ENOENT') return ''
    throw error
  }
}

function startDemo() {
  if (demoProcess && demoOrigin) return Promise.resolve(demoOrigin)
  return new Promise((resolve, reject) => {
    const child = utilityProcess.fork(path.join(app.getAppPath(), 'server.js'), [], {
      env: {
        ...process.env,
        ATLAS_DEMO: '1',
        NODE_ENV: 'development',
        ATLAS_DB: path.join(app.getPath('userData'), 'demo.sqlite'),
        HOST: '127.0.0.1',
        PORT: '0',
      },
      serviceName: 'Atlas da Mente — servidor local',
    })
    demoProcess = child
    const deadline = setTimeout(() => {
      child.kill()
      reject(new Error('O servidor local levou tempo demais para iniciar.'))
    }, 12_000)
    child.on('exit', () => {
      clearTimeout(deadline)
      if (demoProcess === child) {
        demoProcess = undefined
        demoOrigin = undefined
      }
      reject(new Error('O servidor local foi encerrado.'))
    })
    child.once('message', ({ port }) => {
      clearTimeout(deadline)
      demoOrigin = 'http://127.0.0.1:' + port
      resolve(demoOrigin)
    })
  })
}

function isAtlasUrl(value) {
  try {
    return Boolean(activeOrigin) && new URL(value).origin === activeOrigin
  } catch {
    return false
  }
}

async function connect(origin) {
  if (connecting) return
  connecting = true
  try {
    const target = origin || await startDemo()
    const response = await fetch(target + '/api/session', { signal: AbortSignal.timeout(8000), redirect: 'error' })
    const data = response.ok && await response.json()
    if (!data || typeof data.demo !== 'boolean' || !Object.hasOwn(data, 'account')) {
      throw new Error('O endereço não respondeu como um servidor Atlas da Mente.')
    }
    activeOrigin = target
    await mainWindow.loadURL(target)
    if (origin && demoProcess) demoProcess.kill()
  } finally {
    connecting = false
  }
}

function showSettings() {
  if (settingsWindow && !settingsWindow.isDestroyed()) return settingsWindow.focus()
  settingsWindow = new BrowserWindow({
    parent: mainWindow, modal: true, width: 520, height: 465, minWidth: 400, minHeight: 410,
    autoHideMenuBar: true, title: 'Servidor do Atlas', backgroundColor: '#f8f7fc',
    webPreferences: { contextIsolation: true, sandbox: true, preload: path.join(__dirname, 'preload.cjs') },
  })
  settingsWindow.setMenu(null)
  settingsWindow.webContents.setWindowOpenHandler(() => ({ action: 'deny' }))
  settingsWindow.webContents.on('will-navigate', event => event.preventDefault())
  return settingsWindow.loadFile(path.join(__dirname, 'settings.html'))
}

function trustedSettings(event) {
  if (!settingsWindow || event.sender !== settingsWindow.webContents || event.senderFrame !== settingsWindow.webContents.mainFrame) {
    throw new Error('Solicitação indisponível nesta janela.')
  }
}
ipcMain.handle('atlas:server:get', async event => {
  trustedSettings(event)
  return savedOrigin().catch(() => '')
})
ipcMain.handle('atlas:server:set', async (event, value) => {
  trustedSettings(event)
  if (typeof value !== 'string' || value.length > 512) return { error: 'Informe um endereço de servidor válido.' }
  if (connecting) return { error: 'Aguarde a conexão atual.' }
  try {
    const origin = value.trim() ? serverOrigin(value) : ''
    await connect(origin)
    await writeFile(configFile, JSON.stringify({ origin }), { mode: 0o600 })
    settingsWindow.close()
    return {}
  } catch (error) {
    if (error.name === 'TypeError' || error.name === 'TimeoutError') {
      return { error: 'Confira o endereço e a conexão com o servidor Atlas.' }
    }
    return { error: error.message }
  }
})

async function launch() {
  configFile = path.join(app.getPath('userData'), 'atlas-server.json')
  mainWindow = new BrowserWindow({
    title: 'Atlas da Mente', width: 1280, height: 860, minWidth: 360, minHeight: 560,
    icon: path.join(__dirname, 'icon.png'), backgroundColor: '#f8f7fc',
    webPreferences: { nodeIntegration: false, contextIsolation: true, sandbox: true },
  })
  const { webContents } = mainWindow
  webContents.setWindowOpenHandler(() => ({ action: 'deny' }))
  for (const eventName of ['will-navigate', 'will-redirect', 'will-frame-navigate']) {
    webContents.on(eventName, (event, target) => {
      const url = typeof target === 'string' ? target : event.url ?? target?.url
      if (!isAtlasUrl(url)) event.preventDefault()
    })
  }
  webContents.session.setPermissionRequestHandler((sender, permission, allowed, details) => {
    allowed(sender === webContents && permission === 'clipboard-sanitized-write' && isAtlasUrl(details.requestingUrl))
  })
  webContents.session.setPermissionCheckHandler((sender, permission, url) => (
    sender === webContents && permission === 'clipboard-sanitized-write' && isAtlasUrl(url)
  ))
  Menu.setApplicationMenu(Menu.buildFromTemplate([
    { label: 'Atlas da Mente', submenu: [
      { label: 'Servidor…', click: showSettings },
      { label: 'Início', click: () => activeOrigin && mainWindow.loadURL(activeOrigin) },
      { type: 'separator' }, { role: 'quit', label: 'Sair' },
    ] },
    { label: 'Editar', submenu: [
      { role: 'undo', label: 'Desfazer' }, { role: 'redo', label: 'Refazer' },
      { type: 'separator' }, { role: 'cut', label: 'Recortar' }, { role: 'copy', label: 'Copiar' },
      { role: 'paste', label: 'Colar' }, { role: 'selectAll', label: 'Selecionar tudo' },
    ] },
  ]))
  try {
    await connect(await savedOrigin())
  } catch (error) {
    await dialog.showMessageBox(mainWindow, {
      type: 'error', title: 'Atlas da Mente', message: 'Não foi possível abrir o Atlas.',
      detail: error.message, buttons: ['Configurar servidor'],
    })
    await showSettings()
  }
}

if (!app.requestSingleInstanceLock()) app.quit()
else {
  app.on('second-instance', () => {
    if (mainWindow?.isMinimized()) mainWindow.restore()
    mainWindow?.focus()
  })
  app.whenReady().then(launch)
  app.on('window-all-closed', () => app.quit())
  app.on('before-quit', () => demoProcess?.kill())
}
