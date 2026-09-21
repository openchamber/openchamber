import React from 'react';
import { createPortal } from 'react-dom';

import { Icon } from '@/components/icon/Icon';
import { Button } from '@/components/ui/button';
import { OpenChamberLogo } from '@/components/ui/OpenChamberLogo';
import { useI18n } from '@/lib/i18n';

export const MobileQrScannerOverlay: React.FC<{ onCancel: () => void }> = ({ onCancel }) => {
  const { t } = useI18n();
  const overlayRef = React.useRef<HTMLDivElement>(null);

  React.useLayoutEffect(() => {
    const htmlBackground = {
      value: document.documentElement.style.getPropertyValue('background-color'),
      priority: document.documentElement.style.getPropertyPriority('background-color'),
    };
    const bodyBackground = {
      value: document.body.style.getPropertyValue('background-color'),
      priority: document.body.style.getPropertyPriority('background-color'),
    };
    // The app's reduced-transparency theme deliberately uses an !important
    // background. Use an inline important color while CameraX is behind the
    // WebView; the CSS minifier collapses `background: transparent` in a way
    // that does not reset that important background color on Android WebView.
    document.documentElement.style.setProperty('background-color', 'rgba(0, 0, 0, 0)', 'important');
    document.body.style.setProperty('background-color', 'rgba(0, 0, 0, 0)', 'important');

    // startScan() places CameraX behind the WebView. OpenChamber has several
    // independent portal roots, so hiding only #root (or relying on inherited
    // visibility) can leave a sheet/sidebar painted over the preview. Opacity on
    // each top-level sibling is composited for its whole subtree and cannot be
    // overridden by descendants.
    const hidden = new Map<HTMLElement, { opacity: string; pointerEvents: string }>();
    const hideBodySibling = (node: Node) => {
      if (!(node instanceof HTMLElement) || node === overlayRef.current || hidden.has(node)) return;
      hidden.set(node, { opacity: node.style.opacity, pointerEvents: node.style.pointerEvents });
      node.style.setProperty('opacity', '0');
      node.style.setProperty('pointer-events', 'none');
    };
    Array.from(document.body.children).forEach(hideBodySibling);
    const observer = new MutationObserver((records) => {
      records.forEach((record) => record.addedNodes.forEach(hideBodySibling));
    });
    observer.observe(document.body, { childList: true });

    return () => {
      observer.disconnect();
      hidden.forEach((previous, element) => {
        element.style.opacity = previous.opacity;
        element.style.pointerEvents = previous.pointerEvents;
      });
      if (htmlBackground.value) {
        document.documentElement.style.setProperty('background-color', htmlBackground.value, htmlBackground.priority);
      } else {
        document.documentElement.style.removeProperty('background-color');
      }
      if (bodyBackground.value) {
        document.body.style.setProperty('background-color', bodyBackground.value, bodyBackground.priority);
      } else {
        document.body.style.removeProperty('background-color');
      }
    };
  }, []);

  React.useEffect(() => {
    const handleVisibilityChange = () => {
      if (document.visibilityState === 'hidden') onCancel();
    };
    document.addEventListener('visibilitychange', handleVisibilityChange);
    return () => document.removeEventListener('visibilitychange', handleVisibilityChange);
  }, [onCancel]);

  return createPortal(
    <div
      ref={overlayRef}
      role="dialog"
      aria-modal="true"
      aria-label={t('mobile.connect.scanQr')}
      className="fixed inset-0 z-[1000] flex flex-col bg-transparent px-6 pb-[calc(var(--safe-area-inset-bottom,env(safe-area-inset-bottom,0px))+24px)] pt-[calc(var(--safe-area-inset-top,env(safe-area-inset-top,0px))+24px)] text-foreground"
    >
      <div className="flex flex-1 flex-col items-center justify-center gap-6">
        <div className="aspect-square w-full max-w-72 rounded-[28px] border-2 border-foreground/90 shadow-[0_0_0_9999px_color-mix(in_srgb,var(--surface-background)_18%,transparent)]" aria-hidden />
        <p className="max-w-sm rounded-[16px] border border-border/60 bg-background px-4 py-3 text-center typography-body text-foreground shadow-sm">
          {t('mobile.connect.welcome.scanHint')}
        </p>
      </div>
      <Button type="button" variant="outline" size="lg" className="mx-auto min-h-12 w-full max-w-sm bg-background" onClick={onCancel}>
        <Icon name="close" className="size-[18px]" />
        {t('mobile.instances.cancelEdit')}
      </Button>
    </div>,
    document.body,
  );
};

export const MobileQrConnectionLoading: React.FC = () => {
  const { t } = useI18n();
  return createPortal(
    <div role="status" className="fixed inset-0 z-[1000] flex flex-col items-center justify-center gap-5 bg-background px-6 text-foreground">
      <OpenChamberLogo width={96} height={96} isAnimated />
      <div className="flex items-center gap-2 typography-ui-label text-muted-foreground">
        <Icon name="loader-4" className="size-[18px] animate-spin" />
        <span>{t('mobile.connect.connecting')}</span>
      </div>
    </div>,
    document.body,
  );
};
