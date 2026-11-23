/**
 * Text for the log. A log line has what is needed to follow a delivery: the payload id, the host of the destination,
 * the attempt, the status code, the time it took and sizes. It has no URL path or query, no header values, no
 * request or response body and no key material.
 */

// The host of a URL (lower case, no port, no trailing dot). Not a URL: ''.
export const hostOf = url => {
  try {
    return new URL(String(url)).hostname.toLowerCase().replace(/\.+$/, '')
  } catch (e) {
    return ''
  }
}

const originOf = url => {
  try {
    const parsed = new URL(url)
    return `${parsed.protocol}//${parsed.host}`
  } catch (e) {
    return '(url)'
  }
}

// A text with every http(s) / ws(s) URL in it cut down to scheme and host
export const withoutUrlDetails = (text, max = 300) => String(text ?? '')
  .replace(/\b(?:https?|wss?):\/\/[^\s'"<>]*/gi, url => originOf(url))
  .slice(0, max)

// The code of an error (database, network), or its name: no free text
export const errorCode = e => String(e?.code || e?.type || e?.name || 'Error').slice(0, 60)

// The message of an error from a delivery: an HTTP client puts the URL in it
export const errorText = e => withoutUrlDetails(e?.message ?? e)

// An error that was not handled: name, message and stack, same rule for URLs (file paths of the stack stay)
export const errorTrace = e => withoutUrlDetails(e?.stack ?? e?.message ?? e, 2000)
