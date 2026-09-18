import React from 'react';
import type { JsonValue } from '@openchamber/sdk';

import { useI18n } from '@/lib/i18n';
import { readPath, stringifyTemplateValue } from '@/lib/guests/tool-presentation';

/** Rows drawn for an `output: "table"` rule; the rest is a count line. */
const GUEST_TOOL_TABLE_ROWS_MAX = 200;
/** Characters per cell; the column paths are short by contract, values are not. */
const GUEST_TOOL_TABLE_CELL_MAX = 200;

// Same classes the markdown decorator puts on assistant tables
// (`components/chat/markdown/decorate.ts`), minus the copy/download toolbar.
const TABLE_CELL_CLASS = 'min-w-[120px] max-w-[320px] whitespace-normal [overflow-wrap:anywhere] border-r border-border/60 px-4 py-2.5 align-middle last:border-r-0';

interface GuestToolTableProps {
    rows: readonly JsonValue[];
    columns: readonly string[];
}

/**
 * The expanded body of a tool call an extension declared as a table: one
 * column per declared path, one row per output item, cells read with the
 * same dotted-path reader the header templates use.
 */
export const GuestToolTable: React.FC<GuestToolTableProps> = ({ rows, columns }) => {
    const { t } = useI18n();
    const visibleRows = rows.length > GUEST_TOOL_TABLE_ROWS_MAX ? rows.slice(0, GUEST_TOOL_TABLE_ROWS_MAX) : rows;
    const hiddenCount = rows.length - visibleRows.length;

    return (
        <div className="flex w-fit max-w-full flex-col gap-1">
            <div className="overflow-x-auto rounded-lg border border-border/80 bg-[var(--surface-elevated)]">
                <table className="w-max border-collapse text-sm">
                    <thead>
                        <tr className="border-b border-border/60">
                            {columns.map((column) => (
                                <th key={column} className={`${TABLE_CELL_CLASS} text-left font-semibold text-foreground`}>
                                    {column}
                                </th>
                            ))}
                        </tr>
                    </thead>
                    <tbody>
                        {visibleRows.map((row, rowIndex) => (
                            <tr key={rowIndex} className={rowIndex === visibleRows.length - 1 ? 'border-0' : 'border-b border-border/60'}>
                                {columns.map((column) => (
                                    <td key={column} className={`${TABLE_CELL_CLASS} text-foreground/90`}>
                                        {stringifyTemplateValue(readPath(row, column), GUEST_TOOL_TABLE_CELL_MAX)}
                                    </td>
                                ))}
                            </tr>
                        ))}
                    </tbody>
                </table>
            </div>
            {hiddenCount > 0 ? (
                <div className="typography-micro text-muted-foreground">
                    {t('chat.toolPart.moreRows', { count: hiddenCount })}
                </div>
            ) : null}
        </div>
    );
};
