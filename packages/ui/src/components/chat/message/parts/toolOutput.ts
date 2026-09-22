const MAX_SYNTHETIC_TERMINAL_CELLS = 100_000;

const hasTerminalControlCharacter = (output: string): boolean => {
    for (let index = 0; index < output.length; index += 1) {
        const code = output.charCodeAt(index);
        if (code <= 0x08 || code === 0x0B || code === 0x0C || code === 0x0D || (code >= 0x0E && code <= 0x1F) || code === 0x7F || (code >= 0x80 && code <= 0x9F)) {
            return true;
        }
    }
    return false;
};

interface TerminalRenderBudget {
    syntheticCells: number;
}

const ensureLine = (lines: string[][], requestedRow: number, budget: TerminalRenderBudget): number => {
    const missingRows = Math.max(0, requestedRow - lines.length + 1);
    const availableCells = MAX_SYNTHETIC_TERMINAL_CELLS - budget.syntheticCells;
    const addedRows = Math.min(missingRows, availableCells);
    const row = Math.min(requestedRow, lines.length + addedRows - 1);

    while (lines.length <= row) {
        lines.push([]);
    }
    budget.syntheticCells += addedRows;
    return row;
};

const writeTerminalCharacter = (
    lines: string[][],
    row: number,
    requestedColumn: number,
    character: string,
    budget: TerminalRenderBudget,
): number => {
    const line = lines[row];
    const availableCells = MAX_SYNTHETIC_TERMINAL_CELLS - budget.syntheticCells;
    const column = Math.min(requestedColumn, line.length + availableCells);
    const padding = Math.max(0, column - line.length);
    while (line.length < column) {
        line.push(' ');
    }
    budget.syntheticCells += padding;
    line[column] = character;
    return column;
};

const findTerminalStringTerminator = (
    output: string,
    start: number,
    allowBell: boolean,
): { index: number; length: number } | undefined => {
    for (let index = start; index < output.length; index += 1) {
        const code = output.charCodeAt(index);
        if (allowBell && code === 0x07) return { index, length: 1 };
        if (code === 0x9C) return { index, length: 1 };
        if (code === 0x1B && output.charCodeAt(index + 1) === 0x5C) return { index, length: 2 };
    }
    return undefined;
};

export const renderTerminalOutput = (output: string): string => {
    if (!hasTerminalControlCharacter(output)) {
        return output;
    }

    const lines: string[][] = [[]];
    const budget: TerminalRenderBudget = { syntheticCells: 0 };
    let row = 0;
    let column = 0;

    for (let index = 0; index < output.length; index += 1) {
        const character = output[index];
        const code = output.charCodeAt(index);

        if (character === '\n') {
            row += 1;
            column = 0;
            lines[row] ??= [];
            continue;
        }
        if (character === '\r') {
            column = 0;
            continue;
        }
        if (character === '\b') {
            column = Math.max(0, column - 1);
            continue;
        }
        if (character === '\t' || (code >= 0x20 && code < 0x7F) || code > 0x9F) {
            column = writeTerminalCharacter(lines, row, column, character, budget) + 1;
            continue;
        }

        const nextCode = output.charCodeAt(index + 1);
        if ((code === 0x1B && nextCode === 0x5B) || code === 0x9B) {
            const sequenceStart = code === 0x9B ? index + 1 : index + 2;
            let sequenceEnd = sequenceStart;
            let hasIntermediate = false;
            let sequenceMalformed = false;
            while (sequenceEnd < output.length) {
                const sequenceCode = output.charCodeAt(sequenceEnd);
                if (!hasIntermediate && sequenceCode >= 0x30 && sequenceCode <= 0x3F) {
                    sequenceEnd += 1;
                    continue;
                }
                if (sequenceCode >= 0x20 && sequenceCode <= 0x2F) {
                    hasIntermediate = true;
                    sequenceEnd += 1;
                    continue;
                }
                if (sequenceCode >= 0x40 && sequenceCode <= 0x7E) break;
                sequenceMalformed = true;
                break;
            }
            if (sequenceMalformed) {
                // Drop the ESC/CSI introducer and recognized prefix, then let
                // the invalid byte be handled by the normal output loop.
                index = sequenceEnd - 1;
                continue;
            }
            if (sequenceEnd === output.length) {
                break;
            }

            const command = output[sequenceEnd];
            const parameters = output.slice(sequenceStart, sequenceEnd).split(';').map((value) => Number.parseInt(value, 10) || 0);
            const count = parameters[0] || 1;
            if (command === 'A') {
                row = Math.max(0, row - count);
            } else if (command === 'B') {
                row = ensureLine(lines, row + count, budget);
            } else if (command === 'C') {
                column += count;
            } else if (command === 'D') {
                column = Math.max(0, column - count);
            } else if (command === 'G') {
                column = Math.max(0, count - 1);
            } else if (command === 'H' || command === 'f') {
                row = ensureLine(lines, Math.max(0, (parameters[0] || 1) - 1), budget);
                column = Math.max(0, (parameters[1] || 1) - 1);
            } else if (command === 'K') {
                const line = lines[row];
                const mode = parameters[0];
                if (mode === 1) {
                    for (let i = 0; i <= column && i < line.length; i += 1) {
                        line[i] = ' ';
                    }
                } else if (mode === 2) {
                    lines[row] = [];
                } else {
                    line.length = Math.min(line.length, column);
                }
            }
            index = sequenceEnd;
            continue;
        }

        if ((code === 0x1B && nextCode === 0x5D) || code === 0x9D) {
            const terminator = findTerminalStringTerminator(output, code === 0x9D ? index + 1 : index + 2, true);
            if (!terminator) {
                break;
            }
            index = terminator.index + terminator.length - 1;
            continue;
        }

        if ((code === 0x1B && (nextCode === 0x50 || nextCode === 0x58 || nextCode === 0x5E || nextCode === 0x5F))
            || code === 0x90 || code === 0x98 || code === 0x9E || code === 0x9F) {
            const terminator = findTerminalStringTerminator(output, code >= 0x80 ? index + 1 : index + 2, false);
            if (!terminator) {
                break;
            }
            index = terminator.index + terminator.length - 1;
            continue;
        }

        // Drop unknown ESC sequences and every other C0/C1 control rather than
        // allowing their payload or introducer bytes into copied output.
        if (code === 0x1B) {
            let sequenceEnd = index + 1;
            while (sequenceEnd < output.length) {
                const sequenceCode = output.charCodeAt(sequenceEnd);
                if (sequenceCode >= 0x30 && sequenceCode <= 0x7E) {
                    index = sequenceEnd;
                    break;
                }
                if (sequenceCode < 0x20 || sequenceCode > 0x2F) {
                    break;
                }
                sequenceEnd += 1;
            }
            if (sequenceEnd === output.length) {
                break;
            }
            if (output.charCodeAt(sequenceEnd) < 0x30 || output.charCodeAt(sequenceEnd) > 0x7E) {
                // A non-ASCII or control byte cannot be the final byte of an
                // ESC sequence. Drop the introducer and intermediate bytes,
                // then let the normal loop process the following byte as
                // output or another control sequence.
                index = sequenceEnd - 1;
                continue;
            }
            continue;
        }
    }

    return lines.map((line) => line.join('')).join('\n');
};

export const getShellClipboardText = (output: string): string => renderTerminalOutput(output);

export const getToolOutput = (
    tool: string,
    stateOutput: unknown,
    metadataOutput: unknown,
    status?: string,
): string | undefined => {
    const isBash = tool === 'bash';
    const shouldNormalize = isBash && status !== 'running';

    if (typeof stateOutput === 'string') {
        return shouldNormalize ? renderTerminalOutput(stateOutput) : stateOutput;
    }

    if (isBash && typeof metadataOutput === 'string' && metadataOutput.length > 0) {
        return shouldNormalize ? renderTerminalOutput(metadataOutput) : metadataOutput;
    }

    return undefined;
};

export const getStreamingOutputAppend = (previous: string, next: string): string | undefined => {
    return next.startsWith(previous) ? next.slice(previous.length) : undefined;
};
