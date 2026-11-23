// Limits for the deliveries that run at the same time: one for all deliveries together, one per destination host.

export const defaultLimits = {total: 200, perHost: 20}

const positive = (value, fallback) => {
  const n = Number(value)
  return Number.isInteger(n) && n > 0 ? n : fallback
}

// From the configuration (.env): PROXY_CONFIG_MAX_DELIVERIES and PROXY_CONFIG_MAX_DELIVERIES_PER_HOST
export const limitsFrom = (config = {}) => ({
  total: positive(config.MAX_DELIVERIES, defaultLimits.total),
  perHost: positive(config.MAX_DELIVERIES_PER_HOST, defaultLimits.perHost),
})

// A list where the first one in is the first one out, also fast when it is long
const fifo = () => {
  let items = []
  let head = 0
  return {
    push: item => { items.push(item) },
    shift () {
      const item = items[head]
      items[head++] = undefined
      if (head > 1024 && head * 2 > items.length) {
        items = items.slice(head)
        head = 0
      }
      return item
    },
    get length () { return items.length - head },
  }
}

/**
 * run(host, task) starts the task when there is a free place for all deliveries and for this host, and resolves or
 * rejects like the task. A task over a limit waits: it is never refused.
 * Order: per host, first in is first out. When several hosts wait, they take turns (one task per turn), so a host
 * with many waiting tasks does not delay the others. A host at its own limit is passed over until it has a free
 * place.
 */
export function createLimiter ({total = defaultLimits.total, perHost = defaultLimits.perHost} = {}) {
  let running = 0
  let waiting = 0
  const active = new Map() // host: tasks that run now
  const queues = new Map() // host: waiting tasks. The order of the hosts in the Map is the order of their turns.

  const open = host => running < total && (active.get(host) || 0) < perHost

  const start = (host, task) => {
    running++
    active.set(host, (active.get(host) || 0) + 1)
    task()
  }

  const next = () => {
    while (running < total) {
      let host
      for (const name of queues.keys()) {
        if ((active.get(name) || 0) < perHost) {
          host = name
          break
        }
      }
      if (host === undefined) return

      const queue = queues.get(host)
      const task = queue.shift()
      waiting--
      // To the end of the turns when more tasks wait for this host
      queues.delete(host)
      if (queue.length > 0) queues.set(host, queue)
      start(host, task)
    }
  }

  const done = host => {
    running--
    const left = active.get(host) - 1
    if (left > 0) active.set(host, left)
    else active.delete(host)
    next()
  }

  const run = (host, task) => new Promise((resolve, reject) => {
    const name = String(host)
    const guarded = async () => {
      try {
        resolve(await task())
      } catch (e) {
        reject(e)
      } finally {
        done(name)
      }
    }

    // Not past the tasks that already wait for this host
    if (!queues.has(name) && open(name)) return start(name, guarded)

    if (!queues.has(name)) queues.set(name, fifo())
    queues.get(name).push(guarded)
    waiting++
  })

  return {
    run,
    // A task for this host would start now
    open: host => !queues.has(String(host)) && open(String(host)),
    stats: () => ({running, waiting, hosts: active.size}),
  }
}
