# Sdílení energie – Bobnická

Měsíční report sdílení elektřiny pro dva bytové domy (vchod A a B).
Data se automaticky stahují z portálu EDC každý 12. den v měsíci,
generuje se HTML report dostupný online přes GitHub Pages.

## Online report

Po publikaci přes GitHub Pages: `https://basapetr-source.github.io/sdileni-bobnicka-report/`

## Co to dělá

Každý 12. den v měsíci se na GitHub Actions automaticky spustí pipeline:

1. Přihlášení na portál EDC s uloženými přihlašovacími údaji
2. Pro každou ze dvou skupin sdílení (Vchod A a Vchod B) se stáhne export
   IN/OUT dat za předchozí kalendářní měsíc
3. Vygeneruje se `report.html` se dvěma jasně oddělenými sekcemi
4. Výstup se commitne do repa a publikuje přes GitHub Pages

## Lokální spuštění

```bash
npm install

# 1) Jednorázově – zjistit SSE ID skupin pro tento účet (vypíše JSON)
npm run discover

# Z výstupu zkopíruj SSE ID obou skupin do .env (SSE_ID_A, SSE_ID_B).

# 2) Spustit celý měsíční pipeline (přihlášení → export → report)
npm run monthly

# 3) Otevřít report v prohlížeči (jen regeneruje HTML z dat v exports/)
npm run report
```

## Konfigurace

`.env` (lokálně) nebo GitHub Secrets (CI):

| Klíč | Význam |
|------|--------|
| `EDC_USERNAME` | Přihlašovací jméno na portál EDC |
| `EDC_PASSWORD` | Heslo |
| `SSE_ID_A` | Číselné ID skupiny sdílení pro Vchod A |
| `SSE_ID_B` | Číselné ID skupiny sdílení pro Vchod B |

## Soubory

```
Sdileni_Bobnicka/
├── exports/                       Stažené CSV exporty z EDC
│   └── Export-{A|B}-{YYYY}-{MM}-inout.csv
├── lib/
│   ├── edc-api.js                 EDC Keycloak OIDC + export endpoints
│   └── parse-data.js              Načítání XLSX (názvy bytů) a CSV
├── docs/index.html                Publikovaná verze reportu (GitHub Pages)
├── Názvy elektroměrů dle EAN.xlsx Mapování EAN → název bytu (vstup)
├── discover-sse.js                Najde SSE ID dostupných skupin
├── run-monthly.js                 Celý měsíční pipeline
├── generate-report.js             Vygeneruje report.html z dat v exports/
└── .github/workflows/monthly-update.yml  Spouštěč 12. dne v měsíci
```

## Co se v reportu zobrazuje

Report obsahuje pro každou skupinu sdílení (Vchod A a B) samostatně:

- Souhrnné karty (výroba, nasdíleno, efektivita; spotřeba, přijato, pokrytí)
- Tabulku výrobny – výroba/nasdíleno/přebytek po měsících
- Tabulku odběrných míst – spotřeba/přijato/ze sítě po měsících (společná
  spotřeba domu + jednotlivé byty)

Měsíce lze filtrovat (Vše / rok / měsíc).

## Pozn. k rozdílům oproti projektu Sdileni_energie

- Stahuje se jen IN/OUT export (žádný PAIR/alokační export).
- Žádné nahrávání alokačních klíčů zpět na EDC.
- Žádný výpočet optimalizace.
- Žádné automatické odesílání e-mailu.
