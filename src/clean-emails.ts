import 'dotenv/config'
import { db } from './db/client'
import { resolveContactEmail } from './email-validation'

/**
 * Siivoaa tallennetut sähköpostit uuden validaattorin mukaan.
 *
 *   pnpm tsx src/clean-emails.ts              # DRY-RUN: näyttää mitä tekisi, ei kirjoita
 *   pnpm tsx src/clean-emails.ts --apply      # kirjoittaa muutokset kantaan
 *   pnpm tsx src/clean-emails.ts --keep-cross # älä nollaa eri-brändin osoitteita
 *
 * Turvasäännöt:
 *  - EI koskaan kosketa rivejä joilla emailSent = true (lähetettyä ei voi perua;
 *    viallinen jo-lähetetty raportoidaan erikseen, mutta säilytetään auditiksi)
 *  - 'fixed' (esim. %20-etuliite) → korjataan, ei nollata
 *  - isot organisaatiot raportoidaan, EI nollata (validi osoite ≠ huono kohde)
 */

const APPLY = process.argv.includes('--apply')
const KEEP_CROSS = process.argv.includes('--keep-cross')
const BIG_ORG_EMPLOYEES = 250

function hostOf(url: string): string {
  try {
    return new URL(url).hostname.replace(/^www\./, '')
  } catch {
    return url.replace(/^https?:\/\//, '').replace(/^www\./, '').replace(/\/.*$/, '')
  }
}

async function main() {
  console.log(`Cleanup ${APPLY ? '(APPLY — kirjoitetaan)' : '(DRY-RUN — ei kirjoiteta)'}\n`)

  const leads = await db.lead.findMany({
    where: { email: { not: null } },
    include: { domain: true },
  })

  const toNull: { id: string; domainId: string; email: string; url: string }[] = []
  const toFix: { id: string; domainId: string; from: string; to: string }[] = []
  const sentBad: { url: string; email: string; reason: string }[] = []
  const bigOrg: { url: string; email: string; employees: number }[] = []

  for (const lead of leads) {
    const host = hostOf(lead.domain.url)
    const v = resolveContactEmail(lead.email!, host)

    const isBad =
      v.status === 'invalid' || (v.status === 'cross' && !KEEP_CROSS)

    if (isBad) {
      if (lead.emailSent) {
        sentBad.push({ url: host, email: lead.email!, reason: v.status })
      } else {
        toNull.push({ id: lead.id, domainId: lead.domainId, email: lead.email!, url: host })
      }
    } else if (v.status === 'fixed' && !lead.emailSent) {
      toFix.push({ id: lead.id, domainId: lead.domainId, from: lead.email!, to: v.email })
    }

    if ((lead.domain.employees ?? 0) > BIG_ORG_EMPLOYEES) {
      bigOrg.push({ url: host, email: lead.email!, employees: lead.domain.employees! })
    }
  }

  console.log(`Nollataan (viallinen / eri brändi, ei vielä lähetetty): ${toNull.length}`)
  for (const r of toNull) console.log(`  ✗ ${r.url.padEnd(28)} ${r.email}`)

  console.log(`\nKorjataan (normalisoitu): ${toFix.length}`)
  for (const r of toFix) console.log(`  ~ ${r.from}  →  ${r.to}`)

  if (sentBad.length) {
    console.log(`\n⚠️  JO LÄHETETTY viallinen osoite (ei kosketa, mutta huomioi): ${sentBad.length}`)
    for (const r of sentBad) console.log(`  ! ${r.url.padEnd(28)} ${r.email} (${r.reason})`)
  }

  if (bigOrg.length) {
    console.log(`\nℹ️  Iso organisaatio (>${BIG_ORG_EMPLOYEES} hlö) — harkitse blocklistia, ei nollata: ${bigOrg.length}`)
    for (const r of bigOrg.sort((a, b) => b.employees - a.employees)) {
      console.log(`  · ${r.url.padEnd(28)} ${String(r.employees).padStart(6)} hlö  ${r.email}`)
    }
  }

  if (!APPLY) {
    console.log(`\nDRY-RUN valmis. Aja --apply kun lista näyttää oikealta.`)
    await db.$disconnect()
    process.exit(0)
  }

  // Kirjoita muutokset
  for (const r of toNull) {
    await db.lead.update({ where: { id: r.id }, data: { email: null } })
    await db.domain.update({ where: { id: r.domainId }, data: { email: null } })
  }
  for (const r of toFix) {
    await db.lead.update({ where: { id: r.id }, data: { email: r.to } })
    await db.domain.update({ where: { id: r.domainId }, data: { email: r.to } })
  }

  console.log(`\nValmis. Nollattu ${toNull.length}, korjattu ${toFix.length}.`)
  await db.$disconnect()
  process.exit(0)
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})
