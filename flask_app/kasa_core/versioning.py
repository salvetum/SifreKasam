"""Release-version parsing and update metadata fetching."""

import json
import re
from typing import Any
from urllib.request import Request, urlopen


def normalize_version(value: str | None) -> str:
    return str(value or "").strip().removeprefix("v").removeprefix("V")


def version_parts(value: str | None) -> tuple[int, ...]:
    normalized = normalize_version(value).split("-", 1)[0]
    numbers = [int(part) for part in re.findall(r"\d+", normalized)]
    return tuple((numbers + [0, 0, 0])[:3])


_PRE_RELEASE_ORDER = {"dev": 0, "alpha": 1, "beta": 2, "rc": 3}


def _version_key(value: str | None) -> tuple[tuple[int, ...], tuple[int, int, str]]:
    """Sürümü sıralanabilir anahtar çevirir; ön sürüm ekleri de karşılaştırılır."""
    normalized = normalize_version(value)
    if "-" not in normalized:
        return (version_parts(normalized), (1, 0, ""))
    suffix = normalized.split("-", 1)[1]
    match = re.match(r"([A-Za-z]+)\.?(\d*)", suffix)
    if not match:
        return (version_parts(normalized), (0, 0, normalized))
    label = match.group(1).lower()
    rank = _PRE_RELEASE_ORDER.get(label, 0)
    return (version_parts(normalized), (0, rank, int(match.group(2) or 0)))


def is_newer_version(latest: str | None, current: str | None) -> bool:
    return bool(normalize_version(latest)) and _version_key(latest) > _version_key(current)


def fetch_latest_release(
    api_url: str,
    repository: str,
    app_version: str,
    timeout: float = 5,
) -> dict[str, Any]:
    request = Request(
        api_url,
        headers={
            "Accept": "application/vnd.github+json",
            "User-Agent": f"SifreKasam/{app_version}",
        },
    )
    with urlopen(request, timeout=timeout) as response:
        payload = response.read().decode("utf-8")
    data = json.loads(payload)
    latest_version = normalize_version(data.get("tag_name") or data.get("name"))
    return {
        "latest_version": latest_version,
        "release_name": data.get("name") or f"v{latest_version}",
        "release_url": data.get("html_url")
        or f"https://github.com/{repository}/releases",
        "published_at": data.get("published_at"),
    }
