const HEX_COLOR_PATTERN = /^#[0-9a-fA-F]{6}$/;

export const isHexColor = (value: string): boolean => HEX_COLOR_PATTERN.test(value);

export const COLOR_PRESETS = ['#e5484d', '#f76b15', '#d6a312', '#30a46c', '#12a594', '#3e63dd', '#8e4ec6', '#d6409f'] as const;
