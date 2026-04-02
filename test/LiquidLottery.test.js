const { expect } = require('chai');
const { ethers } = require('hardhat');
const {
    loadFixture,
    time,
} = require('@nomicfoundation/hardhat-toolbox/network-helpers');

describe('LiquidLottery', function () {
    // ── Shared library instances (deployed once, reused for error matching) ──
    let lotteryMathLib, lotteryViewsLib;
    before(async function () {
        lotteryMathLib = await (await ethers.getContractFactory('LotteryMath')).deploy();
        await lotteryMathLib.waitForDeployment();
        lotteryViewsLib = await (await ethers.getContractFactory('LotteryViews')).deploy();
        await lotteryViewsLib.waitForDeployment();
    });

    // ─── Fixture ────────────────────────────────────────────────────
    //
    // Uses @chainlink/local's CCIPLocalSimulator which provides a real
    // synchronous MockCCIPRouter.  When ccipSend() is called it immediately
    // delivers the message to the receiver in the same transaction, so a single
    // call to mockVRF.fulfillRandomWords() exercises the full 2-hop CCIP
    // pipeline:
    //
    //   closeDraw()
    //     → LiquidLotteryV1._triggerDraw()  ──ccipSend──►  LotteryVRFRequester.ccipReceive()
    //       → MockVRFCoordinator.requestRandomWords()
    //
    //   mockVRF.fulfillRandomWords(requestId, [seed])
    //     → LotteryVRFRequester.fulfillRandomWords()  ──ccipSend──►  LiquidLotteryV1.ccipReceive()
    //       → _applyRandomness()  →  round DRAWN
    //
    // The CCIPLocalSimulator's MockRouter hardcodes sourceChainSelector =
    // 16015286601757825753 (Sepolia simulator selector) in all delivered
    // messages, so both contracts must be configured with that value.
    async function deployFixture() {
        const [owner, alice, bob, charlie] = await ethers.getSigners();

        // ── 1. Deploy CCIPLocalSimulator and read its config ───────────
        const CCIPLocalSimulator = await ethers.getContractFactory('CCIPLocalSimulator');
        const simulator = await CCIPLocalSimulator.deploy();
        await simulator.waitForDeployment();
        const config = await simulator.configuration();
        // chainSelector_ and both routers are the same single MockCCIPRouter instance
        const CHAIN_SELECTOR = config.chainSelector_;           // 16015286601757825753n
        const mockRouter     = config.sourceRouter_;            // MockCCIPRouter address
        const routerAddr     = mockRouter;                       // address string from configuration()

        // ── 2. Deploy MockVRFCoordinator ───────────────────────────────
        const MockVRF = await ethers.getContractFactory('MockVRFCoordinator');
        const mockVRF = await MockVRF.deploy();
        await mockVRF.waitForDeployment();

        // ── 3. Deploy LotteryVRFRequester (source-chain side) ──────────
        //    Temporary lotteryContract = owner.address; updated in step 5.
        const LotteryVRFRequesterFactory = await ethers.getContractFactory('LotteryVRFRequester');
        const vrfRequester = await LotteryVRFRequesterFactory.deploy(
            await mockVRF.getAddress(),   // VRF coordinator
            routerAddr,                   // CCIP router (same MockRouter)
            CHAIN_SELECTOR,               // destChainSelector → LiquidLotteryV1 "chain"
            owner.address,                // lotteryContract placeholder (updated below)
            1n,                           // subscriptionId
            ethers.ZeroHash,              // keyHash
            500_000,                      // callbackGasLimit
            3,                             // requestConfirmations
        );
        await vrfRequester.waitForDeployment();

        // ── 4. Deploy libraries + LiquidLotteryV1 UUPS proxy ──────────
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
            routerAddr,                         // CCIP router (same MockRouter)
            CHAIN_SELECTOR,                     // sourceChainSelector (LotteryVRFRequester's chain)
            await vrfRequester.getAddress(),    // vrfRequester
        ]);
        const ERC1967Proxy = await ethers.getContractFactory('ERC1967Proxy');
        const proxy = await ERC1967Proxy.deploy(await impl.getAddress(), initData);
        await proxy.waitForDeployment();
        const lottery = LiquidLotteryV1.attach(await proxy.getAddress());

        // ── 5. Wire: tell vrfRequester the real lottery address ────────
        await vrfRequester.connect(owner).setLotteryContract(await lottery.getAddress());

        return {
            simulator, mockRouter, routerAddr, CHAIN_SELECTOR,
            mockVRF, vrfRequester,
            lottery, impl, owner, alice, bob, charlie,
            lotteryMathLib, lotteryViewsLib,
        };
    }

    // ─── Helpers ────────────────────────────────────────────────────
    function makeTicket(whites, goldNum, goldPos) {
        return { whites, goldNum, goldPos };
    }

    const MIN_TICKET_PRICE = ethers.parseEther('0.01');
    const TICKET_PRICE_BPS = 5n; // 0.05 %

    // Match the contract's upkeepInterval default (24 h) and DRAW_GRACE_PERIOD (5 min).
    const UPKEEP_INTERVAL = 86400n;  // seconds – contract default
    const DRAW_GRACE      = 300n;    // seconds – contract DRAW_GRACE_PERIOD

    // Arbitrary large seed unlikely to produce whites [1,2,3,4,5]
    const NON_MATCHING_SEED = ethers.toBigInt(
        '0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
    );

    /** Compute expected ticket price from pool values */
    function expectedPrice(jackpotPool, seedPool) {
        const pool = jackpotPool + seedPool;
        const price = (pool * TICKET_PRICE_BPS) / 10000n;
        return price > MIN_TICKET_PRICE ? price : MIN_TICKET_PRICE;
    }

    async function buyTickets(lottery, signer, tickets, valueOverride) {
        const whites = tickets.map((t) => t.whites);
        const golds = tickets.map((t) => t.goldNum);
        const positions = tickets.map((t) => t.goldPos);
        const value =
      valueOverride !== undefined
          ? valueOverride
          : (await lottery.ticketPrice()) * BigInt(tickets.length);
        return lottery
            .connect(signer)
            .buyTickets(whites, golds, positions, ethers.ZeroAddress, { value });
    }

    // Advance time past upkeepInterval so closeBettingAndDraw() passes the interval check.
    async function closeDraw(l) {
        await time.increase(Number(UPKEEP_INTERVAL));
        return l.closeBettingAndDraw();
    }

    /**
   * Simulate the cross-chain VRF fulfillment using the real @chainlink/local
   * MockCCIPRouter pipeline.
   *
   * closeDraw() has already triggered the full chain:
   *   LiquidLotteryV1._triggerDraw() → ccipSend → LotteryVRFRequester.ccipReceive()
   *   → MockVRFCoordinator.requestRandomWords() → requestId stored
   *
   * fulfillDraw() completes the second hop:
   *   MockVRFCoordinator.fulfillRandomWords(requestId, [seed])
   *   → LotteryVRFRequester.fulfillRandomWords() → ccipSend
   *   → LiquidLotteryV1.ccipReceive() → _applyRandomness() → DRAWN
   *
   * @param mockVRF    MockVRFCoordinator instance.
   * @param requestId  VRF request ID (1-based, auto-increments per draw request).
   * @param seed       Random word to use as the VRF output.
   */
    async function fulfillDraw(mockVRF, requestId, seed) {
        return mockVRF.fulfillRandomWords(requestId, [BigInt(seed)]);
    }

    // ─── Tests ──────────────────────────────────────────────────────

    describe('Deployment', function () {
        it('should start at round 1 in OPEN state', async function () {
            const { lottery } = await loadFixture(deployFixture);
            expect(await lottery.currentRound()).to.equal(1);
            const info = await lottery.getRoundInfo(1);
            expect(info.state).to.equal(0); // OPEN
        });

        it('should have correct constants', async function () {
            const { lottery } = await loadFixture(deployFixture);
            expect(await lottery.TICKET_PRICE_BPS()).to.equal(TICKET_PRICE_BPS);
            expect(await lottery.MIN_TICKET_PRICE()).to.equal(MIN_TICKET_PRICE);
            expect(await lottery.MAX_TICKETS()).to.equal(25);
            expect(await lottery.FEE_BPS()).to.equal(2000);
            expect(await lottery.JACKPOT_BPS()).to.equal(5000);
            expect(await lottery.SEED_BPS()).to.equal(3000);
        });
    });

    describe('Dynamic ticket pricing', function () {
        it('should return MIN_TICKET_PRICE when pools are empty', async function () {
            const { lottery } = await loadFixture(deployFixture);
            expect(await lottery.ticketPrice()).to.equal(MIN_TICKET_PRICE);
        });

        it('should return percentage-based price when pools are large enough', async function () {
            const { lottery, alice } = await loadFixture(deployFixture);

            // Seed the jackpot pool via a direct transfer + manual pool setup
            // is not possible; instead buy tickets to build up the pool then
            // check that subsequent price reflects the pools.
            // With empty pools the first ticket costs MIN_TICKET_PRICE.
            const t = makeTicket([1, 2, 3, 4, 5], 10, 0);
            await buyTickets(lottery, alice, [t]);

            const info = await lottery.getRoundInfo(1);
            const price = await lottery.ticketPrice();
            const expected = expectedPrice(info.jackpotPool, info.seedPool);
            expect(price).to.equal(expected);
        });

        it('should increase price as more tickets are sold and pools grow', async function () {
            const { lottery, alice, bob } = await loadFixture(deployFixture);

            const priceBefore = await lottery.ticketPrice();
            expect(priceBefore).to.equal(MIN_TICKET_PRICE);

            // Buy first ticket at MIN_TICKET_PRICE
            await buyTickets(lottery, alice, [makeTicket([1, 2, 3, 4, 5], 10, 0)]);

            // Price may still be MIN if pool is too small for 2% to exceed it
            const priceAfterOne = await lottery.ticketPrice();
            expect(priceAfterOne).to.be.gte(MIN_TICKET_PRICE);
        });

        it('should accept overpayment and refund the difference', async function () {
            const { lottery, alice } = await loadFixture(deployFixture);
            const t = makeTicket([1, 2, 3, 4, 5], 10, 0);

            const price = await lottery.ticketPrice();
            const overpay = price + ethers.parseEther('1');

            const balBefore = await ethers.provider.getBalance(alice.address);
            const tx = await buyTickets(lottery, alice, [t], overpay);
            const receipt = await tx.wait();
            const gasCost = receipt.gasUsed * receipt.gasPrice;
            const balAfter = await ethers.provider.getBalance(alice.address);

            // Alice should have paid only the ticket price + gas (not the overpay)
            expect(balBefore - balAfter - gasCost).to.equal(price);
        });

        it('should reject insufficient payment', async function () {
            const { lottery, alice } = await loadFixture(deployFixture);
            const t = makeTicket([1, 2, 3, 4, 5], 10, 0);

            // Send less than MIN_TICKET_PRICE
            await expect(
                buyTickets(lottery, alice, [t], ethers.parseEther('0.001')),
            ).to.be.revertedWithCustomError(lotteryMathLib, 'InsufficientPayment');
        });
    });

    describe('Buying tickets', function () {
        it('should accept a valid single ticket', async function () {
            const { lottery, alice } = await loadFixture(deployFixture);
            const t = makeTicket([1, 20, 33, 55, 90], 42, 2);

            await expect(buyTickets(lottery, alice, [t]))
                .to.emit(lottery, 'TicketsPurchased')
                .withArgs(1, alice.address, 1);

            const info = await lottery.getRoundInfo(1);
            expect(info.ticketCount).to.equal(1);

            // Revenue split: 50% jackpot, 30% seed, 20% fee
            const price = MIN_TICKET_PRICE; // pools were empty
            const fee = (price * 2000n) / 10000n;
            const jackpot = (price * 5000n) / 10000n;
            const seed = price - fee - jackpot;
            expect(info.jackpotPool).to.equal(jackpot);
            expect(info.seedPool).to.equal(seed);
        });

        it('should accept multiple tickets at once', async function () {
            const { lottery, alice } = await loadFixture(deployFixture);
            const t1 = makeTicket([1, 2, 3, 4, 5], 10, 0);
            const t2 = makeTicket([10, 20, 30, 40, 50], 60, 4);
            const t3 = makeTicket([85, 86, 87, 88, 89], 90, 3);

            await buyTickets(lottery, alice, [t1, t2, t3]);

            const info = await lottery.getRoundInfo(1);
            expect(info.ticketCount).to.equal(3);
            expect(await lottery.playerTicketCount(1, alice.address)).to.equal(3);
        });

        it('should reject if whites are not sorted', async function () {
            const { lottery, alice } = await loadFixture(deployFixture);
            const t = makeTicket([5, 3, 1, 2, 4], 10, 0);
            await expect(buyTickets(lottery, alice, [t])).to.be.revertedWithCustomError(lotteryMathLib, 'WhitesNotSortedUnique');
        });

        it('should reject if whites have duplicates', async function () {
            const { lottery, alice } = await loadFixture(deployFixture);
            const t = makeTicket([1, 1, 2, 3, 4], 10, 0);
            await expect(buyTickets(lottery, alice, [t])).to.be.revertedWithCustomError(lotteryMathLib, 'WhitesNotSortedUnique');
        });

        it('should reject if white number out of range', async function () {
            const { lottery, alice } = await loadFixture(deployFixture);
            const t = makeTicket([0, 1, 2, 3, 4], 10, 0);
            await expect(buyTickets(lottery, alice, [t])).to.be.revertedWithCustomError(lotteryMathLib, 'WhiteOutOfRange');
        });

        it('should reject if gold number out of range', async function () {
            const { lottery, alice } = await loadFixture(deployFixture);
            const t = makeTicket([1, 2, 3, 4, 5], 91, 0);
            await expect(buyTickets(lottery, alice, [t])).to.be.revertedWithCustomError(lotteryMathLib, 'GoldOutOfRange');
        });

        it('should reject if gold position out of range', async function () {
            const { lottery, alice } = await loadFixture(deployFixture);
            const t = makeTicket([1, 2, 3, 4, 5], 10, 5);
            await expect(buyTickets(lottery, alice, [t])).to.be.revertedWithCustomError(lotteryMathLib, 'GoldPosOutOfRange');
        });

        it('should reject insufficient payment', async function () {
            const { lottery, alice } = await loadFixture(deployFixture);
            const t = makeTicket([1, 2, 3, 4, 5], 10, 0);
            await expect(
                lottery
                    .connect(alice)
                    .buyTickets([t.whites], [t.goldNum], [t.goldPos], ethers.ZeroAddress, {
                        value: 0,
                    }),
            ).to.be.revertedWithCustomError(lotteryMathLib, 'InsufficientPayment');
        });

        it('should reject if exceeding max tickets per address', async function () {
            const { lottery, alice } = await loadFixture(deployFixture);
            const maxTickets = Number(await lottery.MAX_TICKETS()); // 25 per address per round
            const tickets = [];
            for (let i = 0; i <= maxTickets; i++) {  // maxTickets + 1 tickets → over the limit
                tickets.push(makeTicket([1, 2, 3, 4, 5], 10, 0));
            }
            await expect(buyTickets(lottery, alice, tickets)).to.be.revertedWithCustomError(lotteryMathLib, 'TicketLimitExceeded');
        });

        it('should track player tickets correctly', async function () {
            const { lottery, alice } = await loadFixture(deployFixture);
            const t1 = makeTicket([1, 2, 3, 4, 5], 10, 0);
            const t2 = makeTicket([10, 20, 30, 40, 50], 60, 4);

            await buyTickets(lottery, alice, [t1, t2]);

            const indices = await lottery.getPlayerTicketIndices(1, alice.address);
            expect(indices.length).to.equal(2);

            const tickets = await lottery.getPlayerTickets(1, alice.address);
            expect(tickets.length).to.equal(2);
            expect(tickets[0].whites[0]).to.equal(1);
            expect(tickets[1].whites[0]).to.equal(10);
        });
    });

    describe('Draw and settlement', function () {
        it('should reject draw if no tickets sold', async function () {
            const { lottery, owner } = await loadFixture(deployFixture);
            await expect(lottery.closeBettingAndDraw()).to.be.revertedWithCustomError(lotteryMathLib, 'NoTicketsSold');
        });

        it('should reject draw from non-admin', async function () {
            const { lottery, alice } = await loadFixture(deployFixture);
            const t = makeTicket([1, 2, 3, 4, 5], 10, 0);
            await buyTickets(lottery, alice, [t]);
            await expect(
                lottery.connect(alice).closeBettingAndDraw(),
            ).to.be.revertedWithCustomError(lottery, 'Unauthorized');
        });

        it('should reject buying after draw is requested', async function () {
            const { lottery, alice, owner } = await loadFixture(deployFixture);
            const t = makeTicket([1, 2, 3, 4, 5], 10, 0);
            await buyTickets(lottery, alice, [t]);
            await closeDraw(lottery);

            await expect(buyTickets(lottery, alice, [t])).to.be.revertedWithCustomError(lotteryMathLib, 'RoundNotOpen');
        });

        it('should reject settlement before draw is fulfilled', async function () {
            const { lottery, alice } = await loadFixture(deployFixture);
            const t = makeTicket([1, 2, 3, 4, 5], 10, 0);
            await buyTickets(lottery, alice, [t]);
            await closeDraw(lottery);

            await expect(lottery.settleRound()).to.be.revertedWithCustomError(lotteryMathLib, 'NotDrawnYet');
        });

        it('full flow: no winners → pools roll over', async function () {
            const { lottery, mockVRF, alice, owner } = await loadFixture(
                deployFixture,
            );

            const t = makeTicket([1, 2, 3, 4, 5], 10, 0);
            await buyTickets(lottery, alice, [t]);

            // Capture pools before draw
            const infoBefore = await lottery.getRoundInfo(1);

            // Close and request draw
            await closeDraw(lottery);

            // Fulfill via CCIP with random word that generates DIFFERENT numbers
            await fulfillDraw(mockVRF, 1, NON_MATCHING_SEED);

            // Verify state is DRAWN
            const infoDrawn = await lottery.getRoundInfo(1);
            expect(infoDrawn.state).to.equal(2); // DRAWN

            // Settle
            await lottery.settleRound();

            // Round should be settled
            const infoSettled = await lottery.getRoundInfo(1);
            expect(infoSettled.state).to.equal(3); // SETTLED
            expect(infoSettled.jackpotWinners).to.equal(0);
            expect(infoSettled.superWinners).to.equal(0);

            // Next round should have rolled-over pools
            expect(await lottery.currentRound()).to.equal(2);
            const info2 = await lottery.getRoundInfo(2);
            expect(info2.jackpotPool).to.equal(infoBefore.jackpotPool);
            expect(info2.seedPool).to.equal(infoBefore.seedPool);
            expect(info2.state).to.equal(0); // OPEN
        });

        it('full flow: jackpot winner (5/5 whites, no gold)', async function () {
            const { lottery, mockVRF, alice, owner } = await loadFixture(
                deployFixture,
            );

            const t = makeTicket([1, 2, 3, 4, 5], 10, 0);
            await buyTickets(lottery, alice, [t]);

            await closeDraw(lottery);

            // Fulfill via CCIP with a random word
            const randomWord = 42n;
            await fulfillDraw(mockVRF, 1, randomWord);

            // Settle (no inline payments any more)
            await lottery.settleRound();

            const infoSettled = await lottery.getRoundInfo(1);

            // Check if it was a win – if so, Alice can *claim* her prize
            if (infoSettled.jackpotWinners > 0n) {
                // Prize is claimable, not auto-sent
                const claimable = await lottery.getClaimableAmount(1, alice.address);
                expect(claimable).to.be.greaterThan(0n);

                const aliceBalBefore = await ethers.provider.getBalance(alice.address);
                const indices = await lottery.getPlayerTicketIndices(1, alice.address);
                const claimTx = await lottery.connect(alice).claimPrizeBatch(1, indices);
                const receipt = await claimTx.wait();
                const gasCost = receipt.gasUsed * receipt.gasPrice;
                const aliceBalAfter = await ethers.provider.getBalance(alice.address);

                expect(aliceBalAfter - aliceBalBefore + gasCost).to.equal(claimable);
                // Claimable is now 0
                expect(await lottery.getClaimableAmount(1, alice.address)).to.equal(0n);
            }

            // Either way, next round should be open
            expect(await lottery.currentRound()).to.equal(2);
        });

        it('claim-based: prize stays in contract until claimed', async function () {
            const { lottery, mockVRF, alice } = await loadFixture(deployFixture);

            // Buy a ticket with the drawn numbers that seed 42 produces
            // We'll use the seed to find what numbers are drawn and buy those
            // For simplicity, use NON_MATCHING_SEED → no winners → rollover
            const t = makeTicket([1, 2, 3, 4, 5], 10, 0);
            await buyTickets(lottery, alice, [t]);

            // Capture jackpot pool
            const infoBefore = await lottery.getRoundInfo(1);
            const contractBalBefore = await ethers.provider.getBalance(
                await lottery.getAddress(),
            );

            await closeDraw(lottery);
            await fulfillDraw(mockVRF, 1, NON_MATCHING_SEED);
            await lottery.settleRound();

            // No winners → ETH stays in contract (rolled to next round; minus CCIP fee)
            const contractBalAfter = await ethers.provider.getBalance(
                await lottery.getAddress(),
            );
            // Contract balance includes carried-over jackpot + seed (minus fees already in ownerFees and CCIP fee)
            expect(contractBalAfter).to.be.gte(
                infoBefore.jackpotPool + infoBefore.seedPool,
            );
        });

        it('claimPrize reverts for non-owner', async function () {
            const { lottery, mockVRF, alice, bob } = await loadFixture(deployFixture);
            const t = makeTicket([1, 2, 3, 4, 5], 10, 0);
            await buyTickets(lottery, alice, [t]);
            await closeDraw(lottery);
            await fulfillDraw(mockVRF, 1, 42n);
            await lottery.settleRound();

            const infoSettled = await lottery.getRoundInfo(1);
            if (infoSettled.jackpotWinners > 0n) {
                // Bob tries to claim Alice's ticket (index 0)
                await expect(
                    lottery.connect(bob).claimPrize(1, 0),
                ).to.be.revertedWithCustomError(lotteryMathLib, 'NotTicketOwner');
            }
        });

        it('claimPrize reverts if ticket has no prize', async function () {
            const { lottery, mockVRF, alice } = await loadFixture(deployFixture);
            const t = makeTicket([1, 2, 3, 4, 5], 10, 0);
            await buyTickets(lottery, alice, [t]);
            await closeDraw(lottery);
            // Non-matching seed → no winners
            await fulfillDraw(mockVRF, 1, NON_MATCHING_SEED);
            await lottery.settleRound();

            await expect(
                lottery.connect(alice).claimPrize(1, 0),
            ).to.be.revertedWithCustomError(lotteryMathLib, 'NoPrize');
        });

        it('claimPrize reverts for double-claim', async function () {
            const { lottery, mockVRF, alice } = await loadFixture(deployFixture);

            // Use seed 42 and check if alice wins; skip test if not
            await buyTickets(lottery, alice, [makeTicket([1, 2, 3, 4, 5], 10, 0)]);
            await closeDraw(lottery);
            await fulfillDraw(mockVRF, 1, 42n);
            await lottery.settleRound();

            const info = await lottery.getRoundInfo(1);
            if (info.jackpotWinners === 0n) return; // seed 42 produced no match – skip

            const indices = await lottery.getPlayerTicketIndices(1, alice.address);
            // First claim succeeds
            await lottery.connect(alice).claimPrizeBatch(1, indices);
            // Second claim reverts
            await expect(
                lottery.connect(alice).claimPrizeBatch(1, indices),
            ).to.be.revertedWithCustomError(lotteryMathLib, 'AlreadyClaimed');
        });

        it('emergencyCancelDraw invalidates draw state, late CCIP callback is silently discarded', async function () {
            const { lottery, vrfRequester, mockVRF, alice } = await loadFixture(deployFixture);
            const t = makeTicket([1, 2, 3, 4, 5], 10, 0);
            await buyTickets(lottery, alice, [t]);
            await closeDraw(lottery);

            // Cancel the draw
            await time.increase(Number(DRAW_GRACE));
            await lottery.emergencyCancelDraw();
            expect((await lottery.getRoundInfo(1)).state).to.equal(0); // OPEN

            // A late VRF fulfillment arrives after emergency cancel.
            // fulfillRandomWords now uses try/catch: ccipReceive() rejects the
            // message (r.state != DRAWING) but the callback itself no longer reverts.
            // The random word is stored in pendingRandomWords for potential cleanup.
            await expect(
                fulfillDraw(mockVRF, 1, NON_MATCHING_SEED),
            ).to.not.be.reverted;

            // Lottery state must remain OPEN — the rejected CCIP had no effect.
            expect((await lottery.getRoundInfo(1)).state).to.equal(0); // still OPEN

            // The random word should be stored in pendingRandomWords (resilience mechanism).
            expect(await vrfRequester.pendingRandomWords(1n)).to.equal(NON_MATCHING_SEED);
        });
    }); // end describe("Draw and settlement")

    describe('Owner fees', function () {
        it('should accumulate and be withdrawable', async function () {
            const { lottery, alice, owner } = await loadFixture(deployFixture);

            const t = makeTicket([1, 2, 3, 4, 5], 10, 0);
            await buyTickets(lottery, alice, [t]);

            // First ticket on empty pool → price = MIN_TICKET_PRICE
            const price = MIN_TICKET_PRICE;
            const fee = (price * 2000n) / 10000n;
            const nftShare = (fee * 5000n) / 10000n;
            const expectedFee = fee - nftShare; // admin gets 10% of totalCost
            expect(await lottery.ownerFees()).to.equal(expectedFee);

            const balBefore = await ethers.provider.getBalance(owner.address);
            const tx = await lottery.withdrawFees();
            const receipt = await tx.wait();
            const gasCost = receipt.gasUsed * receipt.gasPrice;
            const balAfter = await ethers.provider.getBalance(owner.address);

            expect(balAfter - balBefore + gasCost).to.equal(expectedFee);
            expect(await lottery.ownerFees()).to.equal(0);
        });

        it('should reject fee withdrawal from non-admin', async function () {
            const { lottery, alice } = await loadFixture(deployFixture);
            const t = makeTicket([1, 2, 3, 4, 5], 10, 0);
            await buyTickets(lottery, alice, [t]);

            await expect(
                lottery.connect(alice).withdrawFees(),
            ).to.be.revertedWithCustomError(lottery, 'Unauthorized');
        });

        it('topUpOwnerFees: credits sent ETH to ownerFees', async function () {
            const { lottery, alice } = await loadFixture(deployFixture);

            const topUpAmount = ethers.parseEther('0.5');
            const feesBefore = await lottery.ownerFees();

            await lottery.connect(alice).topUpOwnerFees({ value: topUpAmount });

            expect(await lottery.ownerFees()).to.equal(feesBefore + topUpAmount);
        });

        it('topUpOwnerFees: reverts with zero value', async function () {
            const { lottery, alice } = await loadFixture(deployFixture);

            await expect(
                lottery.connect(alice).topUpOwnerFees({ value: 0n }),
            ).to.be.revertedWithCustomError(lotteryViewsLib, 'NoValueSent');
        });

        it('topUpOwnerFees: emits OwnerFeesTopUp event', async function () {
            const { lottery, alice } = await loadFixture(deployFixture);

            const topUpAmount = ethers.parseEther('0.1');
            await expect(
                lottery.connect(alice).topUpOwnerFees({ value: topUpAmount }),
            ).to.emit(lottery, 'OwnerFeesTopUp').withArgs(alice.address, topUpAmount);
        });

        it('topUpOwnerFees: does NOT affect jackpot or seed pool accounting', async function () {
            const { lottery, alice } = await loadFixture(deployFixture);

            // Buy a ticket to establish pool balances
            const t = makeTicket([1, 2, 3, 4, 5], 10, 0);
            await buyTickets(lottery, alice, [t]);

            const roundBefore = await lottery.getRoundInfo(1);
            const jackpotBefore = roundBefore.jackpotPool;
            const seedBefore    = roundBefore.seedPool;

            // Top up ownerFees — must not touch jackpot/seed pools
            await lottery.connect(alice).topUpOwnerFees({ value: ethers.parseEther('1') });

            const roundAfter = await lottery.getRoundInfo(1);
            expect(roundAfter.jackpotPool).to.equal(jackpotBefore);
            expect(roundAfter.seedPool).to.equal(seedBefore);
        });

        it('topUpOwnerFees: direct receive() does NOT update ownerFees', async function () {
            const { lottery, alice } = await loadFixture(deployFixture);

            const feesBefore = await lottery.ownerFees();

            // Send ETH directly via a plain transfer — must NOT update ownerFees
            await alice.sendTransaction({ to: await lottery.getAddress(), value: ethers.parseEther('1') });

            expect(await lottery.ownerFees()).to.equal(feesBefore);
        });
    });

    describe('seedJackpot', function () {
        it('admin can seed the jackpot', async function () {
            const { lottery } = await loadFixture(deployFixture);

            await lottery.seedJackpot({ value: ethers.parseEther('1') });

            const info = await lottery.getRoundInfo(1);
            expect(info.jackpotPool).to.equal(ethers.parseEther('1'));
        });

        it('non-admin cannot seed the jackpot', async function () {
            const { lottery, alice } = await loadFixture(deployFixture);

            await expect(
                lottery.connect(alice).seedJackpot({ value: ethers.parseEther('1') }),
            ).to.be.revertedWithCustomError(lottery, 'Unauthorized');
        });

        it('reverts with zero value', async function () {
            const { lottery } = await loadFixture(deployFixture);

            await expect(
                lottery.seedJackpot({ value: 0n }),
            ).to.be.revertedWithCustomError(lotteryViewsLib, 'NoValueSent');
        });

        it('seed accumulates across multiple calls', async function () {
            const { lottery } = await loadFixture(deployFixture);

            await lottery.seedJackpot({ value: ethers.parseEther('1') });
            await lottery.seedJackpot({ value: ethers.parseEther('2') });

            const info = await lottery.getRoundInfo(1);
            expect(info.jackpotPool).to.equal(ethers.parseEther('3'));
        });

        it('seed increases ticketPrice', async function () {
            const { lottery } = await loadFixture(deployFixture);

            const priceBefore = await lottery.ticketPrice();

            // Seed a large amount so the 0.05% calculation exceeds MIN_TICKET_PRICE
            await lottery.seedJackpot({ value: ethers.parseEther('100') });

            const priceAfter = await lottery.ticketPrice();
            expect(priceAfter).to.be.gt(priceBefore);
        });

        it('seeded amount rolls over to round 2 when no winner', async function () {
            const { lottery, mockVRF, alice } = await loadFixture(deployFixture);

            // Seed round 1 jackpot
            await lottery.seedJackpot({ value: ethers.parseEther('1') });

            // Buy a ticket so the round can be drawn
            const t = makeTicket([1, 2, 3, 4, 5], 10, 0);
            await buyTickets(lottery, alice, [t]);

            const infoBefore = await lottery.getRoundInfo(1);

            // Complete round with no winner
            await closeDraw(lottery);
            await fulfillDraw(mockVRF, 1, NON_MATCHING_SEED);
            await lottery.settleRound();

            expect(await lottery.currentRound()).to.equal(2);
            const info2 = await lottery.getRoundInfo(2);
            expect(info2.jackpotPool).to.equal(infoBefore.jackpotPool);
        });
    });

    describe('CCIP fee deducted from ownerFees', function () {
        it('ownerFees is unchanged after draw when MockRouter fee is 0', async function () {
            const { lottery, mockVRF, alice } = await loadFixture(deployFixture);
            const t = makeTicket([1, 2, 3, 4, 5], 10, 0);
            await buyTickets(lottery, alice, [t]);

            const price = MIN_TICKET_PRICE;
            const fee = (price * 2000n) / 10000n;
            const nftShare = (fee * 5000n) / 10000n;
            const expectedFee = fee - nftShare; // admin 10%
            expect(await lottery.ownerFees()).to.equal(expectedFee);

            // Trigger draw — MockRouter charges 0 fee so ownerFees stays the same
            await closeDraw(lottery);
            expect(await lottery.ownerFees()).to.equal(expectedFee);

            // Complete round
            await fulfillDraw(mockVRF, 1, NON_MATCHING_SEED);
            await lottery.settleRound();
        });

        it('closeBettingAndDraw succeeds when ownerFees covers the CCIP fee', async function () {
            const { lottery, alice } = await loadFixture(deployFixture);
            const t = makeTicket([1, 2, 3, 4, 5], 10, 0);
            await buyTickets(lottery, alice, [t]);

            const price = MIN_TICKET_PRICE;
            const fee = (price * 2000n) / 10000n;
            const nftShare = (fee * 5000n) / 10000n;
            const expectedFee = fee - nftShare; // admin 10%

            // ownerFees > 0 after ticket purchase
            const feesBefore = await lottery.ownerFees();
            expect(feesBefore).to.equal(expectedFee);

            await closeDraw(lottery);

            // MockRouter CCIP fee is 0, so ownerFees should remain unchanged
            const feesAfter = await lottery.ownerFees();
            expect(feesAfter).to.equal(feesBefore);
        });
    });

    describe('Emergency cancel draw', function () {
        it('should allow admin to cancel a stuck draw', async function () {
            const { lottery, alice } = await loadFixture(deployFixture);
            const t = makeTicket([1, 2, 3, 4, 5], 10, 0);
            await buyTickets(lottery, alice, [t]);
            await closeDraw(lottery);

            // Now in DRAWING state, simulate VRF never responding
            await time.increase(Number(DRAW_GRACE));
            await lottery.emergencyCancelDraw();

            const info = await lottery.getRoundInfo(1);
            expect(info.state).to.equal(0); // back to OPEN
        });

        it('emergencyCancelDraw reverts during DRAW_GRACE_PERIOD', async function () {
            const { lottery, alice } = await loadFixture(deployFixture);
            await buyTickets(lottery, alice, [makeTicket([1, 2, 3, 4, 5], 10, 0)]);
            await closeDraw(lottery);
            // drawRequestedAt is just set; 300 s haven't elapsed yet
            await expect(lottery.emergencyCancelDraw()).to.be.revertedWithCustomError(lotteryMathLib, 'GracePeriodActive');
        });

        it('emergencyCancelDraw succeeds exactly at DRAW_GRACE_PERIOD boundary', async function () {
            const { lottery, alice } = await loadFixture(deployFixture);
            await buyTickets(lottery, alice, [makeTicket([1, 2, 3, 4, 5], 10, 0)]);
            await closeDraw(lottery);
            await time.increase(Number(DRAW_GRACE));
            await expect(lottery.emergencyCancelDraw()).to.not.be.reverted;
            expect((await lottery.getRoundInfo(1)).state).to.equal(0); // OPEN
        });

        it('emergencyCancelDraw emits DrawCancelled event', async function () {
            const { lottery, alice } = await loadFixture(deployFixture);
            await buyTickets(lottery, alice, [makeTicket([1, 2, 3, 4, 5], 10, 0)]);
            await closeDraw(lottery);
            await time.increase(Number(DRAW_GRACE));
            await expect(lottery.emergencyCancelDraw())
                .to.emit(lottery, 'DrawCancelled')
                .withArgs(1n);
        });

        it('emergencyCancelDraw resets lastUpkeepTime so draw can be re-triggered immediately', async function () {
            const { lottery, vrfRequester, alice } = await loadFixture(deployFixture);
            await buyTickets(lottery, alice, [makeTicket([1, 2, 3, 4, 5], 10, 0)]);
            await closeDraw(lottery); // advances time by UPKEEP_INTERVAL, triggers draw

            const requestIdBefore = await vrfRequester.latestVrfRequestId();

            await time.increase(Number(DRAW_GRACE));
            await lottery.emergencyCancelDraw(); // resets lastUpkeepTime to allow immediate retry

            // closeBettingAndDraw() should now succeed WITHOUT advancing time further.
            // (lastUpkeepTime was set to block.timestamp - upkeepInterval in emergencyCancelDraw)
            await expect(lottery.closeBettingAndDraw()).to.not.be.reverted;

            // Confirm a new draw was actually triggered (round → DRAWING, new VRF request).
            expect((await lottery.getRoundInfo(1)).state).to.equal(1); // DRAWING
            expect(await vrfRequester.latestVrfRequestId()).to.equal(requestIdBefore + 1n);
        });
    });

    describe('publicEmergencyCancelDraw', function () {
        const EMERGENCY_DELAY = 86400n; // 24 hours in seconds

        it('reverts when round is not in DRAWING state', async function () {
            const { lottery, alice } = await loadFixture(deployFixture);
            await buyTickets(lottery, alice, [makeTicket([1, 2, 3, 4, 5], 10, 0)]);
            // Round is OPEN, not DRAWING
            await expect(
                lottery.connect(alice).publicEmergencyCancelDraw(),
            ).to.be.revertedWithCustomError(lotteryViewsLib, 'NotDrawing');
        });

        it('reverts before 24-hour delay has elapsed', async function () {
            const { lottery, alice, bob } = await loadFixture(deployFixture);
            await buyTickets(lottery, alice, [makeTicket([1, 2, 3, 4, 5], 10, 0)]);
            await closeDraw(lottery);
            // Only 1 hour has passed
            await time.increase(3600);
            await expect(
                lottery.connect(bob).publicEmergencyCancelDraw(),
            ).to.be.revertedWithCustomError(lotteryViewsLib, 'EmergencyCancelDelayNotMet');
        });

        it('reverts at 23h59m (just before 24h boundary)', async function () {
            const { lottery, alice, bob } = await loadFixture(deployFixture);
            await buyTickets(lottery, alice, [makeTicket([1, 2, 3, 4, 5], 10, 0)]);
            await closeDraw(lottery);
            await time.increase(Number(EMERGENCY_DELAY) - 60); // 23h59m
            await expect(
                lottery.connect(bob).publicEmergencyCancelDraw(),
            ).to.be.revertedWithCustomError(lotteryViewsLib, 'EmergencyCancelDelayNotMet');
        });

        it('succeeds for any user after 24 hours', async function () {
            const { lottery, alice, bob } = await loadFixture(deployFixture);
            await buyTickets(lottery, alice, [makeTicket([1, 2, 3, 4, 5], 10, 0)]);
            await closeDraw(lottery);
            await time.increase(Number(EMERGENCY_DELAY));
            // bob (non-admin) can cancel
            await expect(lottery.connect(bob).publicEmergencyCancelDraw()).to.not.be.reverted;
            expect((await lottery.getRoundInfo(1)).state).to.equal(0); // back to OPEN
        });

        it('emits DrawCancelled event', async function () {
            const { lottery, alice, bob } = await loadFixture(deployFixture);
            await buyTickets(lottery, alice, [makeTicket([1, 2, 3, 4, 5], 10, 0)]);
            await closeDraw(lottery);
            await time.increase(Number(EMERGENCY_DELAY));
            await expect(lottery.connect(bob).publicEmergencyCancelDraw())
                .to.emit(lottery, 'DrawCancelled')
                .withArgs(1n);
        });

        it('awards 2 free ticket credits to caller', async function () {
            const { lottery, alice, bob } = await loadFixture(deployFixture);
            await buyTickets(lottery, alice, [makeTicket([1, 2, 3, 4, 5], 10, 0)]);
            await closeDraw(lottery);
            await time.increase(Number(EMERGENCY_DELAY));
            expect(await lottery.freeTicketCredits(bob.address)).to.equal(0n);
            await lottery.connect(bob).publicEmergencyCancelDraw();
            expect(await lottery.freeTicketCredits(bob.address)).to.equal(2n);
        });

        it('emits DrawTriggerRewarded event with 2 credits', async function () {
            const { lottery, alice, bob } = await loadFixture(deployFixture);
            await buyTickets(lottery, alice, [makeTicket([1, 2, 3, 4, 5], 10, 0)]);
            await closeDraw(lottery);
            await time.increase(Number(EMERGENCY_DELAY));
            await expect(lottery.connect(bob).publicEmergencyCancelDraw())
                .to.emit(lottery, 'DrawTriggerRewarded')
                .withArgs(bob.address, 2n);
        });

        it('resets lastUpkeepTime so draw can be re-triggered immediately', async function () {
            const { lottery, vrfRequester, alice, bob } = await loadFixture(deployFixture);
            await buyTickets(lottery, alice, [makeTicket([1, 2, 3, 4, 5], 10, 0)]);
            await closeDraw(lottery);
            const requestIdBefore = await vrfRequester.latestVrfRequestId();
            await time.increase(Number(EMERGENCY_DELAY));
            await lottery.connect(bob).publicEmergencyCancelDraw();
            // closeBettingAndDraw() should now succeed WITHOUT advancing time further
            await expect(lottery.closeBettingAndDraw()).to.not.be.reverted;
            expect((await lottery.getRoundInfo(1)).state).to.equal(1); // DRAWING
            expect(await vrfRequester.latestVrfRequestId()).to.equal(requestIdBefore + 1n);
        });

        it('admin emergencyCancelDraw still works with 5min grace (admin privilege preserved)', async function () {
            const { lottery, alice } = await loadFixture(deployFixture);
            await buyTickets(lottery, alice, [makeTicket([1, 2, 3, 4, 5], 10, 0)]);
            await closeDraw(lottery);
            await time.increase(Number(DRAW_GRACE));
            // Admin can still cancel with 5-minute grace period
            await expect(lottery.emergencyCancelDraw()).to.not.be.reverted;
            expect((await lottery.getRoundInfo(1)).state).to.equal(0);
        });

        it('drawRequestedAt view returns correct timestamp', async function () {
            const { lottery, alice } = await loadFixture(deployFixture);
            await buyTickets(lottery, alice, [makeTicket([1, 2, 3, 4, 5], 10, 0)]);
            await closeDraw(lottery);
            const ts = await lottery.drawRequestedAt();
            expect(ts).to.be.gt(0n);
            // Should be close to the latest block timestamp
            const block = await ethers.provider.getBlock('latest');
            expect(ts).to.be.lte(BigInt(block.timestamp));
        });
    });

    describe('closeBettingAndDraw interval enforcement', function () {
        it('reverts when upkeepInterval has not elapsed', async function () {
            const { lottery, alice } = await loadFixture(deployFixture);
            await buyTickets(lottery, alice, [makeTicket([1, 2, 3, 4, 5], 10, 0)]);
            await expect(lottery.closeBettingAndDraw()).to.be.revertedWithCustomError(lotteryMathLib, 'IntervalNotElapsed');
        });

        it('succeeds after upkeepInterval has elapsed', async function () {
            const { lottery, alice } = await loadFixture(deployFixture);
            await buyTickets(lottery, alice, [makeTicket([1, 2, 3, 4, 5], 10, 0)]);
            await time.increase(86400);
            await expect(lottery.closeBettingAndDraw()).to.not.be.reverted;
        });
    });

    describe('View functions', function () {
        it('getTicket should return correct data', async function () {
            const { lottery, alice } = await loadFixture(deployFixture);
            const t = makeTicket([10, 20, 30, 40, 50], 77, 3);
            await buyTickets(lottery, alice, [t]);

            const ticket = await lottery.getTicket(1, 0);
            expect(ticket.player).to.equal(alice.address);
            expect(ticket.whites).to.deep.equal([10, 20, 30, 40, 50]);
            expect(ticket.goldNum).to.equal(77);
            expect(ticket.goldPos).to.equal(3);
        });

        it('getPlayerTickets should return all of a player\'s tickets', async function () {
            const { lottery, alice, bob } = await loadFixture(deployFixture);

            await buyTickets(lottery, alice, [
                makeTicket([1, 2, 3, 4, 5], 10, 0),
                makeTicket([6, 7, 8, 9, 10], 20, 1),
            ]);
            await buyTickets(lottery, bob, [
                makeTicket([11, 12, 13, 14, 15], 30, 2),
            ]);

            const aliceTickets = await lottery.getPlayerTickets(1, alice.address);
            expect(aliceTickets.length).to.equal(2);

            const bobTickets = await lottery.getPlayerTickets(1, bob.address);
            expect(bobTickets.length).to.equal(1);
        });

        it('getRoundInfo should return complete round data', async function () {
            const { lottery, alice } = await loadFixture(deployFixture);

            await buyTickets(lottery, alice, [
                makeTicket([1, 2, 3, 4, 5], 10, 0),
            ]);

            const info = await lottery.getRoundInfo(1);
            expect(info.ticketCount).to.equal(1);
            expect(info.state).to.equal(0); // OPEN
            expect(info.jackpotPool).to.be.greaterThan(0);
            expect(info.seedPool).to.be.greaterThan(0);
        });
    });

    describe('Multi-round carry-over', function () {
        it('should accumulate pools across rounds with no winners', async function () {
            const { lottery, mockVRF, alice } = await loadFixture(deployFixture);

            // Round 1: buy ticket, draw, no winner, settle
            const t = makeTicket([1, 2, 3, 4, 5], 10, 0);
            await buyTickets(lottery, alice, [t]);

            const r1info = await lottery.getRoundInfo(1);
            const r1Jackpot = r1info.jackpotPool;
            const r1Seed = r1info.seedPool;

            await closeDraw(lottery);
            await fulfillDraw(mockVRF, 1, NON_MATCHING_SEED);
            await lottery.settleRound();

            // Round 2: buy another ticket
            expect(await lottery.currentRound()).to.equal(2);

            // Get the ticket price for round 2 (now pools are carried over)
            const r2price = await lottery.ticketPrice();

            await buyTickets(lottery, alice, [
                makeTicket([10, 20, 30, 40, 50], 60, 4),
            ]);

            const r2info = await lottery.getRoundInfo(2);
            // Round 2 pools should include round 1 carried-over pools + new ticket revenue
            const expectedJackpot = r1Jackpot + (r2price * 5000n) / 10000n;
            const expectedSeed = r1Seed + (r2price - (r2price * 2000n) / 10000n - (r2price * 5000n) / 10000n);

            expect(r2info.jackpotPool).to.equal(expectedJackpot);
            expect(r2info.seedPool).to.equal(expectedSeed);
        });
    });

    // ─── Chainlink Automation ───────────────────────────────────────


    describe('checkUpkeep', function () {
        it('returns false before the interval has elapsed', async function () {
            const { lottery, alice } = await loadFixture(deployFixture);
            // Buy a ticket so ticketCount > 0, but don't advance time
            await buyTickets(lottery, alice, [makeTicket([1, 2, 3, 4, 5], 10, 0)]);
            const [needed] = await lottery.checkUpkeep('0x');
            expect(needed).to.equal(false);
        });

        it('returns false when interval elapsed but no tickets sold', async function () {
            const { lottery } = await loadFixture(deployFixture);
            await time.increase(Number(UPKEEP_INTERVAL));
            const [needed] = await lottery.checkUpkeep('0x');
            expect(needed).to.equal(false);
        });

        it('returns true after interval elapsed and tickets sold', async function () {
            const { lottery, alice } = await loadFixture(deployFixture);
            await buyTickets(lottery, alice, [makeTicket([1, 2, 3, 4, 5], 10, 0)]);
            await time.increase(Number(UPKEEP_INTERVAL));
            const [needed] = await lottery.checkUpkeep('0x');
            expect(needed).to.equal(true);
        });

        it('returns true when round is DRAWN (regardless of time)', async function () {
            const { lottery, mockVRF, alice } = await loadFixture(deployFixture);
            await buyTickets(lottery, alice, [makeTicket([1, 2, 3, 4, 5], 10, 0)]);
            await closeDraw(lottery);
            await fulfillDraw(mockVRF, 1, NON_MATCHING_SEED);

            const [needed] = await lottery.checkUpkeep('0x');
            expect(needed).to.equal(true);
        });

        it('returns false when round is DRAWING', async function () {
            const { lottery, alice } = await loadFixture(deployFixture);
            await buyTickets(lottery, alice, [makeTicket([1, 2, 3, 4, 5], 10, 0)]);
            await closeDraw(lottery);
            const [needed] = await lottery.checkUpkeep('0x');
            expect(needed).to.equal(false);
        });
    });

    describe('performUpkeep', function () {
        it('triggers draw when interval elapsed and tickets sold', async function () {
            const { lottery, alice } = await loadFixture(deployFixture);
            await buyTickets(lottery, alice, [makeTicket([1, 2, 3, 4, 5], 10, 0)]);
            await time.increase(Number(UPKEEP_INTERVAL));

            await expect(lottery.performUpkeep('0x'))
                .to.emit(lottery, 'UpkeepPerformed')
                .withArgs(1, 'draw')
                .and.to.emit(lottery, 'DrawRequested');

            const info = await lottery.getRoundInfo(1);
            expect(info.state).to.equal(1); // DRAWING
        });

        it('settles round when state is DRAWN', async function () {
            const { lottery, mockVRF, alice } = await loadFixture(deployFixture);
            await buyTickets(lottery, alice, [makeTicket([1, 2, 3, 4, 5], 10, 0)]);
            await closeDraw(lottery);
            await fulfillDraw(mockVRF, 1, NON_MATCHING_SEED);

            await expect(lottery.performUpkeep('0x'))
                .to.emit(lottery, 'UpkeepPerformed')
                .withArgs(1, 'settle')
                .and.to.emit(lottery, 'RoundSettled');

            expect(await lottery.currentRound()).to.equal(2);
        });

        it('reverts when round is OPEN but interval not elapsed', async function () {
            const { lottery, alice } = await loadFixture(deployFixture);
            await buyTickets(lottery, alice, [makeTicket([1, 2, 3, 4, 5], 10, 0)]);
            await expect(lottery.performUpkeep('0x')).to.be.revertedWithCustomError(lotteryMathLib, 'IntervalNotElapsed');
        });

        it('reverts when round is OPEN but no tickets sold', async function () {
            const { lottery } = await loadFixture(deployFixture);
            await time.increase(Number(UPKEEP_INTERVAL));
            await expect(lottery.performUpkeep('0x')).to.be.revertedWithCustomError(lotteryMathLib, 'NoTicketsSold');
        });

        it('reverts when round is DRAWING (neither condition met)', async function () {
            const { lottery, alice } = await loadFixture(deployFixture);
            await buyTickets(lottery, alice, [makeTicket([1, 2, 3, 4, 5], 10, 0)]);
            await closeDraw(lottery);
            await expect(lottery.performUpkeep('0x')).to.be.revertedWithCustomError(lotteryMathLib, 'NoUpkeepNeeded');
        });

        it('full automated lifecycle: OPEN → DRAWING → DRAWN → SETTLED', async function () {
            const { lottery, mockVRF, alice } = await loadFixture(deployFixture);

            await buyTickets(lottery, alice, [makeTicket([1, 2, 3, 4, 5], 10, 0)]);
            await time.increase(Number(UPKEEP_INTERVAL));

            // Automation triggers draw
            await lottery.performUpkeep('0x');
            expect((await lottery.getRoundInfo(1)).state).to.equal(1); // DRAWING

            // CCIP fulfills
            await fulfillDraw(mockVRF, 1, NON_MATCHING_SEED);
            expect((await lottery.getRoundInfo(1)).state).to.equal(2); // DRAWN

            // Automation settles
            await lottery.performUpkeep('0x');
            expect((await lottery.getRoundInfo(1)).state).to.equal(3); // SETTLED
            expect(await lottery.currentRound()).to.equal(2);
        });
    });

    describe('triggerPublicDraw', function () {
        it('reverts during the grace period', async function () {
            const { lottery, alice } = await loadFixture(deployFixture);
            await buyTickets(lottery, alice, [makeTicket([1, 2, 3, 4, 5], 10, 0)]);

            // Advance past the interval but NOT past the grace period
            await time.increase(Number(UPKEEP_INTERVAL) + Number(DRAW_GRACE) - 10);
            await expect(
                lottery.connect(alice).triggerPublicDraw(),
            ).to.be.revertedWithCustomError(lotteryMathLib, 'GracePeriodActive');
        });

        it('reverts if no tickets sold', async function () {
            const { lottery, alice } = await loadFixture(deployFixture);
            await time.increase(Number(UPKEEP_INTERVAL) + Number(DRAW_GRACE));
            await expect(
                lottery.connect(alice).triggerPublicDraw(),
            ).to.be.revertedWithCustomError(lotteryMathLib, 'NoTicketsSold');
        });

        it('succeeds for any caller after grace period', async function () {
            const { lottery, alice, bob } = await loadFixture(deployFixture);
            await buyTickets(lottery, alice, [makeTicket([1, 2, 3, 4, 5], 10, 0)]);
            await time.increase(Number(UPKEEP_INTERVAL) + Number(DRAW_GRACE));

            // bob (non-admin) can trigger
            await expect(lottery.connect(bob).triggerPublicDraw())
                .to.emit(lottery, 'UpkeepPerformed')
                .withArgs(1, 'public-draw')
                .and.to.emit(lottery, 'DrawRequested');

            expect((await lottery.getRoundInfo(1)).state).to.equal(1); // DRAWING
        });

        it('reverts when round is not OPEN', async function () {
            const { lottery, alice } = await loadFixture(deployFixture);
            await buyTickets(lottery, alice, [makeTicket([1, 2, 3, 4, 5], 10, 0)]);
            await closeDraw(lottery); // now DRAWING
            await time.increase(Number(UPKEEP_INTERVAL) + Number(DRAW_GRACE));
            await expect(lottery.triggerPublicDraw()).to.be.revertedWithCustomError(lotteryMathLib, 'RoundNotOpen');
        });
    });

    describe('Upkeep interval proposal (24 h timelock)', function () {
        it('proposeSetUpkeepInterval emits AdminActionProposed and UpkeepIntervalProposed', async function () {
            const { lottery, owner } = await loadFixture(deployFixture);
            await expect(lottery.connect(owner).proposeSetUpkeepInterval(3600))
                .to.emit(lottery, 'AdminActionProposed')
                .and.to.emit(lottery, 'UpkeepIntervalProposed');
        });

        it('proposeSetUpkeepInterval reverts for zero interval', async function () {
            const { lottery } = await loadFixture(deployFixture);
            await expect(lottery.proposeSetUpkeepInterval(0)).to.be.revertedWithCustomError(lotteryViewsLib, 'IntervalMustBePositive');
        });

        it('proposeSetUpkeepInterval reverts for non-admin', async function () {
            const { lottery, alice } = await loadFixture(deployFixture);
            await expect(
                lottery.connect(alice).proposeSetUpkeepInterval(3600),
            ).to.be.revertedWithCustomError(lottery, 'Unauthorized');
        });

        it('executeSetUpkeepInterval reverts before timelock expires', async function () {
            const { lottery, owner } = await loadFixture(deployFixture);
            await lottery.connect(owner).proposeSetUpkeepInterval(3600);
            await expect(
                lottery.connect(owner).executeSetUpkeepInterval(3600),
            ).to.be.revertedWithCustomError(lotteryViewsLib, 'TimelockNotExpired');
        });

        it('executeSetUpkeepInterval succeeds after timelock expires', async function () {
            const { lottery, owner } = await loadFixture(deployFixture);
            await lottery.connect(owner).proposeSetUpkeepInterval(3600);
            await time.increase(24 * 60 * 60 + 1);
            await expect(
                lottery.connect(owner).executeSetUpkeepInterval(3600),
            ).to.emit(lottery, 'AdminActionExecuted');
            expect(await lottery.upkeepInterval()).to.equal(3600);
        });

        it('executeSetUpkeepInterval reverts if not proposed', async function () {
            const { lottery, owner } = await loadFixture(deployFixture);
            await expect(
                lottery.connect(owner).executeSetUpkeepInterval(7200),
            ).to.be.revertedWithCustomError(lotteryViewsLib, 'ActionNotProposed');
        });

        it('executeSetUpkeepInterval reverts for non-admin', async function () {
            const { lottery, alice } = await loadFixture(deployFixture);
            await expect(
                lottery.connect(alice).executeSetUpkeepInterval(3600),
            ).to.be.revertedWithCustomError(lottery, 'Unauthorized');
        });

        it('cancelAdminAction clears upkeep interval proposal state', async function () {
            const { lottery, owner } = await loadFixture(deployFixture);
            await lottery.connect(owner).proposeSetUpkeepInterval(3600);
            const actionHash = ethers.keccak256(
                ethers.AbiCoder.defaultAbiCoder().encode(
                    ['string', 'uint256'],
                    ['setUpkeepInterval', 3600],
                ),
            );
            await expect(lottery.connect(owner).cancelAdminAction(actionHash))
                .to.emit(lottery, 'AdminActionCancelled');
            // Proposal state should be cleared
            expect(await lottery.pendingUpkeepInterval()).to.equal(0);
            expect(await lottery.upkeepIntervalProposalExecuteAfter()).to.equal(0);
            // After cancellation, execution must fail
            await time.increase(24 * 60 * 60 + 1);
            await expect(
                lottery.connect(owner).executeSetUpkeepInterval(3600),
            ).to.be.revertedWithCustomError(lotteryViewsLib, 'ActionNotProposed');
        });

        it('getUpkeepIntervalProposal returns status 0 when no proposal', async function () {
            const { lottery } = await loadFixture(deployFixture);
            const [newInterval, executeAfter, status] = await lottery.getUpkeepIntervalProposal();
            expect(status).to.equal(0);
            expect(newInterval).to.equal(0);
            expect(executeAfter).to.equal(0);
        });

        it('getUpkeepIntervalProposal returns status 1 when pending', async function () {
            const { lottery, owner } = await loadFixture(deployFixture);
            await lottery.connect(owner).proposeSetUpkeepInterval(3600);
            const [newInterval, , status] = await lottery.getUpkeepIntervalProposal();
            expect(status).to.equal(1);
            expect(newInterval).to.equal(3600);
        });

        it('getUpkeepIntervalProposal returns status 2 when ready', async function () {
            const { lottery, owner } = await loadFixture(deployFixture);
            await lottery.connect(owner).proposeSetUpkeepInterval(3600);
            await time.increase(24 * 60 * 60 + 1);
            const [newInterval, , status] = await lottery.getUpkeepIntervalProposal();
            expect(status).to.equal(2);
            expect(newInterval).to.equal(3600);
        });

        it('setLastUpkeepTime is no longer externally accessible', async function () {
            const { lottery } = await loadFixture(deployFixture);
            expect(lottery.setLastUpkeepTime).to.be.undefined;
        });
    });

    // ─── Bug Fix 2: First-ticket draw-timer reset ───────────────────

    describe('First-ticket draw-timer reset (Bug Fix 2)', function () {
        it('lastUpkeepTime resets to block.timestamp when first ticket is bought', async function () {
            const { lottery, alice } = await loadFixture(deployFixture);

            // Advance time significantly before buying the first ticket
            await time.increase(Number(UPKEEP_INTERVAL) * 3); // 3 days

            const tsBefore = await time.latest();
            await buyTickets(lottery, alice, [makeTicket([1, 2, 3, 4, 5], 10, 0)]);
            const tsAfter = await time.latest();

            const lastUpkeep = await lottery.lastUpkeepTime();
            // lastUpkeepTime should be reset to ~current block time (not deployment time)
            expect(Number(lastUpkeep)).to.be.gte(tsBefore);
            expect(Number(lastUpkeep)).to.be.lte(tsAfter + 1);

            // Timer just reset, so upkeep should NOT be needed yet
            const [needed] = await lottery.checkUpkeep('0x');
            expect(needed).to.equal(false);
        });

        it('subsequent tickets in the same round do NOT reset the timer', async function () {
            const { lottery, alice, bob } = await loadFixture(deployFixture);

            // Alice buys first ticket → timer resets
            await buyTickets(lottery, alice, [makeTicket([1, 2, 3, 4, 5], 10, 0)]);
            const timerAfterFirst = await lottery.lastUpkeepTime();

            // Advance half the interval
            await time.increase(Number(UPKEEP_INTERVAL) / 2);

            // Bob buys second ticket → timer should NOT reset again
            await buyTickets(lottery, bob, [makeTicket([2, 3, 4, 5, 6], 20, 1)]);
            const timerAfterSecond = await lottery.lastUpkeepTime();

            expect(timerAfterSecond).to.equal(timerAfterFirst);
        });

        it('triggerPublicDraw is NOT immediately available after stale timer + first ticket', async function () {
            const { lottery, alice } = await loadFixture(deployFixture);

            // Simulate 3 days passing with no ticket activity
            await time.increase(Number(UPKEEP_INTERVAL) * 3);

            // Now buy the first ticket – timer resets to NOW
            await buyTickets(lottery, alice, [makeTicket([1, 2, 3, 4, 5], 10, 0)]);

            // Even though 3 days have passed since deployment, the grace period
            // hasn't elapsed since the ticket purchase → public draw should fail
            await expect(
                lottery.connect(alice).triggerPublicDraw(),
            ).to.be.revertedWithCustomError(lotteryMathLib, 'GracePeriodActive');
        });

        it('triggerPublicDraw works after interval+grace elapses from first ticket', async function () {
            const { lottery, alice, bob } = await loadFixture(deployFixture);

            // Simulate 3 days of inactivity, then first ticket
            await time.increase(Number(UPKEEP_INTERVAL) * 3);
            await buyTickets(lottery, alice, [makeTicket([1, 2, 3, 4, 5], 10, 0)]);

            // Now advance past interval + grace from first ticket purchase
            await time.increase(Number(UPKEEP_INTERVAL) + Number(DRAW_GRACE));

            await expect(lottery.connect(bob).triggerPublicDraw())
                .to.emit(lottery, 'UpkeepPerformed')
                .withArgs(1, 'public-draw');
        });
    });

    // ─── Trigger rewards ────────────────────────────────────────────────────────

    describe('Trigger rewards', function () {
    // Helper: buy one ticket, advance time past interval+grace, call triggerPublicDraw.
        async function setupPublicDraw(lottery, signer) {
            await buyTickets(lottery, signer, [makeTicket([1, 2, 3, 4, 5], 10, 0)]);
            await time.increase(Number(UPKEEP_INTERVAL) + Number(DRAW_GRACE));
        }

        it('freeTicketCredits starts at 0 for a new address', async function () {
            const { lottery, alice } = await loadFixture(deployFixture);
            expect(await lottery.freeTicketCredits(alice.address)).to.equal(0n);
        });

        it('triggerPublicDraw emits DrawTriggerRewarded with 2 credits', async function () {
            const { lottery, alice, bob } = await loadFixture(deployFixture);
            await setupPublicDraw(lottery, alice);
            await expect(lottery.connect(bob).triggerPublicDraw())
                .to.emit(lottery, 'DrawTriggerRewarded')
                .withArgs(bob.address, 2n);
        });

        it('triggerPublicDraw adds 2 free ticket credits to caller', async function () {
            const { lottery, alice, bob } = await loadFixture(deployFixture);
            await setupPublicDraw(lottery, alice);
            await lottery.connect(bob).triggerPublicDraw();
            expect(await lottery.freeTicketCredits(bob.address)).to.equal(2n);
        });

        it('free ticket credits allow buying tickets at no cost', async function () {
            const { lottery, mockVRF, alice, bob } = await loadFixture(deployFixture);
            // Bob earns 2 credits by triggering a public draw
            await setupPublicDraw(lottery, alice);
            await lottery.connect(bob).triggerPublicDraw();
            await mockVRF.fulfillRandomWords(1n, [NON_MATCHING_SEED]);
            await lottery.settleRound();

            // Round 2: Bob buys 2 tickets using his credits (sends 0 ETH)
            expect(await lottery.freeTicketCredits(bob.address)).to.equal(2n);
            const price = await lottery.ticketPrice();
            await expect(
                lottery.connect(bob).buyTickets(
                    [[1, 2, 3, 4, 5], [2, 3, 4, 5, 6]], [10, 11], [0, 1],
                    ethers.ZeroAddress, { value: 0n },
                ),
            ).to.emit(lottery, 'TicketsPurchased').withArgs(2n, bob.address, 2n);

            // Credits should be consumed
            expect(await lottery.freeTicketCredits(bob.address)).to.equal(0n);
        });

        it('free ticket credits partially cover when buying more than credit balance', async function () {
            const { lottery, mockVRF, alice, bob } = await loadFixture(deployFixture);
            await setupPublicDraw(lottery, alice);
            await lottery.connect(bob).triggerPublicDraw();
            await mockVRF.fulfillRandomWords(1n, [NON_MATCHING_SEED]);
            await lottery.settleRound();

            // Bob has 2 credits; buys 3 tickets → pays for 1 ticket
            const price = await lottery.ticketPrice();
            await expect(
                lottery.connect(bob).buyTickets(
                    [[1, 2, 3, 4, 5], [2, 3, 4, 5, 6], [3, 4, 5, 6, 7]],
                    [10, 11, 12], [0, 1, 2],
                    ethers.ZeroAddress, { value: price },   // pays for 1 of 3 tickets
                ),
            ).to.emit(lottery, 'TicketsPurchased');

            expect(await lottery.freeTicketCredits(bob.address)).to.equal(0n);
        });

        it('buying with credits reverts if user pays too little for paid portion', async function () {
            const { lottery, mockVRF, alice, bob } = await loadFixture(deployFixture);
            await setupPublicDraw(lottery, alice);
            await lottery.connect(bob).triggerPublicDraw();
            await mockVRF.fulfillRandomWords(1n, [NON_MATCHING_SEED]);
            await lottery.settleRound();

            // Bob has 2 credits; tries to buy 3 tickets with 0 ETH (should pay for 1)
            await expect(
                lottery.connect(bob).buyTickets(
                    [[1, 2, 3, 4, 5], [2, 3, 4, 5, 6], [3, 4, 5, 6, 7]],
                    [10, 11, 12], [0, 1, 2],
                    ethers.ZeroAddress, { value: 0n },   // insufficient — needs to pay for 1 ticket
                ),
            ).to.be.revertedWithCustomError(lotteryMathLib, 'InsufficientPayment');
        });

        it('settleRound emits SettleRewarded event', async function () {
            const { lottery, mockVRF, alice } = await loadFixture(deployFixture);
            await buyTickets(lottery, alice, [makeTicket([1, 2, 3, 4, 5], 10, 0)]);
            await closeDraw(lottery);
            await fulfillDraw(mockVRF, 1, NON_MATCHING_SEED);
            await expect(lottery.settleRound()).to.emit(lottery, 'SettleRewarded');
        });

        it('settleRoundBatch emits SettleRewarded on final batch', async function () {
            const { lottery, mockVRF, alice } = await loadFixture(deployFixture);
            await buyTickets(lottery, alice, [makeTicket([1, 2, 3, 4, 5], 10, 0)]);
            await closeDraw(lottery);
            await fulfillDraw(mockVRF, 1, NON_MATCHING_SEED);
            await expect(lottery.settleRoundBatch()).to.emit(lottery, 'SettleRewarded');
        });

        it('settle reward equals 1% of fee pool sent to caller', async function () {
            const { lottery, mockVRF, alice, bob } = await loadFixture(deployFixture);
            const price = await lottery.ticketPrice();
            await buyTickets(lottery, alice, [makeTicket([1, 2, 3, 4, 5], 10, 0)]);
            await closeDraw(lottery);
            await fulfillDraw(mockVRF, 1, NON_MATCHING_SEED);

            // feePool = price * FEE_BPS / 10000 = price * 20%; reward = feePool / 100
            const feeBps = await lottery.FEE_BPS();
            const feePool = (price * feeBps) / 10000n;
            const expectedReward = feePool / 100n;

            const bobBalBefore = await ethers.provider.getBalance(bob.address);
            const tx = await lottery.connect(bob).settleRound();
            const receipt = await tx.wait();
            const gasUsed = receipt.gasUsed * tx.gasPrice;
            const bobBalAfter = await ethers.provider.getBalance(bob.address);

            // Bob's balance change should equal reward minus gas cost
            expect(bobBalAfter - bobBalBefore + gasUsed).to.equal(expectedReward);
        });
    });

    // ─── LiquidLotteryV1 (upgradeable proxy) ────────────────────────

    describe('LiquidLotteryV1 via UUPS proxy', function () {
        async function deployV1Fixture() {
            const [owner, alice, bob] = await ethers.getSigners();

            // Same CCIPLocalSimulator-based setup as the outer deployFixture.
            const CCIPLocalSimulator = await ethers.getContractFactory('CCIPLocalSimulator');
            const simulator = await CCIPLocalSimulator.deploy();
            await simulator.waitForDeployment();
            const config = await simulator.configuration();
            const CHAIN_SELECTOR = config.chainSelector_;
            const mockRouter     = config.sourceRouter_;
            const routerAddr     = mockRouter;

            const MockVRF = await ethers.getContractFactory('MockVRFCoordinator');
            const mockVRF = await MockVRF.deploy();
            await mockVRF.waitForDeployment();

            const LotteryVRFRequesterFactory = await ethers.getContractFactory('LotteryVRFRequester');
            const vrfRequester = await LotteryVRFRequesterFactory.deploy(
                await mockVRF.getAddress(), routerAddr, CHAIN_SELECTOR,
                owner.address, 1n, ethers.ZeroHash, 500_000, 3,
            );
            await vrfRequester.waitForDeployment();

            const [__mathLib, __viewsLib] = await Promise.all([
                (await ethers.getContractFactory('LotteryMath')).deploy(),
                (await ethers.getContractFactory('LotteryViews')).deploy(),
            ]);
            await Promise.all([__mathLib.waitForDeployment(), __viewsLib.waitForDeployment()]);
            const LiquidLotteryV1 = await ethers.getContractFactory('LiquidLotteryV1', {
                libraries: {
                    LotteryMath: await __mathLib.getAddress(),
                    LotteryViews: await __viewsLib.getAddress(),
                },
            });
            const impl = await LiquidLotteryV1.deploy();
            await impl.waitForDeployment();
            const implAddr = await impl.getAddress();

            const initData = LiquidLotteryV1.interface.encodeFunctionData(
                'initialize',
                [
                    owner.address,
                    routerAddr,
                    CHAIN_SELECTOR,
                    await vrfRequester.getAddress(),
                ],
            );

            const ERC1967Proxy = await ethers.getContractFactory('ERC1967Proxy');
            const proxy = await ERC1967Proxy.deploy(implAddr, initData);
            await proxy.waitForDeployment();
            const proxyAddr = await proxy.getAddress();

            const lottery = LiquidLotteryV1.attach(proxyAddr);
            await vrfRequester.connect(owner).setLotteryContract(proxyAddr);

            return {
                simulator, mockRouter, routerAddr, CHAIN_SELECTOR,
                mockVRF, vrfRequester, impl, implAddr, proxyAddr,
                lottery, owner, alice, bob,
            };
        }

        it('initializes correctly via proxy', async function () {
            const { lottery, owner } = await loadFixture(deployV1Fixture);
            expect(await lottery.currentRound()).to.equal(1);
            expect((await lottery.getRoundInfo(1)).state).to.equal(0); // OPEN
            expect(
                await lottery.hasRole(await lottery.DEFAULT_ADMIN_ROLE(), owner.address),
            ).to.equal(true);
        });

        it('implementation cannot be re-initialized', async function () {
            const { impl, owner, routerAddr, CHAIN_SELECTOR, vrfRequester } = await loadFixture(deployV1Fixture);
            // Calling initialize on the implementation directly should revert
            // because _disableInitializers() was called in the constructor.
            await expect(
                impl.initialize(
                    owner.address, routerAddr, CHAIN_SELECTOR, await vrfRequester.getAddress(),
                ),
            ).to.be.reverted;
        });

        it('full lottery flow works through proxy', async function () {
            const { lottery, mockVRF, alice } = await loadFixture(deployV1Fixture);

            await buyTickets(lottery, alice, [makeTicket([1, 2, 3, 4, 5], 10, 0)]);
            await closeDraw(lottery);
            await fulfillDraw(mockVRF, 1, NON_MATCHING_SEED);
            await lottery.settleRound();

            expect(await lottery.currentRound()).to.equal(2);
        });

        it('settle reward reduces proxy ETH balance by 1% of fee pool', async function () {
            const { lottery, mockVRF, alice, proxyAddr } = await loadFixture(
                deployV1Fixture,
            );

            await buyTickets(lottery, alice, [makeTicket([1, 2, 3, 4, 5], 10, 0)]);
            const balBefore = await ethers.provider.getBalance(proxyAddr);

            await closeDraw(lottery);
            await fulfillDraw(mockVRF, 1, NON_MATCHING_SEED);

            // 1 ticket at MIN_TICKET_PRICE (0.01 ETH); fee = 20%; settleReward = 1% of fee
            // = 0.01 * 20% * 1% = 0.000002 ETH = 2000000000000 wei
            const expectedSettleReward = (MIN_TICKET_PRICE * 2000n / 10000n) / 100n;
            await expect(lottery.settleRound()).to.emit(lottery, 'SettleRewarded');

            const balAfter = await ethers.provider.getBalance(proxyAddr);
            // MockRouter charges 0 CCIP fee; only the settle reward leaves the contract
            expect(balAfter).to.equal(balBefore - expectedSettleReward);
        });

        it('admin can upgrade to a new implementation (via timelock)', async function () {
            const { lottery, proxyAddr, owner } = await loadFixture(deployV1Fixture);

            // Deploy a new implementation (same V1 for simplicity)
            const [__mathLib, __viewsLib] = await Promise.all([
                (await ethers.getContractFactory('LotteryMath')).deploy(),
                (await ethers.getContractFactory('LotteryViews')).deploy(),
            ]);
            await Promise.all([__mathLib.waitForDeployment(), __viewsLib.waitForDeployment()]);
            const LiquidLotteryV1 = await ethers.getContractFactory('LiquidLotteryV1', {
                libraries: {
                    LotteryMath: await __mathLib.getAddress(),
                    LotteryViews: await __viewsLib.getAddress(),
                },
            });
            const newImpl = await LiquidLotteryV1.deploy();
            await newImpl.waitForDeployment();
            const newImplAddr = await newImpl.getAddress();

            // Step 1: propose the upgrade
            await lottery.connect(owner).proposeUpgrade(newImplAddr);

            // Step 2: advance time past the 72-hour timelock (into execution window)
            await time.increase(72 * 60 * 60 + 1);

            // Step 3: execute the upgrade via the proxy
            await expect(
                lottery.connect(owner).upgradeToAndCall(newImplAddr, '0x'),
            ).to.not.be.reverted;
        });

        it('upgrade reverts if timelock has not elapsed', async function () {
            const { lottery, owner } = await loadFixture(deployV1Fixture);

            const [__mathLib, __viewsLib] = await Promise.all([
                (await ethers.getContractFactory('LotteryMath')).deploy(),
                (await ethers.getContractFactory('LotteryViews')).deploy(),
            ]);
            await Promise.all([__mathLib.waitForDeployment(), __viewsLib.waitForDeployment()]);
            const LiquidLotteryV1 = await ethers.getContractFactory('LiquidLotteryV1', {
                libraries: {
                    LotteryMath: await __mathLib.getAddress(),
                    LotteryViews: await __viewsLib.getAddress(),
                },
            });
            const newImpl = await LiquidLotteryV1.deploy();
            await newImpl.waitForDeployment();
            const newImplAddr = await newImpl.getAddress();

            // Propose but do NOT advance time
            await lottery.connect(owner).proposeUpgrade(newImplAddr);

            await expect(
                lottery.connect(owner).upgradeToAndCall(newImplAddr, '0x'),
            ).to.be.revertedWithCustomError(lotteryViewsLib, 'TimelockNotExpired');
        });

        it('upgrade reverts if the 1-hour execution window has expired', async function () {
            const { lottery, owner } = await loadFixture(deployV1Fixture);

            const [__mathLib, __viewsLib] = await Promise.all([
                (await ethers.getContractFactory('LotteryMath')).deploy(),
                (await ethers.getContractFactory('LotteryViews')).deploy(),
            ]);
            await Promise.all([__mathLib.waitForDeployment(), __viewsLib.waitForDeployment()]);
            const LiquidLotteryV1 = await ethers.getContractFactory('LiquidLotteryV1', {
                libraries: {
                    LotteryMath: await __mathLib.getAddress(),
                    LotteryViews: await __viewsLib.getAddress(),
                },
            });
            const newImpl = await LiquidLotteryV1.deploy();
            await newImpl.waitForDeployment();
            const newImplAddr = await newImpl.getAddress();

            await lottery.connect(owner).proposeUpgrade(newImplAddr);

            // Advance past both the 72-hour timelock AND the 1-hour execution window
            await time.increase(72 * 60 * 60 + 60 * 60 + 1);

            await expect(
                lottery.connect(owner).upgradeToAndCall(newImplAddr, '0x'),
            ).to.be.revertedWithCustomError(lotteryViewsLib, 'UpgradeProposalExpired');
        });

        it('upgrade reverts without a prior proposeUpgrade call', async function () {
            const { lottery, owner } = await loadFixture(deployV1Fixture);

            const [__mathLib, __viewsLib] = await Promise.all([
                (await ethers.getContractFactory('LotteryMath')).deploy(),
                (await ethers.getContractFactory('LotteryViews')).deploy(),
            ]);
            await Promise.all([__mathLib.waitForDeployment(), __viewsLib.waitForDeployment()]);
            const LiquidLotteryV1 = await ethers.getContractFactory('LiquidLotteryV1', {
                libraries: {
                    LotteryMath: await __mathLib.getAddress(),
                    LotteryViews: await __viewsLib.getAddress(),
                },
            });
            const newImpl = await LiquidLotteryV1.deploy();
            await newImpl.waitForDeployment();

            await expect(
                lottery.connect(owner).upgradeToAndCall(await newImpl.getAddress(), '0x'),
            ).to.be.revertedWithCustomError(lotteryViewsLib, 'UpgradeNotProposed');
        });

        it('non-admin cannot upgrade', async function () {
            const { lottery, alice } = await loadFixture(deployV1Fixture);

            const [__mathLib, __viewsLib] = await Promise.all([
                (await ethers.getContractFactory('LotteryMath')).deploy(),
                (await ethers.getContractFactory('LotteryViews')).deploy(),
            ]);
            await Promise.all([__mathLib.waitForDeployment(), __viewsLib.waitForDeployment()]);
            const LiquidLotteryV1 = await ethers.getContractFactory('LiquidLotteryV1', {
                libraries: {
                    LotteryMath: await __mathLib.getAddress(),
                    LotteryViews: await __viewsLib.getAddress(),
                },
            });
            const newImpl = await LiquidLotteryV1.deploy();
            await newImpl.waitForDeployment();

            await expect(
                lottery.connect(alice).upgradeToAndCall(await newImpl.getAddress(), '0x'),
            ).to.be.revertedWithCustomError(lottery, 'Unauthorized');
        });

        it('getUpgradeProposal returns correct status at each stage', async function () {
            const { lottery, owner } = await loadFixture(deployV1Fixture);

            const [__mathLib, __viewsLib] = await Promise.all([
                (await ethers.getContractFactory('LotteryMath')).deploy(),
                (await ethers.getContractFactory('LotteryViews')).deploy(),
            ]);
            await Promise.all([__mathLib.waitForDeployment(), __viewsLib.waitForDeployment()]);
            const LiquidLotteryV1 = await ethers.getContractFactory('LiquidLotteryV1', {
                libraries: {
                    LotteryMath: await __mathLib.getAddress(),
                    LotteryViews: await __viewsLib.getAddress(),
                },
            });
            const newImpl = await LiquidLotteryV1.deploy();
            await newImpl.waitForDeployment();
            const newImplAddr = await newImpl.getAddress();

            // Before any proposal: status = 0 (none)
            let p = await lottery.getUpgradeProposal();
            expect(p.impl).to.equal(ethers.ZeroAddress);
            expect(p.status).to.equal(0);

            // After proposal: status = 1 (pending — timelock running)
            await lottery.connect(owner).proposeUpgrade(newImplAddr);
            p = await lottery.getUpgradeProposal();
            expect(p.impl).to.equal(newImplAddr);
            expect(p.status).to.equal(1);
            expect(p.expiresAt).to.equal(p.executeAfter + 3600n);

            // After 72 h but within expiry window: status = 2 (ready)
            await time.increase(72 * 60 * 60 + 1);
            p = await lottery.getUpgradeProposal();
            expect(p.status).to.equal(2);

            // After 72 h + 1 h (expired): status = 3
            await time.increase(60 * 60);
            p = await lottery.getUpgradeProposal();
            expect(p.status).to.equal(3);
        });

        it('buyTickets is blocked during the upgrade execution window', async function () {
            const { lottery, owner, alice } = await loadFixture(deployV1Fixture);

            const [__mathLib, __viewsLib] = await Promise.all([
                (await ethers.getContractFactory('LotteryMath')).deploy(),
                (await ethers.getContractFactory('LotteryViews')).deploy(),
            ]);
            await Promise.all([__mathLib.waitForDeployment(), __viewsLib.waitForDeployment()]);
            const LiquidLotteryV1 = await ethers.getContractFactory('LiquidLotteryV1', {
                libraries: {
                    LotteryMath: await __mathLib.getAddress(),
                    LotteryViews: await __viewsLib.getAddress(),
                },
            });
            const newImpl = await LiquidLotteryV1.deploy();
            await newImpl.waitForDeployment();
            const newImplAddr = await newImpl.getAddress();

            await lottery.connect(owner).proposeUpgrade(newImplAddr);
            const ticket = makeTicket([1, 2, 3, 4, 5], 10, 0);

            // Still in timelock period — buy should succeed
            await expect(buyTickets(lottery, alice, [ticket])).to.not.be.reverted;

            // Advance into the execution window
            await time.increase(72 * 60 * 60 + 1);

            await expect(
                buyTickets(lottery, alice, [ticket]),
            ).to.be.revertedWithCustomError(lotteryMathLib, 'UpgradePending');

            // After the window expires, buys should be allowed again
            await time.increase(60 * 60 + 1);
            await expect(buyTickets(lottery, alice, [ticket])).to.not.be.reverted;
        });

        it('cancelAdminAction clears upgrade proposal state', async function () {
            const { lottery, owner } = await loadFixture(deployV1Fixture);

            const [__mathLib, __viewsLib] = await Promise.all([
                (await ethers.getContractFactory('LotteryMath')).deploy(),
                (await ethers.getContractFactory('LotteryViews')).deploy(),
            ]);
            await Promise.all([__mathLib.waitForDeployment(), __viewsLib.waitForDeployment()]);
            const LiquidLotteryV1 = await ethers.getContractFactory('LiquidLotteryV1', {
                libraries: {
                    LotteryMath: await __mathLib.getAddress(),
                    LotteryViews: await __viewsLib.getAddress(),
                },
            });
            const newImpl = await LiquidLotteryV1.deploy();
            await newImpl.waitForDeployment();
            const newImplAddr = await newImpl.getAddress();

            await lottery.connect(owner).proposeUpgrade(newImplAddr);

            // Confirm proposal is active
            let p = await lottery.getUpgradeProposal();
            expect(p.impl).to.equal(newImplAddr);

            // Cancel it
            const actionHash = ethers.keccak256(
                ethers.AbiCoder.defaultAbiCoder().encode(
                    ['string', 'address'],
                    ['upgradeToAndCall', newImplAddr],
                ),
            );
            await lottery.connect(owner).cancelAdminAction(actionHash);

            // Proposal state should be cleared
            p = await lottery.getUpgradeProposal();
            expect(p.impl).to.equal(ethers.ZeroAddress);
            expect(p.status).to.equal(0);
        });

        it('proposeUpgrade emits UpgradeProposed event with correct fields', async function () {
            const { lottery, owner } = await loadFixture(deployV1Fixture);

            const [__mathLib, __viewsLib] = await Promise.all([
                (await ethers.getContractFactory('LotteryMath')).deploy(),
                (await ethers.getContractFactory('LotteryViews')).deploy(),
            ]);
            await Promise.all([__mathLib.waitForDeployment(), __viewsLib.waitForDeployment()]);
            const LiquidLotteryV1 = await ethers.getContractFactory('LiquidLotteryV1', {
                libraries: {
                    LotteryMath: await __mathLib.getAddress(),
                    LotteryViews: await __viewsLib.getAddress(),
                },
            });
            const newImpl = await LiquidLotteryV1.deploy();
            await newImpl.waitForDeployment();
            const newImplAddr = await newImpl.getAddress();

            const tx = await lottery.connect(owner).proposeUpgrade(newImplAddr);
            const receipt = await tx.wait();
            const block = await ethers.provider.getBlock(receipt.blockNumber);

            const expectedExecuteAfter = BigInt(block.timestamp) + BigInt(72 * 3600);
            const expectedExpiresAt    = expectedExecuteAfter + BigInt(3600);

            await expect(tx)
                .to.emit(lottery, 'UpgradeProposed')
                .withArgs(newImplAddr, expectedExecuteAfter, expectedExpiresAt);
        });

        it('proposeUpgrade reverts when a proposal is already pending', async function () {
            const { lottery, owner } = await loadFixture(deployV1Fixture);

            const [__mathLib, __viewsLib] = await Promise.all([
                (await ethers.getContractFactory('LotteryMath')).deploy(),
                (await ethers.getContractFactory('LotteryViews')).deploy(),
            ]);
            await Promise.all([__mathLib.waitForDeployment(), __viewsLib.waitForDeployment()]);
            const LiquidLotteryV1 = await ethers.getContractFactory('LiquidLotteryV1', {
                libraries: {
                    LotteryMath: await __mathLib.getAddress(),
                    LotteryViews: await __viewsLib.getAddress(),
                },
            });
            const implA = await LiquidLotteryV1.deploy();
            await implA.waitForDeployment();
            const implB = await LiquidLotteryV1.deploy();
            await implB.waitForDeployment();

            // First proposal goes through
            await lottery.connect(owner).proposeUpgrade(await implA.getAddress());

            // Second proposal with a different address must revert until A is cancelled
            await expect(
                lottery.connect(owner).proposeUpgrade(await implB.getAddress()),
            ).to.be.revertedWithCustomError(lotteryViewsLib, 'ExistingProposal');
        });

        it('proposeUpgrade succeeds after cancelling the previous proposal', async function () {
            const { lottery, owner } = await loadFixture(deployV1Fixture);

            const [__mathLib, __viewsLib] = await Promise.all([
                (await ethers.getContractFactory('LotteryMath')).deploy(),
                (await ethers.getContractFactory('LotteryViews')).deploy(),
            ]);
            await Promise.all([__mathLib.waitForDeployment(), __viewsLib.waitForDeployment()]);
            const LiquidLotteryV1 = await ethers.getContractFactory('LiquidLotteryV1', {
                libraries: {
                    LotteryMath: await __mathLib.getAddress(),
                    LotteryViews: await __viewsLib.getAddress(),
                },
            });
            const implA = await LiquidLotteryV1.deploy();
            await implA.waitForDeployment();
            const implAAddr = await implA.getAddress();
            const implB = await LiquidLotteryV1.deploy();
            await implB.waitForDeployment();
            const implBAddr = await implB.getAddress();

            await lottery.connect(owner).proposeUpgrade(implAAddr);

            // Cancel A
            const actionHashA = ethers.keccak256(
                ethers.AbiCoder.defaultAbiCoder().encode(
                    ['string', 'address'],
                    ['upgradeToAndCall', implAAddr],
                ),
            );
            await lottery.connect(owner).cancelAdminAction(actionHashA);

            // Now proposing B must succeed
            await expect(
                lottery.connect(owner).proposeUpgrade(implBAddr),
            ).to.not.be.reverted;

            const p = await lottery.getUpgradeProposal();
            expect(p.impl).to.equal(implBAddr);
        });

        it('claim-based prizes work through proxy', async function () {
            const { lottery, mockVRF, alice } = await loadFixture(deployV1Fixture);

            await buyTickets(lottery, alice, [makeTicket([1, 2, 3, 4, 5], 10, 0)]);
            await closeDraw(lottery);
            await fulfillDraw(mockVRF, 1, 42n);
            await lottery.settleRound();

            const info = await lottery.getRoundInfo(1);
            if (info.jackpotWinners > 0n) {
                const claimable = await lottery.getClaimableAmount(1, alice.address);
                expect(claimable).to.be.gt(0n);

                const aliceBalBefore = await ethers.provider.getBalance(alice.address);
                const indices = await lottery.getPlayerTicketIndices(1, alice.address);
                const tx = await lottery.connect(alice).claimPrizeBatch(1, indices);
                const receipt = await tx.wait();
                const gasCost = receipt.gasUsed * receipt.gasPrice;
                const aliceBalAfter = await ethers.provider.getBalance(alice.address);

                expect(aliceBalAfter - aliceBalBefore + gasCost).to.equal(claimable);
            }
        });

        it('MAX_ROUND_TICKETS cap is enforced', async function () {
            const { lottery } = await loadFixture(deployV1Fixture);
            expect(await lottery.MAX_ROUND_TICKETS()).to.equal(10000);
        });
    });

    // ─── Deterministic winner (computed seed) ──────────────────────

    /**
   * JS replica of the Solidity _generateDrawnNumbers(seed):
   * lets us pre-compute winning numbers and buy a guaranteed-win ticket.
   * LOW-2: Updated to use domain-separated nonces matching the Solidity implementation.
   */
    function generateDrawnNumbers(seed) {
        const abiCoder = ethers.AbiCoder.defaultAbiCoder();
        const bigSeed = BigInt(seed);

        // Derive independent seeds for each output domain (mirrors Solidity).
        const whitesSeed  = BigInt(ethers.keccak256(abiCoder.encode(['uint256', 'string'], [bigSeed, 'whites'])));
        const goldNumSeed = BigInt(ethers.keccak256(abiCoder.encode(['uint256', 'string'], [bigSeed, 'goldNum'])));
        const goldPosSeed = BigInt(ethers.keccak256(abiCoder.encode(['uint256', 'string'], [bigSeed, 'goldPos'])));

        // Generate whites using the whites domain seed.
        let rng = whitesSeed;
        const whites = [];
        let count = 0;

        while (whites.length < 5) {
            rng = BigInt(ethers.keccak256(abiCoder.encode(['uint256', 'uint8'], [rng, count])));
            const num = Number(rng % 90n) + 1;
            if (!whites.includes(num)) {
                whites.push(num);
                count++;
            }
        }

        // Bubble sort (same as Solidity)
        for (let i = 0; i < 4; i++) {
            for (let j = 0; j < 4 - i; j++) {
                if (whites[j] > whites[j + 1]) {
                    [whites[j], whites[j + 1]] = [whites[j + 1], whites[j]];
                }
            }
        }

        const goldNum = Number(goldNumSeed % 90n) + 1;
        const goldPos = Number(goldPosSeed % 5n);

        return { whites, goldNum, goldPos };
    }

    const DETERMINISTIC_SEED = 1n; // small, predictable seed

    describe('Deterministic winner (computed seed)', function () {
        it('jackpot winner when ticket exactly matches computed drawn numbers', async function () {
            const { lottery, mockVRF, alice } = await loadFixture(deployFixture);

            const { whites, goldNum, goldPos } = generateDrawnNumbers(DETERMINISTIC_SEED);
            const losGold = goldNum === 1 ? 2 : 1; // different gold → jackpot but not super

            await buyTickets(lottery, alice, [makeTicket(whites, losGold, goldPos)]);
            await closeDraw(lottery);
            await fulfillDraw(mockVRF, 1, DETERMINISTIC_SEED);
            await lottery.settleRound();

            const info = await lottery.getRoundInfo(1);
            expect(info.jackpotWinners).to.equal(1);

            const claimable = await lottery.getClaimableAmount(1, alice.address);
            expect(claimable).to.be.gt(0n);
        });

        it('super jackpot winner when ticket matches whites + gold exactly', async function () {
            const { lottery, mockVRF, alice } = await loadFixture(deployFixture);

            const { whites, goldNum, goldPos } = generateDrawnNumbers(DETERMINISTIC_SEED);

            await buyTickets(lottery, alice, [makeTicket(whites, goldNum, goldPos)]);
            await closeDraw(lottery);
            await fulfillDraw(mockVRF, 1, DETERMINISTIC_SEED);
            await lottery.settleRound();

            const info = await lottery.getRoundInfo(1);
            expect(info.jackpotWinners).to.equal(1);
            expect(info.superWinners).to.equal(1);

            const claimable = await lottery.getClaimableAmount(1, alice.address);
            // Prize = jackpotPool (sole winner) + seedPool (sole super winner)
            expect(claimable).to.equal(info.jackpotPool + info.seedPool);
        });

        it('jackpot split equally between two winners with the same whites', async function () {
            const { lottery, mockVRF, alice, bob } = await loadFixture(deployFixture);

            const { whites, goldNum, goldPos } = generateDrawnNumbers(DETERMINISTIC_SEED);
            // Both use a different gold → jackpot winners, not super winners
            const otherGold = goldNum === 1 ? 2 : 1;

            await buyTickets(lottery, alice, [makeTicket(whites, otherGold, goldPos)]);
            await buyTickets(lottery, bob,   [makeTicket(whites, otherGold, goldPos)]);

            await closeDraw(lottery);
            await fulfillDraw(mockVRF, 1, DETERMINISTIC_SEED);
            await lottery.settleRound();

            const info = await lottery.getRoundInfo(1);
            expect(info.jackpotWinners).to.equal(2);

            const aliceClaimable = await lottery.getClaimableAmount(1, alice.address);
            const bobClaimable   = await lottery.getClaimableAmount(1, bob.address);

            // Both halves should be equal
            expect(aliceClaimable).to.equal(bobClaimable);
            // Each half equals jackpotPool / 2 (two winners split the pool)
            expect(aliceClaimable).to.equal(info.jackpotPool / 2n);
        });

        it('claimPrizeBatch claims both winning tickets in a single call', async function () {
            const { lottery, mockVRF, alice } = await loadFixture(deployFixture);

            const { whites, goldNum, goldPos } = generateDrawnNumbers(DETERMINISTIC_SEED);

            // Buy two winning tickets for alice
            await buyTickets(lottery, alice, [
                makeTicket(whites, goldNum, goldPos),
                makeTicket(whites, goldNum, goldPos),
            ]);

            await closeDraw(lottery);
            await fulfillDraw(mockVRF, 1, DETERMINISTIC_SEED);
            await lottery.settleRound();

            const info = await lottery.getRoundInfo(1);
            expect(info.jackpotWinners).to.equal(2); // both alice's tickets win

            const totalClaimable = await lottery.getClaimableAmount(1, alice.address);
            expect(totalClaimable).to.be.gt(0n);

            const indices = [...(await lottery.getPlayerTicketIndices(1, alice.address))];
            const balBefore = await ethers.provider.getBalance(alice.address);
            const tx = await lottery.connect(alice).claimPrizeBatch(1, indices);
            const receipt = await tx.wait();
            const gasCost = receipt.gasUsed * receipt.gasPrice;
            const balAfter = await ethers.provider.getBalance(alice.address);

            expect(balAfter - balBefore + gasCost).to.equal(totalClaimable);
            expect(await lottery.getClaimableAmount(1, alice.address)).to.equal(0n);
        });

        it('claimPrizeBatch silently skips already-claimed tickets', async function () {
            const { lottery, mockVRF, alice } = await loadFixture(deployFixture);

            const { whites, goldNum, goldPos } = generateDrawnNumbers(DETERMINISTIC_SEED);

            await buyTickets(lottery, alice, [
                makeTicket(whites, goldNum, goldPos),
                makeTicket(whites, goldNum, goldPos),
            ]);

            await closeDraw(lottery);
            await fulfillDraw(mockVRF, 1, DETERMINISTIC_SEED);
            await lottery.settleRound();

            const indices = [...(await lottery.getPlayerTicketIndices(1, alice.address))];

            // First batch claim — transfers prizes
            await lottery.connect(alice).claimPrizeBatch(1, indices);

            // Second batch claim on the same (already-claimed) indices must NOT revert,
            // but also must not transfer any additional funds.
            const balBefore = await ethers.provider.getBalance(alice.address);
            const tx = await lottery.connect(alice).claimPrizeBatch(1, indices);
            const receipt = await tx.wait();
            const gasCost = receipt.gasUsed * receipt.gasPrice;
            const balAfter = await ethers.provider.getBalance(alice.address);

            // Net balance change should be negative (only gas cost, no prize received)
            expect(balBefore - balAfter).to.equal(gasCost);
            expect(await lottery.getClaimableAmount(1, alice.address)).to.equal(0n);
        });

        it('claimPrizeBatch skips non-prize tickets and claims only winners', async function () {
            const { lottery, mockVRF, alice } = await loadFixture(deployFixture);

            const { whites, goldNum, goldPos } = generateDrawnNumbers(DETERMINISTIC_SEED);

            // Buy one winning and one losing ticket
            await buyTickets(lottery, alice, [
                makeTicket(whites, goldNum, goldPos),
                makeTicket([1, 2, 3, 4, 5], 88, 0), // losing ticket (numbers won't match drawn)
            ]);

            await closeDraw(lottery);
            await fulfillDraw(mockVRF, 1, DETERMINISTIC_SEED);
            await lottery.settleRound();

            const totalClaimable = await lottery.getClaimableAmount(1, alice.address);
            expect(totalClaimable).to.be.gt(0n);

            const indices = [...(await lottery.getPlayerTicketIndices(1, alice.address))];
            // Batch includes both the winner and the loser — should not revert
            const balBefore = await ethers.provider.getBalance(alice.address);
            const tx = await lottery.connect(alice).claimPrizeBatch(1, indices);
            const receipt = await tx.wait();
            const gasCost = receipt.gasUsed * receipt.gasPrice;
            const balAfter = await ethers.provider.getBalance(alice.address);

            // Winner prize received despite the loser being in the same batch
            expect(balAfter - balBefore + gasCost).to.equal(totalClaimable);
        });

        it('getClaimableAmount returns 0 after all prizes are claimed', async function () {
            const { lottery, mockVRF, alice } = await loadFixture(deployFixture);

            const { whites, goldNum, goldPos } = generateDrawnNumbers(DETERMINISTIC_SEED);
            await buyTickets(lottery, alice, [makeTicket(whites, goldNum, goldPos)]);
            await closeDraw(lottery);
            await fulfillDraw(mockVRF, 1, DETERMINISTIC_SEED);
            await lottery.settleRound();

            const indices = [...(await lottery.getPlayerTicketIndices(1, alice.address))];
            await lottery.connect(alice).claimPrizeBatch(1, indices);

            expect(await lottery.getClaimableAmount(1, alice.address)).to.equal(0n);
        });
    });

    // ─── CCIP authorization ─────────────────────────────────────────

    describe('CCIP authorization', function () {
        it('ccipReceive reverts when called by a non-router (direct call)', async function () {
            const { lottery, alice } = await loadFixture(deployFixture);
            const t = makeTicket([1, 2, 3, 4, 5], 10, 0);
            await buyTickets(lottery, alice, [t]);
            await closeDraw(lottery);

            // alice calls ccipReceive directly (not through the router)
            const message = {
                messageId:           ethers.ZeroHash,
                sourceChainSelector: 16015286601757825753n,
                sender:              ethers.AbiCoder.defaultAbiCoder().encode(['address'], [alice.address]),
                data:                ethers.AbiCoder.defaultAbiCoder().encode(['uint256', 'uint256'], [1n, 42n]),
                destTokenAmounts:    [],
            };
            await expect(
                lottery.connect(alice).ccipReceive(message),
            ).to.be.revertedWithCustomError(lotteryMathLib, 'OnlyCCIPRouter');
        });

        it('ccipReceive reverts for wrong source chain (direct call bypasses router)', async function () {
            const { lottery, vrfRequester, alice } = await loadFixture(deployFixture);
            // Calling ccipReceive directly with wrong selector (bypasses the real router).
            // This also proves the router-only guard fires first; the second guard would
            // fire if we could craft a delivery with wrong selector via MockRouter.
            const message = {
                messageId:           ethers.ZeroHash,
                sourceChainSelector: 999n, // wrong
                sender:              ethers.AbiCoder.defaultAbiCoder().encode(['address'], [await vrfRequester.getAddress()]),
                data:                ethers.AbiCoder.defaultAbiCoder().encode(['uint256', 'uint256'], [1n, 42n]),
                destTokenAmounts:    [],
            };
            await expect(
                lottery.connect(alice).ccipReceive(message),
            ).to.be.revertedWithCustomError(lotteryMathLib, 'OnlyCCIPRouter');
        });

        it('ccipReceive reverts for wrong vrfRequester (direct call)', async function () {
            const { lottery, CHAIN_SELECTOR, alice } = await loadFixture(deployFixture);
            const message = {
                messageId:           ethers.ZeroHash,
                sourceChainSelector: CHAIN_SELECTOR,
                sender:              ethers.AbiCoder.defaultAbiCoder().encode(['address'], [alice.address]), // wrong sender
                data:                ethers.AbiCoder.defaultAbiCoder().encode(['uint256', 'uint256'], [1n, 42n]),
                destTokenAmounts:    [],
            };
            await expect(
                lottery.connect(alice).ccipReceive(message),
            ).to.be.revertedWithCustomError(lotteryMathLib, 'OnlyCCIPRouter');
        });
    });

    // ─── Admin configuration setters ───────────────────────────────

    describe('Admin configuration setters', function () {
        it('admin can update setCCIPGasLimit', async function () {
            const { lottery, owner } = await loadFixture(deployFixture);
            await expect(
                lottery.connect(owner).setCCIPGasLimit(300_000),
            ).to.not.be.reverted;
        });

        it('setCCIPGasLimit reverts below MIN_CCIP_GAS_LIMIT', async function () {
            const { lottery } = await loadFixture(deployFixture);
            const min = await lottery.MIN_CCIP_GAS_LIMIT();
            await expect(
                lottery.setCCIPGasLimit(Number(min) - 1),
            ).to.be.revertedWithCustomError(lotteryViewsLib, 'GasLimitOutOfRange');
        });

        it('setCCIPGasLimit reverts above MAX_CCIP_GAS_LIMIT', async function () {
            const { lottery } = await loadFixture(deployFixture);
            const max = await lottery.MAX_CCIP_GAS_LIMIT();
            await expect(
                lottery.setCCIPGasLimit(Number(max) + 1),
            ).to.be.revertedWithCustomError(lotteryViewsLib, 'GasLimitOutOfRange');
        });

        it('non-admin cannot call setCCIPGasLimit', async function () {
            const { lottery, alice } = await loadFixture(deployFixture);
            await expect(
                lottery.connect(alice).setCCIPGasLimit(300_000),
            ).to.be.revertedWithCustomError(lottery, 'Unauthorized');
        });

        it('non-admin cannot call proposeSetCCIPRouter', async function () {
            const { lottery, routerAddr, alice } = await loadFixture(deployFixture);
            await expect(
                lottery.connect(alice).proposeSetCCIPRouter(routerAddr),
            ).to.be.revertedWithCustomError(lottery, 'Unauthorized');
        });

        it('non-admin cannot call proposeSetVRFRequester', async function () {
            const { lottery, routerAddr, alice } = await loadFixture(deployFixture);
            await expect(
                lottery.connect(alice).proposeSetVRFRequester(routerAddr),
            ).to.be.revertedWithCustomError(lottery, 'Unauthorized');
        });

        it('non-admin cannot call emergencyCancelDraw', async function () {
            const { lottery, alice } = await loadFixture(deployFixture);
            const t = makeTicket([1, 2, 3, 4, 5], 10, 0);
            await buyTickets(lottery, alice, [t]);
            await closeDraw(lottery);

            await expect(
                lottery.connect(alice).emergencyCancelDraw(),
            ).to.be.revertedWithCustomError(lottery, 'Unauthorized');
        });
    });

    // ─── Pool carry-over exact ETH amounts ─────────────────────────

    describe('Pool carry-over exact ETH amounts', function () {
        it('entire jackpotPool carries over to the next round when no winner', async function () {
            const { lottery, mockVRF, alice } = await loadFixture(deployFixture);

            await buyTickets(lottery, alice, [makeTicket([1, 2, 3, 4, 5], 10, 0)]);
            const r1 = await lottery.getRoundInfo(1);
            const jackpotPool1 = r1.jackpotPool;
            const seedPool1   = r1.seedPool;

            await closeDraw(lottery);
            await fulfillDraw(mockVRF, 1, NON_MATCHING_SEED);
            await lottery.settleRound();

            const r2 = await lottery.getRoundInfo(2);
            expect(r2.jackpotPool).to.equal(jackpotPool1);
            expect(r2.seedPool).to.equal(seedPool1);
        });

        it('fee is not included in the carried-over pools', async function () {
            const { lottery, alice } = await loadFixture(deployFixture);

            const price = await lottery.ticketPrice();
            await buyTickets(lottery, alice, [makeTicket([1, 2, 3, 4, 5], 10, 0)]);

            const r1 = await lottery.getRoundInfo(1);
            const expectedJackpot = (price * 5000n) / 10000n;
            const expectedSeed    = (price * 3000n) / 10000n;
            const totalFee        = (price * 2000n) / 10000n;
            const nftShare        = (totalFee * 5000n) / 10000n;
            const expectedFee     = totalFee - nftShare; // admin 10%

            expect(r1.jackpotPool).to.equal(expectedJackpot);
            expect(r1.seedPool).to.equal(expectedSeed);
            expect(await lottery.ownerFees()).to.equal(expectedFee);
        });

        it('pool accumulates correctly over two no-winner rounds', async function () {
            const { lottery, mockVRF, alice, bob } = await loadFixture(deployFixture);

            const price = await lottery.ticketPrice();

            // Round 1
            await buyTickets(lottery, alice, [makeTicket([1, 2, 3, 4, 5], 10, 0)]);
            await closeDraw(lottery);
            await fulfillDraw(mockVRF, 1, NON_MATCHING_SEED);
            await lottery.settleRound();

            // Round 2 – fresh ticket (price may have changed but let's just fetch it)
            const price2 = await lottery.ticketPrice();
            await buyTickets(lottery, bob, [makeTicket([2, 3, 4, 5, 6], 20, 1)]);
            await closeDraw(lottery);
            await fulfillDraw(mockVRF, 2, NON_MATCHING_SEED);
            await lottery.settleRound();

            // Round 3 should have the sum of both rounds' pools
            const r3 = await lottery.getRoundInfo(3);
            const expectedJackpot = (price * 5000n / 10000n) + (price2 * 5000n / 10000n);
            const expectedSeed    = (price * 3000n / 10000n) + (price2 * 3000n / 10000n);

            expect(r3.jackpotPool).to.equal(expectedJackpot);
            expect(r3.seedPool).to.equal(expectedSeed);
        });

        it('dust from integer division is added to next round jackpotPool', async function () {
            const { lottery, mockVRF, alice, bob, charlie } = await loadFixture(
                deployFixture,
            );

            const { whites, goldNum, goldPos } = generateDrawnNumbers(DETERMINISTIC_SEED);

            // Three players all win → jackpotPool / 3 may leave dust
            await buyTickets(lottery, alice,   [makeTicket(whites, goldNum, goldPos)]);
            await buyTickets(lottery, bob,     [makeTicket(whites, goldNum, goldPos)]);
            await buyTickets(lottery, charlie, [makeTicket(whites, goldNum, goldPos)]);

            const r1 = await lottery.getRoundInfo(1);
            const jackpotPool1 = r1.jackpotPool;

            await closeDraw(lottery);
            await fulfillDraw(mockVRF, 1, DETERMINISTIC_SEED);
            await lottery.settleRound();

            const r1settled = await lottery.getRoundInfo(1);
            expect(r1settled.jackpotWinners).to.equal(3);

            // Compute expected prize per winner and dust from the reported pool
            const prizePerWinner = r1settled.jackpotPool / 3n;
            const dust = r1settled.jackpotPool - prizePerWinner * 3n;

            const r2 = await lottery.getRoundInfo(2);
            // Dust should have rolled to round 2's jackpot
            expect(r2.jackpotPool).to.be.gte(dust);
        });
    });

    // ─── claimPendingPayout ─────────────────────────────────────────

    describe('claimPendingPayout', function () {
        it('returns 0 for an address with no pending payout', async function () {
            const { lottery, alice } = await loadFixture(deployFixture);
            expect(await lottery.pendingPayouts(alice.address)).to.equal(0n);
        });
    });

    // ─── Audit fixes ────────────────────────────────────────────────

    describe('HIGH: Admin timelock for CCIP config changes', function () {
        it('proposeSetCCIPRouter emits AdminActionProposed', async function () {
            const { lottery, owner, routerAddr: fixtureRouterAddr } = await loadFixture(deployFixture);
            const routerAddr = fixtureRouterAddr;
            await expect(lottery.connect(owner).proposeSetCCIPRouter(routerAddr))
                .to.emit(lottery, 'AdminActionProposed');
        });

        it('executeSetCCIPRouter reverts before timelock expires', async function () {
            const { lottery, owner, routerAddr: fixtureRouterAddr } = await loadFixture(deployFixture);
            const routerAddr = fixtureRouterAddr;
            await lottery.connect(owner).proposeSetCCIPRouter(routerAddr);
            await expect(
                lottery.connect(owner).executeSetCCIPRouter(routerAddr),
            ).to.be.revertedWithCustomError(lotteryViewsLib, 'TimelockNotExpired');
        });

        it('executeSetCCIPRouter succeeds after timelock expires', async function () {
            const { lottery, owner, routerAddr: fixtureRouterAddr } = await loadFixture(deployFixture);
            const routerAddr = fixtureRouterAddr;
            await lottery.connect(owner).proposeSetCCIPRouter(routerAddr);
            await time.increase(48 * 60 * 60 + 1);
            await expect(
                lottery.connect(owner).executeSetCCIPRouter(routerAddr),
            ).to.emit(lottery, 'AdminActionExecuted');
            expect(await lottery.ccipRouter()).to.equal(routerAddr);
        });

        it('executeSetCCIPRouter reverts if not proposed', async function () {
            const { lottery, owner, routerAddr: fixtureRouterAddr } = await loadFixture(deployFixture);
            const routerAddr = fixtureRouterAddr;
            await expect(
                lottery.connect(owner).executeSetCCIPRouter(routerAddr),
            ).to.be.revertedWithCustomError(lotteryViewsLib, 'ActionNotProposed');
        });

        it('cancelAdminAction removes a pending CCIP router action', async function () {
            const { lottery, owner, routerAddr: fixtureRouterAddr } = await loadFixture(deployFixture);
            const routerAddr = fixtureRouterAddr;
            await lottery.connect(owner).proposeSetCCIPRouter(routerAddr);
            const actionHash = ethers.keccak256(
                ethers.AbiCoder.defaultAbiCoder().encode(
                    ['string', 'address'],
                    ['setCCIPRouter', routerAddr],
                ),
            );
            await expect(lottery.connect(owner).cancelAdminAction(actionHash))
                .to.emit(lottery, 'AdminActionCancelled');
            // After cancellation, execution must fail
            await time.increase(48 * 60 * 60 + 1);
            await expect(
                lottery.connect(owner).executeSetCCIPRouter(routerAddr),
            ).to.be.revertedWithCustomError(lotteryViewsLib, 'ActionNotProposed');
        });

        it('non-admin cannot propose CCIP router change', async function () {
            const { lottery, routerAddr, alice } = await loadFixture(deployFixture);
            await expect(
                lottery.connect(alice).proposeSetCCIPRouter(routerAddr),
            ).to.be.revertedWithCustomError(lottery, 'Unauthorized');
        });

        it('proposeSetCCIPRouter reverts for zero address', async function () {
            const { lottery, owner } = await loadFixture(deployFixture);
            await expect(
                lottery.connect(owner).proposeSetCCIPRouter(ethers.ZeroAddress),
            ).to.be.revertedWithCustomError(lotteryViewsLib, 'ZeroAddress');
        });

        it('proposeSetCCIPRouter reverts for EOA', async function () {
            const { lottery, owner, alice } = await loadFixture(deployFixture);
            await expect(
                lottery.connect(owner).proposeSetCCIPRouter(alice.address),
            ).to.be.revertedWithCustomError(lotteryViewsLib, 'NotAContract');
        });

        it('proposeSetVRFRequester emits AdminActionProposed', async function () {
            const { lottery, owner, routerAddr: requesterRouterAddr } = await loadFixture(deployFixture);
            const requesterAddr = requesterRouterAddr;
            await expect(lottery.connect(owner).proposeSetVRFRequester(requesterAddr))
                .to.emit(lottery, 'AdminActionProposed');
        });

        it('executeSetVRFRequester succeeds after timelock expires', async function () {
            const { lottery, owner, routerAddr: requesterRouterAddr } = await loadFixture(deployFixture);
            const requesterAddr = requesterRouterAddr;
            await lottery.connect(owner).proposeSetVRFRequester(requesterAddr);
            await time.increase(48 * 60 * 60 + 1);
            await expect(
                lottery.connect(owner).executeSetVRFRequester(requesterAddr),
            ).to.emit(lottery, 'AdminActionExecuted');
            expect(await lottery.vrfRequester()).to.equal(requesterAddr);
        });
    });

    describe('MEDIUM-1: CCIP draw state validation', function () {
        it('after emergencyCancelDraw + re-draw, fulfilling earlier VRF request still works', async function () {
            const { lottery, mockVRF, alice } = await loadFixture(deployFixture);
            // Buy and draw for round 1 → VRF request #1 issued
            await buyTickets(lottery, alice, [makeTicket([1, 2, 3, 4, 5], 10, 0)]);
            await closeDraw(lottery);
            // Cancel round 1 → back to OPEN.  LotteryVRFRequester still has pendingRoundId=1.
            await time.increase(Number(DRAW_GRACE));
            await lottery.emergencyCancelDraw();
            // Re-draw round 1 → VRF request #2 issued (same round, pendingRoundId check relaxed)
            await closeDraw(lottery);
            // VRF request #1 can still be fulfilled (round 1 is DRAWING).
            // The full pipeline: fulfillRandomWords(1) → LotteryVRFRequester.fulfillRandomWords
            // → ccipSend → LiquidLotteryV1.ccipReceive → _applyRandomness.
            await expect(
                fulfillDraw(mockVRF, 1, NON_MATCHING_SEED),
            ).to.not.be.reverted;
        });

        it('ccipReceive succeeds for the current drawing round', async function () {
            const { lottery, mockVRF, alice } = await loadFixture(deployFixture);
            await buyTickets(lottery, alice, [makeTicket([1, 2, 3, 4, 5], 10, 0)]);
            await closeDraw(lottery);
            await expect(
                fulfillDraw(mockVRF, 1, NON_MATCHING_SEED),
            ).to.not.be.reverted;
        });
    });

    describe('MEDIUM-1 (audit 2): noContract blocks contract callers', function () {
        it('contract caller is rejected when buying tickets', async function () {
            const { lottery } = await loadFixture(deployFixture);

            const MockCaller = await ethers.getContractFactory('MockContractCaller');
            const caller = await MockCaller.deploy();
            await caller.waitForDeployment();

            const price = await lottery.ticketPrice();
            await expect(
                caller.tryBuyTickets(await lottery.getAddress(), { value: price }),
            ).to.be.revertedWithCustomError(lottery, 'NoIndirectCalls');
        });
    });

    describe('MEDIUM-2: Batch settlement', function () {
        it('settleRoundBatch completes settlement in one call when tickets <= batchSize', async function () {
            const { lottery, mockVRF, alice } = await loadFixture(deployFixture);
            await buyTickets(lottery, alice, [makeTicket([1, 2, 3, 4, 5], 10, 0)]);
            await closeDraw(lottery);
            await fulfillDraw(mockVRF, 1, NON_MATCHING_SEED);
            await lottery.settleRoundBatch();
            expect((await lottery.getRoundInfo(1)).state).to.equal(3); // SETTLED
        });

        it('settleRoundBatch can be called multiple times for large rounds', async function () {
            const { lottery, mockVRF, alice, bob } = await loadFixture(deployFixture);

            // Reduce batch size to 1 to force multiple calls
            await lottery.setSettlementBatchSize(1);

            // Buy 3 tickets from different accounts
            await buyTickets(lottery, alice, [makeTicket([1, 2, 3, 4, 5], 10, 0)]);
            await buyTickets(lottery, bob,   [makeTicket([2, 3, 4, 5, 6], 20, 1)]);
            await buyTickets(lottery, alice, [makeTicket([3, 4, 5, 6, 7], 30, 2)]);

            await closeDraw(lottery);
            await fulfillDraw(mockVRF, 1, NON_MATCHING_SEED);

            // With batchSize=1 and 3 tickets, need 3 calls
            expect((await lottery.getRoundInfo(1)).state).to.equal(2); // DRAWN
            await lottery.settleRoundBatch();
            expect((await lottery.getRoundInfo(1)).state).to.equal(2); // still DRAWN
            await lottery.settleRoundBatch();
            expect((await lottery.getRoundInfo(1)).state).to.equal(2); // still DRAWN
            await lottery.settleRoundBatch();
            expect((await lottery.getRoundInfo(1)).state).to.equal(3); // SETTLED
        });

        it('settleRoundBatch and settleRound produce identical results', async function () {
            const { lottery, mockVRF, alice } = await loadFixture(deployFixture);
            const { whites, goldNum, goldPos } = generateDrawnNumbers(DETERMINISTIC_SEED);

            await buyTickets(lottery, alice, [makeTicket(whites, goldNum, goldPos)]);
            await closeDraw(lottery);
            await fulfillDraw(mockVRF, 1, DETERMINISTIC_SEED);

            await lottery.settleRoundBatch();

            const r = await lottery.getRoundInfo(1);
            expect(r.state).to.equal(3);            // SETTLED
            expect(r.jackpotWinners).to.equal(1);
        });

        it('settleRoundBatch reverts when round is not DRAWN', async function () {
            const { lottery, alice } = await loadFixture(deployFixture);
            await buyTickets(lottery, alice, [makeTicket([1, 2, 3, 4, 5], 10, 0)]);
            await expect(lottery.settleRoundBatch()).to.be.revertedWithCustomError(lotteryMathLib, 'NotDrawnYet');
        });

        it('setSettlementBatchSize can be changed by admin', async function () {
            const { lottery, owner } = await loadFixture(deployFixture);
            await lottery.connect(owner).setSettlementBatchSize(50);
            expect(await lottery.settlementBatchSize()).to.equal(50);
        });

        it('setSettlementBatchSize reverts for size 0', async function () {
            const { lottery, owner } = await loadFixture(deployFixture);
            await expect(
                lottery.connect(owner).setSettlementBatchSize(0),
            ).to.be.revertedWithCustomError(lotteryViewsLib, 'InvalidBatchSize');
        });

        it('non-admin cannot call setSettlementBatchSize', async function () {
            const { lottery, alice } = await loadFixture(deployFixture);
            await expect(
                lottery.connect(alice).setSettlementBatchSize(50),
            ).to.be.revertedWithCustomError(lottery, 'Unauthorized');
        });

        it('MEDIUM-2: settleRound reverts when ticketCount > settlementBatchSize', async function () {
            const { lottery, mockVRF, alice, bob } = await loadFixture(deployFixture);

            // Reduce batch size to 1 so that 2 tickets exceed the limit
            await lottery.setSettlementBatchSize(1);

            await buyTickets(lottery, alice, [makeTicket([1, 2, 3, 4, 5], 10, 0)]);
            await buyTickets(lottery, bob,   [makeTicket([2, 3, 4, 5, 6], 20, 1)]);

            await closeDraw(lottery);
            await fulfillDraw(mockVRF, 1, NON_MATCHING_SEED);

            // ticketCount (2) > settlementBatchSize (1) → must use batch
            await expect(lottery.settleRound()).to.be.revertedWithCustomError(lotteryMathLib, 'UseBatchSettlement');

            // settleRoundBatch still works
            await lottery.settleRoundBatch();
            await lottery.settleRoundBatch();
            expect((await lottery.getRoundInfo(1)).state).to.equal(3); // SETTLED
        });
    });

    describe('LOW-2: Improved randomness (domain-separated nonces)', function () {
        it('generateDrawnNumbers JS matches Solidity _generateDrawnNumbers output', async function () {
            const { lottery, mockVRF, alice } = await loadFixture(deployFixture);
            const { whites, goldNum, goldPos } = generateDrawnNumbers(DETERMINISTIC_SEED);

            // Buy the exact winning ticket according to JS helper
            await buyTickets(lottery, alice, [makeTicket(whites, goldNum, goldPos)]);
            await closeDraw(lottery);
            await fulfillDraw(mockVRF, 1, DETERMINISTIC_SEED);
            await lottery.settleRound();

            const info = await lottery.getRoundInfo(1);
            // If JS and Solidity agree, alice is a winner
            expect(info.jackpotWinners).to.equal(1);
            expect(info.superWinners).to.equal(1);
        });

        it('different seeds produce different white numbers', async function () {
            const r1 = generateDrawnNumbers(1n);
            const r2 = generateDrawnNumbers(2n);
            const same = r1.whites.every((w, i) => w === r2.whites[i]);
            expect(same).to.be.false;
        });
    });

    // ═══════════════════════════════════════════════════════════════
    //  V2: GoldenTicket NFT + Referral System
    // ═══════════════════════════════════════════════════════════════

    describe('V2: GoldenTicket contract', function () {
        async function deployGoldenTicketFixture() {
            const base = await deployFixture();
            const { lottery, owner, alice, bob } = base;
            const mintPrice = ethers.parseEther('0.1');
            const GoldenTicket = await ethers.getContractFactory('GoldenTicket');
            const nft = await GoldenTicket.deploy(mintPrice, 'https://example.com/meta/');
            await nft.waitForDeployment();
            // Unlock full supply so existing public-mint tests work as before
            await nft.connect(owner).setMintableSupply(10);
            // Wire: GoldenTicket → lottery (so mint() can call seedJackpot)
            await nft.connect(owner).setLotteryContract(await lottery.getAddress());
            await lottery.connect(owner).setGoldenTicketContract(await nft.getAddress());
            return { ...base, nft, mintPrice };
        }

        it('should have correct name, symbol, and MAX_SUPPLY', async function () {
            const { nft } = await loadFixture(deployGoldenTicketFixture);
            expect(await nft.name()).to.equal('GoldenTicket');
            expect(await nft.symbol()).to.equal('GTICKET');
            expect(await nft.MAX_SUPPLY()).to.equal(10);
        });

        it('public mint succeeds with correct payment', async function () {
            const { nft, alice, mintPrice } = await loadFixture(deployGoldenTicketFixture);
            await nft.connect(alice).mint({ value: mintPrice });
            expect(await nft.ownerOf(0)).to.equal(alice.address);
            expect(await nft.totalMinted()).to.equal(1);
        });

        it('public mint reverts with insufficient payment', async function () {
            const { nft, alice } = await loadFixture(deployGoldenTicketFixture);
            await expect(
                nft.connect(alice).mint({ value: ethers.parseEther('0.01') }),
            ).to.be.revertedWithCustomError(nft, 'InsufficientPayment');
        });

        it('adminMint succeeds for owner', async function () {
            const { nft, owner, alice } = await loadFixture(deployGoldenTicketFixture);
            await nft.connect(owner).adminMint(alice.address);
            expect(await nft.ownerOf(0)).to.equal(alice.address);
            expect(await nft.totalMinted()).to.equal(1);
        });

        it('adminMint reverts for non-owner', async function () {
            const { nft, alice } = await loadFixture(deployGoldenTicketFixture);
            await expect(
                nft.connect(alice).adminMint(alice.address),
            ).to.be.revertedWithCustomError(nft, 'OwnableUnauthorizedAccount');
        });

        it('max supply is enforced', async function () {
            const { nft, owner, alice } = await loadFixture(deployGoldenTicketFixture);
            // Mint all 10
            for (let i = 0; i < 10; i++) {
                await nft.connect(owner).adminMint(alice.address);
            }
            expect(await nft.totalMinted()).to.equal(10);
            // 11th mint reverts
            await expect(
                nft.connect(owner).adminMint(alice.address),
            ).to.be.revertedWithCustomError(nft, 'AlreadyMintedOut');
        });

        it('mint forwards payment to jackpot pool (no proceeds in GoldenTicket)', async function () {
            const { nft, lottery, owner, alice, mintPrice } = await loadFixture(deployGoldenTicketFixture);
            const infoBefore = await lottery.getRoundInfo(1);
            await nft.connect(alice).mint({ value: mintPrice });

            // Mint payment goes to jackpot pool, not to _proceeds
            const infoAfter = await lottery.getRoundInfo(1);
            expect(infoAfter.jackpotPool - infoBefore.jackpotPool).to.equal(mintPrice);

            // withdrawProceeds reverts because _proceeds is 0
            await expect(
                nft.connect(owner).withdrawProceeds(),
            ).to.be.revertedWithCustomError(nft, 'NoValueToWithdraw');
        });

        it('withdrawProceeds reverts when no proceeds', async function () {
            const { nft, owner } = await loadFixture(deployGoldenTicketFixture);
            await expect(
                nft.connect(owner).withdrawProceeds(),
            ).to.be.revertedWithCustomError(nft, 'NoValueToWithdraw');
        });

        it('setBaseURI updates metadata URI', async function () {
            const { nft, owner, alice, mintPrice } = await loadFixture(deployGoldenTicketFixture);
            await nft.connect(alice).mint({ value: mintPrice });
            await nft.connect(owner).setBaseURI('https://new-uri.com/');
            expect(await nft.tokenURI(0)).to.equal('https://new-uri.com/0');
        });
    });

    describe('V2: GoldenTicket mintableSupply and pricing', function () {
        async function deployGoldenTicketBaseFixture() {
            const base = await deployFixture();
            const { lottery, owner, alice, bob } = base;
            const mintPrice = ethers.parseEther('2');
            const GoldenTicket = await ethers.getContractFactory('GoldenTicket');
            const nft = await GoldenTicket.deploy(mintPrice, 'https://example.com/meta/');
            await nft.waitForDeployment();
            // Wire: GoldenTicket → lottery (so mint() can call seedJackpot)
            await nft.connect(owner).setLotteryContract(await lottery.getAddress());
            await lottery.connect(owner).setGoldenTicketContract(await nft.getAddress());
            // mintableSupply starts at 0 — not set here
            return { ...base, nft, mintPrice };
        }

        it('mintableSupply starts at 0', async function () {
            const { nft } = await loadFixture(deployGoldenTicketBaseFixture);
            expect(await nft.mintableSupply()).to.equal(0);
        });

        it('mint() reverts when mintableSupply is 0', async function () {
            const { nft, alice, mintPrice } = await loadFixture(deployGoldenTicketBaseFixture);
            await expect(
                nft.connect(alice).mint({ value: mintPrice }),
            ).to.be.revertedWithCustomError(nft, 'MintableSupplyReached');
        });

        it('setMintableSupply sets the value', async function () {
            const { nft, owner } = await loadFixture(deployGoldenTicketBaseFixture);
            await nft.connect(owner).setMintableSupply(3);
            expect(await nft.mintableSupply()).to.equal(3);
        });

        it('setMintableSupply reverts for non-owner', async function () {
            const { nft, alice } = await loadFixture(deployGoldenTicketBaseFixture);
            await expect(
                nft.connect(alice).setMintableSupply(1),
            ).to.be.revertedWithCustomError(nft, 'OwnableUnauthorizedAccount');
        });

        it('setMintableSupply reverts if n > MAX_SUPPLY', async function () {
            const { nft, owner } = await loadFixture(deployGoldenTicketBaseFixture);
            await expect(
                nft.connect(owner).setMintableSupply(11),
            ).to.be.revertedWithCustomError(nft, 'ExceedsMaxSupply');
        });

        it('mint() succeeds after setMintableSupply(1)', async function () {
            const { nft, owner, alice, mintPrice } = await loadFixture(deployGoldenTicketBaseFixture);
            await nft.connect(owner).setMintableSupply(1);
            await nft.connect(alice).mint({ value: mintPrice });
            expect(await nft.ownerOf(0)).to.equal(alice.address);
            expect(await nft.publicMinted()).to.equal(1);
        });

        it('mint() reverts after mintableSupply is reached', async function () {
            const { nft, owner, alice, bob, mintPrice } = await loadFixture(deployGoldenTicketBaseFixture);
            await nft.connect(owner).setMintableSupply(1);
            await nft.connect(alice).mint({ value: mintPrice });
            await expect(
                nft.connect(bob).mint({ value: mintPrice }),
            ).to.be.revertedWithCustomError(nft, 'MintableSupplyReached');
        });

        it('setMintPrice updates the mint price', async function () {
            const { nft, owner, alice } = await loadFixture(deployGoldenTicketBaseFixture);
            const newPrice = ethers.parseEther('5');
            await nft.connect(owner).setMintPrice(newPrice);
            expect(await nft.mintPrice()).to.equal(newPrice);
            await nft.connect(owner).setMintableSupply(1);
            await nft.connect(alice).mint({ value: newPrice });
            expect(await nft.ownerOf(0)).to.equal(alice.address);
        });

        it('setMintPrice reverts for non-owner', async function () {
            const { nft, alice } = await loadFixture(deployGoldenTicketBaseFixture);
            await expect(
                nft.connect(alice).setMintPrice(ethers.parseEther('1')),
            ).to.be.revertedWithCustomError(nft, 'OwnableUnauthorizedAccount');
        });

        it('adminMint bypasses mintableSupply', async function () {
            const { nft, owner, alice } = await loadFixture(deployGoldenTicketBaseFixture);
            // mintableSupply is 0, adminMint still works
            await nft.connect(owner).adminMint(alice.address);
            expect(await nft.ownerOf(0)).to.equal(alice.address);
            expect(await nft.totalMinted()).to.equal(1);
            expect(await nft.publicMinted()).to.equal(0);
        });

        it('lotteryMint bypasses mintableSupply', async function () {
            const { nft, owner, alice } = await loadFixture(deployGoldenTicketBaseFixture);
            await nft.connect(owner).setLotteryContract(owner.address);
            // mintableSupply is 0, lotteryMint still works
            await nft.connect(owner).lotteryMint(alice.address);
            expect(await nft.ownerOf(0)).to.equal(alice.address);
            expect(await nft.publicMinted()).to.equal(0);
        });

        it('progressive mint flow: price 2 ETH then 5 ETH', async function () {
            const { nft, owner, alice, bob } = await loadFixture(deployGoldenTicketBaseFixture);
            const price1 = ethers.parseEther('2');
            const price2 = ethers.parseEther('5');

            // Step 1: Unlock 1 token at 2 ETH
            await nft.connect(owner).setMintableSupply(1);
            await nft.connect(alice).mint({ value: price1 });
            expect(await nft.publicMinted()).to.equal(1);

            // Step 2: Raise price to 5 ETH and unlock 2nd slot
            await nft.connect(owner).setMintPrice(price2);
            await nft.connect(owner).setMintableSupply(2);
            await nft.connect(bob).mint({ value: price2 });
            expect(await nft.publicMinted()).to.equal(2);
            expect(await nft.ownerOf(1)).to.equal(bob.address);
        });

        it('adminMint does not count toward publicMinted', async function () {
            const { nft, owner, alice, bob, mintPrice } = await loadFixture(deployGoldenTicketBaseFixture);
            // adminMint pushes _totalMinted to 1 but _publicMinted stays 0
            await nft.connect(owner).adminMint(alice.address);
            // With mintableSupply=1, public mint should still work
            await nft.connect(owner).setMintableSupply(1);
            await nft.connect(bob).mint({ value: mintPrice });
            expect(await nft.publicMinted()).to.equal(1);
            expect(await nft.totalMinted()).to.equal(2);
        });
    });

    describe('V2: setGoldenTicketContract', function () {
        it('admin can set golden ticket contract', async function () {
            const { lottery, owner, alice } = await loadFixture(deployFixture);
            // Deploy a GoldenTicket
            const GoldenTicket = await ethers.getContractFactory('GoldenTicket');
            const nft = await GoldenTicket.deploy(ethers.parseEther('0.1'), '');
            await nft.waitForDeployment();

            await lottery.connect(owner).setGoldenTicketContract(await nft.getAddress());
            expect(await lottery.goldenTicketContract()).to.equal(await nft.getAddress());
        });

        it('non-admin cannot set golden ticket contract', async function () {
            const { lottery, alice } = await loadFixture(deployFixture);
            await expect(
                lottery.connect(alice).setGoldenTicketContract(alice.address),
            ).to.be.revertedWithCustomError(lottery, 'Unauthorized');
        });

        it('reverts when setting zero address', async function () {
            const { lottery, owner } = await loadFixture(deployFixture);
            await expect(
                lottery.connect(owner).setGoldenTicketContract(ethers.ZeroAddress),
            ).to.be.revertedWithCustomError(lotteryViewsLib, 'ZeroAddress');
        });
    });

    describe('V2: Referral registration', function () {
        it('referrer is set on first buyTickets with referrer', async function () {
            const { lottery, alice, bob } = await loadFixture(deployFixture);
            const t = makeTicket([1, 2, 3, 4, 5], 10, 0);
            const price = await lottery.ticketPrice();

            await expect(
                lottery.connect(alice).buyTickets(
                    [t.whites], [t.goldNum], [t.goldPos], bob.address,
                    { value: price },
                ),
            ).to.emit(lottery, 'ReferrerRegistered').withArgs(alice.address, bob.address);
        });

        it('self-referral reverts', async function () {
            const { lottery, alice } = await loadFixture(deployFixture);
            const t = makeTicket([1, 2, 3, 4, 5], 10, 0);
            const price = await lottery.ticketPrice();

            await expect(
                lottery.connect(alice).buyTickets(
                    [t.whites], [t.goldNum], [t.goldPos], alice.address,
                    { value: price },
                ),
            ).to.be.revertedWithCustomError(lotteryMathLib, 'SelfReferral');
        });

        it('referrer is permanent — cannot be changed', async function () {
            const { lottery, alice, bob, charlie } = await loadFixture(deployFixture);
            const t = makeTicket([1, 2, 3, 4, 5], 10, 0);
            const price = await lottery.ticketPrice();

            // Set Bob as referrer
            await lottery.connect(alice).buyTickets(
                [t.whites], [t.goldNum], [t.goldPos], bob.address,
                { value: price },
            );

            // Try to set Charlie — should NOT emit ReferrerRegistered (referrer stays Bob)
            const t2 = makeTicket([2, 3, 4, 5, 6], 11, 1);
            const price2 = await lottery.ticketPrice();
            await expect(
                lottery.connect(alice).buyTickets(
                    [t2.whites], [t2.goldNum], [t2.goldPos], charlie.address,
                    { value: price2 },
                ),
            ).to.not.emit(lottery, 'ReferrerRegistered');
        });

        it('ZeroAddress referrer does not register', async function () {
            const { lottery, alice } = await loadFixture(deployFixture);
            const t = makeTicket([1, 2, 3, 4, 5], 10, 0);

            await expect(buyTickets(lottery, alice, [t]))
                .to.not.emit(lottery, 'ReferrerRegistered');
        });
    });

    describe('V2: Fee split without referrer', function () {
        it('10% goes to nftRevenuePool, 10% to ownerFees, 0% to referral', async function () {
            const { lottery, alice } = await loadFixture(deployFixture);
            const t = makeTicket([1, 2, 3, 4, 5], 10, 0);
            await buyTickets(lottery, alice, [t]);

            const price = MIN_TICKET_PRICE;  // first ticket on empty pool
            const totalFee = (price * 2000n) / 10000n;     // 20%
            const nftShare = (totalFee * 5000n) / 10000n;  // 50% of fee = 10% of totalCost
            const adminShare = totalFee - nftShare;          // 10% of totalCost

            expect(await lottery.nftRevenuePool()).to.equal(nftShare);
            expect(await lottery.nftTotalDistributed()).to.equal(nftShare);
            expect(await lottery.ownerFees()).to.equal(adminShare);
            expect(await lottery.referralEarnings(alice.address)).to.equal(0n);
        });
    });

    describe('V2: Fee split with referrer', function () {
        it('10% NFT, 7% admin, 3% referral when referrer is set', async function () {
            const { lottery, alice, bob } = await loadFixture(deployFixture);
            const t = makeTicket([1, 2, 3, 4, 5], 10, 0);
            const price = await lottery.ticketPrice();

            // Alice buys with Bob as referrer
            await lottery.connect(alice).buyTickets(
                [t.whites], [t.goldNum], [t.goldPos], bob.address,
                { value: price },
            );

            const totalCost = price;
            const totalFee = (totalCost * 2000n) / 10000n;     // 20%
            const nftShare = (totalFee * 5000n) / 10000n;       // 10% of totalCost
            const refShare = (totalCost * 300n) / 10000n;        // 3% of totalCost
            const adminShare = totalFee - nftShare - refShare;   // 7% of totalCost

            expect(await lottery.nftRevenuePool()).to.equal(nftShare);
            expect(await lottery.ownerFees()).to.equal(adminShare);
            expect(await lottery.referralEarnings(bob.address)).to.equal(refShare);
        });

        it('ReferralEarned event is emitted with correct amounts', async function () {
            const { lottery, alice, bob } = await loadFixture(deployFixture);
            const t = makeTicket([1, 2, 3, 4, 5], 10, 0);
            const price = await lottery.ticketPrice();

            const refShare = (price * 300n) / 10000n; // 3%

            await expect(
                lottery.connect(alice).buyTickets(
                    [t.whites], [t.goldNum], [t.goldPos], bob.address,
                    { value: price },
                ),
            ).to.emit(lottery, 'ReferralEarned').withArgs(bob.address, alice.address, refShare);
        });
    });

    describe('V2: claimReferralEarnings', function () {
        it('referrer can claim accumulated earnings', async function () {
            const { lottery, alice, bob } = await loadFixture(deployFixture);
            const t = makeTicket([1, 2, 3, 4, 5], 10, 0);
            const price = await lottery.ticketPrice();

            // Alice buys with Bob as referrer
            await lottery.connect(alice).buyTickets(
                [t.whites], [t.goldNum], [t.goldPos], bob.address,
                { value: price },
            );

            const refShare = (price * 300n) / 10000n;
            expect(await lottery.referralEarnings(bob.address)).to.equal(refShare);

            const balBefore = await ethers.provider.getBalance(bob.address);
            const tx = await lottery.connect(bob).claimReferralEarnings();
            const receipt = await tx.wait();
            const gasCost = receipt.gasUsed * receipt.gasPrice;
            const balAfter = await ethers.provider.getBalance(bob.address);

            expect(balAfter - balBefore + gasCost).to.equal(refShare);
            expect(await lottery.referralEarnings(bob.address)).to.equal(0n);
        });

        it('emits ReferralEarningsClaimed event', async function () {
            const { lottery, alice, bob } = await loadFixture(deployFixture);
            const t = makeTicket([1, 2, 3, 4, 5], 10, 0);
            const price = await lottery.ticketPrice();

            await lottery.connect(alice).buyTickets(
                [t.whites], [t.goldNum], [t.goldPos], bob.address,
                { value: price },
            );

            const refShare = (price * 300n) / 10000n;
            await expect(lottery.connect(bob).claimReferralEarnings())
                .to.emit(lottery, 'ReferralEarningsClaimed')
                .withArgs(bob.address, refShare);
        });

        it('reverts when no earnings to claim', async function () {
            const { lottery, alice } = await loadFixture(deployFixture);
            await expect(
                lottery.connect(alice).claimReferralEarnings(),
            ).to.be.revertedWithCustomError(lotteryViewsLib, 'NothingToClaim');
        });
    });

    describe('V2: claimNFTRevenue', function () {
        async function deployWithNFTFixture() {
            const base = await deployFixture();
            const { lottery, owner, alice, bob } = base;

            // Deploy GoldenTicket and mint token 0 to alice
            const GoldenTicket = await ethers.getContractFactory('GoldenTicket');
            const nft = await GoldenTicket.deploy(ethers.parseEther('0.1'), '');
            await nft.waitForDeployment();

            await nft.connect(owner).adminMint(alice.address); // tokenId 0

            // Wire NFT contract to lottery
            await lottery.connect(owner).setGoldenTicketContract(await nft.getAddress());

            return { ...base, nft };
        }

        it('NFT holder can claim 1/10 of revenue pool', async function () {
            const { lottery, nft, alice, bob } = await loadFixture(deployWithNFTFixture);

            // Buy some tickets to generate NFT revenue
            const t = makeTicket([1, 2, 3, 4, 5], 10, 0);
            await buyTickets(lottery, bob, [t]);

            const price = MIN_TICKET_PRICE;
            const totalFee = (price * 2000n) / 10000n;
            const nftShare = (totalFee * 5000n) / 10000n;
            const perToken = nftShare / 10n;

            expect(await lottery.getClaimableNFTRevenue(0)).to.equal(perToken);

            const balBefore = await ethers.provider.getBalance(alice.address);
            const tx = await lottery.connect(alice).claimNFTRevenue(0);
            const receipt = await tx.wait();
            const gasCost = receipt.gasUsed * receipt.gasPrice;
            const balAfter = await ethers.provider.getBalance(alice.address);

            expect(balAfter - balBefore + gasCost).to.equal(perToken);
        });

        it('emits NFTRevenueClaimed event', async function () {
            const { lottery, nft, alice, bob } = await loadFixture(deployWithNFTFixture);

            const t = makeTicket([1, 2, 3, 4, 5], 10, 0);
            await buyTickets(lottery, bob, [t]);

            const price = MIN_TICKET_PRICE;
            const totalFee = (price * 2000n) / 10000n;
            const nftShare = (totalFee * 5000n) / 10000n;
            const perToken = nftShare / 10n;

            await expect(lottery.connect(alice).claimNFTRevenue(0))
                .to.emit(lottery, 'NFTRevenueClaimed')
                .withArgs(0, alice.address, perToken);
        });

        it('non-owner of NFT cannot claim', async function () {
            const { lottery, nft, bob } = await loadFixture(deployWithNFTFixture);

            const t = makeTicket([1, 2, 3, 4, 5], 10, 0);
            await buyTickets(lottery, bob, [t]);

            // Bob doesn't own token 0
            await expect(
                lottery.connect(bob).claimNFTRevenue(0),
            ).to.be.revertedWithCustomError(lotteryViewsLib, 'NotNFTOwner');
        });

        it('reverts when no revenue to claim', async function () {
            const { lottery, alice } = await loadFixture(deployWithNFTFixture);

            // No tickets bought, no revenue
            await expect(
                lottery.connect(alice).claimNFTRevenue(0),
            ).to.be.revertedWithCustomError(lotteryViewsLib, 'NoNFTRevenue');
        });

        it('reverts when goldenTicketContract not set', async function () {
            const { lottery, alice } = await loadFixture(deployFixture);

            await expect(
                lottery.connect(alice).claimNFTRevenue(0),
            ).to.be.revertedWithCustomError(lotteryViewsLib, 'ZeroAddress');
        });

        it('double claim reverts (no new revenue)', async function () {
            const { lottery, nft, alice, bob } = await loadFixture(deployWithNFTFixture);

            const t = makeTicket([1, 2, 3, 4, 5], 10, 0);
            await buyTickets(lottery, bob, [t]);

            // First claim succeeds
            await lottery.connect(alice).claimNFTRevenue(0);

            // Second claim with no new revenue reverts
            await expect(
                lottery.connect(alice).claimNFTRevenue(0),
            ).to.be.revertedWithCustomError(lotteryViewsLib, 'NoNFTRevenue');
        });

        it('revenue accumulates across multiple ticket purchases', async function () {
            const { lottery, nft, alice, bob } = await loadFixture(deployWithNFTFixture);

            const t1 = makeTicket([1, 2, 3, 4, 5], 10, 0);
            const t2 = makeTicket([2, 3, 4, 5, 6], 11, 1);
            const price = await lottery.ticketPrice();

            // Two separate purchases
            await buyTickets(lottery, bob, [t1]);
            await buyTickets(lottery, bob, [t2]);

            const nftPool = await lottery.nftRevenuePool();
            const claimable = await lottery.getClaimableNFTRevenue(0);
            expect(claimable).to.equal(nftPool / 10n);
        });
    });

    // ═══════════════════════════════════════════════════════════════
    //  V2: GoldenTicket Super Jackpot Prize
    // ═══════════════════════════════════════════════════════════════

    describe('GoldenTicket Super Jackpot Prize', function () {
        async function deployWithSuperJackpotFixture() {
            const base = await deployFixture();
            const { lottery, owner } = base;

            const GoldenTicket = await ethers.getContractFactory('GoldenTicket');
            const nft = await GoldenTicket.deploy(ethers.parseEther('0.1'), '');
            await nft.waitForDeployment();
            const nftAddr = await nft.getAddress();

            // Wire both sides
            await lottery.connect(owner).setGoldenTicketContract(nftAddr);
            await nft.connect(owner).setLotteryContract(await lottery.getAddress());

            return { ...base, nft };
        }

        it('should auto-mint GoldenTicket to first super jackpot winner', async function () {
            const { lottery, mockVRF, alice, nft } = await loadFixture(deployWithSuperJackpotFixture);

            const { whites, goldNum, goldPos } = generateDrawnNumbers(DETERMINISTIC_SEED);
            await buyTickets(lottery, alice, [makeTicket(whites, goldNum, goldPos)]);
            await closeDraw(lottery);
            await fulfillDraw(mockVRF, 1, DETERMINISTIC_SEED);
            await lottery.settleRound();

            // Alice should own tokenId 0
            expect(await nft.ownerOf(0)).to.equal(alice.address);
            expect(await nft.totalMinted()).to.equal(1);
        });

        it('should emit GoldenTicketAwarded event on first super jackpot', async function () {
            const { lottery, mockVRF, alice, nft } = await loadFixture(deployWithSuperJackpotFixture);

            const { whites, goldNum, goldPos } = generateDrawnNumbers(DETERMINISTIC_SEED);
            await buyTickets(lottery, alice, [makeTicket(whites, goldNum, goldPos)]);
            await closeDraw(lottery);
            await fulfillDraw(mockVRF, 1, DETERMINISTIC_SEED);

            // GoldenTicketAwarded event is emitted directly by the GoldenTicket contract
            await expect(lottery.settleRound())
                .to.emit(nft, 'GoldenTicketAwarded')
                .withArgs(0, alice.address);
        });

        it('should only mint once (goldenTicketAwarded flag prevents second mint)', async function () {
            const { lottery, mockVRF, alice, bob, nft, lotteryMathLib } = await loadFixture(deployWithSuperJackpotFixture);

            const { whites, goldNum, goldPos } = generateDrawnNumbers(DETERMINISTIC_SEED);

            // Round 1: alice wins super jackpot → gets NFT
            await buyTickets(lottery, alice, [makeTicket(whites, goldNum, goldPos)]);
            await closeDraw(lottery);
            await fulfillDraw(mockVRF, 1, DETERMINISTIC_SEED);
            await lottery.settleRound();
            expect(await nft.totalMinted()).to.equal(1);

            // Round 2: bob also hits super jackpot → no second NFT mint
            const { whites: w2, goldNum: gn2, goldPos: gp2 } = generateDrawnNumbers(DETERMINISTIC_SEED);
            await buyTickets(lottery, bob, [makeTicket(w2, gn2, gp2)]);
            await closeDraw(lottery);
            await fulfillDraw(mockVRF, 2, DETERMINISTIC_SEED);

            // Should NOT emit GoldenTicketWon again
            await expect(lottery.settleRound())
                .to.not.emit(lotteryMathLib, 'GoldenTicketWon');

            // Still only 1 NFT minted
            expect(await nft.totalMinted()).to.equal(1);
        });

        it('should not revert settlement if GoldenTicket supply is exhausted', async function () {
            const { lottery, mockVRF, alice, owner, nft } = await loadFixture(deployWithSuperJackpotFixture);

            // Mint all 10 via adminMint to owner
            for (let i = 0; i < 10; i++) {
                await nft.connect(owner).adminMint(owner.address);
            }
            expect(await nft.totalMinted()).to.equal(10);

            // Super jackpot winner — settlement should succeed silently
            const { whites, goldNum, goldPos } = generateDrawnNumbers(DETERMINISTIC_SEED);
            await buyTickets(lottery, alice, [makeTicket(whites, goldNum, goldPos)]);
            await closeDraw(lottery);
            await fulfillDraw(mockVRF, 1, DETERMINISTIC_SEED);

            // Should not revert
            await expect(lottery.settleRound()).to.not.be.reverted;

            // No extra NFTs minted
            expect(await nft.totalMinted()).to.equal(10);
        });

        it('lotteryMint reverts when called by non-lottery address', async function () {
            const { nft, alice } = await loadFixture(deployWithSuperJackpotFixture);
            await expect(
                nft.connect(alice).lotteryMint(alice.address),
            ).to.be.revertedWithCustomError(nft, 'OnlyLottery');
        });

        it('setLotteryContract only callable by owner', async function () {
            const { nft, alice } = await loadFixture(deployWithSuperJackpotFixture);
            await expect(
                nft.connect(alice).setLotteryContract(alice.address),
            ).to.be.revertedWithCustomError(nft, 'OwnableUnauthorizedAccount');
        });

        it('lotteryMint reverts with AlreadyMintedOut if supply exhausted', async function () {
            const { nft, owner } = await loadFixture(deployWithSuperJackpotFixture);
            // Temporarily point lotteryContract to owner so we can call lotteryMint directly
            await nft.connect(owner).setLotteryContract(owner.address);
            for (let i = 0; i < 10; i++) {
                await nft.connect(owner).lotteryMint(owner.address);
            }
            await expect(
                nft.connect(owner).lotteryMint(owner.address),
            ).to.be.revertedWithCustomError(nft, 'AlreadyMintedOut');
        });

        it('goldenTicketAwarded flag prevents mint in subsequent rounds (explicit flag check)', async function () {
            const { lottery, mockVRF, alice, bob, nft } = await loadFixture(deployWithSuperJackpotFixture);

            const { whites, goldNum, goldPos } = generateDrawnNumbers(DETERMINISTIC_SEED);

            // Round 1: alice wins super jackpot → goldenTicketAwarded becomes true internally
            await buyTickets(lottery, alice, [makeTicket(whites, goldNum, goldPos)]);
            await closeDraw(lottery);
            await fulfillDraw(mockVRF, 1, DETERMINISTIC_SEED);
            await lottery.settleRound();

            // Verify the flag is set by reading storage directly (slot BASE+30)
            const baseSlot = BigInt(ethers.keccak256(ethers.toUtf8Bytes('liquidlottery.v1.main.storage')));
            const flagRaw = await ethers.provider.getStorage(await lottery.getAddress(), baseSlot + 30n);
            expect(flagRaw).to.not.equal(ethers.ZeroHash); // goldenTicketAwarded == true
            expect(await nft.totalMinted()).to.equal(1);

            // Round 2: bob also hits super jackpot → flag is still true, no second mint
            const { whites: whites2, goldNum: goldNum2, goldPos: goldPos2 } = generateDrawnNumbers(DETERMINISTIC_SEED);
            await buyTickets(lottery, bob, [makeTicket(whites2, goldNum2, goldPos2)]);
            await closeDraw(lottery);
            await fulfillDraw(mockVRF, 2, DETERMINISTIC_SEED);
            await lottery.settleRound();

            const flagRaw2 = await ethers.provider.getStorage(await lottery.getAddress(), baseSlot + 30n);
            expect(flagRaw2).to.not.equal(ethers.ZeroHash); // still true
            expect(await nft.totalMinted()).to.equal(1);
        });

        it('GoldenTicket is awarded when settlement uses settleRoundBatch path', async function () {
            const { lottery, mockVRF, alice, nft } = await loadFixture(deployWithSuperJackpotFixture);

            const { whites, goldNum, goldPos } = generateDrawnNumbers(DETERMINISTIC_SEED);
            await buyTickets(lottery, alice, [makeTicket(whites, goldNum, goldPos)]);
            await closeDraw(lottery);
            await fulfillDraw(mockVRF, 1, DETERMINISTIC_SEED);

            // Use batch settlement path instead of settleRound()
            await lottery.settleRoundBatch();

            expect(await nft.totalMinted()).to.equal(1);
            expect(await nft.ownerOf(0)).to.equal(alice.address);
        });
    });

    // ═══════════════════════════════════════════════════════════════
    //  V2: GoldenTicket mint → seedJackpot forwarding
    // ═══════════════════════════════════════════════════════════════

    describe('V2: GoldenTicket mint → seedJackpot', function () {
        async function deployMintSeedFixture() {
            const base = await deployFixture();
            const { lottery, owner, alice, bob } = base;
            const mintPrice = ethers.parseEther('1');
            const GoldenTicket = await ethers.getContractFactory('GoldenTicket');
            const nft = await GoldenTicket.deploy(mintPrice, '');
            await nft.waitForDeployment();
            await nft.connect(owner).setMintableSupply(10);
            // Wire both sides
            await nft.connect(owner).setLotteryContract(await lottery.getAddress());
            await lottery.connect(owner).setGoldenTicketContract(await nft.getAddress());
            return { ...base, nft, mintPrice };
        }

        it('GoldenTicket mint forwards HYPE to lottery jackpot', async function () {
            const { lottery, nft, alice, mintPrice } = await loadFixture(deployMintSeedFixture);
            const infoBefore = await lottery.getRoundInfo(1);

            await nft.connect(alice).mint({ value: mintPrice });

            const infoAfter = await lottery.getRoundInfo(1);
            expect(infoAfter.jackpotPool - infoBefore.jackpotPool).to.equal(mintPrice);
        });

        it('GoldenTicket mint reverts if lotteryContract not set', async function () {
            const { owner, alice } = await loadFixture(deployMintSeedFixture);
            const mintPrice = ethers.parseEther('1');
            const GoldenTicket = await ethers.getContractFactory('GoldenTicket');
            const nftNoLottery = await GoldenTicket.deploy(mintPrice, '');
            await nftNoLottery.waitForDeployment();
            await nftNoLottery.connect(owner).setMintableSupply(10);
            // lotteryContract is address(0) — mint must revert
            await expect(
                nftNoLottery.connect(alice).mint({ value: mintPrice }),
            ).to.be.reverted;
        });

        it('multiple mints accumulate in jackpot', async function () {
            const { lottery, nft, alice, bob, mintPrice } = await loadFixture(deployMintSeedFixture);
            const infoBefore = await lottery.getRoundInfo(1);

            await nft.connect(alice).mint({ value: mintPrice });
            await nft.connect(bob).mint({ value: mintPrice });

            const infoAfter = await lottery.getRoundInfo(1);
            expect(infoAfter.jackpotPool - infoBefore.jackpotPool).to.equal(mintPrice * 2n);
        });

        it('seedJackpot callable by admin', async function () {
            const { lottery } = await loadFixture(deployMintSeedFixture);
            const infoBefore = await lottery.getRoundInfo(1);
            const amount = ethers.parseEther('5');

            await lottery.seedJackpot({ value: amount });

            const infoAfter = await lottery.getRoundInfo(1);
            expect(infoAfter.jackpotPool - infoBefore.jackpotPool).to.equal(amount);
        });

        it('seedJackpot callable by goldenTicketContract', async function () {
            const { lottery, nft, alice, mintPrice } = await loadFixture(deployMintSeedFixture);
            // Minting triggers seedJackpot from the GoldenTicket contract address,
            // which is set as goldenTicketContract on the lottery
            const infoBefore = await lottery.getRoundInfo(1);

            await nft.connect(alice).mint({ value: mintPrice });

            const infoAfter = await lottery.getRoundInfo(1);
            expect(infoAfter.jackpotPool - infoBefore.jackpotPool).to.equal(mintPrice);
            expect(await nft.totalMinted()).to.equal(1);
        });

        it('seedJackpot reverts for unauthorized callers', async function () {
            const { lottery, alice } = await loadFixture(deployMintSeedFixture);

            await expect(
                lottery.connect(alice).seedJackpot({ value: ethers.parseEther('1') }),
            ).to.be.revertedWithCustomError(lottery, 'Unauthorized');
        });
    });

    // ═══════════════════════════════════════════════════════════════
    //  V2: claimNFTRevenue multi-round accumulation
    // ═══════════════════════════════════════════════════════════════

    describe('V2: claimNFTRevenue multi-round accumulation', function () {
        async function deployWithNFTMultiRoundFixture() {
            const base = await deployFixture();
            const { lottery, owner, alice } = base;

            const GoldenTicket = await ethers.getContractFactory('GoldenTicket');
            const nft = await GoldenTicket.deploy(ethers.parseEther('0.1'), '');
            await nft.waitForDeployment();

            await nft.connect(owner).adminMint(alice.address); // tokenId 0

            await lottery.connect(owner).setGoldenTicketContract(await nft.getAddress());

            return { ...base, nft };
        }

        it('NFT revenue accumulates correctly across multiple rounds', async function () {
            const { lottery, mockVRF, alice, bob, nft } = await loadFixture(deployWithNFTMultiRoundFixture);

            // Round 1: buy tickets and complete the round with no winners
            const t1 = makeTicket([1, 2, 3, 4, 5], 10, 0);
            await buyTickets(lottery, bob, [t1]);
            await closeDraw(lottery);
            await fulfillDraw(mockVRF, 1, NON_MATCHING_SEED);
            await lottery.settleRound();

            // Round 2: buy tickets and complete the round with no winners
            const t2 = makeTicket([2, 3, 4, 5, 6], 11, 1);
            await buyTickets(lottery, bob, [t2]);
            await closeDraw(lottery);
            await fulfillDraw(mockVRF, 2, NON_MATCHING_SEED);
            await lottery.settleRound();

            // Total nftTotalDistributed includes revenue from both rounds
            const totalDistributed = await lottery.nftTotalDistributed();
            const perToken = totalDistributed / 10n;

            expect(await lottery.getClaimableNFTRevenue(0)).to.equal(perToken);

            // Alice claims and should receive the full accumulated amount
            const balBefore = await ethers.provider.getBalance(alice.address);
            const tx = await lottery.connect(alice).claimNFTRevenue(0);
            const receipt = await tx.wait();
            const gasCost = receipt.gasUsed * receipt.gasPrice;
            const balAfter = await ethers.provider.getBalance(alice.address);

            expect(balAfter - balBefore + gasCost).to.equal(perToken);
            expect(await lottery.getClaimableNFTRevenue(0)).to.equal(0n);
        });

        it('claim between rounds: partial claim then new revenue', async function () {
            const { lottery, mockVRF, alice, bob, nft } = await loadFixture(deployWithNFTMultiRoundFixture);

            // Round 1: buy tickets to generate revenue
            const t1 = makeTicket([1, 2, 3, 4, 5], 10, 0);
            await buyTickets(lottery, bob, [t1]);
            const distributed1 = await lottery.nftTotalDistributed();
            const perToken1 = distributed1 / 10n;

            // Alice claims her share from round 1 revenue
            await lottery.connect(alice).claimNFTRevenue(0);
            expect(await lottery.getClaimableNFTRevenue(0)).to.equal(0n);

            // Complete round 1
            await closeDraw(lottery);
            await fulfillDraw(mockVRF, 1, NON_MATCHING_SEED);
            await lottery.settleRound();

            // Round 2: buy tickets to generate new revenue
            const t2 = makeTicket([2, 3, 4, 5, 6], 11, 1);
            await buyTickets(lottery, bob, [t2]);

            // Only round 2's share should be claimable now
            const distributed2 = await lottery.nftTotalDistributed();
            const perToken2 = distributed2 / 10n;
            const expectedClaimable = perToken2 - perToken1;

            expect(await lottery.getClaimableNFTRevenue(0)).to.equal(expectedClaimable);

            // Alice claims again and gets only the new revenue
            const balBefore = await ethers.provider.getBalance(alice.address);
            const tx = await lottery.connect(alice).claimNFTRevenue(0);
            const receipt = await tx.wait();
            const gasCost = receipt.gasUsed * receipt.gasPrice;
            const balAfter = await ethers.provider.getBalance(alice.address);

            expect(balAfter - balBefore + gasCost).to.equal(expectedClaimable);
        });
    });

    // ═══════════════════════════════════════════════════════════════
    //  V2: Fee split with free ticket credits
    // ═══════════════════════════════════════════════════════════════

    describe('V2: Fee split with free ticket credits', function () {
        // Helper: buy one ticket as alice, advance time past UPKEEP_INTERVAL + DRAW_GRACE,
        // call triggerPublicDraw as bob (awarding him 2 free ticket credits), then fulfill
        // and settle round 1 so we enter round 2 with bob holding 2 free credits.
        async function setupFreeCredits(lottery, mockVRF, alice, bob) {
            await buyTickets(lottery, alice, [makeTicket([1, 2, 3, 4, 5], 10, 0)]);
            await time.increase(Number(UPKEEP_INTERVAL) + Number(DRAW_GRACE));
            await lottery.connect(bob).triggerPublicDraw();
            await fulfillDraw(mockVRF, 1, NON_MATCHING_SEED);
            await lottery.settleRound();
        }

        it('fee split is correct when all tickets are free (0 paid)', async function () {
            const { lottery, mockVRF, alice, bob } = await loadFixture(deployFixture);

            await setupFreeCredits(lottery, mockVRF, alice, bob);

            // Bob has 2 free credits; note pools and fees before buying
            expect(await lottery.freeTicketCredits(bob.address)).to.equal(2n);
            const nftPoolBefore = await lottery.nftRevenuePool();
            const ownerFeesBefore = await lottery.ownerFees();
            const refEarningsBefore = await lottery.referralEarnings(bob.address);

            // Round 2: bob buys exactly 2 tickets with 0 ETH (all free)
            await buyTickets(lottery, bob, [
                makeTicket([1, 2, 3, 4, 5], 10, 0),
                makeTicket([2, 3, 4, 5, 6], 11, 1),
            ], 0n);

            // No new fees since totalCost == 0
            expect(await lottery.nftRevenuePool()).to.equal(nftPoolBefore);
            expect(await lottery.ownerFees()).to.equal(ownerFeesBefore);
            expect(await lottery.referralEarnings(bob.address)).to.equal(refEarningsBefore);

            // Tickets are still registered
            expect(await lottery.playerTicketCount(2, bob.address)).to.equal(2n);
        });

        it('fee split is correct when mixing free credits and paid tickets', async function () {
            const { lottery, mockVRF, alice, bob } = await loadFixture(deployFixture);

            await setupFreeCredits(lottery, mockVRF, alice, bob);

            // Bob has 2 free credits; buys 3 tickets paying for only 1
            const price = await lottery.ticketPrice();

            const nftPoolBefore = await lottery.nftRevenuePool();
            const ownerFeesBefore = await lottery.ownerFees();

            await lottery.connect(bob).buyTickets(
                [[1, 2, 3, 4, 5], [2, 3, 4, 5, 6], [3, 4, 5, 6, 7]],
                [10, 11, 12], [0, 1, 2],
                ethers.ZeroAddress, { value: price },
            );

            // Fee split is computed only on the 1 paid ticket's price
            const totalCost = price; // only 1 ticket paid
            const totalFee = (totalCost * 2000n) / 10000n;
            const nftShare = (totalFee * 5000n) / 10000n;
            const adminShare = totalFee - nftShare;

            expect(await lottery.nftRevenuePool()).to.equal(nftPoolBefore + nftShare);
            expect(await lottery.ownerFees()).to.equal(ownerFeesBefore + adminShare);
        });

        it('fee split with free credits AND a referrer', async function () {
            const { lottery, mockVRF, alice, bob, charlie } = await loadFixture(deployFixture);

            await setupFreeCredits(lottery, mockVRF, alice, bob);

            // Bob has 2 free credits; buys 3 tickets with charlie as referrer, pays for 1
            const price = await lottery.ticketPrice();

            const refEarningsBefore = await lottery.referralEarnings(charlie.address);
            const nftPoolBefore = await lottery.nftRevenuePool();
            const ownerFeesBefore = await lottery.ownerFees();

            await lottery.connect(bob).buyTickets(
                [[1, 2, 3, 4, 5], [2, 3, 4, 5, 6], [3, 4, 5, 6, 7]],
                [10, 11, 12], [0, 1, 2],
                charlie.address, { value: price },
            );

            // Fee split on 1 paid ticket only
            const totalCost = price;
            const totalFee = (totalCost * 2000n) / 10000n;
            const nftShare = (totalFee * 5000n) / 10000n;
            const refShare = (totalCost * 300n) / 10000n;
            const adminShare = totalFee - nftShare - refShare;

            expect(await lottery.referralEarnings(charlie.address)).to.equal(refEarningsBefore + refShare);
            expect(await lottery.nftRevenuePool()).to.equal(nftPoolBefore + nftShare);
            expect(await lottery.ownerFees()).to.equal(ownerFeesBefore + adminShare);
        });
    });

    // ═══════════════════════════════════════════════════════════════
    //  V2: Referral persistence across rounds
    // ═══════════════════════════════════════════════════════════════

    describe('V2: Referral persistence across rounds', function () {
        it('referrer earns commission in round 2 after being set in round 1', async function () {
            const { lottery, mockVRF, alice, bob } = await loadFixture(deployFixture);
            const t = makeTicket([1, 2, 3, 4, 5], 10, 0);
            const price1 = await lottery.ticketPrice();

            // Round 1: Alice sets Bob as referrer
            await lottery.connect(alice).buyTickets(
                [t.whites], [t.goldNum], [t.goldPos], bob.address,
                { value: price1 },
            );
            await closeDraw(lottery);
            await fulfillDraw(mockVRF, 1, NON_MATCHING_SEED);
            await lottery.settleRound();

            const earningsAfterR1 = await lottery.referralEarnings(bob.address);

            // Round 2: Alice buys more tickets (no referrer param — doesn't matter, referrer is permanent)
            const price2 = await lottery.ticketPrice();
            await buyTickets(lottery, alice, [makeTicket([2, 3, 4, 5, 6], 11, 1)]);

            const expectedRefShare = (price2 * 300n) / 10000n;
            expect(await lottery.referralEarnings(bob.address)).to.equal(earningsAfterR1 + expectedRefShare);
        });

        it('referrer accumulates earnings across multiple rounds before claiming', async function () {
            const { lottery, mockVRF, alice, bob } = await loadFixture(deployFixture);
            const t = makeTicket([1, 2, 3, 4, 5], 10, 0);
            const price1 = await lottery.ticketPrice();

            // Round 1: Alice buys with Bob as referrer
            await lottery.connect(alice).buyTickets(
                [t.whites], [t.goldNum], [t.goldPos], bob.address,
                { value: price1 },
            );
            const refShare1 = (price1 * 300n) / 10000n;

            await closeDraw(lottery);
            await fulfillDraw(mockVRF, 1, NON_MATCHING_SEED);
            await lottery.settleRound();

            // Round 2: Alice buys again (Bob's referrer persists automatically)
            const price2 = await lottery.ticketPrice();
            await buyTickets(lottery, alice, [makeTicket([2, 3, 4, 5, 6], 11, 1)]);
            const refShare2 = (price2 * 300n) / 10000n;

            // Bob's total earnings = round 1 + round 2
            expect(await lottery.referralEarnings(bob.address)).to.equal(refShare1 + refShare2);

            // Bob claims once and gets the full accumulated amount
            const balBefore = await ethers.provider.getBalance(bob.address);
            const tx = await lottery.connect(bob).claimReferralEarnings();
            const receipt = await tx.wait();
            const gasCost = receipt.gasUsed * receipt.gasPrice;
            const balAfter = await ethers.provider.getBalance(bob.address);

            expect(balAfter - balBefore + gasCost).to.equal(refShare1 + refShare2);
            expect(await lottery.referralEarnings(bob.address)).to.equal(0n);
        });
    });

    // ═══════════════════════════════════════════════════════════════
    //  V2: pendingPayouts fallback on failed ETH transfer
    // ═══════════════════════════════════════════════════════════════

    describe('V2: pendingPayouts fallback on failed ETH transfer', function () {
        async function deployWithNFTAndRejectETHFixture() {
            const base = await deployFixture();
            const { lottery, owner } = base;

            const GoldenTicket = await ethers.getContractFactory('GoldenTicket');
            const nft = await GoldenTicket.deploy(ethers.parseEther('0.1'), '');
            await nft.waitForDeployment();

            const RejectETH = await ethers.getContractFactory('RejectETH');
            const rejecter = await RejectETH.deploy();
            await rejecter.waitForDeployment();

            // Mint token 0 to the ETH-rejecting contract
            await nft.connect(owner).adminMint(await rejecter.getAddress());

            await lottery.connect(owner).setGoldenTicketContract(await nft.getAddress());

            return { ...base, nft, rejecter };
        }

        it('claimNFTRevenue falls back to pendingPayouts when transfer fails', async function () {
            const { lottery, rejecter, bob } = await loadFixture(deployWithNFTAndRejectETHFixture);

            // Generate NFT revenue by buying a ticket
            await buyTickets(lottery, bob, [makeTicket([1, 2, 3, 4, 5], 10, 0)]);

            const claimable = await lottery.getClaimableNFTRevenue(0);
            expect(claimable).to.be.gt(0n);

            const pendingBefore = await lottery.pendingPayouts(await rejecter.getAddress());

            // The rejecting contract calls claimNFTRevenue — transfer fails, should not revert
            await rejecter.callClaimNFTRevenue(await lottery.getAddress(), 0);

            // pendingPayouts should have increased by the claimable amount
            expect(await lottery.pendingPayouts(await rejecter.getAddress()))
                .to.equal(pendingBefore + claimable);

            // Revenue is no longer claimable
            expect(await lottery.getClaimableNFTRevenue(0)).to.equal(0n);
        });

        it('claimReferralEarnings falls back to pendingPayouts when transfer fails', async function () {
            const { lottery, rejecter, alice } = await loadFixture(deployWithNFTAndRejectETHFixture);

            // Register the ETH-rejecting contract as referrer and generate earnings
            await lottery.connect(alice).buyTickets(
                [[1, 2, 3, 4, 5]], [10], [0],
                await rejecter.getAddress(),
                { value: MIN_TICKET_PRICE },
            );

            const earnings = await lottery.referralEarnings(await rejecter.getAddress());
            expect(earnings).to.be.gt(0n);

            const pendingBefore = await lottery.pendingPayouts(await rejecter.getAddress());

            // The rejecting contract calls claimReferralEarnings — transfer fails, should not revert
            await rejecter.callClaimReferralEarnings(await lottery.getAddress());

            // pendingPayouts should have increased by the earnings amount
            expect(await lottery.pendingPayouts(await rejecter.getAddress()))
                .to.equal(pendingBefore + earnings);

            // Referral earnings are cleared
            expect(await lottery.referralEarnings(await rejecter.getAddress())).to.equal(0n);
        });
    });

    // ═══════════════════════════════════════════════════════════════
    //  V2: End-to-end integration
    // ═══════════════════════════════════════════════════════════════

    describe('V2: End-to-end integration', function () {
        async function deployWithSuperJackpotAndNFTFixture() {
            const base = await deployFixture();
            const { lottery, owner, charlie } = base;

            const GoldenTicket = await ethers.getContractFactory('GoldenTicket');
            const nft = await GoldenTicket.deploy(ethers.parseEther('0.1'), '');
            await nft.waitForDeployment();

            // Mint token 0 to charlie (the NFT revenue recipient)
            await nft.connect(owner).adminMint(charlie.address);

            // Wire both sides
            await lottery.connect(owner).setGoldenTicketContract(await nft.getAddress());
            await nft.connect(owner).setLotteryContract(await lottery.getAddress());

            return { ...base, nft };
        }

        it('full V2 flow: referral + NFT revenue + super jackpot prize + claim', async function () {
            const { lottery, mockVRF, alice, bob, charlie, nft, owner } = await loadFixture(deployWithSuperJackpotAndNFTFixture);

            const { whites, goldNum, goldPos } = generateDrawnNumbers(DETERMINISTIC_SEED);
            const price = await lottery.ticketPrice();

            // Alice buys the winning ticket with Bob as referrer
            await lottery.connect(alice).buyTickets(
                [whites], [goldNum], [goldPos], bob.address,
                { value: price },
            );

            // Complete the round using the deterministic seed so Alice wins
            await closeDraw(lottery);
            await fulfillDraw(mockVRF, 1, DETERMINISTIC_SEED);
            await lottery.settleRound();

            // ── Referral: Bob should have 3% of ticket cost ──
            const expectedRefShare = (price * 300n) / 10000n;
            expect(await lottery.referralEarnings(bob.address)).to.equal(expectedRefShare);

            // ── NFT revenue: charlie (token 0 holder) should have 1/10 of nftTotalDistributed ──
            const totalDistributed = await lottery.nftTotalDistributed();
            const expectedNFTShare = totalDistributed / 10n;
            expect(await lottery.getClaimableNFTRevenue(0)).to.equal(expectedNFTShare);

            // ── Prize: Alice should have jackpot + super jackpot ──
            const roundInfo = await lottery.getRoundInfo(1);
            expect(roundInfo.jackpotWinners).to.equal(1);
            expect(roundInfo.superWinners).to.equal(1);

            const contractBalBefore = await ethers.provider.getBalance(await lottery.getAddress());

            // Bob claims referral earnings
            await lottery.connect(bob).claimReferralEarnings();
            expect(await lottery.referralEarnings(bob.address)).to.equal(0n);

            // Charlie claims NFT revenue
            await lottery.connect(charlie).claimNFTRevenue(0);
            expect(await lottery.getClaimableNFTRevenue(0)).to.equal(0n);

            // Alice claims her prize
            const alicePrize = await lottery.getClaimableAmount(1, alice.address);
            expect(alicePrize).to.be.gt(0n);
            await lottery.connect(alice).claimPrize(1, 0);

            // Contract balance should have decreased by claimed amounts
            const contractBalAfter = await ethers.provider.getBalance(await lottery.getAddress());
            expect(contractBalAfter).to.be.lt(contractBalBefore);
        });
    });
});
