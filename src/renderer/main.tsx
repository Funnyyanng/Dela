import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { ErrorBoundary } from './components/ErrorBoundary';
import App from './app/App';
import './styles/globals.css';
import { MarkdownPdfPage } from './content/note/MarkdownPdfPage';

const printingMarkdown = new URLSearchParams(location.search).get('markdown-pdf') === '1';
if (printingMarkdown) {
  document.documentElement.classList.remove('dark');
  document.documentElement.dataset.markdownPdf = '';
}

createRoot(document.getElementById('root')!).render(
  printingMarkdown ? (
    <MarkdownPdfPage />
  ) : (
    <StrictMode>
      {/* 根部兜底：AppShell/侧栏抛错时降级为可重试的错误页，而非整树卸载成白屏。 */}
      <ErrorBoundary title="应用遇到错误">
        <App />
      </ErrorBoundary>
    </StrictMode>
  ),
);
