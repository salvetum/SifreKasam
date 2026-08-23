"""Giriş brute-force koruması: üstel geri çekilme ve kalıcı kilit durumu."""

import json
import logging
import os
import threading
import time

from kasa_core.paths import get_data_dir

log = logging.getLogger(__name__)

LOGIN_LOCK_THRESHOLD = 5
LOGIN_LOCK_BASE_SECONDS = 30
LOGIN_LOCK_MAX_SECONDS = 30 * 60

_login_attempts: dict[str, dict[str, float | int]] = {}
_attempts_lock = threading.Lock()
_lockout_file = os.path.join(get_data_dir(), 'login_lockout.json')


def _save() -> None:
    now = time.time()
    with _attempts_lock:
        expired = [k for k, v in _login_attempts.items()
                   if now - float(v.get('locked_until', 0)) > LOGIN_LOCK_MAX_SECONDS and int(v.get('failures', 0)) >= LOGIN_LOCK_THRESHOLD]
        for k in expired:
            _login_attempts.pop(k, None)
        snapshot = dict(_login_attempts)
    try:
        with open(_lockout_file, 'w', encoding='utf-8') as f:
            json.dump(snapshot, f)
    except OSError:
        pass


def load_persisted() -> None:
    if not os.path.isfile(_lockout_file):
        return
    try:
        with open(_lockout_file, 'r', encoding='utf-8') as f:
            data = json.load(f)
        if isinstance(data, dict):
            with _attempts_lock:
                _login_attempts.update(data)
    except (OSError, json.JSONDecodeError):
        pass


def retry_after(key: str) -> int:
    with _attempts_lock:
        state = _login_attempts.get(key) or {}
        remaining = int(max(0, float(state.get('locked_until', 0)) - time.time()))
        if remaining <= 0 and state.get('locked_until'):
            state.pop('locked_until', None)
        return remaining


def backoff_seconds(failures: int) -> int:
    """Başarısız girişler sürdükçe bekleme süresini 30 dakikaya kadar katlar."""
    if failures < LOGIN_LOCK_THRESHOLD:
        return 0
    exponent = failures - LOGIN_LOCK_THRESHOLD
    return min(LOGIN_LOCK_BASE_SECONDS * (2 ** exponent), LOGIN_LOCK_MAX_SECONDS)


def record_failure(key: str) -> int:
    with _attempts_lock:
        state = _login_attempts.setdefault(key, {'failures': 0, 'locked_until': 0.0})
        failures = int(state.get('failures', 0)) + 1
        state['failures'] = failures
        wait_seconds = backoff_seconds(failures)
        if wait_seconds:
            state['locked_until'] = max(float(state.get('locked_until', 0)), time.time() + wait_seconds)
        remaining = int(max(0, float(state.get('locked_until', 0)) - time.time()))
    _save()
    return remaining


def reset_failures(key: str) -> None:
    with _attempts_lock:
        _login_attempts.pop(key, None)
    _save()


load_persisted()
