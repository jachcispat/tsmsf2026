# Nastavení e-mailu na Renderu pro Seznam.cz

Tahle verze webu má výchozí nastavení pro adresu `libormm@seznam.cz` a SMTP server Seznamu.

Důležité: heslo nepatří do GitHubu. Nastav ho pouze v Renderu v **Environment** jako hodnotu `SMTP_PASS`.

## Environment Variables na Renderu

Nastav nebo zkontroluj tyto proměnné:

```text
OWNER_EMAIL=libormm@seznam.cz
SMTP_HOST=smtp.seznam.cz
SMTP_PORT=465
SMTP_SECURE=true
SMTP_USER=libormm@seznam.cz
SMTP_PASS=SEM_VLOZ_HESLO_V_RENDERU
MAIL_FROM=libormm@seznam.cz
DATA_DIR=/var/data
```

## Kontrolní adresy

Po deployi otevři:

```text
https://tsmsf2026.onrender.com/api/playoff-mail-config
```

Musí tam být `passwordSet: true`.

Po odeslání testovacího tipu zkontroluj tabulku:

```text
https://tsmsf2026.onrender.com/#playoff-results
```

A počet uložených formulářů:

```text
https://tsmsf2026.onrender.com/api/playoff-submissions-count
```

## Co se změnilo v kódu

- Tip se vždy nejdřív uloží do JSONu.
- Až potom se vytváří XLSX a zkouší odeslání e-mailu.
- Pokud e-mail selže, formulář se i tak uloží a zobrazí v play-off tabulce.
- Chybějící SMTP údaje už nezabrání uložení tipu.
