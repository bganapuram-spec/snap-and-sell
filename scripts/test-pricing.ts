import assert from 'node:assert/strict'
import { evaluateOffer, nicePrice, parseSalesCsv, searchSales, type Item } from '../src/pricing.ts'

const item = (): Item => ({
  id: 'i1', title: 'Levi jacket', description: '', listPrice: 54, autoAcceptAt: 50, floor: 47, status: 'live',
})
const counterOf = (d: ReturnType<typeof evaluateOffer>) => (d.decision === 'counter' ? d.counterPrice : NaN)

assert.deepEqual(evaluateOffer(item(), 60), { decision: 'accept', price: 54 })
assert.deepEqual(evaluateOffer(item(), 51), { decision: 'accept', price: 51 })
assert.deepEqual(evaluateOffer(item(), 48), { decision: 'needs_owner_approval', price: 48 })
assert.deepEqual(evaluateOffer(item(), 47), { decision: 'needs_owner_approval', price: 47 })
assert.equal(evaluateOffer(item(), 0).decision, 'invalid')
assert.equal(evaluateOffer(item(), -5).decision, 'invalid')
assert.equal(evaluateOffer(item(), NaN).decision, 'invalid')
assert.equal(evaluateOffer({ ...item(), status: 'sold' }, 60).decision, 'unavailable')

// Lowball flag at or under half of list.
const lb = evaluateOffer(item(), 20)
assert.equal(lb.decision === 'counter' && lb.lowball, true)
const nl = evaluateOffer(item(), 40)
assert.equal(nl.decision === 'counter' && nl.lowball, false)

// Human-sounding prices and real movement on a wide item.
const wide: Item = { ...item(), listPrice: 100, autoAcceptAt: 60, floor: 55 }
assert.equal(counterOf(evaluateOffer(wide, 52)), 80) // reasonable offer: real step
assert.equal(counterOf(evaluateOffer(wide, 52, 80)), 70)
assert.equal(counterOf(evaluateOffer(wide, 40)), 90) // lowball: small step
assert.equal(counterOf(evaluateOffer(wide, 30, 80)), 75)
assert.equal(nicePrice(52.2, 50, 53), 52)
assert.equal(nicePrice(81.5, 60, 99), 80)

// Over many rounds: counters never rise, never drop below auto-accept, and eventually reach it.
for (const it of [item(), wide, { ...item(), listPrice: 18, autoAcceptAt: 16, floor: 14 }, { ...item(), listPrice: 300, autoAcceptAt: 279, floor: 255 }]) {
  for (const offer of [1, it.listPrice * 0.3, it.listPrice * 0.6, it.floor - 1]) {
    let last: number | undefined
    let reachedBest = false
    for (let round = 0; round < 15; round++) {
      const d = evaluateOffer(it, offer, last)
      if (offer >= it.floor) break
      assert.equal(d.decision, 'counter')
      const c = counterOf(d)
      assert.ok(c >= it.autoAcceptAt, `counter ${c} below auto ${it.autoAcceptAt}`)
      assert.ok(c <= it.listPrice)
      if (last !== undefined) assert.ok(c <= last, `counter rose ${last} -> ${c}`)
      if (last !== undefined && last > it.autoAcceptAt) assert.ok(c < last, `counter stuck at ${c}`)
      last = c
      if (d.decision === 'counter' && d.bestPrice) reachedBest = true
    }
    if (offer < it.floor) assert.ok(reachedBest, `never reached best price for ${it.listPrice}/${offer}`)
  }
}

// No offer below the floor is ever accepted, across a sweep.
for (let o = 0.01; o < 47; o += 0.37) assert.notEqual(evaluateOffer(item(), o).decision, 'accept')

const sales = parseSalesCsv('title,price,sold_date,category\n"Levi\'s jacket, blue",48,2026-09-01,outerwear\nCoach bag,72,2026-09-02,bags\n')
assert.equal(sales.length, 2)
assert.equal(sales[0].title, "Levi's jacket, blue")
const r = searchSales(sales, "levi's jacket")
assert.equal(r.count, 1)
assert.equal(r.median, 48)
assert.equal(searchSales(sales, 'iphone 13').count, 0) // model numbers must match

console.log('pricing tests passed')
