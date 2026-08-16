import { describe, expect, it, vi } from "vitest";
import {
	createScheduledTaskPreflight,
	PreflightDeniedError,
} from "./preflight.js";

const context = {
	projectID: "project",
	projectPath: "/repo",
	taskID: "task",
	taskName: "Task",
	reason: "scheduled",
};
const config = JSON.stringify({ command: ["/usr/bin/preflight", "--check"] });

describe("scheduled task preflight", () => {
	it("does nothing without a config", async () => {
		const execute = vi.fn();
		const gate = createScheduledTaskPreflight({
			readFile: async () => {
				const error = new Error("missing");
				error.code = "ENOENT";
				throw error;
			},
			execFile: execute,
		});
		await expect(gate.evaluate(context)).resolves.toBeUndefined();
		expect(execute).not.toHaveBeenCalled();
	});

	it("uses argv without a shell and denies a nonzero exit", async () => {
		const stdin = { end: vi.fn() };
		const execute = vi.fn((_file, _args, _options, callback) => {
			callback(Object.assign(new Error("exit 7"), { code: 7 }), "");
			return { stdin };
		});
		const gate = createScheduledTaskPreflight({
			readFile: async () => config,
			execFile: execute,
		});
		await expect(gate.evaluate(context)).rejects.toBeInstanceOf(
			PreflightDeniedError,
		);
		expect(execute).toHaveBeenCalledWith(
			"/usr/bin/preflight",
			["--check"],
			expect.objectContaining({ shell: false }),
			expect.any(Function),
		);
		expect(stdin.end).toHaveBeenCalledWith(`${JSON.stringify(context)}\n`);
	});
});
