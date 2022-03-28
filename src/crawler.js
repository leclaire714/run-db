/**
 * crawler.test.js
 *
 * Generic blockchain crawler that adds and removes transactions to the db
 */

// ------------------------------------------------------------------------------------------------
// Crawler
// ------------------------------------------------------------------------------------------------

class Crawler {
  constructor (indexer, api, ds, logger) {
    this.indexer = indexer
    this.api = api
    this.logger = logger
    this.ds = ds
    // this.height = null
    // this.hash = null
    // this.pollForNewBlocksInterval = 10000
    // this.pollForNewBlocksTimerId = null
    // this.expireMempoolTransactionsInterval = 60000
    // this.expireMempoolTransactionsTimerId = null
    // this.rewindCount = 10
    // this.started = false
    // this.listeningForMempool = false
    //
    // this.onCrawlError = null
    // this.onCrawlBlockTransactions = null
    // this.onRewindBlocks = null
    // this.onMempoolTransaction = null
    // this.onExpireMempoolTransactions = null
  }

  async start (_height, _hash) {
    const realTip = await this.api.getTip()
    let knownHeight = await this.ds.getCrawlHeight()

    while (knownHeight < realTip.height) {
      knownHeight++
      const { height, hash } = await this.api.getBlockDataByHeight(knownHeight)
      await this._receiveBlock(height, hash)
    }

    await this.api.onMempoolTx(this._receiveTransaction.bind(this))
    await this.api.onNewBlock(this._receiveBlock.bind(this))
    // this.logger.debug('Starting crawler')
    //
    // if (this.started) return
    //
    // this.started = true
    // this.height = height
    // this.hash = hash
    //
    // this._pollForNewBlocks().catch(console.error)
    // this._expireMempoolTransactions().catch(console.error)
  }

  async _receiveTransaction (rawTx, blockHeight = null) {
    await this.indexer.indexTransaction(rawTx, blockHeight)
  }

  async _receiveBlock (blockHeight, blockHash) {
    await this.api.iterateBlock(blockHash, async (rawTx) => {
      await this._receiveTransaction(rawTx, blockHeight)
    })
    await this.ds.setCrawlHash(blockHash)
    await this.ds.setCrawlHeight(blockHeight)
  }

  async setTip (blockHash) {
    const { height, hash } = await this.api.getBlockData(blockHash)
    this.ds.setCrawlHash(hash)
    this.ds.setCrawlHeight(height)
  }

  stop () {
    // this.started = false
    // this.listeningForMempool = false
    // clearTimeout(this.pollForNewBlocksTimerId)
    // this.pollForNewBlocksTimerId = null
    // clearTimeout(this.expireMempoolTransactionsTimerId)
    // this.expireMempoolTransactionsTimerId = null
  }

  async _expireMempoolTransactions () {
    // if (!this.started) return
    //
    // this.logger.debug('Expiring mempool transactions')
    //
    // if (this.onExpireMempoolTransactions) { await this.onExpireMempoolTransactions() }
    //
    // this.expireMempoolTransactionsTimerId = setTimeout(
    //   this._expireMempoolTransactions.bind(this), this.expireMempoolTransactionsInterval)
  }

  async _pollForNewBlocks () {
    // if (!this.started) return
    //
    // try {
    //   await this._pollForNextBlock()
    // } catch (e) {
    //   if (this.onCrawlError) { await this.onCrawlError(e) }
    //   // Swallow, we'll retry
    // }
    //
    // if (!this.started) return
    //
    // this.pollForNewBlocksTimerId = setTimeout(this._pollForNewBlocks.bind(this), this.pollForNewBlocksInterval)
  }

  async _pollForNextBlock () {
    // if (!this.started) return
    //
    // this.logger.debug('Polling for next block')
    //
    // // Save the current query so we can check for a race condition after
    // const currHeight = this.height
    // const currHash = this.hash
    //
    // const block = this.api.getNextBlock && await this.api.getNextBlock(currHeight, currHash)
    //
    // // Case: shutting down
    // if (!this.started) return
    //
    // // Case: race condition, block already updated by another poller
    // if (this.height !== currHeight) return
    //
    // // Case: reorg
    // if (block && block.reorg) {
    //   this.logger.debug('Reorg detected')
    //   await this._rewindAfterReorg()
    //   setTimeout(() => this._pollForNextBlock(), 0)
    //   return
    // }
    //
    // // Case: at the chain tip
    // if (!block || block.height <= this.height) {
    //   this.logger.debug('No new blocks')
    //   await this._listenForMempool()
    //   return
    // }
    //
    // // Case: received a block
    // if (block) {
    //   this.logger.debug('Received new block at height', block.height)
    //   if (this.onCrawlBlockTransactions) {
    //     await this.onCrawlBlockTransactions(block.height, block.hash, block.time, block.txids, block.txhexs)
    //   }
    //   this.height = block.height
    //   this.hash = block.hash
    //   setTimeout(() => this._pollForNextBlock(), 0)
    // }
  }

  async _rewindAfterReorg () {
    // const newHeight = this.height - this.rewindCount
    // if (this.onRewindBlocks) { await this.onRewindBlocks(newHeight) }
    // this.height = newHeight
    // this.hash = null
  }

  async _listenForMempool () {
    // if (this.listeningForMempool) return
    //
    // if (this.api.listenForMempool) {
    //   await this.api.listenForMempool(this._onMempoolRunTransaction.bind(this))
    // }
    //
    // this.listeningForMempool = true
  }

  async _onMempoolRunTransaction (txid, rawtx) {
    // if (this.onMempoolTransaction) await this.onMempoolTransaction(txid, rawtx)
  }
}

// ------------------------------------------------------------------------------------------------

module.exports = Crawler
