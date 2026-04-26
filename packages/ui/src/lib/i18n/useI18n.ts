import React from 'react';

import { I18nContext } from './react-context';

export function useI18n() {
  const value = React.useContext(I18nContext);
  if (!value) {
    throw new Error('useI18n must be used within I18nProvider');
  }
  return value;
}
