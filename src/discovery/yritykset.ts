import { chromium } from 'playwright'

// Toimialat yritykset.fi -sivustolta
const CATEGORIES = [
  'rakentaminen',
  'terveys-ja-hyvinvointi',
  'kuljetus-ja-logistiikka',
  'ravintolat-ja-kahvilat',
  'kauneus-ja-kosmetiikka',
  'markkinointi-ja-mainonta',
  'tilitoimistot',
  'lakipalvelut',
  'it-palvelut',
  'siivouspalvelut',
]

export async function scrapeYritykset(category: string, limit = 30): Promise<string[]> {
  const browser = await chromium.launch({ headless: true, args: ['--no-sandbox'] })
  const urls: string[] = []

  try {
    const page = await browser.newPage()
    const baseUrl = `https://www.yritykset.fi/toimialat/${category}/`
    await page.goto(baseUrl, { waitUntil: 'domcontentloaded', timeout: 20000 })

    // Kerää yritysten profiilinlinkit
    const profileLinks = await page.$$eval('a[href*="/yritys/"]', (els) =>
      [...new Set(els.map((el) => (el as HTMLAnchorElement).href))]
    )

    for (const profileLink of profileLinks.slice(0, limit)) {
      if (urls.length >= limit) break
      try {
        await page.goto(profileLink, { waitUntil: 'domcontentloaded', timeout: 15000 })

        // Etsi yrityksen verkkosivulinkki profiilisivulta
        const websiteUrl = await page.$eval(
          'a[href^="http"]:not([href*="yritykset.fi"])',
          (el) => (el as HTMLAnchorElement).href
        ).catch(() => null)

        if (websiteUrl) {
          const hostname = new URL(websiteUrl).hostname
          if (!urls.some((u) => u.includes(hostname))) {
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

export { CATEGORIES }
