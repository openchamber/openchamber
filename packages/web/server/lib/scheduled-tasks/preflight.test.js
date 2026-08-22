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

  it("denies a zero exit whose stdout carries an explicit allow:false", async () => {
    const execute = vi.fn((_file, _args, _options, callback) => {
      callback(null, JSON.stringify({ allow: false, reason: "blocked" }));
      return { stdin: { end: vi.fn() } };
    });
    const gate = createScheduledTaskPreflight({
      readFile: async () => config,
      execFile: execute,
    });
    await expect(gate.evaluate(context)).rejects.toThrow("blocked");
  });

  it("allows a zero exit whose stdout is not JSON", async () => {
    const execute = vi.fn((_file, _args, _options, callback) => {
      callback(null, "ok\n");
      return { stdin: { end: vi.fn() } };
    });
    const gate = createScheduledTaskPreflight({
      readFile: async () => config,
      execFile: execute,
    });
    await expect(gate.evaluate(context)).resolves.toBeUndefined();
  });

  it("allows a failing command when onError is allow", async () => {
    const execute = vi.fn((_file, _args, _options, callback) => {
      callback(new Error("boom"), "");
      return { stdin: { end: vi.fn() } };
    });
    const gate = createScheduledTaskPreflight({
      readFile: async () =>
        JSON.stringify({
          command: ["/usr/bin/preflight"],
          onError: "allow",
        }),
      execFile: execute,
    });
    await expect(gate.evaluate(context)).resolves.toBeUndefined();
  });

  it("skips manual runs when applyTo is scheduled", async () => {
    const execute = vi.fn();
    const gate = createScheduledTaskPreflight({
      readFile: async () =>
        JSON.stringify({
          command: ["/usr/bin/preflight"],
          applyTo: "scheduled",
        }),
      execFile: execute,
    });
    await expect(
      gate.evaluate({ ...context, reason: "manual" }),
    ).resolves.toBeUndefined();
    expect(execute).not.toHaveBeenCalled();
  });

  it("still gates scheduled runs when applyTo is scheduled", async () => {
    const execute = vi.fn((_file, _args, _options, callback) => {
      callback(null, "");
      return { stdin: { end: vi.fn() } };
    });
    const gate = createScheduledTaskPreflight({
      readFile: async () =>
        JSON.stringify({
          command: ["/usr/bin/preflight"],
          applyTo: "scheduled",
        }),
      execFile: execute,
    });
    await expect(
      gate.evaluate({ ...context, reason: "scheduled" }),
    ).resolves.toBeUndefined();
    expect(execute).toHaveBeenCalled();
  });

  it("fails closed on a malformed config instead of falling back to allow", async () => {
    const execute = vi.fn();
    const gate = createScheduledTaskPreflight({
      readFile: async () => "not json",
      execFile: execute,
    });
    await expect(gate.evaluate(context)).rejects.toBeInstanceOf(
      PreflightDeniedError,
    );
    expect(execute).not.toHaveBeenCalled();
  });

  it("fails closed on a config missing a valid command array", async () => {
    const gate = createScheduledTaskPreflight({
      readFile: async () => JSON.stringify({ command: [] }),
      execFile: vi.fn(),
    });
    await expect(gate.evaluate(context)).rejects.toBeInstanceOf(
      PreflightDeniedError,
    );
  });
});
