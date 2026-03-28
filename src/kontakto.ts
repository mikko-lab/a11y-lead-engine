// Kontakto.fi — suomalainen B2B-kontaktitietokanta
// API-avain: KONTAKTO_API_KEY ympäristömuuttujaan
// Dokumentaatio: https://kontakto.fi (kirjaudu sisään → API-osio)

const KONTAKTO_API = 'https://api.kontakto.fi/v1'

export interface KontaktoContact {
  email: string
  name?: string
  title?: string
}

export interface KontaktoResult {
  companyName: string
  businessId?: string
  contacts: KontaktoContact[]
}

export async function lookupKontakto(domain: string): Promise<KontaktoResult | null> {
  if (!process.env.KONTAKTO_API_KEY) return null

  const hostname = domain.replace(/^https?:\/\//, '').replace(/\/.*$/, '').replace(/^www\./, '')

  try {
    const res = await fetch(`${KONTAKTO_API}/companies/search?domain=${encodeURIComponent(hostname)}`, {
      headers: {
        Authorization: `Bearer ${process.env.KONTAKTO_API_KEY}`,
        Accept: 'application/json',
      },
      signal: AbortSignal.timeout(5000),
    })

    if (!res.ok) return null

    const json = await res.json() as any
    const company = json?.data?.[0] ?? json?.results?.[0] ?? json?.company ?? null
    if (!company) return null

    const contacts: KontaktoContact[] = (company.contacts ?? company.persons ?? [])
      .filter((c: any) => c.email)
      .map((c: any) => ({
        email: c.email,
        name: c.name ?? c.firstName ? `${c.firstName ?? ''} ${c.lastName ?? ''}`.trim() : undefined,
        title: c.title ?? c.jobTitle ?? undefined,
      }))

    return {
      companyName: company.name ?? company.companyName ?? '',
      businessId: company.businessId ?? company.ytunnus ?? undefined,
      contacts,
    }
  } catch {
    return null
  }
}

// Palauttaa parhaan sähköpostin kontaktilistasta
// Suosii päätöksentekijöitä: toimitusjohtaja, yrittäjä, omistaja
export function pickBestEmail(result: KontaktoResult): string | null {
  if (result.contacts.length === 0) return null

  const decisionMaker = result.contacts.find((c) =>
    /toimitusjohtaja|ceo|yrittäjä|omistaja|owner|founder|johtaja|director/i.test(c.title ?? '')
  )

  return decisionMaker?.email ?? result.contacts[0].email
}
