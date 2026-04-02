// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import "@chainlink/contracts-ccip/contracts/interfaces/IRouterClient.sol";
import "@chainlink/contracts-ccip/contracts/libraries/Client.sol";

interface IGoldenTicketMint {
    function lotteryMint(address to) external;
}

// ─── Types ───────────────────────────────────────────────────────────────────
enum RoundState { OPEN, DRAWING, DRAWN, SETTLED }

struct TicketInfo {
    address player;
    uint8[5] whites;
    uint8   goldNum;
    uint8   goldPos;
}

struct RoundInfo {
    uint256    jackpotPool;
    uint256    seedPool;
    uint256    feePool;
    uint256    ticketCount;
    RoundState state;
    uint8[5]   drawnWhites;
    uint8      drawnGoldNum;
    uint8      drawnGoldPos;
    uint256    jackpotWinners;
    uint256    superWinners;
    bytes32    ccipMessageId;
    uint256    jackpotPrizePerWinner;
    uint256    superPrizePerWinner;
}

struct LotteryStorage {
    address ccipRouter;
    uint64  sourceChainSelector;
    address vrfRequester;
    uint256 ccipGasLimit;
    uint256 currentRound;
    mapping(uint256 => RoundInfo)                         rounds;
    mapping(uint256 => mapping(uint256 => TicketInfo))    roundTickets;
    mapping(uint256 => mapping(address => uint256))       playerTicketCount;
    mapping(uint256 => mapping(address => uint256[]))     playerIndices;
    mapping(address => uint256)                           pendingPayouts;
    mapping(uint256 => mapping(uint256 => bool))          ticketClaimed;
    uint256 ownerFees;
    mapping(bytes32 => uint256)                           pendingAdminActions;
    address pendingUpgradeImpl;
    uint256 upgradeProposalExecuteAfter;
    uint256 settlementBatchSize;
    mapping(uint256 => uint256) settlementProgress;
    mapping(uint256 => uint256) settleJCount;
    mapping(uint256 => uint256) settleSCount;
    uint256 upkeepInterval;
    uint256 lastUpkeepTime;
    uint256 pendingUpkeepInterval;
    uint256 upkeepIntervalProposalExecuteAfter;
    uint256 drawRequestedAt;
    mapping(address => uint256) freeTicketCredits;
    // ── V2: GoldenTicket + Referral ──────────────────────────
    address goldenTicketContract;
    uint256 nftRevenuePool;
    mapping(uint256 => uint256) nftClaimedRevenue;       // tokenId → total already claimed
    uint256 nftTotalDistributed;                          // cumulative total added to nftRevenuePool
    mapping(address => address) referrers;
    mapping(address => uint256) referralEarnings;
    bool goldenTicketAwarded;
}

// ─── Errors ──────────────────────────────────────────────────────────────────
error Unauthorized();
error NoIndirectCalls();
error ZeroAddress();
error NotAContract();
error OnlyCCIPRouter();
error WrongSourceChain();
error WrongRequester();
error WrongRound();
error UnexpectedState();
error UpgradePending();
error NoTickets();
error ArrayLengthMismatch();
error InsufficientPayment();
error RoundNotOpen();
error TicketLimitExceeded();
error RoundTicketCapReached();
error RoundNotSettled();
error NothingToClaim();
error NoTicketsSold();
error IntervalNotElapsed();
error NotDrawnYet();
error UseBatchSettlement();
error InvalidBatchSize();
error GasLimitOutOfRange();
error ActionNotProposed();
error TimelockNotExpired();
error ExistingProposal();
error NoFees();
error TransferFailed();
error NoValueSent();
error NotDrawing();
error GracePeriodActive();
error IntervalMustBePositive();
error UpgradeNotProposed();
error UpgradeProposalExpired();
error AlreadyClaimed();
error NotTicketOwner();
error NoPrize();
error InsufficientOwnerFees();
error GoldOutOfRange();
error GoldPosOutOfRange();
error WhiteOutOfRange();
error WhitesNotSortedUnique();
error NoUpkeepNeeded();
error EmergencyCancelDelayNotMet();
error SelfReferral();
error ReferrerAlreadySet();
error NotNFTOwner();
error NoNFTRevenue();

// ─── Events ──────────────────────────────────────────────────────────────────
event TicketsPurchased(uint256 indexed roundId, address indexed player, uint256 count);
event DrawRequested(uint256 indexed roundId, bytes32 ccipMessageId);
event NumbersDrawn(uint256 indexed roundId, uint8[5] whites, uint8 goldNum, uint8 goldPos);
event RoundSettled(uint256 indexed roundId, uint256 jackpotWinners, uint256 superWinners);
event PrizeClaimed(uint256 indexed roundId, address indexed player, uint256 amount);
event UpkeepPerformed(uint256 indexed roundId, string action);
event CCIPDrawFulfilled(uint256 indexed roundId, uint256 randomWord);
event DrawCancelled(uint256 indexed roundId);
event AdminActionProposed(bytes32 indexed actionHash, uint256 executeAfter);
event AdminActionExecuted(bytes32 indexed actionHash);
event AdminActionCancelled(bytes32 indexed actionHash);
event UpgradeProposed(address indexed newImplementation, uint256 executeAfter, uint256 expiresAt);
event UpkeepIntervalProposed(uint256 newInterval, uint256 executeAfter);
event OwnerFeesTopUp(address indexed sender, uint256 amount);
event DrawTriggerRewarded(address indexed caller, uint256 credits);
event SettleRewarded(address indexed caller, uint256 amount);
event ReferrerRegistered(address indexed player, address indexed referrer);
event ReferralEarned(address indexed referrer, address indexed player, uint256 amount);
event NFTRevenueClaimed(uint256 indexed tokenId, address indexed holder, uint256 amount);
event ReferralEarningsClaimed(address indexed referrer, uint256 amount);
event GoldenTicketWon(uint256 indexed roundId, address indexed winner);

// ─────────────────────────────────────────────────────────────────────────────
/**
 * @title LotteryMath
 * @notice Core game-logic library for LiquidLottery: ticket purchasing, CCIP
 *         draw flow, settlement, prize claiming, and number generation.
 *         Shares ERC-7201 namespaced storage (slot = keccak256("liquidlottery.
 *         v1.main.storage")) with LotteryViews, which handles view functions
 *         and admin-configuration setters.
 */
library LotteryMath {

    bytes32 private constant _SLOT = keccak256("liquidlottery.v1.main.storage");

    uint16  private constant TICKET_PRICE_BPS     = 5;
    uint256 private constant MIN_TICKET_PRICE     = 0.01 ether;
    uint256 private constant MAX_TICKET_PRICE     = 0.5 ether;
    uint8   private constant MAX_TICKETS          = 25;
    uint256 private constant MAX_ROUND_TICKETS    = 10_000;
    uint16  private constant FEE_BPS              = 2000;
    uint16  private constant JACKPOT_BPS          = 5000;
    uint256 private constant DRAW_GRACE_PERIOD    = 300;
    uint256 private constant UPGRADE_EXPIRY       = 1 hours;
    uint16  private constant SETTLE_REWARD_BPS    = 100;   // 1 % of fee pool to settle trigger
    uint8   private constant DRAW_TRIGGER_CREDITS = 2;     // free tickets awarded for public draw
    uint16  private constant REFERRAL_BPS         = 300;   // 3% referral fee
    uint16  private constant NFT_FEE_BPS          = 5000;  // 50% of fee → NFT holders (= 10% of totalCost)

    function _s() private pure returns (LotteryStorage storage s) {
        bytes32 slot = _SLOT;
        assembly { s.slot := slot }
    }

    // ── Init ─────────────────────────────────────────────────────
    function initStorage(address _ccipRouter, uint64 _selector, address _vrfRequester) external {
        LotteryStorage storage s = _s();
        s.ccipRouter          = _ccipRouter;
        s.sourceChainSelector = _selector;
        s.vrfRequester        = _vrfRequester;
        s.ccipGasLimit        = 500_000;
        s.currentRound        = 1;
        s.rounds[1].state     = RoundState.OPEN;
        s.upkeepInterval      = 86400;
        s.lastUpkeepTime      = block.timestamp;
        s.settlementBatchSize = 500;
    }

    // ── CCIP ─────────────────────────────────────────────────────
    function ccipReceiveValidated(Client.Any2EVMMessage calldata message) external {
        LotteryStorage storage s = _s();
        if (msg.sender != s.ccipRouter) revert OnlyCCIPRouter();
        if (message.sourceChainSelector != s.sourceChainSelector) revert WrongSourceChain();
        address sender = abi.decode(message.sender, (address));
        if (sender != s.vrfRequester) revert WrongRequester();

        (uint256 roundId, uint256 randomWord) = abi.decode(message.data, (uint256, uint256));
        if (roundId != s.currentRound) revert WrongRound();
        if (s.rounds[roundId].state != RoundState.DRAWING) revert UnexpectedState();
        emit CCIPDrawFulfilled(roundId, randomWord);
        _applyRandomness(s, roundId, randomWord);
    }

    // ── Player actions ───────────────────────────────────────────
    function buyTickets(
        uint8[5][] calldata whites,
        uint8[]    calldata goldNums,
        uint8[]    calldata goldPositions,
        address    referrer
    ) external {
        LotteryStorage storage s = _s();
        if (_isUpgradeWindow(s)) revert UpgradePending();
        uint256 count = whites.length;
        if (count == 0) revert NoTickets();
        if (count != goldNums.length || count != goldPositions.length) revert ArrayLengthMismatch();

        uint256 rid = s.currentRound;
        RoundInfo storage r = s.rounds[rid];
        if (r.state != RoundState.OPEN) revert RoundNotOpen();
        if (s.playerTicketCount[rid][msg.sender] + count > MAX_TICKETS) revert TicketLimitExceeded();
        if (r.ticketCount + count > MAX_ROUND_TICKETS) revert RoundTicketCapReached();

        if (r.ticketCount == 0) s.lastUpkeepTime = block.timestamp;

        // ── Register referrer (once, permanent) ──────────────────
        if (s.referrers[msg.sender] == address(0) && referrer != address(0)) {
            if (referrer == msg.sender) revert SelfReferral();
            s.referrers[msg.sender] = referrer;
            emit ReferrerRegistered(msg.sender, referrer);
        }

        // Apply free ticket credits
        uint256 credits   = s.freeTicketCredits[msg.sender];
        uint256 freeCount = credits >= count ? count : credits;
        if (freeCount > 0) s.freeTicketCredits[msg.sender] -= freeCount;
        uint256 paidCount = count - freeCount;
        uint256 price     = _ticketPrice(s);
        uint256 totalCost = price * paidCount;
        if (msg.value < totalCost) revert InsufficientPayment();

        for (uint256 i = 0; i < count; i++) {
            _validateTicket(whites[i], goldNums[i], goldPositions[i]);
            uint256 idx = r.ticketCount;
            s.roundTickets[rid][idx] = TicketInfo({ player: msg.sender, whites: whites[i], goldNum: goldNums[i], goldPos: goldPositions[i] });
            s.playerIndices[rid][msg.sender].push(idx);
            r.ticketCount++;
        }

        s.playerTicketCount[rid][msg.sender] += count;
        // ── Fee split (V2) ───────────────────────────────────────
        uint256 fee        = (totalCost * FEE_BPS)     / 10000;     // 20%
        uint256 jackpotAdd = (totalCost * JACKPOT_BPS) / 10000;     // 50%
        r.jackpotPool += jackpotAdd;
        r.seedPool    += totalCost - fee - jackpotAdd;               // 30%
        r.feePool     += fee;

        // 1) NFT holders: 50% of fee = 10% of totalCost
        uint256 nftShare   = (fee * NFT_FEE_BPS) / 10000;
        s.nftRevenuePool    += nftShare;
        s.nftTotalDistributed += nftShare;

        // 2) Referral: 3% of totalCost, taken from admin share
        uint256 adminShare = fee - nftShare;                         // 10% of totalCost
        address ref = s.referrers[msg.sender];
        if (ref != address(0)) {
            uint256 refShare = (totalCost * REFERRAL_BPS) / 10000;   // 3% of totalCost
            s.referralEarnings[ref] += refShare;
            adminShare -= refShare;                                  // admin → 7%
            emit ReferralEarned(ref, msg.sender, refShare);
        }

        // 3) Admin: whatever remains (7% or 10%)
        s.ownerFees += adminShare;

        uint256 refund = msg.value - totalCost;
        if (refund > 0) {
            (bool ok,) = payable(msg.sender).call{value: refund}("");
            if (!ok) s.pendingPayouts[msg.sender] += refund;
        }
        emit TicketsPurchased(rid, msg.sender, count);
    }

    function claimPrize(uint256 roundId, uint256 ticketIdx) external {
        _claimTicket(_s(), roundId, ticketIdx);
    }

    function claimPrizeBatch(uint256 roundId, uint256[] calldata ticketIndices) external {
        LotteryStorage storage s = _s();
        RoundInfo storage r = s.rounds[roundId];
        if (r.state != RoundState.SETTLED) revert RoundNotSettled();
        for (uint256 i = 0; i < ticketIndices.length; i++) {
            uint256 idx = ticketIndices[i];
            if (s.ticketClaimed[roundId][idx]) continue;
            TicketInfo storage t = s.roundTickets[roundId][idx];
            if (t.player != msg.sender) continue;
            uint256 prize = _calcPrize(r, t);
            if (prize == 0) continue;
            _executePrize(s, roundId, idx, prize);
        }
    }

    function claimPendingPayout() external {
        LotteryStorage storage s = _s();
        uint256 amount = s.pendingPayouts[msg.sender];
        if (amount == 0) revert NothingToClaim();
        s.pendingPayouts[msg.sender] = 0;
        (bool ok,) = payable(msg.sender).call{value: amount}("");
        if (!ok) revert TransferFailed();
    }

    // ── Draw / settle ────────────────────────────────────────────
    function closeBettingAndDraw() external {
        LotteryStorage storage s = _s();
        uint256 rid = s.currentRound;
        RoundInfo storage r = s.rounds[rid];
        if (r.state != RoundState.OPEN) revert RoundNotOpen();
        if (r.ticketCount == 0) revert NoTicketsSold();
        if (block.timestamp < s.lastUpkeepTime + s.upkeepInterval) revert IntervalNotElapsed();
        s.lastUpkeepTime = block.timestamp;
        _triggerDraw(s);
    }

    function settleRound() external {
        LotteryStorage storage s = _s();
        if (s.rounds[s.currentRound].state != RoundState.DRAWN) revert NotDrawnYet();
        if (s.rounds[s.currentRound].ticketCount > s.settlementBatchSize) revert UseBatchSettlement();
        _settleCurrentRound(s);
    }

    function settleRoundBatch() external {
        LotteryStorage storage s = _s();
        uint256 rid = s.currentRound;
        RoundInfo storage r = s.rounds[rid];
        if (r.state != RoundState.DRAWN) revert NotDrawnYet();

        uint8[5] memory dw = r.drawnWhites;
        uint8 dGN = r.drawnGoldNum;
        uint8 dGP = r.drawnGoldPos;
        uint256 tc = r.ticketCount;

        uint256 start = s.settlementProgress[rid];
        uint256 end   = start + s.settlementBatchSize;
        if (end > tc) end = tc;

        uint256 jc = s.settleJCount[rid];
        uint256 sc = s.settleSCount[rid];

        for (uint256 i = start; i < end; i++) {
            TicketInfo storage t = s.roundTickets[rid][i];
            if (_matchWhitesMem(t.whites, dw)) {
                jc++;
                if (t.goldNum == dGN && t.goldPos == dGP) sc++;
            }
        }
        s.settlementProgress[rid] = end;
        s.settleJCount[rid]       = jc;
        s.settleSCount[rid]       = sc;

        if (end >= tc) {
            delete s.settlementProgress[rid];
            delete s.settleJCount[rid];
            delete s.settleSCount[rid];
            _finalizeSettlement(s, rid, r, jc, sc);
        }
    }

    // ── Automation ────────────────────────────────────────────────
    function performUpkeep() external {
        LotteryStorage storage s = _s();
        uint256 rid = s.currentRound;
        RoundInfo storage r = s.rounds[rid];
        if (r.state == RoundState.OPEN) {
            if (r.ticketCount == 0) revert NoTicketsSold();
            if (block.timestamp < s.lastUpkeepTime + s.upkeepInterval) revert IntervalNotElapsed();
            s.lastUpkeepTime = block.timestamp;
            emit UpkeepPerformed(rid, "draw");
            _triggerDraw(s);
        } else if (r.state == RoundState.DRAWN) {
            emit UpkeepPerformed(rid, "settle");
            _settleCurrentRound(s);
        } else {
            revert NoUpkeepNeeded();
        }
    }

    function triggerPublicDraw() external {
        LotteryStorage storage s = _s();
        uint256 rid = s.currentRound;
        RoundInfo storage r = s.rounds[rid];
        if (r.state != RoundState.OPEN) revert RoundNotOpen();
        if (r.ticketCount == 0) revert NoTicketsSold();
        if (block.timestamp < s.lastUpkeepTime + s.upkeepInterval + DRAW_GRACE_PERIOD) revert GracePeriodActive();
        s.lastUpkeepTime = block.timestamp;
        emit UpkeepPerformed(rid, "public-draw");
        _triggerDraw(s);
        // Reward the caller with free ticket credits for triggering the draw
        s.freeTicketCredits[msg.sender] += DRAW_TRIGGER_CREDITS;
        emit DrawTriggerRewarded(msg.sender, DRAW_TRIGGER_CREDITS);
    }

    // ── generateDrawnNumbers (public pure) ────────────────────────
    function generateDrawnNumbers(uint256 seed) external pure returns (uint8[5] memory whites, uint8 goldNum, uint8 goldPos) {
        return _generateDrawnNumbers(seed);
    }

    // ══════════════ INTERNAL HELPERS ══════════════════════════════
    function _ticketPrice(LotteryStorage storage s) private view returns (uint256) {
        RoundInfo storage r = s.rounds[s.currentRound];
        uint256 pool = r.jackpotPool + r.seedPool;
        uint256 price = (pool * TICKET_PRICE_BPS) / 10000;
        if (price < MIN_TICKET_PRICE) return MIN_TICKET_PRICE;
        if (price > MAX_TICKET_PRICE) return MAX_TICKET_PRICE;
        return price;
    }

    function _isUpgradeWindow(LotteryStorage storage s) private view returns (bool) {
        if (s.pendingUpgradeImpl == address(0)) return false;
        uint256 ea = s.upgradeProposalExecuteAfter;
        return block.timestamp >= ea && block.timestamp < ea + UPGRADE_EXPIRY;
    }

    function _triggerDraw(LotteryStorage storage s) private {
        uint256 rid = s.currentRound;
        RoundInfo storage r = s.rounds[rid];
        r.state = RoundState.DRAWING;
        s.drawRequestedAt = block.timestamp;
        Client.EVM2AnyMessage memory msg_ = Client.EVM2AnyMessage({
            receiver:     abi.encode(s.vrfRequester),
            data:         abi.encode(rid),
            tokenAmounts: new Client.EVMTokenAmount[](0),
            feeToken:     address(0),
            extraArgs:    Client._argsToBytes(Client.EVMExtraArgsV1({gasLimit: s.ccipGasLimit}))
        });
        uint256 fee = IRouterClient(s.ccipRouter).getFee(s.sourceChainSelector, msg_);
        if (s.ownerFees < fee) revert InsufficientOwnerFees();
        s.ownerFees -= fee;
        bytes32 msgId = IRouterClient(s.ccipRouter).ccipSend{value: fee}(s.sourceChainSelector, msg_);
        r.ccipMessageId = msgId;
        emit DrawRequested(rid, msgId);
    }

    function _applyRandomness(LotteryStorage storage s, uint256 rid, uint256 randomWord) private {
        RoundInfo storage r = s.rounds[rid];
        (uint8[5] memory whites, uint8 goldNum, uint8 goldPos) = _generateDrawnNumbers(randomWord);
        r.drawnWhites  = whites;
        r.drawnGoldNum = goldNum;
        r.drawnGoldPos = goldPos;
        r.state        = RoundState.DRAWN;
        emit NumbersDrawn(rid, whites, goldNum, goldPos);
    }

    function _settleCurrentRound(LotteryStorage storage s) private {
        uint256 rid = s.currentRound;
        RoundInfo storage r = s.rounds[rid];
        uint8[5] memory dw = r.drawnWhites;
        uint8 dGN = r.drawnGoldNum; uint8 dGP = r.drawnGoldPos;
        uint256 tc = r.ticketCount;
        uint256 jc; uint256 sc;
        for (uint256 i = 0; i < tc; i++) {
            TicketInfo storage t = s.roundTickets[rid][i];
            if (_matchWhitesMem(t.whites, dw)) {
                jc++;
                if (t.goldNum == dGN && t.goldPos == dGP) sc++;
            }
        }
        _finalizeSettlement(s, rid, r, jc, sc);
    }

    function _finalizeSettlement(LotteryStorage storage s, uint256 rid, RoundInfo storage r, uint256 jc, uint256 sc) private {
        r.jackpotWinners = jc; r.superWinners = sc;
        // ── GoldenTicket award: mint to first Super Jackpot winner ──
        if (sc > 0 && !s.goldenTicketAwarded && s.goldenTicketContract != address(0)) {
            for (uint256 i = 0; i < r.ticketCount; i++) {
                TicketInfo storage t = s.roundTickets[rid][i];
                if (_matchWhitesMem(t.whites, r.drawnWhites) && t.goldNum == r.drawnGoldNum && t.goldPos == r.drawnGoldPos) {
                    try IGoldenTicketMint(s.goldenTicketContract).lotteryMint(t.player) {
                        s.goldenTicketAwarded = true;
                        emit GoldenTicketWon(rid, t.player);
                    } catch {}
                    break;
                }
            }
        }
        uint256 jp = jc > 0 ? r.jackpotPool / jc : 0;
        uint256 sp = sc > 0 ? r.seedPool    / sc : 0;
        r.jackpotPrizePerWinner = jp;
        r.superPrizePerWinner   = sp;
        uint256 nrid = rid + 1;
        if (jc == 0) { s.rounds[nrid].jackpotPool += r.jackpotPool; }
        else { uint256 d = r.jackpotPool - jp * jc; if (d > 0) s.rounds[nrid].jackpotPool += d; }
        if (sc == 0) { s.rounds[nrid].seedPool += r.seedPool; }
        else { uint256 d = r.seedPool - sp * sc; if (d > 0) s.rounds[nrid].seedPool += d; }
        r.state = RoundState.SETTLED;
        s.currentRound = nrid;
        s.rounds[nrid].state = RoundState.OPEN;
        emit RoundSettled(rid, jc, sc);
        // Reward the settle trigger: 1 % of the round fee pool paid out immediately.
        // Clamp to available ownerFees (guards against the unlikely edge case where
        // fees were withdrawn between ticket sales and settlement).
        uint256 settleReward = (r.feePool * SETTLE_REWARD_BPS) / 10000;
        if (settleReward > 0) {
            if (settleReward > s.ownerFees) settleReward = s.ownerFees;
            if (settleReward > 0) {
                s.ownerFees -= settleReward;
                (bool ok,) = payable(msg.sender).call{value: settleReward}("");
                if (!ok) s.pendingPayouts[msg.sender] += settleReward;
                emit SettleRewarded(msg.sender, settleReward);
            }
        }
    }

    function _claimTicket(LotteryStorage storage s, uint256 roundId, uint256 ticketIdx) private {
        RoundInfo storage r = s.rounds[roundId];
        if (r.state != RoundState.SETTLED) revert RoundNotSettled();
        if (s.ticketClaimed[roundId][ticketIdx]) revert AlreadyClaimed();
        TicketInfo storage t = s.roundTickets[roundId][ticketIdx];
        if (t.player != msg.sender) revert NotTicketOwner();
        uint256 prize = _calcPrize(r, t);
        if (prize == 0) revert NoPrize();
        _executePrize(s, roundId, ticketIdx, prize);
    }

    function _calcPrize(RoundInfo storage r, TicketInfo storage t) private view returns (uint256 prize) {
        if (!_matchWhitesStor(t.whites, r.drawnWhites)) return 0;
        prize = r.jackpotPrizePerWinner;
        if (t.goldNum == r.drawnGoldNum && t.goldPos == r.drawnGoldPos) prize += r.superPrizePerWinner;
    }

    function _executePrize(LotteryStorage storage s, uint256 roundId, uint256 ticketIdx, uint256 prize) private {
        s.ticketClaimed[roundId][ticketIdx] = true;
        (bool sent,) = payable(msg.sender).call{value: prize}("");
        if (!sent) s.pendingPayouts[msg.sender] += prize;
        emit PrizeClaimed(roundId, msg.sender, prize);
    }

    function _matchWhitesStor(uint8[5] storage a, uint8[5] storage b) private view returns (bool) {
        for (uint8 i = 0; i < 5; i++) { if (a[i] != b[i]) return false; }
        return true;
    }

    function _matchWhitesMem(uint8[5] storage a, uint8[5] memory b) private view returns (bool) {
        for (uint8 i = 0; i < 5; i++) { if (a[i] != b[i]) return false; }
        return true;
    }

    function _validateTicket(uint8[5] calldata whites, uint8 goldNum, uint8 goldPos) private pure {
        if (goldNum < 1 || goldNum > 90) revert GoldOutOfRange();
        if (goldPos > 4) revert GoldPosOutOfRange();
        for (uint8 i = 0; i < 5; i++) {
            if (whites[i] < 1 || whites[i] > 90) revert WhiteOutOfRange();
            if (i > 0 && whites[i] <= whites[i-1]) revert WhitesNotSortedUnique();
        }
    }

    function _generateDrawnNumbers(uint256 seed) private pure returns (uint8[5] memory whites, uint8 goldNum, uint8 goldPos) {
        uint256 ws = uint256(keccak256(abi.encode(seed, "whites")));
        uint256 gns = uint256(keccak256(abi.encode(seed, "goldNum")));
        uint256 gps = uint256(keccak256(abi.encode(seed, "goldPos")));
        uint256 rng = ws; uint8 count = 0;
        while (count < 5) {
            rng = uint256(keccak256(abi.encode(rng, count)));
            uint8 num = uint8(rng % 90) + 1;
            bool dup = false;
            for (uint8 j = 0; j < count; j++) { if (whites[j] == num) { dup = true; break; } }
            if (!dup) { whites[count] = num; count++; }
        }
        for (uint8 i = 0; i < 4; i++) {
            for (uint8 j = 0; j < 4 - i; j++) {
                if (whites[j] > whites[j+1]) { (whites[j], whites[j+1]) = (whites[j+1], whites[j]); }
            }
        }
        goldNum = uint8(gns % 90) + 1;
        goldPos = uint8(gps % 5);
    }
}
