const configPrefix = 'PROXY_CONFIG_'

import dotenv from 'dotenv'
dotenv.config()

import debug from 'debug'
const log = debug('xummproxy:config')

/**
 * Parse config from dotenv (`.env`)
 * assuming prefix configPrefix
 * (and stripping prefix to `config` object)
 */
 const config = Object.keys(process.env)
 .filter(k => k.slice(0, configPrefix.length) === configPrefix)
 .reduce((a, b) => {
   return Object.assign(a, {
     [b.slice(configPrefix.length)]: process.env[b]
   })
 }, {})

console.log('Init Xumm Proxy (1/2)')
log('Init Xumm Proxy (2/2)')

export {
  config
}
