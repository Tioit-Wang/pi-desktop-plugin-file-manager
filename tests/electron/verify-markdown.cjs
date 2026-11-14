const { createRequire } = require('node:module');
const path = require('node:path');
const fs = require('node:fs/promises');
const os = require('node:os');
const assert = require('node:assert/strict');
const { crc32, deflateSync } = require('node:zlib');
const from = directory => directory ? createRequire(path.join(directory, 'package.json')) : require;
const { _electron } = from(process.env.PDF_PLAYWRIGHT_DIR)('playwright');
const electronBinary = from(process.env.PDF_ELECTRON_DIR)('electron');

function widePng() {
  const width = 2400, height = 120;
  const rows = Buffer.alloc((width * 3 + 1) * height);
  for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
    const offset = y * (width * 3 + 1) + 1 + x * 3;
    rows.set(x < width / 2 ? [40, 140, 220] : [240, 150, 40], offset);
  }
  const chunk = (kind, data) => {
    const payload = Buffer.concat([Buffer.from(kind), data]);
    const size = Buffer.alloc(4), crc = Buffer.alloc(4);
    size.writeUInt32BE(data.length); crc.writeUInt32BE(crc32(payload));
    return Buffer.concat([size, payload, crc]);
  };
  const header = Buffer.alloc(13);
  header.writeUInt32BE(width); header.writeUInt32BE(height, 4);
  header[8] = 8; header[9] = 2;
  return Buffer.concat([Buffer.from('89504e470d0a1a0a', 'hex'), chunk('IHDR', header),
    chunk('IDAT', deflateSync(rows)), chunk('IEND', Buffer.alloc(0))]);
}

(async () => {
  const pluginDir = process.env.PDF_PLUGIN_DIR || path.resolve(__dirname, '../..');
  const temporary = await fs.mkdtemp(path.join(os.tmpdir(), 'pifm-markdown-browser-'));
  const project = path.join(temporary, 'project');
  const images = path.join(project, 'images');
  const notes = path.join(project, 'notes');
  await fs.mkdir(images, { recursive: true });
  await fs.mkdir(notes);
  const png = widePng();
  for (const file of ['pixel.png', '中文.png']) await fs.writeFile(path.join(images, file), png);
  await fs.writeFile(path.join(temporary, 'outside.png'), png);
  await fs.writeFile(path.join(project, '.env'), png);
  await fs.symlink(path.join(temporary, 'outside.png'), path.join(images, 'escape.png'));
  await fs.writeFile(path.join(images, 'bad.png'), 'invalid PNG');
  await fs.writeFile(path.join(images, 'large.png'), png);
  await fs.truncate(path.join(images, 'large.png'), 8 * 1024 * 1024 + 1);
  const markdown = '# Synthetic image preview\n\n' + [
    '![pixel](../images/pixel.png)', '![Chinese](../images/%E4%B8%AD%E6%96%87.png)',
    '![missing](../images/missing.png)', '![remote](https://example.invalid/image.png)',
    `![absolute](${path.join(temporary, 'outside.png')})`, '![protected](../.env)',
    '![escape](../../outside.png)', '![symlink](../images/escape.png)',
    '![oversized](../images/large.png)', '![invalid](../images/bad.png)',
  ].join('\n\n');
  await fs.writeFile(path.join(notes, 'guide.md'), markdown);
  await fs.writeFile(path.join(notes, 'other.md'), '# No images in this document\n');
  const external = path.join(temporary, 'external.md');
  await fs.writeFile(external, '# External document\n\n![external](outside.png)\n');
  const application = await _electron.launch({ executablePath: electronBinary, args: [path.join(__dirname, 'main.cjs')], env: {
    ...process.env, PDF_PLUGIN_DIR: pluginDir, PDF_FIXTURE_DIR: project,
    PDF_PROFILE_DIR: path.join(temporary, 'profile'),
  } });
  const errors = [];
  try {
    const page = await application.firstWindow();
    page.setDefaultTimeout(15000);
    page.on('pageerror', error => errors.push(String(error)));
    await page.getByRole('tree').waitFor();
    const open = async file => {
      await application.evaluate(({ BrowserWindow }, selected) => {
        BrowserWindow.getAllWindows()[0].webContents.send('test:view:open', { path: selected });
      }, file);
    };
    await page.getByRole('treeitem').filter({ hasText: 'notes' }).click();
    await page.getByRole('treeitem').filter({ hasText: 'guide.md' }).click();
    await page.getByRole('tab', { name: 'Preview', exact: true }).click();
    await page.waitForFunction(() => document.querySelectorAll('.md-body img').length === 2 &&
      [...document.querySelectorAll('.md-body img')].every(image => image.complete && image.naturalWidth === 2400) &&
      document.querySelectorAll('.md-body .md-image').length === 8);
    assert.deepEqual(await page.locator('.md-body img').evaluateAll(nodes => nodes.map(image => image.alt)), ['pixel', 'Chinese']);
    assert.equal(await page.locator('.md-body img').evaluateAll(nodes => nodes.every(image => {
      const outer = image.closest('.md-body').getBoundingClientRect();
      const inner = image.getBoundingClientRect();
      return inner.width > 0 && inner.left >= outer.left && inner.right <= outer.right;
    })), true);
    console.log('PASS production preview decodes relative/encoded Chinese PNGs; eight denied or invalid sources retain placeholders');

    await open('notes/other.md');
    await page.getByRole('heading', { name: 'No images in this document' }).waitFor();
    assert.equal(await page.locator('.md-body img').count(), 0);
    await open('notes/guide.md');
    await page.getByRole('heading', { name: 'Synthetic image preview' }).waitFor();
    await fs.writeFile(path.join(images, 'missing.png'), png);
    await fs.writeFile(path.join(notes, 'guide.md'), markdown.replace('Synthetic image preview', 'Reloaded image preview'));
    await page.getByRole('button', { name: 'Reload from disk', exact: true }).click();
    await page.getByRole('heading', { name: 'Reloaded image preview' }).waitFor();
    await page.waitForFunction(() => document.querySelectorAll('.md-body img').length === 3 &&
      [...document.querySelectorAll('.md-body img')].every(image => image.complete && image.naturalWidth === 2400));
    if (process.env.PDF_EVIDENCE_DIR) {
      await fs.mkdir(process.env.PDF_EVIDENCE_DIR, { recursive: true });
      await page.screenshot({ path: path.join(process.env.PDF_EVIDENCE_DIR, 'markdown-preview.png') });
    }
    console.log('PASS document switching clears prior images and reload resolves a newly available image');

    await open(external);
    await page.getByRole('heading', { name: 'External document' }).waitFor();
    assert.equal(await page.locator('.md-body img').count(), 0);
    assert.match(await page.locator('.md-body .md-image').innerText(), /external/);
    assert.deepEqual(await application.evaluate(() => global.blockedPdfRequests), []);
    assert.deepEqual(errors, []);
    assert.deepEqual(await fs.readFile(path.join(temporary, 'outside.png')), png);
    console.log('PASS external-document siblings stay inaccessible; no network requests, uncaught page errors or outside-file changes');
  } finally {
    await application.close();
    await fs.rm(temporary, { recursive: true, force: true });
  }
})().catch(error => { console.error(error); process.exitCode = 1; });
