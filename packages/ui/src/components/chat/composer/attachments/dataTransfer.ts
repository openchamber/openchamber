
import { parseDroppedFileReferences, VS_CODE_DROP_DATA_TYPES } from './filePaths';

export const INTERNAL_FILE_PATH_TYPE = 'application/x-openchamber-file-path';

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

export function collectDroppedFiles(dataTransfer: DataTransfer | null | undefined): File[] {
    if (!dataTransfer) return [];

    const directFiles = Array.from(dataTransfer.files || []);
    if (directFiles.length > 0) return directFiles;

    return Array.from(dataTransfer.items || [])
        .filter((item) => item.kind === 'file')
        .map((item) => item.getAsFile())
        .filter((file): file is File => Boolean(file));
}

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
