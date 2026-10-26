/**
 * What gets Docker going on this computer, under its place in Settings and in the create dialog:
 * the one action OpenChamber can take (install with Homebrew, start Colima, open Docker Desktop),
 * or the step the user takes themselves with the exact command or page, and while Docker answers,
 * a warning when it has too little memory for a space. The host decides which, see
 * `places/docker-setup.js`; this screen shows it and starts the action it offers.
 *
 * While an action runs, its state is read every two seconds, the only reading this does on its
 * own, and only while it is on screen: the user started it and watches it. When it ends well the
 * caller checks the place again, which then answers.
 */

import React from 'react';

import { Icon } from '@/components/icon/Icon';
import { Spinner } from '@/components/ui/spinner';
import { Button } from '@/components/ui/button';
import { copyTextToClipboard } from '@/lib/clipboard';
import { getCurrentIntlLocale, useI18n, type I18nKey } from '@/lib/i18n';
import {
  readDockerSetupJob,
  startDockerSetup,
  type DockerRemedy,
  type DockerSetupAction,
  type DockerSetupJob,
  type SpaceFailure,
  type SpacePlace,
} from '@/lib/spaces/spaces-api';
import { openExternalUrl } from '@/lib/url';
import { failureOfError, spaceFailureText } from './spaceFailureText';

const JOB_POLL_MS = 2_000;

const BREW_URL = 'https://brew.sh';
const LINUX_GUIDE_URL = 'https://docs.docker.com/engine/install/';
const WINDOWS_GUIDE_URL = 'https://docs.docker.com/desktop/setup/install/windows-install/';
const LINUX_START_COMMAND = 'sudo systemctl start docker';
const LINUX_GROUP_COMMAND = 'sudo usermod -aG docker $USER';
const COLIMA_MEMORY_COMMAND = 'colima stop && colima start --memory 6';

type Remedy = {
  text: I18nKey;
  action?: { run: DockerSetupAction; label: I18nKey };
  link?: { url: string; label: I18nKey };
  command?: string;
};

const REMEDIES = {
  install_all: { text: 'spaces.setup.remedy.installAll', action: { run: 'install_all', label: 'spaces.setup.action.install' } },
  install_cli: { text: 'spaces.setup.remedy.installCli', action: { run: 'install_cli', label: 'spaces.setup.action.install' } },
  start_colima: { text: 'spaces.setup.remedy.startColima', action: { run: 'start_colima', label: 'spaces.setup.action.startColima' } },
  start_desktop: { text: 'spaces.setup.remedy.startDesktop', action: { run: 'start_desktop', label: 'spaces.setup.action.startDesktop' } },
  get_brew: { text: 'spaces.setup.remedy.getBrew', link: { url: BREW_URL, label: 'spaces.setup.action.openBrew' } },
  linux_install: { text: 'spaces.setup.remedy.linuxInstall', link: { url: LINUX_GUIDE_URL, label: 'spaces.setup.action.openGuide' } },
  linux_start: { text: 'spaces.setup.remedy.linuxStart', command: LINUX_START_COMMAND },
  permission: { text: 'spaces.setup.remedy.permission', command: LINUX_GROUP_COMMAND },
  windows_install: { text: 'spaces.setup.remedy.windowsInstall', link: { url: WINDOWS_GUIDE_URL, label: 'spaces.setup.action.openGuide' } },
  windows_start: { text: 'spaces.setup.remedy.windowsStart' },
} satisfies Record<DockerRemedy, Remedy>;

/** What the screen shows for a remedy: its text, and the action, link or command it offers. */
const remedyOf = (remedy: DockerRemedy): Remedy => REMEDIES[remedy];

const RUNNING_TEXT = {
  install_all: 'spaces.setup.running.installAll',
  install_cli: 'spaces.setup.running.installCli',
  start_colima: 'spaces.setup.running.startColima',
  start_desktop: 'spaces.setup.running.startDesktop',
} satisfies Record<DockerSetupAction, I18nKey>;

const FAILED_TEXT = {
  install_all: 'spaces.setup.failed.install',
  install_cli: 'spaces.setup.failed.install',
  start_colima: 'spaces.setup.failed.startColima',
  start_desktop: 'spaces.setup.failed.startDesktop',
} satisfies Record<DockerSetupAction, I18nKey>;

/** Memory as people read it: binary gigabytes, one decimal at most. */
const formatMemory = (bytes: number): string => {
  const number = new Intl.NumberFormat(getCurrentIntlLocale(), { maximumFractionDigits: 1 }).format(bytes / 1024 ** 3);
  return `${number} GB`;
};

/** A command the user runs in their own terminal, with a button that copies it. */
const CommandLine: React.FC<{ command: string }> = ({ command }) => {
  const { t } = useI18n();
  const [copied, setCopied] = React.useState(false);
  React.useEffect(() => {
    if (!copied) return;
    const timer = setTimeout(() => setCopied(false), 2_000);
    return () => clearTimeout(timer);
  }, [copied]);
  return (
    <div className="flex max-w-md items-center gap-1 rounded bg-muted/50 ps-2">
      {/* A shell command reads left to right in every language. */}
      <code dir="ltr" className="typography-code min-w-0 flex-1 overflow-x-auto whitespace-nowrap py-1 text-xs text-foreground">{command}</code>
      <Button
        variant="ghost"
        size="icon"
        className="shrink-0"
        aria-label={t('spaces.setup.action.copy')}
        title={t('spaces.setup.action.copy')}
        onClick={() => void copyTextToClipboard(command).then((result) => { if (result.ok) setCopied(true); })}
      >
        <Icon name={copied ? 'check' : 'file-copy'} className="size-3.5" />
      </Button>
    </div>
  );
};

/** The state of the action as the host last said it, read again every two seconds while it runs. */
const useSetupJob = (initial: DockerSetupJob | null, onFinished: () => void) => {
  const [job, setJob] = React.useState<DockerSetupJob | null>(initial);
  React.useEffect(() => { setJob(initial); }, [initial]);
  const finished = React.useRef(onFinished);
  finished.current = onFinished;
  const running = job?.running === true;
  React.useEffect(() => {
    if (!running) return;
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout>;
    const read = () => {
      timer = setTimeout(() => {
        readDockerSetupJob(controller.signal).then((next) => {
          if (controller.signal.aborted) return;
          setJob(next);
          if (next?.running) read();
          // Ended well: Docker answers now, which the place's own check shows.
          else if (next === null) finished.current();
        }, () => {
          // The host went away mid-action: stop reading and check the place, which says what is wrong.
          if (!controller.signal.aborted) { setJob(null); finished.current(); }
        });
      }, JOB_POLL_MS);
    };
    read();
    return () => { controller.abort(); clearTimeout(timer); };
  }, [running]);
  return [job, setJob] as const;
};

type DockerSetupNoticeProps = {
  place: SpacePlace;
  /** Checks the places again, after an action ended or when the user asks. */
  onRecheck: () => void;
  /** Whether the notice carries its own "Check again"; Settings has one beside it already. */
  withCheck?: boolean;
};

export const DockerSetupNotice: React.FC<DockerSetupNoticeProps> = ({ place, onRecheck, withCheck = false }) => {
  const { t } = useI18n();
  const setup = place.setup;
  const [job, setJob] = useSetupJob(setup?.job ?? null, onRecheck);
  const [refusal, setRefusal] = React.useState<SpaceFailure | null>(null);
  const [starting, setStarting] = React.useState(false);
  const [showOutput, setShowOutput] = React.useState(false);

  if (!setup) return null;
  const remedy = place.available || !setup.remedy ? null : remedyOf(setup.remedy);
  const memory = place.available && setup.memory?.low ? setup.memory : null;
  if (!remedy && !memory && !job) return null;

  const start = async (action: DockerSetupAction) => {
    setStarting(true);
    setRefusal(null);
    setShowOutput(false);
    try {
      setJob(await startDockerSetup(action));
    } catch (error) {
      if (!(error instanceof Error)) throw error;
      setRefusal(failureOfError(error));
    } finally {
      setStarting(false);
    }
  };

  if (job?.running) {
    return (
      <p className="flex items-start gap-1.5 typography-meta text-muted-foreground" role="status">
        <Spinner className="mt-[0.2em] h-3.5 w-3.5 shrink-0" />
        <span>{t(RUNNING_TEXT[job.action])}</span>
      </p>
    );
  }

  const memoryText = memory
    ? t(memory.engine === 'colima' ? 'spaces.setup.memory.colima' : memory.engine === 'docker_desktop' ? 'spaces.setup.memory.desktop' : 'spaces.setup.memory.other', { size: formatMemory(memory.bytes) })
    : null;

  return (
    <div className="space-y-2">
      {remedy ? (
        <>
          {/* What the user can do about it: one line with the info mark, as Settings' own notes read. */}
          <p className="flex items-start gap-1.5 typography-meta text-foreground" role="status">
            <Icon name="information" className="mt-[0.2em] h-3.5 w-3.5 shrink-0 text-[var(--status-info)]" />
            <span>{t(remedy.text)}</span>
          </p>
          {remedy.command ? <CommandLine command={remedy.command} /> : null}
        </>
      ) : null}
      {memoryText ? (
        <>
          <p className="flex items-start gap-1.5 typography-meta text-[var(--status-warning)]" role="status">
            <Icon name="error-warning" className="mt-[0.2em] h-3.5 w-3.5 shrink-0" />
            <span>{memoryText}</span>
          </p>
          {memory?.engine === 'colima' ? <CommandLine command={COLIMA_MEMORY_COMMAND} /> : null}
        </>
      ) : null}
      {job?.failure ? (
        <div className="space-y-1" role="alert">
          <p className="typography-meta text-[var(--status-error)]">{t(FAILED_TEXT[job.action])}</p>
          {job.failure.output ? (
            <>
              <button type="button" className="typography-meta text-muted-foreground hover:text-foreground hover:underline" onClick={() => setShowOutput((value) => !value)}>
                {t('spaces.setup.action.details')}
                <Icon name={showOutput ? 'arrow-down-s' : 'arrow-right-s'} className="ms-0.5 inline h-3.5 w-3.5" />
              </button>
              {/* The command's own output, as it printed it: text to show. */}
              {showOutput ? <pre dir="ltr" className="typography-code max-h-40 max-w-md overflow-auto whitespace-pre-wrap break-words rounded bg-muted/50 px-2 py-1 text-xs text-muted-foreground">{job.failure.output}</pre> : null}
            </>
          ) : null}
        </div>
      ) : null}
      {refusal ? <p className="typography-meta text-[var(--status-error)]" role="alert">{spaceFailureText(t, refusal)}</p> : null}
      {remedy?.action || remedy?.link || withCheck ? (
        <div className="flex flex-wrap items-center gap-2">
          {remedy?.action ? (
            <Button size="sm" variant="outline" disabled={starting} onClick={() => { if (remedy.action) void start(remedy.action.run); }}>
              {starting ? <Icon name="loader-4" className="size-3.5 animate-spin" /> : null}
              {t(remedy.action.label)}
            </Button>
          ) : null}
          {remedy?.link ? (
            <Button size="sm" variant="outline" onClick={() => { if (remedy.link) void openExternalUrl(remedy.link.url); }}>
              {t(remedy.link.label)}
              <Icon name="external-link" className="size-3.5" />
            </Button>
          ) : null}
          {withCheck ? (
            <Button size="sm" variant="ghost" className="!font-normal" onClick={onRecheck}>{t('spaces.setup.action.check')}</Button>
          ) : null}
        </div>
      ) : null}
    </div>
  );
};
