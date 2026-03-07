import {
	RiAiAgentLine,
	RiArrowLeftSLine,
	RiBarChart2Line,
	RiBookLine,
	RiBookOpenLine,
	RiChatAi3Line,
	RiChatHistoryLine,
	RiCloseLine,
	RiCloudLine,
	RiCommandLine,
	RiFoldersLine,
	RiGitBranchLine,
	RiGlobalLine,
	RiListUnordered,
	RiMicLine,
	RiNotification3Line,
	RiPaletteLine,
	RiRestartLine,
	RiRobot2Line,
	RiServerLine,
	RiSlashCommands2,
} from "@remixicon/react";
import React from "react";
import { useTranslation } from "react-i18next";
import { McpIcon } from "@/components/icons/McpIcon";
import { AgentsPage } from "@/components/sections/agents/AgentsPage";
import { AgentsSidebar } from "@/components/sections/agents/AgentsSidebar";
import { CommandsPage } from "@/components/sections/commands/CommandsPage";
import { CommandsSidebar } from "@/components/sections/commands/CommandsSidebar";
import { GitPage } from "@/components/sections/git-identities/GitPage";
import { McpPage } from "@/components/sections/mcp/McpPage";
import { McpSidebar } from "@/components/sections/mcp/McpSidebar";
import { AboutSettings } from "@/components/sections/openchamber/AboutSettings";
import { OpenChamberPage } from "@/components/sections/openchamber/OpenChamberPage";
import type { OpenChamberSection } from "@/components/sections/openchamber/types";
import { ProjectsPage } from "@/components/sections/projects/ProjectsPage";
import { ProjectsSidebar } from "@/components/sections/projects/ProjectsSidebar";
import { ProvidersPage } from "@/components/sections/providers/ProvidersPage";
import { ProvidersSidebar } from "@/components/sections/providers/ProvidersSidebar";
import { RemoteInstancesPage } from "@/components/sections/remote-instances/RemoteInstancesPage";
import { RemoteInstancesSidebar } from "@/components/sections/remote-instances/RemoteInstancesSidebar";
import { SkillsPage } from "@/components/sections/skills/SkillsPage";
import { SkillsSidebar } from "@/components/sections/skills/SkillsSidebar";
import { UsagePage } from "@/components/sections/usage/UsagePage";
import { UsageSidebar } from "@/components/sections/usage/UsageSidebar";
import { ErrorBoundary } from "@/components/ui/ErrorBoundary";
import {
	Tooltip,
	TooltipContent,
	TooltipTrigger,
} from "@/components/ui/tooltip";
import { isDesktopShell, isVSCodeRuntime, isWebRuntime } from "@/lib/desktop";
import { useDeviceInfo } from "@/lib/device";
import {
	getSettingsPageMeta,
	resolveSettingsSlug,
	SETTINGS_PAGE_METADATA,
	type SettingsPageMeta,
	type SettingsPageSlug,
	type SettingsRuntimeContext,
} from "@/lib/settings/metadata";
import { cn, getModifierLabel } from "@/lib/utils";
import {
	reloadOpenCodeConfiguration,
	useAgentsStore,
} from "@/stores/useAgentsStore";
import { useCommandsStore } from "@/stores/useCommandsStore";
import { useMcpConfigStore } from "@/stores/useMcpConfigStore";
import { useProjectsStore } from "@/stores/useProjectsStore";
import { useSkillsCatalogStore } from "@/stores/useSkillsCatalogStore";
import { useSkillsStore } from "@/stores/useSkillsStore";
import { useUIStore } from "@/stores/useUIStore";

// Same constraints as main sidebar
const SETTINGS_NAV_MIN_WIDTH = 176;
const SETTINGS_NAV_MAX_WIDTH = 280;
const SETTINGS_NAV_RAIL_WIDTH = 48;

type MobileStage = "nav" | "page-sidebar" | "page-content";

interface SettingsViewProps {
	onClose?: () => void;
	/** Force mobile layout regardless of device detection */
	forceMobile?: boolean;
	/** Rendered inside a window/dialog (skip traffic light padding) */
	isWindowed?: boolean;
}

const pageOrder: SettingsPageSlug[] = [
	"appearance",
	"chat",
	"notifications",
	"sessions",
	"shortcuts",
	"git",
	"projects",
	"remote-instances",
	"agents",
	"commands",
	"mcp",
	"providers",
	"usage",
	"skills.installed",
	"skills.catalog",
	"voice",
	"tunnel",
];

function buildRuntimeContext(isDesktop: boolean): SettingsRuntimeContext {
	const isVSCode = isVSCodeRuntime();
	const isWeb = !isDesktop && isWebRuntime();
	return { isVSCode, isWeb, isDesktop };
}

function isPageAvailable(
	page: SettingsPageMeta,
	ctx: SettingsRuntimeContext,
): boolean {
	if (!page.isAvailable) {
		return true;
	}
	return page.isAvailable(ctx);
}

function getSettingsNavIcon(
	slug: SettingsPageSlug,
): React.ComponentType<{ className?: string }> | null {
	switch (slug) {
		case "projects":
			return RiFoldersLine;
		case "remote-instances":
			return RiServerLine;
		case "appearance":
			return RiPaletteLine;
		case "chat":
			return RiChatAi3Line;
		case "notifications":
			return RiNotification3Line;
		case "shortcuts":
			return RiCommandLine;
		case "sessions":
			return RiChatHistoryLine;

		case "providers":
			return RiCloudLine;
		case "agents":
			return RiAiAgentLine;
		case "commands":
			return RiSlashCommands2;
		case "mcp":
			return McpIcon;

		case "skills.installed":
			return RiBookOpenLine;
		case "skills.catalog":
			return RiBookLine;

		case "git":
			return RiGitBranchLine;

		case "usage":
			return RiBarChart2Line;
		case "voice":
			return RiMicLine;
		case "tunnel":
			return RiGlobalLine;
		case "home":
			return null;
		default:
			return RiRobot2Line;
	}
}

const SettingsHome: React.FC<{ onOpen: (slug: SettingsPageSlug) => void }> = ({
	onOpen,
}) => {
	const { t } = useTranslation();

	return (
		<div className="h-full overflow-auto">
			<div className="mx-auto w-full max-w-3xl px-6 py-6 space-y-6">
				<div className="space-y-1">
					<h1 className="typography-ui-header font-semibold text-foreground">
						{t("settings.title")}
					</h1>
					<p className="typography-ui text-muted-foreground">
						{t("settings.jumpToCommonPages")}
					</p>
				</div>

				<div className="grid gap-3 sm:grid-cols-2">
					<button
						type="button"
						onClick={() => onOpen("providers")}
						className={cn(
							"rounded-lg border border-border bg-[var(--surface-elevated)] p-4 text-left",
							"hover:bg-[var(--interactive-hover)] transition-colors",
						)}
					>
						<div className="typography-ui-label text-foreground">
							{t("settings.home.providers.title")}
						</div>
						<div className="typography-micro text-muted-foreground/70">
							{t("settings.home.providers.desc")}
						</div>
					</button>

					<button
						type="button"
						onClick={() => onOpen("agents")}
						className={cn(
							"rounded-lg border border-border bg-[var(--surface-elevated)] p-4 text-left",
							"hover:bg-[var(--interactive-hover)] transition-colors",
						)}
					>
						<div className="typography-ui-label text-foreground">
							{t("settings.home.agents.title")}
						</div>
						<div className="typography-micro text-muted-foreground/70">
							{t("settings.home.agents.desc")}
						</div>
					</button>

					<button
						type="button"
						onClick={() => onOpen("skills.catalog")}
						className={cn(
							"rounded-lg border border-border bg-[var(--surface-elevated)] p-4 text-left",
							"hover:bg-[var(--interactive-hover)] transition-colors",
						)}
					>
						<div className="typography-ui-label text-foreground">
							{t("settings.home.skillsCatalog.title")}
						</div>
						<div className="typography-micro text-muted-foreground/70">
							{t("settings.home.skillsCatalog.desc")}
						</div>
					</button>

					<button
						type="button"
						onClick={() => onOpen("mcp")}
						className={cn(
							"rounded-lg border border-border bg-[var(--surface-elevated)] p-4 text-left",
							"hover:bg-[var(--interactive-hover)] transition-colors",
						)}
					>
						<div className="typography-ui-label text-foreground">
							{t("settings.home.mcp.title")}
						</div>
						<div className="typography-micro text-muted-foreground/70">
							{t("settings.home.mcp.desc")}
						</div>
					</button>

					<button
						type="button"
						onClick={() => onOpen("usage")}
						className={cn(
							"rounded-lg border border-border bg-[var(--surface-elevated)] p-4 text-left",
							"hover:bg-[var(--interactive-hover)] transition-colors",
						)}
					>
						<div className="typography-ui-label text-foreground">
							{t("settings.home.usage.title")}
						</div>
						<div className="typography-micro text-muted-foreground/70">
							{t("settings.home.usage.desc")}
						</div>
					</button>
				</div>
			</div>
		</div>
	);
};

export const SettingsView: React.FC<SettingsViewProps> = ({
	onClose,
	forceMobile,
	isWindowed,
}) => {
	const { t } = useTranslation();
	const deviceInfo = useDeviceInfo();
	const isMobile = forceMobile ?? deviceInfo.isMobile;

	const settingsPageRaw = useUIStore((state) => state.settingsPage);
	const setSettingsPage = useUIStore((state) => state.setSettingsPage);
	const settingsSlug = resolveSettingsSlug(settingsPageRaw);

	const [mobileStage, setMobileStage] = React.useState<MobileStage>("nav");
	const autoNavSlugRef = React.useRef<string | null>(null);

	const [navWidth, setNavWidth] = React.useState(216);
	const [hasManuallyResized, setHasManuallyResized] = React.useState(false);
	const [isResizing, setIsResizing] = React.useState(false);
	const startXRef = React.useRef(0);
	const startWidthRef = React.useRef(navWidth);
	const containerRef = React.useRef<HTMLDivElement>(null);

	const isDesktopApp = React.useMemo(() => {
		return isDesktopShell();
	}, []);

	// keep platform check available for future window chrome tweaks

	const runtimeCtx = React.useMemo(
		() => buildRuntimeContext(isDesktopApp),
		[isDesktopApp],
	);

	const visiblePages = React.useMemo(() => {
		return SETTINGS_PAGE_METADATA.filter((page) => page.slug !== "home")
			.filter((page) => isPageAvailable(page, runtimeCtx))
			.filter((page) => !(runtimeCtx.isVSCode && page.slug === "projects"))
			.filter((page) => !(isMobile && page.slug === "shortcuts"));
	}, [runtimeCtx, isMobile]);

	const sortedFilteredPages = React.useMemo(() => {
		const rank = new Map<SettingsPageSlug, number>(
			pageOrder.map((s, i) => [s, i]),
		);
		return visiblePages
			.slice()
			.sort((a, b) => (rank.get(a.slug) ?? 999) - (rank.get(b.slug) ?? 999));
	}, [visiblePages]);

	const activeProjectId = useProjectsStore((state) => state.activeProjectId);

	React.useEffect(() => {
		if (typeof window === "undefined") return;
		const handleResize = () => {
			if (!hasManuallyResized) {
				const proportionalWidth = Math.min(
					SETTINGS_NAV_MAX_WIDTH,
					Math.max(
						SETTINGS_NAV_MIN_WIDTH,
						Math.floor(window.innerWidth * 0.12),
					),
				);
				setNavWidth(proportionalWidth);
			}
		};
		window.addEventListener("resize", handleResize);
		return () => window.removeEventListener("resize", handleResize);
	}, [hasManuallyResized]);

	React.useEffect(() => {
		if (!isResizing) return;
		const handlePointerMove = (event: PointerEvent) => {
			const delta = event.clientX - startXRef.current;
			const nextWidth = Math.min(
				SETTINGS_NAV_MAX_WIDTH,
				Math.max(SETTINGS_NAV_MIN_WIDTH, startWidthRef.current + delta),
			);
			setNavWidth(nextWidth);
			setHasManuallyResized(true);
		};
		const handlePointerUp = () => setIsResizing(false);
		window.addEventListener("pointermove", handlePointerMove);
		window.addEventListener("pointerup", handlePointerUp, { once: true });
		return () => {
			window.removeEventListener("pointermove", handlePointerMove);
			window.removeEventListener("pointerup", handlePointerUp);
		};
	}, [isResizing]);

	const handlePointerDown = (event: React.PointerEvent) => {
		setIsResizing(true);
		startXRef.current = event.clientX;
		startWidthRef.current = navWidth;
		event.preventDefault();
	};

	// Load stores when project changes or when a page becomes active.
	React.useEffect(() => {
		void activeProjectId;
		if (settingsSlug === "agents") {
			setTimeout(() => void useAgentsStore.getState().loadAgents(), 0);
			return;
		}
		if (settingsSlug === "commands") {
			setTimeout(() => void useCommandsStore.getState().loadCommands(), 0);
			return;
		}
		if (settingsSlug === "mcp") {
			setTimeout(() => void useMcpConfigStore.getState().loadMcpConfigs(), 0);
			return;
		}
		if (
			settingsSlug === "skills.installed" ||
			settingsSlug === "skills.catalog"
		) {
			setTimeout(() => {
				void useSkillsStore.getState().loadSkills();
				void useSkillsCatalogStore.getState().loadCatalog();
			}, 0);
		}
	}, [activeProjectId, settingsSlug]);

	const openPage = React.useCallback(
		(slug: SettingsPageSlug) => {
			setSettingsPage(slug);
			autoNavSlugRef.current = slug;
			if (!isMobile) {
				return;
			}
			const def = getSettingsPageMeta(slug);
			if (!def || def.slug === "home") {
				setMobileStage("nav");
				return;
			}
			setMobileStage(def.kind === "split" ? "page-sidebar" : "page-content");
		},
		[isMobile, setSettingsPage],
	);

	const activePageMeta = React.useMemo(() => {
		return getSettingsPageMeta(settingsSlug);
	}, [settingsSlug]);

	// Collapse main nav to icon rail when active page has its own sidebar
	const isNavCollapsed = !isMobile && activePageMeta?.kind === "split";

	const openChamberSectionBySlug: Partial<
		Record<SettingsPageSlug, OpenChamberSection>
	> = React.useMemo(
		() => ({
			appearance: "visual",
			chat: "chat",
			shortcuts: "shortcuts",
			sessions: "sessions",
			notifications: "notifications",
			voice: "voice",
			tunnel: "tunnel",
		}),
		[],
	);

	const renderUnavailable = React.useCallback(() => {
		return (
			<div className="flex h-full items-center justify-center px-6">
				<div className="max-w-md text-center">
					<div className="typography-ui-header font-semibold text-foreground">
						{t("settings.notAvailable")}
					</div>
					<p className="typography-ui text-muted-foreground mt-1">
						{t("settings.notAvailableDesc")}
					</p>
				</div>
			</div>
		);
	}, [t]);

	const renderPageSidebar = React.useCallback(
		(slug: SettingsPageSlug, opts: { onItemSelect?: () => void }) => {
			switch (slug) {
				case "projects":
					return <ProjectsSidebar onItemSelect={opts.onItemSelect} />;
				case "remote-instances":
					return <RemoteInstancesSidebar onItemSelect={opts.onItemSelect} />;
				case "agents":
					return <AgentsSidebar onItemSelect={opts.onItemSelect} />;
				case "commands":
					return <CommandsSidebar onItemSelect={opts.onItemSelect} />;
				case "mcp":
					return <McpSidebar onItemSelect={opts.onItemSelect} />;
				case "skills.installed":
					return <SkillsSidebar onItemSelect={opts.onItemSelect} />;
				case "providers":
					return <ProvidersSidebar onItemSelect={opts.onItemSelect} />;
				case "usage":
					return <UsageSidebar onItemSelect={opts.onItemSelect} />;
				default:
					return null;
			}
		},
		[],
	);

	const renderPageContent = React.useCallback(
		(slug: SettingsPageSlug) => {
			const meta = getSettingsPageMeta(slug);
			if (meta && !isPageAvailable(meta, runtimeCtx)) {
				return renderUnavailable();
			}

			switch (slug) {
				case "home":
					return <SettingsHome onOpen={openPage} />;
				case "projects":
					return <ProjectsPage />;
				case "remote-instances":
					return <RemoteInstancesPage />;
				case "agents":
					return <AgentsPage />;
				case "commands":
					return <CommandsPage />;
				case "mcp":
					return <McpPage />;
				case "skills.installed":
					return <SkillsPage view="installed" />;
				case "skills.catalog":
					return <SkillsPage view="catalog" />;
				case "providers":
					return <ProvidersPage />;
				case "usage":
					return <UsagePage />;
				case "git":
					return <GitPage />;
				case "appearance":
				case "chat":
				case "shortcuts":
				case "sessions":
				case "notifications":
				case "voice":
				case "tunnel": {
					const section = openChamberSectionBySlug[slug] ?? "visual";
					return <OpenChamberPage section={section} />;
				}
				default:
					return <SettingsHome onOpen={openPage} />;
			}
		},
		[openChamberSectionBySlug, openPage, renderUnavailable, runtimeCtx],
	);

	// Mobile: if opened via deep-link / palette to a non-home page, jump into it once.
	React.useEffect(() => {
		if (!isMobile) {
			return;
		}
		if (mobileStage !== "nav") {
			return;
		}
		if (settingsSlug === "home") {
			return;
		}
		if (autoNavSlugRef.current === settingsSlug) {
			return;
		}
		const def = getSettingsPageMeta(settingsSlug);
		if (!def || def.slug === "home") {
			return;
		}
		autoNavSlugRef.current = settingsSlug;
		setMobileStage(def.kind === "split" ? "page-sidebar" : "page-content");
	}, [isMobile, mobileStage, settingsSlug]);

	const showBackButton = isMobile && mobileStage !== "nav";
	const shortcutKey = getModifierLabel();

	const getPageTitle = React.useCallback(
		(slug: SettingsPageSlug, fallback: string) => {
			switch (slug) {
				case "home":
					return t("settings.pages.home");
				case "appearance":
					return t("settings.pages.appearance");
				case "chat":
					return t("settings.pages.chat");
				case "notifications":
					return t("settings.pages.notifications");
				case "sessions":
					return t("settings.pages.sessions");
				case "shortcuts":
					return t("settings.pages.shortcuts");
				case "providers":
					return t("settings.pages.providers");
				case "agents":
					return t("settings.pages.agents");
				case "commands":
					return t("settings.pages.commands");
				case "mcp":
					return t("settings.pages.mcp");
				case "skills.installed":
					return t("settings.pages.skills.installed");
				case "skills.catalog":
					return t("settings.pages.skills.catalog");
				case "git":
					return t("settings.pages.git");
				case "projects":
					return t("settings.pages.projects");
				case "remote-instances":
					return t("settings.pages.remote-instances");
				case "usage":
					return t("settings.pages.usage");
				case "voice":
					return t("settings.pages.voice");
				case "tunnel":
					return t("settings.pages.tunnel");
				default:
					return fallback;
			}
		},
		[t],
	);

	const handleBack = React.useCallback(() => {
		setMobileStage("nav");
	}, []);

	const handleOpenPageSidebar = React.useCallback(() => {
		setMobileStage("page-sidebar");
	}, []);

	const renderSettingsNav = (collapsed: boolean) => {
		return (
			<div className="flex h-full flex-col overflow-hidden">
				{/* Scrollable nav items */}
				<div className="flex-1 min-h-0 overflow-y-auto overflow-x-hidden">
					<div className="flex flex-col gap-0.5 pt-4 pb-2 px-2">
						{sortedFilteredPages.map((page) => {
							const selected = settingsSlug === page.slug;
							const Icon = getSettingsNavIcon(page.slug);
							if (!Icon) return null;

							return (
								<Tooltip key={page.slug} delayDuration={collapsed ? 100 : 600}>
									<TooltipTrigger asChild>
										<button
											type="button"
											onClick={() => openPage(page.slug)}
											className={cn(
												"flex h-8 items-center gap-2 rounded-md px-2 overflow-hidden",
												selected
													? "bg-interactive-selection text-foreground"
													: "text-foreground hover:bg-interactive-hover",
											)}
										>
											<Icon className="h-4 w-4 shrink-0" />
											<span
												className={cn(
													"flex items-center gap-1.5 whitespace-nowrap overflow-hidden transition-opacity duration-150",
													collapsed ? "opacity-0" : "opacity-100",
												)}
											>
												<span className="typography-ui-label font-normal truncate">
													{getPageTitle(page.slug, page.title)}
												</span>
												{(page.slug === "voice" || page.slug === "tunnel") && (
													<span className="shrink-0 typography-micro px-1 rounded leading-none pb-px text-[var(--status-warning)] bg-[var(--status-warning)]/10">
														{t("settings.beta")}
													</span>
												)}
											</span>
										</button>
									</TooltipTrigger>
									{collapsed && (
										<TooltipContent side="right" sideOffset={8}>
											{getPageTitle(page.slug, page.title)}
										</TooltipContent>
									)}
								</Tooltip>
							);
						})}
					</div>
				</div>

				{/* Footer — hidden when collapsed via overflow on parent */}
				<div
					className={cn(
						"overflow-hidden transition-opacity duration-150",
						collapsed ? "opacity-0 pointer-events-none" : "opacity-100",
					)}
				>
					<div className="border-t border-border bg-sidebar px-2 py-1 space-y-0.5">
						{!runtimeCtx.isVSCode && (
							<Tooltip delayDuration={300}>
								<TooltipTrigger asChild>
									<button
										type="button"
										className={cn(
											"flex h-7 w-full items-center gap-2 rounded-md px-2 overflow-hidden whitespace-nowrap",
											"text-sm font-semibold text-sidebar-foreground/90",
											"hover:text-sidebar-foreground hover:bg-interactive-hover",
										)}
										onClick={() =>
											void reloadOpenCodeConfiguration({
												message: "Restarting OpenCode…",
												mode: "projects",
												scopes: ["all"],
											})
										}
									>
										<RiRestartLine className="h-4 w-4 shrink-0" />
										<span>{t("settings.reloadOpenCode")}</span>
									</button>
								</TooltipTrigger>
								<TooltipContent>
									{t("settings.reloadOpenCodeTooltip")}
								</TooltipContent>
							</Tooltip>
						)}

						{isMobile && runtimeCtx.isWeb && (
							<div className="px-1.5 pt-2">
								<AboutSettings />
							</div>
						)}
					</div>
				</div>
			</div>
		);
	};

	const renderMobileStage = () => {
		if (mobileStage === "nav") {
			return (
				<div
					className={cn(
						"flex-1 overflow-hidden",
						runtimeCtx.isVSCode ? "bg-background" : "bg-sidebar",
					)}
				>
					<div className="flex h-full min-h-0 flex-col">
						<ErrorBoundary>{renderSettingsNav(false)}</ErrorBoundary>
					</div>
				</div>
			);
		}

		if (!activePageMeta) {
			return <div className="flex-1 bg-background" />;
		}

		if (mobileStage === "page-sidebar") {
			if (activePageMeta.kind !== "split") {
				// No sidebar available; fall back to direct content.
				const fallback = renderPageContent(settingsSlug);
				return (
					<div
						className="flex-1 overflow-hidden bg-background"
						data-keyboard-avoid="true"
					>
						<ErrorBoundary>{fallback}</ErrorBoundary>
					</div>
				);
			}
			return (
				<div
					className={cn(
						"flex-1 overflow-hidden",
						runtimeCtx.isVSCode ? "bg-background" : "bg-sidebar",
					)}
				>
					<ErrorBoundary>
						{renderPageSidebar(settingsSlug, {
							onItemSelect: () => setMobileStage("page-content"),
						})}
					</ErrorBoundary>
				</div>
			);
		}

		// page-content
		const content = renderPageContent(settingsSlug);

		return (
			<div
				className="flex-1 overflow-hidden bg-background"
				data-keyboard-avoid="true"
			>
				<ErrorBoundary>{content}</ErrorBoundary>
			</div>
		);
	};

	const renderDesktopContent = () => {
		if (!activePageMeta || settingsSlug === "home") {
			return <SettingsHome onOpen={openPage} />;
		}

		if (activePageMeta.kind === "split") {
			return (
				<div className="flex h-full min-h-0 overflow-hidden">
					<div
						className={cn(
							"w-[264px] min-w-[264px] border-r",
							runtimeCtx.isVSCode ? "bg-background" : "bg-sidebar",
						)}
						style={{ borderColor: "var(--interactive-border)" }}
					>
						<ErrorBoundary>{renderPageSidebar(settingsSlug, {})}</ErrorBoundary>
					</div>
					<div className="flex-1 overflow-hidden bg-background">
						<ErrorBoundary>{renderPageContent(settingsSlug)}</ErrorBoundary>
					</div>
				</div>
			);
		}

		return (
			<div className="h-full overflow-hidden bg-background">
				<ErrorBoundary>{renderPageContent(settingsSlug)}</ErrorBoundary>
			</div>
		);
	};

	return (
		<div
			ref={containerRef}
			data-settings-view="true"
			className={cn(
				"relative flex h-full flex-col overflow-hidden bg-background",
			)}
		>
			{isMobile ? (
				<div
					className={cn(
						"flex items-center gap-2 px-3 py-2 border-b",
						"bg-background/95 backdrop-blur supports-[backdrop-filter]:bg-background/80",
					)}
					style={{ borderColor: "var(--interactive-border)" }}
				>
					<button
						type="button"
						onClick={showBackButton ? handleBack : onClose}
						aria-label={
							showBackButton
								? t("settings.backToSettings")
								: t("settings.closeSettings")
						}
						className="inline-flex h-9 w-9 flex-shrink-0 items-center justify-center rounded-lg p-2 text-muted-foreground hover:text-foreground hover:bg-interactive-hover/50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary"
					>
						<RiArrowLeftSLine className="h-5 w-5" />
					</button>

					<div className="min-w-0 flex-1 typography-ui-label font-medium text-foreground truncate">
						{mobileStage === "nav"
							? t("settings.title")
							: activePageMeta
								? getPageTitle(activePageMeta.slug, activePageMeta.title)
								: t("settings.title")}
					</div>

					{mobileStage === "page-content" &&
						activePageMeta?.kind === "split" && (
							<button
								type="button"
								onClick={handleOpenPageSidebar}
								aria-label={t("settings.openSectionList")}
								className="inline-flex h-9 w-9 flex-shrink-0 items-center justify-center rounded-lg p-2 text-muted-foreground hover:text-foreground hover:bg-interactive-hover/50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary"
							>
								<RiListUnordered className="h-5 w-5" />
							</button>
						)}

					{onClose && (
						<button
							type="button"
							onClick={onClose}
							aria-label={t("settings.closeSettings")}
							title={`${t("settings.closeSettings")} (${shortcutKey}+,)`}
							className="inline-flex h-9 w-9 flex-shrink-0 items-center justify-center rounded-lg p-2 text-muted-foreground hover:text-foreground hover:bg-interactive-hover/50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary"
						>
							<RiCloseLine className="h-5 w-5" />
						</button>
					)}
				</div>
			) : (
				<>
					{showBackButton && (
						<div
							className={cn(
								"absolute left-3 z-50",
								isWindowed ? "top-2" : "top-3",
							)}
						>
							<button
								type="button"
								onClick={handleBack}
								aria-label="Back"
								className="inline-flex h-9 w-9 items-center justify-center rounded-lg p-2 text-muted-foreground hover:text-foreground hover:bg-interactive-hover/50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary"
							>
								<RiArrowLeftSLine className="h-5 w-5" />
							</button>
						</div>
					)}

					{onClose && (
						<div
							className={cn(
								"absolute right-0.5 z-50",
								isWindowed ? "top-0.5" : "top-1",
							)}
						>
							<button
								type="button"
								onClick={onClose}
								aria-label={t("settings.closeSettings")}
								title={`${t("settings.closeSettings")} (${shortcutKey}+,)`}
								className="inline-flex h-7 w-7 items-center justify-center rounded-md p-0.5 text-muted-foreground hover:text-foreground hover:bg-interactive-hover/50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary"
							>
								<RiCloseLine className="h-5 w-5" />
							</button>
						</div>
					)}
				</>
			)}

			<div className="flex flex-1 overflow-hidden">
				{isMobile ? (
					renderMobileStage()
				) : (
					<>
						<div
							className={cn(
								"relative flex h-full min-h-0 flex-col overflow-hidden border-r",
								isDesktopApp
									? "bg-[color:var(--sidebar-overlay-strong)] backdrop-blur supports-[backdrop-filter]:bg-[color:var(--sidebar-overlay-soft)]"
									: runtimeCtx.isVSCode
										? "bg-background"
										: "bg-sidebar",
								isResizing && !isNavCollapsed
									? ""
									: "transition-[width,min-width] duration-200 ease-[cubic-bezier(0.25,0.1,0.25,1)]",
							)}
							style={{
								width: isNavCollapsed
									? `${SETTINGS_NAV_RAIL_WIDTH}px`
									: `${navWidth}px`,
								minWidth: isNavCollapsed
									? `${SETTINGS_NAV_RAIL_WIDTH}px`
									: `${navWidth}px`,
								borderColor: "var(--interactive-border)",
							}}
						>
							{!isNavCollapsed && (
								<button
									type="button"
									className={cn(
										"absolute right-0 top-0 z-20 h-full w-[6px] -mr-[3px] cursor-col-resize",
										isResizing
											? "bg-primary/30"
											: "bg-transparent hover:bg-primary/20",
									)}
									onPointerDown={handlePointerDown}
									aria-label={t("settings.resizeNav")}
								/>
							)}
							<ErrorBoundary>{renderSettingsNav(isNavCollapsed)}</ErrorBoundary>
						</div>

						<div className="flex-1 overflow-hidden bg-background">
							{renderDesktopContent()}
						</div>
					</>
				)}
			</div>
		</div>
	);
};
