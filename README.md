# A11Y Lead Engine

Automaattinen saavutettavuusskanneri ja lead-generointimoottori WordPress-sivustoille. Skannaa sivustot WCAG 2.2 AA -standardin mukaan, generoi PDF-raportit ja lähettää personoidun sähköpostin löydetyille asiakkaille.

---

## Ominaisuudet

- **Pre-filter** — nopea fetch-pohjainen esitarkistus ennen raskasta skannausta (kieli, CTA, WordPress-tunnistus)
- **WCAG 2.2 AA -skannaus** — axe-core + Playwright, pisteet 0–100
- **PDF-raportti** — yksityiskohtainen raportti löydetyistä ongelmista ja korjausehdotuksista
- **Sähköpostilähetys** — personoitu viesti löydetylle kontaktille, raportti liitteenä
- **Sähköpostin etsintä** — Kontakto → Hunter.io → sivuston scrape
- **YTJ-integraatio** — hakee Y-tunnuksen ja TOL-toimialakoodin PRH:n avoimesta datasta
- **Toimialasuodatus** — kohdista ajo valituille TOL-toimialoille
- **Web-dashboard** — leadit, tilastot, manuaalinen sähköpostilähetys, uuden ajon käynnistys live-lokilla

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
DATABASE_URL=file:./dev.db

SMTP_HOST=smtp.example.com
SMTP_PORT=587
SMTP_USER=käyttäjä
SMTP_PASS=salasana
SMTP_FROM=nimi@example.com

SENDER_NAME=WP Saavutettavuus
SENDER_URL=https://wpsaavutettavuus.fi

HUNTER_API_KEY=        # valinnainen
KONTAKTO_API_KEY=      # valinnainen
```

---

## Käyttö

### Dashboard (suositeltava)

```bash
# Terminaali 1 — worker
pnpm dev

# Terminaali 2 — web-käyttöliittymä
pnpm dashboard
```

Avaa selaimessa: http://localhost:3030

Dashboardissa voit:
- Selata ja suodattaa leadeja
- Lähettää raportteja manuaalisesti
- Käynnistää uuden ajon valitsemalla hakemiston ja toimialan

### Komentorivi

```bash
# Yksittäinen skannaus
pnpm scan https://esimerkki.fi

# Skannaus + sähköpostilähetys
pnpm scan https://esimerkki.fi --email

# Skannaus + lähetys tiettyyn osoitteeseen
pnpm scan https://esimerkki.fi --to asiakas@esimerkki.fi

# Automaattinen haku + skannaus
pnpm discover --duckduckgo --limit 50 --email
pnpm discover --tranco --limit 200
pnpm discover --yritykset

# Tiedostosta
pnpm discover domains.txt --email

# Näytä viimeisimmät leadit
pnpm leads
```

---

## Arkkitehtuuri

```
src/
  cli.ts          — komentorivi-käyttöliittymä
  dashboard.ts    — Express-palvelin + web-UI
  worker.ts       — BullMQ-worker, käsittelee skannausjonon
  queue.ts        — Redis/BullMQ-jono
  scanner.ts      — axe-core + Playwright -skannaus
  prefilter.ts    — nopea fetch-pohjainen esitarkistus
  enrichment.ts   — sähköpostin etsintä (Kontakto → Hunter → scrape)
  ytj.ts          — PRH open data -integraatio
  kontakto.ts     — Kontakto B2B -integraatio
  mailer.ts       — sähköpostilähetys + HTML-pohja
  pdf.ts          — PDF-raportin generointi
  discovery/
    duckduckgo.ts — WordPress-sivustojen haku
    tranco.ts     — Tranco .fi -domainlista
    yritykset.ts  — yritykset.fi -hakemisto
```

### Skannauksen kulku

1. **Pre-filter** — onko sivu elossa, kieli fi/en/sv, löytyykö CTA/lomake
2. **Skannaus** — axe-core ajaa WCAG 2.2 AA -tarkistuksen
3. **Sähköpostin haku** — Kontakto → Hunter.io → sivuston scrape
4. **YTJ-haku** — yrityksen nimi, Y-tunnus ja TOL-toimialakoodi
5. **Tallennus** — Prisma/SQLite
6. **PDF-generointi** — jsPDF
7. **Sähköpostilähetys** — nodemailer SMTP

---

## Toimialasuodatus

Voit kohdistaa ajon halutuille TOL-toimialoille. YTJ tarkistetaan jokaisen domainin kohdalla — muut toimialat ohitetaan, tuntemattomia ei ohiteta.

Kohderyhmätoimialat oletuksena:
- 47 Vähittäiskauppa
- 55 Majoitustoiminta
- 56 Ravitsemistoiminta
- 68 Kiinteistöalan toiminta
- 85 Koulutus
- 86 Terveyspalvelut
- 88 Sosiaalihuolto

---

## Lisenssi

MIT
