import { RangeSetBuilder, type Extension } from '@codemirror/state';
import { Decoration, EditorView, ViewPlugin, type DecorationSet, type ViewUpdate } from '@codemirror/view';
import { proseTextDirection } from '@/lib/i18n/textDirection';

const rtlLine = Decoration.line({ attributes: { dir: 'rtl' } });
const ltrLine = Decoration.line({ attributes: { dir: 'ltr' } });
const automaticLine = Decoration.line({ attributes: { dir: 'auto' } });

function lineDecoration(text: string) {
    const dir = proseTextDirection(text);
    if (dir === 'rtl') return rtlLine;
    if (dir === 'ltr') return ltrLine;
    return automaticLine;
}

function lineDirections(view: EditorView): DecorationSet {
    const builder = new RangeSetBuilder<Decoration>();
    let previousLine = -1;
    for (const { from, to } of view.visibleRanges) {
        for (let position = from; position <= to;) {
            const line = view.state.doc.lineAt(position);
            if (line.from !== previousLine) {
                builder.add(line.from, line.from, lineDecoration(line.text));
                previousLine = line.from;
            }
            position = line.to + 1;
        }
    }
    return builder.finish();
}

// Each logical line takes the direction most of its words run, so a
// Latin-first Arabic line runs right to left; a line without letters keeps
// dir=auto. CodeMirror reads the same direction for cursor movement and
// selection. The content root stays LTR: dir=auto there would change its
// direction as virtualization replaces lines.
export const composerBidi: Extension = [
    EditorView.contentAttributes.of({ dir: 'ltr' }),
    EditorView.perLineTextDirection.of(true),
    EditorView.theme({ '.cm-line': { textAlign: 'start' } }),
    ViewPlugin.fromClass(class {
        decorations: DecorationSet;

        constructor(view: EditorView) {
            this.decorations = lineDirections(view);
        }

        update(update: ViewUpdate) {
            if (update.docChanged || update.viewportChanged) {
                this.decorations = lineDirections(update.view);
            }
        }
    }, { decorations: (plugin) => plugin.decorations }),
];
