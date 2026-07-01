import React from 'react';
interface SessionsTabTitleProps {
  title: string;
}

const SessionsTabTitle: React.FC<SessionsTabTitleProps> = ({ title }) => (
  <h1 className="text-sm font-medium truncate" title={title}>{title}</h1>
);

export { SessionsTabTitle };
