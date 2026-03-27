import { chromium } from 'playwright'
import { addScanJob } from '../queue'
import { searchWordPressSites, WP_QUERIES } from './duckduckgo'
import { scrapeYritykset, CATEGORIES } from './yritykset'
import { getFiDomains } from './tranco'

export async function detectWordPress(url: string): Promise<boolean> {
  const browser = await chromium.launch({ headless: true, args: ['--no-sandbox'] })
  try {
    const page = await browser.newPage()
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 15000 })
    const html = await page.content()
    return (
      html.includes('wp-content') ||
      html.includes('wp-includes') ||
      html.includes('wp-json') ||
      html.includes('/wp-login')
    )
  } catch {
    return false
  } finally {
    await browser.close()
  }
}

export interface DiscoveryResult {
  found: number
  wordpress: number
  queued: number
}

export async function discoverFromDuckDuckGo(opts: {
  limit?: number
  sendEmail?: boolean
  onProgress?: (msg: string) => void
}): Promise<DiscoveryResult> {
  const { limit = 50, sendEmail = false, onProgress = console.log } = opts
  const perQuery = Math.ceil(limit / WP_QUERIES.length)
  const allUrls = new Set<string>()

  for (const query of WP_QUERIES) {
    onProgress(`  Haetaan: "${query}"`)
    const urls = await searchWordPressSites(query, perQuery)
    urls.forEach((u) => allUrls.add(u))
    if (allUrls.size >= limit) break
    await sleep(2000) // kohteliaisuusviive
  }

  return queueWordPressSites([...allUrls], { sendEmail, onProgress })
}

export async function discoverFromTranco(opts: {
  limit?: number
  sendEmail?: boolean
  onProgress?: (msg: string) => void
}): Promise<DiscoveryResult> {
  const { limit = 200, sendEmail = false, onProgress = console.log } = opts
  onProgress(`  Haetaan top-${limit} .fi-domainia Tranco-listasta...`)
  const urls = await getFiDomains(limit)
  onProgress(`  Löydettiin ${urls.length} .fi-domainia`)
  return queueWordPressSites(urls, { sendEmail, onProgress })
}

export async function discoverFromYritykset(opts: {
  categories?: string[]
  limitPerCategory?: number
  sendEmail?: boolean
  onProgress?: (msg: string) => void
}): Promise<DiscoveryResult> {
  const {
    categories = CATEGORIES.slice(0, 3),
    limitPerCategory = 20,
    sendEmail = false,
    onProgress = console.log,
  } = opts

  const allUrls = new Set<string>()

  for (const cat of categories) {
    onProgress(`  Toimiala: ${cat}`)
    const urls = await scrapeYritykset(cat, limitPerCategory)
    urls.forEach((u) => allUrls.add(u))
    await sleep(1500)
  }

  return queueWordPressSites([...allUrls], { sendEmail, onProgress })
}

async function queueWordPressSites(
  urls: string[],
  opts: { sendEmail: boolean; onProgress: (msg: string) => void }
): Promise<DiscoveryResult> {
  const { sendEmail, onProgress } = opts
  let wordpress = 0
  let queued = 0

  onProgress(`\n  Tarkistetaan ${urls.length} domainia WordPress-tunnistuksella...`)

  for (const url of urls) {
    try {
      const isWP = await detectWordPress(url)
      if (isWP) {
        wordpress++
        await addScanJob({ url, sendEmail })
        queued++
        onProgress(`  ✓ WordPress: ${url}`)
      } else {
        onProgress(`  – Ei WP:   ${url}`)
      }
    } catch {
      continue
    }
  }

  return { found: urls.length, wordpress, queued }
}

function sleep(ms: number) {
  return new Promise((r) => setTimeout(r, ms))
}
