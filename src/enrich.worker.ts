import 'dotenv/config'
import { Worker, Job } from 'bullmq'
import { connection, EnrichJobData, aiQueue } from './queue'
import { scoreLead } from './scoring-agent'
import { findEmail } from './enrichment'
import { browserPool } from './browser-pool'
import { db } from './db/client'
import { lookupYTJ } from './ytj'
import { lookupKauppalehti } from './kauppalehti'

// ── Scoring gate ──────────────────────────────────────────────────────────────
// score < SCORE_MIN → liian rikki, ei jatketa
// score > SCORE_MAX → ei ongelmia myytävänä, jo suodatettu scan.workerissa
// score >= QUALIFIED_THRESHOLD + email → QUALIFIED → jatketaan outreachiin
const SCORE_MIN           = 40
const QUALIFIED_THRESHOLD = 70

async function processJob(job: Job<EnrichJobData>) {
  const { leadId, url, sendEmail, emailOverride } = job.data
  console.log(`\n[enrich] ${url}`)

  const lead = await db.lead.findUnique({ where: { id: leadId }, include: { scan: true, domain: true } })
  if (!lead) throw new Error(`Lead ${leadId} ei löydy`)

  // Scoring gate — liian matala pisteet, ei kannata jatkaa
  if (lead.scan.score < SCORE_MIN) {
    console.log(`  Scoring gate: score ${lead.scan.score} < ${SCORE_MIN} → stop`)
    await db.lead.update({ where: { id: leadId }, data: { status: 'ENRICHED' } })
    return { skipped: true, reason: 'score_too_low' }
  }

  // 1. Sähköposti
  await job.updateProgress(20)
  const browser = await browserPool.acquire()
  const email = emailOverride ?? await findEmail(url, browser)
  console.log(`  Sähköposti: ${email ?? 'ei löydy'}`)

  // 2. YTJ
  await job.updateProgress(50)
  const hostname = new URL(url).hostname
  const ytj = await lookupYTJ(hostname)
  if (ytj) console.log(`  YTJ: ${ytj.name} | TOL ${ytj.tol}: ${ytj.tolName}`)

  // 3. Kauppalehti
  await job.updateProgress(70)
  const kl = ytj?.businessId ? await lookupKauppalehti(ytj.businessId) : null
  if (kl?.revenue) console.log(`  KL: ${(kl.revenue / 1000).toFixed(0)} t€ | ${kl.employees ?? '?'} hlö`)

  // 4. Päivitä domain
  await db.domain.update({
    where: { id: lead.domainId },
    data: {
      ...(email        && { email }),
      ...(ytj?.name    && { company: ytj.name }),
      ...(ytj?.businessId && { businessId: ytj.businessId }),
      ...(ytj?.tol     && { tol: ytj.tol }),
      ...(ytj?.tolName && { tolName: ytj.tolName }),
      ...(kl?.revenue  && { revenue: kl.revenue }),
      ...(kl?.employees && { employees: kl.employees }),
      ...(kl?.founded  && { foundedYear: kl.founded }),
    },
  })

  // 5. Scoring-agentti
  await job.updateProgress(80)
  const scoring = await scoreLead({
    score: lead.scan.score,
    critical: lead.scan.critical,
    serious: lead.scan.serious,
    moderate: lead.scan.moderate,
    revenue: kl?.revenue,
    employees: kl?.employees,
    tolName: ytj?.tolName,
    isWordPress: lead.domain.isWordPress,
    hasCta: lead.domain.hasCta,
    hasAccessibilityStatement: lead.domain.hasAccessibilityStatement,
  })
  if (scoring) console.log(`  Prioriteetti: ${scoring.priorityScore}/10 — ${scoring.priorityReason}`)

  // 6. Determine status — scoring gate + email check
  const score = lead.scan.score
  const isQualified = !!email && score >= QUALIFIED_THRESHOLD
  const status = isQualified ? 'QUALIFIED' : 'ENRICHED'

  await db.lead.update({
    where: { id: leadId },
    data: {
      ...(email && { email }),
      status,
      ...(scoring && { priorityScore: scoring.priorityScore, priorityReason: scoring.priorityReason }),
    },
  })

  console.log(`  Score ${score} | email: ${email ? 'kyllä' : 'ei'} → ${status}`)

  // 6. Ketjuta → ai (myös ENRICHED menee ai-vaiheeseen, action.worker päättää lähettämisestä)
  await aiQueue.add('ai', { leadId, sendEmail }, {
    attempts: 2,
    backoff: { type: 'exponential', delay: 3000 },
  })

  await job.updateProgress(100)
  return { leadId, email, status }
}

const worker = new Worker<EnrichJobData>('enrich', processJob, {
  connection,
  concurrency: 2,
})

worker.on('failed', async (job, err) => {
  console.error(`[enrich:VIRHE] ${job?.data.leadId}: ${err.message}`)
  if (job?.data.leadId) {
    await db.lead.update({ where: { id: job.data.leadId }, data: { status: 'FAILED' } })
  }
})

process.on('SIGTERM', async () => { await browserPool.shutdown() })
process.on('SIGINT',  async () => { await browserPool.shutdown() })

console.log('enrich.worker käynnissä...')
