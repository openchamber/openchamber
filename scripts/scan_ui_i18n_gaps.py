#!/usr/bin/env python3
"""扫描 UI 代码中疑似未做 i18n 处理的文本，并输出文件列表。"""

from __future__ import annotations

import argparse
import re
import sys
from dataclasses import dataclass
from pathlib import Path


SUPPORTED_EXTENSIONS = {".tsx", ".jsx"}


USER_VISIBLE_PROPS = {
    "title",
    "placeholder",
    "aria-label",
    "alt",
    "label",
    "description",
    "helperText",
    "tooltip",
    "message",
    "text",
}


DEFAULT_EXCLUDE_DIRS = {
    "node_modules",
    "dist",
    "build",
    ".git",
    ".next",
    "coverage",
    "__tests__",
    "__mocks__",
}


I18N_CALL_PATTERN = re.compile(r"\b(?:i18n\.)?t\s*\(")
ONLY_SYMBOLS_PATTERN = re.compile(r"^[\s\d_\-:/.#()[\]{}|]+$")
URL_PATTERN = re.compile(r"^(?:https?:)?//")
FILE_LIKE_PATTERN = re.compile(r"^[./~]?[\w\-./]+\.[A-Za-z0-9]{1,8}$")

JSX_TEXT_PATTERN = re.compile(r">\s*([^<{}`\n][^<{}`\n]*?)\s*<")
PROP_LITERAL_PATTERN = re.compile(r"\b([A-Za-z][\w-]*)\s*=\s*(['\"])([^'\"\n]{2,})\2")
CODE_FRAGMENT_PATTERN = re.compile(
    r"(=>|\b(?:Record|Promise|Array|React)\b|[{};]|\bextends\b|\bas\s+[A-Za-z])"
)


@dataclass
class Hit:
    line_number: int
    reason: str
    text: str


def is_excluded(path: Path, excludes: set[str]) -> bool:
    return any(part in excludes for part in path.parts)


def looks_like_human_text(text: str) -> bool:
    candidate = text.strip()
    if len(candidate) < 2:
        return False
    if URL_PATTERN.search(candidate):
        return False
    if FILE_LIKE_PATTERN.fullmatch(candidate):
        return False
    if ONLY_SYMBOLS_PATTERN.fullmatch(candidate):
        return False
    if "${" in candidate:
        return False

    has_letters = bool(
        re.search(r"[A-Za-z\u4e00-\u9fff\u3040-\u30ff\uac00-\ud7af]", candidate)
    )
    return has_letters


def should_ignore_literal(line: str, prop_name: str | None, literal: str) -> bool:
    if "// i18n-scan-ignore" in line:
        return True
    if I18N_CALL_PATTERN.search(line):
        return True
    if "className=" in line and prop_name == "className":
        return True

    if prop_name and prop_name not in USER_VISIBLE_PROPS:
        return True
    if prop_name is None and CODE_FRAGMENT_PATTERN.search(literal):
        return True

    if not looks_like_human_text(literal):
        return True

    return False


def scan_line(line: str, line_number: int) -> list[Hit]:
    hits: list[Hit] = []
    has_jsx_hint = "<" in line and ">" in line

    if has_jsx_hint:
        for match in JSX_TEXT_PATTERN.finditer(line):
            text = match.group(1).strip()
            if text.startswith("{") or text.endswith("}"):
                continue
            if "</" not in line and "/>" not in line:
                continue
            if should_ignore_literal(line, None, text):
                continue
            hits.append(Hit(line_number=line_number, reason="jsx-text", text=text))

    for match in PROP_LITERAL_PATTERN.finditer(line):
        prop_name = match.group(1)
        literal = match.group(3).strip()
        if should_ignore_literal(line, prop_name, literal):
            continue
        hits.append(Hit(line_number=line_number, reason="prop-literal", text=literal))

    return hits


def scan_file(file_path: Path) -> list[Hit]:
    try:
        content = file_path.read_text(encoding="utf-8")
    except UnicodeDecodeError:
        return []

    hits: list[Hit] = []
    for index, line in enumerate(content.splitlines(), start=1):
        stripped = line.strip()
        if not stripped or stripped.startswith("//"):
            continue
        hits.extend(scan_line(line=line, line_number=index))
    return hits


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(description="扫描 UI 代码中未进行 i18n 的可疑文本")
    parser.add_argument(
        "--root",
        default="packages/ui/src/components",
        help="扫描根目录（默认: packages/ui/src/components）",
    )
    parser.add_argument(
        "--verbose",
        action="store_true",
        help="输出具体命中行与原因",
    )
    parser.add_argument(
        "--max-hits-per-file",
        type=int,
        default=20,
        help="每个文件最多展示多少条命中（默认: 20）",
    )
    return parser


def main() -> int:
    args = build_parser().parse_args()
    root = Path(args.root).resolve()

    if not root.exists() or not root.is_dir():
        print(f"[ERROR] 扫描根目录不存在: {root}", file=sys.stderr)
        return 2

    findings: dict[Path, list[Hit]] = {}

    for path in root.rglob("*"):
        if not path.is_file():
            continue
        if path.suffix not in SUPPORTED_EXTENSIONS:
            continue
        if is_excluded(path.relative_to(root), DEFAULT_EXCLUDE_DIRS):
            continue

        hits = scan_file(path)
        if hits:
            findings[path] = hits

    if not findings:
        print("未发现疑似未做 i18n 处理的 UI 文件。")
        return 0

    print("发现疑似未做 i18n 处理的文件：")
    for file_path in sorted(findings.keys()):
        rel = (
            file_path.relative_to(Path.cwd())
            if file_path.is_relative_to(Path.cwd())
            else file_path
        )
        print(f"- {rel}")
        if args.verbose:
            for hit in findings[file_path][: args.max_hits_per_file]:
                print(f"    L{hit.line_number:<4} [{hit.reason}] {hit.text}")

    print(f"\n总计: {len(findings)} 个文件")
    return 1


if __name__ == "__main__":
    raise SystemExit(main())
