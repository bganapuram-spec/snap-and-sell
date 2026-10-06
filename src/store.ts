// Demo state: items, buyer sessions, owner approvals, and the activity log.
// Kept in memory and snapshotted to data/state.json so a server restart doesn't wipe the demo.

import { existsSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { pathToFileURL } from 'node:url'
import { parseSalesCsv, type Item, type Sale } from './pricing.ts'

export const items = new Map<string, Item>()

export type BuyerSession = {
  sessionId: string
  itemId: string
  buyerName: string
  cursor?: string
  lastCounter?: number
  firstOffer?: number
  lastOffer?: number // this buyer's latest real offer; feeds the item's offer book
  lastOfferAt?: string
  ownerCounter?: number // a counter the owner made by hand; buyer can take it
  isAgent?: boolean // an AI buyer agent (demo shopper), always labelled as one
  transcript?: { role: 'buyer' | 'shop'; text: string; ts: string }[]
  pendingNotes?: string[] // trusted owner updates, delivered to the agent on the next turn
  busy: boolean
}
export const buyerSessions = new Map<string, BuyerSession>()

export type Approval = {
  id: string
  itemId: string
  sessionId: string
  buyerName: string
  price: number
  firstOffer?: number
  lastCounter?: number
  evidence?: unknown
  status: 'pending' | 'accepted' | 'declined' | 'countered'
  counterPrice?: number
}
export const approvals = new Map<string, Approval>()

export type Question = {
  id: string
  itemId: string
  sessionId: string
  buyerName: string
  question: string
  status: 'open' | 'answered'
  answer?: string
  askedAt: string
  answeredAt?: string
}
export const questions = new Map<string, Question>()

// Owner decisions and answers reach the sales agent through this queue, never through buyer text.
export function noteForSession(sessionId: string, note: string) {
  const s = buyerSessions.get(sessionId)
  if (!s) return
  ;(s.pendingNotes ??= []).push(note)
  scheduleSave()
}

export type LogEntry = { ts: string; kind: string; message: string; data?: unknown }
export const log: LogEntry[] = []

export function logEvent(kind: string, message: string, data?: unknown) {
  const entry = { ts: new Date().toISOString(), kind, message, data }
  log.push(entry)
  console.log(`[${entry.ts.slice(11, 19)}] ${kind.padEnd(12)} ${message}`)
  scheduleSave()
}

// ---------------- Sales ----------------

export const onSold: ((item: Item) => void)[] = []

// The one place an item becomes sold. Callers check status first; this refuses a second sale.
export function markSold(item: Item, price: number, buyerName: string, via: string, firstOffer?: number) {
  if (item.status === 'sold') throw new Error('Item already sold')
  Object.assign(item, { status: 'sold', soldPrice: price, soldTo: buyerName, soldFirstOffer: firstOffer, soldAt: new Date().toISOString(), soldVia: via })
  for (const a of approvals.values()) if (a.itemId === item.id && a.status === 'pending') a.status = 'declined'
  logEvent('sold', `SOLD to ${buyerName}`, { itemId: item.id, detail: `$${price} · ${via}` })
  for (const fn of onSold) fn(item)
}

// ---------------- Offer book ----------------

// Real offers only: each buyer's latest offer on a live item. Nothing here is ever invented.
export function offerBook(itemId: string) {
  const item = items.get(itemId)
  const offers = [...buyerSessions.values()]
    .filter((s) => s.itemId === itemId && typeof s.lastOffer === 'number')
    .map((s) => ({ sessionId: s.sessionId, buyerName: s.buyerName, amount: s.lastOffer!, at: s.lastOfferAt, isAgent: !!s.isAgent }))
    .sort((a, b) => b.amount - a.amount)
  return { live: item?.status === 'live', offers, highest: offers[0] ?? null }
}

// What one buyer may know about competition: amounts only, never identities.
export function competitionFor(sessionId: string) {
  const s = buyerSessions.get(sessionId)
  if (!s) return null
  const book = offerBook(s.itemId)
  const others = book.offers.filter((o) => o.sessionId !== sessionId)
  const highestOther = others[0]?.amount ?? null
  return {
    yourOffer: s.lastOffer ?? null,
    highestOtherOffer: highestOther,
    highestOtherIsAgent: others[0]?.isAgent ?? false,
    youAreHighest: s.lastOffer != null && (highestOther == null || s.lastOffer > highestOther),
    otherBuyersWithOffers: others.length,
  }
}

// ---------------- Persistence ----------------
// Locally the shop is saved to data/state.json. In production (free hosting, no disk) it is saved to
// Upstash Redis instead, so a restart or idle spin-down doesn't wipe it.

// DATA_DIR overrides where state.json lives; locally it's ./data.
export const DATA_DIR = process.env.DATA_DIR ? pathToFileURL(`${process.env.DATA_DIR.replace(/\/$/, '')}/`) : new URL('../data/', import.meta.url)
const STATE_FILE = new URL('state.json', DATA_DIR)
const UPSTASH_URL = process.env.UPSTASH_REDIS_REST_URL?.replace(/\/$/, '')
const UPSTASH_TOKEN = process.env.UPSTASH_REDIS_REST_TOKEN
export const remoteStore = !!(UPSTASH_URL && UPSTASH_TOKEN)
const STATE_KEY = 'snapsell:state'
const photoKey = (itemId: string) => `snapsell:photos:${itemId}`
// The state is re-saved on every chat message, so remotely it keeps only the recent log.
const REMOTE_LOG_LIMIT = 300
let saveTimer: NodeJS.Timeout | undefined

// Only the real server saves (loadState turns it on). Scripts and tests that import the store, like
// npm run smoke, must never overwrite the shop's saved items.
let persist = false

export async function redis(...command: string[]): Promise<any> {
  const res = await fetch(UPSTASH_URL!, {
    method: 'POST',
    headers: { authorization: `Bearer ${UPSTASH_TOKEN}`, 'content-type': 'application/json' },
    body: JSON.stringify(command),
  })
  const out = await res.json().catch(() => ({}))
  if (!res.ok || out.error) throw new Error(`Upstash ${command[0]} failed: ${out.error ?? res.status}`)
  return out.result
}

export function scheduleSave() {
  if (!persist) return
  clearTimeout(saveTimer)
  saveTimer = setTimeout(saveNow, 300)
}

// Photos are large and never change, so remotely each item's photos are written once under their own key.
const photosSaved = new Set<string>()
let writing: Promise<void> = Promise.resolve()

export function saveNow(): Promise<void> {
  if (!persist) return Promise.resolve()
  clearTimeout(saveTimer)
  const snapshot = {
    savedAt: new Date().toISOString(),
    items: [...items.values()],
    buyerSessions: [...buyerSessions.values()].map(({ busy, ...s }) => s),
    approvals: [...approvals.values()],
    questions: [...questions.values()],
    log,
  }
  if (!remoteStore) {
    const tmp = new URL('state.json.tmp', DATA_DIR)
    writeFileSync(tmp, JSON.stringify(snapshot))
    renameSync(tmp, STATE_FILE)
    return Promise.resolve()
  }
  // Writes run one after another so an older snapshot can never land after a newer one.
  writing = writing.then(async () => {
    for (const i of snapshot.items) {
      if (photosSaved.has(i.id) || !i.photos?.length && !i.photo) continue
      await redis('SET', photoKey(i.id), JSON.stringify({ photo: i.photo, photos: i.photos }))
      photosSaved.add(i.id)
    }
    const light = { ...snapshot, items: snapshot.items.map(({ photo, photos, ...i }) => i), log: snapshot.log.slice(-REMOTE_LOG_LIMIT) }
    await redis('SET', STATE_KEY, JSON.stringify(light))
  }).catch((err) => console.error('Saving to Upstash failed:', err.message))
  return writing
}

export async function loadState() {
  persist = true
  // Render stops the server with SIGTERM (deploys, idle spin-down): save first so nothing is lost.
  for (const sig of ['SIGTERM', 'SIGINT'] as const) process.once(sig, () => { saveNow().finally(() => process.exit(0)) })
  let snap: any
  if (remoteStore) {
    const raw = await redis('GET', STATE_KEY)
    if (!raw) return console.log('No saved shop in Upstash yet: starting empty')
    snap = JSON.parse(raw)
    const ids: string[] = (snap.items ?? []).map((i: Item) => i.id)
    const photos: (string | null)[] = ids.length ? await redis('MGET', ...ids.map(photoKey)) : []
    ids.forEach((id, n) => {
      if (!photos[n]) return
      Object.assign(snap.items[n], JSON.parse(photos[n]!))
      photosSaved.add(id)
    })
  } else {
    if (!existsSync(STATE_FILE)) return
    snap = JSON.parse(readFileSync(STATE_FILE, 'utf8'))
  }
  for (const i of snap.items ?? []) items.set(i.id, i)
  for (const s of snap.buyerSessions ?? []) buyerSessions.set(s.sessionId, { ...s, busy: false })
  for (const a of snap.approvals ?? []) approvals.set(a.id, a)
  for (const q of snap.questions ?? []) questions.set(q.id, q)
  log.push(...(snap.log ?? []))
  console.log(`Restored ${items.size} items, ${buyerSessions.size} buyer sessions from ${remoteStore ? 'Upstash' : 'data/state.json'} (saved ${snap.savedAt})`)
}

export function resetState() {
  const itemIds = [...items.keys()]
  items.clear()
  buyerSessions.clear()
  approvals.clear()
  questions.clear()
  log.length = 0
  saveNow()
  if (remoteStore && itemIds.length) {
    writing = writing.then(() => redis('DEL', ...itemIds.map(photoKey))).then(() => itemIds.forEach((id) => photosSaved.delete(id)), (err) => console.error('Deleting photos from Upstash failed:', err.message))
  }
}

// Sales history, in order of preference:
//   1. data/past_sales.csv: the merchant's own sales (title,price,sold_date,category)
//   2. data/resale_sales.csv: real US resale sales from the public Mercari dataset (2018), clearly labelled
//   3. data/past_sales.SAMPLE.csv: synthetic, only so the code runs
// Sales made in the app are appended at runtime either way ("sold here").
export type SalesSource = { sales: Sale[]; isSample: boolean; kind: 'shop' | 'public' | 'sample'; label: string }
export function loadPastSales(): SalesSource {
  const own = new URL('../data/past_sales.csv', import.meta.url)
  const pub = new URL('../data/resale_sales.csv', import.meta.url)
  const sample = new URL('../data/past_sales.SAMPLE.csv', import.meta.url)
  if (existsSync(own)) return { sales: parseSalesCsv(readFileSync(own, 'utf8')), isSample: false, kind: 'shop', label: "Your shop's past sales" }
  if (existsSync(pub)) {
    const sales = parseSalesCsv(readFileSync(pub, 'utf8'))
    console.log(`Sales history: ${sales.length} real resale sales from the public Mercari dataset (2018)`)
    return { sales, isSample: false, kind: 'public', label: 'Real resale sales (Mercari, 2018)' }
  }
  console.warn('WARNING: no sales data found, using SAMPLE data (not real).')
  return { sales: parseSalesCsv(readFileSync(sample, 'utf8')), isSample: true, kind: 'sample', label: 'Sample data (not real)' }
}
