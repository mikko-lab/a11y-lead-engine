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

  // 1. Kontakto (suomalaiset päätöksentekijät)
  const kontakto = await lookupKontakto(baseUrl)
  if (kontakto) {
    const email = pickBestEmail(kontakto)
    if (email) return email
  }

  // 2. Hunter.io
  if (process.env.HUNTER_API_KEY) {
    const email = await hunterLookup(domain)
    if (email) return email
  }

  // 3. Sivuston scrape varalla
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

async function scrapeSite(baseUrl: string): Promise<string | null> {
  const origin = baseUrl.replace(/\/$/, '')
  const browser = await chromium.launch({ headless: true, args: ['--no-sandbox'] })

  try {
    const page = await browser.newPage()

    await page.goto(origin, { waitUntil: 'domcontentloaded', timeout: 15000 })
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

function extractEmail(html: string): string | null {
  const mailtoMatch = html.match(/mailto:([a-zA-Z0-9._%+\-]+@[a-zA-Z0-9.\-]+\.[a-zA-Z]{2,})/)
  if (mailtoMatch) return mailtoMatch[1]

  const matches = html.match(EMAIL_RE) ?? []
  const filtered = matches.filter(
    (e) =>
      !e.includes('noreply') &&
      !e.includes('example') &&
      !e.endsWith('.png') &&
      !e.endsWith('.jpg') &&
      !e.endsWith('.svg')
  )
  return filtered[0] ?? null
}
