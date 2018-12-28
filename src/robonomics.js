import Promise from 'bluebird'
import _has from 'lodash/has'
import XRT from './contract/xrt'
import Factory from './contract/factory'
import Lighthouse from './contract/lighthouse'
import ENS from './contract/ens'
import Channel from './channel'
import Message from './message'
import * as signers from './message/signer'

let instance = null
export const getInstance = () => {
  return instance
}

export default class Robonomics {
  constructor(options) {
    this.channel = null
    this.xrt = null
    this.factory = null
    this.lighthouse = null
    this.init = []

    if (options.web3) {
      this.web3 = options.web3
    } else if (typeof window !== 'undefined' && window.web3) {
      this.web3 = window.web3
    } else {
      throw new Error('Required web3')
    }

    this.isPrivateKey = false
    this.privateKey = null
    if (options.account) {
      this.account = options.account
    } else if (options.privateKey) {
      this.isPrivateKey = true
      this.privateKey = options.privateKey
      this.account = signers.getAddressPrivateKey(this.privateKey)
    } else if (this.web3.eth.coinbase) {
      this.account = this.web3.eth.coinbase
    } else {
      throw new Error('Required account')
    }
    this.account = this.web3.toChecksumAddress(this.account)

    if (options.provider) {
      this.provider = options.provider
      this.init.push(this.provider.ready())
    } else {
      throw new Error('Required provider')
    }

    let signPrefix = true
    if (_has(options, 'signPrefix')) {
      signPrefix = Boolean(options.signPrefix)
    } else if (_has(this.web3.currentProvider, 'isMetaMask') && this.web3.currentProvider.isMetaMask) {
      signPrefix = false
    }
    if (options.signer) {
      this.signer = options.signer()
    } else if (this.isPrivateKey === false) {
      this.signer = signers.account(this.web3, this.account, signPrefix)
    } else {
      this.signer = signers.privateKey(this.privateKey, signPrefix)
    }
    this.message = new Message(this.signer)

    this.version = 4
    if (_has(options, 'version')) {
      this.version = options.version
    }
    let ens = '0x314159265dD8dbb310642f98f50C066173C1259b'
    if (options.ens) {
      ens = options.ens
    }
    let ensSuffix = 'eth'
    if (options.ensSuffix) {
      ensSuffix = options.ensSuffix
    }
    this.ens = new ENS(this.web3, ens, this.version, ensSuffix)

    this.eventTimeout = 10000
    if (options.eventTimeout) {
      this.eventTimeout = options.eventTimeout
    }

    this.init.push(
      this.ens.ready()
        .then(() => {
          return Promise.join(this.ens.addr('xrt'), this.ens.addr('factory'),
            (xrt, factory) => {
              this.xrt = new XRT(this.web3, xrt)
              this.factory = new Factory(this.web3, factory)
              if (options.lighthouse) {
                return this.setLighthouse(options.lighthouse)
              }
              return this.setLighthouse('airalab')
            })
        })
    )
    instance = this
  }

  ready() {
    return Promise.all(this.init)
  }

  async setLighthouse(lighthouse) {
    let address = await this.ens.addrLighthouse(lighthouse)
    address = this.web3.toChecksumAddress(address)
    this.lighthouse = new Lighthouse(this.web3, address, lighthouse)
    this.channel = new Channel(this.ens.getUrl(lighthouse, 'lighthouse'), this.provider)
  }

  getLighthouses(options = { fromBlock: 0, toBlock: 'latest' }) {
    return new Promise((resolve, reject) => {
      this.factory.contract.NewLighthouse({}, options).get((error, result) => {
        if (!error) {
          const lighthouses = []
          result.forEach((item) => {
            lighthouses.push({
              name: this.ens.getUrl(item.args.name, 'lighthouse'),
              addr: item.args.lighthouse,
            })
          })
          resolve(lighthouses)
        } else {
          reject(error)
        }
      })
    })
  }

  getMarkets() {
    return Promise.resolve([])
  }

  getModel(market) {
    return this.ens.addrModel(market)
      .then((model) => {
        if (model === '0x0000000000000000000000000000000000000000' && market.length === 46 && market.substring(0, 2) === 'Qm') {
          return market
        } else if (model === '0x0000000000000000000000000000000000000000') {
          throw new Error('not found model')
        }
        return model
      })
  }

  getDemand(market, cb) {
    if (this.channel === null) {
      throw new Error('Required lighthouse')
    }
    if (market === null) {
      this.channel.demands((msg) => {
        cb(msg)
      })
    } else {
      this.getModel(market)
        .then((model) => {
          this.channel.demands((msg) => {
            if (msg.model === model) {
              cb(msg)
            }
          })
        })
    }
  }

  getOffer(market, cb) {
    if (this.channel === null) {
      throw new Error('Required lighthouse')
    }
    if (market === null) {
      this.channel.offers((msg) => {
        cb(msg)
      })
    } else {
      this.getModel(market)
        .then((model) => {
          this.channel.offers((msg) => {
            if (msg.model === model) {
              cb(msg)
            }
          })
        })
    }
  }

  getResult(cb) {
    if (this.channel === null) {
      throw new Error('Required lighthouse')
    }
    this.channel.result((msg) => {
      cb(msg)
    })
  }

  watchLiability(market, cb) {
    return this.factory.watchLiability((liability) => {
      liability.lighthouse()
        .then((r) => {
          if (r === this.lighthouse.address) {
            if (market) {
              Promise.join(this.getModel(market), liability.model(),
                (marketAddr, liabilityMarketAddr) => {
                  if (marketAddr === liabilityMarketAddr) {
                    cb(liability)
                  }
                })
            } else {
              cb(liability)
            }
          }
        })
    })
  }

  post(type, market, data) {
    if (this.channel === null) {
      throw new Error('Required lighthouse')
    }
    let msg
    return this.getModel(market)
      .then((model) => {
        msg = this.message.create(type, { lighthouse: this.lighthouse.address, model, ...data })
        return msg.sign()
      })
      .then(() => this.channel.push(msg))
      .then(() => msg)
  }

  postOffer(market, data) {
    return this.post('offer', market, data)
      .then((msg) => {
        return new Promise((resolve, reject) => {
          const watcher = this.watchLiability(null, (liability) => {
            liability.equalOffer({ ...msg, account: this.account })
              .then((r) => {
                if (r) {
                  this.factory.stop(watcher)
                  resolve(liability)
                }
              })
              .catch((e) => {
                reject(e)
              })
          })
        })
      })
  }

  postDemand(market, data) {
    return this.post('demand', market, data)
      .then((msg) => {
        return new Promise((resolve, reject) => {
          const watcher = this.watchLiability(null, (liability) => {
            liability.equalDemand({ ...msg, account: this.account })
              .then((r) => {
                if (r) {
                  this.factory.stop(watcher)
                  resolve(liability)
                }
              })
              .catch((e) => {
                reject(e)
              })
          })
        })
      })
  }

  postResult(data) {
    if (this.channel === null) {
      throw new Error('Required lighthouse')
    }
    const msg = this.message.create('result', { ...data })
    return msg.sign()
      .then(() => this.channel.push(msg))
  }
}
