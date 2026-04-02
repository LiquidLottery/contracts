// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import "@openzeppelin/contracts-upgradeable/access/OwnableUpgradeable.sol";
import "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import "@openzeppelin/contracts-upgradeable/proxy/utils/UUPSUpgradeable.sol";
import "@openzeppelin/contracts-upgradeable/proxy/utils/Initializable.sol";
import "@chainlink/contracts-ccip/contracts/interfaces/IAny2EVMMessageReceiver.sol";
import "@chainlink/contracts-ccip/contracts/libraries/Client.sol";
import "./LotteryMath.sol";
import "./LotteryViews.sol";

/**
 * @title LiquidLotteryV1
 * @notice Thin upgradeable wrapper – all game logic lives in LotteryMath
 *         and LotteryViews (deployed as separate libraries) to stay under
 *         the 13 514-byte runtime bytecode limit on Hyperliquid.
 */
contract LiquidLotteryV1 is
    Initializable,
    OwnableUpgradeable,
    ReentrancyGuard,
    UUPSUpgradeable,
    IAny2EVMMessageReceiver
{
    // ── Public constants (kept on-contract for ABI visibility) ────
    uint16  public constant TICKET_PRICE_BPS         = 5;
    uint256 public constant MIN_TICKET_PRICE         = 0.01 ether;
    uint8   public constant MAX_TICKETS              = 25;
    uint256 public constant MAX_ROUND_TICKETS        = 10_000;
    uint16  public constant FEE_BPS                  = 2000;
    uint16  public constant JACKPOT_BPS              = 5000;
    uint16  public constant SEED_BPS                 = 3000;
    uint256 public constant ADMIN_TIMELOCK           = 48 hours;
    uint256 public constant MIN_CCIP_GAS_LIMIT       = 100_000;
    uint256 public constant MAX_CCIP_GAS_LIMIT       = 2_000_000;
    bytes32 public constant DEFAULT_ADMIN_ROLE       = bytes32(0);

    // ── Events (re-declared for ABI visibility; emitted by libraries) ──
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

    // ── Modifiers ────────────────────────────────────────────────
    modifier onlyAdmin() { if (_msgSender() != owner()) revert Unauthorized(); _; }
    modifier noContract() { if (tx.origin != msg.sender) revert NoIndirectCalls(); _; }

    /// @custom:oz-upgrades-unsafe-allow constructor
    constructor() { _disableInitializers(); }

    function initialize(
        address _owner, address _ccipRouter, uint64 _sourceChainSelector, address _vrfRequester
    ) external initializer {
        if (_owner == address(0) || _ccipRouter == address(0) || _vrfRequester == address(0)) revert ZeroAddress();
        __Ownable_init(_owner);
        LotteryMath.initStorage(_ccipRouter, _sourceChainSelector, _vrfRequester);
    }

    receive() external payable {}

    // ── AccessControl shim ───────────────────────────────────────
    function hasRole(bytes32, address addr) public view returns (bool) { return addr == owner(); }
    function supportsInterface(bytes4 id) public pure returns (bool) {
        return id == type(IAny2EVMMessageReceiver).interfaceId || id == 0x01ffc9a7;
    }

    // ═══════════════════ CCIP ════════════════════════════════════
    function ccipReceive(Client.Any2EVMMessage calldata message) external override nonReentrant {
        LotteryMath.ccipReceiveValidated(message);
    }

    // ═══════════════════ PLAYER ACTIONS ══════════════════════════
    function buyTickets(uint8[5][] calldata w, uint8[] calldata g, uint8[] calldata p, address referrer)
        external payable noContract nonReentrant { LotteryMath.buyTickets(w, g, p, referrer); }
    function claimPrize(uint256 rid, uint256 idx) external nonReentrant { LotteryMath.claimPrize(rid, idx); }
    function claimPrizeBatch(uint256 rid, uint256[] calldata idxs) external nonReentrant { LotteryMath.claimPrizeBatch(rid, idxs); }
    function claimPendingPayout() external nonReentrant { LotteryMath.claimPendingPayout(); }

    // ═══════════════════ V2: NFT + REFERRAL CLAIMS ═══════════════
    function claimNFTRevenue(uint256 tokenId) external nonReentrant { LotteryViews.claimNFTRevenue(tokenId); }
    function claimReferralEarnings() external nonReentrant { LotteryViews.claimReferralEarnings(); }

    // ═══════════════════ GAME ADMIN ═════════════════════════════
    function closeBettingAndDraw()  external onlyAdmin { LotteryMath.closeBettingAndDraw(); }
    function settleRound()          external nonReentrant { LotteryMath.settleRound(); }
    function settleRoundBatch()     external nonReentrant { LotteryMath.settleRoundBatch(); }

    // ═══════════════════ AUTOMATION ══════════════════════════════
    function performUpkeep(bytes calldata) external nonReentrant { LotteryMath.performUpkeep(); }
    function triggerPublicDraw()           external nonReentrant { LotteryMath.triggerPublicDraw(); }
    function publicEmergencyCancelDraw()   external nonReentrant { LotteryViews.publicEmergencyCancelDraw(); }

    // ═══════════════════ ADMIN CONFIG (via LotteryViews) ════════
    function setSettlementBatchSize(uint256 s)       external onlyAdmin { LotteryViews.setSettlementBatchSize(s); }
    function emergencyCancelDraw()                   external onlyAdmin { LotteryViews.emergencyCancelDraw(); }
    function setCCIPGasLimit(uint256 v)              external onlyAdmin { LotteryViews.setCCIPGasLimit(v); }
    function proposeSetCCIPRouter(address a)         external onlyAdmin { LotteryViews.proposeSetCCIPRouter(a); }
    function executeSetCCIPRouter(address a)         external onlyAdmin { LotteryViews.executeSetCCIPRouter(a); }
    function proposeSetSourceChainSelector(uint64 v) external onlyAdmin { LotteryViews.proposeAction(keccak256(abi.encode("setSourceChainSelector", v)), ADMIN_TIMELOCK); }
    function executeSetSourceChainSelector(uint64 v) external onlyAdmin { LotteryViews.executeSetSourceChainSelector(v); }
    function proposeSetVRFRequester(address a)       external onlyAdmin { LotteryViews.proposeSetVRFRequester(a); }
    function executeSetVRFRequester(address a)       external onlyAdmin { LotteryViews.executeSetVRFRequester(a); }
    function proposeUpgrade(address a)               external onlyAdmin { LotteryViews.proposeUpgrade(a); }
    function cancelAdminAction(bytes32 h)            external onlyAdmin { LotteryViews.cancelAdminAction(h); }
    function withdrawFees()                          external onlyAdmin nonReentrant { LotteryViews.withdrawFees(); }
    function topUpOwnerFees()                        external payable { LotteryViews.topUpOwnerFees(); }
    function proposeSetUpkeepInterval(uint256 v)     external onlyAdmin { LotteryViews.proposeSetUpkeepInterval(v); }
    function executeSetUpkeepInterval(uint256 v)     external onlyAdmin { LotteryViews.executeSetUpkeepInterval(v); }
    function setGoldenTicketContract(address a)       external onlyAdmin { LotteryViews.setGoldenTicketContract(a); }

    // ═══════════════════ VIEW (via LotteryViews) ════════════════
    function checkUpkeep(bytes calldata) external view returns (bool n, bytes memory d) { return LotteryViews.checkUpkeep(); }
    function ticketPrice() public view returns (uint256) { return LotteryViews.ticketPrice(); }
    function getRoundInfo(uint256 rid) external view returns (
        uint256 jackpotPool, uint256 seedPool, uint256 ticketCount, uint8 state,
        uint8[5] memory drawnWhites, uint8 drawnGoldNum, uint8 drawnGoldPos,
        uint256 jackpotWinners, uint256 superWinners
    ) { return LotteryViews.getRoundInfo(rid); }
    function getTicket(uint256 rid, uint256 idx) external view returns (address player, uint8[5] memory whites, uint8 goldNum, uint8 goldPos) { return LotteryViews.getTicket(rid, idx); }
    function getPlayerTicketIndices(uint256 rid, address p) external view returns (uint256[] memory) { return LotteryViews.getPlayerTicketIndices(rid, p); }
    function getPlayerTickets(uint256 rid, address p) external view returns (TicketInfo[] memory) { return LotteryViews.getPlayerTickets(rid, p); }
    function getClaimableAmount(uint256 rid, address p) external view returns (uint256) { return LotteryViews.getClaimableAmount(rid, p); }
    function getUpkeepIntervalProposal() external view returns (uint256 newInterval, uint256 executeAfter, uint8 status) { return LotteryViews.getUpkeepIntervalProposal(); }
    function getUpgradeProposal() external view returns (address impl, uint256 executeAfter, uint256 expiresAt, uint8 status) { return LotteryViews.getUpgradeProposal(); }

    // ── V2 Views ──────────────────────────────────────────────────
    function getClaimableNFTRevenue(uint256 tokenId) external view returns (uint256) { return LotteryViews.getClaimableNFTRevenue(tokenId); }

    // ── State-variable getters ───────────────────────────────────
    function currentRound()        external view returns (uint256) { return LotteryViews.currentRound(); }
    function ccipRouter()          external view returns (address) { return LotteryViews.ccipRouter(); }
    function sourceChainSelector() external view returns (uint64)  { return LotteryViews.sourceChainSelector(); }
    function vrfRequester()        external view returns (address) { return LotteryViews.vrfRequester(); }
    function ccipGasLimit()        external view returns (uint256) { return LotteryViews.ccipGasLimit(); }
    function ownerFees()           external view returns (uint256) { return LotteryViews.ownerFees(); }
    function settlementBatchSize() external view returns (uint256) { return LotteryViews.settlementBatchSize(); }
    function upkeepInterval()      external view returns (uint256) { return LotteryViews.upkeepInterval(); }
    function lastUpkeepTime()      external view returns (uint256) { return LotteryViews.lastUpkeepTime(); }
    function pendingUpkeepInterval() external view returns (uint256) { return LotteryViews.pendingUpkeepInterval(); }
    function upkeepIntervalProposalExecuteAfter() external view returns (uint256) { return LotteryViews.upkeepIntervalProposalExecuteAfter(); }
    function pendingAdminActions(bytes32 h)   external view returns (uint256) { return LotteryViews.pendingAdminActions(h); }
    function pendingPayouts(address a)        external view returns (uint256) { return LotteryViews.pendingPayouts(a); }
    function ticketClaimed(uint256 r, uint256 i) external view returns (bool) { return LotteryViews.ticketClaimed(r, i); }
    function playerTicketCount(uint256 r, address p) external view returns (uint256) { return LotteryViews.playerTicketCount(r, p); }
    function pendingUpgradeImpl()  external view returns (address) { return LotteryViews.pendingUpgradeImpl(); }
    function settlementProgress(uint256 r) external view returns (uint256) { return LotteryViews.settlementProgress(r); }
    function freeTicketCredits(address a)  external view returns (uint256) { return LotteryViews.freeTicketCredits(a); }
    function drawRequestedAt()             external view returns (uint256) { return LotteryViews.drawRequestedAt(); }

    // ── V2 State getters ──────────────────────────────────────────
    function goldenTicketContract() external view returns (address) { return LotteryViews.goldenTicketContract(); }
    function nftRevenuePool()      external view returns (uint256) { return LotteryViews.nftRevenuePool(); }
    function nftTotalDistributed() external view returns (uint256) { return LotteryViews.nftTotalDistributed(); }
    function referralEarnings(address a) external view returns (uint256) { return LotteryViews.referralEarnings(a); }

    // ═══════════════════ UUPS ════════════════════════════════════
    function _authorizeUpgrade(address newImpl) internal override onlyAdmin {
        LotteryViews.authorizeUpgrade(newImpl);
    }
}
