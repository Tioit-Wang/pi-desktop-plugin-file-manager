/** PDF read path and stable fit-width regression checks. Run with pnpm verify:pdf. */
import assert from "node:assert/strict";
import { build } from "esbuild";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, truncateSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const pluginMain = join(dirname(fileURLToPath(import.meta.url)), "..", "main.js");
const require = createRequire(pluginMain);
const temporary = mkdtempSync(join(process.env.PI_SCRATCH_DIR || tmpdir(), "pifm-pdf-"));
const alpha = join(temporary, "alpha");
const beta = join(temporary, "beta");
const limit = 24 * 1024 * 1024;
const bytes = Buffer.from("%PDF-1.7\n%\xff\xff\xff\xff\nBinary PDF bytes\0\n%%EOF\n", "binary");
let plugin;

try {
  const fitModule = join(temporary, "pdf-fit.mjs");
  await build({
    entryPoints: [join(dirname(fileURLToPath(import.meta.url)), "src", "lib", "pdfFit.ts")],
    bundle: true, platform: "node", format: "esm", outfile: fitModule, logLevel: "silent",
  });
  const { createPdfFitWidths } = await import(pathToFileURL(fitModule).href);
  const modes = ["single", "double", "cover"];
  const widths = (geometry) => modes.map((mode) => geometry.width(mode));
  for (const count of [23, 24]) {
    const geometry = createPdfFitWidths();
    for (let page = 1; page <= count; page += 1) geometry.add(page, 816);
    assert.deepEqual(widths(geometry), [816, 1632, 1632]);
    for (const page of [count, count - 1, 1, 2, count]) geometry.add(page, 816);
    assert.deepEqual(widths(geometry), [816, 1632, 1632]);
  }
  console.log("ok   23 / 24 页双页布局的封面与末尾落单页保持相同适应宽度");

  const mixed = createPdfFitWidths();
  [816, 1056, 816, 816, 2400, 816, 816].forEach((width, index) => mixed.add(index + 1, width));
  assert.deepEqual(widths(mixed), [2400, 3216, 3216]);
  const twoPages = createPdfFitWidths();
  twoPages.add(1, 816); twoPages.add(2, 1056);
  assert.deepEqual(widths(twoPages), [1056, 1872, 1056]);
  console.log("ok   混合尺寸按实际页面组宽度计算，两页文档的独立封面正确分组");

  const lazy = createPdfFitWidths();
  let previous = widths(lazy);
  for (const [page, width] of [[3, 900], [2, 500], [5, 2400], [4, 300], [1, 400], [6, 200]]) {
    lazy.add(page, width);
    const next = widths(lazy);
    assert.ok(next.every((value, index) => value >= previous[index]));
    previous = next;
  }
  assert.deepEqual(widths(lazy), [2400, 2600, 2700]);
  assert.deepEqual(widths(createPdfFitWidths()), [0, 0, 0]);
  console.log("ok   惰性 / 乱序加载只扩展已知最宽组，新文档不继承旧文档宽度");

  mkdirSync(alpha);
  mkdirSync(beta);
  mkdirSync(join(alpha, ".ssh"));
  for (const root of [alpha, beta]) writeFileSync(join(root, "report.PDF"), bytes);
  writeFileSync(join(alpha, "empty.pdf"), "");
  writeFileSync(join(alpha, "broken.pdf"), "not a PDF");
  writeFileSync(join(alpha, "text.txt"), "ordinary text\n");
  writeFileSync(join(alpha, "archive.bin"), Buffer.from([0, 1, 2]));
  writeFileSync(join(alpha, ".ssh", "private.pdf"), bytes);
  writeFileSync(join(temporary, "outside.pdf"), bytes);
  symlinkSync(join(temporary, "outside.pdf"), join(alpha, "escaped.pdf"));
  writeFileSync(join(alpha, "large.pdf"), bytes);
  truncateSync(join(alpha, "large.pdf"), limit);
  writeFileSync(join(alpha, "over-limit.pdf"), bytes);
  truncateSync(join(alpha, "over-limit.pdf"), limit + 1);

  let settings = { fmPrefs: { watchFiles: false } };
  const workspace = {
    path: alpha, name: "alpha", projectId: "pdf-check",
    roots: [{ path: alpha, name: "alpha", primary: true }, { path: beta, name: "beta" }],
  };
  globalThis.pi = {
    workspace: { get: async () => workspace },
    plugin: {
      getDataPath: async () => join(temporary, "data"),
      getSettings: async () => settings,
      setSettings: async (value) => { settings = value; },
    },
    ui: { showToast: () => {} }, fs: {},
  };
  plugin = require(pluginMain);
  await plugin.onLoad();
  const read = (path, external = false) => plugin.onPanelInvoke("fm.read", { path, external });
  const pdf = await read("report.PDF");
  assert.equal(pdf.kind, "pdf");
  assert.equal(pdf.mime, "application/pdf");
  assert.equal(pdf.size, bytes.length);
  assert.deepEqual(Buffer.from(pdf.dataUri.split(",")[1], "base64"), bytes);
  console.log("ok   .PDF 大小写识别，二进制字节无损传递");

  const boundary = await read("large.pdf");
  assert.equal(boundary.kind, "pdf");
  assert.equal(boundary.size, limit);
  assert.ok(boundary.dataUri.length > limit);
  const oversized = await read("over-limit.pdf");
  assert.equal(oversized.kind, "tooLarge");
  assert.equal(oversized.limit, limit);
  assert.equal(oversized.dataUri, undefined);
  console.log("ok   大于文本上限的 PDF 可读，24 MiB 边界通过，超限不传字节");

  assert.equal((await read("empty.pdf")).kind, "pdf");
  assert.equal((await read("broken.pdf")).kind, "pdf");
  assert.equal((await read("text.txt")).kind, "text");
  assert.equal((await read("archive.bin")).kind, "binary");
  console.log("ok   空 / 损坏 PDF 交给查看器报告，文本与二进制读取保持正确");

  for (const target of ["../outside.pdf", "escaped.pdf", ".ssh/private.pdf", join(temporary, "outside.pdf")]) {
    assert.equal((await read(target)).ok, false, target);
  }
  assert.equal((await read(join(temporary, "outside.pdf"), true)).kind, "pdf");
  assert.equal((await read(join(alpha, ".ssh", "private.pdf"), true)).ok, false);
  console.log("ok   根外路径与符号链接被拒，宿主指定的外部 PDF 可读，凭据仍拒绝");

  await plugin.onPanelInvoke("fm.prefs.set", { partial: { projectRoots: { "p:pdf-check": beta } } });
  assert.equal((await read("report.PDF")).kind, "pdf");
  assert.equal((await read("text.txt")).ok, false);
  console.log("ok   切换文件夹后 PDF 按当前文件夹根读取");
  console.log("PDF VERIFY PASSED");
} finally {
  await plugin?.onUnload();
  delete globalThis.pi;
  rmSync(temporary, { recursive: true, force: true });
}
