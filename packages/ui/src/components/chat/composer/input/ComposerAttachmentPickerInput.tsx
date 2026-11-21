import React from 'react';

type AttachmentPickerInputProps = {
    ref: React.Ref<HTMLInputElement>;
    onChange: (event: React.ChangeEvent<HTMLInputElement>) => void;
};

export const AttachmentPickerInput = React.memo(function AttachmentPickerInput({ ref, onChange }: AttachmentPickerInputProps) {
    return (
        <input
            ref={ref}
            type="file"
            multiple
            className="hidden"
            onChange={onChange}
        />
    );
});
