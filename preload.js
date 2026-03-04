// preload.js — NexLink context bridge
'use strict';
const { contextBridge, ipcRenderer, desktopCapturer } = require('electron');
contextBridge.exposeInMainWorld('electronAPI', {
  // Screen capture (fallback when getDisplayMedia fails)
  getDesktopSources: (opts) => desktopCapturer.getSources(opts || { types: ['screen', 'window'] }),
  // Network
  getLocalIPs: () => ipcRenderer.invoke('net-get-local-ips'),
  // Signaling server
  startSignalingServer: (port) => ipcRenderer.invoke('signaling-start', { port }),
  stopSignalingServer:  ()     => ipcRenderer.invoke('signaling-stop'),
  // Config
  loadConfig: ()       => ipcRenderer.invoke('config-load'),
  saveConfig: (config) => ipcRenderer.invoke('config-save', config),
  // Avatar file picker
  pickAvatarFile: () => ipcRenderer.invoke('dialog-open-avatar'),
  // Identity
  getIdentity: () => ipcRenderer.invoke('identity-get'),
  // Discovery (UDP LAN)
  startDiscovery: () => ipcRenderer.invoke('discovery-start'),
  stopDiscovery:  () => ipcRenderer.invoke('discovery-stop'),
  scanDiscovery:  () => ipcRenderer.invoke('discovery-scan'),
  onDiscoveryUpdate: (cb) => {
    if (typeof cb !== 'function') return;
    const handler = (_e, list) => cb(list);
    ipcRenderer.on('discovery-update', handler);
    return () => ipcRenderer.off('discovery-update', handler);
  },
  onSignalingExit: (cb) => {
    if (typeof cb !== 'function') return () => {};
    const handler = () => cb();
    ipcRenderer.on('signaling-server-exited', handler);
    return () => ipcRenderer.off('signaling-server-exited', handler);
  },
  // Window controls
  minimize: () => ipcRenderer.send('win-minimize'),
  maximize: () => ipcRenderer.send('win-maximize'),
  close:    () => ipcRenderer.send('win-close'),
  // DevTools
  openDevTools: () => ipcRenderer.send('devtools-open'),
  // Notifications
  notifyCall:    (data) => ipcRenderer.send('incoming-call-notify', data),
  notifyMessage: (data) => ipcRenderer.send('notify-message', data),
  // Call overlay — отдельное Electron-окно звонка
  openCallOverlay:  () => ipcRenderer.send('call-overlay-open'),
  closeCallOverlay: () => ipcRenderer.send('call-overlay-close'),
  // Direct video frame push (replaces capturePage approach)
  sendCallOverlayFrame: (dataUrl) => ipcRenderer.send('call-overlay-frame', dataUrl),
  // Legacy bounds (kept for compatibility, no longer used actively)
  sendCallOverlayBounds: (bounds) => ipcRenderer.send('call-overlay-capture', bounds),
  onCallOverlayOpened: (cb) => {
    if (typeof cb !== 'function') return () => {};
    const handler = () => cb();
    ipcRenderer.on('call-overlay-opened', handler);
    return () => ipcRenderer.off('call-overlay-opened', handler);
  },
  onCallOverlayClosed: (cb) => {
    if (typeof cb !== 'function') return () => {};
    const handler = () => cb();
    ipcRenderer.on('call-overlay-closed', handler);
    return () => ipcRenderer.off('call-overlay-closed', handler);
  },
});