import { rankByQuery } from '@/lib/search/fuzzySearch';
import React from 'react';
import { toast } from '@/components/ui';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Icon } from '@/components/icon/Icon';
import type { IconName } from '@/components/icon/icons';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { type IntegrationCatalogStatusTone } from '@/components/sections/integrations/IntegrationCatalogCard';
import { McpOAuthSignIn } from '@/components/sections/mcp/McpOAuthSignIn';
import { MCP_DRAFT_OAUTH_UNSET } from '@/components/sections/mcp/mcpDraft';
import { cn } from '@/lib/utils';
import { runtimeFetch } from '@/lib/runtime-fetch';
import { useI18n, type I18nKey } from '@/lib/i18n';
import { useDirectoryStore } from '@/stores/useDirectoryStore';
import { useMcpConfigStore, type McpDraft } from '@/stores/useMcpConfigStore';
import { useMcpStore } from '@/stores/useMcpStore';
import type { McpServerStatus } from '@/lib/opencode/model';
import { usePluginsStore, type PluginEntry, type RegistryResult } from '@/stores/usePluginsStore';
import { useSkillsStore, type DiscoveredSkill } from '@/stores/useSkillsStore';
import { useSkillsCatalogStore } from '@/stores/useSkillsCatalogStore';
import { useGuestsStore } from '@/lib/guests/store';
import { installGuest, uninstallGuest } from '@/lib/guests/install';
import { loadGuestCatalog } from '@/lib/guests/load-catalog';
import { useUIStore } from '@/stores/useUIStore';
import { brandIconFor } from '@/lib/integrations-catalog/brand-icons';
import { vendorLogoFor } from '@/lib/integrations-catalog/vendor-logos';
import {
  CATALOG_CATEGORY_ORDER,
  CATALOG_ENTRIES,
  CATALOG_FEATURED_IDS,
  getCatalogEntry,
  catalogComponentName,
  catalogEntryHasAllInputs,
  catalogMcpComponent,
  catalogPluginPackageName,
  interpolateCatalogTokens,
  type CatalogCategory,
  type CatalogComponent,
  type CatalogEntry,
  type CatalogMcpComponent,
  type CatalogPluginComponent,
  type CatalogSkillComponent,
} from '@/lib/integrations-catalog/registry';

/** Unique within an entry: an entry may bundle several skills or plugins. */
const catalogComponentKey = (component: CatalogComponent): string => {
  if (component.kind === 'skill') return `skill:${component.subpath}`;
  if (component.kind === 'plugin') return `plugin:${component.spec}`;
  if (component.kind === 'extension') return `extension:${component.guestId}`;
  return 'mcp';
};

/** Where a component can be viewed: the skill's folder on GitHub, the plugin on npm. */
const catalogComponentHref = (component: CatalogComponent): string | null => {
  if (component.kind === 'skill') return `https://github.com/${component.source}/tree/HEAD/${component.subpath}`;
  if (component.kind === 'plugin') return `https://www.npmjs.com/package/${catalogPluginPackageName(component.spec)}`;
  if (component.kind === 'extension') return component.gitUrl;
  return null;
};

const readMcpStatusName = (status: { status: { status: string } } | undefined): string | undefined =>
  status?.status?.status;

type ConfirmRequest =
  | { kind: 'plugin-install'; entry: CatalogEntry; component?: CatalogComponent }
  | { kind: 'uninstall'; entry: CatalogEntry };


// Stable empty references: a selector returning a fresh [] or {} on every
// call re-renders the component forever (Maximum update depth exceeded).
const EMPTY_MCP_SERVERS: never[] = [];
const EMPTY_MCP_STATUSES: Record<string, McpServerStatus> = {};
const EMPTY_PLUGIN_ENTRIES: PluginEntry[] = [];
const EMPTY_GUESTS: import('@/lib/guests/types').InstalledGuest[] = [];
const EMPTY_REGISTRY_INFO: Record<string, RegistryResult> = {};
const EMPTY_SKILLS: DiscoveredSkill[] = [];

/** The name OpenCode reports for a skill: SKILL.md frontmatter when it differs from the folder basename. */
const skillReportedName = (component: CatalogSkillComponent): string => component.skillName ?? component.skillDir;

const requiresNoteKey = {
  node: 'integrationsCatalog.requires.node',
  python: 'integrationsCatalog.requires.python',
  docker: 'integrationsCatalog.requires.docker',
} satisfies Record<'node' | 'python' | 'docker', I18nKey>;

const CATEGORY_LABEL_KEY = {
  product: 'integrationsCatalog.category.product',
  openchamber: 'integrationsCatalog.category.openchamber',
  code: 'integrationsCatalog.category.code',
  design: 'integrationsCatalog.category.design',
  cloud: 'integrationsCatalog.category.cloud',
  data: 'integrationsCatalog.category.data',
  quality: 'integrationsCatalog.category.quality',
  ai: 'integrationsCatalog.category.ai',
  other: 'integrationsCatalog.category.other',
} satisfies Record<CatalogCategory, I18nKey>;

/** What a card's status pill shows. */
type CatalogCardStatus = { label: string; tone: IntegrationCatalogStatusTone };

/** A user-scope MCP draft with the same defaults the Settings → MCP add form uses. */
const buildCatalogMcpDraft = (entry: CatalogEntry, component: CatalogMcpComponent, values: Record<string, string>, token: string): McpDraft => {
  const base: McpDraft = {
    name: entry.id,
    scope: 'user',
    type: 'local',
    command: [],
    url: '',
    environment: [],
    headers: [],
    ...MCP_DRAFT_OAUTH_UNSET,
    oauthAuthServerMetadataUrl: '',
    protocol: 'legacy',
    timeoutStartup: '',
    timeoutCatalog: '',
    timeoutExecution: '',
    codemode: 'default',
    disabled: false,
  };
  if (component.remote) {
    const header = component.remote.tokenHeader;
    const tokenValue = token.trim();
    return {
      ...base,
      type: 'remote',
      url: interpolateCatalogTokens(component.remote.url, values),
      headers: header && (tokenValue !== '' || !component.remote.tokenOptional)
        ? [{ key: header.name, value: `${header.valuePrefix ?? ''}${tokenValue}` }]
        : [],
    };
  }
  const local = component.local;
  return {
    ...base,
    type: 'local',
    command: local ? local.command.map((part) => interpolateCatalogTokens(part, values)) : [],
    timeoutStartup: local?.timeoutMs ? String(local.timeoutMs) : '',
  };
};

const TILE_SIZE = {
  sm: { tile: 'size-5 rounded-[5px]', glyph: 'size-3' },
  md: { tile: 'size-10 rounded-[10px]', glyph: 'size-[22px]' },
  lg: { tile: 'size-16 rounded-2xl', glyph: 'size-9' },
} as const;

/**
 * The entry's mark: its official glyph on a tile in the brand's own color,
 * else the vendor's own app icon, else the generic sprite icon on a neutral
 * tile.
 */
function BrandTile({ entry, size }: { entry: CatalogEntry; size: keyof typeof TILE_SIZE }): React.ReactNode {
  const brand = brandIconFor(entry.id);
  const logo = brand ? undefined : vendorLogoFor(entry.id);
  const { tile, glyph } = TILE_SIZE[size];
  if (logo) {
    return <img src={logo} alt="" draggable={false} className={cn(tile, 'shrink-0 object-cover ring-1 ring-[var(--interactive-border)]')} />;
  }
  return (
    <div
      className={cn(tile, 'flex shrink-0 items-center justify-center ring-1 ring-inset ring-[var(--interactive-border)]', brand ? null : 'bg-[var(--surface-muted)] text-muted-foreground')}
      style={brand ? { backgroundColor: brand.color, color: brand.glyph } : undefined}
    >
      {brand ? (
        <svg viewBox="0 0 24 24" className={glyph} aria-hidden="true">
          <path d={brand.path} fill="currentColor" />
        </svg>
      ) : (
        <Icon name={entry.icon} className={glyph} />
      )}
    </div>
  );
}

/** A section heading with its count, set off by a rule. */
function SectionHeading({ title, count }: { title: string; count?: number }): React.ReactNode {
  return (
    <h2 className="flex items-baseline gap-2 border-b border-[var(--interactive-border)] pb-2.5 text-base font-semibold text-foreground">
      {title}
      {count !== undefined ? <span className="text-sm font-normal text-muted-foreground">{count}</span> : null}
    </h2>
  );
}

const COMPONENT_ICON = {
  mcp: 'server',
  plugin: 'puzzle',
  skill: 'box-3',
  extension: 'apps',
} satisfies Record<CatalogComponent['kind'], IconName>;

export function IntegrationsCatalogView(): React.ReactNode {
  const { t } = useI18n();
  const open = useUIStore((state) => state.isIntegrationsCatalogOpen);
  const setSettingsDialogOpen = useUIStore((state) => state.setSettingsDialogOpen);
  const setSettingsPage = useUIStore((state) => state.setSettingsPage);
  const currentDirectory = useDirectoryStore((state) => state.currentDirectory);

  const mcpServers = useMcpConfigStore((state) => open ? state.mcpServers : EMPTY_MCP_SERVERS);
  const loadMcpConfigs = useMcpConfigStore((state) => state.loadMcpConfigs);
  const createMcp = useMcpConfigStore((state) => state.createMcp);
  const deleteMcp = useMcpConfigStore((state) => state.deleteMcp);
  const setSelectedMcp = useMcpConfigStore((state) => state.setSelectedMcp);
  const refreshMcpStatus = useMcpStore((state) => state.refresh);
  const mcpStatuses = useMcpStore((state) => open ? state.getStatusForDirectory(currentDirectory) : EMPTY_MCP_STATUSES);
  const pluginEntries = usePluginsStore((state) => open ? state.entries : EMPTY_PLUGIN_ENTRIES);
  const pluginRegistryInfo = usePluginsStore((state) => open ? state.registryInfo : EMPTY_REGISTRY_INFO);
  const loadPlugins = usePluginsStore((state) => state.loadPlugins);
  const createPluginEntry = usePluginsStore((state) => state.createEntry);
  const deletePluginEntry = usePluginsStore((state) => state.deleteEntry);
  const setSelectedPlugin = usePluginsStore((state) => state.setSelected);
  const skills = useSkillsStore((state) => open ? state.skills : EMPTY_SKILLS);
  const loadSkills = useSkillsStore((state) => state.loadSkills);
  const installSkills = useSkillsCatalogStore((state) => state.installSkills);
  const guests = useGuestsStore((state) => open ? state.guests : EMPTY_GUESTS);

  const [selectedId, setSelectedId] = React.useState<string | null>(null);
  /** The entry whose OAuth sign-in starts as soon as its detail page can show it, right after install. */
  const [pendingSignInId, setPendingSignInId] = React.useState<string | null>(null);
  const showEntry = React.useCallback((id: string | null) => {
    setSelectedId(id);
    setPendingSignInId(null);
  }, []);

  // Browse and detail share one scroller: a detail page opens at its top,
  // and going back returns the browse list to where it was left.
  const scrollerRef = React.useRef<HTMLElement | null>(null);
  const browseScrollTopRef = React.useRef(0);
  React.useLayoutEffect(() => {
    const scroller = scrollerRef.current;
    if (!scroller) return;
    scroller.scrollTop = selectedId ? 0 : browseScrollTopRef.current;
  }, [selectedId]);
  const [query, setQuery] = React.useState('');
  /** The category chip the browse view is narrowed to; null shows every section. */
  const [category, setCategory] = React.useState<CatalogCategory | null>(null);
  const [busyId, setBusyId] = React.useState<string | null>(null);
  const [confirm, setConfirm] = React.useState<ConfirmRequest | null>(null);
  const [inputValues, setInputValues] = React.useState<Record<string, Record<string, string>>>({});
  const [tokenValues, setTokenValues] = React.useState<Record<string, string>>({});

  React.useEffect(() => {
    if (!open) return;
    void loadMcpConfigs();
    void loadPlugins();
    void loadSkills();
    void loadGuestCatalog();
    void refreshMcpStatus({ directory: currentDirectory });
  }, [open, loadMcpConfigs, loadPlugins, loadSkills, refreshMcpStatus, currentDirectory]);

  React.useEffect(() => {
    if (!open) {
      setSelectedId(null);
      setPendingSignInId(null);
      browseScrollTopRef.current = 0;
      setQuery('');
      setCategory(null);
      setBusyId(null);
      setConfirm(null);
      setInputValues({});
      setTokenValues({});
    }
  }, [open]);

  const readInput = React.useCallback((entry: CatalogEntry, inputId: string): string => {
    const input = entry.inputs?.find((candidate) => candidate.id === inputId);
    return inputValues[entry.id]?.[inputId] ?? input?.defaultValue ?? '';
  }, [inputValues]);

  const setInputValue = React.useCallback((entryId: string, inputId: string, value: string) => {
    setInputValues((prev) => ({ ...prev, [entryId]: { ...prev[entryId], [inputId]: value } }));
  }, []);

  const readToken = React.useCallback((entry: CatalogEntry): string => tokenValues[entry.id] ?? '', [tokenValues]);
  const setTokenValue = (entryId: string, value: string) => setTokenValues((prev) => ({ ...prev, [entryId]: value }));

  const installedMcp = React.useMemo(
    () => new Set(mcpServers.map((server) => server.name)),
    [mcpServers],
  );
  const installedPluginNames = React.useMemo(
    () => new Set(pluginEntries.filter((entry) => entry.parsedKind === 'npm').map((entry) => catalogPluginPackageName(entry.spec))),
    [pluginEntries],
  );
  // The catalog installs skills into the user's OpenCode skills folder, so
  // only a skill there counts; a same-named skill the user keeps elsewhere
  // (another tool's folder, a project) is not the catalog's to show or delete.
  const catalogSkillKeys = React.useMemo(
    () => new Set(skills
      .filter((skill) => skill.scope === 'user' && skill.source === 'opencode')
      .map((skill) => `${skill.path.split(/[\\/]/).at(-2) ?? ''}\u0000${skill.name}`)),
    [skills],
  );
  const installedGuestIds = React.useMemo(
    () => new Set(guests.map((guest) => guest.id)),
    [guests],
  );

  const isMcpInstalled = React.useCallback((entry: CatalogEntry): boolean =>
    installedMcp.has(entry.id), [installedMcp]);
  const isPluginInstalled = React.useCallback((component: CatalogPluginComponent): boolean =>
    installedPluginNames.has(catalogPluginPackageName(component.spec)), [installedPluginNames]);
  const isSkillInstalled = React.useCallback((component: CatalogSkillComponent): boolean =>
    catalogSkillKeys.has(`${component.skillDir}\u0000${skillReportedName(component)}`), [catalogSkillKeys]);
  const isExtensionInstalled = React.useCallback((guestId: string): boolean =>
    installedGuestIds.has(guestId), [installedGuestIds]);

  /** Every installable part of the integration is present. */
  const isComponentInstalled = React.useCallback((entry: CatalogEntry, component: CatalogComponent): boolean => {
    if (component.kind === 'mcp') return isMcpInstalled(entry);
    if (component.kind === 'plugin') return isPluginInstalled(component);
    if (component.kind === 'extension') return isExtensionInstalled(component.guestId);
    return isSkillInstalled(component);
  }, [isExtensionInstalled, isMcpInstalled, isPluginInstalled, isSkillInstalled]);

  /**
   * The integration is set up once its main part is: the MCP server when it
   * ships one, else its first part. Bundled skills are extras; a missing one
   * gets its own Install on the detail page.
   */
  const isEntryInstalled = React.useCallback((entry: CatalogEntry): boolean =>
    isComponentInstalled(entry, catalogMcpComponent(entry) ?? entry.components[0]), [isComponentInstalled]);

  /**
   * Entries with any part installed, for the rail: a bundle whose MCP server
   * is set up but whose skills are not yet is still one the user works with.
   */
  const installedEntries = React.useMemo(
    () => CATALOG_ENTRIES.filter((entry) => entry.components.some((component) => isComponentInstalled(entry, component))),
    [isComponentInstalled],
  );

  const searchResults = React.useMemo(() => {
    const normalizedQuery = query.trim().toLowerCase();
    if (!normalizedQuery) return null;
    return rankByQuery([...CATALOG_ENTRIES], normalizedQuery, (entry) => [
      entry.name,
      entry.publisher,
      t(entry.descriptionKey),
    ]);
  }, [query, t]);

  const componentKindLabelKey = (component: CatalogComponent): I18nKey => {
    if (component.kind === 'plugin') return 'integrationsCatalog.status.plugin';
    if (component.kind === 'skill') return 'integrationsCatalog.status.skill';
    if (component.kind === 'extension') return 'integrationsCatalog.status.extension';
    if (component.local) return 'integrationsCatalog.status.local';
    if (component.auth === 'token') return 'integrationsCatalog.status.token';
    if (component.auth === 'none') return 'integrationsCatalog.status.noAuth';
    return 'integrationsCatalog.status.oauth';
  };

  const statusOf = React.useCallback((entry: CatalogEntry): CatalogCardStatus => {
    // Runtime status outranks everything: a bundled entry whose MCP server
    // asks for sign-in must show it even while its skills are not installed.
    const runtime = readMcpStatusName(mcpStatuses[entry.id]);
    if (runtime === 'needs_auth') return { label: t('integrationsCatalog.status.needsAuth'), tone: 'warning' };
    if (runtime === 'failed') return { label: t('integrationsCatalog.status.failed'), tone: 'warning' };
    if (isEntryInstalled(entry)) {
      const plugin = entry.components.find((component): component is CatalogPluginComponent => component.kind === 'plugin');
      if (plugin) {
        const spec = pluginRegistryInfo[plugin.spec];
        if (spec?.kind === 'npm-ok' && spec.hasUpdate) return { label: t('integrationsCatalog.status.updateAvailable'), tone: 'warning' };
      }
      const server = mcpServers.find((candidate) => candidate.name === entry.id);
      if (server?.disabled) return { label: t('integrationsCatalog.status.disabled'), tone: 'neutral' };
      return { label: t('integrationsCatalog.status.installed'), tone: 'success' };
    }
    return { label: t(componentKindLabelKey(entry.components[0])), tone: 'neutral' };
  }, [isEntryInstalled, mcpServers, mcpStatuses, pluginRegistryInfo, t]);

  const openInSettings = React.useCallback((entry: CatalogEntry) => {
    const mcp = catalogMcpComponent(entry);
    const plugin = entry.components.find((component): component is CatalogPluginComponent => component.kind === 'plugin');
    if (mcp) {
      setSettingsPage('mcp');
      setSelectedMcp(entry.id);
    } else if (plugin) {
      setSettingsPage('plugins');
      const installed = pluginEntries.find((candidate) => catalogPluginPackageName(candidate.spec) === catalogPluginPackageName(plugin.spec));
      setSelectedPlugin(installed?.id ?? null);
    } else {
      setSettingsPage('skills.catalog');
    }
    setSettingsDialogOpen(true);
  }, [pluginEntries, setSettingsDialogOpen, setSelectedMcp, setSelectedPlugin, setSettingsPage]);

  /**
   * Opens Settings on the page that owns one component, with that component
   * selected: MCP → its server page, plugin → its entry, skill → its editor,
   * extension → the extensions page.
   */
  const configureComponent = React.useCallback((entry: CatalogEntry, component: CatalogComponent) => {
    if (component.kind === 'mcp') {
      setSettingsPage('mcp');
      setSelectedMcp(entry.id);
    } else if (component.kind === 'plugin') {
      setSettingsPage('plugins');
      const installed = pluginEntries.find((candidate) => catalogPluginPackageName(candidate.spec) === catalogPluginPackageName(component.spec));
      setSelectedPlugin(installed?.id ?? null);
    } else if (component.kind === 'skill') {
      setSettingsPage('skills.installed');
      useSkillsStore.getState().setSelectedSkill(skillReportedName(component));
    } else {
      setSettingsPage('extensions');
    }
    setSettingsDialogOpen(true);
  }, [pluginEntries, setSettingsDialogOpen, setSelectedMcp, setSelectedPlugin, setSettingsPage]);

  /**
   * One Install pass over every component of the entry: the MCP server, the
   * plugin, and the skills. Already-installed components are skipped, so a
   * re-run cannot fail on "already exists". A plugin keeps its explicit
   * confirmation; skills install with skip-all conflicts so nothing is
   * overwritten silently.
   */
  const installEntry = React.useCallback(async (entry: CatalogEntry, only?: CatalogComponent) => {
    setBusyId(entry.id);
    try {
      let failed = false;
      let errorDetail: string | null = null;
      // Skills of one source install in a single call (one clone), with the
      // repo-root-relative subpath as the selection: the installer
      // sparse-checkouts selections from the repository root.
      const pendingSkills = new Map<string, CatalogSkillComponent[]>();
      for (const component of only ? [only] : entry.components) {
        if (component.kind === 'mcp') {
          if (isMcpInstalled(entry)) continue;
          const token = component.auth === 'token' ? readToken(entry) : '';
          const values: Record<string, string> = {};
          for (const input of entry.inputs ?? []) values[input.id] = readInput(entry, input.id);
          const result = await createMcp(buildCatalogMcpDraft(entry, component, values, token));
          if (!result.ok) {
            failed = true;
            continue;
          }
          if (result.reloadFailed) {
            toast.warning(result.message || t('integrationsCatalog.install.success', { name: entry.name }), {
              description: result.warning || undefined,
            });
          }
          // The config write reaches disk immediately, but OpenCode rereads
          // it on its own schedule; without a reload the mcp_* OAuth
          // integration is missing from integration.list and the sign-in
          // panel below cannot appear. The same reload Settings performs
          // on Apply & Restart.
          try {
            const response = await runtimeFetch('/api/config/reload', { method: 'POST' });
            if (!response.ok) {
              const payload = await response.json().catch(() => null);
              if (payload?.requiresManualRestart) {
                toast.warning(payload?.message ?? undefined);
              }
            }
          } catch {
            // The reload is best-effort: the sign-in panel's own retry
            // (McpOAuthSignIn) still picks the integration up late.
          }
          if (component.auth === 'oauth') {
            setSelectedId(entry.id);
            setPendingSignInId(entry.id);
          }
          try {
            await useMcpStore.getState().connect(entry.id, currentDirectory);
          } catch {
            if (component.auth === 'oauth') {
              // A failed connect is the expected 401 path for an OAuth
              // server: refresh statuses so needs_auth lands in the map and
              // the sign-in panel can open the browser. A real network or
              // server failure shows up as the failed pill instead.
              await useMcpStore.getState().refresh({ directory: currentDirectory, silent: true }).catch(() => undefined);
            } else {
              toast.error(t('integrationsCatalog.connect.failed', { name: entry.name }));
            }
          }
        } else if (component.kind === 'plugin') {
          if (isPluginInstalled(component)) continue;
          const result = await createPluginEntry({ spec: component.spec, scope: 'user' });
          if (!result.ok) failed = true;
        } else if (component.kind === 'extension') {
          if (isExtensionInstalled(component.guestId)) continue;
          const result = await installGuest(component.gitUrl);
          if (!result.ok) {
            failed = true;
            errorDetail = errorDetail ?? result.code;
          }
        } else {
          if (isSkillInstalled(component)) continue;
          const batch = pendingSkills.get(component.source) ?? [];
          batch.push(component);
          pendingSkills.set(component.source, batch);
        }
      }
      for (const [source, batch] of pendingSkills) {
        const response = await installSkills({
          source,
          scope: 'user',
          selections: batch.map((component) => ({ skillDir: component.subpath })),
          conflictPolicy: 'skipAll',
        });
        if (!response.ok) {
          failed = true;
          errorDetail = response.error?.message ?? errorDetail;
        }
      }
      if (failed) {
        toast.error(t('integrationsCatalog.install.failed', { name: entry.name }), {
          description: errorDetail ?? undefined,
        });
      } else {
        toast.success(t('integrationsCatalog.install.success', { name: entry.name }));
      }
    } finally {
      setBusyId(null);
    }
  }, [createMcp, createPluginEntry, currentDirectory, installSkills, isExtensionInstalled, isMcpInstalled, isPluginInstalled, isSkillInstalled, readInput, readToken, t]);

  /** One Uninstall pass: removes the MCP server, the plugin entries, and the installed skills. */
  const uninstallEntry = React.useCallback(async (entry: CatalogEntry) => {
    setBusyId(entry.id);
    setConfirm(null);
    try {
      let failed = false;
      let errorDetail: string | null = null;
      const mcp = catalogMcpComponent(entry);
      if (mcp && isMcpInstalled(entry)) {
        const result = await deleteMcp(entry.id);
        if (!result.ok) {
          failed = true;
          errorDetail = t('integrationsCatalog.uninstall.mcpDetail', { name: entry.id });
        }
      }
      for (const component of entry.components) {
        if (component.kind === 'plugin' && isPluginInstalled(component)) {
          const installed = pluginEntries.find((candidate) => catalogPluginPackageName(candidate.spec) === catalogPluginPackageName(component.spec));
          if (installed) {
            const result = await deletePluginEntry(installed.id);
            if (!result.ok) {
              failed = true;
              errorDetail = t('integrationsCatalog.uninstall.pluginDetail', { spec: component.spec });
            }
          }
        }
        if (component.kind === 'extension' && isExtensionInstalled(component.guestId)) {
          const result = await uninstallGuest(component.guestId);
          if (!result.ok) {
            failed = true;
            errorDetail = t('integrationsCatalog.uninstall.extensionDetail', { name: component.guestId });
          }
        }
        // Deletion keys on the folder basename, while the installed check also
        // matches the SKILL.md frontmatter name; the two differ for some
        // vendors (Vercel's react skill). Only the catalog's own copy goes.
        if (component.kind === 'skill' && isSkillInstalled(component)) {
          const ok = await useSkillsStore.getState().deleteSkill(component.skillDir, currentDirectory, { scope: 'user', source: 'opencode' });
          if (!ok) {
            failed = true;
            errorDetail = t('integrationsCatalog.uninstall.skillDetail', { name: component.skillDir });
          }
        }
      }
      if (failed) {
        toast.error(t('integrationsCatalog.uninstall.failed', { name: entry.name }), {
          description: errorDetail ?? undefined,
        });
      } else {
        toast.success(t('integrationsCatalog.uninstall.success', { name: entry.name }));
      }
    } finally {
      setBusyId(null);
    }
  }, [currentDirectory, deleteMcp, deletePluginEntry, isExtensionInstalled, isMcpInstalled, isPluginInstalled, isSkillInstalled, pluginEntries, t]);

  const canInstallEntry = (entry: CatalogEntry): boolean => {
    const mcp = catalogMcpComponent(entry);
    if (!mcp) return true;
    if (mcp.auth === 'token') {
      const token = readToken(entry);
      return token.trim() !== '' || mcp.remote?.tokenOptional === true;
    }
    return catalogEntryHasAllInputs(entry, Object.fromEntries((entry.inputs ?? []).map((input) => [input.id, readInput(entry, input.id)])));
  };

  const statusTextClass = (tone: IntegrationCatalogStatusTone): string => {
    if (tone === 'success') return 'text-[var(--status-success)]';
    if (tone === 'warning') return 'text-[var(--status-warning)]';
    return 'text-muted-foreground';
  };

  /** Install, or the detail page when the entry still needs a token or a field filled in there. */
  const requestInstall = (entry: CatalogEntry) => {
    if (!canInstallEntry(entry)) {
      showEntry(entry.id);
      return;
    }
    if (entry.components.some((component) => component.kind === 'plugin')) {
      setConfirm({ kind: 'plugin-install', entry });
      return;
    }
    void installEntry(entry);
  };

  /** The end of a browse row: install, progress, or where the entry stands. */
  const renderRowAction = (entry: CatalogEntry): React.ReactNode => {
    if (busyId === entry.id) {
      return (
        <span className="flex size-8 shrink-0 items-center justify-center" aria-label={t('integrationsCatalog.action.installing')}>
          <Icon name="loader-4" className="size-4 animate-spin text-muted-foreground" />
        </span>
      );
    }
    const status = statusOf(entry);
    // A server asking for sign-in outranks a bundle part still missing.
    if (status.tone === 'warning') {
      return <span className={cn('shrink-0 typography-micro', statusTextClass(status.tone))}>{status.label}</span>;
    }
    if (!isEntryInstalled(entry)) {
      return (
        <Button
          variant="ghost"
          size="icon"
          className="shrink-0 rounded-full text-muted-foreground hover:text-foreground"
          aria-label={t('integrationsCatalog.action.installNamed', { name: entry.name })}
          title={t('integrationsCatalog.action.install')}
          onClick={(event) => {
            event.stopPropagation();
            requestInstall(entry);
          }}
        >
          <Icon name="add" className="size-5" />
        </Button>
      );
    }
    if (status.tone === 'success') {
      return (
        <span className="flex size-8 shrink-0 items-center justify-center" title={status.label}>
          <Icon name="check" className="size-4 text-[var(--status-success)]" aria-label={status.label} />
        </span>
      );
    }
    return <span className={cn('shrink-0 typography-micro', statusTextClass(status.tone))}>{status.label}</span>;
  };

  const renderRow = (entry: CatalogEntry): React.ReactNode => (
    <div
      key={entry.id}
      role="button"
      tabIndex={0}
      onClick={() => showEntry(entry.id)}
      onKeyDown={(event) => {
        if (event.target !== event.currentTarget) return;
        if (event.key === 'Enter' || event.key === ' ') {
          event.preventDefault();
          showEntry(entry.id);
        }
      }}
      className="group flex min-w-0 cursor-pointer items-center gap-3 rounded-xl py-2.5 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--interactive-focus-ring)]"
    >
      <BrandTile entry={entry} size="md" />
      <div className="min-w-0 flex-1">
        <div className="flex min-w-0 items-center gap-1.5">
          <span className="truncate text-sm font-medium text-foreground">{entry.name}</span>
          {entry.status === 'beta' ? (
            <span className="shrink-0 rounded-full bg-[var(--surface-muted)] px-1.5 typography-micro text-muted-foreground">{t('integrationsCatalog.status.beta')}</span>
          ) : null}
        </div>
        <p className="truncate text-sm text-muted-foreground transition-colors group-hover:text-foreground/80">{t(entry.descriptionKey)}</p>
      </div>
      {renderRowAction(entry)}
    </div>
  );

  const renderRows = (entries: readonly CatalogEntry[]): React.ReactNode => (
    <div className="mt-2 grid gap-x-10 [grid-template-columns:repeat(auto-fill,minmax(300px,1fr))]">
      {entries.map((entry) => renderRow(entry))}
    </div>
  );

  const entriesIn = (target: CatalogCategory): CatalogEntry[] =>
    CATALOG_ENTRIES.filter((entry) => entry.categories.includes(target));

  const renderBrowseSections = (): React.ReactNode => {
    if (searchResults) {
      return searchResults.length === 0 ? (
        <p className="py-16 text-center text-sm text-muted-foreground">{t('integrationsCatalog.empty.noMatches', { query: query.trim() })}</p>
      ) : (
        <section>
          <SectionHeading title={t('integrationsCatalog.section.results')} count={searchResults.length} />
          {renderRows(searchResults)}
        </section>
      );
    }
    if (category) {
      const entries = entriesIn(category);
      return (
        <section>
          <SectionHeading title={t(CATEGORY_LABEL_KEY[category])} count={entries.length} />
          {renderRows(entries)}
        </section>
      );
    }
    const featured = CATALOG_FEATURED_IDS.flatMap((id) => {
      const entry = getCatalogEntry(id);
      return entry ? [entry] : [];
    });
    return (
      <div className="flex flex-col gap-10">
        <section>
          <SectionHeading title={t('integrationsCatalog.section.featured')} />
          {renderRows(featured)}
        </section>
        {CATALOG_CATEGORY_ORDER.map((target) => {
          const entries = entriesIn(target);
          if (entries.length === 0) return null;
          return (
            <section key={target}>
              <h2 className="border-b border-[var(--interactive-border)] pb-2.5">
                <button
                  type="button"
                  onClick={() => setCategory(target)}
                  className="group/heading inline-flex items-center gap-1 text-base font-semibold text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--interactive-focus-ring)] rounded-sm"
                >
                  {t(CATEGORY_LABEL_KEY[target])}
                  <span className="ms-1 text-sm font-normal text-muted-foreground">{entries.length}</span>
                  <Icon name="arrow-right-s" className="size-4 text-muted-foreground transition-transform group-hover/heading:translate-x-0.5 rtl:group-hover/heading:-translate-x-0.5" />
                </button>
              </h2>
              {renderRows(entries)}
            </section>
          );
        })}
      </div>
    );
  };

  const renderBrowse = (): React.ReactNode => (
    <div className="mx-auto w-full max-w-[920px] px-8 pb-12">
      <div className="flex flex-wrap items-center justify-between gap-x-6 gap-y-3">
        <h1 className="min-w-0 text-2xl font-semibold text-foreground">{t('integrationsCatalog.page.title')}</h1>
        <div className="relative w-full max-w-xs">
          <Icon
            name="search"
            className="pointer-events-none absolute inset-s-2.5 top-1/2 size-3.5 -translate-y-1/2 text-muted-foreground"
            aria-hidden
          />
          <Input
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            placeholder={t('integrationsCatalog.search.placeholder')}
            aria-label={t('integrationsCatalog.search.placeholder')}
            className="ps-8"
          />
        </div>
      </div>

      {searchResults ? null : (
        <div className="mt-4 flex flex-wrap gap-1.5" role="group" aria-label={t('integrationsCatalog.info.category')}>
          <Button variant="chip" size="sm" className="rounded-full" aria-pressed={category === null} onClick={() => setCategory(null)}>
            {t('integrationsCatalog.category.all')}
          </Button>
          {CATALOG_CATEGORY_ORDER.map((target) => (
            <Button
              key={target}
              variant="chip"
              size="sm"
              className="rounded-full"
              aria-pressed={category === target}
              onClick={() => setCategory(category === target ? null : target)}
            >
              {t(CATEGORY_LABEL_KEY[target])}
            </Button>
          ))}
        </div>
      )}

      <div className="mt-8">{renderBrowseSections()}</div>
    </div>
  );

  /** The rail: back to browsing, then every installed integration with its state. */
  const renderRail = (): React.ReactNode => (
    <aside className="flex w-56 shrink-0 flex-col border-e border-border/50">
      <div className="flex-1 overflow-y-auto p-2">
        <button
          type="button"
          onClick={() => showEntry(null)}
          aria-pressed={!selectedEntry}
          className={cn(
            'flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-start typography-ui-label transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring',
            !selectedEntry ? 'bg-interactive-selection text-interactive-selection-foreground' : 'text-muted-foreground hover:text-foreground',
          )}
        >
          <Icon name="compass-3" className="size-4 shrink-0" />
          <span className="min-w-0 flex-1 truncate">{t('integrationsCatalog.rail.discover')}</span>
        </button>

        <div className="mt-5 flex items-baseline gap-1.5 px-2 pb-1.5 typography-micro font-medium text-muted-foreground">
          {t('integrationsCatalog.filter.installed')}
          <span className="text-muted-foreground/70">{installedEntries.length}</span>
        </div>
        {installedEntries.length === 0 ? (
          <p className="px-2 typography-micro text-muted-foreground/80">{t('integrationsCatalog.rail.installedEmpty')}</p>
        ) : installedEntries.map((entry) => {
          const selected = selectedId === entry.id;
          const status = statusOf(entry);
          return (
            <button
              key={entry.id}
              type="button"
              onClick={() => showEntry(entry.id)}
              aria-pressed={selected}
              className={cn(
                'flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-start typography-ui-label transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring',
                selected ? 'bg-interactive-selection text-interactive-selection-foreground' : 'text-foreground/80 hover:text-foreground',
              )}
            >
              <BrandTile entry={entry} size="sm" />
              <span className="min-w-0 flex-1 truncate">{entry.name}</span>
              {status.tone === 'warning' ? (
                <span className="size-1.5 shrink-0 rounded-full bg-[var(--status-warning)]" title={status.label} aria-label={status.label} />
              ) : null}
            </button>
          );
        })}
      </div>
    </aside>
  );

  /** Token field, picker inputs and prerequisites, shown before the first install. */
  const renderSetup = (entry: CatalogEntry, mcp: CatalogMcpComponent): React.ReactNode => {
    const needsToken = mcp.auth === 'token' && Boolean(mcp.remote);
    const notes = [
      ...(mcp.local ? [...(mcp.local.requires ?? []).map((requirement) => t(requiresNoteKey[requirement])), t('integrationsCatalog.local.note'), t('integrationsCatalog.requires.prefix')] : []),
      ...(mcp.auth === 'oauth' && mcp.remote ? [t('integrationsCatalog.oauth.note')] : []),
    ];
    if (!needsToken && !entry.inputs && notes.length === 0) return null;
    return (
      <section className="flex flex-col gap-3">
        <SectionHeading title={t('integrationsCatalog.detail.setup')} />
        {entry.inputs?.map((input) => (
          <div key={input.id} className="flex flex-wrap items-center gap-x-4 gap-y-1.5">
            <label htmlFor={`catalog-input-${entry.id}-${input.id}`} className="w-36 shrink-0 text-sm text-muted-foreground">
              {t(input.labelKey)}
            </label>
            <Input
              id={`catalog-input-${entry.id}-${input.id}`}
              value={readInput(entry, input.id)}
              onChange={(event) => setInputValue(entry.id, input.id, event.target.value)}
              placeholder={input.placeholder}
              className="max-w-xs"
            />
          </div>
        ))}
        {needsToken ? (
          <div className="flex flex-wrap items-center gap-x-4 gap-y-1.5">
            <label htmlFor={`catalog-token-${entry.id}`} className="w-36 shrink-0 text-sm text-muted-foreground">
              {t('integrationsCatalog.token.label')}
            </label>
            <Input
              id={`catalog-token-${entry.id}`}
              type="password"
              autoComplete="off"
              value={readToken(entry)}
              onChange={(event) => setTokenValue(entry.id, event.target.value)}
              placeholder={t('integrationsCatalog.token.placeholder')}
              className="max-w-xs"
            />
            {mcp.tokenHelpUrl ? (
              <a href={mcp.tokenHelpUrl} target="_blank" rel="noreferrer" className="inline-flex items-center gap-1 text-sm text-muted-foreground transition-colors hover:text-foreground">
                {t('integrationsCatalog.token.getToken')}
                <Icon name="external-link" className="size-3.5" />
              </a>
            ) : null}
          </div>
        ) : null}
        {needsToken && mcp.remote?.tokenOptional ? (
          <p className="text-sm text-muted-foreground">{t('integrationsCatalog.token.optional')}</p>
        ) : null}
        {notes.length > 0 ? <p className="text-sm text-muted-foreground">{notes.join(' ')}</p> : null}
      </section>
    );
  };

  /** Where the installed MCP server stands, with the sign-in when it asks for one. */
  const renderConnection = (entry: CatalogEntry): React.ReactNode => {
    const runtime = readMcpStatusName(mcpStatuses[entry.id]);
    const disabled = mcpServers.find((candidate) => candidate.name === entry.id)?.disabled === true;
    const state: { label: string; tone: IntegrationCatalogStatusTone } = disabled
      ? { label: t('integrationsCatalog.status.disabled'), tone: 'neutral' }
      : runtime === 'connected'
        ? { label: t('integrationsCatalog.connection.connected'), tone: 'success' }
        : runtime === 'needs_auth'
          ? { label: t('integrationsCatalog.status.needsAuth'), tone: 'warning' }
          : runtime === 'failed'
            ? { label: t('integrationsCatalog.status.failed'), tone: 'warning' }
            : { label: t('integrationsCatalog.connection.idle'), tone: 'neutral' };
    return (
      <section className="flex flex-col gap-3">
        <SectionHeading title={t('integrationsCatalog.detail.connection')} />
        <div className="rounded-xl border border-[var(--interactive-border)] bg-[var(--surface-elevated)] p-4">
          <div className="flex items-center gap-3">
            <BrandTile entry={entry} size="sm" />
            <span className="min-w-0 flex-1 truncate text-sm text-foreground">{entry.name}</span>
            <span className={cn('flex shrink-0 items-center gap-1.5 text-sm', statusTextClass(state.tone))}>
              <span className="size-1.5 rounded-full bg-current" aria-hidden />
              {state.label}
            </span>
          </div>
          {runtime === 'needs_auth' && !disabled ? (
            <div className="mt-4 border-t border-[var(--interactive-border)] pt-4">
              <p className="mb-3 text-sm text-muted-foreground">{t('integrationsCatalog.oauth.waiting')}</p>
              <McpOAuthSignIn
                serverName={entry.id}
                directory={currentDirectory}
                autoStart={pendingSignInId === entry.id}
                onConnected={() => { void useMcpStore.getState().connect(entry.id, currentDirectory); }}
              />
            </div>
          ) : null}
        </div>
      </section>
    );
  };

  /** One part of the integration: what it is, where it comes from, and whether it is installed. */
  const renderComponentRow = (entry: CatalogEntry, component: CatalogComponent): React.ReactNode => {
    const componentInstalled = isComponentInstalled(entry, component);
    const href = catalogComponentHref(component);
    const detail = component.kind === 'mcp'
      ? component.remote
        ? interpolateCatalogTokens(component.remote.url, Object.fromEntries((entry.inputs ?? []).map((input) => [input.id, readInput(entry, input.id)])))
        : component.local?.command.join(' ') ?? null
      : component.kind === 'skill'
        ? `${component.source} · ${component.subpath}`
        : component.kind === 'plugin'
          ? [component.spec, component.license].filter(Boolean).join(' · ')
          : component.gitUrl;

    return (
      <div key={catalogComponentKey(component)} className="flex items-center gap-3 py-3">
        <div className="flex size-9 shrink-0 items-center justify-center rounded-lg bg-[var(--surface-muted)] text-muted-foreground">
          <Icon name={COMPONENT_ICON[component.kind]} className="size-4" />
        </div>
        <div className="min-w-0 flex-1">
          <div className="truncate text-sm text-foreground">{catalogComponentName(entry, component)}</div>
          {detail ? <div className="truncate font-mono text-xs text-muted-foreground" dir="ltr">{detail}</div> : null}
          {component.kind === 'skill' && component.termsUrl ? (
            <a href={component.termsUrl} target="_blank" rel="noreferrer" className="mt-0.5 inline-flex items-center gap-1 text-xs text-muted-foreground transition-colors hover:text-foreground">
              {t('integrationsCatalog.component.terms')}
              <Icon name="external-link" className="size-3" />
            </a>
          ) : null}
        </div>
        <div className="flex shrink-0 items-center gap-0.5">
          {componentInstalled ? (
            <>
              <span className="me-1 flex items-center gap-1 typography-micro text-[var(--status-success)]">
                <Icon name="check" className="size-3.5" />
                {t('integrationsCatalog.status.installed')}
              </span>
              <Button
                variant="ghost"
                size="icon"
                className="size-7 text-muted-foreground hover:text-foreground"
                aria-label={t('integrationsCatalog.action.configure')}
                title={t('integrationsCatalog.action.configure')}
                onClick={() => configureComponent(entry, component)}
              >
                <Icon name="settings-3" className="size-4" />
              </Button>
            </>
          ) : isEntryInstalled(entry) ? (
            <Button
              variant="outline"
              size="xs"
              className="me-1"
              disabled={busyId === entry.id}
              onClick={() => {
                if (component.kind === 'plugin') setConfirm({ kind: 'plugin-install', entry, component });
                else void installEntry(entry, component);
              }}
            >
              {t('integrationsCatalog.action.install')}
            </Button>
          ) : null}
          {href ? (
            <Button variant="ghost" size="icon" className="size-7 text-muted-foreground hover:text-foreground" asChild>
              <a href={href} target="_blank" rel="noreferrer" aria-label={t('integrationsCatalog.info.source')} title={t('integrationsCatalog.info.source')}>
                <Icon name="external-link" className="size-4" />
              </a>
            </Button>
          ) : null}
        </div>
      </div>
    );
  };

  const renderComponentGroup = (entry: CatalogEntry, kind: CatalogComponent['kind'], titleKey: I18nKey): React.ReactNode => {
    const components = entry.components.filter((component) => component.kind === kind);
    if (components.length === 0) return null;
    return (
      <section key={kind}>
        <SectionHeading title={t(titleKey)} count={kind === 'mcp' ? undefined : components.length} />
        <div className="divide-y divide-[var(--interactive-border)]">
          {components.map((component) => renderComponentRow(entry, component))}
        </div>
      </section>
    );
  };

  /** Install for an entry not yet installed; Manage and a menu with Uninstall once it is. */
  const renderHeaderActions = (entry: CatalogEntry): React.ReactNode => {
    const isBusy = busyId === entry.id;
    if (!isEntryInstalled(entry)) {
      return (
        <Button size="lg" disabled={isBusy || !canInstallEntry(entry)} onClick={() => requestInstall(entry)}>
          <Icon name={isBusy ? 'loader-4' : 'add'} className={cn('size-4', isBusy && 'animate-spin')} />
          {isBusy ? t('integrationsCatalog.action.installing') : t('integrationsCatalog.action.install')}
        </Button>
      );
    }
    return (
      <div className="flex items-center gap-1.5">
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button variant="ghost" size="icon" className="size-9 text-muted-foreground hover:text-foreground" disabled={isBusy} aria-label={t('integrationsCatalog.action.more')}>
              <Icon name="more" className="size-4" />
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end">
            <DropdownMenuItem variant="destructive" onSelect={() => setConfirm({ kind: 'uninstall', entry })}>
              <Icon name="delete-bin" className="size-4" />
              <span>{t('integrationsCatalog.action.uninstall')}</span>
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
        <Button variant="outline" size="lg" onClick={() => openInSettings(entry)}>
          <Icon name="settings-3" className="size-4" />
          {t('integrationsCatalog.action.manage')}
        </Button>
      </div>
    );
  };

  const renderDetail = (entry: CatalogEntry): React.ReactNode => {
    const status = statusOf(entry);
    const mcp = catalogMcpComponent(entry);
    const installed = isEntryInstalled(entry);
    const mcpInstalled = Boolean(mcp) && isMcpInstalled(entry);
    const sources = [...new Set(entry.components.flatMap((component) => component.kind === 'skill' ? [component.source] : []))];

    return (
      <div className="mx-auto w-full max-w-3xl px-8 pb-12 pt-4">
        <nav className="flex items-center gap-1 text-sm" aria-label={t('integrationsCatalog.page.title')}>
          <button type="button" onClick={() => showEntry(null)} className="rounded-sm text-muted-foreground transition-colors hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring">
            {t('integrationsCatalog.page.title')}
          </button>
          <Icon name="arrow-right-s" className="size-4 text-muted-foreground/60" />
          <span className="truncate text-foreground">{entry.name}</span>
        </nav>

        <header className="mt-8">
          <BrandTile entry={entry} size="lg" />
          <div className="mt-4 flex flex-wrap items-start justify-between gap-4">
            <div className="min-w-0 flex-1">
              <h1 className="text-2xl font-semibold text-foreground">{entry.name}</h1>
              <p className="mt-1 text-sm text-muted-foreground">{t(entry.descriptionKey)}</p>
              <div className="mt-2 flex flex-wrap items-center gap-x-3 gap-y-1 text-sm text-muted-foreground">
                <span className="inline-flex items-center gap-1">
                  {entry.publisher}
                  {entry.verified ? <Icon name="verified-badge" className="size-4 text-[var(--status-info)]" aria-label={t('integrationsCatalog.detail.official')} /> : null}
                </span>
                {installed || entry.status === 'beta' ? (
                  <span className={cn('inline-flex items-center gap-1.5', installed ? statusTextClass(status.tone) : null)}>
                    <span className="size-1.5 rounded-full bg-current" aria-hidden />
                    {installed ? status.label : t('integrationsCatalog.status.beta')}
                  </span>
                ) : null}
              </div>
            </div>
            <div className="flex shrink-0 items-center">{renderHeaderActions(entry)}</div>
          </div>
        </header>

        <div className="mt-10 flex flex-col gap-10">
          {mcp && !mcpInstalled ? renderSetup(entry, mcp) : null}
          {mcpInstalled ? renderConnection(entry) : null}

          <section className="flex flex-col gap-3">
            <SectionHeading title={t('integrationsCatalog.detail.about')} />
            <p className="text-sm leading-relaxed text-foreground">{t(entry.detailsKey)}</p>
          </section>

          {renderComponentGroup(entry, 'mcp', 'integrationsCatalog.group.mcp')}
          {renderComponentGroup(entry, 'skill', 'integrationsCatalog.group.skills')}
          {renderComponentGroup(entry, 'plugin', 'integrationsCatalog.group.plugin')}
          {renderComponentGroup(entry, 'extension', 'integrationsCatalog.group.extension')}

          <section className="flex flex-col gap-3">
            <SectionHeading title={t('integrationsCatalog.detail.info')} />
            <dl className="grid grid-cols-[minmax(8rem,max-content)_1fr] gap-x-8 gap-y-2.5 text-sm">
              <dt className="text-muted-foreground">{t('integrationsCatalog.info.developer')}</dt>
              <dd className="min-w-0 text-foreground">{entry.publisher}</dd>
              <dt className="text-muted-foreground">{t('integrationsCatalog.info.category')}</dt>
              <dd className="min-w-0 text-foreground">{entry.categories.map((target) => t(CATEGORY_LABEL_KEY[target])).join(', ')}</dd>
              {mcp ? (
                <>
                  <dt className="text-muted-foreground">{t('integrationsCatalog.info.auth')}</dt>
                  <dd className="min-w-0 text-foreground">{t(componentKindLabelKey(mcp))}</dd>
                </>
              ) : null}
              <dt className="text-muted-foreground">{t('integrationsCatalog.info.website')}</dt>
              <dd className="min-w-0">
                <a href={entry.homepage} target="_blank" rel="noreferrer" className="inline-flex max-w-full items-center gap-1 text-foreground transition-colors hover:text-[var(--primary-text)]">
                  <span className="truncate" dir="ltr">{entry.homepage.replace(/^https?:\/\//, '')}</span>
                  <Icon name="external-link" className="size-3.5 shrink-0 text-muted-foreground" />
                </a>
              </dd>
              {sources.map((source) => (
                <React.Fragment key={source}>
                  <dt className="text-muted-foreground">{t('integrationsCatalog.info.source')}</dt>
                  <dd className="min-w-0">
                    <a href={`https://github.com/${source}`} target="_blank" rel="noreferrer" className="inline-flex max-w-full items-center gap-1 font-mono text-xs text-foreground transition-colors hover:text-[var(--primary-text)]" dir="ltr">
                      <span className="truncate">{source}</span>
                      <Icon name="external-link" className="size-3.5 shrink-0 text-muted-foreground" />
                    </a>
                  </dd>
                </React.Fragment>
              ))}
            </dl>
          </section>

          <p className="text-xs leading-relaxed text-muted-foreground">{t('integrationsCatalog.detail.dataNote')}</p>
        </div>
      </div>
    );
  };

  const selectedEntry = selectedId ? getCatalogEntry(selectedId) : undefined;

  if (!open) return null;

  return (
    <div className="absolute inset-0 z-10 flex bg-background">
      {renderRail()}

      <main
        ref={scrollerRef}
        className="min-w-0 flex-1 overflow-y-auto"
        onScroll={(event) => {
          if (!selectedId) browseScrollTopRef.current = event.currentTarget.scrollTop;
        }}
      >
        {selectedEntry ? renderDetail(selectedEntry) : renderBrowse()}
      </main>

      {confirm ? (
        <Dialog open onOpenChange={(next) => { if (!next) setConfirm(null); }}>
          <DialogContent className="max-w-md">
            {confirm.kind === 'plugin-install' ? (
              <>
                <DialogHeader>
                  <DialogTitle>{t('integrationsCatalog.plugin.confirm.title', { name: confirm.entry.name })}</DialogTitle>
                  <DialogDescription>
                    {t('integrationsCatalog.plugin.confirm.description', { spec: confirm.entry.components.find((component): component is CatalogPluginComponent => component.kind === 'plugin')?.spec ?? '' })}
                  </DialogDescription>
                </DialogHeader>
                <DialogFooter>
                  <Button variant="ghost" size="sm" onClick={() => setConfirm(null)}>
                    {t('integrationsCatalog.plugin.confirm.cancel')}
                  </Button>
                  <Button
                    variant="default"
                    size="sm"
                    disabled={busyId === confirm.entry.id}
                    onClick={() => {
                      setConfirm(null);
                      void installEntry(confirm.entry, confirm.component);
                    }}
                  >
                    {t('integrationsCatalog.action.install')}
                  </Button>
                </DialogFooter>
              </>
            ) : (
              <>
                <DialogHeader>
                  <DialogTitle>{t('integrationsCatalog.uninstall.title', { name: confirm.entry.name })}</DialogTitle>
                  <DialogDescription>
                    {t('integrationsCatalog.uninstall.description', { name: confirm.entry.name })}
                  </DialogDescription>
                </DialogHeader>
                <DialogFooter>
                  <Button variant="ghost" size="sm" onClick={() => setConfirm(null)}>
                    {t('integrationsCatalog.plugin.confirm.cancel')}
                  </Button>
                  <Button variant="destructive" size="sm" disabled={busyId === confirm.entry.id} onClick={() => void uninstallEntry(confirm.entry)}>
                    {t('integrationsCatalog.uninstall.confirm')}
                  </Button>
                </DialogFooter>
              </>
            )}
          </DialogContent>
        </Dialog>
      ) : null}
    </div>
  );
}
