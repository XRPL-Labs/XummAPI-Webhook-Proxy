import {query} from './database.mjs'
import debug from 'debug'
import express from 'express'

const log = debug('xummproxy:apiserver')
let server
let started = false

const apiserver = {
  start () {
    const app = express()
    const port = Number(process.env?.PORT || 6500) || 6500

    app.get('/:uuid([0-9A-F]{8}-[0-9A-F]{4}-4[0-9A-F]{3}-[89AB][0-9A-F]{3}-[0-9A-F]{12})', async (req, res) => {
      return res.json(await query(`
        SELECT
          moment,
          response_code,
          response_message,
          attempt,
          error
        FROM
          calls
        WHERE
          payload = :uuid ORDER BY id DESC
      `, req.params))
    })
    
    server = app.listen(port, () => {
      log(`Webserver listening on port ${port}`)
    })
    
    started = true
    log('API Server started')
  },
  close () {
    if (started) {
      log('Shutting down webserver...')
      server?.close()
    }
    started = false
  }
}

export {
  apiserver
}
