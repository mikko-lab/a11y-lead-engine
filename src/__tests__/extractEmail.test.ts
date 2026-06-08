import { describe, it, expect } from 'vitest'
import { extractEmail } from '../enrichment'

// HUOM: vaatii että extractEmail (ja emailScore/deobfuscate halutessa)
// on viety `export`-merkinnällä enrichment.ts:stä.

describe('extractEmail — domain-skooraus ja suodatus', () => {
  it('suosii yrityksen omaa osoitetta footerin toimisto-gmailin sijaan', () => {
    const html = `<footer>
      <a href="mailto:toimisto.helsinki@gmail.com">verkkosivut: Toimisto</a>
      <a href="mailto:info@yritys.fi">Ota yhteyttä</a>
    </footer>`
    expect(extractEmail(html, 'yritys.fi')).toBe('info@yritys.fi')
  })

  it('purkaa obfuskoinnin info [at] yritys [piste] fi', () => {
    expect(extractEmail('Sähköposti: info [at] yritys [piste] fi', 'yritys.fi'))
      .toBe('info@yritys.fi')
  })

  it('suodattaa asset-osoitteet (png, woff, css)', () => {
    const html = `logo@2x.png font@font.woff style@main.css
      <a href="mailto:myynti@yritys.fi">x</a>`
    expect(extractEmail(html, 'yritys.fi')).toBe('myynti@yritys.fi')
  })

  it('suodattaa tracking-/järjestelmäosoitteet (sentry, donotreply, wordpress)', () => {
    const html = `abc@sentry.io donotreply@yritys.fi wordpress@yritys.fi
      <a href="mailto:asiakaspalvelu@yritys.fi">x</a>`
    expect(extractEmail(html, 'yritys.fi')).toBe('asiakaspalvelu@yritys.fi')
  })

  it('valitsee oman domainin kolmannen osapuolen domainin sijaan', () => {
    const html = `<a href="mailto:asiakas@toinenfirma.fi">x</a> matti@kauppa.fi`
    expect(extractEmail(html, 'kauppa.fi')).toBe('matti@kauppa.fi')
  })

  it('palauttaa gmailin jos mitään parempaa ei ole (ei null)', () => {
    expect(extractEmail('Ota yhteyttä: yrittaja.matti@gmail.com', 'yritys.fi'))
      .toBe('yrittaja.matti@gmail.com')
  })

  it('suosii roolisosoitetta henkilön sijaan samalla domainilla', () => {
    expect(extractEmail('matti.virtanen@yritys.fi info@yritys.fi', 'yritys.fi'))
      .toBe('info@yritys.fi')
  })

  it('deduplikoi mailto + plaintext saman osoitteen', () => {
    const html = `<a href="mailto:info@yritys.fi">info@yritys.fi</a> info@yritys.fi`
    expect(extractEmail(html, 'yritys.fi')).toBe('info@yritys.fi')
  })

  it('tunnistaa subdomain-osuman oman domainin osaksi', () => {
    expect(extractEmail('myynti@shop.yritys.fi joku@muu.com', 'yritys.fi'))
      .toBe('myynti@shop.yritys.fi')
  })

  it('palauttaa null jos vain roska-/asset-osoitteita', () => {
    expect(extractEmail('noreply@yritys.fi logo@2x.png', 'yritys.fi')).toBeNull()
  })
})
