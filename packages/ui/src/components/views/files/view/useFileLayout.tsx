import React from 'react';

export function useFileLayout({ isMobile }: {
  isMobile: boolean;
}) {
  const suppressFileLoadingIndicator = !isMobile;
  const [showMobilePageContent, setShowMobilePageContent] = React.useState(false);

  return { suppressFileLoadingIndicator, showMobilePageContent, setShowMobilePageContent };
}
