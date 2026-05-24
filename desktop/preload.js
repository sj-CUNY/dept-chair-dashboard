'use strict';
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('setup', {
  // Listen for progress updates pushed from main process
  onProgress: (cb) => ipcRenderer.on('setup:progress', (_e, data) => cb(data)),
  // Listen for fatal error
  onError:    (cb) => ipcRenderer.on('setup:error',    (_e, msg)  => cb(msg)),
  // Listen for completion
  onDone:     (cb) => ipcRenderer.on('setup:done',     () => cb()),
});
