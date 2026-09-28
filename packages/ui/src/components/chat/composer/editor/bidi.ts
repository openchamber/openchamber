import { RangeSetBuilder, type Extension } from '@codemirror/state';
import { Decoration, EditorView, ViewPlugin, type DecorationSet, type ViewUpdate } from '@codemirror/view';

const automaticLine = Decoration.line({ attributes: { dir: 'auto' } });

function lineDirections(view: EditorView): DecorationSet {
    const builder = new RangeSetBuilder<Decoration>();
    let previousLine = -1;
    for (const { from, to } of view.visibleRanges) {
        for (let position = from; position <= to;) {
            const line = view.state.doc.lineAt(position);
            if (line.from !== previousLine) {
                builder.add(line.from, line.from, automaticLine);
                previousLine = line.from;
            }
            position = line.to + 1;
        }
    }
    return builder.finish();
}

// Let the browser resolve each logical line, and let CodeMirror read that same
// direction for cursor movement and selection. The content root stays LTR:
// dir=auto there would change its direction as virtualization replaces lines.
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
