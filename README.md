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
- Při živém zápasu se data na serveru obnovují nejvýše po 15 sekundách a prohlížeč je kontroluje každých 30 sekund. Mimo živé zápasy se stránka kontroluje každé dvě minuty.
- Pokud zdroj není dostupný, použijí se dokončené výsledky uložené ve výchozím XLSX; stránka na to uživatele upozorní.

## Co se počítá

- průběžné živé skóre, stav/minutu zápasu a dočasný přepočet bodů,
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
