# TSMSF 2026 - automatické výsledky + Pavouk / Play-off

Webová verze soutěže TSMSF 2026. Původní část zobrazuje výsledky základních skupin a průběžné pořadí. Nově je přidaná záložka **Pavouk (Play-off)** s formulářem pro vyplnění tipů.

## Spuštění lokálně

Stačí Python 3.10+; nejsou potřeba žádné externí balíčky.

```bash
python app.py
```

Potom otevři:

```text
http://localhost:8000
```

Play-off formulář otevřeš přímo přes:

```text
http://localhost:8000/#playoff
```

## Co umí play-off formulář

- jméno + e-mail soutěžícího,
- typ hráče: normální / stříbrný / zlatý,
- 32 zápasů play-off,
- automatické doplňování týmů do dalších kol podle tipů,
- výběr vítěze pouze z možných týmů pro daný zápas,
- bonusové otázky,
- ukládání odeslaných tipů do JSON,
- export všech tipů do XLSX,
- automatické odeslání XLSX exportu na e-mail správce při správném SMTP nastavení.

## Export XLSX

```text
/api/playoff-export
```

Při nastaveném `ADMIN_TOKEN`:

```text
/api/playoff-export?token=TVUJ_TOKEN
```

## Environment variables

Viz `.env.example`.

Nejdůležitější proměnné:

```text
DATA_DIR=/var/data
OWNER_EMAIL=libormm@seznam.cz
SMTP_HOST=...
SMTP_PORT=587
SMTP_SECURE=false
SMTP_USER=...
SMTP_PASS=...
MAIL_FROM=...
ADMIN_TOKEN=...
```

## Render

Pro ostrý provoz doporučuji v Renderu přidat persistent disk a nastavit:

```text
DATA_DIR=/var/data
```

Jinak se data mohou při redeployi ztratit.

Podrobný postup je v `PLAYOFF_DEPLOYMENT.md`.
