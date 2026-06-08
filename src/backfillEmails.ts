import 'dotenv/config'
import { Queue } from 'bullmq'
import { db } from './db/client'
import { connection } from './queue'

const queue = new Queue('email-discovery', { connection })

async function main() {
  const leads = await db.lead.findMany({
    where: { email: null },
    select: { id: true, domain: { select: { url: true } } },
  })

  console.log(`Jonoon lisätään ${leads.length} leadia ilman sähköpostia...`)

  await queue.addBulk(
    leads.map((l) => ({
      name: 'discover',
      data: { leadId: l.id, domain: l.domain.url },
      opts: {
        attempts: 2,
        backoff: { type: 'exponential' as const, delay: 5000 },
        removeOnComplete: 1000,
        removeOnFail: 500,
      },
    }))
  )

  console.log('Valmis. Seuraa worker:email lokia edistymistä varten.')
  await queue.close()
  await db.$disconnect()
  process.exit(0)
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})
