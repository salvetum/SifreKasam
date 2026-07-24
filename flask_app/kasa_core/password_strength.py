"""Consistent zxcvbn-based password-strength analysis."""

import logging
import math
import re
from collections.abc import Iterable
from typing import Any
from urllib.parse import urlparse


log = logging.getLogger(__name__)

ACCEPTABLE_PASSWORD_SCORE = 3
PASSWORD_MIN_LENGTH = 12
LONG_PASSPHRASE_MIN_LENGTH = 20
LONG_PASSPHRASE_MIN_WORDS = 4
MAX_ANALYZED_PASSWORD_LENGTH = 256
MAX_USER_INPUTS = 24
MAX_USER_INPUT_LENGTH = 200

try:
    from zxcvbn import zxcvbn as _zxcvbn
except ImportError:
    _zxcvbn = None


def _context_variants(value: object) -> list[str]:
    text = str(value or "").strip()[:MAX_USER_INPUT_LENGTH]
    if not text:
        return []

    variants = [text]
    parsed = urlparse(text if "://" in text else f"//{text}")
    if parsed.hostname:
        variants.append(parsed.hostname)
        variants.extend(parsed.hostname.split("."))
    if "@" in text:
        local_part, _, domain = text.partition("@")
        variants.extend((local_part, domain))
    variants.extend(
        token
        for token in re.split(r"[^0-9A-Za-zÇĞİÖŞÜçğıöş]+", text)
        if len(token) >= 3
    )
    return variants


def normalize_user_inputs(values: object) -> list[str]:
    if not isinstance(values, Iterable) or isinstance(values, (str, bytes, dict)):
        return []

    normalized: list[str] = []
    seen: set[str] = set()
    for value in values:
        for variant in _context_variants(value):
            key = variant.casefold()
            if len(key) < 3 or key in seen:
                continue
            seen.add(key)
            normalized.append(variant)
            if len(normalized) >= MAX_USER_INPUTS:
                return normalized
    return normalized


def _character_requirements(password: str) -> dict[str, bool]:
    return {
        "min_length": len(password) >= PASSWORD_MIN_LENGTH,
        "lowercase": any(character.islower() for character in password),
        "uppercase": any(character.isupper() for character in password),
        "number": any(character.isdigit() for character in password),
        "symbol": any(not character.isalnum() for character in password),
    }


def _is_long_passphrase(password: str) -> bool:
    words = [word for word in password.split() if word]
    return (
        len(password) >= LONG_PASSPHRASE_MIN_LENGTH
        and len(words) >= LONG_PASSPHRASE_MIN_WORDS
    )


def _apply_composition_policy(
    score: int,
    password: str,
    requirements: dict[str, bool],
) -> int:
    """Require character variety for short passwords without penalizing passphrases."""
    if not requirements["min_length"]:
        return min(score, 1)
    if _is_long_passphrase(password):
        return score

    character_class_count = sum(
        requirements[key]
        for key in ("lowercase", "uppercase", "number", "symbol")
    )
    if character_class_count <= 2:
        return min(score, 1)
    if character_class_count < 4:
        return min(score, 2)
    return score


def _result_payload(
    score: int,
    guesses_log10: float,
    crack_time: str,
    feedback: dict[str, Any],
    requirements: dict[str, bool],
) -> dict[str, Any]:
    return {
        "score": max(0, min(4, int(score))),
        "guesses_log10": float(guesses_log10),
        "crack_time": crack_time,
        "feedback": feedback,
        "requirements": requirements,
        "missing_requirements": [
            key for key, requirement_met in requirements.items()
            if not requirement_met
        ],
    }


def _fallback_analysis(password: str, user_inputs: list[str]) -> dict[str, Any]:
    requirements = _character_requirements(password)
    character_class_count = sum(
        requirements[key]
        for key in ("lowercase", "uppercase", "number", "symbol")
    )
    score = sum([
        requirements["min_length"],
        len(password) >= 16,
        character_class_count >= 3,
        character_class_count == 4,
    ])
    folded_password = password.casefold()
    if any(value.casefold() in folded_password for value in user_inputs):
        score = min(score, 1)
    score = _apply_composition_policy(score, password, requirements)

    guesses = max(1, 10 ** (score * 2))
    seconds = guesses / 10_000
    return _result_payload(
        score,
        math.log10(guesses),
        "less than a second" if seconds < 1 else f"{seconds:g} seconds",
        {"warning": "", "suggestions": []},
        requirements,
    )


def analyze_password(
    password: str,
    user_inputs: object = None,
) -> dict[str, Any]:
    analyzed_password = str(password or "")[:MAX_ANALYZED_PASSWORD_LENGTH]
    normalized_inputs = normalize_user_inputs(user_inputs)
    requirements = _character_requirements(analyzed_password)
    if not analyzed_password:
        return _result_payload(
            0,
            0.0,
            "",
            {"warning": "", "suggestions": []},
            requirements,
        )

    if _zxcvbn is None:
        return _fallback_analysis(analyzed_password, normalized_inputs)

    try:
        result = _zxcvbn(analyzed_password, user_inputs=normalized_inputs)
        feedback = result.get("feedback") or {}
        score = _apply_composition_policy(
            max(0, min(4, int(result.get("score", 0)))),
            analyzed_password,
            requirements,
        )
        return _result_payload(
            score,
            float(result.get("guesses_log10", 0.0)),
            str(
                (result.get("crack_times_display") or {}).get(
                    "offline_slow_hashing_1e4_per_second",
                    "",
                )
            ),
            {
                "warning": str(feedback.get("warning") or ""),
                "suggestions": [
                    str(suggestion)
                    for suggestion in feedback.get("suggestions") or []
                ],
            },
            requirements,
        )
    except Exception:
        log.exception("zxcvbn score calculation failed")
        return _fallback_analysis(analyzed_password, normalized_inputs)


def score_password(password: str, user_inputs: object = None) -> int:
    return int(analyze_password(password, user_inputs)["score"])


def password_is_weak(password: str, user_inputs: object = None) -> bool:
    return score_password(password, user_inputs) < ACCEPTABLE_PASSWORD_SCORE
