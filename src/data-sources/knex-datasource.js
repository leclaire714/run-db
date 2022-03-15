/**
 * database.js
 *
 * Layer between the database and the application
 */
const { HEIGHT_MEMPOOL, CRAWL_HASH, CRAWL_HEIGHT } = require('../constants')
const { TX, DEPS, EXECUTING, TRUST, BAN, SPEND, JIG, BERRY, CRAWL } = require('./columns')

class KnexDatasource {
  constructor (knex, logger, readonly = false) {
    this.knex = knex
    this.logger = logger
    this.readonly = readonly
    this.connection = null
    this.insideTx = false
  }

  prepareStatements () {}

  async setUp () {
    // this.knex = knex({
    //   client: 'pg',
    //   connection: this.connectionUri
    // })
  }

  async tearDown () {
    if (this.knex) {
      await this.knex.destroy()
      this.knex = null
    }
  }

  async performOnTransaction (fn) {
    if (this.insideTx) {
      return fn(this)
    }

    return this.knex.transaction(async trx => {
      const newDs = new KnexDatasource(trx, this.logger, this.readonly)
      newDs.insideTx = true
      try {
        await fn(newDs)
      } catch (e) {
        console.error(e)
        throw e
      }
    })
  }

  async txExists (txid) {
    const row = await this.knex(TX.NAME).where(TX.txid, txid).first([TX.txid])
    return !!row
  }

  async checkTxIsDownloaded (txid) {
    const result = await this.knex(TX.NAME).where(TX.txid, txid).whereNotNull('bytes').first([TX.txid])
    return !!result
  }

  async searchTxsAboveHeight (height) {
    return this.knex(TX.NAME).where(TX.height, '>', height).pluck(TX.txid)
  }

  async mempoolTxsPreviousToTime (time) {
    return this.knex(TX.NAME)
      .where(TX.height, HEIGHT_MEMPOOL)
      .where(TX.time, '<', time)
      .select()
  }

  async searchTxsToDownload () {
    return this.knex(TX.NAME).whereNotNull(TX.bytes).pluck(TX.txid)
  }

  async countDownloadedTxs () {
    const result = this.knex(TX.NAME).whereNotNull(TX.bytes).count(TX.txid, { as: 'count' }).first()
    return result.count
  }

  async countIndexedTxs () {
    const result = this.knex(TX.NAME).where(TX.indexed, true).count(TX.txid, { as: 'count' }).first()
    return result.count
  }

  async getFailedTx (deptxid) {
    const result = await this.knex(TX.NAME).where(TX.txid, deptxid).first()
    return result && result.executed && !result.indexed
  }

  async addNewTx (txid, time) {
    await this.knex(TX.NAME).insert({
      txid,
      time,
      height: null,
      bytes: null,
      has_code: false,
      executable: false,
      executed: false,
      indexed: false
    })
  }

  async setTxHeight (txid, height) {
    await this.knex(TX.NAME)
      .where(TX.txid, txid)
      .where(qb => {
        qb.whereNull(TX.height).orWhere(TX.height, HEIGHT_MEMPOOL)
      })
      .update(TX.height, height)
  }

  async setTxTime (txid, time) {
    await this.knex(TX.NAME)
      .where(TX.txid, txid)
      .update(TX.time, time)
  }

  async setTxBytes (txid, bytes) {
    await this.knex(TX.NAME)
      .where(TX.txid, txid)
      .update(TX.bytes, bytes)
  }

  async setExecutableForTx (txid, executable) {
    await this.knex(TX.NAME)
      .where(TX.txid, txid)
      .update(TX.executable, executable)
  }

  async setHasCodeForTx (txid, hasCode) {
    await this.knex(TX.NAME)
      .where(TX.txid, txid)
      .update(TX.hasCode, hasCode)
  }

  async setExecutedForTx (txid, executed) {
    await this.knex(TX.NAME)
      .where(TX.txid, txid)
      .update(TX.executed, executed)
  }

  async setIndexedForTx (txid, indexed) {
    await this.knex(TX.NAME)
      .where(TX.txid, txid)
      .update(TX.indexed, indexed)
  }

  async txIsIndexed (txid) {
    const result = await this.knex(TX.NAME)
      .where(TX.txid, txid)
      .first([TX.txid])

    return result && result.indexed
  }

  async hasFailedDep (txid) {
    const result = this.knex(TX.NAME)
      .join(DEPS.NAME, `${DEPS.NAME}.${DEPS.up}`, `${TX.NAME}.${TX.txid}`)
      .join({ innerTx: TX.NAME }, `${DEPS.NAME}.${DEPS.down}`, `innerTx.${TX.txid}`)
      .where(`${TX.NAME}.${TX.txid}`, txid)
      .where(`innerTx.${TX.executed}`, true)
      .where(`innerTx.${TX.indexed}`, false)
      .count(`${TX.NAME}.${TX.txid}`, { as: 'count' })
      .first()
    return result.count > 0
  }

  async checkTxWasExecuted (txid) {
    const result = this.knex(TX.NAME).where(TX.txid, txid).first(TX.executed)
    return result && result.executed
  }

  async getTxHex (txid) {
    const result = await this.knex(TX.NAME).where(TX.txid, txid).first([TX.bytes])
    return result && result.bytes && result.bytes.toString('hex')
  }

  async getTxTime (txid) {
    const result = await this.knex(TX.NAME).where(TX.txid, txid).first([TX.time])
    return result && result.time
  }

  async getTxHeight (txid) {
    const result = await this.knex(TX.NAME).where(TX.txid, txid).first([TX.height])
    return result && result.height
  }

  async deleteTx (txid) {
    this.deleteTransactionStmt.run(txid)
  }

  async unconfirmTx (txid) {
    await this.knex(TX.NAME).where(TX.txid, txid).update(TX.height, HEIGHT_MEMPOOL)
  }

  async getTxMetadata (txid) {
    return this.knex(TX.NAME).where(TX.txid, txid).first()
  }

  // executing

  async markTxAsExecuting (txid) {
    await this.knex(EXECUTING.NAME)
      .insert({ txid })
      .onConflict(EXECUTING.txid)
      .ignore()
  }

  async removeTxFromExecuting (txid) {
    await this.knex(EXECUTING.NAME).where(EXECUTING.txid, txid).del()
  }

  async findAllExecutingTxids () {
    return this.knex(EXECUTING.NAME).pluck(EXECUTING.txid)
  }

  async txidTrustedAndReadyToExecute (txid) {
    const mainTx = 'mainTx'
    const knex = this.knex
    const row = await knex(this.knex.ref(TX.NAME).as(mainTx))
      .leftJoin(TRUST.NAME, `${TRUST.NAME}.${TRUST.txid}`, `${mainTx}.${TX.txid}`)
      .leftJoin(BAN.NAME, `${BAN.NAME}.${BAN.txid}`, `${mainTx}.${TX.txid}`)
      .whereNotNull(`${mainTx}.${TX.bytes}`)
      .where(`${mainTx}.${TX.txid}`, txid)
      .where(`${mainTx}.${TX.executable}`, true)
      .where(`${mainTx}.${TX.executed}`, false)
      .where(qb => {
        qb.where(`${mainTx}.${TX.hasCode}`, false)
          .orWhere(`${TRUST.NAME}.${TRUST.value}`, true)
      })
      .whereNull(`${BAN.NAME}.${BAN.txid}`)
      .whereNotExists(function () {
        const depTx = 'depTx'
        this.select(TX.txid).from(knex.ref(TX.NAME).as(depTx))
          .join(DEPS.NAME, DEPS.up, `${depTx}.${TX.txid}`)
          .where(DEPS.down, knex.ref(`${mainTx}.${TX.txid}`))
          .where(qb => {
            qb.whereNull(`${depTx}.${TX.bytes}`).orWhere(qb => {
              qb.where(`${depTx}.${TX.executable}`, true)
              qb.where(`${depTx}.${TX.executed}`, false)
            })
          })
      }).first(`${mainTx}.${TX.txid}`)

    return !!row
  }

  async txidIsReadyToExecute (txid) {
    const mainTx = 'mainTx'
    const knex = this.knex
    const row = await knex(this.knex.ref(TX.NAME).as(mainTx))
      .leftJoin(BAN.NAME, `${BAN.NAME}.${BAN.txid}`, `${mainTx}.${TX.txid}`)
      .whereNotNull(`${mainTx}.${TX.bytes}`)
      .where(`${mainTx}.${TX.txid}`, txid)
      .where(`${mainTx}.${TX.executable}`, true)
      .where(`${mainTx}.${TX.executed}`, false)
      .whereNull(`${BAN.NAME}`)
      .whereNotExists(function () {
        const depTx = 'depTx'
        this.select(TX.txid).from(knex.ref(TX.NAME).as(depTx))
          .join(DEPS.NAME, DEPS.up, `${depTx}.${TX.txid}`)
          .where(DEPS.down, `${mainTx}.${TX.txid}`)
          .where(qb => {
            qb.whereNull(`${depTx}.${TX.bytes}`).orWhere(qb => {
              qb.where(`${depTx}.${TX.executable}`, true)
              qb.where(`${depTx}.${TX.executed}`, false)
            })
          })
      }).first(['txid'])

    return !!row
  }

  async checkDependenciesWereExecutedOk (txid) {
    // `SELECT COUNT(*) = 0 as ok
    //     FROM tx
    //     JOIN deps ON deps.up = tx.txid
    //     WHERE deps.down = ?
    //     AND (+tx.downloaded = 0 OR (tx.executable = 1 AND tx.executed = 0))`
    const count = await this.knex(TX.NAME)
      .join(DEPS.NAME, `${DEPS.NAME}.${DEPS.up}`, `${TX.NAME}.${TX.txid}`)
      .where(DEPS.down, txid)
      .where(qb => {
        qb.whereNotNull(`${TX.NAME}.${TX.bytes}`).orWhere(qb => {
          qb.where(`${TX.NAME}.${TX.executable}`, true).andWhere(`${TX.NAME}.${TX.executed}`, false)
        })
      }).count()
    return count === 0
  }

  // spends

  async getSpendingTxid (location) {
    const row = await this.knex(SPEND.NAME).where(SPEND.location, location).first([SPEND.spendTxid])
    return row && row[SPEND.spendTxid]
  }

  async upsertSpend (location, txid) {
    await this.knex(SPEND.NAME)
      .insert({ [SPEND.location]: location, [SPEND.spendTxid]: txid })
      .onConflict(SPEND.location).merge()
  }

  async setAsUnspent (location) {
    await this.upsertSpend(location, null)
  }

  async deleteSpendsForTxid (txid) {
    this.deleteSpendsStmt.run(txid)
  }

  async unspendOutput (txid) {
    await this.knex(SPEND.NAME)
      .whereLike(SPEND.location, `${txid}_o%`)
      .del()
  }

  // deps

  async addDep (deptxid, txid) {
    await this.knex(DEPS.NAME)
      .insert({ [DEPS.up]: deptxid, [DEPS.down]: txid })
      .onConflict([DEPS.up, DEPS.down]).ignore()
  }

  async searchDownstreamTxidsReadyToExecute (txid) {
    const knex = this.knex
    const mainTx = 'mainTx'
    return knex(DEPS.NAME)
      .join(knex.ref(TX.NAME).as(mainTx), `${mainTx}.${TX.txid}`, `${DEPS.NAME}.${DEPS.down}`)
      .leftJoin(BAN.NAME, `${BAN.NAME}.${BAN.txid}`, `${mainTx}.${TX.txid}`)
      .leftJoin(TRUST.NAME, `${mainTx}.${TX.txid}`, `${TRUST.NAME}.${TRUST.txid}`)
      .whereNotNull(`${mainTx}.${TX.bytes}`)
      .where(`${DEPS.NAME}.${DEPS.up}`, txid)
      .where(`${mainTx}.${TX.executable}`, true)
      .where(`${mainTx}.${TX.executed}`, false)
      .whereNull(`${BAN.NAME}.${BAN.txid}`)
      .where(qb => {
        qb.where(`${mainTx}.${TX.hasCode}`, false).orWhere(`${TRUST.NAME}.${TRUST.value}`, true)
      })
      .whereNotExists(function () {
        const depTx = 'depTx'
        this.select(TX.txid).from(knex.ref(TX.NAME).as(depTx))
          .join(DEPS.NAME, DEPS.up, `${depTx}.${TX.txid}`)
          .where(DEPS.down, knex.ref(`${mainTx}.${TX.txid}`))
          .where(qb => {
            qb.whereNull(`${depTx}.${TX.bytes}`).orWhere(qb => {
              qb.where(`${depTx}.${TX.executable}`, true)
              qb.where(`${depTx}.${TX.executed}`, false)
            })
          })
      }).pluck(`${mainTx}.${TX.txid}`)
  }

  async searchDownstreamForTxid (txid) {
    const rows = await this.knex(DEPS.NAME).where(DEPS.up, txid).select([DEPS.down])
    return rows.map(r => r.down)
  }

  async deleteDepsForTxid (txid) {
    await this.knex(DEPS.NAME).where(DEPS.down, txid).del()
  }

  async getNonExecutedUpstreamTxIds (txid) {
    const rows = await this.knex(DEPS.NAME)
      .join(TX.NAME, TX.txid, DEPS.up)
      .where(DEPS.down, txid)
      .where(TX.executable, true)
      .where(TX.executed, false)
      .where(TX.hasCode, true)
      .select([DEPS.up])

    return rows.map(r => r.txid)
  }

  // jig

  async setJigMetadata (location) {
    await this.knex(JIG.NAME)
      .insert({ [JIG.location]: location })
      .onConflict().ignore()
  }

  async getJigState (location) {
    const row = await this.knex(JIG.NAME)
      .where(JIG.location, location)
      .first([JIG.state])
    if (row && row.state) {
      return JSON.parse(row.state)
    } else {
      return null
    }
  }

  async setJigState (location, stateObject) {
    await this.knex(JIG.NAME)
      .insert({ [JIG.location]: location, [JIG.state]: JSON.stringify(stateObject) })
      .onConflict().ignore()
  }

  async setBerryState (location, stateObject) {
    await this.knex(BERRY.NAME)
      .insert({ [BERRY.location]: location, [BERRY.state]: JSON.stringify(stateObject) })
      .onConflict().ignore()
  }

  async setBerryMetadata (location) {
    await this.knex(BERRY.NAME)
      .insert({ [BERRY.location]: location })
      .onConflict().ignore()
  }

  async getBerryState (location) {
    const row = await this.knex(BERRY.NAME)
      .where(BERRY.location, location)
      .first([BERRY.state])
    if (row && row.state) {
      return JSON.parse(row.state)
    } else {
      return null
    }
  }

  async setJigClass (location, cls) {
    await this.knex(JIG.NAME)
      .where(JIG.location, location)
      .update({ [JIG.klass]: cls })
  }

  async setJigLock (location, lock) {
    await this.knex(JIG.NAME)
      .where(JIG.location, location)
      .update({ [JIG.lock]: lock })
  }

  async setJigScriptHash (location, scriptHash) {
    await this.knex(JIG.NAME)
      .where(JIG.location, location)
      .update({ [JIG.scriptHash]: scriptHash })
  }

  async deleteJigStatesForTxid (txid) {
    await this.knex(JIG.NAME)
      .whereLike(JIG.location, `${txid}%`)
      .del()
  }

  async deleteBerryStatesForTxid (txid) {
    await this.knex(BERRY.NAME)
      .whereLike(BERRY.location, `${txid}%`)
      .del()
  }

  // unspent

  async getAllUnspent () {
    const rows = await this.knex(JIG.NAME)
      .join(SPEND.NAME, SPEND.location, JIG.location)
      .whereNull(SPEND.spendTxid)
      .select([JIG.location])
    return rows.map(row => row.location)
  }

  async getAllUnspentByClassOrigin (origin) {
    const rows = await this.knex(SPEND.NAME)
      .join(JIG.NAME, SPEND.location, JIG.location)
      .whereNull(SPEND.spendTxid)
      .where(JIG.klass, origin)
      .select([JIG.location])

    return rows.map(row => row.location)
  }

  async getAllUnspentByLockOrigin (origin) {
    const rows = await this.knex(SPEND.NAME)
      .join(JIG.NAME, SPEND.location, JIG.location)
      .whereNull(SPEND.spendTxid)
      .where(JIG.lock, origin)
      .select([JIG.location])

    return rows.map(row => row.location)
  }

  async getAllUnspentByScripthash (scripthash) {
    const rows = await this.knex(SPEND.NAME)
      .join(JIG.NAME, SPEND.location, JIG.location)
      .whereNull(SPEND.spendTxid)
      .where(JIG.scriptHash, scripthash)
      .select([JIG.location])

    return rows.map(row => row.location)
  }

  async getAllUnspentByClassOriginAndLockOrigin (clsOrigin, lockOrigin) {
    const rows = await this.knex(SPEND.NAME)
      .join(JIG.NAME, SPEND.location, JIG.location)
      .whereNull(SPEND.spendTxid)
      .where(JIG.klass, clsOrigin)
      .where(JIG.lock, lockOrigin)
      .select([JIG.location])

    return rows.map(row => row.location)
  }

  async getAllUnspentByClassOriginAndScripthash (clsOrigin, scripthash) {
    const rows = await this.knex(SPEND.NAME)
      .join(JIG.NAME, SPEND.location, JIG.location)
      .whereNull(SPEND.spendTxid)
      .where(JIG.klass, clsOrigin)
      .where(JIG.scriptHash, scripthash)
      .select([JIG.location])

    return rows.map(row => row.location)
  }

  async getAllUnspentByLockOriginAndScripthash (lockOrigin, scripthash) {
    const rows = await this.knex(SPEND.NAME)
      .join(JIG.NAME, SPEND.location, JIG.location)
      .whereNull(SPEND.spendTxid)
      .where(JIG.lock, lockOrigin)
      .where(JIG.scriptHash, scripthash)
      .select([JIG.location])

    return rows.map(row => row.location)
  }

  async getAllUnspentByClassOriginAndLockOriginAndScriptHash (clsOrigin, lockOrigin, scripthash) {
    const rows = await this.knex(SPEND.NAME)
      .join(JIG.NAME, SPEND.location, JIG.location)
      .whereNull(SPEND.spendTxid)
      .where(JIG.klass, clsOrigin)
      .where(JIG.lock, lockOrigin)
      .where(JIG.scriptHash, scripthash)
      .select([JIG.location])

    return rows.map(row => row.location)
  }

  async countTotalUnspent () {
    return this.knex(SPEND.NAME)
      .join(JIG.NAME, SPEND.location, JIG.location)
      .whereNull(SPEND.spendTxid)
      .count()
  }

  // trust
  async isTrusted (txid) {
    const row = await this.knex(TRUST.NAME)
      .where(TRUST.txid, txid)
      .first([TRUST.txid])

    return !!row
  }

  async setTrust (txid, trusted) {
    await this.knex(TRUST.NAME)
      .insert({ [TRUST.txid]: txid, [TRUST.value]: trusted })
      .onConflict(TRUST.txid).merge()
  }

  async searchAllTrust () {
    return this.knex(TRUST.NAME)
      .where(TRUST.value, true)
      .pluck(TRUST.txid)
  }

  // ban

  async checkIsBanned (txid) {
    const row = await this.knex(BAN.NAME).where(BAN.txid, txid).first([BAN.txid])
    return !!row
  }

  async saveBan (txid) {
    await this.knex(BAN.NAME)
      .insert({ [BAN.txid]: txid })
      .onConflict().merge()
  }

  async removeBan (txid) {
    await this.knex(BAN.NAME)
      .where(BAN.txid, txid)
      .del()
  }

  async searchAllBans () {
    return this.knex(BAN.NAME).pluck(BAN.txid)
  }

  // crawl

  async setCrawlHeight (heigth) {
    await this.knex(CRAWL.NAME)
      .insert({ [CRAWL.name]: CRAWL_HEIGHT, [CRAWL.value]: heigth.toString() })
      .onConflict(CRAWL.name).merge()
  }

  async setCrawlHash (hash) {
    await this.knex(CRAWL.NAME)
      .insert({ [CRAWL.name]: CRAWL_HASH, [CRAWL.value]: hash.toString() })
      .onConflict(CRAWL.name).merge()
  }

  async nullCrawlHash () {
    await this.knex(CRAWL.NAME)
      .where(CRAWL.name, CRAWL_HASH)
      .del()
  }

  async getCrawlHeight () {
    const row = await this.knex(CRAWL.NAME)
      .where(CRAWL.name, CRAWL_HEIGHT)
      .first([CRAWL.value])
    return row && parseInt(row.value)
  }

  async getCrawlHash () {
    const row = await this.knex(CRAWL.NAME)
      .where(CRAWL.name, CRAWL_HASH)
      .first([CRAWL.value])
    return row && row.value
  }
}

// ------------------------------------------------------------------------------------------------

module.exports = { KnexDatasource }
