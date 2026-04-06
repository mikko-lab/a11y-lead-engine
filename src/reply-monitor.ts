import 'dotenv/config'
import { ImapFlow } from 'imapflow'
import { db } from './db/client'

const POLL_INTERVAL_MS = 5 * 60 * 1000 // 5 min

function createClient() {
  return new ImapFlow({
    host:   process.env.IMAP_HOST ?? process.env.SMTP_HOST ?? '',
    port:   Number(process.env.IMAP_PORT ?? 993),
    secure: Number(process.env.IMAP_PORT ?? 993) === 993,
    auth: {
      user: process.env.IMAP_USER ?? process.env.SMTP_USER ?? '',
      pass: process.env.IMAP_PASS ?? process.env.SMTP_PASS ?? '',
    },
    logger: false,
  })
}

async function checkReplies() {
  const client = createClient()
  try {
    await client.connect()
    await client.mailboxOpen('INBOX')

    // Hae lukemattomat viestit
    const messages = client.fetch('1:*', { envelope: true, flags: true })

    const newReplies: { uid: number; from: string }[] = []
    for await (const msg of messages) {
      if (!msg.flags || !msg.envelope) continue
      if (msg.flags.has('\\Seen')) continue
      const from = msg.envelope.from?.[0]?.address?.toLowerCase()
      if (from) newReplies.push({ uid: msg.uid, from })
    }

    if (newReplies.length === 0) {
      await client.logout()
      return
    }

    // Matchaa leadeihin — hae kaikki lähetetyt leadit joilla on email
    const sentLeads = await db.lead.findMany({
      where: { emailSent: true, repliedAt: null },
      select: { id: true, email: true },
    })

    const emailToLeadId = new Map(
      sentLeads
        .filter(l => l.email)
        .map(l => [l.email!.toLowerCase(), l.id])
    )

    for (const { uid, from } of newReplies) {
      const leadId = emailToLeadId.get(from)
      if (leadId) {
        await db.lead.update({
          where: { id: leadId },
          data: { repliedAt: new Date(), status: 'REPLIED' },
        })
        console.log(`[reply] ${from} → REPLIED`)
      }

      // Merkitse luetuksi
      await client.messageFlagsAdd({ uid }, ['\\Seen'])
    }

    await client.logout()
  } catch (err) {
    console.error(`[reply-monitor:VIRHE] ${(err as Error).message}`)
    try { await client.logout() } catch {}
  }
}

async function run() {
  console.log(`reply-monitor käynnissä (poll ${POLL_INTERVAL_MS / 1000}s välein)`)
  while (true) {
    await checkReplies()
    await new Promise(r => setTimeout(r, POLL_INTERVAL_MS))
  }
}

run()
