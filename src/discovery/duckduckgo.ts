import { chromium } from 'playwright'

export async function searchWordPressSites(query: string, limit = 20): Promise<string[]> {
  const browser = await chromium.launch({ headless: true, args: ['--no-sandbox'] })
  const results: string[] = []

  try {
    const context = await browser.newContext({
      userAgent:
        'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
      locale: 'fi-FI',
    })
    const page = await context.newPage()

    // Bing on huomattavasti sallivampi kuin DuckDuckGo
    const searchUrl = `https://www.bing.com/search?q=${encodeURIComponent(query)}&setlang=fi&cc=FI&count=50`
    await page.goto(searchUrl, { waitUntil: 'domcontentloaded', timeout: 20000 })
    await page.waitForTimeout(1500)

    const links = await page.evaluate(() => {
      const found: string[] = []
      // Bing hakutulosten linkit ovat h2 > a tai .b_algo a
      document.querySelectorAll('h2 a[href^="http"], .b_algo a[href^="http"]').forEach((el) => {
        const href = (el as HTMLAnchorElement).href
        if (!href.includes('bing.com') && !href.includes('microsoft.com')) {
          found.push(href)
        }
      })
      return [...new Set(found)]
    })

    for (const link of links) {
      if (results.length >= limit) break
      try {
        const url = new URL(link)
        const clean = `${url.protocol}//${url.hostname}`
        if (!results.includes(clean)) results.push(clean)
      } catch {
        continue
      }
    }
  } finally {
    await browser.close()
  }

  return results
}

export const WP_QUERIES = [
  'wp-content site:.fi tilitoimisto',
  'wp-content site:.fi markkinointitoimisto',
  'wp-content site:.fi hammaslääkäri',
  'wp-content site:.fi fysioterapia',
  'wp-content site:.fi lakitoimisto',
  'wp-content site:.fi rakennusyritys',
  'wp-content site:.fi autokorjaamo',
  'wp-content site:.fi parturi kampaamo',
  'wp-content site:.fi kiinteistövälittäjä',
  'wp-content site:.fi siivouspalvelu',
]
