import { expect } from '../../../setup'

/* External Imports */
import { ethers } from 'hardhat'
import { Signer, ContractFactory, Contract } from 'ethers'
import { smockit, MockContract } from '@eth-optimism/smock'
import {
  AppendSequencerBatchParams,
  encodeAppendSequencerBatch,
} from '@eth-optimism/core-utils'
import { TransactionResponse } from '@ethersproject/abstract-provider'
import { keccak256 } from 'ethers/lib/utils'
import _ from 'lodash'

/* Internal Imports */
import {
  makeAddressManager,
  setProxyTarget,
  L2_GAS_DISCOUNT_DIVISOR,
  ENQUEUE_GAS_COST,
  setEthTime,
  NON_ZERO_ADDRESS,
  getEthTime,
  getNextBlockNumber,
} from '../../../helpers'
import { names } from '../../../../src/address-names'

const ELEMENT_TEST_SIZES = [1, 2, 4, 8, 16]
const MAX_GAS_LIMIT = 8_000_000

const getTransactionHash = (
  sender: string,
  target: string,
  gasLimit: number,
  data: string
): string => {
  return keccak256(encodeQueueTransaction(sender, target, gasLimit, data))
}

const encodeQueueTransaction = (
  sender: string,
  target: string,
  gasLimit: number,
  data: string
): string => {
  return ethers.utils.defaultAbiCoder.encode(
    ['address', 'address', 'uint256', 'bytes'],
    [sender, target, gasLimit, data]
  )
}

const appendSequencerBatch = async (
  CanonicalTransactionChain: Contract,
  batch: AppendSequencerBatchParams
): Promise<TransactionResponse> => {
  const methodId = keccak256(Buffer.from('appendSequencerBatch()')).slice(2, 10)
  const calldata = encodeAppendSequencerBatch(batch)
  return CanonicalTransactionChain.signer.sendTransaction({
    to: CanonicalTransactionChain.address,
    data: '0x' + methodId + calldata,
  })
}

describe('CanonicalTransactionChain', () => {
  let addressManagerOwner: Signer
  let sequencer: Signer
  let otherSigner: Signer
  before(async () => {
    ;[addressManagerOwner, sequencer, otherSigner] = await ethers.getSigners()
  })

  let AddressManager: Contract
  let Mock__StateCommitmentChain: MockContract
  before(async () => {
    AddressManager = await makeAddressManager()
    await AddressManager.setAddress(
      'OVM_Sequencer',
      await sequencer.getAddress()
    )

    Mock__StateCommitmentChain = await smockit(
      await ethers.getContractFactory('StateCommitmentChain')
    )

    await setProxyTarget(
      AddressManager,
      'StateCommitmentChain',
      Mock__StateCommitmentChain
    )
  })

  let Factory__CanonicalTransactionChain: ContractFactory
  let Factory__ChainStorageContainer: ContractFactory
  before(async () => {
    Factory__CanonicalTransactionChain = await ethers.getContractFactory(
      'CanonicalTransactionChain'
    )

    Factory__ChainStorageContainer = await ethers.getContractFactory(
      'ChainStorageContainer'
    )
  })

  let CanonicalTransactionChain: Contract
  beforeEach(async () => {
    CanonicalTransactionChain = await Factory__CanonicalTransactionChain.deploy(
      AddressManager.address,
      MAX_GAS_LIMIT,
      L2_GAS_DISCOUNT_DIVISOR,
      ENQUEUE_GAS_COST
    )

    const batches = await Factory__ChainStorageContainer.deploy(
      AddressManager.address,
      'CanonicalTransactionChain'
    )

    await AddressManager.setAddress(
      'ChainStorageContainer-CTC-batches',
      batches.address
    )

    await AddressManager.setAddress(
      names.managed.contracts.CanonicalTransactionChain,
      CanonicalTransactionChain.address
    )
  })

  describe('Gas param setters', () => {
    describe('setGasParams', async () => {
      it('should revert when not called by the Burn Admin', async () => {
        await expect(
          CanonicalTransactionChain.connect(otherSigner).setGasParams(60000, 32)
        ).to.be.revertedWith('Only callable by the Burn Admin.')
      })

      it('should update the enqueueGasCost and enqueueL2GasPrepaid correctly', async () => {
        const newEnqueueGasCost = 31113
        const newGasDivisor = 19
        await CanonicalTransactionChain.connect(
          addressManagerOwner
        ).setGasParams(newGasDivisor, newEnqueueGasCost)

        await CanonicalTransactionChain.l2GasDiscountDivisor()
        const enqueueL2GasPrepaid =
          await CanonicalTransactionChain.enqueueL2GasPrepaid()
        expect(enqueueL2GasPrepaid).to.equal(newGasDivisor * newEnqueueGasCost)
      })

      it('should emit an L2GasParamsUpdated event', async () => {
        await expect(
          CanonicalTransactionChain.connect(addressManagerOwner).setGasParams(
            88,
            31514
          )
        ).to.emit(CanonicalTransactionChain, 'L2GasParamsUpdated')
      })
    })
  })

  describe('enqueue', () => {
    const target = NON_ZERO_ADDRESS
    const gasLimit = 500_000

    it('should revert when trying to input more data than the max data size', async () => {
      const MAX_ROLLUP_TX_SIZE =
        await CanonicalTransactionChain.MAX_ROLLUP_TX_SIZE()
      const data = '0x' + '12'.repeat(MAX_ROLLUP_TX_SIZE + 1)

      await expect(
        CanonicalTransactionChain.enqueue(target, gasLimit, data, {
          gasLimit: 40000000,
        })
      ).to.be.revertedWith(
        'Transaction data size exceeds maximum for rollup transaction.'
      )
    })

    it('should revert when trying to enqueue a transaction with a higher gasLimit than the max', async () => {
      const data = '0x1234567890'

      await expect(
        CanonicalTransactionChain.enqueue(target, MAX_GAS_LIMIT + 1, data)
      ).to.be.revertedWith(
        'Transaction gas limit exceeds maximum for rollup transaction.'
      )
    })

    it('should revert if gas limit parameter is not at least MIN_ROLLUP_TX_GAS', async () => {
      const MIN_ROLLUP_TX_GAS =
        await CanonicalTransactionChain.MIN_ROLLUP_TX_GAS()
      const customGasLimit = MIN_ROLLUP_TX_GAS / 2
      const data = '0x' + '12'.repeat(1234)

      await expect(
        CanonicalTransactionChain.enqueue(target, customGasLimit, data)
      ).to.be.revertedWith('Transaction gas limit too low to enqueue.')
    })

    it('should revert if transaction gas limit does not cover rollup burn', async () => {
      const _enqueueL2GasPrepaid =
        await CanonicalTransactionChain.enqueueL2GasPrepaid()
      const l2GasDiscountDivisor =
        await CanonicalTransactionChain.l2GasDiscountDivisor()
      const data = '0x' + '12'.repeat(1234)

      // Create a tx with high L2 gas limit, but insufficient L1 gas limit to cover burn.
      const l2GasLimit = 2 * _enqueueL2GasPrepaid
      // This l1GasLimit is equivalent to the gasToConsume amount calculated in the CTC. After
      // additional gas overhead, it will be enough trigger the gas burn, but not enough to cover
      // it.
      const l1GasLimit =
        (l2GasLimit - _enqueueL2GasPrepaid) / l2GasDiscountDivisor

      await expect(
        CanonicalTransactionChain.enqueue(target, l2GasLimit, data, {
          gasLimit: l1GasLimit,
        })
      ).to.be.revertedWith('Insufficient gas for L2 rate limiting burn.')
    })

    describe('with valid input parameters', () => {
      it('should emit a TransactionEnqueued event', async () => {
        const timestamp = (await getEthTime(ethers.provider)) + 100
        const data = '0x' + '12'.repeat(1234)

        await setEthTime(ethers.provider, timestamp)

        await expect(
          CanonicalTransactionChain.enqueue(target, gasLimit, data)
        ).to.emit(CanonicalTransactionChain, 'TransactionEnqueued')
      })

      describe('when enqueing multiple times', () => {
        const data = '0x' + '12'.repeat(1234)

        for (const size of ELEMENT_TEST_SIZES) {
          it(`should be able to enqueue ${size} elements`, async () => {
            for (let i = 0; i < size; i++) {
              await expect(
                CanonicalTransactionChain.enqueue(target, gasLimit, data)
              ).to.not.be.reverted
            }
          })
        }
      })
    })

    describe('with _gaslimit below the enqueueL2GasPrepaid threshold', async () => {
      it('the cost to enqueue transactions is consistent for different L2 gas amounts below the prepaid threshold', async () => {
        const enqueueL2GasPrepaid =
          await CanonicalTransactionChain.enqueueL2GasPrepaid()
        const data = '0x' + '12'.repeat(1234)
        const l2GasLimit1 = enqueueL2GasPrepaid - 1
        const l2GasLimit2 = enqueueL2GasPrepaid - 100

        // The first enqueue is more expensive because it's writing to an empty slot,
        // so we need to pre-load the buffer or the test will fail.
        await CanonicalTransactionChain.enqueue(
          NON_ZERO_ADDRESS,
          l2GasLimit1,
          data
        )

        const res1 = await CanonicalTransactionChain.enqueue(
          NON_ZERO_ADDRESS,
          l2GasLimit1,
          data
        )
        const receipt1 = await res1.wait()

        const res2 = await CanonicalTransactionChain.enqueue(
          NON_ZERO_ADDRESS,
          l2GasLimit2,
          data
        )
        const receipt2 = await res2.wait()
        expect(receipt1.gasUsed).to.equal(receipt2.gasUsed)
      })
    })
  })

  describe('getQueueElement', () => {
    it('should revert when accessing a non-existent element', async () => {
      await expect(
        CanonicalTransactionChain.getQueueElement(0)
      ).to.be.revertedWith(
        'reverted with panic code 0x32 (Array accessed at an out-of-bounds or negative index)'
      )
    })

    describe('when the requested element exists', () => {
      const target = NON_ZERO_ADDRESS
      const gasLimit = 500_000
      const data = '0x' + '12'.repeat(1234)

      describe('when getting the first element', () => {
        for (const size of ELEMENT_TEST_SIZES) {
          it(`gets the element when ${size} + 1 elements exist`, async () => {
            const timestamp = (await getEthTime(ethers.provider)) + 100
            const blockNumber = await getNextBlockNumber(ethers.provider)
            await setEthTime(ethers.provider, timestamp)

            const transactionHash = getTransactionHash(
              await addressManagerOwner.getAddress(),
              target,
              gasLimit,
              data
            )

            await CanonicalTransactionChain.enqueue(target, gasLimit, data)

            for (let i = 0; i < size; i++) {
              await CanonicalTransactionChain.enqueue(
                target,
                gasLimit,
                '0x' + '12'.repeat(i + 1)
              )
            }

            expect(
              _.toPlainObject(
                await CanonicalTransactionChain.getQueueElement(0)
              )
            ).to.deep.include({
              transactionHash,
              timestamp,
              blockNumber,
            })
          })
        }
      })

      describe('when getting the middle element', () => {
        for (const size of ELEMENT_TEST_SIZES) {
          it(`gets the element when ${size} elements exist`, async () => {
            let timestamp: number
            let blockNumber: number
            let transactionHash: string

            const middleIndex = Math.floor(size / 2)
            for (let i = 0; i < size; i++) {
              if (i === middleIndex) {
                timestamp = (await getEthTime(ethers.provider)) + 100
                blockNumber = await getNextBlockNumber(ethers.provider)
                await setEthTime(ethers.provider, timestamp)

                transactionHash = getTransactionHash(
                  await addressManagerOwner.getAddress(),
                  target,
                  gasLimit,
                  data
                )

                await CanonicalTransactionChain.enqueue(target, gasLimit, data)
              } else {
                await CanonicalTransactionChain.enqueue(
                  target,
                  gasLimit,
                  '0x' + '12'.repeat(i + 1)
                )
              }
            }

            expect(
              _.toPlainObject(
                await CanonicalTransactionChain.getQueueElement(middleIndex)
              )
            ).to.deep.include({
              transactionHash,
              timestamp,
              blockNumber,
            })
          })
        }
      })

      describe('when getting the last element', () => {
        for (const size of ELEMENT_TEST_SIZES) {
          it(`gets the element when ${size} elements exist`, async () => {
            let timestamp: number
            let blockNumber: number
            let transactionHash: string

            for (let i = 0; i < size; i++) {
              if (i === size - 1) {
                timestamp = (await getEthTime(ethers.provider)) + 100
                blockNumber = await getNextBlockNumber(ethers.provider)
                await setEthTime(ethers.provider, timestamp)

                transactionHash = getTransactionHash(
                  await addressManagerOwner.getAddress(),
                  target,
                  gasLimit,
                  data
                )

                await CanonicalTransactionChain.enqueue(target, gasLimit, data)
              } else {
                await CanonicalTransactionChain.enqueue(
                  target,
                  gasLimit,
                  '0x' + '12'.repeat(i + 1)
                )
              }
            }

            expect(
              _.toPlainObject(
                await CanonicalTransactionChain.getQueueElement(size - 1)
              )
            ).to.deep.include({
              transactionHash,
              timestamp,
              blockNumber,
            })
          })
        }
      })
    })
  })

  describe('appendSequencerBatch', () => {
    beforeEach(() => {
      CanonicalTransactionChain = CanonicalTransactionChain.connect(sequencer)
    })

    it('should revert if expected start does not match current total batches', async () => {
      await expect(
        appendSequencerBatch(CanonicalTransactionChain, {
          transactions: ['0x1234'],
          contexts: [
            {
              numSequencedTransactions: 0,
              numSubsequentQueueTransactions: 0,
              timestamp: 0,
              blockNumber: 0,
            },
          ],
          shouldStartAtElement: 1234,
          totalElementsToAppend: 1,
        })
      ).to.be.revertedWith(
        'Actual batch start index does not match expected start index.'
      )
    })

    it('should revert if attempting to append more elements than are available in the queue.', async () => {
      await expect(
        appendSequencerBatch(CanonicalTransactionChain, {
          transactions: ['0x1234'],
          contexts: [
            {
              numSequencedTransactions: 1,
              numSubsequentQueueTransactions: 1,
              timestamp: 0,
              blockNumber: 0,
            },
          ],
          shouldStartAtElement: 0,
          totalElementsToAppend: 2,
        })
      ).to.be.revertedWith(
        'Attempted to append more elements than are available in the queue.'
      )
    })

    it('should revert if not called by the sequencer', async () => {
      await expect(
        appendSequencerBatch(
          CanonicalTransactionChain.connect(addressManagerOwner),
          {
            transactions: ['0x1234'],
            contexts: [
              {
                numSequencedTransactions: 0,
                numSubsequentQueueTransactions: 0,
                timestamp: 0,
                blockNumber: 0,
              },
            ],
            shouldStartAtElement: 0,
            totalElementsToAppend: 1,
          }
        )
      ).to.be.revertedWith('Function can only be called by the Sequencer.')
    })

    it('should emit the previous blockhash in the TransactionBatchAppended event', async () => {
      const timestamp = await getEthTime(ethers.provider)
      const currentBlockHash = await (
        await ethers.provider.getBlock('latest')
      ).hash
      const blockNumber = await getNextBlockNumber(ethers.provider)
      const res = await appendSequencerBatch(CanonicalTransactionChain, {
        transactions: ['0x1234'],
        contexts: [
          {
            numSequencedTransactions: 1,
            numSubsequentQueueTransactions: 0,
            timestamp,
            blockNumber,
          },
        ],
        shouldStartAtElement: 0,
        totalElementsToAppend: 1,
      })
      const receipt = await res.wait()

      // Because the res value is returned by a sendTransaction type, we need to manually
      // decode the logs.
      const eventArgs = ethers.utils.defaultAbiCoder.decode(
        ['uint256', 'bytes32', 'uint256', 'uint256', 'bytes'],
        receipt.logs[0].data
      )

      await expect(eventArgs[0]).to.eq(currentBlockHash)
    })

    for (const size of ELEMENT_TEST_SIZES) {
      const target = NON_ZERO_ADDRESS
      const gasLimit = 500_000
      const data = '0x' + '12'.repeat(1234)

      describe(`Happy path: when appending ${size} sequencer transactions`, () => {
        describe('when not inserting queue elements in between', () => {
          describe('when using a single batch context', () => {
            let contexts: any[]
            let transactions: any[]
            beforeEach(async () => {
              const timestamp = (await getEthTime(ethers.provider)) - 100
              const blockNumber =
                (await getNextBlockNumber(ethers.provider)) - 10

              contexts = [
                {
                  numSequencedTransactions: size,
                  numSubsequentQueueTransactions: 0,
                  timestamp,
                  blockNumber,
                },
              ]

              transactions = [...Array(size)].map((el, idx) => {
                return '0x' + '12' + '34'.repeat(idx)
              })
            })

            it('should append the given number of transactions', async () => {
              await expect(
                appendSequencerBatch(CanonicalTransactionChain, {
                  transactions,
                  contexts,
                  shouldStartAtElement: 0,
                  totalElementsToAppend: size,
                })
              )
                .to.emit(CanonicalTransactionChain, 'SequencerBatchAppended')
                .withArgs(0, 0, size)
            })
          })
        })

        describe('when inserting queue elements in between', () => {
          beforeEach(async () => {
            for (let i = 0; i < size; i++) {
              await CanonicalTransactionChain.enqueue(target, gasLimit, data)
            }
          })

          describe('between every other sequencer transaction', () => {
            let contexts: any[]
            let transactions: any[]
            beforeEach(async () => {
              const timestamp = (await getEthTime(ethers.provider)) - 100
              const blockNumber =
                (await getNextBlockNumber(ethers.provider)) - 50

              contexts = [...Array(size)].map(() => {
                return {
                  numSequencedTransactions: 1,
                  numSubsequentQueueTransactions: 1,
                  timestamp,
                  blockNumber: Math.max(blockNumber, 0),
                }
              })

              transactions = [...Array(size)].map((el, idx) => {
                return '0x' + '12' + '34'.repeat(idx)
              })
            })

            it('should append the batch', async () => {
              await expect(
                appendSequencerBatch(CanonicalTransactionChain, {
                  transactions,
                  contexts,
                  shouldStartAtElement: 0,
                  totalElementsToAppend: size * 2,
                })
              )
                .to.emit(CanonicalTransactionChain, 'SequencerBatchAppended')
                .withArgs(0, size, size * 2)
            })
          })

          const spacing = Math.max(Math.floor(size / 4), 1)
          describe(`between every ${spacing} sequencer transaction`, () => {
            let contexts: any[]
            let transactions: any[]
            beforeEach(async () => {
              const timestamp = (await getEthTime(ethers.provider)) - 100
              const blockNumber =
                (await getNextBlockNumber(ethers.provider)) - 50

              contexts = [...Array(spacing)].map(() => {
                return {
                  numSequencedTransactions: size / spacing,
                  numSubsequentQueueTransactions: 1,
                  timestamp,
                  blockNumber: Math.max(blockNumber, 0),
                }
              })

              transactions = [...Array(size)].map((el, idx) => {
                return '0x' + '12' + '34'.repeat(idx)
              })
            })

            it('should append the batch', async () => {
              await expect(
                appendSequencerBatch(CanonicalTransactionChain, {
                  transactions,
                  contexts,
                  shouldStartAtElement: 0,
                  totalElementsToAppend: size + spacing,
                })
              )
                .to.emit(CanonicalTransactionChain, 'SequencerBatchAppended')
                .withArgs(0, spacing, size + spacing)
            })
          })
        })
      })
    }
  })

  describe('getTotalElements', () => {
    it('should return zero when no elements exist', async () => {
      expect(await CanonicalTransactionChain.getTotalElements()).to.equal(0)
    })

    for (const size of ELEMENT_TEST_SIZES) {
      describe(`when the sequencer inserts a batch of ${size} elements`, () => {
        beforeEach(async () => {
          const timestamp = (await getEthTime(ethers.provider)) - 100
          const blockNumber = (await getNextBlockNumber(ethers.provider)) - 10

          const contexts = [
            {
              numSequencedTransactions: size,
              numSubsequentQueueTransactions: 0,
              timestamp,
              blockNumber: Math.max(blockNumber, 0),
            },
          ]

          const transactions = [...Array(size)].map((el, idx) => {
            return '0x' + '12' + '34'.repeat(idx)
          })

          const res = await appendSequencerBatch(
            CanonicalTransactionChain.connect(sequencer),
            {
              transactions,
              contexts,
              shouldStartAtElement: 0,
              totalElementsToAppend: size,
            }
          )
          await res.wait()
        })

        it(`should return ${size}`, async () => {
          expect(await CanonicalTransactionChain.getTotalElements()).to.equal(
            size
          )
        })
      })
    }
  })
})
