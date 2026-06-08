/**
 * emailHarvester.ts
 *
 * Sähköpostien löytäminen leadeille a11y-lead-engine -putkeen.
 *
 * Kaksi sisääntuloa:
 *   1) extractFromPage(page, domain)  -> kutsu OLEMASSA OLEVASSA axe-core-workerissa
 *      sillä Playwright-sivulla joka on jo renderöity. Lähes ilmainen.
 *   2) harvestEmails(domain)          -> erillinen syväcrawl (oma selain) niille
 *      leadeille joilla ei vielä ole osoitetta.
 *
 * Periaate: mailto > näkyvä teksti > arvattu roolisosoite. MX-tarkistus
 * karsii bouncet ilman SMTP-koputtelua.
 */

import { chromium, type Browser, type Page } from 'playwright';
import { resolveMx } from 'node:dns/promises';

export interface EmailCandidate {
  email: string;
  source: 'mailto' | 'text' | 'guessed';
  confidence: number; // 0–100
  domainMatch: boolean; // osoitteen domain == yrityksen domain
  foundOn: string; // URL josta löytyi (tai "(guessed)")
}

export interface HarvestResult {
  domain: string;
  hasMx: boolean;
  candidates: EmailCandidate[];
  best: EmailCandidate | null;
}

// Yleisimmät yhteystieto-/tietosuojapolut suomalaisilla sivuilla
const CONTACT_PATHS = [
  '',
  '/yhteystiedot',
  '/yhteystiedot/',
  '/yhteys',
  '/ota-yhteytta',
  '/yhteydenotto',
  '/contact',
  '/contact-us',
  '/tietoa-meista',
  '/tietosuoja',
  '/tietosuojaseloste',
  '/privacy',
];

// Roolisosoitteet joita arvataan vain jos MX löytyy
const ROLE_PREFIXES = ['info', 'myynti', 'asiakaspalvelu', 'toimisto', 'yhteys', 'sales', 'contact'];

const FREE_MAIL = /@(gmail|hotmail|outlook|yahoo|icloud|live|protonmail|me)\./i;
const NOISE_LOCAL = /^(example|test|name|your|email|user|sentry|noreply|no-reply|donotreply|wordpress)@/i;
const ASSET_EXT = /\.(png|jpg|jpeg|gif|svg|webp|css|js|woff2?)$/i;

const EMAIL_RE = /[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/g;

/** Muuntaa obfuskoidut muodot ("info [at] domain.fi") oikeiksi ennen regexiä. */
function deobfuscate(s: string): string {
  return s
    .replace(/\s*[\[(]\s*at\s*[\])]\s*/gi, '@')
    .replace(/\s*[\[(]\s*ät\s*[\])]\s*/gi, '@')
    .replace(/\s*[\[(]\s*(dot|piste)\s*[\])]\s*/gi, '.');
}

function cleanDomain(input: string): string {
  return input
    .replace(/^https?:\/\//i, '')
    .replace(/\/.*$/, '')
    .replace(/^www\./i, '')
    .trim()
    .toLowerCase();
}

function isValidEmail(e: string): boolean {
  if (!/^[^@\s]+@[^@\s]+\.[a-z]{2,}$/i.test(e)) return false;
  if (ASSET_EXT.test(e)) return false; // logo@2x.png yms. roska
  if (e.length > 254) return false;
  return true;
}

function makeCandidate(
  email: string,
  source: EmailCandidate['source'],
  foundOn: string,
  domain: string
): EmailCandidate {
  const lower = email.toLowerCase();
  const emailDomain = lower.split('@')[1] ?? '';
  const domainMatch = emailDomain === domain || emailDomain.endsWith('.' + domain);

  let confidence = source === 'mailto' ? 80 : source === 'text' ? 60 : 30;
  if (domainMatch) confidence += 15;
  if (FREE_MAIL.test(lower)) confidence -= 25;
  if (NOISE_LOCAL.test(lower)) confidence -= 40;
  confidence = Math.max(0, Math.min(100, confidence));

  return { email: lower, source, confidence, domainMatch, foundOn };
}

/**
 * Poimii sähköpostit yhdeltä jo renderöidyltä sivulta.
 * Kutsu tätä olemassa olevassa axe-core-workerissa: sivu on jo ladattu.
 */
export async function extractFromPage(page: Page, domain: string): Promise<EmailCandidate[]> {
  const clean = cleanDomain(domain);
  const url = page.url();
  const found: EmailCandidate[] = [];

  // 1) mailto:-linkit — korkein luotettavuus
  const mailtos = await page
    .$$eval('a[href^="mailto:"]', (els) =>
      els.map((a) => (a as HTMLAnchorElement).href.replace(/^mailto:/i, '').split('?')[0].trim())
    )
    .catch(() => [] as string[]);

  for (const m of mailtos) {
    if (isValidEmail(m)) found.push(makeCandidate(m, 'mailto', url, clean));
  }

  // 2) näkyvä teksti + deobfuskointi
  const text = await page.evaluate(() => document.body?.innerText ?? '').catch(() => '');
  const matches = deobfuscate(text).match(EMAIL_RE) ?? [];
  for (const m of matches) {
    if (isValidEmail(m)) found.push(makeCandidate(m, 'text', url, clean));
  }

  return found;
}

async function checkMx(domain: string): Promise<boolean> {
  try {
    const mx = await resolveMx(domain);
    return mx.length > 0;
  } catch {
    return false;
  }
}

function rankAndDedupe(cands: EmailCandidate[]): EmailCandidate[] {
  const map = new Map<string, EmailCandidate>();
  for (const c of cands) {
    const existing = map.get(c.email);
    if (!existing || c.confidence > existing.confidence) map.set(c.email, c);
  }
  return [...map.values()].sort((a, b) => b.confidence - a.confidence);
}

function guessRoleAddresses(domain: string): EmailCandidate[] {
  return ROLE_PREFIXES.map((p) => makeCandidate(`${p}@${domain}`, 'guessed', '(guessed)', domain));
}

/**
 * Syväcrawl: oma selain, käy yleisimmät yhteystietopolut läpi.
 * Käytä fallbackina leadeille joilla ei vielä ole osoitetta.
 */
export async function harvestEmails(
  domain: string,
  opts?: { browser?: Browser; maxPages?: number }
): Promise<HarvestResult> {
  const clean = cleanDomain(domain);
  const hasMx = await checkMx(clean);

  // Ei MX:ää = ei kannata edes crawlata tai arvata
  if (!hasMx) {
    return { domain: clean, hasMx, candidates: [], best: null };
  }

  const browser = opts?.browser ?? (await chromium.launch({ headless: true }));
  const ownBrowser = !opts?.browser;
  const all: EmailCandidate[] = [];

  try {
    const context = await browser.newContext({
      userAgent: 'WPSaavutettavuus-Audit/1.0 (+https://wpsaavutettavuus.fi)',
    });
    const page = await context.newPage();
    page.setDefaultTimeout(15000);

    const paths = CONTACT_PATHS.slice(0, opts?.maxPages ?? CONTACT_PATHS.length);
    for (const path of paths) {
      const url = `https://${clean}${path}`;
      try {
        const resp = await page.goto(url, { waitUntil: 'domcontentloaded' });
        if (!resp || resp.status() >= 400) continue;
        all.push(...(await extractFromPage(page, clean)));

        // Aikainen exit: jos vahva domain-osuma mailtosta löytyi, lopeta crawl
        if (all.some((c) => c.domainMatch && c.source === 'mailto')) break;
      } catch {
        // kuollut polku — ohitetaan
      }
    }
    await context.close();
  } finally {
    if (ownBrowser) await browser.close();
  }

  let ranked = rankAndDedupe(all);

  // Vain jos mitään ei löytynyt, arvataan roolisosoitteet (MX on jo varmistettu)
  if (ranked.length === 0) ranked = guessRoleAddresses(clean);

  return { domain: clean, hasMx, candidates: ranked, best: ranked[0] ?? null };
}
