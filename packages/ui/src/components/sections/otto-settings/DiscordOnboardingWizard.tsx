import React, { useState } from 'react';
import { Button } from '@/components/ui/button';
import { Icon } from '@/components/icon/Icon';
import { Checkbox } from '@/components/ui/checkbox';
import { useI18n } from '@/lib/i18n';
import { cn } from '@/lib/utils';
import {
  useMessengerStore,
  type MessengerConnection,
} from '@/stores/useMessengerStore';
import { useProjectsStore } from '@/stores/useProjectsStore';

const TOTAL_STEPS = 4;
const DEVELOPER_PORTAL_URL = 'https://discord.com/developers/applications';
const DISCORD_ID_GUIDE_URL =
  'https://support.discord.com/hc/en-us/articles/206346498-Where-can-I-find-my-User-Server-Message-ID';

/** Dense settings actions — same size/weight as Discord header controls. */
const ACTION_BTN = '!font-normal';

type DiscordOnboardingWizardProps = {
  conn: MessengerConnection;
  onScrollToSection?: (section: 'token' | 'guild' | 'channel' | 'test' | 'advanced') => void;
};

export function DiscordOnboardingWizard({
  conn,
}: DiscordOnboardingWizardProps) {
  const { t } = useI18n();
  const step = useMessengerStore((s) => s.onboardingStep) ?? 0;
  const nextOnboardingStep = useMessengerStore((s) => s.nextOnboardingStep);
  const prevOnboardingStep = useMessengerStore((s) => s.prevOnboardingStep);
  const finishOnboarding = useMessengerStore((s) => s.finishOnboarding);
  const updateConnection = useMessengerStore((s) => s.updateConnection);
  const testConnection = useMessengerStore((s) => s.testConnection);
  const saveDiscordConfig = useMessengerStore((s) => s.saveDiscordConfig);
  const fetchDiscordInviteUrl = useMessengerStore((s) => s.fetchDiscordInviteUrl);
  const resolveDiscordGuild = useMessengerStore((s) => s.resolveDiscordGuild);
  const resolveDiscordChannel = useMessengerStore((s) => s.resolveDiscordChannel);
  const sendTestMessage = useMessengerStore((s) => s.sendTestMessage);
  const syncDiscordGuildProjects = useMessengerStore((s) => s.syncDiscordGuildProjects);
  const startDiscordListener = useMessengerStore((s) => s.startDiscordListener);
  const refreshDiscordListenerStatus = useMessengerStore((s) => s.refreshDiscordListenerStatus);
  const refreshBridgeStatus = useMessengerStore((s) => s.refreshBridgeStatus);
  const bridgeStatus = useMessengerStore((s) => s.bridgeStatus);
  const projects = useProjectsStore((s) => s.projects);

  const [tokenInput, setTokenInput] = useState('');
  const [guildInput, setGuildInput] = useState('');
  const [channelInput, setChannelInput] = useState('');
  const [startingListener, setStartingListener] = useState(false);
  const [listenerStatusText, setListenerStatusText] = useState<string | null>(null);

  const hasToken = Boolean(conn.botToken);
  const isConnected = conn.status === 'connected';
  const hasTarget = Boolean(conn.defaultChannelId) || Boolean(conn.discordGuildId);
  const bridgeOn = conn.bridgeEnabled !== false;
  const listenerRunning = Boolean(conn.discordListenerRunning);
  const listenerLive = Boolean(conn.discordListenerRunning && conn.discordListenerConnected);
  const listenerStuck = listenerRunning && !listenerLive && !startingListener;

  const canAdvance = (() => {
    if (step === 0) return hasToken && isConnected;
    if (step === 1) return isConnected;
    if (step === 2) return hasTarget;
    if (step === 3) return bridgeOn && listenerRunning;
    return false;
  })();

  const inputClass =
    'w-full rounded-md border border-border bg-background px-3 py-1.5 typography-ui-label text-foreground focus:outline-none focus:ring-1 focus:ring-ring';

  const handleSaveToken = () => {
    if (!tokenInput.trim()) return;
    updateConnection('discord', { botToken: tokenInput.trim(), enabled: true });
    setTimeout(() => saveDiscordConfig(), 0);
    setTokenInput('');
    setTimeout(() => void testConnection('discord'), 0);
  };

  const buildProjectPayloads = () => {
    const now = new Date().toLocaleString();
    return projects.map((p) => {
      const label = p.label || p.path.split('/').pop() || p.path;
      const lines = [`🤖 Otto sync — ${label}`, '', `Last synced ${now}`];
      return { id: p.id, path: p.path, label, body: lines.join('\n') };
    });
  };

  const buildSummary = () => {
    return [
      '**🤖 Otto sync summary**',
      '',
      `• Projects: ${projects.length}`,
      '',
      `_Sent ${new Date().toLocaleString()}_`,
    ].join('\n');
  };

  const handleNext = () => {
    if (step >= TOTAL_STEPS - 1) {
      finishOnboarding();
      return;
    }
    nextOnboardingStep();
  };

  const handleEnableBridge = (enabled: boolean) => {
    updateConnection('discord', { bridgeEnabled: enabled });
    setTimeout(() => saveDiscordConfig(), 0);
    setTimeout(() => void refreshBridgeStatus('discord'), 0);
  };

  const handleStartListener = async () => {
    setStartingListener(true);
    setListenerStatusText(t('settings.integrations.discord.wizard.step4.listenerStarting'));
    try {
      if (listenerStuck) {
        await useMessengerStore.getState().stopDiscordListener();
      }
      const ok = await startDiscordListener();
      if (!ok) {
        const err = useMessengerStore.getState().connections.find((c) => c.type === 'discord')
          ?.discordListenerError;
        setListenerStatusText(
          t('settings.integrations.discord.wizard.step4.listenerError', {
            error: err ?? 'start failed',
          }),
        );
        return;
      }
      if (
        !useMessengerStore.getState().connections.find((c) => c.type === 'discord')
          ?.discordListenerConnected
      ) {
        setListenerStatusText(t('settings.integrations.discord.wizard.step4.listenerConnecting'));
        await refreshDiscordListenerStatus();
      }
      setListenerStatusText(null);
    } finally {
      setStartingListener(false);
    }
  };

  const stepTitle = (key: Parameters<typeof t>[0]) => (
    <div className="typography-ui-label font-medium text-foreground">{t(key)}</div>
  );

  const stepDescription = (key: Parameters<typeof t>[0]) => (
    <p className="mt-1 typography-meta text-muted-foreground leading-snug">{t(key)}</p>
  );

  return (
    <div
      className="rounded-lg border border-[color-mix(in_srgb,var(--primary-base)_20%,transparent)] bg-[color-mix(in_srgb,var(--primary-base)_5%,var(--background))] p-4 space-y-4"
      data-settings-item="integrations.discord.wizard"
    >
      <div>
        <h4 className="typography-ui-header font-medium text-foreground">
          {t('settings.integrations.discord.wizard.title')}
        </h4>
        <p className="mt-0.5 typography-meta text-muted-foreground">
          {t('settings.integrations.discord.wizard.stepOf', {
            current: step + 1,
            total: TOTAL_STEPS,
          })}
        </p>
      </div>

      <div className="flex gap-1">
        {Array.from({ length: TOTAL_STEPS }, (_, i) => (
          <div
            key={i}
            className={cn(
              'h-1 flex-1 rounded-full transition-colors',
              i <= step ? 'bg-[var(--primary-base)]' : 'bg-[var(--surface-muted)]',
            )}
          />
        ))}
      </div>

      {/* Step 0: Token */}
      {step === 0 && (
        <div className="space-y-4">
          <div>
            {stepTitle('settings.integrations.discord.wizard.step1.title')}
            {stepDescription('settings.integrations.discord.wizard.step1.description')}
          </div>

          <Button
            type="button"
            variant="outline"
            size="xs"
            className={ACTION_BTN}
            onClick={() => window.open(DEVELOPER_PORTAL_URL, '_blank', 'noopener,noreferrer')}
          >
            {t('settings.integrations.discord.wizard.step1.openPortal')}
          </Button>

          <div className="space-y-3">
            <div className="typography-ui-label font-medium text-foreground">
              {t('settings.integrations.discord.wizard.step1.guideTitle')}
            </div>
            <ol className="space-y-3">
              {(
                [
                  {
                    title: 'settings.integrations.discord.wizard.step1.stepNewApp.title',
                    description: 'settings.integrations.discord.wizard.step1.stepNewApp.description',
                  },
                  {
                    title: 'settings.integrations.discord.wizard.step1.stepBotMenu.title',
                    description: 'settings.integrations.discord.wizard.step1.stepBotMenu.description',
                  },
                  {
                    title: 'settings.integrations.discord.wizard.step1.stepResetToken.title',
                    description:
                      'settings.integrations.discord.wizard.step1.stepResetToken.description',
                  },
                  {
                    title: 'settings.integrations.discord.wizard.step1.stepIntent.title',
                    description: 'settings.integrations.discord.wizard.step1.stepIntent.description',
                  },
                ] as const
              ).map((item, index) => (
                <li key={item.title} className="flex gap-3">
                  <span
                    className="mt-0.5 flex size-5 shrink-0 items-center justify-center rounded-full bg-[color-mix(in_srgb,var(--primary-base)_15%,transparent)] typography-micro font-medium text-[var(--primary-base)] tabular-nums"
                    aria-hidden
                  >
                    {index + 1}
                  </span>
                  <div className="min-w-0 space-y-0.5">
                    <div className="typography-ui-label font-medium text-foreground">
                      {t(item.title)}
                    </div>
                    <p className="typography-meta text-muted-foreground leading-snug">
                      {t(item.description)}
                    </p>
                  </div>
                </li>
              ))}
            </ol>
          </div>

          {!hasToken ? (
            <div className="space-y-1.5">
              <label className="typography-ui-label font-medium text-foreground">
                {t('settings.integrations.discord.wizard.step1.tokenLabel')}
              </label>
              <p className="typography-meta text-muted-foreground leading-snug">
                {t('settings.integrations.discord.wizard.step1.tokenHint')}
              </p>
              <div className="flex gap-2">
                <input
                  type="password"
                  value={tokenInput}
                  onChange={(e) => setTokenInput(e.target.value)}
                  placeholder={t('settings.integrations.discord.wizard.step1.tokenLabel')}
                  className={inputClass}
                />
                <Button
                  type="button"
                  size="xs"
                  className={ACTION_BTN}
                  disabled={!tokenInput.trim()}
                  onClick={handleSaveToken}
                >
                  {t('settings.integrations.discord.wizard.step1.saveToken')}
                </Button>
              </div>
            </div>
          ) : (
            <div className="space-y-2">
              <div className="flex items-center gap-2 typography-ui-label text-muted-foreground">
                <Icon name="check" className="size-3.5 text-[var(--status-success)]" />
                {isConnected
                  ? t('settings.integrations.discord.wizard.step1.verified', {
                      username: conn.discordBotUsername ?? 'bot',
                    })
                  : t('settings.integrations.discord.wizard.step1.tokenLabel')}
              </div>
              {!isConnected && (
                <Button
                  type="button"
                  variant="outline"
                  size="xs"
                  className={ACTION_BTN}
                  disabled={conn.status === 'connecting'}
                  onClick={() => void testConnection('discord')}
                >
                  {conn.status === 'connecting'
                    ? t('settings.integrations.discord.wizard.step1.verifying')
                    : t('settings.integrations.discord.wizard.step1.verify')}
                </Button>
              )}
            </div>
          )}
        </div>
      )}

      {/* Step 1: Invite */}
      {step === 1 && (
        <div className="space-y-3">
          <div>
            {stepTitle('settings.integrations.discord.wizard.step2.title')}
            {stepDescription('settings.integrations.discord.wizard.step2.description')}
          </div>
          <p className="typography-meta text-muted-foreground">
            {(conn.discordGuilds?.length ?? 0) > 0
              ? t('settings.integrations.discord.wizard.step2.botInServers', {
                  count: conn.discordGuilds?.length ?? 0,
                })
              : t('settings.integrations.discord.wizard.step2.botNotInServers')}
          </p>
          {conn.discordInviteUrl ? (
            <Button
              type="button"
              variant="outline"
              size="xs"
              className={ACTION_BTN}
              onClick={() => window.open(conn.discordInviteUrl!, '_blank', 'noopener,noreferrer')}
            >
              {t('settings.integrations.discord.wizard.step2.openInvite')}
            </Button>
          ) : (
            <Button
              type="button"
              variant="outline"
              size="xs"
              className={ACTION_BTN}
              onClick={() => void fetchDiscordInviteUrl()}
            >
              {t('settings.integrations.discord.wizard.step2.generateInvite')}
            </Button>
          )}
        </div>
      )}

      {/* Step 2: Channels */}
      {step === 2 && (
        <div className="space-y-3">
          <div>
            {stepTitle('settings.integrations.discord.wizard.step3.title')}
            {stepDescription('settings.integrations.discord.wizard.step3.description')}
            <a
              href={DISCORD_ID_GUIDE_URL}
              target="_blank"
              rel="noreferrer"
              className="mt-1 inline-flex items-center gap-1 typography-meta text-[var(--primary-base)] hover:underline"
            >
              {t('settings.integrations.discord.wizard.step3.idGuideLink')}
            </a>
          </div>
          {!conn.discordGuildId ? (
            <div className="space-y-1.5">
              <label className="typography-ui-label font-medium text-foreground">
                {t('settings.integrations.discord.wizard.step3.guildLabel')}
              </label>
              <p className="typography-meta text-muted-foreground leading-snug">
                {t('settings.integrations.discord.wizard.step3.guildHint')}
              </p>
              <div className="flex gap-2">
                <input
                  type="text"
                  value={guildInput}
                  onChange={(e) => setGuildInput(e.target.value)}
                  placeholder="1234567890123456789"
                  className={inputClass}
                />
                <Button
                  type="button"
                  size="xs"
                  className={ACTION_BTN}
                  disabled={!guildInput.trim()}
                  onClick={() => {
                    const v = guildInput.trim();
                    updateConnection('discord', { discordGuildId: v });
                    setGuildInput('');
                    setTimeout(() => saveDiscordConfig(), 0);
                    setTimeout(() => void resolveDiscordGuild(), 0);
                  }}
                >
                  {t('settings.integrations.discord.wizard.save')}
                </Button>
              </div>
              {conn.discordGuilds && conn.discordGuilds.length > 0 && (
                <div className="flex flex-wrap gap-1 pt-1">
                  {conn.discordGuilds.slice(0, 6).map((g) => (
                    <Button
                      key={g.id}
                      type="button"
                      variant="chip"
                      size="xs"
                      className={ACTION_BTN}
                      onClick={() => {
                        updateConnection('discord', { discordGuildId: g.id, guildName: g.name });
                        setTimeout(() => saveDiscordConfig(), 0);
                        setTimeout(() => void resolveDiscordGuild(), 0);
                      }}
                    >
                      {g.name}
                    </Button>
                  ))}
                </div>
              )}
            </div>
          ) : (
            <div className="flex items-center gap-2 typography-ui-label">
              <Icon name="check" className="size-3.5 text-[var(--status-success)]" />
              <code className="rounded bg-[var(--surface-muted)] px-1.5 py-0.5 typography-micro text-foreground">
                {conn.discordGuildId}
              </code>
              {conn.guildName && (
                <span className="typography-meta text-muted-foreground">{conn.guildName}</span>
              )}
            </div>
          )}
          {!conn.defaultChannelId && (
            <div className="space-y-1.5">
              <label className="typography-ui-label font-medium text-foreground">
                {t('settings.integrations.discord.wizard.step3.channelLabel')}
              </label>
              <p className="typography-meta text-muted-foreground leading-snug">
                {t('settings.integrations.discord.wizard.step3.channelHint')}
              </p>
              <div className="flex gap-2">
                <input
                  type="text"
                  value={channelInput}
                  onChange={(e) => setChannelInput(e.target.value)}
                  placeholder="1234567890123456789"
                  className={inputClass}
                />
                <Button
                  type="button"
                  size="xs"
                  className={ACTION_BTN}
                  disabled={!channelInput.trim()}
                  onClick={() => {
                    const v = channelInput.trim();
                    updateConnection('discord', { defaultChannelId: v });
                    setChannelInput('');
                    setTimeout(() => saveDiscordConfig(), 0);
                    setTimeout(() => void resolveDiscordChannel(), 0);
                  }}
                >
                  {t('settings.integrations.discord.wizard.save')}
                </Button>
              </div>
            </div>
          )}
          {hasTarget && (
            <div className="flex flex-wrap gap-2">
              <Button
                type="button"
                variant="outline"
                size="xs"
                className={ACTION_BTN}
                disabled={conn.lastSyncStatus === 'sending'}
                onClick={() => void sendTestMessage('discord')}
              >
                {t('settings.integrations.discord.wizard.step3.sendTest')}
              </Button>
              {conn.discordGuildId && (
                <Button
                  type="button"
                  variant="outline"
                  size="xs"
                  className={ACTION_BTN}
                  disabled={conn.lastSyncStatus === 'sending'}
                  onClick={() =>
                    void syncDiscordGuildProjects(buildProjectPayloads(), buildSummary())
                  }
                >
                  {t('settings.integrations.discord.wizard.step3.syncNow')}
                </Button>
              )}
            </div>
          )}
        </div>
      )}

      {/* Step 3: Bridge + Listener */}
      {step === 3 && (
        <div className="space-y-3">
          <div>
            {stepTitle('settings.integrations.discord.wizard.step4.title')}
            {stepDescription('settings.integrations.discord.wizard.step4.description')}
          </div>
          <label className="flex cursor-pointer items-center gap-2 py-1">
            <Checkbox
              checked={bridgeOn}
              disabled={!bridgeStatus.enabled}
              onChange={handleEnableBridge}
              ariaLabel={t('settings.integrations.discord.wizard.step4.bridge')}
            />
            <span className="typography-ui-label text-foreground">
              {t('settings.integrations.discord.wizard.step4.bridge')}
            </span>
          </label>
          <div className="flex items-center gap-2">
            <Button
              type="button"
              variant="outline"
              size="xs"
              className={ACTION_BTN}
              disabled={startingListener || (listenerRunning && listenerLive)}
              onClick={() => void handleStartListener()}
            >
              {startingListener ? (
                <Icon name="loader-4" className="size-3.5 animate-spin" />
              ) : null}
              {listenerStuck
                ? t('settings.integrations.discord.wizard.step4.retryListener')
                : t('settings.integrations.discord.wizard.step4.startListener')}
            </Button>
            <span
              className={cn(
                'typography-meta',
                listenerLive
                  ? 'text-[var(--status-success)]'
                  : listenerRunning
                    ? 'text-[var(--status-warning)]'
                    : 'text-muted-foreground',
              )}
            >
              {listenerLive
                ? t('settings.integrations.discord.wizard.step4.listenerLive')
                : listenerRunning
                  ? t('settings.integrations.discord.wizard.step4.listenerConnecting')
                  : t('settings.integrations.discord.wizard.step4.listenerStopped')}
            </span>
          </div>
          {conn.discordListenerError && (
            <p className="typography-meta text-[var(--status-error)]">{conn.discordListenerError}</p>
          )}
          {listenerStatusText && (
            <p className="typography-meta text-muted-foreground">{listenerStatusText}</p>
          )}
          {canAdvance && (
            <p className="typography-meta text-[var(--status-success)]">
              {t('settings.integrations.discord.wizard.step4.complete')}
            </p>
          )}
        </div>
      )}

      {/* Navigation — Back is omitted on the first step */}
      <div
        className={cn(
          'flex items-center gap-2 border-t border-border/60 pt-3',
          step > 0 ? 'justify-between' : 'justify-end',
        )}
      >
        {step > 0 && (
          <Button
            type="button"
            variant="outline"
            size="xs"
            className={ACTION_BTN}
            onClick={() => prevOnboardingStep()}
          >
            {t('settings.integrations.discord.wizard.back')}
          </Button>
        )}
        <Button
          type="button"
          size="xs"
          className={ACTION_BTN}
          disabled={!canAdvance}
          onClick={handleNext}
        >
          {step >= TOTAL_STEPS - 1
            ? t('settings.integrations.discord.wizard.finish')
            : t('settings.integrations.discord.wizard.next')}
        </Button>
      </div>
    </div>
  );
}
