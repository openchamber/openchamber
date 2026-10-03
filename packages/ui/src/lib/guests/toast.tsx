import React from 'react';
import type { ToastRequest } from '@openchamber/sdk';
import { toast, type ExternalToast } from 'sonner';

import { GuestToastActions } from '@/components/layout/GuestToastActions';

/** Buttons own only local toast data and remain usable after the guest frame exits. */
export const showGuestToast = (request: ToastRequest): void => {
  const copyText = request.copy === true ? request.message : request.copy ? request.copy.text : undefined;
  const dismiss = request.dismiss === true || request.persistent === true;
  if (copyText === undefined && !dismiss) {
    toast[request.kind](request.message);
    return;
  }
  const id = crypto.randomUUID();
  const options: ExternalToast = {
    id,
    action: <GuestToastActions copyText={copyText} dismiss={dismiss} onDismiss={() => toast.dismiss(id)} />,
  };
  if (request.persistent) options.duration = Infinity;
  toast[request.kind](request.message, options);
};
