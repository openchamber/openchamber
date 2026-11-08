import type { Components } from 'streamdown';

import { Icon } from '@/components/icon/Icon';
import type { IconName } from '@/components/icon/icons';
import { useI18n } from '@/lib/i18n';
import { markdownAlertKind, type MarkdownAlertKind } from './remarkAlerts';

const alertIconName = {
  note: 'information',
  tip: 'lightbulb',
  important: 'feedback',
  warning: 'alert',
  caution: 'error-warning',
} as const satisfies Record<MarkdownAlertKind, IconName>;

const alertTitleKey = {
  note: 'chat.markdown.alert.note',
  tip: 'chat.markdown.alert.tip',
  important: 'chat.markdown.alert.important',
  warning: 'chat.markdown.alert.warning',
  caution: 'chat.markdown.alert.caution',
} as const satisfies Record<MarkdownAlertKind, string>;

/** A quote, or a GitHub alert (`remarkAlerts`) drawn as a titled callout. */
export const MarkdownBlockquote: NonNullable<Components['blockquote']> = ({ node, children, ...props }) => {
  const { t } = useI18n();
  const kind = markdownAlertKind(node?.properties.dataOcAlert);
  if (!kind) return <blockquote {...props} dir="auto">{children}</blockquote>;
  return (
    <blockquote {...props} dir="auto">
      <p data-oc-alert-title={kind.toUpperCase()}>
        <Icon name={alertIconName[kind]} className="size-4 shrink-0" />
        <span>{t(alertTitleKey[kind])}</span>
      </p>
      {children}
    </blockquote>
  );
};
