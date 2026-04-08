/**
 * toegankelijkheidsverklaring.nl — Hollannin julkinen saavutettavuusseloste-rekisteri
 *
 * Pre-lawsuit detection: organisaatiot jotka ovat itse ilmoittaneet
 * etteivät täytä saavutettavuusvaatimuksia. 6–12 kk ennen oikeustapauksia.
 *
 * Status-luokat:
 *   voldoet-niet          → D: ei täytä vaatimuksia (kuumin liidi)
 *   eerste-maatregelen    → C: ensimmäiset toimenpiteet käynnistetty
 *   voldoet-gedeeltelijk  → B: täyttää osittain
 *   voldoet-volledig      → A: täyttää kokonaan (ei relevantti)
 */

const BASE = 'https://www.toegankelijkheidsverklaring.nl/register'

export type ComplianceStatus =
  | 'voldoet-niet'
  | 'eerste-maatregelen'
  | 'voldoet-gedeeltelijk'
  | 'voldoet-volledig'

export interface ToegankelijkheidOrg {
  orgName: string
  serviceName: string
  serviceUrl: string | null
  declarationUrl: string
  declarationId: string
  status: ComplianceStatus
  lastModified: string | null
  country: 'NL'
}

// Myyntiprioriteetit statuksen perusteella — ei tarvita Claudea
export const STATUS_PRIORITY: Record<ComplianceStatus, { salesPriority: number; accessibilityRisk: number }> = {
  'voldoet-niet':         { salesPriority: 9, accessibilityRisk: 0.95 },
  'eerste-maatregelen':   { salesPriority: 7, accessibilityRisk: 0.80 },
  'voldoet-gedeeltelijk': { salesPriority: 4, accessibilityRisk: 0.55 },
  'voldoet-volledig':     { salesPriority: 0, accessibilityRisk: 0.05 },
}

async function hae(url: string): Promise<string> {
  const res = await fetch(url, {
    headers: {
      'User-Agent': 'Mozilla/5.0 (compatible; a11y-research/1.0)',
      'Accept': 'text/html',
      'Accept-Language': 'nl-NL,nl;q=0.9',
    },
    signal: AbortSignal.timeout(15_000),
  })
  if (!res.ok) throw new Error(`HTTP ${res.status}: ${url}`)
  return res.text()
}

function parseTaulukkoRivit(html: string): ToegankelijkheidOrg[] {
  const tulokset: ToegankelijkheidOrg[] = []

  // Etsi taulukon rivit <tr>...</tr>
  const rivit = html.match(/<tr[\s\S]*?<\/tr>/gi) ?? []

  for (const rivi of rivit) {
    // Ohita otsikkorivi (th-elementit)
    if (/<th/i.test(rivi)) continue

    const solut = [...rivi.matchAll(/<td[^>]*>([\s\S]*?)<\/td>/gi)].map((m) =>
      m[1].replace(/<[^>]+>/g, '').replace(/\s+/g, ' ').trim()
    )

    if (solut.length < 3) continue

    const orgName     = solut[0] || ''
    const serviceName = solut[1] || ''
    const statusText  = solut[2] || ''

    if (!orgName || orgName.length < 2) continue

    // Status tekstistä
    let status: ComplianceStatus = 'voldoet-volledig'
    if (/voldoet niet/i.test(statusText) || /\bD\b/.test(statusText))        status = 'voldoet-niet'
    else if (/eerste maatregelen/i.test(statusText) || /\bC\b/.test(statusText)) status = 'eerste-maatregelen'
    else if (/gedeeltelijk/i.test(statusText) || /\bB\b/.test(statusText))    status = 'voldoet-gedeeltelijk'

    const lastModified = solut[3] || null

    // Hae declarationUrl rivistä
    const declMatch = rivi.match(/href="(\/register\/(\d+)[^"]*)"/)
    const declarationPath = declMatch?.[1] ?? null
    const declarationId   = declMatch?.[2] ?? null
    if (!declarationPath || !declarationId) continue

    // Hae serviceUrl
    const serviceUrlMatch = rivi.match(/<td[^>]*>[\s\S]*?<a[^>]+href="([^"]+)"[^>]*>/)
    const serviceUrl = serviceUrlMatch?.[1] ?? null

    tulokset.push({
      orgName,
      serviceName,
      serviceUrl,
      declarationUrl: `https://www.toegankelijkheidsverklaring.nl${declarationPath}`,
      declarationId,
      status,
      lastModified,
      country: 'NL',
    })
  }

  return tulokset
}

function sleep(ms: number) {
  return new Promise((r) => setTimeout(r, ms))
}

export async function scrapeToegang(opts: {
  statuses?: ComplianceStatus[]
  maxPages?: number
  onProgress?: (msg: string) => void
} = {}): Promise<ToegankelijkheidOrg[]> {
  const {
    statuses = ['voldoet-niet', 'eerste-maatregelen'],
    maxPages = 5,
    onProgress = console.log,
  } = opts

  const kaikki: ToegankelijkheidOrg[] = []
  const nahty = new Set<string>()

  for (const status of statuses) {
    onProgress(`  Status: ${status}`)

    for (let page = 0; page < maxPages; page++) {
      const url = `${BASE}?status=${status}&order=changed&sort=desc&page=${page}`

      try {
        const html = await hae(url)
        const rivit = parseTaulukkoRivit(html)

        if (rivit.length === 0) {
          onProgress(`    → Sivu ${page}: ei tuloksia, lopetetaan`)
          break
        }

        let uusia = 0
        for (const org of rivit) {
          if (nahty.has(org.declarationId)) continue
          nahty.add(org.declarationId)
          kaikki.push(org)
          uusia++
        }

        onProgress(`    → Sivu ${page}: ${uusia} organisaatiota`)
        await sleep(800)
      } catch (e: any) {
        onProgress(`    ✗ Sivu ${page}: ${e.message}`)
        break
      }
    }
  }

  return kaikki
}
