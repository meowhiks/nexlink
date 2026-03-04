// preload for call overlay window
'use strict';

const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('electronAPI', {
  callOverlay: {
    onFrame: (cb) => {
      if (typeof cb !== 'function') return;
      ipcRenderer.on('call-overlay-frame', (_e, dataUrl) => cb(dataUrl));
    },
    toggleFullscreen: () => ipcRenderer.send('call-overlay-fullscreen'),
    close: () => ipcRenderer.send('call-overlay-close'),
  },
});
