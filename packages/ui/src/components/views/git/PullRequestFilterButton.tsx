import { ReferenceFilterPanel, type ReferenceFilterGroup } from '@/components/references/referenceFilterPanel';
import { useI18n, type I18nKey } from '@/lib/i18n';
import type { PullRequestComparison } from './pullRequestSelection';
import {
  DEFAULT_PULL_REQUEST_FILTER,
  PULL_REQUEST_STATUS_FILTERS,
  pullRequestFilterChoices,
  type PullRequestStatusFilter,
} from './pullRequestFilter';

const STATUS_LABEL_KEYS = {
  all: 'references.picker.filter.state.all',
  open: 'references.picker.filter.open',
  draft: 'references.picker.state.draft',
  closed: 'references.picker.filter.state.closed',
  merged: 'references.picker.filter.state.merged',
} as const satisfies Record<PullRequestStatusFilter, I18nKey>;

export function PullRequestFilterButton({ comparison, mobile = false, positionerClassName }: {
  comparison: PullRequestComparison;
  mobile?: boolean;
  positionerClassName?: string;
}) {
  const { t } = useI18n();
  const { filter, setFilter, stateQualifier } = comparison;
  const choices = pullRequestFilterChoices(comparison.prs, filter);
  const anyOf = (values: readonly string[]) => [{ value: '', label: t(STATUS_LABEL_KEYS.all) }, ...values.map((value) => ({ value, label: value }))];
  const groups: ReferenceFilterGroup[] = [{
    label: [t('references.picker.filter.group.status'), stateQualifier].filter(Boolean).join(' · '),
    value: stateQualifier ? '' : filter.status,
    options: PULL_REQUEST_STATUS_FILTERS.map((status) => ({ value: status, label: t(STATUS_LABEL_KEYS[status]) })),
    onSelect: (next) => {
      const status = PULL_REQUEST_STATUS_FILTERS.find((entry) => entry === next);
      if (status) setFilter({ ...filter, status });
    },
    taken: stateQualifier !== null,
  }];
  if (choices.repositories.length > 1 || filter.repository) groups.push({
    label: t('session.githubPrPicker.filter.group.repository'),
    value: filter.repository,
    options: anyOf(choices.repositories),
    onSelect: (repository) => setFilter({ ...filter, repository }),
    taken: false,
  });
  if (choices.authors.length > 1 || filter.author) groups.push({
    label: t('session.githubPrPicker.filter.group.author'),
    value: filter.author,
    options: anyOf(choices.authors),
    onSelect: (author) => setFilter({ ...filter, author }),
    taken: false,
  });
  const status = filter.status === DEFAULT_PULL_REQUEST_FILTER.status ? '' : t(STATUS_LABEL_KEYS[filter.status]);
  const narrowing = [filter.repository, filter.author, filter.labels.join(', ')];
  const summary = [stateQualifier ?? status, ...narrowing].filter(Boolean).join(' · ');

  return <ReferenceFilterPanel
    title={t('references.picker.filter.label')}
    summary={summary}
    groups={groups}
    labelSection={choices.labels.length > 0 || filter.labels.length > 0
      ? { kind: 'labels', choices: choices.labels, applied: filter.labels, onChange: (labels) => setFilter({ ...filter, labels }) }
      : null}
    appearance="icon"
    mobile={mobile}
    onClearAll={[status, ...narrowing].some(Boolean) ? () => setFilter(DEFAULT_PULL_REQUEST_FILTER) : undefined}
    positionerClassName={positionerClassName}
  />;
}
