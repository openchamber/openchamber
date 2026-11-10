import React from 'react';
import { Icon } from '@/components/icon/Icon';
import { SETTINGS_SECTION_TITLE_CLASS, SettingsSection } from '@/components/sections/shared/SettingsSection';
import { fetchReleaseNotes, formatReleaseDate, type ReleaseNotesRelease } from '@/components/update/releaseNotes';
import { ReleaseNotesBody } from '@/components/update/ReleaseNotesBody';
import { getCurrentIntlLocale, useI18n } from '@/lib/i18n';
import { formatCanaryBuild, parseCanaryVersion } from '@/lib/updateChannel';

const GITHUB_RELEASES_URL = 'https://github.com/openchamber/openchamber/releases';

type ReleaseCardProps = {
  release: ReleaseNotesRelease;
  /**
   * The release's name and date above its notes, in an update's list. There
   * only the first group opens; the rest wait behind a count line. Without
   * it the section title names the release.
   */
  label: { version: string; date: string | null } | null;
};

const ReleaseCard: React.FC<ReleaseCardProps> = ({ release, label }) => (
  <div className="oc-tile rounded-lg p-4">
    {label && (
      <div className="mb-3 flex items-center gap-3">
        <span className="typography-ui-label rounded bg-[var(--primary-base)]/10 px-1.5 py-0.5 font-mono text-[var(--primary-base)]">
          {label.version}
        </span>
        {label.date && <span className="typography-meta text-muted-foreground">{label.date}</span>}
      </div>
    )}
    <ReleaseNotesBody notes={release} folded={label !== null} />
  </div>
);

type AboutReleaseNotesProps = {
  /** The installed version, or the offered one when `since` is set. */
  version: string;
  /** The installed version while an update to `version` is offered. */
  since: string | null;
  /** "2.5.4 Canary · Oct 30" for a Canary build, with its build number beside a same-day `beside`. */
  describeVersion: (version: string, beside?: string | null) => string;
};

/**
 * What the installed version brought, or what an offered update brings.
 * Nothing shows while the notes load, when they cannot be read, or when the
 * changelog has none for this version.
 */
export const AboutReleaseNotes: React.FC<AboutReleaseNotesProps> = ({ version, since, describeVersion }) => {
  const { t } = useI18n();
  const [loaded, setLoaded] = React.useState<{ key: string; releases: ReleaseNotesRelease[] } | null>(null);
  const requestKey = `${since ?? ''}>${version}`;

  React.useEffect(() => {
    const controller = new AbortController();
    void fetchReleaseNotes(version, since, controller.signal).then((releases) => {
      if (!controller.signal.aborted) setLoaded(releases ? { key: requestKey, releases } : null);
    });
    return () => controller.abort();
  }, [version, since, requestKey]);

  const releases = loaded?.key === requestKey ? loaded.releases : [];
  if (releases.length === 0) return null;

  const single = releases.length === 1 ? releases[0] : null;
  const showDate = single && !since && !parseCanaryVersion(single.version);
  // A Canary night is named by its day, plus its build number when another
  // build of the same day is in the list.
  const canaries = releases.map((release) => parseCanaryVersion(release.version));
  const labelOf = (release: ReleaseNotesRelease, index: number): ReleaseCardProps['label'] => {
    const canary = canaries[index];
    if (!canary) return { version: `v${release.version}`, date: formatReleaseDate(release.date) };
    const sameDay = canaries.find((other, otherIndex) => otherIndex !== index && other?.builtOn.getTime() === canary.builtOn.getTime());
    return { version: t('updateDialog.canary.night', { date: formatCanaryBuild(canary, getCurrentIntlLocale(), sameDay) }), date: null };
  };
  return (
    <SettingsSection
      title={(
        <h2 className={SETTINGS_SECTION_TITLE_CLASS}>
          {since
            ? t('settings.openchamber.about.releaseNotes.since', { version: describeVersion(since, version) })
            : t('settings.openchamber.about.releaseNotes.current', { version: describeVersion(version) })}
          {showDate && <span className="typography-meta whitespace-nowrap text-muted-foreground"> · {formatReleaseDate(single.date)}</span>}
        </h2>
      )}
      headerAction={(
        <a
          href={GITHUB_RELEASES_URL}
          target="_blank"
          rel="noopener noreferrer"
          className="flex items-center gap-1.5 typography-meta text-muted-foreground transition-colors hover:text-foreground"
        >
          {t('settings.openchamber.about.releaseNotes.allReleases')}
          <Icon name="external-link" className="size-3.5" />
        </a>
      )}
      contentClassName="space-y-2"
    >
      {releases.map((release, index) => (
        <ReleaseCard key={release.version} release={release} label={since ? labelOf(release, index) : null} />
      ))}
    </SettingsSection>
  );
};
