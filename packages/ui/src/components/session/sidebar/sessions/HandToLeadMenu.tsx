import { Icon } from '@/components/icon/Icon';
import { toast } from '@/components/ui';
import { useI18n } from '@/lib/i18n';
import type { Session } from '@/lib/opencode/model';
import { handSessionToLead } from '@/sync/session-lead';
import { SessionMenuItemHint } from '../../SessionMenuItemHint';
import type { SessionMenuSlots } from './sessionMenuSlots';
import { useProjectLeads } from './useProjectLeads';

export function HandToLeadMenu({ session, projectId, slots }: { session: Session; projectId: string | null; slots: SessionMenuSlots }) {
  const { Item, Sub, SubTrigger, SubContent } = slots;
  const { t } = useI18n();
  const leads = useProjectLeads(projectId, session.id);
  if (leads.length === 0) return null;
  const handTo = (lead: Session) => {
    void handSessionToLead(session.id, lead.id).catch((error: unknown) => {
      toast.error(t('sessions.sidebar.session.handToLead.failed'), { description: error instanceof Error ? error.message : undefined });
    });
  };
  return (
    <Sub>
      <SessionMenuItemHint hint={t('sessions.sidebar.session.menuHint.handToLead')}>
        <SubTrigger className="w-full [&>svg]:me-1" data-session-hand-to-lead={session.id}>
          <Icon name="lead-flag" className="me-1 h-4 w-4" />
          {t('sessions.sidebar.session.menu.handToLead')}
        </SubTrigger>
      </SessionMenuItemHint>
      <SubContent className="min-w-[200px] max-w-[320px]">
        {leads.map((lead) => (
          <Item key={lead.id} onClick={() => handTo(lead)} data-hand-to-lead-target={lead.id}>
            <span className="truncate">{lead.title || t('sessions.sidebar.session.untitled')}</span>
          </Item>
        ))}
      </SubContent>
    </Sub>
  );
}
