#!/usr/bin/env python3
"""Audit workflow files for invalid reusable-workflow caller jobs (#1399).

A job that calls a reusable workflow (`uses:` at job level) may only carry
a fixed keyword list; any other key (the classic case: `timeout-minutes`)
makes the whole workflow file invalid, and every run of it fails at
startup with zero jobs. That mistake has broken main twice (#118, #1399),
so this audit runs in CI on workflow changes (workflow-audit.yml).

Full actionlint would catch this too, but repo-wide it also reports
hundreds of unrelated findings (custom runner labels, the concurrency
`queue` key its version predates); this script checks only the caller-job
rule, so its answer is never buried.

Usage: audit-workflow-caller-jobs.py [workflow-file-or-dir ...]
Exit 0 when every caller job is valid, 1 with one line per violation.
"""
import os
import re
import sys

ALLOWED_CALLER_JOB_KEYS = {
    "name",
    "uses",
    "with",
    "secrets",
    "strategy",
    "needs",
    "if",
    "concurrency",
    "permissions",
}

JOB_ID = re.compile(r"^  ([A-Za-z0-9_.-]+):\s*(#.*)?$")
JOB_KEY = re.compile(r"^    ([a-z][a-z0-9-]*):")


def audit_file(path):
    findings = []
    state = {"in_jobs": False, "job_id": None, "job_keys": []}

    def flush():
        if state["job_id"] is not None and "uses" in [key for key, _ in state["job_keys"]]:
            for key, line_no in state["job_keys"]:
                if key not in ALLOWED_CALLER_JOB_KEYS:
                    findings.append(
                        f"{path}:{line_no}: job \"{state['job_id']}\" calls a reusable workflow "
                        f"but carries \"{key}\", which caller jobs may not use "
                        f"(allowed: {', '.join(sorted(ALLOWED_CALLER_JOB_KEYS))})"
                    )

    with open(path, encoding="utf-8") as handle:
        lines = handle.readlines()
    for line_no, raw in enumerate(lines, start=1):
        line = raw.rstrip("\n")
        stripped = line.strip()
        if not stripped or stripped.startswith("#"):
            continue
        indent = len(line) - len(line.lstrip(" "))
        if indent == 0:
            flush()
            state["job_id"] = None
            state["job_keys"] = []
            state["in_jobs"] = stripped.startswith("jobs:")
            continue
        if not state["in_jobs"]:
            continue
        if indent == 2:
            match = JOB_ID.match(line)
            if match:
                flush()
                state["job_id"] = match.group(1)
                state["job_keys"] = []
            continue
        if indent == 4 and state["job_id"] is not None:
            match = JOB_KEY.match(line)
            if match:
                state["job_keys"].append((match.group(1), line_no))
    flush()
    return findings


def main(argv):
    roots = argv[1:] or [".github/workflows"]
    files = []
    for root in roots:
        if os.path.isfile(root):
            files.append(root)
        else:
            for name in sorted(os.listdir(root)):
                if name.endswith((".yml", ".yaml")):
                    files.append(os.path.join(root, name))
    findings = []
    for path in files:
        findings.extend(audit_file(path))
    for finding in findings:
        print(finding)
    if findings:
        print(f"audit-workflow-caller-jobs: {len(findings)} invalid caller job(s)", file=sys.stderr)
        return 1
    print(f"audit-workflow-caller-jobs: {len(files)} workflow files, no invalid caller jobs")
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv))
