from __future__ import annotations

import json
import os
import smtplib
import time
import zipfile
import threading
import unicodedata
import urllib.error
import urllib.parse
import urllib.request
from datetime import datetime, timezone
from email.message import EmailMessage
from pathlib import Path
from typing import Any

BASE_DIR = Path(__file__).resolve().parent
STATIC_DIR = BASE_DIR / "static"
PLAYOFF_DATA_PATH = STATIC_DIR / "playoff-data.json"
INITIAL_SUBMISSIONS_PATH = STATIC_DIR / "playoff-initial-submissions.json"
REQUESTED_DATA_DIR = os.environ.get("DATA_DIR", "").strip()
DATA_DIR_WARNING = ""


def _data_dir_candidates() -> list[Path]:
    candidates: list[Path] = []
    if REQUESTED_DATA_DIR:
        candidates.append(Path(REQUESTED_DATA_DIR))
    candidates.extend([
        BASE_DIR / "data",
        Path("/tmp") / "tsmsf2026-data",
    ])

    unique: list[Path] = []
    seen: set[str] = set()
    for candidate in candidates:
        key = str(candidate.expanduser())
        if key in seen:
            continue
        seen.add(key)
        unique.append(candidate)
    return unique


def _is_writable_dir(path: Path) -> tuple[bool, str]:
    try:
        path.mkdir(parents=True, exist_ok=True)
        probe = path / f".write-test-{os.getpid()}-{time.time_ns()}"
        probe.write_text("ok", encoding="utf-8")
        probe.unlink(missing_ok=True)
        return True, ""
    except Exception as exc:
        return False, str(exc)


def _resolve_data_dir() -> tuple[Path, str]:
    failures: list[str] = []
    for candidate in _data_dir_candidates():
        ok, reason = _is_writable_dir(candidate)
        if ok:
            if failures:
                return candidate, "DATA_DIR fallback aktivní: " + " | ".join(failures)
            return candidate, ""
        failures.append(f"{candidate}: {reason}")

    # Last-resort relative directory. If this also fails, the original exception
    # will be visible from ensure_storage/write_submissions.
    fallback = BASE_DIR / "data"
    return fallback, "DATA_DIR není zapisovatelný: " + " | ".join(failures)


DATA_DIR, DATA_DIR_WARNING = _resolve_data_dir()
SUBMISSIONS_PATH = DATA_DIR / "playoff_submissions.json"
EXPORT_PATH = DATA_DIR / "tipy-playoff-ms-2026.xlsx"
DEFAULT_OWNER_EMAIL = "libormm@seznam.cz"
DEFAULT_SMTP_HOST = "smtp.seznam.cz"
DEFAULT_SMTP_PORT = "465"
DEFAULT_SMTP_SECURE = "true"

OWNER_EMAIL = os.environ.get("OWNER_EMAIL", DEFAULT_OWNER_EMAIL).strip() or DEFAULT_OWNER_EMAIL
ADMIN_TOKEN = os.environ.get("ADMIN_TOKEN", "")
GOOGLE_SHEETS_WEBAPP_URL = os.environ.get("GOOGLE_SHEETS_WEBAPP_URL", "").strip()
GOOGLE_SHEETS_SECRET = os.environ.get("GOOGLE_SHEETS_SECRET", "").strip()
try:
    GOOGLE_SHEETS_TIMEOUT = int(os.environ.get("GOOGLE_SHEETS_TIMEOUT", "12"))
except (TypeError, ValueError):
    GOOGLE_SHEETS_TIMEOUT = 12
_STORAGE_LOCK = threading.Lock()
_SHEETS_CACHE_LOCK = threading.Lock()
_SHEETS_CACHE: dict[str, Any] = {"expires": 0.0, "items": [], "error": ""}
SHEETS_CACHE_TTL_SECONDS = 20

with PLAYOFF_DATA_PATH.open("r", encoding="utf-8") as fh:
    PLAYOFF_DATA = json.load(fh)


# Vestavěná záloha importu z přiloženého XLSX. Díky tomu se záznam z XLS
# zobrazí i tehdy, když se na GitHub omylem nenahraje soubor
# static/playoff-initial-submissions.json nebo když existuje prázdný persistentní
# disk na Renderu. Hesla ani citlivé údaje zde nejsou.
EMBEDDED_INITIAL_SUBMISSIONS: list[dict[str, Any]] = [
  {
    "id": "seed-xlsx-libormm-seznam-cz-20260628165138",
    "source": "tipy-playoff-ms-2026.xlsx",
    "isSeed": True,
    "submittedAt": "2026-06-28T16:51:38.255Z",
    "name": "Libor",
    "email": "libormm@seznam.cz",
    "betType": "gold",
    "consent": True,
    "predictions": {
      "A": {"homeGoals": 1, "awayGoals": 1, "winner": "Kanada"},
      "B": {"homeGoals": 2, "awayGoals": 1, "winner": "Německo"},
      "C": {"homeGoals": 1, "awayGoals": 1, "winner": "Maroko"},
      "D": {"homeGoals": 1, "awayGoals": 1, "winner": "Japonsko"},
      "E": {"homeGoals": 2, "awayGoals": 1, "winner": "Francie"},
      "F": {"homeGoals": 1, "awayGoals": 2, "winner": "Norsko"},
      "G": {"homeGoals": 2, "awayGoals": 1, "winner": "Mexiko"},
      "H": {"homeGoals": 2, "awayGoals": 0, "winner": "Anglie"},
      "I": {"homeGoals": 2, "awayGoals": 1, "winner": "Spojené státy"},
      "J": {"homeGoals": 1, "awayGoals": 1, "winner": "Senegal"},
      "K": {"homeGoals": 1, "awayGoals": 1, "winner": "Chorvatsko"},
      "L": {"homeGoals": 2, "awayGoals": 1, "winner": "Španělsko"},
      "M": {"homeGoals": 2, "awayGoals": 1, "winner": "Švýcarsko"},
      "N": {"homeGoals": 3, "awayGoals": 0, "winner": "Argentina"},
      "O": {"homeGoals": 1, "awayGoals": 1, "winner": "Ghana"},
      "P": {"homeGoals": 1, "awayGoals": 2, "winner": "Egypt"},
      "Q": {"homeGoals": 1, "awayGoals": 2, "winner": "Francie"},
      "R": {"homeGoals": 1, "awayGoals": 1, "winner": "Maroko"},
      "S": {"homeGoals": 1, "awayGoals": 1, "winner": "Japonsko"},
      "T": {"homeGoals": 2, "awayGoals": 1, "winner": "Mexiko"},
      "U": {"homeGoals": 1, "awayGoals": 2, "winner": "Španělsko"},
      "V": {"homeGoals": 2, "awayGoals": 1, "winner": "Spojené státy"},
      "W": {"homeGoals": 2, "awayGoals": 1, "winner": "Argentina"},
      "X": {"homeGoals": 1, "awayGoals": 1, "winner": "Ghana"},
      "Y": {"homeGoals": 2, "awayGoals": 1, "winner": "Francie"},
      "Z": {"homeGoals": 1, "awayGoals": 1, "winner": "Spojené státy"},
      "AA": {"homeGoals": 1, "awayGoals": 2, "winner": "Mexiko"},
      "AB": {"homeGoals": 2, "awayGoals": 1, "winner": "Argentina"},
      "AC": {"homeGoals": 1, "awayGoals": 1, "winner": "Francie"},
      "AD": {"homeGoals": 1, "awayGoals": 1, "winner": "Mexiko"},
      "BR": {"homeGoals": 2, "awayGoals": 1, "winner": "Spojené státy"},
      "FIN": {"homeGoals": 1, "awayGoals": 2, "winner": "Mexiko"}
    },
    "bonuses": {"extraTimes": 9, "penaltyShootouts": 5, "totalGoals": 90}
  }
]


def match_by_id(match_id: str) -> dict[str, Any] | None:
    return next((match for match in PLAYOFF_DATA["matches"] if match.get("id") == match_id), None)


def clean(value: Any) -> str:
    return "" if value is None else str(value).strip()


def display_name(value: Any) -> str:
    name = clean(value)
    if name.lower().replace(" ", "") == "chatgpt":
        return "Dan Mališ"
    return name


def concrete_options(match: dict[str, Any]) -> list[str]:
    options = match.get("winnerOptions") or []
    if options:
        return [clean(x) for x in options if clean(x)]
    return [x for x in [clean(match.get("home")), clean(match.get("away"))] if x]


def prediction_winner(predictions: dict[str, Any], match_id: str) -> str:
    pred = predictions.get(match_id) if isinstance(predictions, dict) else None
    return clean((pred or {}).get("winner"))


def entrants(match: dict[str, Any], predictions: dict[str, Any], stack: set[str] | None = None) -> list[str]:
    if stack is None:
        stack = set()
    match_id = str(match.get("id"))
    if match_id in stack:
        return concrete_options(match)
    stack.add(match_id)

    def resolve_source(source: dict[str, Any] | None, fallback: Any) -> list[str]:
        fallback_text = clean(fallback)
        if not source:
            return [fallback_text] if fallback_text else []
        source_match = match_by_id(str(source.get("matchId")))
        if not source_match:
            return [fallback_text] if fallback_text else []
        source_entrants = entrants(source_match, predictions, stack)
        source_winner = prediction_winner(predictions, str(source.get("matchId")))
        if source.get("type") == "winner":
            return [source_winner] if source_winner else source_entrants
        if source.get("type") == "loser":
            if source_winner and source_winner in source_entrants:
                return [team for team in source_entrants if team != source_winner]
            return source_entrants
        return [fallback_text] if fallback_text else []

    teams: list[str] = []
    teams.extend(resolve_source(match.get("homeSource"), match.get("home")))
    teams.extend(resolve_source(match.get("awaySource"), match.get("away")))
    stack.discard(match_id)
    unique = list(dict.fromkeys(team for team in teams if team))
    return unique or concrete_options(match)


def is_email(value: str) -> bool:
    value = clean(value)
    return "@" in value and "." in value.rsplit("@", 1)[-1] and " " not in value


def ensure_storage() -> None:
    DATA_DIR.mkdir(parents=True, exist_ok=True)
    if not SUBMISSIONS_PATH.exists():
        SUBMISSIONS_PATH.write_text("[]", encoding="utf-8")


def read_submissions() -> list[dict[str, Any]]:
    ensure_storage()
    try:
        data = json.loads(SUBMISSIONS_PATH.read_text(encoding="utf-8"))
        return data if isinstance(data, list) else []
    except Exception:
        return []


def normalize_seed_items(items: list[dict[str, Any]]) -> list[dict[str, Any]]:
    normalized: list[dict[str, Any]] = []
    for item in items:
        if not isinstance(item, dict):
            continue
        copied = dict(item)
        copied.setdefault("source", "xls-import")
        copied.setdefault("isSeed", True)
        normalized.append(copied)
    return normalized


def read_initial_submissions() -> list[dict[str, Any]]:
    """Read bundled seed submissions imported from the provided XLSX.

    If the JSON file is missing, fall back to EMBEDDED_INITIAL_SUBMISSIONS, so
    the final play-off table is not empty after a partial GitHub upload.
    """
    try:
        if INITIAL_SUBMISSIONS_PATH.exists():
            data = json.loads(INITIAL_SUBMISSIONS_PATH.read_text(encoding="utf-8"))
            if isinstance(data, list) and data:
                return normalize_seed_items(data)
    except Exception:
        pass
    return normalize_seed_items(EMBEDDED_INITIAL_SUBMISSIONS)


def sheets_config() -> dict[str, Any]:
    return {
        "enabled": bool(GOOGLE_SHEETS_WEBAPP_URL and GOOGLE_SHEETS_SECRET),
        "urlSet": bool(GOOGLE_SHEETS_WEBAPP_URL),
        "secretSet": bool(GOOGLE_SHEETS_SECRET),
        "timeout": GOOGLE_SHEETS_TIMEOUT,
    }


def _sheets_request(payload: dict[str, Any] | None = None) -> dict[str, Any]:
    if not GOOGLE_SHEETS_WEBAPP_URL or not GOOGLE_SHEETS_SECRET:
        raise RuntimeError("Google Sheets není nakonfigurovaný: chybí GOOGLE_SHEETS_WEBAPP_URL nebo GOOGLE_SHEETS_SECRET.")

    if payload is None:
        url = GOOGLE_SHEETS_WEBAPP_URL
        separator = "&" if "?" in url else "?"
        url = f"{url}{separator}{urllib.parse.urlencode({'secret': GOOGLE_SHEETS_SECRET})}"
        req = urllib.request.Request(url, headers={"Accept": "application/json"}, method="GET")
    else:
        body = json.dumps({"secret": GOOGLE_SHEETS_SECRET, **payload}, ensure_ascii=False).encode("utf-8")
        req = urllib.request.Request(
            GOOGLE_SHEETS_WEBAPP_URL,
            data=body,
            headers={"Content-Type": "application/json; charset=utf-8", "Accept": "application/json"},
            method="POST",
        )

    try:
        with urllib.request.urlopen(req, timeout=GOOGLE_SHEETS_TIMEOUT) as response:
            raw = response.read().decode("utf-8")
            return json.loads(raw or "{}")
    except urllib.error.HTTPError as exc:
        detail = exc.read().decode("utf-8", errors="replace")[:500]
        raise RuntimeError(f"Google Sheets HTTP {exc.code}: {detail}") from exc


def append_submission_to_google_sheets(payload: dict[str, Any]) -> dict[str, Any]:
    if not GOOGLE_SHEETS_WEBAPP_URL or not GOOGLE_SHEETS_SECRET:
        return {"enabled": False, "saved": False, "reason": "GOOGLE_SHEETS_WEBAPP_URL nebo GOOGLE_SHEETS_SECRET není nastavený."}
    result = _sheets_request({"action": "append", "submission": payload})
    if not result.get("ok"):
        raise RuntimeError(str(result.get("error") or result))
    with _SHEETS_CACHE_LOCK:
        _SHEETS_CACHE["expires"] = 0.0
    return {"enabled": True, "saved": True, "id": result.get("id"), "rows": result.get("rows")}


def read_google_sheets_submissions(force: bool = False) -> list[dict[str, Any]]:
    if not GOOGLE_SHEETS_WEBAPP_URL or not GOOGLE_SHEETS_SECRET:
        return []
    now = time.time()
    with _SHEETS_CACHE_LOCK:
        if not force and now < float(_SHEETS_CACHE.get("expires") or 0):
            return list(_SHEETS_CACHE.get("items") or [])
    try:
        result = _sheets_request(None)
        if not result.get("ok"):
            raise RuntimeError(str(result.get("error") or result))
        items = result.get("submissions") if isinstance(result.get("submissions"), list) else []
        normalized = [item for item in items if isinstance(item, dict)]
        with _SHEETS_CACHE_LOCK:
            _SHEETS_CACHE.update({"expires": now + SHEETS_CACHE_TTL_SECONDS, "items": normalized, "error": ""})
        return normalized
    except Exception as exc:
        with _SHEETS_CACHE_LOCK:
            _SHEETS_CACHE.update({"expires": now + SHEETS_CACHE_TTL_SECONDS, "error": str(exc)})
        return []


def google_sheets_status() -> dict[str, Any]:
    cfg = sheets_config()
    with _SHEETS_CACHE_LOCK:
        return {**cfg, "lastError": str(_SHEETS_CACHE.get("error") or ""), "cachedCount": len(_SHEETS_CACHE.get("items") or [])}


def all_submissions() -> list[dict[str, Any]]:
    """Bundled XLS import + Google Sheets + stored live form submissions.

    Dedupe only by identical id. Imported XLS rows are intentionally kept
    separate from later live submissions even if they use the same e-mail,
    because the user asked to prefill the final table from the XLS file.
    """
    merged: list[dict[str, Any]] = []
    seen: set[str] = set()
    for item in [*read_initial_submissions(), *read_google_sheets_submissions(), *read_submissions()]:
        if not isinstance(item, dict):
            continue
        key = clean(item.get("id")) or f"row-{len(merged)}"
        if key in seen:
            continue
        seen.add(key)
        merged.append(item)
    return merged


def write_submissions(items: list[dict[str, Any]]) -> None:
    ensure_storage()
    tmp_path = SUBMISSIONS_PATH.with_suffix(".json.tmp")
    tmp_path.write_text(json.dumps(items, ensure_ascii=False, indent=2), encoding="utf-8")
    tmp_path.replace(SUBMISSIONS_PATH)


def append_submission(payload: dict[str, Any]) -> dict[str, Any]:
    """Persist a submitted tip before any best-effort side effects such as e-mail.

    Google Sheets is used as the durable storage when configured. Local JSON is
    kept as a fast fallback/cache for free Render deployments, where disk is
    temporary and may disappear after restart or redeploy.
    """
    sheets: dict[str, Any]
    try:
        sheets = append_submission_to_google_sheets(payload)
    except Exception as exc:
        sheets = {"enabled": bool(GOOGLE_SHEETS_WEBAPP_URL and GOOGLE_SHEETS_SECRET), "saved": False, "reason": str(exc)}

    local: dict[str, Any]
    try:
        with _STORAGE_LOCK:
            submissions = read_submissions()
            submissions.append(payload)
            write_submissions(submissions)
            local = {
                "saved": True,
                "storedSubmissions": len(submissions),
                "storagePath": str(SUBMISSIONS_PATH),
            }
    except Exception as exc:
        local = {"saved": False, "reason": str(exc), "storagePath": str(SUBMISSIONS_PATH)}

    if not sheets.get("saved") and not local.get("saved"):
        raise RuntimeError(f"Google Sheets: {sheets.get('reason')}; lokální JSON: {local.get('reason')}")

    return {
        "saved": bool(sheets.get("saved") or local.get("saved")),
        "googleSheets": sheets,
        "local": local,
    }


def validate_submission(body: dict[str, Any]) -> tuple[dict[str, Any], list[str]]:
    errors: list[str] = []
    predictions = body.get("predictions") if isinstance(body.get("predictions"), dict) else {}
    bonuses = body.get("bonuses") if isinstance(body.get("bonuses"), dict) else {}
    payload = {
        "id": f"playoff-{int(time.time() * 1000)}-{os.urandom(4).hex()}",
        "submittedAt": datetime.now(timezone.utc).isoformat(),
        "name": clean(body.get("name")),
        "email": clean(body.get("email")),
        "betType": clean(body.get("betType")),
        "consent": bool(body.get("consent")),
        "predictions": {},
        "bonuses": {},
    }

    if not payload["name"]:
        errors.append("Vyplň jméno.")
    if not is_email(payload["email"]):
        errors.append("Vyplň platný e-mail.")
    if payload["betType"] not in {item["id"] for item in PLAYOFF_DATA["betTypes"]}:
        errors.append("Vyber typ hráče / sázky.")
    if not payload["consent"]:
        errors.append("Potvrď souhlas se zpracováním údajů pro soutěž.")

    validation_predictions = dict(predictions)
    for match in PLAYOFF_DATA["matches"]:
        match_id = str(match["id"])
        pred = predictions.get(match_id) if isinstance(predictions.get(match_id), dict) else {}
        clean_pred = {
            "homeGoals": clean(pred.get("homeGoals")),
            "awayGoals": clean(pred.get("awayGoals")),
            "winner": clean(pred.get("winner")),
        }
        for field, label in [("homeGoals", "góly prvního týmu"), ("awayGoals", "góly druhého týmu")]:
            try:
                val = int(clean_pred[field])
                if val < 0 or val > 20:
                    raise ValueError
                clean_pred[field] = val
            except Exception:
                errors.append(f"Zápas {match_id}: vyplň {label} jako celé číslo 0–20.")
        validation_predictions[match_id] = clean_pred
        allowed = entrants(match, validation_predictions)
        if clean_pred["winner"] not in allowed:
            errors.append(f"Zápas {match_id}: postupující musí být jedna z možností: {', '.join(allowed)}.")
        payload["predictions"][match_id] = clean_pred

    for field in PLAYOFF_DATA.get("bonusFields", []):
        field_id = str(field["id"])
        try:
            val = int(clean(bonuses.get(field_id)))
            if val < int(field.get("min", 0)) or val > int(field.get("max", 999)):
                raise ValueError
            payload["bonuses"][field_id] = val
        except Exception:
            errors.append(f"{field.get('label', field_id)}: vyplň celé číslo {field.get('min', 0)}–{field.get('max', 999)}.")
    return payload, errors




def normalize_person_key(value: Any) -> str:
    """Stable comparison key for player names in public-table deduplication."""
    text = unicodedata.normalize("NFKD", clean(value))
    text = text.encode("ascii", "ignore").decode("ascii").lower()
    return "".join(ch for ch in text if ch.isalnum())


def submission_identity_keys(item: dict[str, Any]) -> set[str]:
    """Return all keys that can identify the same human submission.

    This intentionally includes both email and displayed name, so old XLS seed
    rows such as ChatGPT can be hidden when the live Google Sheets row is shown
    as Dan Mališ.
    """
    keys: set[str] = set()
    email = clean(item.get("email")).lower()
    if email:
        keys.add(f"email:{email}")
    for name in (item.get("name"), display_name(item.get("name"))):
        name_key = normalize_person_key(name)
        if name_key:
            keys.add(f"name:{name_key}")
    return keys


def submission_primary_key(item: dict[str, Any]) -> str:
    email = clean(item.get("email")).lower()
    if email:
        return f"email:{email}"
    name_key = normalize_person_key(display_name(item.get("name")))
    if name_key:
        return f"name:{name_key}"
    return f"id:{clean(item.get('id'))}"


def submission_source_kind(item: dict[str, Any]) -> str:
    """Human-friendly source kind used for priority/dedup/admin output."""
    if item.get("isSeed") is True or clean(item.get("source")) in {"xls-import", "tipy-playoff-ms-2026.xlsx"}:
        return "seed"
    source = clean(item.get("source")).lower()
    if "sheet" in source:
        return "googleSheets"
    return "form"


def submission_source_priority(item: dict[str, Any]) -> int:
    """Public table priority: live/form/Sheets rows beat bundled XLS seed rows."""
    kind = submission_source_kind(item)
    if kind == "seed":
        return 10
    if kind == "googleSheets":
        return 30
    return 40


def _submitted_sort_value(item: dict[str, Any]) -> str:
    return clean(item.get("submittedAt"))


def latest_submissions_by_email(items: list[dict[str, Any]]) -> list[dict[str, Any]]:
    """Return deduplicated rows for public tables.

    Priority is explicit and conservative:
    1. live/local form rows,
    2. Google Sheets rows,
    3. XLS/seed fallback rows.

    Within the same source priority the newest submittedAt wins. Identity is
    matched by e-mail first and then by normalized displayed name. This keeps
    the public table clean when an XLS fallback row and a real form row exist
    for the same person.
    """
    candidates = [item for item in items if isinstance(item, dict)]
    candidates.sort(
        key=lambda item: (submission_source_priority(item), _submitted_sort_value(item), clean(item.get("id"))),
        reverse=True,
    )

    accepted: list[dict[str, Any]] = []
    used_keys: set[str] = set()
    for item in candidates:
        keys = submission_identity_keys(item) or {submission_primary_key(item)}
        if keys & used_keys:
            continue
        accepted.append(item)
        used_keys.update(keys)

    return sorted(accepted, key=lambda x: (display_name(x.get("name")).lower(), clean(x.get("submittedAt"))))


def public_submission(item: dict[str, Any]) -> dict[str, Any]:
    """Sanitized submission for the public web table.

    E-mail addresses stay only in the XLSX export and JSON storage, not in the
    public page.
    """
    return {
        "id": clean(item.get("id")),
        "submittedAt": clean(item.get("submittedAt")),
        "name": display_name(item.get("name")),
        "betType": clean(item.get("betType")),
        "source": clean(item.get("source")),
        "isSeed": bool(item.get("isSeed")),
        "predictions": item.get("predictions") if isinstance(item.get("predictions"), dict) else {},
        "bonuses": item.get("bonuses") if isinstance(item.get("bonuses"), dict) else {},
    }


def public_table_payload() -> dict[str, Any]:
    submissions = all_submissions()
    latest = latest_submissions_by_email(submissions)
    return {
        "ok": True,
        "generatedAt": datetime.now(timezone.utc).isoformat(),
        "totalSubmissions": len(submissions),
        "activeSubmissions": len(latest),
        "seedSubmissions": len(read_initial_submissions()),
        "storedSubmissions": len(read_submissions()),
        "submissions": [public_submission(item) for item in latest],
    }


def mask_email(value: Any) -> str:
    email = clean(value).lower()
    if "@" not in email:
        return ""
    local, domain = email.split("@", 1)
    if not local:
        return f"*@{domain}"
    shown = local[:2] if len(local) > 3 else local[:1]
    return f"{shown}{'*' * max(2, len(local) - len(shown))}@{domain}"


def duplicate_groups(items: list[dict[str, Any]]) -> list[dict[str, Any]]:
    groups: dict[str, list[dict[str, Any]]] = {}
    for item in items:
        if not isinstance(item, dict):
            continue
        email = clean(item.get("email")).lower()
        if email:
            key = f"email:{email}"
            label = mask_email(email)
        else:
            name_key = normalize_person_key(display_name(item.get("name")))
            if not name_key:
                continue
            key = f"name:{name_key}"
            label = display_name(item.get("name"))
        groups.setdefault(key, []).append(item)

    output: list[dict[str, Any]] = []
    for key, rows in groups.items():
        if len(rows) < 2:
            continue
        output.append({
            "key": key.split(":", 1)[0],
            "label": mask_email(rows[0].get("email")) or display_name(rows[0].get("name")),
            "count": len(rows),
            "names": sorted({display_name(row.get("name")) for row in rows if clean(row.get("name"))}),
            "sources": sorted({submission_source_kind(row) for row in rows}),
            "kept": display_name(latest_submissions_by_email(rows)[0].get("name")) if latest_submissions_by_email(rows) else "",
        })
    return sorted(output, key=lambda item: (-int(item.get("count", 0)), clean(item.get("label"))))


def admin_summary_payload() -> dict[str, Any]:
    seeded = read_initial_submissions()
    stored = read_submissions()
    sheets = read_google_sheets_submissions(force=True)
    merged = all_submissions()
    public_rows = latest_submissions_by_email(merged)

    counts_by_source = {"seed": 0, "googleSheets": 0, "form": 0}
    for item in merged:
        kind = submission_source_kind(item)
        counts_by_source[kind] = counts_by_source.get(kind, 0) + 1

    duplicates = duplicate_groups(merged)
    cfg = smtp_config()
    return {
        "ok": True,
        "generatedAt": datetime.now(timezone.utc).isoformat(),
        "counts": {
            "totalRaw": len(merged),
            "publicRows": len(public_rows),
            "seed": len(seeded),
            "stored": len(stored),
            "googleSheets": len(sheets),
            "bySource": counts_by_source,
        },
        "duplicates": {
            "count": len(duplicates),
            "hiddenRows": max(0, len(merged) - len(public_rows)),
            "groups": duplicates[:12],
        },
        "sourcePriority": [
            "form/live JSON",
            "Google Sheets",
            "XLS/seed fallback",
        ],
        "googleSheets": google_sheets_status(),
        "mail": {
            "enabled": bool(cfg.get("enabled")),
            "owner": cfg.get("owner"),
            "lastKnown": "SMTP je doplňkové; neúspěšný e-mail nemá blokovat uložený tip.",
        },
        "storage": {
            "dataDir": str(DATA_DIR),
            "requestedDataDir": REQUESTED_DATA_DIR,
            "dataDirWarning": DATA_DIR_WARNING,
            "submissionsPath": str(SUBMISSIONS_PATH),
        },
    }

def bet_label(bet_id: str) -> str:
    for item in PLAYOFF_DATA.get("betTypes", []):
        if item.get("id") == bet_id:
            return f"{item.get('label')} ({item.get('fee')} Kč)"
    return bet_id


def col_letter(index: int) -> str:
    letters = ""
    while index:
        index, remainder = divmod(index - 1, 26)
        letters = chr(65 + remainder) + letters
    return letters or "A"


def xml_escape(value: Any) -> str:
    return str(value if value is not None else "").replace("&", "&amp;").replace("<", "&lt;").replace(">", "&gt;").replace('"', "&quot;")


def worksheet_xml(rows: list[list[Any]]) -> str:
    xml_rows = []
    for r_idx, row in enumerate(rows, start=1):
        cells = []
        for c_idx, value in enumerate(row, start=1):
            ref = f"{col_letter(c_idx)}{r_idx}"
            if isinstance(value, (int, float)) and not isinstance(value, bool):
                cells.append(f'<c r="{ref}"><v>{value}</v></c>')
            else:
                cells.append(f'<c r="{ref}" t="inlineStr"><is><t>{xml_escape(value)}</t></is></c>')
        xml_rows.append(f'<row r="{r_idx}">{"".join(cells)}</row>')
    width = max((len(row) for row in rows), default=1)
    height = max(len(rows), 1)
    dimension = f"A1:{col_letter(width)}{height}"
    return f'''<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><dimension ref="{dimension}"/><sheetData>{''.join(xml_rows)}</sheetData></worksheet>'''


def export_rows(submissions: list[dict[str, Any]]) -> dict[str, list[list[Any]]]:
    summary_header = ["Čas odeslání", "Jméno", "E-mail", "Typ hráče"]
    for match in PLAYOFF_DATA["matches"]:
        summary_header.extend([f"{match['id']} skóre", f"{match['id']} vítěz"])
    for field in PLAYOFF_DATA.get("bonusFields", []):
        summary_header.append(field.get("label", field.get("id")))
    summary_rows = [summary_header]

    tip_rows = [["Čas odeslání", "Jméno", "E-mail", "Typ hráče", "Kolo", "Zápas", "Datum/čas", "Tým 1 / pozice", "Tým 2 / pozice", "Tip skóre", "Tip vítěz", "Možnosti vítěze"]]
    bonus_rows = [["Čas odeslání", "Jméno", "E-mail", "Typ hráče", *[field.get("label", field.get("id")) for field in PLAYOFF_DATA.get("bonusFields", [])]]]

    for submission in submissions:
        predictions = submission.get("predictions", {})
        player_name = display_name(submission.get("name"))
        summary = [submission.get("submittedAt"), player_name, submission.get("email"), bet_label(submission.get("betType", ""))]
        for match in PLAYOFF_DATA["matches"]:
            pred = predictions.get(match["id"], {})
            summary.extend([f"{pred.get('homeGoals', '')}:{pred.get('awayGoals', '')}", pred.get("winner", "")])
            tip_rows.append([
                submission.get("submittedAt"), player_name, submission.get("email"), bet_label(submission.get("betType", "")),
                match.get("round"), match.get("id"), match.get("dateTime"), match.get("home"), match.get("away"),
                f"{pred.get('homeGoals', '')}:{pred.get('awayGoals', '')}", pred.get("winner", ""), ", ".join(entrants(match, predictions)),
            ])
        for field in PLAYOFF_DATA.get("bonusFields", []):
            summary.append(submission.get("bonuses", {}).get(field.get("id"), ""))
        summary_rows.append(summary)
        bonus_rows.append([submission.get("submittedAt"), player_name, submission.get("email"), bet_label(submission.get("betType", "")), *[submission.get("bonuses", {}).get(field.get("id"), "") for field in PLAYOFF_DATA.get("bonusFields", [])]])

    scoring_rows = [["Pravidlo"], *[[rule] for rule in PLAYOFF_DATA.get("scoring", [])]]
    return {"Souhrn": summary_rows, "Tipy": tip_rows, "Bonusy": bonus_rows, "Bodování": scoring_rows}


def write_xlsx(path: Path, sheets: dict[str, list[list[Any]]]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    sheet_names = list(sheets.keys())
    with zipfile.ZipFile(path, "w", zipfile.ZIP_DEFLATED) as zf:
        content_types = [
            '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>',
            '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">',
            '<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>',
            '<Default Extension="xml" ContentType="application/xml"/>',
            '<Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>',
        ]
        for idx in range(1, len(sheet_names) + 1):
            content_types.append(f'<Override PartName="/xl/worksheets/sheet{idx}.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>')
        content_types.append('</Types>')
        zf.writestr('[Content_Types].xml', ''.join(content_types))
        zf.writestr('_rels/.rels', '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/></Relationships>')
        workbook = ['<?xml version="1.0" encoding="UTF-8" standalone="yes"?><workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets>']
        rels = ['<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">']
        for idx, name in enumerate(sheet_names, start=1):
            workbook.append(f'<sheet name="{xml_escape(name)}" sheetId="{idx}" r:id="rId{idx}"/>')
            rels.append(f'<Relationship Id="rId{idx}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet{idx}.xml"/>')
            zf.writestr(f'xl/worksheets/sheet{idx}.xml', worksheet_xml(sheets[name]))
        workbook.append('</sheets></workbook>')
        rels.append('</Relationships>')
        zf.writestr('xl/workbook.xml', ''.join(workbook))
        zf.writestr('xl/_rels/workbook.xml.rels', ''.join(rels))


def export_submissions() -> Path:
    submissions = all_submissions()
    write_xlsx(EXPORT_PATH, export_rows(submissions))
    return EXPORT_PATH


def smtp_config() -> dict[str, Any]:
    host = (os.environ.get("SMTP_HOST") or DEFAULT_SMTP_HOST).strip()
    port_raw = (os.environ.get("SMTP_PORT") or DEFAULT_SMTP_PORT).strip()
    try:
        port = int(port_raw)
        port_warning = ""
    except (TypeError, ValueError):
        port = int(DEFAULT_SMTP_PORT)
        port_warning = f"Neplatný SMTP_PORT={port_raw!r}; používám výchozí {DEFAULT_SMTP_PORT}."
    user = (os.environ.get("SMTP_USER") or OWNER_EMAIL).strip()
    password = os.environ.get("SMTP_PASS", "")
    secure_raw = (os.environ.get("SMTP_SECURE") or DEFAULT_SMTP_SECURE).strip().lower()
    secure = secure_raw in {"1", "true", "yes", "ssl", "tls"} or port == 465
    sender = (os.environ.get("MAIL_FROM") or user or OWNER_EMAIL).strip()
    # Na Render Free bývá SMTP často nedostupné nebo blokované. Proto je
    # automatický e-mail defaultně vypnutý; tipy se ukládají do JSON/Google Sheets
    # a XLSX jde stáhnout ručně přes export endpoint. Pro zapnutí nastav
    # PLAYOFF_EMAIL_ENABLED=true v Environment Variables.
    enabled_raw = (os.environ.get("PLAYOFF_EMAIL_ENABLED") or "false").strip().lower()
    enabled = enabled_raw in {"1", "true", "yes", "on"}
    return {
        "enabled": enabled,
        "enabledRaw": enabled_raw,
        "host": host,
        "port": port,
        "portRaw": port_raw,
        "portWarning": port_warning,
        "user": user,
        "password": password,
        "secure": secure,
        "sender": sender,
        "owner": OWNER_EMAIL,
    }


def send_export_mail(xlsx_path: Path, latest_submission: dict[str, Any]) -> dict[str, Any]:
    cfg = smtp_config()
    if not cfg.get("enabled"):
        return {
            "sent": False,
            "skipped": True,
            "reason": "Automatický e-mail je vypnutý. Tip je uložený; XLSX export lze stáhnout ručně.",
        }
    host = cfg["host"]
    port = cfg["port"]
    user = cfg["user"]
    password = cfg["password"]
    secure = cfg["secure"]
    sender = cfg["sender"]
    owner = cfg["owner"]
    if not host or not user or not password or not sender or not owner:
        missing = [name for name, value in [
            ("SMTP_HOST", host),
            ("SMTP_USER", user),
            ("SMTP_PASS", password),
            ("MAIL_FROM", sender),
            ("OWNER_EMAIL", owner),
        ] if not value]
        return {
            "sent": False,
            "reason": "Tip je uložený a je v tabulce, ale e-mail se neodeslal. Chybí: " + ", ".join(missing),
        }

    msg = EmailMessage()
    msg["From"] = sender
    msg["To"] = owner
    msg["Subject"] = f"Nový play-off tip MS 2026: {latest_submission.get('name', '')}"
    msg.set_content(
        "Byl odeslán nový play-off tip do soutěže TSMSF 2026.\n\n"
        f"Jméno: {latest_submission.get('name', '')}\n"
        f"E-mail: {latest_submission.get('email', '')}\n"
        f"Typ hráče: {bet_label(latest_submission.get('betType', ''))}\n\n"
        "V příloze je aktuální XLSX export všech odeslaných play-off tipů."
    )
    msg.add_attachment(xlsx_path.read_bytes(), maintype="application", subtype="vnd.openxmlformats-officedocument.spreadsheetml.sheet", filename="tipy-playoff-ms-2026.xlsx")
    try:
        if secure:
            with smtplib.SMTP_SSL(host, port, timeout=20) as smtp:
                smtp.login(user, password)
                smtp.send_message(msg)
        else:
            with smtplib.SMTP(host, port, timeout=20) as smtp:
                smtp.starttls()
                smtp.login(user, password)
                smtp.send_message(msg)
    except OSError as exc:
        if getattr(exc, "errno", None) == 101:
            return {
                "sent": False,
                "skipped": True,
                "reason": "SMTP síť není na hostingu dostupná. Tip je uložený; XLSX export lze stáhnout ručně.",
            }
        raise
    return {"sent": True}
