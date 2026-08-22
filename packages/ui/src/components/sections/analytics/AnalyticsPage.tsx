import React from "react";
import type { Session } from "@opencode-ai/sdk/v2";
import { useI18n } from "@/lib/i18n";
import {
  aggregateAnalytics,
  formatCompactNumber,
  type AnalyticsPeriod,
  type AnalyticsScope,
} from "@/lib/analytics/aggregate";
import { useDirectoryStore } from "@/stores/useDirectoryStore";
import {
  resolveGlobalSessionDirectory,
  useGlobalSessionsStore,
} from "@/stores/useGlobalSessionsStore";
import { useQuotaStore } from "@/stores/useQuotaStore";
import { useConfigStore } from "@/stores/useConfigStore";
import { getModelDisplayName } from "@/lib/modelDisplay";
import { SettingsPageLayout } from "@/components/sections/shared/SettingsPageLayout";
import { SettingsSection } from "@/components/sections/shared/SettingsSection";
import { QuotaSummary } from "./QuotaSummary";
import { TopSessions } from "./TopSessions";
import { TokenBreakdownChart } from "./TokenBreakdownChart";
import { PromptCachingChart } from "./PromptCachingChart";
import { UsageSummary, type HeroChartType, type HeroMetric, type HeroView } from "./UsageSummary";
import { ActivityStrip } from "./ActivityStrip";
import { StatCardRow } from "./StatCardRow";
import { ChartCard } from "./ChartCard";
import { DailyBarsChart } from "./DailyBarsChart";
import { EfficiencyStats } from "./EfficiencyStats";
import { ActivityRhythmCard } from "./ActivityRhythmCard";
import { Button } from "@/components/ui/button";
import { SortableTabsStrip } from "@/components/ui/sortable-tabs-strip";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Icon } from "@/components/icon/Icon";

import { RankedList } from "./RankedList";
import { useSessionModelUsage } from "./useSessionModelUsage";

type ScopeKind = "project" | "all";

export type AnalyticsTab = "overview" | "trends";

const PERIODS: readonly AnalyticsPeriod[] = [
  "7d",
  "30d",
  "90d",
  "all",
] as const;

/** Exported for tests: pure scope filtering over a session list. */
// eslint-disable-next-line react-refresh/only-export-components
export const filterSessionsForScope = (
  sessions: readonly Session[],
  scope: AnalyticsScope,
  resolveDirectory: (session: Session) => string | null,
): Session[] => {
  if (scope.kind === "all") return [...sessions];
  return sessions.filter((session) => {
    try {
      return resolveDirectory(session) === scope.directory;
    } catch {
      return false;
    }
  });
};

// eslint-disable-next-line react-refresh/only-export-components
export const resolveAnalyticsTab = (value: string): AnalyticsTab =>
  value === "trends" ? "trends" : "overview";

interface SegmentedOption<T extends string> {
  value: T;
  label: string;
}

export function AnalyticsPage() {
  const { t } = useI18n();
  const activeSessions = useGlobalSessionsStore((s) => s.activeSessions);
  const status = useGlobalSessionsStore((s) => s.status);
  const loadSessions = useGlobalSessionsStore((s) => s.loadSessions);
  const currentDirectory = useDirectoryStore((s) => s.currentDirectory);
  const loadQuotaSettings = useQuotaStore((s) => s.loadSettings);
  const fetchAllQuotas = useQuotaStore((s) => s.fetchAllQuotas);
  const providers = useConfigStore((s) => s.providers);

  const [period, setPeriod] = React.useState<AnalyticsPeriod>("30d");
  const [scopeKind, setScopeKind] = React.useState<ScopeKind>("all");
  const [heroMetric, setHeroMetric] = React.useState<HeroMetric>("tokens");
  const [heroView, setHeroView] = React.useState<HeroView>("daily");
  const [heroChartType, setHeroChartType] = React.useState<HeroChartType>("bar");
  const [refreshNonce, setRefreshNonce] = React.useState(0);

  React.useEffect(() => {
    void loadSessions();
    void loadQuotaSettings();
    void fetchAllQuotas();
  }, [loadSessions, loadQuotaSettings, fetchAllQuotas, refreshNonce]);

  const scope: AnalyticsScope = React.useMemo(
    () =>
      scopeKind === "project" && currentDirectory
        ? { kind: "directory", directory: currentDirectory }
        : { kind: "all" },
    [scopeKind, currentDirectory],
  );

  const { modelUsage } = useSessionModelUsage(activeSessions);

  const viewModel = React.useMemo(
    () =>
      aggregateAnalytics(activeSessions, {
        period,
        scope,
        resolveDirectory: resolveGlobalSessionDirectory,
        sessionModelUsage: modelUsage,
      }),
    [activeSessions, period, scope, modelUsage],
  );

  const handleRefresh = React.useCallback(() => {
    setRefreshNonce((nonce) => nonce + 1);
  }, []);

  const resolveModelMeta = React.useCallback(
    (key: string) => {
      const slash = key.lastIndexOf("/");
      const providerID = slash >= 0 ? key.slice(0, slash) : "";
      const modelID = slash >= 0 ? key.slice(slash + 1) : key;
      let provider = providers.find((item) => item.id === providerID);
      let model = provider?.models.find((item) => item.id === modelID);
      // Fallback: some sessions stored a bare model id (no provider prefix) or an
      // unknown provider — search the whole catalog so display name / provider /
      // reasoning still resolve for keys like "glm-5.2".
      if (!model) {
        for (const candidate of providers) {
          const found = candidate.models.find(
            (item) => item.id === modelID || item.id === key,
          );
          if (found) {
            provider = candidate;
            model = found;
            break;
          }
        }
      }
      return {
        displayName: getModelDisplayName(
          model ? { id: model.id, name: model.name } : undefined,
          modelID,
        ),
        providerName: provider?.name,
        providerId: provider?.id,
        reasoning: Boolean(model?.capabilities?.reasoning),
      };
    },
    [providers],
  );

  const weekdayNames = React.useMemo(
    () =>
      Array.from({ length: 7 }, (_, i) =>
        new Intl.DateTimeFormat(undefined, { weekday: "short" }).format(
          new Date(2024, 0, 7 + i),
        ),
      ),
    [],
  );

  const periodOptions = PERIODS.map((value) => ({
    value,
    label: t(`settings.analytics.period.${value}`),
  }));

  const scopeOptions: readonly SegmentedOption<ScopeKind>[] = [
    { value: "project", label: t("settings.analytics.scope.project") },
    { value: "all", label: t("settings.analytics.scope.all") },
  ];

  return (
    <SettingsPageLayout
      title={t("settings.page.analytics.title")}
      headerEnd={
        <div className="flex flex-wrap items-center gap-2 @max-lg:w-[100cqw] @lg:w-110 @lg:-mbs-1">
          <SortableTabsStrip
            items={scopeOptions.map((option) => ({
              id: option.value,
              label: option.label,
              icon: (
                <Icon
                  name={option.value === "project" ? "folder" : "stack"}
                  className="h-4 w-4"
                />
              ),
            }))}
            activeId={scopeKind}
            onSelect={(id) =>
              setScopeKind(id === "project" ? "project" : "all")
            }
            layoutMode="fit"
            variant="active-pill"
            className="grow min-w-60"
          />
          <Select
            value={period}
            onValueChange={(v) => setPeriod(v as AnalyticsPeriod)}
          >
            <SelectTrigger
              size="lg"
              aria-label={t("settings.analytics.period.groupLabel")}
            >
              <Icon name="calendar" className="h-4 w-4 text-muted-foreground" />
              <SelectValue>
                {(value) =>
                  periodOptions.find((option) => option.value === value)
                    ?.label ?? value
                }
              </SelectValue>
            </SelectTrigger>
            <SelectContent>
              {periodOptions.map((option) => (
                <SelectItem key={option.value} value={option.value}>
                  {option.label}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          <Button
            variant="ghost"
            size="icon"
            type="button"
            onClick={handleRefresh}
            className="rounded-lg border border-(--surface-subtle) px-2.5 py-1 typography-ui-label text-muted-foreground transition-colors hover:text-foreground"
            aria-label={t("settings.analytics.action.refresh")}
          >
            <Icon
              name="refresh"
              className={status === "loading" ? "h-4 w-4 animate-spin" : "h-4 w-4"}
            />
          </Button>
        </div>
      }
      showSaveStatus={false}
    >
      {status === "error" && (
        <div className="mb-8 rounded-lg border border-[var(--status-error-border)] bg-[var(--status-error-background)] px-4 py-3">
          <p className="typography-ui-label font-medium text-[var(--status-error)]">
            {t("settings.analytics.state.errorTitle")}
          </p>
        </div>
      )}

      {status !== "error" &&
        viewModel.kpis.sessionCount === 0 &&
        status === "ready" && (
          <p className="pb-8 typography-meta text-muted-foreground">
            {t("settings.analytics.state.empty")}
          </p>
        )}

      <SettingsSection
        divider={false}
        title={t("settings.analytics.summary.title")}
      >
        <UsageSummary
          kpis={viewModel.kpis}
          daily={viewModel.daily}
          byModelDaily={viewModel.byModelDaily}
          byModelDailyCost={viewModel.byModelDailyCost}
          topModelKeys={viewModel.topModelKeys}
          models={viewModel.models}
          metric={heroMetric}
          onChangeMetric={setHeroMetric}
          view={heroView}
          onChangeView={setHeroView}
          chartType={heroChartType}
          onChangeChartType={setHeroChartType}
          deltaEnabled={period !== "all"}
          labels={{
            metrics: {
              tokens: t("settings.analytics.trends.metric.tokens"),
              cost: t("settings.analytics.trends.metric.cost"),
              sessions: t("settings.analytics.trends.metric.sessions"),
            },
            view: {
              daily: t("settings.analytics.summary.view.daily"),
              total: t("settings.analytics.summary.view.total"),
            },
            viewAria: t("settings.analytics.summary.view.aria"),
            chartToggleAria: t("settings.analytics.summary.chartToggleAria"),
            chartTypeBar: t("settings.analytics.summary.chartType.bar"),
            chartTypeLine: t("settings.analytics.summary.chartType.line"),
            topModels: t("settings.analytics.summary.topModels"),
            other: t("settings.analytics.trends.byModel.other"),
            deltaUp: t("settings.analytics.kpi.deltaUp"),
            deltaDown: t("settings.analytics.kpi.deltaDown"),
            deltaNew: t("settings.analytics.kpi.deltaNew"),
            deltaFlat: t("settings.analytics.kpi.deltaFlat"),
            ariaLabel: t("settings.analytics.summary.title"),
          }}
          resolveModelMeta={resolveModelMeta}
        />
      </SettingsSection>

      <SettingsSection title={t("settings.analytics.yearHeatmap.title")}>
        <ActivityStrip
          weeks={viewModel.yearHeatmap}
          kpis={viewModel.kpis}
          labels={{
            metricCaption: t("settings.analytics.trends.metric.tokens"),
            longestStreak: t("settings.analytics.activity.longestStreak"),
            avgPerDay: t("settings.analytics.activity.avgPerDay"),
            avgPerWeek: t("settings.analytics.activity.avgPerWeek"),
            total: t("settings.analytics.activity.total"),
            days: t("settings.analytics.activity.days"),
            heatmap: {
              title: t("settings.analytics.yearHeatmap.title"),
              less: t("settings.analytics.yearHeatmap.less"),
              more: t("settings.analytics.yearHeatmap.more"),
            },
          }}
        />
      </SettingsSection>

      <SettingsSection title={t("settings.analytics.kpi.sectionTitle")}>
        <StatCardRow
          kpis={viewModel.kpis}
          daily={viewModel.daily}
          dailyBreakdown={viewModel.dailyBreakdown}
          deltaEnabled={period !== "all"}
          labels={{
            tokens: t("settings.analytics.kpi.tokens"),
            cost: t("settings.analytics.kpi.cost"),
            sessions: t("settings.analytics.kpi.sessions"),
            cacheHitRate: t("settings.analytics.kpi.cacheHitRate"),
            activeDays: t("settings.analytics.kpi.activeDays"),
            streak: t("settings.analytics.kpi.streak"),
            deltaUp: t("settings.analytics.kpi.deltaUp"),
            deltaDown: t("settings.analytics.kpi.deltaDown"),
            deltaNew: t("settings.analytics.kpi.deltaNew"),
            deltaFlat: t("settings.analytics.kpi.deltaFlat"),
          }}
        />
      </SettingsSection>

      <SettingsSection title={t("settings.analytics.efficiency.title")}>
        <EfficiencyStats
          kpis={viewModel.kpis}
          labels={{
            costPerMillion: t("settings.analytics.efficiency.costPerMillion"),
            costPerSession: t("settings.analytics.efficiency.costPerSession"),
            tokensPerSession: t(
              "settings.analytics.efficiency.tokensPerSession",
            ),
            reasoningShare: t("settings.analytics.efficiency.reasoningShare"),
            avgDuration: t("settings.analytics.efficiency.avgDuration"),
            medianDuration: t("settings.analytics.efficiency.medianDuration"),
            longestDuration: t("settings.analytics.efficiency.longestDuration"),
          }}
        />
      </SettingsSection>

      <SettingsSection title={t("settings.analytics.tab.trends")}>
        <div className="grid gap-3 grid-cols-[repeat(auto-fit,minmax(250px,1fr))]">
          <ChartCard
            title={t("settings.analytics.trends.tokenBreakdown.title")}
          >
            <TokenBreakdownChart
              breakdown={viewModel.dailyBreakdown}
              labels={{
                title: t("settings.analytics.trends.tokenBreakdown.title"),
                ariaLabel: t(
                  "settings.analytics.trends.tokenBreakdown.ariaLabel",
                ),
                prompt: t("settings.analytics.trends.tokenBreakdown.prompt"),
                completion: t(
                  "settings.analytics.trends.tokenBreakdown.completion",
                ),
                reasoning: t(
                  "settings.analytics.trends.tokenBreakdown.reasoning",
                ),
                cached: t("settings.analytics.trends.tokenBreakdown.cached"),
              }}
            />
          </ChartCard>
          <ChartCard title={t("settings.analytics.trends.cache.title")}>
            <PromptCachingChart
              breakdown={viewModel.dailyBreakdown}
              labels={{
                title: t("settings.analytics.trends.cache.title"),
                ariaLabel: t("settings.analytics.trends.cache.ariaLabel"),
                cached: t("settings.analytics.trends.cache.cached"),
                uncached: t("settings.analytics.trends.cache.uncached"),
              }}
            />
          </ChartCard>
          <ChartCard title={t("settings.analytics.chart.sessionsPerDay")}>
            <DailyBarsChart
              daily={viewModel.daily}
              metric="sessions"
              ariaLabel={t("settings.analytics.chart.sessionsPerDay")}
            />
          </ChartCard>
          <ChartCard title={t("settings.analytics.chart.costPerDay")}>
            <DailyBarsChart
              daily={viewModel.daily}
              metric="cost"
              ariaLabel={t("settings.analytics.chart.costPerDay")}
            />
          </ChartCard>
          <ChartCard title={t("settings.analytics.agents.title")}>
            <RankedList
              items={viewModel.byAgent.map((a) => ({
                id: a.agent,
                title: a.agent,
                values: [formatCompactNumber(a.tokens)],
              }))}
              empty={t("settings.analytics.agents.empty")}
            />
          </ChartCard>
          <ActivityRhythmCard
            byWeekdayHour={viewModel.byWeekdayHour}
            labels={{
              title: t("settings.analytics.rhythm.title"),
              ariaLabel: t("settings.analytics.rhythm.hoursAria"),
              weekdayNames,
              less: t("settings.analytics.yearHeatmap.less"),
              more: t("settings.analytics.yearHeatmap.more"),
            }}
          />
        </div>
      </SettingsSection>

      <SettingsSection title={t("settings.analytics.quota.title")}>
        <div className="rounded-lg border bg-card p-3">
          <QuotaSummary
            labels={{
              empty: t("settings.analytics.quota.none"),
              manage: t("settings.analytics.quota.manage"),
            }}
          />
        </div>
      </SettingsSection>

      <SettingsSection title={t("settings.analytics.topSessions.title")}>
        <TopSessions
          entries={viewModel.topSessions}
          labels={{
            open: t("settings.analytics.topSessions.open"),
            empty: t("settings.analytics.topSessions.empty"),
          }}
        />
      </SettingsSection>
    </SettingsPageLayout>
  );
}
