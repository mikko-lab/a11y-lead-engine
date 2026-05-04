import { chromium, Browser, Page } from 'playwright'
import path from 'path'

const AXE_PATH = path.join(process.cwd(), 'node_modules/axe-core/axe.min.js')

export interface Violation {
  id: string
  impact: string | null
  description: string
  help: string
  wcag: string
  element: string | null
  pageUrl?: string
  contrastRatio?: number
  expectedContrastRatio?: string
}

export interface PageResult {
  url: string
  score: number
  critical: number
  serious: number
  moderate: number
  minor: number
}

export interface ScanResult {
  url: string
  score: number
  critical: number
  serious: number
  moderate: number
  minor: number
  passed: number
  violations: Violation[]
  timestamp: string
  pagesScanned: number
  pageBreakdown: PageResult[]
  smallTouchTargets: number   // WCAG 2.5.8 — alle 24×24px klikattavat elementit
  focusOutlineIssues: number  // elementit joilla ei näkyvää focus-indikaattoria
}

const SUBPAGE_PATTERNS = [
  /yhteystiedot|ota-yhteytt|contact|yhteys/i,
  /palvelut|services|tuotteet|products/i,
  /ajanvaraus|booking|varaus|appointment/i,
  /hinnasto|hinnat|pricing/i,
  /lomake|form/i,
]

// Tarkistaa kosketusmaalit: WCAG 2.5.8 vaatii vähintään 24×24px
async function checkTouchTargets(page: Page): Promise<number> {
  return page.evaluate(() => {
    return Array.from(document.querySelectorAll('a, button, [role="button"], input[type="submit"], input[type="button"]'))
      .filter(el => {
        const r = el.getBoundingClientRect()
        return r.width > 0 && r.height > 0 && (r.width < 24 || r.height < 24)
      }).length
  })
}

// Tarkistaa focus-indikaattorit: fokusoi elementit JS:llä ja mittaa computed style
async function checkFocusOutlines(page: Page): Promise<number> {
  return page.evaluate(() => {
    const focusable = Array.from(document.querySelectorAll(
      'a[href], button:not([disabled]), input:not([disabled]):not([type="hidden"]), select:not([disabled]), [tabindex]:not([tabindex="-1"])'
    )).slice(0, 20) as HTMLElement[]

    let missing = 0
    for (const el of focusable) {
      el.focus()
      const s = window.getComputedStyle(el)
      const outlineWidth = parseFloat(s.outlineWidth)
      const outlineStyle  = s.outlineStyle
      const boxShadow     = s.boxShadow
      const hasOutline    = outlineStyle !== 'none' && outlineWidth > 0
      const hasBoxShadow  = boxShadow !== 'none'
      if (!hasOutline && !hasBoxShadow) missing++
      el.blur()
    }
    return missing
  }).catch(() => 0)
}

export function calculateScore(
  critical: number,
  serious: number,
  moderate: number,
  minor: number,
): number {
  return Math.max(0, 100 - (critical * 20 + serious * 10 + moderate * 5 + minor * 2))
}

async function scanPageInBrowser(browser: Browser, url: string): Promise<ScanResult> {
  const page = await browser.newPage()
  await page.setExtraHTTPHeaders({ 'Accept-Language': 'fi-FI,fi;q=0.9' })

  try {
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 20000 })
    await page.waitForTimeout(1500)

    await page.addScriptTag({ path: AXE_PATH })

    const raw = await page.evaluate(async () => {
      return await (window as any).axe.run({
        runOnly: { type: 'tag', values: ['wcag2a', 'wcag2aa', 'wcag21aa'] },
      })
    })

    const violations: Violation[] = raw.violations.map((v: any) => {
      // Poimi kontrastidata color-contrast-säännölle
      const contrastData = v.id === 'color-contrast'
        ? (v.nodes[0]?.any?.[0]?.data ?? v.nodes[0]?.all?.[0]?.data ?? null)
        : null

      return {
        id: v.id,
        impact: v.impact ?? null,
        description: v.description,
        help: v.help,
        wcag: v.tags.filter((t: string) => t.startsWith('wcag')).join(', ') || v.id,
        element: v.nodes[0]?.html ?? null,
        pageUrl: url,
        contrastRatio: contrastData?.contrastRatio ?? undefined,
        expectedContrastRatio: contrastData?.expectedContrastRatio ?? undefined,
      }
    })

    // Mukautetut tarkistukset
    const [smallTouchTargets, focusOutlineIssues] = await Promise.all([
      checkTouchTargets(page),
      checkFocusOutlines(page),
    ])

    const critical = violations.filter((v) => v.impact === 'critical').length
    const serious  = violations.filter((v) => v.impact === 'serious').length
    const moderate = violations.filter((v) => v.impact === 'moderate').length
    // Pienet kosketusmaalit lasketaan minor-tasolle
    const minor    = violations.filter((v) => v.impact === 'minor').length + smallTouchTargets
    const passed   = raw.passes.length
    const score    = calculateScore(critical, serious, moderate, minor)

    return {
      url,
      score, critical, serious, moderate,
      minor: violations.filter((v) => v.impact === 'minor').length,
      passed,
      violations,
      timestamp: new Date().toISOString(),
      pagesScanned: 1,
      pageBreakdown: [],
      smallTouchTargets,
      focusOutlineIssues,
    }
  } finally {
    await page.close()
  }
}

async function discoverSubPages(browser: Browser, baseUrl: string): Promise<string[]> {
  const origin = new URL(baseUrl).origin
  const page = await browser.newPage()

  try {
    await page.goto(baseUrl, { waitUntil: 'domcontentloaded', timeout: 15000 })

    const paths = await page.evaluate((origin: string) => {
      const anchors = Array.from(document.querySelectorAll('nav a, header a, footer a, [role="navigation"] a'))
      return anchors
        .map((a) => (a as HTMLAnchorElement).href)
        .filter((href) => href.startsWith(origin) && !href.includes('#') && !href.endsWith('.pdf') && !href.endsWith('.jpg'))
        .map((href) => new URL(href).pathname)
        .filter((p) => p !== '/' && p.length > 1)
    }, origin)

    return [...new Set(paths)]
  } catch {
    return []
  } finally {
    await page.close()
  }
}

export async function scanSite(url: string, sharedBrowser?: Browser): Promise<ScanResult> {
  const normalized = url.startsWith('http') ? url : `https://${url}`
  const origin = new URL(normalized).origin

  const ownBrowser = !sharedBrowser
  const browser = sharedBrowser ?? await chromium.launch({
    headless: true,
    args: ['--no-sandbox', '--disable-setuid-sandbox'],
  })

  try {
    const homeResult = await scanPageInBrowser(browser, normalized)

    const subPaths = await discoverSubPages(browser, normalized)
    const targetPaths = subPaths
      .filter((p) => SUBPAGE_PATTERNS.some((re) => re.test(p)))
      .slice(0, 1)  // homepage + 1 alisivu riittää liidiksi

    const allResults: ScanResult[] = [homeResult]
    for (const p of targetPaths) {
      try {
        const result = await scanPageInBrowser(browser, origin + p)
        allResults.push(result)
      } catch {
        // skip unreachable pages
      }
    }

    // Yhdistä violations — deduplikaatio rule id:n mukaan
    const seen = new Set<string>()
    const combinedViolations: Violation[] = []
    for (const result of allResults) {
      for (const v of result.violations) {
        if (!seen.has(v.id)) {
          seen.add(v.id)
          combinedViolations.push(v)
        }
      }
    }

    const critical = combinedViolations.filter((v) => v.impact === 'critical').length
    const serious  = combinedViolations.filter((v) => v.impact === 'serious').length
    const moderate = combinedViolations.filter((v) => v.impact === 'moderate').length
    const minor    = combinedViolations.filter((v) => v.impact === 'minor').length
    const passed   = Math.min(...allResults.map((r) => r.passed))

    const smallTouchTargets  = Math.max(...allResults.map((r) => r.smallTouchTargets))
    const focusOutlineIssues = Math.max(...allResults.map((r) => r.focusOutlineIssues))

    const score = calculateScore(critical, serious, moderate, minor + smallTouchTargets)

    const pageBreakdown: PageResult[] = allResults.map((r) => ({
      url: r.url, score: r.score, critical: r.critical,
      serious: r.serious, moderate: r.moderate, minor: r.minor,
    }))

    return {
      url: normalized, score, critical, serious, moderate, minor, passed,
      violations: combinedViolations,
      timestamp: new Date().toISOString(),
      pagesScanned: allResults.length,
      pageBreakdown,
      smallTouchTargets,
      focusOutlineIssues,
    }
  } finally {
    if (ownBrowser) await browser.close()
  }
}

export async function scanUrl(url: string): Promise<ScanResult> {
  const normalized = url.startsWith('http') ? url : `https://${url}`
  const browser = await chromium.launch({
    headless: true,
    args: ['--no-sandbox', '--disable-setuid-sandbox'],
  })
  try {
    return await scanPageInBrowser(browser, normalized)
  } finally {
    await browser.close()
  }
}

export async function detectWordPress(url: string): Promise<boolean> {
  const normalized = url.startsWith('http') ? url : `https://${url}`
  const browser = await chromium.launch({ headless: true, args: ['--no-sandbox'] })
  try {
    const page = await browser.newPage()
    await page.goto(normalized, { waitUntil: 'domcontentloaded', timeout: 15000 })
    const html = await page.content()
    return html.includes('wp-content') || html.includes('wp-includes') || html.includes('wp-json') || html.includes('wordpress')
  } catch {
    return false
  } finally {
    await browser.close()
  }
}
