import { describe, expect, it } from 'vitest';
import {
  BROWSER_BACKEND,
  BROWSER_ERROR_CODES,
  ORIGIN_CLASS,
  OP_TIER,
  classifyOrigin,
  dynamicTier,
  evaluateConsent,
  isExternalNavigationBlocked,
  opFromToolName,
  resolveCapability,
  routeToolCall,
  toolNameFromOp,
} from './command-router.js';

const desktop = { backend: BROWSER_BACKEND.DESKTOP_CDP, originClass: ORIGIN_CLASS.EXTERNAL };
const webLocal = { backend: BROWSER_BACKEND.WEB_IFRAME, originClass: ORIGIN_CLASS.LOCALHOST };
const webExternal = { backend: BROWSER_BACKEND.WEB_IFRAME, originClass: ORIGIN_CLASS.EXTERNAL };

const policyOn = { enabled: true, advancedEnabled: false };
const policyAdvanced = { enabled: true, advancedEnabled: true };
const policyOff = { enabled: false };

describe('tool <-> op mapping', () => {
  it('round-trips browser_ prefix', () => {
    expect(opFromToolName('browser_click')).toBe('click');
    expect(toolNameFromOp('click')).toBe('browser_click');
    expect(opFromToolName('not_a_browser_tool')).toBeNull();
  });
});

describe('classifyOrigin', () => {
  it('treats loopback + *.localhost as localhost', () => {
    expect(classifyOrigin('http://localhost:3000')).toBe(ORIGIN_CLASS.LOCALHOST);
    expect(classifyOrigin('http://127.0.0.1:5173/x')).toBe(ORIGIN_CLASS.LOCALHOST);
    expect(classifyOrigin('http://app.localhost:8080')).toBe(ORIGIN_CLASS.LOCALHOST);
  });
  it('treats real hosts as external and blank for empty/about:blank', () => {
    expect(classifyOrigin('https://example.com')).toBe(ORIGIN_CLASS.EXTERNAL);
    expect(classifyOrigin('about:blank')).toBe(ORIGIN_CLASS.BLANK);
    expect(classifyOrigin('')).toBe(ORIGIN_CLASS.BLANK);
    expect(classifyOrigin('not a url')).toBe(ORIGIN_CLASS.BLANK);
  });
});

describe('resolveCapability', () => {
  it('desktop supports DOM ops on any origin', () => {
    expect(resolveCapability({ op: 'click', backend: BROWSER_BACKEND.DESKTOP_CDP, originClass: ORIGIN_CLASS.EXTERNAL }).supported).toBe(true);
    expect(resolveCapability({ op: 'evaluate', backend: BROWSER_BACKEND.DESKTOP_CDP, originClass: ORIGIN_CLASS.EXTERNAL }).supported).toBe(true);
  });
  it('web localhost supports DOM ops', () => {
    expect(resolveCapability({ op: 'snapshot', backend: BROWSER_BACKEND.WEB_IFRAME, originClass: ORIGIN_CLASS.LOCALHOST }).supported).toBe(true);
  });
  it('web external DOM op is CROSS_ORIGIN_BLOCKED, navigate still allowed', () => {
    const click = resolveCapability({ op: 'click', backend: BROWSER_BACKEND.WEB_IFRAME, originClass: ORIGIN_CLASS.EXTERNAL });
    expect(click.supported).toBe(false);
    expect(click.code).toBe(BROWSER_ERROR_CODES.CROSS_ORIGIN_BLOCKED);
    expect(resolveCapability({ op: 'navigate', backend: BROWSER_BACKEND.WEB_IFRAME, originClass: ORIGIN_CLASS.EXTERNAL }).supported).toBe(true);
    expect(resolveCapability({ op: 'screenshot', backend: BROWSER_BACKEND.WEB_IFRAME, originClass: ORIGIN_CLASS.EXTERNAL }).supported).toBe(true);
  });
  it('reports unknown ops', () => {
    const r = resolveCapability({ op: 'frobnicate', backend: BROWSER_BACKEND.DESKTOP_CDP, originClass: ORIGIN_CLASS.LOCALHOST });
    expect(r.supported).toBe(false);
    expect(r.code).toBe(BROWSER_ERROR_CODES.UNKNOWN_OP);
  });
});

describe('dynamicTier', () => {
  it('promotes cookies/storage set to advanced', () => {
    expect(dynamicTier('cookies', { mode: 'get' })).toBe(OP_TIER.READ);
    expect(dynamicTier('cookies', { mode: 'set' })).toBe(OP_TIER.ADVANCED);
    expect(dynamicTier('storage', { mode: 'set', area: 'local' })).toBe(OP_TIER.ADVANCED);
  });
});

describe('evaluateConsent', () => {
  it('denies everything when disabled', () => {
    expect(evaluateConsent({ op: 'snapshot', args: {}, originClass: ORIGIN_CLASS.LOCALHOST, policy: policyOff }).decision).toBe('deny');
  });
  it('allows reads + localhost interaction by default', () => {
    expect(evaluateConsent({ op: 'snapshot', args: {}, originClass: ORIGIN_CLASS.LOCALHOST, policy: policyOn }).decision).toBe('allow');
    expect(evaluateConsent({ op: 'click', args: {}, originClass: ORIGIN_CLASS.LOCALHOST, policy: policyOn }).decision).toBe('allow');
  });
  it('denies advanced tools unless advancedEnabled', () => {
    expect(evaluateConsent({ op: 'evaluate', args: { js: '1' }, originClass: ORIGIN_CLASS.LOCALHOST, policy: policyOn }).decision).toBe('deny');
    expect(evaluateConsent({ op: 'evaluate', args: { js: '1' }, originClass: ORIGIN_CLASS.LOCALHOST, policy: policyAdvanced }).decision).toBe('allow');
  });
  it('allows external interaction by default; denies only when allowExternal is false', () => {
    expect(evaluateConsent({ op: 'click', args: {}, originClass: ORIGIN_CLASS.EXTERNAL, policy: policyOn }).decision).toBe('allow');
    expect(evaluateConsent({ op: 'click', args: {}, originClass: ORIGIN_CLASS.EXTERNAL, policy: { ...policyOn, allowExternal: false } }).decision).toBe('deny');
    // Reads on external stay allowed even when external is restricted.
    expect(evaluateConsent({ op: 'snapshot', args: {}, originClass: ORIGIN_CLASS.EXTERNAL, policy: { ...policyOn, allowExternal: false } }).decision).toBe('allow');
  });
  it('blocks navigating to an external target under localhost-only, not just ops on the current page', () => {
    const localOnly = { ...policyOn, allowExternal: false };
    // From a localhost page, navigating to an external site is denied (the escape hatch is closed).
    expect(evaluateConsent({ op: 'navigate', args: { url: 'https://example.com' }, originClass: ORIGIN_CLASS.LOCALHOST, policy: localOnly }).decision).toBe('deny');
    // Navigating to another localhost target stays allowed.
    expect(evaluateConsent({ op: 'navigate', args: { url: 'http://localhost:3000/x' }, originClass: ORIGIN_CLASS.LOCALHOST, policy: localOnly }).decision).toBe('allow');
    // Default (allowExternal unset ⇒ permissive) still allows external navigation.
    expect(evaluateConsent({ op: 'navigate', args: { url: 'https://example.com' }, originClass: ORIGIN_CLASS.LOCALHOST, policy: policyOn }).decision).toBe('allow');
  });
});

describe('isExternalNavigationBlocked (lifecycle open target gate)', () => {
  it('is true only for external targets under localhost-only', () => {
    expect(isExternalNavigationBlocked('https://example.com', { enabled: true, allowExternal: false })).toBe(true);
    expect(isExternalNavigationBlocked('http://localhost:5173', { enabled: true, allowExternal: false })).toBe(false);
    expect(isExternalNavigationBlocked('https://example.com', policyOn)).toBe(false);
    expect(isExternalNavigationBlocked('https://example.com', null)).toBe(false);
  });
});

describe('routeToolCall (full gate, called directly — proves policy is in core)', () => {
  it('rejects unknown tools', () => {
    expect(routeToolCall({ toolName: 'browser_nope', controller: desktop, policy: policyOn }).code).toBe(BROWSER_ERROR_CODES.UNKNOWN_OP);
  });
  it('rejects bad args before any dispatch', () => {
    const r = routeToolCall({ toolName: 'browser_navigate', args: {}, controller: desktop, policy: policyOn });
    expect(r.ok).toBe(false);
    expect(r.code).toBe(BROWSER_ERROR_CODES.BAD_ARGS);
  });
  it('clears a valid localhost click', () => {
    const r = routeToolCall({ toolName: 'browser_click', args: { ref: 'e3' }, controller: webLocal, policy: policyOn });
    expect(r).toMatchObject({ ok: true, op: 'click' });
  });
  it('blocks a cross-origin web click with CROSS_ORIGIN_BLOCKED', () => {
    const r = routeToolCall({ toolName: 'browser_click', args: { ref: 'e3' }, controller: webExternal, policy: policyOn });
    expect(r.ok).toBe(false);
    expect(r.code).toBe(BROWSER_ERROR_CODES.CROSS_ORIGIN_BLOCKED);
  });
  it('denies evaluate when advanced disabled even on desktop', () => {
    const r = routeToolCall({ toolName: 'browser_evaluate', args: { js: 'document.title' }, controller: desktop, policy: policyOn });
    expect(r.ok).toBe(false);
    expect(r.code).toBe(BROWSER_ERROR_CODES.CONSENT_DENIED);
  });
  it('lifecycle ops only need the master enable gate', () => {
    expect(routeToolCall({ toolName: 'browser_status', controller: null, policy: policyOn }).ok).toBe(true);
    expect(routeToolCall({ toolName: 'browser_status', controller: null, policy: policyOff }).code).toBe(BROWSER_ERROR_CODES.CONSENT_DENIED);
  });
  it('non-lifecycle op with no controller reports NO_BROWSER_PANE', () => {
    const r = routeToolCall({ toolName: 'browser_snapshot', controller: null, policy: policyOn });
    expect(r.code).toBe(BROWSER_ERROR_CODES.NO_BROWSER_PANE);
  });
});
