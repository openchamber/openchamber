import { readFileSync } from 'node:fs';
import { inspectOpenUIProgram, deriveOpenUIComponentSlots } from '../../../shared/openui/program.js';

// Parsing uses the official runtime with telemetry disabled for host-owned calls.
process.env.OPENUI_TELEMETRY_DISABLED = '1';
const { schema } = JSON.parse(readFileSync(new URL('./context/generated/gen.schema.json', import.meta.url), 'utf8'));
const componentSlots = deriveOpenUIComponentSlots(schema);

export const inspectOpenUI = (source) => inspectOpenUIProgram(source, schema, componentSlots);
