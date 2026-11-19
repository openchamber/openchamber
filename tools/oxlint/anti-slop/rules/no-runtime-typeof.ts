import { defineRule } from "@oxlint/plugins";

import type { ESTree } from "@oxlint/plugins";
import { isExportedInputParser, isRuntimeFunction } from "../shared/input-parsers.ts";

function isInsideBoundary(node: ESTree.Node, filename: string, allowInTypeGuards: boolean, patterns: readonly string[]): boolean {
	let current: ESTree.Node | null = node.parent;
	while (current !== null && current.type !== "Program") {
		if (isRuntimeFunction(current)) {
			return (allowInTypeGuards && current.returnType?.typeAnnotation.type === "TSTypePredicate")
				|| isExportedInputParser(current, filename, patterns);
		}
		current = current.parent;
	}
	return false;
}

/** Disallow runtime typeof checks that narrow unparsed values instead of decoding them. */
export const noRuntimeTypeofRule = defineRule({
	meta: {
		type: "problem",
		docs: {
			description:
				"Disallow runtime typeof checks; external values must be decoded into meaningful types at their I/O boundary.",
		},
		messages: {
			runtimeTypeof:
				"A `typeof` check narrows a representation without establishing its contract. Parse input at its I/O boundary, then branch on the domain value.",
		},
		schema: [
			{
				type: "object",
				properties: {
					allowInTypeGuards: { type: "boolean" },
					allowInParsers: { type: "array", items: { type: "string" } },
				},
				additionalProperties: false,
			},
		],
		defaultOptions: [{ allowInTypeGuards: false, allowInParsers: [] }],
	},
	createOnce(context) {
		return {
			UnaryExpression(node) {
				const option = context.options?.[0];
				const allowInTypeGuards =
					typeof option === "object" &&
					option !== null &&
					!Array.isArray(option) &&
					option.allowInTypeGuards === true;
				const patterns = typeof option === "object" && option !== null && "allowInParsers" in option
					&& Array.isArray(option.allowInParsers) ? option.allowInParsers : [];
				if (
					node.operator === "typeof" &&
					!isInsideBoundary(node, context.filename, allowInTypeGuards, patterns)
				) {
					context.report({ node, messageId: "runtimeTypeof" });
				}
			},
		};
	},
});
