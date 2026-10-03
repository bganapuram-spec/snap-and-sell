// Live check: does the lister see a photo returned by a custom tool, search comps, and return JSON?
import { readFileSync } from 'node:fs'
import { loadAgentIds, runListing } from '../src/zoowork.ts'

const path = process.argv[2]
if (!path) throw new Error('usage: node --env-file=.env scripts/test-lister.ts <photo.jpg>')
const data = readFileSync(path).toString('base64')
const t0 = Date.now()
const draft = await runListing(loadAgentIds().listerId, { data, mimeType: 'image/jpeg' }, (step, info) =>
  console.log(`[${((Date.now() - t0) / 1000).toFixed(1)}s] step ${step} ${info ?? ''}`))
console.log(JSON.stringify(draft, null, 2))
console.log(`total ${((Date.now() - t0) / 1000).toFixed(1)}s`)
