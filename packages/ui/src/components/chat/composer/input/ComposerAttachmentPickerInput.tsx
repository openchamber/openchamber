import React from 'react';

type AttachmentPickerInputProps = {
    ref: React.Ref<HTMLInputElement>;
    onChange: (event: React.ChangeEvent<HTMLInputElement>) => void;
    camera?: boolean;
};

export const AttachmentPickerInput = React.memo(function AttachmentPickerInput({ ref, onChange, camera = false }: AttachmentPickerInputProps) {
    return (
        <input
            ref={ref}
            type="file"
            multiple={!camera}
            accept={camera ? 'image/*' : undefined}
            capture={camera ? 'environment' : undefined}
            className="hidden"
            onChange={onChange}
        />
    );
});
