import nodeFetch from 'node-fetch'
import {validUrl, agentFor, agentForFirstParty, protectedRefused, protectedDomain, sameHost} from './resolve.mjs'
import {config} from './config.mjs'

const redirectCodes = [301, 302, 303, 307, 308]

export const maxRedirects = 3
export const redirectRefused = 'Invalid URL (redirect)'
export const maxResponseBytes = 512 * 1024
export const deliveryTimeout = 15_000 // ms
// The text of the HTTP client for a request that is ended by its signal: the same text for the time limit
export const timeoutText = 'The operation was aborted.'

// Ends a response body that is not read (to the end): its connection is closed
const endBody = call => {
  const body = call?.body
  if (body && typeof body.destroy === 'function' && !body.destroyed) body.destroy()
}

/**
 * One webhook delivery. Redirects are not followed by the HTTP client: every hop is a new request that is
 * checked like the first one (validUrl before the request, the public address check at connect time), and a
 * redirect must stay on the same host.
 * As before for the recipient: 301 / 302 / 303 continue as GET without body, 307 / 308 keep method and body.
 * Resolves with the last response (a redirect that is not followed is the result: its code is logged).
 */
export async function deliver (url, {method = 'post', headers = {}, body, signal, application = ''} = {}, {fetch = nodeFetch, check = validUrl, protect = {domains: config.PROTECTED_DOMAINS, allowed: config.PROTECTED_ALLOWED_URLS}} = {}) {
  let target = String(url)
  let request = {method, headers: {...headers}, body}

  // Our own domains: only the exact first-party webhook URLs (resolve.mjs)
  if (protectedRefused(target, protect, application)) {
    throw new Error('Invalid URL')
  }

  for (let hop = 0; ; hop++) {
    // On a protected domain and not refused: one of the exact first-party URLs. Only those can have an address in a
    // reserved block (resolve.mjs).
    const firstParty = protectedDomain(target, protect)

    if (!(await check(target, {firstParty}))) {
      // After a redirect the recipient's server sent us there: its own text, for the report (apiserver: /refused)
      throw new Error(hop === 0 ? 'Invalid URL' : redirectRefused)
    }

    const call = await fetch(target, {
      ...request,
      signal,
      redirect: 'manual',
      agent: firstParty ? agentForFirstParty : agentFor,
      size: maxResponseBytes,
    })

    const location = redirectCodes.includes(call.status) ? call.headers.get('location') : null
    if (!location || hop >= maxRedirects) {
      return call
    }

    // The body of a redirect is not read
    endBody(call)

    let next
    try {
      next = new URL(location, target).toString()
    } catch (e) {
      throw new Error('Invalid URL')
    }

    // A redirect to another host is not followed: not to our own sites, and not anywhere else
    if (!sameHost(next, target) || protectedRefused(next, protect, application)) {
      throw new Error(redirectRefused)
    }

    if (call.status === 303 || ((call.status === 301 || call.status === 302) && String(request.method).toLowerCase() === 'post')) {
      const {'content-type': dropped, ...rest} = request.headers
      request = {method: 'get', headers: rest, body: undefined}
    }

    target = next
  }
}

/**
 * Reads the response body as text, from the stream: never more than maxBytes are kept, and a body that is larger is
 * ended at that point (an error, as before). The signal ends a body that does not finish.
 */
export async function readBody (call, {maxBytes = maxResponseBytes, signal} = {}) {
  const body = call?.body
  if (!body || typeof body[Symbol.asyncIterator] !== 'function') return ''

  const onAbort = () => endBody(call)
  if (signal?.aborted) {
    endBody(call)
    throw new Error(timeoutText)
  }
  signal?.addEventListener('abort', onAbort, {once: true})

  const chunks = []
  let bytes = 0
  try {
    for await (const chunk of body) {
      const part = typeof chunk === 'string' ? Buffer.from(chunk) : chunk
      bytes += part.length
      if (bytes > maxBytes) {
        throw new Error(`content size at ${call.url} over limit: ${maxBytes}`)
      }
      chunks.push(part)
    }
  } catch (e) {
    throw signal?.aborted ? new Error(timeoutText) : e
  } finally {
    signal?.removeEventListener('abort', onAbort)
    endBody(call)
  }

  return new TextDecoder().decode(Buffer.concat(chunks))
}

/**
 * One delivery with one time limit for all of it: the checks, the request, every redirect and the read of the
 * response body. Resolves with {status, headers, text}.
 * At the time limit the request and the body are ended and the error has timeout: true. The result does not wait
 * for a client that does not stop. In every case nothing of this delivery is left open afterwards.
 */
export async function deliverWithin (url, request = {}, {timeout = deliveryTimeout, maxBytes = maxResponseBytes, ...inject} = {}) {
  const controller = new AbortController()
  let expire
  const expired = new Promise((resolve, reject) => { expire = reject })
  const timer = setTimeout(() => {
    expire(Object.assign(new Error(timeoutText), {timeout: true}))
    controller.abort()
  }, timeout)

  const run = async () => {
    const call = await deliver(url, {...request, signal: controller.signal}, inject)
    const text = await readBody(call, {maxBytes, signal: controller.signal})
    return {status: call.status, headers: call.headers, text}
  }

  try {
    return await Promise.race([run(), expired])
  } finally {
    clearTimeout(timer)
    // Ends what is still open: a body that was not read to the end, a redirect, a request that goes on
    controller.abort()
  }
}
