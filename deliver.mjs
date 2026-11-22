import nodeFetch from 'node-fetch'
import {validUrl, agentFor, protectedRefused, sameHost} from './resolve.mjs'
import {config} from './config.mjs'

const redirectCodes = [301, 302, 303, 307, 308]

export const maxRedirects = 3
export const redirectRefused = 'Invalid URL (redirect)'
export const maxResponseBytes = 512 * 1024

/**
 * One webhook delivery. Redirects are not followed by the HTTP client: every hop is a new request that is
 * checked like the first one (validUrl before the request, the public address check at connect time), and a
 * redirect must stay on the same host.
 * As before for the recipient: 301 / 302 / 303 continue as GET without body, 307 / 308 keep method and body.
 * Resolves with the last response (a redirect that is not followed is the result: its code is logged).
 */
export async function deliver (url, {method = 'post', headers = {}, body, signal} = {}, {fetch = nodeFetch, check = validUrl, protect = {domains: config.PROTECTED_DOMAINS, allowed: config.PROTECTED_ALLOWED_URLS}} = {}) {
  let target = String(url)
  let request = {method, headers: {...headers}, body}

  // Our own domains: only the exact first-party webhook URLs (resolve.mjs)
  if (protectedRefused(target, protect)) {
    throw new Error('Invalid URL')
  }

  for (let hop = 0; ; hop++) {
    if (!(await check(target))) {
      // After a redirect the recipient's server sent us there: its own text, for the report (apiserver: /refused)
      throw new Error(hop === 0 ? 'Invalid URL' : redirectRefused)
    }

    const call = await fetch(target, {
      ...request,
      signal,
      redirect: 'manual',
      agent: agentFor,
      size: maxResponseBytes,
    })

    const location = redirectCodes.includes(call.status) ? call.headers.get('location') : null
    if (!location || hop >= maxRedirects) {
      return call
    }

    let next
    try {
      next = new URL(location, target).toString()
    } catch (e) {
      throw new Error('Invalid URL')
    }

    // A redirect to another host is not followed: not to our own sites, and not anywhere else
    if (!sameHost(next, target) || protectedRefused(next, protect)) {
      throw new Error(redirectRefused)
    }

    if (call.status === 303 || ((call.status === 301 || call.status === 302) && String(request.method).toLowerCase() === 'post')) {
      const {'content-type': dropped, ...rest} = request.headers
      request = {method: 'get', headers: rest, body: undefined}
    }

    target = next
  }
}
