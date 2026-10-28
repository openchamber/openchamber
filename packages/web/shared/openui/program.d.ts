import type { ElementNode, LibraryJSONSchema, OpenUIError, ValidationError } from '@openuidev/lang-core';

export interface OpenUIComponentSlot {
  component: string;
  prop: string;
  allowed: readonly string[] | null;
}

type OpenUIProgramDiagnostic = ValidationError | OpenUIError | { message: string; path?: string };
type OpenUIProgramInspection =
  | { valid: true; root: ElementNode }
  | { valid: false; diagnostics: readonly OpenUIProgramDiagnostic[] };

export function deriveOpenUIComponentSlots(schema: LibraryJSONSchema): OpenUIComponentSlot[];
export function walkRenderedOpenUINodes(root: ElementNode, slots: readonly OpenUIComponentSlot[]): ElementNode[];
export function inspectOpenUIProgram(source: string, schema: LibraryJSONSchema, slots?: readonly OpenUIComponentSlot[]): OpenUIProgramInspection;
