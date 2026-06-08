import 'dotenv/config'
import { db } from './db/client'

/**
 * Merkitsee optOut=true domaineille jotka osuvat brändi-blocklistiin,
 * kirjaamo-patterniin tai kasino-patterniin.
 *
 *   pnpm tsx src/flag-bigorg.ts              # DRY-RUN
 *   pnpm tsx src/flag-bigorg.ts --apply      # kirjoittaa optOut kantaan
 *
 * optOut estää lähetyksen action.workerissa automaattisesti.
 */

const APPLY = process.argv.includes('--apply')

// Brändit joita ei kohdenneta (liian suuria, julkishallinto, sopimaton)
const BRAND_BLOCK = new Set([
  'vtt', 'k-rauta', 'kesko', 'kotipizza', 'helen', 'caruna', 'fortum',
  'sanoma', 'lidl', 'finavia', 'hus', 'valtori', 'oph', 'valtiokonttori',
  'siunsote', 'aalto', 'helsinki', 'hsl', 'traficom', 'veikkaus',
  'migri', 'intermin', 'vm', 'om', 'ym', 'defmin', 'tem',
  'finanssivalvonta', 'kansallisarkisto', 'fingrid', 'varma',
  'alandsbanken', 'nordea', 'op', 'aktia',
])

// Sähköpostin local-part — täsmälleen nämä local-partit (ankkuroitu molemmista päistä)
// kirjaamo[\w.]* sallii kirjaamo.hva, kirjaamo.tem jne. — muut vain exact match
const REGISTRY_LOCAL_RE = /^(kirjaamo(\.[a-z0-9]+)*|registratur|registry|diarium|hatakeskuslaitos)$/i

// Domain-osa: kasino/uhkapeli
const CASINO_HOST_RE = /casino|kasino|kasino\.|bingo|bets?\b|betting|pelata|uhkapelit/i

function hostOf(url: string): string {
  try {
    return new URL(url).hostname.replace(/^www\./, '')
  } catch {
    return url.replace(/^https?:\/\//, '').replace(/^www\./, '').replace(/\/.*$/, '')
  }
}

function brandOf(host: string): string {
  const parts = host.split('.').filter(Boolean)
  return parts.length >= 2 ? parts[parts.length - 2] : host
}

function matchReason(email: string, host: string): string | null {
  const local = email.split('@')[0] ?? ''
  const brand = brandOf(host)
  if (CASINO_HOST_RE.test(host)) return `kasino (${host})`
  if (REGISTRY_LOCAL_RE.test(local)) return `kirjaamo-osoite (${email})`
  if (BRAND_BLOCK.has(brand)) return `brändi-blocklist (${brand})`
  return null
}

async function main() {
  console.log(`Flag-bigorg ${APPLY ? '(APPLY)' : '(DRY-RUN)'}\n`)

  const leads = await db.lead.findMany({
    where: { email: { not: null }, emailSent: false },
    include: { domain: true },
  })

  type Hit = { domainId: string; url: string; email: string; reason: string }
  const hits: Hit[] = []
  const seenDomain = new Set<string>()

  for (const l of leads) {
    if (l.domain.optedOut) continue
    const host = hostOf(l.domain.url)
    const reason = matchReason(l.email!, host)
    if (!reason) continue
    hits.push({ domainId: l.domainId, url: host, email: l.email!, reason })
    seenDomain.add(l.domainId)
  }

  // Yksi rivi per domain (voi olla monta leadia samalle domainille)
  const uniqueHits = hits.filter((h, i) => hits.findIndex(x => x.domainId === h.domainId) === i)

  console.log(`OptOut-merkinnät (${uniqueHits.length} domainia):`)
  console.log('─'.repeat(72))
  for (const h of uniqueHits) {
    console.log(`  ${h.url.padEnd(32)} ${h.email.padEnd(36)} ← ${h.reason}`)
  }

  if (!APPLY) {
    console.log(`\nDRY-RUN valmis. Aja --apply kun lista näyttää oikealta.`)
    await db.$disconnect()
    process.exit(0)
  }

  let updated = 0
  for (const id of seenDomain) {
    await db.domain.update({ where: { id }, data: { optedOut: true } })
    updated++
  }

  console.log(`\nValmis. ${updated} domainia merkitty optOut=true.`)
  await db.$disconnect()
  process.exit(0)
}

main().catch((e) => { console.error(e); process.exit(1) })
