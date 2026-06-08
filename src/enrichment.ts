import { chromium, Browser } from 'playwright'
import { lookupKontakto, pickBestEmail } from './kontakto'

const EMAIL_RE = /[a-zA-Z0-9._%+\-]+@[a-zA-Z0-9.\-]+\.[a-zA-Z]{2,}/g

const CONTACT_PATHS = [
  '/yhteystiedot',
  '/ota-yhteytta',
  '/contact',
  '/yhteystieto',
  '/meista',
  '/about',
  '/tietoa-meista',
]

export async function findEmail(baseUrl: string, sharedBrowser?: Browser): Promise<string | null> {
  const domain = new URL(baseUrl).hostname.replace('www.', '')

  // 1–3. Aja rinnakkain: Kontakto, Hunter, WP REST
  const [kontaktoRes, hunterRes, wpRes] = await Promise.allSettled([
    lookupKontakto(baseUrl).then(k => k ? pickBestEmail(k) : null),
    process.env.HUNTER_API_KEY ? hunterLookup(domain) : Promise.resolve(null),
    wpRestEmail(baseUrl, domain),
  ])

  // Palauta ensimmäinen onnistunut tulos prioriteettijärjestyksessä
  for (const res of [kontaktoRes, hunterRes, wpRes]) {
    if (res.status === 'fulfilled' && res.value) return res.value
  }

  // 4. Sivuston scrape varalla
  return scrapeSite(baseUrl, sharedBrowser)
}

async function hunterLookup(domain: string): Promise<string | null> {
  try {
    const url = `https://api.hunter.io/v2/domain-search?domain=${domain}&api_key=${process.env.HUNTER_API_KEY}&limit=1`
    const res = await fetch(url)
    if (!res.ok) return null
    const json = await res.json() as any

    const emails: any[] = json?.data?.emails ?? []
    if (emails.length === 0) return null

    // Suosi generic osoitteita (info@, contact@, hello@) ennen henkilökohtaisia
    const generic = emails.find((e) =>
      /^(info|contact|hello|hei|asiakaspalvelu|myynti|sales|office)@/.test(e.value)
    )
    return generic?.value ?? emails[0]?.value ?? null
  } catch {
    return null
  }
}

// WordPress REST API: /wp-json/wp/v2/users paljastaa usein käyttäjänimet
// Rakennetaan siitä sähköpostiehdokkaita etunimi.sukunimi@domain.fi
async function wpRestEmail(baseUrl: string, domain: string): Promise<string | null> {
  try {
    const res = await fetch(`${baseUrl.replace(/\/$/, '')}/wp-json/wp/v2/users?per_page=5`, {
      signal: AbortSignal.timeout(6000),
      headers: { 'User-Agent': 'Mozilla/5.0' },
    })
    if (!res.ok) return null
    const users: any[] = await res.json()
    if (!Array.isArray(users) || users.length === 0) return null

    // Palauta vain oikea sähköposti — ei arvauksia nimistä
    for (const u of users) {
      if (u.email && !u.email.includes('example') && !u.email.includes('wordpress')) {
        return u.email
      }
    }
  } catch {}
  return null
}

async function scrapeSite(baseUrl: string, sharedBrowser?: Browser): Promise<string | null> {
  const origin = baseUrl.replace(/\/$/, '')
  const domain = new URL(baseUrl).hostname.replace(/^www\./, '')
  const ownBrowser = !sharedBrowser
  const browser = sharedBrowser ?? await chromium.launch({ headless: true, args: ['--no-sandbox'] })

  try {
    const page = await browser.newPage()

    await page.goto(origin, { waitUntil: 'domcontentloaded', timeout: 15000 })

    // Etsi footer-alueelta ensin — korkein luotettavuus, domain-skooraus mukana
    const footerEmails: string[] = await page.evaluate(() => {
      const footer = document.querySelector('footer, #footer, .footer, .site-footer')
      if (!footer) return []
      return [...footer.querySelectorAll('a[href^="mailto:"]')]
        .map((a) => (a as HTMLAnchorElement).href.replace(/^mailto:/i, '').split('?')[0].trim().toLowerCase())
    })
    const bestFooter = footerEmails
      .filter((e) => !FAKE_EMAIL_RE.test(e) && !ASSET_EXT_RE.test(e) && e.length <= 254)
      .sort((a, b) => emailScore(b, domain) - emailScore(a, domain))[0] ?? null
    if (bestFooter) return bestFooter

    const homeHtml = await page.content()
    const homeEmail = extractEmail(homeHtml, domain)
    if (homeEmail) return homeEmail

    for (const path of CONTACT_PATHS) {
      try {
        const res = await page.goto(origin + path, { waitUntil: 'domcontentloaded', timeout: 10000 })
        if (!res || res.status() >= 400) continue
        const html = await page.content()
        const found = extractEmail(html, domain)
        if (found) return found
      } catch {
        continue
      }
    }

    return null
  } catch {
    return null
  } finally {
    if (ownBrowser) await browser.close()
  }
}

const FAKE_EMAIL_RE = /noreply|no-reply|donotreply|do-not-reply|example|placeholder|esimerkki|test@test|foo@bar|lorem|@sentry\.|wordpress@/i
const ASSET_EXT_RE = /\.(png|jpe?g|gif|svg|webp|css|js|woff2?|ttf|eot|ico)$/i
const FREE_MAIL_RE = /@(gmail|hotmail|outlook|yahoo|icloud|live|protonmail|me)\./i
const ROLE_PREFIX_RE = /^(info|contact|hello|hei|myynti|asiakaspalvelu|sales|office|toimisto|yhteys|tuki|support)@/i

function deobfuscate(s: string): string {
  return s
    .replace(/\s*[\[(]\s*at\s*[\])]\s*/gi, '@')
    .replace(/\s*[\[(]\s*ät\s*[\])]\s*/gi, '@')
    .replace(/\s*[\[(]\s*(dot|piste)\s*[\])]\s*/gi, '.')
}

function emailScore(email: string, domain: string): number {
  const emailDomain = email.split('@')[1] ?? ''
  let pts = 0
  if (emailDomain === domain || emailDomain.endsWith('.' + domain)) pts += 10
  if (ROLE_PREFIX_RE.test(email)) pts += 3
  if (FREE_MAIL_RE.test(email)) pts -= 5
  return pts
}

function extractEmail(html: string, domain: string): string | null {
  const text = deobfuscate(html)

  const mailtos = [...text.matchAll(/mailto:([a-zA-Z0-9._%+\-]+@[a-zA-Z0-9.\-]+\.[a-zA-Z]{2,})/gi)]
    .map((m) => m[1].toLowerCase())
  const textMatches = (text.match(EMAIL_RE) ?? []).map((e) => e.toLowerCase())

  const seen = new Set<string>()
  const candidates = [...mailtos, ...textMatches].filter((e) => {
    if (seen.has(e)) return false
    seen.add(e)
    return !FAKE_EMAIL_RE.test(e) && !ASSET_EXT_RE.test(e) && e.length <= 254
  })

  if (candidates.length === 0) return null
  candidates.sort((a, b) => emailScore(b, domain) - emailScore(a, domain))
  return candidates[0]
}
