import { chromium } from 'playwright'

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
  const origin = baseUrl.replace(/\/$/, '')
  const browser = await chromium.launch({ headless: true, args: ['--no-sandbox'] })

  try {
    const page = await browser.newPage()

    // Try homepage first
    await page.goto(origin, { waitUntil: 'domcontentloaded', timeout: 15000 })
    const homeHtml = await page.content()
    const homeEmail = extractEmail(homeHtml)
    if (homeEmail) return homeEmail

    // Try contact pages
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
  // Prefer mailto: links
  const mailtoMatch = html.match(/mailto:([a-zA-Z0-9._%+\-]+@[a-zA-Z0-9.\-]+\.[a-zA-Z]{2,})/)
  if (mailtoMatch) return mailtoMatch[1]

  // Fallback to any email in text, skip images/media/noreply
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
