import { formatAgentStatus, type AgentStatus } from '@/lib/agentStatus';
import { useEasterEggCopy } from '@/lib/easter-eggs/easterEggCopy';
import { thinkingLine } from '@/lib/easter-eggs/lines';
import { useI18n } from '@/lib/i18n';

/**
 * The status row's and the pill's label in the reader's language. A block of
 * reasoning now and then says one of the locale's thinking jokes instead of
 * "thinking"; while the locale's jokes load it says "thinking".
 */
export function useAgentStatusLabel(status: AgentStatus | null, modelName?: string | null): string | null {
  const { t, locale } = useI18n();
  const copy = useEasterEggCopy();
  if (!status) return null;
  const joke = status.key === 'chat.agentStatus.thinking' && status.seed && copy ? thinkingLine(copy, status.seed) : null;
  return formatAgentStatus(t, locale, status, modelName, joke ?? undefined);
}
