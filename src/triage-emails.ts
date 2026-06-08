import 'dotenv/config'
import { db } from './db/client'

const ROLE_RE = /^(info|myynti|asiakaspalvelu|contact|hello|hei|sales|office|toimisto|yhteys|tuki|support|markkinointi|viestinta|media|kirjaamo|palaute|tilaukset|laskutus|accounts|billing)@/i

async function main() {
  const leads = await db.lead.findMany({
    where: { email: { not: null }, emailSent: false },
    include: { domain: { select: { url: true, company: true, employees: true, revenue: true } } },
    orderBy: [{ domain: { employees: { sort: 'desc', nulls: 'last' } } }],
  })

  const role: typeof leads = []
  const personal: typeof leads = []

  for (const l of leads) {
    if (ROLE_RE.test(l.email!)) role.push(l)
    else personal.push(l)
  }

  console.log(`\n━━━ TRIAGE — ${leads.length} lähettämätöntä sähköpostia ━━━\n`)

  console.log(`✅  ROOLIOSOITTEET (${role.length}) — turvallisia lähettää`)
  console.log('─'.repeat(72))
  for (const l of role) {
    const emp = l.domain.employees ? `${l.domain.employees} hlö` : '? hlö'
    const rev = l.domain.revenue ? `${Math.round(l.domain.revenue / 1000)}t€` : '?'
    const host = new URL(l.domain.url).hostname
    console.log(`  ${l.email!.padEnd(38)} ${host.padEnd(24)} ${emp.padStart(8)}  ${rev.padStart(8)}`)
  }

  console.log(`\n⚠️   HENKILÖNIMET (${personal.length}) — tarkista isot organisaatiot`)
  console.log('─'.repeat(72))
  for (const l of personal) {
    const emp = l.domain.employees ? `${l.domain.employees} hlö` : '? hlö'
    const rev = l.domain.revenue ? `${Math.round(l.domain.revenue / 1000)}t€` : '?`'
    const host = new URL(l.domain.url).hostname
    const flag = l.domain.employees && l.domain.employees > 50 ? ' ← ISO' : ''
    console.log(`  ${l.email!.padEnd(38)} ${host.padEnd(24)} ${emp.padStart(8)}  ${rev.padStart(8)}${flag}`)
  }

  console.log('\n')
  await db.$disconnect()
}

main().catch((e) => { console.error(e); process.exit(1) })
