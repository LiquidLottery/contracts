// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import "@chainlink/contracts/src/v0.8/vrf/dev/VRFConsumerBaseV2Plus.sol";
import "@chainlink/contracts/src/v0.8/vrf/dev/libraries/VRFV2PlusClient.sol";
import "@chainlink/contracts-ccip/contracts/interfaces/IAny2EVMMessageReceiver.sol";
import "@chainlink/contracts-ccip/contracts/interfaces/IRouterClient.sol";
import "@chainlink/contracts-ccip/contracts/libraries/Client.sol";

/**
 * @title  LotteryVRFRequester
 * @notice Deployed on the **source chain** (e.g. Base) where both
 *         Chainlink VRF v2.5 and Chainlink CCIP are available.
 *
 * Architecture (cross-chain randomness relay via CCIP)
 * ────────────────────────────────────────────────────
 *
 * Draw flow (2-hop):
 *   1. Admin server or any user calls closeBettingAndDraw() /
 *      triggerPublicDraw() on LiquidLotteryV1 (Hyperliquid L1).
 *   2. LiquidLotteryV1._triggerDraw() sends CCIP message → LotteryVRFRequester
 *      with payload: abi.encode(roundId).
 *   3. LotteryVRFRequester.ccipReceive() requests VRF randomness.
 *   4. fulfillRandomWords() sends CCIP message → LiquidLotteryV1
 *      with payload: abi.encode(roundId, randomWord).
 *   5. LiquidLotteryV1.ccipReceive() applies the randomness and sets the
 *      round to DRAWN.
 *
 * Scheduling
 * ──────────
 * An off-chain Node.js server monitors the lottery and calls
 * closeBettingAndDraw() / settleRoundBatch() at the right time.
 * If the server is unavailable, any user can call triggerPublicDraw()
 * (after the draw grace period) or settleRoundBatch() directly.
 *
 * Source chain selection guidance
 * ────────────────────────────────
 * Choose a chain with:
 *   • Chainlink VRF v2.5 support
 *   • Chainlink CCIP support (both lanes to/from Hyperliquid L1)
 *   • Very low gas fees
 * Recommended: Base (chain ID 8453).
 */
contract LotteryVRFRequester is VRFConsumerBaseV2Plus, IAny2EVMMessageReceiver {
    // ─────────────── CCIP Config ─────────────────────────────────────
    /// @notice CCIP router on the source chain.
    address public immutable i_ccipRouter;
    /// @notice CCIP chain selector for Hyperliquid L1 (destination).
    uint64  public immutable i_destChainSelector;

    /// @notice LiquidLotteryV1 proxy address on Hyperliquid L1.
    ///         The only address allowed to send draw-request CCIP messages here.
    address public lotteryContract;

    /// @notice Gas limit for the CCIP callback on Hyperliquid L1
    ///         (covers _applyRandomness + state writes in LiquidLotteryV1).
    uint256 public ccipFulfillGasLimit;

    // ─────────────── VRF Config ──────────────────────────────────────
    uint256 public s_subscriptionId;
    bytes32 public s_keyHash;
    uint32  public s_callbackGasLimit;
    uint16  public s_requestConfirmations;

    // ─────────────── State ───────────────────────────────────────────
    /// @notice Maps VRF requestId → lottery roundId.
    mapping(uint256 => uint256) public vrfRequestToRound;
    /// @notice Round ID for the currently-pending VRF request (0 = none).
    uint256 public pendingRoundId;
    /// @notice The most-recently issued VRF request ID.  Useful for tests and
    ///         off-chain monitoring.
    uint256 public latestVrfRequestId;
    /// @notice Stores VRF random words that were fulfilled but whose CCIP send
    ///         failed (e.g. insufficient native balance for the CCIP fee).
    ///         A non-zero entry means the owner must call retryFulfillViaCCIP()
    ///         after topping up the contract's ETH balance.
    mapping(uint256 => uint256) public pendingRandomWords;

    // ─────────────── Constants ───────────────────────────────────────
    uint256 public constant MIN_CCIP_GAS_LIMIT     = 100_000;
    uint256 public constant MAX_CCIP_GAS_LIMIT     = 2_000_000;
    /// @notice Default gas budget for LiquidLotteryV1.ccipReceive() on the
    ///         destination chain.  Set to 500 000 to comfortably cover
    ///         _applyRandomness storage writes and CCIP message verification.
    uint256 public constant DEFAULT_CCIP_GAS_LIMIT = 500_000;

    // ─────────────── Events ──────────────────────────────────────────
    event DrawRequestReceived(uint256 indexed roundId, uint256 vrfRequestId);
    event DrawFulfilled(uint256 indexed roundId, uint256 randomWord);
    event CCIPFulfillSent(uint256 indexed roundId, bytes32 ccipMessageId);
    event LotteryContractUpdated(address newLotteryContract);
    event CCIPFulfillGasLimitUpdated(uint256 newLimit);
    /// @notice Emitted when a VRF random word was persisted but the CCIP send
    ///         failed.  Off-chain monitors should alert and the owner should
    ///         top up ETH, then call retryFulfillViaCCIP(roundId).
    event RandomWordStored(uint256 indexed roundId, uint256 randomWord);

    // ─────────────── Constructor ─────────────────────────────────────

    /**
     * @param vrfCoordinator       Chainlink VRF coordinator on source chain.
     * @param ccipRouter           Chainlink CCIP router on source chain.
     * @param destChainSelector    CCIP selector for Hyperliquid L1.
     * @param _lotteryContract     LiquidLotteryV1 proxy on Hyperliquid L1.
     * @param subscriptionId       Chainlink VRF v2.5 subscription ID.
     * @param keyHash              VRF key hash (lane selection).
     * @param callbackGasLimit     Gas limit for fulfillRandomWords callback.
     * @param requestConfirmations VRF confirmation blocks.
     */
    constructor(
        address vrfCoordinator,
        address ccipRouter,
        uint64  destChainSelector,
        address _lotteryContract,
        uint256 subscriptionId,
        bytes32 keyHash,
        uint32  callbackGasLimit,
        uint16  requestConfirmations
    ) VRFConsumerBaseV2Plus(vrfCoordinator) {
        require(ccipRouter       != address(0), "zero ccip router");
        require(_lotteryContract != address(0), "zero lottery contract");

        i_ccipRouter           = ccipRouter;
        i_destChainSelector    = destChainSelector;
        lotteryContract        = _lotteryContract;
        s_subscriptionId       = subscriptionId;
        s_keyHash              = keyHash;
        s_callbackGasLimit     = callbackGasLimit;
        s_requestConfirmations = requestConfirmations;
        ccipFulfillGasLimit    = DEFAULT_CCIP_GAS_LIMIT;
    }

    receive() external payable {}

    // ═══════════════════ CCIP RECEIVER ═══════════════════════════

    /**
     * @notice Called by the CCIP router to deliver messages from Hyperliquid L1.
     *
     * Message types (by data length / content):
     *  • 32 bytes  — draw request: abi.encode(roundId).
     *                LiquidLotteryV1 calls _triggerDraw() which sends this.
     */
    function ccipReceive(
        Client.Any2EVMMessage calldata message
    ) external override {
        require(msg.sender == i_ccipRouter, "only CCIP router");

        address sender = abi.decode(message.sender, (address));
        require(sender == lotteryContract, "unknown sender");

        // Draw request: 32 bytes → abi.encode(roundId).
        uint256 roundId = abi.decode(message.data, (uint256));
        _requestVRFForRound(roundId);
    }

    function supportsInterface(bytes4 interfaceId) public pure returns (bool) {
        return
            interfaceId == type(IAny2EVMMessageReceiver).interfaceId ||
            interfaceId == 0x01ffc9a7; // ERC165 interfaceId
    }

    // ═══════════════════ VRF FULFILLMENT ═════════════════════════

    /**
     * @notice Chainlink VRF v2.5 callback.  Sends the random word to
     *         LiquidLotteryV1 via CCIP.
     *
     *         The random word is persisted in pendingRandomWords BEFORE the
     *         CCIP send is attempted.  If the send fails (e.g. insufficient
     *         native-token balance for the CCIP fee) the word is kept in
     *         storage and a RandomWordStored event is emitted so off-chain
     *         monitors can alert.  The owner can then top up the contract's
     *         ETH balance and call retryFulfillViaCCIP(roundId) to relay the
     *         stored word.  This prevents the VRF result from being lost if
     *         the CCIP leg fails (Bug 3 fix).
     */
    function fulfillRandomWords(
        uint256 requestId,
        uint256[] calldata randomWords
    ) internal override {
        uint256 roundId = vrfRequestToRound[requestId];
        require(roundId != 0, "unknown VRF request");
        delete vrfRequestToRound[requestId];

        if (pendingRoundId == roundId) {
            pendingRoundId = 0;
        }

        uint256 word = randomWords[0];

        // Persist the random word first — ensures data is never lost even if
        // the subsequent CCIP send reverts (e.g. insufficient native balance).
        pendingRandomWords[roundId] = word;
        emit DrawFulfilled(roundId, word);

        // Best-effort CCIP send.  If it fails the word stays in
        // pendingRandomWords for the owner to retry via retryFulfillViaCCIP().
        try this.attemptSendFulfillToCCIP(roundId, word) {
            delete pendingRandomWords[roundId];
        } catch {
            emit RandomWordStored(roundId, word);
        }
    }

    /**
     * @notice External self-call trampoline used exclusively by
     *         fulfillRandomWords so that the CCIP send can be wrapped in a
     *         Solidity try/catch block (which requires an external call).
     * @dev    MUST NOT be called by any address other than this contract itself.
     */
    function attemptSendFulfillToCCIP(uint256 roundId, uint256 randomWord) external {
        require(msg.sender == address(this), "only self");
        _sendFulfillToCCIP(roundId, randomWord);
    }

    /**
     * @notice Manually relay a previously stored VRF random word to
     *         LiquidLotteryV1 via CCIP.  Call this after topping up the
     *         contract's ETH balance when pendingRandomWords[roundId] != 0.
     * @param  roundId The lottery round whose stored random word to send.
     */
    function retryFulfillViaCCIP(uint256 roundId) external onlyOwner {
        uint256 word = pendingRandomWords[roundId];
        require(word != 0, "no pending random word for this round");
        delete pendingRandomWords[roundId];
        _sendFulfillToCCIP(roundId, word);
    }

    // ═══════════════════ ADMIN ═══════════════════════════════════

    /**
     * @notice Update the LiquidLotteryV1 proxy address.
     */
    function setLotteryContract(address newContract) external onlyOwner {
        require(newContract != address(0), "zero address");
        lotteryContract = newContract;
        emit LotteryContractUpdated(newContract);
    }

    /// @notice Set gas limit for CCIP messages sent to Hyperliquid L1.
    function setCCIPFulfillGasLimit(uint256 newLimit) external onlyOwner {
        require(
            newLimit >= MIN_CCIP_GAS_LIMIT && newLimit <= MAX_CCIP_GAS_LIMIT,
            "gas limit out of range"
        );
        ccipFulfillGasLimit = newLimit;
        emit CCIPFulfillGasLimitUpdated(newLimit);
    }

    function setSubscriptionId(uint256 id) external onlyOwner {
        s_subscriptionId = id;
    }

    function setKeyHash(bytes32 newKeyHash) external onlyOwner {
        s_keyHash = newKeyHash;
    }

    function setCallbackGasLimit(uint32 newLimit) external onlyOwner {
        s_callbackGasLimit = newLimit;
    }

    function setRequestConfirmations(uint16 newConf) external onlyOwner {
        s_requestConfirmations = newConf;
    }

    /**
     * @notice Discard a stored VRF random word for a given round.
     *         Use this to clean up a stale pendingRandomWords entry that
     *         should no longer be sent — for example, after emergencyCancelDraw()
     *         on LiquidLotteryV1 if a new VRF request will be issued for the
     *         same round and the old word must not be applied.
     * @param  roundId The round whose pending random word to discard.
     */
    function clearPendingRandomWord(uint256 roundId) external onlyOwner {
        require(pendingRandomWords[roundId] != 0, "no pending random word for this round");
        delete pendingRandomWords[roundId];
    }

    // withdrawFunds intentionally removed – the VRF requester is a secure
    // "well" that the admin can only fund, never drain.  This ensures CCIP
    // operational funds are always available for VRF fulfillment.

    // ═══════════════════ INTERNAL ════════════════════════════════

    function _requestVRFForRound(uint256 roundId) internal {
        // Allow re-requesting for the same round (e.g., after emergencyCancelDraw
        // on LiquidLotteryV1 resets the round to OPEN without notifying this contract).
        require(
            pendingRoundId == 0 || pendingRoundId == roundId,
            "VRF already pending for different round"
        );
        pendingRoundId = roundId;

        uint256 requestId = s_vrfCoordinator.requestRandomWords(
            VRFV2PlusClient.RandomWordsRequest({
                keyHash:              s_keyHash,
                subId:                s_subscriptionId,
                requestConfirmations: s_requestConfirmations,
                callbackGasLimit:     s_callbackGasLimit,
                numWords:             1,
                extraArgs: VRFV2PlusClient._argsToBytes(
                    VRFV2PlusClient.ExtraArgsV1({nativePayment: true})
                )
            })
        );

        vrfRequestToRound[requestId] = roundId;
        latestVrfRequestId = requestId;
        emit DrawRequestReceived(roundId, requestId);
    }

    function _sendFulfillToCCIP(uint256 roundId, uint256 randomWord) internal {
        bytes memory payload = abi.encode(roundId, randomWord);

        Client.EVM2AnyMessage memory ccipMsg = _buildCCIPMessage(
            lotteryContract,
            payload,
            ccipFulfillGasLimit
        );

        uint256 fee = IRouterClient(i_ccipRouter).getFee(i_destChainSelector, ccipMsg);
        require(address(this).balance >= fee, "insufficient balance for CCIP fee");

        bytes32 messageId = IRouterClient(i_ccipRouter).ccipSend{value: fee}(
            i_destChainSelector,
            ccipMsg
        );

        emit CCIPFulfillSent(roundId, messageId);
    }

    function _buildCCIPMessage(
        address receiver,
        bytes memory data,
        uint256 gasLimit
    ) internal pure returns (Client.EVM2AnyMessage memory) {
        return Client.EVM2AnyMessage({
            receiver:     abi.encode(receiver),
            data:         data,
            tokenAmounts: new Client.EVMTokenAmount[](0),
            feeToken:     address(0),  // pay in native token
            extraArgs:    Client._argsToBytes(
                Client.EVMExtraArgsV1({gasLimit: gasLimit})
            )
        });
    }
}
