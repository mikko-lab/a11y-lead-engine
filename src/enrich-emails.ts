import 'dotenv/config'
import { chromium } from 'playwright'
import { db } from './db/client'
import { findEmail } from './enrichment'
import { SCORE_MIN } from './config'

/**
 * Backfill: hae sähköpostit leadeille joilla email = null.
 *
 *   pnpm enrich:emails                    # min-score 40, concurrency 4, koko joukko
 *   pnpm enrich:emails --min-score=0      # myös alle 40 pisteen leadit
 *   pnpm enrich:emails --limit=10         # savutesti: 10 leadiä oikeilla sivuilla
 *   pnpm enrich:emails --concurrency=2    # kevyemmin
 *
 * Muutokset vanhaan:
 *  - ei `take: 200` -cappia → käy koko joukon läpi kursorilla (batch 100)
 *  - yksi jaettu Chromium koko ajolle (ei selainta per lead)
 *  - rinnakkaisuus (oletus 4) sekventiaalisen sijaan
 *  - min-score ajonaikaisena lippuna (gate-päätös sinun, ei kovakoodattu)
 */

function numArg(name: string, def: number): number {
  const m = process.argv.find((a) => a.startsWith(`--${name}=`))
  return m ? Number(m.split('=')[1]) : def
}

const MIN_SCORE = numArg('min-score', SCORE_MIN)
const CONCURRENCY = numArg('concurrency', 4)
const LIMIT = numArg('limit', 0) // 0 = ei rajaa
const BATCH = 100

type LeadRow = { id: string; domainId: string; domain: { url: string } }

async function processLead(lead: LeadRow, browser: import('playwright').Browser) {
  const url = lead.domain.url
  try {
    const email = await findEmail(url, browser)
    if (email) {
      await db.lead.update({ where: { id: lead.id }, data: { email } })
      await db.domain.update({ where: { id: lead.domainId }, data: { email } })
      return { url, email }
    }
    return { url, email: null as string | null }
  } catch (e: any) {
    return { url, email: null as string | null, error: e?.message ?? String(e) }
  }
}

// Yksinkertainen rinnakkaisuusallas: pitää CONCURRENCY-määrän tehtäviä käynnissä
async function runPool<T, R>(items: T[], worker: (t: T) => Promise<R>, concurrency: number): Promise<R[]> {
  const results: R[] = new Array(items.length)
  let i = 0
  async function next(): Promise<void> {
    while (i < items.length) {
      const idx = i++
      results[idx] = await worker(items[idx])
    }
  }
  await Promise.all(Array.from({ length: Math.min(concurrency, items.length) }, next))
  return results
}

async function main() {
  console.log(`Backfill: min-score ${MIN_SCORE}, concurrency ${CONCURRENCY}${LIMIT ? `, limit ${LIMIT}` : ''}\n`)

  const browser = await chromium.launch({
    headless: true,
    args: ['--no-sandbox', '--disable-setuid-sandbox'],
  })

  let cursor: string | undefined
  let total = 0
  let found = 0

  try {
    while (true) {
      const batch = (await db.lead.findMany({
        where: { email: null, scan: { score: { gte: MIN_SCORE } } },
        include: { domain: true },
        orderBy: { id: 'asc' },
        take: BATCH,
        ...(cursor ? { cursor: { id: cursor }, skip: 1 } : {}),
      })) as unknown as LeadRow[]

      if (batch.length === 0) break
      cursor = batch[batch.length - 1].id

      const slice = LIMIT > 0 ? batch.slice(0, Math.max(0, LIMIT - total)) : batch
      const res = await runPool(slice, (l) => processLead(l, browser), CONCURRENCY)

      for (const r of res) {
        total++
        if (r.email) {
          found++
          console.log(`  ✓ ${r.url} → ${r.email}`)
        } else {
          console.log(`  · ${r.url} → ${(r as any).error ? 'virhe: ' + (r as any).error : 'ei löydy'}`)
        }
      }

      if (LIMIT > 0 && total >= LIMIT) break
    }
  } finally {
    await browser.close().catch(() => {})
    await db.$disconnect()
  }

  console.log(`\nValmis. ${found}/${total} sähköpostia löydetty.`)
  process.exit(0)
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})
