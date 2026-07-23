"""Reject unsafe rendering shortcuts in first-party templates and JavaScript."""

from __future__ import annotations

import re
import sys
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]
TEMPLATES_DIR = ROOT / "flask_app" / "templates"
FIRST_PARTY_JAVASCRIPT = (ROOT / "flask_app" / "static" / "app.js",)
CSP_SOURCE = ROOT / "flask_app" / "app.py"

TEMPLATE_RULES = (
    (re.compile(r"\|\s*safe\b"), "Jinja |safe filtresi auto-escape korumasını devre dışı bırakır"),
    (re.compile(r"\sstyle\s*="), "Inline style attribute yerine CSS sınıfı kullanın"),
    (re.compile(r"\son[a-z]+\s*="), "Inline event handler yerine addEventListener kullanın"),
    (re.compile(r"<script(?![^>]*\bnonce=)"), "Script etiketi request nonce değeri taşımalıdır"),
    (re.compile(r"<style(?![^>]*\bnonce=)"), "Style etiketi request nonce değeri taşımalıdır"),
)
CSP_RULES = (
    (re.compile(r"['\"]unsafe-inline['\"]"), "CSP içinde unsafe-inline kullanılamaz"),
)
JAVASCRIPT_RULES = (
    (re.compile(r"\.(?:innerHTML|outerHTML)\b"), "HTML string sink yerine textContent/DOM API kullanın"),
    (re.compile(r"\binsertAdjacentHTML\s*\("), "insertAdjacentHTML kullanıcı verisini XSS'e açabilir"),
    (re.compile(r"\bdocument\.write\s*\("), "document.write güvenli olmayan bir HTML sink'idir"),
    (re.compile(r"\.style(?:\.|\s*=)"), "CSP style-src-attr koruması için classList veya nonce'lu stylesheet kullanın"),
    (re.compile(r"setAttribute\s*\(\s*['\"]style['\"]"), "Dinamik style attribute CSP tarafından engellenir"),
)


def scan_file(path: Path, rules: tuple[tuple[re.Pattern[str], str], ...]) -> list[str]:
    """Return actionable line-based findings for a UTF-8 source file."""
    findings: list[str] = []
    relative_path = path.relative_to(ROOT)
    for line_number, line in enumerate(path.read_text(encoding="utf-8").splitlines(), 1):
        for pattern, message in rules:
            if pattern.search(line):
                findings.append(f"{relative_path}:{line_number}: {message}")
    return findings


def main() -> int:
    findings: list[str] = []
    for template_path in sorted(TEMPLATES_DIR.rglob("*.html")):
        findings.extend(scan_file(template_path, TEMPLATE_RULES + JAVASCRIPT_RULES))
    for javascript_path in FIRST_PARTY_JAVASCRIPT:
        findings.extend(scan_file(javascript_path, JAVASCRIPT_RULES))
    findings.extend(scan_file(CSP_SOURCE, CSP_RULES))

    if findings:
        print("Güvenlik lint hataları:", file=sys.stderr)
        print("\n".join(f"- {finding}" for finding in findings), file=sys.stderr)
        return 1

    print("Security lint passed: unsafe template/DOM sinks were not found.")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
