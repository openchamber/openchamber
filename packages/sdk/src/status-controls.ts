export const GUEST_STATUS_CONTROLS_MAX = 4;
export const GUEST_STATUS_CONTROL_ID = /^[a-z][a-z0-9-]{0,39}$/;
export const GUEST_STATUS_CONTROL_LABEL_MAX = 60;
export const GUEST_STATUS_CONTROL_OPTIONS_MAX = 16;
export const GUEST_STATUS_CONTROL_VALUE_MAX = 80;

export type GuestStatusControlOption = {
  value: string;
  label: string;
};

export type GuestStatusControl =
  | {
    kind: 'button';
    id: string;
    label: string;
    disabled?: boolean;
  }
  | {
    kind: 'select';
    id: string;
    label: string;
    value: string;
    options: GuestStatusControlOption[];
    disabled?: boolean;
  };

export type GuestStatusControlEvent = {
  id: string;
  value?: string;
};

const isControlObject = (value: GuestStatusControl | GuestStatusControlOption): boolean => (
  Object(value) === value && !Array.isArray(value)
);

const hasOnlyKeys = (
  value: GuestStatusControl | GuestStatusControlOption,
  keys: readonly string[],
): boolean => Object.keys(value).every((key) => keys.includes(key));

const isLabel = (value: string): boolean => (
  String(value) === value && value.length >= 1 && value.length <= GUEST_STATUS_CONTROL_LABEL_MAX
);

const isValue = (value: string): boolean => (
  String(value) === value && value.length >= 1 && value.length <= GUEST_STATUS_CONTROL_VALUE_MAX
);

/**
 * Guest-side fast-fail guard for `setStatusControls`. The host zod schema is
 * still authoritative because JavaScript callers can bypass this SDK method.
 */
export const isGuestStatusControls = (controls: GuestStatusControl[]): boolean => {
  // The public type is precise, but this boundary also receives untyped JavaScript callers.
  if (!Array.isArray(controls) || controls.length > GUEST_STATUS_CONTROLS_MAX) return false;
  const ids = new Set<string>();
  for (const control of controls) {
    if (!isControlObject(control) || !GUEST_STATUS_CONTROL_ID.test(control.id) || !isLabel(control.label)) return false;
    if (control.disabled !== undefined && control.disabled !== true && control.disabled !== false) return false;
    if (ids.has(control.id)) return false;
    ids.add(control.id);
    if (control.kind === 'button') {
      if (!hasOnlyKeys(control, ['kind', 'id', 'label', 'disabled'])) return false;
      continue;
    }
    if (control.kind !== 'select' || !hasOnlyKeys(control, ['kind', 'id', 'label', 'value', 'options', 'disabled'])) return false;
    if (!isValue(control.value) || !Array.isArray(control.options)
      || control.options.length < 1 || control.options.length > GUEST_STATUS_CONTROL_OPTIONS_MAX) return false;
    const values = new Set<string>();
    for (const option of control.options) {
      if (!isControlObject(option) || !hasOnlyKeys(option, ['value', 'label'])
        || !isValue(option.value) || !isLabel(option.label) || values.has(option.value)) return false;
      values.add(option.value);
    }
    if (!values.has(control.value)) return false;
  }
  return true;
};
