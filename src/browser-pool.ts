import { chromium, Browser } from 'playwright'

const BROWSER_ARGS = ['--no-sandbox', '--disable-setuid-sandbox']
const MAX_USES = 50  // käynnistä uudelleen joka 50. jobin jälkeen

class BrowserPool {
  private browser: Browser | null = null
  private uses = 0

  async acquire(): Promise<Browser> {
    if (!this.browser || this.uses >= MAX_USES) {
      if (this.browser) {
        await this.browser.close().catch(() => {})
        this.browser = null
      }
      this.browser = await chromium.launch({ headless: true, args: BROWSER_ARGS })
      this.uses = 0
      console.log('  [pool] Uusi Chromium käynnistetty')
    }
    this.uses++
    return this.browser
  }

  async shutdown() {
    if (this.browser) {
      await this.browser.close().catch(() => {})
      this.browser = null
    }
  }
}

export const browserPool = new BrowserPool()
