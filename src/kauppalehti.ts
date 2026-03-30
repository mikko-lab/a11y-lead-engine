import { chromium } from 'playwright'

export interface KauppalehtiResult {
  revenue: number | null      // euroa
  employees: number | null
  founded: number | null
}

const TIMEOUT_MS = 15000

export async function lookupKauppalehti(businessId: string): Promise<KauppalehtiResult | null> {
  if (!businessId) return null

  const browser = await chromium.launch({ headless: true, args: ['--no-sandbox'] })
  try {
    const page = await browser.newPage({ ignoreHTTPSErrors: true })
    await page.goto(`https://www.kauppalehti.fi/yritykset/yritys/${businessId}`, {
      waitUntil: 'domcontentloaded',
      timeout: TIMEOUT_MS,
    })
    await page.waitForTimeout(2000)

    const data = await page.evaluate(() => {
      const text = document.body.innerText

      // Liikevaihto — esim. "1 234 t€" tai "1,2 M€"
      const revenueMatch =
        text.match(/Liikevaihto\s*([\d\s,]+)\s*t€/i) ||
        text.match(/Liikevaihto\s*([\d,.]+)\s*M€/i)

      let revenue: number | null = null
      if (revenueMatch) {
        const raw = revenueMatch[1].replace(/\s/g, '').replace(',', '.')
        const num = parseFloat(raw)
        // Jos yksikkö on M€ (miljoona), muunna euroiksi
        revenue = text.includes('M€') && revenueMatch[0].includes('M€')
          ? Math.round(num * 1_000_000)
          : Math.round(num * 1000) // t€ → €
      }

      // Henkilöstö
      const empMatch = text.match(/Henkilöstö\s*([\d\s]+)/)
      const employees = empMatch ? parseInt(empMatch[1].replace(/\s/g, '')) : null

      // Perustettu
      const foundedMatch = text.match(/Perustettu\s*(\d{4})/)
      const founded = foundedMatch ? parseInt(foundedMatch[1]) : null

      return { revenue, employees, founded }
    })

    return data
  } catch {
    return null
  } finally {
    await browser.close()
  }
}

/** Onko liikevaihto kohderyhmässä (200k – 5M€)? */
export function isRevenueTarget(revenue: number | null): boolean {
  if (revenue === null) return true // ei tietoa → päästetään läpi
  return revenue >= 200_000 && revenue <= 5_000_000
}
