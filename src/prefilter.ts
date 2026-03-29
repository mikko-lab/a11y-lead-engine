const ACCEPTED_LANGS = ['fi', 'en', 'sv']
const TIMEOUT_MS = 6000

// Kaupungit, viranomaiset, koulut — tarkistetaan hostnamesta ennen fetchiä
const GOV_HOSTNAME_RE = /\b(kela|vero|stat|avi|ely-keskus|te-palvelut|dvv|traficom|ruokavirasto|fimea|ttl|thl|mela|mavi|prh|evira|valvira|tukes|syke|metla|stuk|fmi|ymparisto|mol\.fi)\b|\.gov\.fi$|\.edu\.fi$|\.ac\.fi$|\b(yliopisto|amk|ammattikorkeakoulu|korkeakoulu|lukio|peruskoulu|oppilaitos)\b/i

const CITY_DOMAINS = new Set([
  'hel.fi','espoo.fi','tampere.fi','vantaa.fi','oulu.fi','turku.fi',
  'jyvaskyla.fi','lahti.fi','kuopio.fi','pori.fi','joensuu.fi','lappeenranta.fi',
  'vaasa.fi','kouvola.fi','rovaniemi.fi','seinajoki.fi','kotka.fi','mikkeli.fi',
  'hameenlinna.fi','porvoo.fi','lohja.fi','joensuu.fi','hyvinkaa.fi','nurmijärvi.fi',
  'järvenpää.fi','rauma.fi','kajaani.fi','kerava.fi','savonlinna.fi',
])

const KUNTA_RE = /\b(kunta|kaupunki|seurakunta|virasto|ministeri|valtion|valtio|poliisi)\b/i

// Enterprise-signaalit HTML-otsikosta / meta-descriptionista
const ENTERPRISE_TITLE_RE = /\boyj\b|\bkonserni\b|\bgroup\b|\bholding\b|\binternational\b|\bglobal\b|\bcorporation\b|\bcorp\b/i

function isGovOrEnterprise(hostname: string, html: string): string | null {
  const host = hostname.replace(/^www\./, '')

  // Kaupunkidomain
  if (CITY_DOMAINS.has(host)) return 'kaupunki/kuntadomain'

  // Hostname-tasoiset viranomais-/koulutunnisteet
  if (GOV_HOSTNAME_RE.test(host)) return 'viranomainen/koulu'

  // Kuntasanat hostnamessa
  if (KUNTA_RE.test(host)) return 'kunta/virasto'

  // Enterprise-signaalit sivun otsikossa tai meta-descriptionissa
  const titleMatch = html.match(/<title[^>]*>([^<]{1,200})<\/title>/i)
  const title = titleMatch?.[1] ?? ''
  const metaDesc = html.match(/<meta[^>]+name=["']description["'][^>]+content=["']([^"']{1,300})["']/i)?.[1] ?? ''

  if (ENTERPRISE_TITLE_RE.test(title) || ENTERPRISE_TITLE_RE.test(metaDesc)) {
    return 'enterprise/konserni'
  }

  return null
}

export interface PreFilterResult {
  pass: boolean
  reason?: string
  isWP: boolean
  lang: string | null
  hasCta: boolean
  hasAccessibilityStatement: boolean
  siteLastModified: Date | null
}

export async function preFilter(url: string): Promise<PreFilterResult> {
  const normalized = url.startsWith('http') ? url : `https://${url}`

  const empty: PreFilterResult = {
    pass: false, reason: '', isWP: false, lang: null,
    hasCta: false, hasAccessibilityStatement: false, siteLastModified: null,
  }

  let html: string
  let contentLanguage: string | null = null
  let lastModifiedHeader: string | null = null

  try {
    const res = await fetch(normalized, {
      signal: AbortSignal.timeout(TIMEOUT_MS),
      headers: { 'User-Agent': 'Mozilla/5.0 (compatible; a11y-checker/1.0)' },
      redirect: 'follow',
    })

    if (res.status >= 400) {
      return { ...empty, reason: `HTTP ${res.status}` }
    }

    contentLanguage  = res.headers.get('content-language')
    lastModifiedHeader = res.headers.get('last-modified')
    html = await res.text()
  } catch (e: any) {
    return { ...empty, reason: e.name === 'TimeoutError' ? 'timeout' : 'connection error' }
  }

  // Enterprise / gov filter
  const hostname = new URL(normalized).hostname
  const govReason = isGovOrEnterprise(hostname, html)
  if (govReason) {
    return { ...empty, reason: govReason }
  }

  // Language check
  const langMatch = html.match(/<html[^>]+lang=["']([^"']+)["']/i)
  const rawLang = langMatch?.[1] ?? contentLanguage?.split(',')[0]?.trim() ?? null
  const lang = rawLang?.toLowerCase().split('-')[0] ?? null

  if (lang && !ACCEPTED_LANGS.includes(lang)) {
    return { ...empty, reason: `kieli: ${rawLang}`, lang }
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
    return { ...empty, isWP, lang, reason: 'ei lomaketta tai CTA:ta' }
  }

  // Accessibility statement detection
  const hasAccessibilityStatement =
    /saavutettavuusseloste|accessibility.statement|tillg[äa]nglighetsredog/i.test(html) ||
    /href=["'][^"']*saavutettavuus[^"']*["']/i.test(html) ||
    /href=["'][^"']*accessibility[^"']*["']/i.test(html)

  // Last-Modified header
  const siteLastModified = lastModifiedHeader ? new Date(lastModifiedHeader) : null

  return { pass: true, isWP, lang, hasCta, hasAccessibilityStatement, siteLastModified }
}
