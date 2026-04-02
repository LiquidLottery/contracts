// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import "@chainlink/contracts-ccip/contracts/interfaces/IRouterClient.sol";
import "@chainlink/contracts-ccip/contracts/interfaces/IAny2EVMMessageReceiver.sol";
import "@chainlink/contracts-ccip/contracts/libraries/Client.sol";

/**
 * @title  MockCCIPRouter
 * @notice Minimal mock CCIP router for testing LiquidLotteryV1 (HyperEVM side)
 *         and LotteryVRFRequester (source-chain side).
 *
 * In tests it replaces both the CCIP router on Hyperliquid L1 and the router
 * on the source chain.  Two separate instances are typically deployed (one per
 * "chain" in a single-process Hardhat test), but a single instance can be used
 * when only one direction is tested.
 *
 * Key helpers:
 *  • sendFee()           — fixed 0.001 ETH fee returned by getFee().
 *  • deliverMessage()    — manually deliver a queued outbound message to a
 *                          receiver; simulates CCIP cross-chain delivery.
 *  • getLastOutbound()   — inspect the most-recent message sent via ccipSend().
 */
contract MockCCIPRouter is IRouterClient {
    uint256 public constant MOCK_FEE = 0.001 ether;

    struct PendingMessage {
        uint64  destChainSelector;
        address sender;
        bytes   data;
        bool    exists;
    }

    /// Last outbound message (most recent ccipSend call).
    PendingMessage public lastOutbound;

    /// Counter for generating message IDs.
    uint256 private _msgCounter;

    // ── IRouterClient ────────────────────────────────────────────

    function isChainSupported(uint64) external pure override returns (bool) {
        return true;
    }

    function getFee(
        uint64,
        Client.EVM2AnyMessage memory
    ) external pure override returns (uint256) {
        return MOCK_FEE;
    }

    /**
     * @notice Accept a cross-chain send request and record it.
     *         The fee (MOCK_FEE) must be supplied as msg.value.
     */
    function ccipSend(
        uint64 destinationChainSelector,
        Client.EVM2AnyMessage calldata message
    ) external payable override returns (bytes32 messageId) {
        require(msg.value >= MOCK_FEE, "insufficient fee");

        messageId = bytes32(++_msgCounter);

        lastOutbound = PendingMessage({
            destChainSelector: destinationChainSelector,
            sender:            msg.sender,
            data:              message.data,
            exists:            true
        });
    }

    // ── Test helpers ─────────────────────────────────────────────

    /**
     * @notice Deliver the most-recent outbound message to `receiver`.
     *         The caller specifies the source-chain selector and sender address
     *         to fill the Any2EVMMessage fields (mirrors the originating contract).
     * @param receiver           Address implementing IAny2EVMMessageReceiver.
     * @param sourceChainSelector CCIP chain selector reported as the message source.
     * @param senderOnSource     Address reported as the message sender.
     */
    function deliverLastMessage(
        address receiver,
        uint64  sourceChainSelector,
        address senderOnSource
    ) external {
        require(lastOutbound.exists, "no pending message");

        Client.Any2EVMMessage memory msg_ = Client.Any2EVMMessage({
            messageId:           bytes32(_msgCounter),
            sourceChainSelector: sourceChainSelector,
            sender:              abi.encode(senderOnSource),
            data:                lastOutbound.data,
            destTokenAmounts:    new Client.EVMTokenAmount[](0)
        });

        lastOutbound.exists = false;

        IAny2EVMMessageReceiver(receiver).ccipReceive(msg_);
    }

    /**
     * @notice Deliver an arbitrary CCIP message to a receiver.
     *         Use when you need fine-grained control over all message fields.
     */
    function deliverMessage(
        address receiver,
        Client.Any2EVMMessage calldata message
    ) external {
        IAny2EVMMessageReceiver(receiver).ccipReceive(message);
    }
}
