import 'dotenv/config'
import { Worker, Job } from 'bullmq'
import path from 'path'
import fs from 'fs'
import { connection, ScanJobData } from './queue'
import { scanSite } from './scanner'
import { findEmail } from './enrichment'
import { browserPool } from './browser-pool'
import { generatePdf } from './pdf'
import { sendReport } from './mailer'
import { db } from './db/client'
import { preFilter } from './prefilter'
import { lookupYTJ } from './ytj'
import { lookupKauppalehti } from './kauppalehti'
import { generateAiSummary } from './ai-summary'

const REPORTS_DIR = path.join(process.cwd(), 'reports')
if (!fs.existsSync(REPORTS_DIR)) fs.mkdirSync(REPORTS_DIR)

const SENDER_NAME = process.env.SENDER_NAME ?? 'WP Saavutettavuus'
const SENDER_URL  = process.env.SENDER_URL  ?? 'https://wpsaavutettavuus.fi'

const SCORE_DROP_THRESHOLD = 15 // pisteet — tämän verran laskettava jotta alert aktivoituu

async function processJob(job: Job<ScanJobData>) {
  const { url, sendEmail, emailOverride, source } = job.data
  console.log(`\n[${new Date().toLocaleTimeString('fi-FI')}] Aloitetaan: ${url}`)

  // 0. Pre-filter — nopea tarkistus ennen raskasta skannausta
  await job.updateProgress(5)
  const filter = await preFilter(url)
  console.log(`  Pre-filter: ${filter.pass ? 'ok' : `hylätty (${filter.reason})`} | kieli: ${filter.lang ?? '?'} | WP: ${filter.isWP} | CTA: ${filter.hasCta}`)

  if (!filter.pass) {
    console.log(`  → Ohitetaan`)
    return { skipped: true, reason: filter.reason }
  }

  // 1. Monisivuinen tarkistus
  await job.updateProgress(20)
  console.log(`  Tarkistetaan...`)
  const browser = await browserPool.acquire()
  const scan = await scanSite(url, browser)
  console.log(`  Pisteet: ${scan.score}/100 | Sivuja: ${scan.pagesScanned} | Kriittistä: ${scan.critical} | Vakavia: ${scan.serious} | Kohtalaista: ${scan.moderate}`)

  // Early exit — ei liidi-potentiaalia
  if (scan.score === 0) {
    console.log(`  → Score 0, ohitetaan (täysin rikki tai estetty)`)
    return { skipped: true, reason: 'score_zero' }
  }
  if (scan.score >= 95) {
    console.log(`  → Score ${scan.score}/100, ohitetaan (ei ongelmia myytävänä)`)
    return { skipped: true, reason: 'score_too_high' }
  }

  // 2. Find email — aina ON, ellei emailOverride
  await job.updateProgress(50)
  const email = emailOverride ?? await findEmail(url, browser)
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

  // Hae edellinen skannaus ennen tallennusta — score drop -vertailua varten
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

  // Tallenna violations omaan tauluun
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

  // Score drop -tarkistus
  const scoreDrop = prevScan ? prevScan.score - scan.score : 0
  const scoreDropAlert = scoreDrop >= SCORE_DROP_THRESHOLD
  if (scoreDropAlert) {
    console.log(`  ⚠ Score drop: ${prevScan!.score} → ${scan.score} (−${scoreDrop} pistettä)`)
  }

  // 5. AI-yhteenveto johdolle
  await job.updateProgress(75)
  const siteContext = ytj?.tolName ?? (filter.hasCta ? 'palveluyritys, jolla on ajanvaraus tai yhteydenotto' : undefined)
  const aiSummary = await generateAiSummary(scan.violations, scan.url, siteContext)
  if (aiSummary) console.log(`  AI-yhteenveto generoitu`)

  // 5b. Generate PDF (tallennetaan sisäiseen käyttöön)
  await job.updateProgress(80)
  const pdf = generatePdf(scan, SENDER_NAME, SENDER_URL)
  const pdfName = `${new URL(normalized).hostname}-${Date.now()}.pdf`
  const pdfPath = path.join(REPORTS_DIR, pdfName)
  fs.writeFileSync(pdfPath, pdf)

  // 6. Save lead
  const maxLeadNo = await db.lead.aggregate({ _max: { leadNo: true } })
  const nextLeadNo = (maxLeadNo._max.leadNo ?? 0) + 1
  const lead = await db.lead.create({
    data: {
      leadNo: nextLeadNo,
      domainId: domain.id,
      scanId: dbScan.id,
      email: email ?? undefined,
      pdfPath,
      aiSummary: aiSummary ?? undefined,
      source: source ?? undefined,
      scoreDropAlert,
    },
  })

  // 7. Send email — automaattisesti aina kun email löytyy (ellei opted out)
  // sendEmail=false voidaan käyttää dry run -ajoihin
  if (email && sendEmail !== false && !domain.optedOut) {
    await job.updateProgress(90)
    const reportUrl = `${SENDER_URL}/r/${lead.token}`
    const optOutUrl = `${SENDER_URL}/opt-out/${lead.token}`

    // Benchmark: kaikkien skannattujen sivustojen keskiarvo
    const benchmarkStats = await db.scan.aggregate({ _avg: { score: true }, _count: { id: true } })
    const benchmark = benchmarkStats._count.id >= 10
      ? { avg: Math.round(benchmarkStats._avg.score ?? 0), total: benchmarkStats._count.id }
      : undefined

    console.log(`  Lähetetään sähköposti → ${email} | analyysi: ${reportUrl}`)
    await sendReport({ to: email, scan, reportUrl, optOutUrl, aiSummary: lead.aiSummary, senderName: SENDER_NAME, senderUrl: SENDER_URL, benchmark })
    await db.lead.update({
      where: { id: lead.id },
      data: { emailSent: true, sentAt: new Date() },
    })
    console.log(`  Sähköposti lähetetty!`)
  }

  await job.updateProgress(100)
  console.log(`  Valmis! Lead #${lead.id}`)

  return { leadId: lead.id, score: scan.score, email, pagesScanned: scan.pagesScanned, scoreDropAlert }
}

const worker = new Worker<ScanJobData>('scan', processJob, {
  connection,
  concurrency: 1,
})

worker.on('failed', (job, err) => {
  console.error(`[VIRHE] ${job?.data.url}: ${err.message}`)
})

process.on('SIGTERM', async () => { await browserPool.shutdown() })
process.on('SIGINT',  async () => { await browserPool.shutdown() })

console.log('A11Y Lead Engine worker käynnissä...')
console.log('Odottaa töitä. Lisää työ ajamalla: pnpm scan <url>\n')
