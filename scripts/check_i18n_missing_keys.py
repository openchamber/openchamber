#!/usr/bin/env python3
"""Check missing i18n keys used by t(...) calls in UI source files."""

from __future__ import annotations

import argparse
import json
import re
import sys
from dataclasses import dataclass
from pathlib import Path


SUPPORTED_EXTENSIONS = {".ts", ".tsx", ".js", ".jsx"}
DEFAULT_SOURCE_ROOT = "packages/ui/src"
DEFAULT_LOCALES = (
    "packages/ui/src/i18n/locales/en.json",
    "packages/ui/src/i18n/locales/zh.json",
)


T_CALL_PATTERN = re.compile(r"""\bt\s*\(\s*(['"])([^'"`]+?)\1""")


@dataclass(frozen=True)
class KeyUsage:
    key: str
    file_path: Path
    line_number: int


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(
        description="检查 t('...') 调用的 key 是否在 locale JSON 中存在"
    )
    parser.add_argument(
        "--source-root",
        default=DEFAULT_SOURCE_ROOT,
        help=f"源码根目录（默认: {DEFAULT_SOURCE_ROOT}）",
    )
    parser.add_argument(
        "--locale",
        action="append",
        dest="locales",
        default=[],
        help="locale 文件路径，可传多次（默认检查 en/zh）",
    )
    parser.add_argument(
        "--allow-dynamic-prefix",
        action="append",
        default=[],
        help="允许动态 key 前缀（例如 commandDialog.），以避免误报",
    )
    parser.add_argument(
        "--allow-flat-keys",
        action="store_true",
        help="允许检查不带 '.' 的 key（默认仅检查 namespace.key 形式）",
    )
    return parser.parse_args()


def flatten_locale_keys(value: object, prefix: str = "") -> set[str]:
    keys: set[str] = set()
    if not isinstance(value, dict):
        return keys

    for key, child in value.items():
        full = f"{prefix}.{key}" if prefix else key
        if isinstance(child, dict):
            keys.update(flatten_locale_keys(child, full))
        else:
            keys.add(full)

    return keys


def load_locale_keys(locale_path: Path) -> set[str]:
    try:
        data = json.loads(locale_path.read_text(encoding="utf-8"))
    except FileNotFoundError:
        raise FileNotFoundError(f"locale 文件不存在: {locale_path}") from None
    except json.JSONDecodeError as exc:
        raise ValueError(f"locale JSON 解析失败: {locale_path}: {exc}") from exc

    return flatten_locale_keys(data)


def iter_source_files(source_root: Path) -> list[Path]:
    files: list[Path] = []
    for path in source_root.rglob("*"):
        if not path.is_file():
            continue
        if path.suffix not in SUPPORTED_EXTENSIONS:
            continue
        files.append(path)
    return files


def collect_usages(source_root: Path) -> list[KeyUsage]:
    usages: list[KeyUsage] = []
    for file_path in iter_source_files(source_root):
        text = file_path.read_text(encoding="utf-8", errors="ignore")
        for index, line in enumerate(text.splitlines(), start=1):
            for match in T_CALL_PATTERN.finditer(line):
                key = match.group(2).strip()
                if not key:
                    continue
                usages.append(KeyUsage(key=key, file_path=file_path, line_number=index))
    return usages


def should_allow_dynamic(key: str, allow_prefixes: list[str]) -> bool:
    return any(key.startswith(prefix) for prefix in allow_prefixes)


def main() -> int:
    args = parse_args()
    source_root = Path(args.source_root).resolve()
    locale_paths = [Path(p).resolve() for p in (args.locales or DEFAULT_LOCALES)]

    if not source_root.exists() or not source_root.is_dir():
        print(f"[ERROR] source 根目录不存在: {source_root}", file=sys.stderr)
        return 2

    locale_key_map: dict[Path, set[str]] = {}
    try:
        for locale_path in locale_paths:
            locale_key_map[locale_path] = load_locale_keys(locale_path)
    except (FileNotFoundError, ValueError) as exc:
        print(f"[ERROR] {exc}", file=sys.stderr)
        return 2

    usages = collect_usages(source_root)
    missing_by_locale: dict[Path, list[KeyUsage]] = {path: [] for path in locale_paths}

    for usage in usages:
        if not args.allow_flat_keys and "." not in usage.key:
            continue
        if should_allow_dynamic(usage.key, args.allow_dynamic_prefix):
            continue
        for locale_path, locale_keys in locale_key_map.items():
            if usage.key not in locale_keys:
                missing_by_locale[locale_path].append(usage)

    total_missing = sum(len(items) for items in missing_by_locale.values())
    if total_missing == 0:
        checked_locales = ", ".join(str(p.relative_to(Path.cwd())) for p in locale_paths)
        print(f"OK: 未发现缺失 i18n keys。已检查 locale: {checked_locales}")
        return 0

    print("=" * 72)
    print("发现缺失 i18n keys")
    print("=" * 72)

    for locale_path in locale_paths:
        rel_locale = (
            locale_path.relative_to(Path.cwd())
            if locale_path.is_relative_to(Path.cwd())
            else locale_path
        )
        items = missing_by_locale[locale_path]
        unique_keys = sorted({item.key for item in items})
        print(f"\nLocale: {rel_locale}")
        print(f"缺失 key 数量: {len(unique_keys)} (引用次数: {len(items)})")
        for key in unique_keys:
            first = next(item for item in items if item.key == key)
            rel_file = (
                first.file_path.relative_to(Path.cwd())
                if first.file_path.is_relative_to(Path.cwd())
                else first.file_path
            )
            print(f"  - {key}  ({rel_file}:{first.line_number})")

    print("\n提示: 可在 CI 中执行此脚本并以非 0 退出码阻断合并。")
    return 1


if __name__ == "__main__":
    raise SystemExit(main())
