import { chromium } from 'playwright'
import path from 'path'

const AXE_PATH = path.join(process.cwd(), 'node_modules/axe-core/axe.min.js')

export interface Violation {
  id: string
  impact: string | null
  description: string
  help: string
  wcag: string
  element: string | null
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
}

export async function scanUrl(url: string): Promise<ScanResult> {
  const normalized = url.startsWith('http') ? url : `https://${url}`

  const browser = await chromium.launch({
    headless: true,
    args: ['--no-sandbox', '--disable-setuid-sandbox'],
  })

  try {
    const page = await browser.newPage()
    await page.setExtraHTTPHeaders({ 'Accept-Language': 'fi-FI,fi;q=0.9' })

    await page.goto(normalized, { waitUntil: 'networkidle', timeout: 30000 })
    await page.waitForTimeout(2000)

    await page.addScriptTag({ path: AXE_PATH })

    const raw = await page.evaluate(async () => {
      return await (window as any).axe.run({
        runOnly: { type: 'tag', values: ['wcag2a', 'wcag2aa', 'wcag21aa'] },
      })
    })

    const violations: Violation[] = raw.violations.map((v: any) => ({
      id: v.id,
      impact: v.impact ?? null,
      description: v.description,
      help: v.help,
      wcag: v.tags.filter((t: string) => t.startsWith('wcag')).join(', ') || v.id,
      element: v.nodes[0]?.html ?? null,
    }))

    const critical = violations.filter((v) => v.impact === 'critical').length
    const serious  = violations.filter((v) => v.impact === 'serious').length
    const moderate = violations.filter((v) => v.impact === 'moderate').length
    const minor    = violations.filter((v) => v.impact === 'minor').length
    const passed   = raw.passes.length

    const score = Math.max(0, 100 - (critical * 20 + serious * 10 + moderate * 5 + minor * 2))

    return { url: normalized, score, critical, serious, moderate, minor, passed, violations, timestamp: new Date().toISOString() }
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

    return (
      html.includes('wp-content') ||
      html.includes('wp-includes') ||
      html.includes('wp-json') ||
      html.includes('wordpress')
    )
  } catch {
    return false
  } finally {
    await browser.close()
  }
}
