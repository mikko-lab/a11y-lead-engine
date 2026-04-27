# Tietoturva

## Palvelinkonfiguraatio

### Sallitut portit (UFW)
| Portti | Protokolla | Kuvaus |
|--------|-----------|--------|
| 22 | TCP | SSH |
| 443 | TCP | HTTPS (Caddy, kun otettu käyttöön) |

Kaikki muut portit suljettu. Redis (6379) ja dashboard (3030) kuuntelevat **ainoastaan 127.0.0.1**.

### Käyttäjät
- Sovellus pyörii `a11y`-käyttäjänä — **ei root**
- SSH root-kirjautuminen estetty (`PermitRootLogin no`)
- SSH-kirjautuminen vain avaimilla (`PasswordAuthentication no`)

### Prosessit
```
dashboard        — tsx src/dashboard.ts    (127.0.0.1:3030)
worker:scan      — tsx src/scan.worker.ts
worker:enrich    — tsx src/enrich.worker.ts
worker:ai        — tsx src/ai.worker.ts
worker:action    — tsx src/action.worker.ts
worker:replies   — tsx src/reply-monitor.ts
scheduler        — tsx src/scheduler.ts
redis            — Docker, 127.0.0.1:6379
```

---

## Ympäristömuuttujat

Katso `.env.example` mallina. Pakolliset ennen deployta:

| Muuttuja | Kuvaus |
|----------|--------|
| `REDIS_PASSWORD` | Generoi: `openssl rand -hex 32` |
| `DASH_USER` | Dashboard-käyttäjätunnus |
| `DASH_PASS` | Dashboard-salasana (vahva) |
| `ANTHROPIC_API_KEY` | Anthropic Console |
| `SMTP_PASS` | Sähköpostipalvelun salasana |

**Avainten lähteet:**
- Anthropic: console.anthropic.com → API Keys
- Hunter.io: hunter.io → API
- Brave Search: api.search.brave.com
- SMTP: sähköpostipalveluntarjoaja

---

## Dashboard-pääsy

Dashboard ei ole suoraan internetissä. Käytetään SSH-tunnelia:

```bash
ssh -L 3030:127.0.0.1:3030 a11y@204.168.214.102
# → http://localhost:3030
```

Tunnistautuminen: HTTP Basic Auth (`DASH_USER` / `DASH_PASS` .env:stä).

**Julkiset reitit (ei vaadi auth):**
- `/r/:token` — asiakkaalle lähetettävä raporttisivu
- `/opt-out/:token` — GDPR-poistumisilmoitus
- `/pixel/:token` — sähköpostin avausseuranta

---

## Deploy

```bash
# Palvelimelle kirjautuminen
ssh a11y@204.168.214.102

# Deploy
DEPLOY_SERVER=a11y@204.168.214.102 ./deploy.sh
```

**Älä koskaan:**
- Käytä `root@`-käyttäjää deployssa
- Lisää `.env`-tiedostoa git-historiaan
- Altista Redis-porttia (6379) internettiin
- Aja `pnpm db:push --accept-data-loss` ilman vahvistusta

---

## Tarkistuskomennot

```bash
# Portit — kaikki pitää olla 127.0.0.1
ss -tlnp | grep -E '3030|6379'

# Auth toimii
curl -i http://localhost:3030/api/stats                              # → 401
curl -i -u admin:SALASANA http://localhost:3030/api/stats            # → 200

# SSRF-suoja
curl -i -u admin:SALASANA -X POST http://localhost:3030/api/scan/manual \
  -H 'Content-Type: application/json' \
  -d '{"url":"http://169.254.169.254/"}' | head -1                  # → 400
curl -i -u admin:SALASANA -X POST http://localhost:3030/api/scan/manual \
  -H 'Content-Type: application/json' \
  -d '{"url":"http://7f000001.nip.io/"}' | head -1                  # → 400 (DNS rebinding)

# Redis vaatii salasanan
docker exec app-redis-1 redis-cli ping                               # → NOAUTH
docker exec app-redis-1 redis-cli -a "$REDIS_PASSWORD" ping          # → PONG

# Prosessin käyttäjä
ps -o user,cmd -p $(pgrep -f "node.*dashboard")                     # → a11y
```

---

## Incidenttihistoria

**Huhtikuu 2026 — Vanha palvelin kompromissoitu**

Juurisyy: Redis (6379) oli auki internettiin ilman salasanaa. Hyökkääjä kirjoitti Redis-konfiguraatioon cron-komennon joka latasi ja ajoi `/var/tmp/.x86`-binäärin (Monero-miner / IoT-botnet). Miner käytti `chattr +i` lukitsemaan järjestelmäbinäärit.

Toimenpiteet:
- Vanha palvelin wipetattu ja uudelleenasennettu (Ubuntu 24.04)
- Kaikki API-avaimet pyöritetty (Anthropic, Hunter, Brave, SMTP)
- SSH deploy-avain revoked GitHubista
- Hetzner abuse-tiketti vastattu
- Redis sidottu 127.0.0.1:een + pakollinen salasana
- Dashboard HTTP Basic Auth -suojattu
- SSRF-suoja vahvistettu (DNS rebinding -tarkistus)
