# TSMSF 2026 - automatické výsledky

Webová verze tabulky `TSMSF_2026_DEN2_BODY_bile_jednotne_formatovani.xlsx`.

## Spuštění

Stačí Python 3.10+; nejsou potřeba žádné externí balíčky.

```bash
python app.py
```

Potom otevřete `http://localhost:8000`.

Port lze změnit proměnnou prostředí:

```bash
PORT=8080 python app.py
```

## Automatická aktualizace

- Při každém načtení stránky zavolá frontend `/api/scores`.
- Server stáhne zápasy z veřejného JSON rozhraní, které používá výsledková stránka ESPN pro soutěž `fifa.world`.
- Výsledky se na serveru ukládají do dvouminutové paměťové cache a v prohlížeči se kontrolují každých pět minut.
- Pokud zdroj není dostupný, použijí se dokončené výsledky uložené ve výchozím XLSX; stránka na to uživatele upozorní.

## Co se počítá

- body za přesný výsledek / rozdíl / správného vítěze,
- koeficient odvážnosti podle pravidel v tabulce,
- průběžné pořadí všech hráčů,
- samostatná stříbrná a zlatá liga,
- celkový počet branek a závěrečný bonus,
- pořadí ve všech 12 skupinách.

## Nasazení

Projekt lze spustit na libovolném VPS. Obsahuje také `Dockerfile`.

```bash
docker build -t tsmsf2026 .
docker run --rm -p 8000:8000 tsmsf2026
```
