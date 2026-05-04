import { describe, it, expect, vi, beforeEach } from 'vitest'
import { db } from '../db/client'
import { preFilter } from '../prefilter'

vi.mock('../db/client', () => ({
  db: {
    blocklist: {
      findMany: vi.fn().mockResolvedValue([]),
    },
  },
}))

function mockFetch(html: string, headers: Record<string, string> = {}) {
  return vi.fn().mockResolvedValue({
    ok: true,
    status: 200,
    text: async () => html,
    headers: {
      get: (key: string) => headers[key.toLowerCase()] ?? null,
    },
  })
}

describe('preFilter — kielentunnistus', () => {
  beforeEach(() => vi.clearAllMocks())

  it('hyväksyy suomenkielisen sivun (lang="fi")', async () => {
    global.fetch = mockFetch(
      '<html lang="fi"><body><form><button>OK</button></form></body></html>',
    )
    const result = await preFilter('https://esimerkki.fi')
    expect(result.lang).toBe('fi')
    expect(result.pass).toBe(true)
  })

  it('hylkää saksankielisen sivun (lang="de")', async () => {
    global.fetch = mockFetch('<html lang="de"><body></body></html>')
    const result = await preFilter('https://example.de')
    expect(result.pass).toBe(false)
    expect(result.reason).toMatch(/kieli/i)
  })

  it('tunnistaa kielen content-language-headerista', async () => {
    global.fetch = mockFetch('<html><body></body></html>', {
      'content-language': 'fi',
    })
    const result = await preFilter('https://esimerkki.fi')
    expect(result.lang).toBe('fi')
  })
})

describe('preFilter — WordPress-tunnistus', () => {
  it('tunnistaa WordPress-sivun wp-content-polusta', async () => {
    global.fetch = mockFetch(
      '<html lang="fi"><head><link rel="stylesheet" href="/wp-content/themes/mytheme/style.css"></head><body></body></html>',
    )
    const result = await preFilter('https://esimerkki.fi')
    expect(result.isWP).toBe(true)
  })

  it('ei tunnista ei-WordPress-sivua WordPressiksi', async () => {
    global.fetch = mockFetch('<html lang="fi"><body><p>Hei maailma</p></body></html>')
    const result = await preFilter('https://esimerkki.fi')
    expect(result.isWP).toBe(false)
  })
})

describe('preFilter — CTA-tunnistus', () => {
  it('tunnistaa lomakkeen CTAksi', async () => {
    global.fetch = mockFetch(
      '<html lang="fi"><body><form action="/tilaa"><button type="submit">Tilaa</button></form></body></html>',
    )
    const result = await preFilter('https://esimerkki.fi')
    expect(result.hasCta).toBe(true)
  })

  it('tunnistaa napin CTAksi', async () => {
    global.fetch = mockFetch(
      '<html lang="fi"><body><button>Ota yhteyttä</button></body></html>',
    )
    const result = await preFilter('https://esimerkki.fi')
    expect(result.hasCta).toBe(true)
  })

  it('palauttaa hasCta false kun ei lomaketta eikä nappia', async () => {
    global.fetch = mockFetch(
      '<html lang="fi"><body><p>Pelkkää tekstiä</p></body></html>',
    )
    const result = await preFilter('https://esimerkki.fi')
    expect(result.hasCta).toBe(false)
  })
})

describe('preFilter — gov/enterprise-filtteri', () => {
  it('hylkää .gov.fi-domainin', async () => {
    global.fetch = mockFetch('<html lang="fi"><body></body></html>')
    const result = await preFilter('https://virasto.gov.fi')
    expect(result.pass).toBe(false)
    expect(result.reason).toMatch(/viranomainen|koulu/i)
  })

  it('hylkää blocklist-osuman', async () => {
    // TTL-cache on 5 min — vanhennetaan se fake timereilla
    const realNow = Date.now()
    vi.useFakeTimers()
    vi.setSystemTime(realNow + 6 * 60 * 1000)
    vi.mocked(db.blocklist.findMany).mockResolvedValueOnce([
      { domain: 'suuri-yritys.fi' },
    ] as never)
    global.fetch = mockFetch('<html lang="fi"><body></body></html>')
    const result = await preFilter('https://suuri-yritys.fi')
    vi.useRealTimers()
    expect(result.pass).toBe(false)
    expect(result.reason).toMatch(/blocklist/i)
  })
})

describe('preFilter — saavutettavuusseloste', () => {
  it('tunnistaa saavutettavuusselosteen', async () => {
    // CTA tarvitaan jotta preFilter etenee selosteen tarkistukseen asti
    global.fetch = mockFetch(
      '<html lang="fi"><body><button>OK</button><a href="/saavutettavuusseloste">Saavutettavuusseloste</a></body></html>',
    )
    const result = await preFilter('https://esimerkki.fi')
    expect(result.hasAccessibilityStatement).toBe(true)
  })

  it('palauttaa false kun selostelinkki puuttuu', async () => {
    global.fetch = mockFetch(
      '<html lang="fi"><body><p>Ei selostelinkkiä</p></body></html>',
    )
    const result = await preFilter('https://esimerkki.fi')
    expect(result.hasAccessibilityStatement).toBe(false)
  })
})

describe('preFilter — fetch epäonnistuu', () => {
  it('palauttaa pass: false kun sivu ei vastaa', async () => {
    global.fetch = vi.fn().mockRejectedValue(new Error('ECONNREFUSED'))
    const result = await preFilter('https://ei-olemassa.fi')
    expect(result.pass).toBe(false)
    expect(result.reason).toMatch(/connection error|timeout/i)
  })
})
