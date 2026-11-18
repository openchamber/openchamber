import { defineRule } from "@oxlint/plugins";

import type { ESTree } from "@oxlint/plugins";
import { toPosix } from "../shared/scope.ts";

const INPUT = "/packages/ui/src/components/chat/composer/input/";
const OWNERS = new Map([
  ["prevWasAbortedRef", "useComposerControls.ts"],
  ["abortPromptOwnerRef", "useComposerAbortPrompt.ts"],
  ["canAcceptDropRef", "useComposerFileDrop.ts"],
  ["referencePicker", "useComposerReferencePickerState.ts"],
  ["attachmentPreview", "useComposerAttachmentPreview.ts"],
  ["attachmentCompatibilityRef", "useComposerAttachmentCompatibility.ts"],
  ["largeTextPasteScopeRef", "useComposerLargePasteScope.ts"],
  ["composerText", "useComposerDraftText.ts"],
  ["openAutocomplete", "useComposerAutocompleteState.ts"],
  ["mobileControlsPanel", "useComposerMobilePanels.ts"],
  ["promptHistorySearch", "useComposerHistorySearchState.ts"],
  ["isDragging", "useComposerDropState.ts"],
  ["largeTextPasteOffer", "useComposerLargePasteState.ts"],
  ["dictationSendInFlightRef", "useComposerDictationState.ts"],
  ["handleSubmitRef", "useComposerSending.ts"],
  ["handleQueueMessageRef", "useComposerSending.ts"],
  ["sendMessage", "useComposerSending.ts"],
  ["footerGapClass", "useComposerControls.ts"],
  ["abortShortcutReaches", "useComposerControls.ts"],
]);
const HANDLERS = new Set(["handleSubmitRef", "handleQueueMessageRef"]);
const CONSUMERS = new Set(["consumePendingPresetSubmit", "consumePendingDraftSubmit"]);
const FLAT_FIELDS = new Set(["composerText", "currentSessionId", "setReferencePicker", "handleSubmitRef"]);
const RETIRED = new Set(["useComposerInputState.ts", "useComposerEnvironment.ts"]);

function keyName(node: ESTree.Node): string | null {
  if (node.type === "Identifier") return node.name;
  if (node.type === "Literal" && typeof node.value === "string") return node.value;
  return null;
}

function memberName(node: ESTree.MemberExpression): string | null {
  return node.computed && node.property.type !== "Literal" ? null : keyName(node.property);
}

export const composerInputBoundariesRule = defineRule({
  meta: {
    type: "problem",
    docs: { description: "Keep composer state, outgoing handlers and render dependencies with their domain owners." },
    messages: {
      owner: "{{name}} belongs to {{owner}} so composer state and effects keep one domain owner. Declare it there and pass the domain slice to consumers.",
      publish: "Outgoing refs must be published together in useComposerSending.ts so queue and submit wiring has one owner. Move this write there.",
      consume: "Pending external submits belong to useComposerExternalSubmits.ts so dictation stays transcript-only. Move this consumption there.",
      slices: "Composer boundaries connect named domain slices to avoid rebuilding field-by-field dependencies. Pass the owner object and select its fields inside the consumer.",
      retired: "This catch-all composer module mixes unrelated state lifetimes. Put state in its domain hook and connect named slices in ChatInput.tsx.",
      fragment: "A fragment around only the composer form adds no render boundary. Return the form directly.",
      newline: "Composer source files need a final newline for clean diffs. Add a newline at the end of the file.",
      export: "Keep export attached to its declaration so documentation belongs to the exported symbol. Put comments before export and keep the declaration on the same line.",
    },
  },
  createOnce(context) {
    const location = () => {
      const filename = `/${toPosix(context.filename)}`;
      const file = filename.slice(filename.lastIndexOf("/") + 1);
      const input = filename.includes(INPUT) && /\.tsx?$/.test(file) && !filename.includes("/__tests__/");
      return {
        file, input,
        entry: filename.endsWith("/packages/ui/src/components/chat/ChatInput.tsx"),
        render: input && ["renderComposerForm.tsx", "renderComposerDialogs.tsx"].includes(file),
      };
    };
    return {
      Program(node) {
        const { file, input } = location();
        if (!input) return;
        if (RETIRED.has(file)) context.report({ node, messageId: "retired" });
        const text = context.sourceCode.text;
        if (text.length > 0 && !text.endsWith("\n")) context.report({ node, messageId: "newline" });
      },
      VariableDeclarator(node) {
        const { file, input, entry } = location();
        if (entry && node.id.type === "ObjectPattern" && node.init?.type === "CallExpression" &&
          node.init.callee.type === "Identifier" && node.init.callee.name.startsWith("useComposer")) {
          context.report({ node, messageId: "slices" });
        }
        if (!input || !node.init) return;
        const binding = node.id.type === "ArrayPattern" ? node.id.elements[0] : node.id;
        if (binding?.type !== "Identifier") return;
        const owner = OWNERS.get(binding.name);
        if (owner && owner !== file) context.report({ node, messageId: "owner", data: { name: binding.name, owner } });
      },
      AssignmentExpression(node) {
        const { file, input } = location();
        if (!input || file === "useComposerSending.ts") return;
        const left = node.left;
        if (left.type === "MemberExpression" && memberName(left) === "current" &&
          left.object.type === "Identifier" && HANDLERS.has(left.object.name)) {
          context.report({ node, messageId: "publish" });
        }
      },
      CallExpression(node) {
        const { file, input } = location();
        if (!input || file === "useComposerExternalSubmits.ts") return;
        if (node.callee.type === "MemberExpression" && CONSUMERS.has(memberName(node.callee) ?? "")) {
          context.report({ node, messageId: "consume" });
        }
      },
      TSTypeAliasDeclaration(node) {
        if (location().render && node.id.name === "Dependencies" && node.typeAnnotation.type !== "TSTypeLiteral") {
          context.report({ node, messageId: "slices" });
        }
      },
      TSPropertySignature(node) {
        if (!location().render || !FLAT_FIELDS.has(keyName(node.key) ?? "")) return;
        const parent = node.parent;
        if ((parent.type === "TSTypeLiteral" && parent.parent.type === "TSTypeAliasDeclaration") || parent.type === "TSInterfaceBody") {
          context.report({ node, messageId: "slices" });
        }
      },
      JSXFragment(node) {
        if (!location().render) return;
        const children = node.children.filter((child) => child.type !== "JSXText" || child.value.trim() !== "");
        const only = children[0];
        if (children.length === 1 && only?.type === "JSXElement" &&
          only.openingElement.name.type === "JSXIdentifier" && only.openingElement.name.name === "form") {
          context.report({ node, messageId: "fragment" });
        }
      },
      ExportNamedDeclaration(node) {
        if (!location().input || !node.declaration) return;
        const prefix = context.sourceCode.text.slice(node.range[0], node.declaration.range[0]);
        if (/\/[/*]|\n/.test(prefix)) context.report({ node, messageId: "export" });
      },
    };
  },
});
