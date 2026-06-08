import 'dotenv/config'
import { Worker, type Job } from 'bullmq'
import { chromium, type Browser } from 'playwright'
import { db } from './db/client'
import { harvestEmails } from './emailHarvester'
import { connection } from './queue'

interface EmailJobData {
  leadId: string
  domain: string
}

let browser: Browser | null = null
async function getBrowser(): Promise<Browser> {
  if (!browser || !browser.isConnected()) {
    browser = await chromium.launch({ headless: true })
  }
  return browser
}

const worker = new Worker<EmailJobData>(
  'email-discovery',
  async (job: Job<EmailJobData>) => {
    const { leadId, domain } = job.data
    const b = await getBrowser()

    const result = await harvestEmails(domain, { browser: b })

    if (!result.best) {
      return { found: false, hasMx: result.hasMx }
    }

    await db.lead.update({
      where: { id: leadId },
      data: {
        email: result.best.email,
        emailSource: result.best.source.toUpperCase(),
        emailConfidence: result.best.confidence,
      },
    })

    return {
      found: true,
      email: result.best.email,
      source: result.best.source,
      confidence: result.best.confidence,
    }
  },
  { connection, concurrency: 4 }
)

worker.on('completed', (job, ret) => {
  if (ret?.found) console.log(`✓ ${job.data.domain} → ${ret.email} (${ret.source}, ${ret.confidence})`)
  else console.log(`– ${job.data.domain}: ei löytynyt (hasMx: ${ret?.hasMx})`)
})
worker.on('failed', (job, err) => {
  console.error(`✗ ${job?.data.domain}: ${err.message}`)
})

async function shutdown() {
  await worker.close()
  if (browser?.isConnected()) await browser.close()
  await db.$disconnect()
  process.exit(0)
}
process.on('SIGTERM', shutdown)
process.on('SIGINT', shutdown)

console.log('Email discovery worker käynnissä (concurrency 4)')
