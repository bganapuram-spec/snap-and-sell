// Small shared helpers for all three pages.

window.$ = (id) => document.getElementById(id)

window.el = (tag, props = {}, ...kids) => {
  const { dataset, ...rest } = props
  const n = document.createElement(tag)
  for (const [k, v] of Object.entries(rest)) {
    if (k.startsWith('aria-')) n.setAttribute(k, v)
    else n[k] = v
  }
  if (dataset) Object.assign(n.dataset, dataset)
  n.append(...kids.filter((k) => k !== null && k !== undefined && k !== false))
  return n
}

// Never hangs: requests time out, and reads retry, so a flaky tunnel can't freeze a page.
window.api = async (path, opts = {}, token) => {
  const headers = { 'Content-Type': 'application/json' }
  if (token) headers['X-Merchant-Token'] = token
  const isRead = !opts.method || opts.method === 'GET'
  const timeoutMs = opts.timeoutMs ?? (isRead ? 15000 : 45000)
  for (let attempt = 0; ; attempt++) {
    const ctl = new AbortController()
    const timer = setTimeout(() => ctl.abort(), timeoutMs)
    try {
      const res = await fetch(path, { ...opts, headers, signal: ctl.signal })
      const data = await res.json().catch(() => ({}))
      if (!res.ok) throw Object.assign(new Error(data.error || `Request failed (${res.status})`), { http: res.status })
      return data
    } catch (e) {
      const network = !e.http
      if (isRead && network && attempt < 2) { await new Promise((r) => setTimeout(r, 1000 * (attempt + 1))); continue }
      if (network) throw new Error(e.name === 'AbortError' ? 'Connection timed out.' : 'Connection problem.')
      throw e
    } finally { clearTimeout(timer) }
  }
}

window.money = (n) => (n == null ? '—' : '$' + (Number.isInteger(n) ? n : Number(n).toFixed(2)))

window.clock = (ts) => new Date(ts).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })

const COLORS = ['#111111']
window.avatar = (name, i) => el('div', {
  className: 'avatar',
  textContent: (name || '?').trim().slice(0, 1).toUpperCase(),
  title: name,
  style: `background:${COLORS[i % COLORS.length]}`,
})

window.FEED_ICONS = { listing: 'Listed', offer: 'Offer', manipulation: 'Blocked', approval: 'Needs you', sold: 'Sold', declined: 'Passed', buyer: 'Buyer', question: 'Question', highest: 'Top offer', countered: 'Counter', edited: 'Edited', paused: 'Paused', deleted: 'Deleted', answered: 'Answered', photo: 'Photos', web: 'Web', solddata: 'Sold data', found: 'Found', sold: 'Sold', rules: 'Rules', soldprice: 'Sold' }
// Live research log shown while the lister works (owner screen + projector).
window.researchLog = (activity) => el('div', { className: 'rlog' },
  el('div', { className: 'eyebrow', style: 'margin-bottom:6px', textContent: 'What it’s checking' }),
  activity.length ? el('ul', { className: 'feed' }, ...activity.slice().reverse().slice(0, 9).map((a) => feedItem({ ...a, kind: a.kind === 'sold' ? 'soldprice' : a.kind })))
    : el('div', { className: 'muted', textContent: 'Starting…' }))

window.feedItem = (e) => el('li', { className: 'k-' + e.kind },
  el('time', { textContent: clock(e.ts) }),
  el('span', { className: 'ico', textContent: FEED_ICONS[e.kind] || e.kind }),
  el('div', {}, el('div', { className: 'msg', textContent: e.message }), e.detail ? el('div', { className: 'det', textContent: e.detail }) : null))

window.confetti = () => {
  const box = el('div', { className: 'confetti' })
  const colors = ['#d4ff3a', '#111111', '#111111', '#cacacb', '#d4ff3a']
  for (let i = 0; i < 110; i++) {
    box.append(el('i', {
      style: `left:${Math.random() * 100}%;background:${colors[i % colors.length]};animation-duration:${1.8 + Math.random() * 1.8}s;animation-delay:${Math.random() * 0.5}s;transform:rotate(${Math.random() * 360}deg)`,
    }))
  }
  document.body.append(box)
  setTimeout(() => box.remove(), 4200)
}

window.flash = () => {
  const f = el('div', { className: 'flash' })
  document.body.append(f)
  setTimeout(() => f.remove(), 600)
}

// Same price-tier logic everywhere: quick offers at roughly 70/80/90% of list, rounded to $5.
window.quickOffers = (list) => [0.7, 0.8, 0.9].map((p) => Math.max(5, Math.round((list * p) / 5) * 5)).filter((v, i, a) => a.indexOf(v) === i && v < list)

// Owner-only: the facts behind an offer decision.
window.evidenceBox = (ev) => {
  if (!ev) return null
  const head = ev.decision === 'counter' ? `Why the agent countered at ${money(ev.counter)}`
    : ev.decision === 'needs_owner_approval' ? `Why ${money(ev.offer)} needs you`
    : ev.decision === 'accept' ? `Why the agent sold at ${money(ev.offer >= ev.listPrice ? ev.listPrice : ev.offer)}` : 'Offer details'
  const row = (k, v, cls) => el('div', { className: 'ev-row' + (cls ? ' ' + cls : '') }, el('span', { textContent: k }), el('span', { textContent: v }))
  const sec = (t, ...kids) => el('div', { className: 'ev-sec' }, el('div', { className: 'ev-h', textContent: t }), ...kids)
  const range = (r) => (r && r.count ? `${money(r.min)}–${money(r.max)}` : 'none found')
  return el('div', { className: 'evidence' },
    el('div', { className: 'ev-title', textContent: head }),
    row('Listing price', money(ev.listPrice)),
    sec('Item condition',
      row(ev.condition ? ev.condition[0].toUpperCase() + ev.condition.slice(1) + ' / used' : '—', ''),
      ...ev.flaws.map((f) => el('div', { className: 'ev-b bad', textContent: '• ' + f })),
      ...ev.highlights.map((h) => el('div', { className: 'ev-b', textContent: '• ' + h }))),
    sec('Market', row('Comparable asking range', range(ev.market)), ev.market?.median != null ? row('Median comparable', money(ev.market.median)) : null),
    sec('Real sold prices', row('Similar items sold', ev.history?.prices?.length ? ev.history.prices.map(money).join(' / ') : 'none found')),
    sec('Negotiation',
      row('Buyer offer', money(ev.offer)),
      ev.counter != null ? row('Agent counter', money(ev.counter), 'strong') : null,
      row('Your hard floor', money(ev.floor))),
    el('div', { className: 'ev-checks' }, ...ev.checks.map((c) => el('div', { className: c.ok ? 'ok' : 'no', textContent: (c.ok ? '✓ ' : '✗ ') + c.text }))))
}
