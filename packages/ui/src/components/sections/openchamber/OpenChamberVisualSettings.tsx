import { RiInformationLine, RiRestartLine } from "@remixicon/react";
import React from "react";
import { useTranslation } from "react-i18next";
import { ButtonSmall } from "@/components/ui/button-small";
import { Checkbox } from "@/components/ui/checkbox";
import { Input } from "@/components/ui/input";
import { NumberInput } from "@/components/ui/number-input";
import { Radio } from "@/components/ui/radio";
import {
	Select,
	SelectContent,
	SelectItem,
	SelectTrigger,
	SelectValue,
} from "@/components/ui/select";
import {
	Tooltip,
	TooltipContent,
	TooltipTrigger,
} from "@/components/ui/tooltip";
import { useThemeSystem } from "@/contexts/useThemeSystem";
import { usePwaDetection } from "@/hooks/usePwaDetection";
import { isVSCodeRuntime, isWebRuntime } from "@/lib/desktop";
import { useDeviceInfo } from "@/lib/device";
import {
	setDirectoryShowHidden,
	useDirectoryShowHidden,
} from "@/lib/directoryShowHidden";
import { updateDesktopSettings } from "@/lib/persistence";
import { cn, getModifierLabel } from "@/lib/utils";
import { useMessageQueueStore } from "@/stores/messageQueueStore";
import { useUIStore } from "@/stores/useUIStore";
import type { ThemeMode } from "@/types/theme";

interface Option<T extends string> {
	id: T;
	labelKey: string;
	descriptionKey?: string;
}

const THEME_MODE_OPTIONS: Array<{ value: ThemeMode; labelKey: string }> = [
	{
		value: "system",
		labelKey: "appearance.system",
	},
	{
		value: "light",
		labelKey: "appearance.light",
	},
	{
		value: "dark",
		labelKey: "appearance.dark",
	},
];

const TOOL_EXPANSION_OPTIONS: Array<{
	value: "collapsed" | "activity" | "detailed" | "changes";
	labelKey: string;
	descriptionKey: string;
}> = [
	{
		value: "collapsed",
		labelKey: "appearance.toolOutput.collapsed",
		descriptionKey: "appearance.toolOutput.collapsedDesc",
	},
	{
		value: "activity",
		labelKey: "appearance.toolOutput.summary",
		descriptionKey: "appearance.toolOutput.summaryDesc",
	},
	{
		value: "detailed",
		labelKey: "appearance.toolOutput.detailed",
		descriptionKey: "appearance.toolOutput.detailedDesc",
	},
	{
		value: "changes",
		labelKey: "appearance.toolOutput.changes",
		descriptionKey: "appearance.toolOutput.changesDesc",
	},
];

const DIFF_LAYOUT_OPTIONS: Option<"dynamic" | "inline" | "side-by-side">[] = [
	{
		id: "dynamic",
		labelKey: "appearance.dynamic",
		descriptionKey: "appearance.dynamicDesc",
	},
	{
		id: "inline",
		labelKey: "appearance.alwaysInline",
		descriptionKey: "appearance.alwaysInlineDesc",
	},
	{
		id: "side-by-side",
		labelKey: "appearance.alwaysSideBySide",
		descriptionKey: "appearance.alwaysSideBySideDesc",
	},
];

const DIFF_VIEW_MODE_OPTIONS: Option<"single" | "stacked">[] = [
	{
		id: "single",
		labelKey: "appearance.singleFile",
		descriptionKey: "appearance.singleFileDesc",
	},
	{
		id: "stacked",
		labelKey: "appearance.allFiles",
		descriptionKey: "appearance.allFilesDesc",
	},
];

const MERMAID_RENDERING_OPTIONS: Option<"svg" | "ascii">[] = [
	{
		id: "svg",
		labelKey: "appearance.svg",
		descriptionKey: "appearance.svgDesc",
	},
	{
		id: "ascii",
		labelKey: "appearance.ascii",
		descriptionKey: "appearance.asciiDesc",
	},
];

const DEFAULT_PWA_INSTALL_NAME = "OpenChamber - AI Coding Assistant";

type PwaInstallNameWindow = Window & {
	__OPENCHAMBER_SET_PWA_INSTALL_NAME__?: (value: string) => string;
	__OPENCHAMBER_UPDATE_PWA_MANIFEST__?: () => void;
};

const USER_MESSAGE_RENDERING_OPTIONS: Option<"markdown" | "plain">[] = [
	{
		id: "markdown",
		labelKey: "appearance.markdown",
		descriptionKey: "appearance.markdownDesc",
	},
	{
		id: "plain",
		labelKey: "appearance.plainText",
		descriptionKey: "appearance.plainTextDesc",
	},
];

const normalizeUserMessageRenderingMode = (
	mode: unknown,
): "markdown" | "plain" => {
	return mode === "markdown" ? "markdown" : "plain";
};

export type VisibleSetting =
	| "theme"
	| "pwaInstallName"
	| "fontSize"
	| "terminalFontSize"
	| "spacing"
	| "cornerRadius"
	| "inputBarOffset"
	| "navRail"
	| "toolOutput"
	| "mermaidRendering"
	| "userMessageRendering"
	| "stickyUserHeader"
	| "diffLayout"
	| "mobileStatusBar"
	| "mobileKeyboardTools"
	| "dotfiles"
	| "reasoning"
	| "queueMode"
	| "textJustificationActivity"
	| "activityHeaderTimestamps"
	| "terminalQuickKeys"
	| "persistDraft";

interface OpenChamberVisualSettingsProps {
	/** Which settings to show. If undefined, shows all. */
	visibleSettings?: VisibleSetting[];
}

export const OpenChamberVisualSettings: React.FC<
	OpenChamberVisualSettingsProps
> = ({ visibleSettings }) => {
	const { t } = useTranslation();
	const { isMobile } = useDeviceInfo();
	const { browserTab } = usePwaDetection();
	const language = useUIStore((state) => state.language);
	const setLanguage = useUIStore((state) => state.setLanguage);
	const directoryShowHidden = useDirectoryShowHidden();
	const showReasoningTraces = useUIStore((state) => state.showReasoningTraces);
	const setShowReasoningTraces = useUIStore(
		(state) => state.setShowReasoningTraces,
	);
	const showTextJustificationActivity = useUIStore(
		(state) => state.showTextJustificationActivity,
	);
	const setShowTextJustificationActivity = useUIStore(
		(state) => state.setShowTextJustificationActivity,
	);
	const showActivityHeaderTimestamps = useUIStore(
		(state) => state.showActivityHeaderTimestamps,
	);
	const setShowActivityHeaderTimestamps = useUIStore(
		(state) => state.setShowActivityHeaderTimestamps,
	);
	const toolCallExpansion = useUIStore((state) => state.toolCallExpansion);
	const setToolCallExpansion = useUIStore(
		(state) => state.setToolCallExpansion,
	);
	const mermaidRenderingMode = useUIStore(
		(state) => state.mermaidRenderingMode,
	);
	const setMermaidRenderingMode = useUIStore(
		(state) => state.setMermaidRenderingMode,
	);
	const userMessageRenderingMode = useUIStore(
		(state) => state.userMessageRenderingMode,
	);
	const setUserMessageRenderingMode = useUIStore(
		(state) => state.setUserMessageRenderingMode,
	);
	const stickyUserHeader = useUIStore((state) => state.stickyUserHeader);
	const setStickyUserHeader = useUIStore((state) => state.setStickyUserHeader);
	const fontSize = useUIStore((state) => state.fontSize);
	const setFontSize = useUIStore((state) => state.setFontSize);
	const terminalFontSize = useUIStore((state) => state.terminalFontSize);
	const setTerminalFontSize = useUIStore((state) => state.setTerminalFontSize);
	const padding = useUIStore((state) => state.padding);
	const setPadding = useUIStore((state) => state.setPadding);
	const cornerRadius = useUIStore((state) => state.cornerRadius);
	const setCornerRadius = useUIStore((state) => state.setCornerRadius);
	const inputBarOffset = useUIStore((state) => state.inputBarOffset);
	const setInputBarOffset = useUIStore((state) => state.setInputBarOffset);
	const diffLayoutPreference = useUIStore(
		(state) => state.diffLayoutPreference,
	);
	const setDiffLayoutPreference = useUIStore(
		(state) => state.setDiffLayoutPreference,
	);
	const diffViewMode = useUIStore((state) => state.diffViewMode);
	const setDiffViewMode = useUIStore((state) => state.setDiffViewMode);
	const showTerminalQuickKeysOnDesktop = useUIStore(
		(state) => state.showTerminalQuickKeysOnDesktop,
	);
	const setShowTerminalQuickKeysOnDesktop = useUIStore(
		(state) => state.setShowTerminalQuickKeysOnDesktop,
	);
	const queueModeEnabled = useMessageQueueStore(
		(state) => state.queueModeEnabled,
	);
	const setQueueMode = useMessageQueueStore((state) => state.setQueueMode);
	const persistChatDraft = useUIStore((state) => state.persistChatDraft);
	const setPersistChatDraft = useUIStore((state) => state.setPersistChatDraft);
	const isNavRailExpanded = useUIStore((state) => state.isNavRailExpanded);
	const setNavRailExpanded = useUIStore((state) => state.setNavRailExpanded);
	const showMobileSessionStatusBar = useUIStore(
		(state) => state.showMobileSessionStatusBar,
	);
	const setShowMobileSessionStatusBar = useUIStore(
		(state) => state.setShowMobileSessionStatusBar,
	);
	const showMobileKeyboardTools = useUIStore(
		(state) => state.showMobileKeyboardTools,
	);
	const setShowMobileKeyboardTools = useUIStore(
		(state) => state.setShowMobileKeyboardTools,
	);
	const {
		themeMode,
		setThemeMode,
		availableThemes,
		customThemesLoading,
		reloadCustomThemes,
		lightThemeId,
		darkThemeId,
		setLightThemePreference,
		setDarkThemePreference,
	} = useThemeSystem();

	const [themesReloading, setThemesReloading] = React.useState(false);
	const handleUserMessageRenderingModeChange = React.useCallback(
		(mode: "markdown" | "plain") => {
			setUserMessageRenderingMode(mode);
			void updateDesktopSettings({ userMessageRenderingMode: mode });
		},
		[setUserMessageRenderingMode],
	);

	const handleStickyUserHeaderChange = React.useCallback(
		(enabled: boolean) => {
			setStickyUserHeader(enabled);
			void updateDesktopSettings({ stickyUserHeader: enabled });
		},
		[setStickyUserHeader],
	);

	const lightThemes = React.useMemo(
		() =>
			availableThemes
				.filter((theme) => theme.metadata.variant === "light")
				.sort((a, b) => a.metadata.name.localeCompare(b.metadata.name)),
		[availableThemes],
	);

	const darkThemes = React.useMemo(
		() =>
			availableThemes
				.filter((theme) => theme.metadata.variant === "dark")
				.sort((a, b) => a.metadata.name.localeCompare(b.metadata.name)),
		[availableThemes],
	);

	const selectedLightTheme = React.useMemo(
		() =>
			lightThemes.find((theme) => theme.metadata.id === lightThemeId) ??
			lightThemes[0],
		[lightThemes, lightThemeId],
	);

	const selectedDarkTheme = React.useMemo(
		() =>
			darkThemes.find((theme) => theme.metadata.id === darkThemeId) ??
			darkThemes[0],
		[darkThemes, darkThemeId],
	);

	const formatThemeLabel = React.useCallback(
		(themeName: string, variant: "light" | "dark") => {
			const suffix = variant === "dark" ? " Dark" : " Light";
			return themeName.endsWith(suffix)
				? themeName.slice(0, -suffix.length)
				: themeName;
		},
		[],
	);

	const shouldShow = (setting: VisibleSetting): boolean => {
		if (!visibleSettings) return true;
		return visibleSettings.includes(setting);
	};

	const isVSCode = isVSCodeRuntime();
	const hasAppearanceSettings =
		(shouldShow("theme") || shouldShow("pwaInstallName")) && !isVSCode;
	const hasLayoutSettings =
		shouldShow("fontSize") ||
		shouldShow("terminalFontSize") ||
		shouldShow("spacing") ||
		shouldShow("cornerRadius") ||
		shouldShow("inputBarOffset");
	const hasNavigationSettings =
		(!isMobile && shouldShow("navRail")) ||
		(shouldShow("terminalQuickKeys") && !isMobile);
	const hasBehaviorSettings =
		shouldShow("toolOutput") ||
		shouldShow("mermaidRendering") ||
		shouldShow("userMessageRendering") ||
		shouldShow("stickyUserHeader") ||
		shouldShow("diffLayout") ||
		(shouldShow("mobileStatusBar") && isMobile) ||
		shouldShow("dotfiles") ||
		shouldShow("reasoning") ||
		shouldShow("queueMode") ||
		shouldShow("textJustificationActivity") ||
		shouldShow("activityHeaderTimestamps") ||
		shouldShow("persistDraft");
	const selectedToolExpansionOption = TOOL_EXPANSION_OPTIONS.find(
		(option) => option.value === toolCallExpansion,
	);

	const showPwaInstallNameSetting =
		shouldShow("pwaInstallName") && isWebRuntime() && browserTab;
	const [pwaInstallName, setPwaInstallName] = React.useState("");

	const applyPwaInstallName = React.useCallback(async (value: string) => {
		if (typeof window === "undefined") {
			return;
		}

		const win = window as PwaInstallNameWindow;
		const normalized = value.trim().replace(/\s+/g, " ").slice(0, 64);
		const persistedValue = normalized;

		await updateDesktopSettings({ pwaAppName: persistedValue });

		if (typeof win.__OPENCHAMBER_SET_PWA_INSTALL_NAME__ === "function") {
			const resolved = win.__OPENCHAMBER_SET_PWA_INSTALL_NAME__(persistedValue);
			setPwaInstallName(resolved);
			return;
		}

		setPwaInstallName(persistedValue || DEFAULT_PWA_INSTALL_NAME);
		win.__OPENCHAMBER_UPDATE_PWA_MANIFEST__?.();
	}, []);

	React.useEffect(() => {
		if (typeof window === "undefined" || !showPwaInstallNameSetting) {
			return;
		}

		let cancelled = false;

		const loadPwaInstallName = async () => {
			try {
				const response = await fetch("/api/config/settings", {
					method: "GET",
					headers: { Accept: "application/json" },
					cache: "no-store",
				});

				if (!response.ok) {
					if (!cancelled) {
						setPwaInstallName(DEFAULT_PWA_INSTALL_NAME);
					}
					return;
				}

				const settings = await response.json().catch(() => ({}));
				const raw =
					typeof settings?.pwaAppName === "string" ? settings.pwaAppName : "";
				const normalized = raw.trim().replace(/\s+/g, " ").slice(0, 64);

				if (!cancelled) {
					setPwaInstallName(normalized || DEFAULT_PWA_INSTALL_NAME);
				}
			} catch {
				if (!cancelled) {
					setPwaInstallName(DEFAULT_PWA_INSTALL_NAME);
				}
			}
		};

		void loadPwaInstallName();

		return () => {
			cancelled = true;
		};
	}, [showPwaInstallNameSetting]);

	return (
		<div className="space-y-8">
			<div className="mb-8 space-y-3">
				<section className="px-2 pb-2 pt-0 space-y-0.5">
					<div className="pb-1.5">
						<div className="flex min-w-0 flex-col gap-1.5">
							<span className="typography-ui-header font-medium text-foreground">
								{t("language.label")}
							</span>
							<div className="flex items-center gap-2">
								<Select value={language} onValueChange={setLanguage}>
									<SelectTrigger
										aria-label={t("language.label")}
										className="w-fit"
									>
										<SelectValue />
									</SelectTrigger>
									<SelectContent>
										<SelectItem value="en">{t("language.en")}</SelectItem>
										<SelectItem value="zh-CN">{t("language.zh-CN")}</SelectItem>
									</SelectContent>
								</Select>
							</div>
						</div>
					</div>
				</section>
			</div>

			{/* --- Appearance & Themes --- */}
			{hasAppearanceSettings && (
				<div className="mb-8 space-y-3">
					<section className="px-2 pb-2 pt-0 space-y-0.5">
						<div className="pb-1.5">
							<div className="flex min-w-0 flex-col gap-1.5">
								<span className="typography-ui-header font-medium text-foreground">
									{t("appearance.colorMode")}
								</span>
								<div className="flex flex-wrap items-center gap-1">
									{THEME_MODE_OPTIONS.map((option) => (
										<ButtonSmall
											key={option.value}
											variant="outline"
											size="xs"
											className={cn(
												"!font-normal",
												themeMode === option.value
													? "border-[var(--primary-base)] text-[var(--primary-base)] bg-[var(--primary-base)]/10 hover:text-[var(--primary-base)]"
													: "text-foreground",
											)}
											onClick={() => setThemeMode(option.value)}
										>
											{t(option.labelKey)}
										</ButtonSmall>
									))}
								</div>
							</div>
						</div>

						<div className="mt-2 grid grid-cols-1 gap-2 py-1.5 md:grid-cols-[14rem_auto] md:gap-x-8 md:gap-y-2">
							<div className="flex min-w-0 items-center gap-2">
								<span className="typography-ui-label text-foreground shrink-0">
									{t("appearance.lightTheme")}
								</span>
								<Select
									value={selectedLightTheme?.metadata.id ?? ""}
									onValueChange={setLightThemePreference}
								>
									<SelectTrigger
										aria-label={t("appearance.selectLightTheme")}
										className="w-fit"
									>
										<SelectValue placeholder={t("appearance.selectTheme")} />
									</SelectTrigger>
									<SelectContent>
										{lightThemes.map((theme) => (
											<SelectItem
												key={theme.metadata.id}
												value={theme.metadata.id}
											>
												{formatThemeLabel(theme.metadata.name, "light")}
											</SelectItem>
										))}
									</SelectContent>
								</Select>
							</div>
							<div className="flex min-w-0 items-center gap-2">
								<span className="typography-ui-label text-foreground shrink-0">
									{t("appearance.darkTheme")}
								</span>
								<Select
									value={selectedDarkTheme?.metadata.id ?? ""}
									onValueChange={setDarkThemePreference}
								>
									<SelectTrigger
										aria-label={t("appearance.selectDarkTheme")}
										className="w-fit"
									>
										<SelectValue placeholder={t("appearance.selectTheme")} />
									</SelectTrigger>
									<SelectContent>
										{darkThemes.map((theme) => (
											<SelectItem
												key={theme.metadata.id}
												value={theme.metadata.id}
											>
												{formatThemeLabel(theme.metadata.name, "dark")}
											</SelectItem>
										))}
									</SelectContent>
								</Select>
							</div>
						</div>
						<div className="flex items-center gap-2 py-1.5">
							<button
								type="button"
								disabled={customThemesLoading || themesReloading}
								onClick={() => {
									const startedAt = Date.now();
									setThemesReloading(true);
									void reloadCustomThemes().finally(() => {
										const elapsed = Date.now() - startedAt;
										if (elapsed < 500) {
											window.setTimeout(() => {
												setThemesReloading(false);
											}, 500 - elapsed);
											return;
										}
										setThemesReloading(false);
									});
								}}
								className="inline-flex items-center typography-ui-label font-normal text-foreground underline decoration-[1px] underline-offset-2 hover:text-foreground/80 disabled:cursor-not-allowed disabled:text-muted-foreground/60"
							>
								{themesReloading
									? t("appearance.reloadingThemes")
									: t("appearance.reloadThemes")}
							</button>
							<Tooltip delayDuration={700}>
								<TooltipTrigger asChild>
									<button
										type="button"
										className="flex items-center justify-center rounded-md p-1 text-muted-foreground/70 hover:text-foreground"
										aria-label={t("appearance.themeImportInfo")}
									>
										<RiInformationLine className="h-3.5 w-3.5" />
									</button>
								</TooltipTrigger>
								<TooltipContent sideOffset={8}>
									{t("appearance.themeImportTooltip")}
								</TooltipContent>
							</Tooltip>
						</div>

						{showPwaInstallNameSetting && (
							<div
								className={cn(
									"py-1.5",
									isMobile ? "space-y-2" : "flex items-center gap-8",
								)}
							>
								<div
									className={cn(
										"flex min-w-0 flex-col",
										isMobile ? "w-full" : "w-56 shrink-0",
									)}
								>
									<span className="typography-ui-label text-foreground">
										{t("appearance.installAppName")}
									</span>
									<span className="typography-meta text-muted-foreground">
										{t("appearance.installAppNameDesc")}
									</span>
								</div>
								<div
									className={cn(
										"flex items-center gap-2",
										isMobile ? "w-full" : "w-fit min-w-[22rem]",
									)}
								>
									<Input
										value={pwaInstallName}
										onChange={(event) => {
											setPwaInstallName(event.target.value);
										}}
										onBlur={() => {
											void applyPwaInstallName(pwaInstallName);
										}}
										onKeyDown={(event) => {
											if (event.key === "Enter") {
												event.preventDefault();
												void applyPwaInstallName(pwaInstallName);
											}
										}}
										className="h-7"
										maxLength={64}
										aria-label={t("appearance.installAppName")}
									/>
									<ButtonSmall
										type="button"
										variant="ghost"
										onClick={() => {
											setPwaInstallName(DEFAULT_PWA_INSTALL_NAME);
											void applyPwaInstallName("");
										}}
										className="h-7 w-7 px-0 text-muted-foreground hover:text-foreground"
										aria-label={t("appearance.resetInstallAppName")}
										title={t("common.reset")}
									>
										<RiRestartLine className="h-3.5 w-3.5" />
									</ButtonSmall>
								</div>
							</div>
						)}
					</section>
				</div>
			)}

			{/* --- UI Scaling & Layout --- */}
			{hasLayoutSettings && (
				<div className="mb-8 space-y-3">
					<section className="p-2 space-y-0.5">
						<h4 className="typography-ui-header font-medium text-foreground">
							{t("appearance.spacingLayout")}
						</h4>
						<div className="pl-2">
							{shouldShow("fontSize") && !isMobile && (
								<div className="flex items-center gap-8 py-1">
									<div className="flex min-w-0 flex-col w-56 shrink-0">
										<span className="typography-ui-label text-foreground">
											{t("appearance.interfaceFontSize")}
										</span>
									</div>
									<div className="flex items-center gap-2 w-fit">
										<NumberInput
											value={fontSize}
											onValueChange={setFontSize}
											min={50}
											max={200}
											step={5}
											aria-label={t("appearance.interfaceFontSize")}
											className="w-16"
										/>
										<ButtonSmall
											type="button"
											variant="ghost"
											onClick={() => setFontSize(100)}
											disabled={fontSize === 100}
											className="h-7 w-7 px-0 text-muted-foreground hover:text-foreground"
											aria-label={t("common.reset")}
											title={t("common.reset")}
										>
											<RiRestartLine className="h-3.5 w-3.5" />
										</ButtonSmall>
									</div>
								</div>
							)}

							{shouldShow("terminalFontSize") && (
								<div
									className={cn(
										"py-1",
										isMobile
											? "flex flex-col gap-3"
											: "flex items-center gap-8",
									)}
								>
									<div
										className={cn(
											"flex min-w-0 flex-col",
											isMobile ? "w-full" : "w-56 shrink-0",
										)}
									>
										<span className="typography-ui-label text-foreground">
											{t("appearance.terminalFontSize")}
										</span>
									</div>
									<div
										className={cn(
											"flex items-center gap-2",
											isMobile ? "w-full" : "w-fit",
										)}
									>
										<NumberInput
											value={terminalFontSize}
											onValueChange={setTerminalFontSize}
											min={9}
											max={52}
											step={1}
											className="w-16"
										/>
										<ButtonSmall
											type="button"
											variant="ghost"
											onClick={() => setTerminalFontSize(13)}
											disabled={terminalFontSize === 13}
											className="h-7 w-7 px-0 text-muted-foreground hover:text-foreground"
											aria-label={t("common.reset")}
											title={t("common.reset")}
										>
											<RiRestartLine className="h-3.5 w-3.5" />
										</ButtonSmall>
									</div>
								</div>
							)}

							{shouldShow("spacing") && (
								<div
									className={cn(
										"py-1",
										isMobile
											? "flex flex-col gap-3"
											: "flex items-center gap-8",
									)}
								>
									<div
										className={cn(
											"flex min-w-0 flex-col",
											isMobile ? "w-full" : "w-56 shrink-0",
										)}
									>
										<span className="typography-ui-label text-foreground">
											{t("appearance.spacingDensity")}
										</span>
									</div>
									<div
										className={cn(
											"flex items-center gap-2",
											isMobile ? "w-full" : "w-fit",
										)}
									>
										<NumberInput
											value={padding}
											onValueChange={setPadding}
											min={50}
											max={200}
											step={5}
											className="w-16"
										/>
										<ButtonSmall
											type="button"
											variant="ghost"
											onClick={() => setPadding(100)}
											disabled={padding === 100}
											className="h-7 w-7 px-0 text-muted-foreground hover:text-foreground"
											aria-label={t("common.reset")}
											title={t("common.reset")}
										>
											<RiRestartLine className="h-3.5 w-3.5" />
										</ButtonSmall>
									</div>
								</div>
							)}

							{shouldShow("cornerRadius") && (
								<div
									className={cn(
										"py-1",
										isMobile
											? "flex flex-col gap-3"
											: "flex items-center gap-8",
									)}
								>
									<div
										className={cn(
											"flex min-w-0 flex-col",
											isMobile ? "w-full" : "w-56 shrink-0",
										)}
									>
										<span className="typography-ui-label text-foreground">
											{t("appearance.cornerRadius")}
										</span>
									</div>
									<div
										className={cn(
											"flex items-center gap-2",
											isMobile ? "w-full" : "w-fit",
										)}
									>
										<NumberInput
											value={cornerRadius}
											onValueChange={setCornerRadius}
											min={0}
											max={32}
											step={1}
											className="w-16"
										/>
										<ButtonSmall
											type="button"
											variant="ghost"
											onClick={() => setCornerRadius(12)}
											disabled={cornerRadius === 12}
											className="h-7 w-7 px-0 text-muted-foreground hover:text-foreground"
											aria-label={t("common.reset")}
											title={t("common.reset")}
										>
											<RiRestartLine className="h-3.5 w-3.5" />
										</ButtonSmall>
									</div>
								</div>
							)}

							{shouldShow("inputBarOffset") && (
								<div
									className={cn(
										"py-1",
										isMobile
											? "flex flex-col gap-3"
											: "flex items-center gap-8",
									)}
								>
									<div
										className={cn(
											"flex min-w-0 flex-col",
											isMobile ? "w-full" : "w-56 shrink-0",
										)}
									>
										<div className="flex items-center gap-1.5">
											<span className="typography-ui-label text-foreground">
												{t("appearance.inputBarOffset")}
											</span>
											<Tooltip delayDuration={1000}>
												<TooltipTrigger asChild>
													<RiInformationLine className="h-3.5 w-3.5 text-muted-foreground/60 cursor-help" />
												</TooltipTrigger>
												<TooltipContent sideOffset={8} className="max-w-xs">
													{t("appearance.inputBarOffsetTooltip")}
												</TooltipContent>
											</Tooltip>
										</div>
									</div>
									<div
										className={cn(
											"flex items-center gap-2",
											isMobile ? "w-full" : "w-fit",
										)}
									>
										<NumberInput
											value={inputBarOffset}
											onValueChange={setInputBarOffset}
											min={0}
											max={100}
											step={5}
											className="w-16"
										/>
										<ButtonSmall
											type="button"
											variant="ghost"
											onClick={() => setInputBarOffset(0)}
											disabled={inputBarOffset === 0}
											className="h-7 w-7 px-0 text-muted-foreground hover:text-foreground"
											aria-label={t("common.reset")}
											title={t("common.reset")}
										>
											<RiRestartLine className="h-3.5 w-3.5" />
										</ButtonSmall>
									</div>
								</div>
							)}
						</div>
					</section>
				</div>
			)}

			{/* --- Navigation --- */}
			{hasNavigationSettings && (
				<div className="space-y-3">
					<section className="px-2 pb-2 pt-0">
						<h4 className="typography-ui-header font-medium text-foreground">
							{t("appearance.navigation")}
						</h4>
						{shouldShow("navRail") && !isMobile && (
							<div className="group mt-1.5 flex cursor-pointer items-center gap-2 py-1.5">
								<Checkbox
									checked={isNavRailExpanded}
									onChange={setNavRailExpanded}
									ariaLabel={t("appearance.expandProjectRail")}
								/>
								<div className="flex min-w-0 items-center gap-1.5">
									<span className="typography-ui-label text-foreground">
										{t("appearance.expandProjectRail")}
									</span>
									<Tooltip delayDuration={1000}>
										<TooltipTrigger asChild>
											<RiInformationLine className="h-3.5 w-3.5 text-muted-foreground/60 cursor-help" />
										</TooltipTrigger>
										<TooltipContent sideOffset={8} className="max-w-xs">
											{t("appearance.expandProjectRailTooltip")}
										</TooltipContent>
									</Tooltip>
								</div>
							</div>
						)}

						{shouldShow("terminalQuickKeys") && !isMobile && (
							<div className="group flex cursor-pointer items-center gap-2 py-1.5">
								<Checkbox
									checked={showTerminalQuickKeysOnDesktop}
									onChange={setShowTerminalQuickKeysOnDesktop}
									ariaLabel={t("appearance.terminalQuickKeys")}
								/>
								<div className="flex min-w-0 items-center gap-1.5">
									<span className="typography-ui-label text-foreground">
										{t("appearance.terminalQuickKeys")}
									</span>
									<Tooltip delayDuration={1000}>
										<TooltipTrigger asChild>
											<RiInformationLine className="h-3.5 w-3.5 text-muted-foreground/60 cursor-help" />
										</TooltipTrigger>
										<TooltipContent sideOffset={8} className="max-w-xs">
											{t("appearance.terminalQuickKeysTooltip")}
										</TooltipContent>
									</Tooltip>
								</div>
							</div>
						)}
					</section>
				</div>
			)}

			{hasBehaviorSettings && (
				<div className="space-y-3">
					{shouldShow("toolOutput") && (
						<section className="px-2 pb-2 pt-0">
							<h4 className="typography-ui-header font-medium text-foreground">
								{t("appearance.defaultToolOutput")}
							</h4>
							<div className="mt-1.5 flex flex-wrap items-center gap-1">
								{TOOL_EXPANSION_OPTIONS.map((option) => {
									return (
										<ButtonSmall
											key={option.value}
											type="button"
											variant="outline"
											size="xs"
											className={cn(
												"!font-normal",
												toolCallExpansion === option.value
													? "border-[var(--primary-base)] text-[var(--primary-base)] bg-[var(--primary-base)]/10 hover:text-[var(--primary-base)]"
													: "text-foreground",
											)}
											onClick={() => setToolCallExpansion(option.value)}
										>
											{t(option.labelKey)}
										</ButtonSmall>
									);
								})}
							</div>
							{selectedToolExpansionOption && (
								<p className="mt-2 typography-ui-label font-normal text-muted-foreground">
									{t(selectedToolExpansionOption.descriptionKey)}
								</p>
							)}
						</section>
					)}

					{(shouldShow("userMessageRendering") ||
						shouldShow("mermaidRendering") ||
						(shouldShow("diffLayout") && !isVSCode)) && (
						<div className="grid grid-cols-1 gap-y-2 md:grid-cols-[minmax(0,16rem)_minmax(0,16rem)] md:justify-start md:gap-x-2">
							{shouldShow("userMessageRendering") && (
								<section className="p-2">
									<h4 className="typography-ui-header font-medium text-foreground">
										{t("appearance.userMessageRendering")}
									</h4>
									<div
										role="radiogroup"
										aria-label={t("appearance.userMessageRendering")}
										className="mt-1 space-y-0"
									>
										{USER_MESSAGE_RENDERING_OPTIONS.map((option) => {
											const selected =
												normalizeUserMessageRenderingMode(
													userMessageRenderingMode,
												) === option.id;
											const optionLabel = t(option.labelKey);
											return (
												<div
													key={option.id}
													className="flex w-full items-center gap-2 py-0.5 text-left"
												>
													<Radio
														checked={selected}
														onChange={() =>
															handleUserMessageRenderingModeChange(option.id)
														}
														ariaLabel={`${t("appearance.userMessageRendering")}: ${optionLabel}`}
													/>
													<span
														className={cn(
															"typography-ui-label font-normal",
															selected
																? "text-foreground"
																: "text-foreground/50",
														)}
													>
														{optionLabel}
													</span>
												</div>
											);
										})}
									</div>
								</section>
							)}

							{shouldShow("mermaidRendering") && (
								<section className="p-2">
									<h4 className="typography-ui-header font-medium text-foreground">
										{t("appearance.mermaidRendering")}
									</h4>
									<div
										role="radiogroup"
										aria-label={t("appearance.mermaidRendering")}
										className="mt-1 space-y-0"
									>
										{MERMAID_RENDERING_OPTIONS.map((option) => {
											const selected = mermaidRenderingMode === option.id;
											const optionLabel = t(option.labelKey);
											return (
												<div
													key={option.id}
													className="flex w-full items-center gap-2 py-0.5 text-left"
												>
													<Radio
														checked={selected}
														onChange={() => setMermaidRenderingMode(option.id)}
														ariaLabel={`${t("appearance.mermaidRendering")}: ${optionLabel}`}
													/>
													<span
														className={cn(
															"typography-ui-label font-normal",
															selected
																? "text-foreground"
																: "text-foreground/50",
														)}
													>
														{optionLabel}
													</span>
												</div>
											);
										})}
									</div>
								</section>
							)}

							{shouldShow("diffLayout") && !isVSCode && (
								<section className="p-2">
									<h4 className="typography-ui-header font-medium text-foreground">
										{t("appearance.diffLayout")}
									</h4>
									<div
										role="radiogroup"
										aria-label={t("appearance.diffLayout")}
										className="mt-1 space-y-0"
									>
										{DIFF_LAYOUT_OPTIONS.map((option) => {
											const selected = diffLayoutPreference === option.id;
											const optionLabel = t(option.labelKey);
											return (
												<div
													key={option.id}
													className="flex w-full items-center gap-2 py-0.5 text-left"
												>
													<Radio
														checked={selected}
														onChange={() => setDiffLayoutPreference(option.id)}
														ariaLabel={`${t("appearance.diffLayout")}: ${optionLabel}`}
													/>
													<span
														className={cn(
															"typography-ui-label font-normal",
															selected
																? "text-foreground"
																: "text-foreground/50",
														)}
													>
														{optionLabel}
													</span>
												</div>
											);
										})}
									</div>
								</section>
							)}

							{shouldShow("diffLayout") && !isVSCode && (
								<section className="p-2">
									<h4 className="typography-ui-header font-medium text-foreground">
										{t("appearance.diffViewMode")}
									</h4>
									<div
										role="radiogroup"
										aria-label={t("appearance.diffViewMode")}
										className="mt-1 space-y-0"
									>
										{DIFF_VIEW_MODE_OPTIONS.map((option) => {
											const selected = diffViewMode === option.id;
											const optionLabel = t(option.labelKey);
											return (
												<div
													key={option.id}
													className="flex w-full items-center gap-2 py-0.5 text-left"
												>
													<Radio
														checked={selected}
														onChange={() => setDiffViewMode(option.id)}
														ariaLabel={`${t("appearance.diffViewMode")}: ${optionLabel}`}
													/>
													<span
														className={cn(
															"typography-ui-label font-normal",
															selected
																? "text-foreground"
																: "text-foreground/50",
														)}
													>
														{optionLabel}
													</span>
												</div>
											);
										})}
									</div>
								</section>
							)}
						</div>
					)}

				{(shouldShow("stickyUserHeader") ||
					(shouldShow("mobileStatusBar") && isMobile) ||
					(shouldShow("mobileKeyboardTools") && isMobile) ||
					shouldShow("dotfiles") ||
						shouldShow("queueMode") ||
						shouldShow("persistDraft") ||
						shouldShow("reasoning") ||
						shouldShow("textJustificationActivity")) && (
						<section className="p-2 space-y-0.5">
							{shouldShow("stickyUserHeader") && (
								<div className="group flex cursor-pointer items-center gap-2 py-1.5">
									<Checkbox
										checked={stickyUserHeader}
										onChange={handleStickyUserHeaderChange}
										ariaLabel={t("appearance.stickyUserHeader")}
									/>
									<span className="typography-ui-label text-foreground">
										{t("appearance.stickyUserHeader")}
									</span>
								</div>
							)}

						{shouldShow("mobileStatusBar") && isMobile && (
							<div className="group flex cursor-pointer items-center gap-2 py-1.5">
								<Checkbox
									checked={showMobileSessionStatusBar}
									onChange={setShowMobileSessionStatusBar}
									ariaLabel={t("appearance.showMobileStatusBar")}
								/>
								<span className="typography-ui-label text-foreground">
									{t("appearance.showMobileStatusBar")}
								</span>
							</div>
						)}

						{shouldShow("mobileKeyboardTools") && isMobile && (
							<div className="group flex cursor-pointer items-center gap-2 py-1.5">
								<Checkbox
									checked={showMobileKeyboardTools}
									onChange={setShowMobileKeyboardTools}
									ariaLabel={t("appearance.showMobileKeyboardTools")}
								/>
								<span className="typography-ui-label text-foreground">
									{t("appearance.showMobileKeyboardTools")}
								</span>
							</div>
						)}

							{shouldShow("dotfiles") && !isVSCodeRuntime() && (
								<div className="group flex cursor-pointer items-center gap-2 py-1.5">
									<Checkbox
										checked={directoryShowHidden}
										onChange={setDirectoryShowHidden}
										ariaLabel={t("appearance.showDotfiles")}
									/>
									<span className="typography-ui-label text-foreground">
										{t("appearance.showDotfiles")}
									</span>
								</div>
							)}

							{shouldShow("queueMode") && (
								<div className="group flex cursor-pointer items-center gap-2 py-1.5">
									<Checkbox
										checked={queueModeEnabled}
										onChange={setQueueMode}
										ariaLabel={t("appearance.queueMessages")}
									/>
									<div className="flex min-w-0 items-center gap-1.5">
										<span className="typography-ui-label text-foreground">
											{t("appearance.queueMessages")}
										</span>
										<Tooltip delayDuration={1000}>
											<TooltipTrigger asChild>
												<RiInformationLine className="h-3.5 w-3.5 text-muted-foreground/60 cursor-help" />
											</TooltipTrigger>
											<TooltipContent sideOffset={8} className="max-w-xs">
												{t("appearance.queueMessagesTooltip", {
													modifier: getModifierLabel(),
												})}
											</TooltipContent>
										</Tooltip>
									</div>
								</div>
							)}

							{shouldShow("persistDraft") && (
								<div className="group flex cursor-pointer items-center gap-2 py-1.5">
									<Checkbox
										checked={persistChatDraft}
										onChange={setPersistChatDraft}
										ariaLabel={t("appearance.persistDraft")}
									/>
									<span className="typography-ui-label text-foreground">
										{t("appearance.persistDraft")}
									</span>
								</div>
							)}

							{shouldShow("reasoning") && (
								<div className="group flex cursor-pointer items-center gap-2 py-1.5">
									<Checkbox
										checked={showReasoningTraces}
										onChange={setShowReasoningTraces}
										ariaLabel={t("appearance.showReasoning")}
									/>
									<span className="typography-ui-label text-foreground">
										{t("appearance.showReasoning")}
									</span>
								</div>
							)}

							{shouldShow("textJustificationActivity") && (
								<div className="group flex cursor-pointer items-center gap-2 py-1.5">
									<Checkbox
										checked={showTextJustificationActivity}
										onChange={setShowTextJustificationActivity}
										ariaLabel={t("appearance.showJustification")}
									/>
									<span className="typography-ui-label text-foreground">
										{t("appearance.showJustification")}
									</span>
								</div>
							)}

							{shouldShow("activityHeaderTimestamps") && (
								<div className="group flex cursor-pointer items-center gap-2 py-1.5">
									<Checkbox
										checked={showActivityHeaderTimestamps}
										onChange={setShowActivityHeaderTimestamps}
										ariaLabel={t("appearance.showTimestamps")}
									/>
									<span className="typography-ui-label text-foreground">
										{t("appearance.showTimestamps")}
									</span>
								</div>
							)}
						</section>
					)}
				</div>
			)}
		</div>
	);
};
