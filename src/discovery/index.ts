import { addScanJob } from '../queue'
import { searchWordPressSites, WP_QUERIES } from './duckduckgo'
import { scrapeYritykset, CATEGORIES } from './yritykset'
import { getFiDomains } from './tranco'
import { preFilter } from '../prefilter'
import { lookupYTJ } from '../ytj'

export { CATEGORIES }

export interface DiscoveryResult {
  found: number
  wordpress: number
  queued: number
}

export interface DiscoveryOpts {
  limit?: number
  sendEmail?: boolean
  tolFilter?: string[]
  onProgress?: (msg: string) => void
}

export async function discoverFromDuckDuckGo(opts: DiscoveryOpts): Promise<DiscoveryResult> {
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

  return queueWordPressSites([...allUrls], { sendEmail, tolFilter: opts.tolFilter, onProgress })
}

export async function discoverFromTranco(opts: DiscoveryOpts): Promise<DiscoveryResult> {
  const { limit = 200, sendEmail = false, onProgress = console.log } = opts
  onProgress(`  Haetaan top-${limit} .fi-domainia Tranco-listasta...`)
  const urls = await getFiDomains(limit)
  onProgress(`  Löydettiin ${urls.length} .fi-domainia`)
  return queueWordPressSites(urls, { sendEmail, tolFilter: opts.tolFilter, onProgress })
}

export async function discoverFromYritykset(opts: DiscoveryOpts & {
  categories?: string[]
  limitPerCategory?: number
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

  return queueWordPressSites([...allUrls], { sendEmail, tolFilter: opts.tolFilter, onProgress })
}

async function queueWordPressSites(
  urls: string[],
  opts: { sendEmail: boolean; tolFilter?: string[]; onProgress: (msg: string) => void }
): Promise<DiscoveryResult> {
  const { sendEmail, tolFilter, onProgress } = opts
  let wordpress = 0
  let queued = 0

  onProgress(`\n  Tarkistetaan ${urls.length} domainia (pre-filter)...`)

  for (const url of urls) {
    try {
      const filter = await preFilter(url)
      if (!filter.pass) {
        onProgress(`  – Hylätty (${filter.reason}): ${url}`)
        continue
      }

      // TOL-suodatus: jos toimialasuodatus on päällä, tarkista YTJ
      if (tolFilter && tolFilter.length > 0) {
        const hostname = new URL(url.startsWith('http') ? url : `https://${url}`).hostname
        const ytj = await lookupYTJ(hostname)
        if (ytj && !tolFilter.includes(ytj.tol)) {
          onProgress(`  – TOL ${ytj.tol} (${ytj.tolName}) ei kuulu kohderyhmään: ${url}`)
          continue
        }
        if (ytj) onProgress(`  ✓ TOL ${ytj.tol} ${ytj.tolName}: ${url}`)
      }

      if (filter.isWP) wordpress++
      await addScanJob({ url, sendEmail })
      queued++
      onProgress(`  ✓ Jonoon: ${url}`)
    } catch {
      continue
    }
  }

  return { found: urls.length, wordpress, queued }
}

function sleep(ms: number) {
  return new Promise((r) => setTimeout(r, ms))
}
