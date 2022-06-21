/**
 * crawler.test.js
 *
 * Tests for the crawler and APIs it uses
 */

const { describe, it, beforeEach, afterEach } = require('mocha')
const { expect } = require('chai')
const { def, get } = require('bdd-lazy-var/getter')
const Indexer = require('../src/indexer')
const { DbTrustList } = require('../src/trust-list/db-trust-list')
const { Executor } = require('../src/execution/executor')
const { Crawler } = require('../src/crawler')
const { TestBlockchainApi } = require('../src/blockchain-api/test-blockchain-api')
const Run = require('run-sdk')
const { ExecutionManager } = require('../src/execution-manager')
const { MemoryQueue } = require('../src/queues/memory-queu')
const { ExecutionWorker } = require('../src/execution-worker')
const { ExecutingSet } = require('../src/executing-set')
const { buildBlobs, buildDs } = require('./test-env')

// ------------------------------------------------------------------------------------------------
// Globals
// ------------------------------------------------------------------------------------------------

const logger = { info: () => {}, warn: () => {}, error: () => {}, debug: () => {} }

// ------------------------------------------------------------------------------------------------
// Crawler
// ------------------------------------------------------------------------------------------------

describe('Crawler', () => {
  def('ds', () => buildDs())

  def('trustList', () => {
    return new DbTrustList()
  })

  def('blobs', () => buildBlobs())

  def('network', () => 'test')

  def('executor', () => {
    return new Executor(get.network, 1, get.blobs, get.ds, logger, {})
  })

  def('execSet', () => new ExecutingSet(get.ds))

  def('indexer', () => {
    return new Indexer(get.ds, get.blobs, get.trustList, get.executor, get.network, get.execSet, logger)
  })

  def('execQueue', () => new MemoryQueue())
  def('trustQueue', () => new MemoryQueue())

  def('indexManager', () => new ExecutionManager(get.blobs, get.execQueue, get.trustQueue, get.execSet))

  def('api', () => {
    return new TestBlockchainApi()
  })

  def('crawler', () => {
    return new Crawler(get.indexManager, get.api, get.ds, logger)
  })

  def('run', () => new Run({ network: 'mock', cache: new Map() }))

  def('someRunTx', async () => {
    class Counter extends Run.Jig {}
    get.run.deploy(Counter)
    await get.run.sync()
    const txid = Counter.location.split('_')[0]
    const hex = await get.run.blockchain.fetch(txid)
    return { txid, hex, buff: Buffer.from(hex, 'hex') }
  })

  def('anotherRunTx', async () => {
    class AnotherClass extends Run.Jig {}
    get.run.deploy(AnotherClass)
    await get.run.sync()
    const txid = AnotherClass.location.split('_')[0]
    const hex = await get.run.blockchain.fetch(txid)
    return { txid, hex, buff: Buffer.from(hex, 'hex') }
  })

  def('childRunTx', async () => {
    const [Counter] = get.run.inventory.code.filter(c => c.name === 'Counter')
    const instance = new Counter()
    await instance.sync()
    const txid = instance.location.split('_')[0]
    const hex = await get.run.blockchain.fetch(txid)
    return { txid, hex, buff: Buffer.from(hex, 'hex') }
  })

  def('startHeight', () => 0)

  def('execWorker', () => new ExecutionWorker(get.indexer, get.execQueue, get.trustQueue))

  beforeEach(async () => {
    await get.ds.setUp()
    await get.ds.knex.migrate.latest()
    await get.blobs.knex.migrate.latest()
    await get.executor.start()
    await get.indexManager.setUp()
    await get.execWorker.setUp()
  })

  afterEach(async () => {
    await get.execWorker.tearDown()
    await get.executor.stop()
    await get.ds.tearDown()
    await get.blobs.knex.destroy()
  })

  it('indexes a tx that arrives from the mempool', async () => {
    const { txid, buff } = await get.someRunTx
    await get.indexer.trust(txid)
    await get.crawler.start(get.startHeight)

    const promise = new Promise(resolve => get.execQueue.onEmpty(resolve))
    get.api.newMempoolTx(txid, buff)
    await get.api.waitForall()
    await promise
    const txWasIndexed = await get.ds.txIsIndexed(txid)
    expect(txWasIndexed).to.eql(true)
  })

  describe('startHeight', () => {
    def('startHeight', () => 2)
    it('does not index txs previous to start height', async () => {
      const { txid: txid1, buff: buff1 } = await get.someRunTx
      const { txid: txid2, buff: buff2 } = await get.anotherRunTx

      await get.indexer.trust(txid1)
      await get.indexer.trust(txid2)
      get.api.newMempoolTx(txid1, buff1)
      await get.api.closeBlock('blockhash1')
      get.api.newMempoolTx(txid2, buff2)
      await get.api.closeBlock('blockhash2')

      const promise = new Promise(resolve => get.execQueue.onEmpty(resolve))
      await get.crawler.start(get.startHeight)
      await promise

      const tx1WasIndexed = await get.ds.txIsIndexed(txid1)
      const tx2WasIndexed = await get.ds.txIsIndexed(txid2)
      expect(tx1WasIndexed).to.eql(false)
      expect(tx2WasIndexed).to.eql(true)
    })
  })

  describe('when indexing a block', () => {
    beforeEach(async () => {
      const { txid: txid1, buff: buff1 } = await get.someRunTx
      const { txid: txid2, buff: buff2 } = await get.childRunTx

      await get.indexer.trust(txid1)
      get.api.newMempoolTx(txid1, buff1)
      get.api.newMempoolTx(txid2, buff2)
    })

    it('indexes the transactions in the block', async () => {
      const promise = new Promise(resolve => get.execQueue.onEmpty(resolve))
      await get.crawler.start(get.startHeight)
      get.api.closeBlock('blockhash1')
      await get.api.waitForall()
      await promise
      const { txid: txid1 } = await get.someRunTx
      const { txid: txid2 } = await get.childRunTx
      const tx1WasIndexed = await get.ds.txIsIndexed(txid1)
      const tx2WasIndexed = await get.ds.txIsIndexed(txid2)
      expect(tx1WasIndexed).to.eql(true)
      expect(tx2WasIndexed).to.eql(true)
    })

    it('increases the crawl', async () => {
      const promise = new Promise(resolve => get.execQueue.onEmpty(resolve))
      await get.crawler.start(get.startHeight)
      get.api.closeBlock('blockhash1')
      await get.api.waitForall()
      await promise

      const height = await get.ds.getCrawlHeight()
      const hash = await get.ds.getCrawlHash()
      expect(height).to.eql(1)
      expect(hash).to.eql('blockhash1')
    })

    describe('when the are missing blocks between the latest known and the new block', function () {
      it('searchs for the middle blocks', async () => {
        await get.crawler.start(get.startHeight)
        get.api.closeBlock('blockhash1')
        const { txid, buff } = await get.anotherRunTx
        const old1 = get.api._onNewBlock
        const old2 = get.api._onNewMempoolTx
        await get.indexer.trust(txid)
        get.api.onNewBlock(async () => {})
        get.api.onMempoolTx(async () => {})
        get.api.closeBlock('empty1')
        get.api.newMempoolTx(txid, buff)
        await get.api.waitForall()
        get.api.closeBlock('nonempty')

        // get.api.closeBlock('empty2')
        get.api.onNewBlock(old1)
        get.api.onMempoolTx(old2)
        const promise = new Promise(resolve => get.execQueue.onEmpty(resolve))
        get.api.closeBlock('empty2')
        await get.api.waitForall()
        await promise

        const tx1WasIndexed = await get.ds.txIsIndexed(txid)
        expect(tx1WasIndexed).to.eql(true)
      })
    })
  })

  describe('#start', async () => {
    it('when its behind of the real tip it keeps up when starting', async () => {
      const tx1 = await get.someRunTx
      const tx2 = await get.anotherRunTx
      get.api.newMempoolTx(tx1.txid, tx1.buff)
      get.api.closeBlock('nonEmpty')
      get.api.closeBlock('firstEmpty')
      get.api.closeBlock('secondEmpty')
      get.api.newMempoolTx(tx2.txid, tx2.buff)
      get.api.closeBlock('tipNonEmpty')
      await get.indexer.trust(tx1.txid)
      await get.indexer.trust(tx2.txid)
      const promise = new Promise(resolve => get.execQueue.onEmpty(resolve))
      await get.crawler.start(get.startHeight)
      await promise

      const tx1WasIndexed = await get.ds.txIsIndexed(tx1.txid)
      const tx2WasIndexed = await get.ds.txIsIndexed(tx2.txid)
      expect(tx1WasIndexed).to.eql(true)
      expect(tx2WasIndexed).to.eql(true)
    })

    it('when it already knows a tip it does not look for previous blocks', async () => {
      const tx1 = await get.someRunTx
      const tx2 = await get.anotherRunTx
      get.api.newMempoolTx(tx1.txid, tx1.buff)
      get.api.closeBlock('nonEmpty')
      get.api.closeBlock('firstEmpty')
      get.api.closeBlock('secondEmpty')
      get.api.newMempoolTx(tx2.txid, tx2.buff)
      get.api.closeBlock('tipNonEmpty')

      await get.indexer.trust(tx1.txid)
      await get.indexer.trust(tx2.txid)
      await get.crawler.setTip('firstEmpty')
      const promise = new Promise(resolve => get.execQueue.onEmpty(resolve))
      await get.crawler.start(get.startHeight)
      await promise

      const tx1WasIndexed = await get.ds.txIsIndexed(tx1.txid)
      const tx2WasIndexed = await get.ds.txIsIndexed(tx2.txid)
      expect(tx1WasIndexed).to.eql(false)
      expect(tx2WasIndexed).to.eql(true)
    })
  })

  it.skip('add block with already downloaded transactions', async () => {
  })

  // --------------------------------------------------------------------------

  it.skip('reorg blocks', async () => {
  })

  // --------------------------------------------------------------------------

  it.skip('keeps the states after a reorg', async () => {
  })
})
