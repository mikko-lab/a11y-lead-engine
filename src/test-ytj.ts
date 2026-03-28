import 'dotenv/config'
import { lookupYTJ, TARGET_TOLS } from './ytj'

const TEST_DOMAINS = [
  'medialinja.com',
  'fonecta.fi',
  'lähitapiola.fi',
  'mehilainen.fi',
  'scandic.fi',
  'sello.fi',
  'oulu.fi',
  'heltti.com',
  'kotikatu.fi',
  'rakennusliitto.fi',
]

async function main() {
  console.log('YTJ-testiajo\n' + '─'.repeat(60))

  let found = 0
  let targeted = 0

  for (const domain of TEST_DOMAINS) {
    const result = await lookupYTJ(domain)
    if (result) {
      found++
      const isTarget = TARGET_TOLS.includes(result.tol)
      if (isTarget) targeted++
      const tag = isTarget ? '🎯' : '  '
      console.log(`${tag} ${domain}`)
      console.log(`   Yritys:    ${result.name}`)
      console.log(`   Y-tunnus:  ${result.businessId}`)
      console.log(`   TOL ${result.tol}:    ${result.tolName}`)
    } else {
      console.log(`   ${domain} — ei löydy`)
    }
    console.log()
  }

  console.log('─'.repeat(60))
  console.log(`Löytyi: ${found}/${TEST_DOMAINS.length} | Kohderyhmä (🎯): ${targeted}`)
}

main().catch(console.error)
