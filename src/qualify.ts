import { db } from './db/client'
import { QUALIFIED_THRESHOLD } from './config'

/**
 * Re-evaluate ENRICHED -> QUALIFIED kun sähköposti asetetaan/korjataan
 * enrichment-vaiheen jälkeen. enrich.worker asettaa statuksen vain kertaalleen;
 * ilman tätä jälkikäteen lisätty email jättää liidin pysyvästi ENRICHED-tilaan.
 */
export async function requalifyIfEligible(leadId: string): Promise<boolean> {
  const lead = await db.lead.findUnique({ where: { id: leadId }, include: { scan: true, domain: true } })
  if (!lead) return false
  const eligible =
    lead.status === 'ENRICHED' &&
    !!lead.email &&
    lead.scan.score >= QUALIFIED_THRESHOLD &&
    !lead.domain.optedOut
  if (eligible) {
    await db.lead.update({ where: { id: leadId }, data: { status: 'QUALIFIED' } })
  }
  return eligible
}
