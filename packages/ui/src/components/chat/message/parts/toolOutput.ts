const MAX_SYNTHETIC_TERMINAL_CELLS = 100_000;

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

export const renderTerminalOutput = (output: string): string => {
    if (!output.includes('\u001B') && !output.includes('\r') && !output.includes('\b')) {
        return output;
    }

    const lines: string[][] = [[]];
    const budget: TerminalRenderBudget = { syntheticCells: 0 };
    let row = 0;
    let column = 0;

    for (let index = 0; index < output.length; index += 1) {
        const character = output[index];

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
        if (character !== '\u001B') {
            column = writeTerminalCharacter(lines, row, column, character, budget) + 1;
            continue;
        }

        const nextCharacter = output[index + 1];
        if (nextCharacter === '[') {
            const sequenceStart = index + 2;
            let sequenceEnd = sequenceStart;
            while (sequenceEnd < output.length && !/[\x40-\x7E]/.test(output[sequenceEnd])) {
                sequenceEnd += 1;
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

        if (nextCharacter === ']') {
            const terminator = output.indexOf('\u0007', index + 2);
            const stringTerminator = output.indexOf('\u001B\\', index + 2);
            const end = terminator === -1
                ? stringTerminator
                : stringTerminator === -1
                    ? terminator
                    : Math.min(terminator, stringTerminator);
            if (end === -1) {
                break;
            }
            index = output[end] === '\u0007' ? end : end + 1;
            continue;
        }

        index += 1;
    }

    return lines.map((line) => line.join('')).join('\n');
};

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
