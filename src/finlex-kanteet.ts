/**
 * pnpm finlex
 *
 * Hakee Finlexistä saavutettavuuteen liittyvät kanteet ja viranomaispäätökset.
 * Yrittää löytää organisaatioiden verkkosivut YTJ:stä ja lisätä ne scan-jonoon.
 */

import 'dotenv/config'
import { scrapeFinlexKanteet, FinlexTapaus } from './discovery/finlex'
import { addScanJob, scanQueue } from './queue'
import { db } from './db/client'
import { normalizeUrl } from './utils/normalize-url'

const YTJ_API = 'https://avoindata.prh.fi/opendata-ytj-api/v3'

// Hae yritys suoraan nimellä (eri kuin lookupYTJ joka ottaa hostnamen)
async function haeYTJNimella(nimi: string): Promise<{ nimi: string; ytunnus: string; verkkosivut?: string } | null> {
  try {
    const url = `${YTJ_API}/companies?name=${encodeURIComponent(nimi)}&maxResults=3`
    const res = await fetch(url, {
      headers: { Accept: 'application/json' },
      signal: AbortSignal.timeout(5000),
    })
    if (!res.ok) return null
    const json = await res.json() as any
    const yritykset: any[] = json?.companies ?? []
    if (yritykset.length === 0) return null

    const yritys = yritykset[0]
    const virallinen = yritys.names
      ?.filter((n: any) => n.type === '1' && !n.endDate)
      .sort((a: any, b: any) => (b.registrationDate ?? '').localeCompare(a.registrationDate ?? ''))[0]
      ?.name ?? nimi

    // YTJ ei yleensä sisällä verkkosivuja — palautetaan Y-tunnus joka auttaa löytämään sivun
    return {
      nimi: virallinen,
      ytunnus: yritys.businessId?.value ?? '',
      verkkosivut: undefined,
    }
  } catch {
    return null
  }
}

// Yritä löytää organisaation nimi tapauksen otsikosta
function eriotaOrgNimi(tapaus: FinlexTapaus): string[] {
  const nimet: string[] = []

  // Otsikosta — etsitään isolla alkavia fraaseja (mahdolliset organisaationimet)
  // esim. "Kela vastaan X Oy" tai "... - Suomen Pankki"
  const oy = tapaus.otsikko.match(/\b([A-ZÄÖÅ][a-zäöå]+(?: [A-ZÄÖÅ][a-zäöå]+)* (?:Oy|Oyj|Ab|ry|ry\.|rf|rf\.|sr|LLC|Ltd))\b/g)
  if (oy) nimet.push(...oy)

  // Julkiset organisaatiot: Kela, Verohallinto, jne.
  const julkinen = tapaus.otsikko.match(/\b(Kela|Verohallinto|Kansaneläkelaitos|Traficom|Liikenne- ja viestintävirasto|AVI|Aluehallintovirasto)\b/gi)
  if (julkinen) nimet.push(...julkinen)

  // Katkelmista
  if (tapaus.katkelmia) {
    const k = tapaus.katkelmia.match(/\b([A-ZÄÖÅ][a-zäöå]+(?: [A-ZÄÖÅ][a-zäöå]+)* (?:Oy|Oyj|Ab|ry))\b/g)
    if (k) nimet.push(...k)
  }

  return [...new Set(nimet)]
}

async function main() {
  const lisaaJonoon = process.argv.includes('--queue')
  const haeSisalto = process.argv.includes('--sisalto')

  console.log('\nA11Y Lead Engine — Finlex kanteet')
  console.log('─────────────────────────────────────')
  console.log(`Haetaan sisältö tapauskohtaisesti: ${haeSisalto ? 'kyllä (hidasta)' : 'ei'}`)
  console.log(`Lisätään scan-jonoon: ${lisaaJonoon ? 'kyllä' : 'ei (lisää --queue)'}`)
  console.log('─────────────────────────────────────\n')

  const tapaukset = await scrapeFinlexKanteet({
    haeSisalto,
    onProgress: console.log,
  })

  console.log(`\n─────────────────────────────────────`)
  console.log(`Löydettiin yhteensä ${tapaukset.length} tapausta`)
  console.log('─────────────────────────────────────\n')

  if (tapaukset.length === 0) {
    console.log('Ei tuloksia. Finlex ei ehkä vielä sisällä suomalaisia a11y-kanteita.')
    console.log('Kokeile myös: pnpm finlex --sisalto')
    await db.$disconnect()
    await scanQueue.close()
    return
  }

  let lisatty = 0

  for (const tapaus of tapaukset) {
    const viite = tapaus.viite ?? tapaus.url.split('/').slice(-2).join('/')
    console.log(`\n📋 ${viite}`)
    console.log(`   ${tapaus.otsikko.slice(0, 120)}`)
    if (tapaus.tuomioistuin) console.log(`   Tuomioistuin: ${tapaus.tuomioistuin}`)
    if (tapaus.pvm) console.log(`   Päivämäärä: ${tapaus.pvm}`)
    if (tapaus.katkelmia) console.log(`   Katkelma: ${tapaus.katkelmia.slice(0, 200)}`)
    console.log(`   URL: ${tapaus.url}`)

    // Yritä poimia organisaationimet
    const orgNimet = eriotaOrgNimi(tapaus)
    if (orgNimet.length > 0) {
      console.log(`   Organisaatiot: ${orgNimet.join(', ')}`)

      // YTJ-haku jokaiselle nimelle
      for (const nimi of orgNimet) {
        const ytj = await haeYTJNimella(nimi)
        if (ytj) {
          console.log(`   ✓ YTJ: ${ytj.nimi} (${ytj.ytunnus})`)

          // Jos halutaan lisätä jonoon — tarvitaan verkkosivun URL
          // YTJ ei anna suoraan, mutta Y-tunnus auttaa DuckDuckGo-haussa
          if (lisaaJonoon) {
            // Yritetään muodostaa domain nimestä
            const domain = ytj.nimi
              .toLowerCase()
              .replace(/\s+(oy|oyj|ab|ry|sr|ltd|llc)\.?$/i, '')
              .replace(/\s+/g, '')
              .replace(/[äå]/g, 'a')
              .replace(/ö/g, 'o')
              + '.fi'

            try {
              const normi = normalizeUrl(`https://${domain}`)
              const olemassa = await db.domain.findFirst({ where: { url: normi } })
              if (!olemassa) {
                await addScanJob({ url: normi, sendEmail: false, source: `Finlex / ${viite}` })
                console.log(`   → Jonoon: ${domain}`)
                lisatty++
              } else {
                console.log(`   – Jo skannattu: ${domain}`)
              }
            } catch {
              console.log(`   – Ei voitu lisätä: ${domain}`)
            }
          }
        }
      }
    }
  }

  if (lisaaJonoon) {
    console.log(`\n─────────────────────────────────────`)
    console.log(`Lisätty jonoon: ${lisatty} domainia`)
    console.log('Käynnistä worker: pnpm worker')
  } else {
    console.log('\n💡 Lisää --queue jos haluat lisätä löydetyt organisaatiot scan-jonoon')
  }

  await db.$disconnect()
  await scanQueue.close()
}

main().catch((e) => { console.error(e); process.exit(1) })
