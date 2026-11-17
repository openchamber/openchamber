import React from 'react';
import type { JsonValue } from '@openchamber/sdk';

import { useI18n } from '@/lib/i18n';
import { readPath, stringifyTemplateValue } from '@/lib/guests/tool-presentation';
import { ScrollableOverlay } from '@/components/ui/ScrollableOverlay';

const GUEST_TOOL_TABLE_ROWS_MAX = 200;
const GUEST_TOOL_TABLE_CELL_MAX = 200;

const TABLE_CELL_CLASS = 'min-w-[120px] max-w-[320px] whitespace-normal [overflow-wrap:anywhere] border-e border-edge px-4 py-2.5 align-middle last:border-e-0';

interface GuestToolTableProps {
    rows: readonly JsonValue[];
    columns: readonly string[];
}

export const GuestToolTable: React.FC<GuestToolTableProps> = ({ rows, columns }) => {
    const { t } = useI18n();
    const visibleRows = rows.length > GUEST_TOOL_TABLE_ROWS_MAX ? rows.slice(0, GUEST_TOOL_TABLE_ROWS_MAX) : rows;
    const hiddenCount = rows.length - visibleRows.length;

    return (
        <div className="flex w-fit max-w-full flex-col gap-1">
            <ScrollableOverlay outerClassName="overlay-scrollbar-wrapper--no-gutter oc-tile rounded-lg" fillContainer={false}>
                <table className="w-max border-collapse text-sm">
                    <thead>
                        <tr className="border-b border-edge">
                            {columns.map((column) => (
                                <th key={column} className={`${TABLE_CELL_CLASS} text-start font-semibold text-foreground`}>
                                    {column}
                                </th>
                            ))}
                        </tr>
                    </thead>
                    <tbody>
                        {visibleRows.map((row, rowIndex) => (
                            <tr key={rowIndex} className={rowIndex === visibleRows.length - 1 ? 'border-0' : 'border-b border-edge'}>
                                {columns.map((column) => (
                                    <td key={column} className={`${TABLE_CELL_CLASS} text-foreground/90`}>
                                        {stringifyTemplateValue(readPath(row, column), GUEST_TOOL_TABLE_CELL_MAX)}
                                    </td>
                                ))}
                            </tr>
                        ))}
                    </tbody>
                </table>
            </ScrollableOverlay>
            {hiddenCount > 0 ? (
                <div className="typography-micro text-muted-foreground">
                    {t('chat.toolPart.moreRows', { count: hiddenCount })}
                </div>
            ) : null}
        </div>
    );
};
