/**
 * indexer.test.js
 *
 * Main object that discovers, downloads, executes and stores RUN transactions
 */

const crypto = require('crypto')
const Run = require('run-sdk')
const bsv = require('bsv')
const _ = require('lodash')
const { IndexerResult } = require('./model/indexer-result')

// ------------------------------------------------------------------------------------------------
// Indexer
// ------------------------------------------------------------------------------------------------

class Indexer {
  constructor (_database, ds, blobs, trustList, executor, network, logger) {
    this.onFailToIndex = null
    this.pendingRetries = new Map()

    this.logger = logger
    this.ds = ds
    this.blobs = blobs
    this.trustList = trustList
    this.network = network

    this.executor = executor
  }

  async trust (txid) {
    const trusted = await this.trustList.trust(txid, this.ds)

    for (const txid of trusted) {
      await this.executeIfPossible(txid)
    }
    return trusted
  }

  async untrust (txid) {
    await this.trustList.untrust(txid, this.ds)
    return [txid]
  }

  async indexTxid (txid, blockHeight = null) {
    const txBuff = await this.blobs.pullTx(txid, () => null)
    if (txBuff === null) {
      await this.ds.addNewTx(txid, new Date(), null)
      await this.ds.setTransactionExecutionFailed(txid)
      // console.log(res)
      return new IndexerResult(
        false,
        [],
        [],
        [],
        await this.ds.searchDownstreamTxidsReadyToExecute(txid)
      )
    } else {
      return this.indexTransaction(txBuff, blockHeight)
    }
  }

  async indexTransaction (txBuf, blockHeight = null) {
    const txid = crypto.createHash('sha256').update(
      crypto.createHash('sha256').update(txBuf).digest()
    ).digest().reverse().toString('hex')
    const time = new Date()
    await this.ds.addNewTx(txid, time, blockHeight)

    const indexed = await this.ds.txIsIndexed(txid)
    if (indexed) {
      return new IndexerResult(true, [], [], [], await this.ds.searchDownstreamTxidsReadyToExecute(txid))
    }

    const parsed = await this.parseTx(txBuf)
    await this.storeTx(parsed)
    if (parsed.executable) {
      if (this.executor.executing.has(parsed.txid)) {
        return new IndexerResult(
          true,
          [],
          [],
          [],
          []
        )
      }
      const executed = await this.executeIfPossible(parsed.txid)
      if (executed) {
        return new IndexerResult(
          true,
          [],
          [],
          [],
          await this.ds.searchDownstreamTxidsReadyToExecute(txid)
        )
      }
    }
    const missingDeps = await this.ds.nonExecutedDepsFor(parsed.txid)
    const unknownDeps = await this.ds.getUnknownUpstreamTxIds(parsed.txid)
    return new IndexerResult(
      false,
      missingDeps,
      unknownDeps,
      await this.trustList.missingTrustFor(txid, this.ds, parsed.hasCode),
      []
    )
  }

  async executeIfPossible (txid) {
    const canExecuteNow = await this.trustList.checkExecutability(txid, this.ds)
    if (canExecuteNow) {
      const trustList = await this.trustList.executionTrustList(this.ds)
      const result = await this.executor.execute(txid, trustList)
      if (result.success) {
        await this._onIndexed(txid, result.result)
      } else if (result.missingDeps.length > 0) {
        await this._onMissingDeps(txid, result.missingDeps)
        return false
      } else {
        await this._onExecuteFailed(txid, result.error, false)
        return false
      }
    }
    return canExecuteNow
  }

  async storeTx (parsedTx) {
    await this.ds.performOnTransaction(async (ds) => {
      const bytes = parsedTx.txBuf

      await this.blobs.pushTx(parsedTx.txid, bytes)
      await ds.setExecutableForTx(parsedTx.txid, parsedTx.executable)

      for (const location of parsedTx.inputs) {
        await ds.upsertSpend(location, parsedTx.txid)
      }
      for (const location of parsedTx.outputs) {
        await ds.setAsUnspent(location)
      }

      if (parsedTx.executable) {
        await ds.setHasCodeForTx(parsedTx.txid, parsedTx.hasCode)

        for (const depTxid of parsedTx.deps) {
          await ds.addDep(depTxid, parsedTx.txid)

          const failed = await ds.getFailedTx(depTxid)
          if (failed) {
            await ds.setTransactionExecutionFailed(parsedTx.txid, ds)
            return
          }
        }
      } else {
        await ds.setIndexedForTx(parsedTx.txid, true)
      }
    })
  }

  async parseTx (txBuf) {
    const hex = txBuf.toString('hex')
    let metadata = null
    let bsvtx = null

    if (!hex) { throw new Error('No hex') }

    bsvtx = new bsv.Transaction(hex)
    const txid = bsvtx.hash

    const inputs = bsvtx.inputs.map(input => {
      return `${input.prevTxId.toString('hex')}_o${input.outputIndex}`
    })

    const outputs = _.zip(bsvtx.outputs, _.range(bsvtx.outputs.length))
      .filter(([output, _index]) => !output.script.isDataOut() && !output.script.isSafeDataOut())
      .map(([_output, index]) => `${txid}_o${index}`)

    let executable
    try {
      metadata = Run.util.metadata(hex)
      executable = true
    } catch (e) {
      // this.logger.error(`${txid} => ${e.message}`)
      // await this.storeParsedNonExecutableTransaction(txid, hex, inputs, outputs)
      // return
      return {
        txid,
        hex,
        deps: [],
        inputs: [],
        outputs: [],
        hasCode: false,
        executable: false,
        txBuf
      }
    }

    const deps = Run.util.deps(hex)

    const hasCode = metadata.exec.some(cmd => cmd.op === 'DEPLOY' || cmd.op === 'UPGRADE')

    return {
      txid,
      hex,
      deps,
      inputs,
      outputs,
      hasCode,
      executable,
      txBuf
    }
  }

  async start () {
    this.logger.debug('Starting indexer')
    const txids = await this.ds.findAllExecutingTxids()
    for (const txid of txids) {
      await this.executeIfPossible(txid)
    }
  }

  async stop () {
    for (const entry of this.pendingRetries.entries()) {
      clearTimeout(entry[1])
    }
  }

  async _onIndexed (txid, result) {
    this.pendingRetries.delete(txid)
    if (!await this.ds.txExists(txid)) return // Check not re-orged
    this.logger.info(`Executed ${txid}`)

    const { cache, classes, locks, scripthashes } = result

    await this.ds.performOnTransaction(async (ds) => {
      await ds.setExecutedForTx(txid, 1)
      await ds.setIndexedForTx(txid, 1)
      await ds.removeTxFromExecuting(txid)

      for (const key of Object.keys(cache)) {
        if (key.startsWith('jig://')) {
          const location = key.slice('jig://'.length)
          await this.blobs.pushJigState(location, cache[key])
          const klass = classes.find(([loc]) => loc === location)
          const lock = locks.find(([loc]) => loc === location)
          const scriptHash = scripthashes.find(([loc]) => loc === location)
          await ds.setJigMetadata(
            location,
            klass && klass[1],
            lock && lock[1],
            scriptHash && scriptHash[1]
          )
        } else if (key.startsWith('berry://')) {
          const location = key.slice('berry://'.length)
          await this.blobs.pushJigState(location, cache[key])
        }
      }
    })
  }

  async _onExecuteFailed (txid, e, shouldRetry = false) {
    if (shouldRetry) {
      const timeout = setTimeout(() => { this._onReadyToExecute(txid) }, 10000)
      this.pendingRetries.set(txid, timeout)
    } else {
      this.pendingRetries.delete(txid)
      this.logger.error(`Failed to execute ${txid}: ${e.toString()}`)
      await this._setTransactionExecutionFailed(txid)
    }
    if (this.onFailToIndex) this.onFailToIndex(txid, e)
  }

  async _onReadyToExecute (txid) {
    await this.executor.execute(txid)
      .catch((e) =>
        console.warn(`error executing tx ${txid}: ${e.message}`)
      )
  }

  async _setTransactionExecutionFailed (txid, ds = null) {
    ds = ds || this.ds
    await ds.setExecutableForTx(txid, 0)
    await ds.setExecutedForTx(txid, 1)
    await ds.setIndexedForTx(txid, 0)
    await ds.removeTxFromExecuting(txid)

    // We try executing downstream transactions if this was marked executable but it wasn't.
    // This allows an admin to manually change executable status in the database.

    // let executable = false
    // try {
    //   const rawTx = await this.getTransactionHex(txid)
    //   Run.util.metadata(rawTx)
    //   executable = true
    // } catch (e) { }

    // if (!executable) {
    const downstream = await ds.searchDownstreamForTxid(txid)
    for (const downtxid of downstream) {
      await this._setTransactionExecutionFailed(downtxid, ds)
    }
  }

  async _onMissingDeps (txid, deptxids) {
    this.logger.debug(`Discovered ${deptxids.length} dep(s) for ${txid}`)

    await this.ds.performOnTransaction(async (ds) => {
      for (const deptxid of deptxids) {
        await ds.addDep(deptxid, txid)
      }
    })
  }
}

// ------------------------------------------------------------------------------------------------

module.exports = Indexer
