import 'dotenv/config'
import { Worker, Job } from 'bullmq'
import { connection, ScanJobData, enrichQueue } from './queue'
import { normalizeUrl } from './utils/normalize-url'
import { scanSite } from './scanner'
import { browserPool } from './browser-pool'
import { db } from './db/client'
import { preFilter } from './prefilter'

const SCORE_DROP_THRESHOLD = 15

async function processJob(job: Job<ScanJobData>) {
  const { url, sendEmail, emailOverride, source } = job.data
  console.log(`\n[scan] ${url}`)

  // 1. Pre-filter
  await job.updateProgress(10)
  const filter = await preFilter(url)
  console.log(`  Pre-filter: ${filter.pass ? 'ok' : `hylätty (${filter.reason})`} | WP: ${filter.isWP} | CTA: ${filter.hasCta}`)
  if (!filter.pass) return { skipped: true, reason: filter.reason }

  // 2. Scan
  await job.updateProgress(30)
  const browser = await browserPool.acquire()
  const scan = await scanSite(url, browser)
  console.log(`  Pisteet: ${scan.score}/100 | Sivuja: ${scan.pagesScanned} | Kriittistä: ${scan.critical}`)

  if (source !== 'Manuaalinen') {
    if (scan.score === 0)  return { skipped: true, reason: 'score_zero' }
    if (scan.score >= 95)  return { skipped: true, reason: 'score_too_high' }
  }

  // 3. Tallenna Domain + Scan + Lead
  await job.updateProgress(60)
  const normalized = normalizeUrl(scan.url)

  const domain = await db.domain.upsert({
    where: { url: normalized },
    create: {
      url: normalized,
      isWordPress: filter.isWP,
      hasCta: filter.hasCta,
      hasAccessibilityStatement: filter.hasAccessibilityStatement,
      siteLastModified: filter.siteLastModified ?? undefined,
    },
    update: {
      isWordPress: filter.isWP,
      hasCta: filter.hasCta,
      hasAccessibilityStatement: filter.hasAccessibilityStatement,
      siteLastModified: filter.siteLastModified ?? undefined,
    },
  })

  const prevScan = await db.scan.findFirst({
    where: { domainId: domain.id },
    orderBy: { scannedAt: 'desc' },
  })

  const dbScan = await db.scan.create({
    data: {
      domainId: domain.id,
      score: scan.score,
      critical: scan.critical,
      serious: scan.serious,
      moderate: scan.moderate,
      minor: scan.minor,
      passed: scan.passed,
      violations: JSON.stringify(scan.violations),
      pagesScanned: scan.pagesScanned,
      pageBreakdown: scan.pageBreakdown.length > 0 ? JSON.stringify(scan.pageBreakdown) : undefined,
    },
  })

  if (scan.violations.length > 0) {
    await db.violation.createMany({
      data: scan.violations.map((v) => ({
        scanId: dbScan.id,
        ruleId: v.id,
        impact: v.impact ?? undefined,
        description: v.description,
        help: v.help,
        wcag: v.wcag,
        element: v.element ?? undefined,
        pageUrl: v.pageUrl ?? undefined,
      })),
    })
  }

  const scoreDrop = prevScan ? prevScan.score - scan.score : 0
  const scoreDropAlert = scoreDrop >= SCORE_DROP_THRESHOLD
  if (scoreDropAlert) console.log(`  ⚠ Score drop: ${prevScan!.score} → ${scan.score} (−${scoreDrop} p.)`)

  const maxLeadNo = await db.lead.aggregate({ _max: { leadNo: true } })
  const nextLeadNo = (maxLeadNo._max.leadNo ?? 0) + 1

  const lead = await db.lead.create({
    data: {
      leadNo: nextLeadNo,
      domainId: domain.id,
      scanId: dbScan.id,
      source: source ?? undefined,
      scoreDropAlert,
      status: 'SCANNED',
      lastScannedAt: new Date(),
    },
  })

  // 4. Ketjuta → enrich
  await enrichQueue.add('enrich', { leadId: lead.id, url: normalized, sendEmail, emailOverride }, {
    attempts: 2,
    backoff: { type: 'exponential', delay: 3000 },
  })

  await job.updateProgress(100)
  console.log(`  Lead #${lead.leadNo} luotu → SCANNED`)
  return { leadId: lead.id, score: scan.score, scoreDropAlert }
}

const worker = new Worker<ScanJobData>('scan', processJob, { connection, concurrency: 1 })
worker.on('failed', (job, err) => console.error(`[scan:VIRHE] ${job?.data.url}: ${err.message}`))

process.on('SIGTERM', async () => { await browserPool.shutdown() })
process.on('SIGINT',  async () => { await browserPool.shutdown() })

console.log('scan.worker käynnissä...')
