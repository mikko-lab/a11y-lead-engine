import 'dotenv/config'
import { db } from './db/client'
import { enrichQueue } from './queue'
import { discoverFromDuckDuckGo, discoverFromTranco } from './discovery/index'

const INTERVAL_MS   = Number(process.env.SCHEDULER_INTERVAL_HOURS  ?? 6)  * 60 * 60 * 1000
const ENRICH_RETRY_HOURS = Number(process.env.ENRICH_RETRY_HOURS   ?? 24)
const DISCOVERY_LIMIT    = Number(process.env.SCHEDULER_DISCOVERY_LIMIT ?? 50)

// Vuorotellaan lähteitä joka sykli
const sources = ['duckduckgo', 'tranco'] as const
let sourceIndex = 0

async function runDiscovery() {
  const source = sources[sourceIndex % sources.length]
  sourceIndex++

  console.log(`[scheduler] Discovery: ${source} (limit ${DISCOVERY_LIMIT})`)
  try {
    const result = source === 'duckduckgo'
      ? await discoverFromDuckDuckGo({ limit: DISCOVERY_LIMIT, sendEmail: true })
      : await discoverFromTranco({ limit: DISCOVERY_LIMIT, sendEmail: true })
    console.log(`[scheduler] Discovery valmis: ${result.queued} jonoon / ${result.found} löydetty`)
  } catch (err) {
    console.error(`[scheduler] Discovery epäonnistui: ${(err as Error).message}`)
  }
}

async function retryEnriched() {
  const cutoff = new Date(Date.now() - ENRICH_RETRY_HOURS * 60 * 60 * 1000)

  const stale = await db.lead.findMany({
    where: {
      status: 'ENRICHED',
      email: null,             // ei emailia löytynyt viimeksi
      lastScannedAt: { lt: cutoff },
    },
    select: { id: true, domain: { select: { url: true } } },
    take: 20,
  })

  if (stale.length === 0) {
    console.log(`[scheduler] Ei vanhentuneita ENRICHED-leadeja`)
    return
  }

  console.log(`[scheduler] Enrich retry: ${stale.length} leadiä`)
  for (const lead of stale) {
    await enrichQueue.add('enrich-retry', {
      leadId: lead.id,
      url: lead.domain.url,
      sendEmail: true,
    }, {
      attempts: 2,
      backoff: { type: 'exponential', delay: 5000 },
    })
  }
}

async function tick() {
  const now = new Date().toLocaleTimeString('fi-FI')
  console.log(`\n[scheduler] Sykli käynnissä — ${now}`)
  await runDiscovery()
  await retryEnriched()
  console.log(`[scheduler] Seuraava sykli ${INTERVAL_MS / 3600000}h päästä`)
}

async function run() {
  console.log(`scheduler käynnissä (sykli ${INTERVAL_MS / 3600000}h, enrich retry ${ENRICH_RETRY_HOURS}h)`)
  await tick()
  setInterval(tick, INTERVAL_MS)
}

run()
