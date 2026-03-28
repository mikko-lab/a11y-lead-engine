import 'dotenv/config'
import express from 'express'
import path from 'path'
import fs from 'fs'
import { db } from './db/client'
import { generatePdf } from './pdf'
import { sendReport } from './mailer'
import { discoverFromDuckDuckGo, discoverFromTranco, discoverFromYritykset, CATEGORIES } from './discovery/index'
import { TOL_NAMES, TARGET_TOLS } from './ytj'
import { runMonitor } from './monitor'

const app = express()
app.use(express.json())

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

    sendSSE(`Valmis! Löydettiin ${result.found} domainia, jonoon lisätty ${result.queued} skannausta.`, 'done')
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
    },
  })
  res.json(domains)
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
  .tab { padding: 12px 20px; font-size: 14px; font-weight: 600; cursor: pointer; color: #64748b; border-bottom: 2px solid transparent; margin-bottom: -1px; transition: color .15s; }
  .tab.active { color: #00D4AA; border-bottom-color: #00D4AA; }
  .tab:hover:not(.active) { color: #e2e8f0; }
  .page { display: none; }
  .page.active { display: block; }
  .stats { display: grid; grid-template-columns: repeat(4, 1fr); gap: 16px; padding: 24px 32px; }
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
  /* Uusi ajo */
  .run-wrap { padding: 24px 32px; max-width: 860px; }
  .run-section { margin-bottom: 28px; }
  .run-section h3 { font-size: 13px; font-weight: 600; color: #64748b; text-transform: uppercase; letter-spacing: .06em; margin-bottom: 12px; }
  .source-cards { display: grid; grid-template-columns: repeat(3, 1fr); gap: 12px; }
  .source-card { background: #1a2744; border: 2px solid #1e3a5f; border-radius: 10px; padding: 16px 18px; cursor: pointer; transition: border-color .15s; }
  .source-card.selected { border-color: #00D4AA; }
  .source-card h4 { font-size: 14px; font-weight: 700; margin-bottom: 4px; }
  .source-card p { font-size: 12px; color: #64748b; line-height: 1.5; }
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
  .log-line.error { color: #f87171; }
  .log-ts { color: #334155; margin-right: 8px; }
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

<div class="tabs">
  <div class="tab active" onclick="switchTab('leads')">Leadit</div>
  <div class="tab" onclick="switchTab('run')">Uusi ajo</div>
  <div class="tab" onclick="switchTab('monitor')">Seuranta</div>
</div>

<!-- LEADIT -->
<div class="page active" id="page-leads">
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
          <th>Yritys</th>
          <th>TOL</th>
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
          Lähetä sähköposti automaattisesti
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
    <h3>Lähetä raportti</h3>
    <input id="modal-email" type="email" placeholder="vastaanottaja@email.fi">
    <div class="modal-actions">
      <button class="btn btn-ghost btn-sm" onclick="closeModal()">Peruuta</button>
      <button class="btn btn-primary btn-sm" onclick="doSendEmail()">Lähetä</button>
    </div>
  </div>
</div>

<div class="toast" id="toast"></div>

<script>
// ── Data ──────────────────────────────────────────────────────────────────────
let leads = []
let activeLead = null
let selectedSource = 'duckduckgo'
let sendEmailOn = false
let selectedTols = []
let selectedYrCats = []
let runEvtSource = null

const TOL_OPTIONS = [${TOL_OPTIONS}]
const YR_CATEGORIES = [${YR_CATEGORIES}]

// ── Tabs ──────────────────────────────────────────────────────────────────────
function switchTab(tab) {
  document.querySelectorAll('.tab').forEach((t, i) => t.classList.toggle('active', ['leads','run','monitor'][i] === tab))
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
  document.getElementById('header-count').textContent = stats.total + ' leadiä'
  render()
}

function render() {
  const q = document.getElementById('search').value.toLowerCase()
  const filtered = leads.filter(l => l.domain.url.toLowerCase().includes(q) || (l.domain.company || '').toLowerCase().includes(q))
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
    return \`<tr>
      <td><span class="domain">\${domain}</span></td>
      <td style="font-size:13px;color:#94a3b8">\${l.domain.company || '–'}</td>
      <td style="font-size:12px;color:#64748b">\${l.domain.tol ? 'TOL ' + l.domain.tol : '–'}</td>
      <td><span class="score \${cls}">\${score}</span></td>
      <td style="color:#94a3b8;font-size:13px">
        \${l.scan.critical > 0 ? '<span style="color:#ef4444">⚠ ' + l.scan.critical + ' kriit.</span> ' : ''}
        \${l.scan.serious > 0 ? '<span style="color:#f59e0b">' + l.scan.serious + ' vak.</span>' : ''}
        \${l.scan.critical === 0 && l.scan.serious === 0 ? '–' : ''}
      </td>
      <td style="font-size:13px;color:#94a3b8">\${l.email || '–'}</td>
      <td>\${emailBadge}</td>
      <td style="font-size:12px;color:#64748b">\${date}</td>
      <td><div class="actions">
        <a href="/api/leads/\${l.id}/pdf" target="_blank"><button class="btn btn-ghost btn-sm">PDF</button></a>
        <button class="btn btn-primary btn-sm" onclick="openModal('\${l.id}', '\${l.email || ''}')">
          \${l.emailSent ? 'Uudelleen' : 'Lähetä'}
        </button>
      </div></td>
    </tr>\`
  }).join('')
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
      statusBadge = '<span class="badge" style="background:#7f1d1d;color:#fca5a5">⚡ Muutos</span>'
      changeTxt = '<span style="color:#f87171;font-weight:700">' + pct + '%</span>'
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
  document.getElementById('modal').classList.add('open')
  document.getElementById('modal-email').focus()
}

function closeModal() {
  document.getElementById('modal').classList.remove('open')
  activeLead = null
}

async function doSendEmail() {
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
  if (res.ok) { showToast('Sähköposti lähetetty!'); await load() }
  else showToast('Virhe lähetyksessä', true)
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

// ── Init ──────────────────────────────────────────────────────────────────────
initRunPage()
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
