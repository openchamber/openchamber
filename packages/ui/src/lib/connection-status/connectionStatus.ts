import type {
    OpenCodeRuntimeState,
    RuntimeTransportState,
} from '@/stores/useConfigStore';

/**
 * User-facing tone of the connection dot. Per the binding user decisions:
 * - `reconnecting` / `unknown` use `'muted'` (theme-muted neutral), NOT amber.
 * - `connected` uses `'ok'`.
 * - `disconnected` / `offline` use `'error'`.
 * - `degraded` uses `'warn'` (runtime-only degraded case where OpenCode is
 *   unhealthy but the frontend transport is still up).
 */
export type ConnectionTone = 'ok' | 'warn' | 'error' | 'muted';

/** Overall connection verdict shown as the dot's color and the overall hover line. */
export type ConnectionOverall =
    | 'connected'
    | 'reconnecting'
    | 'degraded'
    | 'disconnected'
    | 'unknown';

/** One hop's presentation state. */
export type HopState = {
    /** Short stable i18n key that resolves to a user-facing label. */
    labelKey: string;
    /**
     * Optional short stable i18n key for a reason ("offline", "auth required").
     * `null` when the hop is healthy or the raw reason is unrecognized.
     */
    reasonKey: string | null;
    /**
     * Raw internal code preserved for diagnostics only — never rendered in the
     * normal UI. Callers must not include this in hover content.
     */
    rawReason: string | null;
};

/**
 * Aggregated view model. The hover always shows BOTH hop lines per the
 * binding user decision (no collapsing to a single reason line).
 */
export type ConnectionStatusViewModel = {
    overall: ConnectionOverall;
    tone: ConnectionTone;
    /** Short stable i18n key for the overall verdict label. */
    overallLabelKey: string;
    /** Frontend ↔ OpenChamber runtime hop. */
    hop1: HopState;
    /** OpenChamber runtime ↔ OpenCode hop. */
    hop2: HopState;
    /**
     * Pre-rendered hover lines. The consumer translates each `key` with the
     * i18n store. When a `params` block is present, the consumer MUST resolve
     * the `reasonKey` param by calling `t(reasonKey)` separately to compose
     * the localized reason text. This intentionally uses complete-message keys
     * for the optional reason clause (per the i18n mapping note in the plan:
     * optional clauses must not use the reason as a grammar fragment).
     */
    tooltipLines: Array<{ key: string; params?: Record<string, string | number> }>;
};

/** Stable i18n keys used by the view model. Kept as constants for testability. */
const KEY_HOP1_CONNECTED = 'connectionStatus.hop1.connected';
const KEY_HOP1_CONNECTING = 'connectionStatus.hop1.connecting';
const KEY_HOP1_RECONNECTING = 'connectionStatus.hop1.reconnecting';
const KEY_HOP1_DISCONNECTED = 'connectionStatus.hop1.disconnected';

const KEY_HOP2_HEALTHY = 'connectionStatus.hop2.healthy';
const KEY_HOP2_UNHEALTHY = 'connectionStatus.hop2.unhealthy';
const KEY_HOP2_UNKNOWN = 'connectionStatus.hop2.unknown';

const KEY_REASON_OFFLINE = 'connectionStatus.reason.offline';
const KEY_REASON_AUTH_REQUIRED = 'connectionStatus.reason.authRequired';
const KEY_REASON_UNAVAILABLE = 'connectionStatus.reason.unavailable';
const KEY_REASON_TIMEOUT = 'connectionStatus.reason.timeout';

const KEY_OVERALL_CONNECTED = 'connectionStatus.overall.connected';
const KEY_OVERALL_RECONNECTING = 'connectionStatus.overall.reconnecting';
const KEY_OVERALL_DEGRADED = 'connectionStatus.overall.degraded';
const KEY_OVERALL_DISCONNECTED = 'connectionStatus.overall.disconnected';
const KEY_OVERALL_UNKNOWN = 'connectionStatus.overall.unknown';

const KEY_TOOLTIP_TITLE = 'connectionStatus.tooltip.title';

/**
 * Map a raw internal disconnect/health reason code to one of a small set of
 * user-facing i18n keys. Returns `null` for unrecognized codes — the consumer
 * will then show a generic reason.
 *
 * This is a small, deliberately under-categorized helper. The order of the
 * checks is the precedence: offline beats auth, auth beats unavailable,
 * unavailable beats timeout/heartbeat. The check order matters when a raw
 * reason could match more than one category (e.g. `auth_timeout` resolves to
 * `authRequired` because the auth branch is checked first).
 *
 * Implementation note: explicit substring tests (`.includes`) and exact
 * equality — no regex, no over-categorization. Per the binding user decision,
 * raw internal codes must NEVER appear in i18n keys.
 */
export const classifyReason = (raw: string | null): string | null => {
    if (raw === null) {
        return null;
    }

    if (raw.includes('offline')) {
        return KEY_REASON_OFFLINE;
    } else if (
        raw.includes('auth')
        || raw === '401'
        || raw === '403'
        || raw === 'unauthorized'
        || raw === 'forbidden'
    ) {
        return KEY_REASON_AUTH_REQUIRED;
    } else if (
        raw.includes('init_error')
        || raw.includes('unhealthy')
        || raw.includes('unavailable')
        || raw.includes('failed')
        || raw.includes('error')
    ) {
        return KEY_REASON_UNAVAILABLE;
    } else if (raw.includes('timeout') || raw.includes('heartbeat')) {
        return KEY_REASON_TIMEOUT;
    } else {
        return null;
    }
};

/** Project the runtime ↔ OpenCode hop state into a presentation `HopState`. */
const projectOpenCodeHop = (openCode: OpenCodeRuntimeState): HopState => {
    switch (openCode.phase) {
        case 'healthy':
            return {
                labelKey: KEY_HOP2_HEALTHY,
                reasonKey: null,
                rawReason: null,
            };
        case 'unhealthy':
            return {
                labelKey: KEY_HOP2_UNHEALTHY,
                reasonKey: classifyReason(openCode.reason),
                rawReason: openCode.reason,
            };
        case 'unknown':
            return {
                labelKey: KEY_HOP2_UNKNOWN,
                reasonKey: null,
                rawReason: null,
            };
        default: {
            // Defensive: unknown runtime phase → fall back to the unknown key.
            // Runtime transport phase union is closed, but TypeScript can't
            // prove exhaustiveness through the switch without `never`.
            const _exhaustive: never = openCode.phase;
            void _exhaustive;
            return {
                labelKey: KEY_HOP2_UNKNOWN,
                reasonKey: null,
                rawReason: null,
            };
        }
    }
};

/** Build a `tooltipLines` entry for one hop. The `reasonKey` param is the
 *  i18n key for the reason; the consumer resolves it by calling
 *  `t(reasonKey)` separately (per the i18n mapping note in the plan). */
const buildHopTooltipLine = (hop: HopState): { key: string; params?: Record<string, string | number> } => {
    if (hop.reasonKey === null) {
        return { key: hop.labelKey };
    }
    return {
        key: hop.labelKey,
        params: { reasonKey: hop.reasonKey },
    };
};

/**
 * Build the aggregated connection-status view model.
 *
 * This is a pure, deterministic helper: it does not read globals, does not
 * touch `Date.now()`, and has no side effects. The caller (component/hook)
 * is responsible for observing the browser's `navigator.onLine` state and
 * passing it as `navigatorOffline`.
 *
 * Aggregation precedence (apply top-down; the first matching branch wins):
 *  1. browser offline (`navigatorOffline`) OR transport `offline` → disconnected / error
 *  2. transport `disconnected` → disconnected / error
 *  3. transport `reconnecting` → reconnecting / muted
 *  4. transport `connecting` → unknown / muted
 *  5. transport `connected` + opencode `unhealthy` → degraded / warn
 *  6. transport `connected` + opencode `healthy` → connected / ok
 *  7. transport `connected` + opencode `unknown` (or any unhandled combo) → unknown / muted
 */
export function buildConnectionStatusViewModel(input: {
    runtimeTransport: RuntimeTransportState;
    openCodeRuntime: OpenCodeRuntimeState;
    /** True iff `navigator.onLine === false`. */
    navigatorOffline: boolean;
}): ConnectionStatusViewModel {
    const { runtimeTransport, openCodeRuntime, navigatorOffline } = input;

    // --- Step 1: pick overall + tone + hop1 labelKey based on transport phase
    let overall: ConnectionOverall;
    let tone: ConnectionTone;
    let overallLabelKey: string;
    let hop1: HopState;

    if (navigatorOffline || runtimeTransport.phase === 'offline') {
        overall = 'disconnected';
        tone = 'error';
        overallLabelKey = KEY_OVERALL_DISCONNECTED;
        hop1 = {
            labelKey: KEY_HOP1_DISCONNECTED,
            reasonKey: KEY_REASON_OFFLINE,
            rawReason: 'offline',
        };
    } else if (runtimeTransport.phase === 'disconnected') {
        overall = 'disconnected';
        tone = 'error';
        overallLabelKey = KEY_OVERALL_DISCONNECTED;
        hop1 = {
            labelKey: KEY_HOP1_DISCONNECTED,
            reasonKey: classifyReason(runtimeTransport.reason),
            rawReason: runtimeTransport.reason,
        };
    } else if (runtimeTransport.phase === 'reconnecting') {
        overall = 'reconnecting';
        tone = 'muted';
        overallLabelKey = KEY_OVERALL_RECONNECTING;
        hop1 = {
            labelKey: KEY_HOP1_RECONNECTING,
            reasonKey: classifyReason(runtimeTransport.reason),
            rawReason: runtimeTransport.reason,
        };
    } else if (runtimeTransport.phase === 'connecting') {
        overall = 'unknown';
        tone = 'muted';
        overallLabelKey = KEY_OVERALL_UNKNOWN;
        hop1 = {
            labelKey: KEY_HOP1_CONNECTING,
            reasonKey: null,
            rawReason: null,
        };
    } else if (
        runtimeTransport.phase === 'connected'
        && openCodeRuntime.phase === 'unhealthy'
    ) {
        overall = 'degraded';
        tone = 'warn';
        overallLabelKey = KEY_OVERALL_DEGRADED;
        hop1 = {
            labelKey: KEY_HOP1_CONNECTED,
            reasonKey: null,
            rawReason: null,
        };
    } else if (
        runtimeTransport.phase === 'connected'
        && openCodeRuntime.phase === 'healthy'
    ) {
        overall = 'connected';
        tone = 'ok';
        overallLabelKey = KEY_OVERALL_CONNECTED;
        hop1 = {
            labelKey: KEY_HOP1_CONNECTED,
            reasonKey: null,
            rawReason: null,
        };
    } else {
        // `connected` + `unknown` (or any unhandled combo — kept narrow on
        // purpose; new phases should be added explicitly above).
        overall = 'unknown';
        tone = 'muted';
        overallLabelKey = KEY_OVERALL_UNKNOWN;
        hop1 = {
            labelKey: KEY_HOP1_CONNECTED,
            reasonKey: null,
            rawReason: null,
        };
    }

    // --- Step 2: pick hop2 based on opencode phase
    const hop2 = projectOpenCodeHop(openCodeRuntime);

    // --- Step 3: assemble the tooltip lines. Per the binding user decision,
    // we always emit a header line + two hop lines; the `reason` is sometimes
    // short (passed via `params.reasonKey` for the i18n resolver to compose).
    const tooltipLines: ConnectionStatusViewModel['tooltipLines'] = [
        { key: KEY_TOOLTIP_TITLE },
        buildHopTooltipLine(hop1),
        buildHopTooltipLine(hop2),
    ];

    return {
        overall,
        tone,
        overallLabelKey,
        hop1,
        hop2,
        tooltipLines,
    };
}
