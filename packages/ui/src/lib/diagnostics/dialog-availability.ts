import React from 'react';

/**
 * True under the root that mounts the diagnostic dialog (`MainLayout`). The
 * VS Code, mobile and mini-chat roots do not, so a link that opens the dialog
 * has nothing to open there.
 */
export const DiagnosticDialogAvailableContext = React.createContext(false);
