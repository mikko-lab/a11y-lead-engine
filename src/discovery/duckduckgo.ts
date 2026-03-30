const BRAVE_API_KEY = process.env.BRAVE_SEARCH_API_KEY ?? ''

export async function searchWordPressSites(query: string, limit = 20): Promise<string[]> {
  const results: string[] = []

  try {
    const url = `https://api.search.brave.com/res/v1/web/search?q=${encodeURIComponent(query)}&count=20&country=fi&search_lang=fi`
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
  'tilitoimisto palvelut suomi',
  'hammaslääkäri vastaanotto ajanvaraus',
  'fysioterapia kuntoutus suomi',
  'lakitoimisto asianajaja suomi',
  'rakennusyritys remontti suomi',
  'autokorjaamo huolto suomi',
  'parturi kampaamo hiustenleikkaus',
  'kiinteistövälitys asunnot suomi',
  'siivouspalvelu kotisiivous suomi',
  'ravintola lounas suomi',
  'hieronta hyvinvointi suomi',
  'optikko silmälasit suomi',
  'markkinointitoimisto mainos suomi',
]
