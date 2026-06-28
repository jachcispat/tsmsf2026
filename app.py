from __future__ import annotations

import json
import mimetypes
import os
import threading
from concurrent.futures import ThreadPoolExecutor, as_completed
import time
import unicodedata
import urllib.error
import urllib.parse
import urllib.request
from datetime import datetime, timedelta, timezone
from http import HTTPStatus
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from typing import Any

import playoff_backend

BASE_DIR = Path(__file__).resolve().parent
STATIC_DIR = BASE_DIR / "static"
DATA_PATH = STATIC_DIR / "data.json"
PORT = int(os.environ.get("PORT", "8000"))
CACHE_TTL_SECONDS = int(os.environ.get("SCORES_CACHE_SECONDS", "60"))
LIVE_CACHE_TTL_SECONDS = int(os.environ.get("LIVE_SCORES_CACHE_SECONDS", "15"))
PLAYOFF_PATCH_VERSION = "playoff-submit-v5-google-sheets"

with DATA_PATH.open("r", encoding="utf-8") as fh:
    SITE_DATA = json.load(fh)

_cache_lock = threading.Lock()
_cache: dict[str, Any] = {"expires": 0.0, "payload": None}


def normalize_name(value: str) -> str:
    value = unicodedata.normalize("NFKD", value or "")
    value = value.encode("ascii", "ignore").decode("ascii").lower()
    return "".join(ch for ch in value if ch.isalnum())


TEAM_ALIAS_TO_CZECH: dict[str, str] = {}
for team in SITE_DATA["teams"]:
    for alias in team.get("aliases", []):
        TEAM_ALIAS_TO_CZECH[normalize_name(alias)] = team["name"]
    TEAM_ALIAS_TO_CZECH[normalize_name(team["englishName"])] = team["name"]
    TEAM_ALIAS_TO_CZECH[normalize_name(team["name"])] = team["name"]


def map_team(name: str) -> str | None:
    key = normalize_name(name)
    direct = TEAM_ALIAS_TO_CZECH.get(key)
    if direct:
        return direct
    # Conservative fuzzy fallback: unique containment only.
    candidates = {
        czech
        for alias, czech in TEAM_ALIAS_TO_CZECH.items()
        if len(alias) >= 5 and (alias in key or key in alias)
    }
    return next(iter(candidates)) if len(candidates) == 1 else None


def fetch_json(url: str) -> dict[str, Any]:
    request = urllib.request.Request(
        url,
        headers={
            "User-Agent": "TSMSF2026/1.0 (+https://tsmsf2026.cz)",
            "Accept": "application/json",
        },
    )
    with urllib.request.urlopen(request, timeout=20) as response:
        if response.status != 200:
            raise RuntimeError(f"HTTP {response.status} from score provider")
        return json.loads(response.read().decode("utf-8"))


def parse_espn_events(document: dict[str, Any]) -> list[dict[str, Any]]:
    parsed: list[dict[str, Any]] = []
    for event in document.get("events", []):
        competitions = event.get("competitions") or []
        if not competitions:
            continue
        competition = competitions[0]
        competitors = competition.get("competitors") or []
        home = next((c for c in competitors if c.get("homeAway") == "home"), None)
        away = next((c for c in competitors if c.get("homeAway") == "away"), None)
        if not home or not away:
            continue

        home_name = (home.get("team") or {}).get("displayName") or (home.get("team") or {}).get("shortDisplayName") or ""
        away_name = (away.get("team") or {}).get("displayName") or (away.get("team") or {}).get("shortDisplayName") or ""
        mapped_home = map_team(home_name)
        mapped_away = map_team(away_name)
        if not mapped_home or not mapped_away:
            continue

        status = event.get("status") or competition.get("status") or {}
        status_type = status.get("type") or {}
        state = status_type.get("state") or "pre"
        completed = bool(status_type.get("completed")) or state == "post"
        live = state == "in"

        def score_of(competitor: dict[str, Any]) -> int | None:
            raw = competitor.get("score")
            if isinstance(raw, dict):
                raw = raw.get("value") or raw.get("displayValue")
            try:
                return int(float(raw))
            except (TypeError, ValueError):
                return None

        status_text = (
            status_type.get("shortDetail")
            or status_type.get("detail")
            or status_type.get("description")
            or status.get("displayClock")
            or ""
        )
        display_clock = status.get("displayClock") or competition.get("status", {}).get("displayClock") or ""
        period = status.get("period") or competition.get("status", {}).get("period")

        home_score = score_of(home)
        away_score = score_of(away)
        winner_name = None
        if home.get("winner") is True:
            winner_name = mapped_home
        elif away.get("winner") is True:
            winner_name = mapped_away
        elif completed and isinstance(home_score, int) and isinstance(away_score, int) and home_score != away_score:
            winner_name = mapped_home if home_score > away_score else mapped_away

        parsed.append(
            {
                "providerId": str(event.get("id", "")),
                "date": event.get("date") or competition.get("date"),
                "home": mapped_home,
                "away": mapped_away,
                "homeScore": home_score,
                "awayScore": away_score,
                "winner": winner_name,
                "completed": completed,
                "live": live,
                "state": state,
                "status": status_text,
                "displayClock": display_clock,
                "period": period,
            }
        )
    return parsed


def fetch_espn_scores() -> list[dict[str, Any]]:
    base = "https://site.api.espn.com/apis/site/v2/sports/soccer/fifa.world/scoreboard"
    ranges = [
        "20260611-20260618",
        "20260619-20260624",
        "20260625-20260630",
        "20260701-20260705",
        "20260706-20260711",
        "20260712-20260719",
    ]
    # Samostatný dotaz pro dnešek zvyšuje šanci, že se živý stav a minuta
    # projeví okamžitě; rozsahové dotazy dál zajišťují kompletní turnaj.
    today = datetime.now(timezone.utc).strftime("%Y%m%d")
    query_dates = [today, *ranges]
    urls = [f"{base}?{urllib.parse.urlencode({'limit': 200, 'dates': date_range})}" for date_range in query_dates]
    events: dict[str, dict[str, Any]] = {}
    errors: list[str] = []
    with ThreadPoolExecutor(max_workers=4) as pool:
        futures = {pool.submit(fetch_json, url): url for url in urls}
        for future in as_completed(futures):
            try:
                document = future.result()
                for event in parse_espn_events(document):
                    key = event["providerId"] or f'{event["date"]}|{event["home"]}|{event["away"]}'
                    events[key] = event
            except Exception as exc:
                errors.append(str(exc))
    if not events:
        raise RuntimeError("Score provider returned no World Cup events" + (f" ({'; '.join(errors)})" if errors else ""))
    return list(events.values())


def embedded_results() -> list[dict[str, Any]]:
    results = []
    for match in SITE_DATA["matches"]:
        fallback = match["fallbackResult"]
        if fallback["completed"]:
            results.append(
                {
                    "providerId": f'embedded-{match["id"]}',
                    "date": match["kickoff"],
                    "home": match["home"],
                    "away": match["away"],
                    "homeScore": fallback["home"],
                    "awayScore": fallback["away"],
                    "winner": match["home"] if fallback["home"] > fallback["away"] else match["away"] if fallback["away"] > fallback["home"] else None,
                    "completed": True,
                    "live": False,
                    "state": "post",
                    "status": "Výsledek uložený ve výchozí tabulce",
                }
            )
    return results


def get_scores_payload(force: bool = False) -> dict[str, Any]:
    now = time.time()
    with _cache_lock:
        if not force and _cache["payload"] is not None and now < _cache["expires"]:
            return _cache["payload"]

    try:
        events = fetch_espn_scores()
        payload = {
            "ok": True,
            "source": "ESPN",
            "sourceUrl": "https://www.espn.com/soccer/scoreboard/_/league/fifa.world",
            "updatedAt": datetime.now(timezone.utc).isoformat(),
            "events": events,
            "warning": None,
        }
    except Exception as exc:  # fallback is deliberate: site must still load.
        payload = {
            "ok": False,
            "source": "embedded",
            "sourceUrl": None,
            "updatedAt": datetime.now(timezone.utc).isoformat(),
            "events": embedded_results(),
            "warning": f"Živý zdroj výsledků není dostupný: {exc}",
        }

    live_now = any(event.get("live") for event in payload.get("events", []))
    ttl = LIVE_CACHE_TTL_SECONDS if live_now else CACHE_TTL_SECONDS
    with _cache_lock:
        _cache["payload"] = payload
        _cache["expires"] = now + ttl
    return payload


class Handler(BaseHTTPRequestHandler):
    server_version = "TSMSF2026/1.0"

    def send_json(self, payload: dict[str, Any], status: int = 200) -> None:
        body = json.dumps(payload, ensure_ascii=False).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", "no-store")
        self.send_header("Access-Control-Allow-Origin", "*")
        self.end_headers()
        self.wfile.write(body)

    def send_file_response(self, path: Path, content_type: str, download_name: str | None = None) -> None:
        content = path.read_bytes()
        self.send_response(HTTPStatus.OK)
        self.send_header("Content-Type", content_type)
        self.send_header("Content-Length", str(len(content)))
        self.send_header("Cache-Control", "no-store")
        if download_name:
            self.send_header("Content-Disposition", f'attachment; filename="{download_name}"')
        self.end_headers()
        self.wfile.write(content)

    def do_OPTIONS(self) -> None:
        self.send_response(HTTPStatus.NO_CONTENT)
        self.send_header("Access-Control-Allow-Origin", "*")
        self.send_header("Access-Control-Allow-Methods", "GET, POST, OPTIONS")
        self.send_header("Access-Control-Allow-Headers", "Content-Type")
        self.end_headers()

    def do_POST(self) -> None:
        parsed = urllib.parse.urlparse(self.path)
        if parsed.path != "/api/playoff-submit":
            self.send_error(HTTPStatus.NOT_FOUND)
            return

        try:
            length = int(self.headers.get("Content-Length", "0"))
            body = json.loads(self.rfile.read(length).decode("utf-8") or "{}")
        except Exception:
            self.send_json({"ok": False, "errors": ["Neplatný JSON požadavek."]}, status=400)
            return

        try:
            payload, errors = playoff_backend.validate_submission(body if isinstance(body, dict) else {})
        except Exception as exc:
            self.send_json({
                "ok": False,
                "errors": [f"Backend spadl při validaci play-off tipu: {exc}"],
                "version": PLAYOFF_PATCH_VERSION,
            }, status=500)
            return

        if errors:
            self.send_json({"ok": False, "errors": errors, "version": PLAYOFF_PATCH_VERSION}, status=400)
            return

        try:
            storage = playoff_backend.append_submission(payload)
        except Exception as exc:
            self.send_json({
                "ok": False,
                "errors": [f"Validace proběhla, ale tip se nepodařilo uložit na serveru: {exc}"],
                "version": PLAYOFF_PATCH_VERSION,
            }, status=500)
            return

        export_info: dict[str, Any] = {"created": False}
        xlsx_path = None
        try:
            xlsx_path = playoff_backend.export_submissions()
            export_info = {"created": True, "path": str(xlsx_path)}
        except Exception as exc:
            # Export nesmí zrušit už uložený tip. Hráč se má zobrazit v tabulce i bez e-mailu/XLSX.
            export_info = {"created": False, "reason": str(exc)}

        if xlsx_path is not None:
            try:
                mail = playoff_backend.send_export_mail(xlsx_path, payload)
            except Exception as exc:
                mail = {"sent": False, "reason": str(exc)}
        else:
            mail = {"sent": False, "reason": "XLSX export se nepodařilo vytvořit; tip je ale uložený."}

        self.send_json({
            "ok": True,
            "id": payload["id"],
            "storage": storage,
            "export": export_info,
            "mail": mail,
            "version": PLAYOFF_PATCH_VERSION,
        })

    def do_GET(self) -> None:
        parsed = urllib.parse.urlparse(self.path)
        if parsed.path == "/api/playoff-submit":
            self.send_json({
                "ok": True,
                "endpoint": "/api/playoff-submit",
                "method": "POST",
                "message": "Endpoint existuje. Formulář sem musí posílat POST s JSON payloadem.",
                "version": PLAYOFF_PATCH_VERSION,
            })
            return
        if parsed.path == "/api/scores":
            force = urllib.parse.parse_qs(parsed.query).get("force") == ["1"]
            self.send_json(get_scores_payload(force=force))
            return
        if parsed.path == "/api/playoff-table":
            try:
                self.send_json(playoff_backend.public_table_payload())
            except Exception as exc:
                self.send_json({"ok": False, "error": f"Play-off tabulku se nepodařilo sestavit: {exc}"}, status=500)
            return
        if parsed.path == "/api/playoff-export":
            query = urllib.parse.parse_qs(parsed.query)
            if playoff_backend.ADMIN_TOKEN and query.get("token", [""])[0] != playoff_backend.ADMIN_TOKEN:
                self.send_json({"ok": False, "error": "Neplatný nebo chybějící ADMIN_TOKEN."}, status=403)
                return
            xlsx_path = playoff_backend.export_submissions()
            self.send_file_response(xlsx_path, "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet", "tipy-playoff-ms-2026.xlsx")
            return
        if parsed.path == "/api/playoff-submissions-count":
            items = playoff_backend.all_submissions()
            stored = playoff_backend.read_submissions()
            sheets = playoff_backend.read_google_sheets_submissions(force=True)
            seeded = playoff_backend.read_initial_submissions()
            self.send_json({
                "ok": True,
                "count": len(items),
                "storedCount": len(stored),
                "googleSheetsCount": len(sheets),
                "googleSheets": playoff_backend.google_sheets_status(),
                "seedCount": len(seeded),
                "seedNames": [item.get("name") for item in seeded],
                "storagePath": str(playoff_backend.SUBMISSIONS_PATH),
                "requestedDataDir": playoff_backend.REQUESTED_DATA_DIR,
                "dataDirWarning": playoff_backend.DATA_DIR_WARNING,
                "initialSubmissionsPath": str(playoff_backend.INITIAL_SUBMISSIONS_PATH),
            })
            return
        if parsed.path == "/api/playoff-debug":
            cfg = playoff_backend.smtp_config()
            seeded = playoff_backend.read_initial_submissions()
            stored = playoff_backend.read_submissions()
            sheets = playoff_backend.read_google_sheets_submissions(force=True)
            public_error = ""
            try:
                public_count = len(playoff_backend.public_table_payload().get("submissions", []))
            except Exception as exc:
                public_count = 0
                public_error = str(exc)
            self.send_json({
                "ok": True,
                "version": PLAYOFF_PATCH_VERSION,
                "staticDir": str(STATIC_DIR),
                "dataDir": str(playoff_backend.DATA_DIR),
                "requestedDataDir": playoff_backend.REQUESTED_DATA_DIR,
                "dataDirWarning": playoff_backend.DATA_DIR_WARNING,
                "initialSubmissionsPath": str(playoff_backend.INITIAL_SUBMISSIONS_PATH),
                "initialSubmissionsFileExists": playoff_backend.INITIAL_SUBMISSIONS_PATH.exists(),
                "seedCount": len(seeded),
                "seedNames": [item.get("name") for item in seeded],
                "storedCount": len(stored),
                "googleSheetsCount": len(sheets),
                "googleSheets": playoff_backend.google_sheets_status(),
                "publicCount": public_count,
                "publicError": public_error,
                "mail": {"owner": cfg["owner"], "host": cfg["host"], "port": cfg["port"], "portRaw": cfg.get("portRaw", str(cfg["port"])), "portWarning": cfg.get("portWarning", ""), "secure": cfg["secure"], "userSet": bool(cfg["user"]), "passwordSet": bool(cfg["password"]), "sender": cfg["sender"]},
            })
            return
        if parsed.path == "/api/playoff-mail-config":
            cfg = playoff_backend.smtp_config()
            self.send_json({"ok": True, "owner": cfg["owner"], "host": cfg["host"], "port": cfg["port"], "portRaw": cfg.get("portRaw", str(cfg["port"])), "portWarning": cfg.get("portWarning", ""), "secure": cfg["secure"], "userSet": bool(cfg["user"]), "passwordSet": bool(cfg["password"]), "sender": cfg["sender"]})
            return
        if parsed.path == "/api/health":
            self.send_json({
                "ok": True,
                "service": "tsmsf2026",
                "version": PLAYOFF_PATCH_VERSION,
                "time": datetime.now(timezone.utc).isoformat(),
                "dataDir": str(playoff_backend.DATA_DIR),
                "requestedDataDir": playoff_backend.REQUESTED_DATA_DIR,
                "dataDirWarning": playoff_backend.DATA_DIR_WARNING,
                "submissionsPath": str(playoff_backend.SUBMISSIONS_PATH),
                "googleSheets": playoff_backend.google_sheets_status(),
            })
            return

        # Clean SPA-like routes such as /playoff and /playoff-results should
        # serve index.html. Without this, direct opening those URLs returns 404
        # even though the client-side tab exists.
        clean_routes = {"overview", "matches", "groups", "rules", "playoff", "playoff-results"}
        requested = parsed.path.strip("/") or "index.html"
        if requested in clean_routes:
            requested = "index.html"
        safe = Path(requested)
        if any(part in {"..", ""} for part in safe.parts):
            self.send_error(HTTPStatus.BAD_REQUEST)
            return
        file_path = (STATIC_DIR / safe).resolve()
        if STATIC_DIR.resolve() not in file_path.parents and file_path != STATIC_DIR.resolve():
            self.send_error(HTTPStatus.FORBIDDEN)
            return
        if not file_path.is_file():
            self.send_error(HTTPStatus.NOT_FOUND)
            return

        content = file_path.read_bytes()
        content_type, _ = mimetypes.guess_type(file_path.name)
        self.send_response(HTTPStatus.OK)
        self.send_header("Content-Type", (content_type or "application/octet-stream") + ("; charset=utf-8" if content_type and content_type.startswith("text/") else ""))
        self.send_header("Content-Length", str(len(content)))
        self.send_header("Cache-Control", "no-cache" if file_path.name in {"index.html", "app.js", "data.json", "playoff.js", "playoff.css", "playoff-data.json", "playoff-table.js", "playoff-table.css"} else "public, max-age=86400")
        self.end_headers()
        self.wfile.write(content)

    def log_message(self, fmt: str, *args: Any) -> None:
        print(f"[{self.log_date_time_string()}] {fmt % args}")


if __name__ == "__main__":
    print(f"TSMSF 2026 běží na http://0.0.0.0:{PORT}")
    ThreadingHTTPServer(("0.0.0.0", PORT), Handler).serve_forever()
