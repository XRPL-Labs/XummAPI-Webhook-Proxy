import dns from 'dns'
import http from 'http'
import https from 'https'
import debug from 'debug'
import ipaddr from 'ipaddr.js'
import {config} from './config.mjs'

const log = debug('xummproxy:resolve')

// Not 'unicast' in ipaddr.js 2.0, and not a destination for a webhook
const alsoRefused = [
  ipaddr.parseCIDR('198.18.0.0/15'),
  ipaddr.parseCIDR('192.0.2.0/24'),
  ipaddr.parseCIDR('198.51.100.0/24'),
  ipaddr.parseCIDR('203.0.113.0/24'),
]

// IPv6: special purpose blocks that ipaddr.js 2.0 gives as 'unicast' and that are no global unicast addresses
// (IANA special purpose registry)
const alsoRefusedV6 = [
  ipaddr.parseCIDR('::/96'), // IPv4-compatible form (deprecated): carries an IPv4 address
  ipaddr.parseCIDR('100::/64'), // discard only
  ipaddr.parseCIDR('64:ff9b:1::/48'), // local use translation: carries an IPv4 address
  ipaddr.parseCIDR('2001::/23'), // protocol assignments (2001:0000: to 2001:01ff:)
  ipaddr.parseCIDR('3fff::/20'), // documentation
  ipaddr.parseCIDR('5f00::/16'), // segment routing identifiers
  ipaddr.parseCIDR('fec0::/10'), // site local (deprecated)
]

// The IPv4-compatible form in dotted notation ('::192.0.2.1', an address in ::/96; a lookup gives this notation):
// ipaddr.js 2.0 reads it as the IPv4-mapped form ('::ffff:192.0.2.1')
const compatibleDotted = /^::[^:]*\.[^:]*$/

/**
 * A webhook is delivered to a public address only: global unicast IPv4 / IPv6.
 * Everything else is refused: loopback, private, link local, site local, unspecified, carrier grade NAT, unique local,
 * multicast, reserved, special purpose blocks, and IPv6 forms that carry an IPv4 address (mapped, compatible, NAT64,
 * 6to4, Teredo).
 */
export function publicAddress (address) {
  let parsed
  try {
    parsed = ipaddr.parse(String(address))
  } catch (e) {
    return false
  }
  if (compatibleDotted.test(String(address))) return false
  if (parsed.kind() === 'ipv6' && parsed.isIPv4MappedAddress()) {
    parsed = parsed.toIPv4Address()
  }
  if (parsed.range() !== 'unicast') return false
  if ((parsed.kind() === 'ipv4' ? alsoRefused : alsoRefusedV6).some(range => parsed.match(range))) return false
  return true
}

/**
 * Reserved address blocks (configuration: PROXY_CONFIG_RESERVED_ADDRESS_BLOCKS, comma separated CIDR, IPv4 and IPv6).
 * A destination with an address in one of these blocks is refused like an address that is not public, except for the
 * exact first-party URLs (see protectedRefused). No list: nothing extra is refused (as before).
 */
export function parseBlocks (value) {
  return String(value || '').split(',').map(v => v.trim()).filter(Boolean).map(entry => {
    try {
      return ipaddr.parseCIDR(entry.includes('/') ? entry : entry + (ipaddr.parse(entry).kind() === 'ipv6' ? '/128' : '/32'))
    } catch (e) {
      log('Ignored (not a CIDR)', entry)
      return null
    }
  }).filter(Boolean)
}

const configuredBlocks = parseBlocks(config.RESERVED_ADDRESS_BLOCKS)

export function reservedAddress (address, blocks = configuredBlocks) {
  let parsed
  try {
    parsed = ipaddr.parse(String(address))
  } catch (e) {
    return false
  }
  if (parsed.kind() === 'ipv6' && parsed.isIPv4MappedAddress()) {
    parsed = parsed.toIPv4Address()
  }
  return blocks.some(range => range[0].kind() === parsed.kind() && parsed.match(range))
}

const refused = hostname => Object.assign(new Error('Destination is not a public address'), { code: 'EDESTNOTPUBLIC', hostname })

/**
 * The lookup the socket uses to connect: the address that is checked is the address that is connected to.
 * A name that resolves to an address that is not public (also: one of several) is refused.
 */
export const lookupWith = (accepted, resolve = dns.lookup) => function (hostname, options, callback) {
  if (typeof options === 'function') {
    callback = options
    options = {}
  }
  resolve(hostname, { ...options, all: true }, (err, addresses) => {
    if (err) return callback(err)
    const list = Array.isArray(addresses) ? addresses : []
    if (list.length === 0 || !list.every(a => accepted(a.address))) {
      log('Refused (lookup)', hostname, list.map(a => a.address))
      return callback(refused(hostname))
    }
    if (options.all) return callback(null, list)
    return callback(null, list[0].address, list[0].family)
  })
}

// Public, and not in a reserved block: every destination that is not a first-party URL
const openAddress = address => publicAddress(address) && !reservedAddress(address)

export const publicLookup = lookupWith(publicAddress)
export const openLookup = lookupWith(openAddress)

const agents = {
  'http:': new http.Agent({ lookup: openLookup }),
  'https:': new https.Agent({ lookup: openLookup }),
}
const firstPartyAgents = {
  'http:': new http.Agent({ lookup: publicLookup }),
  'https:': new https.Agent({ lookup: publicLookup }),
}

// For node-fetch: agent: agentFor (every destination), agent: agentForFirstParty (the exact first-party URLs)
export const agentFor = parsedUrl => agents[parsedUrl.protocol]
export const agentForFirstParty = parsedUrl => firstPartyAgents[parsedUrl.protocol]

/**
 * Before a request: http / https only, no credentials in the URL, and a host that is a public address
 * (an IP literal in any notation) or a name that resolves to public addresses only. An address in a reserved block
 * is accepted only for a first-party URL (firstParty).
 * The connect time check (publicLookup) is the one that counts for names: this one gives the early, clear refusal.
 */
export async function validUrl (url, {firstParty = false} = {}) {
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
    const ok = firstParty ? publicAddress(hostname) : openAddress(hostname)
    if (!ok) log('Refused (address)', hostname)
    return ok
  }

  return new Promise(resolve => {
    ;(firstParty ? publicLookup : openLookup)(hostname, { all: true }, err => {
      // A name that does not resolve now is left to the request (it fails there, and is retried as before)
      resolve(!(err && err.code === 'EDESTNOTPUBLIC'))
    })
  })
}

/**
 * Destinations on our own domains. This service calls URLs that strangers choose; our own sites must not treat its
 * address as one of ours. So: a URL on a protected domain (or a subdomain of it) is delivered only when it is one of
 * the exact first-party webhook URLs (scheme, host, port and path; the query is not compared), and, when the entry
 * names an application ('<application uuid>|<url>'), only for the webhooks of that application.
 * Both lists come from the configuration (.env): PROXY_CONFIG_PROTECTED_DOMAINS and PROXY_CONFIG_PROTECTED_ALLOWED_URLS,
 * comma separated. No list: nothing is protected (as before).
 */
const list = value => String(value || '').split(',').map(v => v.trim()).filter(Boolean)
const exact = url => { const u = new URL(url); return (u.origin + u.pathname.replace(/\/+$/, '')).toLowerCase() }

// A URL on one of the protected domains (or a subdomain)
export function protectedDomain (url, {domains} = {}) {
  const protect = list(domains).map(d => d.toLowerCase().replace(/^\*?\./, ''))
  if (protect.length === 0) return false
  try {
    const host = new URL(String(url)).hostname.toLowerCase().replace(/\.+$/, '')
    return protect.some(d => host === d || host.endsWith('.' + d))
  } catch (e) {
    return false // Not a URL: refused elsewhere
  }
}

export function protectedRefused (url, {domains, allowed} = {}, application = '') {
  if (!protectedDomain(url, {domains})) return false
  const parsed = new URL(String(url))
  // An entry is '<url>' (any application) or '<application uuid>|<url>' (only the webhooks of that application)
  const wanted = exact(parsed.toString())
  const app = String(application || '').toLowerCase()
  return !list(allowed).some(entry => {
    const [first, second] = entry.split('|').map(v => v.trim())
    try {
      return second === undefined ? exact(first) === wanted : (app !== '' && first.toLowerCase() === app && exact(second) === wanted)
    } catch (e) {
      return false
    }
  })
}

// A redirect stays on the host that was asked: the recipient chose that host, not another one
export function sameHost (a, b) {
  try {
    return new URL(String(a)).hostname.toLowerCase() === new URL(String(b)).hostname.toLowerCase()
  } catch (e) {
    return false
  }
}
