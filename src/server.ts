// HTTP server: owner app, projector page, and buyer chat. No framework, just node:http.

import { createServer, type IncomingMessage, type ServerResponse } from 'node:http'
import { existsSync, readFileSync } from 'node:fs'
import { randomUUID } from 'node:crypto'
import QRCode from 'qrcode'
import { applyShopRules, searchSales, summarize, type Item } from './pricing.ts'
import { approvals, buyerSessions, competitionFor, countToday, deleteShop, forgetPhotos, GUEST_SHOP_DAYS, items, loadState, log, logEvent, MAIN_SHOP, markSold, noteForSession, offerBook, questions, resetShop, scheduleSave, shopOfItem, shops, type Shop } from './store.ts'
import { addSaleToHistory, ensureAgents, MODEL, pastSales, runShopperBot, runBuyerTurn, runListing, startBuyerSession, type ListingDraft, type ListingStep } from './zoowork.ts'

const PORT = Number(process.env.PORT ?? 3000)
// Render sets RENDER_EXTERNAL_URL itself, so QR codes point at the live site without extra config.
const PUBLIC_URL = (process.env.PUBLIC_URL || process.env.RENDER_EXTERNAL_URL || `http://localhost:${PORT}`).replace(/\/$/, '')
const MERCHANT_TOKEN = process.env.MERCHANT_TOKEN
if (!MERCHANT_TOKEN) throw new Error('Set MERCHANT_TOKEN in .env')

await loadState()
for (const i of items.values()) addSaleToHistory(i)
const { negotiatorId, listerId, shopperId } = await ensureAgents()
console.log(`Agents running: negotiator ${negotiatorId}, lister ${listerId}`)

// ---------------- Demo items ----------------
// seed/demo-items.json: real lister output for CC-licensed photos, so visitors find a stocked shop.
// Loaded whenever the main shop is empty (a fresh deploy, or after "Reset demo").
const SEED_DIR = new URL('../seed/', import.meta.url)
function seedDemoItems() {
  const file = new URL('demo-items.json', SEED_DIR)
  if (process.env.SEED_DEMO_ITEMS === '0' || !existsSync(file) || [...items.values()].some((i) => shopOfItem(i) === MAIN_SHOP)) return
  const seeds = JSON.parse(readFileSync(file, 'utf8'))
  const now = Date.now()
  // Inserted last-to-first: the storefront shows newest first, so the first seed leads the page.
  ;[...seeds].reverse().forEach((d: any, n: number) => {
    const photo = `data:image/jpeg;base64,${readFileSync(new URL(d.photo, SEED_DIR)).toString('base64')}`
    const item: Item = {
      id: randomUUID().slice(0, 8), shopId: MAIN_SHOP, demo: true, credit: d.credit,
      title: d.title, description: d.description, category: d.category,
      listPrice: d.listPrice, autoAcceptAt: d.autoAcceptAt, floor: d.floor, status: 'live',
      photo, photos: [photo], facts: d.facts, market: d.market, history: d.history,
      createdAt: new Date(now - (seeds.length - n) * 60_000).toISOString(),
    }
    items.set(item.id, item)
  })
  scheduleSave()
  console.log(`Stocked the shop with ${seeds.length} demo items`)
}

// A sold demo item comes back after DEMO_RESTOCK_MINUTES, with its old chats cleared, so the demo
// shop never sells out. Checked on a timer (not per sale) so it also works after a restart.
const DEMO_RESTOCK_MINUTES = 10
function restockDemoItems() {
  for (const item of items.values()) {
    if (!item.demo || item.status !== 'sold' || Date.now() - Date.parse(item.soldAt ?? '') < DEMO_RESTOCK_MINUTES * 60_000) continue
    for (const k of ['soldPrice', 'soldTo', 'soldFirstOffer', 'soldAt', 'soldVia'] as const) delete item[k]
    item.status = 'live'
    for (const [id, s] of buyerSessions) if (s.itemId === item.id) buyerSessions.delete(id)
    for (const [id, a] of approvals) if (a.itemId === item.id) approvals.delete(id)
    for (const [id, q] of questions) if (q.itemId === item.id) questions.delete(id)
    logEvent('listing', `${item.title} back in stock`, { itemId: item.id })
  }
}
seedDemoItems()

const STATIC: Record<string, [string, string]> = {
  '/merchant': ['merchant.html', 'text/html'],
  '/stage': ['stage.html', 'text/html'],
  '/style.css': ['style.css', 'text/css'],
  '/app.js': ['app.js', 'text/javascript'],
  '/architecture': ['architecture.html', 'text/html'],
}
const file = (name: string) => {
  const text = readFileSync(new URL(`../public/${name}`, import.meta.url), 'utf8')
  if (!name.endsWith('.html')) return text
  // Inline the shared CSS/JS so each page is a single request: a flaky tunnel can't half-load it.
  return text
    .replace('<link rel="stylesheet" href="/style.css">', () => `<style>${file('style.css')}</style>`)
    .replace('<script src="/app.js"></script>', () => `<script>${file('app.js')}</script>`)
}

// ---------------- Listing jobs ----------------

type StepState = 'pending' | 'active' | 'done'
const STEP_ORDER: ListingStep[] = ['photo', 'comps', 'history', 'rules']

type Job = {
  id: string
  shopId: string
  status: 'running' | 'done' | 'error'
  steps: Record<ListingStep, StepState>
  photo: string // data URL (first photo)
  photos: string[]
  hidden?: boolean // test jobs: never shown on the projector
  activity: { ts: string; kind: string; message: string }[] // plain-English research log for the screens
  finishedAt?: number
  startedAt: number
  seconds?: number
  draft?: ListingDraft
  evidence?: {
    market: ReturnType<typeof summarize>
    history: ReturnType<typeof summarize> & { matches: { title: string; price: number }[] }
    rules: ReturnType<typeof applyShopRules>
  }
  error?: string
}
const jobs = new Map<string, Job>()
let latestJobId: string | undefined // the main shop's latest listing, for the projector

type Mime = 'image/jpeg' | 'image/png' | 'image/webp'
function startJob(photos: { url: string; mimeType: Mime; data: string }[], shopId: string) {
  const job: Job = {
    id: randomUUID().slice(0, 8),
    shopId,
    status: 'running',
    steps: { photo: 'active', comps: 'pending', history: 'pending', rules: 'pending' },
    photo: photos[0].url,
    photos: photos.map((p) => p.url),
    activity: [],
    startedAt: Date.now(),
  }
  jobs.set(job.id, job)
  if (shopId === MAIN_SHOP) latestJobId = job.id

  const KIND: Record<ListingStep, string> = { photo: 'photo', comps: 'web', history: 'solddata', rules: 'rules' }
  const note = (kind: string, message: string) => { job.activity.push({ ts: new Date().toISOString(), kind, message }); job.activity = job.activity.slice(-40) }
  const onStep = (step: ListingStep, info?: string) => {
    for (const s of STEP_ORDER) if (job.steps[s] === 'active' && s !== step) job.steps[s] = 'done'
    if (job.steps[step] !== 'done') job.steps[step] = 'active'
    if (info) note(KIND[step], info)
  }

  runListing(listerId, photos.map(({ data, mimeType }) => ({ data, mimeType })), onStep)
    .then((draft) => {
      const prices = draft.market_comps.map((c) => c.price)
      // Use the sold prices the lister actually looked at; fall back to our own search.
      const histMatches = draft.history_matches?.length ? draft.history_matches
        : searchSales(pastSales.sales, [draft.brand ?? '', draft.title].join(' '), 8).matches.map((m) => ({ title: m.title, price: m.price }))
      job.draft = draft
      job.evidence = {
        market: summarize(prices),
        history: { ...summarize(histMatches.map((m) => m.price)), matches: histMatches },
        rules: applyShopRules(draft.suggested_price),
      }
      for (const c of draft.market_comps.slice(0, 6)) note('found', `${c.source || 'Online'}: ${c.title.slice(0, 70)}, $${c.price}`)
      for (const m of histMatches.slice(0, 3)) note('sold', `Sold for $${m.price}: ${m.title.slice(0, 70)}`)
      note('rules', `Suggested $${draft.suggested_price} · floor $${job.evidence.rules.floor} · auto-accept $${job.evidence.rules.autoAcceptAt}`)
      for (const s of STEP_ORDER) job.steps[s] = 'done'
      job.seconds = Math.round((Date.now() - job.startedAt) / 1000)
      job.finishedAt = Date.now()
      job.status = 'done'
    })
    .catch((err) => {
      console.error('Listing failed', err)
      job.status = 'error'
      job.error = err instanceof Error ? err.message : String(err)
    })
  return job
}

function jobView(job: Job) {
  const { photo, photos, ...rest } = job
  return { ...rest, photoCount: photos.length, elapsed: Math.round((Date.now() - job.startedAt) / 1000) }
}

// ---------------- Views ----------------

// What buyers and the projector may see. Never includes floor or autoAcceptAt.
function publicItem(item: Item) {
  return {
    id: item.id, title: item.title, description: item.description, listPrice: item.listPrice, status: item.status,
    soldPrice: item.soldPrice, soldTo: item.soldTo, soldFirstOffer: item.soldFirstOffer, hasPhoto: !!item.photo, photoCount: item.photos?.length ?? (item.photo ? 1 : 0),
    facts: item.facts ? { condition: item.facts.condition, flaws: item.facts.flaws, highlights: item.facts.highlights, brand: item.facts.brand, era: item.facts.era, material: item.facts.material, size: item.facts.size, color: item.facts.color, acquired: item.facts.acquired ?? null, merchantNotes: item.facts.merchantNotes ?? null } : null,
    createdAt: item.createdAt,
    credit: item.credit ?? null,
  }
}

const dataOf = (e: { data?: unknown }) => (e.data ?? {}) as { itemId?: string; offer?: number; detail?: string }

function itemStats(itemId: string) {
  const entries = log.filter((e) => dataOf(e).itemId === itemId)
  const offers = entries.map((e) => dataOf(e).offer).filter((n): n is number => typeof n === 'number' && n > 0)
  const buyers = [...buyerSessions.values()].filter((s) => s.itemId === itemId)
  return {
    buyers: buyers.length,
    buyerNames: buyers.map((b) => b.buyerName),
    offers: offers.length,
    lowestOffer: offers.length ? Math.min(...offers) : null,
    bestOffer: offers.length ? Math.max(...offers) : null,
    rulesProtected: entries.filter((e) => e.kind === 'manipulation').length,
  }
}

// Inventory row / sold record for the owner. Derived only from real state and the activity log.
function itemSummary(item: Item) {
  const { photo, photos, ...rest } = item
  const book = offerBook(item.id)
  const pending = [...approvals.values()].filter((a) => a.itemId === item.id && a.status === 'pending')
  const entries = log.filter((e) => dataOf(e).itemId === item.id)
  const count = (kind: string, pred: (e: any) => boolean = () => true) => entries.filter((e) => e.kind === kind && pred(e)).length
  const sessions = [...buyerSessions.values()].filter((x) => x.itemId === item.id)
  const created = Date.parse(item.createdAt ?? '') || Date.now()
  const end = item.soldAt ? Date.parse(item.soldAt) : Date.now()
  const displayStatus = item.status === 'sold' ? 'SOLD' : item.status === 'paused' ? 'PAUSED' : pending.length ? 'PENDING APPROVAL' : book.offers.length ? 'NEGOTIATING' : 'LIVE'
  const aiStatus = item.status === 'sold' ? 'Done' : item.status === 'paused' ? 'Paused, not replying with offers'
    : pending.length ? `Waiting on you (${pending.length} offer${pending.length > 1 ? 's' : ''})` : sessions.length ? `Talking to ${sessions.length} buyer${sessions.length > 1 ? 's' : ''}` : 'Waiting for buyers'
  return {
    ...rest, hasPhoto: !!photo, photoCount: photos?.length ?? (photo ? 1 : 0), stats: itemStats(item.id), displayStatus, aiStatus,
    highestOffer: book.highest?.amount ?? null, interested: sessions.length,
    ageMinutes: Math.round((Date.now() - created) / 60000),
    timeToSellMinutes: item.soldAt ? Math.max(1, Math.round((end - created) / 60000)) : null,
    discountPct: item.soldPrice != null ? Math.round((1 - item.soldPrice / item.listPrice) * 100) : null,
    agentActions: {
      buyerMessages: sessions.reduce((n, x) => n + (x.transcript?.filter((t) => t.role === 'buyer').length ?? 0), 0),
      counters: count('offer'),
      lowballsHandled: count('offer', (e) => String(e.data?.detail ?? '').startsWith('Lowball')),
      questionsForwarded: count('question'),
      rulesProtected: count('manipulation'),
      approvalsRequested: count('approval'),
    },
    history: entries.filter((e) => ['offer', 'approval', 'countered', 'declined', 'sold', 'question', 'manipulation', 'highest'].includes(e.kind))
      .map((e) => ({ ts: e.ts, kind: e.kind, message: e.message, detail: dataOf(e).detail })),
  }
}

// The buyer agent's conversation is shown on the projector. Human buyers' chats are not.
function agentChat(itemId: string) {
  const bot = [...buyerSessions.values()].filter((x) => x.itemId === itemId && x.isAgent).at(-1)
  return bot ? { transcript: (bot.transcript ?? []).slice(-12), lastOffer: bot.lastOffer ?? null } : null
}

const r_live = (itemId: string) => items.get(itemId)?.status === 'live'

const shopItems = (shopId: string) => [...items.values()].filter((i) => shopOfItem(i) === shopId)
// Log entries carry their shop; older entries without one belong to the main shop.
const entryShop = (e: { data?: unknown }) => ((e.data ?? {}) as { shopId?: string }).shopId ?? MAIN_SHOP

function shopStats(shopId: string) {
  const all = shopItems(shopId)
  const ids = new Set(all.map((i) => i.id))
  const timed = all.map((i) => i.listingSeconds).filter((n): n is number => typeof n === 'number')
  return {
    listed: all.length,
    sold: all.filter((i) => i.status === 'sold').length,
    avgListingSeconds: timed.length ? Math.round(timed.reduce((a, b) => a + b, 0) / timed.length) : null,
    buyerChats: [...buyerSessions.values()].filter((s) => ids.has(s.itemId)).length,
    rulesProtected: log.filter((e) => e.kind === 'manipulation' && entryShop(e) === shopId).length,
  }
}

const FEED_KINDS = ['listing', 'offer', 'manipulation', 'approval', 'sold', 'declined', 'buyer', 'question', 'highest', 'countered', 'edited', 'paused', 'deleted', 'answered']
// Evidence includes the floor, so only the owner's feed gets it.
const feed = (shopId: string, n: number, withEvidence = false) => log.filter((e) => FEED_KINDS.includes(e.kind) && entryShop(e) === shopId).slice(-n).reverse()
  .map((e) => ({ ts: e.ts, kind: e.kind, message: e.message, detail: dataOf(e).detail, evidence: withEvidence ? (e.data as any)?.evidence : undefined }))

// Advisory only: the owner decides. Built from real offers in the offer book.
function approvalAdvice(itemId: string, sessionId: string, price: number) {
  const book = offerBook(itemId)
  const best = book.offers.find((o) => o.sessionId !== sessionId) ?? null
  const item = items.get(itemId)!
  let recommendation: string
  if (best && best.amount > price) recommendation = `Another buyer currently has $${best.amount}, so accepting $${price} would leave money on the table. Counter or decline.`
  else if (best) recommendation = `This is the highest offer right now (next best is $${best.amount}), $${Math.round((price - item.floor) * 100) / 100} above your floor.`
  else recommendation = `Only offer so far, $${Math.round((price - item.floor) * 100) / 100} above your floor. Accept to sell now, or counter to hold out.`
  return { currentBestOther: best?.amount ?? null, recommendation, suggestedCounter: Math.max(item.autoAcceptAt, Math.ceil((best?.amount ?? price) + 1)) }
}

// ---------------- HTTP plumbing ----------------

// Merchant intake answers override what the AI guessed from the photo, and are marked as merchant-confirmed.
function mergeIntake(facts: Item['facts'], intake: any): Item['facts'] {
  if (!intake) return facts
  const f = facts ?? { brand: null, era: null, material: null, size: null, color: null, condition: '', flaws: [], highlights: [] }
  const qa = (Array.isArray(intake.qa) ? intake.qa : []).map((x: any) => ({ q: String(x.q ?? '').slice(0, 200), a: String(x.a ?? '').slice(0, 300) })).filter((x: any) => x.q && x.a)
  const retail = Number(intake.retailPrice)
  return {
    ...f,
    condition: intake.condition ? String(intake.condition).slice(0, 30) : f.condition,
    flaws: intake.flaws !== undefined ? lines(intake.flaws) : f.flaws,
    acquired: intake.acquired ? String(intake.acquired).slice(0, 40) : f.acquired ?? null,
    retailPrice: Number.isFinite(retail) && retail > 0 ? retail : f.retailPrice ?? null,
    merchantNotes: intake.notes ? String(intake.notes).slice(0, 500) : f.merchantNotes ?? null,
    qa: [...(f.qa ?? []), ...qa],
    merchantConfirmed: true,
  }
}

const lines = (v: unknown) => (Array.isArray(v) ? v : String(v ?? '').split('\n')).map((x) => String(x).trim()).filter(Boolean).slice(0, 8)

class HttpError extends Error {
  status: number
  constructor(status: number, message: string) {
    super(message)
    this.status = status
  }
}

async function body(req: IncomingMessage, limit = 20_000): Promise<any> {
  let raw = ''
  for await (const chunk of req) {
    raw += chunk
    if (raw.length > limit) throw new HttpError(413, 'Body too large')
  }
  try { return raw ? JSON.parse(raw) : {} } catch { throw new HttpError(400, 'Invalid JSON') }
}

function send(res: ServerResponse, status: number, data: unknown, type = 'application/json') {
  res.writeHead(status, { 'Content-Type': type, 'Cache-Control': 'no-store' })
  res.end(type === 'application/json' ? JSON.stringify(data) : (data as string | Buffer))
}

// Every buyer chat costs ZooWork credits, so public visitors get limits: per visitor (by IP) and a
// daily cap for the whole shop. Tune with BUYER_MSGS_PER_10MIN / BUYER_MSGS_PER_DAY.
const BUYER_MSGS_PER_10MIN = Number(process.env.BUYER_MSGS_PER_10MIN ?? 30)
const BUYER_CHATS_PER_10MIN = 5
const BUYER_MSGS_PER_DAY = Number(process.env.BUYER_MSGS_PER_DAY ?? 1000)
const hits = new Map<string, number[]>()

function rateLimit(key: string, max: number, windowMs: number, message: string) {
  const now = Date.now()
  if (hits.size > 10_000) hits.clear()
  const recent = (hits.get(key) ?? []).filter((t) => now - t < windowMs)
  if (recent.length >= max) throw new HttpError(429, message)
  recent.push(now)
  hits.set(key, recent)
}

function clientIp(req: IncomingMessage) {
  // Render's proxy puts the visitor's address first in x-forwarded-for.
  return String(req.headers['x-forwarded-for'] ?? '').split(',')[0].trim() || req.socket.remoteAddress || 'unknown'
}

// Returns the shop this owner token belongs to: the main shop (MERCHANT_TOKEN) or a guest shop.
function requireMerchant(req: IncomingMessage): string {
  const token = String(req.headers['x-merchant-token'] ?? '')
  if (token && token === MERCHANT_TOKEN) return MAIN_SHOP
  const guest = token ? [...shops.values()].find((s) => s.token === token) : undefined
  if (!guest) throw new HttpError(401, 'Merchant token required')
  guest.lastActiveAt = new Date().toISOString()
  return guest.id
}

// Another shop's item is reported as missing, so guests can't probe each other's shops.
function ownItem(shopId: string, itemId: string | undefined) {
  const item = itemId ? items.get(itemId) : undefined
  if (!item || shopOfItem(item) !== shopId) throw new HttpError(404, 'Item not found')
  return item
}

// Guest owners spend the same ZooWork credits, so their costly actions have daily caps (kept in
// Upstash in production, so the free plan's restarts don't reset them).
const GUEST_LISTINGS_PER_DAY = Number(process.env.GUEST_LISTINGS_PER_DAY ?? 5)
const GUEST_LISTINGS_SITE_PER_DAY = Number(process.env.GUEST_LISTINGS_SITE_PER_DAY ?? 100)
const GUEST_BOTS_PER_DAY = 3
const GUEST_SHOPS_PER_IP_PER_DAY = 3
const GUEST_SHOPS_SITE_PER_DAY = 200

async function dailyLimit(key: string, max: number, message: string) {
  if ((await countToday(key)) > max) throw new HttpError(429, message)
}

function guestShopView(shopId: string) {
  const s = shops.get(shopId)
  return {
    id: shopId,
    guest: shopId !== MAIN_SHOP,
    storefront: shopId === MAIN_SHOP ? '/shop' : `/shop?s=${shopId}`,
    expiresAt: s ? new Date(Date.parse(s.lastActiveAt) + GUEST_SHOP_DAYS * 86_400_000).toISOString() : null,
    listingsPerDay: shopId === MAIN_SHOP ? null : GUEST_LISTINGS_PER_DAY,
  }
}

// Guest shops are deleted after GUEST_SHOP_DAYS without their owner opening them.
function expireGuestShops() {
  const cutoff = Date.now() - GUEST_SHOP_DAYS * 86_400_000
  for (const s of [...shops.values()]) {
    if (Date.parse(s.lastActiveAt) >= cutoff) continue
    deleteShop(s.id)
    for (const [id, j] of jobs) if (j.shopId === s.id) jobs.delete(id)
    console.log(`Guest shop ${s.id} expired`)
  }
}

function money(v: unknown, field: string) {
  const n = Number(v)
  if (!Number.isFinite(n) || n <= 0) throw new HttpError(400, `${field} must be a positive number`)
  return Math.round(n * 100) / 100
}

function sendDataUrl(res: ServerResponse, dataUrl: string) {
  const m = dataUrl.match(/^data:(image\/[a-z]+);base64,(.+)$/)
  if (!m) throw new HttpError(404, 'No photo')
  res.writeHead(200, { 'Content-Type': m[1], 'Cache-Control': 'max-age=3600' })
  res.end(Buffer.from(m[2], 'base64'))
}

// ---------------- Routes ----------------

async function route(req: IncomingMessage, res: ServerResponse) {
  const url = new URL(req.url ?? '/', 'http://x')
  const parts = url.pathname.split('/').filter(Boolean)
  const method = req.method ?? 'GET'

  // Landing page: anyone can start a guest shop from here.
  if (method === 'GET' && url.pathname === '/') return send(res, 200, file('home.html'), 'text/html')
  if (method === 'GET' && STATIC[url.pathname]) {
    const [name, type] = STATIC[url.pathname]
    return send(res, 200, file(name), type)
  }
  if (method === 'GET' && parts[0] === 'buy' && parts[1]) return send(res, 200, file('buyer.html'), 'text/html')
  if (method === 'GET' && parts[0] === 'shop') return send(res, 200, file('shop.html'), 'text/html')
  if (parts[0] !== 'api') throw new HttpError(404, 'Not found')

  // --- Merchant ---

  if (method === 'POST' && url.pathname === '/api/listings') {
    const shopId = requireMerchant(req)
    const b = await body(req, 9_000_000)
    const list: unknown[] = Array.isArray(b.photos) ? b.photos : [b.photo]
    if (!list.length || list.length > 6) throw new HttpError(400, 'Send 1 to 6 photos')
    const photos = list.map((url) => {
      const m = String(url ?? '').match(/^data:(image\/(?:jpeg|png|webp));base64,([A-Za-z0-9+/=]+)$/)
      if (!m) throw new HttpError(400, 'Photos must be JPEG, PNG, or WebP data URLs')
      if (m[2].length > 3_500_000) throw new HttpError(413, 'A photo is too large')
      return { url: String(url), mimeType: m[1] as Mime, data: m[2] }
    })
    // ZooWork caps one tool result at 8 MiB across all images.
    if (photos.reduce((n, p) => n + p.data.length, 0) > 7_500_000) throw new HttpError(413, 'Photos too large in total')
    if (shopId !== MAIN_SHOP) {
      // The app shrinks photos to ~200 KB each; a stricter cap keeps guest shops within free storage.
      if (photos.reduce((n, p) => n + p.data.length, 0) > 2_500_000) throw new HttpError(413, 'Photos too large in total')
      await dailyLimit(`listings:${shopId}`, GUEST_LISTINGS_PER_DAY, `Guest shops can list ${GUEST_LISTINGS_PER_DAY} items a day. Come back tomorrow!`)
      await dailyLimit('listings:guests', GUEST_LISTINGS_SITE_PER_DAY, 'Lots of people are trying Snap & Sell today. Come back tomorrow!')
    }
    const job = startJob(photos, shopId)
    if (url.searchParams.get('hidden') === '1') job.hidden = true
    return send(res, 202, jobView(job))
  }

  if (method === 'GET' && parts[1] === 'listings' && parts[2] && !parts[3]) {
    const shopId = requireMerchant(req)
    const job = jobs.get(parts[2])
    if (!job || job.shopId !== shopId) throw new HttpError(404, 'Listing job not found')
    return send(res, 200, jobView(job))
  }

  if (method === 'GET' && parts[1] === 'listings' && parts[2] && parts[3] === 'photo') {
    const job = jobs.get(parts[2])
    if (!job) throw new HttpError(404, 'Listing job not found')
    return sendDataUrl(res, job.photos[Number(url.searchParams.get('i') ?? 0)] ?? job.photo)
  }

  if (method === 'POST' && url.pathname === '/api/items') {
    const shopId = requireMerchant(req)
    const b = await body(req)
    const title = String(b.title ?? '').trim().slice(0, 120)
    if (!title) throw new HttpError(400, 'Title is required')
    const listPrice = money(b.listPrice, 'List price')
    const floor = money(b.floor, 'Floor')
    const autoAcceptAt = money(b.autoAcceptAt, 'Auto-accept price')
    if (!(floor <= autoAcceptAt && autoAcceptAt <= listPrice)) throw new HttpError(400, 'Need floor ≤ auto-accept ≤ list price')
    const found = b.listingId ? jobs.get(String(b.listingId)) : undefined
    const job = found?.shopId === shopId ? found : undefined
    const item: Item = {
      id: randomUUID().slice(0, 8), shopId, title, description: String(b.description ?? '').slice(0, 1000),
      listPrice, autoAcceptAt, floor, status: 'live',
      photo: job?.photo, photos: job?.photos, listingSeconds: job?.seconds, createdAt: new Date().toISOString(),
      facts: mergeIntake(job?.draft?.facts, b.intake),
      category: job?.draft?.category,
      market: job?.evidence?.market,
      history: job?.evidence ? { ...job.evidence.history, prices: job.evidence.history.matches.map((m) => m.price) } : undefined,
    }
    items.set(item.id, item)
    logEvent('listing', `${title} listed`, { itemId: item.id, detail: `$${listPrice}${job?.seconds ? ` · ready in ${job.seconds}s` : ''}` })
    return send(res, 201, item)
  }

  if (method === 'GET' && url.pathname === '/api/merchant/state') {
    const shopId = requireMerchant(req)
    const mine = (itemId: string) => shopOfItem(items.get(itemId)) === shopId && items.has(itemId)
    return send(res, 200, {
      items: shopItems(shopId).map(itemSummary),
      approvals: [...approvals.values()].filter((a) => mine(a.itemId)).reverse().map((a) => ({ ...a, item: (({ photo, photos, ...i }) => i)(items.get(a.itemId)!), ...approvalAdvice(a.itemId, a.sessionId, a.price) })),
      shop: shopStats(shopId),
      shopInfo: guestShopView(shopId),
      feed: feed(shopId, 30, true),
      questions: [...questions.values()].filter((q) => mine(q.itemId)).reverse().map((q) => ({ ...q, itemTitle: items.get(q.itemId)?.title ?? '' })),
      pastSalesIsSample: pastSales.isSample,
      historyLabel: pastSales.label,
    })
  }

  if (parts[1] === 'merchant' && parts[2] === 'items' && parts[3]) {
    const shopId = requireMerchant(req)
    const item = ownItem(shopId, parts[3])
    const action = parts[4]

    if (method === 'GET' && !action) {
      return send(res, 200, {
        item: itemSummary(item),
        buyers: [...buyerSessions.values()].filter((x) => x.itemId === item.id).map((x) => ({
          buyerName: x.buyerName, isAgent: !!x.isAgent, lastOffer: x.lastOffer ?? null, lastCounter: x.lastCounter ?? null, transcript: x.transcript ?? [],
        })),
        approvals: [...approvals.values()].filter((a) => a.itemId === item.id),
      })
    }
    if (method === 'PATCH' && !action) {
      if (item.status === 'sold') throw new HttpError(409, 'Sold items cannot be edited')
      const b = await body(req)
      const next = { ...item }
      if (b.title !== undefined) next.title = String(b.title).trim().slice(0, 120) || item.title
      if (b.description !== undefined) next.description = String(b.description).slice(0, 1000)
      if (b.listPrice !== undefined) next.listPrice = money(b.listPrice, 'List price')
      if (b.floor !== undefined) next.floor = money(b.floor, 'Floor')
      if (b.autoAcceptAt !== undefined) next.autoAcceptAt = money(b.autoAcceptAt, 'Auto-accept price')
      if (!(next.floor <= next.autoAcceptAt && next.autoAcceptAt <= next.listPrice)) throw new HttpError(400, 'Need floor ≤ auto-accept ≤ list price')
      if (b.condition !== undefined || b.flaws !== undefined || b.highlights !== undefined) {
        const f = next.facts ?? { brand: null, era: null, material: null, size: null, color: null, condition: '', flaws: [], highlights: [] }
        next.facts = {
          ...f,
          condition: b.condition !== undefined ? String(b.condition).slice(0, 40) : f.condition,
          flaws: b.flaws !== undefined ? lines(b.flaws) : f.flaws,
          highlights: b.highlights !== undefined ? lines(b.highlights) : f.highlights,
          merchantConfirmed: true,
        } as typeof f
      }
      // Counters already given to buyers stay valid; they never exceed the new list price.
      Object.assign(item, next)
      for (const x of buyerSessions.values()) if (x.itemId === item.id && x.lastCounter != null) x.lastCounter = Math.min(x.lastCounter, item.listPrice)
      logEvent('edited', `${item.title} edited`, { itemId: item.id, detail: `$${item.listPrice} list` })
      return send(res, 200, itemSummary(item))
    }
    if (method === 'POST' && (action === 'pause' || action === 'resume')) {
      if (item.status === 'sold') throw new HttpError(409, 'Item already sold')
      item.status = action === 'pause' ? 'paused' : 'live'
      logEvent(action === 'pause' ? 'paused' : 'listing', `${item.title} ${action === 'pause' ? 'paused' : 'back live'}`, { itemId: item.id })
      return send(res, 200, itemSummary(item))
    }
    if (method === 'POST' && action === 'mark-sold') {
      if (item.status === 'sold') throw new HttpError(409, 'Item already sold')
      const b = await body(req)
      markSold(item, money(b.price, 'Sale price'), String(b.buyer ?? 'In-store buyer').slice(0, 40), 'marked sold by owner')
      return send(res, 200, itemSummary(item))
    }
    if (method === 'DELETE' && !action) {
      if (item.status === 'sold') throw new HttpError(409, 'Sold items stay in your history')
      items.delete(item.id)
      for (const [id, x] of buyerSessions) if (x.itemId === item.id) buyerSessions.delete(id)
      for (const [id, a] of approvals) if (a.itemId === item.id) approvals.delete(id)
      forgetPhotos([item.id])
      logEvent('deleted', `${item.title} deleted`, { shopId })
      return send(res, 200, { ok: true })
    }
  }

  if (method === 'POST' && parts[1] === 'merchant' && parts[2] === 'buyer-agent') {
    const shopId = requireMerchant(req)
    const b = await body(req)
    const item = b.itemId ? ownItem(shopId, String(b.itemId)) : shopItems(shopId).filter((i) => i.status === 'live').at(-1)
    if (!item) throw new HttpError(404, 'No live item')
    if (shopId !== MAIN_SHOP) await dailyLimit(`bots:${shopId}`, GUEST_BOTS_PER_DAY, `Guest shops can run the buyer agent ${GUEST_BOTS_PER_DAY} times a day.`)
    // Budgets: "tough" lands between floor and auto-accept so the owner gets the call;
    // "walk" sits under the floor so you can watch the floor hold; "deal" can reach auto-accept.
    const mode = String(b.mode ?? 'tough')
    const budget = mode === 'walk' ? Math.max(1, item.floor - 3) : mode === 'deal' ? item.autoAcceptAt + 1 : Math.round((item.floor + item.autoAcceptAt) / 2)
    try { await runShopperBot(negotiatorId, shopperId, item.id, budget) } catch (e) { throw new HttpError(409, e instanceof Error ? e.message : 'Could not start') }
    return send(res, 202, { ok: true, itemId: item.id, mode })
  }

  if (method === 'POST' && parts[1] === 'questions' && parts[2] && parts[3] === 'answer') {
    const shopId = requireMerchant(req)
    const q = questions.get(parts[2])
    if (!q || shopOfItem(items.get(q.itemId)) !== shopId) throw new HttpError(404, 'Question not found')
    const answer = String((await body(req)).answer ?? '').trim().slice(0, 500)
    if (!answer) throw new HttpError(400, 'Answer is empty')
    Object.assign(q, { status: 'answered', answer, answeredAt: new Date().toISOString() })
    const item = items.get(q.itemId)
    // Saved to the item, so the agent can answer the next buyer who asks the same thing.
    if (item) {
      item.facts ??= { brand: null, era: null, material: null, size: null, color: null, condition: '', flaws: [], highlights: [] }
      item.facts.qa = [...(item.facts.qa ?? []).filter((x) => x.q !== q.question), { q: q.question, a: answer }]
    }
    noteForSession(q.sessionId, `The owner answered the buyer's question "${q.question}": ${answer}`)
    logEvent('answered', `Owner answered ${q.buyerName}`, { itemId: q.itemId, detail: `${q.question} → ${answer}` })
    return send(res, 200, q)
  }

  if (method === 'POST' && url.pathname === '/api/merchant/reset') {
    const shopId = requireMerchant(req)
    resetShop(shopId)
    for (const [id, j] of jobs) if (j.shopId === shopId) jobs.delete(id)
    if (shopId === MAIN_SHOP) latestJobId = undefined
    // The main shop restocks with demo items, so the public storefront is never empty.
    if (shopId === MAIN_SHOP) seedDemoItems()
    return send(res, 200, { ok: true })
  }

  if (method === 'POST' && parts[1] === 'approvals' && parts[2]) {
    const shopId = requireMerchant(req)
    const a = approvals.get(parts[2])
    if (!a || shopOfItem(items.get(a.itemId)) !== shopId || !items.has(a.itemId)) throw new HttpError(404, 'Approval not found')
    if (a.status !== 'pending') throw new HttpError(409, `Already ${a.status}`)
    const b = await body(req)
    const { decision } = b
    const item = items.get(a.itemId)!
    if (decision === 'accept') {
      if (item.status !== 'live') throw new HttpError(409, 'Item already sold')
      a.status = 'accepted'
      markSold(item, a.price, a.buyerName, 'owner approved', a.firstOffer)
      noteForSession(a.sessionId, `The owner ACCEPTED this buyer's $${a.price} offer. The item is sold to them.`)
    } else if (decision === 'counter') {
      const s = buyerSessions.get(a.sessionId)
      const price = money(b.price, 'Counter price')
      if (!s || item.status !== 'live') throw new HttpError(409, 'Item no longer available')
      if (price < item.floor) throw new HttpError(400, `Counter can't go below your floor ($${item.floor})`)
      a.status = 'countered'
      a.counterPrice = price
      s.ownerCounter = price
      noteForSession(a.sessionId, `The owner reviewed this buyer's $${a.price} offer and COUNTERED at $${price}. If the buyer accepts $${price}, call evaluate_offer with ${price}.`)
      logEvent('countered', `Owner countered ${a.buyerName} at $${price}`, { itemId: item.id, detail: `they offered $${a.price}` })
    } else if (decision === 'decline') {
      a.status = 'declined'
      noteForSession(a.sessionId, `The owner DECLINED this buyer's $${a.price} offer. Invite a better offer; your current counter still stands.`)
      logEvent('declined', `Owner passed on $${a.price}`, { itemId: item.id, detail: a.buyerName })
    } else throw new HttpError(400, 'decision must be accept, counter, or decline')
    return send(res, 200, a)
  }

  // --- Guest shops (anyone can try the app as an owner) ---

  if (method === 'POST' && url.pathname === '/api/guest-shops') {
    const ip = clientIp(req)
    await dailyLimit(`guestshops:${ip}`, GUEST_SHOPS_PER_IP_PER_DAY, "You've made a few shops today already. Use the one you have, or come back tomorrow.")
    await dailyLimit('guestshops', GUEST_SHOPS_SITE_PER_DAY, 'Lots of people are trying Snap & Sell today. Come back tomorrow!')
    const now = new Date().toISOString()
    const shop: Shop = { id: randomUUID().replace(/-/g, '').slice(0, 10), token: randomUUID().replace(/-/g, ''), kind: 'guest', createdAt: now, lastActiveAt: now }
    shops.set(shop.id, shop)
    logEvent('shop', 'Guest shop created', { shopId: shop.id })
    return send(res, 201, { shopId: shop.id, token: shop.token, ...guestShopView(shop.id) })
  }

  // --- Public (buyers + projector) ---

  if (method === 'GET' && parts[1] === 'items' && parts[2]) {
    const item = items.get(parts[2])
    if (!item) throw new HttpError(404, 'Item not found')
    // shopId lets the storefront and buyer pages link back to the right shop (null = main shop).
    const shopId = shopOfItem(item) === MAIN_SHOP ? null : shopOfItem(item)
    if (!parts[3]) return send(res, 200, { item: publicItem(item), shopId, stats: itemStats(item.id), buyUrl: `${PUBLIC_URL}/buy/${item.id}` })
    if (parts[3] === 'photo') return sendDataUrl(res, item.photos?.[Number(url.searchParams.get('i') ?? 0)] ?? item.photo ?? '')
    if (parts[3] === 'qr.svg') {
      const svg = await QRCode.toString(`${PUBLIC_URL}/buy/${item.id}`, { type: 'svg', margin: 1, color: { dark: '#1d1d1b', light: '#ffffff' } })
      return send(res, 200, svg, 'image/svg+xml')
    }
  }

  if (method === 'GET' && url.pathname === '/api/shop') {
    // ?s=<shopId> shows a guest shop's storefront; no parameter is the main shop.
    const visible = shopItems(url.searchParams.get('s') || MAIN_SHOP).filter((i) => i.status !== 'paused').reverse()
    return send(res, 200, { items: visible.map((i) => ({ ...publicItem(i), interested: itemStats(i.id).buyers, highestOffer: i.status === 'live' ? offerBook(i.id).highest?.amount ?? null : null })) })
  }

  if (method === 'GET' && url.pathname === '/api/architecture') {
    return send(res, 200, { model: MODEL, negotiatorId, listerId, pastSalesIsSample: pastSales.isSample, historyKind: pastSales.kind, historyLabel: pastSales.label, historyCount: pastSales.sales.length, items: items.size, buyerSessions: buyerSessions.size })
  }

  if (method === 'GET' && url.pathname === '/api/stage') {
    // The projector shows the owner's own shop only.
    const live = shopItems(MAIN_SHOP).at(-1)
    const job = latestJobId ? jobs.get(latestJobId) : undefined
    // Show the research screen while a newer listing is being prepared.
    const fresh = job && !job.hidden && job.status !== 'error' && (job.status === 'running' || Date.now() - (job.finishedAt ?? 0) < 120_000)
    const researching = fresh && (!live || Date.parse(live.createdAt ?? '') < job.startedAt) ? job : undefined
    return send(res, 200, {
      item: live ? publicItem(live) : null,
      stats: live ? itemStats(live.id) : null,
      buyUrl: live ? `${PUBLIC_URL}/buy/${live.id}` : null,
      job: researching ? { id: researching.id, ...jobView(researching) } : null,
      shop: shopStats(MAIN_SHOP),
      feed: feed(MAIN_SHOP, 12),
      agentChat: live ? agentChat(live.id) : null,
    })
  }

  if (method === 'POST' && parts[1] === 'items' && parts[2] && parts[3] === 'buyers') {
    const item = items.get(parts[2])
    if (!item) throw new HttpError(404, 'Item not found')
    rateLimit(`chats:${clientIp(req)}`, BUYER_CHATS_PER_10MIN, 10 * 60_000, "You've started a lot of chats. Wait a few minutes.")
    const { name } = await body(req)
    const buyerName = String(name ?? '').replace(/[^\p{L}\p{N} _.-]/gu, '').trim().slice(0, 24) || `Buyer #${buyerSessions.size + 1}`
    const s = await startBuyerSession(negotiatorId, item.id, buyerName)
    logEvent('buyer', `${buyerName} joined`, { itemId: item.id })
    return send(res, 201, { sessionId: s.sessionId, buyerName })
  }

  if (parts[1] === 'sessions' && parts[2]) {
    const s = buyerSessions.get(parts[2])
    if (!s) throw new HttpError(404, 'Session not found')

    if (method === 'POST' && parts[3] === 'messages') {
      const { text } = await body(req)
      const msg = String(text ?? '').trim().slice(0, 500)
      if (!msg) throw new HttpError(400, 'Empty message')
      if (s.busy) throw new HttpError(429, 'Still replying to your last message')
      rateLimit(`msgs:${clientIp(req)}`, BUYER_MSGS_PER_10MIN, 10 * 60_000, "You're sending messages fast. Wait a few minutes.")
      await dailyLimit('msgs:all', BUYER_MSGS_PER_DAY, 'The shop is very busy today. Come back tomorrow.')
      const turn = await runBuyerTurn(negotiatorId, s.sessionId, msg)
      return send(res, 200, { ...turn, item: publicItem(items.get(s.itemId)!), competition: competitionFor(s.sessionId) })
    }

    if (method === 'GET' && !parts[3]) {
      const mine = [...approvals.values()].filter((a) => a.sessionId === s.sessionId).at(-1)
      return send(res, 200, {
        item: publicItem(items.get(s.itemId)!),
        buyerName: s.buyerName,
        firstOffer: s.firstOffer ?? null,
        approval: mine ? { price: mine.price, status: mine.status, counterPrice: mine.counterPrice ?? null } : null,
        competition: r_live(s.itemId) ? competitionFor(s.sessionId) : null,
        answers: [...questions.values()].filter((q) => q.sessionId === s.sessionId && q.status === 'answered').map((q) => ({ id: q.id, question: q.question, answer: q.answer })),
      })
    }
  }

  throw new HttpError(404, 'Not found')
}

expireGuestShops()
setInterval(expireGuestShops, 60 * 60_000).unref()
restockDemoItems()
setInterval(restockDemoItems, 60_000).unref()

createServer(async (req, res) => {
  try {
    await route(req, res)
  } catch (err) {
    const status = err instanceof HttpError ? err.status : 500
    if (status === 500) console.error(err)
    if (!res.headersSent) send(res, status, { error: err instanceof Error ? err.message : 'Server error' })
  }
}).listen(PORT, () => {
  console.log(`\nProjector: ${PUBLIC_URL}/stage`)
  // Host logs aren't private, so the owner token is only printed when running locally.
  console.log(`Owner:     ${PUBLIC_URL}/merchant?token=${PUBLIC_URL.includes('localhost') ? MERCHANT_TOKEN : '<MERCHANT_TOKEN>'}`)
})
