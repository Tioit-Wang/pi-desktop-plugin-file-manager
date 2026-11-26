const assert = require('node:assert/strict');
const { createRequire } = require('node:module');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const from = directory => directory ? createRequire(path.join(directory, 'package.json')) : require;
const { _electron } = from(process.env.PDF_PLAYWRIGHT_DIR)('playwright');
const electron = from(process.env.PDF_ELECTRON_DIR)('electron');

(async () => {
  const temp = await fs.mkdtemp(path.join(os.tmpdir(), 'pifm-tree-'));
  const project = path.join(temp, 'project');
  const composerDrag = process.env.FM_COMPOSER_DRAG_TEST === '1';
  const dependencies = path.join(project, 'node_modules');
  const dependency = path.join(dependencies, 'dependency.txt');
  const symlink = path.join(project, 'linked.txt');
  const source = path.join(project, 'src', 'deep', 'open.txt');
  let app;
  try {
    await fs.mkdir(path.join(project, 'src', 'deep'), { recursive: true });
    await fs.mkdir(path.join(project, 'dest'));
    await fs.writeFile(source, 'original');
    if (composerDrag) {
      await fs.mkdir(dependencies);
      await fs.writeFile(dependency, 'dependency');
      await fs.symlink(source, symlink, 'file');
    }
    const git = (...args) => require('node:child_process').execFileSync('git', args, { cwd: project, encoding: 'utf8' });
    app = await _electron.launch({ executablePath: electron, args: [path.join(__dirname, 'main.cjs')], env: {
      ...process.env, PDF_FIXTURE_DIR: project, PDF_PROFILE_DIR: path.join(temp, 'profile'),
      PDF_PLUGIN_DIR: process.env.PDF_PLUGIN_DIR || path.resolve(__dirname, '../..'),
    } });
    const page = await app.firstWindow();
    page.setDefaultTimeout(12000);
    const errors = [];
    page.on('pageerror', e => errors.push(String(e)));
    const row = p => page.locator(`[role="treeitem"][data-path="${p}"]`);
    const button = name => page.getByRole('button', { name, exact: true });
    await row('src').waitFor();
    if (composerDrag) {
      await row('src').click();
      await row('src/deep').click();
      await page.evaluate(() => {
        window.dragEffects = [];
        window.addEventListener('dragstart', event => window.dragEffects.push(event.dataTransfer.effectAllowed));
      });
      await row('src/deep/open.txt').dragTo(row('src/deep'));
      await row('src').dragTo(row('src/deep'));
      await row('node_modules').click();
      const copyOnly = row('node_modules/dependency.txt');
      assert.equal(await copyOnly.getAttribute('draggable'), 'true');
      await copyOnly.dragTo(row('dest'), {
        sourcePosition: { x: 48, y: 10 },
        targetPosition: { x: 140, y: 10 },
      });
      await row('linked.txt').waitFor();
      assert.equal(await row('linked.txt').getAttribute('draggable'), 'false');
      await row('linked.txt').dragTo(row('dest'));
      assert.deepEqual(await page.evaluate(() => window.dragEffects), ['copyMove', 'move', 'copy']);
      assert.deepEqual(await page.evaluate(() => window.pluginBridge.testComposerDrags()), [
        { workspace: project, path: source },
        { workspace: project, path: dependency },
      ]);
      assert.equal(await fs.readFile(source, 'utf8'), 'original');
      assert.equal(await fs.readFile(dependency, 'utf8'), 'dependency');
      await fs.unlink(symlink);
      await fs.unlink(dependency);
      await fs.rmdir(dependencies);
      await button('Refresh').click();
      await row('src').click();
    }
    const gitTab = page.getByRole('tab', { name: 'Source Control', exact: true });
    const explorer = page.getByRole('tab', { name: 'Explorer', exact: true });
    await gitTab.click();
    await button('Initialize repository').click();
    await button('Stage all').click();
    await button('Unstage all').click();
    await panelReady();
    assert.equal(git('diff', '--cached', '--name-only').trim(), '');
    git('config', 'user.name', 'Explorer fixture'); git('config', 'user.email', 'fixture@example.invalid');
    git('remote', 'add', 'origin', 'https://example.invalid/fixture.git');
    git('add', '.'); git('-c', 'commit.gpgsign=false', 'commit', '-qm', 'Fixture baseline');
    await explorer.click();
    async function panelReady() { await page.getByRole('button', { name: 'Untracked (1)', exact: true }).waitFor(); }
    await button('Expand all').click();
    await row('src/deep/open.txt').waitFor();
    await button('Collapse all').click();
    await row('src/deep').waitFor({ state: 'detached' });
    await row('src').click();
    await row('src/deep').click();
    await fs.writeFile(path.join(project, 'src', 'deep', 'external.txt'), 'outside');
    await row('src/deep/external.txt').waitFor({ timeout: 5000 }).catch(async error => {
      console.error('Tree:', await page.locator('body').innerText(), 'watch:', await page.evaluate(async () => ({ hidden: document.hidden, events: await window.pluginBridge.invoke('fm.watch', { since: 0 }) })));
      throw error;
    });
    await fs.unlink(path.join(project, 'src', 'deep', 'external.txt'));
    await row('src/deep/external.txt').waitFor({ state: 'detached', timeout: 5000 });
    await row('src/deep/open.txt').click();
    const editor = page.locator('.cm-content');
    await editor.getByText('original', { exact: true }).waitFor();
    await editor.click();
    await page.keyboard.press(process.platform === 'darwin' ? 'Meta+a' : 'Control+a');
    await page.keyboard.type('unsaved draft');
    await row('src/deep').dragTo(row('dest'));
    await row('dest/deep').waitFor({ timeout: 5000 });
    await row('src/deep').waitFor({ state: 'detached' });
    assert.equal(await fs.readFile(path.join(project, 'dest', 'deep', 'open.txt'), 'utf8'), 'original');
    assert.match(await editor.innerText(), /unsaved draft/);
    await button('Save').click();
    await page.waitForFunction(() => document.querySelector('.cm-content')?.textContent === 'unsaved draft');
    await assert.doesNotReject(async () => {
      for (let i = 0; i < 50; i++) {
        if ((await fs.readFile(path.join(project, 'dest', 'deep', 'open.txt'), 'utf8')) === 'unsaved draft') return;
        await new Promise(resolve => setTimeout(resolve, 60));
      }
      assert.fail('editor did not save to the moved path');
    });
    await row('dest/deep').click({ button: 'right' });
    assert.equal(await page.getByRole('menuitem', { name: /Move to/ }).count(), 0);
    await page.keyboard.press('Escape');
    await editor.click();
    await page.keyboard.press('End');
    await page.keyboard.type(' — editor only');
    const draft = await editor.innerText();
    await gitTab.click();
    assert.equal(await page.getByRole('dialog').count(), 0);
    const panel = page.getByRole('tabpanel', { name: 'Source Control', exact: true });
    const file = 'dest/deep/open.txt';
    const moved = panel.getByRole('listitem').filter({ has: page.getByRole('button', { name: file, exact: true }) });
    const preview = page.locator('#fm-content-panel .diff-pane');
    const reviewTab = page.getByRole('tab', { name: `${file} · Changes`, exact: true });
    const documentTab = page.getByRole('tab', { name: 'open.txt •', exact: true });
    await moved.getByRole('button', { name: file }).click();
    await preview.getByText('unsaved draft', { exact: true }).waitFor();
    assert.equal(await preview.evaluate(el => !!el.closest('aside')), false);
    await documentTab.click();
    assert.equal(await editor.innerText(), draft);
    await reviewTab.click();
    await moved.getByRole('button', { name: 'Stage', exact: true }).click();
    await reviewTab.getByText('Staged', { exact: true }).waitFor();
    await moved.getByRole('button', { name: 'Unstage', exact: true }).click();
    await moved.getByRole('button', { name: 'Stage', exact: true }).click();
    await moved.getByRole('button', { name: 'Unstage', exact: true }).waitFor();
    await fs.writeFile(path.join(project, file), 'disk only');
    await panel.getByRole('button', { name: 'Refresh', exact: true }).click();
    const group = name => panel.getByRole('region', { name, exact: true });
    await group('Changes').getByRole('button', { name: file, exact: true }).click();
    await preview.getByText('disk only', { exact: true }).waitFor();
    await group('Staged Changes').getByRole('button', { name: file, exact: true }).click();
    await preview.getByText('unsaved draft', { exact: true }).waitFor();
    assert.equal(await preview.getByText('disk only', { exact: true }).count(), 0);
    // The source-control list stays visible while document tabs switch by keyboard.
    await reviewTab.focus(); await page.keyboard.press('Home');
    assert.equal(await editor.innerText(), draft);
    await page.keyboard.press('End'); await preview.getByText('unsaved draft', { exact: true }).waitFor();
    if (process.env.PDF_EVIDENCE_DIR) {
      await fs.mkdir(process.env.PDF_EVIDENCE_DIR, { recursive: true });
      await page.screenshot({ path: path.join(process.env.PDF_EVIDENCE_DIR, 'tabs-dark.png') });
    }
    await panel.getByLabel('Commit message').fill('Commit from explorer fixture');
    await panel.getByRole('button', { name: 'Commit staged changes (1)' }).click();
    await panel.getByText('Committed locally.', { exact: true }).waitFor();
    assert.equal(git('log', '-1', '--format=%s').trim(), 'Commit from explorer fixture');
    assert.equal(git('show', 'HEAD:dest/deep/open.txt'), 'unsaved draft');
    assert.equal(git('show', 'HEAD:src/deep/open.txt'), 'original'); // unstaged deletion excluded
    await panel.getByRole('tab', { name: 'History', exact: true }).click();
    await panel.getByRole('button', { name: /Commit from explorer fixture/ }).click();
    await page.getByRole('article', { name: 'Commit details' }).getByRole('heading', { name: 'Commit from explorer fixture' }).waitFor();
    await explorer.click();
    await documentTab.click();
    await editor.waitFor();
    assert.equal(await editor.innerText(), draft);
    assert.deepEqual(errors, []);
    console.log('EXPLORER DESKTOP PASSED: expand/collapse, external create/delete, drag and save dirty file at moved path, Git diff/stage/unstage/commit');
  } finally {
    await app?.close();
    await fs.rm(temp, { recursive: true, force: true });
  }
})().catch(e => { console.error(e); process.exitCode = 1; });
