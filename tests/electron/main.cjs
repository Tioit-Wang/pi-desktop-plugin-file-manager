const { app, BrowserWindow, ipcMain, session } = require('electron');
const path = require('node:path');
app.setPath('userData', process.env.PDF_PROFILE_DIR);
// Loading checks start with manual refresh, then enable the real watcher in the UI.
const loadingTest = process.env.FM_LOADING_TEST === '1';
const workbenchTest = process.env.FM_WORKBENCH_TEST === '1';
let settings = { fmPrefs: { watchFiles: !loadingTest && !workbenchTest } };
if (loadingTest || workbenchTest) global.loadingGate = require('./verify-loading.cjs').createGate(loadingTest);
if (workbenchTest) global.workbenchCalls = [];
global.pi = {
  workspace: { get: async () => {
    const root = process.env.PDF_FIXTURE_DIR;
    const second = workbenchTest ? process.env.FM_SECOND_ROOT : undefined;
    return second ? { path: root, name: 'Workbench fixture', projectId: 'workbench-fixture', roots: [
      { path: root, name: 'Workbench fixture', primary: true }, { path: second, name: 'second-folder' },
    ] } : { path: root, name: 'Synthetic PDF project' };
  } },
  plugin: { getDataPath: async () => process.env.PDF_PROFILE_DIR, getSettings: async () => settings, setSettings: async (value) => { settings = value; } },
};
const plugin = require(path.join(process.env.PDF_PLUGIN_DIR, 'main.js'));
global.testAppearance = { base: 'dark', locale: 'en' };
global.blockedPdfRequests = [];
global.fileLineEvents = [];
app.whenReady().then(async () => {
  await plugin.onLoad();
  session.defaultSession.webRequest.onBeforeRequest((details, callback) => {
    const remote = /^https?:/i.test(details.url);
    if (remote) global.blockedPdfRequests.push(details.url);
    callback({ cancel: remote });
  });
  ipcMain.handle('bridge', async (_event, channel, payload) => {
    if (process.env.FILE_LINES_TEST === '1') {
      if (channel === 'test:fileLineEvents') return global.fileLineEvents;
      if (channel === 'ui.showToast' || channel === 'composer.addFileLines') {
        global.fileLineEvents.push({ channel, payload });
        if (channel === 'composer.addFileLines' && global.fileLineFailure) throw new Error(global.fileLineFailure);
        return { ok: true };
      }
    }
    if (channel === 'app.getAppearance') return global.testAppearance;
    if (channel === 'workspace.get') return global.pi.workspace.get();
    if (workbenchTest && (channel.startsWith('fm.git.') || channel === 'fm.write')) {
      global.workbenchCalls.push({ channel, payload });
      // Never start remote Git transport from a renderer test. Local Git reads
      // and index mutations still run unchanged through the production handlers.
      if (channel === 'fm.git.syncAction' && payload?.action !== 'init') return { ok: true };
    }
    if (loadingTest || workbenchTest) {
      const response = await plugin.onPanelInvoke(channel, payload);
      await global.loadingGate.beforeReply(channel, payload?.path);
      return response;
    }
    return plugin.onPanelInvoke(channel, payload);
  });
  const window = new BrowserWindow({ width: 1250, height: 880, show: true, webPreferences: {
    preload: path.join(__dirname, 'preload.cjs'), sandbox: true, contextIsolation: true, nodeIntegration: false,
    additionalArguments: [
      ...(process.env.FILE_LINES_TEST === '1' ? ['--file-lines-test'] : []),
      ...(process.env.FM_COMPOSER_DRAG_TEST === '1' ? ['--composer-file-drag-test'] : []),
    ],
  } });
  await window.loadFile(path.join(process.env.PDF_PLUGIN_DIR, 'views/index.html'));
});
app.on('window-all-closed', () => app.quit());
app.on('will-quit', () => { void plugin.onUnload(); });
