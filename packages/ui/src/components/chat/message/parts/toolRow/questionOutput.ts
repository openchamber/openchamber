

// Parse question tool output: "User has answered your questions: "Q1"="A1", "Q2"="A2". You can now..."
export const parseQuestionOutput = (output: string): Array<{ question: string; answer: string }> | null => {
    const match = output.match(/^User has answered your questions:\s*(.+?)\.\s*You can now/s);
    if (!match) return null;

    const pairs: Array<{ question: string; answer: string }> = [];
    const content = match[1];

    // Match "question"="answer" pairs, handling multiline answers
    const pairRegex = /"([^"]+)"="([^"]*(?:[^"\\]|\\.)*)"/g;
    let pairMatch;
    while ((pairMatch = pairRegex.exec(content)) !== null) {
        pairs.push({
            question: pairMatch[1],
            answer: pairMatch[2],
        });
    }

    return pairs.length > 0 ? pairs : null;
};

export type CoercedQuestionOption = { label?: unknown; description?: unknown };

const isOptionRecord = (value: unknown): value is CoercedQuestionOption =>
    typeof value === "object" && value !== null;

/**
 * A question's options, leniently read. The model sometimes sends `options`
 * as JSON text alongside a stringified `questions` array; strict
 * `Array.isArray` then drops all options. Parse once, accept a single
 * object, otherwise no options. Never throws (#7084).
 */
export const coerceQuestionOptions = (value: unknown): CoercedQuestionOption[] => {
    if (Array.isArray(value)) return value.filter(isOptionRecord)
    if (typeof value === "string") {
        const trimmed = value.trim()
        if (!trimmed) return []
        try {
            const revived: unknown = JSON.parse(trimmed)
            if (Array.isArray(revived)) return revived.filter(isOptionRecord)
            if (isOptionRecord(revived)) return [revived]
        } catch {
        }
        return []
    }
    if (isOptionRecord(value)) return [value]
    return []
};
