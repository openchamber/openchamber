import { z } from 'zod';
import { BROWSER_SCROLL_DIRECTIONS, BROWSER_VIEWPORT_MODES, BROWSER_REQUEST_HELP_KINDS } from '@openchamber/sdk';
import { browserControlActionSchema } from '@openchamber/sdk/schemas';
import { directory, id, sessionId, text } from './stream-fields.js';

const target = { tabId: id.optional() };
const selector = z.string().min(1).max(10_000);
const viewport = z.enum(BROWSER_VIEWPORT_MODES);
const parameters = {
  'browser.open': z.object({ ...target, url: z.url().refine((url) => /^https?:\/\//i.test(url)).max(16_384), viewport: viewport.optional() }),
  'browser.snapshot': z.object({ ...target, selector: selector.optional() }),
  'browser.click': z.object({ ...target, selector: selector.optional(), text: text.optional() }).refine((value) => value.selector || value.text),
  'browser.type': z.object({ ...target, selector, value: text, submit: z.boolean() }),
  'browser.select': z.object({ ...target, selector, value: text.optional(), label: text.optional() }).refine((value) => (value.value === undefined) !== (value.label === undefined)),
  'browser.scroll': z.object({ ...target, selector: selector.optional(), direction: z.enum(BROWSER_SCROLL_DIRECTIONS).optional() }),
  'browser.back': z.object(target),
  'browser.forward': z.object(target),
  'browser.inspect': z.object({ ...target, selector }),
  'browser.capture': z.object({ ...target, label: id.optional() }),
  'browser.resize': z.object({ ...target, viewport }),
  'browser.close': z.object(target),
  'browser.requestHelp': z.object({ ...target, reason: z.string().min(1).max(300), timeoutSeconds: z.number().int().min(30).max(900), kind: z.enum(BROWSER_REQUEST_HELP_KINDS).optional(), profileName: z.string().max(80).optional() }),
  'browser.saveProfile': z.object(target),
  'browser.dialog': z.object({ ...target, accept: z.boolean(), promptText: z.string().max(10_000).optional() }),
};

// The SDK owns the action vocabulary. Its service-side request reader trusts
// the host's parameters, so this untrusted stream also parses each action's fields.
export const browserRequestSchema = z.object({
  requestId: id,
  action: browserControlActionSchema,
  parameters: z.object({}).passthrough(),
  context: z.object({ directory: directory.nullable(), sessionId: sessionId.nullable() }),
}).transform((request, context) => {
  const parsed = parameters[request.action].safeParse(request.parameters);
  if (!parsed.success) {
    context.addIssue({ code: 'custom', message: 'Invalid browser parameters' });
    return z.NEVER;
  }
  return { requestId: request.requestId, action: request.action, parameters: parsed.data, context: request.context };
});
