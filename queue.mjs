import debug from 'debug'
import {hostOf} from './logtext.mjs'

const log = debug('xummproxy')

/**
 * One message of the queue: {url, payload, data, secret}. A valid message is handed to send().
 * The log gets the payload id and the host of the destination, never the message itself (see logtext.mjs).
 * Returns true when the message was handed to send().
 */
export function handleMessage (message, send) {
  try {
    const data = JSON.parse(message)
    if (typeof data.url === 'string' && typeof data.payload === 'string') {
      if (typeof data.data === 'object' && data) {
        log('Valid REDIS message, process...', { payload: data.payload, host: hostOf(data.url) })
        send(data.url, data.data, data.payload, data?.secret || '')
        return true
      } else {
        log('Invalid message, missing data object')
      }
    } else {
      log('Invalid message, missing url/payload')
    }
  } catch (e) {
    // The message of a parse error can quote the input: only the kind of error
    log('Error decoding REDIS message', e?.name)
  }
  return false
}
