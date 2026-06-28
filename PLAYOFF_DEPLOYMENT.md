# Nasazení záložky Pavouk / Play-off na GitHub + Render

Tento balíček rozšiřuje původní web TSMSF 2026 o záložku **Pavouk (Play-off)** a novou záložku **Play-off tabulka**.
Původní skupinová část, přehled, pravidla, automatické výsledky a tabulky zůstávají zachované.

## Co je přidané

- nová záložka `🏆 Pavouk (Play-off)`,
- formulář s jménem, e-mailem a typem hráče,
- barevné rozlišení `NORMÁLNÍ / STŘÍBRNÝ / ZLATÝ HRÁČ`,
- 32 zápasů play-off,
- vlajky týmů převzaté ze stávajícího webu,
- automatické doplňování týmů do dalších kol podle tipů uživatele,
- zápas o 3. místo automaticky z poražených semifinalistů,
- uložení odeslaných tipů do JSON,
- export všech tipů do XLSX,
- automatické odeslání XLSX exportu na e-mail správce, pokud jsou nastavené SMTP údaje,
- nová záložka `📊 Play-off tabulka` vytvořená z odeslaných formulářů,
- veřejné pořadí a tabulka tipů bez zobrazení e-mailových adres,
- automatické přepočítání bodů podle skutečných výsledků play-off, jakmile je poskytovatel výsledků vrátí.

## Soubory, které nahraď na GitHubu

Nahraj / nahraď přesně tyto soubory a složky:

```text
app.py
playoff_backend.py
static/index.html
static/app.js
static/playoff.js
static/playoff.css
static/playoff-table.js
static/playoff-table.css
static/playoff-data.json
.env.example
README.md
PLAYOFF_DEPLOYMENT.md
docs/playoff-preview.png
```

Původní soubory `static/data.json`, `static/styles.css`, `static/logo.png`, `static/flags/*`, `Dockerfile`, `Procfile` a `tests/*` se nemění, jen zůstanou v repozitáři.

## Nejjednodušší postup na GitHubu

1. Stáhni ZIP z ChatGPT a rozbal ho.
2. Otevři svůj GitHub repozitář, ze kterého běží Render web `tsmsf2026.onrender.com`.
3. Nahraj výše uvedené soubory do stejných cest.
4. Udělej commit, například:

```bash
git add app.py playoff_backend.py static/index.html static/app.js static/playoff.js static/playoff.css static/playoff-table.js static/playoff-table.css static/playoff-data.json .env.example README.md PLAYOFF_DEPLOYMENT.md docs/playoff-preview.png
git commit -m "Add playoff prediction form"
git push
```

5. Render po pushi obvykle spustí nové nasazení automaticky.
6. Po nasazení otevři:

```text
https://tsmsf2026.onrender.com/#playoff
```

Tabulku z odeslaných formulářů otevři přes:

```text
https://tsmsf2026.onrender.com/#playoff-results
```

## Nastavení e-mailu na Renderu

V Render dashboardu otevři službu webu a nastav Environment Variables:

```text
OWNER_EMAIL=libormm@seznam.cz
SMTP_HOST=smtp.seznam.cz
SMTP_PORT=465
SMTP_SECURE=true
SMTP_USER=libormm@seznam.cz
SMTP_PASS=heslo-nastavit-pouze-v-renderu
MAIL_FROM=libormm@seznam.cz
```

Pro Seznam obvykle použij SMTP server a heslo/aplikační heslo podle nastavení účtu. Pokud SMTP_PASS nenastavíš, formulář bude tipy ukládat, play-off tabulka se aktualizuje a export XLSX půjde stáhnout ručně, ale e-mail se neodešle.

## Důležité pro ukládání dat na Renderu

Render může při redeployi zahodit lokální soubory, pokud není připojený persistent disk. Pro ostrý provoz doporučuji:

1. v Renderu přidat persistent disk,
2. mount path nastavit například na:

```text
/var/data
```

3. přidat Environment Variable:

```text
DATA_DIR=/var/data
```

Pak se `playoff_submissions.json` i `tipy-playoff-ms-2026.xlsx` ukládají na disk, který přežije redeploy.

## Export XLSX

Export se stáhne z:

```text
https://tsmsf2026.onrender.com/api/playoff-export
```

Pokud nastavíš `ADMIN_TOKEN`, export bude chráněný:

```text
https://tsmsf2026.onrender.com/api/playoff-export?token=TVUJ_TOKEN
```

## Kontrola po nasazení

Po nasazení zkontroluj:

1. záložka `Pavouk (Play-off)` se zobrazuje,
2. fungují vlajky,
3. po výběru vítěze v 1/16 finále se tým propíše do dalšího kola,
4. výběr vítěze v dalších kolech nabízí jen možné týmy,
5. formulář vyžaduje jméno a e-mail,
6. po odeslání vznikne export XLSX,
7. e-mail odejde pouze tehdy, když jsou správně nastavené SMTP proměnné,
8. záložka `Play-off tabulka` zobrazuje poslední odeslaný formulář každého hráče,
9. export XLSX stále obsahuje e-maily, veřejná tabulka je nezobrazuje.


## E-mail přes Seznam.cz

Podrobný postup je v `RENDER_EMAIL_SEZNAM.md`. Heslo nikdy nedávej do GitHubu, nastav ho jen na Renderu jako `SMTP_PASS`.


## Oprava 404 a předvyplněná play-off tabulka

V této verzi server vrací `index.html` i pro přímé adresy `/playoff` a `/playoff-results`.
Když se při otevření `/api/playoff-table` nebo `/api/playoff-submit` objeví 404, znamená to téměř vždy, že na GitHubu/Renderu stále běží starý `app.py`.

Soubor `static/playoff-initial-submissions.json` obsahuje předvyplněný tip importovaný z dodaného XLSX. Veřejná záložka „Play-off tabulka” ho načte i před prvním odeslaným formulářem.


## Oprava 502 / kontrola importu XLS

Po nahrání na Render zkontroluj tyto adresy:

```text
/api/health
/api/playoff-debug
/api/playoff-submissions-count
/api/playoff-table
```

`/api/playoff-debug` musí ukázat `seedCount: 1` a `seedNames: ["Libor"]`.
Import z XLS je kromě souboru `static/playoff-initial-submissions.json` také vestavěný v backendu, takže se zobrazí i po neúplném uploadu.
