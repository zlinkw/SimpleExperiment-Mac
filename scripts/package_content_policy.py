"""发行包内容策略分类器（Python 端）。

规则数据单源：scripts/package-content-policy.json（与 scripts/package-content-policy.js 同源，
两端等价性由 test/features/packageContentPolicy.test.js 矩阵强制）。
CLI:
  python3 -I scripts/package_content_policy.py --zip <final.vsix>    # 校验最终归档实际 namelist
  python3 -I scripts/package_content_policy.py --list <file>         # 校验逐行清单（vsce ls 等）
诊断只输出 路径<category:类别> 与 missing required 项，绝不输出文件内容。
"""
import json
import pathlib
import sys
import zipfile

_HERE = pathlib.Path(__file__).resolve().parent
POLICY = json.loads((_HERE / "package-content-policy.json").read_text(encoding="utf-8"))


def normalize(entry):
    s = str(entry or "").strip().replace("\\", "/").lower()
    while True:
        if s.startswith("./"):
            s = s[2:]
        elif s.startswith("extension/"):
            s = s[len("extension/"):]
        else:
            break
    return s.rstrip("/")


def classify(entry):
    norm = normalize(entry)
    if not norm:
        return None
    base = norm.rsplit("/", 1)[-1]
    at_root = "/" not in norm
    if at_root and base in POLICY["legal_root_basenames"]:
        return None
    if at_root and base in POLICY["toolchain_readme_exception"]["root_basenames"]:
        return None
    doc_markdown_skipped = {".md"} if norm in POLICY["markdown_runtime_allow_files"] else set()
    for rule in POLICY["forbidden_ordered"]:
        if rule.get("paths") and any(norm == normalize(candidate) for candidate in rule["paths"]):
            return rule["category"]
        if rule.get("basename_contains") and rule["basename_contains"] in base:
            return rule["category"]
        if rule.get("path_segments") and any(seg in norm.split("/") for seg in rule["path_segments"]):
            return rule["category"]
        if rule.get("suffixes") and any(base.endswith(suffix) for suffix in rule["suffixes"]):
            return rule["category"]
        if rule.get("basenames") and base in rule["basenames"]:
            return rule["category"]
        if rule.get("path_prefixes") and any(norm.startswith(prefix) for prefix in rule["path_prefixes"]):
            return rule["category"]
        if rule.get("basename_prefixes") and any(base.startswith(prefix) for prefix in rule["basename_prefixes"]):
            return rule["category"]
        if rule.get("extension") and base.endswith(rule["extension"]):
            if rule["extension"] in doc_markdown_skipped:
                continue
            return rule["category"]
    return None


def check_listing(entries):
    violations = []
    seen = set()
    for entry in entries:
        norm = normalize(entry)
        if not norm:
            continue
        seen.add(norm)
        category = classify(norm)
        if category:
            violations.append(f"{norm} <category:{category}>")
    for required in POLICY["required"]:
        if normalize(required) not in seen:
            violations.append(f"missing required {normalize(required)}")
    if not any(name in seen for name in POLICY["toolchain_readme_exception"]["root_basenames"]):
        violations.append("missing toolchain-exception root readme.md (vsce-enforced)")
    return violations


def main(argv):
    if len(argv) == 3 and argv[1] == "--zip":
        with zipfile.ZipFile(argv[2]) as archive:
            names = archive.namelist()
    elif len(argv) == 3 and argv[1] == "--list":
        names = pathlib.Path(argv[2]).read_text(encoding="utf-8").splitlines()
    else:
        print("usage: package_content_policy.py --zip <archive> | --list <file>", file=sys.stderr)
        return 2
    violations = check_listing(names)
    if violations:
        print(f"VSIX content policy violations ({len(violations)}):", file=sys.stderr)
        for line in violations:
            print(f"- {line}", file=sys.stderr)
        return 1
    print(f"package content policy ok: {len(names)} entries")
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv))
