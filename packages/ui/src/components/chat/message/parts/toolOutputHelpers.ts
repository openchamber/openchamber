const writeTerminalCharacter = (lines: string[], row: number, column: number, character: string): void => {
    const line = lines[row] ?? '';
    const padding = column > line.length ? ' '.repeat(column - line.length) : '';
    lines[row] = `${line.slice(0, column)}${padding}${character}${line.slice(column + 1)}`;
};

/** Converts the common ANSI progress-update sequences into their visible terminal text. */
export const renderTerminalOutput = (output: string): string => {
    if (!output.includes('\u001B') && !output.includes('\r') && !output.includes('\b')) {
        return output;
    }

    const lines = [''];
    let row = 0;
    let column = 0;

    for (let index = 0; index < output.length; index += 1) {
        const character = output[index];

        if (character === '\n') {
            row += 1;
            column = 0;
            lines[row] ??= '';
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
            writeTerminalCharacter(lines, row, column, character);
            column += 1;
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
                row += count;
                lines[row] ??= '';
            } else if (command === 'C') {
                column += count;
            } else if (command === 'D') {
                column = Math.max(0, column - count);
            } else if (command === 'G') {
                column = Math.max(0, count - 1);
            } else if (command === 'H' || command === 'f') {
                row = Math.max(0, (parameters[0] || 1) - 1);
                column = Math.max(0, (parameters[1] || 1) - 1);
                lines[row] ??= '';
            } else if (command === 'K') {
                const mode = parameters[0];
                const line = lines[row] ?? '';
                if (mode === 1) {
                    lines[row] = line.slice(column);
                    column = 0;
                } else if (mode === 2) {
                    lines[row] = '';
                } else {
                    lines[row] = line.slice(0, column);
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

    return lines.join('\n');
};

export const getEffectiveToolOutput = (
    tool: string,
    stateOutput: unknown,
    metadataOutput: unknown,
): string | undefined => {
    const isBash = tool === 'bash';

    if (typeof stateOutput === 'string') {
        return isBash ? renderTerminalOutput(stateOutput) : stateOutput;
    }

    if (isBash && typeof metadataOutput === 'string' && metadataOutput.length > 0) {
        return renderTerminalOutput(metadataOutput);
    }

    return undefined;
};
