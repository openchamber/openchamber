import { describe, expect, test } from 'bun:test';

import type {
    OpenCodeRuntimeState,
    RuntimeTransportState,
} from '@/stores/useConfigStore';

import {
    buildConnectionStatusViewModel,
    classifyReason,
    type ConnectionStatusViewModel,
} from './connectionStatus';

const transportConnected: RuntimeTransportState = {
    phase: 'connected',
    reason: null,
    updatedAt: 0,
};

const transportConnecting: RuntimeTransportState = {
    phase: 'connecting',
    reason: null,
    updatedAt: 0,
};

const transportReconnecting: RuntimeTransportState = {
    phase: 'reconnecting',
    reason: 'ws_closed:code=1006',
    updatedAt: 0,
};

const transportDisconnected: RuntimeTransportState = {
    phase: 'disconnected',
    reason: 'ws_error_frame:HTTP 502',
    updatedAt: 0,
};

const transportOffline: RuntimeTransportState = {
    phase: 'offline',
    reason: 'offline',
    updatedAt: 0,
};

const openCodeHealthy: OpenCodeRuntimeState = {
    phase: 'healthy',
    reason: null,
    updatedAt: 0,
};

const openCodeUnhealthy: OpenCodeRuntimeState = {
    phase: 'unhealthy',
    reason: 'health_check_unhealthy',
    updatedAt: 0,
};

const openCodeUnknown: OpenCodeRuntimeState = {
    phase: 'unknown',
    reason: null,
    updatedAt: 0,
};

const HOP1_CONNECTED = 'connectionStatus.hop1.connected';
const HOP1_CONNECTING = 'connectionStatus.hop1.connecting';
const HOP1_RECONNECTING = 'connectionStatus.hop1.reconnecting';
const HOP1_DISCONNECTED = 'connectionStatus.hop1.disconnected';

const HOP2_HEALTHY = 'connectionStatus.hop2.healthy';
const HOP2_UNHEALTHY = 'connectionStatus.hop2.unhealthy';
const HOP2_UNKNOWN = 'connectionStatus.hop2.unknown';

const REASON_OFFLINE = 'connectionStatus.reason.offline';
const REASON_AUTH = 'connectionStatus.reason.authRequired';
const REASON_UNAVAILABLE = 'connectionStatus.reason.unavailable';
const REASON_TIMEOUT = 'connectionStatus.reason.timeout';

const OVERALL_CONNECTED = 'connectionStatus.overall.connected';
const OVERALL_RECONNECTING = 'connectionStatus.overall.reconnecting';
const OVERALL_DEGRADED = 'connectionStatus.overall.degraded';
const OVERALL_DISCONNECTED = 'connectionStatus.overall.disconnected';
const OVERALL_UNKNOWN = 'connectionStatus.overall.unknown';

const TOOLTIP_TITLE = 'connectionStatus.tooltip.title';

describe('buildConnectionStatusViewModel', () => {
    test('fresh connected startup: both hops healthy', () => {
        const vm = buildConnectionStatusViewModel({
            runtimeTransport: transportConnected,
            openCodeRuntime: openCodeHealthy,
            navigatorOffline: false,
        });

        expect(vm.overall).toBe('connected');
        expect(vm.tone).toBe('ok');
        expect(vm.overallLabelKey).toBe(OVERALL_CONNECTED);
        expect(vm.hop1.labelKey).toBe(HOP1_CONNECTED);
        expect(vm.hop1.reasonKey).toBeNull();
        expect(vm.hop1.rawReason).toBeNull();
        expect(vm.hop2.labelKey).toBe(HOP2_HEALTHY);
        expect(vm.hop2.reasonKey).toBeNull();
        expect(vm.hop2.rawReason).toBeNull();
    });

    test('runtime restart / reconnect: transport reconnecting with ws_closed reason', () => {
        const vm = buildConnectionStatusViewModel({
            runtimeTransport: transportReconnecting,
            openCodeRuntime: openCodeHealthy,
            navigatorOffline: false,
        });

        expect(vm.overall).toBe('reconnecting');
        // Per the binding user decision: reconnecting → muted (theme-muted
        // neutral), NOT amber.
        expect(vm.tone).toBe('muted');
        expect(vm.overallLabelKey).toBe(OVERALL_RECONNECTING);
        expect(vm.hop1.labelKey).toBe(HOP1_RECONNECTING);
        // `ws_closed:code=1006` does not match any classifyReason rule, so the
        // classified reason is null. The raw reason is preserved on hop1 for
        // diagnostics only.
        expect(vm.hop1.reasonKey).toBe(classifyReason('ws_closed:code=1006'));
        expect(vm.hop1.reasonKey).toBeNull();
        expect(vm.hop1.rawReason).toBe('ws_closed:code=1006');
        // hop2 reports whatever the opencode state currently says — and the
        // opencode state is still healthy, so hop2 is healthy.
        expect(vm.hop2.labelKey).toBe(HOP2_HEALTHY);
        expect(vm.hop2.reasonKey).toBeNull();
    });

    test('browser offline: navigatorOffline wins regardless of transport phase', () => {
        // The offline path must win even when the transport still believes it
        // is connected (the network stack may not have observed the drop yet).
        const vmConnectedButOffline = buildConnectionStatusViewModel({
            runtimeTransport: transportConnected,
            openCodeRuntime: openCodeHealthy,
            navigatorOffline: true,
        });
        expect(vmConnectedButOffline.overall).toBe('disconnected');
        expect(vmConnectedButOffline.tone).toBe('error');
        expect(vmConnectedButOffline.hop1.reasonKey).toBe(REASON_OFFLINE);
        expect(vmConnectedButOffline.hop1.rawReason).toBe('offline');

        // The offline path also wins when the transport is in a different
        // non-offline phase.
        const vmReconnectingButOffline = buildConnectionStatusViewModel({
            runtimeTransport: transportReconnecting,
            openCodeRuntime: openCodeHealthy,
            navigatorOffline: true,
        });
        expect(vmReconnectingButOffline.overall).toBe('disconnected');
        expect(vmReconnectingButOffline.tone).toBe('error');
        expect(vmReconnectingButOffline.hop1.reasonKey).toBe(REASON_OFFLINE);

        // Transport phase `offline` (without `navigatorOffline`) also lands in
        // the disconnected path with the offline reason.
        const vmTransportOffline = buildConnectionStatusViewModel({
            runtimeTransport: transportOffline,
            openCodeRuntime: openCodeHealthy,
            navigatorOffline: false,
        });
        expect(vmTransportOffline.overall).toBe('disconnected');
        expect(vmTransportOffline.tone).toBe('error');
        expect(vmTransportOffline.hop1.reasonKey).toBe(REASON_OFFLINE);
    });

    test('runtime unreachable: transport disconnected with HTTP 502 error frame', () => {
        // `ws_error_frame:HTTP 502` contains the substring `error` and
        // therefore classifies to `connectionStatus.reason.unavailable` per
        // the explicit substring rules. Documenting this assertion in code
        // so future maintainers understand why this specific reason maps to
        // `unavailable` rather than `null`.
        const vm = buildConnectionStatusViewModel({
            runtimeTransport: transportDisconnected,
            openCodeRuntime: openCodeHealthy,
            navigatorOffline: false,
        });

        expect(vm.overall).toBe('disconnected');
        expect(vm.tone).toBe('error');
        expect(vm.hop1.labelKey).toBe(HOP1_DISCONNECTED);
        expect(vm.hop1.reasonKey).toBe(REASON_UNAVAILABLE);
        expect(vm.hop1.rawReason).toBe('ws_error_frame:HTTP 502');
        // hop2 still reports whatever the opencode state currently says.
        expect(vm.hop2.labelKey).toBe(HOP2_HEALTHY);
    });

    test('init error: transport disconnected with init_error reason and opencode state unknown', () => {
        // Exercises the disconnected overall path with an `init_error` raw
        // reason and an opencode runtime that has not yet reported. Documents
        // that `init_error` classifies to the unavailable reason (per
        // classifyReason's substring rule) and that the opencode hop remains
        // unknown — the dot is disconnected/error, not degraded/warn.
        const vm = buildConnectionStatusViewModel({
            runtimeTransport: { phase: 'disconnected', reason: 'init_error', updatedAt: 0 },
            openCodeRuntime: openCodeUnknown,
            navigatorOffline: false,
        });

        expect(vm.overall).toBe('disconnected');
        expect(vm.overallLabelKey).toBe(OVERALL_DISCONNECTED);
        expect(vm.tone).toBe('error');
        expect(vm.hop1.labelKey).toBe(HOP1_DISCONNECTED);
        expect(vm.hop1.reasonKey).toBe(REASON_UNAVAILABLE);
        expect(vm.hop1.rawReason).toBe('init_error');
        // opencode has not yet reported, so hop2 stays unknown.
        expect(vm.hop2.labelKey).toBe(HOP2_UNKNOWN);
        expect(vm.hop2.reasonKey).toBeNull();
        expect(vm.hop2.rawReason).toBeNull();
    });

    test('opencode unhealthy: transport connected but opencode reports unhealthy', () => {
        const vm = buildConnectionStatusViewModel({
            runtimeTransport: transportConnected,
            openCodeRuntime: openCodeUnhealthy,
            navigatorOffline: false,
        });

        expect(vm.overall).toBe('degraded');
        expect(vm.tone).toBe('warn');
        expect(vm.overallLabelKey).toBe(OVERALL_DEGRADED);
        expect(vm.hop1.labelKey).toBe(HOP1_CONNECTED);
        expect(vm.hop1.reasonKey).toBeNull();
        expect(vm.hop2.labelKey).toBe(HOP2_UNHEALTHY);
        // `health_check_unhealthy` contains the substring `unhealthy` and
        // therefore classifies to `unavailable`.
        expect(vm.hop2.reasonKey).toBe(REASON_UNAVAILABLE);
        expect(vm.hop2.rawReason).toBe('health_check_unhealthy');
    });

    test('transport switch / recovery: post-reconnect transport is connected', () => {
        const vm = buildConnectionStatusViewModel({
            runtimeTransport: { phase: 'connected', reason: null, updatedAt: 0 },
            openCodeRuntime: openCodeHealthy,
            navigatorOffline: false,
        });

        expect(vm.overall).toBe('connected');
        expect(vm.tone).toBe('ok');
        expect(vm.overallLabelKey).toBe(OVERALL_CONNECTED);
    });

    test('unknown: transport connected but opencode phase is unknown', () => {
        const vm = buildConnectionStatusViewModel({
            runtimeTransport: transportConnected,
            openCodeRuntime: openCodeUnknown,
            navigatorOffline: false,
        });

        expect(vm.overall).toBe('unknown');
        // Per the binding user decision: unknown → muted (theme-muted
        // neutral), NOT amber.
        expect(vm.tone).toBe('muted');
        expect(vm.overallLabelKey).toBe(OVERALL_UNKNOWN);
        expect(vm.hop1.labelKey).toBe(HOP1_CONNECTED);
        expect(vm.hop1.reasonKey).toBeNull();
        expect(vm.hop2.labelKey).toBe(HOP2_UNKNOWN);
        expect(vm.hop2.reasonKey).toBeNull();
    });

    test('tooltipLines is always exactly 3 lines (header + 2 hops), per the user decision', () => {
        // Reference-stable contract: the hover always shows the header line
        // plus both hop lines, even when the second hop is not currently
        // knowable. Never collapses to a single reason line.
        const cases: Array<{
            label: string;
            input: Parameters<typeof buildConnectionStatusViewModel>[0];
        }> = [
            {
                label: 'fresh connected',
                input: {
                    runtimeTransport: transportConnected,
                    openCodeRuntime: openCodeHealthy,
                    navigatorOffline: false,
                },
            },
            {
                label: 'reconnecting',
                input: {
                    runtimeTransport: transportReconnecting,
                    openCodeRuntime: openCodeHealthy,
                    navigatorOffline: false,
                },
            },
            {
                label: 'browser offline',
                input: {
                    runtimeTransport: transportConnected,
                    openCodeRuntime: openCodeHealthy,
                    navigatorOffline: true,
                },
            },
            {
                label: 'runtime unreachable',
                input: {
                    runtimeTransport: transportDisconnected,
                    openCodeRuntime: openCodeHealthy,
                    navigatorOffline: false,
                },
            },
            {
                label: 'opencode unhealthy',
                input: {
                    runtimeTransport: transportConnected,
                    openCodeRuntime: openCodeUnhealthy,
                    navigatorOffline: false,
                },
            },
            {
                label: 'unknown',
                input: {
                    runtimeTransport: transportConnected,
                    openCodeRuntime: openCodeUnknown,
                    navigatorOffline: false,
                },
            },
            {
                label: 'connecting',
                input: {
                    runtimeTransport: transportConnecting,
                    openCodeRuntime: openCodeUnknown,
                    navigatorOffline: false,
                },
            },
        ];

        for (const c of cases) {
            const vm: ConnectionStatusViewModel = buildConnectionStatusViewModel(c.input);
            expect(vm.tooltipLines).toHaveLength(3);
            // Line 0 is always the title (no params).
            expect(vm.tooltipLines[0]).toEqual({ key: TOOLTIP_TITLE });
            expect(vm.tooltipLines[0].params).toBe(undefined);
            // Lines 1 and 2 are the hop lines.
            expect(vm.tooltipLines[1].key).toBe(vm.hop1.labelKey);
            expect(vm.tooltipLines[2].key).toBe(vm.hop2.labelKey);
        }
    });

    test('tooltipLines hop1 line carries reasonKey param only when reasonKey is non-null', () => {
        // hop1 with no reason → no params block.
        const healthyVm = buildConnectionStatusViewModel({
            runtimeTransport: transportConnected,
            openCodeRuntime: openCodeHealthy,
            navigatorOffline: false,
        });
        expect(healthyVm.tooltipLines[1].params).toBe(undefined);

        // hop1 with a classified reason → params.reasonKey carries the i18n
        // key, which the consumer translates separately.
        const reconnectingVm = buildConnectionStatusViewModel({
            runtimeTransport: { phase: 'reconnecting', reason: 'auth_required', updatedAt: 0 },
            openCodeRuntime: openCodeHealthy,
            navigatorOffline: false,
        });
        expect(reconnectingVm.tooltipLines[1].key).toBe(HOP1_RECONNECTING);
        expect(reconnectingVm.tooltipLines[1].params).toEqual({ reasonKey: REASON_AUTH });
    });

    test('hop1 reasonKey for transport `connecting` is always null (no raw reason)', () => {
        // The connecting branch ignores the raw reason — there is no classified
        // reason for a brand-new connection attempt.
        const vm = buildConnectionStatusViewModel({
            runtimeTransport: transportConnecting,
            openCodeRuntime: openCodeUnknown,
            navigatorOffline: false,
        });
        expect(vm.overall).toBe('unknown');
        expect(vm.hop1.labelKey).toBe(HOP1_CONNECTING);
        expect(vm.hop1.reasonKey).toBeNull();
        expect(vm.hop1.rawReason).toBeNull();
    });
});

describe('classifyReason', () => {
    test('maps `offline` to the offline reason', () => {
        expect(classifyReason('offline')).toBe(REASON_OFFLINE);
    });

    test('maps `navigator_offline` to the offline reason', () => {
        expect(classifyReason('navigator_offline')).toBe(REASON_OFFLINE);
    });

    test('maps `auth_required` to the authRequired reason', () => {
        expect(classifyReason('auth_required')).toBe(REASON_AUTH);
    });

    test('returns null for `ws_closed:code=1006` (does not match any rule)', () => {
        // Documenting the negative case: this raw code is preserved on
        // `HopState.rawReason` for diagnostics, but does not produce a
        // classified reason key — the consumer will render a generic reason.
        expect(classifyReason('ws_closed:code=1006')).toBeNull();
    });

    test('maps `init_error` to the unavailable reason', () => {
        expect(classifyReason('init_error')).toBe(REASON_UNAVAILABLE);
    });

    test('maps `health_check_unhealthy` to the unavailable reason', () => {
        expect(classifyReason('health_check_unhealthy')).toBe(REASON_UNAVAILABLE);
    });

    test('maps `sse_heartbeat_timeout` to the timeout reason', () => {
        expect(classifyReason('sse_heartbeat_timeout')).toBe(REASON_TIMEOUT);
    });

    test('returns null for an unrecognized reason string', () => {
        expect(classifyReason('something_totally_unrecognized')).toBeNull();
    });

    test('returns null for null input', () => {
        expect(classifyReason(null)).toBeNull();
    });

    test('maps 401 / 403 / unauthorized / forbidden to the authRequired reason', () => {
        expect(classifyReason('401')).toBe(REASON_AUTH);
        expect(classifyReason('403')).toBe(REASON_AUTH);
        expect(classifyReason('unauthorized')).toBe(REASON_AUTH);
        expect(classifyReason('forbidden')).toBe(REASON_AUTH);
    });

    test('precedence: a string containing both `auth` and `error` resolves to authRequired', () => {
        // `auth_error` contains both substrings, but the auth branch is
        // checked first, so it resolves to `authRequired`. Pinning the
        // precedence here so a future refactor does not silently flip the
        // resolution.
        expect(classifyReason('auth_error')).toBe(REASON_AUTH);
    });
});
