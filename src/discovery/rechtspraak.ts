/**
 * Rechtspraak.nl — Hollannin virallinen tuomioistuindata
 *
 * HUOM (2026-07): data.rechtspraak.nl/uitspraken/zoeken -avoin-data-API:n
 * `q`-parametri EI suodata mitään — se palauttaa aina koko kannan tuoreimmat
 * tapaukset riippumatta hakusanasta (todennettu: sama ResultCount kaikilla
 * hakusanoilla, myös merkityksettömillä). Oikea vapaatekstihaku tehdään
 * uitspraken.rechtspraak.nl:n omalla haku-API:lla (sama jota julkinen
 * hakusivu käyttää), jonka pyyntörunko löytyi sivun JS-bundlesta.
 *
 * Sisältöhaku (haeSisalto) käyttää edelleen virallista, dokumentoitua
 * Open Data -content-endpointia (data.rechtspraak.nl) — se ei ole rikki.
 */

const SEARCH_URL = 'https://uitspraken.rechtspraak.nl/api/zoek'
const CONTENT_BASE = 'https://data.rechtspraak.nl/uitspraken'

// Moniosaiset hakusanat lainausmerkeissä = tarkka fraasihaku (muuten haku-
// moottori tulkitsee välilyönnin OR:ksi ja tulokset ovat lähes satunnaisia).
const HAKUSANAT = [
  '"digitale toegankelijkheid"', // digitaalinen saavutettavuus
  'webtoegankelijkheid',         // web-saavutettavuus
  'WCAG',
  '"EN 301 549"',                // EU-standardi
]

export interface RechtspraakTapaus {
  ecli: string
  otsikko: string
  url: string
  tuomioistuin?: string
  pvm?: string
  menettelytyyppi?: string
  tiivistelma?: string
}

interface ZoekResult {
  TitelEmphasis: string   // ECLI
  Titel: string
  DeeplinkUrl: string
  Uitspraakdatum?: string
  Tekstfragment?: string
}

interface ZoekResponse {
  Results: ZoekResult[]
  ResultCount: number
}

function uuid(): string {
  // Node 19+ / globalThis.crypto — käytössä myös kaikissa modernissa Node LTS:ssä
  return (globalThis as any).crypto?.randomUUID?.() ?? `${Date.now()}-${Math.random()}`
}

async function haeHakutulokset(term: string, maxPerHaku: number): Promise<ZoekResult[]> {
  const body = {
    StartRow: 0,
    PageSize: maxPerHaku,
    ShouldReturnHighlights: true,
    ShouldCountFacets: true,
    SortOrder: 'Relevance',
    SearchTerms: [{ Term: term, Field: 'zt0' }],  // zt0 = "Alle velden"
    Contentsoorten: [],
    Rechtsgebieden: [],
    Instanties: [],
    DatumPublicatie: [],
    DatumUitspraak: [],
    Advanced: { PublicatieStatus: 'Ongedefinieerd' },
    CorrelationId: uuid(),
    Proceduresoorten: [],
  }

  const res = await fetch(SEARCH_URL, {
    method: 'POST',
    headers: {
      'User-Agent': 'Mozilla/5.0 (compatible; a11y-kanteet-research/1.0)',
      'Content-Type': 'application/json',
      'Accept': 'application/json',
    },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(10_000),
  })
  if (!res.ok) throw new Error(`HTTP ${res.status}`)
  const json = await res.json() as ZoekResponse
  return json.Results ?? []
}

function xmlArvo(xml: string, tagi: string): string | undefined {
  const re = new RegExp(`<${tagi}[^>]*>([\\s\\S]*?)<\\/${tagi}>`, 'i')
  return re.exec(xml)?.[1]?.replace(/<[^>]+>/g, '').trim() || undefined
}

function parseTapausSisalto(xml: string): Partial<RechtspraakTapaus> {
  return {
    tuomioistuin: xmlArvo(xml, 'instantie') ?? xmlArvo(xml, 'creator'),
    menettelytyyppi: xmlArvo(xml, 'procedure'),
    pvm: xmlArvo(xml, 'uitspraakdatum') ?? xmlArvo(xml, 'publicatiedatum'),
    tiivistelma: xmlArvo(xml, 'inhoudsindicatie')?.slice(0, 500),
  }
}

async function haeSisaltoXml(ecli: string): Promise<string> {
  const res = await fetch(`${CONTENT_BASE}/content?id=${ecli}`, {
    headers: {
      'User-Agent': 'Mozilla/5.0 (compatible; a11y-kanteet-research/1.0)',
      'Accept': 'application/xml, text/xml',
    },
    signal: AbortSignal.timeout(10_000),
  })
  if (!res.ok) throw new Error(`HTTP ${res.status}`)
  return res.text()
}

function sleep(ms: number) {
  return new Promise((r) => setTimeout(r, ms))
}

export async function scrapeRechtspraakKanteet(opts: {
  onProgress?: (msg: string) => void
  haeSisalto?: boolean
  maxPerHaku?: number
} = {}): Promise<RechtspraakTapaus[]> {
  const { onProgress = console.log, haeSisalto = false, maxPerHaku = 50 } = opts
  const tapaukset: RechtspraakTapaus[] = []
  const nahty = new Set<string>()

  for (const sana of HAKUSANAT) {
    onProgress(`  Haetaan: ${sana}`)

    try {
      const tulokset = await haeHakutulokset(sana, maxPerHaku)
      onProgress(`    → ${tulokset.length} tapausta`)

      for (const t of tulokset) {
        const ecli = t.TitelEmphasis
        if (!ecli || nahty.has(ecli)) continue
        nahty.add(ecli)

        const tapaus: RechtspraakTapaus = {
          ecli,
          otsikko: t.Titel,
          url: t.DeeplinkUrl ?? `${CONTENT_BASE}/content?id=${ecli}`,
          pvm: t.Uitspraakdatum,
          tiivistelma: t.Tekstfragment,
        }

        if (haeSisalto) {
          try {
            await sleep(500)
            const sisaltoXml = await haeSisaltoXml(ecli)
            Object.assign(tapaus, parseTapausSisalto(sisaltoXml))
          } catch {
            // Ohitetaan sisältöhakuvirhe
          }
        }

        tapaukset.push(tapaus)
      }
    } catch (e: any) {
      onProgress(`    ✗ Virhe: ${e.message}`)
    }

    await sleep(1000)
  }

  return tapaukset
}
