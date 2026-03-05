// preload for screen share pop-out window
'use strict';

const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('electronAPI', {
  screenShare: {
    onFrame: (cb) => {
      if (typeof cb !== 'function') return;
      ipcRenderer.on('screen-share-frame', (_e, dataUrl) => cb(dataUrl));
    },
    toggleFullscreen: () => ipcRenderer.send('screen-share-fullscreen'),
    close: () => ipcRenderer.send('screen-share-close'),
  },
});

