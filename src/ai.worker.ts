import 'dotenv/config'
import path from 'path'
import fs from 'fs'
import { Worker, Job } from 'bullmq'
import { connection, AiJobData, actionQueue } from './queue'
import { db } from './db/client'
import { generateAiSummary, generateGeoSnippet } from './ai-summary'
import { generatePdf } from './pdf'

const REPORTS_DIR = path.join(process.cwd(), 'reports')
if (!fs.existsSync(REPORTS_DIR)) fs.mkdirSync(REPORTS_DIR)

const SENDER_NAME = process.env.SENDER_NAME ?? 'WP Saavutettavuus'
const SENDER_URL  = process.env.SENDER_URL  ?? 'https://wpsaavutettavuus.fi'

async function processJob(job: Job<AiJobData>) {
  const { leadId, sendEmail } = job.data

  const lead = await db.lead.findUnique({
    where: { id: leadId },
    include: { domain: true, scan: true },
  })
  if (!lead) throw new Error(`Lead ${leadId} ei löydy`)

  console.log(`\n[ai] ${lead.domain.url}`)

  // 1. AI-yhteenveto + GEO-snippet rinnakkain
  await job.updateProgress(30)
  const violations = JSON.parse(lead.scan.violations)
  const siteContext = lead.domain.tolName
    ?? (lead.domain.hasCta ? 'palveluyritys, jolla on ajanvaraus tai yhteydenotto' : undefined)
  const [aiSummary, geoSnippet] = await Promise.all([
    generateAiSummary(violations, lead.domain.url, siteContext),
    generateGeoSnippet(lead.domain.url),
  ])
  if (aiSummary) console.log(`  AI-yhteenveto generoitu`)
  if (geoSnippet) console.log(`  GEO-snippet generoitu`)

  // 2. PDF
  await job.updateProgress(70)
  const scanData = {
    url: lead.domain.url,
    score: lead.scan.score,
    critical: lead.scan.critical,
    serious: lead.scan.serious,
    moderate: lead.scan.moderate,
    minor: lead.scan.minor,
    passed: lead.scan.passed,
    violations,
    timestamp: lead.scan.scannedAt.toISOString(),
    pagesScanned: lead.scan.pagesScanned,
    pageBreakdown: lead.scan.pageBreakdown ? JSON.parse(lead.scan.pageBreakdown) : [],
    smallTouchTargets: 0,
    focusOutlineIssues: 0,
  }
  const pdf = generatePdf(scanData as any, SENDER_NAME, SENDER_URL)
  const pdfName = `${new URL(lead.domain.url).hostname}-${Date.now()}.pdf`
  const pdfPath = path.join(REPORTS_DIR, pdfName)
  fs.writeFileSync(pdfPath, pdf)

  await db.lead.update({
    where: { id: leadId },
    data: {
      ...(aiSummary && { aiSummary }),
      ...(geoSnippet && { geoSnippetOriginal: geoSnippet.original, geoSnippetOptimized: geoSnippet.optimized }),
      pdfPath,
    },
  })

  // 3. Ketjuta → action
  await actionQueue.add('action', { leadId, sendEmail }, {
    attempts: 2,
    backoff: { type: 'exponential', delay: 3000 },
  })

  await job.updateProgress(100)
  return { leadId }
}

const worker = new Worker<AiJobData>('ai', processJob, { connection, concurrency: 3 })
worker.on('failed', async (job, err) => {
  console.error(`[ai:VIRHE] ${job?.data.leadId}: ${err.message}`)
  if (job?.data.leadId) {
    await db.lead.update({ where: { id: job.data.leadId }, data: { status: 'FAILED' } })
  }
})

console.log('ai.worker käynnissä...')
