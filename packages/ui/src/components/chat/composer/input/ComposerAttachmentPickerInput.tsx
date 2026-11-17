import React from 'react';
import { ATTACHMENT_ACCEPT } from '@/sync/attachment-files';

type AttachmentPickerInputProps = {
    ref: React.Ref<HTMLInputElement>;
    onChange: (event: React.ChangeEvent<HTMLInputElement>) => void;
};

export // Memoized because React re-applies an input's `name` and `type` on every
// commit that reaches it (it clears `name` while setting `type`), and the
// composer renders on streamed updates while these props never change.
const AttachmentPickerInput = React.memo(function AttachmentPickerInput({ ref, onChange }: AttachmentPickerInputProps) {
    return (
        <input
            ref={ref}
            type="file"
            multiple
            className="hidden"
            onChange={onChange}
            accept={ATTACHMENT_ACCEPT}
        />
    );
});