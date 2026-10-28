// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { noteAssetUrl } from '../../../shared/note-files';
import { MarkdownPreview } from './MarkdownPreview';

let host: HTMLDivElement;
let root: Root;

beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  host = document.createElement('div');
  document.body.append(host);
  root = createRoot(host);
});

afterEach(async () => {
  await act(async () => root.unmount());
  host.remove();
  vi.unstubAllGlobals();
});

it('阅读模式渲染标题、表格、公式及同目录图片，并保留安全的 URL 过滤', async () => {
  const value = [
    '# 课程笔记',
    '',
    '| 项目 | 金额 |',
    '| --- | --- |',
    '| 现金流 | 100 |',
    '',
    '公式 $x^2$。',
    '',
    '$$\nV = \\frac{FCF}{r-g}\n$$',
    '',
    '![课件截图](assets/截图%201.png)',
    '',
    '[危险链接](javascript:alert%281%29)',
    '',
    '<script>alert(1)</script>',
  ].join('\n');

  await act(async () =>
    root.render(
      <MarkdownPreview entryId="/courses/note.md" value={value} scroll={0} onScroll={() => {}} />,
    ),
  );

  expect(host.querySelector('h1')?.textContent).toBe('课程笔记');
  expect(host.querySelector('td')?.textContent).toBe('现金流');
  expect(host.querySelectorAll('.katex')).toHaveLength(2);
  expect(host.querySelector('img')?.getAttribute('src')).toBe(
    noteAssetUrl('/courses/note.md', 'assets/截图 1.png'),
  );
  expect(host.querySelector('script')).toBeNull();
  expect(host.querySelector('a[href^="javascript:"]')).toBeNull();
  expect(host.querySelector('[contenteditable]')).toBeNull();
});
