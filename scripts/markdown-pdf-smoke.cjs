const { app, dialog } = require('electron');
const { resolve, join } = require('node:path');
const { mkdtempSync, mkdirSync, writeFileSync, readFileSync } = require('node:fs');
const { tmpdir } = require('node:os');
const assert = require('node:assert/strict');

const root = resolve(process.argv[2] || '.');
const profile = mkdtempSync(join(tmpdir(), 'dela-markdown-pdf-'));
app.setAppPath(root);
for (const name of ['userData', 'documents', 'home']) app.setPath(name, profile);
process.argv.push('--terminal-smoke-test', '--hidden');
app.setLoginItemSettings = () => {
  throw new Error('Smoke must not register login items');
};
const directory = join(profile, '课程');
mkdirSync(join(directory, 'assets'), { recursive: true });
const source = join(directory, '导出验证.md');
const output = join(directory, '导出验证.pdf');
const original = '# 源文件保持不变\n';
writeFileSync(source, original);
writeFileSync(
  join(directory, 'assets', '截图 1.png'),
  Buffer.from(
    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aNd0AAAAASUVORK5CYII=',
    'base64',
  ),
);
const markdown = [
  '# Markdown 导出验证',
  '导出当前草稿。Chinese text and selectable English text.',
  '行内公式 $x^2$ 与独立公式：',
  '$$\nV = \\frac{FCF_1}{r-g}\n$$',
  '![本地图片](assets/截图%201.png)',
  '## 长表格',
  [
    '| 编号 | 课程资料 | 数值 |\n|---|---|---|',
    ...Array.from(
      { length: 80 },
      (_, index) => `| ${index + 1} | 财务预测与估值 | ${index * 100} |`,
    ),
  ].join('\n'),
  '## 长代码',
  [
    '```python',
    ...Array.from({ length: 80 }, (_, index) => `value_${index} = ${index}  # print all lines`),
    'print("CODE_END_SENTINEL")',
    '```',
  ].join('\n'),
  '## 页面下方的流程图',
  '```mermaid\nflowchart LR\nA[现金流] --> B[折现率]\nB --> C[公司价值]\n```',
  'EXPORT_END_SENTINEL',
].join('\n\n');

dialog.showSaveDialog = async () => ({ canceled: false, filePath: output });
dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [directory] });
let owner;
let printChecked = false;
const timeout = setTimeout(() => app.exit(1), 75_000);
app.on('browser-window-created', (_event, window) => {
  window.webContents.setBackgroundThrottling(false);
  if (!owner) {
    owner = window;
    window.webContents.once('did-finish-load', () => void run());
    return;
  }
  const print = window.webContents.printToPDF.bind(window.webContents);
  window.webContents.printToPDF = async (options) => {
    const content = await window.webContents.executeJavaScript(`({
      diagrams: document.querySelectorAll('[data-pdf-mermaid="ready"] svg').length,
      pending: document.querySelectorAll('[data-pdf-mermaid="pending"]').length,
      formulas: document.querySelectorAll('.katex').length,
      rows: document.querySelectorAll('tbody tr').length,
      imageReady: document.querySelector('img')?.naturalWidth > 0,
      end: document.body.textContent.includes('EXPORT_END_SENTINEL'),
      codeEnd: document.body.textContent.includes('CODE_END_SENTINEL'),
      long: document.body.scrollHeight > innerHeight,
      background: getComputedStyle(document.body).backgroundColor
    })`);
    assert.equal(content.diagrams, 1);
    assert.equal(content.pending, 0);
    assert.equal(content.formulas, 2);
    assert.equal(content.rows, 80);
    assert.equal(content.imageReady, true);
    assert.equal(content.end, true);
    assert.equal(content.codeEnd, true);
    assert.equal(content.long, true);
    assert.equal(content.background, 'rgb(255, 255, 255)');
    printChecked = true;
    return print(options);
  };
});

async function run() {
  try {
    const result = await owner.webContents.executeJavaScript(`(async () => {
      await window.dela.workspace.importProjectFolder();
      return window.dela.workspace.exportMarkdownPdf(${JSON.stringify(source)}, ${JSON.stringify(markdown)});
    })()`);
    assert.equal(result, output);
    assert.equal(printChecked, true);
    assert.equal(readFileSync(source, 'utf8'), original);
    const bytes = readFileSync(output);
    assert.equal(bytes.subarray(0, 5).toString(), '%PDF-');
    assert.ok(bytes.byteLength > 10_000);
    console.log(JSON.stringify({ status: 'passed', output, bytes: bytes.byteLength }));
    clearTimeout(timeout);
    app.exit(0);
  } catch (error) {
    console.error(error);
    clearTimeout(timeout);
    app.exit(1);
  }
}

require(join(root, 'out/main/index.cjs'));
