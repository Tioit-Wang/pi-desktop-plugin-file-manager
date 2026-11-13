const assert = require('node:assert/strict');
const { createRequire } = require('node:module');
const path = require('node:path');
const fs = require('node:fs/promises');
const os = require('node:os');
const from = (directory) => directory ? createRequire(path.join(directory, 'package.json')) : require;
const { _electron } = from(process.env.PDF_PLAYWRIGHT_DIR)('playwright');
const electronBinary = from(process.env.PDF_ELECTRON_DIR)('electron');

(async () => {
  const temporary = await fs.mkdtemp(path.join(os.tmpdir(), 'pifm-file-lines-'));
  const project = path.join(temporary, 'project');
  await fs.mkdir(project);
  await fs.writeFile(path.join(project, 'sample.txt'), 'first line\nsecond line\n');
  const application = await _electron.launch({
    executablePath: electronBinary,
    args: [path.join(__dirname, 'main.cjs')],
    env: {
      ...process.env, FILE_LINES_TEST: '1', PDF_FIXTURE_DIR: project,
      PDF_PROFILE_DIR: path.join(temporary, 'profile'),
      PDF_PLUGIN_DIR: process.env.PDF_PLUGIN_DIR || path.resolve(__dirname, '../..'),
    },
  });
  try {
    const page = await application.firstWindow();
    const errors = [];
    page.on('pageerror', (error) => errors.push(String(error)));
    await page.getByRole('treeitem').filter({ hasText: 'sample.txt' }).click();
    const editor = page.locator('.cm-content');
    await editor.getByText('first line', { exact: true }).waitFor();
    await editor.click();
    const modifier = process.platform === 'darwin' ? 'Meta' : 'Control';
    await page.keyboard.press(modifier + '+a');
    await editor.click({ button: 'right' });
    await page.getByRole('menuitem', { name: 'Add to chat', exact: true }).click();
    await page.waitForFunction(async () => (await window.pluginBridge.invoke('test:fileLineEvents')).some((event) => event.channel === 'composer.addFileLines'));
    const events = await application.evaluate(() => global.fileLineEvents);
    assert.deepEqual(events[0].payload, { workspace: project, path: path.join(project, 'sample.txt'), start: 1, end: 2 });

    await application.evaluate(() => { global.fileLineFailure = 'HOST_UNAVAILABLE: Host is restarting'; });
    await editor.click();
    await page.keyboard.press(modifier + '+a');
    await editor.click({ button: 'right' });
    await page.getByRole('menuitem', { name: 'Add to chat', exact: true }).click();
    await page.waitForFunction(async () => (await window.pluginBridge.invoke('test:fileLineEvents')).some((event) => event.channel === 'ui.showToast' && event.payload.message.includes('HOST_UNAVAILABLE')));

    await editor.click();
    await page.keyboard.press(modifier + '+a');
    await page.keyboard.type('unsaved replacement');
    await page.getByRole('status').filter({ hasText: 'Save or reload the file to reference its lines.' }).waitFor();
    await page.keyboard.press(modifier + '+a');
    await editor.click({ button: 'right' });
    assert.equal(await page.getByRole('menuitem', { name: 'Add to chat', exact: true }).count(), 0);
    await page.keyboard.press('Escape');
    await page.getByRole('button', { name: 'Save', exact: true }).click();
    await page.getByRole('status').filter({ hasText: 'Save or reload the file to reference its lines.' }).waitFor({ state: 'detached' });
    await editor.click();
    await page.keyboard.press(modifier + '+a');
    await editor.click({ button: 'right' });
    await page.getByRole('menuitem', { name: 'Add to chat', exact: true }).waitFor();
    await page.keyboard.press('Escape');
    assert.equal(await editor.evaluate((element) => element.contains(document.activeElement)), true);
    assert.deepEqual(errors, []);
    assert.deepEqual(await application.evaluate(() => global.blockedPdfRequests), []);
    console.log('FILE LINES DESKTOP PASSED: saved selection, Host error, unsaved hint, save recovery, Escape focus');
  } finally {
    await application.close();
    await fs.rm(temporary, { recursive: true, force: true });
  }
})().catch((error) => { console.error(error); process.exitCode = 1; });
