import { z } from 'zod';

import type { JsonValue } from './contract.ts';
import { hostMeetsOpenChamberEngine, openChamberEngineMinimum } from './host-version.ts';

const packageEnvelopeSchema = z.union([
  z.object({ openchamber: z.null() }),
  z.object({ openchamber: z.object({}).passthrough() }),
]);

const manifestEngineSchema = z.object({ engines: z.object({ openchamber: z.string() }) });

export type HostTooOld = { ok: false; code: 'host-too-old'; required: string };

export const inspectManifestDocument = (document: JsonValue, hostVersion: string | undefined): { ok: true; isPackage: boolean } | HostTooOld => {
  const envelope = packageEnvelopeSchema.safeParse(document);
  if (hostVersion !== undefined) {
    const engine = manifestEngineSchema.safeParse(envelope.success ? envelope.data.openchamber : document);
    const required = engine.success ? openChamberEngineMinimum(engine.data.engines.openchamber) : null;
    if (required && !hostMeetsOpenChamberEngine(hostVersion, required)) {
      return { ok: false, code: 'host-too-old', required };
    }
  }
  return { ok: true, isPackage: envelope.success };
};
