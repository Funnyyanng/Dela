import { useEffect, useId, useRef, useState } from 'react';
import type { CustomRendererProps } from 'streamdown';
import type { MarkdownPdfDocument } from '../../../shared/workspace';
import { renderMermaid } from '../../lib/mermaid';
import { MarkdownPreview } from './MarkdownPreview';
import './markdown-pdf.css';

function PdfMermaid({ code }: CustomRendererProps) {
  const id = useId().replace(/[^a-z0-9_-]/gi, '');
  const [result, setResult] = useState<{ svg: string; error: string }>({ svg: '', error: '' });
  useEffect(() => {
    let active = true;
    void document.fonts.ready
      .then(() => renderMermaid(`pdf-mermaid-${id}`, code))
      .then(
        ({ svg }) => {
          if (active) setResult({ svg, error: '' });
        },
        (cause) => {
          if (active) setResult({ svg: '', error: String(cause) });
        },
      );
    return () => {
      active = false;
    };
  }, [code, id]);
  return (
    <div
      data-pdf-mermaid={result.error ? 'error' : result.svg ? 'ready' : 'pending'}
      data-pdf-error={result.error || undefined}
      dangerouslySetInnerHTML={{ __html: result.svg }}
    />
  );
}

const printPlugins = {
  code: undefined,
  renderers: [{ language: 'mermaid', component: PdfMermaid }],
};

export async function prepareMarkdownPdf(root: HTMLElement) {
  await new Promise<void>((resolve, reject) => {
    const observer = new MutationObserver(inspect);
    function inspect() {
      const failed = root.querySelector<HTMLElement>('[data-pdf-mermaid="error"]');
      if (failed) {
        observer.disconnect();
        reject(new Error(`流程图无法渲染：${failed.dataset.pdfError}`));
      } else if (!root.querySelector('[data-pdf-mermaid="pending"]')) {
        observer.disconnect();
        resolve();
      }
    }
    observer.observe(root, { childList: true, subtree: true, attributes: true });
    inspect();
  });
  await Promise.all(
    [...root.querySelectorAll('img')].map(async (image) => {
      if (!image.complete)
        await new Promise<void>((resolve, reject) => {
          image.addEventListener('load', () => resolve(), { once: true });
          image.addEventListener('error', () => reject(new Error('图片无法载入')), { once: true });
        });
      if (!image.naturalWidth) throw new Error(`图片无法载入：${image.alt || '未命名图片'}`);
      await image.decode();
    }),
  );
  await document.fonts.ready;
  await new Promise<void>((resolve) =>
    requestAnimationFrame(() => requestAnimationFrame(() => resolve())),
  );
  for (const formula of root.querySelectorAll<HTMLElement>('.katex-display')) {
    const width = formula.clientWidth;
    if (width > 0 && formula.scrollWidth > width)
      formula.style.fontSize = `${(width / formula.scrollWidth) * 100}%`;
  }
}

export function MarkdownPdfPage() {
  const [source, setSource] = useState<MarkdownPdfDocument | null>(null);
  const host = useRef<HTMLElement>(null);
  useEffect(() => {
    void window.dela!.workspace.markdownPdfDocument().then(setSource, (cause) => {
      void window.dela!.workspace.markdownPdfReady(String(cause));
    });
  }, []);
  useEffect(() => {
    if (!source || !host.current) return;
    document.title = source.title.replace(/\.(md|markdown)$/i, '');
    void prepareMarkdownPdf(host.current).then(
      () => window.dela!.workspace.markdownPdfReady(null),
      (cause) => window.dela!.workspace.markdownPdfReady(String(cause)),
    );
  }, [source]);
  return (
    <main ref={host} data-markdown-pdf>
      {source && (
        <MarkdownPreview
          entryId={source.entryId}
          value={source.text}
          scroll={0}
          onScroll={() => {}}
          plugins={printPlugins}
          controls={false}
        />
      )}
    </main>
  );
}
