import React from 'react';
import { Input } from '@/components/ui/input';
import { Textarea } from '@/components/ui/textarea';

/** A one-line field that saves when it loses focus or on Enter, and only when the trimmed text changed. */
export const CommitInput: React.FC<{
  label: string;
  value: string;
  placeholder?: string;
  maxLength?: number;
  onCommit: (value: string) => void;
}> = ({ label, value, placeholder, maxLength = 200, onCommit }) => {
  const [draft, setDraft] = React.useState(value);

  React.useEffect(() => {
    setDraft(value);
  }, [value]);

  const commit = (text: string) => {
    setDraft(text);
    const next = text.trim();
    if (next !== value) onCommit(next);
  };

  return (
    <Input
      aria-label={label}
      value={draft}
      placeholder={placeholder}
      maxLength={maxLength}
      onChange={(event) => setDraft(event.target.value)}
      onBlur={(event) => commit(event.currentTarget.value)}
      onKeyDown={(event) => {
        if (event.key === 'Enter') commit(event.currentTarget.value);
      }}
      className="h-8 min-w-0 rounded-md px-2"
    />
  );
};

/** A paragraph field that saves when it loses focus, like `CommitInput` does for one line. */
export const CommitTextarea: React.FC<{
  label: string;
  value: string;
  placeholder?: string;
  maxLength: number;
  rows?: number;
  onCommit: (value: string) => void;
}> = ({ label, value, placeholder, maxLength, rows = 3, onCommit }) => {
  const [draft, setDraft] = React.useState(value);

  React.useEffect(() => {
    setDraft(value);
  }, [value]);

  return (
    <Textarea
      aria-label={label}
      value={draft}
      placeholder={placeholder}
      maxLength={maxLength}
      rows={rows}
      onChange={(event) => setDraft(event.target.value)}
      onBlur={(event) => {
        const next = event.currentTarget.value.trim();
        if (next !== value) onCommit(next);
      }}
      className="w-full"
    />
  );
};

/** Comma-separated entries, saved as a list; an empty field removes the key. */
export const CommitList: React.FC<{
  label: string;
  value: readonly string[] | undefined;
  placeholder?: string;
  onCommit: (value: string[] | undefined) => void;
}> = ({ label, value, placeholder, onCommit }) => (
  <CommitInput
    label={label}
    value={(value ?? []).join(', ')}
    placeholder={placeholder}
    maxLength={2000}
    onCommit={(text) => {
      const entries = text.split(',').map((entry) => entry.trim()).filter(Boolean);
      onCommit(entries.length > 0 ? entries : undefined);
    }}
  />
);
