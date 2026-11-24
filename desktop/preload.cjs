const { contextBridge, ipcRenderer } = require('electron')

contextBridge.exposeInMainWorld('atlasSettings', {
  read: () => ipcRenderer.invoke('atlas:server:get'),
  save: origin => ipcRenderer.invoke('atlas:server:set', origin),
})
