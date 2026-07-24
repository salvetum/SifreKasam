"""Release-version parsing and update metadata fetching."""

import json
import re
from typing import Any
from urllib.request import Request, urlopen


def normalize_version(value: str | None) -> str:
    return str(value or "").strip().lstrip("vV")


def version_parts(value: str | None) -> tuple[int, ...]:
    normalized = normalize_version(value).split("-", 1)[0]
    numbers = [int(part) for part in re.findall(r"\d+", normalized)]
    return tuple((numbers + [0, 0, 0])[:3])


def is_newer_version(latest: str | None, current: str | None) -> bool:
    latest_parts = version_parts(latest)
    current_parts = version_parts(current)
    return bool(latest_parts) and latest_parts > current_parts


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
