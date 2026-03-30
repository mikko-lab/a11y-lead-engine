import { Queue } from 'bullmq'
import IORedis from 'ioredis'

export const connection = new IORedis(process.env.REDIS_URL ?? 'redis://localhost:6379', {
  maxRetriesPerRequest: null,
})

export const scanQueue = new Queue('scan', { connection })

export interface ScanJobData {
  url: string
  sendEmail: boolean
  emailOverride?: string // if set, send to this instead of discovered email
  source?: string        // e.g. "DuckDuckGo", "yritykset.fi / Ravintolat"
}

export async function addScanJob(data: ScanJobData) {
  return scanQueue.add('scan-url', data, {
    attempts: 2,
    backoff: { type: 'exponential', delay: 5000 },
  })
}
