const BRAVE_API_KEY = process.env.BRAVE_SEARCH_API_KEY ?? ''

export async function searchWordPressSites(query: string, limit = 20): Promise<string[]> {
  const results: string[] = []

  try {
    const url = `https://api.search.brave.com/res/v1/web/search?q=${encodeURIComponent(query)}&count=20&country=fi&search_lang=fi&result_filter=web`
    const res = await fetch(url, {
      headers: {
        'Accept': 'application/json',
        'X-Subscription-Token': BRAVE_API_KEY,
      },
      signal: AbortSignal.timeout(10000),
    })

    if (!res.ok) return results

    const data = await res.json()
    for (const result of (data.web?.results ?? [])) {
      if (results.length >= limit) break
      try {
        const parsed = new URL(result.url)
        const clean = `${parsed.protocol}//${parsed.hostname}`
        if (!results.some(r => r.includes(parsed.hostname))) {
          results.push(clean)
        }
      } catch {}
    }
  } catch {}

  return results
}

export const WP_QUERIES = [
  'tilitoimisto wordpress verkkosivut suomi',
  'hammaslääkäri wordpress vastaanotto',
  'fysioterapia wordpress ajanvaraus',
  'lakitoimisto wordpress palvelut',
  'rakennusyritys wordpress kotisivu',
  'autokorjaamo wordpress varaa aika',
  'parturi kampaamo wordpress',
  'kiinteistövälitys wordpress',
  'siivouspalvelu wordpress kotisivu',
  'ravintola wordpress varaus',
  'hieronta wordpress ajanvaraus',
  'optikko wordpress silmälasit',
  'markkinointitoimisto wordpress palvelut',
]
