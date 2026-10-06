// Deterministic negotiation rules. The LLM never decides a price: it calls
// evaluate_offer, and whatever this file returns is the only binding answer.

export type Item = {
  id: string
  shopId?: string // missing = the main (owner's) shop
  demo?: boolean // seeded demo item: restocks after it sells, never feeds pricing history
  credit?: { author: string; license: string; source: string } // photo attribution (CC-licensed demo photos)
  title: string
  description: string
  listPrice: number
  autoAcceptAt: number // offers at or above this sell immediately
  floor: number // offers below this are never accepted; in between needs the owner
  status: 'live' | 'paused' | 'sold'
  soldPrice?: number
  soldTo?: string
  soldFirstOffer?: number
  soldAt?: string
  soldVia?: string
  category?: string
  photo?: string // data URL (main photo)
  photos?: string[] // all angles, photos[0] === photo
  listingSeconds?: number
  createdAt?: string
  facts?: ItemFacts
  market?: RangeSummary
  history?: RangeSummary & { prices: number[] }
}

export type ItemFacts = {
  brand: string | null
  era: string | null
  material: string | null
  size: string | null
  color: string | null
  condition: string
  flaws: string[]
  highlights: string[]
  merchantConfirmed?: boolean
  acquired?: string | null // merchant: when they got it
  retailPrice?: number | null // merchant: what it cost new
  merchantNotes?: string | null // merchant: anything buyers should know
  qa?: { q: string; a: string }[] // owner answers to buyer questions, reused for future buyers
}

export type RangeSummary = { count: number; min: number | null; max: number | null; median: number | null }

export function summarize(prices: number[]): RangeSummary {
  const p = [...prices].sort((a, b) => a - b)
  return { count: p.length, min: p[0] ?? null, max: p.at(-1) ?? null, median: p.length ? p[Math.floor(p.length / 2)] : null }
}

// Shop policy defaults applied to a suggested price; the owner can edit before going live.
export const SHOP_RULES = { floorPct: 0.85, autoAcceptPct: 0.93 }

export function applyShopRules(price: number) {
  return {
    listPrice: price,
    autoAcceptAt: Math.round(price * SHOP_RULES.autoAcceptPct),
    floor: Math.round(price * SHOP_RULES.floorPct),
  }
}

export type OfferDecision =
  | { decision: 'accept'; price: number }
  | { decision: 'needs_owner_approval'; price: number }
  | { decision: 'counter'; counterPrice: number; lowball: boolean; bestPrice: boolean }
  | { decision: 'invalid'; reason: string }
  | { decision: 'unavailable'; reason: string }

// An offer at or under half the list price is a lowball, the resale-community rule of thumb.
export const isLowball = (item: Item, offer: number) => offer <= item.listPrice * 0.5

// lastCounter is this buyer's previous counter. Counters only ever come down, in shrinking
// human-sized steps, and never below autoAcceptAt (so taking a counter is always a sale).
export function evaluateOffer(item: Item, offer: number, lastCounter?: number): OfferDecision {
  if (item.status !== 'live') return { decision: 'unavailable', reason: item.status === 'paused' ? 'The shop paused this listing for now.' : 'Item already sold.' }
  if (!Number.isFinite(offer) || offer <= 0) {
    return { decision: 'invalid', reason: 'Offer must be a positive dollar amount.' }
  }
  if (offer >= item.listPrice) return { decision: 'accept', price: item.listPrice }
  if (offer >= item.autoAcceptAt) return { decision: 'accept', price: roundCents(offer) }
  if (offer >= item.floor) return { decision: 'needs_owner_approval', price: roundCents(offer) }

  const lowball = isLowball(item, offer)
  const prev = Math.min(lastCounter ?? item.listPrice, item.listPrice)
  const gap = prev - item.autoAcceptAt
  // Lowballers get a small concession; reasonable offers get a real one.
  const raw = prev - gap * (lowball ? 0.25 : 0.45)
  const counter = gap <= 0 ? item.autoAcceptAt : nicePrice(raw, item.autoAcceptAt, Math.max(item.autoAcceptAt, Math.ceil(prev) - 1))
  return { decision: 'counter', counterPrice: counter, lowball, bestPrice: counter <= item.autoAcceptAt }
}

// Pick a price a person would say ($49, $45, $50) near raw, within [min, max].
export function nicePrice(raw: number, min: number, max: number): number {
  const lo = Math.ceil(min), hi = Math.floor(max)
  if (hi <= lo) return Math.max(lo, Math.min(Math.round(raw), hi))
  let best = Math.min(hi, Math.max(lo, Math.round(raw)))
  let bestDist = Infinity
  for (let c = lo; c <= hi; c++) {
    if (![0, 5, 9].includes(c % 10)) continue
    const d = Math.abs(c - raw)
    if (d <= 2 && d < bestDist) { best = c; bestDist = d }
  }
  return best
}

function roundCents(n: number) {
  return Math.round(n * 100) / 100
}

// --- Past-sales lookup (the merchant's own history) ---

export type Sale = { title: string; price: number; soldDate: string; category: string; brand?: string; condition?: string; source?: string }

const STOP = new Set(['the', 'and', 'for', 'with', 'size', 'new', 'nwt', 'euc', 'used', 'women', 'womens', 'men', 'mens', 'free', 'ship', 'shipping', 'bundle', 'lot', 'set', 'of', 'in', 'a', 'sold', 'here', 'vintage', 'color', 'black', 'white', 'blue'])
const tokenCache = new WeakMap<Sale, Set<string>>()
const saleTokens = (s: Sale) => {
  let t = tokenCache.get(s)
  if (!t) { t = tokenize(`${s.title} ${s.brand ?? ''} ${s.category}`); tokenCache.set(s, t) }
  return t
}

// Ranks by how many meaningful query words match, with a bonus for the same brand.
// Needs at least half the query words (min 1) to count as similar, so "jacket" alone doesn't match every jacket.
export function searchSales(sales: Sale[], query: string, limit = 8) {
  const terms = new Set([...tokenize(query)].filter((t) => (t.length > 1 || /\d/.test(t)) && !STOP.has(t)))
  const need = Math.max(1, Math.ceil(terms.size / 2))
  // Model numbers must match exactly: "iphone 13" is not an iPad, "air max 90" is not an air max 95.
  // The first word is usually the brand or product ("iphone", "coach"), so it must match too.
  const mustHave = [...terms].filter((t, i) => i === 0 || /\d/.test(t))
  const scored: { s: Sale; score: number }[] = []
  for (const s of sales) {
    const tok = saleTokens(s)
    if (mustHave.some((t) => !tok.has(t))) continue
    let score = overlap(terms, tok)
    if (score < need) continue
    if (s.brand && terms.has(s.brand.toLowerCase())) score += 2
    scored.push({ s, score })
  }
  scored.sort((a, b) => b.score - a.score)
  const top = scored.slice(0, limit).map((x) => x.s)
  const prices = top.map((s) => s.price).sort((a, b) => a - b)
  return {
    matches: top.map(({ title, price, soldDate, brand, condition, source }) => ({ title, price, soldDate, brand, condition, source })),
    count: top.length,
    min: prices[0] ?? null,
    max: prices.at(-1) ?? null,
    median: prices.length ? prices[Math.floor(prices.length / 2)] : null,
  }
}

function tokenize(s: string) {
  return new Set(s.toLowerCase().replace(/['’]/g, '').match(/[a-z0-9]+/g) ?? [])
}

function overlap(a: Set<string>, b: Set<string>) {
  let n = 0
  for (const t of a) if (b.has(t)) n++
  return n
}

export function parseSalesCsv(text: string): Sale[] {
  const rows = parseCsv(text)
  const [header, ...body] = rows
  const idx = (name: string) => header.indexOf(name)
  return body
    .filter((r) => r.length >= header.length)
    .map((r) => ({
      title: r[idx('title')],
      price: Number(r[idx('price')]),
      soldDate: r[idx('sold_date')],
      category: r[idx('category')],
      brand: idx('brand') >= 0 ? r[idx('brand')] : undefined,
      condition: idx('condition') >= 0 ? r[idx('condition')] : undefined,
      source: idx('source') >= 0 ? r[idx('source')] : undefined,
    }))
    .filter((s) => Number.isFinite(s.price))
}

function parseCsv(text: string): string[][] {
  const rows: string[][] = []
  let row: string[] = []
  let field = ''
  let quoted = false
  for (let i = 0; i < text.length; i++) {
    const c = text[i]
    if (quoted) {
      if (c === '"' && text[i + 1] === '"') { field += '"'; i++ }
      else if (c === '"') quoted = false
      else field += c
    } else if (c === '"') quoted = true
    else if (c === ',') { row.push(field); field = '' }
    else if (c === '\n') { row.push(field.replace(/\r$/, '')); rows.push(row); row = []; field = '' }
    else field += c
  }
  if (field || row.length) { row.push(field); rows.push(row) }
  return rows.filter((r) => r.some((f) => f.trim() !== ''))
}
