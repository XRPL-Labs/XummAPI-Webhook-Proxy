import {config} from './config.mjs'
import mysql from 'mysql'

import debug from 'debug'
const log = debug('xummproxy:database')

const pool = mysql.createPool({
  connectionLimit: config.MYSQL_CONNLIMIT || 10,
  host: config.MYSQL_HOST || '127.0.0.1',
  port: config.MYSQL_PORT || 3306,
  user: config.MYSQL_USER || 'db',
  password: config.MYSQL_PASSWORD || 'db',
  database: config.MYSQL_DATABASE || 'db',
  charset: 'utf8mb4',
  queryFormat(query, values) {
    if (!values) return query
    return query.replace(/\:(\w+)/g, ((txt, key) => {
      if (values.hasOwnProperty(key)) return this.escape(values[key])
      return txt
    }).bind(this))
  }
})

pool.on('connection', c => {
  log(`Database connected @ ${c.threadId}`)
})

const query = async (query, params) => {
  return new Promise((resolve, reject) => {
    pool.query(query || '', params || {}, (error, results) => {
      if (error) reject(error)
      resolve(results)
    })
  })
}

// Trigger pool connection
query('SELECT @@VERSION')

export {
  query
}
