# OpenChamber UI Adaptation Rules

**Description**: Enforces strict visual and architectural parity with OpenChamber's existing UI. Apply this skill whenever creating new UI components, sections, or modifying layout.

## 1. Theme and Color Tokens (Strict)
Never use hardcoded Tailwind colors (e.g., `text-gray-500`, `bg-blue-600`).
OpenChamber is fully driven by HSL CSS variables for light/dark mode parity.
Always use the `hsl(var(--token))` format.

**Common Tokens:**
- Backgrounds: `bg-[hsl(var(--background))]`, `bg-[hsl(var(--surface-elevated))]`, `bg-[hsl(var(--accent))]`
- Text: `text-[hsl(var(--foreground))]`, `text-[hsl(var(--muted-foreground))]`
- Borders: `border-[hsl(var(--border))]`, `border-[hsl(var(--interactive-border))]`
- Status: `text-[hsl(var(--status-success))]`, `bg-[hsl(var(--status-error))]`, `text-[hsl(var(--status-warning))]`

## 2. Typography
Never guess font sizes or weights manually (e.g., avoid `text-sm font-medium`).
OpenChamber has predefined typography classes in `packages/ui/src/lib/typography.ts`.

**Common Classes:**
- `typography-micro`: For smallest metadata, timestamps, secondary labels.
- `typography-meta`: Standard metadata text.
- `typography-ui-label`: Small, semi-bold UI labels (headers of small sections).
- `typography-markdown`: For rendered markdown text.

## 3. UI Primitives
Never build custom dropdowns, buttons, or tooltips from scratch.
Import them exclusively from `packages/ui/src/components/ui/`.

- **Buttons:** `import { Button } from '@/components/ui/button';` (Use `variant="ghost" | "outline"`, `size="sm" | "xs"`)
- **Tooltips:** Use `<Tooltip delayDuration={300}><TooltipTrigger asChild>...<TooltipContent>`
- **Toasts:** `import { toast } from '@/components/ui';` (NEVER import `sonner` directly)
- **Icons:** Use ONLY `@remixicon/react`. (e.g., `RiCheckLine`, `RiErrorWarningLine`)

## 4. Spacing and Layout
- Use `.flex .items-center .gap-2` for standard horizontal alignment.
- Always add `min-w-0` to flex children that contain truncated text (`truncate` or `line-clamp-2`) to prevent flex-box blowout.
- UI containers must have `rounded-md` or `rounded-lg` and `border border-[hsl(var(--border))]`.

## 5. Performance (Render Discipline)
- Never subscribe a UI component to a broad Zustand store if it only needs one field.
- **BAD:** `const state = useMyStore()`
- **GOOD:** `const myField = useMyStore(s => s.myField)`
- Wrap lists or highly active data components in `React.FC` with `React.memo` if they are part of the streaming hot-path.

By adhering to these rules, all new features will feel indistinguishable from the core OpenChamber experience.