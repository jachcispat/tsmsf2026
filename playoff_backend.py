from __future__ import annotations

import json
import os
import smtplib
import time
import zipfile
from datetime import datetime, timezone
from email.message import EmailMessage
from pathlib import Path
from typing import Any

BASE_DIR = Path(__file__).resolve().parent
STATIC_DIR = BASE_DIR / "static"
PLAYOFF_DATA_PATH = STATIC_DIR / "playoff-data.json"
DATA_DIR = Path(os.environ.get("DATA_DIR", BASE_DIR / "data"))
SUBMISSIONS_PATH = DATA_DIR / "playoff_submissions.json"
EXPORT_PATH = DATA_DIR / "tipy-playoff-ms-2026.xlsx"
OWNER_EMAIL = os.environ.get("OWNER_EMAIL", "libormm@seznam.cz")
ADMIN_TOKEN = os.environ.get("ADMIN_TOKEN", "")

with PLAYOFF_DATA_PATH.open("r", encoding="utf-8") as fh:
    PLAYOFF_DATA = json.load(fh)


def match_by_id(match_id: str) -> dict[str, Any] | None:
    return next((match for match in PLAYOFF_DATA["matches"] if match.get("id") == match_id), None)


def clean(value: Any) -> str:
    return "" if value is None else str(value).strip()


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


def write_submissions(items: list[dict[str, Any]]) -> None:
    ensure_storage()
    SUBMISSIONS_PATH.write_text(json.dumps(items, ensure_ascii=False, indent=2), encoding="utf-8")


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
        summary = [submission.get("submittedAt"), submission.get("name"), submission.get("email"), bet_label(submission.get("betType", ""))]
        for match in PLAYOFF_DATA["matches"]:
            pred = predictions.get(match["id"], {})
            summary.extend([f"{pred.get('homeGoals', '')}:{pred.get('awayGoals', '')}", pred.get("winner", "")])
            tip_rows.append([
                submission.get("submittedAt"), submission.get("name"), submission.get("email"), bet_label(submission.get("betType", "")),
                match.get("round"), match.get("id"), match.get("dateTime"), match.get("home"), match.get("away"),
                f"{pred.get('homeGoals', '')}:{pred.get('awayGoals', '')}", pred.get("winner", ""), ", ".join(entrants(match, predictions)),
            ])
        for field in PLAYOFF_DATA.get("bonusFields", []):
            summary.append(submission.get("bonuses", {}).get(field.get("id"), ""))
        summary_rows.append(summary)
        bonus_rows.append([submission.get("submittedAt"), submission.get("name"), submission.get("email"), bet_label(submission.get("betType", "")), *[submission.get("bonuses", {}).get(field.get("id"), "") for field in PLAYOFF_DATA.get("bonusFields", [])]])

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
    submissions = read_submissions()
    write_xlsx(EXPORT_PATH, export_rows(submissions))
    return EXPORT_PATH


def send_export_mail(xlsx_path: Path, latest_submission: dict[str, Any]) -> dict[str, Any]:
    host = os.environ.get("SMTP_HOST")
    port = int(os.environ.get("SMTP_PORT", "587"))
    user = os.environ.get("SMTP_USER")
    password = os.environ.get("SMTP_PASS")
    secure = os.environ.get("SMTP_SECURE", "").lower() == "true" or port == 465
    sender = os.environ.get("MAIL_FROM") or user
    if not host or not user or not password or not sender or not OWNER_EMAIL:
        return {"sent": False, "reason": "SMTP_HOST, SMTP_USER, SMTP_PASS, MAIL_FROM nebo OWNER_EMAIL není nastavený."}

    msg = EmailMessage()
    msg["From"] = sender
    msg["To"] = OWNER_EMAIL
    msg["Subject"] = f"Nový play-off tip MS 2026: {latest_submission.get('name', '')}"
    msg.set_content(
        "Byl odeslán nový play-off tip do soutěže TSMSF 2026.\n\n"
        f"Jméno: {latest_submission.get('name', '')}\n"
        f"E-mail: {latest_submission.get('email', '')}\n"
        f"Typ hráče: {bet_label(latest_submission.get('betType', ''))}\n\n"
        "V příloze je aktuální XLSX export všech odeslaných play-off tipů."
    )
    msg.add_attachment(xlsx_path.read_bytes(), maintype="application", subtype="vnd.openxmlformats-officedocument.spreadsheetml.sheet", filename="tipy-playoff-ms-2026.xlsx")
    if secure:
        with smtplib.SMTP_SSL(host, port, timeout=20) as smtp:
            smtp.login(user, password)
            smtp.send_message(msg)
    else:
        with smtplib.SMTP(host, port, timeout=20) as smtp:
            smtp.starttls()
            smtp.login(user, password)
            smtp.send_message(msg)
    return {"sent": True}
