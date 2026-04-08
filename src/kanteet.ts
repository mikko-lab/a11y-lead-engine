/**
 * pnpm kanteet
 *
 * Yhtenäinen runner: hakee saavutettavuuskanteet Finlexistä (FI) ja
 * Rechtspraak.nl:stä (NL), analysoi ne Claudella ja luo tiketit DB:hen.
 *
 * Käyttö:
 *   pnpm kanteet              — hae + analysoi + tallenna
 *   pnpm kanteet --fi         — vain Suomi
 *   pnpm kanteet --nl         — vain Hollanti
 *   pnpm kanteet --sisalto    — hae myös tapausten koko teksti
 */

import 'dotenv/config'
import { scrapeFinlexKanteet, FinlexTapaus } from './discovery/finlex'
import { scrapeRechtspraakKanteet, RechtspraakTapaus } from './discovery/rechtspraak'
import { analysoi, tallennaTiketti, RiskRevenueMapping } from './court-ticket-agent'
import { db } from './db/client'
import { scanQueue } from './queue'

const args = process.argv.slice(2)
const vainFI = args.includes('--fi')
const vainNL = args.includes('--nl')
const haeSisalto = args.includes('--sisalto')
const ajaMollemmat = !vainFI && !vainNL

function sleep(ms: number) {
  return new Promise((r) => setTimeout(r, ms))
}

async function kasiittele<T extends FinlexTapaus | RechtspraakTapaus>(
  tapaukset: T[],
  source: 'finlex' | 'rechtspraak',
  maa: string
) {
  let uusia = 0
  let ohitettu = 0

  for (const tapaus of tapaukset) {
    const caseRef = source === 'finlex'
      ? ((tapaus as FinlexTapaus).viite ?? tapaus.url)
      : (tapaus as RechtspraakTapaus).ecli

    // Tarkista onko jo tallennettu
    const olemassa = await db.courtLead.findUnique({ where: { caseRef } })
    if (olemassa) {
      ohitettu++
      continue
    }

    console.log(`\n  Analysoidaan: ${caseRef}`)
    const tulos = await analysoi({ ...tapaus, source } as any)

    if (!tulos) {
      console.log('  – Analyysi epäonnistui, ohitetaan')
      continue
    }

    if (!tulos.wcagRelevant) {
      console.log(`  – Ei WCAG-relevantti (${tulos.sector}) — ohitetaan`)
      continue
    }

    await tallennaTiketti({ ...tapaus, source } as any, tulos, maa)
    uusia++

    const riskPct = Math.round(tulos.accessibilityRisk * 100)
    const confPct = Math.round(tulos.confidence * 100)
    console.log(`  ✓ Tiketti luotu`)
    console.log(`    Organisaatio:    ${tulos.organization ?? '(ei tunnistettu)'}`)
    console.log(`    Sektori:         ${tulos.sector}`)
    console.log(`    A11y-riski:      ${riskPct}%  |  Myyntiprioriteetti: ${tulos.salesPriority}/10  |  Varmuus: ${confPct}%`)
    console.log(`    Kulma:           ${tulos.suggestedAngle?.slice(0, 100)}`)

    await sleep(500) // Claude rate limit
  }

  return { uusia, ohitettu }
}

async function main() {
  console.log('\nA11Y Lead Engine — Kanteet-agentti')
  console.log('─────────────────────────────────────')
  console.log(`Maat: ${vainFI ? 'FI' : vainNL ? 'NL' : 'FI + NL'}`)
  console.log(`Tapausten sisältö: ${haeSisalto ? 'kyllä' : 'ei'}`)
  console.log('─────────────────────────────────────\n')

  let yhtUusia = 0
  let yhtOhitettu = 0

  // ── Suomi / Finlex ────────────────────────────────────────────────────────
  if (ajaMollemmat || vainFI) {
    console.log('🇫🇮 Finlex — Suomi')
    const tapaukset = await scrapeFinlexKanteet({ haeSisalto, onProgress: (m) => console.log(`  ${m}`) })
    console.log(`  Löydettiin ${tapaukset.length} tapausta\n`)
    const { uusia, ohitettu } = await kasiittele(tapaukset, 'finlex', 'FI')
    yhtUusia += uusia
    yhtOhitettu += ohitettu
  }

  // ── Hollanti / Rechtspraak ────────────────────────────────────────────────
  if (ajaMollemmat || vainNL) {
    console.log('\n🇳🇱 Rechtspraak.nl — Hollanti')
    const tapaukset = await scrapeRechtspraakKanteet({ haeSisalto, onProgress: (m) => console.log(`  ${m}`) })
    console.log(`  Löydettiin ${tapaukset.length} tapausta\n`)
    const { uusia, ohitettu } = await kasiittele(tapaukset, 'rechtspraak', 'NL')
    yhtUusia += uusia
    yhtOhitettu += ohitettu
  }

  // ── Yhteenveto ────────────────────────────────────────────────────────────
  console.log('\n─────────────────────────────────────')
  console.log(`Uusia tikettejä:  ${yhtUusia}`)
  console.log(`Jo tallennettu:   ${yhtOhitettu}`)

  if (yhtUusia > 0) {
    console.log('\nKatso tiketit dashboardista tai:')
    const tiketit = await db.courtLead.findMany({
      where: { status: 'NEW' },
      orderBy: [{ priorityScore: 'desc' }, { createdAt: 'desc' }],
      take: 5,
    })
    console.log('\nTop tiketit (prioriteetti):')
    for (const t of tiketit) {
      console.log(`  ${t.priorityScore}/10 — ${t.orgName ?? '?'} — ${t.caseRef}`)
    }
  }

  await db.$disconnect()
  await scanQueue.close()
}

main().catch((e) => { console.error(e); process.exit(1) })
