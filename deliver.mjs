import nodeFetch from 'node-fetch'
import {validUrl, agentFor} from './resolve.mjs'

const redirectCodes = [301, 302, 303, 307, 308]

export const maxRedirects = 3
export const maxResponseBytes = 512 * 1024

/**
 * One webhook delivery. Redirects are not followed by the HTTP client: every hop is a new request that is
 * checked like the first one (validUrl before the request, the public address check at connect time).
 * As before for the recipient: 301 / 302 / 303 continue as GET without body, 307 / 308 keep method and body.
 * Resolves with the last response (a redirect that is not followed is the result: its code is logged).
 */
export async function deliver (url, {method = 'post', headers = {}, body, signal} = {}, {fetch = nodeFetch, check = validUrl} = {}) {
  let target = String(url)
  let request = {method, headers: {...headers}, body}

  for (let hop = 0; ; hop++) {
    if (!(await check(target))) {
      throw new Error('Invalid URL')
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

    if (call.status === 303 || ((call.status === 301 || call.status === 302) && String(request.method).toLowerCase() === 'post')) {
      const {'content-type': dropped, ...rest} = request.headers
      request = {method: 'get', headers: rest, body: undefined}
    }

    target = next
  }
}
