import { z } from 'zod';

const browserControlRequestContextSchema = z.object({
  directory: z.string().min(1).nullable().catch(null),
  sessionId: z.string().min(1).nullable().catch(null),
});
export type BrowserControlRequestContext = z.infer<typeof browserControlRequestContextSchema>;
const UNKNOWN_BROWSER_CONTROL_CONTEXT: BrowserControlRequestContext = { directory: null, sessionId: null };

const browserControlRequestSchema = z.object({
  requestId: z.string().min(1),
  action: z.string().min(1),
  parameters: z.record(z.string(), z.unknown()).catch({}),
  context: browserControlRequestContextSchema.catch(UNKNOWN_BROWSER_CONTROL_CONTEXT),
  preferredConnectionId: z.string().min(1).nullable().catch(null),
});

const browserControlPreferredSchema = z.object({ connectionId: z.string().min(1) });

export type BrowserControlEvent =
  | ({ type: 'browser-control-request' } & z.infer<typeof browserControlRequestSchema>)
  | ({ type: 'browser-control-preferred' } & z.infer<typeof browserControlPreferredSchema>);

export const parseBrowserControlEvent = (envelope: { type: string; properties: unknown }): BrowserControlEvent | null => {
  if (envelope.type === 'openchamber:browser-control-request') {
    const parsed = browserControlRequestSchema.safeParse(envelope.properties);
    return parsed.success ? { type: 'browser-control-request', ...parsed.data } : null;
  }
  if (envelope.type === 'openchamber:browser-control-preferred') {
    const parsed = browserControlPreferredSchema.safeParse(envelope.properties);
    return parsed.success ? { type: 'browser-control-preferred', ...parsed.data } : null;
  }
  return null;
};
