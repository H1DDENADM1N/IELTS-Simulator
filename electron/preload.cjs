// 只暴露读本地题库的三个接口，渲染进程拿不到 Node / fs / 网络能力。
const { contextBridge, ipcRenderer } = require('electron')

contextBridge.exposeInMainWorld('ieltsSim', {
  readJson: (name) => ipcRenderer.invoke('ielts-sim:read-json', name),
  readUnit: (id) => ipcRenderer.invoke('ielts-sim:read-unit', id),
  mediaUrl: (name) => ipcRenderer.sendSync('ielts-sim:media-url', name),
})
