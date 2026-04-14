import { Queue } from 'bullmq'
import IORedis from 'ioredis'

export const connection = new IORedis(process.env.REDIS_URL ?? 'redis://localhost:6379', {
  maxRetriesPerRequest: null,
})

// ── Job data types ────────────────────────────────────────────────────────────

export interface ScanJobData {
  url: string
  sendEmail: boolean
  emailOverride?: string
  source?: string
}

export interface EnrichJobData {
  leadId: string
  url: string
  sendEmail: boolean
  emailOverride?: string
}

export interface AiJobData {
  leadId: string
  sendEmail: boolean
}

export interface ActionJobData {
  leadId: string
  sendEmail: boolean
}

export interface GeoJobData {
  siteId: string
  pageId?: string  // jos asetettu, analysoidaan vain tämä sivu (manuaalinen tila)
}

// ── Queues ────────────────────────────────────────────────────────────────────

export const scanQueue   = new Queue<ScanJobData>('scan',   { connection })
export const enrichQueue = new Queue<EnrichJobData>('enrich', { connection })
export const aiQueue     = new Queue<AiJobData>('ai',     { connection })
export const actionQueue = new Queue<ActionJobData>('action', { connection })
export const geoQueue    = new Queue<GeoJobData>('geo',    { connection })

export async function addScanJob(data: ScanJobData) {
  return scanQueue.add('scan-url', data, {
    attempts: 2,
    backoff: { type: 'exponential', delay: 5000 },
  })
}
