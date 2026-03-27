import 'dotenv/config'
import { Worker, Job } from 'bullmq'
import path from 'path'
import fs from 'fs'
import { connection, ScanJobData } from './queue'
import { scanUrl, detectWordPress } from './scanner'
import { findEmail } from './enrichment'
import { generatePdf } from './pdf'
import { sendReport } from './mailer'
import { db } from './db/client'

const REPORTS_DIR = path.join(process.cwd(), 'reports')
if (!fs.existsSync(REPORTS_DIR)) fs.mkdirSync(REPORTS_DIR)

const SENDER_NAME = process.env.SENDER_NAME ?? 'WP Saavutettavuus'
const SENDER_URL  = process.env.SENDER_URL  ?? 'https://wpsaavutettavuus.fi'

async function processJob(job: Job<ScanJobData>) {
  const { url, sendEmail, emailOverride } = job.data
  console.log(`\n[${new Date().toLocaleTimeString('fi-FI')}] Aloitetaan: ${url}`)

  // 1. Detect WordPress
  await job.updateProgress(10)
  const isWP = await detectWordPress(url)
  console.log(`  WordPress: ${isWP ? 'kyllä' : 'ei'}`)

  // 2. Scan
  await job.updateProgress(30)
  console.log(`  Skannataan...`)
  const scan = await scanUrl(url)
  console.log(`  Pisteet: ${scan.score}/100 | Kriittistä: ${scan.critical} | Vakavia: ${scan.serious} | Kohtalaista: ${scan.moderate}`)

  // 3. Find email
  await job.updateProgress(60)
  const email = emailOverride ?? (sendEmail ? await findEmail(url) : null)
  console.log(`  Sähköposti: ${email ?? 'ei löydy'}`)

  // 4. Save to DB
  await job.updateProgress(70)
  const normalized = scan.url

  const domain = await db.domain.upsert({
    where: { url: normalized },
    create: { url: normalized, isWordPress: isWP, email: email ?? undefined },
    update: { isWordPress: isWP, email: email ?? undefined },
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
