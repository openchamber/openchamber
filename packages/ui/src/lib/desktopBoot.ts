
import { z } from 'zod';


type DesktopBootAvailability = { localAvailable?: boolean };

export type DesktopBootOutcome =
  | ({ target: 'local'; status: 'ok'; sshStartupFallbackHostId?: string } & DesktopBootAvailability)
  | ({ target: 'remote'; status: 'ok'; hostId: string; url: string } & DesktopBootAvailability)

  | ({ target: null; status: 'not-configured' } & DesktopBootAvailability)

  | ({ target: 'local'; status: 'unreachable' } & DesktopBootAvailability)
  | ({ target: 'remote'; status: 'unreachable'; hostId: string; url: string } & DesktopBootAvailability)
  | ({ target: 'remote'; status: 'incompatible'; hostId: string; url: string } & DesktopBootAvailability)
  | ({ target: 'remote'; status: 'wrong-service'; hostId: string; url: string } & DesktopBootAvailability)
  | ({ target: 'remote'; status: 'missing'; hostId: string } & DesktopBootAvailability);


export type DesktopBootView =
  | ({ screen: 'main' } & DesktopBootAvailability)
  | ({ screen: 'main'; hostId: string; url: string } & DesktopBootAvailability)
  | ({ screen: 'chooser' } & DesktopBootAvailability)
  | ({ screen: 'recovery'; variant: 'local-unavailable' } & DesktopBootAvailability)
  | ({ screen: 'recovery'; variant: 'remote-unreachable'; hostId: string; url: string } & DesktopBootAvailability)
  | ({ screen: 'recovery'; variant: 'remote-incompatible'; hostId: string; url: string } & DesktopBootAvailability)
  | ({ screen: 'recovery'; variant: 'remote-wrong-service'; hostId: string; url: string } & DesktopBootAvailability)
  | ({ screen: 'recovery'; variant: 'remote-missing'; hostId: string } & DesktopBootAvailability);


export type DesktopBootViewInput = {
  isDesktopShell: boolean;
  bootOutcome: DesktopBootOutcome | null;
};


const VALID_TARGETS = ['local', 'remote', null] as const;

const VALID_STATUSES = ['ok', 'not-configured', 'unreachable', 'incompatible', 'wrong-service', 'missing'] as const;

type ValidationResult =
  | { valid: true; outcome: DesktopBootOutcome }
  | { valid: false };

function validateBootOutcome(raw: unknown): ValidationResult {
  if (!raw || typeof raw !== 'object') {
    return { valid: false };
  }

  const record = raw as Record<string, unknown>;
  const availability = record.localAvailable === false ? { localAvailable: false } : {};
  const target = record.target;
  const status = record.status;

  if (target !== null && (typeof target !== 'string' || !VALID_TARGETS.includes(target as never))) {
    return { valid: false };
  }

  if (typeof status !== 'string' || !VALID_STATUSES.includes(status as never)) {
    return { valid: false };
  }

  if (target === 'remote' || target === 'local') {
    if (status === 'ok' && target === 'local') {
      const outcome: Extract<DesktopBootOutcome, { target: 'local'; status: 'ok' }> = { target: 'local', status: 'ok', ...availability };
      const fallbackHostId = z.string().min(1).safeParse(record.sshStartupFallbackHostId);
      if (fallbackHostId.success) {
        outcome.sshStartupFallbackHostId = fallbackHostId.data;
      }
      return { valid: true, outcome };
    }

    if (status === 'ok' && target === 'remote') {
      if (typeof record.hostId !== 'string' || typeof record.url !== 'string') {
        return { valid: false };
      }
      return { valid: true, outcome: { target: 'remote', status: 'ok', hostId: record.hostId, url: record.url, ...availability } };
    }

    if (status === 'unreachable') {
      if (target === 'local') {
        return { valid: true, outcome: { target: 'local', status: 'unreachable', ...availability } };
      } else {
        if (typeof record.hostId !== 'string' || typeof record.url !== 'string') {
          return { valid: false };
        }
        return { valid: true, outcome: { target: 'remote', status: 'unreachable', hostId: record.hostId, url: record.url, ...availability } };
      }
    }

    if (status === 'incompatible' || status === 'wrong-service') {
      if (target !== 'remote') return { valid: false };
      if (typeof record.hostId !== 'string' || typeof record.url !== 'string') {
        return { valid: false };
      }
      return { valid: true, outcome: { target: 'remote', status, hostId: record.hostId, url: record.url, ...availability } };
    }

    if (status === 'missing') {
      if (target !== 'remote') return { valid: false };
      if (typeof record.hostId !== 'string') {
        return { valid: false };
      }
      return { valid: true, outcome: { target: 'remote', status: 'missing', hostId: record.hostId, ...availability } };
    }
  }

  if (target === null) {
    if (status === 'not-configured') {
      return { valid: true, outcome: { target: null, status: 'not-configured', ...availability } };
    }

    if (status === 'missing') {
      return { valid: false };
    }
  }

  return { valid: false };
}

export function resolveDesktopBootView(
  input: DesktopBootViewInput,
): DesktopBootView | null {
  if (!input.isDesktopShell) {
    return null;
  }

  const outcome = input.bootOutcome;
  if (!outcome) {
    return null;
  }
  const availability = outcome.localAvailable === false ? { localAvailable: false } : {};

  if (outcome.status === 'ok') {
    if (outcome.target === 'local') {
      return { screen: 'main', ...availability };
    } else if (outcome.target === 'remote') {
      return { screen: 'main', hostId: outcome.hostId, url: outcome.url, ...availability };
    }
  }

  if (outcome.target === null && outcome.status === 'not-configured') {
    return { screen: 'chooser', ...availability };
  }

  if (outcome.target === 'local' && outcome.status === 'unreachable') {
    return { screen: 'chooser', ...availability };
  }

  if (outcome.target === 'remote') {
    if (outcome.status === 'unreachable') {
      return { screen: 'recovery', variant: 'remote-unreachable', hostId: outcome.hostId, url: outcome.url, ...availability };
    } else if (outcome.status === 'incompatible') {
      return { screen: 'recovery', variant: 'remote-incompatible', hostId: outcome.hostId, url: outcome.url, ...availability };
    } else if (outcome.status === 'wrong-service') {
      return { screen: 'recovery', variant: 'remote-wrong-service', hostId: outcome.hostId, url: outcome.url, ...availability };
    } else if (outcome.status === 'missing') {
      return { screen: 'recovery', variant: 'remote-missing', hostId: outcome.hostId, ...availability };
    }
  }

  return null;
}


export type BootInjectionStatus =
  | 'not-injected'
  | 'malformed'
  | 'valid';

export type InitialLoadingState = {
  isDesktopShell: boolean;
  bootOutcomeKnown: boolean;
};

export type DesktopBootFlowRestartInput = {
  isDesktopShell: boolean;
  isDesktopLocalOriginActive: boolean;
};

export function canDismissInitialLoading(state: InitialLoadingState): boolean {
  return !state.isDesktopShell || state.bootOutcomeKnown;
}

export function shouldRestartDesktopBootFlow(input: DesktopBootFlowRestartInput): boolean {
  return input.isDesktopShell && !input.isDesktopLocalOriginActive;
}

export function getInjectedBootOutcome(): DesktopBootOutcome | null {
  const status = getBootInjectionStatus();
  if (status !== 'valid') {
    return null;
  }

  const raw = (window as { __OPENCHAMBER_DESKTOP_BOOT_OUTCOME__?: unknown })
    .__OPENCHAMBER_DESKTOP_BOOT_OUTCOME__;

  const result = validateBootOutcome(raw);
  return result.valid ? result.outcome : null;
}

export function getBootInjectionStatus(): BootInjectionStatus {
  if (typeof window === 'undefined') {
    return 'not-injected';
  }

  const raw = (window as { __OPENCHAMBER_DESKTOP_BOOT_OUTCOME__?: unknown })
    .__OPENCHAMBER_DESKTOP_BOOT_OUTCOME__;

  if (raw === undefined || raw === null) {
    return 'not-injected';
  }

  const result = validateBootOutcome(raw);
  return result.valid ? 'valid' : 'malformed';
}
