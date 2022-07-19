import dns from 'dns'
import debug from 'debug'
import ipaddr from 'ipaddr.js'

const log = debug('xummproxy:resolve')

export async function validUrl (url) {
  let isValid = false

  if (url.toLowerCase().match(/^http/) && !url.match(/^\/|^\.\//)) {
    const localRangeNames = ['loopback', 'private']
    const hn = url.replace(/\/+/, '/').split('/')[1]
      .replace(/:[0-9]+$/, '')
      .replace(/^\[(.+)\]$/, '$1')
      .replace(/^::ffff:/, '')

    let isLocal = false

    try {
      // log(ipaddr.parse(hn).range())
      isLocal = localRangeNames.indexOf(ipaddr.parse(hn).range()) > -1
    } catch (e) {
      // log(e.message)
    }

    await Promise.all(['resolve4', 'resolve6'].map(ipv => {
      return new Promise(resolve => {
        dns[ipv](hn, (err, records) => {
          if (err) {
            // log(url, ipv, err)
          } else {
            records.forEach(r => {
              const rangeName = ipaddr.parse(r).range()
              const local = localRangeNames.indexOf(rangeName) > -1
              log(ipv, r, rangeName)
              if (local) {
                isLocal = true
              }
            })
          }
          resolve()
        })
      })
    }))

    if (!isLocal) {
      isValid = true
    }
  }

  return isValid
}
