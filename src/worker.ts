import 'dotenv/config'
import { Worker, Job } from 'bullmq'
import path from 'path'
import fs from 'fs'
import { connection, ScanJobData } from './queue'
import { scanUrl } from './scanner'
import { findEmail } from './enrichment'
import { generatePdf } from './pdf'
import { sendReport } from './mailer'
import { db } from './db/client'
import { preFilter } from './prefilter'
import { lookupYTJ } from './ytj'
import { lookupKauppalehti } from './kauppalehti'

const REPORTS_DIR = path.join(process.cwd(), 'reports')
if (!fs.existsSync(REPORTS_DIR)) fs.mkdirSync(REPORTS_DIR)

const SENDER_NAME = process.env.SENDER_NAME ?? 'WP Saavutettavuus'
const SENDER_URL  = process.env.SENDER_URL  ?? 'https://wpsaavutettavuus.fi'

async function processJob(job: Job<ScanJobData>) {
  const { url, sendEmail, emailOverride } = job.data
  console.log(`\n[${new Date().toLocaleTimeString('fi-FI')}] Aloitetaan: ${url}`)

  // 0. Pre-filter — nopea tarkistus ennen raskasta skannausta
  await job.updateProgress(5)
  const filter = await preFilter(url)
  console.log(`  Pre-filter: ${filter.pass ? 'ok' : `hylätty (${filter.reason})`} | kieli: ${filter.lang ?? '?'} | WP: ${filter.isWP} | CTA: ${filter.hasCta}`)

  if (!filter.pass) {
    console.log(`  → Ohitetaan`)
    return { skipped: true, reason: filter.reason }
  }

  // 1. Scan
  await job.updateProgress(20)
  console.log(`  Skannataan...`)
  const scan = await scanUrl(url)
  console.log(`  Pisteet: ${scan.score}/100 | Kriittistä: ${scan.critical} | Vakavia: ${scan.serious} | Kohtalaista: ${scan.moderate}`)

  // 2. Find email
  await job.updateProgress(50)
  const email = emailOverride ?? (sendEmail ? await findEmail(url) : null)
  console.log(`  Sähköposti: ${email ?? 'ei löydy'}`)

  // 3. YTJ — yritystiedot
  await job.updateProgress(60)
  const hostname = new URL(scan.url).hostname
  const ytj = await lookupYTJ(hostname)
  if (ytj) {
    console.log(`  YTJ: ${ytj.name} | Y-tunnus: ${ytj.businessId} | TOL ${ytj.tol}: ${ytj.tolName}`)
  }

  // 3b. Kauppalehti — liikevaihto ja henkilöstö
  await job.updateProgress(65)
  const kl = ytj?.businessId ? await lookupKauppalehti(ytj.businessId) : null
  if (kl?.revenue) {
    console.log(`  Kauppalehti: liikevaihto ${(kl.revenue / 1000).toFixed(0)} t€ | henkilöstö: ${kl.employees ?? '?'}`)
  }

  // 4. Save to DB
  await job.updateProgress(70)
  const normalized = scan.url

  const domain = await db.domain.upsert({
    where: { url: normalized },
    create: {
      url: normalized,
      isWordPress: filter.isWP,
      email: email ?? undefined,
      company: ytj?.name ?? undefined,
      businessId: ytj?.businessId ?? undefined,
      tol: ytj?.tol ?? undefined,
      tolName: ytj?.tolName ?? undefined,
      hasCta: filter.hasCta,
      hasAccessibilityStatement: filter.hasAccessibilityStatement,
      siteLastModified: filter.siteLastModified ?? undefined,
      revenue: kl?.revenue ?? undefined,
      employees: kl?.employees ?? undefined,
      foundedYear: kl?.founded ?? undefined,
    },
    update: {
      isWordPress: filter.isWP,
      email: email ?? undefined,
      company: ytj?.name ?? undefined,
      businessId: ytj?.businessId ?? undefined,
      tol: ytj?.tol ?? undefined,
      tolName: ytj?.tolName ?? undefined,
      hasCta: filter.hasCta,
      hasAccessibilityStatement: filter.hasAccessibilityStatement,
      siteLastModified: filter.siteLastModified ?? undefined,
      revenue: kl?.revenue ?? undefined,
      employees: kl?.employees ?? undefined,
      foundedYear: kl?.founded ?? undefined,
    },
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
    },
  })

  // 5. Generate PDF
  await job.updateProgress(80)
  console.log(`  Generoidaan PDF...`)
  const pdf = generatePdf(scan, SENDER_NAME, SENDER_URL)
  const pdfName = `${new URL(normalized).hostname}-${Date.now()}.pdf`
  const pdfPath = path.join(REPORTS_DIR, pdfName)
  fs.writeFileSync(pdfPath, pdf)
  console.log(`  PDF tallennettu: reports/${pdfName}`)

  // 6. Save lead
  const lead = await db.lead.create({
    data: {
      domainId: domain.id,
      scanId: dbScan.id,
      email: email ?? undefined,
      pdfPath,
    },
  })

  // 7. Send email
  if (email) {
    await job.updateProgress(90)
    console.log(`  Lähetetään sähköposti → ${email}`)
    await sendReport({ to: email, scan, pdf, senderName: SENDER_NAME, senderUrl: SENDER_URL })
    await db.lead.update({
      where: { id: lead.id },
      data: { emailSent: true, sentAt: new Date() },
    })
    console.log(`  Sähköposti lähetetty!`)
  }

  await job.updateProgress(100)
  console.log(`  Valmis! Lead #${lead.id}`)

  return { leadId: lead.id, score: scan.score, email }
}

const worker = new Worker<ScanJobData>('scan', processJob, {
  connection,
  concurrency: 2,
})

worker.on('failed', (job, err) => {
  console.error(`[VIRHE] ${job?.data.url}: ${err.message}`)
})

console.log('A11Y Lead Engine worker käynnissä...')
console.log('Odottaa töitä. Lisää työ ajamalla: pnpm scan <url>\n')
