/**
 * Reading a drop's payload.
 *
 * Hosts describe a dragged file in incompatible ways: a browser exposes real
 * `File` entries, VS Code's explorer offers only proprietary data types whose
 * payloads must be parsed for paths, and OpenChamber's own file tree marks an
 * internal drag with a private type. These helpers answer the three questions
 * the composer actually asks of a `DataTransfer`, and are pure so they can be
 * exercised without a browser.
 *
 * `getData` throws in some hosts when called during dragover rather than drop;
 * every read here is guarded so one unreadable type cannot abort the scan.
 */

import { parseDroppedFileReferences, VS_CODE_DROP_DATA_TYPES } from './filePaths';

/** Data type marking a drag that started in OpenChamber's own file tree. */
export const INTERNAL_FILE_PATH_TYPE = 'application/x-openchamber-file-path';

/** Data types that, by their presence alone, mean files are being dragged. */
const FILE_BEARING_TYPES = [
    'files',
    'text/uri-list',
    'codefiles',
    INTERNAL_FILE_PATH_TYPE,
];

function readData(dataTransfer: DataTransfer, type: string): string {
    try {
        return dataTransfer.getData(type);
    } catch {
        return '';
    }
}

/**
 * Whether this drag carries files at all, used to decide if the composer
 * should show its drop target. Checked on dragenter/dragover, where payloads
 * are often unreadable, so the declared types are the primary signal and the
 * payload scan is the fallback for hosts that declare nothing useful.
 */
export function hasDraggedFiles(dataTransfer: DataTransfer | null | undefined): boolean {
    if (!dataTransfer) return false;
    if (dataTransfer.files && dataTransfer.files.length > 0) return true;

    if (dataTransfer.types) {
        const lowerTypes = Array.from(dataTransfer.types).map((type) => type.toLowerCase());
        if (FILE_BEARING_TYPES.some((type) => lowerTypes.includes(type))) return true;
        if (lowerTypes.some((type) => type.includes('vnd.code.tree'))) return true;
    }

    for (const dataType of VS_CODE_DROP_DATA_TYPES) {
        const payload = readData(dataTransfer, dataType);
        if (payload && parseDroppedFileReferences(payload).length > 0) return true;
    }

    return false;
}

/**
 * The actual `File` objects in a drop. `files` is the normal source; `items`
 * covers hosts that only populate the item list.
 */
export function collectDroppedFiles(dataTransfer: DataTransfer | null | undefined): File[] {
    if (!dataTransfer) return [];

    const directFiles = Array.from(dataTransfer.files || []);
    if (directFiles.length > 0) return directFiles;

    return Array.from(dataTransfer.items || [])
        .filter((item) => item.kind === 'file')
        .map((item) => item.getAsFile())
        .filter((file): file is File => Boolean(file));
}

/**
 * File references from a drop that carries no `File` objects — VS Code hands
 * over paths and expects the receiver to resolve them itself.
 */
export function collectDroppedFileUris(dataTransfer: DataTransfer | null | undefined): string[] {
    if (!dataTransfer || typeof dataTransfer.getData !== 'function') return [];

    const extracted = new Set<string>();
    for (const dataType of VS_CODE_DROP_DATA_TYPES) {
        const rawPayload = readData(dataTransfer, dataType);
        if (!rawPayload) continue;
        for (const candidate of parseDroppedFileReferences(rawPayload)) {
            extracted.add(candidate);
        }
    }
    return Array.from(extracted);
}
