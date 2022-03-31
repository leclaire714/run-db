const { EventQueue } = require('./exec-queue')
const _ = require('lodash')

class MemoryQueue extends EventQueue {
  constructor () {
    super()
    this.pending = []
    this.subscriptions = []
    this.current = Promise.resolve()
    this._onEmpty = () => {}
  }

  async publish (event) {
    this.pending.push(event)
    this.current.then(() => {
      return Promise.all(this.subscriptions.map(async s => s(event)))
    }).then(() => {
      _.remove(this.pending, e => e === event)
      if (this.pending.length === 0) {
        this._onEmpty()
      }
    })
  }

  async subscribe (fn) {
    this.subscriptions.push(fn)
  }

  // non interface

  async onEmpty (fn) {
    this._onEmpty = fn
  }
}

module.exports = { MemoryQueue }
