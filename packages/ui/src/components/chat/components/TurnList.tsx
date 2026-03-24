import React from 'react';

interface TurnListEntry {
    key: string;
}

interface TurnListProps<TEntry extends TurnListEntry> {
    entries: TEntry[];
    renderEntry: (entry: TEntry) => React.ReactNode;
}

const TurnList = <TEntry extends TurnListEntry>({ entries, renderEntry }: TurnListProps<TEntry>): React.ReactElement => {
    return (
        <>
            {entries.map((entry) => (
                <div
                    key={entry.key}
                    data-turn-entry={entry.key}
                    style={{
                        contentVisibility: 'auto',
                        containIntrinsicSize: 'auto 520px',
                    }}
                >
                    {renderEntry(entry)}
                </div>
            ))}
        </>
    );
};

export default React.memo(TurnList) as typeof TurnList;
