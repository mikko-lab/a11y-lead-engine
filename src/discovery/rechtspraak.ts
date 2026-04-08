/**
 * Rechtspraak.nl — Hollannin virallinen tuomioistuindata API
 *
 * Julkinen REST API, ei autentikointia, XML-formaatti.
 * Hollanti on ollut tiukka WCAG-vaatimusten toimeenpanossa — dataa löytyy.
 *
 * Docs: https://www.rechtspraak.nl/Uitspraken/Paginas/Open-Data.aspx
 */

const BASE = 'https://data.rechtspraak.nl/uitspraken'

const HAKUSANAT = [
  'digitale toegankelijkheid', // digitaalinen saavutettavuus
  'webtoegankelijkheid',       // web-saavutettavuus
  'WCAG',
  'EN 301 549',                // EU-standardi
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

async function hae(url: string): Promise<string> {
  const res = await fetch(url, {
    headers: {
      'User-Agent': 'Mozilla/5.0 (compatible; a11y-kanteet-research/1.0)',
      'Accept': 'application/xml, text/xml',
    },
    signal: AbortSignal.timeout(10_000),
  })
  if (!res.ok) throw new Error(`HTTP ${res.status}: ${url}`)
  return res.text()
}

function xmlArvo(xml: string, tagi: string): string | undefined {
  const re = new RegExp(`<${tagi}[^>]*>([\\s\\S]*?)<\\/${tagi}>`, 'i')
  return re.exec(xml)?.[1]?.replace(/<[^>]+>/g, '').trim() || undefined
}

function xmlKaikki(xml: string, tagi: string): string[] {
  const re = new RegExp(`<${tagi}[^>]*>([\\s\\S]*?)<\\/${tagi}>`, 'gi')
  const tulokset: string[] = []
  let m
  while ((m = re.exec(xml)) !== null) {
    const arvo = m[1].replace(/<[^>]+>/g, '').trim()
    if (arvo) tulokset.push(arvo)
  }
  return tulokset
}

function parseHakutulokset(xml: string): Array<{ ecli: string; otsikko: string; pvm?: string; tiivistelma?: string }> {
  const tulokset: Array<{ ecli: string; otsikko: string; pvm?: string; tiivistelma?: string }> = []

  // RSS/Atom feed — jokainen tapaus on <item> tai <entry>
  const itemRe = /<(?:item|entry)>([\s\S]*?)<\/(?:item|entry)>/gi
  let m
  while ((m = itemRe.exec(xml)) !== null) {
    const blokki = m[1]

    // ECLI löytyy <identifier> tai <id> tai <link>-tagista
    const ecli =
      xmlArvo(blokki, 'identifier') ??
      xmlArvo(blokki, 'id') ??
      blokki.match(/ECLI:NL:[A-Z0-9:]+/)?.[0]

    if (!ecli || !ecli.startsWith('ECLI:')) continue

    const otsikko = xmlArvo(blokki, 'title') ?? ecli
    const pvm = xmlArvo(blokki, 'updated') ?? xmlArvo(blokki, 'pubDate') ?? xmlArvo(blokki, 'date')
    const tiivistelma = xmlArvo(blokki, 'summary') ?? xmlArvo(blokki, 'description')

    tulokset.push({ ecli, otsikko, pvm, tiivistelma })
  }

  return tulokset
}

function parseTapausSisalto(xml: string, ecli: string): Partial<RechtspraakTapaus> {
  return {
    tuomioistuin: xmlArvo(xml, 'instantie') ?? xmlArvo(xml, 'creator'),
    menettelytyyppi: xmlArvo(xml, 'procedure'),
    pvm: xmlArvo(xml, 'uitspraakdatum') ?? xmlArvo(xml, 'publicatiedatum'),
    tiivistelma: xmlArvo(xml, 'inhoudsindicatie')?.slice(0, 500),
  }
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
    const url = `${BASE}/zoeken?q=${encodeURIComponent(sana)}&max=${maxPerHaku}&type=Uitspraak&sort=DESC`
    onProgress(`  Haetaan: "${sana}"`)

    try {
      const xml = await hae(url)
      const tulokset = parseHakutulokset(xml)
      onProgress(`    → ${tulokset.length} tapausta`)

      for (const t of tulokset) {
        if (nahty.has(t.ecli)) continue
        nahty.add(t.ecli)

        const tapaus: RechtspraakTapaus = {
          ecli: t.ecli,
          otsikko: t.otsikko,
          url: `${BASE}/content?id=${t.ecli}`,
          pvm: t.pvm,
          tiivistelma: t.tiivistelma,
        }

        if (haeSisalto) {
          try {
            await sleep(500)
            const sisaltoXml = await hae(tapaus.url)
            const lisatiedot = parseTapausSisalto(sisaltoXml, t.ecli)
            Object.assign(tapaus, lisatiedot)
          } catch {
            // Ohitetaan
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
