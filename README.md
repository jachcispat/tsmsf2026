# TSMSF 2026 - automatické výsledky + Pavouk / Play-off

Webová verze soutěže TSMSF 2026. Původní část zobrazuje výsledky základních skupin a průběžné pořadí. Nově jsou přidané záložky **Pavouk (Play-off)** s formulářem pro vyplnění tipů a **Play-off tabulka** s přehledem odeslaných formulářů.

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

Play-off tabulku otevřeš přes:

```text
http://localhost:8000/#playoff-results
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

## Co umí play-off tabulka

- bere poslední odeslaný formulář od každého e-mailu,
- zobrazuje pořadí hráčů,
- zobrazuje podobnou řádkovou tabulku jako základní část: kolo, čas, týmy, výsledek, skutečný vítěz, body a tipy hráčů,
- dopočítává body za správně určeného postupujícího / medailistu / vítěze, jakmile jsou dostupné skutečné výsledky play-off,
- ukazuje bonusové tipy,
- e-maily nezobrazuje veřejně; jsou jen v uloženém JSONu a XLSX exportu.

## Export XLSX

```text
/api/playoff-export
```

Veřejná data pro play-off tabulku:

```text
/api/playoff-table
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
