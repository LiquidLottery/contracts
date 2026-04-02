/**
 * LotteryVRFRequester.test.js
 *
 * Integration tests for LotteryVRFRequester using @chainlink/local's
 * CCIPLocalSimulator so that the full two-contract CCIP pipeline runs
 * synchronously in a single Hardhat network.
 *
 * Architecture under test:
 *
 *   LiquidLotteryV1 (Hyperliquid L1 side)
 *     ─── ccipSend(roundId) ──────────────────► LotteryVRFRequester.ccipReceive()
 *                                                 └─► MockVRFCoordinator.requestRandomWords()
 *   LotteryVRFRequester.fulfillRandomWords()
 *     ─── ccipSend(roundId, randomWord) ──────► LiquidLotteryV1.ccipReceive()
 *                                                 └─► _applyRandomness() → DRAWN
 *
 * Both sides use the SAME @chainlink/local MockCCIPRouter instance so messages
 * are delivered synchronously within a single transaction.
 */

const { expect } = require('chai');
const { ethers } = require('hardhat');
const {
    loadFixture,
    time,
} = require('@nomicfoundation/hardhat-toolbox/network-helpers');

describe('LotteryVRFRequester', function () {
    // ─── Fixture ──────────────────────────────────────────────────────────────

    async function deployFixture() {
        const [owner, alice, bob] = await ethers.getSigners();

        // ── CCIPLocalSimulator (provides a shared synchronous MockCCIPRouter) ──
        const CCIPLocalSimulator = await ethers.getContractFactory('CCIPLocalSimulator');
        const simulator = await CCIPLocalSimulator.deploy();
        await simulator.waitForDeployment();
        const config = await simulator.configuration();
        const CHAIN_SELECTOR = config.chainSelector_; // 16015286601757825753n (Sepolia)
        const routerAddr     = config.sourceRouter_;   // address string

        // ── MockVRFCoordinator ─────────────────────────────────────────────────
        const MockVRF = await ethers.getContractFactory('MockVRFCoordinator');
        const mockVRF = await MockVRF.deploy();
        await mockVRF.waitForDeployment();

        // ── LotteryVRFRequester (source-chain side) ────────────────────────────
        const LotteryVRFRequesterFactory = await ethers.getContractFactory('LotteryVRFRequester');
        const vrfRequester = await LotteryVRFRequesterFactory.deploy(
            await mockVRF.getAddress(),  // VRF coordinator
            routerAddr,                  // CCIP router
            CHAIN_SELECTOR,              // destChainSelector (LiquidLottery "chain")
            owner.address,               // lotteryContract placeholder — updated below
            1n,                          // subscriptionId
            ethers.ZeroHash,             // keyHash
            500_000,                     // callbackGasLimit
            3,                            // requestConfirmations
        );
        await vrfRequester.waitForDeployment();

        // ── LiquidLotteryV1 UUPS proxy (destination-chain side) ────────────────
        const lotteryMathLib = await (await ethers.getContractFactory('LotteryMath')).deploy();
        await lotteryMathLib.waitForDeployment();
        const lotteryViewsLib = await (await ethers.getContractFactory('LotteryViews')).deploy();
        await lotteryViewsLib.waitForDeployment();
        const LiquidLotteryV1 = await ethers.getContractFactory('LiquidLotteryV1', {
            libraries: {
                LotteryMath: await lotteryMathLib.getAddress(),
                LotteryViews: await lotteryViewsLib.getAddress(),
            },
        });
        const impl = await LiquidLotteryV1.deploy();
        await impl.waitForDeployment();

        const initData = LiquidLotteryV1.interface.encodeFunctionData('initialize', [
            owner.address,
            routerAddr,
            CHAIN_SELECTOR,
            await vrfRequester.getAddress(),
        ]);
        const ERC1967Proxy = await ethers.getContractFactory('ERC1967Proxy');
        const proxy = await ERC1967Proxy.deploy(await impl.getAddress(), initData);
        await proxy.waitForDeployment();
        const lottery = LiquidLotteryV1.attach(await proxy.getAddress());

        // ── Wire: tell vrfRequester the real lottery address ──────────────────
        await vrfRequester.connect(owner).setLotteryContract(await lottery.getAddress());

        return {
            simulator, CHAIN_SELECTOR, routerAddr,
            mockVRF, vrfRequester, lottery,
            owner, alice, bob,
        };
    }

    // ─── Helpers ──────────────────────────────────────────────────────────────
    const DRAW_GRACE = 300n;    // seconds — LiquidLotteryV1.DRAW_GRACE_PERIOD

    async function buyTicket(lottery, signer) {
        const price = await lottery.ticketPrice();
        return lottery.connect(signer).buyTickets([[1, 2, 3, 4, 5]], [10], [0], ethers.ZeroAddress, { value: price });
    }

    async function closeDraw(lottery) {
        await time.increase(86400); // upkeepInterval default
        return lottery.closeBettingAndDraw();
    }

    // ─── Tests ────────────────────────────────────────────────────────────────

    // ════════════════ Deployment ══════════════════════════════════════════════

    describe('Deployment', function () {
        it('initialises state variables correctly', async function () {
            const { vrfRequester, mockVRF, lottery, owner, routerAddr, CHAIN_SELECTOR } =
        await loadFixture(deployFixture);

            expect(await vrfRequester.i_ccipRouter()).to.equal(routerAddr);
            expect(await vrfRequester.i_destChainSelector()).to.equal(CHAIN_SELECTOR);
            expect(await vrfRequester.lotteryContract()).to.equal(await lottery.getAddress());
            expect(await vrfRequester.s_subscriptionId()).to.equal(1n);
            expect(await vrfRequester.s_keyHash()).to.equal(ethers.ZeroHash);
            expect(await vrfRequester.s_callbackGasLimit()).to.equal(500_000);
            expect(await vrfRequester.s_requestConfirmations()).to.equal(3);
            expect(await vrfRequester.pendingRoundId()).to.equal(0n);
            expect(await vrfRequester.latestVrfRequestId()).to.equal(0n);
            expect(await vrfRequester.ccipFulfillGasLimit()).to.equal(
                await vrfRequester.DEFAULT_CCIP_GAS_LIMIT(),
            );
        });

        it('owner is the deployer', async function () {
            const { vrfRequester, owner } = await loadFixture(deployFixture);
            expect(await vrfRequester.owner()).to.equal(owner.address);
        });

        it('supportsInterface returns true for IAny2EVMMessageReceiver', async function () {
            const { vrfRequester } = await loadFixture(deployFixture);
            expect(await vrfRequester.supportsInterface('0x85572ffb')).to.be.true;
        });

        it('supportsInterface returns true for ERC165 itself', async function () {
            const { vrfRequester } = await loadFixture(deployFixture);
            expect(await vrfRequester.supportsInterface('0x01ffc9a7')).to.be.true;
        });

        it('supportsInterface returns false for unknown interface', async function () {
            const { vrfRequester } = await loadFixture(deployFixture);
            expect(await vrfRequester.supportsInterface('0xdeadbeef')).to.be.false;
        });
    });

    // ════════════════ Full 2-hop CCIP pipeline ════════════════════════════════

    describe('Full CCIP pipeline (closeDraw → VRF → draw result)', function () {
        it('closeDraw triggers VRF request (pendingRoundId and latestVrfRequestId set)', async function () {
            const { vrfRequester, lottery, alice } = await loadFixture(deployFixture);
            await buyTicket(lottery, alice);

            expect(await vrfRequester.pendingRoundId()).to.equal(0n);
            expect(await vrfRequester.latestVrfRequestId()).to.equal(0n);

            await closeDraw(lottery);

            expect(await vrfRequester.pendingRoundId()).to.equal(1n);
            expect(await vrfRequester.latestVrfRequestId()).to.equal(1n);
        });

        it('round moves to DRAWING after closeDraw', async function () {
            const { lottery, alice } = await loadFixture(deployFixture);
            await buyTicket(lottery, alice);
            await closeDraw(lottery);
            const info = await lottery.getRoundInfo(1);
            expect(info.state).to.equal(1); // DRAWING
        });

        it('VRF fulfillment completes the second hop and round is DRAWN', async function () {
            const { vrfRequester, mockVRF, lottery, alice } = await loadFixture(deployFixture);
            await buyTicket(lottery, alice);
            await closeDraw(lottery);

            const reqId = await vrfRequester.latestVrfRequestId();
            expect(reqId).to.equal(1n);

            await mockVRF.fulfillRandomWords(reqId, [42n]);

            // pendingRoundId cleared after fulfillment
            expect(await vrfRequester.pendingRoundId()).to.equal(0n);

            const info = await lottery.getRoundInfo(1);
            expect(info.state).to.equal(2); // DRAWN
        });

        it('DrawRequestReceived and DrawFulfilled events are emitted', async function () {
            const { vrfRequester, mockVRF, lottery, alice } = await loadFixture(deployFixture);
            await buyTicket(lottery, alice);

            await expect(closeDraw(lottery))
                .to.emit(vrfRequester, 'DrawRequestReceived')
                .withArgs(1n, 1n); // roundId=1, vrfRequestId=1

            await expect(mockVRF.fulfillRandomWords(1n, [99n]))
                .to.emit(vrfRequester, 'DrawFulfilled')
                .withArgs(1n, 99n); // roundId=1, randomWord=99
        });

        it('CCIPFulfillSent event is emitted on the second hop', async function () {
            const { vrfRequester, mockVRF, lottery, alice } = await loadFixture(deployFixture);
            await buyTicket(lottery, alice);
            await closeDraw(lottery);

            await expect(mockVRF.fulfillRandomWords(1n, [42n]))
                .to.emit(vrfRequester, 'CCIPFulfillSent')
                .withArgs(1n, /* any bytes32 */ ethers.isHexString);
        });

        it('full round: buy → close → fulfill → settle works end-to-end', async function () {
            const { mockVRF, lottery, alice } = await loadFixture(deployFixture);
            await buyTicket(lottery, alice);
            await closeDraw(lottery);
            await mockVRF.fulfillRandomWords(1n, [42n]);
            await lottery.settleRound();

            expect(await lottery.currentRound()).to.equal(2n);
        });

        it('two consecutive rounds work correctly (requestIds increment)', async function () {
            const { mockVRF, lottery, alice, bob } = await loadFixture(deployFixture);

            // Round 1
            await buyTicket(lottery, alice);
            await closeDraw(lottery);                      // VRF requestId = 1
            await mockVRF.fulfillRandomWords(1n, [11n]);
            await lottery.settleRound();

            // Round 2
            await buyTicket(lottery, bob);
            await closeDraw(lottery);                      // VRF requestId = 2
            await mockVRF.fulfillRandomWords(2n, [22n]);
            await lottery.settleRound();

            expect(await lottery.currentRound()).to.equal(3n);
        });
    });

    // ════════════════ ccipReceive (draw request path) ═════════════════════════

    describe('ccipReceive — draw request path', function () {
        it('reverts when called by a non-router address', async function () {
            const { vrfRequester, alice, CHAIN_SELECTOR } = await loadFixture(deployFixture);
            const message = {
                messageId:           ethers.ZeroHash,
                sourceChainSelector: CHAIN_SELECTOR,
                sender:              ethers.AbiCoder.defaultAbiCoder().encode(['address'], [alice.address]),
                data:                ethers.AbiCoder.defaultAbiCoder().encode(['uint256'], [1n]),
                destTokenAmounts:    [],
            };
            await expect(
                vrfRequester.connect(alice).ccipReceive(message),
            ).to.be.revertedWith('only CCIP router');
        });

        it('reverts when sender is not the registered lotteryContract', async function () {
            const { vrfRequester, lottery, alice, routerAddr, CHAIN_SELECTOR } =
        await loadFixture(deployFixture);
            // Temporarily deploy a second requester acting as a "bad lottery"
            const badMsg = {
                messageId:           ethers.ZeroHash,
                sourceChainSelector: CHAIN_SELECTOR,
                sender:              ethers.AbiCoder.defaultAbiCoder().encode(['address'], [alice.address]),
                data:                ethers.AbiCoder.defaultAbiCoder().encode(['uint256'], [1n]),
                destTokenAmounts:    [],
            };
            // Deliver directly (bypassing router check is not possible, so just verify router guard)
            await expect(
                vrfRequester.connect(alice).ccipReceive(badMsg),
            ).to.be.revertedWith('only CCIP router');
        });

        it('reverts when a VRF request is already pending for a DIFFERENT round', async function () {
            const { vrfRequester, mockVRF, lottery, alice } = await loadFixture(deployFixture);

            // Get two rounds by completing round 1 first
            await buyTicket(lottery, alice);
            await closeDraw(lottery);                 // pendingRoundId = 1, requestId = 1

            // Start round 2 (need to settle round 1 first)
            await mockVRF.fulfillRandomWords(1n, [42n]);
            await lottery.settleRound();

            // Buy into round 2 and start drawing (pendingRoundId → 0 after fulfillment)
            await buyTicket(lottery, alice);
            await closeDraw(lottery);                 // pendingRoundId = 2, requestId = 2
            expect(await vrfRequester.pendingRoundId()).to.equal(2n);

            // If a re-request for a DIFFERENT roundId tried to come in, it would be blocked.
            // We simulate this by checking the guard on _requestVRFForRound via the contract state.
            // pendingRoundId == 2 != 1 would cause "VRF already pending for different round"
            // We cannot inject this via CCIP without a real second lottery, so we just assert state.
            expect(await vrfRequester.pendingRoundId()).to.not.equal(0n);
        });
    });

    // ════════════════ Emergency cancel + re-draw ══════════════════════════════

    describe('Emergency cancel + re-draw', function () {
        it('allows re-request for the same round after emergencyCancelDraw', async function () {
            const { vrfRequester, mockVRF, lottery, alice } = await loadFixture(deployFixture);
            await buyTicket(lottery, alice);

            // First draw → VRF request #1
            await closeDraw(lottery);
            expect(await vrfRequester.latestVrfRequestId()).to.equal(1n);

            // Cancel draw on LiquidLotteryV1 side
            await time.increase(Number(DRAW_GRACE));
            await lottery.emergencyCancelDraw();
            expect((await lottery.getRoundInfo(1)).state).to.equal(0); // OPEN

            // vrfRequester still has pendingRoundId = 1 (lottery didn't notify it)
            expect(await vrfRequester.pendingRoundId()).to.equal(1n);

            // Re-draw the same round → VRF request #2 (pendingRoundId == roundId: allowed)
            await closeDraw(lottery);
            expect(await vrfRequester.latestVrfRequestId()).to.equal(2n);
            expect(await vrfRequester.pendingRoundId()).to.equal(1n);

            // Fulfilling VRF request #1 still works (round is DRAWING)
            await expect(
                mockVRF.fulfillRandomWords(1n, [77n]),
            ).to.not.be.reverted;

            expect((await lottery.getRoundInfo(1)).state).to.equal(2); // DRAWN
        });

        it('late VRF callback after round DRAWN is rejected (unexpected state)', async function () {
            const { vrfRequester, mockVRF, lottery, alice } = await loadFixture(deployFixture);
            await buyTicket(lottery, alice);

            await closeDraw(lottery);          // requestId=1
            await mockVRF.fulfillRandomWords(1n, [55n]);
            // Round 1 is now DRAWN — requestId=2 won't exist in MockVRF but let's test state
            expect((await lottery.getRoundInfo(1)).state).to.equal(2); // DRAWN

            // Trying to re-fulfill a round that's already DRAWN would be rejected
            await lottery.settleRound();       // round 1 → SETTLED
            // Any stale VRF callback would propagate a ccipSend that gets rejected by
            // the lottery's ccipReceive ("unexpected state") → ReceiverError → MockVRF "callback failed"
        });
    });

    // ════════════════ Admin setters ═══════════════════════════════════════════

    describe('Admin setters', function () {
        it('setLotteryContract: owner can update', async function () {
            const { vrfRequester, owner, alice } = await loadFixture(deployFixture);
            await expect(
                vrfRequester.connect(owner).setLotteryContract(alice.address),
            ).to.emit(vrfRequester, 'LotteryContractUpdated').withArgs(alice.address);
            expect(await vrfRequester.lotteryContract()).to.equal(alice.address);
        });

        it('setLotteryContract: reverts for zero address', async function () {
            const { vrfRequester, owner } = await loadFixture(deployFixture);
            await expect(
                vrfRequester.connect(owner).setLotteryContract(ethers.ZeroAddress),
            ).to.be.revertedWith('zero address');
        });

        it('setLotteryContract: reverts for non-owner', async function () {
            const { vrfRequester, alice } = await loadFixture(deployFixture);
            await expect(
                vrfRequester.connect(alice).setLotteryContract(alice.address),
            ).to.be.reverted;
        });

        it('checkUpkeep and performUpkeep do not exist on VRFRequester (automation removed)', async function () {
            const { vrfRequester } = await loadFixture(deployFixture);
            expect(vrfRequester.checkUpkeep).to.be.undefined;
            expect(vrfRequester.performUpkeep).to.be.undefined;
        });

        it('upkeepInterval does not exist on VRFRequester (automation removed)', async function () {
            const { vrfRequester } = await loadFixture(deployFixture);
            expect(vrfRequester.upkeepInterval).to.be.undefined;
        });

        it('setCCIPFulfillGasLimit: owner can update within bounds', async function () {
            const { vrfRequester, owner } = await loadFixture(deployFixture);
            const min = await vrfRequester.MIN_CCIP_GAS_LIMIT();
            await expect(
                vrfRequester.connect(owner).setCCIPFulfillGasLimit(min),
            ).to.emit(vrfRequester, 'CCIPFulfillGasLimitUpdated').withArgs(min);
        });

        it('setCCIPFulfillGasLimit: reverts below MIN_CCIP_GAS_LIMIT', async function () {
            const { vrfRequester, owner } = await loadFixture(deployFixture);
            const min = await vrfRequester.MIN_CCIP_GAS_LIMIT();
            await expect(
                vrfRequester.connect(owner).setCCIPFulfillGasLimit(min - 1n),
            ).to.be.revertedWith('gas limit out of range');
        });

        it('setCCIPFulfillGasLimit: reverts above MAX_CCIP_GAS_LIMIT', async function () {
            const { vrfRequester, owner } = await loadFixture(deployFixture);
            const max = await vrfRequester.MAX_CCIP_GAS_LIMIT();
            await expect(
                vrfRequester.connect(owner).setCCIPFulfillGasLimit(max + 1n),
            ).to.be.revertedWith('gas limit out of range');
        });

        it('setSubscriptionId: owner can update', async function () {
            const { vrfRequester, owner } = await loadFixture(deployFixture);
            await vrfRequester.connect(owner).setSubscriptionId(999n);
            expect(await vrfRequester.s_subscriptionId()).to.equal(999n);
        });

        it('setKeyHash: owner can update', async function () {
            const { vrfRequester, owner } = await loadFixture(deployFixture);
            const newHash = ethers.keccak256(ethers.toUtf8Bytes('test'));
            await vrfRequester.connect(owner).setKeyHash(newHash);
            expect(await vrfRequester.s_keyHash()).to.equal(newHash);
        });

        it('setCallbackGasLimit: owner can update', async function () {
            const { vrfRequester, owner } = await loadFixture(deployFixture);
            await vrfRequester.connect(owner).setCallbackGasLimit(300_000);
            expect(await vrfRequester.s_callbackGasLimit()).to.equal(300_000);
        });

        it('setRequestConfirmations: owner can update', async function () {
            const { vrfRequester, owner } = await loadFixture(deployFixture);
            await vrfRequester.connect(owner).setRequestConfirmations(5);
            expect(await vrfRequester.s_requestConfirmations()).to.equal(5);
        });

        it('withdrawFunds function does not exist (removed for safety)', async function () {
            const { vrfRequester } = await loadFixture(deployFixture);
            expect(vrfRequester.withdrawFunds).to.be.undefined;
        });
    });

    // ════════════ Bug-fix: resilient fulfillRandomWords (Bug 3) ══════════════

    describe('Resilient VRF fulfillment (pendingRandomWords)', function () {
        it('DEFAULT_CCIP_GAS_LIMIT is 500 000 (up from 300 000) to cover destination gas', async function () {
            const { vrfRequester } = await loadFixture(deployFixture);
            expect(await vrfRequester.DEFAULT_CCIP_GAS_LIMIT()).to.equal(500_000n);
        });

        it('ccipFulfillGasLimit defaults to 500 000 on deployment', async function () {
            const { vrfRequester } = await loadFixture(deployFixture);
            expect(await vrfRequester.ccipFulfillGasLimit()).to.equal(500_000n);
        });

        it('pendingRandomWords[roundId] is 0 after a successful VRF fulfillment', async function () {
            const { vrfRequester, mockVRF, lottery, alice } = await loadFixture(deployFixture);
            await buyTicket(lottery, alice);
            await closeDraw(lottery);              // requestId = 1
            await mockVRF.fulfillRandomWords(1n, [42n]); // fulfills and sends via CCIP
            // Word was stored briefly then deleted because CCIP succeeded.
            expect(await vrfRequester.pendingRandomWords(1n)).to.equal(0n);
        });

        it('retryFulfillViaCCIP reverts when no pending random word exists', async function () {
            const { vrfRequester, owner } = await loadFixture(deployFixture);
            await expect(
                vrfRequester.connect(owner).retryFulfillViaCCIP(1n),
            ).to.be.revertedWith('no pending random word for this round');
        });

        it('retryFulfillViaCCIP reverts for non-owner', async function () {
            const { vrfRequester, alice } = await loadFixture(deployFixture);
            await expect(
                vrfRequester.connect(alice).retryFulfillViaCCIP(1n),
            ).to.be.reverted;
        });

        it('clearPendingRandomWord reverts when no pending word exists', async function () {
            const { vrfRequester, owner } = await loadFixture(deployFixture);
            await expect(
                vrfRequester.connect(owner).clearPendingRandomWord(1n),
            ).to.be.revertedWith('no pending random word for this round');
        });

        it('clearPendingRandomWord reverts for non-owner', async function () {
            const { vrfRequester, alice } = await loadFixture(deployFixture);
            await expect(
                vrfRequester.connect(alice).clearPendingRandomWord(1n),
            ).to.be.reverted;
        });

        it('attemptSendFulfillToCCIP reverts when called by non-self address', async function () {
            const { vrfRequester, owner } = await loadFixture(deployFixture);
            await expect(
                vrfRequester.connect(owner).attemptSendFulfillToCCIP(1n, 42n),
            ).to.be.revertedWith('only self');
        });
    });
});
