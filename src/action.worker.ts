import 'dotenv/config'
import { Worker, Job } from 'bullmq'
import { connection, ActionJobData } from './queue'
import { db } from './db/client'
import { sendReport } from './mailer'

const SENDER_NAME = process.env.SENDER_NAME ?? 'WP Saavutettavuus'
const SENDER_URL  = process.env.SENDER_URL  ?? 'https://wpsaavutettavuus.fi'

async function processJob(job: Job<ActionJobData>) {
  const { leadId, sendEmail } = job.data

  const lead = await db.lead.findUnique({
    where: { id: leadId },
    include: { domain: true, scan: true },
  })
  if (!lead) throw new Error(`Lead ${leadId} ei löydy`)

  console.log(`\n[action] ${lead.domain.url} | status: ${lead.status}`)

  // Lähetä vain QUALIFIED-leadeille joilla on email, ei opted out, eikä dry run
  if (lead.status !== 'QUALIFIED' || !lead.email || lead.domain.optedOut || sendEmail === false) {
    console.log(`  Ohitetaan (status: ${lead.status}, email: ${lead.email ? 'kyllä' : 'ei'}, optedOut: ${lead.domain.optedOut})`)
    return { skipped: true }
  }

  await job.updateProgress(30)
  const violations = JSON.parse(lead.scan.violations)
  const scan = {
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

  const reportUrl = `${SENDER_URL}/r/${lead.token}`
  const optOutUrl = `${SENDER_URL}/opt-out/${lead.token}`
  const pixelUrl  = `${SENDER_URL}/pixel/${lead.token}`

  const benchmarkStats = await db.scan.aggregate({ _avg: { score: true }, _count: { id: true } })
  const benchmark = benchmarkStats._count.id >= 10
    ? { avg: Math.round(benchmarkStats._avg.score ?? 0), total: benchmarkStats._count.id }
    : undefined

  await job.updateProgress(60)
  console.log(`  Lähetetään → ${lead.email}`)
  await sendReport({
    to: lead.email,
    scan: scan as any,
    reportUrl,
    optOutUrl,
    pixelUrl,
    aiSummary: lead.aiSummary,
    senderName: SENDER_NAME,
    senderUrl: SENDER_URL,
    benchmark,
  })

  await db.lead.update({
    where: { id: leadId },
    data: { emailSent: true, sentAt: new Date(), status: 'CONTACTED' },
  })

  await job.updateProgress(100)
  console.log(`  Lähetetty! → CONTACTED`)
  return { leadId, email: lead.email }
}

const worker = new Worker<ActionJobData>('action', processJob, { connection, concurrency: 5 })
worker.on('failed', async (job, err) => {
  console.error(`[action:VIRHE] ${job?.data.leadId}: ${err.message}`)
  if (job?.data.leadId) {
    await db.lead.update({ where: { id: job.data.leadId }, data: { status: 'FAILED' } })
  }
})

console.log('action.worker käynnissä...')
