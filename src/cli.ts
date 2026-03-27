import 'dotenv/config'
import fs from 'fs'
import readline from 'readline'
import { addScanJob, scanQueue } from './queue'
import { db } from './db/client'

const [,, command, ...args] = process.argv

async function cmdScan() {
  const url = args[0]
  if (!url) {
    console.error('Käyttö: pnpm scan <url> [--email] [--to osoite@email.fi]')
    process.exit(1)
  }

  const sendEmail = args.includes('--email')
  const toIdx = args.indexOf('--to')
  const emailOverride = toIdx !== -1 ? args[toIdx + 1] : undefined

  const job = await addScanJob({ url, sendEmail, emailOverride })
  console.log(`Työ lisätty jonoon. ID: ${job.id}`)
  console.log(`URL: ${url}`)
  console.log(`Lähetä sähköposti: ${emailOverride ?? (sendEmail ? 'automaattinen haku' : 'ei')}`)
  console.log('\nKäynnistä worker toisessa terminaalissa: pnpm worker')

  await scanQueue.close()
  process.exit(0)
}

async function cmdDiscover() {
  const source = args[0]
  const sendEmail = args.includes('--email')

  // Automaattinen haku: pnpm discover --duckduckgo tai pnpm discover --yritykset
  if (source === '--duckduckgo' || source === '--yritykset') {
    const { discoverFromDuckDuckGo, discoverFromYritykset } = await import('./discovery/index')
    const limitIdx = args.indexOf('--limit')
    const limit = limitIdx !== -1 ? parseInt(args[limitIdx + 1]) : 50

    console.log(`\nA11Y Lead Engine — Automaattinen löytö`)
    console.log(`Lähde: ${source === '--duckduckgo' ? 'DuckDuckGo-haku' : 'yritykset.fi'}`)
    console.log(`Maksimi: ${limit} domainia`)
    console.log(`Lähetä sähköposti: ${sendEmail ? 'kyllä' : 'ei'}`)
    console.log('─────────────────────────────────────\n')

    const result = source === '--duckduckgo'
      ? await discoverFromDuckDuckGo({ limit, sendEmail })
      : await discoverFromYritykset({ sendEmail })

    console.log('\n─────────────────────────────────────')
    console.log(`Löydettiin:     ${result.found} domainia`)
    console.log(`WordPress:      ${result.wordpress} sivustoa`)
    console.log(`Jonoon lisätty: ${result.queued} skannausta`)
    console.log('\nKäynnistä worker: pnpm worker')

    await scanQueue.close()
    process.exit(0)
  }

  // Tiedostosta: pnpm discover domains.txt
  if (!source || !fs.existsSync(source)) {
    console.error('Käyttö:')
    console.error('  pnpm discover domains.txt           Skannaa lista tiedostosta')
    console.error('  pnpm discover --duckduckgo           Hae WP-sivustoja automaattisesti')
    console.error('  pnpm discover --yritykset            Hae yritykset.fi -hakemistosta')
    console.error('  pnpm discover --duckduckgo --limit 100 --email')
    process.exit(1)
  }

  const lines = fs.readFileSync(source, 'utf-8').split('\n').map((l) => l.trim()).filter(Boolean)
  console.log(`Löydettiin ${lines.length} domainia tiedostosta ${source}`)

  let added = 0
  for (const url of lines) {
    try {
      await addScanJob({ url, sendEmail })
      console.log(`  ✓ ${url}`)
      added++
    } catch (e: any) {
      console.error(`  ✗ ${url}: ${e.message}`)
    }
  }

  console.log(`\n${added} työtä lisätty jonoon.`)
  console.log('Käynnistä worker: pnpm worker')

  await scanQueue.close()
  process.exit(0)
}

async function cmdLeads() {
  const leads = await db.lead.findMany({
    include: { domain: true, scan: true },
    orderBy: { createdAt: 'desc' },
    take: 20,
  })

  if (leads.length === 0) {
    console.log('Ei leadeja vielä. Aja ensin: pnpm scan <url>')
    await db.$disconnect()
    process.exit(0)
  }

  console.log('\n─────────────────────────────────────────────────────')
  console.log(' Viimeisimmät leadit')
  console.log('─────────────────────────────────────────────────────')

  for (const l of leads) {
    const sent = l.emailSent ? `✓ lähetetty ${l.email}` : l.email ? `⚡ ${l.email} (ei lähetetty)` : '– ei sähköpostia'
    console.log(`\n  ${l.domain.url}`)
    console.log(`  Pisteet: ${l.scan.score}/100 | Kriittistä: ${l.scan.critical} | Vakavia: ${l.scan.serious}`)
    console.log(`  Sähköposti: ${sent}`)
    console.log(`  PDF: ${l.pdfPath ?? '–'}`)
    console.log(`  Aika: ${l.createdAt.toLocaleString('fi-FI')}`)
  }

  console.log('\n─────────────────────────────────────────────────────\n')
  await db.$disconnect()
  process.exit(0)
}

async function main() {
  switch (command) {
    case 'scan':     await cmdScan();    break
    case 'discover': await cmdDiscover(); break
    case 'leads':    await cmdLeads();   break
    default:
      console.log('A11Y Lead Engine')
      console.log('')
      console.log('Komennot:')
      console.log('  pnpm scan <url>                    Skannaa yksi sivu')
      console.log('  pnpm scan <url> --email            Skannaa + lähetä sähköposti automaattisesti')
      console.log('  pnpm scan <url> --to osoite@fi     Skannaa + lähetä tähän osoitteeseen')
      console.log('  pnpm discover domains.txt          Skannaa lista tiedostosta')
      console.log('  pnpm discover --duckduckgo         Hae WP-sivustoja automaattisesti')
      console.log('  pnpm discover --yritykset          Hae yritykset.fi -hakemistosta')
      console.log('  pnpm discover --duckduckgo --limit 100 --email  Hae + lähetä')
      console.log('  pnpm leads                         Näytä viimeisimmät leadit')
      console.log('  pnpm worker                        Käynnistä worker-prosessi')
      console.log('')
      process.exit(0)
  }
}

main().catch((e) => { console.error(e); process.exit(1) })
