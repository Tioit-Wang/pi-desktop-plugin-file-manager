const { contextBridge, ipcRenderer } = require('electron');
const composerDrags = [];
const composerDragTest = process.argv.includes('--composer-file-drag-test');
contextBridge.exposeInMainWorld('pluginBridge', {
  capabilities: { composerFileLines: process.argv.includes('--file-lines-test') },
  ...(composerDragTest ? {
    startComposerFileDrag: payload => {
      composerDrags.push(payload);
      return true;
    },
    testComposerDrags: () => composerDrags,
  } : {}),
  invoke: (channel, payload) => ipcRenderer.invoke('bridge', channel, payload),
  on: (event, handler) => {
    const listener = (_event, payload) => handler(payload);
    ipcRenderer.on('test:' + event, listener);
    return () => ipcRenderer.removeListener('test:' + event, listener);
  },
});
