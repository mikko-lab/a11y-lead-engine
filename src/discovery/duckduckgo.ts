import { chromium } from 'playwright'

export async function searchWordPressSites(query: string, limit = 20): Promise<string[]> {
  const browser = await chromium.launch({ headless: true, args: ['--no-sandbox'] })
  const results: string[] = []

  try {
    const page = await browser.newPage()
    await page.setExtraHTTPHeaders({ 'Accept-Language': 'fi-FI,fi;q=0.9' })

    const searchUrl = `https://html.duckduckgo.com/html/?q=${encodeURIComponent(query)}`
    await page.goto(searchUrl, { waitUntil: 'domcontentloaded', timeout: 20000 })

    const links = await page.$$eval('a.result__url', (els) =>
      els.map((el) => el.textContent?.trim()).filter(Boolean) as string[]
    )

    for (const link of links) {
      if (results.length >= limit) break
      try {
        const url = link.startsWith('http') ? link : `https://${link}`
        new URL(url)
        if (!results.includes(url)) results.push(url)
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
  'wp-content site:.fi toimisto',
  'wp-content site:.fi yritys',
  'wp-content site:.fi palvelut',
  'wp-content site:.fi tilitoimisto',
  'wp-content site:.fi lakiasiaintoimisto',
  'wp-content site:.fi markkinointi',
  'wp-content site:.fi rakennusyritys',
  'wp-content site:.fi hammaslääkäri',
  'wp-content site:.fi fysioterapia',
  'wp-content site:.fi autokorjaamo',
]
