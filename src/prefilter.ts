const ACCEPTED_LANGS = ['fi', 'en', 'sv']
const TIMEOUT_MS = 6000

export interface PreFilterResult {
  pass: boolean
  reason?: string
  isWP: boolean
  lang: string | null
  hasCta: boolean
}

export async function preFilter(url: string): Promise<PreFilterResult> {
  const normalized = url.startsWith('http') ? url : `https://${url}`

  let html: string
  let contentLanguage: string | null = null

  try {
    const res = await fetch(normalized, {
      signal: AbortSignal.timeout(TIMEOUT_MS),
      headers: { 'User-Agent': 'Mozilla/5.0 (compatible; a11y-checker/1.0)' },
      redirect: 'follow',
    })

    if (res.status >= 400) {
      return { pass: false, reason: `HTTP ${res.status}`, isWP: false, lang: null, hasCta: false }
    }

    contentLanguage = res.headers.get('content-language')
    html = await res.text()
  } catch (e: any) {
    const reason = e.name === 'TimeoutError' ? 'timeout' : 'connection error'
    return { pass: false, reason, isWP: false, lang: null, hasCta: false }
  }

  // Language check
  const langMatch = html.match(/<html[^>]+lang=["']([^"']+)["']/i)
  const rawLang = langMatch?.[1] ?? contentLanguage?.split(',')[0]?.trim() ?? null
  const lang = rawLang?.toLowerCase().split('-')[0] ?? null

  if (lang && !ACCEPTED_LANGS.includes(lang)) {
    return { pass: false, reason: `kieli: ${rawLang}`, isWP: false, lang, hasCta: false }
  }

  // WordPress detection
  const isWP =
    /wp-content|wp-includes|\/wp-json\//.test(html) ||
    /<meta[^>]+generator[^>]+WordPress/i.test(html) ||
    /<meta[^>]+WordPress[^>]+generator/i.test(html)

  // CTA / form detection
  const hasCta =
    /<form[\s>]/i.test(html) ||
    /type=["']submit["']/i.test(html) ||
    /<button/i.test(html) ||
    /ota yhteyttä|tilaa|varaa aika|pyydä tarjous|contact us/i.test(html)

  if (!hasCta) {
    return { pass: false, reason: 'ei lomaketta tai CTA:ta', isWP, lang, hasCta }
  }

  return { pass: true, isWP, lang, hasCta }
}
