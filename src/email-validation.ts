/**
 * Sähköpostin validointi — YKSI totuuslähde.
 * Sekä findEmail (kaikki lähteet) että cleanup-skripti käyttävät tätä,
 * jotta sama roska ei pääse läpi missään polussa.
 */

const EMAIL_SHAPE = /^[a-z0-9._%+\-]+@[a-z0-9.\-]+\.[a-z]{2,}$/i
const ASSET_EXT = /\.(png|jpe?g|svg|gif|webp|woff2?|ttf|eot|ico|css|js|mjs|map)$/i
const HEX_KEY = /^[a-f0-9]{16,}$/i // Sentry DSN / kone-avaimet
const FAKE_TOKEN =
  /noreply|no-?reply|donotreply|do-not-reply|wordpress|wixpress|lorem|sentry|\.ingest\.|mailer-daemon|postmaster/i
const PH_LOCAL =
  /^(user|malli|your|you|name|nimi|email|sahkoposti|sähköposti|test|demo|example|esimerkki|placeholder)$/i
const PH_NAME =
  /^(etunimi\.sukunimi|firstname\.lastname|first\.last|name\.surname|nimi\.sukunimi|forename\.surname)$/i
const PH_DOMAIN = /^(domain|example|yourdomain|company|sukunimi)\.(com|fi|net|org)$/i

/** Normalisoi ja validoi. Palauttaa siistityn osoitteen tai null. */
export function cleanContactEmail(raw: string | null | undefined): string | null {
  if (!raw) return null
  let e = String(raw).trim().toLowerCase()
  try {
    e = decodeURIComponent(e)
  } catch {
    /* viallinen %-koodaus — jatketaan alkuperäisellä */
  }
  e = e.replace(/^\s+/, '').trim() // poista johtava (purettu) välilyönti, esim. %20asiakaspalvelu@

  if (!EMAIL_SHAPE.test(e)) return null
  if (ASSET_EXT.test(e)) return null

  const [local, host] = e.split('@')
  if (!/[a-z0-9]/.test(local)) return null // esim. pelkkä "_"
  if (HEX_KEY.test(local)) return null
  if (PH_LOCAL.test(local)) return null
  if (PH_NAME.test(local)) return null
  if (FAKE_TOKEN.test(e)) return null
  if (PH_DOMAIN.test(host)) return null

  return e
}

const TLD = new Set([
  'com', 'net', 'org', 'io', 'co', 'fi', 'se', 'no', 'dk', 'de',
  'eu', 'uk', 'nl', 'fr', 'es', 'it', 'info', 'biz', 'gov', 'edu', 'ac',
])

/** Brändi-tunniste: viimeinen ei-TLD-label. nursebuddy.co.uk → "nursebuddy" */
export function brandOf(host: string): string {
  const l = host.toLowerCase().replace(/^www\./, '').split('.').filter(Boolean)
  while (l.length > 1 && TLD.has(l[l.length - 1])) l.pop()
  return l[l.length - 1] ?? host
}

/** Sama brändi eri TLD:llä lasketaan samaksi (xstocks.fi ↔ xstocks.com). */
export function sameBrand(a: string, b: string): boolean {
  return brandOf(a) === brandOf(b)
}

export type EmailVerdict =
  | { status: 'ok'; email: string }
  | { status: 'fixed'; email: string } // normalisoitu (esim. %20 poistettu)
  | { status: 'cross'; email: string } // validi, mutta eri brändi kuin lead
  | { status: 'invalid'; email: null }

/** Korkean tason ratkaisu cleanupille: yhdistää validoinnin + brändivertailun. */
export function resolveContactEmail(raw: string, leadDomain: string): EmailVerdict {
  const cleaned = cleanContactEmail(raw)
  if (!cleaned) return { status: 'invalid', email: null }
  const host = cleaned.split('@')[1]
  if (!sameBrand(host, leadDomain)) return { status: 'cross', email: cleaned }
  if (cleaned !== String(raw).trim().toLowerCase()) return { status: 'fixed', email: cleaned }
  return { status: 'ok', email: cleaned }
}
