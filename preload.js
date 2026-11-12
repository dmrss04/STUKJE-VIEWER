const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('api', {
  initialFile: () => ipcRenderer.invoke('file:initial'),
  openDialog: () => ipcRenderer.invoke('file:open'),
  fit: (w, h) => ipcRenderer.invoke('win:fit', w, h),
  minimize: () => ipcRenderer.send('win:min'),
  close: () => ipcRenderer.send('win:close'),
  toggleMax: () => ipcRenderer.send('win:toggleMax'),
  tile: () => ipcRenderer.send('win:tile'),
  dragStart: () => ipcRenderer.send('win:dragStart'),
  dragEnd: () => ipcRenderer.send('win:dragEnd'),
  resizeStart: (dir) => ipcRenderer.send('win:resizeStart', dir),
  resizeEnd: () => ipcRenderer.send('win:resizeEnd'),
  onMaximized: (cb) => ipcRenderer.on('win:maximized', (_e, v) => cb(v)),
});
