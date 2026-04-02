// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import "./LotteryMath.sol";

/// @notice Minimal interface to check NFT ownership — avoids importing full ERC721.
interface IERC721Minimal {
    function ownerOf(uint256 tokenId) external view returns (address);
}

/**
 * @title LotteryViews
 * @notice View / admin-config functions split from LotteryMath to keep each
 *         library under the 13 514-byte Hyperliquid runtime bytecode limit.
 *         Shares the same ERC-7201 storage slot as LotteryMath.
 */
library LotteryViews {

    bytes32 private constant _SLOT = keccak256("liquidlottery.v1.main.storage");

    uint256 private constant ADMIN_TIMELOCK           = 48 hours;
    uint256 private constant UPGRADE_TIMELOCK         = 72 hours;
    uint256 private constant UPGRADE_EXPIRY           = 1 hours;
    uint256 private constant UPKEEP_INTERVAL_TIMELOCK = 24 hours;
    uint256 private constant MIN_CCIP_GAS_LIMIT       = 100_000;
    uint256 private constant MAX_CCIP_GAS_LIMIT       = 2_000_000;
    uint256 private constant MAX_ROUND_TICKETS        = 10_000;
    uint16  private constant TICKET_PRICE_BPS         = 5;
    uint256 private constant MIN_TICKET_PRICE         = 0.01 ether;
    uint256 private constant MAX_TICKET_PRICE         = 0.5 ether;
    uint256 private constant EMERGENCY_CANCEL_DELAY   = 24 hours;
    uint8   private constant DRAW_TRIGGER_CREDITS     = 2;
    uint8   private constant NFT_MAX_SUPPLY           = 10;

    function _s() private pure returns (LotteryStorage storage s) {
        bytes32 slot = _SLOT;
        assembly { s.slot := slot }
    }

    // ── View functions ────────────────────────────────────────────
    function ticketPrice() external view returns (uint256) {
        LotteryStorage storage s = _s();
        RoundInfo storage r = s.rounds[s.currentRound];
        uint256 pool = r.jackpotPool + r.seedPool;
        uint256 price = (pool * TICKET_PRICE_BPS) / 10000;
        if (price < MIN_TICKET_PRICE) return MIN_TICKET_PRICE;
        if (price > MAX_TICKET_PRICE) return MAX_TICKET_PRICE;
        return price;
    }

    function getRoundInfo(uint256 rid) external view returns (
        uint256 jackpotPool, uint256 seedPool, uint256 ticketCount, uint8 state,
        uint8[5] memory drawnWhites, uint8 drawnGoldNum, uint8 drawnGoldPos,
        uint256 jackpotWinners, uint256 superWinners
    ) {
        RoundInfo storage r = _s().rounds[rid];
        return (r.jackpotPool, r.seedPool, r.ticketCount, uint8(r.state), r.drawnWhites, r.drawnGoldNum, r.drawnGoldPos, r.jackpotWinners, r.superWinners);
    }

    function getTicket(uint256 rid, uint256 idx) external view returns (address player, uint8[5] memory whites, uint8 goldNum, uint8 goldPos) {
        TicketInfo storage t = _s().roundTickets[rid][idx];
        return (t.player, t.whites, t.goldNum, t.goldPos);
    }

    function getPlayerTicketIndices(uint256 rid, address player) external view returns (uint256[] memory) {
        return _s().playerIndices[rid][player];
    }

    function getPlayerTickets(uint256 rid, address player) external view returns (TicketInfo[] memory) {
        LotteryStorage storage s = _s();
        uint256[] storage indices = s.playerIndices[rid][player];
        TicketInfo[] memory result = new TicketInfo[](indices.length);
        for (uint256 i = 0; i < indices.length; i++) result[i] = s.roundTickets[rid][indices[i]];
        return result;
    }

    function getClaimableAmount(uint256 roundId, address player) external view returns (uint256 amount) {
        LotteryStorage storage s = _s();
        RoundInfo storage r = s.rounds[roundId];
        if (r.state != RoundState.SETTLED) return 0;
        uint256[] storage indices = s.playerIndices[roundId][player];
        for (uint256 i = 0; i < indices.length; i++) {
            uint256 idx = indices[i];
            if (s.ticketClaimed[roundId][idx]) continue;
            TicketInfo storage t = s.roundTickets[roundId][idx];
            if (_matchWhitesStor(t.whites, r.drawnWhites)) {
                amount += r.jackpotPrizePerWinner;
                if (t.goldNum == r.drawnGoldNum && t.goldPos == r.drawnGoldPos) amount += r.superPrizePerWinner;
            }
        }
    }

    function getUpkeepIntervalProposal() external view returns (uint256 newInterval, uint256 executeAfter, uint8 status) {
        LotteryStorage storage s = _s();
        newInterval = s.pendingUpkeepInterval;
        executeAfter = s.upkeepIntervalProposalExecuteAfter;
        if (newInterval == 0 || executeAfter == 0) status = 0;
        else if (block.timestamp < executeAfter) status = 1;
        else status = 2;
    }

    function getUpgradeProposal() external view returns (address impl, uint256 executeAfter, uint256 expiresAt, uint8 status) {
        LotteryStorage storage s = _s();
        impl = s.pendingUpgradeImpl;
        executeAfter = s.upgradeProposalExecuteAfter;
        expiresAt = executeAfter > 0 ? executeAfter + UPGRADE_EXPIRY : 0;
        if (impl == address(0) || executeAfter == 0) status = 0;
        else if (block.timestamp < executeAfter) status = 1;
        else if (block.timestamp < expiresAt) status = 2;
        else status = 3;
    }

    function checkUpkeep() external view returns (bool upkeepNeeded, bytes memory) {
        LotteryStorage storage s = _s();
        RoundInfo storage r = s.rounds[s.currentRound];
        if (r.state == RoundState.OPEN) {
            upkeepNeeded = (r.ticketCount > 0 && block.timestamp >= s.lastUpkeepTime + s.upkeepInterval);
        } else if (r.state == RoundState.DRAWN) {
            upkeepNeeded = true;
        }
    }

    // ── Simple state getters ──────────────────────────────────────
    function currentRound()        external view returns (uint256) { return _s().currentRound; }
    function ccipRouter()          external view returns (address) { return _s().ccipRouter; }
    function sourceChainSelector() external view returns (uint64)  { return _s().sourceChainSelector; }
    function vrfRequester()        external view returns (address) { return _s().vrfRequester; }
    function ccipGasLimit()        external view returns (uint256) { return _s().ccipGasLimit; }
    function ownerFees()           external view returns (uint256) { return _s().ownerFees; }
    function settlementBatchSize() external view returns (uint256) { return _s().settlementBatchSize; }
    function upkeepInterval()      external view returns (uint256) { return _s().upkeepInterval; }
    function lastUpkeepTime()      external view returns (uint256) { return _s().lastUpkeepTime; }
    function pendingAdminActions(bytes32 h) external view returns (uint256) { return _s().pendingAdminActions[h]; }
    function pendingPayouts(address a) external view returns (uint256) { return _s().pendingPayouts[a]; }
    function ticketClaimed(uint256 r, uint256 i) external view returns (bool) { return _s().ticketClaimed[r][i]; }
    function playerTicketCount(uint256 r, address p) external view returns (uint256) { return _s().playerTicketCount[r][p]; }
    function roundTickets(uint256 r, uint256 i) external view returns (address, uint8[5] memory, uint8, uint8) {
        TicketInfo storage t = _s().roundTickets[r][i];
        return (t.player, t.whites, t.goldNum, t.goldPos);
    }
    function settlementProgress(uint256 r) external view returns (uint256) { return _s().settlementProgress[r]; }
    function pendingUpgradeImpl()  external view returns (address) { return _s().pendingUpgradeImpl; }
    function pendingUpkeepInterval() external view returns (uint256) { return _s().pendingUpkeepInterval; }
    function upkeepIntervalProposalExecuteAfter() external view returns (uint256) { return _s().upkeepIntervalProposalExecuteAfter; }
    function freeTicketCredits(address a) external view returns (uint256) { return _s().freeTicketCredits[a]; }
    function drawRequestedAt()  external view returns (uint256) { return _s().drawRequestedAt; }

    // ── V2 getters ────────────────────────────────────────────────────
    function goldenTicketContract() external view returns (address) { return _s().goldenTicketContract; }
    function nftRevenuePool()      external view returns (uint256) { return _s().nftRevenuePool; }
    function nftTotalDistributed() external view returns (uint256) { return _s().nftTotalDistributed; }
    function nftClaimedRevenue(uint256 tokenId) external view returns (uint256) { return _s().nftClaimedRevenue[tokenId]; }
    function referrers(address a)  external view returns (address) { return _s().referrers[a]; }
    function referralEarnings(address a) external view returns (uint256) { return _s().referralEarnings[a]; }
    function goldenTicketAwarded() external view returns (bool) { return _s().goldenTicketAwarded; }

    /// @notice Returns the claimable NFT revenue for a specific tokenId.
    function getClaimableNFTRevenue(uint256 tokenId) external view returns (uint256) {
        LotteryStorage storage s = _s();
        uint256 perToken = s.nftTotalDistributed / NFT_MAX_SUPPLY;
        uint256 claimed  = s.nftClaimedRevenue[tokenId];
        return perToken > claimed ? perToken - claimed : 0;
    }

    // ── V2: NFT Revenue Claim ─────────────────────────────────
    function claimNFTRevenue(uint256 tokenId) external {
        LotteryStorage storage s = _s();
        if (s.goldenTicketContract == address(0)) revert ZeroAddress();
        address holder = IERC721Minimal(s.goldenTicketContract).ownerOf(tokenId);
        if (holder != msg.sender) revert NotNFTOwner();
        uint256 perToken = s.nftTotalDistributed / NFT_MAX_SUPPLY;
        uint256 claimed  = s.nftClaimedRevenue[tokenId];
        uint256 claimable = perToken > claimed ? perToken - claimed : 0;
        if (claimable == 0) revert NoNFTRevenue();
        s.nftClaimedRevenue[tokenId] = perToken;
        s.nftRevenuePool -= claimable;
        (bool ok,) = payable(msg.sender).call{value: claimable}("");
        if (!ok) s.pendingPayouts[msg.sender] += claimable;
        emit NFTRevenueClaimed(tokenId, msg.sender, claimable);
    }

    // ── V2: Referral Earnings Claim ───────────────────────────
    function claimReferralEarnings() external {
        LotteryStorage storage s = _s();
        uint256 amount = s.referralEarnings[msg.sender];
        if (amount == 0) revert NothingToClaim();
        s.referralEarnings[msg.sender] = 0;
        (bool ok,) = payable(msg.sender).call{value: amount}("");
        if (!ok) s.pendingPayouts[msg.sender] += amount;
        emit ReferralEarningsClaimed(msg.sender, amount);
    }

    // ── Admin config ─────────────────────────────────────────────
    function setCCIPGasLimit(uint256 newLimit) external {
        if (newLimit < MIN_CCIP_GAS_LIMIT || newLimit > MAX_CCIP_GAS_LIMIT) revert GasLimitOutOfRange();
        _s().ccipGasLimit = newLimit;
    }

    function proposeSetCCIPRouter(address newRouter) external {
        if (newRouter == address(0)) revert ZeroAddress();
        if (newRouter.code.length == 0) revert NotAContract();
        _proposeAdmin(keccak256(abi.encode("setCCIPRouter", newRouter)), ADMIN_TIMELOCK);
    }

    function executeSetCCIPRouter(address newRouter) external {
        if (newRouter.code.length == 0) revert NotAContract();
        LotteryStorage storage s = _s();
        _executeAction(s, keccak256(abi.encode("setCCIPRouter", newRouter)));
        s.ccipRouter = newRouter;
    }

    function proposeSetVRFRequester(address newRequester) external {
        if (newRequester == address(0)) revert ZeroAddress();
        if (newRequester.code.length == 0) revert NotAContract();
        _proposeAdmin(keccak256(abi.encode("setVRFRequester", newRequester)), ADMIN_TIMELOCK);
    }

    function executeSetVRFRequester(address newRequester) external {
        if (newRequester.code.length == 0) revert NotAContract();
        LotteryStorage storage s = _s();
        _executeAction(s, keccak256(abi.encode("setVRFRequester", newRequester)));
        s.vrfRequester = newRequester;
    }

    function proposeUpgrade(address newImpl) external {
        LotteryStorage storage s = _s();
        if (s.pendingUpgradeImpl != address(0)) revert ExistingProposal();
        if (newImpl == address(0)) revert ZeroAddress();
        if (newImpl.code.length == 0) revert NotAContract();
        bytes32 h = keccak256(abi.encode("upgradeToAndCall", newImpl));
        uint256 ea = block.timestamp + UPGRADE_TIMELOCK;
        s.pendingAdminActions[h] = ea;
        s.pendingUpgradeImpl = newImpl;
        s.upgradeProposalExecuteAfter = ea;
        emit AdminActionProposed(h, ea);
        emit UpgradeProposed(newImpl, ea, ea + UPGRADE_EXPIRY);
    }

    function cancelAdminAction(bytes32 actionHash) external {
        LotteryStorage storage s = _s();
        if (s.pendingAdminActions[actionHash] == 0) revert ActionNotProposed();
        if (s.pendingUpgradeImpl != address(0)) {
            bytes32 uh = keccak256(abi.encode("upgradeToAndCall", s.pendingUpgradeImpl));
            if (uh == actionHash) { s.pendingUpgradeImpl = address(0); s.upgradeProposalExecuteAfter = 0; }
        }
        if (s.pendingUpkeepInterval != 0) {
            bytes32 ih = keccak256(abi.encode("setUpkeepInterval", s.pendingUpkeepInterval));
            if (ih == actionHash) { s.pendingUpkeepInterval = 0; s.upkeepIntervalProposalExecuteAfter = 0; }
        }
        delete s.pendingAdminActions[actionHash];
        emit AdminActionCancelled(actionHash);
    }

    function withdrawFees() external {
        LotteryStorage storage s = _s();
        uint256 amount = s.ownerFees;
        if (amount == 0) revert NoFees();
        s.ownerFees = 0;
        (bool ok,) = payable(msg.sender).call{value: amount}("");
        if (!ok) revert TransferFailed();
    }

    function topUpOwnerFees() external {
        if (msg.value == 0) revert NoValueSent();
        _s().ownerFees += msg.value;
        emit OwnerFeesTopUp(msg.sender, msg.value);
    }

    function seedJackpot() external {
        LotteryStorage storage s = _s();
        if (msg.value == 0) revert NoValueSent();
        s.rounds[s.currentRound].jackpotPool += msg.value;
    }

    function proposeSetUpkeepInterval(uint256 newInterval) external {
        if (newInterval == 0) revert IntervalMustBePositive();
        LotteryStorage storage s = _s();
        bytes32 h = keccak256(abi.encode("setUpkeepInterval", newInterval));
        uint256 ea = block.timestamp + UPKEEP_INTERVAL_TIMELOCK;
        s.pendingAdminActions[h] = ea;
        s.pendingUpkeepInterval = newInterval;
        s.upkeepIntervalProposalExecuteAfter = ea;
        emit AdminActionProposed(h, ea);
        emit UpkeepIntervalProposed(newInterval, ea);
    }

    function executeSetUpkeepInterval(uint256 newInterval) external {
        LotteryStorage storage s = _s();
        bytes32 h = keccak256(abi.encode("setUpkeepInterval", newInterval));
        if (s.pendingAdminActions[h] == 0) revert ActionNotProposed();
        if (block.timestamp < s.pendingAdminActions[h]) revert TimelockNotExpired();
        delete s.pendingAdminActions[h];
        s.pendingUpkeepInterval = 0;
        s.upkeepIntervalProposalExecuteAfter = 0;
        s.upkeepInterval = newInterval;
        emit AdminActionExecuted(h);
    }

    function authorizeUpgrade(address newImpl) external {
        LotteryStorage storage s = _s();
        bytes32 h = keccak256(abi.encode("upgradeToAndCall", newImpl));
        if (s.pendingAdminActions[h] == 0) revert UpgradeNotProposed();
        uint256 ea = s.pendingAdminActions[h];
        if (block.timestamp < ea) revert TimelockNotExpired();
        if (block.timestamp >= ea + UPGRADE_EXPIRY) revert UpgradeProposalExpired();
        delete s.pendingAdminActions[h];
        s.pendingUpgradeImpl = address(0);
        s.upgradeProposalExecuteAfter = 0;
        emit AdminActionExecuted(h);
    }

    function proposeAction(bytes32 h, uint256 delay) external {
        _proposeAdmin(h, delay);
    }

    function executeSetSourceChainSelector(uint64 newSelector) external {
        LotteryStorage storage s = _s();
        bytes32 h = keccak256(abi.encode("setSourceChainSelector", newSelector));
        _executeAction(s, h);
        s.sourceChainSelector = newSelector;
    }

    function setSettlementBatchSize(uint256 size) external {
        if (size == 0 || size > MAX_ROUND_TICKETS) revert InvalidBatchSize();
        _s().settlementBatchSize = size;
    }

    function setGoldenTicketContract(address addr) external {
        if (addr == address(0)) revert ZeroAddress();
        _s().goldenTicketContract = addr;
    }

    function emergencyCancelDraw() external {
        LotteryStorage storage s = _s();
        uint256 rid = s.currentRound;
        RoundInfo storage r = s.rounds[rid];
        if (r.state != RoundState.DRAWING) revert NotDrawing();
        if (block.timestamp < s.drawRequestedAt + 300) revert GracePeriodActive();
        r.ccipMessageId = bytes32(0);
        r.state = RoundState.OPEN;
        s.lastUpkeepTime = block.timestamp - s.upkeepInterval;
        emit DrawCancelled(rid);
    }

    function publicEmergencyCancelDraw() external {
        LotteryStorage storage s = _s();
        uint256 rid = s.currentRound;
        RoundInfo storage r = s.rounds[rid];
        if (r.state != RoundState.DRAWING) revert NotDrawing();
        if (block.timestamp < s.drawRequestedAt + EMERGENCY_CANCEL_DELAY) revert EmergencyCancelDelayNotMet();
        r.ccipMessageId = bytes32(0);
        r.state = RoundState.OPEN;
        s.lastUpkeepTime = block.timestamp - s.upkeepInterval;
        emit DrawCancelled(rid);
        s.freeTicketCredits[msg.sender] += DRAW_TRIGGER_CREDITS;
        emit DrawTriggerRewarded(msg.sender, DRAW_TRIGGER_CREDITS);
    }

    // ── Private helpers ──────────────────────────────────────────
    function _matchWhitesStor(uint8[5] storage a, uint8[5] storage b) private view returns (bool) {
        for (uint8 i = 0; i < 5; i++) { if (a[i] != b[i]) return false; }
        return true;
    }

    function _proposeAdmin(bytes32 h, uint256 delay) private {
        LotteryStorage storage s = _s();
        uint256 ea = block.timestamp + delay;
        s.pendingAdminActions[h] = ea;
        emit AdminActionProposed(h, ea);
    }

    function _executeAction(LotteryStorage storage s, bytes32 h) private {
        if (s.pendingAdminActions[h] == 0) revert ActionNotProposed();
        if (block.timestamp < s.pendingAdminActions[h]) revert TimelockNotExpired();
        delete s.pendingAdminActions[h];
        emit AdminActionExecuted(h);
    }
}
