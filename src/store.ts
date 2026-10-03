// Demo state: items, buyer sessions, owner approvals, and the activity log.
// Kept in memory and snapshotted to data/state.json so a server restart doesn't wipe the demo.

import { existsSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
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

const STATE_FILE = new URL('../data/state.json', import.meta.url)
let saveTimer: NodeJS.Timeout | undefined

export function scheduleSave() {
  clearTimeout(saveTimer)
  saveTimer = setTimeout(saveNow, 300)
}

export function saveNow() {
  const snapshot = {
    savedAt: new Date().toISOString(),
    items: [...items.values()],
    buyerSessions: [...buyerSessions.values()].map(({ busy, ...s }) => s),
    approvals: [...approvals.values()],
    questions: [...questions.values()],
    log,
  }
  const tmp = new URL('../data/state.json.tmp', import.meta.url)
  writeFileSync(tmp, JSON.stringify(snapshot))
  renameSync(tmp, STATE_FILE)
}

export function loadState() {
  if (!existsSync(STATE_FILE)) return
  const snap = JSON.parse(readFileSync(STATE_FILE, 'utf8'))
  for (const i of snap.items ?? []) items.set(i.id, i)
  for (const s of snap.buyerSessions ?? []) buyerSessions.set(s.sessionId, { ...s, busy: false })
  for (const a of snap.approvals ?? []) approvals.set(a.id, a)
  for (const q of snap.questions ?? []) questions.set(q.id, q)
  log.push(...(snap.log ?? []))
  console.log(`Restored ${items.size} items, ${buyerSessions.size} buyer sessions from data/state.json (saved ${snap.savedAt})`)
}

export function resetState() {
  items.clear()
  buyerSessions.clear()
  approvals.clear()
  questions.clear()
  log.length = 0
  saveNow()
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
