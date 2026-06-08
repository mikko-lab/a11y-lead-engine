# A11Y Lead Engine

Automaattinen saavutettavuusskanneri ja liidien hallintajärjestelmä WordPress-sivustoille. Skannaa sivustot WCAG 2.2 AA -standardin mukaan, generoi AI-yhteenvedon johdolle ja lähettää personoidun sähköpostin raporttilinkillä.

---

## Ominaisuudet

- **Pre-filter** — nopea esitarkistus ennen skannausta (kieli, CTA, WordPress-tunnistus, suurten toimijoiden blocklist)
- **WCAG 2.2 AA -skannaus** — axe-core + Playwright, pisteet 0–100
- **AI-yhteenveto** — Claude Haiku generoi selkokielisen tiivistelmän johtajalle suomeksi
- **Web-raportti** — asiakkaalle lähetettävä raporttisivu (`/r/:token`), ei PDF-liitettä
- **Sähköpostilähetys** — personoitu HTML-viesti, positiivinen sävy, GDPR-opt-out
- **Sähköpostin etsintä** — Kontakto.fi → Hunter.io → WP REST API → sivuston scrape (footer-first, domain-skooraus)
- **Sähköpostin validointi** — yksi totuuslähde (`email-validation.ts`): suodattaa roska-, placeholder- ja asset-osoitteet, vaatii API-lähteiltä saman brändin domainin, normalisoi viallisen muotoilun (esim. URL-koodattu etuliite)
- **Liidien siivous & kohdennus** — `clean:emails` validoi tallennetut osoitteet, `flag:bigorg` merkitsee isot organisaatiot / kirjaamot / kasinot optOut:iksi, `triage:emails` luokittelee rooli- vs henkilöosoitteet
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
KONTAKTO_API_KEY=...
BRAVE_SEARCH_API_KEY=...
```

---

## Käyttö

### Dashboard

```bash
# Dashboard (UI + API)
pnpm dashboard
```

Avaa selaimessa: `http://localhost:3000`

Worker-prosessit ajetaan tuotannossa pm2:lla (ks. `deploy.sh` → `pm2 restart all`). Kehityksessä käynnistä tarvittavat worker-skriptit erikseen:

```bash
pnpm worker:scan
pnpm worker:enrich
pnpm worker:ai
pnpm worker:action
pnpm worker:replies
```

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

### Sähköpostien hallinta

```bash
# Backfill: hae sähköpostit leadeille joilla email = null
pnpm enrich:emails                  # min-score 40 (gate), koko joukko
pnpm enrich:emails --limit=10       # savutesti oikeilla sivuilla ennen täyttä ajoa
pnpm enrich:emails --min-score=0    # myös alle 40 pisteen leadit
pnpm enrich:emails --concurrency=2  # kevyempi rinnakkaisuus

# Siivous & kohdennus — DRY-RUN oletuksena, --apply kirjoittaa
pnpm clean:emails                        # validoi tallennetut, näytä nollattavat/korjattavat
pnpm clean:emails -- --apply
pnpm clean:emails -- --keep-cross        # älä nollaa eri-brändin osoitteita
pnpm flag:bigorg                         # merkitse isot org / kirjaamot / kasinot optOut:iksi
pnpm flag:bigorg -- --apply
pnpm triage:emails                       # rooli vs henkilö, lajiteltu org-koon mukaan
```

---

## Arkkitehtuuri

```
src/
  dashboard.ts        — Express: dashboard-UI, API, /r/:token, /opt-out/:token
  queue.ts            — Redis/BullMQ-jonot (scan → enrich → ai → action) + job-tyypit
  worker.ts           — pipeline-worker (legacy monoliitti, ei aktiivinen pm2:ssa)
  scan.worker.ts      — BullMQ: skannausvaihe
  enrich.worker.ts    — BullMQ: sähköposti + YTJ + Kauppalehti + scoring → ketjuttaa ai-jonoon
  ai.worker.ts        — BullMQ: Claude Haiku -yhteenveto
  action.worker.ts    — BullMQ: lähetyspäätös + sähköpostin lähetys
  reply-monitor.ts    — seuraa saapuneita sähköpostivastauksia
  scheduler.ts        — lähetysikkunan ajastus (arkiaamu 8–10, Helsinki)
  browser-pool.ts     — jaettu Chromium, recycle 50 jobin välein
  scanner.ts          — axe-core + Playwright -skannaus
  prefilter.ts        — esitarkistus + suurten toimijoiden blocklist
  enrichment.ts       — sähköpostin etsintä (Kontakto + Hunter + WP REST + scrape), validoitu
  email-validation.ts — validoinnin totuuslähde: cleanContactEmail, brandOf/sameBrand, resolveContactEmail
  kontakto.ts         — Kontakto.fi B2B-kontaktihaku
  scoring-agent.ts    — Claude: liidin prioriteetti 0–10
  ai-summary.ts       — Claude Haiku -yhteenveto suomeksi
  mailer.ts           — HTML-sähköpostipohja (MD→HTML, opt-out-linkki)
  ytj.ts              — PRH open data (Y-tunnus, TOL)
  kauppalehti.ts      — liikevaihto ja henkilöstö
  monitor.ts          — HTML-muutosseuranta
  config.ts           — scoring gate -rajat, lähetysikkunan laskenta
  pdf.ts              — PDF-raportti (sisäinen käyttö)
  cli.ts              — komentorivi (scan, discover, monitor)
  enrich-emails.ts    — backfill: email=null-leadit (kursori, concurrency, --limit, --min-score)
  clean-emails.ts     — siivoa tallennetut osoitteet (dry-run, --apply, --keep-cross)
  flag-bigorg.ts      — merkitse isot org / kirjaamot / kasinot optOut:iksi (dry-run, --apply)
  triage-emails.ts    — luokittele rooli vs henkilö, lajittele org-koon mukaan
  discovery/
    index.ts            — orchestraattori, lähdeseuranta
    duckduckgo.ts       — WordPress-sivustojen haku
    tranco.ts           — Tranco .fi -domainlista
    yritykset.ts        — yritykset.fi -hakemistoscrape
    finlex.ts           — Finlex (FI oikeustapaukset)
    rechtspraak.ts      — Rechtspraak.nl API (NL oikeustapaukset)
    toegankelijkheid.ts — NL saavutettavuus-leadit
  court-ticket-agent.ts — Claude analysoi kanteet → myyntitiketti DB:hen
  kanteet.ts            — runner: FI + NL haku + analyysi + tallennus
  finlex-kanteet.ts     — FI-kanteiden runner
  rechtspraak-kanteet.ts — NL-kanteiden runner
  toegankelijkheid-leads.ts — NL-liidien runner
  db/client.ts          — Prisma-client
  utils/normalize-url.ts — URL-normalisointi
  __tests__/            — vitest (prefilter, scanner, extractEmail)
```

### Skannauksen kulku

1. **Pre-filter** — onko sivu elossa, kieli fi, löytyykö CTA, blocklist
2. **Skannaus** — axe-core / WCAG 2.2 AA Playwrightilla
3. **Sähköpostin haku + validointi** — Kontakto/Hunter/WP REST/scrape; kaikki ehdokkaat `cleanContactEmail`-gaten läpi, API-lähteiltä vaaditaan sama brändi-domain
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

Repon `deploy.sh` hoitaa synkan, riippuvuudet, DB-päivityksen ja uudelleenkäynnistyksen:

```bash
DEPLOY_SERVER=a11y@<IP> ./deploy.sh
```

Skripti ajaa:
1. `rsync` (poislukien `node_modules`, `.git`, `prisma/dev.db`, `.env`)
2. `pnpm install --frozen-lockfile && pnpm db:push`
3. `pm2 restart all`

> **Huom:** Jos `pnpm db:push` kysyy resetoinnista, vastaa N ja lisää puuttuvat kolumnit manuaalisesti `sqlite3`-komennolla.

---

## Julkiset reitit

- `/r/:token` — asiakkaalle lähetettävä raporttisivu (ei vaadi kirjautumista)
- `/opt-out/:token` — GDPR-poistumisilmoitus

---

## Tietoturva

> **Redis-porttia (6379) ei saa altistaa internettiin.** Vanha palvelin kompromissoitiin juuri tästä syystä: Redis oli auki ilman salasanaa.

### Pakolliset toimenpiteet ennen deployta

1. **Generoi Redis-salasana:** `openssl rand -hex 32` → `REDIS_PASSWORD` .env:ään
2. **Aseta dashboard-tunnukset:** `DASH_USER` ja vahva `DASH_PASS` .env:ään
3. **Käytä ei-root-käyttäjää:** palvelimella `a11y`-käyttäjä, ei `root`
4. **Redis kuuntelee vain localhostia:** `docker-compose.yml` on konfiguroitu `127.0.0.1:6379:6379`
5. **Dashboard kuuntelee vain localhostia:** `app.listen(PORT, '127.0.0.1')` — käytä SSH-tunnelia tai reverse-proxyä

### Tarkistuskomennot palvelimella

```bash
ss -tlnp | grep -E '6379|3030'   # molemmat pitää olla 127.0.0.1
curl -i http://localhost:3030/api/stats           # → 401
curl -i -u admin:salasana http://localhost:3030/api/stats  # → 200
```

## Lisenssi

MIT
