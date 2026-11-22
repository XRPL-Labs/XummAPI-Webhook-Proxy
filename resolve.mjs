import dns from 'dns'
import http from 'http'
import https from 'https'
import debug from 'debug'
import ipaddr from 'ipaddr.js'

const log = debug('xummproxy:resolve')

// Not 'unicast' in ipaddr.js 2.0, and not a destination for a webhook
const alsoRefused = [
  ipaddr.parseCIDR('198.18.0.0/15'),
  ipaddr.parseCIDR('192.0.2.0/24'),
  ipaddr.parseCIDR('198.51.100.0/24'),
  ipaddr.parseCIDR('203.0.113.0/24'),
]

/**
 * A webhook is delivered to a public address only: global unicast IPv4 / IPv6.
 * Everything else is refused: loopback, private, link local, unspecified, carrier grade NAT, unique local,
 * multicast, reserved, and IPv6 forms that carry an IPv4 address (mapped, NAT64, 6to4, Teredo).
 */
export function publicAddress (address) {
  let parsed
  try {
    parsed = ipaddr.parse(String(address))
  } catch (e) {
    return false
  }
  if (parsed.kind() === 'ipv6' && parsed.isIPv4MappedAddress()) {
    parsed = parsed.toIPv4Address()
  }
  if (parsed.range() !== 'unicast') return false
  if (parsed.kind() === 'ipv4' && alsoRefused.some(range => parsed.match(range))) return false
  return true
}

const refused = hostname => Object.assign(new Error('Destination is not a public address'), { code: 'EDESTNOTPUBLIC', hostname })

/**
 * The lookup the socket uses to connect: the address that is checked is the address that is connected to.
 * A name that resolves to an address that is not public (also: one of several) is refused.
 */
export function publicLookup (hostname, options, callback) {
  if (typeof options === 'function') {
    callback = options
    options = {}
  }
  dns.lookup(hostname, { ...options, all: true }, (err, addresses) => {
    if (err) return callback(err)
    const list = Array.isArray(addresses) ? addresses : []
    if (list.length === 0 || !list.every(a => publicAddress(a.address))) {
      log('Refused (lookup)', hostname, list.map(a => a.address))
      return callback(refused(hostname))
    }
    if (options.all) return callback(null, list)
    return callback(null, list[0].address, list[0].family)
  })
}

const agents = {
  'http:': new http.Agent({ lookup: publicLookup }),
  'https:': new https.Agent({ lookup: publicLookup }),
}

// For node-fetch: agent: agentFor
export const agentFor = parsedUrl => agents[parsedUrl.protocol]

/**
 * Before a request: http / https only, no credentials in the URL, and a host that is a public address
 * (an IP literal in any notation) or a name that resolves to public addresses only.
 * The connect time check (publicLookup) is the one that counts for names: this one gives the early, clear refusal.
 */
export async function validUrl (url) {
  let parsed
  try {
    parsed = new URL(String(url))
  } catch (e) {
    return false
  }

  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return false
  if (parsed.username !== '' || parsed.password !== '') return false

  // WHATWG URL: IPv4 notations (decimal, hex, short) are normalised, IPv6 is in brackets
  const hostname = parsed.hostname.replace(/^\[(.+)\]$/, '$1')
  if (hostname === '') return false

  if (ipaddr.isValid(hostname)) {
    const ok = publicAddress(hostname)
    if (!ok) log('Refused (address)', hostname)
    return ok
  }

  return new Promise(resolve => {
    publicLookup(hostname, { all: true }, err => {
      // A name that does not resolve now is left to the request (it fails there, and is retried as before)
      resolve(!(err && err.code === 'EDESTNOTPUBLIC'))
    })
  })
}
