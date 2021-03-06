/**
 * server.js
 *
 * Express server handlers
 */

const express = require('express')
const morgan = require('morgan')
const bodyParser = require('body-parser')
const bsv = require('bsv')

// ------------------------------------------------------------------------------------------------
// Server
// ------------------------------------------------------------------------------------------------

class Server {
  constructor (indexer, logger, port) {
    this.indexer = indexer
    this.logger = logger
    this.port = port
    this.listener = null
    this.onListening = null
  }

  start () {
    const app = express()

    if (this.logger) app.use(morgan('tiny'))

    app.use(bodyParser.text())

    app.get('/jig/:location', this.getJig.bind(this))
    app.get('/berry/:location', this.getBerry.bind(this))
    app.get('/tx/:txid', this.getTx.bind(this))
    app.get('/time/:txid', this.getTime.bind(this))
    app.get('/spends/:location', this.getSpends.bind(this))
    app.get('/unspent', this.getUnspent.bind(this))
    app.get('/jigs', this.getJigs.bind(this))
    app.get('/trust/:txid?', this.getTrust.bind(this))
    app.get('/ban/:txid?', this.getBan.bind(this))
    app.get('/untrusted/:txid?', this.getUntrusted.bind(this))
    app.get('/status', this.getStatus.bind(this))

    app.post('/trust/:txid', this.postTrust.bind(this))
    app.post('/ban/:txid', this.postBan.bind(this))
    app.post('/tx/:txid', this.postTx.bind(this))

    app.delete('/trust/:txid', this.deleteTrust.bind(this))
    app.delete('/ban/:txid', this.deleteBan.bind(this))
    app.delete('/tx/:txid', this.deleteTx.bind(this))

    app.use((err, req, res, next) => {
      if (this.logger) this.logger.error(err.stack)
      res.status(500).send('Something broke!')
    })

    this.listener = app.listen(this.port, () => {
      if (this.logger) this.logger.info(`Listening at http://localhost:${this.listener.address().port}`)
      this.port = this.listener.address().port
      if (this.onListening) this.onListening()
    })
  }

  stop () {
    if (!this.listener) return
    this.listener.close()
    this.listener = null
  }

  async getJig (req, res, next) {
    try {
      const state = this.indexer.jig(req.params.location)
      if (state) {
        res.setHeader('Content-Type', 'application/json')
        res.send(state)
      } else {
        res.status(404).send(`Not found: ${req.params.location}\n`)
      }
    } catch (e) { next(e) }
  }

  async getBerry (req, res, next) {
    try {
      const state = this.indexer.berry(req.params.location)
      if (state) {
        res.setHeader('Content-Type', 'application/json')
        res.send(state)
      } else {
        res.status(404).send(`Not found: ${req.params.location}\n`)
      }
    } catch (e) { next(e) }
  }

  async getTx (req, res, next) {
    try {
      const rawtx = this.indexer.tx(req.params.txid)
      if (rawtx) {
        res.send(rawtx)
      } else {
        res.status(404).send(`Not found: ${req.params.txid}\n`)
      }
    } catch (e) { next(e) }
  }

  async getTime (req, res, next) {
    try {
      const time = this.indexer.time(req.params.txid)
      if (time) {
        res.json(time)
      } else {
        res.status(404).send(`Not found: ${req.params.txid}\n`)
      }
    } catch (e) { next(e) }
  }

  async getSpends (req, res, next) {
    try {
      const txid = this.indexer.spends(req.params.location)
      if (txid) {
        res.send(txid)
      } else {
        res.status(404).send(`Not spent: ${req.params.location}\n`)
      }
    } catch (e) { next(e) }
  }

  async getUnspent (req, res, next) {
    try {
      if (req.query.class) {
        res.json(this.indexer.database.getAllUnspentByClassOrigin(req.query.class))
      } else {
        res.json(this.indexer.database.getAllUnspent())
      }
    } catch (e) { next(e) }
  }

  async getJigs (req, res, next) {
    try {
      const { origin, unspent, owner, lock } = req.query;
      const jigs = await this.indexer.database.getJigList(origin, unspent);
      let list = jigs;
      if (owner || lock) {
        list = jigs.filter(jig => {
          const state = jig.state;
          const jigOwner = state.props.owner;
          if (!jigOwner) {
            return false;
          }
          const ownerType = typeof (jigOwner) === 'string' ? 'address' : 'lock';
          if (owner) {
            return jigOwner === owner;
          } else {
            return (ownerType === 'lock' && jigOwner.T && jigOwner.T['$jig'] === lock);
          }
        });
      }
      res.json(list.map(jig => jig.location));
    } catch (e) { next(e) }
  }

  async getTrust (req, res, next) {
    try {
      if (req.params.txid) {
        res.json(this.indexer.database.isTrusted(req.params.txid))
      } else {
        res.json(Array.from(this.indexer.database.getTrustlist()))
      }
    } catch (e) { next(e) }
  }

  async getBan (req, res, next) {
    try {
      if (req.params.txid) {
        res.json(this.indexer.database.isBanned(req.params.txid))
      } else {
        res.json(Array.from(this.indexer.database.getBanlist()))
      }
    } catch (e) { next(e) }
  }

  async getUntrusted (req, res, next) {
    try {
      const untrusted = this.indexer.untrusted(req.params.txid)
      res.json(untrusted)
    } catch (e) { next(e) }
  }

  async getStatus (req, res, next) {
    try {
      const status = this.indexer.status()
      res.json(status)
    } catch (e) { next(e) }
  }

  async postTrust (req, res, next) {
    try {
      this.indexer.trust(req.params.txid)
      res.send(`Trusted ${req.params.txid}\n`)
    } catch (e) { next(e) }
  }

  async postBan (req, res, next) {
    try {
      this.indexer.ban(req.params.txid)
      res.send(`Banned ${req.params.txid}\n`)
    } catch (e) { next(e) }
  }

  async postTx (req, res, next) {
    try {
      let txid = req.params.txid
      let hex = null
      if (typeof hex === 'string') {
        hex = req.body
        const bsvtx = new bsv.Transaction(hex)
        if (!txid) txid = bsvtx.hash
        if (txid && txid !== bsvtx.hash) throw new Error('txid does not match rawtx')
      }
      if (!txid) throw new Error('Invalid request parameters')
      this.indexer.add(txid, hex)
      res.send(`Added ${txid}\n`)
    } catch (e) { next(e) }
  }

  async deleteTrust (req, res, next) {
    try {
      this.indexer.untrust(req.params.txid)
      res.send(`Untrusted ${req.params.txid}\n`)
    } catch (e) { next(e) }
  }

  async deleteBan (req, res, next) {
    try {
      this.indexer.unban(req.params.txid)
      res.send(`Unbanned ${req.params.txid}\n`)
    } catch (e) { next(e) }
  }

  async deleteTx (req, res, next) {
    try {
      this.indexer.remove(req.params.txid)
      res.send(`Removed ${req.params.txid}\n`)
    } catch (e) { next(e) }
  }
}

// ------------------------------------------------------------------------------------------------

module.exports = Server
