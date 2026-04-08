/**
 * pnpm vroegsignaal
 *
 * Pre-lawsuit detection — toegankelijkheidsverklaring.nl
 *
 * Hakee organisaatiot jotka ovat itse ilmoittaneet
 * etteivät täytä WCAG-vaatimuksia. Nämä ovat 6–12 kk
 * ennen oikeustapauksia — markkina kertoo itse kuka tarvitsee apua.
 *
 * Käyttö:
 *   pnpm vroegsignaal              — voldoet-niet + eerste-maatregelen
 *   pnpm vroegsignaal --kaikki     — myös gedeeltelijk
 *   pnpm vroegsignaal --sivut 20   — max sivuja per status (oletus 5)
 */

import 'dotenv/config'
import { scrapeToegang, STATUS_PRIORITY, ComplianceStatus } from './discovery/toegankelijkheid'
import { db } from './db/client'
import { scanQueue } from './queue'

const args = process.argv.slice(2)
const kaikki = args.includes('--kaikki')
const sivutIdx = args.indexOf('--sivut')
const maxPages = sivutIdx !== -1 ? parseInt(args[sivutIdx + 1]) : 5

const statuses: ComplianceStatus[] = kaikki
  ? ['voldoet-niet', 'eerste-maatregelen', 'voldoet-gedeeltelijk']
  : ['voldoet-niet', 'eerste-maatregelen']

const STATUS_LABEL: Record<string, string> = {
  'voldoet-niet':         '🔴 Ei täytä vaatimuksia',
  'eerste-maatregelen':   '🟡 Aloitettu mutta kesken',
  'voldoet-gedeeltelijk': '🟠 Täyttää osittain',
}

async function main() {
  console.log('\nA11Y Lead Engine — Vroegsignaal (Pre-Lawsuit Detection)')
  console.log('────────────────────────────────────────────────────────')
  console.log(`Lähde:   toegankelijkheidsverklaring.nl`)
  console.log(`Status:  ${statuses.join(', ')}`)
  console.log(`Sivuja:  max ${maxPages} per status (~${maxPages * 50} organisaatiota)`)
  console.log('────────────────────────────────────────────────────────\n')

  const orgs = await scrapeToegang({
    statuses,
    maxPages,
    onProgress: console.log,
  })

  console.log(`\n────────────────────────────────────────────────────────`)
  console.log(`Löydettiin ${orgs.length} organisaatiota`)
  console.log('────────────────────────────────────────────────────────\n')

  let uusia = 0
  let ohitettu = 0

  for (const org of orgs) {
    const caseRef = `toegankelijkheid:${org.declarationId}`

    const olemassa = await db.courtLead.findUnique({ where: { caseRef } })
    if (olemassa) { ohitettu++; continue }

    const { salesPriority, accessibilityRisk } = STATUS_PRIORITY[org.status]

    await db.courtLead.create({
      data: {
        source:            'toegankelijkheid',
        caseRef,
        caseUrl:           org.declarationUrl,
        caseTitle:         `${org.serviceName || org.orgName} — ${STATUS_LABEL[org.status] ?? org.status}`,
        country:           'NL',
        orgName:           org.orgName,
        orgWebsite:        org.serviceUrl ?? undefined,
        sector:            'public_authority', // rekisteri kattaa pääosin julkisen sektorin
        accessibilityRisk,
        salesPriority,
        confidence:        0.95,  // itse ilmoitettu — korkea varmuus
        wcagRelevant:      true,
        suggestedAngle:    `${org.orgName} has self-declared non-compliance with WCAG/EN 301 549. This is an explicit, documented accessibility gap — the ideal moment to offer remediation support before regulatory action follows.`,
        aiSummary:         `${org.orgName} on ilmoittanut saavutettavuusselosterekisterissä statukseksi "${STATUS_LABEL[org.status] ?? org.status}". Organisaatio on tietoinen ongelmastaan mutta ei ole vielä korjannut sitä — optimaalinen hetki tarjota apua ennen viranomaistoimia.`,
        caseDate:          org.lastModified ?? undefined,
        status:            'NEW',
        // legacy
        priorityScore:     salesPriority,
        contactAngle:      `${org.orgName} — ${STATUS_LABEL[org.status] ?? org.status}`,
      },
    })

    uusia++
    console.log(`  ✓ ${STATUS_LABEL[org.status] ?? org.status}  ${org.orgName}`)
    if (org.serviceUrl) console.log(`    ${org.serviceUrl}`)
  }

  console.log(`\n────────────────────────────────────────────────────────`)
  console.log(`Uusia liidejä:    ${uusia}`)
  console.log(`Jo tallennettu:   ${ohitettu}`)

  if (uusia > 0) {
    const top = await db.courtLead.findMany({
      where: { source: 'toegankelijkheid', status: 'NEW' },
      orderBy: { salesPriority: 'desc' },
      take: 5,
    })
    console.log('\nTop 5 (prioriteetti):')
    for (const t of top) {
      console.log(`  ${t.salesPriority}/10 · ${t.orgName}`)
    }
    console.log('\nKatso kaikki: pnpm dashboard → ⚖️ Kanteet')
  }

  await db.$disconnect()
  await scanQueue.close()
}

main().catch((e) => { console.error(e); process.exit(1) })
