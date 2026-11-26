import React from 'react';

import type { RenderRow } from './types';

type RowsSnapshotProps = {
    rows: readonly RenderRow[];
    onBeforeChange: (previous: readonly RenderRow[], next: readonly RenderRow[]) => void;
};

export class RowsSnapshot extends React.Component<RowsSnapshotProps> {
    getSnapshotBeforeUpdate(previous: RowsSnapshotProps): null {
        if (previous.rows !== this.props.rows) this.props.onBeforeChange(previous.rows, this.props.rows);
        return null;
    }

    componentDidUpdate(): void {}

    render(): React.ReactNode {
        return null;
    }
}
