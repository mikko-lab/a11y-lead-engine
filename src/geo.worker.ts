import 'dotenv/config'
import { Worker, Job } from 'bullmq'
import Anthropic from '@anthropic-ai/sdk'
import { connection, GeoJobData } from './queue'
import { db } from './db/client'

const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY })

// ── WordPress REST API ────────────────────────────────────────────────────────

function normalizeUrl(url: string): string {
  if (url && !url.startsWith('http://') && !url.startsWith('https://')) {
    return 'https://' + url
  }
  return url
}

async function detectPlatform(baseUrl: string): Promise<string> {
  try {
    const res = await fetch(baseUrl, { redirect: 'follow', signal: AbortSignal.timeout(8000) })
    const html = await res.text()
    if (/squarespace/i.test(html)) return 'squarespace'
    if (/wp-content|wp-includes/i.test(html)) return 'wordpress'
    return 'unknown'
  } catch {
    return 'unknown'
  }
}

async function fetchWpPages(baseUrl: string, user: string, password: string, count = 10) {
  const base = normalizeUrl(baseUrl).replace(/\/$/, '')
  const token = Buffer.from(`${user}:${password}`).toString('base64')
  const headers = { Authorization: `Basic ${token}`, 'User-Agent': 'GEO-Agent/1.0' }

  const results: Array<{ id: number; title: string; url: string; content: string }> = []
  let apiReachable = false

  for (const type of ['pages', 'posts']) {
    const resp = await fetch(
      `${base}/wp-json/wp/v2/${type}?per_page=${count}&status=publish`,
      { headers, signal: AbortSignal.timeout(10000) }
    )
    if (!resp.ok) continue
    apiReachable = true
    const items = await resp.json() as any[]
    for (const item of items) {
      const raw = item.content?.rendered ?? ''
      const text = raw.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim()
      if (text.length < 100) continue
      results.push({
        id: item.id,
        title: item.title?.rendered ?? '(ei otsikkoa)',
        url: item.link ?? '',
        content: text.slice(0, 4000),
      })
    }
    if (results.length >= count) break
  }

  if (!apiReachable) {
    throw new Error('WP_API_NOT_FOUND')
  }

  return results.slice(0, count)
}

// ── GEO-pisteet (0–100) ───────────────────────────────────────────────────────

function scoreContent(text: string): number {
  let score = 30
  const lower = text.toLowerCase()

  // Q&A / kysymysrakenne
  if (/\?/.test(text)) score += 10
  // Numerot / faktat
  if (/\d+/.test(text)) score += 10
  // Auktoriteettisignaalit
  if (/tutkimus|lähde|mukaan|vuonna|julkaisu/i.test(lower)) score += 10
  // Lauserakenne — pitkät selitykset
  if (text.split('.').length > 5) score += 10
  // Listaukset
  if (/•|-|\n/.test(text)) score += 10
  // Riittävä pituus
  if (text.length > 500) score += 10

  return Math.min(score, 70) // max ennen optimointia on 70
}

// ── Claude — GEO-analyysi & optimointi ───────────────────────────────────────

async function analyzeAndOptimize(title: string, content: string) {
  const prompt = `Olet GEO-optimointiasiantuntija (Generative Engine Optimization). Tehtäväsi on analysoida WordPress-sivuston sisältö ja optimoida se niin, että AI-järjestelmät (ChatGPT, Perplexity, Google AI Overviews) siteeraavat sitä vastauksissa.

GEO-periaatteet joita sovellat:
1. Q&A-rakenne: muuta väittämät kysymys–vastaus-muotoon
2. Faktat ja luvut: lisää konkreettisia tietoja
3. Auktoriteettisignaalit: viittaukset, asiantuntijuus, kokemus
4. Selkeä rakenne: lyhyet kappaleet, otsikointi
5. Kattavuus: vastaa kysymykseen kattavasti yhdessä kappaleessa

Sivun otsikko: ${title}

Alkuperäinen sisältö:
${content}

Vastaa VAIN JSON-muodossa (ei muuta tekstiä):
{
  "geoScore": <kokonaisluku 0-100, alkuperäisen sisällön GEO-pisteet>,
  "geoScoreAfter": <kokonaisluku 0-100, optimoidun sisällön arvioitu pisteet>,
  "findings": [<lista lyhyistä havainnoista mikä puuttuu, max 4 kpl>],
  "optimizedContent": "<GEO-optimoitu sisältö, max 800 sanaa, pelkkä teksti ilman HTML:ää>"
}`

  const msg = await client.messages.create({
    model: 'claude-haiku-4-5-20251001',
    max_tokens: 2048,
    messages: [{ role: 'user', content: prompt }],
  })

  const raw = (msg.content[0] as any).text.trim()
  // Poimi JSON vaikka Claude lisäisi ylimääräistä tekstiä
  const match = raw.match(/\{[\s\S]*\}/)
  if (!match) throw new Error('Claude ei palauttanut JSON:ia')
  return JSON.parse(match[0]) as {
    geoScore: number
    geoScoreAfter: number
    findings: string[]
    optimizedContent: string
  }
}

// ── Worker ────────────────────────────────────────────────────────────────────

async function processJob(job: Job<GeoJobData>) {
  const { siteId, pageId } = job.data

  const site = await db.geoSite.findUnique({ where: { id: siteId } })
  if (!site) throw new Error(`GeoSite ${siteId} ei löydy`)

  // ── Manuaalinen tila: analysoi yksi valmiiksi tallennettu sivu ───────────────
  if (pageId) {
    const page = await db.geoPage.findUnique({ where: { id: pageId } })
    if (!page) throw new Error(`GeoPage ${pageId} ei löydy`)
    console.log(`\n[geo] manuaalinen analyysi: ${page.title}`)
    const result = await analyzeAndOptimize(page.title, page.originalContent)
    await db.geoPage.update({
      where: { id: pageId },
      data: {
        optimizedContent: result.optimizedContent,
        geoScore: result.geoScore,
        geoScoreAfter: result.geoScoreAfter,
        analysis: JSON.stringify({ findings: result.findings }),
        status: 'ANALYZED',
      },
    })
    await db.geoSite.update({ where: { id: siteId }, data: { lastError: null } })
    console.log(`  Valmis — GEO: ${result.geoScore} → ${result.geoScoreAfter}`)
    return
  }

  console.log(`\n[geo] ${site.url}`)
  await job.updateProgress(5)

  // Hae sivut WordPressistä
  let pages: Awaited<ReturnType<typeof fetchWpPages>>
  try {
    pages = await fetchWpPages(site.url, site.wpUser ?? '', site.wpPassword ?? '', 10)
  } catch (err: any) {
    if (err.message === 'WP_API_NOT_FOUND') {
      const platform = await detectPlatform(site.url)
      console.log(`  WP REST API ei löydy — alusta: ${platform}`)
      await db.geoSite.update({
        where: { id: siteId },
        data: {
          platform,
          lastError: platform === 'squarespace'
            ? 'Squarespace-sivusto — käytä manuaalista copy-paste -tilaa'
            : 'WordPress REST API ei vastaa. Tarkista URL ja tunnukset.',
        },
      })
      return
    }
    throw err
  }

  console.log(`  Löydettiin ${pages.length} sivua`)

  if (!pages.length) {
    console.log('  Ei sivuja — lopetetaan')
    await db.geoSite.update({ where: { id: siteId }, data: { lastError: 'Sivuja ei löydy. Tarkista tunnukset ja Application Password.' } })
    return
  }

  // Nollataan mahdollinen aiempi virhe
  await db.geoSite.update({ where: { id: siteId }, data: { lastError: null, platform: 'wordpress' } })

  // Analysoi jokainen sivu
  for (let i = 0; i < pages.length; i++) {
    const page = pages[i]
    await job.updateProgress(Math.round(10 + (i / pages.length) * 85))
    console.log(`  [${i + 1}/${pages.length}] ${page.title}`)

    try {
      const result = await analyzeAndOptimize(page.title, page.content)

      await db.geoPage.upsert({
        where: {
          // upsert siteId+wpPageId yhdistelmällä — käytetään composite unique
          // koska wpPageId voi olla null, käytetään url:ia
          id: (await db.geoPage.findFirst({
            where: { siteId, wpPageId: page.id },
            select: { id: true },
          }))?.id ?? 'new-' + Date.now() + '-' + i,
        },
        create: {
          siteId,
          wpPageId: page.id,
          title: page.title,
          url: page.url,
          originalContent: page.content,
          optimizedContent: result.optimizedContent,
          geoScore: result.geoScore,
          geoScoreAfter: result.geoScoreAfter,
          analysis: JSON.stringify({ findings: result.findings }),
          status: 'ANALYZED',
        },
        update: {
          title: page.title,
          url: page.url,
          originalContent: page.content,
          optimizedContent: result.optimizedContent,
          geoScore: result.geoScore,
          geoScoreAfter: result.geoScoreAfter,
          analysis: JSON.stringify({ findings: result.findings }),
          status: 'ANALYZED',
        },
      })
    } catch (err) {
      console.error(`  Virhe sivulla ${page.title}:`, err)
    }
  }

  await job.updateProgress(100)
  console.log(`  Valmis — ${pages.length} sivua analysoitu`)
}

// ── Käynnistys ────────────────────────────────────────────────────────────────

const worker = new Worker<GeoJobData>('geo', processJob, {
  connection,
  concurrency: 1,
})

worker.on('completed', job => console.log(`[geo] Job ${job.id} valmis`))
worker.on('failed', (job, err) => console.error(`[geo] Job ${job?.id} epäonnistui:`, err.message))

console.log('GEO worker käynnissä')
