import 'dotenv/config'
import { db } from './db/client'
import { aiQueue } from './queue'

const APPLY  = process.argv.includes('--apply')
const LIMIT  = (() => {
  const i = process.argv.indexOf('--limit')
  return i !== -1 ? Number(process.argv[i + 1]) : Infinity
})()

async function main() {
  const label = APPLY ? '(APPLY)' : '(DRY-RUN)'
  const limitLabel = isFinite(LIMIT) ? `, limit ${LIMIT}` : ''
  console.log(`Requeue-enriched ${label}${limitLabel}\n`)

  const leads = await db.lead.findMany({
    where: {
      status: 'ENRICHED',
      email: { not: null },
      emailSent: false,
      domain: { optedOut: false },
    },
    select: { id: true, domain: { select: { url: true } } },
    orderBy: { createdAt: 'desc' },
    take: isFinite(LIMIT) ? LIMIT : undefined,
  })

  console.log(`ENRICHED-leadeja jonoon: ${leads.length}`)
  if (!APPLY) {
    console.log('\nDRY-RUN — aja --apply lisätäksesi ai-jonoon.')
    console.log('Canary: --limit 15 --apply')
    await db.$disconnect()
    return
  }

  let ok = 0
  for (const lead of leads) {
    await aiQueue.add('ai', { leadId: lead.id, sendEmail: true }, {
      attempts: 2,
      backoff: { type: 'exponential', delay: 5000 },
    })
    ok++
    if (ok % 10 === 0) console.log(`  ${ok}/${leads.length} jonoon...`)
  }

  console.log(`\nValmis. ${ok} jobia lisätty ai-jonoon → ai.worker → action.worker → lähetys.`)
  await db.$disconnect()
}

main().catch(e => { console.error(e); process.exit(1) })
