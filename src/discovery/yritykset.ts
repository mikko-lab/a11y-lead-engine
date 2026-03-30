import { chromium } from 'playwright'

// Finder.fi kategoriat → hakusanat
const CATEGORY_KEYWORDS: Record<string, string> = {
  'terveys-ja-hyvinvointi':   'lääkäriasema hammaslääkäri fysioterapia',
  'kauneus-ja-kosmetiikka':   'parturi kampaamo kauneudenhoito',
  'ravintolat-ja-kahvilat':   'ravintola kahvila',
  'majoitus':                 'hotelli majoitus',
  'kiinteistot':              'kiinteistönvälitys isännöinti',
  'sosiaalipalvelut':         'hoitokoti päiväkoti sosiaalipalvelu',
  'taide-ja-viihde':          'taidegalleria teatteri viihde',
  'henkilokohtaiset-palvelut':'hieroja optikko apteekki',
  'rakentaminen':             'rakennusyritys remontti LVI',
  'tilitoimistot':            'tilitoimisto kirjanpito',
}

export const CATEGORIES = Object.keys(CATEGORY_KEYWORDS)

export async function scrapeYritykset(category: string, limit = 30): Promise<string[]> {
  const keywords = CATEGORY_KEYWORDS[category] ?? category.replace(/-/g, ' ')
  const browser = await chromium.launch({ headless: true, args: ['--no-sandbox'] })
  const urls: string[] = []

  try {
    const context = await browser.newContext({
      userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
      ignoreHTTPSErrors: true,
    })
    const page = await context.newPage()

    // Finder.fi haku
    const searchUrl = `https://www.finder.fi/search?what=${encodeURIComponent(keywords.split(' ')[0])}&where=`
    await page.goto(searchUrl, { waitUntil: 'networkidle', timeout: 25000 })
    await page.waitForTimeout(2000)

    // Kerää yritysprofiilien linkit
    const profileLinks = await page.evaluate(() => {
      const links: string[] = []
      document.querySelectorAll('a[href*="/yhteystiedot/"]').forEach(el => {
        const href = (el as HTMLAnchorElement).href
        if (href && !links.includes(href)) links.push(href)
      })
      return links
    })

    for (const profileLink of profileLinks.slice(0, limit * 2)) {
      if (urls.length >= limit) break
      try {
        await page.goto(profileLink, { waitUntil: 'networkidle', timeout: 15000 })
        await page.waitForTimeout(1000)

        const websiteUrl = await page.evaluate(() => {
          const links = Array.from(document.querySelectorAll('a[href^="http"]'))
          const external = links.find(el => {
            const href = (el as HTMLAnchorElement).href
            return !href.includes('finder.fi') && !href.includes('facebook') &&
                   !href.includes('instagram') && !href.includes('linkedin')
          })
          return external ? (external as HTMLAnchorElement).href : null
        })

        if (websiteUrl) {
          const hostname = new URL(websiteUrl).hostname
          if (!urls.some(u => u.includes(hostname))) {
            urls.push(websiteUrl)
          }
        }
      } catch {
        continue
      }
    }
  } finally {
    await browser.close()
  }

  return urls
}
