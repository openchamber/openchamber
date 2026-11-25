import React from 'react';

import { NAME_SLOT } from './wake';

export const WakeTitle: React.FC<{ title: string; name: string }> = ({ title, name }) => {
    const [before, after] = title.split(NAME_SLOT);
    if (after === undefined) return <>{title}</>;
    return (
        <>
            {before}
            <bdi style={{ color: 'var(--tools-title)' }}>{name}</bdi>
            {after}
        </>
    );
};
