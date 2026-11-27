import { ReferenceFilterPanel, type ReferenceFilterGroup } from '@/components/references/referenceFilterPanel';
import {
  REPOSITORY_PEOPLE_LABEL_KEYS,
  REPOSITORY_STATE_LABEL_KEYS,
} from '@/components/references/referencePickerItems';
import { useI18n } from '@/lib/i18n';
import type { PullRequestComparison } from './pullRequestSelection';
import {
  DEFAULT_PULL_REQUEST_FILTER,
  PULL_REQUEST_PEOPLE,
  PULL_REQUEST_STATES,
  pullRequestFilterChoices,
} from './pullRequestFilter';

export function PullRequestFilterButton({ comparison, mobile = false, positionerClassName }: {
  comparison: PullRequestComparison;
  mobile?: boolean;
  positionerClassName?: string;
}) {
  const { t } = useI18n();
  const { filter, setFilter, stateQualifier, peopleQualifier } = comparison;
  const choices = pullRequestFilterChoices(comparison.prs, filter);
  const anyOf = (values: readonly string[]) => [{ value: '', label: t(REPOSITORY_STATE_LABEL_KEYS.all) }, ...values.map((value) => ({ value, label: value }))];
  const groups: ReferenceFilterGroup[] = [{
    label: [t('references.picker.filter.group.status'), stateQualifier].filter(Boolean).join(' · '),
    value: stateQualifier ? '' : filter.state,
    options: PULL_REQUEST_STATES.map((state) => ({ value: state, label: t(REPOSITORY_STATE_LABEL_KEYS[state]) })),
    onSelect: (next) => {
      const state = PULL_REQUEST_STATES.find((entry) => entry === next);
      if (state) setFilter({ ...filter, state });
    },
    taken: stateQualifier !== null,
  }, {
    label: [t('references.picker.filter.group.people'), peopleQualifier].filter(Boolean).join(' · '),
    value: peopleQualifier ? '' : filter.people,
    options: PULL_REQUEST_PEOPLE.map((people) => ({ value: people, label: t(REPOSITORY_PEOPLE_LABEL_KEYS[people]) })),
    onSelect: (next) => {
      const people = PULL_REQUEST_PEOPLE.find((entry) => entry === next);
      if (people) setFilter({ ...filter, people });
    },
    taken: peopleQualifier !== null,
  }];
  if (choices.repositories.length > 1 || filter.repository) groups.push({
    label: t('session.githubPrPicker.filter.group.repository'),
    value: filter.repository,
    options: anyOf(choices.repositories),
    onSelect: (repository) => setFilter({ ...filter, repository }),
    taken: false,
  });
  const status = filter.state === DEFAULT_PULL_REQUEST_FILTER.state ? '' : t(REPOSITORY_STATE_LABEL_KEYS[filter.state]);
  const people = filter.people === DEFAULT_PULL_REQUEST_FILTER.people ? '' : t(REPOSITORY_PEOPLE_LABEL_KEYS[filter.people]);
  const narrowing = [filter.repository, filter.labels.join(', ')];
  const summary = [stateQualifier ?? status, peopleQualifier ?? people, ...narrowing].filter(Boolean).join(' · ');

  return <ReferenceFilterPanel
    title={t('references.picker.filter.label')}
    summary={summary}
    groups={groups}
    labelSection={choices.labels.length > 0 || filter.labels.length > 0
      ? { kind: 'labels', choices: choices.labels, applied: filter.labels, onChange: (labels) => setFilter({ ...filter, labels }) }
      : null}
    appearance="icon"
    mobile={mobile}
    onClearAll={[status, people, ...narrowing].some(Boolean) ? () => setFilter(DEFAULT_PULL_REQUEST_FILTER) : undefined}
    positionerClassName={positionerClassName}
  />;
}
