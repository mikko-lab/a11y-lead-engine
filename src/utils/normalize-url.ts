/**
 * Normalisoi URL kanoniseen muotoon duplikaattien estämiseksi:
 * - https://www.yritys.fi  → https://yritys.fi
 * - http://yritys.fi       → https://yritys.fi
 * - yritys.fi              → https://yritys.fi
 */
export function normalizeUrl(url: string): string {
  const withProtocol = url.startsWith('http') ? url : `https://${url}`
  const parsed = new URL(withProtocol)
  const hostname = parsed.hostname.replace(/^www\./, '')
  return `https://${hostname}`
}
