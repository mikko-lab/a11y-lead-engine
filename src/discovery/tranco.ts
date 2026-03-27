import unzipper from 'unzipper'
import { Readable } from 'stream'

export async function getFiDomains(limit = 500): Promise<string[]> {
  const domains: string[] = []

  const res = await fetch('https://tranco-list.eu/top-1m.csv.zip')
  if (!res.ok || !res.body) throw new Error(`HTTP ${res.status}`)

  const nodeStream = Readable.fromWeb(res.body as any)

  return new Promise((resolve, reject) => {
    nodeStream
      .pipe(unzipper.ParseOne())
      .on('data', (chunk: Buffer) => {
        const lines = chunk.toString().split('\n')
        for (const line of lines) {
          const domain = line.split(',')[1]?.trim()
          if (domain?.endsWith('.fi')) {
            domains.push(`https://${domain}`)
            if (domains.length >= limit) {
              resolve(domains)
              return
            }
          }
        }
      })
      .on('finish', () => resolve(domains))
      .on('error', reject)
  })
}
