import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { ThemeSystemProvider } from '@/contexts/ThemeSystemContext';
import { ThemeProvider } from '@/components/providers/ThemeProvider';
import { I18nProvider, initializeLocale } from '@/lib/i18n';
import { preloadMarkdownRenderer } from '@/components/chat/markdownRendererLoader';
import { A2uiDemoPage } from '@/components/chat/a2ui/A2uiDemoPage';

export function renderA2uiDemo() {
  initializeLocale();
  preloadMarkdownRenderer();
  const rootElement = document.getElementById('root');
  if (!rootElement) throw new Error('Root element not found');
  createRoot(rootElement).render(
    <StrictMode>
      <I18nProvider>
        <ThemeSystemProvider>
          <ThemeProvider>
            <A2uiDemoPage />
          </ThemeProvider>
        </ThemeSystemProvider>
      </I18nProvider>
    </StrictMode>,
  );
}
