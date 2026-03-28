import crypto from 'crypto'
import { db } from './db/client'
import { addScanJob } from './queue'

const CHANGE_THRESHOLD = 20  // % muutos joka laukaisee uuden skannauksen
const FETCH_TIMEOUT_MS = 8000

// Poistaa HTML-tagit ja dynaamisen sisällön (timestamp, nonce, token)
function extractText(html: string): string {
  return html
    .replace(/<script[\s\S]*?<\/script>/gi, '')
    .replace(/<style[\s\S]*?<\/style>/gi, '')
    .replace(/<!--[\s\S]*?-->/g, '')
    .replace(/<[^>]+>/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
}

function hashContent(text: string): string {
  return crypto.createHash('sha256').update(text).digest('hex')
}

function changePercent(oldLen: number, newLen: number): number {
  if (oldLen === 0) return 100
  return Math.round(Math.abs(newLen - oldLen) / oldLen * 100)
}

export interface MonitorResult {
  url: string
  status: 'changed' | 'unchanged' | 'new' | 'error'
  changePercent?: number
  queued?: boolean
}

export async function checkDomain(
  domainId: string,
  url: string,
  opts: { sendEmail?: boolean; onProgress?: (msg: string) => void } = {}
): Promise<MonitorResult> {
  const { sendEmail = false, onProgress = () => {} } = opts

  let html: string
  try {
    const res = await fetch(url, {
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
      headers: { 'User-Agent': 'Mozilla/5.0 (compatible; a11y-monitor/1.0)' },
      redirect: 'follow',
    })
    if (!res.ok) throw new Error(`HTTP ${res.status}`)
    html = await res.text()
  } catch (e: any) {
    onProgress(`  ✗ ${url} — ${e.message}`)
    await db.domain.update({
      where: { id: domainId },
      data: { lastMonitored: new Date() },
    })
    return { url, status: 'error' }
  }

  const text    = extractText(html)
  const newHash = hashContent(text)
  const newLen  = text.length

  const domain = await db.domain.findUnique({ where: { id: domainId } })
  const oldHash = domain?.htmlHash
  const oldLen  = domain?.htmlLength ?? 0

  // Ensimmäinen tarkistus — tallennetaan baseline
  if (!oldHash) {
    await db.domain.update({
      where: { id: domainId },
      data: { htmlHash: newHash, htmlLength: newLen, lastMonitored: new Date(), changePercent: null },
    })
    onProgress(`  ○ ${url} — baseline tallennettu`)
    return { url, status: 'new' }
  }

  // Ei muutosta
  if (newHash === oldHash) {
    await db.domain.update({
      where: { id: domainId },
      data: { lastMonitored: new Date(), changePercent: 0 },
    })
    onProgress(`  – ${url} — ei muutosta`)
    return { url, status: 'unchanged', changePercent: 0 }
  }

  // Lasketaan muutosprosentti
  const pct = changePercent(oldLen, newLen)

  await db.domain.update({
    where: { id: domainId },
    data: { htmlHash: newHash, htmlLength: newLen, lastMonitored: new Date(), changePercent: pct },
  })

  if (pct >= CHANGE_THRESHOLD) {
    await addScanJob({ url, sendEmail })
    onProgress(`  ✓ ${url} — MUUTOS ${pct}% → jonoon lisätty`)
    return { url, status: 'changed', changePercent: pct, queued: true }
  }

  onProgress(`  ~ ${url} — pieni muutos ${pct}% (alle kynnyksen)`)
  return { url, status: 'changed', changePercent: pct, queued: false }
}

export async function runMonitor(opts: {
  sendEmail?: boolean
  onProgress?: (msg: string) => void
}): Promise<{ checked: number; changed: number; queued: number; errors: number }> {
  const { sendEmail = false, onProgress = console.log } = opts

  const domains = await db.domain.findMany({
    orderBy: { lastMonitored: { sort: 'asc', nulls: 'first' } },
  })

  onProgress(`Seurataan ${domains.length} domainia...`)

  let changed = 0, queued = 0, errors = 0

  for (const d of domains) {
    const result = await checkDomain(d.id, d.url, { sendEmail, onProgress })
    if (result.status === 'error') errors++
    if (result.status === 'changed') changed++
    if (result.queued) queued++
  }

  onProgress(`\nValmis — tarkistettu: ${domains.length} | muuttunut: ${changed} | jonoon: ${queued} | virheitä: ${errors}`)
  return { checked: domains.length, changed, queued, errors }
}
