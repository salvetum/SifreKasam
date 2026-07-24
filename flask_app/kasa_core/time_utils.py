"""UTC timestamp helpers with explicit timezone semantics."""

from datetime import UTC, datetime


def utc_now() -> datetime:
    """Return the current timezone-aware UTC datetime."""
    return datetime.now(UTC)


def utc_now_naive() -> datetime:
    """Return naive UTC for existing SQLite DateTime columns."""
    return utc_now().replace(tzinfo=None)


def utc_iso_timestamp() -> str:
    """Return an ISO 8601 UTC timestamp using the compact Z suffix."""
    return utc_now().isoformat(timespec="seconds").replace("+00:00", "Z")
