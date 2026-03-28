const YTJ_API = 'https://avoindata.prh.fi/opendata-ytj-api/v3'

export interface YTJCompany {
  businessId: string
  name: string
  tol: string
  tolName: string
}

// TOL-toimialaluokitus — kohderyhmät
export const TOL_NAMES: Record<string, string> = {
  '47': 'Vähittäiskauppa',
  '55': 'Majoitustoiminta',
  '56': 'Ravitsemistoiminta',
  '62': 'Ohjelmistot ja konsultointi',
  '63': 'Tietopalvelutoiminta',
  '68': 'Kiinteistöalan toiminta',
  '72': 'Tutkimus ja kehittäminen',
  '73': 'Mainonta ja markkinatutkimus',
  '74': 'Muut erikoistuneet palvelut',
  '85': 'Koulutus',
  '86': 'Terveyspalvelut',
  '88': 'Sosiaalihuolto',
  '90': 'Taiteet ja viihde',
  '96': 'Muut henkilökohtaiset palvelut',
}

// Toimialat joihin kannattaa kohdistaa
export const TARGET_TOLS = ['47', '55', '56', '68', '85', '86', '88', '90', '96']

export async function lookupYTJ(hostname: string): Promise<YTJCompany | null> {
  const searchTerm = hostname
    .replace(/^www\./, '')
    .replace(/\.(fi|com|net|org|eu|io)$/i, '')
    .replace(/[-_]/g, ' ')
    .trim()

  if (!searchTerm || searchTerm.length < 3) return null

  // Kokeile myös ä/ö-variantit jos alkuperäinen ei löydy
  const variants = Array.from(new Set([
    searchTerm,
    searchTerm.replace(/a/g, 'ä').replace(/A/g, 'Ä'),
    searchTerm.replace(/o/g, 'ö').replace(/O/g, 'Ö'),
  ]))

  try {
    for (const term of variants) {
      const url = `${YTJ_API}/companies?name=${encodeURIComponent(term)}&maxResults=5`
      const res = await fetch(url, {
        headers: { Accept: 'application/json' },
        signal: AbortSignal.timeout(5000),
      })
      if (!res.ok) continue

      const json = await res.json() as any
      const companies: any[] = json?.companies ?? []
      if (companies.length === 0) continue

      // Suosi nimitarkkaa vastausta — käytä type "1" (virallinen nimi)
      const match =
        companies.find((c) =>
          c.names?.some((n: any) => n.type === '1' && !n.endDate)
        ) ?? companies[0]

      // Virallinen nimi (type "1"), uusin ensin
      const officialName =
        match.names
          ?.filter((n: any) => n.type === '1' && !n.endDate)
          .sort((a: any, b: any) => b.registrationDate?.localeCompare(a.registrationDate ?? '') ?? 0)[0]
          ?.name ?? ''

      // TOL-koodi — 5-merkkinen, käytä 2 ensimmäistä
      const tolCode: string = match?.mainBusinessLine?.type ?? ''
      const tol = tolCode.slice(0, 2)

      // Suomenkielinen kuvaus (languageCode "1" = suomi)
      const fiDesc =
        match?.mainBusinessLine?.descriptions?.find((d: any) => d.languageCode === '1')?.description ?? ''

      const tolName = TOL_NAMES[tol] ?? fiDesc ?? tolCode

      return {
        businessId: match.businessId?.value ?? '',
        name: officialName,
        tol,
        tolName,
      }
    }
    return null
  } catch {
    return null
  }
}
