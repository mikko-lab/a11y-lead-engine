import 'dotenv/config'
import express from 'express'
import path from 'path'
import fs from 'fs'
import rateLimit from 'express-rate-limit'
import { db } from './db/client'
import { generatePdf } from './pdf'
import { sendReport } from './mailer'
import { discoverFromDuckDuckGo, discoverFromTranco, discoverFromYritykset, CATEGORIES } from './discovery/index'
import { TOL_NAMES, TARGET_TOLS } from './ytj'
import { runMonitor } from './monitor'
import { addScanJob } from './queue'

const app = express()
app.use(express.json())

// Rate limiting
const publicLimit = rateLimit({ windowMs: 15 * 60 * 1000, max: 60, standardHeaders: true, legacyHeaders: false })
const dashboardLimit = rateLimit({ windowMs: 15 * 60 * 1000, max: 300, standardHeaders: true, legacyHeaders: false })

app.use('/r/', publicLimit)
app.use('/opt-out/', publicLimit)
app.use('/api/', dashboardLimit)

const SENDER_NAME = process.env.SENDER_NAME ?? 'WP Saavutettavuus'
const SENDER_URL  = process.env.SENDER_URL  ?? 'https://wpsaavutettavuus.fi'
const REPORTS_DIR = path.join(process.cwd(), 'reports')

// ── SSE: live-lokit discovery-ajoon ──────────────────────────────────────────
let sseClients: express.Response[] = []

function sendSSE(msg: string, type = 'log') {
  const data = JSON.stringify({ msg, type, ts: new Date().toLocaleTimeString('fi-FI') })
  sseClients.forEach(c => { try { c.write(`data: ${data}\n\n`) } catch {} })
}

app.get('/api/discover/stream', (req, res) => {
  res.setHeader('Content-Type', 'text/event-stream')
  res.setHeader('Cache-Control', 'no-cache')
  res.setHeader('Connection', 'keep-alive')
  res.flushHeaders()
  sseClients.push(res)
  req.on('close', () => { sseClients = sseClients.filter(c => c !== res) })
})

let discoveryRunning = false

app.post('/api/discover', async (req, res) => {
  if (discoveryRunning) return res.status(409).json({ error: 'Ajo on jo käynnissä' })

  const { source, limit = 50, sendEmail = false, tolFilter = [], categories = [] } = req.body
  res.json({ ok: true })

  discoveryRunning = true
  const onProgress = (msg: string) => sendSSE(msg)

  try {
    sendSSE(`Aloitetaan ajo — lähde: ${source}, limit: ${limit}`, 'info')
    if (tolFilter.length > 0) {
      sendSSE(`Toimialasuodatus: ${tolFilter.map((t: string) => TOL_NAMES[t] ?? t).join(', ')}`, 'info')
    }

    let result
    if (source === 'duckduckgo') {
      result = await discoverFromDuckDuckGo({ limit, sendEmail, tolFilter, onProgress })
    } else if (source === 'tranco') {
      result = await discoverFromTranco({ limit, sendEmail, tolFilter, onProgress })
    } else if (source === 'yritykset') {
      const cats = categories.length > 0 ? categories : CATEGORIES.slice(0, 3)
      result = await discoverFromYritykset({ sendEmail, tolFilter, categories: cats, onProgress })
    } else {
      sendSSE('Tuntematon lähde', 'error')
      return
    }

    sendSSE(`Valmis! Löydettiin ${result.found} domainia, jonoon lisätty ${result.queued} tarkistusta.`, 'done')
  } catch (e: any) {
    sendSSE(`Virhe: ${e.message}`, 'error')
  } finally {
    discoveryRunning = false
  }
})

app.get('/api/discover/status', (_, res) => {
  res.json({ running: discoveryRunning })
})

// ── Monitor API ───────────────────────────────────────────────────────────────
let monitorRunning = false

app.get('/api/monitor/domains', async (_, res) => {
  const domains = await db.domain.findMany({
    orderBy: { lastMonitored: { sort: 'desc', nulls: 'last' } },
    select: {
      id: true, url: true, company: true, tol: true, tolName: true,
      htmlHash: true, htmlLength: true, lastMonitored: true, changePercent: true,
      scans: { orderBy: { scannedAt: 'desc' }, take: 1, select: { score: true } },
    },
  })
  const filtered = domains.filter(d => !d.scans[0] || d.scans[0].score < 100)
  res.json(filtered.map(({ scans, ...rest }) => rest))
})

app.post('/api/monitor/run', async (req, res) => {
  if (monitorRunning) return res.status(409).json({ error: 'Seuranta on jo käynnissä' })
  const { sendEmail = false } = req.body
  res.json({ ok: true })
  monitorRunning = true
  try {
    sendSSE('Muutosseuranta käynnistetty...', 'info')
    await runMonitor({ sendEmail, onProgress: (msg) => sendSSE(msg) })
    sendSSE('Seuranta valmis.', 'done')
  } catch (e: any) {
    sendSSE(`Virhe: ${e.message}`, 'error')
  } finally {
    monitorRunning = false
  }
})

app.get('/api/monitor/status', (_, res) => {
  res.json({ running: monitorRunning })
})

// ── API ───────────────────────────────────────────────────────────────────────

app.get('/api/stats', async (_, res) => {
  const [total, sent, converted, leads] = await Promise.all([
    db.lead.count(),
    db.lead.count({ where: { emailSent: true } }),
    db.lead.count({ where: { convertedAt: { not: null } } }),
    db.lead.findMany({
      include: { scan: true },
      orderBy: { createdAt: 'desc' },
    }),
  ])
  const scores = leads.map((l) => l.scan.score)
  const avg = scores.length ? Math.round(scores.reduce((a, b) => a + b, 0) / scores.length) : 0
  const withEmail = leads.filter((l) => l.email).length
  res.json({ total, sent, avg, withEmail, converted })
})

function conversionScore(lead: any): number {
  const d = lead.domain
  const score = lead.scan.score
  const sixMonthsAgo = new Date(Date.now() - 1000 * 60 * 60 * 24 * 180)
  let pts = 0

  // Kipupiste: tarpeeksi rikki korjattavaksi, muttei niin rikki ettei budjettia
  if (score >= 25 && score <= 65)                                 pts += 2
  else if (score < 25)                                            pts += 1

  // WordPress: helpompi korjata, tunnettu ekosysteemi
  if (d.isWordPress)                                              pts += 2

  // Liiketoimintasignaalit
  if (d.hasCta)                                                   pts += 1
  if (!d.hasAccessibilityStatement)                               pts += 1  // ei tietoisuutta = mahdollisuus
  if (d.siteLastModified && new Date(d.siteLastModified) > sixMonthsAgo) pts += 1
  if (d.revenue && d.revenue >= 200_000 && d.revenue <= 5_000_000)      pts += 2

  // Intentiosignaalit (vahvimmat)
  if (lead.reportViewCount > 0)                                   pts += 3  // katsoi analyysin
  if (lead.reportViewCount > 2)                                   pts += 1  // useita katseluja
  if (lead.scoreDropAlert)                                        pts += 2  // score laski — kiireellinen

  return pts
}

app.get('/api/leads', async (_, res) => {
  const leads = await db.lead.findMany({
    include: { domain: true, scan: true },
    orderBy: { createdAt: 'desc' },
  })
  res.json(leads.map(l => ({ ...l, conversionScore: conversionScore(l) })))
})

app.post('/api/leads/:id/convert', async (req, res) => {
  const lead = await db.lead.findUnique({ where: { id: req.params.id } })
  if (!lead) return res.status(404).json({ error: 'Lead ei löydy' })
  await db.lead.update({
    where: { id: req.params.id },
    data: { convertedAt: lead.convertedAt ? null : new Date() },
  })
  res.json({ ok: true })
})

app.post('/api/leads/:id/send', async (req, res) => {
  const lead = await db.lead.findUnique({
    where: { id: req.params.id },
    include: { domain: true, scan: true },
  })
  if (!lead) return res.status(404).json({ error: 'Lead ei löydy' })

  const emailTo = req.body.email || lead.email
  if (!emailTo) return res.status(400).json({ error: 'Sähköpostiosoite puuttuu' })

  const scan = {
    url: lead.domain.url,
    score: lead.scan.score,
    critical: lead.scan.critical,
    serious: lead.scan.serious,
    moderate: lead.scan.moderate,
    minor: lead.scan.minor,
    passed: lead.scan.passed,
    violations: JSON.parse(lead.scan.violations),
    timestamp: lead.scan.scannedAt.toISOString(),
  }

  const pdf = lead.pdfPath && fs.existsSync(lead.pdfPath)
    ? fs.readFileSync(lead.pdfPath)
    : generatePdf(scan, SENDER_NAME, SENDER_URL)

  const reportUrl = `${SENDER_URL}/r/${lead.token}`
  const optOutUrl = `${SENDER_URL}/opt-out/${lead.token}`

  const benchmarkStats = await db.scan.aggregate({ _avg: { score: true }, _count: { id: true } })
  const benchmark = benchmarkStats._count.id >= 10
    ? { avg: Math.round(benchmarkStats._avg.score ?? 0), total: benchmarkStats._count.id }
    : undefined

  await sendReport({ to: emailTo, scan, reportUrl, optOutUrl, aiSummary: lead.aiSummary, senderName: SENDER_NAME, senderUrl: SENDER_URL, benchmark })
  await db.lead.update({
    where: { id: lead.id },
    data: { emailSent: true, sentAt: new Date(), email: emailTo },
  })

  res.json({ ok: true })
})

app.get('/api/leads/:id/pdf', async (req, res) => {
  const lead = await db.lead.findUnique({ where: { id: req.params.id }, include: { scan: true, domain: true } })
  if (!lead) return res.status(404).send('Not found')

  if (lead.pdfPath && fs.existsSync(lead.pdfPath)) {
    res.setHeader('Content-Type', 'application/pdf')
    res.setHeader('Content-Disposition', `attachment; filename="${new URL(lead.domain.url).hostname}-raportti.pdf"`)
    return res.send(fs.readFileSync(lead.pdfPath))
  }

  const scan = {
    url: lead.domain.url,
    score: lead.scan.score,
    critical: lead.scan.critical,
    serious: lead.scan.serious,
    moderate: lead.scan.moderate,
    minor: lead.scan.minor,
    passed: lead.scan.passed,
    violations: JSON.parse(lead.scan.violations),
    timestamp: lead.scan.scannedAt.toISOString(),
  }
  const pdf = generatePdf(scan, SENDER_NAME, SENDER_URL)
  res.setHeader('Content-Type', 'application/pdf')
  res.setHeader('Content-Disposition', `attachment; filename="${new URL(lead.domain.url).hostname}-raportti.pdf"`)
  res.send(pdf)
})

app.patch('/api/leads/:id/email', async (req, res) => {
  const lead = await db.lead.findUnique({ where: { id: req.params.id } })
  if (!lead) return res.status(404).json({ error: 'Lead ei löydy' })
  const email = req.body.email?.trim() || null
  await db.lead.update({ where: { id: req.params.id }, data: { email } })
  res.json({ ok: true })
})

app.delete('/api/leads/:id', async (req, res) => {
  const lead = await db.lead.findUnique({ where: { id: req.params.id } })
  if (!lead) return res.status(404).json({ error: 'Lead ei löydy' })
  await db.lead.delete({ where: { id: req.params.id } })
  res.json({ ok: true })
})

app.delete('/api/leads', async (req, res) => {
  const { ids } = req.body as { ids: string[] }
  if (!Array.isArray(ids) || ids.length === 0) return res.status(400).json({ error: 'ids puuttuu' })
  await db.lead.deleteMany({ where: { id: { in: ids } } })
  res.json({ ok: true, deleted: ids.length })
})

app.post('/api/leads/:id/notes', async (req, res) => {
  const { notes } = req.body
  const lead = await db.lead.findUnique({ where: { id: req.params.id } })
  if (!lead) return res.status(404).json({ error: 'Lead ei löydy' })
  await db.lead.update({ where: { id: req.params.id }, data: { notes } })
  res.json({ ok: true })
})

// ── Opt-out (ei autentikaatiota) ──────────────────────────────────────────────
app.get('/opt-out/:token', async (req, res) => {
  const lead = await db.lead.findUnique({
    where: { token: req.params.token },
    include: { domain: true },
  })
  if (!lead) return res.status(404).send('Linkkiä ei löydy.')

  await db.domain.update({
    where: { id: lead.domainId },
    data: { optedOut: true, optedOutAt: new Date() },
  })

  res.send(`<!DOCTYPE html>
<html lang="fi">
<head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Peruutus vahvistettu</title>
<style>body{font-family:'Segoe UI',Arial,sans-serif;background:#f8fafc;display:flex;align-items:center;justify-content:center;min-height:100vh;margin:0;}
.box{background:#fff;border-radius:12px;padding:40px 32px;max-width:480px;text-align:center;box-shadow:0 2px 16px rgba(0,0,0,.07);}
h1{font-size:22px;margin:0 0 12px;}p{color:#475569;line-height:1.6;margin:0 0 8px;}</style>
</head>
<body><div class="box">
  <p style="font-size:32px;margin:0 0 16px;">✅</p>
  <h1>Peruutus vahvistettu</h1>
  <p>Osoite <strong>${lead.domain.url}</strong> on poistettu postituslistaltamme.</p>
  <p>Ette saa meiltä enää viestejä.</p>
</div></body></html>`)
})

// ── Julkinen raporttisivu (ei autentikaatiota) ─────────────────────────────────
app.get('/r/:token', async (req, res) => {
  const lead = await db.lead.findUnique({
    where: { token: req.params.token },
    include: { domain: true, scan: true },
  })
  if (!lead) return res.status(404).send('Raporttia ei löydy.')

  // Seuraa katsomisia (ei-blokkaava)
  db.lead.update({
    where: { token: req.params.token },
    data: {
      reportViewCount: { increment: 1 },
      reportFirstViewedAt: lead.reportFirstViewedAt ?? new Date(),
    },
  }).catch(() => {})

  const benchmarkStats = await db.scan.aggregate({ _avg: { score: true }, _count: { id: true } })
  const benchmark = benchmarkStats._count.id >= 10
    ? { avg: Math.round(benchmarkStats._avg.score ?? 0), total: benchmarkStats._count.id }
    : null

  const scan = {
    url: lead.domain.url,
    score: lead.scan.score,
    critical: lead.scan.critical,
    serious: lead.scan.serious,
    moderate: lead.scan.moderate,
    minor: lead.scan.minor,
    passed: lead.scan.passed,
    violations: JSON.parse(lead.scan.violations) as Array<{id:string,impact:string|null,help:string,wcag:string,element:string|null,contrastRatio?:number,expectedContrastRatio?:string,pageUrl?:string}>,
    timestamp: lead.scan.scannedAt.toISOString(),
    pagesScanned: lead.scan.pagesScanned ?? 1,
    pageBreakdown: lead.scan.pageBreakdown ? JSON.parse(lead.scan.pageBreakdown) : [],
  }

  const domain = new URL(scan.url).hostname
  const scoreColor = scan.score >= 80 ? '#00D4AA' : scan.score >= 50 ? '#f59e0b' : '#fb923c'
  const issueCount = scan.critical + scan.serious

  const violationRows = scan.violations.slice(0, 10).map(v => {
    const impactColor = v.impact === 'critical' ? '#fb923c' : v.impact === 'serious' ? '#f59e0b' : v.impact === 'moderate' ? '#60a5fa' : '#94a3b8'
    const impactLabel = v.impact === 'critical' ? 'Kriittinen' : v.impact === 'serious' ? 'Vakava' : v.impact === 'moderate' ? 'Kohtalainen' : 'Vähäinen'
    const contrastBadge = v.contrastRatio && v.expectedContrastRatio
      ? `<span style="background:#1e293b;color:#fbbf24;font-size:11px;font-weight:700;padding:2px 8px;border-radius:4px;font-family:monospace;">${v.contrastRatio.toFixed(1)}:1 / ${v.expectedContrastRatio}</span>`
      : ''
    const pageBadge = v.pageUrl && v.pageUrl !== scan.url
      ? `<span style="color:#64748b;font-size:11px;">📄 ${new URL(v.pageUrl).pathname}</span>`
      : ''
    return `
    <div style="border:1px solid #1e293b;border-radius:8px;padding:16px;margin-bottom:12px;">
      <div style="display:flex;align-items:center;gap:8px;flex-wrap:wrap;margin-bottom:8px;">
        <span style="background:${impactColor};color:#fff;font-size:11px;font-weight:700;padding:2px 8px;border-radius:4px;">${impactLabel}</span>
        <span style="color:#94a3b8;font-size:12px;">${v.wcag}</span>
        ${contrastBadge}
        ${pageBadge}
      </div>
      <p style="margin:0 0 6px;font-weight:600;color:#e2e8f0;">${v.help}</p>
      ${v.element ? `<code style="display:block;background:#0f172a;color:#7dd3fc;font-size:11px;padding:8px;border-radius:4px;overflow-x:auto;white-space:pre-wrap;word-break:break-all;">${v.element.replace(/</g,'&lt;').replace(/>/g,'&gt;')}</code>` : ''}
    </div>`
  }).join('')

  res.send(`<!DOCTYPE html>
<html lang="fi">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>Sivustoanalyysi — ${domain}</title>
<style>
  * { box-sizing: border-box; }
  body { font-family: 'Segoe UI', Arial, sans-serif; background: #0f172a; color: #e2e8f0; margin: 0; padding: 0; }
  .container { max-width: 720px; margin: 0 auto; padding: 40px 24px 80px; }
  h1 { font-size: 22px; margin: 0 0 4px; }
  a { color: #7dd3fc; }
</style>
</head>
<body>
<div class="container">
  <p style="color:#94a3b8;font-size:13px;margin:0 0 32px;">Analyysi generoitu ${new Date(scan.timestamp).toLocaleDateString('fi-FI')}</p>

  <h1>Sivustoanalyysi</h1>
  <p style="color:#94a3b8;margin:4px 0 32px;"><a href="${scan.url}" target="_blank">${scan.url}</a></p>

  <div style="display:flex;gap:20px;flex-wrap:wrap;margin-bottom:40px;">
    <div style="flex:1;min-width:140px;background:#1e293b;border-radius:12px;padding:20px;text-align:center;">
      <div style="font-size:48px;font-weight:800;color:${scoreColor};">${scan.score}</div>
      <div style="color:#94a3b8;font-size:13px;">/ 100 pistettä</div>
    </div>
    <div style="flex:1;min-width:140px;background:#1e293b;border-radius:12px;padding:20px;text-align:center;">
      <div style="font-size:48px;font-weight:800;color:#fb923c;">${issueCount}</div>
      <div style="color:#94a3b8;font-size:13px;">vakavaa ongelmaa</div>
    </div>
    <div style="flex:1;min-width:140px;background:#1e293b;border-radius:12px;padding:20px;text-align:center;">
      <div style="font-size:48px;font-weight:800;color:#94a3b8;">${scan.violations.length}</div>
      <div style="color:#94a3b8;font-size:13px;">ongelmaa yhteensä</div>
    </div>
    ${benchmark ? `
    <div style="flex:1;min-width:140px;background:#1a1f2e;border:1px solid #334155;border-radius:12px;padding:20px;text-align:center;">
      <div style="font-size:48px;font-weight:800;color:#94a3b8;">${benchmark.avg}</div>
      <div style="color:#94a3b8;font-size:13px;">keskiarvo (${benchmark.total} sivustoa)</div>
      <div style="margin-top:8px;font-size:12px;font-weight:700;color:${scan.score < benchmark.avg ? '#fb923c' : '#00D4AA'};">
        ${scan.score < benchmark.avg ? `${benchmark.avg - scan.score} pistettä alle` : `${scan.score - benchmark.avg} pistettä yli`} keskiarvon
      </div>
    </div>` : ''}
  </div>

  ${lead.aiSummary ? `
  <div style="background:#1e1a2e;border:1px solid #6d28d9;border-radius:12px;padding:24px;margin-bottom:40px;">
    <p style="margin:0 0 12px;font-size:13px;font-weight:700;color:#a78bfa;letter-spacing:1px;text-transform:uppercase;">Yhteenveto johdolle</p>
    <div style="color:#e2e8f0;line-height:1.7;white-space:pre-line;">${lead.aiSummary}</div>
  </div>` : ''}

  ${(scan as any).smallTouchTargets > 0 || (scan as any).focusOutlineIssues > 0 ? `
  <div style="background:#1c1a14;border:1px solid #713f12;border-radius:12px;padding:20px;margin-bottom:24px;display:flex;gap:24px;flex-wrap:wrap;">
    ${(scan as any).smallTouchTargets > 0 ? `<div><span style="color:#fbbf24;font-weight:700;">👆 ${(scan as any).smallTouchTargets} pientä painiketta</span> <span style="color:#94a3b8;font-size:13px;">alle 24×24px (WCAG 2.5.8 — mobiili)</span></div>` : ''}
    ${(scan as any).focusOutlineIssues > 0 ? `<div><span style="color:#fbbf24;font-weight:700;">⌨ ${(scan as any).focusOutlineIssues} elementtiä ilman focus-kehystä</span> <span style="color:#94a3b8;font-size:13px;">(WCAG 2.4.7 — näppäimistönavigointi)</span></div>` : ''}
  </div>` : ''}

  ${scan.pageBreakdown && scan.pageBreakdown.length > 1 ? `
  <div style="margin-bottom:24px;">
    <p style="font-size:13px;color:#94a3b8;margin:0 0 10px;">Tarkistettu ${scan.pageBreakdown.length} sivua:</p>
    ${scan.pageBreakdown.map((p: any) => {
      const pc = p.score >= 80 ? '#00D4AA' : p.score >= 50 ? '#f59e0b' : '#fb923c'
      return `<div style="display:flex;align-items:center;gap:12px;padding:8px 0;border-bottom:1px solid #1e293b;">
        <span style="font-weight:700;color:${pc};min-width:40px;">${p.score}</span>
        <span style="color:#94a3b8;font-size:13px;">${new URL(p.url).pathname || '/'}</span>
        ${p.critical > 0 ? `<span style="color:#fb923c;font-size:12px;">⚠ ${p.critical}</span>` : ''}
      </div>`
    }).join('')}
  </div>` : ''}

  <h2 style="font-size:16px;color:#94a3b8;margin:0 0 16px;">Löydetyt ongelmat</h2>
  ${violationRows || '<p style="color:#64748b;">Ei löydettyjä ongelmia.</p>'}

  <div style="background:#0d2b26;border:1px solid #0f766e;border-radius:12px;padding:28px;margin-top:40px;text-align:center;">
    <p style="margin:0 0 8px;font-size:18px;font-weight:700;">Haluatko ongelmat korjatuksi?</p>
    <p style="margin:0 0 20px;color:#94a3b8;">Suurin osa löydetyistä ongelmista korjataan nopeasti.</p>
    <a href="https://wpsaavutettavuus.fi" style="display:inline-block;background:#00D4AA;color:#0f172a;font-weight:700;font-size:15px;padding:13px 28px;border-radius:8px;text-decoration:none;">
      Ota yhteyttä → wpsaavutettavuus.fi
    </a>
  </div>

  <p style="text-align:center;color:#94a3b8;font-size:12px;margin-top:40px;">
    Analyysi on luotu automaattisesti axe-core / WCAG 2.2 AA -standardin mukaisesti.<br>
    ${SENDER_NAME} · <a href="https://wpsaavutettavuus.fi" style="color:#94a3b8;">wpsaavutettavuus.fi</a>
  </p>
</div>
</body>
</html>`)
})

// ── Manuaalinen skannaus ──────────────────────────────────────────────────────

app.post('/api/scan/manual', async (req, res) => {
  const { url } = req.body
  if (!url || typeof url !== 'string') return res.status(400).json({ error: 'url puuttuu' })

  let normalized = url.trim()
  if (!/^https?:\/\//i.test(normalized)) normalized = 'https://' + normalized

  try {
    new URL(normalized)
  } catch {
    return res.status(400).json({ error: 'Virheellinen URL' })
  }

  await addScanJob({ url: normalized, sendEmail: false, source: 'Manuaalinen' })
  res.json({ ok: true, url: normalized })
})

// ── Dashboard HTML ────────────────────────────────────────────────────────────

const TOL_OPTIONS = TARGET_TOLS.map(tol => `{ tol: '${tol}', name: '${TOL_NAMES[tol] ?? tol}' }`).join(',')
const YR_CATEGORIES = CATEGORIES.map(c => `{ id: '${c}', name: '${c.replace(/-/g, ' ')}' }`).join(',')

app.get('/', (_, res) => {
  res.send(/* html */`<!DOCTYPE html>
<html lang="fi">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>A11Y Lead Engine</title>
<style>
  * { box-sizing: border-box; margin: 0; padding: 0; }
  body { font-family: 'Segoe UI', sans-serif; background: #0f1923; color: #e2e8f0; min-height: 100vh; }
  header { background: #0A2540; border-bottom: 1px solid #1e3a5f; padding: 16px 32px; display: flex; align-items: center; gap: 16px; }
  header h1 { font-size: 18px; font-weight: 700; color: #fff; }
  header span { color: #00D4AA; font-size: 13px; font-weight: 600; margin-left: auto; }
  .tabs { display: flex; gap: 0; padding: 0 32px; border-bottom: 1px solid #1e3a5f; background: #0A2540; }
  .tab { padding: 12px 20px; font-size: 14px; font-weight: 600; cursor: pointer; color: #94a3b8; border-bottom: 2px solid transparent; margin-bottom: -1px; transition: color .15s; }
  .tab.active { color: #00D4AA; border-bottom-color: #00D4AA; }
  .tab:hover:not(.active) { color: #e2e8f0; }
  .page { display: none; }
  .page.active { display: block; }
  .stats { display: grid; grid-template-columns: repeat(5, 1fr); gap: 16px; padding: 24px 32px; }
  .stat { background: #1a2744; border: 1px solid #1e3a5f; border-radius: 10px; padding: 20px; }
  .stat-value { font-size: 36px; font-weight: 700; color: #00D4AA; }
  .stat-label { font-size: 13px; color: #94a3b8; margin-top: 4px; }
  .toolbar { padding: 0 32px 16px; display: flex; gap: 12px; align-items: center; }
  .toolbar input { flex: 1; max-width: 320px; padding: 8px 14px; border-radius: 8px; border: 1px solid #1e3a5f; background: #1a2744; color: #e2e8f0; font-size: 14px; outline: none; }
  .toolbar input:focus { border-color: #00D4AA; }
  .btn { padding: 8px 16px; border-radius: 8px; font-size: 13px; font-weight: 600; cursor: pointer; border: none; transition: opacity .15s; }
  .btn:hover:not(:disabled) { opacity: .85; }
  .btn:disabled { opacity: .4; cursor: not-allowed; }
  .btn-primary { background: #00D4AA; color: #000; }
  .btn-sm { padding: 5px 12px; font-size: 12px; }
  .btn-ghost { background: #1e3a5f; color: #e2e8f0; }
  .btn-lg { padding: 12px 28px; font-size: 15px; }
  table { width: 100%; border-collapse: collapse; }
  thead th { padding: 10px 16px; text-align: left; font-size: 11px; font-weight: 600; color: #94a3b8; text-transform: uppercase; letter-spacing: .05em; border-bottom: 1px solid #1e3a5f; }
  tbody tr { border-bottom: 1px solid #141e2e; transition: background .1s; }
  tbody tr:hover { background: #1a2744; }
  td { padding: 12px 16px; font-size: 14px; vertical-align: middle; }
  .domain { font-weight: 600; color: #e2e8f0; text-decoration: none; }
  .domain:hover { text-decoration: underline; }
  .score { font-weight: 700; font-size: 18px; }
  .score.green { color: #00D4AA; }
  .score.yellow { color: #f59e0b; }
  .score.red { color: #fb923c; }
  .badge { display: inline-block; padding: 2px 8px; border-radius: 4px; font-size: 11px; font-weight: 600; }
  .badge-sent { background: #0d3d2e; color: #5eead4; }
  .badge-nosend { background: #1e3a5f; color: #94a3b8; }
  .badge-noemail { background: #1f1f1f; color: #64748b; }
  .actions { display: flex; gap: 6px; }
  .table-wrap { padding: 0 32px 32px; overflow-x: auto; }
  /* Uusi ajo */
  .run-wrap { padding: 24px 32px; max-width: 860px; }
  .run-section { margin-bottom: 28px; }
  .run-section h3 { font-size: 13px; font-weight: 600; color: #94a3b8; text-transform: uppercase; letter-spacing: .06em; margin-bottom: 12px; }
  .source-cards { display: grid; grid-template-columns: repeat(3, 1fr); gap: 12px; }
  .source-card { background: #1a2744; border: 2px solid #1e3a5f; border-radius: 10px; padding: 16px 18px; cursor: pointer; transition: border-color .15s; }
  .source-card.selected { border-color: #00D4AA; }
  .source-card h4 { font-size: 14px; font-weight: 700; margin-bottom: 4px; }
  .source-card p { font-size: 12px; color: #94a3b8; line-height: 1.5; }
  .tol-grid { display: flex; flex-wrap: wrap; gap: 8px; }
  .tol-chip { display: flex; align-items: center; gap: 6px; background: #1a2744; border: 1px solid #1e3a5f; border-radius: 6px; padding: 6px 12px; cursor: pointer; font-size: 13px; transition: border-color .15s, background .15s; user-select: none; }
  .tol-chip.selected { background: #0d3d2e; border-color: #00D4AA; color: #00D4AA; }
  .tol-chip input { display: none; }
  .run-row { display: flex; gap: 16px; align-items: flex-end; margin-bottom: 20px; }
  .run-field { display: flex; flex-direction: column; gap: 6px; }
  .run-field label { font-size: 12px; color: #94a3b8; font-weight: 600; }
  .run-field input[type=number] { width: 100px; padding: 8px 12px; border-radius: 8px; border: 1px solid #1e3a5f; background: #1a2744; color: #e2e8f0; font-size: 14px; outline: none; }
  .run-field input[type=number]:focus { border-color: #00D4AA; }
  .toggle-wrap { display: flex; align-items: center; gap: 8px; font-size: 14px; cursor: pointer; padding-bottom: 2px; }
  .toggle { width: 40px; height: 22px; background: #1e3a5f; border-radius: 11px; position: relative; transition: background .2s; flex-shrink: 0; }
  .toggle.on { background: #00D4AA; }
  .toggle::after { content:''; position: absolute; width: 16px; height: 16px; background: #fff; border-radius: 50%; top: 3px; left: 3px; transition: left .2s; }
  .toggle.on::after { left: 21px; }
  .log-box { background: #090f18; border: 1px solid #1e3a5f; border-radius: 8px; padding: 16px; height: 280px; overflow-y: auto; font-family: 'Menlo', 'Consolas', monospace; font-size: 12px; line-height: 1.7; }
  .log-line { color: #94a3b8; }
  .log-line.info { color: #60a5fa; }
  .log-line.done { color: #00D4AA; font-weight: 700; }
  .log-line.error { color: #fb923c; }
  .log-ts { color: #64748b; margin-right: 8px; }
  .status-dot { width: 8px; height: 8px; border-radius: 50%; background: #334155; display: inline-block; }
  .status-dot.running { background: #00D4AA; animation: pulse 1s infinite; }
  @keyframes pulse { 0%,100%{opacity:1} 50%{opacity:.4} }
  /* Modal */
  .modal-bg { display: none; position: fixed; inset: 0; background: rgba(0,0,0,.7); z-index: 100; align-items: center; justify-content: center; }
  .modal-bg.open { display: flex; }
  .modal { background: #1a2744; border: 1px solid #1e3a5f; border-radius: 12px; padding: 28px; min-width: 360px; }
  .modal h3 { margin-bottom: 16px; font-size: 16px; }
  .modal input { width: 100%; padding: 9px 14px; border-radius: 8px; border: 1px solid #1e3a5f; background: #0f1923; color: #e2e8f0; font-size: 14px; margin-bottom: 14px; outline: none; }
  .modal input:focus { border-color: #00D4AA; }
  .modal-actions { display: flex; gap: 8px; justify-content: flex-end; }
  .toast { position: fixed; bottom: 24px; right: 24px; background: #0d3d2e; color: #5eead4; border: 1px solid #0f766e; padding: 12px 20px; border-radius: 8px; font-size: 14px; font-weight: 600; opacity: 0; transition: opacity .3s; pointer-events: none; z-index: 200; }
  .toast.show { opacity: 1; }
  .empty { text-align: center; padding: 60px; color: #94a3b8; }
  .active-filter { border: 1px solid #00D4AA !important; color: #00D4AA !important; }
</style>
</head>
<body>

<header>
  <h1>A11Y Lead Engine</h1>
  <span id="header-count">Ladataan...</span>
</header>

<div class="tabs">
  <div class="tab active" onclick="switchTab('leads')">Leadit</div>
  <div class="tab" onclick="switchTab('run')">Uusi ajo</div>
  <div class="tab" onclick="switchTab('manual')">Manuaalinen</div>
  <div class="tab" onclick="switchTab('monitor')">Seuranta</div>
</div>

<!-- LEADIT -->
<div class="page active" id="page-leads">
  <div class="stats">
    <div class="stat"><div class="stat-value" id="s-total">–</div><div class="stat-label">Leadeja yhteensä</div></div>
    <div class="stat"><div class="stat-value" id="s-email">–</div><div class="stat-label">Löydetty sähköposti</div></div>
    <div class="stat"><div class="stat-value" id="s-sent">–</div><div class="stat-label">Lähetetty</div></div>
    <div class="stat"><div class="stat-value" id="s-avg">–</div><div class="stat-label">Keskipisteet</div></div>
    <div class="stat"><div class="stat-value" id="s-converted" style="color:#00D4AA">–</div><div class="stat-label">Konvertoitu</div></div>
  </div>
  <div class="toolbar">
    <input id="search" placeholder="Hae domainilla tai yrityksellä..." oninput="render()">
    <label class="toggle-wrap" style="font-size:13px;" onclick="toggleHotOnly()">
      <div class="toggle" id="hot-toggle"></div>
      Näytä vain parhaat (6+ p.)
    </label>
    <div style="display:flex;gap:4px;" id="status-filter-btns">
      <button class="btn btn-ghost btn-sm active-filter" id="sf-all" onclick="setStatusFilter('all')">Kaikki</button>
      <button class="btn btn-ghost btn-sm" id="sf-nosend" onclick="setStatusFilter('nosend')">Ei lähetetty</button>
      <button class="btn btn-ghost btn-sm" id="sf-sent" onclick="setStatusFilter('sent')">Lähetetty</button>
      <button class="btn btn-ghost btn-sm" id="sf-noemail" onclick="setStatusFilter('noemail')">Ei sähköpostia</button>
    </div>
    <button class="btn btn-ghost btn-sm" onclick="load()">↻ Päivitä</button>
    <span id="bulk-bar" style="display:none;align-items:center;gap:8px;">
      <span id="bulk-count" style="font-size:13px;color:#94a3b8;"></span>
      <button class="btn btn-sm" style="background:#431407;color:#fed7aa" onclick="bulkDelete()">Poista valitut</button>
      <button class="btn btn-ghost btn-sm" onclick="clearSelection()">Peruuta</button>
    </span>
  </div>
  <div class="table-wrap">
    <table>
      <thead>
        <tr>
          <th><input type="checkbox" id="select-all" onchange="toggleSelectAll(this.checked)" style="cursor:pointer"></th>
          <th>#</th>
          <th>Domain</th>
          <th>Yritys</th>
          <th>TOL</th>
          <th onclick="sortScore()" style="cursor:pointer;user-select:none">Pisteet<span id="score-sort-icon"> ↕</span></th>
          <th>Konversio</th>
          <th>Liikevaihto</th>
          <th>Ongelmat</th>
          <th>Sähköposti</th>
          <th>Tila</th>
          <th>Lähde</th>
          <th>Skannattu</th>
          <th>Toiminnot</th>
        </tr>
      </thead>
      <tbody id="tbody"></tbody>
    </table>
    <div id="empty" class="empty" style="display:none">Ei leadeja vielä.</div>
  </div>
</div>

<!-- UUSI AJO -->
<div class="page" id="page-run">
  <div class="run-wrap">

    <div class="run-section">
      <h3>Hakemisto</h3>
      <div class="source-cards">
        <div class="source-card selected" id="src-duckduckgo" onclick="selectSource('duckduckgo')">
          <h4>DuckDuckGo</h4>
          <p>Hakee suomalaisia WordPress-sivustoja hakukoneesta.</p>
        </div>
        <div class="source-card" id="src-tranco" onclick="selectSource('tranco')">
          <h4>Tranco .fi</h4>
          <p>Top .fi-domainit liikenteen mukaan järjestettynä.</p>
        </div>
        <div class="source-card" id="src-yritykset" onclick="selectSource('yritykset')">
          <h4>yritykset.fi</h4>
          <p>Hakemistopohjainen haku toimialoittain.</p>
        </div>
      </div>
    </div>

    <div class="run-section" id="yr-categories-section" style="display:none">
      <h3>Toimialat (yritykset.fi)</h3>
      <div class="tol-grid" id="yr-cats"></div>
    </div>

    <div class="run-section">
      <h3>Toimialasuodatus (YTJ)</h3>
      <p style="font-size:13px;color:#64748b;margin-bottom:12px;">Jos valitset toimialan, YTJ tarkistetaan jokaisen domainin kohdalla ja muut ohitetaan. Tuntemattomia yrityksiä ei ohiteta.</p>
      <div class="tol-grid" id="tol-chips"></div>
    </div>

    <div class="run-row">
      <div class="run-field">
        <label>Maksimimäärä</label>
        <input type="number" id="run-limit" value="50" min="5" max="500">
      </div>
      <div class="run-field">
        <label style="opacity:0">toggle</label>
        <label class="toggle-wrap" onclick="toggleEmail()">
          <div class="toggle" id="email-toggle"></div>
          Lähetä sähköposti (pois = dry run)
        </label>
      </div>
      <div class="run-field">
        <label style="opacity:0">btn</label>
        <button class="btn btn-primary btn-lg" id="run-btn" onclick="startRun()">Aloita ajo</button>
      </div>
    </div>

    <div class="run-section">
      <h3 style="display:flex;align-items:center;gap:8px;">
        Loki <span class="status-dot" id="run-dot"></span>
      </h3>
      <div class="log-box" id="log-box"></div>
    </div>

  </div>
</div>

<!-- MANUAALINEN SKANNAUS -->
<div class="page" id="page-manual">
  <div class="run-wrap">
    <div class="run-section">
      <h3>Manuaalinen skannaus</h3>
      <p style="font-size:13px;color:#64748b;margin-bottom:16px;">Syötä URL ja lisää se skannausjonoon. Worker käsittelee sen seuraavaksi.</p>
      <div style="display:flex;gap:12px;align-items:center;">
        <input id="manual-url" type="text" placeholder="https://esimerkki.fi" style="flex:1;max-width:480px;padding:9px 14px;border-radius:8px;border:1px solid #1e3a5f;background:#1a2744;color:#e2e8f0;font-size:14px;outline:none;" onkeydown="if(event.key==='Enter')scanManual()">
        <button class="btn btn-primary" onclick="scanManual()">Skannaa</button>
      </div>
      <div id="manual-result" style="margin-top:12px;font-size:13px;"></div>
    </div>
  </div>
</div>

<!-- SEURANTA -->
<div class="page" id="page-monitor">
  <div class="run-wrap">
    <div class="run-section">
      <h3 style="display:flex;align-items:center;gap:12px;">
        Muutosseuranta
        <span class="status-dot" id="monitor-dot"></span>
      </h3>
      <p style="font-size:13px;color:#64748b;margin-bottom:16px;">
        Tarkistaa kaikkien domainien HTML-sisällön muutokset. Jos muutos ylittää 20 %, domain lisätään automaattisesti skannausjonoon.
      </p>
      <div style="display:flex;gap:12px;align-items:center;margin-bottom:20px;">
        <button class="btn btn-primary" id="monitor-btn" onclick="startMonitor()">Aja seuranta nyt</button>
        <label class="toggle-wrap" onclick="toggleMonitorEmail()">
          <div class="toggle" id="monitor-email-toggle"></div>
          Lähetä sähköposti muuttuneille
        </label>
      </div>
      <div class="log-box" id="monitor-log"></div>
    </div>

    <div class="run-section" style="margin-top:24px;">
      <h3 style="display:flex;align-items:center;justify-content:space-between;">
        Seuratut domainit
        <button class="btn btn-ghost btn-sm" onclick="loadMonitorDomains()">↻ Päivitä</button>
      </h3>
      <div class="table-wrap" style="padding:0;margin-top:12px;">
        <table>
          <thead>
            <tr>
              <th>Domain</th>
              <th>Yritys</th>
              <th>TOL</th>
              <th>Muutos</th>
              <th>Tila</th>
              <th>Tarkistettu</th>
            </tr>
          </thead>
          <tbody id="monitor-tbody"></tbody>
        </table>
        <div id="monitor-empty" class="empty" style="display:none">Ei seurattavia domaineja. Lisää skannaamalla ensin sivustoja.</div>
      </div>
    </div>
  </div>
</div>

<!-- MODAL -->
<div class="modal-bg" id="modal">
  <div class="modal">
    <h3 id="modal-title">Lähetä yhteenveto</h3>
    <input id="modal-email" type="email" placeholder="vastaanottaja@email.fi">
    <div class="modal-actions">
      <button class="btn btn-ghost btn-sm" onclick="closeModal()">Peruuta</button>
      <button class="btn btn-ghost btn-sm" id="modal-save-btn" onclick="saveEmail()">Tallenna</button>
      <button class="btn btn-primary btn-sm" id="modal-send-btn" onclick="doSendEmail()">Lähetä</button>
    </div>
  </div>
</div>

<div class="toast" id="toast"></div>

<!-- MUISTIINPANOT MODAL -->
<div id="notes-modal" style="display:none;position:fixed;inset:0;background:rgba(0,0,0,0.7);z-index:1000;align-items:center;justify-content:center;">
  <div style="background:#1e293b;border-radius:12px;padding:24px;width:480px;max-width:90vw;">
    <h3 style="margin:0 0 16px;color:#f1f5f9">Muistiinpanot</h3>
    <input type="hidden" id="notes-lead-id">
    <textarea id="notes-textarea" rows="8" style="width:100%;background:#0f172a;color:#f1f5f9;border:1px solid #334155;border-radius:8px;padding:12px;font-size:14px;resize:vertical;box-sizing:border-box;" placeholder="Kirjoita muistiinpanoja tästä asiakkaasta..."></textarea>
    <div style="display:flex;gap:8px;justify-content:flex-end;margin-top:12px;">
      <button class="btn btn-ghost btn-sm" onclick="closeNotes()">Peruuta</button>
      <button class="btn btn-primary btn-sm" onclick="saveNotes()">Tallenna</button>
    </div>
  </div>
</div>

<script>
// ── Data ──────────────────────────────────────────────────────────────────────
let leads = []
let activeLead = null
let selectedSource = 'duckduckgo'
let sendEmailOn = true
let selectedTols = []
let selectedYrCats = []
let runEvtSource = null
let hotOnly = false
let statusFilter = 'all' // 'all' | 'sent' | 'nosend' | 'noemail'
let scoreSort = null // null | 'desc' | 'asc'
let selectedIds = new Set()

const TOL_OPTIONS = [${TOL_OPTIONS}]
const YR_CATEGORIES = [${YR_CATEGORIES}]

// ── Tabs ──────────────────────────────────────────────────────────────────────
function switchTab(tab) {
  document.querySelectorAll('.tab').forEach((t, i) => t.classList.toggle('active', ['leads','run','manual','monitor'][i] === tab))
  document.querySelectorAll('.page').forEach(p => p.classList.remove('active'))
  document.getElementById('page-' + tab).classList.add('active')
  if (tab === 'monitor') loadMonitorDomains()
}

// ── Stats & Leads ─────────────────────────────────────────────────────────────
async function load() {
  const [statsRes, leadsRes] = await Promise.all([fetch('/api/stats'), fetch('/api/leads')])
  const stats = await statsRes.json()
  leads = await leadsRes.json()
  document.getElementById('s-total').textContent = stats.total
  document.getElementById('s-email').textContent = stats.withEmail
  document.getElementById('s-sent').textContent = stats.sent
  document.getElementById('s-avg').textContent = stats.avg + '/100'
  document.getElementById('s-converted').textContent = stats.converted
  document.getElementById('header-count').textContent = stats.total + ' leadiä'
  render()
}

function convDots(pts) {
  // Normalisoi 0–15 → 0–5 pistettä
  const dots = pts >= 12 ? 5 : pts >= 9 ? 4 : pts >= 6 ? 3 : pts >= 3 ? 2 : pts > 0 ? 1 : 0
  const color = dots === 5 ? '#00D4AA' : dots >= 4 ? '#5eead4' : dots >= 3 ? '#f59e0b' : '#64748b'
  const filled = '●'.repeat(dots)
  const empty = '○'.repeat(5 - dots)
  return \`<span style="color:\${color};font-size:15px;letter-spacing:1px" title="\${pts} pistettä">\${filled}\${empty}</span>\`
}

function toggleHotOnly() {
  hotOnly = !hotOnly
  document.getElementById('hot-toggle').classList.toggle('on', hotOnly)
  render()
}

function setStatusFilter(val) {
  statusFilter = val
  document.querySelectorAll('#status-filter-btns .btn').forEach(b => b.classList.remove('active-filter'))
  document.getElementById('sf-' + val).classList.add('active-filter')
  render()
}

function sortScore() {
  scoreSort = scoreSort === 'desc' ? 'asc' : 'desc'
  render()
}

function render() {
  const q = document.getElementById('search').value.toLowerCase()
  let filtered = leads.filter(l =>
    l.domain.url.toLowerCase().includes(q) || (l.domain.company || '').toLowerCase().includes(q)
  )
  filtered = filtered.filter(l => l.scan.score < 100)
  if (statusFilter === 'sent') filtered = filtered.filter(l => l.emailSent)
  else if (statusFilter === 'nosend') filtered = filtered.filter(l => !l.emailSent && l.email)
  else if (statusFilter === 'noemail') filtered = filtered.filter(l => !l.email)
  if (hotOnly) {
    filtered = filtered.filter(l => l.conversionScore >= 6)
    filtered.sort((a, b) => b.conversionScore - a.conversionScore)
  }
  if (scoreSort === 'desc') filtered.sort((a, b) => b.scan.score - a.scan.score)
  else if (scoreSort === 'asc') filtered.sort((a, b) => a.scan.score - b.scan.score)
  const icon = document.getElementById('score-sort-icon')
  if (icon) icon.textContent = scoreSort === 'desc' ? ' ↓' : scoreSort === 'asc' ? ' ↑' : ' ↕'
  const tbody = document.getElementById('tbody')
  const empty = document.getElementById('empty')
  if (!filtered.length) { tbody.innerHTML = ''; empty.style.display = ''; return }
  empty.style.display = 'none'
  tbody.innerHTML = filtered.map(l => {
    const score = l.scan.score
    const cls = score >= 80 ? 'green' : score >= 50 ? 'yellow' : 'red'
    const domain = new URL(l.domain.url).hostname
    const date = new Date(l.createdAt).toLocaleDateString('fi-FI')
    const emailBadge = l.emailSent
      ? '<span class="badge badge-sent">✓ Lähetetty</span>'
      : l.email ? '<span class="badge badge-nosend">Ei lähetetty</span>'
      : '<span class="badge badge-noemail">Ei sähköpostia</span>'
    const isHot = l.conversionScore >= 9
    const hotRow = isHot ? ' style="background:#0d2b26"' : l.convertedAt ? ' style="background:#0d2b26"' : ''
    const viewBadge = l.reportViewCount > 0
      ? \`<span style="color:#00D4AA;font-size:11px;font-weight:700;margin-left:4px" title="Analyysi katsottu \${l.reportViewCount}x">👁 \${l.reportViewCount}</span>\`
      : ''
    const dropBadge = l.scoreDropAlert
      ? \`<span style="color:#fb923c;font-size:11px;font-weight:700;margin-left:4px" title="Score laski edellisestä skannauksesta">↓ drop</span>\`
      : ''
    const convertedLabel = l.convertedAt ? '✓ Konv.' : 'Konv?'
    const convertedStyle = l.convertedAt ? 'background:#0d3d2e;color:#5eead4' : 'background:#1e3a5f;color:#94a3b8'
    return \`<tr\${hotRow}>
      <td><input type="checkbox" data-id="\${l.id}" \${selectedIds.has(l.id) ? 'checked' : ''} onchange="toggleSelect('\${l.id}', this.checked)" style="cursor:pointer"></td>
      <td style="font-size:12px;color:#64748b;font-weight:600">#\${l.leadNo}</td>
      <td><a href="\${l.domain.url}" target="_blank" class="domain">\${domain}</a>\${viewBadge}\${dropBadge}</td>
      <td style="font-size:13px;color:#94a3b8">\${l.domain.company || '–'}</td>
      <td style="font-size:12px;color:#64748b">\${l.domain.tol ? 'TOL ' + l.domain.tol : '–'}</td>
      <td><span class="score \${cls}">\${score}</span>\${l.scan.pagesScanned > 1 ? \`<span style="font-size:10px;color:#64748b;margin-left:4px">\${l.scan.pagesScanned}s</span>\` : ''}</td>
      <td>\${convDots(l.conversionScore)}</td>
      <td style="font-size:12px;color:#94a3b8">\${l.domain.revenue ? (l.domain.revenue >= 1_000_000 ? (l.domain.revenue/1_000_000).toFixed(1) + ' M€' : Math.round(l.domain.revenue/1000) + ' t€') : '–'}</td>
      <td style="color:#94a3b8;font-size:13px">
        \${l.scan.critical > 0 ? '<span style="color:#fb923c">⚠ ' + l.scan.critical + ' kriit.</span> ' : ''}
        \${l.scan.serious > 0 ? '<span style="color:#f59e0b">' + l.scan.serious + ' vak.</span>' : ''}
        \${l.scan.critical === 0 && l.scan.serious === 0 ? '–' : ''}
      </td>
      <td style="font-size:13px;color:#94a3b8;white-space:nowrap">\${l.email || '–'} <button class="btn btn-sm" style="background:transparent;color:#64748b;padding:1px 5px;font-size:12px;vertical-align:middle" onclick="openEditEmail('\${l.id}','\${l.email || ''}')" title="Muokkaa sähköpostia">✎</button></td>
      <td>\${emailBadge}</td>
      <td style="font-size:11px;color:#64748b;max-width:120px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis" title="\${l.source || ''}">\${l.source || '–'}</td>
      <td style="font-size:12px;color:#64748b">\${date}</td>
      <td><div class="actions">
        <a href="/api/leads/\${l.id}/pdf" target="_blank"><button class="btn btn-ghost btn-sm">PDF</button></a>
        <button class="btn btn-primary btn-sm" onclick="openModal('\${l.id}', '\${l.email || ''}')">
          \${l.emailSent ? 'Uudelleen' : 'Lähetä'}
        </button>
        <button class="btn btn-sm" style="\${convertedStyle}" onclick="toggleConvert('\${l.id}')">\${convertedLabel}</button>
        <button class="btn btn-sm" style="background:#1e293b;color:\${l.notes ? '#00D4AA' : '#64748b'}" onclick="openNotes('\${l.id}')" title="\${l.notes ? 'Muistiinpanoja kirjoitettu' : 'Lisää muistiinpanoja'}">✎</button>
        <button class="btn btn-sm" style="background:#1e293b;color:#fb923c" onclick="deleteLead('\${l.id}')">Poista</button>
      </div></td>
    </tr>\`
  }).join('')
  updateBulkBar()
}

// ── Uusi ajo ──────────────────────────────────────────────────────────────────
function initRunPage() {
  // TOL-chipit
  const tolGrid = document.getElementById('tol-chips')
  TOL_OPTIONS.forEach(o => {
    const chip = document.createElement('label')
    chip.className = 'tol-chip'
    chip.innerHTML = \`<input type="checkbox" value="\${o.tol}"> \${o.name}\`
    chip.querySelector('input').addEventListener('change', e => {
      if (e.target.checked) selectedTols.push(o.tol)
      else selectedTols = selectedTols.filter(t => t !== o.tol)
      chip.classList.toggle('selected', e.target.checked)
    })
    tolGrid.appendChild(chip)
  })

  // yritykset.fi kategoriat
  const yrGrid = document.getElementById('yr-cats')
  YR_CATEGORIES.forEach(o => {
    const chip = document.createElement('label')
    chip.className = 'tol-chip'
    chip.innerHTML = \`<input type="checkbox" value="\${o.id}"> \${o.name}\`
    chip.querySelector('input').addEventListener('change', e => {
      if (e.target.checked) selectedYrCats.push(o.id)
      else selectedYrCats = selectedYrCats.filter(c => c !== o.id)
      chip.classList.toggle('selected', e.target.checked)
    })
    yrGrid.appendChild(chip)
  })
}

function selectSource(src) {
  selectedSource = src
  document.querySelectorAll('.source-card').forEach(c => c.classList.remove('selected'))
  document.getElementById('src-' + src).classList.add('selected')
  document.getElementById('yr-categories-section').style.display = src === 'yritykset' ? '' : 'none'
}

function toggleEmail() {
  sendEmailOn = !sendEmailOn
  document.getElementById('email-toggle').classList.toggle('on', sendEmailOn)
}

async function startRun() {
  const btn = document.getElementById('run-btn')
  const dot = document.getElementById('run-dot')
  btn.disabled = true
  btn.textContent = 'Käynnissä...'
  dot.classList.add('running')

  // Tyhjennä loki
  document.getElementById('log-box').innerHTML = ''

  // SSE
  if (runEvtSource) runEvtSource.close()
  runEvtSource = new EventSource('/api/discover/stream')
  runEvtSource.onmessage = e => {
    const d = JSON.parse(e.data)
    appendLog(d.ts, d.msg, d.type)
    if (d.type === 'done' || d.type === 'error') {
      btn.disabled = false
      btn.textContent = 'Aloita ajo'
      dot.classList.remove('running')
      runEvtSource.close()
      load()
    }
  }

  const limit = parseInt(document.getElementById('run-limit').value) || 50

  await fetch('/api/discover', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      source: selectedSource,
      limit,
      sendEmail: sendEmailOn,
      tolFilter: selectedTols,
      categories: selectedYrCats,
    })
  })
}

async function toggleConvert(id) {
  await fetch(\`/api/leads/\${id}/convert\`, { method: 'POST' })
  await load()
}

async function deleteLead(id) {
  if (!confirm('Poistetaanko tämä lead?')) return
  await fetch(\`/api/leads/\${id}\`, { method: 'DELETE' })
  await load()
}

function toggleSelect(id, checked) {
  if (checked) selectedIds.add(id)
  else selectedIds.delete(id)
  updateBulkBar()
}

function toggleSelectAll(checked) {
  document.querySelectorAll('#tbody input[type=checkbox]').forEach(cb => {
    const id = cb.dataset.id
    if (!id) return
    cb.checked = checked
    if (checked) selectedIds.add(id)
    else selectedIds.delete(id)
  })
  updateBulkBar()
}

function updateBulkBar() {
  const bar = document.getElementById('bulk-bar')
  const count = document.getElementById('bulk-count')
  const selectAll = document.getElementById('select-all')
  if (selectedIds.size > 0) {
    bar.style.display = 'flex'
    count.textContent = selectedIds.size + ' valittu'
  } else {
    bar.style.display = 'none'
  }
  const allBoxes = document.querySelectorAll('#tbody input[type=checkbox]')
  if (selectAll) selectAll.checked = allBoxes.length > 0 && [...allBoxes].every(cb => cb.checked)
}

function clearSelection() {
  selectedIds.clear()
  document.querySelectorAll('#tbody input[type=checkbox]').forEach(cb => cb.checked = false)
  const selectAll = document.getElementById('select-all')
  if (selectAll) selectAll.checked = false
  updateBulkBar()
}

async function bulkDelete() {
  if (selectedIds.size === 0) return
  if (!confirm(\`Poistetaanko \${selectedIds.size} leadia?\`)) return
  await fetch('/api/leads', {
    method: 'DELETE',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ ids: [...selectedIds] })
  })
  selectedIds.clear()
  await load()
}

function openNotes(id) {
  const lead = leads.find(l => l.id === id)
  document.getElementById('notes-lead-id').value = id
  document.getElementById('notes-textarea').value = lead?.notes || ''
  document.getElementById('notes-modal').style.display = 'flex'
  document.getElementById('notes-textarea').focus()
}

function closeNotes() {
  document.getElementById('notes-modal').style.display = 'none'
}

async function saveNotes() {
  const id = document.getElementById('notes-lead-id').value
  const notes = document.getElementById('notes-textarea').value
  await fetch(\`/api/leads/\${id}/notes\`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ notes })
  })
  closeNotes()
  await load()
}

function appendLog(ts, msg, type = 'log') {
  const box = document.getElementById('log-box')
  const line = document.createElement('div')
  line.className = 'log-line ' + type
  line.innerHTML = \`<span class="log-ts">\${ts}</span>\${escHtml(msg)}\`
  box.appendChild(line)
  box.scrollTop = box.scrollHeight
}

function escHtml(s) {
  return s.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;')
}

// ── Seuranta ──────────────────────────────────────────────────────────────────
let monitorEmailOn = false
let monitorEvtSource = null

function toggleMonitorEmail() {
  monitorEmailOn = !monitorEmailOn
  document.getElementById('monitor-email-toggle').classList.toggle('on', monitorEmailOn)
}

// ── Manuaalinen skannaus ──────────────────────────────────────────────────────
async function scanManual() {
  const input = document.getElementById('manual-url')
  const result = document.getElementById('manual-result')
  const url = input.value.trim()
  if (!url) return
  result.textContent = 'Lisätään jonoon...'
  result.style.color = '#94a3b8'
  try {
    const res = await fetch('/api/scan/manual', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ url }),
    })
    const data = await res.json()
    if (!res.ok) {
      result.textContent = 'Virhe: ' + (data.error ?? res.status)
      result.style.color = '#fb923c'
    } else {
      result.textContent = '✓ Lisätty jonoon: ' + data.url
      result.style.color = '#00D4AA'
      input.value = ''
    }
  } catch (e) {
    result.textContent = 'Verkkovirhe: ' + e.message
    result.style.color = '#fb923c'
  }
}

async function startMonitor() {
  const btn = document.getElementById('monitor-btn')
  const dot = document.getElementById('monitor-dot')
  btn.disabled = true
  btn.textContent = 'Käynnissä...'
  dot.classList.add('running')
  document.getElementById('monitor-log').innerHTML = ''

  if (monitorEvtSource) monitorEvtSource.close()
  monitorEvtSource = new EventSource('/api/discover/stream')
  monitorEvtSource.onmessage = e => {
    const d = JSON.parse(e.data)
    const box = document.getElementById('monitor-log')
    const line = document.createElement('div')
    line.className = 'log-line ' + d.type
    line.innerHTML = \`<span class="log-ts">\${d.ts}</span>\${escHtml(d.msg)}\`
    box.appendChild(line)
    box.scrollTop = box.scrollHeight
    if (d.type === 'done' || d.type === 'error') {
      btn.disabled = false
      btn.textContent = 'Aja seuranta nyt'
      dot.classList.remove('running')
      monitorEvtSource.close()
      loadMonitorDomains()
    }
  }

  await fetch('/api/monitor/run', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ sendEmail: monitorEmailOn })
  })
}

async function loadMonitorDomains() {
  const domains = await fetch('/api/monitor/domains').then(r => r.json())
  const tbody = document.getElementById('monitor-tbody')
  const empty = document.getElementById('monitor-empty')

  if (!domains.length) { tbody.innerHTML = ''; empty.style.display = ''; return }
  empty.style.display = 'none'

  tbody.innerHTML = domains.map(d => {
    const hostname = new URL(d.url).hostname
    const checked = d.lastMonitored ? new Date(d.lastMonitored).toLocaleDateString('fi-FI') : '–'
    const pct = d.changePercent

    let statusBadge, changeTxt
    if (d.htmlHash === null) {
      statusBadge = '<span class="badge badge-nosend">Ei tarkistettu</span>'
      changeTxt = '–'
    } else if (pct === null || pct === 0) {
      statusBadge = '<span class="badge badge-noemail">Ei muutosta</span>'
      changeTxt = '–'
    } else if (pct >= 20) {
      statusBadge = '<span class="badge" style="background:#431407;color:#fed7aa">⚡ Muutos</span>'
      changeTxt = '<span style="color:#fb923c;font-weight:700">' + pct + '%</span>'
    } else {
      statusBadge = '<span class="badge badge-nosend">Pieni muutos</span>'
      changeTxt = pct + '%'
    }

    return \`<tr>
      <td><span class="domain">\${hostname}</span></td>
      <td style="font-size:13px;color:#94a3b8">\${d.company || '–'}</td>
      <td style="font-size:12px;color:#64748b">\${d.tol ? 'TOL ' + d.tol : '–'}</td>
      <td style="font-size:13px">\${changeTxt}</td>
      <td>\${statusBadge}</td>
      <td style="font-size:12px;color:#64748b">\${checked}</td>
    </tr>\`
  }).join('')
}

// ── Modal ─────────────────────────────────────────────────────────────────────
function openModal(id, email) {
  activeLead = id
  document.getElementById('modal-email').value = email
  document.getElementById('modal-title').textContent = 'Lähetä yhteenveto'
  document.getElementById('modal-send-btn').style.display = ''
  document.getElementById('modal').classList.add('open')
  document.getElementById('modal-email').focus()
}

function openEditEmail(id, email) {
  activeLead = id
  document.getElementById('modal-email').value = email
  document.getElementById('modal-title').textContent = 'Muokkaa sähköpostia'
  document.getElementById('modal-send-btn').style.display = 'none'
  document.getElementById('modal').classList.add('open')
  document.getElementById('modal-email').focus()
}

function closeModal() {
  document.getElementById('modal').classList.remove('open')
  document.getElementById('modal-send-btn').style.display = ''
  activeLead = null
}

async function saveEmail() {
  const email = document.getElementById('modal-email').value.trim()
  const btn = document.getElementById('modal-save-btn')
  btn.textContent = 'Tallennetaan...'
  btn.disabled = true
  const res = await fetch('/api/leads/' + activeLead + '/email', {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email })
  })
  btn.textContent = 'Tallenna'
  btn.disabled = false
  closeModal()
  if (res.ok) { showToast('Sähköposti tallennettu!'); await load() }
  else showToast('Virhe tallennuksessa', true)
}

async function doSendEmail() {
  const email = document.getElementById('modal-email').value
  if (!email) return
  const btn = document.getElementById('modal-send-btn')
  btn.textContent = 'Lähetetään...'
  btn.disabled = true
  const res = await fetch('/api/leads/' + activeLead + '/send', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email })
  })
  btn.textContent = 'Lähetä'
  btn.disabled = false
  closeModal()
  if (res.ok) { showToast('Sähköposti lähetetty!'); await load() }
  else showToast('Virhe lähetyksessä', true)
}

function showToast(msg, err = false) {
  const t = document.getElementById('toast')
  t.textContent = msg
  t.style.background = err ? '#431407' : '#0d3d2e'
  t.style.color = err ? '#fed7aa' : '#5eead4'
  t.classList.add('show')
  setTimeout(() => t.classList.remove('show'), 3000)
}

document.getElementById('modal').addEventListener('click', e => {
  if (e.target === document.getElementById('modal')) closeModal()
})

// ── Init ──────────────────────────────────────────────────────────────────────
initRunPage()
document.getElementById('email-toggle').classList.toggle('on', sendEmailOn)
load()
setInterval(load, 30000)
</script>
</body>
</html>`)
})

// ── Start ─────────────────────────────────────────────────────────────────────

const PORT = process.env.DASHBOARD_PORT ?? 3030
app.listen(PORT, () => {
  console.log(`Dashboard käynnissä: http://localhost:${PORT}`)
})
