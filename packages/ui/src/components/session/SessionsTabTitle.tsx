import React from 'react';
import { ArchiveAllDropdown } from '@/components/session/ArchiveAllDropdown';

interface SessionsTabTitleProps {
  title: string;
  onArchiveAll?: () => void;
}

const SessionsTabTitle: React.FC<SessionsTabTitleProps> = ({ title, onArchiveAll }) => (
  <>
    <h1 className="text-sm font-medium truncate flex-1" title={title}>{title}</h1>
    {onArchiveAll && <ArchiveAllDropdown onArchiveAll={onArchiveAll} />}
  </>
);

export { SessionsTabTitle };
