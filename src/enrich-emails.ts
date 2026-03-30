import 'dotenv/config'
import { db } from './db/client'
import { findEmail } from './enrichment'

async function main() {
  const leads = await db.lead.findMany({
    where: { email: null },
    include: { domain: true },
    take: 200,
  })

  console.log(`Haetaan sähköpostit ${leads.length} liidin kohdalle...\n`)

  let found = 0
  for (const lead of leads) {
    const url = lead.domain.url
    process.stdout.write(`  ${url} → `)
    try {
      const email = await findEmail(url)
      if (email) {
        await db.lead.update({ where: { id: lead.id }, data: { email } })
        await db.domain.update({ where: { id: lead.domainId }, data: { email } })
        console.log(email)
        found++
      } else {
        console.log('ei löydy')
      }
    } catch (e: any) {
      console.log(`virhe: ${e.message}`)
    }
  }

  console.log(`\nValmis! Löydettiin ${found}/${leads.length} sähköpostia.`)
}

main().catch(console.error).finally(() => process.exit(0))
