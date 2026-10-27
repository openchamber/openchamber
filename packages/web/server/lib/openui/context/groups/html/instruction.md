# HtmlView
HtmlView runs sandboxed HTML with local CSS/JS. Iframe state is separate from DSL fields; explicit submissions use the host bridge.
Apply the root's native-composition fallback rule before using this sandbox. A spatial diagram or custom interaction does not by itself qualify for HtmlView. Keep the same visual-composition criteria. A theme change updates host variables without reloading the document. Source replacement starts a new document; unsubmitted script state does not survive remounts.

## Page
One self-contained document with a short descriptive title. html/height/title are positional; omit height or pass null for measured content height. Use inline style/script; remote libraries/stylesheets are not portable. Chat diagrams use a transparent canvas with useful section headings and figure labels. Project mockups use that project's design, with explicit text colors and a background of their own.
Fit the reply column, about 720px desktop and 360px phone. Wrap or stack; wide tables scroll in their own box. Give charts fixed pixel heights and reserve enough space for readable labels; remove repetition and empty space before reducing type. Avoid 100vh and root height:100%. Use rem/em for type, following the user's interface size. Keep hover/tap popups inside the page and flip near edges.

## Theme
Host variables: --background, --foreground, --muted, --muted-foreground, --card, --card-foreground, --border, --primary, --primary-foreground, --destructive, --warning, --success, --info, --code-background, --code-foreground, --chart-1 through --chart-6, --radius, --font-sans, --font-mono. The host supplies base type/color and updates variables when its theme changes.
Ready classes: oc-box, oc-muted, oc-table on a div around table, oc-num, oc-badge with data-tone=success|warning|error|info, oc-dot and oc-bar using --color; oc-bar length uses --value as a percentage. Fields: oc-field label with control, oc-input on input/select/textarea, oc-switch checkbox, oc-segmented around buttons with aria-pressed=true on the selected one. Use tone for grouping and lines for meaningful dividers.

## Media and execution
HTML images may use HTTPS, embedded image data or local image paths. The iframe has no app DOM or session access. Links use the host's HTTP(S) opener.
Scripts manage local interactions. From the final submit button's click, await openchamber.submit(data, summary). summary is a short description of the user's choice; data is the JSON needed next. In Markdown UI the host sends a new user turn; inside prompt_openui it returns this call's result. Local edits alone send nothing. The script never supplies sessionId/callId or selects the delivery mode.
Keep values until the promise resolves; disable duplicate clicks while pending and show acceptance only after success. On rejection retain values and allow an appropriate retry. Summary is limited to 500 characters and JSON data to 16000 characters. The host checks source, current generation, user gesture and whether the waiting call is still live. A stale or completed prompt cannot submit again. On replay, openchamber.answer contains accepted data so the page can show the saved choice. Chat answers, stop and cancellation close a waiting prompt. Do not simulate waiting with a page-local flag.

## String encoding
The html argument is a DSL string. Escape double quotes, backslashes and line breaks for that string; single-quoted HTML attributes reduce escaping. Escape the entire DSL again only if a transport requires JSON. A backtick fence inside an HTML string must not close its surrounding Markdown fence; use a longer outer fence when needed.
