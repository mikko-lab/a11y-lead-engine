# A11Y Lead Engine

Automaattinen saavutettavuusskanneri ja liidien hallintajärjestelmä WordPress-sivustoille. Skannaa sivustot WCAG 2.2 AA -standardin mukaan, generoi AI-yhteenvedon johdolle ja lähettää personoidun sähköpostin raporttilinkillä.

---

## Ominaisuudet

- **Pre-filter** — nopea esitarkistus ennen skannausta (kieli, CTA, WordPress-tunnistus, suurten toimijoiden blocklist)
- **WCAG 2.2 AA -skannaus** — axe-core + Playwright, pisteet 0–100
- **AI-yhteenveto** — Claude Haiku generoi selkokielisen tiivistelmän johtajalle suomeksi
- **Web-raportti** — asiakkaalle lähetettävä raporttisivu (`/r/:token`), ei PDF-liitettä
- **Sähköpostilähetys** — personoitu HTML-viesti, positiivinen sävy, GDPR-opt-out
- **Sähköpostin etsintä** — Hunter.io → WP REST API → sivuston scrape (footer-first)
- **YTJ-integraatio** — yrityksen nimi, Y-tunnus ja TOL-toimialakoodi
- **Kauppalehti-integraatio** — liikevaihto ja henkilöstömäärä
- **Toimialasuodatus** — kohdista ajo valituille TOL-toimialoille
- **Lähdeseuranta** — tallentaa mistä hausta kukin liidi löytyi
- **Lead-numero** — juokseva #-numero helpottaa asiakkaaseen viittaamista
- **GDPR opt-out** — asiakas voi kieltäytyä lisäviesteistä (`/opt-out/:token`)
- **Muutosseuranta** — seuraa domainien HTML-muutoksia
- **Web-dashboard** — leadit, tilastot, uuden ajon käynnistys, live-loki
- **Sähköpostin manuaalinen hallinta** — lisää tai muokkaa asiakkaan sähköpostiosoite suoraan dashboardissa ilman lähetystä
- **Finlex-skräpperi** — hakee saavutettavuuteen liittyvät oikeustapaukset Suomesta (Finlex)
- **Rechtspraak-integraatio** — hakee WCAG/toegankelijkheid-tapaukset Hollannin tuomioistuimista (virallinen avoin API)
- **Court Ticket -agentti** — Claude analysoi oikeustapaukset automaattisesti ja luo myyntitiketit: organisaatio, prioriteetti 0–10, ehdotettu yhteydenottokulma
- **Kanteet-dashboard** — ⚖️ erillinen välilehti oikeuskanteille, status-seuranta (Uusi → Kontaktoitu → Konvertoitu)

---

## Pikastartti

### Vaatimukset

- Node.js 20+
- pnpm
- Redis

### Asennus

```bash
pnpm install
pnpm exec playwright install chromium
cp .env.example .env   # täytä ympäristömuuttujat
pnpm db:push
```

### Ympäristömuuttujat

```env
DATABASE_URL="file:/opt/a11y/prisma/dev.db"
REDIS_URL="redis://localhost:6379"

SMTP_HOST=smtp.esimerkki.fi
SMTP_PORT=587
SMTP_USER=user@esimerkki.fi
SMTP_PASS=salasana
SMTP_FROM="Nimi <user@esimerkki.fi>"

SENDER_NAME=WP Saavutettavuus
SENDER_URL=https://app.wpsaavutettavuus.fi

ANTHROPIC_API_KEY=sk-ant-...
HUNTER_API_KEY=...
BRAVE_SEARCH_API_KEY=...
```

---

## Käyttö

### Dashboard (suositeltava)

```bash
# Terminaali 1 — worker
pnpm worker

# Terminaali 2 — dashboard
pnpm dev
```

Avaa selaimessa: `http://localhost:3000`

| Välilehti | Kuvaus |
|---|---|
| **Leadit** | Kaikki liidit, pisteet, yritystiedot, lähde, sähköpostin lisäys/muokkaus, manuaalinen lähetys |
| **Uusi ajo** | Valitse lähde, toimialasuodatus, käynnistä live-lokilla |
| **Seuranta** | HTML-muutosseuranta, automaattinen uudelleenskannaus |
| **⚖️ Kanteet** | Oikeustapaukset FI + NL, AI-analyysi, prioriteetti, yhteydenottokulma, status-seuranta |

### Komentorivi

```bash
pnpm scan https://esimerkki.fi          # yksittäinen skannaus
pnpm scan https://esimerkki.fi --email  # skannaus + sähköposti

# Oikeuskanteet (FI + NL)
pnpm kanteet              # hae molemmat maat + luo AI-tiketit
pnpm kanteet --fi         # vain Suomi (Finlex)
pnpm kanteet --nl         # vain Hollanti (Rechtspraak)
pnpm kanteet --sisalto    # hae myös tapausten koko teksti (parempi analyysi)
```

---

## Arkkitehtuuri

```
src/
  dashboard.ts    — Express-palvelin, dashboard-UI, API, /r/:token, /opt-out/:token
  worker.ts       — BullMQ-worker: skannaus, rikastus, AI-yhteenveto, lähetys
  queue.ts        — Redis/BullMQ-jono ja ScanJobData-tyyppi
  scanner.ts      — axe-core + Playwright -skannaus
  prefilter.ts    — nopea esitarkistus + suurten toimijoiden blocklist
  enrichment.ts   — sähköpostin etsintä (Hunter → WP REST API → scrape)
  ai-summary.ts   — Claude Haiku -yhteenveto suomeksi
  mailer.ts       — HTML-sähköpostipohja (MD→HTML, opt-out-linkki)
  ytj.ts          — PRH open data (Y-tunnus, TOL)
  kauppalehti.ts  — liikevaihto ja henkilöstö
  monitor.ts      — HTML-muutosseuranta
  pdf.ts          — PDF-raportti (sisäinen käyttö)
  discovery/
    index.ts        — orchestraattori, lähdeseuranta
    duckduckgo.ts   — WordPress-sivustojen haku
    tranco.ts       — Tranco .fi -domainlista
    yritykset.ts    — yritykset.fi -hakemistoscrape
    finlex.ts       — Finlex-skräpperi (FI oikeustapaukset)
    rechtspraak.ts  — Rechtspraak.nl API (NL oikeustapaukset)
  court-ticket-agent.ts — Claude analysoi kanteet → tiketti DB:hen
  kanteet.ts        — runner: FI + NL haku + analyysi + tallennus
```

### Skannauksen kulku

1. **Pre-filter** — onko sivu elossa, kieli fi, löytyykö CTA, blocklist
2. **Skannaus** — axe-core / WCAG 2.2 AA Playwrightilla
3. **Sähköpostin haku** — Hunter → WP REST API → scrape
4. **YTJ + Kauppalehti** — yritystiedot ja taloustiedot
5. **Tallennus** — Prisma/SQLite (Domain, Scan, Lead)
6. **AI-yhteenveto** — Claude Haiku, max 3 kohtaa suomeksi
7. **Sähköpostilähetys** — linkki `/r/:token` -raporttisivulle

---

## Toimialasuodatus (YTJ)

| TOL | Toimiala |
|---|---|
| 47 | Vähittäiskauppa |
| 55 | Majoitustoiminta |
| 56 | Ravitsemistoiminta |
| 68 | Kiinteistöalan toiminta |
| 85 | Koulutus |
| 86 | Terveyspalvelut |
| 88 | Sosiaalihuolto |
| 90 | Taiteet ja viihde |
| 96 | Muut henkilökohtaiset palvelut |

---

## Deploy (palvelimelle)

Lokaalisti:
```bash
cd /path/to/a11y-lead-engine
tar -czf a11y.tar.gz --exclude=node_modules --exclude=.git --exclude=reports src prisma package.json pnpm-lock.yaml && scp a11y.tar.gz root@<IP>:/opt/a11y/
```

Palvelimella:
```bash
cd /opt/a11y && tar -xzf a11y.tar.gz && chown -R root:root prisma/ && pnpm install && pnpm db:push --accept-data-loss && pm2 restart all --update-env
```

> **Huom:** Jos `pnpm db:push` kysyy resetoinnista, vastaa N ja lisää puuttuvat kolumnit manuaalisesti `sqlite3`-komennolla.

---

## Julkiset reitit

- `/r/:token` — asiakkaalle lähetettävä raporttisivu (ei vaadi kirjautumista)
- `/opt-out/:token` — GDPR-poistumisilmoitus

## Lisenssi

MIT
