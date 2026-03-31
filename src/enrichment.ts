import { chromium } from 'playwright'
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

export async function findEmail(baseUrl: string): Promise<string | null> {
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
  return scrapeSite(baseUrl)
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

async function scrapeSite(baseUrl: string): Promise<string | null> {
  const origin = baseUrl.replace(/\/$/, '')
  const browser = await chromium.launch({ headless: true, args: ['--no-sandbox'] })

  try {
    const page = await browser.newPage()

    await page.goto(origin, { waitUntil: 'domcontentloaded', timeout: 15000 })

    // Etsi footer-alueelta ensin (tiheä sähköpostipaikka)
    const footerEmail = await page.evaluate(() => {
      const footer = document.querySelector('footer, #footer, .footer, .site-footer')
      if (!footer) return null
      const mailto = footer.querySelector('a[href^="mailto:"]')
      if (mailto) return mailto.getAttribute('href')?.replace('mailto:', '') ?? null
      return null
    })
    if (footerEmail) return footerEmail

    const homeHtml = await page.content()
    const homeEmail = extractEmail(homeHtml)
    if (homeEmail) return homeEmail

    for (const path of CONTACT_PATHS) {
      try {
        const res = await page.goto(origin + path, { waitUntil: 'domcontentloaded', timeout: 10000 })
        if (!res || res.status() >= 400) continue
        const html = await page.content()
        const found = extractEmail(html)
        if (found) return found
      } catch {
        continue
      }
    }

    return null
  } catch {
    return null
  } finally {
    await browser.close()
  }
}

const FAKE_EMAIL_RE = /noreply|no-reply|example|placeholder|esimerkki|test@test|foo@bar|lorem/i

function extractEmail(html: string): string | null {
  const mailtoMatch = html.match(/mailto:([a-zA-Z0-9._%+\-]+@[a-zA-Z0-9.\-]+\.[a-zA-Z]{2,})/)
  if (mailtoMatch && !FAKE_EMAIL_RE.test(mailtoMatch[1])) return mailtoMatch[1]

  const matches = html.match(EMAIL_RE) ?? []
  const filtered = matches.filter(
    (e) =>
      !FAKE_EMAIL_RE.test(e) &&
      !e.endsWith('.png') &&
      !e.endsWith('.jpg') &&
      !e.endsWith('.svg')
  )
  return filtered[0] ?? null
}
