/**
 * Finlex-skräpperi — saavutettavuuskanteet
 *
 * Hakee oikeus.fi / finlex.fi -palvelusta saavutettavuuteen liittyviä
 * tuomioistuinpäätöksiä ja viranomaispäätöksiä. Nämä organisaatiot ovat
 * jo saaneet huomion — täydellinen hetki tarjota apua.
 */

const BASE = 'https://www.finlex.fi'

const HAKUSANAT = [
  'saavutettavuus',
  'saavutettavuusdirektiivi',
  'saavutettavuusvaatimus',
  'WCAG',
  'digisaavutettavuus',
]

const KATEGORIAT = [
  'oikeuskaytanto',   // KKO, KHO, hovioikeudet
  'viranomaiset',     // AVI, Traficom, muut viranomaispäätökset
]

export interface FinlexTapaus {
  otsikko: string
  url: string
  viite?: string   // esim. "KKO:2026:27"
  tuomioistuin?: string
  pvm?: string
  katkelmia?: string
}

async function hae(url: string): Promise<string> {
  const res = await fetch(url, {
    headers: {
      'User-Agent': 'Mozilla/5.0 (compatible; a11y-kanteet-research/1.0)',
      'Accept': 'text/html,application/xhtml+xml',
      'Accept-Language': 'fi-FI,fi;q=0.9',
    },
    signal: AbortSignal.timeout(10_000),
  })
  if (!res.ok) throw new Error(`HTTP ${res.status}`)
  return res.text()
}

function parseLinkki(html: string): Array<{ href: string; teksti: string }> {
  const tulokset: Array<{ href: string; teksti: string }> = []
  // Etsi linkit jotka viittaavat yksittäisiin tapauksiin — URL:ssa on numero lopussa
  const re = /<a\s[^>]*href="(\/fi\/(?:oikeuskaytanto|viranomaiset)[^"]*\/\d+[^"]*)"[^>]*>([\s\S]*?)<\/a>/gi
  let m
  while ((m = re.exec(html)) !== null) {
    const teksti = m[2].replace(/<[^>]+>/g, '').replace(/\s+/g, ' ').trim()
    if (teksti.length > 5 && teksti.length < 300) {
      tulokset.push({ href: m[1], teksti })
    }
  }
  return tulokset
}

function parseTuomioistuin(href: string): string | undefined {
  if (href.includes('korkein-oikeus') || href.includes('/kko/')) return 'KKO'
  if (href.includes('korkein-hallinto-oikeus') || href.includes('/kho/')) return 'KHO'
  if (href.includes('hovioikeus')) return 'Hovioikeus'
  if (href.includes('hallinto-oikeus')) return 'Hallinto-oikeus'
  if (href.includes('markkinaoikeus')) return 'Markkinaoikeus'
  if (href.includes('avi') || href.includes('aluehallintovirasto')) return 'AVI'
  if (href.includes('traficom')) return 'Traficom'
  return undefined
}

function parseViite(teksti: string): string | undefined {
  const m = teksti.match(/\b(KKO|KHO|MAO|HAO)[\s:]+(\d{4})[\s:]+(?:T\s*)?(\d+)/i)
  if (m) return `${m[1].toUpperCase()}:${m[2]}:${m[3]}`
  return undefined
}

function parsePvm(html: string): string | undefined {
  // ISO-päivämäärä tai suomalainen muoto
  const m = html.match(/(\d{4}-\d{2}-\d{2})|(\d{1,2}\.\d{1,2}\.\d{4})/)
  return m?.[0]
}

function parseKatkelma(html: string): string | undefined {
  // Etsi lyhyt tekstikatkelma jossa mainitaan saavutettavuus
  const re = /([^.!?]*saavutettavu[^.!?]*[.!?])/gi
  const osumat: string[] = []
  let m
  while ((m = re.exec(html)) !== null) {
    const puhdas = m[1].replace(/<[^>]+>/g, '').replace(/\s+/g, ' ').trim()
    if (puhdas.length > 20 && puhdas.length < 400) {
      osumat.push(puhdas)
    }
    if (osumat.length >= 2) break
  }
  return osumat.join(' … ') || undefined
}

function sleep(ms: number) {
  return new Promise((r) => setTimeout(r, ms))
}

export async function scrapeFinlexKanteet(opts: {
  onProgress?: (msg: string) => void
  haeSisalto?: boolean  // haetaanko tapausten koko sisältö (hidasta)
} = {}): Promise<FinlexTapaus[]> {
  const { onProgress = console.log, haeSisalto = false } = opts
  const tapaukset: FinlexTapaus[] = []
  const nahty = new Set<string>()

  for (const sana of HAKUSANAT) {
    for (const kategoria of KATEGORIAT) {
      const url = `${BASE}/fi/haku?q=${encodeURIComponent(sana)}&category=${kategoria}&limit=50&sort=relevance`
      onProgress(`  Haetaan: "${sana}" / ${kategoria}`)

      try {
        const html = await hae(url)
        const linkit = parseLinkki(html)
        onProgress(`    → ${linkit.length} linkkiä löydettiin`)

        for (const { href, teksti } of linkit) {
          const kokoUrl = `${BASE}${href}`
          if (nahty.has(kokoUrl)) continue
          nahty.add(kokoUrl)

          const tapaus: FinlexTapaus = {
            otsikko: teksti,
            url: kokoUrl,
            viite: parseViite(teksti),
            tuomioistuin: parseTuomioistuin(href),
          }

          if (haeSisalto) {
            try {
              await sleep(800)
              const sisalto = await hae(kokoUrl)
              tapaus.pvm = parsePvm(sisalto)
              tapaus.katkelmia = parseKatkelma(sisalto)
            } catch {
              // Ohitetaan sisältöhakuvirhe
            }
          }

          tapaukset.push(tapaus)
        }
      } catch (e: any) {
        onProgress(`    ✗ Virhe: ${e.message}`)
      }

      await sleep(1200)
    }
  }

  return tapaukset
}
