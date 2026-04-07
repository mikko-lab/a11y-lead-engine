/**
 * pnpm rechtspraak
 *
 * Hakee Hollannin tuomioistuimista saavutettavuuteen liittyvät tapaukset.
 */

import 'dotenv/config'
import { scrapeRechtspraakKanteet } from './discovery/rechtspraak'
import { scanQueue } from './queue'
import { db } from './db/client'

async function main() {
  const haeSisalto = process.argv.includes('--sisalto')

  console.log('\nA11Y Lead Engine — Rechtspraak.nl (Hollanti)')
  console.log('─────────────────────────────────────────────')
  console.log(`Haetaan tapausten sisältö: ${haeSisalto ? 'kyllä' : 'ei (lisää --sisalto)'}`)
  console.log('─────────────────────────────────────────────\n')

  const tapaukset = await scrapeRechtspraakKanteet({
    haeSisalto,
    onProgress: console.log,
  })

  console.log(`\n─────────────────────────────────────────────`)
  console.log(`Löydettiin yhteensä ${tapaukset.length} tapausta`)
  console.log('─────────────────────────────────────────────\n')

  if (tapaukset.length === 0) {
    console.log('Ei tuloksia.')
    await db.$disconnect()
    await scanQueue.close()
    return
  }

  for (const t of tapaukset) {
    console.log(`\n⚖️  ${t.ecli}`)
    console.log(`   ${t.otsikko.slice(0, 120)}`)
    if (t.tuomioistuin) console.log(`   Tuomioistuin: ${t.tuomioistuin}`)
    if (t.pvm) console.log(`   Päivämäärä: ${t.pvm}`)
    if (t.menettelytyyppi) console.log(`   Menettely: ${t.menettelytyyppi}`)
    if (t.tiivistelma) console.log(`   Tiivistelmä: ${t.tiivistelma.slice(0, 250)}`)
    console.log(`   URL: ${t.url}`)
  }

  await db.$disconnect()
  await scanQueue.close()
}

main().catch((e) => { console.error(e); process.exit(1) })
