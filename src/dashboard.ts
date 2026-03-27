import 'dotenv/config'
import express from 'express'
import path from 'path'
import fs from 'fs'
import { db } from './db/client'
import { scanUrl } from './scanner'
import { generatePdf } from './pdf'
import { findEmail } from './enrichment'
import { sendReport } from './mailer'

const app = express()
app.use(express.json())

const SENDER_NAME = process.env.SENDER_NAME ?? 'WP Saavutettavuus'
const SENDER_URL  = process.env.SENDER_URL  ?? 'https://wpsaavutettavuus.fi'
const REPORTS_DIR = path.join(process.cwd(), 'reports')

// ── API ───────────────────────────────────────────────────────────────────────

app.get('/api/stats', async (_, res) => {
  const [total, sent, leads] = await Promise.all([
    db.lead.count(),
    db.lead.count({ where: { emailSent: true } }),
    db.lead.findMany({
      include: { scan: true },
      orderBy: { createdAt: 'desc' },
    }),
  ])
  const scores = leads.map((l) => l.scan.score)
  const avg = scores.length ? Math.round(scores.reduce((a, b) => a + b, 0) / scores.length) : 0
  const withEmail = leads.filter((l) => l.email).length
  res.json({ total, sent, avg, withEmail })
})

app.get('/api/leads', async (_, res) => {
  const leads = await db.lead.findMany({
    include: { domain: true, scan: true },
    orderBy: { createdAt: 'desc' },
  })
  res.json(leads)
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

  await sendReport({ to: emailTo, scan, pdf, senderName: SENDER_NAME, senderUrl: SENDER_URL })
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

// ── Dashboard HTML ────────────────────────────────────────────────────────────

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
  header { background: #0A2540; border-bottom: 1px solid #1e3a5f; padding: 16px 32px; display: flex; align-items: center; gap: 12px; }
  header h1 { font-size: 18px; font-weight: 700; color: #fff; }
  header span { color: #00D4AA; font-size: 13px; font-weight: 600; }
  .stats { display: grid; grid-template-columns: repeat(4, 1fr); gap: 16px; padding: 24px 32px; }
  .stat { background: #1a2744; border: 1px solid #1e3a5f; border-radius: 10px; padding: 20px; }
  .stat-value { font-size: 36px; font-weight: 700; color: #00D4AA; }
  .stat-label { font-size: 13px; color: #94a3b8; margin-top: 4px; }
  .toolbar { padding: 0 32px 16px; display: flex; gap: 12px; align-items: center; }
  .toolbar input { flex: 1; max-width: 320px; padding: 8px 14px; border-radius: 8px; border: 1px solid #1e3a5f; background: #1a2744; color: #e2e8f0; font-size: 14px; outline: none; }
  .toolbar input:focus { border-color: #00D4AA; }
  .btn { padding: 8px 16px; border-radius: 8px; font-size: 13px; font-weight: 600; cursor: pointer; border: none; transition: opacity .15s; }
  .btn:hover { opacity: .85; }
  .btn-primary { background: #00D4AA; color: #000; }
  .btn-sm { padding: 5px 12px; font-size: 12px; }
  .btn-ghost { background: #1e3a5f; color: #e2e8f0; }
  .btn-danger { background: #ef4444; color: #fff; }
  table { width: 100%; border-collapse: collapse; }
  thead th { padding: 10px 16px; text-align: left; font-size: 11px; font-weight: 600; color: #64748b; text-transform: uppercase; letter-spacing: .05em; border-bottom: 1px solid #1e3a5f; }
  tbody tr { border-bottom: 1px solid #141e2e; transition: background .1s; }
  tbody tr:hover { background: #1a2744; }
  td { padding: 12px 16px; font-size: 14px; vertical-align: middle; }
  .domain { font-weight: 600; color: #e2e8f0; }
  .score { font-weight: 700; font-size: 18px; }
  .score.green { color: #22c55e; }
  .score.yellow { color: #f59e0b; }
  .score.red { color: #ef4444; }
  .badge { display: inline-block; padding: 2px 8px; border-radius: 4px; font-size: 11px; font-weight: 600; }
  .badge-sent { background: #064e3b; color: #6ee7b7; }
  .badge-nosend { background: #1e3a5f; color: #94a3b8; }
  .badge-noemail { background: #1f1f1f; color: #64748b; }
  .actions { display: flex; gap: 6px; }
  .table-wrap { padding: 0 32px 32px; overflow-x: auto; }
  .modal-bg { display: none; position: fixed; inset: 0; background: rgba(0,0,0,.7); z-index: 100; align-items: center; justify-content: center; }
  .modal-bg.open { display: flex; }
  .modal { background: #1a2744; border: 1px solid #1e3a5f; border-radius: 12px; padding: 28px; min-width: 360px; }
  .modal h3 { margin-bottom: 16px; font-size: 16px; }
  .modal input { width: 100%; padding: 9px 14px; border-radius: 8px; border: 1px solid #1e3a5f; background: #0f1923; color: #e2e8f0; font-size: 14px; margin-bottom: 14px; outline: none; }
  .modal input:focus { border-color: #00D4AA; }
  .modal-actions { display: flex; gap: 8px; justify-content: flex-end; }
  .toast { position: fixed; bottom: 24px; right: 24px; background: #064e3b; color: #6ee7b7; border: 1px solid #065f46; padding: 12px 20px; border-radius: 8px; font-size: 14px; font-weight: 600; opacity: 0; transition: opacity .3s; pointer-events: none; z-index: 200; }
  .toast.show { opacity: 1; }
  .empty { text-align: center; padding: 60px; color: #475569; }
</style>
</head>
<body>

<header>
  <h1>A11Y Lead Engine</h1>
  <span id="header-count">Ladataan...</span>
</header>

<div class="stats">
  <div class="stat"><div class="stat-value" id="s-total">–</div><div class="stat-label">Leadeja yhteensä</div></div>
  <div class="stat"><div class="stat-value" id="s-email">–</div><div class="stat-label">Löydetty sähköposti</div></div>
  <div class="stat"><div class="stat-value" id="s-sent">–</div><div class="stat-label">Lähetetty</div></div>
  <div class="stat"><div class="stat-value" id="s-avg">–</div><div class="stat-label">Keskipisteet</div></div>
</div>

<div class="toolbar">
  <input id="search" placeholder="Hae domainilla..." oninput="render()">
  <button class="btn btn-ghost btn-sm" onclick="load()">↻ Päivitä</button>
</div>

<div class="table-wrap">
  <table>
    <thead>
      <tr>
        <th>Domain</th>
        <th>Pisteet</th>
        <th>Ongelmat</th>
        <th>Sähköposti</th>
        <th>Tila</th>
        <th>Skannattu</th>
        <th>Toiminnot</th>
      </tr>
    </thead>
    <tbody id="tbody"></tbody>
  </table>
  <div id="empty" class="empty" style="display:none">Ei leadeja vielä. Aja: pnpm scan &lt;url&gt;</div>
</div>

<div class="modal-bg" id="modal">
  <div class="modal">
    <h3>Lähetä raportti</h3>
    <input id="modal-email" type="email" placeholder="vastaanottaja@email.fi">
    <div class="modal-actions">
      <button class="btn btn-ghost btn-sm" onclick="closeModal()">Peruuta</button>
      <button class="btn btn-primary btn-sm" onclick="sendEmail()">Lähetä</button>
    </div>
  </div>
</div>

<div class="toast" id="toast"></div>

<script>
let leads = []
let activeLead = null

async function load() {
  const [statsRes, leadsRes] = await Promise.all([fetch('/api/stats'), fetch('/api/leads')])
  const stats = await statsRes.json()
  leads = await leadsRes.json()

  document.getElementById('s-total').textContent = stats.total
  document.getElementById('s-email').textContent = stats.withEmail
  document.getElementById('s-sent').textContent = stats.sent
  document.getElementById('s-avg').textContent = stats.avg + '/100'
  document.getElementById('header-count').textContent = stats.total + ' leadiä'
  render()
}

function render() {
  const q = document.getElementById('search').value.toLowerCase()
  const filtered = leads.filter(l => l.domain.url.toLowerCase().includes(q))
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
      : l.email
      ? '<span class="badge badge-nosend">Ei lähetetty</span>'
      : '<span class="badge badge-noemail">Ei sähköpostia</span>'

    return \`<tr>
      <td><span class="domain">\${domain}</span></td>
      <td><span class="score \${cls}">\${score}</span></td>
      <td style="color:#94a3b8;font-size:13px">
        \${l.scan.critical > 0 ? '<span style="color:#ef4444">⚠ ' + l.scan.critical + ' kriit.</span> ' : ''}
        \${l.scan.serious > 0 ? '<span style="color:#f59e0b">' + l.scan.serious + ' vak.</span>' : ''}
        \${l.scan.critical === 0 && l.scan.serious === 0 ? '–' : ''}
      </td>
      <td style="font-size:13px;color:#94a3b8">\${l.email || '–'}</td>
      <td>\${emailBadge}</td>
      <td style="font-size:12px;color:#64748b">\${date}</td>
      <td>
        <div class="actions">
          <a href="/api/leads/\${l.id}/pdf" target="_blank">
            <button class="btn btn-ghost btn-sm">PDF</button>
          </a>
          <button class="btn btn-primary btn-sm" onclick="openModal('\${l.id}', '\${l.email || ''}')">
            \${l.emailSent ? 'Lähetä uudelleen' : 'Lähetä'}
          </button>
        </div>
      </td>
    </tr>\`
  }).join('')
}

function openModal(id, email) {
  activeLead = id
  document.getElementById('modal-email').value = email
  document.getElementById('modal').classList.add('open')
  document.getElementById('modal-email').focus()
}

function closeModal() {
  document.getElementById('modal').classList.remove('open')
  activeLead = null
}

async function sendEmail() {
  const email = document.getElementById('modal-email').value
  if (!email) return
  const btn = document.querySelector('.modal .btn-primary')
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

  if (res.ok) {
    showToast('Sähköposti lähetetty!')
    await load()
  } else {
    showToast('Virhe lähetyksessä', true)
  }
}

function showToast(msg, err = false) {
  const t = document.getElementById('toast')
  t.textContent = msg
  t.style.background = err ? '#7f1d1d' : '#064e3b'
  t.style.color = err ? '#fca5a5' : '#6ee7b7'
  t.classList.add('show')
  setTimeout(() => t.classList.remove('show'), 3000)
}

document.getElementById('modal').addEventListener('click', e => {
  if (e.target === document.getElementById('modal')) closeModal()
})

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
