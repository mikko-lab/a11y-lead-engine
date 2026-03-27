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
  console.log(`Lähetä sähköposti: ${sendEmail ? (emailOverride ?? 'automaattinen haku') : 'ei'}`)
  console.log('\nKäynnistä worker toisessa terminaalissa: pnpm worker')

  await scanQueue.close()
  process.exit(0)
}

async function cmdDiscover() {
  const file = args[0]
  if (!file || !fs.existsSync(file)) {
    console.error('Käyttö: pnpm discover domains.txt')
    console.error('\ndomain.txt formaatti (yksi per rivi):')
    console.error('  https://esimerkki.fi')
    console.error('  toinen.fi')
    process.exit(1)
  }

  const sendEmail = args.includes('--email')
  const lines = fs.readFileSync(file, 'utf-8').split('\n').map((l) => l.trim()).filter(Boolean)
  console.log(`Löydettiin ${lines.length} domainia tiedostosta ${file}`)

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
      console.log('  pnpm discover domains.txt          Skannaa lista domaineista')
      console.log('  pnpm discover domains.txt --email  Skannaa + lähetä kaikille')
      console.log('  pnpm leads                         Näytä viimeisimmät leadit')
      console.log('  pnpm worker                        Käynnistä worker-prosessi')
      console.log('')
      process.exit(0)
  }
}

main().catch((e) => { console.error(e); process.exit(1) })
